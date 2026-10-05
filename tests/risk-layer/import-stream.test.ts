import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayFilesFrom, jsonlChunks } from '../../scripts/risk/lib-import';

// PLAN-ANALYTICS item 2 — the hourly import re-read every day of history on every run (AUDIT-VAULT finding 10).
// Reproduced 2026-10-02 on the real collector files: after 1.9 days the old reader held 0.46 GB of parsed rows per
// run, growing with each day. Fixed: a run opens only the day files at or after the table's newest imported day, and
// reads them as a stream of bounded chunks.
const dir = mkdtempSync(join(tmpdir(), 'risk-import-'));
const days = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
];
const rowsPerDay = 1_234;
mkdirSync(join(dir, 'pools'));
for (const d of days)
  writeFileSync(
    join(dir, 'pools', `${d}.jsonl`),
    `${Array.from({ length: rowsPerDay }, (_, i) =>
      JSON.stringify({
        pool: `p${i % 7}`,
        fetchedAt: `${d}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
        i,
      }),
    ).join('\n')}\n\n`,
  );
writeFileSync(join(dir, 'pools', 'notes.txt'), 'not a day file');

describe('hourly import reads only what is new', () => {
  it('opens the day files from the newest imported day on, all of them when the table is empty', () => {
    const all = dayFilesFrom(join(dir, 'pools'), null);
    expect(all.map((f) => f.slice(-16, -6))).toEqual(days);
    // the newest imported row is on Oct 6: Oct 6 is re-read (inserts skip existing rows), Oct 1 to 5 are not opened
    const since = dayFilesFrom(join(dir, 'pools'), new Date('2026-10-06T13:00:00Z'));
    expect(since.map((f) => f.slice(-16, -6))).toEqual(['2026-10-06', '2026-10-07']);
    expect(dayFilesFrom(join(dir, 'missing'), null)).toEqual([]);
  });

  it('streams a file in chunks of at most n rows, in order, skipping blank lines', async () => {
    const file = dayFilesFrom(join(dir, 'pools'), null)[0] as string;
    const sizes: number[] = [];
    const seen: number[] = [];
    for await (const c of jsonlChunks<{ i: number }>(file, 500)) {
      sizes.push(c.length);
      seen.push(...c.map((r) => r.i));
    }
    expect(sizes).toEqual([500, 500, 234]);
    expect(seen).toEqual(Array.from({ length: rowsPerDay }, (_, i) => i));
  });

  it('after a week, a run reads one or two days of rows, not the week', async () => {
    let read = 0;
    for (const f of dayFilesFrom(join(dir, 'pools'), new Date('2026-10-07T00:30:00Z')))
      for await (const c of jsonlChunks(f, 500)) read += c.length;
    expect(read).toBe(rowsPerDay);
  });
});
