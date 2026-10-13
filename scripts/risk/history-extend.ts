import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HISTORY_DIR, type RegistryPool, valuePools } from './lib-history';
import { rpc } from './lib-pools';

// Step 5b, extended forward (founder, 2026-10-06, while the archive endpoint is still free): the
// signatures newer than each value pool's stored newest, from getSignaturesForAddress with `until`,
// prepended to sigs/<pool>/0000.tsv so every reader that takes the window's end from that file's first
// line sees the new end. Then the day partition's marker and the old newest day's fetch marker are set
// aside, so `history-full.ts` partitions the days again and fetches what is new: the rest of that day
// (it skips the transactions already written) and every day since. Nothing is deleted: what is
// rewritten is copied first to sigs/<pool>/backup-<stamp>/, and a marker set aside keeps its content
// under a dated name.
// Usage: tsx history-extend.ts [parallel=8] [poolPrefix] [--dry]
const args = process.argv.slice(2).filter((a) => a !== '--dry');
const PARALLEL = Number(args[0] ?? 8);
const FILTER = args[1];
const DRY = process.argv.includes('--dry');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const log = (row: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  console.log(line);
  if (!DRY) appendLog(line);
};
const appendLog = (line: string) =>
  writeFileSync(join(HISTORY_DIR, 'extend.jsonl'), `${line}\n`, { flag: 'a' });

type Cursor = {
  before?: string;
  oldestTime?: number;
  newestTime?: number;
  walked: number;
  kept: number;
  failed: number;
  chunk: number;
  bytes: number;
  done: boolean;
  since: number;
};
type Sig = { signature: string; slot: number; blockTime: number | null; err: unknown };

async function extend(p: RegistryPool) {
  const dir = join(HISTORY_DIR, 'sigs', p.address);
  const chunk0 = join(dir, '0000.tsv');
  const curFile = join(dir, 'cursor.json');
  if (!existsSync(chunk0) || !existsSync(curFile)) {
    log({ pool: p.address, asset: p.assetSymbol, skipped: 'no walked signatures' });
    return { pool: p.address, added: 0 };
  }
  const old = readFileSync(chunk0, 'utf8');
  const until = old.slice(0, old.indexOf('\t'));
  const cursor = JSON.parse(readFileSync(curFile, 'utf8')) as Cursor;
  // newest → older, until the signature the walk already holds
  const rows: Sig[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc<Sig[]>('getSignaturesForAddress', [
      p.address,
      { limit: 1000, until, ...(before ? { before } : {}) },
    ]);
    if (!page.length) break;
    rows.push(...page);
    before = page.at(-1)?.signature;
    if (page.length < 1000) break;
  }
  const seen = new Set<string>();
  const fresh = rows.filter(
    (r) => r.signature !== until && !seen.has(r.signature) && seen.add(r.signature),
  );
  const failed = fresh.filter((r) => r.err).length;
  const newest = fresh[0]?.blockTime ?? null;
  const oldestNew = fresh.at(-1)?.blockTime ?? null;
  log({
    pool: p.address,
    asset: p.assetSymbol,
    until,
    storedNewest: cursor.newestTime ? new Date(cursor.newestTime * 1000).toISOString() : null,
    added: fresh.length,
    failed,
    newest: newest ? new Date(newest * 1000).toISOString() : null,
    oldestNew: oldestNew ? new Date(oldestNew * 1000).toISOString() : null,
    pages: Math.ceil(rows.length / 1000),
  });
  if (DRY || fresh.length === 0) return { pool: p.address, added: fresh.length };
  // back up, then prepend
  const backup = join(dir, `backup-${STAMP}`);
  mkdirSync(backup, { recursive: true });
  copyFileSync(chunk0, join(backup, '0000.tsv'));
  copyFileSync(curFile, join(backup, 'cursor.json'));
  const lines = fresh
    .map((r) => `${r.signature}\t${r.slot}\t${r.blockTime ?? 0}\t${r.err ? 1 : 0}\n`)
    .join('');
  writeFileSync(`${chunk0}.tmp`, lines + old);
  renameSync(`${chunk0}.tmp`, chunk0);
  cursor.walked += fresh.length;
  cursor.kept += fresh.length;
  cursor.failed += failed;
  cursor.newestTime = newest ?? cursor.newestTime;
  if (cursor.chunk === 0) cursor.bytes = statSync(chunk0).size;
  writeFileSync(curFile, JSON.stringify(cursor));
  // the partition and the old newest day's fetch are done again by history-full.ts
  const partitionDone = join(HISTORY_DIR, 'byday', p.address, '.done');
  if (existsSync(partitionDone)) renameSync(partitionDone, `${partitionDone}.before-${STAMP}`);
  const oldNewestDay = cursor.newestTime && oldestNew ? day(oldestNew) : null;
  const storedDay = JSON.parse(readFileSync(join(backup, 'cursor.json'), 'utf8')) as Cursor;
  const dayToReopen = storedDay.newestTime ? day(storedDay.newestTime) : oldNewestDay;
  if (dayToReopen) {
    const marker = join(HISTORY_DIR, 'events', p.address, `${dayToReopen}.done`);
    if (existsSync(marker)) renameSync(marker, `${marker}.before-${STAMP}`);
  }
  return { pool: p.address, added: fresh.length };
}

const pools = valuePools().filter((p) => !FILTER || p.address.startsWith(FILTER));
log({ event: 'start', pools: pools.length, parallel: PARALLEL, dry: DRY, stamp: STAMP });
const queue = [...pools];
const results: Array<{ pool: string; added: number; error?: string }> = [];
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        results.push(await extend(p));
      } catch (e) {
        // a pool that could not be read is left as it was (nothing is written before its pages are all in)
        const error = e instanceof Error ? e.message : String(e);
        log({ pool: p.address, asset: p.assetSymbol, error });
        results.push({ pool: p.address, added: 0, error });
      }
    }
  }),
);
log({
  event: 'done',
  pools: results.length,
  failed: results.filter((r) => r.error).map((r) => r.pool),
  added: results.reduce((a, r) => a + r.added, 0),
  next: DRY
    ? 'run again without --dry'
    : 'pnpm risk:history-full 128 28, then verify, reconstruct, report, flow-import, recovery-import',
});
if (results.some((r) => r.error)) process.exit(1);
