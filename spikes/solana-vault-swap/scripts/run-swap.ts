// Creates the vault (if needed), funds it, and swaps USDC -> SPYx through the vault program.
//   CLUSTER=local   (default) replays out/route.json against the local validator and sends.
//   CLUSTER=mainnet needs RPC_URL and OWNER_KEYPAIR; simulates only unless --send is passed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import anchor from '@coral-xyz/anchor';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection,
  LAMPORTS_PER_SOL,
  type PublicKey,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import {
  buildTx,
  buildVaultSwapIx,
  fetchRoute,
  loadAlts,
  loadKeypair,
  logStats,
  OUT,
  program,
  ROOT,
  type Route,
  SPYX,
  txStats,
  USDC,
  vaultAtas,
  vaultPda,
} from './common.ts';

const cluster = process.env.CLUSTER ?? 'local';
const send = cluster === 'local' || process.argv.includes('--send');
const step = process.env.STEP ?? 'all'; // setup | swap | all
const basketId = BigInt(process.env.BASKET_ID ?? '1');
const amount = BigInt(process.env.AMOUNT ?? '10000000'); // 10 USDC
const cuLimit = Number(process.env.CU_LIMIT ?? '400000');
const cuPrice = Number(process.env.CU_PRICE ?? (cluster === 'mainnet' ? '50000' : '0'));

let rpc = 'http://127.0.0.1:8899';
let ownerPath = resolve(ROOT, 'keys/local-owner.json');
if (cluster === 'mainnet') {
  if (!process.env.RPC_URL || !process.env.OWNER_KEYPAIR) {
    throw new Error('mainnet needs RPC_URL and OWNER_KEYPAIR');
  }
  rpc = process.env.RPC_URL;
  ownerPath = process.env.OWNER_KEYPAIR;
}
const connection = new Connection(rpc, 'confirmed');
const owner = loadKeypair(ownerPath);
const prog = program(connection, owner);
const vault = vaultPda(owner.publicKey, basketId);
const atas = vaultAtas(vault);
const report: Record<string, unknown> = {
  cluster,
  owner: owner.publicKey.toBase58(),
  vault: vault.toBase58(),
  send,
};

async function run(label: string, tx: VersionedTransaction) {
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    commitment: 'confirmed',
  });
  const logs = sim.value.logs ?? [];
  const out: Record<string, unknown> = {
    simulated: sim.value.err ? { err: sim.value.err } : 'ok',
    simulatedComputeUnits: sim.value.unitsConsumed,
    ...logStats(logs),
  };
  if (sim.value.err) {
    out.logs = logs;
    report[label] = out;
    return false;
  }
  if (send) {
    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
    const bh = await connection.getLatestBlockhash('confirmed');
    const conf = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    const meta = await connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    out.signature = sig;
    out.err = conf.value.err ?? meta?.meta?.err ?? null;
    out.computeUnitsConsumed = meta?.meta?.computeUnitsConsumed;
    out.feeLamports = meta?.meta?.fee;
    Object.assign(out, logStats(meta?.meta?.logMessages ?? []));
    out.logs = meta?.meta?.logMessages;
  } else {
    out.logs = logs;
  }
  report[label] = out;
  return !out.err;
}

async function tokenAmount(addr: PublicKey) {
  try {
    return (await connection.getTokenAccountBalance(addr, 'confirmed')).value.amount;
  } catch {
    return null;
  }
}

if (cluster === 'local' && (await connection.getBalance(owner.publicKey)) < LAMPORTS_PER_SOL) {
  const sig = await connection.requestAirdrop(owner.publicKey, 5 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(
    { signature: sig, ...(await connection.getLatestBlockhash()) },
    'confirmed',
  );
}

// ---- setup: vault account, its two token accounts, and (mainnet) the USDC deposit ----
if (step !== 'swap') {
  const ixs: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(vault))) {
    ixs.push(
      await prog.methods
        .createVault(new anchor.BN(basketId.toString()))
        .accounts({ owner: owner.publicKey })
        .instruction(),
    );
  }
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      atas.usdc,
      vault,
      USDC,
      TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      atas.spyx,
      vault,
      SPYX,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  const have = BigInt((await tokenAmount(atas.usdc)) ?? '0');
  if (cluster === 'mainnet' && have < amount) {
    const ownerUsdc = getAssociatedTokenAddressSync(USDC, owner.publicKey);
    ixs.push(
      createTransferCheckedInstruction(
        ownerUsdc,
        USDC,
        atas.usdc,
        owner.publicKey,
        amount - have,
        6,
      ),
    );
  }
  const tx = await buildTx(connection, owner, ixs, [], 200_000, cuPrice);
  const ok = await run('setup', tx);
  if (!ok || (!send && step === 'all')) {
    if (!send)
      report.note = 'setup simulated only; the swap needs setup on chain. Re-run with --send.';
    finish();
  }
}

// ---- swap ----
if (step !== 'setup') {
  const route: Route =
    cluster === 'local'
      ? JSON.parse(readFileSync(resolve(OUT, 'route.json'), 'utf8'))
      : await fetchRoute(vault, {
          amount,
          slippageBps: Number(process.env.SLIPPAGE_BPS ?? '100'),
          maxAccounts: Number(process.env.MAX_ACCOUNTS ?? '30'),
          dexes: process.env.DEXES,
          onlyDirectRoutes: process.env.DIRECT !== '0',
          useSharedAccounts:
            process.env.SHARED === undefined ? undefined : process.env.SHARED === '1',
        });
  if (route.vault !== vault.toBase58())
    throw new Error('route.json was built for a different vault');
  // Jupiter asks for one token account per mint the user must hold. More than one means a
  // multi-hop `route` that parks an intermediate token in the vault, which has no such account.
  if (cluster !== 'local' && route.setupInstructions.length > 1) {
    throw new Error(
      'route needs an intermediate token account in the vault; use DIRECT=1 or SHARED=1',
    );
  }

  const before = { usdc: await tokenAmount(atas.usdc), spyx: await tokenAmount(atas.spyx) };
  const ix = await buildVaultSwapIx(prog, owner.publicKey, vault, route);
  const alts = await loadAlts(connection, route.addressLookupTableAddresses);
  const tx = await buildTx(connection, owner, [ix], alts, cuLimit, cuPrice);
  report.route = {
    dexes: route.quote.routePlan.map((r: any) => r.swapInfo.label),
    inAmount: route.quote.inAmount,
    quotedOut: route.quote.outAmount,
    minOut: route.quote.otherAmountThreshold,
    jupiterSetupInstructionsIgnored: route.setupInstructions.length,
  };
  report.tx = txStats(tx, route.swapInstruction.accounts.length);
  await run('swap', tx);
  const after = { usdc: await tokenAmount(atas.usdc), spyx: await tokenAmount(atas.spyx) };
  report.vaultBalances = { before, after };
}
finish();

function finish(): never {
  mkdirSync(OUT, { recursive: true });
  const file = resolve(OUT, `report-${cluster}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const { setup, swap, ...rest } = report as any;
  const brief = (x: any) =>
    x && {
      ...x,
      logs: x.simulated === 'ok' && !x.err ? `${x.logs?.length} lines in ${file}` : x.logs,
    };
  console.log(JSON.stringify({ ...rest, setup: brief(setup), swap: brief(swap) }, null, 2));
  process.exit(0);
}
