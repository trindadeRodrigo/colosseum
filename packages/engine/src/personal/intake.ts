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
  carvedOutAfter,
  classKeptAfter,
  classMentionsIn,
  currenciesIn,
  evenSplitSaidIn,
  exitTimesIn,
  glideAskedIn,
  goalCuesIn,
  horizonsIn,
  looseRiskWordsIn,
  MARKET_IDS,
  type Market,
  type MarketMention,
  type MarketShare,
  marketMentionsIn,
  marketShareIn,
  maxYieldAskedIn,
  mentionsIn,
  mixIn,
  mixSaidInTurns,
  NARRATIVES,
  namesRuledOutIn,
  noneSaidIn,
  openEndedIn,
  otherLanguageIn,
  partSaidIn,
  phraseIn,
  portfolioSaidAt,
  type RefusalSaid,
  type Refused,
  refusalsSaidIn,
  restOfMoneyIn,
  riskCuesIn,
  risksRuledOutIn,
  saysMoreIn,
  shareSaidIn,
  sharesOfMoneyIn,
  splitIn,
  stanceOf,
  sumsWrittenIn,
  TURN_BREAK,
  timeFramesIn,
  withoutMarketShares,
  wordsWrite,
  yesOrNoSaidIn,
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
  CLASS_WORDS,
  CREDIT_WORDS,
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
  type RiskLevel,
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
// A list of the ways a clause turns a holding down cannot be finished (the review of Oct 7: most of
// its new sentences were still read as stated). So the rule is not the list:
//   - With a model, a holding needs both readers. A mix, a narrative or a share of the money for one
//     is taken with no question only where the model's reply reads it and the text check confirms it.
//     Words the text check finds that the model did not read are not taken, not asked and not said
//     (`text_only:mix`, `text_only:market:<id>`): the model decides whether something was named, the
//     code whether that may be taken.
//   - With no model, a holding read from the text is asked once, its reading the start, never taken.
//     A question has a way out ("none"), and does not come back once answered.
//   - The last word wins: across the messages, what a later one says of a narrative, of a class of a
//     mix or of a refusal decides over an earlier one.
//   - A refusal the text states is taken, with or without a model. One the model did not read is
//     said in a line of its own, and a refusal and a holding of the same class are asked, never both
//     in one sheet.
//   - A share is taken only in its plain forms, and a filter is never used to pick one stock.
//
// With no model (none configured, down, out of budget) the rules parser fills the draft and the same
// questions are asked. Nothing fails.

/** The fields the intake can ask about, in the order it asks. */
export const QUESTION_FIELDS = [
  'goal',
  'amountUsd',
  'sleeves',
  'mix',
  'limits',
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
  /**
   * The risk whose limits a mix takes, for the read-back (gate EXPLICIT-MIX). A caller with the shelf
   * passes the engine's exact rule (`riskForMix`); left out, `riskForMixEstimate` on the issuer caps.
   * The engine's rule depends on the amount, so the intake hands in the sheet's own amount where it
   * knows it (Oct 7).
   */
  riskOfMix?: (mix: PersonalMix, themes: string[], amountUsd?: number) => RiskLevel;
  /** The curated stock labels on the person's chain (gate THEMES). Left out: none. */
  labels?: ShelfLabel[];
  /**
   * What a filter matches among the stocks the shelf lists on the person's chain: pure code over the
   * sourced attributes, passed by a caller that has them. Left out, or null: nothing matches.
   */
  matchOf?: (filter: MarketFilter) => FilterMatch | null;
  /**
   * The risk whose limits a sheet held in themes takes, for the read-back (the review of Oct 7). A
   * caller with the shelf passes the engine's exact rule for the sleeves and the shared portfolios
   * read; left out, the estimate on the issuer caps, the themes' share counted as stocks. As for a
   * mix, the intake hands in the sheet's own amount where it knows it.
   */
  riskOfSleeves?: (sleeves: PlanSleeve[], themes: string[], amountUsd?: number) => RiskLevel;
  /**
   * False when the caller could not read what the person's chain lists (the chain is off, its adapter
   * failed). A narrative is then left unresolved, as with no chain (flags `market_unresolved:`):
   * nothing is said of what the chain has, no sentence says it has no stock, and no sheet is made
   * from a goal that names one. Left out: true.
   */
  shelfKnown?: boolean;
  /**
   * The companies the person's chain lists, each by its name, its ticker and its token's symbol
   * (`companyNamesOf` over the sourced attributes). A name the person rules out of a list the plan
   * holds ("invest in AI but no Tesla") is said back as not applied only where it is one of these
   * (the third review, Oct 7: "No IRA" and "not in January" were said back as a company). Left out:
   * none is known, and no such line is said. The model never sees this list.
   */
  names?: readonly string[];
  /**
   * The form's answers as they stood when each of the last messages was sent, the last entry for
   * the last message (the third review, Oct 7). A plain yes or no names no question: it is applied
   * only to the question that was the one open when it was said, and what was open then depends on
   * what the form had answered then, not on what it answers now ("Put 30% in big tech.", "no" with
   * four questions open, and the form filled in afterwards, left big tech out for good). For a
   * message with no entry the form is counted as empty: a yes or no then answers only a question
   * that was the one open whatever the form says.
   */
  answersThen?: readonly IntakeAnswers[];
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

/**
 * What a stated refusal of a class leaves out with it. Stocks: the funds of stocks too. The product
 * holds a fund of stocks as a stock token (gate PROTECT-NO-STOCKS; in the registry `stock` and `etf`
 * are held by the same goals, and every `etf` on the shelf is a stock index fund), so a person who
 * says "no stocks" means none through a fund either. Not the other way: "no ETFs" leaves single
 * stocks to hold.
 */
const LEFT_OUT_WITH: Partial<Record<Refused, HoldableClass[]>> = { stock: ['etf'] };

const BPS_PER_PCT = WHOLE_MIX_BPS / 100;
// The words right after a share that say it is kept safe: "80% safe and liquid", "keep 30% in cash",
// "80% seguro e líquido". Nothing else after a percent is a part kept safe ("80% high risk").
const KEPT_SAFE_AFTER =
  /^\s+(?:(?:kept|held|in|em)\s+)?(?:safe(?:ly)?|secure|liquid|cash|segur[oa]s?|seguran[cç]a|l[ií]quid[oa]s?|caixa)(?:\s+(?:and|e)\s+(?:safe|secure|liquid|segur[oa]s?|l[ií]quid[oa]s?))?(?![\p{L}])/iu;
// What may stand between two shares of one plain pair: marks, and the words that join or lead in.
const JOINS_SHARES =
  /^[\s,.;:]*(?:(?:and|e|plus|mais|then|with|com|keep|leave|put|invest|place|manter|mantenha|deixar|deixe|colocar|coloque|investir|invista|the|other|a|o|os|as|outros)(?![\p{L}])[\s,]*)*$/iu;

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

/**
 * The least share of the plan a holding can be, in basis points (the review of Oct 7: "$20" for AI
 * in a plan of $5,000 gave a sheet with 0.4% in it, which no line of a plan can be): the table's
 * floor for a line, and its floor in dollars over the amount where the amount is known. A share
 * under it is no share a plan can hold: it is not taken, and how much is asked again.
 */
const leastShareBps = (
  amountUsd: number | null,
  params: Pick<PersonalParameters, 'minLineBps' | 'minLineUsd'> = PERSONAL_PARAMS,
): number =>
  Math.max(
    params.minLineBps,
    // The basis point nearest the floor in dollars: the share "$5" itself comes to, so the least a
    // person is told ("$5") is a share that is taken when they say it (the third review, Oct 7:
    // rounded up, the line said $5.01 and $5.04 where the floor is $5).
    amountUsd ? Math.round((params.minLineUsd / amountUsd) * WHOLE_MIX_BPS) : 0,
  );

/** The least a holding can be in dollars, for a plan of this amount: what `SHARE_TOO_SMALL` says. */
const leastShareUsd = (
  amountUsd: number,
  params: Pick<PersonalParameters, 'minLineBps' | 'minLineUsd'> = PERSONAL_PARAMS,
): number => Math.max(params.minLineUsd, (params.minLineBps / WHOLE_MIX_BPS) * amountUsd);

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
): PersonalMix | 'too_small' | null {
  const stated = mixIn(message);
  const share = stated ? null : shareSaidIn(message);
  const ofAMarket = asked.template !== 'mix';
  let growthBps: number | null = null;
  if (share?.kind === 'pair') growthBps = share.first * BPS_PER_PCT;
  // "A third" is a third of the whole, to the nearest basis point.
  if (share?.kind === 'percent') growthBps = Math.round(share.value * BPS_PER_PCT);
  // "All of it" and a sum answer "how much for it", and say nothing of how the whole is held.
  if (share?.kind === 'whole' && ofAMarket) growthBps = WHOLE_MIX_BPS;
  if (share?.kind === 'amount' && ofAMarket) growthBps = bpsOf(share, amountUsd);
  // A share for it that no line of a plan can be is no answer: the question stays.
  if (ofAMarket && growthBps !== null && growthBps > 0 && growthBps < leastShareBps(amountUsd))
    return 'too_small';
  const mix =
    stated?.mix ??
    (growthBps === null
      ? null
      : { growthBps, dollarYieldBps: 0, goldBps: 0, cashBps: WHOLE_MIX_BPS - growthBps });
  const parsed = PersonalMix.safeParse(mix);
  return mix !== null && parsed.success ? parsed.data : null;
}

/**
 * The share a message says where it writes one figure, a percent or a sum of money, or one part of
 * the whole in words, and nothing else about money or holdings, whatever words lead into it ("Make
 * that 40%.", "Actually, $1,000", "Hmm, make it half."). Null where it writes none, or more.
 */
function loneShareIn(message: string, amountUsd: number | null): PersonalMix | null {
  const figures = mentionsIn(message);
  const [figure] = figures;
  if (figures.length > 1) return null;
  // With no figure, one part of the whole said in words: "Hmm, make it half.", "No wait, a third.".
  const part = figure ? null : partSaidIn(message);
  if (!figure && part === null) return null;
  if (
    figure &&
    figure.kind !== 'percent' &&
    !(figure.kind === 'amount' && figure.money && !figure.perMonth)
  )
    return null;
  const own = figure ?? part;
  if (saysMoreIn(message, 0, message.length, own ? [own] : [], null, false)) return null;
  const growthBps = !figure
    ? Math.round((part?.value ?? 0) * BPS_PER_PCT)
    : figure.kind === 'percent'
      ? Math.round(figure.value * BPS_PER_PCT)
      : bpsOf({ kind: 'amount', value: figure.value }, amountUsd);
  if (growthBps === null || growthBps < leastShareBps(amountUsd)) return null;
  const parsed = PersonalMix.safeParse({
    growthBps,
    dollarYieldBps: 0,
    goldBps: 0,
    cashBps: WHOLE_MIX_BPS - growthBps,
  });
  return parsed.success ? parsed.data : null;
}

/** What the person's later messages said in words, read as answers to the questions before them. */
type Heard = {
  /**
   * How each was read: `mix_from_words`, `sleeves_from_words`, `none_from_words`, `mix_confirmed`
   * (a plain yes to a question's start); and `share_too_small` for a share that was not taken
   * because no line of a plan can be that small.
   */
  flags: string[];
  /**
   * The narratives a message answered "none" for, by id (`marketFilter` for the model's): left out
   * until a later message asks for one again (the third review, Oct 7).
   */
  leftOut: string[];
  /**
   * The answers to the question that asks whether to leave something out (`limits`): the classes it
   * asked of, and whether the person said yes.
   */
  refusals: { classes: Refused[]; taken: boolean }[];
  /**
   * The answers to the question that asks of a shared portfolio by its name (`themes`, template
   * `startFrom`): its slug, and whether the person said yes. Taken back where a later message
   * writes the portfolio's name again: it is then read anew, as written.
   */
  portfolios: { slug: string; taken: boolean }[];
  /**
   * Set where a later message brought a holding up again after its question was answered, or said a
   * share of a holding that stands: the share is asked once more and not taken, with `start` as the
   * question's start where the message gave one. Cleared by the answer.
   */
  reask: { start: PersonalMix | null } | null;
  /**
   * The messages that were read as an answer to a question, by their place in the conversation. An
   * answer says nothing beside the question it answered: where that question is asked again, its
   * words are no split of the plan ("half", said of AI, is not "half and half").
   */
  answered: number[];
};

