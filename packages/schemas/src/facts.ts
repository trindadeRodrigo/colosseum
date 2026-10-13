import { z } from 'zod';
import { Provenance } from './enums';

/**
 * Fact sheets: what the agent and the product read from the liquidity and risk layer (PLAN-ANALYTICS Step A).
 * A fact is one number with where it came from, or `null` with the reason it is not measured. A missing fact is
 * never zero: a zero reads as "no liquidity" and would shrink a real plan. packages/risk builds the sheets; the
 * API serves them unchanged.
 */
export const FACTS_METHOD_VERSION = 'facts-0.1';

export const FactRegime = z.enum([
  'us_market_hours',
  'us_offhours_weekday',
  'weekend',
  'us_holiday',
]);
export type FactRegime = z.infer<typeof FactRegime>;

/** fraction: 0.01 = 1%. ratio: dimensionless (coverage, weekend ÷ market hours). */
export const FactUnit = z.enum(['fraction', 'usd', 'ratio', 'count', 'hours', 'seconds']);
export type FactUnit = z.infer<typeof FactUnit>;

/** measured: read or computed from chain data. lower_bound: the true value is at least this. assumption: a
 *  stated input no source confirms yet (issuer redemption terms). */
export const FactQuality = z.enum(['measured', 'lower_bound', 'assumption']);
export type FactQuality = z.infer<typeof FactQuality>;

export const FactNullReason = z.enum([
  /** The regime has no snapshot yet (the weekend, before the first collected one). */
  'no_samples_in_regime',
  /** Fewer samples than the method's minimum at this size or in this bucket. */
  'insufficient_samples',
  /** A value was stored or computed, and it is not a finite number (a division by a stored zero). */
  'not_a_number',
  /** The size is above the largest measured notional. */
  'beyond_measured_size',
  /** No reference price for the asset at that time (Step 11). */
  'no_reference_price',
  /** Needs an external price source that is not plugged in (D19). */
  'no_external_source',
  /** The asset's chain has no collector feeding this fact. */
  'chain_not_covered',
  /** The data exists on-chain and is not collected yet. */
  'not_collected',
  /** Collected, not yet imported into the tables the API reads. */
  'not_imported',
  /** Liquidations whose seized collateral was not traced after the transaction. */
  'not_followed',
  /** Waits for a decision in docs/GATES.md. */
  'gate_open',
  /** The fact does not apply to this asset or pool. */
  'not_applicable',
  /** The asset has no oracle the vault could check a rebalance against (gate UNIVERSE). */
  'no_oracle',
]);
export type FactNullReason = z.infer<typeof FactNullReason>;

const factContext = {
  unit: FactUnit,
  regime: FactRegime.optional(),
  sizeUsd: z.number().positive().optional(),
};

export const MeasuredFact = z.object({
  value: z.number(),
  quality: FactQuality,
  ...factContext,
  source: z.string().min(1),
  method: z.string().min(1),
  methodVersion: z.string().min(1),
  /** When the data behind the value was read; for a fitted value, the end of its data window. */
  fetchedAt: z.string().datetime(),
  dataFrom: z.string().datetime().optional(),
  samples: z.number().int().nonnegative().optional(),
  provenance: Provenance,
});
export type MeasuredFact = z.infer<typeof MeasuredFact>;

export const MissingFact = z.object({
  value: z.null(),
  reason: FactNullReason,
  ...factContext,
  /** What would fill it, in a few words, for the reader. */
  detail: z.string().optional(),
});
export type MissingFact = z.infer<typeof MissingFact>;

export const Fact = z.union([MeasuredFact, MissingFact]);
export type Fact = z.infer<typeof Fact>;

export const fact = (f: MeasuredFact): MeasuredFact => f;
export const missing = (
  reason: FactNullReason,
  unit: FactUnit,
  ctx: { regime?: FactRegime; sizeUsd?: number; detail?: string } = {},
): MissingFact => ({ value: null, reason, unit, ...ctx });

/**
 * Every fact inside a sheet, with its path. A number stored under `value` without the measured fields, or a
 * `null` without a reason, is returned in `invalid`: the contract test fails on any.
 */
