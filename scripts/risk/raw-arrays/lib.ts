import { basename, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  buildPoolSim,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeDlmmBinArray,
  decodeWhirlpool,
  decodeWpTickArray,
} from '@colosseum/risk';
import { type AccountReader, captureBytes, type RegPool, type SplitCapture } from '../lib-split';

// PLAN-UNIVERSE RU.12 — the hourly raw recording of every concentrated-liquidity pool of the tracked stocks that the
// pool collector does not record itself. The collector (scripts/risk/collector/pools.ts, not edited before Oct 12)
// writes the pool account and the tick arrays of the Raydium and Orca pools among the pools that hold 80% of registry
// TVL, each in the runs where it lists the pool's arrays again; this job writes the others every hour in the same file
// format, into a folder of its own, and the API reads both (apps/api/src/pool-recorded.ts). This file is the part
// with no client, no environment and no clock: which pools one run reads, what becomes of each, the bytes of a
// recording, and the run's row. scripts/risk/raw-arrays/job.ts holds the reader, the clock and the files.

export const RAW_ARRAYS_METHOD_VERSION = 'raw-arrays-0.1';
export const RAW_ARRAYS_SOURCE =
  'Solana RPC getMultipleAccounts (pool account, Raydium fee config, every tick or bin array the pool collector’s cache lists)';
export const RAW_ARRAYS_METHOD =
  'raw account bytes, base64, one file per pool and hour in the pool collector’s raw format';

/** The venues with tick or bin arrays. A constant-product pool has none and is no part of this. */
export const CL_VENUES: ReadonlySet<string> = new Set([
  'raydium_clmm',
  'orca_whirlpool',
  'meteora_dlmm',
]);
const KNOWN_VENUES: ReadonlySet<string> = new Set([...CL_VENUES, 'raydium_cpmm']);
const KNOWN_TIERS: ReadonlySet<string> = new Set(['A', 'B']);

type RawRegPool = Omit<RegPool, 'assetIsToken0'> & { assetIsToken0: boolean | number };

/**
 * The pools the collector writes raw, by its own rule, from the registry it reads: `rawSet` is every registry pool
 * taken in order of TVL until the running sum reaches `RAW_TOP_SHARE` (0.8) of the total, and a pool of that set is
 * written only when it is a Raydium CLMM or an Orca pool (`isCl`; a Meteora pool of the set is never written). The
 * collector cannot be imported (it runs on import and is not edited), so the rule is written again here, and
 * tests/risk-layer/raw-arrays.test.ts fails when the collector's lines change.
 */
export const COLLECTOR_RAW_TOP_SHARE = 0.8;
export function collectorRecorded(
  registryPools: ReadonlyArray<{ address: string; venue: string; tvlUsd: number }>,
): Set<string> {
  const total = registryPools.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);
  let cum = 0;
  const top = new Set<string>();
  for (const p of [...registryPools].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
    if (cum >= COLLECTOR_RAW_TOP_SHARE * total) break;
    cum += p.tvlUsd;
    top.add(p.address);
  }
  return new Set(
    registryPools
      .filter(
        (p) => top.has(p.address) && (p.venue === 'raydium_clmm' || p.venue === 'orca_whirlpool'),
      )
      .map((p) => p.address),
  );
}

export type RawSelection = {
  /** Every concentrated-liquidity pool of a tracked stock in the registry (tiers A and B), in registry order. */
  all: RegPool[];
  /** What this run reads and writes. */
  read: RegPool[];
  /** The pools of `all` the collector writes under its own rule, whether or not this run reads them too. */
  collector: RegPool[];
  /** The collector's pools this run does not read: all of them, or none when the run is set to read every pool. */
  leftToCollector: RegPool[];
  /** Left out by the setting (exit paths named in RISK_RAW_ARRAYS_SKIP). */
  leftOutBySetting: RegPool[];
  /**
   * Pools of a tracked stock on a venue or in a tier this selection does not know: in none of the lists above, so the
   * run says it is not accounted. Empty on every registry seen.
   */
  notUnderstood: RegPool[];
};

/**
 * The pools one run reads: every concentrated-liquidity pool of a tracked stock, less the ones the collector writes
 * itself (unless `everyPool`), less the exit paths the setting names. A pool is a tracked stock's when the registry
 * files it under one, and also when it pairs two stock tokens and the tracked one is on the other side: the registry
 * files such a pool once, and the router reads it for both stocks (`selectSplitPools`). The collector's set is derived
 * from the same registry in the same call, so a new registry moves both sides together and no pool falls between.
 */
