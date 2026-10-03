import { z } from 'zod';
import { BasketAssetBase } from './basket-asset';
import type { Shelf } from './basket-sheet';
import { AssetId, Bps } from './chain';
import type { LiquidityProvider } from './liquidity';
import { type Quote, Trade } from './vault';

// DESIGN-VAULT 3.6, the types of packages/basket. The functions (flatten, view, planRebalance,
// checkCreatorLimits, rollUp, metaHash) live there; only their inputs and outputs are here.

export const Share = z.object({ key: z.string().min(1), bps: Bps });
export type Share = z.infer<typeof Share>;

/**
 * The fourteen rules an author's version can break (DESIGN-VAULT section 6), by the names and in the
 * order of fixtures/creator-limits/vectors.json. The order is the numbering: the first is 1, and a
 * refusal names the lowest-numbered rule broken. On a chain every one of them is `CreatorLimit`.
 */
export const CreatorLimitReason = z.enum([
  'FeeNotZero',
  'FlagsNotZero',
  'TooFewAssets',
  'TooManyAssets',
  'AssetNotListed',
  'DuplicateAsset',
  'WeightBelowMin',
  'WeightOffStep',
  'WeightAboveCeiling',
  'WeightSum',
  'VersionPending',
  'VersionTooSoon',
  'TurnoverTooHigh',
  'CashNotAllowed',
]);
export type CreatorLimitReason = z.infer<typeof CreatorLimitReason>;

/** A reason's number, 1 to 14, as the vectors, the Solana program and the EVM registry number it. */
export function creatorLimitReasonId(reason: CreatorLimitReason): number {
  return CreatorLimitReason.options.indexOf(reason) + 1;
}

/** The reason with that number, or null when the number is not one of the fourteen. */
export function creatorLimitReasonOf(id: number): CreatorLimitReason | null {
  return (Number.isInteger(id) && CreatorLimitReason.options[id - 1]) || null;
}

/**
 * What the author-limit check reads of a listed asset: its id, its ceiling, and its class, which is
 * how the chain's cash token is told apart (`cls: 'cash'`). A `BasketAsset[]` fits.
 */
export const LimitAsset = BasketAssetBase.pick({ id: true, maxWeightBps: true, cls: true });
export type LimitAsset = z.infer<typeof LimitAsset>;

export const LimitContext = z.object({
  /** The platform list of the recipe's chain. */
  assets: z.array(LimitAsset),
  /** Unix seconds. */
  now: z.number().int().nonnegative(),
  /** Unix seconds of the last publish. Null before the first version. */
  lastPublishAt: z.number().int().nonnegative().nullable(),
  hasPending: z.boolean(),
  /**
   * Seconds. One delay, not two (section 6): the least time between two versions, and the time
   * between a later version being published and taking effect.
   */
  publishDelay: z.number().int().nonnegative(),
});
export type LimitContext = z.infer<typeof LimitContext>;

export const LimitResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), turnoverBps: Bps }),
  z.object({
    ok: z.literal(false),
    /** The lowest-numbered rule the version breaks. */
    code: CreatorLimitReason,
    detail: z.string(),
    /**
     * Unix seconds. Present only when waiting is all it takes: the same version, published at or after
     * this time with nothing else changed, is accepted. So it comes with `VersionTooSoon`, and only
     * when the version breaks no later rule. Absent while a version is pending: the version in effect
     * will change, and nothing can be promised against it.
     */
    allowedAt: z.number().int().nonnegative().optional(),
  }),
]);
export type LimitResult = z.infer<typeof LimitResult>;

/**
 * What `view` and `planRebalance` read of the chain's asset list: each token's decimals. Neither
 * `VaultState` nor `Price` carries them, and a value cannot be worked out without them. A
 * `BasketAsset[]` fits.
 */
export const AssetUnits = BasketAssetBase.pick({ id: true, decimals: true });
export type AssetUnits = z.infer<typeof AssetUnits>;

/** What the planner is held to. */
export const RebalancePolicy = z.object({
  /** A weight within this many bps of its target is in place. 0 when planning a deposit. */
  bandBps: Bps,
  /**
   * The dust threshold: no trade worth less than this many dollars. A float, and safe as one: it is a
   * setting that a value is compared against, never an amount that moves.
   */
  minTradeUsd: z.number().nonnegative(),
  /**
   * The most a trade is expected to lose, in bps. The purchases count on each sale bringing in this
   * much less, so that sales and purchases sent together do not run out of cash. Left out, it is 0:
   * the plan is exact at the given prices.
   */
  costBps: Bps.optional(),
});
export type RebalancePolicy = z.infer<typeof RebalancePolicy>;

/** A plan, and what it had to leave out: what `rebalancePlan` returns. `planRebalance` returns the trades alone. */
export const RebalancePlan = z.object({
  /** Sales first, then purchases; every trade has the chain's cash token on one side. */
  trades: z.array(Trade),
  /** Assets that are held or are targets and have no price, or are not on the asset list. None is traded. */
  unpriced: z.array(AssetId),
  /**
   * False when one of the unpriced assets is both held and a target. The vault's value is then
   * unknown, every weight with it, and no trade is planned.
   */
  weighed: z.boolean(),
});
export type RebalancePlan = z.infer<typeof RebalancePlan>;

/**
 * Holds a provider, so it is a type only. `now` is an ISO time: a stored quote cannot be called fresh
 * or stale without one, and nothing in packages/basket reads a clock.
 */
export type RollUpContext = {
  shelf: Shelf;
  liquidity?: LiquidityProvider;
  quotes: Quote[];
  now: string;
};

export const RiskRollUp = z.object({
  byIssuer: z.array(Share),
  byChain: z.array(Share),
  byClass: z.array(Share),
  flags: z.array(z.string()),
  /** Two exit numbers: the latest stored quote, and the measured worst regime. Null is "not measured". */
  exit: z.object({
    quotedBps: z.number().nullable(),
    quotedAt: z.string().datetime().nullable(),
    measuredWorstBps: z.number().nullable(),
    /** The share of the plan that is measured. */
    measuredShareBps: Bps,
  }),
});
export type RiskRollUp = z.infer<typeof RiskRollUp>;
