import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// PLAN-ANALYTICS item 2 — what the hourly import reads. The collectors write one JSONL file per UTC day; a table's
// newest imported row says which day it had reached, so a run opens only that day's file and the later ones (inserts
// skip rows already present) and reads each as a stream of bounded chunks. Memory no longer grows with history.

/** The `YYYY-MM-DD.jsonl` files of `dir` whose day is on or after `newest`'s UTC day (all of them when null). */
export function dayFilesFrom(dir: string, newest: Date | null): string[] {
  if (!existsSync(dir)) return [];
  const from = newest ? newest.toISOString().slice(0, 10) : '';
  return readdirSync(dir)
    .filter((n) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n) && n.slice(0, 10) >= from)
    .sort()
    .map((n) => join(dir, n));
}

/** The rows of a JSONL file in order, at most `n` parsed rows at a time; blank lines are skipped. */
export async function* jsonlChunks<T = Record<string, unknown>>(
  file: string,
  n = 500,
): AsyncGenerator<T[]> {
  let buf: T[] = [];
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    if (!line) continue;
    buf.push(JSON.parse(line) as T);
    if (buf.length >= n) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}
