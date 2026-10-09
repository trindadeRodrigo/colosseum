import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type BuiltPool,
  buildPoolSim,
  type CostSplit,
  decodeClmmPool,
  type PoolRef,
  ROUTE_CHUNKS,
  type RouteLeg,
  type RoutePool,
  routeTrade,
  type TwoHopPool,
  usdCurves,
  type ViaTrade,
} from '@colosseum/risk';

// The split snapshot's inputs as data (PLAN-UNIVERSE RU.11): which registry pools one run reads, the accounts it
// read, and the SOL price beside them. `pnpm risk:split-snapshot` reads them from the chain; `pnpm risk:split-capture`
// freezes them to a file, and the snapshot and `pnpm risk:routing-gap --router` route from that file with no network.
// This file imports no client and reads no environment: the chain reader, the price and the clock are passed in.

export const SPLIT_CAPTURE_KIND = 'split-capture-0.1';
export const USD_MINTS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
export const SOL = 'So11111111111111111111111111111111111111112';

/** One pool as the collector's registry holds it (`~/.colosseum/risk/registry.json`). */
export type RegPool = PoolRef & {
  assetSymbol: string;
  quoteMint: string;
  quoteSymbol?: string | null;
  exitPath: string;
  tier: string;
  tvlUsd: number;
  decimals0: number;
  decimals1: number;
  vault0: string;
  vault1: string;
};
type RawRegPool = Omit<RegPool, 'assetIsToken0'> & { assetIsToken0: boolean | number };

/** Why a pool of the registry is listed and not routed, with the money it holds. */
export type ListedGroup = { reason: string; pools: number; tvlUsd: number };

export type SplitSelection = {
  /** Dollar and SOL exit pools of tiers A and B, in registry order: what the snapshot has read since `split-0.1`. */
  direct: RegPool[];
  /** Stock-to-stock pools with at least one tracked stock; empty unless two hops are on. */
  twoHop: RegPool[];
  /** Pools of tiers A and B that no route uses, by reason; null unless two hops are on. */
  listed: ListedGroup[] | null;
};

/**
 * The pools one run reads. With `twoHop` off this is the `split-0.1` rule and nothing else. With it on, the pools that
 * pair two stock tokens are added when at least one of the two is tracked (`tracked`: the mints of the chain's asset
 * list); which direction of such a pool is routed is decided when the pools are built, by whether the other stock is
 * tracked and has a dollar or SOL pool in the same run.
 */
export function selectSplitPools(
  registryPools: readonly RawRegPool[],
  opts: { twoHop: boolean; tracked: ReadonlySet<string> },
): SplitSelection {
  const ab = registryPools
    .filter((p) => ['A', 'B'].includes(p.tier))
    .map((p) => ({ ...p, assetIsToken0: Boolean(p.assetIsToken0) })) as RegPool[];
  const direct = ab.filter((p) => p.exitPath === 'direct_usd' || p.exitPath === 'via_sol');
  if (!opts.twoHop) return { direct, twoHop: [], listed: null };
  const stockPairs = ab.filter((p) => p.exitPath === 'via_xstock');
  const twoHop = stockPairs.filter(
    (p) => opts.tracked.has(p.assetMint) || opts.tracked.has(p.quoteMint),
  );
  const group = (reason: string, ps: RegPool[]): ListedGroup => ({
    reason,
    pools: ps.length,
    tvlUsd: ps.reduce((s, p) => s + p.tvlUsd, 0),
  });
  const listed = [
    group(
      'quote_token_has_no_measured_way_to_dollars',
      ab.filter((p) => p.exitPath === 'other'),
    ),
    group(
      'neither_stock_is_tracked',
      stockPairs.filter((p) => !twoHop.includes(p)),
    ),
  ];
  return { direct, twoHop, listed };
}

