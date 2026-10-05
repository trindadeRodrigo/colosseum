import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RAYDIUM_CLMM_PROGRAM, Reader } from '@colosseum/risk';
import { rpc, rpcStats } from './lib-pools';

// Step 5 — trade history for calibration. For the top Raydium CLMM pools (by registry TVL), walks
// getSignaturesForAddress back DAYS days, samples up to PER_HOUR consecutive transactions per UTC hour,
// and decodes Raydium SwapEvent logs (amounts, direction, post-swap sqrt price, liquidity, tick).
// Consecutive events give the pre-trade price (the previous event's post price), so realised cost per trade
// is measurable by size and hour of week. Resumable: signatures and decoded swaps are checkpointed.
// Usage: tsx history-backfill.ts [pools=5] [days=28] [perHour=30]
const N_POOLS = Number(process.argv[2] ?? 5);
const DAYS = Number(process.argv[3] ?? 28);
const PER_HOUR = Number(process.argv[4] ?? 30);
const CONCURRENCY = 4;
const OUT = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history');
mkdirSync(OUT, { recursive: true });
const SWAP_DISC = createHash('sha256')
  .update('event:SwapEvent')
  .digest()
  .subarray(0, 8)
  .toString('hex');

const regFile = join(
  'data/risk',
  readdirSync('data/risk')
    .filter((n) => n.startsWith('registry-') && n.endsWith('.json') && !n.includes('search'))
    .sort()
    .at(-1) as string,
);
const reg = JSON.parse(readFileSync(regFile, 'utf8')) as {
  pools: Array<{
    address: string;
    venue: string;
    assetSymbol: string;
    quoteSymbol: string;
    tvlUsd: number;
    exitPath: string;
  }>;
};
const pools = reg.pools
  .filter((p) => p.venue === 'raydium_clmm' && p.exitPath === 'direct_usd')
  .sort((a, b) => b.tvlUsd - a.tvlUsd)
  .slice(0, N_POOLS);
const since = Math.floor(Date.now() / 1000) - DAYS * 86_400;

for (const p of pools) {
  const sigFile = join(OUT, `${p.address}-sigs.json`);
  const swapFile = join(OUT, `${p.address}-swaps.jsonl`);
  // 1. walk signatures newest → oldest, keeping per UTC hour only the PER_HOUR oldest successful ones seen
  //    (a rolling buffer: what remains after the walk passes an hour is that hour's oldest consecutive run).
  //    Checkpoint = cursor + buffers, so memory and disk stay small for pools with ~50k tx/day.
  type Sig = { signature: string; slot: number; blockTime: number | null; err: unknown };
  type Ckpt = {
    before?: string;
    oldestTime?: number;
    walked: number;
    hours: Record<string, Sig[]>;
  };
  const ck: Ckpt = existsSync(sigFile)
    ? JSON.parse(readFileSync(sigFile, 'utf8'))
    : { walked: 0, hours: {} };
  while ((ck.oldestTime ?? Number.POSITIVE_INFINITY) > since) {
    const page = await rpc<Sig[]>('getSignaturesForAddress', [
      p.address,
      { limit: 1000, ...(ck.before ? { before: ck.before } : {}) },
    ]);
    if (!page.length) break;
    for (const sg of page) {
      if (sg.err || !sg.blockTime || sg.blockTime < since) continue;
      const h = String(Math.floor(sg.blockTime / 3600));
      const buf = ck.hours[h] ?? [];
      buf.push({ signature: sg.signature, slot: sg.slot, blockTime: sg.blockTime, err: null });
      if (buf.length > PER_HOUR) buf.shift(); // keep the oldest PER_HOUR (walk goes backwards in time)
      ck.hours[h] = buf;
    }
    ck.walked += page.length;
    ck.before = page.at(-1)?.signature;
    ck.oldestTime = page.at(-1)?.blockTime ?? ck.oldestTime;
    if (ck.walked % 50_000 < 1000) {
      writeFileSync(sigFile, JSON.stringify(ck));
      console.log(
        JSON.stringify({
          pool: p.address,
          walked: ck.walked,
          oldest: ck.oldestTime ? new Date(ck.oldestTime * 1000).toISOString() : null,
        }),
      );
    }
  }
  writeFileSync(sigFile, JSON.stringify(ck));
  const byHour = new Map<number, Sig[]>(Object.entries(ck.hours).map(([h, v]) => [Number(h), v]));
  const sigs = { length: ck.walked };
  const done = new Set<string>(
    existsSync(swapFile)
      ? readFileSync(swapFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l).signature as string)
      : [],
  );
  const todo: Sig[] = [];
  for (const arr of byHour.values())
    todo.push(...arr.sort((a, b) => a.slot - b.slot).slice(0, PER_HOUR));
  const pending = todo.filter((s) => !done.has(s.signature));
  console.log(
    JSON.stringify({
      pool: p.address,
      asset: p.assetSymbol,
      sigs: sigs.length,
      hours: byHour.size,
      sampled: todo.length,
      pending: pending.length,
    }),
  );
  // 3. fetch and decode, CONCURRENCY at a time
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    await Promise.all(
      pending.slice(i, i + CONCURRENCY).map(async (s) => {
        try {
          const tx = await rpc<{
            slot: number;
            blockTime: number;
            meta: { logMessages: string[] | null };
          } | null>('getTransaction', [
            s.signature,
            { encoding: 'json', maxSupportedTransactionVersion: 1 },
          ]);
          const events = (tx?.meta.logMessages ?? [])
            .filter((l) => l.startsWith('Program data: '))
            .map((l) => new Uint8Array(Buffer.from(l.slice(14), 'base64')))
            .filter(
              (d) => d.length >= 205 && Buffer.from(d.subarray(0, 8)).toString('hex') === SWAP_DISC,
            )
            .map((d) => new Reader(d))
            .filter((r) => r.pubkey(8) === p.address)
            .map((r, k) => ({
              k,
              amount0: r.u64(136).toString(),
              amount1: r.u64(152).toString(),
              zeroForOne: r.u8(168) === 1,
              sqrtPriceX64: r.u128(169).toString(),
              liquidity: r.u128(185).toString(),
              tick: r.i32(201),
            }));
          appendFileSync(
            swapFile,
            `${JSON.stringify({ pool: p.address, signature: s.signature, slot: tx?.slot ?? s.slot, blockTime: tx?.blockTime ?? s.blockTime, events, program: RAYDIUM_CLMM_PROGRAM, source: 'Solana RPC getTransaction (archive), Raydium SwapEvent log', method: 'raydium_swap_event_decode', provenance: 'live' })}\n`,
          );
        } catch (e) {
          appendFileSync(
            join(OUT, 'errors.jsonl'),
            `${JSON.stringify({ pool: p.address, signature: s.signature, error: String(e).slice(0, 200) })}\n`,
          );
        }
      }),
    );
    if (i % 2000 === 0)
      console.log(
        JSON.stringify({ pool: p.address, progress: i, of: pending.length, rpc: rpcStats }),
      );
  }
}
console.log(JSON.stringify({ done: true, pools: pools.length, rpc: rpcStats }));
