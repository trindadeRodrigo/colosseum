import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * The raw recordings of concentrated-liquidity pools: the pool head and every tick or bin array, as bytes, at most
 * one a pool and hour, under `<dir>/<YYYY-MM-DD>/<HH>/<pool>.json.gz`. Two jobs write them, in one file format, each
 * into a folder of its own: the pool collector (scripts/risk/collector/pools.ts), for the Raydium and Orca pools among
 * the pools that hold the top 80% of registry TVL, in the runs where it lists a pool's arrays again (about half the
 * hours), and the raw-arrays job (scripts/risk/raw-arrays), every hour, for the other concentrated-liquidity pools of
 * the tracked stocks. Reading them is a file read, no RPC: the liquidity routes use
 * them when the live read is gated (DA3) or has no RPC, and for the pool's value hour by hour.
 */
export const RECORDED_SOURCE =
  'pool collector hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array), decoded by packages/risk/src/pools';
export const RECORDED_ARRAYS_SOURCE =
  'raw-arrays job hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array the pool collector’s cache lists), decoded by packages/risk/src/pools';

/**
 * The source of an answer made of several recordings: the job or jobs that wrote them, and only those. A pool only
 * the raw-arrays job records does not name the collector. An answer with no recording in it names the collector, as
 * it did when there was one job.
 */
export const recordedSources = (ofCollector: boolean, ofArrays: boolean) =>
  !ofArrays
    ? RECORDED_SOURCE
    : ofCollector
      ? `${RECORDED_SOURCE}; ${RECORDED_ARRAYS_SOURCE}`
      : RECORDED_ARRAYS_SOURCE;

export function recordedDir(): string {
  return process.env.RISK_RAW_DIR ?? join(homedir(), '.colosseum', 'risk', 'raw');
}

/** The raw-arrays job's folder. This API does not read RISK_HOME: the folder is named whole or is the default. */
export function recordedArraysDir(): string {
  return process.env.RISK_RAW_ARRAYS_DIR ?? join(homedir(), '.colosseum', 'risk', 'raw-arrays');
}

/**
 * Both folders, the collector's first: where both hold a pool's hour, the first one's file is the one read, and the
 * other's only when the first's does not read.
 */
export function recordedDirs(): string[] {
  return [recordedDir(), recordedArraysDir()];
}

/** Which job wrote a recording. The folder says it, not the file: the first folder of a list is the collector's. */
export type RecordedBy = 'collector' | 'raw-arrays';
const byOf = (folder: number): RecordedBy => (folder === 0 ? 'collector' : 'raw-arrays');

export type Recorded = {
  pool: string;
  venue: string;
  slot: number | null;
  fetchedAt: string;
  head: Uint8Array;
  kids: Uint8Array[];
  by: RecordedBy;
  source: string;
};

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/**
 * One recording; null when the file is not a readable recording of a pool head. A file of the raw-arrays job has the
 * collector's keys first and its own after them (slotHead, childrenListedAt, source, method, methodVersion,
 * provenance), which are not read here: both read the same way.
 */
export function readRecorded(file: string, by: RecordedBy = 'collector'): Recorded | null {
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
      by,
      source: by === 'collector' ? RECORDED_SOURCE : RECORDED_ARRAYS_SOURCE,
    };
  } catch {
    return null;
  }
}

/**
 * One hour folder of one folder of the list: which folder, its day and hour (`hour` is both, `YYYY-MM-DD/HH`, the
 * order of the index), its path and the pools that have a recording in it. The index is made of these and holds
 * nothing per file but a pointer: a pool's name is one string however many hours hold it (`sharing`), and a file's
 * path is made when the file is read (`fileOf`). A path kept per file cost about 1.1 KB each for the life of the
 * process: with 259 pools 7 MB a day, 215 MB after 31 days. This is about 10 bytes a file: 1.9 MB after 31 days.
 */
type HourFolder = {
  folder: number;
  day: string;
  hh: string;
  hour: string;
  dir: string;
  pools: string[];
};

