import {
  BasketSheet,
  type BasketSheetDraft,
  type ChainId,
  GoalCurrency,
  Language,
  type PlanSleeve,
  PlanSleeves,
} from '@colosseum/schemas';
import { z } from 'zod';
import { draftFromRules } from './draft';
import {
  amountInText,
  currenciesIn,
  exitTimesIn,
  glideAskedIn,
  goalCuesIn,
  horizonsIn,
  looseRiskWordsIn,
  MARKET_IDS,
  type Market,
  type MarketShare,
  marketMentionsIn,
  marketShareIn,
  maxYieldAskedIn,
  mentionsIn,
  mixIn,
  mixSaidIn,
  NARRATIVES,
  openEndedIn,
  otherLanguageIn,
  phraseIn,
  type RefusalSaid,
  type Refused,
  refusalsSaidIn,
  riskCuesIn,
  shareSaidIn,
  splitIn,
  stanceOf,
  timeFramesIn,
  withoutMarketShares,
} from './intake-text';
import {
  attributeKey,
  type FilterMatch,
  filterOfSlug,
  MarketFilter,
  matchedSlug,
  type ShelfLabel,
} from './market-filter';
import { INTAKE_LIMITS, PERSONAL_PARAMS } from './params';
import { matchedName, readBack, type TermSaid } from './readback';
import {
  ASSUMPTION_TEMPLATES,
  type AssumptionId,
  FILTER_BY_WORDS,
  QUESTION_TEMPLATES,
  type QuestionId,
  render,
  WORDS,
} from './templates';
import {
  HoldableClass,
  PersonalLimits,
  PersonalMix,
  type PersonalParameters,
  PersonalSheet,
} from './types';

// The guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7). A model reads the person's goal into
// a draft of the sheet and says which fields it could not read. Everything after that is here, in pure
// code: each value is validated on its own and dropped to null when it fails; an amount and a time
// frame must be written in the text; a shared portfolio must be on the shelf; a refusal is taken from
// the text where its clause states it, with or without the model; any field where the model and the
// rules parser disagree is flagged and asked about. A
// market or an industry the person names is read by fixed words, or named by the model as one
// attribute and its value, and code decides what holds it on the person's chain: a shared portfolio, a
// curated label, the names a filter matches, or nothing, said so and never held (gates THEMES,
// THEME-MATCHED, THEME-NONE-YET). A holding is taken from the text only where its clause states it as
// what the person wants held: one it rules out or says of something else is not taken, one the person
// may still mean is asked once, and nothing is built from the opposite (the review of Oct 6). The
// questions come from fixed templates, one per field, and the read-back the person confirms is drawn
// from the validated sheet. The engine runs only on the sheet the person confirms.
//
// With no model (none configured, down, out of budget) the rules parser fills the draft and the same
// questions are asked. Nothing fails.

/** The fields the intake can ask about, in the order it asks. */
export const QUESTION_FIELDS = [
  'goal',
  'amountUsd',
  'sleeves',
  'mix',
  'incomeTargetUsdMonthly',
  'horizonMonths',
  'risk',
  'currency',
  'themes',
  'chains',
] as const;
export type QuestionField = (typeof QUESTION_FIELDS)[number];

/**
 * LOCAL TYPE. The person's answers to the questions, field by field, each held to the sheet's own
 * schema. An answer is the person's entry on the form: it is not checked against the text.
 */
export const IntakeAnswers = z
  .object({
    goal: BasketSheet.shape.goal,
    amountUsd: BasketSheet.shape.amountUsd,
    incomeTargetUsdMonthly: z.number().positive(),
    horizonMonths: BasketSheet.shape.horizonMonths,
    risk: BasketSheet.shape.risk,
    currency: GoalCurrency,
    themes: BasketSheet.shape.themes,
    language: Language,
    rules: BasketSheet.shape.rules,
    obligations: BasketSheet.shape.obligations.unwrap(),
    sleeves: PlanSleeves,
    restoreSplit: z.boolean(),
    limits: PersonalLimits,
    /** The person has no date for the goal (gate GLIDE-OPT-IN, Oct 6). */
    horizonOpen: z.boolean(),
    /**
     * What the person wants held (gate EXPLICIT-MIX, Oct 6), or null for no mix: the answer to a mix
     * with stocks on a goal of income or to protect, when the person keeps the goal.
     */
    mix: PersonalMix.nullable(),
  })
  .partial()
  .strict();
export type IntakeAnswers = z.infer<typeof IntakeAnswers>;

/** LOCAL TYPE. A question: the field, the template it comes from, its text, and what was read. */
export const IntakeQuestion = z.object({
  field: z.enum(QUESTION_FIELDS),
  template: z.string(),
  text: z.string(),
  /** The choices, for a field that has a fixed set. */
  options: z.array(z.string()).optional(),
  /**
   * What the text was read as, when it was read and is unclear: the form starts from it. For the
   * `mix` question it is a mix: the one the model read and the text's words could not confirm, or the
   * one the person only wondered about.
   */
  read: z.union([z.string(), z.number(), z.array(z.string()), PersonalMix]).optional(),
});
export type IntakeQuestion = z.infer<typeof IntakeQuestion>;

const Value = z.union([z.string(), z.number(), z.array(z.string()), z.null()]);

/** LOCAL TYPE. A field the model and the rules parser read differently. */
export const Disagreement = z.object({ field: z.string(), model: Value, rules: Value });
export type Disagreement = z.infer<typeof Disagreement>;

/** LOCAL TYPE. The limits the text states, as read: a draft of `PersonalLimits`. */
export const LimitsDraft = z.object({
  creditTolerance: z.literal('none').nullable(),
  cannotHoldClasses: z.array(HoldableClass).nullable(),
  /** How soon the whole plan may be needed, when the text says so: a limit, never the time frame. */
  mayNeedInMonths: BasketSheet.shape.horizonMonths.optional(),
});
export type LimitsDraft = z.infer<typeof LimitsDraft>;

/** A shared portfolio on the person's chain, by its slug and name. The model never sees this list. */
export type ShelfPortfolio = { slug: string; name: string };

/**
 * LOCAL TYPE. A market, an industry or a trend the text asks for ("big tech", "semiconductors",
 * "obesity drugs"), and what it reads to on the person's chain. Code decides it: the model names a
 * narrative by its id or by a filter, never a portfolio, a label or an asset.
 */
export const IntakeNarrative = z.object({
  /** Its id in the fixed word lists; null for one the model named by a filter. */
  id: z.enum(MARKET_IDS).nullable(),
  /** The person's words, as written. */
  words: z.string(),
  /**
   * `portfolio`: a shared portfolio on the shelf. `label`: a curated label (gate THEMES). `matched`: a
   * filter over the sourced attributes (gate THEME-MATCHED). `none`: nothing on the chain, and so
   * nothing held for it (gate THEME-NONE-YET).
   */
  kind: z.enum(['portfolio', 'label', 'matched', 'none']),
  /** The shared portfolio's slug, or the slug a theme sleeve takes; null for `none`. */
  slug: z.string().nullable(),
  /** For `matched`, the filter, its value as the stocks' attributes write it; null otherwise. */
  filter: MarketFilter.nullable(),
  /** What it is said by, in the person's language; null for `none`. */
  name: z.string().nullable(),
});
export type IntakeNarrative = z.infer<typeof IntakeNarrative>;

export type IntakeInput = {
  text: string;
  /** YYYY-MM: the month a time frame like "by 2031" is counted from. No clock is read here. */
  nowMonth: string;
  /** The language the page is in, when the text does not settle it. */
  language?: Language;
  /** What the model answered, as it came; null when no model answered. */
  reply: unknown | null;
  answers?: IntakeAnswers;
  /** The chain of the person's wallet (gate ONE-CHAIN); null while they have not picked one. */
  homeChain: ChainId | null;
  portfolios: ShelfPortfolio[];
  /** The curated stock labels on the person's chain (gate THEMES). Left out: none. */
  labels?: ShelfLabel[];
  /**
   * What a filter matches among the stocks the shelf lists on the person's chain: pure code over the
   * sourced attributes, passed by a caller that has them. Left out, or null: nothing matches.
   */
  matchOf?: (filter: MarketFilter) => FilterMatch | null;
};

export type IntakeResult = {
  method: 'model' | 'rules';
  language: Language;
  /** What the text says, after the checks. Every field null that it does not say or that failed. */
  draft: BasketSheetDraft;
  limits: LimitsDraft;
  questions: IntakeQuestion[];
  /** Why a value was dropped or doubted, by code: `amount_not_in_text`, `disagrees_with_rules:risk`. */
  flags: string[];
  disagreements: Disagreement[];
  /** The sheet, once nothing is left to ask and it validates. The person confirms it. */
  sheet: PersonalSheet | null;
  /**
   * The read-back of `sheet`, sentence by sentence, from templates, with what was assumed said before
   * the last sentence.
   */
  readBack: string[] | null;
  /** What was assumed from the person's words, from templates, so they can correct it (Oct 6). */
  assumptions: string[];
  /** What the person wants held, as read and checked (gate EXPLICIT-MIX); null when none is. */
  mix: PersonalMix | null;
  /**
   * The markets, industries and trends the text asks for, in the order written, each with what it
   * reads to on the person's chain. Empty while the person has no chain: nothing is resolved then
   * (flags `market_unresolved:<id>`).
   */
  narratives: IntakeNarrative[];
};

