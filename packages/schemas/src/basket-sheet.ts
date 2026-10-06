import { z } from 'zod';
import { BasketAsset } from './basket-asset';
import { AssetId, Bps, ChainId, Sourced } from './chain';
import { Language } from './enums';
import { Component, FamilyMeta, Recipe } from './recipe';

// DESIGN-VAULT 3.6, personalization. A plan is a `BasketProposal`: lines with reasons, a card and one
// recipe per chain. `compose()` in packages/engine/src/personal builds it; the numbers in
// `PersonalParams` are Rodrigo's.

/** ISO 4217, three capitals: the currency a goal is counted in (most goals are in dollars). */
export const GoalCurrency = z.string().regex(/^[A-Z]{3}$/);
export type GoalCurrency = z.infer<typeof GoalCurrency>;

/** A dated withdrawal the plan must pay: a month, an amount and its currency. */
export const Obligation = z.object({
  /** YYYY-MM. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amount: z.number().positive(),
  currency: GoalCurrency,
});
export type Obligation = z.infer<typeof Obligation>;

/** A theme: a shared portfolio's slug, which is at most 64 characters (the slug rule of the routes). */
export const ThemeSlug = z.string().min(1).max(64);

/**
 * A share of the plan with its own strategy (gate SLEEVES, Oct 5): a goal with dates, a theme from a
 * curated list, or the safest liquid yield. `shareBps` is of the whole plan.
 */
export const PlanSleeve = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goal'), shareBps: Bps.min(1) }),
  z.object({ kind: z.literal('theme'), shareBps: Bps.min(1), theme: ThemeSlug }),
  z.object({ kind: z.literal('safe_yield'), shareBps: Bps.min(1) }),
]);
export type PlanSleeve = z.infer<typeof PlanSleeve>;

/** Sleeves add up to the whole plan, and the goal and safe-yield sleeves appear at most once each. */
export const PlanSleeves = z
  .array(PlanSleeve)
  .min(1)
  .refine((xs) => xs.reduce((n, x) => n + x.shareBps, 0) === 10_000, {
    message: 'sleeve shares must add up to exactly 10,000',
  })
  .refine(
    (xs) =>
      xs.filter((x) => x.kind === 'goal').length <= 1 &&
      xs.filter((x) => x.kind === 'safe_yield').length <= 1,
    { message: 'at most one goal sleeve and one safe-yield sleeve' },
  )
  .refine(
    (xs) => {
      const themes = xs.flatMap((x) => (x.kind === 'theme' ? [x.theme] : []));
      return new Set(themes).size === themes.length;
    },
    { message: 'a theme appears once' },
  );
export type PlanSleeves = z.infer<typeof PlanSleeves>;

export const BasketSheet = z.object({
  basketType: z.literal('standard'),
  goal: z.enum(['grow', 'income', 'protect']),
  amountUsd: z.number().min(10).max(1_000_000),
  horizonMonths: z.number().int().min(1).max(480),
  risk: z.enum(['low', 'medium', 'high']),
  /** Family slugs. */
  themes: z.array(ThemeSlug).max(3),
  /**
   * ISO two-letter, self-declared. Optional and unused in planning (gate COUNTRY-REMOVED, Rodrigo,
   * Oct 6): no plan is shaped by it. Kept so stored sheets that carry one still parse.
   */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  chains: z.array(ChainId).min(1),
  incomeTargetUsdMonthly: z.number().positive().optional(),
  rules: z.object({ useHoldings: z.boolean(), glide: z.boolean() }),
  language: Language,
  /** The goal's currency. Left out: dollars. */
  currency: GoalCurrency.optional(),
  /** Dated withdrawals, in the goal's currency or another. Left out: none. */
  obligations: z.array(Obligation).max(480).optional(),
  /** The person's split of the plan. Left out: one goal sleeve at 10,000 (`sleevesOf`). */
  sleeves: PlanSleeves.optional(),
  /**
   * Whether a sleeve that has grown is brought back to its share: the person's choice, never the
   * engine's (gate SLEEVES). Left out: false.
   */
  restoreSplit: z.boolean().optional(),
});
export type BasketSheet = z.infer<typeof BasketSheet>;

/** The sleeves of a sheet: its own, or one goal sleeve at the whole plan. */
export const sleevesOf = (sheet: Pick<BasketSheet, 'sleeves'>): PlanSleeve[] =>
  sheet.sleeves ?? [{ kind: 'goal', shareBps: 10_000 }];

/** The currency of a sheet's goal: its own, or dollars. */
export const currencyOf = (sheet: Pick<BasketSheet, 'currency'>): GoalCurrency =>
  sheet.currency ?? 'USD';

/**
 * What the sentence parser fills (DESIGN-VAULT section 7): every field of the sheet, each null when the
 * text did not say. The form is always the confirm step that turns a draft into a BasketSheet.
 */