/** Everything one run read, as data. Account bytes are base64; an account the chain did not return is null. */
export type SplitCapture = {
  kind: typeof SPLIT_CAPTURE_KIND;
  startedAt: string;
  fetchedAt: string;
  /** Context slot of the last batch of pool accounts, and of the last batch of config and child accounts. */
  slotHeads: number;
  slot: number;
  solUsd: number | null;
  solUsdSource: string;
  twoHop: boolean;
  /**
   * Symbols the capture was cut to (`pnpm risk:split-capture --only`), or null or absent for a whole run. A capture
   * cut to some stocks holds every pool of those stocks, but only part of the stock-to-stock pools of the stocks they
   * are paired with: two hops are measured for the named stocks only (`twoHopWholeFor`).
   */
  only?: string[] | null;
  /** Mints of the tracked stocks, and the file they were read from; empty with two hops off. */
  tracked: string[];
  trackedSource: string | null;
  registry: { fetchedAt: string | null; methodVersion: string | null };
  direct: RegPool[];
  twoHopPools: RegPool[];
  listed: ListedGroup[] | null;
  children: Record<string, string[]>;
  accounts: Record<string, string | null>;
  rpc: { calls: number; seconds: number };
  source: string;
  method: string;
  provenance: 'live';
};

export type AccountReader = (
  keys: string[],
) => Promise<{ slot: number; accounts: Map<string, { data: Uint8Array } | null> }>;

/**
 * Reads one run's accounts: every selected pool, then the Raydium fee configs and the tick or bin arrays the
 * collector's cache lists for them (no getProgramAccounts). With two hops off the keys and their order are those of
 * `split-0.1`, so the same requests are sent.
 */
export async function readSplitCapture(
  sel: SplitSelection,
  cacheChildren: Record<string, string[]>,
  meta: {
    twoHop: boolean;
    only?: string[] | null;
    tracked: string[];
    trackedSource: string | null;
    registry: { fetchedAt: string | null; methodVersion: string | null };
  },
  deps: {
    read: AccountReader;
    solUsd: () => Promise<number | null>;
    now: () => Date;
    rpcCalls: () => number;
  },
): Promise<SplitCapture> {
  const t0 = deps.now();
  const calls0 = deps.rpcCalls();
  const pools = [...sel.direct, ...sel.twoHop];
  const heads = await deps.read(pools.map((p) => p.address));
  // A stock-to-stock pool whose account does not decode is listed when the pools are built: it must not stop the
  // read before the rows every reader depends on. A dollar or SOL pool that does not decode throws, as it always has.
  const stockPairs = new Set(sel.twoHop.map((p) => p.address));
  const cfgKeys = pools
    .filter((p) => p.venue === 'raydium_clmm')
    .map((p) => {
      const h = heads.accounts.get(p.address)?.data;
      if (!h) return null;
      if (!stockPairs.has(p.address)) return decodeClmmPool(h).ammConfig;
      try {
        return decodeClmmPool(h).ammConfig;
      } catch {
        return null;
      }
    })
    .filter((k): k is string => !!k);
  const children: Record<string, string[]> = {};
  for (const p of pools) children[p.address] = cacheChildren[p.address] ?? [];
  const childKeys = pools.flatMap((p) => children[p.address] as string[]);
  const rest = await deps.read([...new Set([...cfgKeys, ...childKeys])]);
  const fetchedAt = deps.now();
  const solUsd = await deps.solUsd();
  const accounts: Record<string, string | null> = {};
  for (const m of [heads.accounts, rest.accounts])
    for (const [k, a] of m) accounts[k] = a ? Buffer.from(a.data).toString('base64') : null;
  return {
    kind: SPLIT_CAPTURE_KIND,
    startedAt: t0.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    slotHeads: heads.slot,
    slot: rest.slot,
    solUsd,
    solUsdSource: 'lite-api.jup.ag/price/v3',
    twoHop: meta.twoHop,
    only: meta.only ?? null,
    tracked: meta.tracked,
    trackedSource: meta.trackedSource,
    registry: meta.registry,
    direct: sel.direct,
    twoHopPools: sel.twoHop,
    listed: sel.listed,
    children,
    accounts,
    rpc: {
      calls: deps.rpcCalls() - calls0,
      seconds: (fetchedAt.getTime() - t0.getTime()) / 1000,
    },
    source:
      'Solana RPC getMultipleAccounts (pool and child accounts from the collector cache); Jupiter price API (SOL)',
    method: 'split_inputs_frozen',
    provenance: 'live',
  };
}

