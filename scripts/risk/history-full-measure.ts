import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_DIR, readSignatures, valuePools, walkSignatures } from './lib-history';
import { rpc, rpcStats } from './lib-pools';

// Step 5b.1 — measure before fetching.
//   walk [days=28] [parallel=8]  walk getSignaturesForAddress for the value pools and keep every signature
//                                (the fetcher reads these files); prints counts per pool and in total.
//   throughput [seconds=75] [levels=4,16,32,64]  getTransaction at each parallel level on walked
//                                signatures; rate, 429s and latency.
const mode = process.argv[2] ?? 'walk';
mkdirSync(HISTORY_DIR, { recursive: true });
const log = (row: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  console.log(line);
  appendFileSync(join(HISTORY_DIR, 'measure.jsonl'), `${line}\n`);
};

if (mode === 'walk') {
  const days = Number(process.argv[3] ?? 28);
  const parallel = Number(process.argv[4] ?? 8);
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const pools = valuePools();
  const queue = [...pools];
  const results: Record<string, unknown>[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const c = await walkSignatures(p.address, since, (c) => {
          if (c.kept % 100_000 < 1000)
            log({ walk: p.address, kept: c.kept, oldest: new Date((c.oldestTime ?? 0) * 1000) });
        });
        const row = {
          pool: p.address,
          venue: p.venue,
          asset: p.assetSymbol,
          quote: p.quoteSymbol,
          tvlUsd: Math.round(p.tvlUsd),
          sigs: c.kept,
          failed: c.failed,
          oldest: new Date((c.oldestTime ?? 0) * 1000).toISOString(),
          newest: new Date((c.newestTime ?? 0) * 1000).toISOString(),
        };
        results.push(row);
        log({ walked: row });
      }
    }),
  );
  const total = results.reduce((s, r) => s + (r.sigs as number), 0);
  const failed = results.reduce((s, r) => s + (r.failed as number), 0);
  log({
    walkDone: { pools: pools.length, days, sigs: total, failed, toFetch: total - failed },
    seconds: Math.round((Date.now() - t0) / 1000),
    rpc: rpcStats,
  });
} else if (mode === 'throughput') {
  const seconds = Number(process.argv[3] ?? 75);
  const pools = valuePools();
  // a mixed sample: successful signatures from every walked pool, interleaved
  const iters = pools.map((p) => readSignatures(p.address));
  const sigs: string[] = [];
  while (sigs.length < 200_000) {
    let any = false;
    for (const it of iters) {
      for (let k = 0; k < 50; k++) {
        const n = it.next();
        if (n.done) break;
        any = true;
        if (!n.value.failed) sigs.push(n.value.signature);
      }
    }
    if (!any) break;
  }
  let cursor = 0;
  const levels = (process.argv[4] ?? '4,16,32,64').split(',').map(Number);
  for (const level of levels) {
    const before = { ...rpcStats };
    let ok = 0;
    let bytes = 0;
    let errors = 0;
    const lat: number[] = [];
    const end = Date.now() + seconds * 1000;
    await Promise.all(
      Array.from({ length: level }, async () => {
        while (Date.now() < end && cursor < sigs.length) {
          const s = sigs[cursor++] as string;
          const t = Date.now();
          try {
            const tx = await rpc('getTransaction', [
              s,
              { encoding: 'json', maxSupportedTransactionVersion: 1 },
            ]);
            bytes += JSON.stringify(tx).length;
            ok++;
            lat.push(Date.now() - t);
          } catch {
            errors++;
          }
        }
      }),
    );
    lat.sort((a, b) => a - b);
    log({
      throughput: {
        parallel: level,
        seconds,
        ok,
        perSec: +(ok / seconds).toFixed(1),
        errors,
        retries429: rpcStats.retries429 - before.retries429,
        rpcErrors: rpcStats.errors - before.errors,
        avgBodyBytes: ok ? Math.round(bytes / ok) : 0,
        p50ms: lat[Math.floor(lat.length / 2)] ?? null,
        p95ms: lat[Math.floor(lat.length * 0.95)] ?? null,
      },
    });
  }
}
