import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * The pool collector's hourly raw recordings (scripts/risk/collector/pools.ts): for the concentrated-liquidity pools
 * that make up the top 80% of registry TVL, the pool head and every tick or bin array it discovered, as bytes, once an
 * hour, under `<dir>/<YYYY-MM-DD>/<HH>/<pool>.json.gz`. Reading them is a file read, no RPC: the liquidity routes use
 * them when the live read is gated (DA3) or has no RPC, and for the pool's value hour by hour.
 */
export const RECORDED_SOURCE =
  'pool collector hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array), decoded by packages/risk/src/pools';

export function recordedDir(): string {
  return process.env.RISK_RAW_DIR ?? join(homedir(), '.colosseum', 'risk', 'raw');
}

export type Recorded = {
  pool: string;
  venue: string;
  slot: number | null;
  fetchedAt: string;
  head: Uint8Array;
  kids: Uint8Array[];
};

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** One recording; null when the file is not a readable recording of a pool head. */
export function readRecorded(file: string): Recorded | null {
  try {
    const j = JSON.parse(gunzipSync(readFileSync(file)).toString()) as {
      pool?: string;
      venue?: string;
      slot?: number;
      fetchedAt?: string;
      head?: string;
      children?: Record<string, string>;
    };
    if (!j.pool || !j.head || !j.fetchedAt) return null;
    return {
      pool: j.pool,
      venue: j.venue ?? '',
      slot: typeof j.slot === 'number' ? j.slot : null,
      fetchedAt: j.fetchedAt,
      head: b64(j.head),
      kids: Object.values(j.children ?? {})
        .filter((v) => v.length > 0)
        .map(b64),
    };
  } catch {
    return null;
  }
}

/** Every recording file per pool, oldest first (by the folder's day and hour). Missing folder: empty. */
export function recordedIndex(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(dir)) return out;
  const days = readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (const d of days) {
    const hours = readdirSync(join(dir, d))
      .filter((h) => /^\d{2}$/.test(h))
      .sort();
    for (const h of hours)
      for (const f of readdirSync(join(dir, d, h))) {
        if (!f.endsWith('.json.gz')) continue;
        const pool = f.slice(0, -'.json.gz'.length);
        const list = out.get(pool) ?? [];
        list.push(join(dir, d, h, f));
        out.set(pool, list);
      }
  }
  return out;
}

/** The folder's hour of a recording file, as an ISO time (the file's own fetchedAt is the exact time). */
export function hourOfFile(file: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})[/\\](\d{2})[/\\][^/\\]+$/.exec(file);
  return m ? `${m[1]}T${m[2]}:00:00.000Z` : null;
}

/**
 * The recordings with caches: the index is re-read at most once a minute, decoded files are kept (they never change).
 * `now` is a seam for tests.
 */
export function recordedStore(dir: string = recordedDir(), now: () => number = Date.now) {
  let index: { at: number; map: Map<string, string[]> } | null = null;
  const files = new Map<string, Recorded | null>();
  const idx = () => {
    if (!index || now() - index.at > 60_000) index = { at: now(), map: recordedIndex(dir) };
    return index.map;
  };
  const read = (f: string) => {
    if (!files.has(f)) files.set(f, readRecorded(f));
    return files.get(f) ?? null;
  };
  return {
    pools(): Array<{ pool: string; files: string[] }> {
      return [...idx()].map(([pool, fs]) => ({ pool, files: fs }));
    },
    /** The newest readable recording of a pool, or null. */
    latest(pool: string): Recorded | null {
      const fs = idx().get(pool) ?? [];
      for (let i = fs.length - 1; i >= 0; i--) {
        const r = read(fs[i] as string);
        if (r) return r;
      }
      return null;
    },
    /** Every readable recording of a pool at or after `since` (ms), oldest first. */
    since(pool: string, since: number): Recorded[] {
      return (idx().get(pool) ?? [])
        .filter((f) => {
          const h = hourOfFile(f);
          return !h || Date.parse(h) >= since - 3_600_000;
        })
        .map(read)
        .filter((r): r is Recorded => !!r && Date.parse(r.fetchedAt) >= since);
    },
  };
}
export type RecordedStore = ReturnType<typeof recordedStore>;