/** One string per pool name: `shared(name)` is the first string it was given with those letters. */
function sharing() {
  const seen = new Map<string, string>();
  const shared = (name: string) => {
    const s = seen.get(name);
    if (s !== undefined) return s;
    seen.set(name, name);
    return name;
  };
  return { shared, seen };
}

/** The names in a folder; null when it is not there, is not a folder or cannot be listed. */
function namesIn(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** The day folders of one folder, oldest first; anything else at its top (the job's run log) is not one. */
const dayFolders = (dir: string) =>
  (namesIn(dir) ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

/**
 * The hour folders of one day folder, oldest first, each with the pools recorded in it. An entry named like a day or
 * an hour that is not a folder, or a folder that cannot be listed, is left out instead of stopping the index: the
 * day's other hours, the folder's other days and the other folder still answer. `whole` says nothing was left out.
 */
function listDay(
  dir: string,
  day: string,
  folder: number,
  shared: (name: string) => string,
): { hours: HourFolder[]; whole: boolean } {
  const hhs = namesIn(join(dir, day));
  const hours: HourFolder[] = [];
  let whole = hhs !== null;
  for (const hh of (hhs ?? []).filter((h) => /^\d{2}$/.test(h)).sort()) {
    const path = join(dir, day, hh);
    const names = namesIn(path);
    if (!names) {
      whole = false;
      continue;
    }
    const pools = names
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => shared(f.slice(0, -'.json.gz'.length)));
    hours.push({ folder, day, hh, hour: `${day}/${hh}`, dir: path, pools });
  }
  return { hours, whole };
}

/** The path of a pool's recording in an hour folder. Made when it is asked for; the index keeps none. */
const fileOf = (h: HourFolder, pool: string) => `${h.dir}${sep}${pool}.json.gz`;

/** An hour folder's hour as an ISO time. */
const isoHour = (h: HourFolder) => `${h.day}T${h.hh}:00:00.000Z`;

/** Oldest first; of two folders' same day and hour, the one whose folder comes first in the list. */
const older = (a: HourFolder, b: HourFolder) =>
  a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : a.folder - b.folder;

/**
 * Per pool, the hour folders that hold a recording of it: one per day and hour, oldest first. Where two folders hold
 * the same pool and hour the first folder's is kept and the other left out, and an hour only a later folder has is
 * kept. The precedence is per pool and hour, not per pool: a pool that moves from one job's set to the other's keeps
 * its whole history. The pools come in the order the folders list them (`listed`: folder by folder, each oldest
 * first).
 */
function byPool(listed: HourFolder[]): Map<string, HourFolder[]> {
  const out = new Map<string, HourFolder[]>();
  for (const h of listed)
    for (const pool of h.pools) {
      const hs = out.get(pool);
      if (hs) hs.push(h);
      else out.set(pool, [h]);
    }
  for (const [pool, hs] of out) {
    hs.sort(older);
    out.set(
      pool,
      hs.filter((h, i) => h.hour !== hs[i - 1]?.hour),
    );
  }
  return out;
}

/** The hour folders oldest first, those of one day and hour together, the first folder of the list first. */
function byHour(listed: HourFolder[]): HourFolder[][] {
  const out: HourFolder[][] = [];
  for (const h of [...listed].sort(older)) {
    const last = out[out.length - 1];
    if (last?.[0]?.hour === h.hour) last.push(h);
    else out.push([h]);
  }
  return out;
}

/**
 * Of the hour folders of one day and hour, those that hold a recording of the pool, the first folder of the list
 * first. The first whose file reads is the one read: the collector's when both read. The collector writes a file
 * with one plain write, so a reader can find it half written; the hour is then read from the next folder that holds
 * it, and not lost.
 */
const holding = (sameHour: HourFolder[], pool: string) =>
  sameHour.filter((h) => h.pools.includes(pool));

/**
 * What the recorded list says of one pool: how many hours hold a recording of it (one per day and hour: an hour both
 * folders hold is one, the first folder's), the first and the last of those hours as ISO times, and how many of them
 * are the raw-arrays job's. It is of the files the folders list, not of what reads: no file is opened for it.
 */
export type RecordedPool = {
  pool: string;
  hours: number;
  from: string;
  to: string;
  ofArrays: number;
};

/**
 * The recorded list: every pool of the index with its `RecordedPool`, made in one pass over the hour folders and
 * with no path. It says what `byPool` says, pool for pool and in the same order, without a list of hours per pool.
 * The order is the order the folders list the pools in, folder by folder and each oldest first. The pass goes hour
 * by hour instead, so it keeps for each pool the lowest folder that holds it and when it first met the pool there
 * (`folder`, `met`), and puts the pools in that order at the end.
 */
function listOf(hours: HourFolder[][]): RecordedPool[] {
  type Sum = {
    pool: string;
    n: number;
    first: HourFolder;
    last: HourFolder;
    /** Which day and hour `last` is, as its place in `hours`: a number is compared, not the hour's letters. */
    at: number;
    ofArrays: number;
    folder: number;
    met: number;
  };
  const sums = new Map<string, Sum>();
  let met = 0;
  hours.forEach((sameHour, at) => {
    for (const h of sameHour) {
      const ofArrays = byOf(h.folder) === 'raw-arrays' ? 1 : 0;
      for (const pool of h.pools) {
        met++;
        const s = sums.get(pool);
        if (!s) {
          sums.set(pool, { pool, n: 1, first: h, last: h, at, ofArrays, folder: h.folder, met });
          continue;
        }
        if (h.folder < s.folder) {
          s.folder = h.folder;
          s.met = met;
        }
        // an earlier folder of the list holds this hour of the pool: the hour is counted already, as that folder's
        if (s.at === at) continue;
        s.n++;
        s.last = h;
        s.at = at;
        s.ofArrays += ofArrays;
      }
    }
  });
  return [...sums.values()]
    .sort((a, b) => a.folder - b.folder || a.met - b.met)
    .map((s) => ({
      pool: s.pool,
      hours: s.n,
      from: isoHour(s.first),
      to: isoHour(s.last),
      ofArrays: s.ofArrays,
    }));
}

/**
 * Every recording file per pool, oldest first (by the folder's day and hour), from one folder or a list of them
 * (between folders: `byPool`). A folder that is not there or cannot be listed holds nothing. The paths are made for
 * this answer: the store does not call this and keeps no path.
 */
export function recordedIndex(dirs: string | string[]): Map<string, string[]> {
  const folders = [dirs].flat();
  const { shared } = sharing();
  const listed = folders.flatMap((dir, i) =>
    dayFolders(dir).flatMap((d) => listDay(dir, d, i, shared).hours),
  );
  return new Map([...byPool(listed)].map(([pool, hs]) => [pool, hs.map((h) => fileOf(h, pool))]));
}

/** The folder's hour of a recording file, as an ISO time (the file's own fetchedAt is the exact time). */
export function hourOfFile(file: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})[/\\](\d{2})[/\\][^/\\]+$/.exec(file);
  return m ? `${m[1]}T${m[2]}:00:00.000Z` : null;
}

