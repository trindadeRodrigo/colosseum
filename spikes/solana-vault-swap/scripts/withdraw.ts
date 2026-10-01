// Owner pulls everything out of the vault in kind (SPYx and any USDC left).
// Same CLUSTER / RPC_URL / OWNER_KEYPAIR / --send rules as run-swap.ts.
import { resolve } from 'node:path';
import anchor from '@coral-xyz/anchor';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, type TransactionInstruction } from '@solana/web3.js';
import {
  buildTx,
  loadKeypair,
  logStats,
  program,
  ROOT,
  SPYX,
  USDC,
  vaultAtas,
  vaultPda,
} from './common.ts';

const cluster = process.env.CLUSTER ?? 'local';
const send = cluster === 'local' || process.argv.includes('--send');
const rpc = cluster === 'mainnet' ? process.env.RPC_URL! : 'http://127.0.0.1:8899';
const owner = loadKeypair(
  cluster === 'mainnet' ? process.env.OWNER_KEYPAIR! : resolve(ROOT, 'keys/local-owner.json'),
);
const connection = new Connection(rpc, 'confirmed');
const prog = program(connection, owner);
const vault = vaultPda(owner.publicKey, BigInt(process.env.BASKET_ID ?? '1'));
const atas = vaultAtas(vault);

const ixs: TransactionInstruction[] = [];
const moved: Record<string, string> = {};
for (const [name, mint, tokenProgram, from] of [
  ['spyx', SPYX, TOKEN_2022_PROGRAM_ID, atas.spyx],
  ['usdc', USDC, TOKEN_PROGRAM_ID, atas.usdc],
] as const) {
  const bal = await connection.getTokenAccountBalance(from, 'confirmed').catch(() => null);
  if (!bal || bal.value.amount === '0') continue;
  const to = getAssociatedTokenAddressSync(mint, owner.publicKey, false, tokenProgram);
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      to,
      owner.publicKey,
      mint,
      tokenProgram,
    ),
    await prog.methods
      .withdraw(new anchor.BN(bal.value.amount))
      .accounts({
        owner: owner.publicKey,
        vault,
        mint,
        vaultTokenAccount: from,
        ownerTokenAccount: to,
        tokenProgram,
      })
      .instruction(),
  );
  moved[name] = bal.value.amount;
}
if (ixs.length === 0) {
  console.log('vault is empty');
  process.exit(0);
}
const tx = await buildTx(connection, owner, ixs, [], 200_000, cluster === 'mainnet' ? 50_000 : 0);
const sim = await connection.simulateTransaction(tx, { sigVerify: false });
const out: any = {
  moved,
  simulated: sim.value.err ?? 'ok',
  computeUnits: sim.value.unitsConsumed,
  ...logStats(sim.value.logs ?? []),
};
if (sim.value.err) out.logs = sim.value.logs;
else if (send) {
  out.signature = await connection.sendTransaction(tx, { skipPreflight: true });
  const conf = await connection.confirmTransaction(
    { signature: out.signature, ...(await connection.getLatestBlockhash()) },
    'confirmed',
  );
  out.err = conf.value.err;
}
console.log(JSON.stringify(out, null, 2));