export const BasketSheetDraft = z.object({
  basketType: BasketSheet.shape.basketType.nullable(),
  goal: BasketSheet.shape.goal.nullable(),
  amountUsd: BasketSheet.shape.amountUsd.nullable(),
  horizonMonths: BasketSheet.shape.horizonMonths.nullable(),
  risk: BasketSheet.shape.risk.nullable(),
  themes: BasketSheet.shape.themes.nullable(),
  country: BasketSheet.shape.country.nullable(),
  chains: BasketSheet.shape.chains.nullable(),
  incomeTargetUsdMonthly: z.number().positive().nullable(),
  rules: BasketSheet.shape.rules.nullable(),
  language: BasketSheet.shape.language.nullable(),
  // Added on Oct 5 (ENG-3 slice 2): a draft written before them reads as "the text did not say".
  currency: GoalCurrency.nullable().default(null),
  obligations: z.array(Obligation).nullable().default(null),
  sleeves: PlanSleeves.nullable().default(null),
  restoreSplit: z.boolean().nullable().default(null),
});
export type BasketSheetDraft = z.infer<typeof BasketSheetDraft>;

/** Everything a plan can be built from: the listed assets and the shared portfolios. */
export const Shelf = z.object({
  version: z.string().min(1),
  assets: z.array(BasketAsset),
  families: z.array(z.object({ meta: FamilyMeta, recipes: z.array(Recipe) })),
});
export type Shelf = z.infer<typeof Shelf>;

export const PersonalParams = z.object({
  version: z.string().min(1),
  /** Key `${goal}:${risk}`. */
  sleeves: z.record(z.string(), z.object({ growthBps: Bps, dollarYieldBps: Bps, goldBps: Bps })),
  glideFloor: z.array(
    z.object({ monthsLeft: z.number().int().nonnegative(), dollarYieldBps: Bps }),
  ),
  /** Key: risk. */
  capPerStockBps: z.record(z.string(), Bps),
  /** Key: risk. */
  capPerIssuerBps: z.record(z.string(), Bps),
  tierCeilingUsd: z.record(z.enum(['A', 'B', 'C']), z.number().nonnegative()),
  shareOfDepth: z.number().positive().max(1),
  tau: z.number().positive().max(1),
  minLineBps: Bps,
  maxLinesPerChain: z.number().int().min(1),
});
export type PersonalParams = z.infer<typeof PersonalParams>;

/** Why a line is what it is. `text` comes from a template, never from a model. */
export const Reason = z.object({
  rule: z.string().min(1),
  inputs: z.array(z.string()),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  text: z.string(),
});
export type Reason = z.infer<typeof Reason>;

export const BasketLine = z.object({
  chain: ChainId,
  assetId: AssetId,
  /** The family slug this line came through, if any. */
  viaIndex: z.string().optional(),
  weightBps: Bps,
  amountUsd: z.number().nonnegative(),
  reasons: z.array(Reason),
});
export type BasketLine = z.infer<typeof BasketLine>;

export const BasketCard = z.object({
  moneyTodayUsd: z.number().nonnegative(),
  termMonths: z.number().int().positive(),
  cashFlow: z.enum(['none', 'monthly', 'at_end']),
  expectedReturn: z.object({
    lowPct: z.number(),
    highPct: z.number(),
    basis: z.string(),
    lossInFallUsd: z.number().nonnegative(),
  }),
  /** `costBps` is null when the exit cost is not measured; never shown as zero. */
  exit: z.object({ text: z.string(), costBps: z.number().nullable() }),
});
export type BasketCard = z.infer<typeof BasketCard>;

/** Income goals only: whether the target is met, the gap, and each way to close it. */
export const Verdict = z.object({
  met: z.boolean(),
  gapUsdMonthly: z.number(),
  ways: z.array(z.object({ change: z.string(), closesGap: z.boolean() })),
});
export type Verdict = z.infer<typeof Verdict>;

export const ObservationRef = Sourced.extend({
  id: z.string().min(1),
  kind: z.enum(['yield', 'price', 'liquidity', 'fx']),
});
export type ObservationRef = z.infer<typeof ObservationRef>;

export const BasketProposalBase = z.object({
  sheet: BasketSheet,
  engineVersion: z.string().min(1),
  paramsHash: z.string().min(1),
  shelfVersion: z.string().min(1),
  inputsHash: z.string().min(1),
  lines: z.array(BasketLine),
  recipes: z.array(
    z.object({
      chain: ChainId,
      amountUsd: z.number().nonnegative(),
      components: z.array(Component),
    }),
  ),
  removed: z.array(z.object({ ref: z.string(), reasons: z.array(Reason) })),
  card: BasketCard,
  verdict: Verdict.optional(),
  flags: z.array(z.string()),
  observations: z.array(ObservationRef),
  disclaimer: z.string(),
});

export const BasketProposal = BasketProposalBase.refine(
  (p) => p.lines.reduce((n, l) => n + l.weightBps, 0) === 10_000,
  { message: 'line weights must add up to exactly 10,000', path: ['lines'] },
);
export type BasketProposal = z.infer<typeof BasketProposal>;