export function saveCapture(file: string, c: SplitCapture): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, gzipSync(JSON.stringify(c)));
}

export function loadCapture(file: string): SplitCapture {
  const c = JSON.parse(gunzipSync(readFileSync(file)).toString()) as SplitCapture;
  if (c.kind !== SPLIT_CAPTURE_KIND) throw new Error(`${file}: not a ${SPLIT_CAPTURE_KIND} file`);
  return c;
}

/** Whether a capture holds every stock-to-stock pool of this stock: always, unless it was cut to other stocks. */
export const twoHopWholeFor = (c: SplitCapture, symbol: string): boolean =>
  !c.only || c.only.includes(symbol);

/**
 * One account's bytes from a capture; undefined when the chain did not return it or it was not read. An account the
 * chain returned with no data is zero bytes, not undefined, as the snapshot saw it before captures existed.
 */
export const captureBytes = (c: SplitCapture, key: string): Uint8Array | undefined => {
  const s = c.accounts[key];
  return s === null || s === undefined ? undefined : new Uint8Array(Buffer.from(s, 'base64'));
};

/** One asset of a run: its dollar and SOL pools as the router takes them, and the stock-to-stock pools it may use. */
export type SplitAsset = { symbol: string; pools: RoutePool[]; twoHop: TwoHopPool[] };

/** One direction of a stock-to-stock pool that no route uses, with the reason and the money the pool holds. */
export type NotRouted = {
  pool: string;
  asset: string;
  assetMint: string;
  via: string;
  viaSymbol: string | null;
  tvlUsd: number;
  reason:
    | 'via_not_tracked'
    | 'via_pool_read_incomplete'
    | 'via_has_no_pool_in_this_run'
    | 'asset_has_no_pool_in_this_run'
    | 'pool_not_built'
    | 'pool_read_incomplete';
};

export type BuiltSplit = {
  /** Assets by mint, in the order their first pool was built. */
  byAsset: Map<string, SplitAsset>;
  /**
   * Per tracked stock whose dollar and SOL pools were all read whole in this run, that stock's own `pools`: the
   * second hop of a two-hop route.
   */
  via: Map<string, RoutePool[]>;
  failures: string[];
  notRouted: NotRouted[];
};

// What the read of one pool lacks, in the words a line of `failures` uses, or null when it counts as read whole.
// Either none of its tick or bin arrays was read (Raydium and Orca would then be simulated as one range with no end,
// Meteora with no mid), or one the collector's cache lists did not come back (the pool would be simulated with a hole
// in its liquidity), or it is a Raydium CLMM pool and its fee config was not read (it would be simulated with a fee
// of 0). The arrays are looked at first, without decoding the pool; for the config a Raydium pool account is decoded,
// and what its decoder throws is thrown.
const readGap = (c: SplitCapture, p: RegPool, head: Uint8Array): string | null => {
  if (p.venue !== 'raydium_cpmm') {
    const kids = c.children[p.address] ?? [];
    const read = kids.filter((k) => captureBytes(c, k) !== undefined).length;
    if (!read) return 'no tick or bin array read';
    if (read < kids.length)
      return `${kids.length - read} of ${kids.length} tick or bin arrays not read`;
  }
  if (p.venue === 'raydium_clmm' && captureBytes(c, decodeClmmPool(head).ammConfig) === undefined)
    return 'no fee config read';
  return null;
};

// One pool's simulator from a capture's bytes: the Raydium fee config named by the pool account, and the tick or bin
// arrays the capture lists for the pool. Throws what the decoders throw.
const simFromCapture = (c: SplitCapture, p: RegPool, head: Uint8Array): BuiltPool => {
  const cfg =
    p.venue === 'raydium_clmm' ? captureBytes(c, decodeClmmPool(head).ammConfig) : undefined;
  const kids = (c.children[p.address] ?? [])
    .map((k) => captureBytes(c, k))
    .filter((d): d is Uint8Array => !!d);
  return buildPoolSim(p, head, kids, cfg);
};

