import {
  AssetId,
  type BasketProposal,
  BasketSheet,
  Bps,
  type FxObservation,
  type LiquidityProvider,
  type ObservationRef,
  PersonalParams,
  PlanCandidateId,
  type PlanScorecard,
  type PlanStatus,
  type Verdict,
  type YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import { ISO_3166_1_ALPHA2 } from './countries';
import { LegType } from './leg-types';
import type { ThemeList } from './theme-list';

// The types of the personalization engine that packages/schemas does not hold yet. Each is marked
// LOCAL TYPE and listed in DESIGN-VAULT 3.6: it moves to packages/schemas when the frame takes it.

/** The asset classes a person can rule out. Cash is not one: a vault is funded in it. */
export const HoldableClass = z.enum([
  'stock',
  'etf',
  'gold',
  'commodity',
  'dollar_yield',
  'crypto',
]);
export type HoldableClass = z.infer<typeof HoldableClass>;

/**
 * LOCAL TYPE. The limits a person sets that `BasketSheet` has no field for: what they must not
 * lose, what they cannot hold, and how soon they may need the money.
 */
export const PersonalLimits = z.object({
  /** Dollars of the amount that stay out of stocks, crypto and gold: held in dollar yield and cash. */
  mustKeepUsd: z.number().nonnegative().optional(),
  /** Months until they may need the money, when that is sooner than the goal's date. */
  mayNeedInMonths: BasketSheet.shape.horizonMonths.optional(),
  /**
   * How much credit risk they accept: the most of the plan in credit and basis legs (gate SOLVER-PARAMS,
   * the old solver's budget). Left out: the table's default, until the guided intake asks.
   */
  creditTolerance: z.enum(['none', 'limited', 'accept']).optional(),
  /** What they cannot hold: whole classes, tickers of the underlying ('TSLA'), or single tokens. */
  cannotHold: z
    .object({
      classes: z.array(HoldableClass).optional(),
      underlyings: z.array(z.string().min(1)).optional(),
      assets: z.array(AssetId).optional(),
    })
    .optional(),
});
export type PersonalLimits = z.infer<typeof PersonalLimits>;

/**
 * Whether `code` names a country a person can live in: an ISO 3166-1 alpha-2 code assigned now
 * (`countries.ts`, data with its source and date). An alias, a retired or a reserved code ("UK", "SU",
 * "YU", "EU", "ZZ") is no country: it would let assets blocked for the real one through the country
 * check, so the intake asks again and the engine and the route refuse it.
 */
export const isCountryCode = (code: string): boolean => ISO_3166_1_ALPHA2.has(code);

/**
 * LOCAL TYPE. `BasketSheet` with the person's limits. This is what `compose` validates and runs on.
 *
 * A plan lives on one chain: the chain of the wallet the person signed in with (decided on
 * 2026-10-03). `chains` keeps the list shape of the shared type and must name exactly one.
 */
// `horizonOpen` (shared, Oct 6): `horizonMonths` then holds `openEndedHorizonMonths` of the parameter
// table, a starting value and not the person's; no date is shown or made from it, and the glide is off.
export const PersonalSheet = BasketSheet.extend({ limits: PersonalLimits.optional() })
  .refine((s) => !(s.horizonOpen && s.rules.glide), {
    message: 'a goal with no date has no glide: it has no date to near',
    path: ['rules', 'glide'],
  })
  .refine((s) => (s.limits?.mustKeepUsd ?? 0) <= s.amountUsd, {
    message: 'what must not be lost cannot be more than the amount',
    path: ['limits', 'mustKeepUsd'],
  })
  // A theme sleeve holds stocks (gate SLEEVES): what must not be lost is kept by the other sleeves,
  // so it cannot be more than they hold. Compared in cents and basis points, as the engine counts.
  .refine(
    (s) =>
      Math.round((s.limits?.mustKeepUsd ?? 0) * 100) * 10_000 <=
      Math.round(s.amountUsd * 100) *
        (10_000 - (s.sleeves ?? []).reduce((n, x) => n + (x.kind === 'theme' ? x.shareBps : 0), 0)),
    {
      message: 'what must not be lost cannot be more than the sleeves outside the themes hold',
      path: ['limits', 'mustKeepUsd'],
    },
  )
  .refine((s) => s.chains.length === 1, {
    message: 'a plan lives on one chain: name exactly one',
    path: ['chains'],
  });
export type PersonalSheet = z.infer<typeof PersonalSheet>;

/**
 * LOCAL TYPE. `Holding` in packages/schemas is raw units with no price, and the rule on holdings
 * works in dollars. One of `asset` (a token on the shelf) or `underlying` (a ticker) says what it is.
 */
export const HeldPosition = z
  .object({
    asset: AssetId.optional(),
    underlying: z.string().min(1).optional(),
    valueUsd: z.number().nonnegative(),
  })
  .refine((h) => h.asset !== undefined || h.underlying !== undefined, {
    message: 'a holding names a token on the shelf or the ticker of its underlying',
  });
export type HeldPosition = z.infer<typeof HeldPosition>;

const Months = z.number().int().nonnegative();
export const GoalKind = BasketSheet.shape.goal;
export type GoalKind = z.infer<typeof GoalKind>;
export const RiskLevel = BasketSheet.shape.risk;
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * LOCAL TYPE. `PersonalParams` of packages/schemas, plus the numbers it has no field for. Every
 * number the engine uses is in here; the table itself is `params.ts`.
 */
export const PersonalParameters = PersonalParams.extend({
  /**
   * The time frame a goal with no date is built with (gate GLIDE-OPT-IN, Oct 6). Never said back as
   * the person's: the read-back says "no date set". With no glide, it moves only what reads the date.
   */
  openEndedHorizonMonths: BasketSheet.shape.horizonMonths,
  /** Cash kept when the money may be needed within `monthsLeft` months. */
  cashFloor: z.array(z.object({ monthsLeft: Months, cashBps: Bps })),
  /** A line smaller than this many dollars is not held. */
  minLineUsd: z.number().nonnegative(),
  /** A holding counts as "already held" from this share of the amount. */
  holdingMinBps: Bps,
  /** The fall the card shows a loss for, on stocks, crypto and gold. */
  fallBps: Bps,
  /** From this share in dollar yield, a plan that is not for income shows its cash flow as "at the end". */
  atEndMinBps: Bps,
  /** A way to close an income gap names an amount rounded up to this many dollars. */
  wayStepUsd: z.number().positive(),
  /** The shared portfolio a goal starts from when the person chooses none: a slug, or none. */
  defaultTheme: z.record(GoalKind, z.string().nullable()),
  /**
   * What fills a sleeve when no shared portfolio does: the ticker of an underlying. Gold is a list in
   * order: the first the person can hold on the chain.
   */
  defaultUnderlying: z.object({
    growth: z.string().min(1),
    gold: z.array(z.string().min(1)).min(1),
  }),
  /** Yields after haircut within this of a band's top count as equal (a fraction: 0.005 is half a point). */
  yieldBand: z.number().nonnegative().max(1),
  /**
   * The most of the plan in one dollar-yield token: by its symbol where the table names it, otherwise
   * by its leg types (the smallest of them). Lowered to the token's exit ceiling where that is smaller.
   */
  capPerAssetBps: z.object({
    bySymbol: z.record(z.string(), Bps),
    byLegType: z.record(LegType, Bps),
  }),
  /** The most of the plan with one issuer, for dollar yield, gold and cash. Stocks keep `capPerIssuerBps`. */
  issuerCapBps: Bps,
  /** The most of the plan in credit and basis legs, by the person's credit tolerance. */
  creditShareBps: z.record(z.enum(['none', 'limited', 'accept']), Bps),
  /** The credit tolerance of a person who has not said. */
  defaultCreditTolerance: z.enum(['none', 'limited', 'accept']),
  /** Months of withdrawals set aside (slice 2). */
  setAsideMonths: z.number().int().nonnegative(),
  /** Drift inside a sleeve at which a rebalance is proposed, in basis points (slice 4). */
  driftBandBps: Bps,
  /** Days another asset must stay ahead by more than the band before the safe-yield sleeve switches (slice 4). */
  switchDays: z.number().int().positive(),
  /** The oldest an FX reading may be, in days, to count a withdrawal not in dollars when the set-aside is refilled (slice 4). */
  fxMaxAgeDays: z.number().int().nonnegative(),
  /** The named stresses of the status (slice 3): how far yields fall, how long a credit leg is gated, how far the goal's currency moves and over how many months. */
  stress: z.object({
    /** How far every dollar-yield leg's carry falls. */
    carryFallBps: Bps,
    creditGateMonths: z.number().int().nonnegative(),
    fxMoveBps: Bps,
    fxMoveMonths: z.number().int().positive(),
  }),
  /** A way to scale the withdrawals down is tried in steps of this many basis points of each amount. */
  wayScaleStepBps: Bps.refine((n) => n > 0, 'a step must be more than zero'),
  /**
   * The three candidates (slice 3, gate THREE-PLANS): what each changes in this table, always toward
   * the cautious side of the person's limits, never past them. Carry is the table as it is.
   * `distinctBps`: two candidates closer than this (half the sum of absolute weight differences) are
   * one choice, and the later in the fixed order is not shown.
   */
  candidates: z.object({
    cover: z.object({
      setAsideMonths: z.number().int().nonnegative(),
      /** Of the person's own credit limit, the share Cover may hold, in basis points of it. */
      creditOfLimitBps: Bps,
      tau: z.number().positive().max(1),
      shareOfDepth: z.number().positive().max(1),
    }),
    spread: z.object({ equalFill: z.boolean(), issuerCapBps: Bps }),
    distinctBps: Bps,
  }),
});
export type PersonalParameters = z.infer<typeof PersonalParameters>;

/** The four sleeves of a plan. `growth` is stocks and crypto. */
export const SLEEVES = ['growth', 'dollarYield', 'gold', 'cash'] as const;
export type Sleeve = (typeof SLEEVES)[number];

/** Time and data come in here: `compose` reads no clock, no network and no environment. */
export type ComposeContext = {
  /** ISO time the plan is made at. The goal's date is this plus the sheet's months. */
  now: string;
  /** What the person already holds, in dollars. */
  holdings?: HeldPosition[];
  /** Yield observations, keyed by the shelf's asset id (`solana:syrupusdc`). */
  yields?: YieldObservation[];
  /**
   * FX readings, pair `USD<currency>` (units of the currency for one dollar), each with its source,
   * time and method. Needed only to count a withdrawal that is not in dollars; never guessed.
   */
  fx?: FxObservation[];
  /** Measured exit capacity and cost, keyed by the shelf's asset id. */
  liquidity?: LiquidityProvider;
  /**
   * Where the provider's figures come from. A `LiquidityProvider` carries a method and a provenance
   * and no source, so whoever wires it says. Left out, each liquidity figure is flagged as unsourced.
   */
  liquiditySource?: string;
  /** The parameter table. Left out: `PERSONAL_PARAMS`, the starting table. */
  params?: PersonalParameters;
  /**
   * The curated theme lists (gate THEMES), one per theme per chain, as `content/themes/` holds them.
   * A theme sleeve reads the list of its slug on the person's chain; with none, it holds no name.
   */
  themes?: ThemeList[];
};

/**
 * LOCAL TYPE. A liquidity provider that knows which tokens sell into one pool, and what that pool
 * takes in one window at `tau` for all of them together. `LiquidityProvider` has per-token figures
 * only, and two tokens on one pool cannot each sell their own capacity at once. The coverage check
 * reads this where the provider has it; a provider without it is read token by token.
 */
export type PooledLiquidityProvider = LiquidityProvider & {
  poolOf(
    assetId: string,
    tau: number,
    windowDays: number,
  ): { pool: string; capacityUsd: number } | null;
};

export const reportsPools = (p: LiquidityProvider): p is PooledLiquidityProvider =>
  typeof (p as Partial<PooledLiquidityProvider>).poolOf === 'function';

/**
 * LOCAL TYPE. A figure the plan was shaped by: `ObservationRef` of packages/schemas, where the source
 * and the time may be missing. They are never made up: a provider that gives no time or no source
 * leaves null here, and the plan carries a flag that says so.
 */
export type PersonalObservation = Omit<ObservationRef, 'source' | 'fetchedAt'> & {
  source: string | null;
  fetchedAt: string | null;
};

/**
 * LOCAL TYPE. A `BasketProposal` whose sheet carries the person's limits, plus the four sleeves as
 * the plan holds them (the plan bar of the design system shows sleeves, with the tokens under it),
 * and whose observations may lack a source or a time.
 */
export type PersonalProposal = Omit<BasketProposal, 'sheet' | 'observations' | 'verdict'> & {
  sheet: PersonalSheet;
  sleeves: { sleeve: Sleeve; weightBps: number; amountUsd: number }[];
  // `split` (the person's sleeves, gate SLEEVES) is the shared `BasketProposal.split` since ENG-3
  // slice 4: each sleeve, its share and dollars, and what the safe-yield and theme sleeves hold.
  observations: PersonalObservation[];
  verdict?: PersonalVerdict;
  /** Present when the sheet has withdrawals: the plan month by month, in the goal's currency. */
  schedule?: PersonalSchedule;
  /** Present with the schedule: months paid now and under each stress, and the carry needed (slice 3). */
  status?: PersonalStatus;
  /** Present on a plan made as one of the three candidates (`candidates`): which one, and what to compare it on. */
  candidate?: CandidateId;
  scorecard?: Scorecard;
};

/** The three candidates of gate THREE-PLANS, in their fixed order. None is marked or selected. */
export const CANDIDATES = PlanCandidateId.options;
export type CandidateId = PlanCandidateId;

/** What a candidate is compared on (C11): the shared `PlanScorecard` of packages/schemas. */
export type Scorecard = PlanScorecard;

/** LOCAL TYPE. The candidates shown, in the fixed order, and the ones not shown with why. */
export type PersonalCandidates = {
  shown: { id: CandidateId; plan: PersonalProposal }[];
  notShown: { id: CandidateId; why: string }[];
};

/** The status of a plan with withdrawals (slice 3): the shared `PlanStatus` of packages/schemas. */
export type PersonalStatus = PlanStatus;

/**
 * LOCAL TYPE. The plan month by month in the goal's currency (slice 2): what is withdrawn, what is
 * left, and whether the month's withdrawal was paid. Dollar yield accrues at its yield after
 * haircut; stocks, crypto, gold and cash accrue nothing. A token is sold at its measured exit cost,
 * no more of it in a month than one window's capacity; where nothing is measured, at `tau` and its
 * tier ceiling, flagged. `atPar` is the same draw with every cost at zero, for comparison.
 */
export type PersonalSchedule = {
  currency: string;
  /** Units of the goal's currency per dollar, held for the whole schedule; 1 for dollars. */
  rate: number;
  rows: { month: string; withdrawal: number; balance: number; paid: boolean }[];
  monthsPaid: number;
  monthsWithWithdrawal: number;
  /** What was owed and not paid, in the goal's currency. */
  shortfall: number;
};

/**
 * LOCAL TYPE. The shared `Verdict`, with one sentence beside the ways: that no larger amount closes
 * the gap. It is not a way to close it, so it is not listed among them, where a caller would show it
 * as one. Every entry of `ways` closes the gap.
 */
export type PersonalVerdict = Verdict & { noAmountCloses?: string };

export type PersonalErrorCode =
  | 'InvalidSheet'
  | 'InvalidContext'
  | 'InvalidParams'
  | 'InvalidShelf';

/** What `compose` throws when it is handed something it cannot run on. It never guesses. */
export class PersonalInputError extends Error {
  readonly code: PersonalErrorCode;
  readonly issues: { path: string; message: string }[];
  constructor(code: PersonalErrorCode, issues: { path: string; message: string }[]) {
    super(
      `${code}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`,
    );
    this.name = 'PersonalInputError';
    this.code = code;
    this.issues = issues;
  }
}