const RISKS = ['low', 'medium', 'high'] as const;
const WHOLE_MIX_BPS = 10_000;

const BPS_PER_PCT = WHOLE_MIX_BPS / 100;

type ShareSaidOf = Exclude<MarketShare, null>;
/**
 * A share of the money in basis points of the plan: the whole, a percent as written, or a sum over
 * the amount. Null for a sum while the amount is not known.
 */
const bpsOf = (share: ShareSaidOf, amountUsd: number | null): number | null =>
  share.kind === 'whole'
    ? WHOLE_MIX_BPS
    : share.kind === 'percent'
      ? share.value * BPS_PER_PCT
      : amountUsd === null
        ? null
        : Math.round((share.value / amountUsd) * WHOLE_MIX_BPS);

/**
 * The shares of the money a list of holdings takes, in basis points, each the sum of what the text
 * gives it: percents as written, sums over the amount. `wait`: a share is a sum and the amount is not
 * known yet. Null: a holding has no share, or one of them is "the whole". Nothing is filled in.
 */
function sharesInBps(held: { shares: MarketShare[] }[], amountUsd: number | null) {
  const said = held.map((h) => h.shares.filter((x): x is ShareSaidOf => x !== null));
  if (said.some((shares) => shares.length === 0 || shares.some((x) => x.kind === 'whole')))
    return null;
  const bps = said.map((shares) => shares.map((x) => bpsOf(x, amountUsd)));
  if (bps.some((each) => each.includes(null))) return 'wait';
  return bps.map((each) => each.reduce((n: number, x) => n + (x ?? 0), 0));
}

/**
 * The theme sleeves a list of narratives makes, each with the share of the money the text gives it:
 * one alone with the whole is the whole plan; percents and sums are their shares, and what is left is
 * kept in the safe-yield sleeve (gate EXPLICIT-MIX: "that share in stocks and the rest in cash").
 * `wait`: a share is a sum and the amount is not known yet. Null: a share is missing, one of several
 * is "the whole", or the shares come to more than the whole. Nothing is filled in.
 */
function themeSleevesOf(
  themes: { slug: string; shares: MarketShare[] }[],
  amountUsd: number | null,
): PlanSleeve[] | 'wait' | null {
  const [only] = themes;
  if (only && themes.length === 1 && only.shares.some((x) => x?.kind === 'whole'))
    return [{ kind: 'theme', theme: only.slug, shareBps: WHOLE_MIX_BPS }];
  const bps = sharesInBps(themes, amountUsd);
  if (bps === null || bps === 'wait') return bps;
  const sleeves: PlanSleeve[] = themes.map((t, i) => ({
    kind: 'theme',
    theme: t.slug,
    shareBps: bps[i] ?? 0,
  }));
  const rest = WHOLE_MIX_BPS - sleeves.reduce((n, x) => n + x.shareBps, 0);
  if (rest > 0) sleeves.push({ kind: 'safe_yield', shareBps: rest });
  return PlanSleeves.safeParse(sleeves).success ? sleeves : null;
}

/** The share of the plan a split holds in themes, in basis points. */
const themeBpsOf = (sleeves: readonly PlanSleeve[] | null | undefined): number =>
  (sleeves ?? []).reduce((n, s) => (s.kind === 'theme' ? n + s.shareBps : n), 0);

/**
 * The risk a mix needs, as the intake estimates it (gate EXPLICIT-MIX): the lowest risk whose cap per
 * issuer admits the mix's share in stocks and crypto, low for none. The engine on engine/plans derives
 * the exact one from the tokens the mix would hold (`riskForMix(sheet, shelf, ctx)`), which replaces
 * this where both are present.
 */
export function riskForMixEstimate(
  mix: Pick<PersonalMix, 'growthBps'>,
  params: Pick<PersonalParameters, 'capPerIssuerBps'> = PERSONAL_PARAMS,
): (typeof RISKS)[number] {
  return (
    RISKS.find((r) => mix.growthBps <= (params.capPerIssuerBps[r] ?? Number.NEGATIVE_INFINITY)) ??
    'high'
  );
}

const sameMix = (a: PersonalMix, b: PersonalMix) =>
  a.growthBps === b.growthBps &&
  a.dollarYieldBps === b.dollarYieldBps &&
  a.goldBps === b.goldBps &&
  a.cashBps === b.cashBps &&
  (a.creditBps ?? 0) === (b.creditBps ?? 0);

/**
 * The text the intake reads: the first message and every later one, in order, a blank line between
 * them (Oct 6). A follow-up in the person's own words ("I want to grow it", "70-30") is read again with
 * what came before, by the same reader and the same checks: an answer is never only a form field.
 */
export const conversationText = (text: string, followUps: readonly string[] = []): string =>
  [text, ...followUps]
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n');

// The model's reply, field by field. Each is read on its own, so one bad field costs only itself.
const REPLY_FIELDS = {
  goal: BasketSheet.shape.goal,
  amountUsd: BasketSheet.shape.amountUsd,
  incomeTargetUsdMonthly: z.number().positive(),
  horizonMonths: BasketSheet.shape.horizonMonths,
  risk: BasketSheet.shape.risk,
  currency: GoalCurrency,
  chain: z.enum(['solana', 'base', 'robinhood']),
  portfolios: BasketSheet.shape.themes,
  // Any language the text is written in (EXPLICIT-MIX): en and pt are kept, any other is read in en.
  language: z.string().trim().toLowerCase().min(2).max(12),
  /** Markets and trends named ("big tech", "AI"): read to the shelf in code, never by the model. */
  markets: z.array(z.enum(MARKET_IDS)),
  /**
   * A market, an industry or a business the person names that `markets` has no value for ("obesity
   * drugs"): one attribute and its value (gate THEME-MATCHED), with the person's own words. It names
   * no company, ticker or portfolio: code looks for the names whose sourced attributes carry it.
   */
  marketFilter: MarketFilter.extend({
    // The contract sets no length (`market-filter.ts`): what comes from outside is bounded here.
    value: MarketFilter.shape.value.max(INTAKE_LIMITS.filterValueChars),
    words: z.string().trim().min(1).max(INTAKE_LIMITS.filterWordsChars),
  }),
  /** What the person said to hold, in whole percents of the plan (gate EXPLICIT-MIX). */
  mix: z.object({
    growthPct: z.number().int().min(0).max(100),
    dollarYieldPct: z.number().int().min(0).max(100),
    goldPct: z.number().int().min(0).max(100),
    cashPct: z.number().int().min(0).max(100),
    creditPct: z.number().int().min(0).max(100).nullable().optional(),
  }),
  noCredit: z.boolean(),
  cannotHold: z.array(HoldableClass),
  unclear: z.array(z.string()),
  openEnded: z.boolean(),
  mayNeedInMonths: BasketSheet.shape.horizonMonths,
  sleeves: z
    .array(
      z.object({
        kind: z.enum(['goal', 'safe_yield']),
        sharePct: z
          .number()
          .int()
          .min(1)
          .max(100 - 1),
      }),
    )
    .min(2)
    .max(2),
} as const;
type ReplyField = keyof typeof REPLY_FIELDS;
type Reply = { [K in ReplyField]: z.infer<(typeof REPLY_FIELDS)[K]> | null };

/** The model's reply as values: a field that does not validate is null, and flagged. */
export function readReply(raw: unknown): { reply: Reply; flags: string[] } {
  const flags: string[] = [];
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!obj) flags.push('model_unreadable');
  const reply = {} as Record<ReplyField, unknown>;
  for (const key of Object.keys(REPLY_FIELDS) as ReplyField[]) {
    const value = obj ? (obj as Record<string, unknown>)[key] : null;
    if (value === null || value === undefined) {
      reply[key] = null;
      continue;
    }
    const parsed = REPLY_FIELDS[key].safeParse(value);
    reply[key] = parsed.success ? parsed.data : null;
    if (!parsed.success) flags.push(`model_invalid:${key}`);
  }
  return { reply: reply as Reply, flags };
}

/** "The Seven", "the seven" and "the-seven" all name the slug `the-seven`. */
const slugOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function portfolioSlug(name: string, shelf: ShelfPortfolio[]): string | null {
  const wanted = slugOf(name);
  const hit = shelf.find((p) => p.slug === name || slugOf(p.name) === wanted || p.slug === wanted);
  return hit?.slug ?? null;
}

const EMPTY_DRAFT: BasketSheetDraft = {
  basketType: null,
  goal: null,
  amountUsd: null,
  horizonMonths: null,
  risk: null,
  themes: null,
  country: null,
  chains: null,
  incomeTargetUsdMonthly: null,
  rules: null,
  language: null,
  currency: null,
  obligations: null,
  sleeves: null,
  restoreSplit: null,
};