/**
 * Whether every one of these dollar and SOL pools was read whole in the capture: its tick or bin arrays and, for a
 * Raydium CLMM pool, its fee config. A pool read with a gap is still built and still in the `split-0.1` rows, as it
 * always was; this is what decides that its stock is no second hop, and that a comparison with Jupiter leaves it out.
 * Only the capture's own pools are judged: every pool `buildSplit` builds is one of them.
 */
export function readWholeIn(c: SplitCapture, pools: readonly RoutePool[]): boolean {
  const row = new Map(c.direct.map((p) => [p.address, p]));
  return pools.every((rp) => {
    const p = row.get(rp.pool);
    if (!p) return true;
    const head = captureBytes(c, rp.pool);
    return !!head && readGap(c, p, head) === null;
  });
}

/**
 * One capture as router inputs: no I/O, no clock, no environment.
 *
 * The dollar and SOL pools are built as the snapshot has built them since `split-0.1`: same order, same failures,
 * same fields. That includes a pool read with a gap, which is still built as it was then: a Raydium or Orca pool with
 * no tick array read is built as one range with no end, and a Raydium pool with no fee config read is built with a
 * fee of 0 (a Meteora pool with no bin array read has no mid and is skipped, with no line). So a run with two hops
 * off routes what it routed before, and the `split-0.1` rows of a run with them on are the same rows.
 *
 * With two hops on, each stock-to-stock pool is built once and offered in both directions, each of its two stocks
 * traded through the other (the via token). A direction is routed, that is added to the traded stock's `twoHop`, only
 * when all of the following hold. Otherwise it is listed in `notRouted` with the reason of the first that does not:
 * - the pool was built from a whole read. `pool_read_incomplete`: none of its tick or bin arrays was read, or it is a
 *   Raydium CLMM pool and its fee config was not; `failures` has a line that names which (the arrays, when both).
 *   `pool_not_built`: its account is missing or does not decode, with a line in `failures`, or its mid is not a
 *   positive number, with none (a Raydium CPMM pool always: no vault is read for it);
 * - the via token is tracked (`via_not_tracked`);
 * - every dollar and SOL pool built for the via token was read whole, by the same test (`via_pool_read_incomplete`).
 *   One such pool with a gap and the stock is no second hop at all, because the via trade is routed over all of
 *   them. Its pools, their lines in `failures` and its own rows stay as the paragraph above says;
 * - the via token has a dollar or SOL pool built in this capture (`via_has_no_pool_in_this_run`);
 * - the traded stock has one too, which gives its reference price (`asset_has_no_pool_in_this_run`).
 * `via` holds the second hops: for each tracked stock that passed, its own `pools`.
 *
 * Nothing is taken from another snapshot: every account, array, config and price is the capture's own, and a second
 * hop that is missing, was not read or was read with a gap is not routed.
 */