/** The flags of an answer given in words, taken back with it where a later message reopens it. */
const ANSWERED_IN_WORDS = ['mix_from_words', 'mix_confirmed', 'sleeves_from_words'];

/** What a turn leaves open that the next message can answer in words. */
type Open = {
  /** The narratives the `mix` question asks a share of the money for. None: it asks of the mix. */
  shareOf: { key: string; words: string }[];
  /** The themes the `sleeves` question asks a share for each of, in the order written. */
  themes: { keys: string[]; slug: string; words: string }[];
  /** What the `limits` question asks whether to leave out: a refusal one reader read alone. */
  refusal: Refused[];
  /** The shared portfolios the `themes` question asks of by name: one a reader read alone. */
  startFrom: string[];
  /** The narratives a share of the money is held for, where nothing is asked. */
  held: { key: string; words: string }[];
};

/**
 * The split a message says in answer to the question that names several themes ("How do you want to
 * split the money between AI and semiconductors?"): an even one ("half each", "50-50", "equally"), a
 * pair in the order asked ("60/40"), or a share for each by its name that come to the whole ("60% in
 * AI and 40% in semiconductors", "all of it in AI", which leaves the other out). Null where the
 * message says none of these: nothing is filled in.
 */
function sharesAnswered(
  message: string,
  themes: Open['themes'],
  amountUsd: number | null,
): PlanSleeve[] | null {
  const sleevesOf = (bps: (number | null)[]): PlanSleeve[] | null => {
    const sleeves = themes.flatMap((t, i): PlanSleeve[] => {
      const shareBps = bps[i] ?? null;
      return shareBps === null ? [] : [{ kind: 'theme', theme: t.slug, shareBps }];
    });
    const whole = sleeves.reduce((n, x) => n + x.shareBps, 0) === WHOLE_MIX_BPS;
    const least = leastShareBps(amountUsd);
    const held = sleeves.every((x) => x.shareBps >= least);
    return whole && held && PlanSleeves.safeParse(sleeves).success ? sleeves : null;
  };
  if (evenSplitSaidIn(message)) {
    const each = Math.floor(WHOLE_MIX_BPS / themes.length);
    const left = WHOLE_MIX_BPS - each * themes.length;
    return sleevesOf(themes.map((_, i) => (i === 0 ? each + left : each)));
  }
  const said = shareSaidIn(message);
  const [, second] = themes;
  if (said?.kind === 'pair' && second && themes.length === 1 + 1)
    return sleevesOf([said.first * BPS_PER_PCT, said.second * BPS_PER_PCT]);
  // Each by its name: the fixed words of its narrative, or the person's own words for it.
  const mentions = marketMentionsIn(message).filter((m) => m.skipped === null && !m.wondered);
  const shares = themes.map((t): MarketShare => {
    const spans = [
      ...mentions.filter((m) => t.keys.includes(m.market)),
      ...phraseIn(message, t.words),
    ];
    return (
      spans
        .map((m) => marketShareIn(message, m.at, m.end))
        .filter((x) => x !== null)
        .at(-1) ?? null
    );
  });
  return sleevesOf(shares.map((share) => (share === null ? null : bpsOf(share, amountUsd))));
}

/**
 * The draft, the questions, and the sheet with its read-back once nothing is left to ask.
 *
 * The person's later messages are read with the first (`conversationText` joins them with a blank
 * line), by the same reader and the same checks, and the last word wins: what a later message says of
 * a narrative, of a mix or of a refusal decides over an earlier one. A reply of a few words ("70-30",
 * "half", "all of it", "none", "half each") names no market and no question: read with the rest it
 * was lost, or taken for a split of its own. So each message after the first is also read as the
 * answer to the question about what is held that the messages before it left open, as an answer on
 * the form is:
 *   - a share or a mix answers the `mix` question (flag `mix_from_words`);
 *   - "none" ("zero", "0%", "nothing for AI") answers it too: what was asked about is left out for
 *     good, and the question does not come back (`none_from_words`);
 *   - a plain yes ("yes", "that's right", "sim", "isso") takes the question's start, the share the
 *     text states, where it has one (`mix_confirmed`), and a plain no leaves out what was asked
 *     about; both only where it is the one question asked;
 *   - "half each", "60/40" or a share for each by name answers the question that names several
 *     themes (`sleeves_from_words`).
 * An answer on the form wins. A `mix` question that is there only because the model read a mix is
 * not counted: the reply at hand is the model's reading of the whole conversation, this message
 * included, so that question may never have been asked.
 */
export function runIntake(input: IntakeInput): IntakeResult {
  const blocks = input.text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  // Only the last few messages are read this way: a long text in many paragraphs is one message.
  const first = Math.max(0, blocks.length - INTAKE_LIMITS.turnsRead);
  const turns = [blocks.slice(0, first + 1).join(TURN_BREAK), ...blocks.slice(first + 1)];
  // The form's answers stand. What a message answers in words is kept apart, with what it settled:
  // the last word wins over such an answer (the third review, Oct 7).
  const form = input.answers ?? {};
  const words: { mix?: PersonalMix | null; sleeves?: PlanSleeve[] } = {};
  let answers: IntakeAnswers = form;
  /** The narratives the standing answer to the `mix` question was about; none: the mix itself. */
  let settled: string[] | null = null;
  const heard: Heard = {
    flags: [],
    leftOut: [],
    refusals: [],
    portfolios: [],
    reask: null,
    answered: [],
  };
  const say = (answer: typeof words, of: string[] | null = settled) => {
    heard.answered.push(turnNow);
    Object.assign(words, answer);
    answers = { ...form, ...words };
    settled = of;
    heard.reask = null;
  };
  const reopen = (start: PersonalMix | null = null) => {
    delete words.mix;
    delete words.sleeves;
    answers = { ...form, ...words };
    settled = null;
    heard.reask = { start };
    heard.flags = heard.flags.filter((flag) => !ANSWERED_IN_WORDS.includes(flag));
    heard.flags.push('answer_reopened');
  };
  const portfolioNames = input.portfolios.map((p) => p.name);
  let turnNow = 0;
  /**
   * Whether the question of `field` was the one question open when message `n` was sent, with the
   * form as it stood then (`answersThen`; empty where the caller does not say). A plain yes or no
   * answers no other.
   */
  const onlyOpenThen = (n: number, field: QuestionField, now: IntakeResult): boolean => {
    if (now.questions.length !== 1 || now.questions[0]?.field !== field) return false;
    const then = input.answersThen?.[input.answersThen.length - (turns.length - n)] ?? {};
    if (JSON.stringify(then) === JSON.stringify(form)) return true;
    const asked = intakeOf(input, turns.slice(0, n), { ...then, ...words }, heard).result.questions;
    return asked.length === 1 && asked[0]?.field === field;
  };
  for (let n = 1; n < turns.length; n += 1) {
    turnNow = n;
    const message = turns[n] ?? '';
    // An answer closes its question until a later message names that holding again, states a mix
    // or a share for it, or refuses its class: then the question is open again, and is asked once
    // more with the new reading as its start. The message is no answer to the question it reopens.
    const mentioned = marketMentionsIn(message, portfolioNames);
    const asksFor = mentioned.filter((m) => m.skipped === null).map((m) => m.market as string);
    const mixNow = mixSaidInTurns([message]) !== null;
    const refusedNow = refusalsSaidIn(message)
      .filter((r) => r.stance === 'stated')
      .map((r) => r.what);
    const answeredMix = words.mix;
    const holds: Refused[] = answeredMix
      ? [
          ...(answeredMix.growthBps > 0 ? (['stock', 'etf', 'crypto'] as const) : []),
          ...(answeredMix.goldBps > 0 ? (['gold'] as const) : []),
          ...((answeredMix.creditBps ?? 0) > 0 ? (['credit'] as const) : []),
        ]
      : [];
    // Asked of narratives, the answer is reopened by any narrative named after it: the same one
    // said again, or another, with which the holdings are no longer the ones it answered for.
    const about: string[] = settled ?? [];
    const broughtUp =
      ('mix' in words && (mentioned.length > 0 || (about.length === 0 && mixNow))) ||
      ('mix' in words && refusedNow.some((what) => holds.includes(what))) ||
      (words.sleeves !== undefined &&
        (mentioned.length > 0 || mixNow || refusedNow.some((c) => c === 'stock' || c === 'etf')));
    // A narrative answered "none" for and then asked for again is no longer left out.
    const back = heard.leftOut.filter((key) => asksFor.includes(key));
    if (back.length > 0) heard.leftOut = heard.leftOut.filter((key) => !back.includes(key));
    if (broughtUp || back.length > 0) {
      reopen();
      continue;
    }
    // An answer to the question that asks of a shared portfolio by its name stands until a later
    // message writes that portfolio's name again: then it is read anew, as written.
    heard.portfolios = heard.portfolios.filter((answer) => {
      const p = input.portfolios.find((x) => x.slug === answer.slug);
      return ![p?.name, p?.slug].some((w) => w !== undefined && phraseIn(message, w).length > 0);
    });
    const before = intakeOf(input, turns.slice(0, n), answers, heard);
    const amountUsd = answers.amountUsd ?? before.result.draft.amountUsd;
    const asked = before.result.questions.find((q) => q.field === 'mix');
    if (asked && !('mix' in answers) && !before.result.flags.includes('mix_asked:model')) {
      const of = before.open.shareOf;
      if (
        noneSaidIn(
          message,
          of.map((x) => x.words),
        )
      ) {
        // "None" of the money for what was asked about leaves it out; asked of the mix, no mix.
        if (of.length > 0) heard.leftOut.push(...of.map((x) => x.key));
        else say({ mix: null }, []);
        heard.reask = null;
        heard.answered.push(n);
        heard.flags.push('none_from_words');
        continue;
      }
      const mix = mixAnswered(message, asked, amountUsd);
      if (mix === 'too_small') {
        heard.flags.push('share_too_small');
        continue;
      }
      if (mix) {
        say(
          { mix },
          of.map((x) => x.key),
        );
        heard.flags.push('mix_from_words');
        continue;
      }
      // A plain yes or no says no share of its own. It answers this question only where it is the
      // one question asked (with another open, nothing says which the word answers), and not the
      // one that asks which of two things stands. A yes takes the question's start, the share the
      // text states (`mix_confirmed`); with no start it is no answer. A no leaves out what was asked
      // about, as "none" does.
      const yesOrNo = yesOrNoSaidIn(message);
      const said = yesOrNo !== null && onlyOpenThen(n, 'mix', before.result) ? yesOrNo : null;
      const start = PersonalMix.safeParse(asked.read);
      if (said !== null && asked.template !== 'holdOrLeaveOut') {
        if (said === 'yes' && start.success) {
          say(
            { mix: start.data },
            of.map((x) => x.key),
          );
          heard.flags.push('mix_confirmed');
          continue;
        }
        if (said === 'no' && (of.length > 0 || start.success)) {
          if (of.length > 0) heard.leftOut.push(...of.map((x) => x.key));
          else say({ mix: null }, []);
          heard.reask = null;
          heard.flags.push('none_from_words');
          continue;
        }
      }
    }
    // A share said of nothing ("Make that 40%.", "Make it $1,000.") where nothing is asked and one
    // holding stands is a new share for it: asked once, with it as the start, never taken and
    // never passed over.
    if (
      before.result.questions.length === 0 &&
      before.open.held.length === 1 &&
      mentioned.length === 0 &&
      !mixNow &&
      refusedNow.length === 0 &&
      yesOrNoSaidIn(message) === null
    ) {
      // "None" said of the one holding that stands is its last word too: asked, with no start.
      if (noneSaidIn(message)) {
        reopen();
        continue;
      }
      const again =
        mixAnswered(message, { field: 'mix', template: 'marketShare', text: '' }, amountUsd) ??
        loneShareIn(message, amountUsd);
      // The same share said again is no new share: nothing is asked of it.
      const standing =
        before.result.sheet?.mix?.growthBps ?? themeBpsOf(before.result.sheet?.sleeves);
      if (again && again !== 'too_small' && again.growthBps !== standing) {
        reopen(again);
        continue;
      }
    }
    // The question that asks whether to leave something out (a refusal one reader read alone) is
    // answered by a plain yes or no, where it is the one question asked.
    const doubted = before.open.refusal;
    if (doubted.length > 0 && before.result.questions.length === 1) {
      const said = yesOrNoSaidIn(message);
      if (said !== null && onlyOpenThen(n, 'limits', before.result)) {
        heard.refusals.push({ classes: doubted, taken: said === 'yes' });
        continue;
      }
    }
    // The question that asks of a shared portfolio by its name ("Do you want to start from the
    // shared portfolio The Seven?") is answered by a plain yes or no too, where it is the one
    // question asked: a yes takes its start, a no leaves the portfolio out.
    const startFrom = before.open.startFrom;
    if (startFrom.length > 0 && before.result.questions.length === 1) {
      const said = yesOrNoSaidIn(message);
      if (said !== null && onlyOpenThen(n, 'themes', before.result)) {
        heard.portfolios.push(...startFrom.map((slug) => ({ slug, taken: said === 'yes' })));
        heard.answered.push(n);
        continue;
      }
    }
    const themes = before.open.themes;
    if (themes.length > 0 && !('sleeves' in answers)) {
      if (noneSaidIn(message)) {
        heard.leftOut.push(...themes.flatMap((t) => t.keys));
        heard.flags.push('none_from_words');
        continue;
      }
      const none = themes.filter((t) => noneSaidIn(message, [t.words]));
      if (none.length > 0) {
        heard.leftOut.push(...none.flatMap((t) => t.keys));
        heard.flags.push('none_from_words');
        continue;
      }
      const sleeves = sharesAnswered(message, themes, amountUsd);
      if (sleeves) {
        say({ sleeves });
        heard.flags.push('sleeves_from_words');
      }
    }
  }
  return intakeOf(input, turns, answers, heard).result;
}

