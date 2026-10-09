import { z } from 'zod';
import { RiskRollUp } from './basket';
import { AssetTier } from './basket-asset';
import {
  Address,
  AssetId,
  BasketId,
  Bps,
  ChainId,
  DecimalString,
  RawAmount,
  Sourced,
} from './chain';
import { Provenance } from './enums';
import { LegKind, LegTrigger, TradeExpected } from './order';
import { VaultPlan } from './order-api';
import { Holding, Price, VaultName, VaultNumber, VaultView } from './vault';

// The portfolio section's routes (PORT-2): a person's plans over time, read from what the snapshot
// worker kept (`vault_snapshots`, DESIGN-VAULT section 4) and from the order tables, never from a
// chain. Every answer is the signed-in person's own vaults only, on the chains this server runs, each
// chain with the label its figures carry (`mock`, `sandbox`, `live`), and ends with the disclaimer.

// ---------------------------------------------------------------------------------------------------
// The status of a plan (gate ON-TRACK-V1)
// ---------------------------------------------------------------------------------------------------

/** The rule's name and version, printed beside every status it gives. */
export const TRACK_RULE = 'ON-TRACK-V1';

/** The three words a plan's status is said in. Never odds, never a probability. */
export const TrackWord = z.enum(['on_track', 'watch', 'off_track']);
export type TrackWord = z.infer<typeof TrackWord>;

/**
 * The lines of the rule, in the order they are tried: the first that holds gives the status. The web
 * words a line in the person's language from `line` and `params`; `text` is the same sentence in
 * English.
 *
 * - `verdict`: a verdict was handed in (the engine's, ENG-3) and wins over every line below.
 * - `never_read`, `empty`: no status. The vault has no snapshot yet, or holds nothing: a deposit
 *   counts once the chain shows the vault holding it.
 * - `chain_silent`, `loss_half`: Off track. No pass of the worker went through on the vault's chain
 *   for a day; or the loss used is at or past half the chain's loss budget, the line the keeper alerts
 *   on.
 * - `unpriced`: Watch. A position that is held and is a target has no price, so the plan cannot be
 *   weighed.
 * - `no_band`: no status. The chain stated no band, so there is nothing to hold the positions to.
 * - `outside_band`, `cash_over`, `loss_quarter`, `stale`: Watch. A position is further from its target
 *   than the band; the cash is over its share by more than the band; the loss used is at or past a
 *   quarter of the budget; the newest snapshot is older than an hour.
 * - `inside`, `inside_no_budget`: On track, on a chain with a loss budget and on one that keeps none.
 */
export const TrackLine = z.enum([
  'verdict',
  'never_read',
  'empty',
  'chain_silent',
  'loss_half',
  'unpriced',
  'no_band',
  'outside_band',
  'cash_over',
  'loss_quarter',
  'stale',
  'inside',
  'inside_no_budget',
]);
export type TrackLine = z.infer<typeof TrackLine>;

/**
 * A plan's status with the line of the rule that gave it. `status` is null where the rule gives none
 * yet, and `line` says why. `params` are the figures the sentence names (basis points, minutes, an
 * asset id), numbers or strings only. `observedAt` is the time of the snapshot the status stands on,
 * null where there is none.
 */
export const TrackStatus = z.object({
  status: TrackWord.nullable(),
  /** `ON-TRACK-V1`, or the rule of the verdict that was handed in. */
  rule: z.string().min(1),
  line: TrackLine,
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  text: z.string().min(1),
  observedAt: z.string().datetime().nullable(),
});
export type TrackStatus = z.infer<typeof TrackStatus>;

/**
 * What the rule reads of a snapshot: when it was read, what the vault held, each position's target,
 * value and drift as `view()` gave them, the loss used, and the chain's band and loss budget at the
 * read. A row of `vault_snapshots` fits.
 */
export const TrackSnapshot = z.object({
  observedAt: z.string().datetime(),
  cash: z.object({ raw: RawAmount }),
  positions: z.array(
    z.object({
      asset: AssetId,
      raw: RawAmount,
      targetBps: Bps,
      /** Null when the asset has no price. */
      valueUsd: DecimalString.nullable(),
      driftBps: z.number().int().min(-10_000).max(10_000),
    }),
  ),
  lossUsedBps: Bps,
  bandBps: Bps.nullable(),
  lossCapBps: Bps.nullable(),
});
export type TrackSnapshot = z.infer<typeof TrackSnapshot>;