export function buildSplit(c: SplitCapture): BuiltSplit {
  const byAsset = new Map<string, SplitAsset>();
  const failures: string[] = [];
  for (const p of c.direct) {
    const head = captureBytes(c, p.address);
    if (!head) {
      failures.push(`${p.address}: head missing`);
      continue;
    }
    const quoteUsd = USD_MINTS.has(p.quoteMint) ? 1 : p.quoteMint === SOL ? c.solUsd : null;
    if (!quoteUsd) {
      failures.push(`${p.address}: no USD for quote ${p.quoteMint}`);
      continue;
    }
    try {
      const built = simFromCapture(c, p, head);
      const decAsset = p.assetIsToken0 ? p.decimals0 : p.decimals1;
      const decQuote = p.assetIsToken0 ? p.decimals1 : p.decimals0;
      const midUsd = usdCurves(built.sim, decAsset, decQuote, quoteUsd, [100]).midUsd;
      if (!(midUsd > 0)) continue;
      const a = byAsset.get(p.assetMint) ?? { symbol: p.assetSymbol, pools: [], twoHop: [] };
      a.symbol = p.assetSymbol;
      a.pools.push({
        pool: p.address,
        sim: built.sim,
        decAsset,
        decQuote,
        quoteUsd,
        midUsd,
        tvlUsd: p.tvlUsd,
        feeRate: built.feeRate,
        transferFeeBps: {
          asset: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
          quote: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
        },
      });
      byAsset.set(p.assetMint, a);
    } catch (e) {
      failures.push(`${p.address}: ${String(e).slice(0, 80)}`);
    }
  }
  const via = new Map<string, RoutePool[]>();
  const notRouted: NotRouted[] = [];
  if (!c.twoHop) return { byAsset, via, failures, notRouted };

  const tracked = new Set(c.tracked);
  // A tracked stock is a second hop only when every pool built for it above was read whole. The pools themselves are
  // not touched: this decides who may be a via token, nothing else. (Their accounts decoded above, so nothing throws.)
  const viaWithGap = new Set<string>();
  for (const mint of c.tracked) {
    const own = byAsset.get(mint)?.pools;
    if (!own?.length) continue;
    if (readWholeIn(c, own)) via.set(mint, own);
    else viaWithGap.add(mint);
  }
  for (const p of c.twoHopPools) {
    // built once and offered in both directions; a mid that is not a positive number serves neither
    let built: BuiltPool | null = null;
    // a pool read with a gap is listed, never built: its line says what is missing
    let gap: string | null = null;
    const head = captureBytes(c, p.address);
    if (!head) failures.push(`${p.address}: head missing`);
    else
      try {
        gap = readGap(c, p, head);
        if (gap) failures.push(`${p.address}: ${gap}`);
        else {
          const b = simFromCapture(c, p, head);
          if (b.sim.midRaw > 0 && Number.isFinite(b.sim.midRaw)) built = b;
        }
      } catch (e) {
        failures.push(`${p.address}: ${String(e).slice(0, 80)}`);
      }
    // the stock the pool is filed under (the sim's asset side), then the other one (the sim's quote side)
    const filed = {
      mint: p.assetMint,
      symbol: p.assetSymbol as string | null | undefined,
      dec: p.assetIsToken0 ? p.decimals0 : p.decimals1,
      feeBps: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
    };
    const other = {
      mint: p.quoteMint,
      symbol: p.quoteSymbol,
      dec: p.assetIsToken0 ? p.decimals1 : p.decimals0,
      feeBps: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
    };
    for (const [asset, viaSide, assetIsSimAsset] of [
      [filed, other, true],
      [other, filed, false],
    ] as const) {
      const own = byAsset.get(asset.mint);
      const list = (reason: NotRouted['reason']) =>
        notRouted.push({
          pool: p.address,
          asset: asset.symbol ?? own?.symbol ?? asset.mint,
          assetMint: asset.mint,
          via: viaSide.mint,
          viaSymbol: viaSide.symbol ?? byAsset.get(viaSide.mint)?.symbol ?? null,
          tvlUsd: p.tvlUsd,
          reason,
        });
      if (!built) {
        list(gap ? 'pool_read_incomplete' : 'pool_not_built');
        continue;
      }
      if (!tracked.has(viaSide.mint)) {
        list('via_not_tracked');
        continue;
      }
      if (viaWithGap.has(viaSide.mint)) {
        list('via_pool_read_incomplete');
        continue;
      }
      if (!via.has(viaSide.mint)) {
        list('via_has_no_pool_in_this_run');
        continue;
      }
      // no dollar or SOL pool of its own: no reference price, so no rows
      if (!own?.pools.length) {
        list('asset_has_no_pool_in_this_run');
        continue;
      }
      own.twoHop.push({
        pool: p.address,
        sim: built.sim,
        assetIsSimAsset,
        via: viaSide.mint,
        decAsset: asset.dec,
        decVia: viaSide.dec,
        tvlUsd: p.tvlUsd,
        feeRate: built.feeRate,
        transferFeeBps: { asset: asset.feeBps, via: viaSide.feeBps },
      });
    }
  }
  return { byAsset, via, failures, notRouted };
}

