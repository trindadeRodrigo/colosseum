import 'dotenv/config';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  LENDING_HISTORY_DIR,
  loadMeasure,
  readAddressSignatures,
  walkAddress,
} from './lib-lending';
import { rpc, rpcStats } from './lib-pools';

// Step 10b item 4 — complete history of the lending pools, raw bodies kept (decoded later by item 5).
// Input: the VL-3/VL-4 address set (`data/risk/lending-measure/vl3.json`: Kamino markets, reserves and their vault
// token accounts; Jupiter Lend vault config, state and liquidity positions; curated-vault state and token vault),
// walked to each address's first transaction by `pnpm risk:lending-measure vl4` into `<dir>/sigs/`.
// 1. Walk: addresses not yet walked are walked to their first transaction (resumable cursor). The window is each
//    address's whole life up to its walk (VL-4, 2026-10-01 ~21:00Z); later transactions are the live collector's.
// 2. Partition every successful signature by UTC day into `<dir>/byday/<day>.tsv` (signature, slot, blockTime,
//    address index); a transaction seen by several addresses appears once per address.
// 3. Fetch work units (one per day), newest day first, PARALLEL getTransaction at a time across units. Each
//    transaction is fetched once (deduplicated within the day) and written whole, with the addresses it was seen
//    on, to `<dir>/raw/<day>.jsonl.gz` (gzip members appended per batch). Failures go to `errors.jsonl`.
// Resumable: a unit is done when `raw/<day>.done` exists; a partial unit skips rows already written. A unit with
// errors stays open so the next run retries them. Run under nohup + caffeinate (session tasks die at 2 h).
// Usage: tsx lending-history.ts [parallel=16] [dir=data/risk/lending-history]
const PARALLEL = Number(process.argv[2] ?? 16);
const DIR = process.argv[3] ?? LENDING_HISTORY_DIR;
const SOURCE = 'Solana RPC getTransaction (Chainstack archive)';
const METHOD = 'lending-history-0.1';
const BATCH = 200;

type Addr = { address: string; kind: string; group: string; label: string };
const addrs = loadMeasure<{ addresses: Addr[] }>('vl3').addresses;
mkdirSync(DIR, { recursive: true });
const log = (row: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  console.log(line);
  appendFileSync(join(DIR, 'fetch.jsonl'), `${line}\n`);
};
writeFileSync(
  join(DIR, 'addresses.json'),
  JSON.stringify(
    addrs.map((a, i) => ({ i, ...a })),
    null,
    1,
  ),
);

// 1. walks (already complete from VL-4: this only confirms the cursors)
const notWalked = addrs.filter((a) => !existsSync(join(DIR, 'sigs', a.address, 'cursor.json')));
for (const a of notWalked) await walkAddress(DIR, a.address, 0);

// 2. partition (once): every successful signature of every address, by day
const byday = join(DIR, 'byday');
if (!existsSync(join(byday, '.done'))) {
  mkdirSync(byday, { recursive: true });
  for (const f of readdirSync(byday)) writeFileSync(join(byday, f), '');
  let n = 0;
  let failed = 0;
  const buf = new Map<string, string[]>();
  const flush = () => {
    for (const [d, lines] of buf) appendFileSync(join(byday, `${d}.tsv`), lines.join(''));
    buf.clear();
  };
  addrs.forEach((a, i) => {
    for (const s of readAddressSignatures(DIR, a.address)) {
      if (s.failed) {
        failed++;
        continue;
      }
      const d = new Date(s.blockTime * 1000).toISOString().slice(0, 10);
      const arr = buf.get(d) ?? [];
      arr.push(`${s.signature}\t${s.slot}\t${s.blockTime}\t${i}\n`);
      buf.set(d, arr);
      if (++n % 200_000 === 0) flush();
    }
  });
  flush();
  writeFileSync(
    join(byday, '.done'),
    JSON.stringify({ rows: n, failedSkipped: failed, at: new Date().toISOString() }),
  );
  log({ partitioned: { rows: n, failedSkipped: failed } });
}

// 3. units: one per day, newest first
const days = readdirSync(byday)
  .filter((f) => f.endsWith('.tsv'))
  .map((f) => f.slice(0, 10))
  .sort()
  .reverse();
const rawDir = join(DIR, 'raw');
mkdirSync(rawDir, { recursive: true });
type Job = { day: string; sig: string; slot: number; blockTime: number; a: number[] };
const stats = {
  units: 0,
  unitsTotal: days.length,
  txs: 0,
  fetched: 0,
  skipped: 0,
  errors: 0,
  bytesGz: 0,
};
for (const d of days) {
  // total distinct txs (for the progress estimate)
  const seen = new Set<string>();
  for (const line of readFileSync(join(byday, `${d}.tsv`), 'utf8').split('\n'))
    if (line) seen.add(line.slice(0, line.indexOf('\t')));
  stats.txs += seen.size;
  if (existsSync(join(rawDir, `${d}.done`))) stats.units++;
}

