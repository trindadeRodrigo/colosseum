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
import { decoders, type RpcTx, tokenBalances } from '@colosseum/risk';
import {
  HISTORY_DIR,
  JsonlSink,
  type RegistryPool,
  readSignatures,
  valuePools,
} from './lib-history';
import { rpc, rpcStats } from './lib-pools';

// Step 5b.2 — complete history fetcher for the value pools.
// Input: the signature walk (`history-full-measure.ts walk`), every signature of every pool in the window.
// 1. Partition each pool's successful signatures by UTC day (`byday/<pool>/<day>.tsv`, with the walk
//    sequence number, newest = 0, which orders transactions inside a slot).
// 2. Fetch work units (pool, day) newest day first, PARALLEL getTransaction at a time across units.
//    Each tx becomes one compact row in `events/<pool>/<day>.jsonl`: decoded events, the pool vaults'
//    pre and post balances (an absolute reserve trace, a cross-check of decoded amounts, and a
//    completeness check: each row's pre must equal the previous row's post), instruction names,
//    any undecoded pool-program payload, and a truncated-log flag. Failures go to `errors.jsonl`.
// 3. 1 in 1,000 signatures (by hash, so reproducible) also keep the raw body in `raw-sample/`, and so does
//    every tx whose log was truncated (`truncated/`; about 1% of rows).
// Resumable: a unit is done when `events/<pool>/<day>.done` exists; a partial unit skips rows already
// written. Errors are retried on the next run. Run under nohup or launchd (session tasks die at 2 h).
// Usage: tsx history-full.ts [parallel=32] [maxDays=28] [poolFilter]
const PARALLEL = Number(process.argv[2] ?? 32);
const MAX_DAYS = Number(process.argv[3] ?? 28);
const FILTER = process.argv[4];
const SOURCE = 'Solana RPC getTransaction (Chainstack archive)';
const METHOD = 'history-full-0.1';

const pools = valuePools().filter((p) => !FILTER || p.address.startsWith(FILTER));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const log = (row: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  console.log(line);
  appendFileSync(join(HISTORY_DIR, 'fetch.jsonl'), `${line}\n`);
};

// 1. partition
for (const p of pools) {
  const dir = join(HISTORY_DIR, 'byday', p.address);
  if (existsSync(join(dir, '.done'))) continue;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) writeFileSync(join(dir, f), '');
  const buf = new Map<string, string[]>();
  let seq = 0;
  let n = 0;
  const flush = () => {
    for (const [d, lines] of buf) appendFileSync(join(dir, `${d}.tsv`), lines.join(''));
    buf.clear();
    n = 0;
  };
  for (const s of readSignatures(p.address)) {
    const q = seq++;
    if (s.failed) continue;
    const d = day(s.blockTime);
    const arr = buf.get(d) ?? [];
    arr.push(`${s.signature}\t${s.slot}\t${s.blockTime}\t${q}\n`);
    buf.set(d, arr);
    if (++n >= 200_000) flush();
  }
  flush();
  writeFileSync(join(dir, '.done'), String(seq));
}

// 2. units, newest day first; within a day, larger pools first
type Unit = { pool: RegistryPool; day: string };
const units: Unit[] = [];
for (const p of pools)
  for (const f of readdirSync(join(HISTORY_DIR, 'byday', p.address)))
    if (f.endsWith('.tsv')) units.push({ pool: p, day: f.slice(0, 10) });
const days = [...new Set(units.map((u) => u.day))].sort().reverse().slice(0, MAX_DAYS);
const ordered = units
  .filter((u) => days.includes(u.day))
  .sort((a, b) => b.day.localeCompare(a.day) || b.pool.tvlUsd - a.pool.tvlUsd);

const sink = new JsonlSink();
const evDir = (p: string) => join(HISTORY_DIR, 'events', p);
const stats = {
  units: 0,
  fetched: 0,
  skipped: 0,
  errors: 0,
  truncated: 0,
  unknown: 0,
  rawSampled: 0,
};
const t0 = Date.now();