/**
 * A capture seen as a run with two hops off: its dollar and SOL pools, the accounts read for them, and nothing of the
 * stock-to-stock pools. This is what `RISK_SPLIT_REPLAY` routes when the setting is off, whatever the capture holds.
 * The read's own numbers (`rpc`, the slots, the times) stay those of the read that was made.
 */
export function oneHopView(c: SplitCapture): SplitCapture {
  const keep = new Set<string>();
  const children: Record<string, string[]> = {};
  for (const p of c.direct) {
    const kids = c.children[p.address] ?? [];
    children[p.address] = kids;
    keep.add(p.address);
    for (const k of kids) keep.add(k);
    const head = p.venue === 'raydium_clmm' ? captureBytes(c, p.address) : undefined;
    if (head) keep.add(decodeClmmPool(head).ammConfig);
  }
  const accounts: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(c.accounts)) if (keep.has(k)) accounts[k] = v;
  return {
    ...c,
    twoHop: false,
    tracked: [],
    trackedSource: null,
    twoHopPools: [],
    listed: null,
    children,
    accounts,
  };
}

/** The sizes every run routes, in dollars, each as a sale and as a purchase. */
export const SPLIT_NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
export const SPLIT_METHOD_VERSION = 'split-0.1';
export const SPLIT_TWO_HOP_METHOD_VERSION = 'split-0.2';
const SPLIT_SOURCE =
  'Solana RPC getMultipleAccounts (pool and child accounts from the collector cache); Jupiter price API (SOL)';

/** The collector's routed row of one asset (`~/.colosseum/risk/assets/<day>.jsonl`): what the drift is measured on. */
export type CollectorRow = {
  fetchedAt: string;
  pools: number;
  sell: Array<{ notionalUsd: number; costPct: number }>;
};

/** Per asset, the collector's row nearest in time to `fetchedAt`; the earlier line keeps a tie. */
export function nearestCollectorRows(jsonl: string, fetchedAt: string): Map<string, CollectorRow> {
  const collector = new Map<string, CollectorRow>();
  for (const l of jsonl.split('\n')) {
    if (!l) continue;
    const r = JSON.parse(l) as CollectorRow & { assetMint: string };
    const prev = collector.get(r.assetMint);
    if (
      !prev ||
      Math.abs(Date.parse(r.fetchedAt) - Date.parse(fetchedAt)) <
        Math.abs(Date.parse(prev.fetchedAt) - Date.parse(fetchedAt))
    )
      collector.set(r.assetMint, r);
  }
  return collector;
}

/** One line of `SPLIT_DIR/<day>.jsonl`: one asset, side and size routed over its dollar and SOL pools (`split-0.1`). */
export type SplitRowOut = {
  assetMint: string;
  asset: string;
  fetchedAt: string;
  slot: number;
  side: 'sell' | 'buy';
  notionalUsd: number;
  outUsd: number;
  costPct: number;
  poolsUsed: number;
  pools: number;
  refPool: string;
  refMidUsd: number;
  split: CostSplit;
  legs: RouteLeg[];
  solUsd: number | null;
  vsCollector: { fetchedAt: string; pools: number; costPct: number } | null;
  source: string;
  method: string;
  methodVersion: string;
  provenance: 'live';
};

/**
 * One line of `SPLIT_DIR/two-hop/<day>.jsonl`: the same trade with the stock-to-stock pools offered as well
 * (`split-0.2`), beside what the dollar and SOL pools alone give at the same snapshot.
 */
