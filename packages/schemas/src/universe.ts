import { z } from 'zod';
import { AssetClass } from './basket-asset';
import { Address, AssetId, ChainId, chainFamily, isAddressOf } from './chain';
import { Provenance } from './enums';

// The asset list of one chain (gate UNIVERSE, PLAN-UNIVERSE RU.4): the tracked stocks, the pools they
// trade in and the oracle a rebalance needs. One file per chain under scripts/risk/universe/, generated
// by `pnpm risk:universe <chain>` and committed. Additive: nothing else in this package changes.

/** Where a figure came from. On every row and on every oracle. */
const Stamp = {
  source: z.string().min(1),
  fetchedAt: z.string().datetime(),
  method: z.string().min(1),
  provenance: Provenance,
};

/**
 * The oracle the vault would check a rebalance against. It is a reference, never a price: no answer is
 * stored here, and nothing is compared with a pool price (gate ORACLE-VS-DEX).
 */
export const TrackedOracle = z
  .strictObject({
    kind: z.enum(['chainlink', 'scope']),
    /**
     * Where the price is, in the form of `BasketAsset.priceRef`.
     * - `chainlink`: the feed's proxy address, lower case.
     * - `scope`: the entry index as a decimal string, 0 to 511, in `account`.
     */
    ref: z.string().min(1),
    /** `scope`: the price account the index is in. `chainlink`: null. */
    account: z.string().nullable(),
    /** `scope`: the entry of the average the vault compares the price with. `chainlink`: null. */
    twapRef: z.string().nullable(),
    /** `chainlink`: description() and decimals() of the feed as its contract answered. `scope`: null. */
    description: z.string().nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    /**
     * What the oracle prices, where its source says so. `token_with_multiplier`: the share's price times
     * the issuer's multiplier. `token_from_pools`: a price taken from the pools on chain, which is not an
     * independent check on the pools. Null with `pricesReason` where the source does not say. No
     * multiplier is applied to anything here.
     */
    prices: z.enum(['token_with_multiplier', 'token_from_pools']).nullable(),
    pricesReason: z.string().min(1).nullable(),
    ...Stamp,
  })
  .refine((o) => (o.prices === null) === (o.pricesReason !== null), {
    message: 'what the oracle prices, or the reason it is not said',
    path: ['pricesReason'],
  });
export type TrackedOracle = z.infer<typeof TrackedOracle>;

/** The pools of one tracked stock. Counts only: the pools themselves stay in the chain's own files. */
export const TrackedPools = z.strictObject({
  /** Every pool of the stock holding the rule's floor or more with a measured TVL. Contains the cut. */
  ranked: z.number().int().min(0),
  /** Of those, the pools inside the share that names the tracked stocks. */
  inCut: z.number().int().min(0),
  /** Of the ranked pools, how many the vault's swap path reaches (DU3). Null with a reason where reach is not recorded. */
  reachable: z.number().int().min(0).nullable(),
  reachableReason: z.string().min(1).nullable(),
  /** The ranked pools by venue, each with how many of them the vault reaches. */
  byVenue: z.record(
    z.string().min(1),
    z.strictObject({
      pools: z.number().int().min(0),
      reachable: z.number().int().min(0).nullable(),
    }),
  ),
  /** Of the ranked pools, the ones whose other side is a stock token too. Counted here and nowhere else. */
  twoStock: z.number().int().min(0),
  /**
   * Ranked pools filed under another tracked stock in which this stock is the other side. They are
   * counted under that stock, not here.
   */
  twoStockAsOther: z.number().int().min(0),
  /** The ranked pools by how a seller reaches dollars, where the chain's registry records it. */
  byExitPath: z.record(z.string().min(1), z.number().int().min(0)).optional(),
  /** Pools of the stock left out of `ranked`: measured below the floor, and with no TVL (never zero). */
  dust: z.number().int().min(0),
  unmeasured: z.number().int().min(0),
});
export type TrackedPools = z.infer<typeof TrackedPools>;

export const TrackedAssetBase = z.strictObject({
  // identity, in the shape of BasketAsset
  id: AssetId,
  chain: ChainId,
  address: Address,
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
  cls: AssetClass,
  /** Where `cls` comes from: the generator's table of funds, or the default for every other token. */
  clsSource: z.enum(['class_table', 'default_stock']),
  underlying: z.string().min(1),
  issuer: z.string().min(1),
  session: z.enum(['always', 'us_equity']),

  /** True when a pool of the stock is inside the cut at this run. Every row of one run is. */
  inCut: z.boolean(),
  pools: TrackedPools,
  /** Dollars in the ranked pools, in the cut's pools, and in the ranked pools the vault reaches. */
  tvlUsd: z.number().min(0),
  cutUsd: z.number().min(0),
  reachableUsd: z.number().min(0).nullable(),
  /** `tvlUsd` over the money in every ranked pool of the chain. */
  share: z.number().min(0).max(1),

  /** Null with `oracleReason` when the stock has no confirmed oracle. */
  oracle: TrackedOracle.nullable(),
  oracleReason: z.string().min(1).nullable(),
  /** True only with an oracle (gate UNIVERSE). False carries the reason. */
  autoRebalance: z.boolean(),
  autoRebalanceReason: z.string().min(1).nullable(),
  /** A question about this row's oracle that is not answered here. The row is written by the rule; who answers is the vault stream. */
  autoRebalanceOpen: z.string().min(1).nullable(),

  ...Stamp,
});