// The fields both readers read, compared field by field.
const COMPARED = ['goal', 'horizonMonths', 'risk', 'language'] as const;

/**
 * The mix a message says in answer to the `mix` question asked before it (gate EXPLICIT-MIX), in the
 * person's own words: a mix it states ("all of it in stocks", "70% stocks and 30% cash"), or a share
 * with nothing else ("70-30", "half", "all of it", "$500"). Asked of a market ("How much of the $2,000
 * for big tech?"), the share is the market's, in stocks, and the rest is cash; asked how the money is
 * held ("how much in stocks and crypto, and how much in cash?"), a pair is read in that order. Null
 * where the message says neither, or a share that cannot be read one way.
 */
function mixAnswered(
  message: string,
  asked: IntakeQuestion,
  amountUsd: number | null,
): PersonalMix | null {
  const stated = mixIn(message);
  const share = stated ? null : shareSaidIn(message);
  const ofAMarket = asked.template !== 'mix';
  let growthBps: number | null = null;
  if (share?.kind === 'pair') growthBps = share.first * BPS_PER_PCT;
  if (share?.kind === 'percent') growthBps = share.value * BPS_PER_PCT;
  // "All of it" and a sum answer "how much for it", and say nothing of how the whole is held.
  if (share?.kind === 'whole' && ofAMarket) growthBps = WHOLE_MIX_BPS;
  if (share?.kind === 'amount' && ofAMarket) growthBps = bpsOf(share, amountUsd);
  const mix =
    stated?.mix ??
    (growthBps === null
      ? null
      : { growthBps, dollarYieldBps: 0, goldBps: 0, cashBps: WHOLE_MIX_BPS - growthBps });
  const parsed = PersonalMix.safeParse(mix);
  return mix !== null && parsed.success ? parsed.data : null;
}

/**
 * The draft, the questions, and the sheet with its read-back once nothing is left to ask.
 *
 * The person's later messages are read with the first (`conversationText` joins them with a blank
 * line), by the same reader and the same checks. A reply of a few words ("70-30", "half", "all of it")
 * names no market and no question: read with the rest it was lost, or taken for a split of its own. So
 * each message after the first is read as the answer to the `mix` question the messages before it
 * left open, where they left one open and the message says a share or a mix, as an answer on the form
 * is (flag `mix_from_words`). An answer on the form wins. A `mix` question that is there only because
 * the model read a mix is not counted: the reply at hand is the model's reading of the whole
 * conversation, this message included, so that question may never have been asked.
 */
export function runIntake(input: IntakeInput): IntakeResult {
  const blocks = input.text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  // Only the last few messages are read this way: a long text in many paragraphs is one message.
  const first = Math.max(0, blocks.length - INTAKE_LIMITS.turnsRead);
  const turns = [blocks.slice(0, first + 1).join('\n\n'), ...blocks.slice(first + 1)];
  let answers = input.answers ?? {};
  const inWords: string[] = [];
  for (let n = 1; n < turns.length && !('mix' in answers); n += 1) {
    const before = intakeOf({ ...input, text: turns.slice(0, n).join('\n\n') }, answers, []);
    const asked = before.questions.find((q) => q.field === 'mix');
    if (!asked || before.flags.includes('mix_asked:model')) continue;
    const amountUsd = answers.amountUsd ?? before.draft.amountUsd;
    const mix = mixAnswered(turns[n] ?? '', asked, amountUsd);
    if (mix) {
      answers = { ...answers, mix };
      inWords.push('mix_from_words');
    }
  }
  return intakeOf(input, answers, inWords);
}