/**
 * The seam for the engine's verdict (ENG-3): whether the plan's goal is covered now, and under the
 * named stresses. Nothing hands one in yet. When one is handed in it wins, and the answer names its
 * rule in place of `ON-TRACK-V1`.
 */
export const TrackVerdict = z.object({
  /** Who spoke, with its version. */
  rule: z.string().min(1),
  observedOn: z.string().nullable(),
  coveredNow: z.boolean(),
  /** Null when no stress was run. */
  coveredUnderStress: z.boolean().nullable(),
});
export type TrackVerdict = z.infer<typeof TrackVerdict>;

// ---------------------------------------------------------------------------------------------------
// Shared by the four answers
// ---------------------------------------------------------------------------------------------------

/**
 * A chain of the person's that this server does not run: the answer says so, as GET /v1/portfolio
 * does, and never a zero in its place.
 */
export const ChainUnavailable = z.object({
  chain: ChainId,
  name: z.string(),
  code: z.string(),
  error: z.string(),
  retryable: z.boolean(),
});
export type ChainUnavailable = z.infer<typeof ChainUnavailable>;

/** One vault of the person's, or all of them: the query the four routes share. */
const VaultFilter = {
  /** Only this chain. */
  chain: ChainId.optional(),
  /** Only this vault. An address that is not a vault of the person's narrows the answer to nothing. */
  address: z.string().min(1).max(64).optional(),
};

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/history
// ---------------------------------------------------------------------------------------------------

/** How far apart the points of a history are: the last snapshot of each step is the step's point. */
export const HistoryStep = z.enum(['10m', '1h', '1d']);
export type HistoryStep = z.infer<typeof HistoryStep>;

/** The seconds of each step. */
export const HISTORY_STEP_SECONDS: Record<HistoryStep, number> = {
  '10m': 600,
  '1h': 3600,
  '1d': 86_400,
};

/**
 * The most steps one window spans. A window that asks for more is refused, not cut. A vault has a
 * point for each step the window touches, so one more than this at the most: a window of exactly this
 * many steps touches the step it starts in and the step it ends in.
 */
export const HISTORY_MAX_POINTS = 1000;

/**
 * `from` and `to` are ISO instants. Left out, `to` is now and `from` is as far back as the step
 * allows in `HISTORY_MAX_POINTS` points, and never more than ninety days.
 */
export const PortfolioHistoryQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  step: HistoryStep.default('1h'),
  ...VaultFilter,
});
export type PortfolioHistoryQuery = z.infer<typeof PortfolioHistoryQuery>;

/**
 * One vault at one time. `cashUsd` is the cash it held, at one dollar each. A position with no price
 * has `valueUsd: null` and weighs nothing. `source` and `method` are left out where they are the
 * series' own.
 */
export const HistoryPoint = z.object({
  observedAt: z.string().datetime(),
  valueUsd: DecimalString,
  cashUsd: DecimalString,
  positions: z.array(
    z.object({
      asset: AssetId,
      valueUsd: DecimalString.nullable(),
      weightBps: Bps,
      targetBps: Bps,
      driftBps: z.number().int().min(-10_000).max(10_000),
    }),
  ),
  lossUsedBps: Bps,
  source: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});
export type HistoryPoint = z.infer<typeof HistoryPoint>;

/**
 * A vault's points in the window, oldest first. `source` and `method` are those of its newest point:
 * where the reads came from and how the values were made. A vault with no snapshot in the window is
 * not listed.
 */
export const HistorySeries = z.object({
  address: Address,
  name: VaultName.nullable(),
  /** Its number among the person's vaults. Left out where the server holds none for it. */
  number: VaultNumber.optional(),
  source: z.string().min(1),
  method: z.string().min(1),
  points: z.array(HistoryPoint),
});
export type HistorySeries = z.infer<typeof HistorySeries>;