export function selectRawArrayPools(
  registryPools: readonly RawRegPool[],
  opts: { tracked: ReadonlySet<string>; skipExitPaths?: ReadonlySet<string>; everyPool?: boolean },
): RawSelection {
  const inCollectorRule = collectorRecorded(registryPools);
  const ofTracked = registryPools
    .filter(
      (p) =>
        opts.tracked.has(p.assetMint) ||
        (p.exitPath === 'via_xstock' && opts.tracked.has(p.quoteMint)),
    )
    .map((p) => ({ ...p, assetIsToken0: Boolean(p.assetIsToken0) })) as RegPool[];
  const notUnderstood = ofTracked.filter(
    (p) => !KNOWN_VENUES.has(p.venue) || !KNOWN_TIERS.has(p.tier),
  );
  const all = ofTracked.filter((p) => CL_VENUES.has(p.venue) && KNOWN_TIERS.has(p.tier));
  const collector = all.filter((p) => inCollectorRule.has(p.address));
  const leftToCollector = opts.everyPool ? [] : collector;
  const left = new Set(leftToCollector.map((p) => p.address));
  const leftOutBySetting = all.filter(
    (p) => !left.has(p.address) && !!opts.skipExitPaths?.has(p.exitPath),
  );
  const out = new Set([...leftToCollector, ...leftOutBySetting].map((p) => p.address));
  return {
    all,
    read: all.filter((p) => !out.has(p.address)),
    collector,
    leftToCollector,
    leftOutBySetting,
    notUnderstood,
  };
}

/**
 * What of an RPC address must never be logged: the address as it is spelled, and each piece of its path and of its
 * query long enough to be a key. A provider can repeat the key alone in an error, without the address around it.
 */