/** The intake of a text, with the answers the person gave on the form or, for the mix, in words. */
function intakeOf(input: IntakeInput, answers: IntakeAnswers, inWords: string[]): IntakeResult {
  const { text, nowMonth, portfolios } = input;
  const flags: string[] = [...inWords];
  const unclear = new Set<QuestionField>();
  const rules = draftFromRules(text, nowMonth, input.language).draft;
  const draft: BasketSheetDraft = { ...EMPTY_DRAFT };
  const limits: LimitsDraft = { creditTolerance: null, cannotHoldClasses: null };
  // A value the text holds in another currency than dollars, to name in the question.
  let otherCurrency: { amount: number; currency: string } | null = null;
  const disagreements: Disagreement[] = [];
  const method = input.reply === null ? 'rules' : 'model';
  const split = splitIn(text);
  const exits = exitTimesIn(text);
  const openWords = openEndedIn(text);
  // A date or a time frame written in the text wins over "no rush" ("no rush, but I need it by 2030").
  const dated = horizonsIn(text, nowMonth).length > 0;
  let openEnded = false;
  // What the model read as a mix and as markets (gate EXPLICIT-MIX); null with no model.
  let replyMix: PersonalMix | null = null;
  let replyMarkets: Market[] | null = null;
  // The filter the model named for a market the fixed lists have no word for (gate THEME-MATCHED).
  let replyFilter: (MarketFilter & { words: string }) | null = null;
  // The shared portfolios the model says the text names, as written.
  let namedPortfolios: string[] = [];
  // What the model says the person rules out; none with no model.
  let replyRefused: Refused[] = [];

  if (input.reply === null) {
    Object.assign(draft, rules);
    // A text in another language than en or pt (EXPLICIT-MIX): the rules parser reads only those two,
    // and its guess of one is not the text's. The intake speaks English; the chat translates.
    if (otherLanguageIn(text)) {
      draft.language = 'en';
      flags.push('language_other');
    }
    // The rules parser misreads ("for 5 years" as 61 months, "no stocks" as high risk): with no model
    // to check it against, every field it read is put to the person once, its reading the start.
    for (const field of ['goal', 'horizonMonths', 'risk'] as const)
      if (rules[field] !== null) {
        flags.push(`from_rules:${field}`);
        unclear.add(field);
      }
    // "No hard cap", "sem prazo": no date, read by code, the same with or without a model.
    if (openWords !== null && rules.horizonMonths === null && !dated) openEnded = true;
  } else {
    const read = readReply(input.reply);
    flags.push(...read.flags);
    const r = read.reply;
    draft.goal = r.goal;
    draft.risk = r.risk;
    // Any language is read (EXPLICIT-MIX); the questions and the read-back are in en or pt, and a text
    // in any other is answered in en.
    if (r.language === 'en' || r.language === 'pt') draft.language = r.language;
    else if (r.language !== null) {
      draft.language = 'en';
      flags.push(`language_other:${r.language}`);
    }
    replyMarkets = r.markets;
    replyFilter = r.marketFilter;
    if (r.mix !== null) {
      const m = r.mix;
      const parsed = PersonalMix.safeParse({
        growthBps: m.growthPct * 100,
        dollarYieldBps: m.dollarYieldPct * 100,
        goldBps: m.goldPct * 100,
        cashBps: m.cashPct * 100,
        ...(m.creditPct ? { creditBps: m.creditPct * 100 } : {}),
      });
      if (parsed.success) replyMix = parsed.data;
      else flags.push('model_invalid:mix');
    }

    // An amount must be written in the text, in dollars or with no currency beside it.
    for (const field of ['amountUsd', 'incomeTargetUsdMonthly'] as const) {
      const value = r[field];
      if (value === null) continue;
      // Each figure in its role: the sum put in is never a rate a month, the income always is.
      const where = amountInText(text, value, field === 'amountUsd' ? 'amount' : 'income');
      if (where === 'dollars') draft[field] = value;
      else {
        flags.push(
          where === 'absent'
            ? `not_in_text:${field}`
            : where === 'wrong_role'
              ? `wrong_role:${field}`
              : `other_currency:${field}`,
        );
        unclear.add(field);
        if (where === 'other_currency' && field === 'amountUsd') {
          const m = mentionsIn(text).find(
            (x) =>
              x.kind === 'amount' &&
              x.currency &&
              x.currency !== 'USD' &&
              x.currency !== 'XXX' &&
              Math.abs(x.value - value) < 1,
          );
          if (m?.currency) otherCurrency = { amount: m.value, currency: m.currency };
        }
      }
    }
    // The model may give one figure as both the amount and the income.
    if (
      draft.amountUsd !== null &&
      draft.amountUsd === draft.incomeTargetUsdMonthly &&
      mentionsIn(text).filter((m) => m.kind === 'amount' && m.value === draft.amountUsd).length < 2
    ) {
      flags.push('same_figure_twice');
      unclear.add('amountUsd');
      unclear.add('incomeTargetUsdMonthly');
    }
    // A time frame must be written in the text, as one. A time to get the money out ("can take up to
    // 3 months to get out") is a limit on liquidity, never the time frame: it is dropped, not asked.
    const horizons = horizonsIn(text, nowMonth);
    if (r.horizonMonths !== null) {
      if (horizons.includes(r.horizonMonths)) draft.horizonMonths = r.horizonMonths;
      else if (exits.some((e) => e.months === r.horizonMonths)) flags.push('exit_time_not_horizon');
      else {
        flags.push('not_in_text:horizonMonths');
        unclear.add('horizonMonths');
      }
    }
    // No date: taken only where the text says so ("no hard cap", "open-ended", "sem prazo").
    if (r.openEnded === true) {
      if (openWords === null) flags.push('no_cue:openEnded');
      else if (dated) {
        flags.push('date_in_text:openEnded');
        if (draft.horizonMonths === null) unclear.add('horizonMonths');
      } else openEnded = draft.horizonMonths === null;
    }
    // How soon the whole plan may be needed: written as a time to get out, or as a time frame.
    if (r.mayNeedInMonths !== null) {
      if (exits.some((e) => e.months === r.mayNeedInMonths) || horizons.includes(r.mayNeedInMonths))
        limits.mayNeedInMonths = r.mayNeedInMonths;
      else flags.push('not_in_text:mayNeedInMonths');
    }
    // The person's split: each share written in the text, the two the whole. "Half and half" is
    // written as halves.
    if (r.sleeves !== null) {
      const written = new Set([...split.percents, ...split.pairs.flat()]);
      const whole = r.sleeves.reduce((n, x) => n + x.sharePct, 0) === 100;
      const kinds = new Set(r.sleeves.map((x) => x.kind)).size === r.sleeves.length;
      const each = r.sleeves.every(
        (x) => written.has(x.sharePct) || (split.half && x.sharePct * 2 === 100),
      );
      // Every share the text writes as a percent of the money is part of the split, or it is asked:
      // "70/30 but 50% in AI" is never read as 70/30 with the 50% dropped.
      const shares = new Set(r.sleeves.map((x) => x.sharePct));
      const unplaced = split.ofMoney.filter((p) => !shares.has(p));
      if (whole && kinds && each && unplaced.length === 0)
        draft.sleeves = r.sleeves.map((x) => ({ kind: x.kind, shareBps: x.sharePct * 100 }));
      else if (whole && kinds && each) {
        flags.push('split_percent_unplaced');
        unclear.add('sleeves');
      } else {
        flags.push('not_in_text:sleeves');
        unclear.add('sleeves');
      }
    }
    // A currency other than dollars must be written beside an amount.
    if (r.currency !== null) {
      const written = currenciesIn(text);
      if (r.currency === 'USD' ? written.every((c) => c === 'USD') : written.includes(r.currency))
        draft.currency = r.currency;
      else {
        flags.push('not_in_text:currency');
        unclear.add('currency');
      }
    }
    // A shared portfolio the model names must be written in the text, by its name or its slug: the
    // model reads what the person named, it picks nothing. One the text does not write is dropped and
    // flagged, and nothing is asked about it. One that is written must be on the shelf of the
    // person's chain, or it is asked.
    if (r.portfolios !== null && r.portfolios.length > 0) {
      const writtenAs = (name: string) => {
        const onShelf = portfolios.find((p) => p.slug === portfolioSlug(name, portfolios));
        return [name, onShelf?.name, onShelf?.slug].some(
          (words) => words !== undefined && phraseIn(text, words).length > 0,
        );
      };
      namedPortfolios = r.portfolios.filter(writtenAs);
      if (namedPortfolios.length < r.portfolios.length) flags.push('no_cue:portfolios');
      const slugs = namedPortfolios.map((name) => portfolioSlug(name, portfolios));
      const found = [...new Set(slugs.filter((s): s is string => s !== null))];
      if (found.length < slugs.length) {
        flags.push('not_on_shelf:themes');
        unclear.add('themes');
      }
      draft.themes = found.length > 0 ? found : null;
    }
    // The chain is the wallet's. One named in the text is kept in the draft, and a different one is said.
    if (r.chain !== null) {
      draft.chains = [r.chain];
      if (input.homeChain && r.chain !== input.homeChain) flags.push(`other_chain:${r.chain}`);
    }
    // What the model says the person rules out ("no stocks", "sem ações", "no credit"): held to the
    // text below, where the refusals are read with or without it.
    replyRefused = [
      ...new Set(r.cannotHold ?? []),
      ...(r.noCredit === true ? ['credit' as const] : []),
    ];
    // What the model itself says it could not read.
    for (const field of r.unclear ?? [])
      if ((QUESTION_FIELDS as readonly string[]).includes(field))
        unclear.add(field as QuestionField);

    // A goal or a risk the text has no word for is the model's suggestion, not a reading:
    // it is kept as the form's start and asked.
    if (draft.goal !== null && !goalCuesIn(text).includes(draft.goal)) {
      flags.push('no_cue:goal');
      unclear.add('goal');
    }
    if (draft.risk !== null && !riskCuesIn(text).includes(draft.risk)) {
      flags.push('no_cue:risk');
      unclear.add('risk');
    }

    // Where the two readers both read a field and differ, the field is unclear. Two readings of the risk
    // are not compared: the rules parser's "medium" where the text has no word for it (its default, not
    // a reading), and any one where a part is kept safe (the text then says a risk per part; the plan's
    // risk is the other part's).
    const perPart = draft.sleeves?.some((x) => x.kind === 'safe_yield') === true;
    for (const field of COMPARED) {
      const model = draft[field];
      const other = rules[field];
      if (
        field === 'risk' &&
        // With a part kept safe, the rules parser's one reading is compared with the risky part's,
        // unless it read low: that word is the safe part's ("as low as possible for the 70%").
        ((perPart && other === 'low') ||
          (other === 'medium' && !riskCuesIn(text).includes('medium')))
      )
        continue;
      // The rules parser counts "for 10 years" as 121 months: one month apart is the same time frame
      // here, in this check only.
      const near =
        field === 'horizonMonths' &&
        typeof model === 'number' &&
        typeof other === 'number' &&
        Math.abs(model - other) <= 1;
      if (model !== null && other !== null && model !== other && !near) {
        disagreements.push({ field, model, rules: other });
        flags.push(`disagrees_with_rules:${field}`);
        if (field !== 'language') unclear.add(field);
      }
    }
  }

  // What the person rules out ("no stocks", "sem ações", "no credit") is taken from the text, by code,
  // with or without a model (found by the playground run of Oct 6, where with no model it was lost):
  // a refusal that is lost gives the person what they refused. One its clause states becomes the sheet's limits, and the read-back says it back for
  // the person to confirm: it is taken, not asked. One its clause negates ("I can't do without
  // stocks"), says of something else ("my brother holds no stocks") or only wonders about ("no
  // stocks? not sure") is not taken (`refusal_<how>:<what>`). The model's reply is a check, both
  // ways: what it gives that the text does not write is dropped (`not_in_text:`), and what the text
  // states that it missed is taken all the same (`disagrees_with_rules:`).
  const refusals = refusalsSaidIn(text);
  const refused = new Set(refusals.filter((x) => x.stance === 'stated').map((x) => x.what));
  const refusalOf = (what: Refused) => (what === 'credit' ? 'noCredit' : `cannotHold:${what}`);
  for (const what of replyRefused)
    if (!refusals.some((x) => x.what === what)) flags.push(`not_in_text:${refusalOf(what)}`);
  if (method === 'model')
    for (const what of refused)
      if (!replyRefused.includes(what)) flags.push(`disagrees_with_rules:${refusalOf(what)}`);
  // Written, and not taken. Where the person is not sure, or the model read it as their refusal, it
  // is said back with the read-back: nothing a reader took for a refusal is dropped in silence.
  const refusalsNotTaken: RefusalSaid[] = [];
  for (const what of new Set(refusals.map((x) => x.what))) {
    if (refused.has(what)) continue;
    const written = refusals.filter((x) => x.what === what);
    const shown = written.find((x) => x.stance === 'wondered') ?? written[0];
    if (!shown) continue;
    flags.push(`refusal_${shown.stance}:${what}`);
    if (shown.stance === 'wondered' || replyRefused.includes(what)) refusalsNotTaken.push(shown);
  }
  const classesRefused = [...refused].filter((x): x is HoldableClass => x !== 'credit').sort();
  limits.cannotHoldClasses = classesRefused.length > 0 ? classesRefused : null;
  if (refused.has('credit')) limits.creditTolerance = 'none';

  // What the person wants held (gate EXPLICIT-MIX, Rodrigo, Oct 6). A mix is taken only as written,
  // and only where its clause states it as what the person wants held: code reads it from the text in
  // English or Portuguese ("all of it in stocks", "70% stocks and 30% cash", "só crédito"). One its
  // clause rules out or says of something else is no mix ("I wouldn't put all of it in stocks", "so no
  // stocks please"): nothing is built from the opposite of what is written. One the person only
  // wonders about ("Should I put all of it in stocks?"), or says of a part of the money ("the other
  // 30% all in stocks"), is asked (below). Where the model and the text both read one and differ, the
  // text's is taken and the difference flagged.
  const mixSaid = mixSaidIn(text);
  const written = mixSaid?.stance === 'stated' ? mixSaid : null;
  if (mixSaid && !written) flags.push(`mix_${mixSaid.stance}`);
  let mixRead: PersonalMix | null = null;
  if (written) {
    const parsed = PersonalMix.safeParse(written.mix);
    if (parsed.success) {
      mixRead = parsed.data;
      if (replyMix && !sameMix(replyMix, parsed.data)) flags.push('disagrees_with_rules:mix');
    }
  }
  if (replyMix && !mixRead) flags.push('no_cue:mix');
  // Markets, industries and trends ("big tech", "the S&P", "semiconductors", "defense stocks"): the
  // narrative's words must be in the text, as an ask. One the model names that the text has no word
  // for is dropped and asked; one the text names only to rule it out, or in passing, is dropped. Words
  // inside a shared portfolio's name ("Chips & Agents") name the portfolio, not a market.
  const portfolioNames = [...portfolios.map((p) => p.name), ...namedPortfolios];
  const mentions = marketMentionsIn(text, portfolioNames);
  const asked = mentions.filter((m) => m.skipped === null);
  for (const m of replyMarkets ?? []) {
    if (asked.some((w) => w.market === m)) continue;
    const skipped = mentions.find((w) => w.market === m)?.skipped;
    if (skipped) flags.push(`market_${skipped}:${m}`);
    else {
      flags.push(`no_cue:market:${m}`);
      unclear.add('themes');
    }
  }
  // A market the fixed lists have no word for, named by the model as a filter over the sourced
  // attributes (gate THEME-MATCHED). The filter is held to its schema, and the person's words must be
  // written in the text, as an ask, where no fixed list already reads them and they are no part of a
  // shared portfolio's name. Otherwise it is dropped and flagged, and nothing is asked about it. With
  // no model there is none.
  type Named = { words: string; at: number; end: number; wondered: boolean };
  let filterAsked: { filter: MarketFilter; spans: Named[] } | null = null;
  if (replyFilter) {
    const { words, ...filter } = replyFilter;
    const spans = phraseIn(text, words);
    const read = [...mentions, ...portfolioNames.flatMap((name) => phraseIn(text, name))];
    const free = spans.filter((s) => !read.some((m) => m.at < s.end && s.at < m.end));
    const asks = free.flatMap((s): Named[] => {
      const stance = stanceOf(text, s.at, s.end);
      return stance === 'negated' || stance === 'aside'
        ? []
        : [{ ...s, wondered: stance === 'wondered' }];
    });
    if (matchedSlug(filter) === null) flags.push('model_invalid:marketFilter');
    else if (spans.length === 0) flags.push('no_cue:marketFilter');
    else if (free.length === 0) flags.push('market_covers:marketFilter');
    else if (asks.length === 0) flags.push('market_negated:marketFilter');
    else filterAsked = { filter, spans: asks };
  }
  const named: Named[] = [...asked, ...(filterAsked?.spans ?? [])];
  // The split, once what is said of the narratives is set apart: "30%" in "30% in AI" and "half" in
  // "half in big tech" are those narratives' shares, not a split of the plan.
  const rest = splitIn(
    withoutMarketShares(
      text,
      named.map((m) => m.at),
    ),
  );
  // With no model, a split the rules parser cannot read ("70-30", "70%") is asked.
  if (input.reply === null && (rest.pairs.length > 0 || rest.percents.length > 0))
    unclear.add('sleeves');

  // What each narrative reads to on the person's chain, in this order: its shared portfolio, where it
  // names one and the shelf holds it; its curated label, when confirmed and holding a stock listed
  // there (gate THEMES); the first of its filters that matches a stock listed there (gate
  // THEME-MATCHED: the narrative's own, in the order written, or the one the model named); or nothing.
  // Code decides, never the model.
  const labels = input.labels ?? [];
  const usableLabel = (slug: string): ShelfLabel | null =>
    labels.find((l) => l.slug === slug && l.status === 'confirmed' && l.listed > 0) ?? null;
  // The value a matched slug was matched by, as the stocks' attributes write it: the read-back says it.
  const matchedValues: Record<string, string> = {};
  // A filter that matches: the slug its theme sleeve takes, and the filter with the value as the
  // attributes write it. The two writings must be one value (`attributeKey`), or nothing matches.
  const matchFor = (filter: MarketFilter): { slug: string; filter: MarketFilter } | null => {
    const slug = matchedSlug(filter);
    const match = slug ? (input.matchOf?.(filter) ?? null) : null;
    if (!slug || !match || !(match.listed > 0)) return null;
    const kept = MarketFilter.safeParse({ by: filter.by, value: match.value });
    if (!kept.success || attributeKey(kept.data.value) !== attributeKey(filter.value)) return null;
    matchedValues[slug] = kept.data.value;
    return { slug, filter: kept.data };
  };
  type Read = {
    id: Market | null;
    words: string;
    at: number;
    /** The share of the money the text gives it: the last one said, wherever it is named. */
    share: MarketShare;
    kind: IntakeNarrative['kind'];
    slug: string | null;
    filter: MarketFilter | null;
  };
  const resolve = (
    id: Market | null,
    ofModel: MarketFilter | null,
  ): Pick<Read, 'kind' | 'slug' | 'filter'> => {
    const narrative = id ? NARRATIVES[id] : null;
    const portfolio = narrative?.portfolio;
    if (portfolio && portfolios.some((p) => p.slug === portfolio))
      return { kind: 'portfolio', slug: portfolio, filter: null };
    if (narrative && usableLabel(narrative.label))
      return { kind: 'label', slug: narrative.label, filter: null };
    const label = narrative ? labels.find((l) => l.slug === narrative.label) : undefined;
    // A label that is still a proposal, or lists no stock on this chain, holds nothing: said to the
    // operator, once, and the narrative goes on to its filters.
    const unusable = label
      ? `${label.status === 'confirmed' ? 'label_not_listed' : 'label_proposed'}:${label.slug}`
      : null;
    if (unusable && !flags.includes(unusable)) flags.push(unusable);
    const filters = narrative ? narrative.filters : ofModel ? [ofModel] : [];
    for (const filter of filters) {
      const match = matchFor(filter);
      if (match) return { kind: 'matched', ...match };
    }
    const name = id ?? 'marketFilter';
    if (filters.length > 0) flags.push(`filter_no_match:${name}`);
    flags.push(`market_not_on_shelf:${name}`);
    return { kind: 'none', slug: null, filter: null };
  };
  // A share is read where the narrative is stated; one the person only wonders about has none yet.
  const shareOf = (spans: Named[]): MarketShare =>
    spans
      .map((s) => (s.wondered ? null : marketShareIn(text, s.at, s.end)))
      .filter((s) => s !== null)
      .at(-1) ?? null;
  // In the order of the fixed lists, then the model's filter. While the person has no chain nothing
  // is resolved, and nothing is said of what their chain has: the chain is asked first.
  const reads: Read[] = [];
  const marketsAsked = MARKET_IDS.filter((id) => asked.some((m) => m.market === id));
  if (input.homeChain === null) {
    for (const id of marketsAsked) flags.push(`market_unresolved:${id}`);
    if (filterAsked) flags.push('market_unresolved:marketFilter');
  } else {
    for (const id of marketsAsked) {
      const spans = asked.filter((m) => m.market === id);
      const [first] = spans;
      if (first)
        reads.push({
          id,
          words: first.words,
          at: first.at,
          share: shareOf(spans),
          ...resolve(id, null),
        });
    }
    const [first] = filterAsked?.spans ?? [];
    if (filterAsked && first)
      reads.push({
        id: null,
        words: first.words,
        at: first.at,
        share: shareOf(filterAsked.spans),
        ...resolve(null, filterAsked.filter),
      });
  }
  // A shared portfolio is where the plan starts from, as before.
  for (const { kind, slug } of reads)
    if (kind === 'portfolio' && slug && !(draft.themes ?? []).includes(slug))
      draft.themes = [...(draft.themes ?? []), slug];
  // The narratives a theme sleeve holds: one per label or filter, however many words name it.
  const themed = reads
    .filter((r) => r.kind === 'label' || r.kind === 'matched')
    .sort((a, b) => a.at - b.at);
  const themes: { slug: string; words: string; shares: MarketShare[] }[] = [];
  for (const r of themed) {
    const same = themes.find((t) => t.slug === r.slug);
    if (same) same.shares.push(r.share);
    else if (r.slug) themes.push({ slug: r.slug, words: r.words, shares: [r.share] });
  }
  // What an answer's theme sleeve names must be on the shelf too: a curated label that holds a stock
  // on the person's chain, or a filter that matches one there. Otherwise the answer is refused and
  // the split asked again, as a portfolio answered off the shelf is.
  let sleevesAnswered = answers.sleeves;
  let sleevesRefused = false;
  if (sleevesAnswered && input.homeChain !== null) {
    for (const s of sleevesAnswered) {
      if (s.kind !== 'theme' || usableLabel(s.theme)) continue;
      const by = filterOfSlug(s.theme);
      if (!by || matchFor({ by: by.by, value: by.key })?.slug !== s.theme) sleevesRefused = true;
    }
    if (sleevesRefused) {
      flags.push('answer_not_on_shelf:sleeves');
      sleevesAnswered = undefined;
    }
  }

  // "70% ... and the other half" is more than the whole: the split is asked, never guessed.
  let mismatch: { pct: number; rest: number } | null = null;
  if (
    draft.sleeves === null &&
    rest.mismatch &&
    rest.pairs.length === 0 &&
    !('sleeves' in answers)
  ) {
    flags.push('split_mismatch');
    unclear.add('sleeves');
    mismatch = { pct: rest.mismatch.pct, rest: 100 - rest.mismatch.pct };
  }
  if (maxYieldAskedIn(text)) flags.push('max_yield_asked');

  const language: Language =
    answers.language ?? draft.language ?? input.language ?? rules.language ?? 'en';
  const P = PERSONAL_PARAMS;
  // No date: the person said so, in words or as an answer. A date given wins.
  const horizonOpen =
    answers.horizonOpen ??
    (answers.horizonMonths !== undefined ? false : openEnded && draft.horizonMonths === null);

  // The values the sheet would take: the person's answers over what was read.
  const value = {
    goal: answers.goal ?? draft.goal,
    amountUsd: answers.amountUsd ?? draft.amountUsd,
    incomeTargetUsdMonthly: answers.incomeTargetUsdMonthly ?? draft.incomeTargetUsdMonthly,
    horizonMonths:
      answers.horizonMonths ?? (horizonOpen ? P.openEndedHorizonMonths : draft.horizonMonths),
    risk: answers.risk ?? draft.risk,
    currency: answers.currency ?? draft.currency,
    themes: answers.themes ?? draft.themes,
  };
  // The mix (gate EXPLICIT-MIX): the person's answer over what was read. A mix is of the whole plan,
  // so a split read beside it is not kept: the percents are the mix's.
  // A market read to a shared portfolio is a stated holding too (EXPLICIT-MIX): one whose share of the
  // money is written ("invest in big tech", "put $1,000 in US stocks", "put 50% in big tech", "half in
  // the S&P") is held, that share in stocks and the rest in cash; one with no share said ("I like big
  // tech") asks how much, once, and never the risk. Not beside a split, which says the shares itself,
  // nor on a goal of income or to protect.
  // A narrative the chain has nothing for is no stated holding (gate THEME-NONE-YET, Rodrigo, Oct 6):
  // no mix and no sleeve is made from it, and its share is never asked. That is said in one sentence
  // (below), and the rest of the intake goes on as if it had not been named: the risk is asked as for
  // any goal.
  let marketMix: { mix: PersonalMix; words: string } | null = null;
  let marketShareAsk: string | null = null;
  // A share written as a sum waits for the amount it is a share of: nothing is asked of it meanwhile.
  let shareWaits = false;
  const splitWritten =
    rest.ofMoney.length > 0 ||
    rest.pairs.length > 0 ||
    draft.sleeves !== null ||
    sleevesAnswered !== undefined;
  const toGrow = value.goal !== 'income' && value.goal !== 'protect';
  const held = reads.filter((r) => r.kind === 'portfolio');
  // Not where a theme sleeve is in play: the two are not combined (below).
  if (
    themes.length === 0 &&
    !mixRead &&
    !('mix' in answers) &&
    !splitWritten &&
    held.length > 0 &&
    toGrow
  ) {
    // What the text gives the markets: the whole, or the sum of the shares it writes for them.
    const whole = held.find((r) => r.share?.kind === 'whole');
    const bps = whole
      ? [WHOLE_MIX_BPS]
      : sharesInBps([{ shares: held.map((r) => r.share) }], value.amountUsd);
    const first = whole ?? held.find((r) => r.share !== null) ?? held[0];
    if (bps === 'wait') shareWaits = true;
    else if (first) {
      const [growthBps = 0] = bps ?? [];
      const parsed =
        growthBps > 0 && growthBps <= WHOLE_MIX_BPS
          ? PersonalMix.safeParse({
              growthBps,
              dollarYieldBps: 0,
              goldBps: 0,
              cashBps: WHOLE_MIX_BPS - growthBps,
            })
          : null;
      if (parsed?.success) {
        marketMix = { mix: parsed.data, words: first.words };
        flags.push('mix_from_market');
      } else {
        // No share said, or shares that come to more than the money: how much is asked.
        marketShareAsk = first.words;
        flags.push('market_share_unclear');
      }
    }
  }
  // A narrative that reads to a curated label or to a filter is held as a theme sleeve (gates THEMES,
  // THEME-MATCHED), by the same rule for its share: the whole, or a written sum or percent ("30% in
  // AI", "half in semiconductors") with the rest kept in the safe-yield sleeve; with no share said,
  // how much is asked once. A sheet holds a mix or sleeves, never both, so nothing is combined by
  // guessing. Where the shares are not all written (none said, one of several missing, shares over the
  // whole), or a theme is named beside a shared portfolio the text also names, beside a mix the text
  // states that says another share for stocks, or beside a split of the money the text writes, one
  // question is asked instead, by the field whose answer can settle it:
  //   - one theme alone, with no shared portfolio and no written split beside it: how much of the
  //     money (`mix`), as for a market. The answered share of stocks is the theme's;
  //   - anything else: the split (`sleeves`). Only a split says a share for each part.
  // A mix that says the same as the themes' shares ("invest in semiconductors, all of it in stocks")
  // is no second mechanism: the sleeves are made. On a goal of income or to protect a narrative's
  // share is not read, as a market's is not: the theme is not held, and that is said.
  let themeSleeves: PlanSleeve[] | null = null;
  let themeAsk: 'mix' | 'sleeves' | null = null;
  const themesNotHeld = themes.length > 0 && !toGrow;
  if (themesNotHeld) flags.push('themes_dropped_for_goal');
  else if (sleevesAnswered !== undefined) {
    // The person's own split stands as entered: a theme the text names that it leaves out is not held.
    for (const t of themes)
      if (!sleevesAnswered.some((x) => x.kind === 'theme' && x.theme === t.slug))
        flags.push(`theme_not_held:${t.slug}`);
  } else if (themes.length > 0) {
    const [only] = themes;
    const portfolioToo = held.length > 0;
    const sameAsMix = (sleeves: PlanSleeve[], m: PersonalMix | null) =>
      m === null || (m.growthBps === themeBpsOf(sleeves) && m.dollarYieldBps + m.goldBps === 0);
    if ('mix' in answers) {
      // The answer to "how much for it": that share for the one theme, and the rest kept safe. An
      // answer that holds more than stocks and cash, or that cannot be one theme's, stays a mix.
      const m = answers.mix ?? null;
      const to: PlanSleeve[] | null =
        m && only && themes.length === 1 && !portfolioToo && m.growthBps > 0
          ? [
              { kind: 'theme', theme: only.slug, shareBps: m.growthBps },
              ...(m.growthBps < WHOLE_MIX_BPS
                ? [{ kind: 'safe_yield' as const, shareBps: WHOLE_MIX_BPS - m.growthBps }]
                : []),
            ]
          : null;
      if (to && sameAsMix(to, m)) {
        themeSleeves = to;
        flags.push('sleeves_from_mix_answer');
      } else for (const t of themes) flags.push(`theme_not_held:${t.slug}`);
    } else {
      const besideSplit = splitWritten && !mixRead;
      const made = portfolioToo || besideSplit ? null : themeSleevesOf(themes, value.amountUsd);
      if (made === 'wait') shareWaits = true;
      else if (made && sameAsMix(made, mixRead)) {
        themeSleeves = made;
        draft.sleeves = made;
        flags.push('sleeves_from_market');
      } else {
        if (besideSplit) flags.push('theme_beside_split');
        if (portfolioToo) flags.push('theme_beside_portfolio');
        if (mixRead) flags.push('theme_beside_mix');
        if (only && themes.length === 1 && !portfolioToo && !besideSplit) {
          themeAsk = 'mix';
          marketShareAsk = only.words;
          flags.push('market_share_unclear');
        } else {
          themeAsk = 'sleeves';
          unclear.add('sleeves');
          flags.push('theme_shares_unclear');
        }
      }
    }
  }
  // An answered split that holds a theme is the person's word on what is held: a mix the text states
  // beside it is not applied (a sheet holds one or the other), and that is flagged.
  const sleevesWin =
    sleevesAnswered !== undefined && themeBpsOf(sleevesAnswered) > 0 && !('mix' in answers);
  if (sleevesWin && mixRead) flags.push('mix_dropped_for_sleeves');
  // A holding the person may mean and the text does not state is asked once, by the `mix` question:
  // never dropped, never guessed, and the risk is not asked in its place. That is a mix they only
  // wonder about, a mix said of a part of the money, or a mix the model reads that the text's words
  // cannot confirm (`no_cue:mix`), with that reading as the form's start. Not where something stated
  // is already held or asked. Nor for a model's mix where the text gives a share to a narrative it
  // names ("all of it in AI"): that share is the narrative's, whatever the narrative reads to. Nor
  // where the text rules out the very mix the model read ("I wouldn't put all of it in stocks"). And
  // where the text refuses a class the model's mix holds ("no stocks please"), the question is asked
  // with no start: the form never opens on the opposite of what is written.
  const shareOfANarrative = named.some(
    (m) => !m.wondered && marketShareIn(text, m.at, m.end) !== null,
  );
  const ruledOut = PersonalMix.safeParse(mixSaid?.stance === 'negated' ? mixSaid.mix : null);
  const againstRefusal =
    replyMix !== null &&
    ((replyMix.growthBps > 0 && (refused.has('stock') || refused.has('crypto'))) ||
      (replyMix.goldBps > 0 && refused.has('gold')) ||
      ((replyMix.creditBps ?? 0) > 0 && refused.has('credit')));
  let mixAsk: { read: PersonalMix | null; why: 'wondered' | 'part' | 'model' } | null = null;
  const nothingStated =
    !mixRead &&
    marketMix === null &&
    marketShareAsk === null &&
    themeSleeves === null &&
    themeAsk === null &&
    !shareWaits &&
    !('mix' in answers) &&
    sleevesAnswered === undefined;
  if (nothingStated && mixSaid && (mixSaid.stance === 'wondered' || mixSaid.stance === 'part')) {
    const read = mixSaid.stance === 'wondered' ? PersonalMix.safeParse(mixSaid.mix) : null;
    mixAsk = { read: read?.success ? read.data : null, why: mixSaid.stance };
  } else if (
    nothingStated &&
    replyMix &&
    !shareOfANarrative &&
    !(ruledOut.success && sameMix(replyMix, ruledOut.data))
  )
    mixAsk = { read: againstRefusal ? null : replyMix, why: 'model' };
  if (mixAsk) flags.push(`mix_asked:${mixAsk.why}`);
  // While what is held is open (a theme's share, a sum that waits for the amount, a mix that is asked)
  // or the person has no chain to read a narrative on, neither a mix read beside it nor the risk is
  // settled: the risk is not asked meanwhile, as for a market.
  const heldOpen =
    themeAsk !== null ||
    shareWaits ||
    mixAsk !== null ||
    (input.homeChain === null &&
      named.length > 0 &&
      !mixRead &&
      !('mix' in answers) &&
      !splitWritten &&
      toGrow);
  let mix: PersonalMix | null =
    themeSleeves || sleevesWin
      ? null
      : 'mix' in answers
        ? (answers.mix ?? null)
        : (mixRead ?? marketMix?.mix ?? null);
  // The words a mix is said in: the person's, where the mix held is the one they wrote.
  const mixWords = (m: PersonalMix) =>
    written && mixRead && sameMix(m, mixRead)
      ? written.words
      : marketMix && sameMix(m, marketMix.mix)
        ? marketMix.words
        : mixPhrase(m, language);
  // A goal of income or to protect holds no stocks (gate PROTECT-NO-STOCKS): a mix with stocks on one
  // is asked once, as whether the goal is to grow or the plan holds no stocks. An answered goal that
  // keeps income or protect keeps the goal, and the mix is not held, and said so.
  let mixConflict = false;
  let mixDropped: { words: string; goal: string } | null = null;
  if (mix && mix.growthBps > 0 && (value.goal === 'income' || value.goal === 'protect')) {
    if (answers.goal !== undefined) {
      flags.push('mix_dropped_for_goal');
      mixDropped = { words: mixWords(mix), goal: value.goal };
      mix = null;
    } else {
      flags.push('mix_conflicts_goal');
      mixConflict = true;
      unclear.add('goal');
    }
  }
  const sleeves = mix ? null : (sleevesAnswered ?? themeSleeves ?? draft.sleeves);
  // A split held in themes and a part kept safe has no part at a risk the person picks: its limits
  // follow what it holds, as a mix's do, with the themes' share counted as stocks.
  const themeBps = themeBpsOf(sleeves);
  const heldInThemes = themeBps > 0 && !sleeves?.some((x) => x.kind === 'goal');
  // The risk the person said: an answer, or one the model read that the text has a word for. The
  // rules parser's reading alone is not taken as their word.
  const riskSaid =
    answers.risk ??
    (method === 'model' && draft.risk !== null && riskCuesIn(text).includes(draft.risk)
      ? draft.risk
      : null);
  // With a mix, or a plan held in themes, the risk is never asked: the limits follow what is held.
  // The sheet takes the risk those limits need, which is the one the engine will use, whatever risk
  // the person said, and the read-back says it in one line: where they said another risk, that line
  // says both (below), never in silence. While the goal is asked against the mix, or what is held is
  // open, nothing else about the risk is asked either.
  let limitsFor: { words: string | null; risk: (typeof RISKS)[number] } | null = null;
  if (mix || mixConflict || marketShareAsk !== null || heldInThemes || heldOpen) {
    unclear.delete('risk');
    if (heldInThemes) {
      value.risk = riskForMixEstimate({ growthBps: themeBps });
      flags.push('risk_from_themes');
      limitsFor = { words: null, risk: value.risk };
    } else if (mix && !mixConflict && !heldOpen) {
      value.risk = riskForMixEstimate(mix);
      flags.push('risk_from_mix');
      limitsFor = { words: mixWords(mix), risk: value.risk };
    }
    if (limitsFor && riskSaid !== null && riskSaid !== limitsFor.risk)
      flags.push(`risk_said_not_used:${riskSaid}`);
    // A mix is of the whole plan, so no split is asked beside it, unless the split is what is asked
    // to settle a theme.
    if ((mix && answers.sleeves === undefined && themeAsk !== 'sleeves') || themeSleeves)
      unclear.delete('sleeves');
  }
  const keptSafe = sleeves?.some((x) => x.kind === 'safe_yield') === true && sleeves.length > 1;
  // An answer naming a portfolio is held to the shelf too.
  if (answers.themes) {
    const off = answers.themes.filter((slug) => !portfolios.some((p) => p.slug === slug));
    if (off.length > 0) {
      flags.push('answer_not_on_shelf:themes');
      value.themes = null;
    }
  }

  const needed = (field: QuestionField): boolean => {
    if (
      field in answers &&
      field !== 'chains' &&
      !(field === 'themes' && value.themes === null) &&
      !(field === 'sleeves' && sleevesRefused)
    )
      return false;
    switch (field) {
      case 'goal':
      case 'amountUsd':
        return value[field] === null || unclear.has(field);
      case 'risk':
        return (
          !mixConflict &&
          marketShareAsk === null &&
          !heldOpen &&
          (value[field] === null || unclear.has(field))
        );
      case 'mix':
        return marketShareAsk !== null || mixAsk !== null;
      case 'horizonMonths':
        return !horizonOpen && (value[field] === null || unclear.has(field));
      case 'sleeves':
        return unclear.has(field) || sleevesRefused;
      case 'incomeTargetUsdMonthly':
        return value.goal === 'income' && (value[field] === null || unclear.has(field));
      case 'currency':
        return unclear.has(field);
      case 'themes':
        return unclear.has(field) || (answers.themes !== undefined && value.themes === null);
      case 'chains':
        return input.homeChain === null;
    }
  };

  const templateOf = (field: QuestionField): { id: QuestionId; params: Record<string, Value> } => {
    if (field === 'amountUsd' && otherCurrency)
      return { id: 'amountOtherCurrency', params: { ...otherCurrency } };
    if (field === 'sleeves' && mismatch) return { id: 'sleevesMismatch', params: { ...mismatch } };
    if (field === 'risk' && keptSafe) return { id: 'riskGoalPart', params: {} };
    if (field === 'mix' && marketShareAsk !== null)
      return value.amountUsd !== null
        ? { id: 'marketShare', params: { amount: value.amountUsd, market: marketShareAsk } }
        : { id: 'marketShareNoAmount', params: { market: marketShareAsk } };
    if (field === 'goal' && mixConflict && mix && value.goal)
      return { id: 'goalMixConflict', params: { words: mixWords(mix), goal: value.goal } };
    return { id: field, params: {} };
  };
  // What a question starts from: what was read, and for the `mix` question the mix it is asked about.
  const startOf = (field: QuestionField): IntakeQuestion['read'] =>
    field !== 'mix'
      ? readOf(field, value)
      : marketShareAsk === null
        ? (mixAsk?.read ?? undefined)
        : undefined;
  const questions: IntakeQuestion[] = QUESTION_FIELDS.filter(needed).map((field) =>
    question(field, language, templateOf(field), startOf(field)),
  );

  let sheet: PersonalSheet | null = null;
  if (questions.length === 0 && input.homeChain) {
    const limitsOut = answers.limits ?? limitsOf(limits);
    const candidate = {
      basketType: 'standard' as const,
      goal: value.goal,
      amountUsd: value.amountUsd,
      horizonMonths: value.horizonMonths,
      ...(horizonOpen ? { horizonOpen: true } : {}),
      risk: value.risk,
      themes: value.themes ?? [],
      // No country (gate COUNTRY-REMOVED, Rodrigo, Oct 6): the plan does not read one.
      chains: [input.homeChain],
      ...(value.goal === 'income' && value.incomeTargetUsdMonthly !== null
        ? { incomeTargetUsdMonthly: value.incomeTargetUsdMonthly }
        : {}),
      // Holdings count, as the form starts it. The glide is opt-in (gate GLIDE-OPT-IN, Oct 6): on only
      // when the text asks to take less risk as time passes or names a date the money is needed by.
      rules: answers.rules ?? {
        useHoldings: true,
        glide: !horizonOpen && glideAskedIn(text, nowMonth),
      },
      language,
      ...(value.currency !== null ? { currency: value.currency } : {}),
      ...(answers.obligations ? { obligations: answers.obligations } : {}),
      ...(sleeves ? { sleeves } : {}),
      ...(mix ? { mix } : {}),
      ...(answers.restoreSplit !== undefined ? { restoreSplit: answers.restoreSplit } : {}),
      ...(limitsOut ? { limits: limitsOut } : {}),
    };
    const parsed = PersonalSheet.safeParse(candidate);
    if (parsed.success) sheet = parsed.data;
    else
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        flags.push(`sheet_invalid:${field}`);
        if ((QUESTION_FIELDS as readonly string[]).includes(field)) {
          const f = field as QuestionField;
          if (!questions.some((q) => q.field === f))
            questions.push(question(f, language, templateOf(f), startOf(f)));
        }
      }
  }

  // What was assumed from the person's words, said so they can correct it.
  const assumptions: string[] = [];
  const assume = (id: AssumptionId, params: Record<string, Value> = {}) =>
    assumptions.push(render(ASSUMPTION_TEMPLATES[id][language], params, language));
  // With a mix, or a plan held in themes, the risk is what is held, said once below; loose risk words
  // are not read as it.
  const loose =
    answers.risk === undefined && value.risk !== null && !mix && !heldInThemes
      ? looseRiskWordsIn(text, value.risk)
      : null;
  const goalPart = sleeves?.find((x) => x.kind === 'goal');
  if (loose && value.risk !== null)
    if (keptSafe && goalPart)
      assume('RISK_WORDS_PART', { words: loose, risk: value.risk, share: goalPart.shareBps });
    else assume('RISK_WORDS', { words: loose, risk: value.risk });
  if (horizonOpen && openWords !== null && answers.horizonOpen === undefined)
    assume('OPEN_ENDED', { words: openWords });
  const exit = exits.find((e) => e.months !== limits.mayNeedInMonths);
  if (exit) assume('EXIT_TIME', { words: exit.words });
  if (flags.includes('max_yield_asked')) assume('MAX_YIELD_LATER');
  // What a theme is said by: a curated label's name, or what a filter matched by.
  const themeName = (slug: string): string => {
    const by = filterOfSlug(slug);
    if (by) return matchedName(by.by, matchedValues[slug] ?? by.key, language);
    return labels.find((l) => l.slug === slug)?.name[language] || slug;
  };
  // The limits the plan uses to hold a mix, or the themes it is held in, said in one line: the mix in
  // the person's words, a theme in theirs where the text names it and by its name where an answer
  // does. Where the person said a risk and those limits are another's, the same line says both.
  if (limitsFor) {
    const words =
      limitsFor.words ??
      (sleeves ?? [])
        .flatMap((x) => (x.kind === 'theme' ? [x.theme] : []))
        .map((slug) => themes.find((t) => t.slug === slug)?.words ?? themeName(slug))
        .join(` ${WORDS[language].and} `);
    if (riskSaid !== null && riskSaid !== limitsFor.risk)
      assume('MIX_LIMITS_OTHER_RISK', { said: riskSaid, words, risk: limitsFor.risk });
    else assume('MIX_LIMITS', { words, risk: limitsFor.risk });
  }
  for (const { words } of refusalsNotTaken) assume('REFUSAL_NOT_TAKEN', { words });
  if (mixDropped) assume('MIX_DROPPED', mixDropped);
  if (themesNotHeld && value.goal)
    for (const { words } of themes) assume('MIX_DROPPED', { words, goal: value.goal });
  const chain = input.homeChain;
  if (chain)
    for (const r of [...reads].sort((a, b) => a.at - b.at)) {
      // Matched, not curated: said wherever the plan holds it, or still asks how much of it.
      if (r.kind === 'matched' && r.filter && r.slug && !themesNotHeld) {
        const inPlan = sleeves?.some((x) => x.kind === 'theme' && x.theme === r.slug) === true;
        if (inPlan || themeAsk !== null || shareWaits)
          assume('MARKET_MATCHED', {
            words: r.words,
            chain,
            by: FILTER_BY_WORDS[language][r.filter.by],
            value: r.filter.value,
          });
      }
      // Nothing on the chain for it (gate THEME-NONE-YET): said in one line, with the nearest the
      // shelf has where it has one. Nothing is held for it and nothing is asked of it.
      if (r.kind === 'none') {
        const nearest = (r.id ? NARRATIVES[r.id].nearest : [])
          .map(
            (slug) =>
              portfolios.find((p) => p.slug === slug)?.name ?? usableLabel(slug)?.name[language],
          )
          .find((name) => name);
        if (nearest) assume('MARKET_NEAREST', { words: r.words, chain, nearest });
        else assume('MARKET_NONE', { words: r.words, chain });
      }
    }
  if (sheet && !sheet.rules.glide && !horizonOpen && answers.rules === undefined)
    assume('GLIDE_OFFER');

  // How the person said the time frame (Oct 6): the read-back says it back the same way. The last
  // place the text writes the sheet's months, in years ("about 5 years") or as a date ("by 2031"); in
  // months where it writes months, or where the months are an answer the text does not write.
  const frame = horizonOpen
    ? undefined
    : timeFramesIn(text, nowMonth)
        .filter((t) => t.months === value.horizonMonths)
        .at(-1);
  const term: TermSaid | undefined =
    frame === undefined
      ? undefined
      : frame.said === 'date'
        ? { said: 'date', from: nowMonth }
        : { said: frame.said };
  const said = sheet ? readBack(sheet, portfolios, { labels, matched: matchedValues }, term) : null;
  const narratives: IntakeNarrative[] = [...reads]
    .sort((a, b) => a.at - b.at)
    .map(({ id, words, kind, slug, filter }) => ({
      id,
      words,
      kind,
      slug,
      filter,
      name:
        kind === 'portfolio'
          ? (portfolios.find((p) => p.slug === slug)?.name ?? null)
          : slug
            ? themeName(slug)
            : null,
    }));
  return {
    method,
    language,
    draft,
    limits,
    questions,
    flags,
    disagreements,
    sheet,
    readBack: said ? [...said.slice(0, -1), ...assumptions, ...said.slice(-1)] : null,
    assumptions,
    mix,
    narratives,
  };
}