/** How many decoded recordings are kept (about 0.7 MB of JSON each); the oldest used is dropped first. */
export const RECORDED_KEEP = 64;

/**
 * The recordings with caches: the index is re-read at most once a minute; the newest recording of each pool asked
 * is kept until the next refresh, at most `RECORDED_KEEP` of them. A pool's history is read one file at a time and nothing of it is kept,
 * so a 31-day sweep holds one recording at a time. `dirs` is one folder (the collector's) or a list of them, the
 * collector's first. `now` is a seam for tests.
 */
export function recordedStore(
  dirs: string | string[] = recordedDirs(),
  now: () => number = Date.now,
) {
  const folders = [dirs].flat();
  const { shared, seen } = sharing();
  // The index: every hour folder, by day and hour (`hours`). No path of a file is in it (see `HourFolder`): a pool's
  // files are found by looking for its name in the hour folders, newest or oldest first. `seen` holds every name a
  // folder has listed, so a pool that was never recorded costs no search. `pools` is the recorded list of this
  // index, made the first time it is asked for and kept until the next refresh: a few hundred small objects.
  let index: { at: number; hours: HourFolder[][]; pools: readonly RecordedPool[] | null } | null =
    null;
  const kept = new Map<string, Recorded>();
  // A day folder before yesterday (UTC) is written no more, so it is listed once and its list kept: a refresh lists
  // today's and yesterday's folders, however long the history is. A file put into an older day after that is not
  // seen until the server starts again. A day that could not be listed whole is not kept: it is listed again at the
  // next refresh, so a failure that passes (no permission, too many open files) does not hide its hours for good.
  const settled = new Map<string, HourFolder[]>();
  const list = () => {
    const yesterday = new Date(now() - 86_400_000).toISOString().slice(0, 10);
    const listed: HourFolder[] = [];
    folders.forEach((dir, i) => {
      for (const d of dayFolders(dir)) {
        const key = `${i}/${d}`;
        let hours = settled.get(key);
        if (!hours) {
          const day = listDay(dir, d, i, shared);
          hours = day.hours;
          if (d < yesterday && day.whole) settled.set(key, hours);
        }
        listed.push(...hours);
      }
    });
    return listed;
  };
  const idx = () => {
    if (!index || now() - index.at > 60_000) {
      const at = now();
      index = { at, hours: byHour(list()), pools: null };
      // A file can be written again inside its hour (a second run of a job, the collector listing a pool twice), and
      // the history reads it fresh: what is kept is kept for one refresh, so the two agree within the minute.
      kept.clear();
    }
    return index;
  };
  const readKept = (f: string, by: RecordedBy) => {
    const hit = kept.get(f);
    if (hit) {
      kept.delete(f);
      kept.set(f, hit);
      return hit;
    }
    const r = readRecorded(f, by);
    // A file that does not read is not kept: the collector's can be found half written and reads a moment later.
    // Kept, it would hide the hour's own file for as long as the pool is asked for.
    if (!r) return null;
    kept.set(f, r);
    for (const k of kept.keys()) {
      if (kept.size <= RECORDED_KEEP) break;
      kept.delete(k);
    }
    return r;
  };
  return {
    /**
     * The recorded list: every pool with its hours, its first and last hour and how many of them are the raw-arrays
     * job's. It is made once for each refresh of the index, the first time it is asked for, and every call until the
     * next refresh is given that same list, so whoever is given it must not change it. Grouping the index and making
     * a path for every recording at each call held the API's one thread 12 ms a call at 31 days of 259 pools by 24
     * hours and 100 ms at 180 days, measured on a quiet machine, and several times that on a busy one. Making the
     * list takes 3 ms and 17 ms, once a minute at most, and a call after that nothing that can be measured.
     */
    pools(): readonly RecordedPool[] {
      const i = idx();
      i.pools ??= listOf(i.hours);
      return i.pools;
    },
    /**
     * The newest readable recording of a pool, or null. An hour whose first file does not read is read from the
     * next folder that holds it, before any older hour is.
     */
    latest(pool: string): Recorded | null {
      const { hours } = idx();
      if (!seen.has(pool)) return null;
      for (let i = hours.length - 1; i >= 0; i--)
        for (const h of holding(hours[i] as HourFolder[], pool)) {
          const r = readKept(fileOf(h, pool), byOf(h.folder));
          if (r) return r;
        }
      return null;
    },
    /**
     * Every readable recording of a pool at or after `since` (ms), oldest first, read one at a time: one an hour,
     * the first that reads of the folders that hold it.
     */
    *since(pool: string, since: number): Generator<Recorded> {
      const { hours } = idx();
      if (!seen.has(pool)) return;
      for (const sameHour of hours) {
        if (Date.parse(isoHour(sameHour[0] as HourFolder)) < since - 3_600_000) continue;
        for (const h of holding(sameHour, pool)) {
          const r = readRecorded(fileOf(h, pool), byOf(h.folder));
          if (!r) continue;
          if (Date.parse(r.fetchedAt) >= since) yield r;
          break;
        }
      }
    },
  };
}
export type RecordedStore = ReturnType<typeof recordedStore>;