export const TrackedAsset = TrackedAssetBase.refine((a) => a.id.startsWith(`${a.chain}:`), {
  message: "the id starts with the asset's chain",
  path: ['id'],
})
  .refine((a) => isAddressOf(chainFamily(a.chain), a.address), {
    message: "the address is in the form of the asset's chain",
    path: ['address'],
  })
  .refine((a) => (a.oracle === null) === (a.oracleReason !== null), {
    message: 'an oracle or the reason there is none, never both and never neither',
    path: ['oracleReason'],
  })
  .refine((a) => !a.autoRebalance || a.oracle !== null, {
    message: 'automatic rebalancing needs an oracle',
    path: ['autoRebalance'],
  })
  .refine((a) => a.autoRebalance === (a.autoRebalanceReason === null), {
    message: 'false carries its reason, true carries none',
    path: ['autoRebalanceReason'],
  })
  .refine((a) => (a.pools.reachable === null) === (a.pools.reachableReason !== null), {
    message: 'a count of reachable pools or the reason there is none',
    path: ['pools', 'reachableReason'],
  })
  .refine((a) => (a.pools.reachable === null) === (a.reachableUsd === null), {
    message: 'reachable dollars go with reachable pools',
    path: ['reachableUsd'],
  })
  .refine((a) => a.inCut === a.pools.inCut > 0, {
    message: 'inCut says whether a pool of the stock is in the cut',
    path: ['inCut'],
  })
  .refine(
    (a) =>
      a.pools.inCut <= a.pools.ranked &&
      (a.pools.reachable ?? 0) <= a.pools.ranked &&
      a.pools.twoStock <= a.pools.ranked,
    { message: 'a count of ranked pools is at most the ranked pools', path: ['pools'] },
  )
  .refine((a) => a.cutUsd <= a.tvlUsd && (a.reachableUsd ?? 0) <= a.tvlUsd, {
    message: 'the money in the cut and in reach is part of the money in the ranked pools',
    path: ['tvlUsd'],
  })
  .refine(
    (a) =>
      a.oracle === null ||
      (a.oracle.kind === 'chainlink'
        ? chainFamily(a.chain) === 'evm' && isAddressOf('evm', a.oracle.ref)
        : a.chain === 'solana' &&
          /^(?:0|[1-9]\d{0,2})$/.test(a.oracle.ref) &&
          Number(a.oracle.ref) <= 511),
    {
      message: "the oracle's kind and ref are those of the asset's chain",
      path: ['oracle', 'ref'],
    },
  );
export type TrackedAsset = z.infer<typeof TrackedAsset>;

/** One chain's file. */
export const AssetList = z
  .strictObject({
    chain: ChainId,
    ...Stamp,
    /** The files the list was written from, by name. */
    inputs: z.record(z.string().min(1), z.string().min(1)),
    /** The rule the cut was made by (gate UNIVERSE, DU1). */
    rule: z.strictObject({ share: z.number().gt(0).max(1), minPoolUsd: z.number().min(0) }),
    /** Dollars in every ranked pool of the chain: the base of each row's `share`. */
    rankedUsd: z.number().min(0),
    counts: z.strictObject({
      assets: z.number().int().min(0),
      withOracle: z.number().int().min(0),
      withoutOracle: z.number().int().min(0),
      withoutOracleByReason: z.record(z.string().min(1), z.number().int().min(1)),
      autoRebalance: z.number().int().min(0),
      rankedPools: z.number().int().min(0),
      reachablePools: z.number().int().min(0).nullable(),
      twoStockPools: z.number().int().min(0),
    }),
    /** What the list does and does not decide, in words. */
    stated: z.record(z.string().min(1), z.string().min(1)),
    assets: z.array(TrackedAsset),
  })
  .refine((l) => l.assets.every((a) => a.chain === l.chain), {
    message: "every row is on the file's chain",
    path: ['assets'],
  })
  .refine((l) => new Set(l.assets.map((a) => a.address)).size === l.assets.length, {
    message: 'one row per token address',
    path: ['assets'],
  })
  .refine((l) => new Set(l.assets.map((a) => a.id)).size === l.assets.length, {
    message: 'one row per id',
    path: ['assets'],
  })
  .refine(
    (l) =>
      l.counts.assets === l.assets.length &&
      l.counts.withOracle === l.assets.filter((a) => a.oracle !== null).length &&
      l.counts.withoutOracle === l.assets.filter((a) => a.oracle === null).length &&
      l.counts.autoRebalance === l.assets.filter((a) => a.autoRebalance).length &&
      l.counts.rankedPools === l.assets.reduce((s, a) => s + a.pools.ranked, 0) &&
      l.counts.twoStockPools === l.assets.reduce((s, a) => s + a.pools.twoStock, 0),
    { message: 'the counts are those of the rows', path: ['counts'] },
  );
export type AssetList = z.infer<typeof AssetList>;