export type TwoHopRowOut = {
  assetMint: string;
  asset: string;
  fetchedAt: string;
  slot: number;
  side: 'sell' | 'buy';
  notionalUsd: number;
  outUsd: number;
  costPct: number;
  poolsUsed: number;
  /** Dollar and SOL pools offered, stock-to-stock pools offered, and how many of those took an amount. */
  pools: number;
  twoHopPools: number;
  twoHopUsed: number;
  refPool: string;
  refMidUsd: number;
  split: CostSplit;
  legs: RouteLeg[];
  viaTrades: ViaTrade[] | null;
  oneHop: { outUsd: number; costPct: number; poolsUsed: number };
  /**
   * Basis points of the size that two hops save: positive when the two-hop route is cheaper. At a size that empties
   * every dollar and SOL pool (most stocks at $1,000,000 and above) it is not liquidity: a chunk no pool can fill
   * stops being charged to a dollar pool, and the figure rises.
   */
  gainBp: number;
  solUsd: number | null;
  source: string;
  method: string;
  methodVersion: string;
  provenance: 'live';
};

const rowKey = (assetMint: string, side: string, notionalUsd: number) =>
  `${assetMint}|${side}|${notionalUsd}`;

/**
 * The `split-0.1` rows of one run, from what `buildSplit` built: no I/O, no clock. Routed over the dollar and SOL
 * pools only, whatever the capture holds: the same assets in the same order, the same keys in the same order, the
 * same numbers. Every reader of `SPLIT_DIR/<day>.jsonl` depends on that. `drift` is the absolute difference in cost,
 * in percentage points, between each sale up to $250k and the collector's row for it, in row order (the caller sorts).
 */
export function oneHopRows(
  built: BuiltSplit,
  c: SplitCapture,
  opts: { collector?: ReadonlyMap<string, CollectorRow> } = {},
): { rows: SplitRowOut[]; drift: number[] } {
  const rows: SplitRowOut[] = [];
  const drift: number[] = [];
  for (const [mint, a] of built.byAsset) {
    const col = opts.collector?.get(mint);
    for (const side of ['sell', 'buy'] as const)
      for (const n of SPLIT_NOTIONALS) {
        const r = routeTrade(a.pools, n, side);
        const cc = side === 'sell' ? col?.sell.find((x) => x.notionalUsd === n) : undefined;
        if (cc && n <= 250_000) drift.push(Math.abs(r.costPct - cc.costPct));
        rows.push({
          assetMint: mint,
          asset: a.symbol,
          fetchedAt: c.fetchedAt,
          slot: c.slot,
          side,
          notionalUsd: n,
          outUsd: r.outUsd,
          costPct: r.costPct,
          poolsUsed: r.poolsUsed,
          pools: a.pools.length,
          refPool: r.refPool,
          refMidUsd: r.refMidUsd,
          split: r.split,
          legs: r.legs,
          solUsd: c.solUsd,
          vsCollector:
            cc && col ? { fetchedAt: col.fetchedAt, pools: col.pools, costPct: cc.costPct } : null,
          source: SPLIT_SOURCE,
          method: 'routed_greedy_32_chunks with per-pool split (packages/risk/src/pools/route.ts)',
          methodVersion: SPLIT_METHOD_VERSION,
          provenance: 'live',
        });
      }
  }
  return { rows, drift };
}

/**
 * The assets of a run that get `split-0.2` rows, in the order of `byAsset`: those with a stock-to-stock pool they may
 * use and, in a capture cut to some stocks, only those stocks (`twoHopWholeFor`). A stock that such a capture pulled
 * in as a partner comes with only part of its stock-to-stock pools, so a row for it would show the gain of the pools
 * that were read as if they were all of them. None unless the capture was taken with two hops.
 */
export const twoHopAssets = (built: BuiltSplit, c: SplitCapture): Array<[string, SplitAsset]> =>
  c.twoHop
    ? [...built.byAsset].filter(([, a]) => a.twoHop.length > 0 && twoHopWholeFor(c, a.symbol))
    : [];

/**
 * The `split-0.2` rows: for each asset of `twoHopAssets`, each side and size routed with its stock-to-stock pools
 * offered, beside the one-hop answer of the same trade, which is taken from `rows` (the run's own `split-0.1` rows,
 * so both answers are of one snapshot). Empty unless the capture was taken with two hops.
 */