export const PortfolioHistoryResponse = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  step: HistoryStep,
  chains: z.array(
    z.object({
      chain: ChainId,
      name: z.string(),
      /** The label on every figure under it. */
      provenance: Provenance,
      vaults: z.array(HistorySeries),
    }),
  ),
  unavailable: z.array(ChainUnavailable),
  disclaimer: z.string(),
});
export type PortfolioHistoryResponse = z.infer<typeof PortfolioHistoryResponse>;

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/plans
// ---------------------------------------------------------------------------------------------------

export const PortfolioPlansQuery = z.object({ ...VaultFilter });
export type PortfolioPlansQuery = z.infer<typeof PortfolioPlansQuery>;

/**
 * What the person put into a vault through this app: the cash of each of their orders whose deposit
 * confirmed, counted once an order. It is gross: a withdrawal is not taken off, and money that reached
 * the vault any other way is not in it. `method` says so.
 *
 * `deposits` lists what it adds up, oldest first, one entry for each order counted, so a deposit can
 * be marked on the line of the vault's value. `usd` is exactly the sum of the deposits' `usd`, and
 * `orders` is how many there are.
 */
export const PlanPutIn = Sourced.extend({
  usd: DecimalString,
  /** How many orders it adds up. */
  orders: z.number().int().positive(),
  deposits: z.array(
    z.object({
      orderId: z.string().min(1),
      /**
       * When the server learned that the deposit had confirmed: the step's `updated_at`. No record
       * says when it confirmed on the chain.
       */
      at: z.string().datetime(),
      /** That order's cash. */
      usd: DecimalString,
    }),
  ),
});
export type PlanPutIn = z.infer<typeof PlanPutIn>;

/**
 * The newest snapshot of a vault, whole: what it held, each position's value, weight, target and
 * drift, the chain's band and loss budget at the read, and every price the values stood on, each with
 * its own source, time and method. `ageSeconds` is how old it is at the answer, and `stale` whether
 * that is more than the hour the status rule allows.
 */
export const PlanNewest = z.object({
  observedAt: z.string().datetime(),
  ageSeconds: z.number().int().nonnegative(),
  stale: z.boolean(),
  /** The chain's height at the start of the pass that read it; null where the chain could not say. */
  blockOrSlot: z.string().nullable(),
  valueUsd: DecimalString,
  cash: Holding,
  positions: VaultView.shape.positions,
  lossUsedBps: Bps,
  bandBps: Bps.nullable(),
  lossCapBps: Bps.nullable(),
  paused: z.boolean().nullable(),
  prices: z.array(Price),
  source: z.string().min(1),
  method: z.string().min(1),
  provenance: Provenance,
});
export type PlanNewest = z.infer<typeof PlanNewest>;

/**
 * The shared portfolio a vault follows, as its newest snapshot says: the portfolio's id on the chain
 * and the version the vault accepted. The family's id, slug and name are left out where the server
 * holds no row for it, never guessed.
 */
export const PlanFollows = z.object({
  recipeOnchainId: z.string().min(1),
  acceptedVersion: z.number().int().nonnegative(),
  autoFollow: z.boolean(),
  familyId: z.string().optional(),
  slug: z.string().optional(),
  name: z.string().optional(),
});
export type PlanFollows = z.infer<typeof PlanFollows>;

/**
 * One vault of the person's with its plan. `plan` is the plan it was opened for, as the server's join
 * holds it (`VaultPlan`), null for a vault no order of theirs opened. `putIn` is null where no deposit
 * of theirs into it is confirmed, and `newest` where the worker has not read the vault yet. `status`
 * is always there: with no status to give it says which line of the rule says so.
 */
export const PortfolioPlan = z.object({
  chain: ChainId,
  address: Address,
  owner: Address,
  name: VaultName.nullable(),
  /**
   * Its number among the person's vaults, there whether or not it has a name. Left out where the
   * server holds none for it. It is not `basketId`, which is the plan's number on the chain.
   */
  number: VaultNumber.optional(),
  /** The plan's number on the chain. */
  basketId: BasketId,
  plan: VaultPlan.nullable(),
  /**
   * The shared portfolio the vault was opened to follow, as the join holds it (`plan.familyId`), named
   * from the server's own row. Null for a plan made to measure, for a vault with no plan, and where
   * the server holds no row for the family. It says what the vault was opened as; `follows` says what
   * the chain shows it following now, and the two can differ.
   */
  openedFor: z.object({ familyId: z.string(), slug: z.string(), name: z.string() }).nullable(),
  putIn: PlanPutIn.nullable(),
  newest: PlanNewest.nullable(),
  status: TrackStatus,
  follows: PlanFollows.nullable(),
  provenance: Provenance,
});
export type PortfolioPlan = z.infer<typeof PortfolioPlan>;