type Job = { u: Unit; sig: string; slot: number; blockTime: number; seq: number };
function* jobs(): Generator<Job | { done: Unit }> {
  for (const u of ordered) {
    const out = join(evDir(u.pool.address), `${u.day}.jsonl`);
    if (existsSync(join(evDir(u.pool.address), `${u.day}.done`))) continue;
    const have = new Set<string>(
      existsSync(out)
        ? readFileSync(out, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as { s: string }).s)
        : [],
    );
    for (const line of readFileSync(
      join(HISTORY_DIR, 'byday', u.pool.address, `${u.day}.tsv`),
      'utf8',
    ).split('\n')) {
      if (!line) continue;
      const [sig, slot, blockTime, seq] = line.split('\t');
      if (have.has(sig as string)) {
        stats.skipped++;
        continue;
      }
      yield {
        u,
        sig: sig as string,
        slot: Number(slot),
        blockTime: Number(blockTime),
        seq: Number(seq),
      };
    }
    yield { done: u };
  }
}

const inflight = new Map<string, number>(); // unit key → jobs in flight
const unitErrors = new Map<string, number>();
const key = (u: Unit) => `${u.pool.address}/${u.day}`;
const pendingDone: Unit[] = [];
const tryFinish = () => {
  for (let i = pendingDone.length - 1; i >= 0; i--) {
    const u = pendingDone[i] as Unit;
    if (inflight.get(key(u))) continue;
    pendingDone.splice(i, 1);
    // a unit with errors stays open so the next run retries them
    if (!unitErrors.get(key(u)))
      writeFileSync(
        join(evDir(u.pool.address), `${u.day}.done`),
        JSON.stringify({ fetchedAt: new Date().toISOString(), source: SOURCE, method: METHOD }),
      );
    stats.units++;
    log({ unit: key(u), errors: unitErrors.get(key(u)) ?? 0, stats, rpc: rpcStats });
  }
};

const it = jobs();
let lastLog = Date.now();
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) {
      const j = n.value;
      if ('done' in j) {
        pendingDone.push(j.done);
        tryFinish();
        continue;
      }
      const k = key(j.u);
      inflight.set(k, (inflight.get(k) ?? 0) + 1);
      try {
        const tx = await rpc<RpcTx | null>('getTransaction', [
          j.sig,
          { encoding: 'json', maxSupportedTransactionVersion: 1 },
        ]);
        if (!tx?.meta) throw new Error('transaction not served');
        const decode = decoders[j.u.pool.venue];
        const d = decode?.(tx, j.u.pool.address, { mint0: j.u.pool.mint0 });
        const bal = tokenBalances(tx, [j.u.pool.vault0, j.u.pool.vault1]);
        if (d?.truncated) stats.truncated++;
        if (d?.unknown.length) stats.unknown++;
        sink.write(join(evDir(j.u.pool.address), `${j.u.day}.jsonl`), {
          s: j.sig,
          q: j.seq,
          sl: tx.slot,
          t: tx.blockTime ?? j.blockTime,
          ev: d?.events ?? null, // null = no decoder for this venue yet; re-decode from raw payloads
          vp: bal.pre,
          vb: bal.post,
          ix: d?.ix,
          ...(d?.unknown.length ? { ux: d.unknown } : {}),
          ...(d?.truncated ? { tr: 1 } : {}),
          ...(decode ? {} : { logs: tx.meta.logMessages, inner: tx.meta.innerInstructions }),
        });
        // a truncated log may have cut pool events: keep the whole body so they can be recovered
        if (d?.truncated)
          sink.write(join(HISTORY_DIR, 'truncated', j.u.pool.address, `${j.u.day}.jsonl`), tx);
        if (createHash('sha256').update(j.sig).digest().readUInt32BE(0) % 1000 === 0) {
          sink.write(join(HISTORY_DIR, 'raw-sample', `${j.u.pool.address}.jsonl`), tx);
          stats.rawSampled++;
        }
        stats.fetched++;
      } catch (e) {
        stats.errors++;
        unitErrors.set(k, (unitErrors.get(k) ?? 0) + 1);
        appendFileSync(
          join(HISTORY_DIR, 'errors.jsonl'),
          `${JSON.stringify({ at: new Date().toISOString(), pool: j.u.pool.address, day: j.u.day, signature: j.sig, error: String(e).slice(0, 300) })}\n`,
        );
      } finally {
        inflight.set(k, (inflight.get(k) ?? 1) - 1);
        tryFinish();
      }
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        const secs = (Date.now() - t0) / 1000;
        log({ progress: stats, perSec: +(stats.fetched / secs).toFixed(1), rpc: rpcStats });
      }
    }
  }),
);
tryFinish();
sink.close();
log({ finished: true, source: SOURCE, method: METHOD, stats, rpc: rpcStats });