/** A mix in words, for a mix the person gave as an answer: "70% stocks and crypto and 30% cash". */
function mixPhrase(mix: PersonalMix, language: Language): string {
  const parts = (
    [
      ['growth', mix.growthBps],
      ['dollarYield', mix.dollarYieldBps],
      ['gold', mix.goldBps],
      ['cash', mix.cashBps],
    ] as const
  ).filter(([, bps]) => bps > 0);
  return parts
    .map(([sleeve, bps]) => render('{bps|pct} {sleeve|sleeve}', { bps, sleeve }, language))
    .join(language === 'pt' ? ' e ' : ' and ');
}

function limitsOf(read: LimitsDraft): PersonalLimits | null {
  const out: PersonalLimits = {};
  if (read.mayNeedInMonths !== undefined) out.mayNeedInMonths = read.mayNeedInMonths;
  if (read.creditTolerance) out.creditTolerance = read.creditTolerance;
  if (read.cannotHoldClasses) out.cannotHold = { classes: read.cannotHoldClasses };
  return Object.keys(out).length > 0 ? out : null;
}

type Value = string | number;
type Values = Record<
  Exclude<QuestionField, 'chains' | 'sleeves' | 'mix'>,
  string | number | string[] | null | undefined
>;
function readOf(field: QuestionField, value: Values): IntakeQuestion['read'] {
  if (field === 'chains' || field === 'sleeves' || field === 'mix') return undefined;
  const v = value[field];
  return v === null || v === undefined ? undefined : v;
}

const OPTIONS: Partial<Record<QuestionField, string[]>> = {
  goal: [...BasketSheet.shape.goal.options],
  risk: [...BasketSheet.shape.risk.options],
};

function question(
  field: QuestionField,
  language: Language,
  template: { id: QuestionId; params: Record<string, Value> },
  read: IntakeQuestion['read'],
): IntakeQuestion {
  return {
    field,
    template: template.id,
    text: render(QUESTION_TEMPLATES[template.id][language], template.params, language),
    ...(OPTIONS[field] ? { options: OPTIONS[field] } : {}),
    ...(read !== undefined ? { read } : {}),
  };
}