export const PortfolioPlansResponse = z.object({
  chains: z.array(
    z.object({
      chain: ChainId,
      name: z.string(),
      provenance: Provenance,
      /** When a pass of the snapshot worker last went through on this chain; null when none has. */
      answeredAt: z.string().datetime().nullable(),
      plans: z.array(PortfolioPlan),
    }),
  ),
  unavailable: z.array(ChainUnavailable),
  disclaimer: z.string(),
});
export type PortfolioPlansResponse = z.infer<typeof PortfolioPlansResponse>;

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/rebalances
// ---------------------------------------------------------------------------------------------------

/** The most entries one answer has. */
export const REBALANCES_MAX = 200;

export const PortfolioRebalancesQuery = z.object({
  ...VaultFilter,
  limit: z.coerce.number().int().min(1).max(REBALANCES_MAX).default(50),
});
export type PortfolioRebalancesQuery = z.infer<typeof PortfolioRebalancesQuery>;

/** A position against its target in one snapshot. */
export const RebalanceDrift = z.object({
  observedAt: z.string().datetime(),
  weightBps: Bps,
  targetBps: Bps,
  driftBps: z.number().int().min(-10_000).max(10_000),
});
export type RebalanceDrift = z.infer<typeof RebalanceDrift>;

/**
 * One trade of an entry. One side is the chain's cash token; `asset` is the other.
 *
 * For a step of the owner's: `amountInRaw`, and `expected`, the quote the step was last built with
 * (what it pays out, the least the transaction accepts, and `costBps`, the cost against the
 * reference). It is a quote, not what the trade paid: nothing records that. It is left out for an
 * attempt that is not the step's latest build, whose quote was not kept.
 *
 * For an entry worked out from snapshots (`derived`): `rawBefore` and `rawAfter`, the vault's amount
 * of the asset in the two snapshots the trade lies between.
 *
 * `reference` is the asset's price in the newest snapshot before the trade, with its own source, time
 * and method. `before` and `after` are the asset's drift in the snapshots nearest each side. Each is
 * left out where there is no such snapshot.
 */
export const RebalanceTrade = z.object({
  sell: AssetId,
  buy: AssetId,
  asset: AssetId,
  amountInRaw: RawAmount.optional(),
  expected: TradeExpected.optional(),
  rawBefore: RawAmount.optional(),
  rawAfter: RawAmount.optional(),
  reference: Price.optional(),
  before: RebalanceDrift.optional(),
  after: RebalanceDrift.optional(),
});
export type RebalanceTrade = z.infer<typeof RebalanceTrade>;

/**
 * A step that reached the chain for a vault of the person's and traded or adopted a version.
 *
 * - `by: 'owner'`: an attempt of one of the person's own steps that confirmed or failed, with its
 *   transaction. `at` is when the step was built: no record says when it confirmed.
 * - `by: 'keeper'`, `derived: true`: a trade of the keeper's, worked out from two snapshots between
 *   which the vault's last keeper time on an asset changed. The keeper's own log is not in the
 *   database, so it has no transaction id, no quote and no reason; `at` is the chain's time of the
 *   trade.
 *
 * `vault` is null for a step whose vault the server has not cached.
 */
export const RebalanceEntry = Sourced.extend({
  chain: ChainId,
  vault: Address.nullable(),
  at: z.string().datetime(),
  by: z.enum(['owner', 'keeper']),
  derived: z.boolean(),
  kind: LegKind.nullable(),
  /** Why the step was made (`Leg.trigger`); null for a derived entry. */
  why: LegTrigger.nullable(),
  outcome: z.enum(['confirmed', 'failed']),
  trades: z.array(RebalanceTrade),
  orderId: z.string().min(1).nullable(),
  txId: z.string().min(1).nullable(),
  /** The link as it was stored with the transaction; null where there is none. */
  explorerUrl: z.string().nullable(),
});
export type RebalanceEntry = z.infer<typeof RebalanceEntry>;