export function twoHopRowsOf(
  built: BuiltSplit,
  c: SplitCapture,
  rows: readonly SplitRowOut[],
): TwoHopRowOut[] {
  const out: TwoHopRowOut[] = [];
  const oneHop = new Map(rows.map((r) => [rowKey(r.assetMint, r.side, r.notionalUsd), r]));
  for (const [mint, a] of twoHopAssets(built, c)) {
    for (const side of ['sell', 'buy'] as const)
      for (const n of SPLIT_NOTIONALS) {
        const r = oneHop.get(rowKey(mint, side, n));
        if (!r) throw new Error(`twoHopRowsOf: no one-hop row for ${mint} ${side} ${n}`);
        const t = routeTrade(a.pools, n, side, ROUTE_CHUNKS, { pools: a.twoHop, via: built.via });
        out.push({
          assetMint: mint,
          asset: a.symbol,
          fetchedAt: c.fetchedAt,
          slot: c.slot,
          side,
          notionalUsd: n,
          outUsd: t.outUsd,
          costPct: t.costPct,
          poolsUsed: t.poolsUsed,
          pools: a.pools.length,
          twoHopPools: a.twoHop.length,
          twoHopUsed: t.legs.filter((l) => l.via).length,
          refPool: t.refPool,
          refMidUsd: t.refMidUsd,
          split: t.split,
          legs: t.legs,
          viaTrades: t.viaTrades ?? null,
          oneHop: { outUsd: r.outUsd, costPct: r.costPct, poolsUsed: r.poolsUsed },
          gainBp: (r.costPct - t.costPct) * 100,
          solUsd: c.solUsd,
          source: SPLIT_SOURCE,
          method:
            'routed_greedy_32_chunks with two hops through a tracked stock (packages/risk/src/pools/route.ts)',
          methodVersion: SPLIT_TWO_HOP_METHOD_VERSION,
          provenance: 'live',
        });
      }
  }
  return out;
}

/** Both sets of rows of one run and the drift: `oneHopRows`, then `twoHopRowsOf` on them. */
export function splitRows(
  built: BuiltSplit,
  c: SplitCapture,
  opts: { collector?: ReadonlyMap<string, CollectorRow> } = {},
): { rows: SplitRowOut[]; twoHopRows: TwoHopRowOut[]; drift: number[] } {
  const { rows, drift } = oneHopRows(built, c, opts);
  return { rows, twoHopRows: twoHopRowsOf(built, c, rows), drift };
}

/** The directions `buildSplit` did not route, counted for a run's summary. */
export type NotRoutedSummary = {
  /** By reason, in order of first appearance. A pool counts once per reason, and so does its money. */
  byReason: Array<{
    reason: NotRouted['reason'];
    directions: number;
    pools: number;
    tvlUsd: number;
  }>;
  /** Stock-to-stock pools routed in neither direction, and the money they hold: what no route reaches. */
  poolsWithNoRoute: number;
  tvlUsdWithNoRoute: number;
};

export function notRoutedSummary(built: BuiltSplit): NotRoutedSummary {
  const routed = new Set<string>();
  for (const a of built.byAsset.values()) for (const t of a.twoHop) routed.add(t.pool);
  const byReason = new Map<
    NotRouted['reason'],
    { directions: number; pools: Map<string, number> }
  >();
  const none = new Map<string, number>();
  for (const n of built.notRouted) {
    const g = byReason.get(n.reason) ?? { directions: 0, pools: new Map<string, number>() };
    g.directions++;
    g.pools.set(n.pool, n.tvlUsd);
    byReason.set(n.reason, g);
    if (!routed.has(n.pool)) none.set(n.pool, n.tvlUsd);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
  return {
    byReason: [...byReason].map(([reason, g]) => ({
      reason,
      directions: g.directions,
      pools: g.pools.size,
      tvlUsd: sum(g.pools),
    })),
    poolsWithNoRoute: none.size,
    tvlUsdWithNoRoute: sum(none),
  };
}