/**
 * The intake of a conversation, message by message, with the answers the person gave on the form or
 * in words, and what the next message can answer in words.
 */
function intakeOf(
  input: IntakeInput,
  turns: readonly string[],
  answers: IntakeAnswers,
  heard: Heard,
): { result: IntakeResult; open: Open } {
  const { nowMonth, portfolios } = input;
  const text = turns.join(TURN_BREAK);
  // Where each message starts in the text, and which message a place in it is written in.
  const starts: number[] = [];
  let offset = 0;
  for (const turn of turns) {
    starts.push(offset);
    offset += turn.length + TURN_BREAK.length;
  }
  const turnOf = (at: number): number => {
    let found = 0;
    for (const [t, start] of starts.entries()) if (start <= at) found = t;
    return found;
  };
  // Before the first message: no message says it.
  const NO_TURN = -1;
  const flags: string[] = [...new Set(heard.flags)];
  const unclear = new Set<QuestionField>();
  const rules = draftFromRules(text, nowMonth, input.language).draft;
  const draft: BasketSheetDraft = { ...EMPTY_DRAFT };
  const limits: LimitsDraft = { creditTolerance: null, cannotHoldClasses: null };
  // A value the text holds in another currency than dollars, to name in the question.
  let otherCurrency: { amount: number; currency: string } | null = null;
  const disagreements: Disagreement[] = [];
  const method = input.reply === null ? 'rules' : 'model';
  // Whether the caller could read what the person's chain lists; where it could not, nothing is
  // resolved on it, as with no chain.
  const shelfKnown = input.shelfKnown !== false;
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
  // The shared portfolios one reader reads alone, by slug: asked once ("Do you want to start from
  // the shared portfolio The Seven?"), with them as the question's start.
  const startAsked: string[] = [];

  if (input.reply === null) {
    Object.assign(draft, rules);
    // A risk the text writes only under a negation ("I can't take high risk") is not the person's:
    // the rules parser's reading of it is no start for the question.
    if (rules.risk !== null && risksRuledOutIn(text).includes(rules.risk)) {
      flags.push(`risk_negated:${rules.risk}`);
      rules.risk = null;
      draft.risk = null;
    }
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
    // A shared portfolio's name said as a holding ("Start me off from The Seven.") was never read
    // with no model (the third review, Oct 7). The text check is then the one reader: it is asked
    // once, with it as the start, as a mix is, and never taken.
    for (const p of portfolios) {
      const said = [p.name, p.slug]
        .flatMap((words) => phraseIn(text, words))
        .map((m) => portfolioSaidAt(text, m.at, m.end, m.words === p.name || m.words === p.slug));
      // One the person only wonders about is asked by the portfolio question, as with a model.
      if (!said.includes('held')) {
        if (said.includes('wondered')) {
          flags.push('portfolio_wondered');
          unclear.add('themes');
        }
        continue;
      }
      flags.push('from_rules:themes');
      const answer = heard.portfolios.filter((x) => x.slug === p.slug).at(-1);
      if (answer?.taken) {
        flags.push('portfolio_confirmed');
        namedPortfolios.push(p.name);
        draft.themes = [...(draft.themes ?? []), p.slug];
      } else if (answer) flags.push('portfolio_left_out');
      else {
        unclear.add('themes');
        startAsked.push(p.slug);
      }
    }
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
              : where === 'not_a_sum'
                ? `not_a_sum:${field}`
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
    //
    // Where the text writes more than one (the review of Oct 7: "over 5 years ... and in 2 years I
    // buy a car" gave a plan of 2 years), the last word wins: the last message that writes a time
    // frame decides. One that writes several, or a reply that gives another message's, is no reading
    // of one time frame: the date is asked once.
    const horizons = horizonsIn(text, nowMonth);
    const lastWritten = turns
      .map((turn) => horizonsIn(turn, nowMonth))
      .filter((written) => written.length > 0)
      .at(-1);
    if (r.horizonMonths !== null) {
      if (horizons.includes(r.horizonMonths)) {
        const [last, ...more] = lastWritten ?? [];
        if (more.length > 0) {
          // Several in one message: nothing says which is the plan's, so the question has no start.
          flags.push('horizon_several');
          unclear.add('horizonMonths');
        } else if (last !== undefined && last !== r.horizonMonths) {
          // The reply gives an earlier message's: the last one written is the start.
          flags.push('horizon_not_last');
          unclear.add('horizonMonths');
          draft.horizonMonths = last;
        } else draft.horizonMonths = r.horizonMonths;
      } else if (exits.some((e) => e.months === r.horizonMonths))
        flags.push('exit_time_not_horizon');
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
    // A share is one in its plain forms: "I can lose 30% and I am 70% sure" writes no split.
    if (r.sleeves !== null) {
      const written = new Set([...split.ofMoney, ...split.pairs.flat()]);
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
    //
    // And its name must be said as a holding, as a narrative's words must (the review of Oct 7: "the
    // seven of us are saving" started a plan from The Seven). One its clause rules out or says of
    // something else is dropped and flagged (`portfolio_negated`, `portfolio_aside`); one the person
    // only wonders about is asked; words that nothing says name the portfolio are not read
    // (`no_cue:portfolios`).
    if (r.portfolios !== null && r.portfolios.length > 0) {
      const saidAs = (name: string) => {
        const onShelf = portfolios.find((p) => p.slug === portfolioSlug(name, portfolios));
        const said = [name, onShelf?.name, onShelf?.slug]
          .flatMap((words) => (words === undefined ? [] : phraseIn(text, words)))
          .map((m) =>
            portfolioSaidAt(
              text,
              m.at,
              m.end,
              m.words === (onShelf?.name ?? name) || m.words === onShelf?.slug,
            ),
          );
        return (
          (['held', 'wondered', 'negated', 'aside', 'unsure'] as const).find((how) =>
            said.includes(how),
          ) ?? null
        );
      };
      const said = r.portfolios.map((name) => ({ name, how: saidAs(name) }));
      namedPortfolios = said.flatMap((p) => (p.how === 'held' ? [p.name] : []));
      for (const { name, how } of said) {
        const slug = portfolioSlug(name, portfolios);
        if (how === null) flags.push('no_cue:portfolios');
        else if (how === 'wondered') {
          flags.push('portfolio_wondered');
          unclear.add('themes');
        } else if (how === 'unsure') {
          // No reader decides alone (the third review, Oct 7: "My pick is the seven." was dropped
          // with a flag). The reply names it and the text writes its words with nothing that says
          // they name the portfolio: asked once, with it as the start, never taken and never
          // dropped. One the shelf does not hold cannot be held, and is not asked about.
          flags.push('no_cue:portfolios');
          const answer = heard.portfolios.filter((x) => x.slug === slug).at(-1);
          if (slug === null) continue;
          if (answer?.taken) {
            // The person's yes is the second reader: held from here on as one the text states.
            flags.push('portfolio_confirmed');
            namedPortfolios.push(name);
          } else if (answer) flags.push('portfolio_left_out');
          else {
            flags.push('portfolio_asked');
            unclear.add('themes');
            if (!startAsked.includes(slug)) startAsked.push(slug);
          }
        } else if (how !== 'held') flags.push(`portfolio_${how}`);
      }
      const slugs = namedPortfolios.map((name) => portfolioSlug(name, portfolios));
      const found = [...new Set(slugs.filter((s): s is string => s !== null))];
      // Where the shelf could not be read, a name it does not show is not said to be off it.
      if (found.length < slugs.length && shelfKnown) {
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
    // One the text writes only under a negation ("I can't take high risk") is the opposite of what
    // is written (the review of Oct 7): it is asked with no start.
    if (draft.risk !== null && !riskCuesIn(text).includes(draft.risk)) {
      if (risksRuledOutIn(text).includes(draft.risk)) {
        flags.push(`risk_negated:${draft.risk}`);
        draft.risk = null;
      } else flags.push('no_cue:risk');
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
  // a refusal that is lost gives the person what they refused. One its clause states becomes the
  // sheet's limits, and the read-back says it back for the person to confirm: it is taken, not asked.
  // One its clause negates ("I can't do without stocks"), says of something else ("my brother holds
  // no stocks") or only wonders about ("no stocks? not sure") is not taken (`refusal_<how>:<what>`).
  // The model's reply is a check, both ways: what it gives that the text does not write is dropped
  // (`not_in_text:`), and what the text states that it missed is taken all the same
  // (`disagrees_with_rules:`), and said in a line of its own that names the person's words.
  //
  // The last word wins (the review of Oct 7). A later message that names the class as something to
  // hold, or as no problem ("No stocks." then "I changed my mind, stocks are fine"), takes the
  // refusal back (`refusal_withdrawn:<what>`), and that is said, never done in silence. With a model
  // both readers must agree it was taken back: a refusal the model still reads stands.
  const refusals = refusalsSaidIn(text);
  const classNamed = classMentionsIn(text);
  const statedOf = (what: Refused) =>
    refusals.filter((r) => r.what === what && r.stance === 'stated');
  /** The last message that states a refusal of the class; `NO_TURN` where none does. */
  const refusedIn = (what: Refused): number =>
    Math.max(NO_TURN, ...statedOf(what).map((r) => turnOf(r.at)));
  /** Whether a place the text names the class says it as something to hold, or as no problem. */
  const allows = (m: { what: Refused; at: number; end: number }): boolean => {
    const within = refusals.find((r) => r.what === m.what && r.at <= m.at && m.end <= r.end);
    return within ? within.stance === 'negated' : stanceOf(text, m.at, m.end) === 'stated';
  };
  /**
   * Whether a place the text names a class, after a refusal that ends at `from`, holds the class:
   * its own clause must say so, since a class the refusal's clause only goes on to name carries the
   * refusal on ("no stocks, including ETFs").
   */
  const keeps = (m: { what: Refused; at: number; end: number }, from: number): boolean => {
    const within = refusals.find((r) => r.what === m.what && r.at <= m.at && m.end <= r.end);
    return within ? within.stance === 'negated' : classKeptAfter(text, from, m.at, m.end);
  };
  /** The last message that says the class may be held; `NO_TURN` where none does. */
  const allowedIn = (what: Refused): number =>
    Math.max(
      NO_TURN,
      ...classNamed.filter((m) => m.what === what && allows(m)).map((m) => turnOf(m.at)),
    );
  const stated = [...new Set(refusals.filter((x) => x.stance === 'stated').map((x) => x.what))];
  const takenBack = (what: Refused) =>
    allowedIn(what) > refusedIn(what) && !(method === 'model' && replyRefused.includes(what));
  const refused = new Set(stated.filter((what) => !takenBack(what)));
  // Written as the person's refusal, and not taken: said back with the read-back, so that nothing a
  // reader took for a refusal is dropped in silence.
  const refusalsNotTaken: RefusalSaid[] = [];
  /** A refusal the text states that is not applied: a later word, or an answer, holds the class. */
  const withdraw = (what: Refused) => {
    const last = statedOf(what).at(-1);
    refused.delete(what);
    flags.push(`refusal_withdrawn:${what}`);
    if (last && !refusalsNotTaken.includes(last)) refusalsNotTaken.push(last);
  };
  // With no model one reader alone would take a refusal back on a later mention of its class
  // ("No stocks." then "Remember, stocks are out."): it is asked instead (`limits`), where a yes
  // keeps it and a no takes it back, said in a line.
  const takeBackAsked: Refused[] = [];
  for (const what of stated) {
    if (!takenBack(what)) continue;
    const answer = heard.refusals.filter((r) => r.classes.includes(what)).at(-1);
    // An answer that says what is held settles it, as the form's own limits do.
    const settledByAnswer =
      answers.limits !== undefined || 'mix' in answers || answers.sleeves !== undefined;
    if (method === 'model' || settledByAnswer || answer?.taken === false) withdraw(what);
    else if (answer === undefined) {
      takeBackAsked.push(what);
      flags.push(`refusal_asked:${what}`);
    } else refused.add(what);
  }
  // What a stated refusal leaves out: itself, and what goes with it (`LEFT_OUT_WITH`). "No stocks" is
  // no stocks through a fund either, unless the text then names the funds as something to hold ("no
  // stocks, but ETFs are fine"). What goes with it is no disagreement with the model, either way.
  const leftOutOf = (classes: Set<Refused>) =>
    new Set<Refused>(
      [...classes].flatMap((what) => {
        const from = statedOf(what).at(-1)?.end ?? 0;
        const with_ = (LEFT_OUT_WITH[what] ?? []).filter(
          (other) => !classNamed.some((m) => m.what === other && m.at >= from && keeps(m, from)),
        );
        return [what, ...with_];
      }),
    );
  const refusalOf = (what: Refused) => (what === 'credit' ? 'noCredit' : `cannotHold:${what}`);
  // No reader decides alone (the third review, Oct 7). A refusal the model reads that the text check
  // does not confirm was flagged and dropped: "Do not buy stocks for me." and "Nada de bolsa." gave
  // a plan with stocks. It is asked once ("Do you want to leave out stocks?"): a yes takes it, a no
  // leaves the class in and says so in a line. The form's own limits stand over the question.
  const refusalAsked: Refused[] = [...takeBackAsked];
  // A refusal the person confirmed by a yes: their last word on the class.
  const confirmed = new Set<Refused>();
  const refusalDeclined: Refused[] = [];
  if (method === 'model' && answers.limits === undefined) {
    const taken = leftOutOf(refused);
    for (const what of replyRefused) {
      if (taken.has(what)) continue;
      const answer = heard.refusals.filter((r) => r.classes.includes(what)).at(-1);
      if (answer === undefined) refusalAsked.push(what);
      else if (answer.taken) {
        refused.add(what);
        confirmed.add(what);
        flags.push(`refusal_confirmed:${what}`);
      } else {
        refusalDeclined.push(what);
        flags.push(`refusal_declined:${what}`);
      }
    }
  }
  {
    const leftOut = leftOutOf(refused);
    for (const what of replyRefused)
      if (!leftOut.has(what) && !refusals.some((x) => x.what === what))
        flags.push(`not_in_text:${refusalOf(what)}`);
    if (method === 'model')
      for (const what of refused)
        if (!replyRefused.includes(what)) flags.push(`disagrees_with_rules:${refusalOf(what)}`);
    // Written, and no refusal of theirs. Where the person is not sure, or the model read it as their
    // refusal, it is said back.
    for (const what of new Set(refusals.map((x) => x.what))) {
      if (leftOut.has(what) || stated.includes(what)) continue;
      const written = refusals.filter((x) => x.what === what);
      const shown = written.find((x) => x.stance === 'wondered') ?? written[0];
      if (!shown) continue;
      flags.push(`refusal_${shown.stance}:${what}`);
      const asked = refusalAsked.includes(what) || refusalDeclined.includes(what);
      if ((shown.stance === 'wondered' || replyRefused.includes(what)) && !asked)
        refusalsNotTaken.push(shown);
    }
  }

  // What the person wants held (gate EXPLICIT-MIX, Rodrigo, Oct 6). A mix is read only as written,
  // and only where its clause states it as what the person wants held: code reads it from the text in
  // English or Portuguese ("all of it in stocks", "70% stocks and 30% cash", "só crédito"). One its
  // clause rules out or says of something else is no mix ("I wouldn't put all of it in stocks", "so no
  // stocks please"): nothing is built from the opposite of what is written. One the person only
  // wonders about ("Should I put all of it in stocks?"), or says of a part of the money ("the other
  // 30% all in stocks"), is asked (below).
  //
  // The last word wins: the last message that says a mix decides, and a mix whose class a later
  // message rules out is no mix ("all of it in stocks", then "no stocks").
  //
  // With a model a mix needs both readers (the review of Oct 7): it is taken where the model's reply
  // reads one and the text states the same one. Where the two differ neither is taken and the mix
  // is asked once with no start (the third review, Oct 7; the text's was taken). One
  // the text states that the model did not read is not taken, not asked and not said
  // (`text_only:mix`): "I have all my money in stocks and want to diversify" is no plan in stocks.
  // With no model the mix the text states is asked once, with it as the form's start, never taken.
  const mixSaid = mixSaidInTurns(turns);
  const refusedLater =
    mixSaid?.stance === 'stated' &&
    mixSaid.classes.some((c) => refused.has(c) && refusedIn(c) > mixSaid.turn);
  let written = mixSaid?.stance === 'stated' && !refusedLater ? mixSaid : null;
  if (mixSaid && !written) flags.push(refusedLater ? 'mix_refused_later' : `mix_${mixSaid.stance}`);
  if (method === 'model' && written && !replyMix) {
    flags.push('text_only:mix');
    written = null;
  }
  // The mix both readers read, which may be taken; and the one the text states with no model, asked.
  let mixRead: PersonalMix | null = null;
  let mixOfRules: PersonalMix | null = null;
  // No reader decides alone (the third review, Oct 7): where both read a mix and the two differ,
  // neither is taken, and the mix is asked once. The text check's was taken: "My advisor wants
  // 60/40 stocks and bonds, but I want all in stocks" held the advisor's, and a correction it cannot
  // read ("Make the cash 50%.") was lost.
  let mixDiffers = false;
  if (written) {
    const parsed = PersonalMix.safeParse(written.mix);
    if (parsed.success && method === 'model') {
      if (replyMix && !sameMix(replyMix, parsed.data)) {
        flags.push('disagrees_with_rules:mix');
        mixDiffers = true;
      } else mixRead = parsed.data;
    } else if (parsed.success) mixOfRules = parsed.data;
  }
  if (replyMix && !mixRead && !mixDiffers) flags.push('no_cue:mix');
  // A holding brought up again after its question was answered is asked once more, not taken (the
  // third review): the mix both readers now read is the question's start.
  const reasked = heard.reask !== null;
  let mixAgain: PersonalMix | null = null;
  if (reasked && mixRead) {
    mixAgain = mixRead;
    mixRead = null;
  }
  // Markets, industries and trends ("big tech", "the S&P", "semiconductors", "defense stocks"): the
  // narrative's words must be in the text, as an ask. One the model names that the text has no word
  // for is dropped and asked; one the text names only to rule it out, or in passing, is dropped. Words
  // inside a shared portfolio's name ("Chips & Agents") name the portfolio, not a market.
  //
  // The last word wins: a narrative a later message only rules out is not asked for, whatever an
  // earlier one said ("…in AI", then "Actually, no AI"). Within one message any ask stands.
  const portfolioNames = [...portfolios.map((p) => p.name), ...namedPortfolios];
  const mentions = marketMentionsIn(text, portfolioNames);
  /** The asks that stand: those written after the last message that only rules the thing out. */
  const standing = <T extends { at: number }>(
    all: readonly T[],
    says: (m: T) => 'asked' | 'negated' | null,
  ): T[] => {
    const asking = new Set(all.filter((m) => says(m) === 'asked').map((m) => turnOf(m.at)));
    const cut = Math.max(
      NO_TURN,
      ...all
        .filter((m) => says(m) === 'negated' && !asking.has(turnOf(m.at)))
        .map((m) => turnOf(m.at)),
    );
    return all.filter((m) => says(m) === 'asked' && turnOf(m.at) > cut);
  };
  const saysMarket = (m: MarketMention) =>
    m.skipped === null ? 'asked' : m.skipped === 'negated' ? 'negated' : null;
  let asked = MARKET_IDS.flatMap((id) =>
    standing(
      mentions.filter((m) => m.market === id),
      saysMarket,
    ),
  ).sort((a, b) => a.at - b.at);
  for (const m of replyMarkets ?? []) {
    if (asked.some((w) => w.market === m)) continue;
    const all = mentions.filter((w) => w.market === m);
    const skipped = all.some((w) => w.skipped === 'negated')
      ? 'negated'
      : all.find((w) => w.skipped)?.skipped;
    if (skipped) flags.push(`market_${skipped}:${m}`);
    else {
      flags.push(`no_cue:market:${m}`);
      unclear.add('themes');
    }
  }
  // With a model a narrative needs both readers (the review of Oct 7): the fixed words the text check
  // finds are an ask only where the model's reply names that market too, by its id or as the words
  // of its filter. Words the model did not read are not taken, not asked and not said
  // (`text_only:market:<id>`): "I have a cloud of doubt", "after chips and salsa" and "my car needs
  // an oil change" name no market.
  if (method === 'model') {
    const filterWords = replyFilter ? phraseIn(text, replyFilter.words) : [];
    // The words of its filter name a market where the market's own words are all they say: "a
    // software course" says more than "software" (the third review, Oct 7).
    const namedByModel = (id: Market) =>
      (replyMarkets ?? []).includes(id) ||
      (replyFilter !== null &&
        mentions.some(
          (m) =>
            m.market === id &&
            filterWords.some((s) => m.at < s.end && s.at < m.end) &&
            wordsWrite(replyFilter.words, m.words),
        ));
    for (const id of MARKET_IDS)
      if (asked.some((m) => m.market === id) && !namedByModel(id))
        flags.push(`text_only:market:${id}`);
    asked = asked.filter((m) => namedByModel(m.market));
  }
  // What the person answered "none" for, in words: left out, until a later message asks for it again. A share the text gave it
  // ("Put 30% in AI", then "none") stays that narrative's, and is no split of the plan.
  for (const id of MARKET_IDS)
    if (asked.some((m) => m.market === id) && heard.leftOut.includes(id))
      flags.push(`market_left_out:${id}`);
  const leftOutAt = asked.filter((m) => heard.leftOut.includes(m.market)).map((m) => m.at);
  asked = asked.filter((m) => !heard.leftOut.includes(m.market));
  // A market the fixed lists have no word for, named by the model as a filter over the sourced
  // attributes (gate THEME-MATCHED). The filter is held to its schema, and the person's words must be
  // written in the text, as an ask, where no fixed list already reads them and they are no part of a
  // shared portfolio's name. Otherwise it is dropped and flagged, and nothing is asked about it. With
  // no model there is none.
  type Named = { words: string; at: number; end: number; wondered: boolean };
  //
  // The filter is the model's reading, and the text check is its second reader only where the
  // person's words write the value it must carry ("defense stocks" for Aerospace & Defense). Where
  // they do not ("obesity drugs" for GLP-1; "my future" for Consumer Discretionary, the review of
  // Oct 7), the link between the two is the model's alone (`written` false): it is never taken, and
  // is asked once by a question that says what it would be matched by, with the share the person
  // wrote as its start.
  let filterAsked: { filter: MarketFilter; spans: Named[]; written: boolean } | null = null;
  if (replyFilter) {
    const { words, ...filter } = replyFilter;
    const spans = phraseIn(text, words);
    const read = [...mentions, ...portfolioNames.flatMap((name) => phraseIn(text, name))];
    const free = spans
      .filter((s) => !read.some((m) => m.at < s.end && s.at < m.end))
      .map((s) => ({ ...s, stance: stanceOf(text, s.at, s.end) }));
    const asks = standing(free, (s) =>
      s.stance === 'negated' ? 'negated' : s.stance === 'aside' ? null : 'asked',
    ).map(({ stance, ...s }): Named => ({ ...s, wondered: stance === 'wondered' }));
    if (matchedSlug(filter) === null) flags.push('model_invalid:marketFilter');
    else if (spans.length === 0) flags.push('no_cue:marketFilter');
    else if (free.length === 0) flags.push('market_covers:marketFilter');
    else if (asks.length === 0) flags.push('market_negated:marketFilter');
    else if (heard.leftOut.includes('marketFilter')) {
      flags.push('market_left_out:marketFilter');
      leftOutAt.push(...asks.map((m) => m.at));
    } else filterAsked = { filter, spans: asks, written: wordsWrite(words, filter.value) };
  }
  const named: Named[] = [...asked, ...(filterAsked?.spans ?? [])];
  // The split, once what is said of the narratives is set apart: "30%" in "30% in AI" and "half" in
  // "half in big tech" are those narratives' shares, not a split of the plan. Nor are the shares of
  // a mix the text writes, however its clause says it and whoever read it ("100% stocks is too much
  // for me"): they are the mix's, and are not asked about as a split.
  const shares = withoutMarketShares(text, [...named.map((m) => m.at), ...leftOutAt]);
  // Nor are the words of a message that answered a question: an answer says nothing beside it.
  const blank = (t: string, from: number, to: number) =>
    `${t.slice(0, from)}${' '.repeat(Math.max(0, to - from))}${t.slice(to)}`;
  const unanswered = heard.answered.reduce((t, turn) => {
    const from = starts[turn];
    return from === undefined ? t : blank(t, from, from + (turns[turn]?.length ?? 0));
  }, shares);
  const rest = splitIn(mixSaid ? blank(unanswered, mixSaid.at, mixSaid.end) : unanswered);
  // With no model, a split the rules parser cannot read ("70-30", "70% safe") is asked: a pair, or
  // a percent written as a share of the money. Not "0%", which splits nothing: it answers "how
  // much" with none.
  if (
    input.reply === null &&
    !mixOfRules &&
    (rest.pairs.length > 0 || rest.ofMoney.some((pct) => pct > 0))
  )
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
  // attributes write it. The two writings must be one value (`attributeKey`), or nothing matches. A
  // filter is never used to pick one stock (the review of Oct 7: "invest in my future" with a filter
  // by industry gave a sheet all in one car maker): it matches only where it selects at least
  // `filterMinListed` names listed on the chain, and `one` where it selects one alone.
  const matchFor = (
    filter: MarketFilter,
  ): { slug: string; filter: MarketFilter } | 'one' | null => {
    const slug = matchedSlug(filter);
    const match = slug ? (input.matchOf?.(filter) ?? null) : null;
    if (!slug || !match || !(match.listed > 0)) return null;
    const kept = MarketFilter.safeParse({ by: filter.by, value: match.value });
    if (!kept.success || attributeKey(kept.data.value) !== attributeKey(filter.value)) return null;
    if (match.listed < INTAKE_LIMITS.filterMinListed) return 'one';
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
    /** For `none`: a filter matched one name alone there, which is no theme. */
    one: boolean;
    /** For a filter the model named: whether the person's words write its value. */
    written: boolean;
  };
  const resolve = (
    id: Market | null,
    ofModel: MarketFilter | null,
  ): Pick<Read, 'kind' | 'slug' | 'filter' | 'one'> => {
    const narrative = id ? NARRATIVES[id] : null;
    const portfolio = narrative?.portfolio;
    if (portfolio && portfolios.some((p) => p.slug === portfolio))
      return { kind: 'portfolio', slug: portfolio, filter: null, one: false };
    if (narrative && usableLabel(narrative.label))
      return { kind: 'label', slug: narrative.label, filter: null, one: false };
    const label = narrative ? labels.find((l) => l.slug === narrative.label) : undefined;
    // A label that is still a proposal, or lists no stock on this chain, holds nothing: said to the
    // operator, once, and the narrative goes on to its filters.
    const unusable = label
      ? `${label.status === 'confirmed' ? 'label_not_listed' : 'label_proposed'}:${label.slug}`
      : null;
    if (unusable && !flags.includes(unusable)) flags.push(unusable);
    const filters = narrative ? narrative.filters : ofModel ? [ofModel] : [];
    let one = false;
    for (const filter of filters) {
      const match = matchFor(filter);
      if (match === 'one') one = true;
      else if (match) return { kind: 'matched', ...match, one: false };
    }
    const name = id ?? 'marketFilter';
    if (one) flags.push(`filter_one_name:${name}`);
    else if (filters.length > 0) flags.push(`filter_no_match:${name}`);
    flags.push(`market_not_on_shelf:${name}`);
    return { kind: 'none', slug: null, filter: null, one };
  };
  // A share is read where the narrative is stated; one the person only wonders about has none yet.
  // The last word wins for a share too (the review of Oct 7: "invest $5,000 in AI", then "Scrap the
  // AI idea", still held AI where the reply named it): the last message that names the narrative
  // says its share. Where that message names it and gives no share in a plain form, the share an
  // earlier one gave no longer stands (`share_not_last:<id>`), and how much is asked once.
  const shareOf = (key: string, spans: Named[]): MarketShare => {
    const said = spans.map((s) => ({
      turn: turnOf(s.at),
      share: s.wondered ? null : marketShareIn(text, s.at, s.end),
    }));
    const last = Math.max(...said.map((x) => x.turn));
    const share =
      said
        .filter((x) => x.turn === last)
        .map((x) => x.share)
        .filter((x) => x !== null)
        .at(-1) ?? null;
    if (share === null && said.some((x) => x.share !== null)) flags.push(`share_not_last:${key}`);
    return share;
  };
  // In the order of the fixed lists, then the model's filter. While the person has no chain nothing
  // is resolved, and nothing is said of what their chain has: the chain is asked first. The same
  // where the caller could not read what the chain lists (`shelfKnown`): no sentence then says the
  // chain has no stock for it, since nobody looked.
  const reads: Read[] = [];
  const marketsAsked = MARKET_IDS.filter((id) => asked.some((m) => m.market === id));
  const resolvable = input.homeChain !== null && shelfKnown;
  if (!resolvable) {
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
          share: shareOf(id, spans),
          written: true,
          ...resolve(id, null),
        });
    }
    const [first] = filterAsked?.spans ?? [];
    if (filterAsked && first)
      reads.push({
        id: null,
        words: first.words,
        at: first.at,
        share: shareOf('marketFilter', filterAsked.spans),
        written: filterAsked.written,
        ...resolve(null, filterAsked.filter),
      });
  }
  // What an answer's theme sleeve names must be on the shelf too: a curated label that holds a stock
  // on the person's chain, or a filter that matches there. Otherwise the answer is refused and the
  // split asked again, as a portfolio answered off the shelf is.
  let sleevesAnswered = answers.sleeves;
  let sleevesRefused = false;
  if (sleevesAnswered && resolvable) {
    for (const s of sleevesAnswered) {
      if (s.kind !== 'theme' || usableLabel(s.theme)) continue;
      const by = filterOfSlug(s.theme);
      const match = by ? matchFor({ by: by.by, value: by.key }) : null;
      if (!match || match === 'one' || match.slug !== s.theme) sleevesRefused = true;
    }
    if (sleevesRefused) {
      flags.push('answer_not_on_shelf:sleeves');
      sleevesAnswered = undefined;
    }
  }

  // A refusal and a holding of the same class in one conversation, once the last word is taken, is a
  // conflict (the review of Oct 7): "No stocks in my IRA, so here I want all stocks" gave a sheet
  // with both. A mix whose words name a class the text also rules out, or a narrative (stocks) where
  // stocks are ruled out: one question, by the `mix` field, and never a sheet with both. An answer
  // settles it: a share for the holding takes the refusal back (said, never in silence); "none"
  // leaves the holding out, and the refusal stands.
  const growsSoFar =
    (answers.goal ?? draft.goal) !== 'income' && (answers.goal ?? draft.goal) !== 'protect';
  const holdable = reads.filter((r) => r.kind !== 'none').sort((a, b) => a.at - b.at);
  const keyOf = (r: Read): string => r.id ?? 'marketFilter';
  const answeredTheme = (sleevesAnswered ?? []).some((x) => x.kind === 'theme');
  const mixClass = written?.classes.find((c) => refused.has(c));
  const mixRefusal = mixClass ? statedOf(mixClass).at(-1) : undefined;
  // A narrative and a shared portfolio hold stocks, or funds of stocks: a refusal of either class
  // stands against them (the third review, Oct 7: "No ETFs. Put it all in index funds." held both).
  const heldClass = (['stock', 'etf'] as const).find(
    (c) => refused.has(c) && statedOf(c).length > 0,
  );
  const stockRefusal = heldClass ? statedOf(heldClass).at(-1) : undefined;
  // And a shared portfolio the model names is a holding too, where no narrative reads to one ("No
  // stocks. Start from The Seven." gave a sheet with both).
  const startsFrom = holdable.length === 0 ? (draft.themes ?? []) : [];
  const heldWords =
    holdable.length > 0
      ? holdable.map((r) => r.words)
      : startsFrom.map((slug) => portfolios.find((x) => x.slug === slug)?.name ?? slug);
  type Conflict = { what: Refused; refusal: RefusalSaid; held: string[]; of: 'mix' | 'market' };
  const conflict: Conflict | null =
    written && mixClass && mixRefusal
      ? { what: mixClass, refusal: mixRefusal, held: [written.words], of: 'mix' }
      : heldClass && stockRefusal && heldWords.length > 0 && growsSoFar
        ? { what: heldClass, refusal: stockRefusal, held: heldWords, of: 'market' }
        : null;
  // The share of a mix that holds the class a refusal names.
  const partOf = (m: PersonalMix, what: Refused): number =>
    what === 'gold'
      ? m.goldBps
      : what === 'credit'
        ? (m.creditBps ?? 0)
        : what === 'commodity'
          ? 0
          : m.growthBps;
  let conflictAsk: Conflict | null = null;
  // The narratives the person answered "none" for on the form: left out, as the words leave them.
  let noneHeld = false;
  if (conflict) {
    flags.push(`refusal_conflict:${conflict.what}`);
    const m = answers.mix;
    if (answeredTheme || (m && partOf(m, conflict.what) > 0)) withdraw(conflict.what);
    else if ('mix' in answers || sleevesAnswered !== undefined) noneHeld = conflict.of === 'market';
    else conflictAsk = conflict;
  } else {
    // An answered split that holds a theme is the person's later word on stocks.
    if (heldClass && stockRefusal && answeredTheme) withdraw(heldClass);
    // And an answered mix that holds what the text refuses is their word on it too, whatever the
    // text names beside it: never a sheet with both (found by the property test, once it looked at
    // every holding and not at theme sleeves only).
    const answeredMix = answers.mix;
    if (answeredMix)
      for (const what of ['stock', 'gold', 'credit'] as const)
        if (refused.has(what) && statedOf(what).length > 0 && partOf(answeredMix, what) > 0)
          withdraw(what);
    if ('mix' in answers && answers.mix === null && holdable.length > 0) noneHeld = true;
  }
  // The portfolio the model named is not where the plan starts while the question is open, nor
  // once the person answers "none" for it.
  if (startsFrom.length > 0 && (conflictAsk !== null || (conflict !== null && noneHeld)))
    draft.themes = null;
  // While the question is open neither side of it is taken: the mix is not held, and neither is the
  // narrative.
  if (conflictAsk?.of === 'mix') {
    mixRead = null;
    mixOfRules = null;
  }
  // A yes to leaving a class out is the person's last word on it: a mix or a narrative that would
  // hold it is not held, and never shares a sheet with it.
  const mixGone = written !== null && written.classes.some((c) => confirmed.has(c));
  const marketsGone = (confirmed.has('stock') || confirmed.has('etf')) && heldWords.length > 0;
  if (mixGone) {
    mixRead = null;
    mixOfRules = null;
    flags.push('mix_refused_later');
  }
  if (marketsGone && startsFrom.length > 0) draft.themes = null;
  const inPlay =
    conflictAsk?.of === 'market' || marketsGone ? reads.filter((r) => r.kind === 'none') : reads;
  // What the refusals that stand leave out: the sheet's limits.
  const leftOut = leftOutOf(refused);
  const classesRefused = [...leftOut].filter((x): x is HoldableClass => x !== 'credit').sort();
  limits.cannotHoldClasses = classesRefused.length > 0 ? classesRefused : null;
  if (leftOut.has('credit')) limits.creditTolerance = 'none';

  // A shared portfolio is where the plan starts from, as before. Not one the person answered "none"
  // of the money for. Nor on a goal of income or to protect (the third review, Oct 7: "Invest in
  // the S&P 500." on a goal to protect started the plan from The 500 with no question): a narrative
  // holds stocks whatever it reads to, so one that reads to a shared portfolio is not held there
  // either, as one that reads to a label or a filter is not, and that is said.
  const portfoliosNotHeld: string[] = [];
  for (const r of inPlay) {
    if (r.kind !== 'portfolio' || !r.slug) continue;
    if (!growsSoFar) {
      flags.push('themes_dropped_for_goal');
      if (!portfoliosNotHeld.includes(r.words)) portfoliosNotHeld.push(r.words);
      continue;
    }
    if (noneHeld) flags.push(`market_left_out:${keyOf(r)}`);
    else if (!(draft.themes ?? []).includes(r.slug))
      draft.themes = [...(draft.themes ?? []), r.slug];
  }
  // The narratives a theme sleeve holds: one per label or filter, however many words name it.
  const themed = inPlay
    .filter((r) => r.kind === 'label' || r.kind === 'matched')
    .sort((a, b) => a.at - b.at);
  type Themed = {
    keys: string[];
    slug: string;
    words: string;
    shares: MarketShare[];
    /** The filter of a theme only the model linked to the person's words; null for any other. */
    unwritten: MarketFilter | null;
  };
  const themes: Themed[] = [];
  for (const r of themed) {
    const same = themes.find((t) => t.slug === r.slug);
    if (same) {
      same.shares.push(r.share);
      same.keys.push(keyOf(r));
      // A fixed word that reads to the same names confirms them.
      if (r.written) same.unwritten = null;
    } else if (r.slug)
      themes.push({
        keys: [keyOf(r)],
        slug: r.slug,
        words: r.words,
        shares: [r.share],
        unwritten: r.written ? null : r.filter,
      });
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
  // tech") asks how much, once, and never the risk. Beside a split it is taken only where the split
  // is the plain pair below (gate STATED-SHARE), and otherwise how much is asked; never on a goal of
  // income or to protect.
  // A narrative the chain has nothing for is no stated holding (gate THEME-NONE-YET, Rodrigo, Oct 6):
  // no mix and no sleeve is made from it, and its share is never asked. That is said in one sentence
  // (below), and the rest of the intake goes on as if it had not been named: the risk is asked as for
  // any goal.
  let marketMix: { mix: PersonalMix; words: string } | null = null;
  let marketShareAsk: string | null = null;
  // What the text reads the asked share as, where it reads one: the form's start.
  let shareRead: PersonalMix | null = null;
  // The narratives the `mix` question asks a share of the money for.
  let shareAskedOf: Open['shareOf'] = [];
  // A share written as a sum waits for the amount it is a share of: nothing is asked of it meanwhile.
  let shareWaits = false;
  // The mix the text states, taken or not: what is read beside it is read the same either way.
  const mixSeen = mixRead ?? mixOfRules;
  const toGrow = value.goal !== 'income' && value.goal !== 'protect';
  const held = inPlay.filter((r) => r.kind === 'portfolio');
  // A share the person writes for what they want held, beside the share they keep safe (Rodrigo, Oct
  // 7: "8k safe and liquid, the 20% rest in a stock portfolio that follows big tech" was asked the
  // risk of the 20%, and at low risk the plan held 12% in stocks). A split of one part kept safe and
  // one other part, read by the model with each share written, says what the plain form says with
  // the rest's figure written, where the other part's share is the one the text gives what is held:
  // "80% safe and liquid, 20% in big tech" is "20% in big tech and the rest kept safe". The holding
  // is then taken as the plain form is, the risk is not asked, and the limits it takes are said.
  // Only where those two shares are all the text writes of the money: a share that is not the other
  // part's, or anything a plain form would not account for, leaves the split and its questions as
  // they were. With no share written for what is held ("20% to risk"), the risk of that part is asked.
  const partsOf = (sleeves: PlanSleeve[] | null | undefined) => {
    const safePart = sleeves?.find((x) => x.kind === 'safe_yield');
    const otherPart = sleeves?.find((x) => x.kind === 'goal');
    return sleeves?.length === 2 && safePart && otherPart && toGrow
      ? { safeBps: safePart.shareBps, heldBps: otherPart.shareBps }
      : null;
  };
  const twoParts = sleevesAnswered === undefined ? partsOf(draft.sleeves) : null;
  const sharesWritten = twoParts ? sharesOfMoneyIn(text) : [];
  // The safe part's own figure is part of the form: it says nothing more than the form does.
  const safeShares = sharesWritten.filter(
    (x) =>
      x.value * BPS_PER_PCT === twoParts?.safeBps &&
      (x.part === null || x.part === 'cash' || x.part === 'dollarYield'),
  );
  // The two shares are taken only as a pair in its plain form (the independent review of this rule,
  // Oct 7: "I used to keep 80% safe, 20% in stocks", "20% in stocks no way", "80% safe. Of the
  // remaining money, put 20% in big tech", "80% high risk, 20% in stocks" and a later "Actually put
  // the 20% in gold" were all taken). The safe part's figure is one, written once, that its own
  // words say is kept safe, and its clause states it; between the two shares there is nothing but
  // the words that join them; nothing follows the second up to the end of its sentence; and no
  // later message says anything that is not the answer to a question.
  const [safeShare] = safeShares.length === 1 ? safeShares : [];
  const safeWords = safeShare ? KEPT_SAFE_AFTER.exec(text.slice(safeShare.end)) : null;
  const sentenceEnd = (from: number) => {
    const stop = /[.!?;](?=\s|$)|\n/u.exec(text.slice(from));
    return stop ? from + stop.index : text.length;
  };
  const lastWordAt = (at: number) => {
    const turn = turnOf(at);
    return turns.every((_, t) => t <= turn || heard.answered.includes(t));
  };
  /** Whether the safe share and what is held, from its figure to the end of its words, are such a pair. */
  const plainPair = (figureAt: number, wordsEnd: number): boolean => {
    if (!safeShare || !safeWords) return false;
    const safeEnd = safeShare.end + safeWords[0].length;
    const [first, second] =
      safeShare.at < figureAt
        ? [{ end: safeEnd }, { at: figureAt, end: wordsEnd }]
        : [{ end: wordsEnd }, { at: safeShare.at, end: safeEnd }];
    return (
      stanceOf(text, safeShare.at, safeEnd) === 'stated' &&
      JOINS_SHARES.test(text.slice(first.end, second.at)) &&
      text.slice(second.end, sentenceEnd(second.end)).trim() === '' &&
      lastWordAt(Math.max(safeShare.at, figureAt))
    );
  };
  /**
   * The figure of the other part's share that leads into what is written at `at`: the last share
   * written before it in its sentence, where that is the other part's. A share further back is
   * another part's ("80% safe and liquid, 20% in big tech" gives big tech the 20%, never the 80%).
   */
  const figureBefore = (at: number, bps: number, shares = sharesWritten) => {
    const last = shares.filter((x) => x.at < at && sentenceEnd(x.end) >= at).at(-1);
    return last && last.value * BPS_PER_PCT === bps ? last : undefined;
  };
  // One narrative, written once: its share and the safe part's are the pair.
  const [onlyNamed] = named.length === 1 ? named : [];
  const namedFigure =
    twoParts && onlyNamed && !onlyNamed.wondered
      ? figureBefore(onlyNamed.at, twoParts.heldBps)
      : undefined;
  // What the text gives the narratives it names, in all: the share of the part that is not kept safe.
  const narrativesBps = (() => {
    const of = [...held.map((r) => ({ shares: [r.share] })), ...themes];
    const bps = of.length > 0 ? sharesInBps(of, value.amountUsd) : null;
    return Array.isArray(bps) ? bps.reduce((n, x) => n + x, 0) : null;
  })();
  const safeBeside =
    twoParts !== null &&
    narrativesBps === twoParts.heldBps &&
    onlyNamed !== undefined &&
    namedFigure !== undefined &&
    stanceOf(text, namedFigure.at, onlyNamed.end) === 'stated' &&
    plainPair(namedFigure.at, onlyNamed.end) &&
    rest.pairs.length === 0 &&
    rest.ofMoney.every((pct) => pct * BPS_PER_PCT === twoParts.safeBps);
  const splitWritten =
    (rest.ofMoney.length > 0 ||
      rest.pairs.length > 0 ||
      draft.sleeves !== null ||
      sleevesAnswered !== undefined) &&
    !safeBeside;
  // A share is taken only in its plain forms (the review of Oct 7). Where the text also says where
  // the rest goes and that is not cash or kept safe ("30% in AI and the rest in stocks", "half in
  // stocks and half in AI"), or carves a sum out of the share ("all of it in AI except $1,000"), the
  // rest is not put in the safe part by guessing: the split is asked once (`rest_said`).
  const restSaid = restOfMoneyIn(text);
  const carved = named.some((m) => carvedOutAfter(text, m.end));
  // And only where its message says nothing else about money or holdings (the third review, Oct
  // 7): whatever the plain form did not account for, a sum, a percent or another holding, means
  // the share is asked ("All of it in AI except for a $1,000 cushion", "30% in AI and the balance
  // in stocks", "Invest in AI, but only 10%", "Invest in AI, and some gold too").
  const accounted = [
    ...named,
    ...refusals,
    ...(mixSaid ? [mixSaid] : []),
    ...(safeBeside ? safeShares : []),
  ].map(({ at, end }) => ({ at, end }));
  // Each message that names one is read once, however many times it names it.
  const saysMore = [...new Set(named.map((m) => turnOf(m.at)))].some((turn) => {
    const from = starts[turn] ?? 0;
    return saysMoreIn(
      text,
      from,
      from + (turns[turn]?.length ?? 0),
      accounted,
      value.amountUsd,
      restSaid === 'safe' || safeBeside,
    );
  });
  if (saysMore) flags.push('share_not_alone');
  // No reader decides alone, for the amount too (the third review, Oct 7: "I have $5,000 and owe
  // $2,000 on my card" with a reply that gave the debt made a plan of $2,000; "My daughter is 12
  // and I want to invest 5000" one of $12). No code reads which of two figures is the one put in,
  // so where the last message that writes one writes several, the reply's is one reader's: asked
  // once, with it as the start. A sum that is a share of the money ("$500 in big tech") is not one
  // of them, whoever read what it is put in. Bare numbers count only where no sum is written as
  // money, as for the amount itself.
  if (method === 'model' && draft.amountUsd !== null && answers.amountUsd === undefined) {
    const placed = [
      ...mentions,
      ...named,
      ...refusals,
      ...(mixSaid ? [mixSaid] : []),
      ...portfolioNames.flatMap((name) => phraseIn(text, name)),
    ];
    const sumsOf = (bare: boolean) =>
      turns
        .map((turn, t) =>
          sumsWrittenIn(text, starts[t] ?? 0, (starts[t] ?? 0) + turn.length, placed, bare),
        )
        .filter((sums) => sums.length > 0);
    const asMoney = sumsOf(false);
    const lastSums = (asMoney.length > 0 ? asMoney : sumsOf(true)).at(-1);
    if (lastSums && lastSums.length > 1 && lastSums.includes(draft.amountUsd)) {
      flags.push('amount_several');
      unclear.add('amountUsd');
    }
  }
  const restNotPlain = (partial: boolean) =>
    (partial && (restSaid === 'other' || rest.half)) || carved || saysMore;
  // Not where a theme sleeve is in play: the two are not combined (below).
  if (
    themes.length === 0 &&
    !mixSeen &&
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
      // A share no line of a plan can be is no share: how much is asked (`share_too_small`).
      const tooSmall = growthBps > 0 && growthBps < leastShareBps(value.amountUsd);
      if (tooSmall) flags.push('share_too_small');
      const parsed =
        growthBps > 0 && growthBps <= WHOLE_MIX_BPS && !tooSmall
          ? PersonalMix.safeParse({
              growthBps,
              dollarYieldBps: 0,
              goldBps: 0,
              cashBps: WHOLE_MIX_BPS - growthBps,
            })
          : null;
      if (
        parsed?.success &&
        method === 'model' &&
        !reasked &&
        !restNotPlain(growthBps < WHOLE_MIX_BPS)
      ) {
        marketMix = { mix: parsed.data, words: first.words };
        flags.push('mix_from_market');
      } else {
        // How much is asked: no share said, or shares that come to more than the money; a share
        // with the rest said or a sum carved out; or, with no model, a share the text states, which
        // is asked once with its reading as the start and never taken.
        marketShareAsk = first.words;
        shareAskedOf = held.map((r) => ({ key: keyOf(r), words: r.words }));
        if (!parsed?.success) flags.push('market_share_unclear');
        else if (restNotPlain(growthBps < WHOLE_MIX_BPS))
          flags.push('rest_said', 'market_share_unclear');
        else {
          shareRead = parsed.data;
          flags.push('from_rules:market');
        }
      }
    }
  }
  // A market named beside a split whose share the text does not give it in a plain form ("20% in a
  // stock portfolio that follows big tech", "30% to grow, I like big tech", a share corrected in a
  // later message, a split the person answered): no reader can say whether the other part is the
  // market's. How much is asked once, and never the risk in its place: a risk answer would hold
  // less of the market than the share the person wrote. Where the split is one part kept safe and
  // one other part, that part's share is the form's start, so a plain yes holds it; not where the
  // person only wonders about the market, since a start is what a plain yes would take.
  const [besideSplit] = held;
  if (
    themes.length === 0 &&
    !mixSeen &&
    !('mix' in answers) &&
    splitWritten &&
    besideSplit &&
    toGrow &&
    method === 'model' &&
    marketMix === null &&
    marketShareAsk === null
  ) {
    const parts = twoParts ?? partsOf(sleevesAnswered);
    const start = parts
      ? PersonalMix.safeParse({
          growthBps: parts.heldBps,
          dollarYieldBps: 0,
          goldBps: 0,
          cashBps: parts.safeBps,
        })
      : null;
    marketShareAsk = besideSplit.words;
    shareAskedOf = held.map((r) => ({ key: keyOf(r), words: r.words }));
    // The start is what a plain yes takes, so it is only what the text ties to the market: the other
    // part's figure leads into the market's words in one sentence, stated, alone and as the last
    // word (the review: "20% to grow. Big tech scares me" then "yes" held 20% in it).
    const tied =
      parts && onlyNamed && !onlyNamed.wondered
        ? figureBefore(onlyNamed.at, parts.heldBps, sharesOfMoneyIn(text))
        : undefined;
    if (
      start?.success &&
      onlyNamed &&
      tied &&
      text.slice(onlyNamed.end, sentenceEnd(onlyNamed.end)).trim() === '' &&
      stanceOf(text, tied.at, onlyNamed.end) === 'stated' &&
      lastWordAt(onlyNamed.at)
    )
      shareRead = start.data;
    flags.push('market_beside_split');
  }
  // The same split with no narrative, where the other part's share is written for stocks or for gold
  // ("80% safe and liquid, 20% in stocks"): that share is the mix's and the rest is kept in cash, as
  // for a market. The model read the split and the text says what the share is in; the words must
  // state it as what the person wants held, name no class they rule out, and be all the message
  // says of money and holdings.
  if (
    twoParts &&
    method === 'model' &&
    !reasked &&
    named.length === 0 &&
    !mixSeen &&
    !mixSaid &&
    !('mix' in answers) &&
    sharesWritten.length === 2
  ) {
    const said = sharesWritten.find((x) => x.part === 'growth' || x.part === 'gold');
    const kept = safeShare !== said ? safeShare : undefined;
    const classes: Refused[] = said?.part === 'gold' ? ['gold'] : ['stock', 'crypto'];
    const turn = said ? turnOf(said.at) : 0;
    const from = starts[turn] ?? 0;
    if (
      said &&
      kept &&
      said.value * BPS_PER_PCT === twoParts.heldBps &&
      stanceOf(text, said.at, said.partEnd) === 'stated' &&
      plainPair(said.at, said.partEnd) &&
      !classes.some((c) => refused.has(c)) &&
      !saysMoreIn(
        text,
        from,
        from + (turns[turn]?.length ?? 0),
        [{ at: said.at, end: said.partEnd }, kept, ...refusals].map(({ at, end }) => ({ at, end })),
        value.amountUsd,
        true,
      )
    ) {
      const parsed = PersonalMix.safeParse({
        growthBps: said.part === 'growth' ? twoParts.heldBps : 0,
        dollarYieldBps: 0,
        goldBps: said.part === 'gold' ? twoParts.heldBps : 0,
        cashBps: twoParts.safeBps,
      });
      if (parsed.success) {
        marketMix = { mix: parsed.data, words: text.slice(said.at, said.partEnd).trim() };
        flags.push('mix_from_split');
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
  //   - anything else: the split (`sleeves`). Only a split says a share for each part. Asked of
  //     several themes alone, the question names them ("How do you want to split the money between
  //     AI and semiconductors?"), and "half each" answers it; asked of one theme whose rest the
  //     text says, it asks the share and the rest.
  // A mix that says the same as the themes' shares ("invest in semiconductors, all of it in stocks")
  // is no second mechanism: the sleeves are made. On a goal of income or to protect a narrative's
  // share is not read, as a market's is not: the theme is not held, and that is said. With no model
  // the shares the text states are asked once, never taken.
  let themeSleeves: PlanSleeve[] | null = null;
  let themeAsk: 'mix' | 'sleeves' | null = null;
  // The filter of the one theme whose share is asked, where only the model linked it to the
  // person's words: the question says what it would be matched by.
  let matchedAsk: MarketFilter | null = null;
  // The question the split is asked by, where it is asked to settle themes alone.
  let splitAsk:
    | { id: 'themeShares'; themes: Open['themes'] }
    | { id: 'themeAndRest'; market: string }
    | null = null;
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
      const besideSplit = splitWritten && !mixSeen;
      const sleevesMade =
        portfolioToo || besideSplit ? null : themeSleevesOf(themes, value.amountUsd);
      // A share no line of a plan can be is no share: how much is asked (`share_too_small`).
      const least = leastShareBps(value.amountUsd);
      const tooSmall =
        Array.isArray(sleevesMade) &&
        sleevesMade.some((x) => x.kind === 'theme' && x.shareBps < least);
      if (tooSmall) flags.push('share_too_small');
      const made = tooSmall ? null : sleevesMade;
      const alone = only && themes.length === 1 && !portfolioToo && !besideSplit ? only : null;
      // A theme only the model linked to the person's words is one reader's: never taken.
      const unwritten = themes.some((t) => t.unwritten !== null);
      // What is asked of the themes, and why: the share of one alone, or the split.
      let ask: { how: 'share' | 'split'; why: string[] } | null = null;
      if (made === 'wait') shareWaits = true;
      else if (made && sameAsMix(made, mixSeen)) {
        const themeBps = themeBpsOf(made);
        if (restNotPlain(themeBps < WHOLE_MIX_BPS))
          ask = { how: 'split', why: ['rest_said', 'theme_shares_unclear'] };
        else if (method === 'model' && !unwritten && !reasked) {
          themeSleeves = made;
          draft.sleeves = made;
          flags.push('sleeves_from_market');
        } else if (alone?.unwritten) {
          // The model's own link: asked once by a question that says the match, with the share the
          // person wrote as its start, so that a plain yes holds what they wrote.
          ask = { how: 'share', why: ['filter_not_written'] };
          shareRead = {
            growthBps: themeBps,
            dollarYieldBps: 0,
            goldBps: 0,
            cashBps: WHOLE_MIX_BPS - themeBps,
          };
        } else if (unwritten)
          ask = { how: 'split', why: ['filter_not_written', 'theme_shares_unclear'] };
        else if (alone) {
          // With no model: asked once, with what the text says as the form's start.
          ask = { how: 'share', why: ['from_rules:market'] };
          shareRead = {
            growthBps: themeBps,
            dollarYieldBps: 0,
            goldBps: 0,
            cashBps: WHOLE_MIX_BPS - themeBps,
          };
        } else ask = { how: 'split', why: ['from_rules:market', 'theme_shares_unclear'] };
      } else {
        if (besideSplit) flags.push('theme_beside_split');
        if (portfolioToo) flags.push('theme_beside_portfolio');
        if (mixSeen) flags.push('theme_beside_mix');
        ask = alone
          ? { how: 'share', why: ['market_share_unclear'] }
          : { how: 'split', why: ['theme_shares_unclear'] };
      }
      if (ask?.how === 'share' && alone) {
        themeAsk = 'mix';
        marketShareAsk = alone.words;
        matchedAsk = alone.unwritten;
        shareAskedOf = themes.flatMap((t) => t.keys.map((key) => ({ key, words: t.words })));
        flags.push(...ask.why, ...(alone.unwritten ? ['filter_not_written'] : []));
      } else if (ask) {
        themeAsk = 'sleeves';
        unclear.add('sleeves');
        flags.push(...ask.why);
        if (!portfolioToo && !besideSplit)
          splitAsk = alone
            ? { id: 'themeAndRest', market: alone.words }
            : {
                id: 'themeShares',
                themes: themes.map(({ keys, slug, words }) => ({ keys, slug, words })),
              };
      }
    }
  }
  // An answered split that holds a theme is the person's word on what is held: a mix the text states
  // beside it is not applied (a sheet holds one or the other), and that is flagged.
  const sleevesWin =
    sleevesAnswered !== undefined && themeBpsOf(sleevesAnswered) > 0 && !('mix' in answers);
  if (sleevesWin && mixSeen) flags.push('mix_dropped_for_sleeves');
  // A holding the person may mean and the text does not state is asked once, by the `mix` question:
  // never dropped, never guessed, and the risk is not asked in its place. That is a mix they only
  // wonder about, a mix said of a part of the money, a mix the model reads that the text's words
  // cannot confirm (`no_cue:mix`), with that reading as the form's start, and, with no model, a mix
  // the text states, with it as the start. Not where something stated is already held or asked. Nor
  // for a model's mix where the text gives a share to a narrative it names ("all of it in AI"): that
  // share is the narrative's, whatever the narrative reads to. Nor where the text rules out the very
  // mix the model read ("I wouldn't put all of it in stocks"). And where the text refuses a class the
  // model's mix holds ("no stocks please"), the question is asked with no start: the form never
  // opens on the opposite of what is written.
  const shareOfANarrative = named.some(
    (m) => !m.wondered && marketShareIn(text, m.at, m.end) !== null,
  );
  const ruledOut = PersonalMix.safeParse(mixSaid?.stance === 'negated' ? mixSaid.mix : null);
  const againstRefusal =
    replyMix !== null &&
    ((replyMix.growthBps > 0 && (refused.has('stock') || refused.has('crypto'))) ||
      (replyMix.goldBps > 0 && refused.has('gold')) ||
      ((replyMix.creditBps ?? 0) > 0 && refused.has('credit')));
  let mixAsk: {
    read: PersonalMix | null;
    why: 'wondered' | 'part' | 'model' | 'rules' | 'differs' | 'again';
  } | null = null;
  const nothingStated =
    !mixRead &&
    marketMix === null &&
    marketShareAsk === null &&
    themeSleeves === null &&
    themeAsk === null &&
    !shareWaits &&
    !('mix' in answers) &&
    sleevesAnswered === undefined &&
    conflictAsk === null;
  if (nothingStated && mixOfRules) mixAsk = { read: mixOfRules, why: 'rules' };
  else if (nothingStated && mixAgain) mixAsk = { read: mixAgain, why: 'again' };
  // The two readers read different mixes: asked, with no start. Either reading may be the wrong
  // one (the advisor's mix the text check read, or a mix the model made up), and a start is what a
  // plain yes would take.
  else if (nothingStated && mixDiffers) mixAsk = { read: null, why: 'differs' };
  else if (
    nothingStated &&
    mixSaid &&
    (mixSaid.stance === 'wondered' || mixSaid.stance === 'part')
  ) {
    const read = mixSaid.stance === 'wondered' ? PersonalMix.safeParse(mixSaid.mix) : null;
    mixAsk = { read: read?.success ? read.data : null, why: mixSaid.stance };
  } else if (
    nothingStated &&
    replyMix &&
    !mixGone &&
    !shareOfANarrative &&
    !(ruledOut.success && sameMix(replyMix, ruledOut.data))
  )
    mixAsk = { read: againstRefusal ? null : replyMix, why: 'model' };
  if (mixAsk) flags.push(`mix_asked:${mixAsk.why}`);
  // While what is held is open (a theme's share, a sum that waits for the amount, a mix that is asked,
  // a refusal against a holding) or the person has no chain to read a narrative on, neither a mix
  // read beside it nor the risk is settled: the risk is not asked meanwhile, as for a market.
  const heldOpen =
    themeAsk !== null ||
    shareWaits ||
    mixAsk !== null ||
    conflictAsk !== null ||
    (!resolvable && named.length > 0 && !mixSeen && !('mix' in answers) && !splitWritten && toGrow);
  let mix: PersonalMix | null =
    themeSleeves || sleevesWin
      ? null
      : 'mix' in answers
        ? (answers.mix ?? null)
        : (mixRead ?? marketMix?.mix ?? null);
  // The words a mix is said in: the person's, where the mix held is the one they wrote.
  const mixWords = (m: PersonalMix) =>
    written && mixSeen && sameMix(m, mixSeen)
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
      // A caller with the shelf passes the engine's exact rule; left out, the estimate on the caps.
      value.risk =
        input.riskOfSleeves?.(sleeves ?? [], value.themes ?? [], value.amountUsd ?? undefined) ??
        riskForMixEstimate({ growthBps: themeBps });
      flags.push('risk_from_themes');
      limitsFor = { words: null, risk: value.risk };
    } else if (mix && !mixConflict && !heldOpen) {
      // A caller with the shelf passes the engine's exact rule, with the amount of the sheet where
      // it is known; left out, the estimate on the caps.
      value.risk =
        input.riskOfMix?.(mix, value.themes ?? [], value.amountUsd ?? undefined) ??
        riskForMixEstimate(mix);
      flags.push('risk_from_mix');
      limitsFor = { words: mixWords(mix), risk: value.risk };
    }
    if (limitsFor && riskSaid !== null && riskSaid !== limitsFor.risk)
      flags.push(`risk_said_not_used:${riskSaid}`);
    // A mix is of the whole plan, so no split is asked beside it, unless the split is what is asked
    // to settle a theme.
    if ((mix && answers.sleeves === undefined && themeAsk !== 'sleeves') || themeSleeves)
      unclear.delete('sleeves');
    // Nor beside the mix the text states where that is what is asked: its percents are the mix's.
    if ((mixAsk?.why === 'rules' || conflictAsk) && answers.sleeves === undefined)
      unclear.delete('sleeves');
  }
  const keptSafe = sleeves?.some((x) => x.kind === 'safe_yield') === true && sleeves.length > 1;
  // An answer naming a portfolio is held to the shelf too, where the shelf could be read.
  if (answers.themes && shelfKnown) {
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
        return marketShareAsk !== null || mixAsk !== null || conflictAsk !== null;
      case 'limits':
        return refusalAsked.length > 0;
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

  // The question that asks of a shared portfolio by its name, where that is all the `themes`
  // question is asked for: one read alone, and nothing the shelf does not hold.
  const startFrom =
    startAsked.length > 0 &&
    !flags.includes('portfolio_wondered') &&
    !flags.includes('not_on_shelf:themes') &&
    !flags.some((flag) => flag.startsWith('no_cue:market:')) &&
    !(answers.themes !== undefined && value.themes === null)
      ? startAsked
      : [];
  /** What a yes to leaving `classes` out would leave out: each, and what goes with it. */
  const wouldLeaveOut = (classes: readonly Refused[]): Refused[] => {
    const order = [...Object.keys(CLASS_WORDS[language]), 'credit'];
    return [...leftOutOf(new Set(classes))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  };
  /** The classes in the person's language, for a line that lists them. */
  const classWords = (classes: readonly Refused[]): string =>
    [
      ...classes.filter((c) => c !== 'credit').map((c) => CLASS_WORDS[language][c] ?? c),
      ...(classes.includes('credit') ? [CREDIT_WORDS[language]] : []),
    ].join(',');
  /** "a", "a and b", "a, b and c": the person's words, joined in their language. */
  const listed = (words: readonly string[]): string =>
    words.length > 1
      ? `${words.slice(0, -1).join(', ')} ${WORDS[language].and} ${words.at(-1)}`
      : (words[0] ?? '');
  const templateOf = (field: QuestionField): { id: QuestionId; params: Record<string, Value> } => {
    if (field === 'amountUsd' && otherCurrency)
      return { id: 'amountOtherCurrency', params: { ...otherCurrency } };
    if (field === 'sleeves' && mismatch) return { id: 'sleevesMismatch', params: { ...mismatch } };
    if (field === 'sleeves' && splitAsk?.id === 'themeShares')
      return {
        id: 'themeShares',
        params: { themes: listed(splitAsk.themes.map((t) => t.words)) },
      };
    if (field === 'sleeves' && splitAsk?.id === 'themeAndRest')
      return { id: 'themeAndRest', params: { market: splitAsk.market } };
    if (field === 'risk' && keptSafe) return { id: 'riskGoalPart', params: {} };
    if (field === 'mix' && conflictAsk)
      return {
        id: 'holdOrLeaveOut',
        params: { refusal: conflictAsk.refusal.words, held: listed(conflictAsk.held) },
      };
    if (field === 'mix' && marketShareAsk !== null && matchedAsk) {
      const matched = matchedName(matchedAsk.by, matchedAsk.value, language);
      return value.amountUsd !== null
        ? {
            id: 'matchedShare',
            params: { amount: value.amountUsd, market: marketShareAsk, matched },
          }
        : { id: 'matchedShareNoAmount', params: { market: marketShareAsk, matched } };
    }
    if (field === 'mix' && marketShareAsk !== null)
      return value.amountUsd !== null
        ? { id: 'marketShare', params: { amount: value.amountUsd, market: marketShareAsk } }
        : { id: 'marketShareNoAmount', params: { market: marketShareAsk } };
    if (field === 'goal' && mixConflict && mix && value.goal)
      return { id: 'goalMixConflict', params: { words: mixWords(mix), goal: value.goal } };
    if (field === 'limits')
      return { id: 'limits', params: { classes: classWords(wouldLeaveOut(refusalAsked)) } };
    if (field === 'themes' && startFrom.length > 0)
      return {
        id: 'startFrom',
        params: {
          portfolios: listed(
            startFrom.map((slug) => portfolios.find((x) => x.slug === slug)?.name ?? slug),
          ),
        },
      };
    return { id: field, params: {} };
  };
  // What a question starts from: what was read, and for the `mix` question the mix it is asked about,
  // or the share the text gives the market it is asked of. A refusal against a holding has no start.
  const startOf = (field: QuestionField): IntakeQuestion['read'] =>
    field === 'limits'
      ? wouldLeaveOut(refusalAsked)
      : field === 'themes' && startFrom.length > 0
        ? [...new Set([...(value.themes ?? []), ...startFrom])]
        : field !== 'mix'
          ? readOf(field, value)
          : conflictAsk
            ? undefined
            : marketShareAsk === null
              ? (mixAsk?.read ?? undefined)
              : (heard.reask?.start ?? shareRead ?? undefined);
  const questions: IntakeQuestion[] = QUESTION_FIELDS.filter(needed).map((field) =>
    question(field, language, templateOf(field), startOf(field)),
  );

  // What the goal names that only the chain's shelf can settle, where the shelf could not be read: a
  // narrative, a shared portfolio, a theme in an answered split. No sheet is made then: it would
  // leave out, without a word, what the person asked for. It is said in one line that says nothing
  // of what the chain has.
  const waitsForShelf: string[] = shelfKnown
    ? []
    : [
        ...[...named].sort((a, b) => a.at - b.at).map((m) => m.words),
        ...namedPortfolios,
        ...(answers.themes ?? []),
        ...(answers.sleeves ?? []).flatMap((x) => (x.kind === 'theme' ? [x.theme] : [])),
      ].filter((words, i, all) => all.indexOf(words) === i);
  if (waitsForShelf.length > 0) flags.push('shelf_unread');
  let sheet: PersonalSheet | null = null;
  if (questions.length === 0 && input.homeChain && waitsForShelf.length === 0) {
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
    if (limitsFor.risk !== 'low') assume('MIX_MORE_RISK');
  }
  if (input.homeChain)
    for (const words of waitsForShelf) assume('SHELF_UNREAD', { words, chain: input.homeChain });
  for (const { words } of refusalsNotTaken) assume('REFUSAL_NOT_TAKEN', { words });
  // A refusal asked about that the person said no to: the class stays in, and that is said.
  if (refusalDeclined.length > 0)
    assume('REFUSAL_DECLINED', { classes: classWords(wouldLeaveOut(refusalDeclined)) });
  // A share that was not taken because no line of a plan can be that small: said while how much
  // is still asked, with the least a plan of this size can hold, so the question that comes back is
  // not a riddle.
  if (
    flags.includes('share_too_small') &&
    value.amountUsd !== null &&
    questions.some((q) => q.field === 'mix' || q.field === 'sleeves')
  )
    assume('SHARE_TOO_SMALL', { least: leastShareUsd(value.amountUsd) });
  // A refusal the text states that the model did not read: taken, and said in a line of its own
  // that names the person's words, so a clause read wrongly is seen and corrected. Not while it is
  // asked against a holding: the question names it.
  if (method === 'model')
    for (const what of stated) {
      const last = statedOf(what).at(-1);
      if (!last || !refused.has(what) || replyRefused.includes(what)) continue;
      if (conflictAsk?.what === what) continue;
      if (what === 'credit') assume('REFUSAL_TAKEN_CREDIT', { words: last.words });
      else {
        const order = Object.keys(CLASS_WORDS[language]);
        const classes = [...leftOutOf(new Set([what]))]
          .sort((a, b) => order.indexOf(a) - order.indexOf(b))
          .map((c) => CLASS_WORDS[language][c] ?? c);
        assume('REFUSAL_TAKEN', { words: last.words, classes: classes.join(',') });
      }
    }
  // A refusal of a part of a class, and a name ruled out of a list the plan holds: a plan leaves out
  // a class, so neither is applied, and that is said.
  for (const part of new Set(
    refusals.flatMap((r) => (r.part && !leftOut.has(r.what) ? [r.part] : [])),
  )) {
    flags.push('part_refused');
    assume('REFUSAL_OF_A_PART', { words: part });
  }
  if (holdable.length > 0 || (value.themes ?? []).length > 0)
    for (const { words } of namesRuledOutIn(text, input.names ?? [])) {
      flags.push('cannot_leave_out');
      assume('CANNOT_LEAVE_OUT', { words });
    }
  if (mixDropped) assume('MIX_DROPPED', mixDropped);
  if (themesNotHeld && value.goal)
    for (const { words } of themes) assume('MIX_DROPPED', { words, goal: value.goal });
  if (value.goal)
    for (const words of portfoliosNotHeld) assume('MIX_DROPPED', { words, goal: value.goal });
  const chain = input.homeChain;
  if (chain)
    for (const r of [...reads].sort((a, b) => a.at - b.at)) {
      // Matched, not curated: said wherever the plan holds it, or still asks how much of it.
      if (r.kind === 'matched' && r.filter && r.slug && !themesNotHeld) {
        const inPlan = sleeves?.some((x) => x.kind === 'theme' && x.theme === r.slug) === true;
        // Not while the question that says the match is open (the third review, Oct 7): it asks
        // whether that is what the person meant, so nothing says yet that the plan holds the names.
        const matchAsked = matchedAsk !== null && !inPlan;
        if ((inPlan || themeAsk !== null || shareWaits) && !matchAsked)
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
        if (nearest)
          assume(r.one ? 'MARKET_ONE_NEAREST' : 'MARKET_NEAREST', {
            words: r.words,
            chain,
            nearest,
          });
        else assume(r.one ? 'MARKET_ONE' : 'MARKET_NONE', { words: r.words, chain });
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
  // What the next message can answer in words: the narratives the `mix` question asks a share of the
  // money for, and the themes the split is asked between.
  const asks = (field: QuestionField) => questions.some((q) => q.field === field);
  const open: Open = {
    shareOf: !asks('mix')
      ? []
      : conflictAsk
        ? conflictAsk.of === 'market'
          ? holdable.map((r) => ({ key: keyOf(r), words: r.words }))
          : []
        : shareAskedOf,
    themes: asks('sleeves') && splitAsk?.id === 'themeShares' ? splitAsk.themes : [],
    refusal: asks('limits') ? refusalAsked : [],
    startFrom: asks('themes') ? startFrom : [],
    held:
      questions.length === 0 &&
      (marketMix !== null || themeSleeves !== null || (answers.mix ?? null) !== null)
        ? holdable.map((r) => ({ key: keyOf(r), words: r.words }))
        : [],
  };
  return {
    result: {
      method,
      language,
      draft,
      limits,
      questions,
      flags: [...new Set(flags)],
      disagreements,
      sheet,
      readBack: said ? [...said.slice(0, -1), ...assumptions, ...said.slice(-1)] : null,
      assumptions,
      mix,
      narratives,
    },
    open,
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
  Exclude<QuestionField, 'chains' | 'sleeves' | 'mix' | 'limits'>,
  string | number | string[] | null | undefined
>;
function readOf(field: QuestionField, value: Values): IntakeQuestion['read'] {
  if (field === 'chains' || field === 'sleeves' || field === 'mix' || field === 'limits')
    return undefined;
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