export const PortfolioRebalancesResponse = z.object({
  chains: z.array(
    z.object({
      chain: ChainId,
      name: z.string(),
      provenance: Provenance,
      /** Newest first. */
      entries: z.array(RebalanceEntry),
    }),
  ),
  unavailable: z.array(ChainUnavailable),
  disclaimer: z.string(),
});
export type PortfolioRebalancesResponse = z.infer<typeof PortfolioRebalancesResponse>;

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/exposure
// ---------------------------------------------------------------------------------------------------

/**
 * With `address` the answer covers that one vault of the person's and no other: the sums, the roll-up
 * and the size each exit is costed at are that vault's alone.
 */
export const PortfolioExposureQuery = z.object({ ...VaultFilter });
export type PortfolioExposureQuery = z.infer<typeof PortfolioExposureQuery>;

/** A share of a total: in dollars, and in basis points of that total. */
export const ExposureShare = z.object({
  key: z.string().min(1),
  usd: DecimalString,
  bps: Bps,
});
export type ExposureShare = z.infer<typeof ExposureShare>;

/**
 * What selling the person's whole holding of one asset on one chain would cost, at that size.
 *
 * `costBps` is Bearing's measured number, with its source, time, method and label, and is null where
 * the asset is not measured or the size is beyond what was measured. Where it is not measured the
 * asset's tier is named as the fallback (gate EXIT-SOURCE), and a tier states no cost: `fallbackTier`
 * with `costBps: null`.
 *
 * `method` is the version of the method that measured it and `fetchedAt` the end of the data behind
 * the measurement. A source or a time the measurement does not have is left out, never made up.
 */
export const ExposureExit = z.object({
  asset: AssetId,
  usd: DecimalString,
  measured: z.boolean(),
  costBps: z.number().nullable(),
  fallbackTier: AssetTier.optional(),
  source: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  fetchedAt: z.string().datetime().optional(),
  provenance: Provenance.optional(),
});
export type ExposureExit = z.infer<typeof ExposureExit>;

/**
 * The person's holdings on one chain, from the newest snapshot of each of their vaults there.
 * `observedAt` is the oldest of those snapshots: the sums are no fresher than it. `unvalued` are the
 * holdings with no price, and those the chain's asset list does not name: they are in no sum.
 * `rollUp` is the risk roll-up of `packages/basket` over the same holdings.
 */
export const ChainExposure = z.object({
  chain: ChainId,
  name: z.string(),
  provenance: Provenance,
  vaults: z.number().int().nonnegative(),
  valueUsd: DecimalString,
  observedAt: z.string().datetime().nullable(),
  byUnderlying: z.array(ExposureShare),
  byIssuer: z.array(ExposureShare),
  rollUp: RiskRollUp.nullable(),
  exit: z.array(ExposureExit),
  unvalued: z.array(z.object({ asset: AssetId, vault: Address, display: DecimalString })),
  source: z.string().min(1),
  method: z.string().min(1),
});
export type ChainExposure = z.infer<typeof ChainExposure>;

/**
 * `total` adds the chains up, by underlying and by issuer. Its label is the least live of the labels
 * of the chains that add to it: a sum with a mock chain in it is `mock`; its `source` and `method` are
 * those of the chains it adds, and `observedAt` the oldest of their snapshots. Null when no chain holds
 * anything.
 */
export const PortfolioExposureResponse = z.object({
  total: z
    .object({
      valueUsd: DecimalString,
      provenance: Provenance,
      byUnderlying: z.array(ExposureShare),
      byIssuer: z.array(ExposureShare),
      source: z.string().min(1),
      method: z.string().min(1),
      observedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  chains: z.array(ChainExposure),
  unavailable: z.array(ChainUnavailable),
  disclaimer: z.string(),
});
export type PortfolioExposureResponse = z.infer<typeof PortfolioExposureResponse>;
