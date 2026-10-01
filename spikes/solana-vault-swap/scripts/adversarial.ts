// Local validator only. Run after `run-swap.ts` with STEP=setup. Each case is simulated
// and must fail with the named error; nothing here changes state except creating the
// attacker's token account.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  buildTx,
  buildVaultSwapIx,
  idl,
  loadAlts,
  loadKeypair,
  OUT,
  program,
  ROOT,
  type Route,
  SPYX,
  vaultAtas,
  vaultPda,
} from './common.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const owner = loadKeypair(resolve(ROOT, 'keys/local-owner.json'));
const prog = program(connection, owner);
const vault = vaultPda(owner.publicKey, 1n);
const atas = vaultAtas(vault);
const base: Route = JSON.parse(readFileSync(resolve(OUT, 'route.json'), 'utf8'));
const alts = await loadAlts(connection, base.addressLookupTableAddresses);
const errName = (code: number) =>
  idl.errors.find((e: any) => e.code === code)?.name ?? `code ${code}`;

async function expectFail(name: string, route: Route, signer = owner) {
  const ix = await buildVaultSwapIx(program(connection, signer), signer.publicKey, vault, route);
  const tx = await buildTx(connection, signer, [ix], alts, 400_000);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  const err: any = sim.value.err;
  const custom = err?.InstructionError?.[1]?.Custom;
  const anchorLine = (sim.value.logs ?? []).find((l) => l.includes('AnchorError'));
  console.log(
    JSON.stringify({
      case: name,
      failed: !!err,
      error: custom !== undefined ? errName(custom) : err,
      anchorLog: anchorLine?.slice(0, 220),
      jupiterSucceeded: (sim.value.logs ?? []).some(
        (l) => l === 'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success',
      ),
    }),
  );
}

// 1. Caller asks the vault for more than the market gives. Jupiter's own slippage check passes.
const greedy: Route = structuredClone(base);
greedy.quote.otherAmountThreshold = (BigInt(base.quote.outAmount) * 2n).toString();
await expectFail('min_out above what the swap delivers', greedy);

// 2. Output redirected to an attacker's account: every occurrence of the vault's SPYx
//    account inside Jupiter's account list is swapped for the attacker's.
const attacker = Keypair.generate();
const attackerSpyx = getAssociatedTokenAddressSync(
  SPYX,
  attacker.publicKey,
  false,
  TOKEN_2022_PROGRAM_ID,
);
const mk = await buildTx(
  connection,
  owner,
  [
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      attackerSpyx,
      attacker.publicKey,
      SPYX,
      TOKEN_2022_PROGRAM_ID,
    ),
  ],
  [],
  100_000,
);
const sig = await connection.sendTransaction(mk);
await connection.confirmTransaction(
  { signature: sig, ...(await connection.getLatestBlockhash()) },
  'confirmed',
);
const redirected: Route = structuredClone(base);
for (const a of redirected.swapInstruction.accounts) {
  if (a.pubkey === atas.spyx.toBase58()) a.pubkey = attackerSpyx.toBase58();
}
await expectFail('output redirected to attacker', redirected);

// 3. Someone who is not the owner calls swap on this vault.
const stranger = Keypair.generate();
const air = await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
await connection.confirmTransaction(
  { signature: air, ...(await connection.getLatestBlockhash()) },
  'confirmed',
);
await expectFail('caller is not the owner', base, stranger);