export function secretsOf(address: string | undefined): string[] {
  if (!address) return [];
  const pieces = address.split(/[/?&=#]/).filter((x) => x.length >= 8 && !x.includes('.'));
  return [address, ...pieces];
}

/** An error as it may be logged: its message, with anything shaped like an address and every secret taken out. */
export function scrubbed(e: unknown, secrets: ReadonlyArray<string | undefined> = []): string {
  const err = e as { message?: string; cause?: { code?: string } } | undefined;
  let text = String(err?.message ?? e);
  for (const s of secrets) if (s) text = text.split(s).join('<secret>');
  text = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
  // a failed fetch says why only in its cause (ENOTFOUND, ETIMEDOUT)
  const code = err?.cause?.code;
  return (code ? `${text} (${code})` : text).slice(0, 300);
}

/**
 * The chain reader, one batch at a time, remembering what the shared one forgets: the context slot each account came
 * at, and which accounts could not be read. A batch that throws is tried again (`attempts` in all); if it still
 * throws, or the run is past its time, its accounts are handed on as not returned and kept in `failed` with the
 * reason, so the batches already read are not lost and a pool that lacks one is `read_failed`, never written with a
 * hole. The shared rpc() already waits and retries on a rate limit and on a broken connection; this adds the errors
 * it throws at once.
 */
export function batchedReader(
  read: AccountReader,
  opts: {
    size?: number;
    attempts?: number;
    pauseMs?: number;
    /** True once the run should make no further call. */
    pastDeadline?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    say?: (e: unknown) => string;
  } = {},
) {
  const size = opts.size ?? 100;
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const say = opts.say ?? ((e: unknown) => scrubbed(e));
  const slots = new Map<string, number>();
  const failed = new Map<string, string>();
  const stats = { batches: 0, batchRetries: 0, batchesFailed: 0 };
  const wrapped: AccountReader = async (keys) => {
    const accounts = new Map<string, { data: Uint8Array } | null>();
    let slot = 0;
    for (let i = 0; i < keys.length; i += size) {
      const batch = keys.slice(i, i + size);
      stats.batches++;
      let why = '';
      let done = false;
      for (let a = 1; a <= attempts && !done; a++) {
        if (opts.pastDeadline?.()) {
          // a batch that was tried and failed keeps what the RPC said; one never tried says only that
          why = why
            ? `${why}; the run was past its time before it was read again`
            : 'the run was past its time before this batch was read';
          break;
        }
        if (a > 1) stats.batchRetries++;
        try {
          const r = await read(batch);
          slot = r.slot;
          for (const k of batch) {
            accounts.set(k, r.accounts.get(k) ?? null);
            slots.set(k, r.slot);
          }
          done = true;
        } catch (e) {
          why = say(e);
          if (a < attempts) await sleep(opts.pauseMs ?? 1_000);
        }
      }
      if (!done) {
        stats.batchesFailed++;
        for (const k of batch) {
          accounts.set(k, null);
          failed.set(k, why);
        }
      }
    }
    return { slot, accounts };
  };
  return { read: wrapped, slots, failed, stats };
}

/**
 * `readSplitCapture` decodes each Raydium pool account to find its fee config and throws when one does not decode,
 * which would stop the whole run for one account. This wraps the chain reader so such an account is handed on as not
 * returned, and remembered here with what the decoder said: the pool is then listed as `decode_failed`.
 */
export function withholdingUndecodable(
  read: AccountReader,
  pools: readonly RegPool[],
): { read: AccountReader; undecodable: Map<string, string> } {
  const raydium = new Set(pools.filter((p) => p.venue === 'raydium_clmm').map((p) => p.address));
  const undecodable = new Map<string, string>();
  return {
    undecodable,
    read: async (keys) => {
      const r = await read(keys);
      for (const [k, a] of r.accounts) {
        if (!a || !raydium.has(k)) continue;
        // an account with no data is one the chain did not return (head_missing), not one to decode
        if (!a.data.length) {
          r.accounts.set(k, null);
          continue;
        }
        try {
          decodeClmmPool(a.data);
        } catch (e) {
          undecodable.set(k, String(e).slice(0, 120));
          r.accounts.set(k, null);
        }
      }
      return r;
    },
  };
}

/**
 * One recording as it is written: the collector's seven keys in the collector's order (scripts/risk/collector/pools.ts,
 * the write under `rawSet`), then this job's own. A reader of the collector's files reads these the same way.
 */
export type RawRecording = {
  pool: string;
  venue: string;
  /** The highest context slot among the batches this pool's arrays came in. */
  slot: number;
  fetchedAt: string;
  head: string;
  /** Every address the cache lists for the pool, in its order; "" for one the chain did not return, or returned empty. */
  children: Record<string, string>;
  /** The Raydium CLMM fee config the pool account names; null for another venue, or when it was not returned. */
  config: string | null;
  /** Context slot of the batch this pool's account came in. Its arrays are read after it. */
  slotHead: number;
  /** When the collector listed these arrays (`childrenAt` of its cache), or null when it does not say. */
  childrenListedAt: string | null;
  /**
   * Raydium and Orca: |Σ liquidityNet at or below the current tick − the pool's liquidity| ÷ the pool's liquidity,
   * over the arrays read. Above 1e-9 the arrays read do not add up to the pool account. At or below it nothing is
   * proven about an array above the price: on one read of 192 pools, 43 in 100 arrays could be left out without
   * moving it. Null for Meteora, which has no such check.
   */
  invariantRelErr: number | null;
  source: string;
  method: string;
  methodVersion: string;
  provenance: 'live';
};

export type NotWrittenReason =
  /** The chain returned no pool account, or one with no data. */
  | 'head_missing'
  /** The collector's cache lists no account for the pool: it has not listed it yet. */
  | 'no_arrays_in_cache'
  /** The cache lists accounts and none that came back is a tick or bin array of this pool. */
  | 'no_array_read'
  /** The pool account or an array does not decode with packages/risk/src/pools; `detail` is what the decoder said. */
  | 'decode_failed'
  /** The pool account, its fee config or one of its listed arrays is in a batch the RPC did not answer. */
  | 'read_failed'
  /** The pool account and its arrays were read too many slots apart to be one state of the pool. */
  | 'read_torn'
  /** The file could not be written; `detail` is the error. Set by the job, not here. */
  | 'write_failed';

export type PoolFlags = {
  /** Accounts the cache lists that the chain did not return, or returned empty: kept under their address as "". */
  arraysMissing?: number;
  /**
   * The arrays read do not add up to the pool account (`invariantRelErr` above 1e-9, the collector's own test): an
   * array exists that the cache does not list yet, or liquidity in range changed between the read of the pool account
   * and the read of its arrays. The recording is written as read.
   */
  liquidityCheckFailed?: number;
  /** The simulator built from the bytes has no positive mid: a Meteora pool none of whose bins holds anything. */
  noMid?: true;
  /** A Raydium pool whose fee config was not returned: `config` is null. */
  configMissing?: true;
};

export type PoolOutcome =
  | {
      pool: RegPool;
      written: true;
      recording: RawRecording;
      /**
       * Accounts the cache lists, those the chain returned with data, and those that are a tick or bin array of this
       * pool. A Raydium list also holds the pool's tick-array bitmap extension, which is no tick array.
       */
      arrays: { listed: number; returned: number; decoded: number };
      /** Bytes of the accounts in the recording, before base64 and gzip. */
      accountBytes: number;
      flags: PoolFlags;
    }
  | { pool: RegPool; written: false; reason: NotWrittenReason; detail: string | null };

/** The collector's limit for its liquidity check (`built.invariantRelErr > 1e-9` in its run loop). */
export const LIQUIDITY_CHECK_LIMIT = 1e-9;
/**
 * The most slots between a pool's account and its arrays for the two to be written as one recording: about two
 * minutes. A run reads them within about 20 slots; a read stretched by a sleeping machine or a long backoff is past it.
 */
export const MAX_SLOT_GAP = 300;

const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');

// The accounts among `kids` that are a tick or bin array of this pool, by the venue's own decoder. Throws what the
// decoders throw.
const arraysOf = (p: RegPool, head: Uint8Array, kids: readonly Uint8Array[]): number => {
  if (p.venue === 'raydium_clmm')
    return kids.filter((d) => decodeClmmTickArray(d)?.pool === p.address).length;
  if (p.venue === 'orca_whirlpool') {
    const spacing = decodeWhirlpool(head).tickSpacing;
    return kids.filter((d) => decodeWpTickArray(d, spacing)?.pool === p.address).length;
  }
  return kids.filter((d) => decodeDlmmBinArray(d).pair === p.address).length;
};

/**
 * What becomes of each pool of one read: a recording, or the reason there is none. Every pool given comes back
 * exactly once, in the order given. A pool is written only when its bytes decode into a simulator with
 * packages/risk/src/pools, so a file on disk is one the reader can decode. `slots` and `failed` are the batched
 * reader's: with them a recording carries its own two slots, and a pool one of whose accounts was in a batch the RPC
 * did not answer is `read_failed`, which is not the same as an account the chain says is not there.
 */
export function poolOutcomes(
  c: SplitCapture,
  pools: readonly RegPool[],
  opts: {
    childrenAt?: Readonly<Record<string, string>>;
    undecodable?: ReadonlyMap<string, string>;
    slots?: ReadonlyMap<string, number>;
    failed?: ReadonlyMap<string, string>;
    maxSlotGap?: number;
  } = {},
): PoolOutcome[] {
  // an account the chain returned with no data is one it did not return: the reader of these files skips both
  const bytes = (k: string) => {
    const d = captureBytes(c, k);
    return d?.length ? d : undefined;
  };
  return pools.map((p): PoolOutcome => {
    const no = (reason: NotWrittenReason, detail: string | null = null): PoolOutcome => ({
      pool: p,
      written: false,
      reason,
      detail,
    });
    const unread = opts.failed?.get(p.address);
    if (unread !== undefined) return no('read_failed', `the pool account: ${unread}`);
    const bad = opts.undecodable?.get(p.address);
    if (bad !== undefined) return no('decode_failed', bad);
    const head = bytes(p.address);
    if (!head) return no('head_missing');
    const listed = c.children[p.address] ?? [];
    if (!listed.length) return no('no_arrays_in_cache');
    const lost = listed.filter((k) => opts.failed?.has(k));
    if (lost.length)
      return no(
        'read_failed',
        `${lost.length} of ${listed.length} listed accounts: ${opts.failed?.get(lost[0] as string)}`,
      );
    const kids = listed.map(bytes);
    const returned = kids.filter((d): d is Uint8Array => !!d);
    let config: Uint8Array | undefined;
    let decoded: number;
    try {
      if (p.venue === 'raydium_clmm') {
        const key = decodeClmmPool(head).ammConfig;
        const why = opts.failed?.get(key);
        if (why !== undefined) return no('read_failed', `the fee config: ${why}`);
        config = bytes(key);
      }
      decoded = arraysOf(p, head, returned);
    } catch (e) {
      return no('decode_failed', String(e).slice(0, 120));
    }
    if (!decoded)
      return no('no_array_read', `${listed.length} listed, ${returned.length} returned`);
    const slotHead = opts.slots?.get(p.address) ?? c.slotHeads;
    const kidSlots = listed.flatMap((k, i) => {
      const s = kids[i] ? opts.slots?.get(k) : undefined;
      return s === undefined ? [] : [s];
    });
    const slot = kidSlots.length ? Math.max(...kidSlots) : c.slot;
    // from the earliest to the latest of the pool's accounts: its own account and every array
    const apart = Math.max(slotHead, slot, ...kidSlots) - Math.min(slotHead, slot, ...kidSlots);
    if (apart > (opts.maxSlotGap ?? MAX_SLOT_GAP))
      return no(
        'read_torn',
        `${apart} slots between the first and the last of the pool's accounts`,
      );
    let invariantRelErr: number | null;
    let mid: number;
    try {
      const built = buildPoolSim(p, head, returned, config);
      invariantRelErr = built.invariantRelErr;
      mid = built.sim.midRaw;
    } catch (e) {
      return no('decode_failed', String(e).slice(0, 120));
    }
    const flags: PoolFlags = {};
    if (returned.length < listed.length) flags.arraysMissing = listed.length - returned.length;
    if (invariantRelErr !== null && invariantRelErr > LIQUIDITY_CHECK_LIMIT)
      flags.liquidityCheckFailed = invariantRelErr;
    if (!(mid > 0 && Number.isFinite(mid))) flags.noMid = true;
    if (p.venue === 'raydium_clmm' && !config) flags.configMissing = true;
    return {
      pool: p,
      written: true,
      recording: {
        pool: p.address,
        venue: p.venue,
        slot,
        fetchedAt: c.fetchedAt,
        head: b64(head),
        children: Object.fromEntries(listed.map((k, i) => [k, kids[i] ? b64(kids[i]) : ''])),
        config: config ? b64(config) : null,
        slotHead,
        childrenListedAt: opts.childrenAt?.[p.address] ?? null,
        invariantRelErr,
        source: RAW_ARRAYS_SOURCE,
        method: RAW_ARRAYS_METHOD,
        methodVersion: RAW_ARRAYS_METHOD_VERSION,
        provenance: 'live',
      },
      arrays: { listed: listed.length, returned: returned.length, decoded },
      accountBytes:
        head.length + returned.reduce((s, d) => s + d.length, 0) + (config ? config.length : 0),
      flags,
    };
  });
}

/** The bytes of one file: gzip of the recording as JSON, as the collector writes its own. */
export const encodeRecording = (r: RawRecording): Buffer => gzipSync(JSON.stringify(r));

/** `<day>/<hour>` of a recording, UTC: the two folders its file sits in, as in the collector's raw folder. */
export const hourFolder = (fetchedAt: string): { day: string; hour: string } => ({
  day: fetchedAt.slice(0, 10),
  hour: fetchedAt.slice(11, 13),
});

/**
 * Why the job may not write into a folder, or null when it may. The job writes only into a folder of its own: never
 * a collector's raw folder or anything inside one, never a collector's home or another folder of it, except the one
 * the installed job is given there (`raw-arrays`), and never a folder that holds a collector's home.
 *
 * Two folders are the same folder when the disk says so, not when their names match: `idOf` gives what a path is on
 * the disk (its device and inode, following links), or null when nothing is there yet. A link to the raw folder,
 * another letter case on a disk that does not tell cases apart and another spelling of the same volume are then all
 * the raw folder. Where a folder is not there yet, its name is what is compared. `homes` are the collector's home of
 * this run (RISK_HOME) and the default one, so a run pointed at a rehearsal home still may not write into the live one.
 */
export function folderRefusal(
  dir: string,
  homes: readonly string[],
  collectorRaw: readonly string[],
  idOf: (path: string) => string | null,
): string | null {
  if (!dir) return 'no folder is named';
  // a folder and every folder above it, nearest first
  const up = (path: string) => {
    const out: Array<{ path: string; id: string | null }> = [];
    for (let p = path; ; p = dirname(p)) {
      out.push({ path: p, id: idOf(p) });
      if (dirname(p) === p) break;
    }
    return out;
  };
  const chain = up(dir);
  // where in `chain` a folder is: 0 when `dir` is that folder, above 0 when `dir` is inside it, -1 when it is neither
  const at = (folder: string) => {
    const id = idOf(folder);
    return chain.findIndex((c) => c.path === folder || (id !== null && c.id === id));
  };
  for (const raw of collectorRaw)
    if (raw && at(raw) >= 0) return `${dir} is the collector's raw folder, or inside it`;
  for (const home of homes) {
    if (!home) continue;
    const i = at(home);
    if (i === 0) return `${dir} is the collector's home`;
    if (i > 0 && basename((chain[i - 1] as { path: string }).path) !== 'raw-arrays')
      return `${dir} is inside the collector's home and is not its raw-arrays folder`;
    if (
      i < 0 &&
      up(home).some((c) => c.path === dir || (chain[0]?.id != null && c.id === chain[0].id))
    )
      return `${dir} holds the collector's home`;
  }
  return null;
}

type Group = { pools: number; tvlUsd: number; arrays: number };
const group = (ps: readonly RegPool[], kids: Readonly<Record<string, string[]>>): Group => ({
  pools: ps.length,
  tvlUsd: ps.reduce((s, p) => s + p.tvlUsd, 0),
  arrays: ps.reduce((s, p) => s + (kids[p.address]?.length ?? 0), 0),
});
const by = <K extends string>(
  ps: readonly RegPool[],
  key: (p: RegPool) => K,
  kids: Readonly<Record<string, string[]>>,
): Record<K, Group> => {
  const out = {} as Record<K, Group>;
  for (const k of [...new Set(ps.map(key))].sort())
    out[k] = group(
      ps.filter((p) => key(p) === k),
      kids,
    );
  return out;
};

/**
 * What a run would read, from the registry and the cache alone (no network): `pnpm risk:raw-arrays --plan`. `arrays`
 * counts the accounts the cache lists, which for a Raydium pool include its bitmap extension. The accounts are the
 * pool accounts and those; the Raydium fee configs are a few more (15 for 135 pools when measured), known only once
 * the pool accounts are read, so the calls are a lower bound by at most one.
 */
export function planOf(sel: RawSelection, cacheChildren: Readonly<Record<string, string[]>>) {
  const arrays = new Set(sel.read.flatMap((p) => cacheChildren[p.address] ?? [])).size;
  return {
    ofTracked: group(sel.all, cacheChildren),
    read: group(sel.read, cacheChildren),
    collector: group(sel.collector, cacheChildren),
    leftToCollector: group(sel.leftToCollector, cacheChildren),
    leftOutBySetting: group(sel.leftOutBySetting, cacheChildren),
    notUnderstood: sel.notUnderstood.map((p) => ({
      pool: p.address,
      venue: p.venue,
      tier: p.tier,
    })),
    readByExitPath: by(sel.read, (p) => p.exitPath, cacheChildren),
    readByVenue: by(sel.read, (p) => p.venue, cacheChildren),
    readByStock: by(sel.read, (p) => p.assetSymbol, cacheChildren),
    collectorByExitPath: by(sel.collector, (p) => p.exitPath, cacheChildren),
    noArraysInCache: sel.read
      .filter((p) => !cacheChildren[p.address]?.length)
      .map((p) => p.address),
    accounts: sel.read.length + arrays,
    rpcCalls: Math.ceil(sel.read.length / 100) + Math.ceil(arrays / 100),
  };
}

const listed = (p: RegPool) => ({
  pool: p.address,
  asset: p.assetSymbol,
  quote: p.quoteSymbol ?? null,
  venue: p.venue,
  exitPath: p.exitPath,
  tvlUsd: p.tvlUsd,
});

const quantile = (xs: readonly number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};

/** The pool counts of a run, and where every pool of the selection is. */
const counts = (sel: RawSelection, written: number, notWritten: number) => ({
  ofTracked: sel.all.length,
  leftToCollector: sel.leftToCollector.length,
  leftOutBySetting: sel.leftOutBySetting.length,
  read: sel.read.length,
  written,
  notWritten,
});

/**
 * The row of a run that stopped before its pools had an outcome: the counts, and one reason for every pool it was
 * to read, which is that the run failed at this stage. Nothing was written for any of them.
 */
export function failedRunPools(sel: RawSelection, stage: string) {
  return {
    pools: counts(sel, 0, sel.read.length),
    everyPoolNotWritten: {
      reason: 'run_failed',
      stage,
      pools: sel.read.length,
      tvlUsd: sel.read.reduce((s, p) => s + p.tvlUsd, 0),
    },
  };
}

/**
 * The run's row, less what only the job knows (the clock, the files, the RPC counters). Every pool of the tracked
 * stocks is in exactly one of four places: written, not written with its reason, left to the collector, left out by
 * the setting. `accounted` says so: false when the numbers do not add up, or when the registry files a pool of a
 * tracked stock on a venue or in a tier the selection does not know.
 */
export function runSummary(
  sel: RawSelection,
  outcomes: readonly PoolOutcome[],
  c: SplitCapture,
  bytes: ReadonlyMap<string, number>,
) {
  const written = outcomes.filter((o) => o.written);
  const notWritten = outcomes.filter((o) => !o.written);
  const fetched = Date.parse(c.fetchedAt);
  const ages = written
    .map((o) => o.recording.childrenListedAt)
    .filter((t): t is string => !!t)
    .map((t) => (fetched - Date.parse(t)) / 60_000);
  const gaps = written.map((o) => Math.abs(o.recording.slot - o.recording.slotHead));
  const sizeOf = (os: typeof written) =>
    os.reduce((s, o) => s + (bytes.get(o.pool.address) ?? 0), 0);
  const groups = <K extends string>(key: (p: RegPool) => K) => {
    const out = {} as Record<K, { pools: number; tvlUsd: number; written: number; bytes: number }>;
    for (const k of [...new Set(outcomes.map((o) => key(o.pool)))].sort()) {
      const os = outcomes.filter((o) => key(o.pool) === k);
      const ws = written.filter((o) => key(o.pool) === k);
      out[k] = {
        pools: os.length,
        tvlUsd: os.reduce((s, o) => s + o.pool.tvlUsd, 0),
        written: ws.length,
        bytes: sizeOf(ws),
      };
    }
    return out;
  };
  const flagged = (f: keyof PoolFlags) =>
    written
      .filter((o) => o.flags[f] !== undefined)
      .map((o) => ({ pool: o.pool.address, asset: o.pool.assetSymbol, value: o.flags[f] }));
  const accounts = Object.values(c.accounts);
  const sum = (f: (o: (typeof written)[number]) => number) => written.reduce((s, o) => s + f(o), 0);
  return {
    pools: counts(sel, written.length, notWritten.length),
    accounted:
      sel.all.length ===
        sel.leftToCollector.length + sel.leftOutBySetting.length + sel.read.length &&
      sel.read.length === outcomes.length &&
      !sel.notUnderstood.length,
    tvlUsd: {
      written: written.reduce((s, o) => s + o.pool.tvlUsd, 0),
      notWritten: notWritten.reduce((s, o) => s + o.pool.tvlUsd, 0),
      leftToCollector: sel.leftToCollector.reduce((s, p) => s + p.tvlUsd, 0),
      leftOutBySetting: sel.leftOutBySetting.reduce((s, p) => s + p.tvlUsd, 0),
    },
    // every pool with no file, not a sample: with the reason, and what the decoder, the RPC or the disk said
    notWritten: notWritten.map((o) => ({
      ...listed(o.pool),
      reason: o.written ? null : o.reason,
      detail: o.written ? null : o.detail,
    })),
    leftOutBySetting: sel.leftOutBySetting.map(listed),
    notUnderstood: sel.notUnderstood.map((p) => ({ ...listed(p), tier: p.tier })),
    flags: {
      arraysMissing: flagged('arraysMissing'),
      liquidityCheckFailed: flagged('liquidityCheckFailed'),
      noMid: flagged('noMid'),
      configMissing: flagged('configMissing'),
    },
    byExitPath: groups((p) => p.exitPath),
    byVenue: groups((p) => p.venue),
    // accounts the cache lists for the pools written (a Raydium list holds one that is no tick array), those the
    // chain returned, and those that are a tick or bin array of their pool
    arrays: {
      listed: sum((o) => o.arrays.listed),
      returned: sum((o) => o.arrays.returned),
      decoded: sum((o) => o.arrays.decoded),
    },
    // how old the collector's lists were when the arrays were read, in minutes, over the pools written
    listAgeMinutes: {
      median: quantile(ages, 0.5),
      max: ages.length ? Math.max(...ages) : null,
      unknown: written.length - ages.length,
    },
    // slots between each written pool's account and its arrays
    slotGap: { median: quantile(gaps, 0.5), max: gaps.length ? Math.max(...gaps) : null },
    accounts: {
      requested: accounts.length,
      returned: accounts.filter((a) => a !== null).length,
    },
    bytes: {
      written: sizeOf(written),
      accounts: sum((o) => o.accountBytes),
    },
  };
}