const pending = new Map<string, string[]>(); // day → buffered jsonl rows
const flushDay = (d: string) => {
  const rows = pending.get(d);
  if (!rows?.length) return;
  const gz = gzipSync(rows.join(''));
  appendFileSync(join(rawDir, `${d}.jsonl.gz`), gz);
  stats.bytesGz += gz.length;
  pending.set(d, []);
};

function* jobs(): Generator<Job | { done: string }> {
  for (const d of days) {
    if (existsSync(join(rawDir, `${d}.done`))) continue;
    const have = new Set<string>();
    const f = join(rawDir, `${d}.jsonl.gz`);
    if (existsSync(f)) {
      try {
        for (const l of gunzipSync(readFileSync(f)).toString('utf8').split('\n'))
          if (l) have.add((JSON.parse(l) as { s: string }).s);
      } catch (e) {
        // a crash mid-append leaves a truncated gzip member: set the file aside and refetch the day
        renameSync(f, `${f}.corrupt-${Date.now()}`);
        log({ unit: d, corruptFileSetAside: String(e).slice(0, 120) });
      }
    }
    const bySig = new Map<string, Job>();
    for (const line of readFileSync(join(byday, `${d}.tsv`), 'utf8').split('\n')) {
      if (!line) continue;
      const [sig, slot, bt, ai] = line.split('\t') as [string, string, string, string];
      const j = bySig.get(sig);
      if (j) {
        if (!j.a.includes(Number(ai))) j.a.push(Number(ai));
        continue;
      }
      bySig.set(sig, { day: d, sig, slot: Number(slot), blockTime: Number(bt), a: [Number(ai)] });
    }
    const list = [...bySig.values()].sort((x, y) => y.slot - x.slot);
    for (const j of list) {
      if (have.has(j.sig)) {
        stats.skipped++;
        continue;
      }
      yield j;
    }
    yield { done: d };
  }
}

const inflight = new Map<string, number>();
const unitErrors = new Map<string, number>();
const pendingDone: string[] = [];
const tryFinish = () => {
  for (let i = pendingDone.length - 1; i >= 0; i--) {
    const d = pendingDone[i] as string;
    if (inflight.get(d)) continue;
    pendingDone.splice(i, 1);
    flushDay(d);
    if (!unitErrors.get(d))
      writeFileSync(
        join(rawDir, `${d}.done`),
        JSON.stringify({ fetchedAt: new Date().toISOString(), source: SOURCE, method: METHOD }),
      );
    stats.units++;
    log({ unit: d, errors: unitErrors.get(d) ?? 0, stats, rpc: rpcStats });
  }
};

const t0 = Date.now();
let lastLog = Date.now();
const it = jobs();
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) {
      const j = n.value;
      if ('done' in j) {
        pendingDone.push(j.done);
        tryFinish();
        continue;
      }
      inflight.set(j.day, (inflight.get(j.day) ?? 0) + 1);
      try {
        const tx = await rpc<{ meta: unknown } | null>('getTransaction', [
          j.sig,
          { encoding: 'json', maxSupportedTransactionVersion: 1 },
        ]);
        if (!tx?.meta) throw new Error('transaction not served');
        const rows = pending.get(j.day) ?? [];
        rows.push(`${JSON.stringify({ s: j.sig, sl: j.slot, t: j.blockTime, a: j.a, tx })}\n`);
        pending.set(j.day, rows);
        if (rows.length >= BATCH) flushDay(j.day);
        stats.fetched++;
      } catch (e) {
        stats.errors++;
        unitErrors.set(j.day, (unitErrors.get(j.day) ?? 0) + 1);
        appendFileSync(
          join(DIR, 'errors.jsonl'),
          `${JSON.stringify({ at: new Date().toISOString(), day: j.day, signature: j.sig, error: String(e).slice(0, 300) })}\n`,
        );
      } finally {
        inflight.set(j.day, (inflight.get(j.day) ?? 1) - 1);
        tryFinish();
      }
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        const secs = (Date.now() - t0) / 1000;
        const perSec = stats.fetched / secs;
        const left = stats.txs - stats.fetched - stats.skipped;
        log({
          progress: stats,
          perSec: +perSec.toFixed(1),
          etaHours: perSec > 0 ? +(left / perSec / 3600).toFixed(2) : null,
          rpc: rpcStats,
        });
      }
    }
  }),
);
for (const d of pending.keys()) flushDay(d);
tryFinish();
log({ finished: true, source: SOURCE, method: METHOD, stats, rpc: rpcStats });