export function collectFacts(sheet: unknown): {
  facts: Array<{ path: string; fact: Fact }>;
  invalid: Array<{ path: string; issue: string }>;
} {
  const facts: Array<{ path: string; fact: Fact }> = [];
  const invalid: Array<{ path: string; issue: string }> = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if ('value' in node && 'unit' in node) {
      const parsed = Fact.safeParse(node);
      if (parsed.success) facts.push({ path, fact: parsed.data });
      else invalid.push({ path, issue: parsed.error.issues[0]?.message ?? 'invalid fact' });
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(sheet, '');
  return { facts, invalid };
}

/**
 * A fact sheet with no figure that is not a finite number. A measured fact whose value is Infinity or
 * NaN (a division by a stored zero somewhere under it) is answered as a missing fact that says so,
 * with its unit, its regime and its size kept: the schema of an answer refuses such a number, and
 * one of them would refuse the whole sheet with it. Every route that answers a fact sheet passes it
 * through here, so no caller has to remember.
 */
export function finiteFacts<T>(sheet: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const o = node as Record<string, unknown>;
    if ('value' in o && 'unit' in o && typeof o.value === 'number' && !Number.isFinite(o.value))
      return {
        value: null,
        reason: 'not_a_number',
        unit: o.unit,
        ...(o.regime === undefined ? {} : { regime: o.regime }),
        ...(o.sizeUsd === undefined ? {} : { sizeUsd: o.sizeUsd }),
        detail: 'the measured value was not a finite number',
      };
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  return walk(sheet) as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Costs

/**
 * The cost of one trade, split (PLAN-ANALYTICS §5). `total = poolFee + transferFee + impact + basis`, as
 * fractions of the notional; `basis` can be negative. `lossUsd = sizeUsd × total + networkFeeUsd +
 * sizeUsd × platformFee`.
 */
export const CostBreakdown = z.object({
  total: Fact,
  poolFee: Fact,
  transferFee: Fact,
  impact: Fact,
  basis: Fact,
  networkFeeUsd: Fact,
  platformFee: Fact,
  lossUsd: Fact,
});
export type CostBreakdown = z.infer<typeof CostBreakdown>;

export const RegimeCosts = z.object({
  regime: FactRegime,
  exit: CostBreakdown,
  entry: CostBreakdown,
  /** Entry and exit in this regime at the sheet's size, as a fraction. */
  roundTrip: Fact,
  /** Gross return that leaves the holder at zero after entry and exit. */
  breakEvenReturn: Fact,
  /** Largest sale at a cost of at most `tau`. */
  exitCapacityUsd: Fact,
});
export type RegimeCosts = z.infer<typeof RegimeCosts>;

export const DataCoverage = z.object({
  regimesMeasured: z.array(FactRegime),
  regimesMissing: z.array(FactRegime),
  samples: z.number().int().nonnegative(),
  dataFrom: z.string().datetime().nullable(),
  dataTo: z.string().datetime().nullable(),
});
export type DataCoverage = z.infer<typeof DataCoverage>;

// ---------------------------------------------------------------------------------------------------------------
// Sheets

export const GapFact = z.object({ gapPct: z.number().positive(), value: Fact });
export type GapFact = z.infer<typeof GapFact>;

/** Swap flow in one bucket (item 16): USD from priced swaps only; `netSellPressure` = (sell − buy) ÷ volume;
 *  `turnoverPerHour` = volume per hourly row ÷ the median ±2% sell depth. */
export const FlowFacts = z.object({
  volumeUsd: Fact,
  sellUsd: Fact,
  buyUsd: Fact,
  swaps: Fact,
  netSellPressure: Fact,
  turnoverPerHour: Fact,
  /** Swaps in an hour with no quote price: in `swaps`, not in any USD figure. */
  unpricedSwaps: Fact,
});
export type FlowFacts = z.infer<typeof FlowFacts>;

/** The oracle of one bucket of time (PLAN-UNIVERSE RU.9). The oracle and the pool mid are read apart and set side
 *  by side, never blended into one price (gate ORACLE-VS-DEX). */
export const OracleBucketFacts = z.object({
  /** Age of the oracle's price when it was read: the read's time less the oracle's own timestamp. */
  ageMedian: Fact,
  ageP95: Fact,
  /** (pool mid − oracle) ÷ oracle, signed, at the median of the paired readings. */
  gapMedian: Fact,
  /** The same gap without its sign, at the 95th percentile and at its largest. */
  gapAbsP95: Fact,
  gapAbsMax: Fact,
  /** Share of hours in which the vault's price check, at the limits of `limits`, would have refused a trade. An hour
   *  read more than once counts by the share of its readings refused. */
  refusedShare: Fact,
  /** The same share for the age limit alone, and for the distance from the oracle's own one-hour average alone. */
  refusedByAgeShare: Fact,
  refusedByDistanceShare: Fact,
});
export type OracleBucketFacts = z.infer<typeof OracleBucketFacts>;

/** What a rebalance the vault runs by itself needs to know of an asset's oracle (PLAN-UNIVERSE RU.9). These are
 *  measurements; the vault's limits are the vault's to set. */
export const OracleFacts = z.object({
  /** Which oracle and where, as the chain's asset list names it; null when the stock has none. */
  feed: z
    .object({
      kind: z.enum(['chainlink', 'scope']),
      /** Chainlink: the feed's proxy address. Scope: the entry index in the price account. */
      ref: z.string().min(1),
      account: z.string().nullable(),
      /** Scope: the entry of the one-hour average the vault compares the price with. */
      averageRef: z.string().nullable(),
      description: z.string().nullable(),
      /** What the oracle prices, where its source says so; null with `pricesReason` where it does not. */
      prices: z.string().nullable(),
      pricesReason: z.string().nullable(),
      source: z.string().min(1),
      fetchedAt: z.string().datetime(),
      method: z.string().min(1),
      provenance: Provenance,
    })
    .nullable(),
  /** Why there is no oracle, as the asset list says it (`no_feed`, `no_scope_entry`); null with one. */
  feedReason: z.string().nullable(),
  /** True only with an oracle (gate UNIVERSE). False carries `no_oracle`. */
  autoRebalance: z.boolean(),
  autoRebalanceReason: z.string().nullable(),
  /** A question about this oracle the asset list leaves to the vault stream; carried through, not answered. */
  autoRebalanceOpen: z.string().nullable(),
  /** The limits the refusal shares are counted against, each with where it was read. */
  limits: z.object({
    maxAgeSeconds: Fact,
    /** Largest distance between the price and its one-hour average. */
    maxDistance: Fact,
  }),
  /** The readings behind the figures: from the first to the last oracle reading used. */
  window: z.object({ from: z.string().datetime(), to: z.string().datetime() }).nullable(),
  byRegime: z.array(OracleBucketFacts.extend({ regime: FactRegime })),
  /** The hours the vault's keeper may trade in at all (its session, closed days out): outside them a trade is
   *  refused whatever the oracle says. */
  vaultSession: OracleBucketFacts.extend({ session: z.string().min(1) }),
});
export type OracleFacts = z.infer<typeof OracleFacts>;

export const AssetFacts = z.object({
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  chain: z.string().min(1),
  mint: z.string().nullable(),
  /** The trade size every cost in the sheet refers to. */
  sizeUsd: z.number().positive(),
  /** Cost tolerance behind every capacity figure. */
  tau: z.number().positive(),
  costs: z.array(RegimeCosts),
  /** The regime with the highest exit cost at this size, among those measured. */
  worstRegime: FactRegime.nullable(),
  /** Weekend ÷ market-hours exit capacity at `tau`. */
  weekendRatio: Fact,
  liquidityStability: z.object({
    lpTop1Share: Fact,
    lpTop3Share: Fact,
    lpTop10Share: Fact,
    /** Exit cost at this size if the largest `lpExitN` positions leave the main pool. */
    lpExitCost: Fact,
    lpWithdrawalEvents7d: Fact,
    /** Variation of exit capacity across snapshots in the worst regime (standard deviation ÷ mean). */
    capacityVariation: Fact,
    /** The same variation in each regime (item 15). */
    capacityVariationByRegime: z.array(z.object({ regime: FactRegime, value: Fact })).optional(),
    /** After a trade of at least `largeShare` of the pool's ±2% depth: hours until the depth is back to half and
     *  to 90% of what it was, and the share of trades not back to 90% within 24 hours (item 15, Step 5b history). */
    depthRecovery: z
      .array(
        z.object({
          regime: FactRegime,
          largeTrades: Fact,
          hoursTo50: Fact,
          hoursTo90: Fact,
          notRecovered24h: Fact,
        }),
      )
      .optional(),
    /** LP owners behind the position NFTs: the largest owner's share across the asset's pools (item 15). */
    lpOwnerTop1Share: Fact.optional(),
  }),
  /** Pool mid against another price source: (mid − other) ÷ other, by regime. */
  tracking: z.array(z.object({ against: z.string().min(1), regime: FactRegime, gap: Fact })),
  lendingUse: z.object({
    collateralUsd: Fact,
    /** Liquidation capacity ÷ collateral liquidatable at each price gap. */
    coverageByGap: z.array(GapFact),
  }),
  issuerRoute: z.object({
    capacityUsdPerOpenHour: Fact,
    fee: Fact,
    settlementHours: Fact,
  }),
  marketRisk: z.object({
    volatilityAnnual: Fact,
    maxDrawdown: Fact,
    /** Share of weekends whose close-to-open move exceeded each gap. */
    weekendGapFrequency: z.array(GapFact),
  }),
  /** Volume, net sell pressure and turnover from the decoded swap history (item 16); absent on older sheets. */
  flow: z
    .object({
      /** The 28-day window of `byRegime` and `byPool`: the history's last 672 hours, to its newest event. */
      window: z.object({ from: z.string().datetime(), to: z.string().datetime() }).nullable(),
      byRegime: z.array(FlowFacts.extend({ regime: FactRegime })),
      /** Every regime, over the last 24 hours, 7 days and 28 days of the history. */
      byWindow: z.array(
        FlowFacts.extend({
          window: z.enum(['24h', '7d', '28d']),
          from: z.string().datetime().nullable(),
          to: z.string().datetime().nullable(),
        }),
      ),
      byPool: z.array(
        z.object({
          pool: z.string().min(1),
          venue: z.string().min(1),
          quote: z.string().min(1),
          volume28dUsd: Fact,
          swaps: Fact,
          unpricedSwaps: Fact,
          /** The pool's share of the asset's priced 28-day volume over its value pools. */
          share: Fact,
        }),
      ),
      /** Where the token sits (item 16, part 2). */
      holders: z.object({
        top10Share: Fact,
        inWalletsShare: Fact,
        inLendingShare: Fact,
        inPoolsShare: Fact,
      }),
    })
    .optional(),
  /** The oracle a rebalance is checked against (PLAN-UNIVERSE RU.9); absent for an asset on no asset list. */
  oracle: OracleFacts.optional(),
  coverage: DataCoverage,
  methodVersion: z.string().min(1),
  provenance: Provenance,
});
export type AssetFacts = z.infer<typeof AssetFacts>;

export const LiquidationRoute = z.object({
  /** routed_dex | two_hop | wait_for_market_open | issuer_redemption */
  route: z.string().min(1),
  regime: FactRegime,
  seizedUsd: z.number().positive(),
  /** Value recovered ÷ value seized at the DEX mid. */
  recovered: Fact,
  /** (1 + bonus) × (DEX mid ÷ venue oracle) × recovered − 1. */
  liquidatorMargin: Fact,
});
export type LiquidationRoute = z.infer<typeof LiquidationRoute>;

export const LendingPoolFacts = z.object({
  account: z.string().min(1),
  chain: z.string().min(1),
  venue: z.string().min(1),
  market: z.string().min(1),
  symbol: z.string().min(1),
  withdrawal: z.object({
    suppliedUsd: Fact,
    availableUsd: Fact,
    shareLentOut: Fact,
    /** Share of hours with more than `utilAlarmPct` lent out. */
    hoursAboveAlarmShare: Fact,
  }),
  rates: z.object({ supplyApy: Fact, supplyApyVariation: Fact, borrowApy: Fact }),
  lenders: z.object({ top1Share: Fact, top3Share: Fact, top10Share: Fact }),
  collateral: z.array(
    z.object({
      asset: z.string().min(1),
      collateralUsd: Fact,
      liquidationThreshold: Fact,
      liquidationBonus: Fact,
      /** Venue oracle against the pool mid, by regime. */
      oracleGap: z.array(z.object({ regime: FactRegime, gap: Fact })),
      coverageByGap: z.array(GapFact),
      /** Regimes the coverage ratio could not price (no curve or no oracle rows): the ratio is the worst of the
       *  others, so it can be lower there. */
      regimesMissing: z.array(FactRegime).optional(),
      /** The route with the highest recovered value first; every alternative is listed. */
      routes: z.array(LiquidationRoute),
      observed: z.object({
        liquidations: Fact,
        soldInSameTxShare: Fact,
        /** Realised sale price against the pool mid, median. */
        realisedVsMid: Fact,
      }),
    }),
  ),
  history: z.object({
    liquidations: Fact,
    liquidatedUsd: Fact,
    socialisedLossUsd: Fact,
    parameterChanges30d: Fact,
  }),
  coverage: z.object({
    dataFrom: z.string().datetime().nullable(),
    dataTo: z.string().datetime().nullable(),
    verification: z.enum(['onchain', 'api']),
  }),
  methodVersion: z.string().min(1),
  provenance: Provenance,
});
export type LendingPoolFacts = z.infer<typeof LendingPoolFacts>;

export const ConcentrationRow = z.object({
  key: z.string().min(1),
  share: z.number().min(0).max(1),
});
export type ConcentrationRow = z.infer<typeof ConcentrationRow>;

export const PlanFacts = z.object({
  positions: z.array(z.object({ assetId: z.string().min(1), valueUsd: z.number().nonnegative() })),
  totalUsd: z.number().nonnegative(),
  /** Share of the plan's value whose exit cost is measured. */
  measuredShare: z.number().min(0).max(1),
  concentration: z.object({
    byIssuer: z.array(ConcentrationRow),
    byChain: z.array(ConcentrationRow),
    byClass: z.array(ConcentrationRow),
    byVenue: z.array(ConcentrationRow),
    /** The token each leg's largest exit pool pays out. */
    byQuoteToken: z.array(ConcentrationRow).optional(),
  }),
  exit: z.object({
    regime: FactRegime.nullable(),
    legs: z.array(
      z.object({
        assetId: z.string().min(1),
        valueUsd: z.number().nonnegative(),
        exit: Fact,
        /** Another leg's route uses the same pool or the same SOL leg. */
        sharedRoute: z.boolean(),
      }),
    ),
    /** Every leg sold in the same snapshot. */
    planExit: Fact,
    lossUsd: Fact,
  }),
  netReturn: z.object({ roundTrip: Fact, breakEvenReturn: Fact }),
  /** The liquidity breach assessment (risk-0.2) for the plan's withdrawals; absent when none were given. */
  breach: z
    .object({
      breach: z.boolean(),
      likelyBreach: z.boolean(),
      shortfallUsd: Fact,
      monthsAtRisk: z.array(z.string()),
      /** Legs and regimes inside a withdrawal's window that the curves do not measure. */
      regimesMissing: z.array(z.object({ assetId: z.string(), regime: FactRegime })),
    })
    .optional(),
  /** Market risk of the plan held at its weights (item 12); absent when the caller read no prices. */
  marketRisk: z
    .object({
      volatilityAnnual: Fact,
      maxDrawdown: Fact,
      /** Correlation of daily returns between each pair of legs that are not held at par. */
      correlations: z.array(z.object({ a: z.string(), b: z.string(), value: Fact })),
      legsWithoutPrices: z.array(z.string()),
      /** Legs whose only price is par: they enter the plan's figures as a stated peg. */
      legsAtPar: z.array(z.string()),
    })
    .optional(),
  stress: z.array(
    z.object({
      /** weekend_gap | lp_exit | lending_pool_fully_lent */
      scenario: z.string().min(1),
      inputs: z.record(z.string(), z.number()),
      lossUsd: Fact,
      liquidUsd: Fact,
    }),
  ),
  methodVersion: z.string().min(1),
  provenance: Provenance,
});
export type PlanFacts = z.infer<typeof PlanFacts>;
