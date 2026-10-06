import {
  BasketSheet,
  type BasketSheetDraft,
  type ChainId,
  GoalCurrency,
  Language,
  PlanSleeves,
} from '@colosseum/schemas';
import { z } from 'zod';
import { draftFromRules } from './draft';
import {
  amountInText,
  countryNamed,
  currenciesIn,
  exitTimesIn,
  glideAskedIn,
  goalCuesIn,
  horizonsIn,
  looseRiskWordsIn,
  maxYieldAskedIn,
  mentionsIn,
  openEndedIn,
  refusalsIn,
  riskCuesIn,
  splitIn,
} from './intake-text';
import { PERSONAL_PARAMS } from './params';
import { readBack } from './readback';
import {
  ASSUMPTION_TEMPLATES,
  type AssumptionId,
  QUESTION_TEMPLATES,
  type QuestionId,
  render,
} from './templates';
import { HoldableClass, isCountryCode, PersonalLimits, PersonalSheet } from './types';

// The guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7). A model reads the person's goal into
// a draft of the sheet and says which fields it could not read. Everything after that is here, in pure
// code: each value is validated on its own and dropped to null when it fails; an amount and a time
// frame must be written in the text; a shared portfolio must be on the shelf; a refusal must be
// written; any field where the model and the rules parser disagree is flagged and asked about. The
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
  'incomeTargetUsdMonthly',
  'horizonMonths',
  'risk',
  'country',
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
    country: BasketSheet.shape.country,
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
  /** What the text was read as, when it was read and is unclear: the form starts from it. */
  read: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
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
};

/**
 * The text the intake reads: the first message and every later one, in order (Oct 6). A follow-up in
 * the person's own words ("I live in Brazil", "70-30") is read again with what came before, by the same
 * reader and the same checks: an answer is never only a form field.
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
  country: BasketSheet.shape.country,
  chain: z.enum(['solana', 'base', 'robinhood']),
  portfolios: BasketSheet.shape.themes,
  language: Language,
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

/** The draft, the questions, and the sheet with its read-back once nothing is left to ask. */
export function runIntake(input: IntakeInput): IntakeResult {
  const { text, nowMonth, portfolios } = input;
  const answers = input.answers ?? {};
  const flags: string[] = [];
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

  if (input.reply === null) {
    Object.assign(draft, rules);
    // The rules parser misreads ("for 5 years" as 61 months, "no stocks" as high risk): with no model
    // to check it against, every field it read is put to the person once, its reading the start.
    for (const field of ['goal', 'horizonMonths', 'risk'] as const)
      if (rules[field] !== null) {
        flags.push(`from_rules:${field}`);
        unclear.add(field);
      }
    // "No hard cap", "sem prazo": no date, read by code, the same with or without a model.
    if (openWords !== null && rules.horizonMonths === null && !dated) openEnded = true;
    // A split the rules parser cannot read ("70-30", "70%") is asked.
    if (split.pairs.length > 0 || split.percents.length > 0) unclear.add('sleeves');
  } else {
    const read = readReply(input.reply);
    flags.push(...read.flags);
    const r = read.reply;
    draft.goal = r.goal;
    draft.risk = r.risk;
    // "UK" is the person's word for GB, never a code: it is read as GB, and GB is then held to the text.
    draft.country = r.country === 'UK' ? 'GB' : r.country;
    draft.language = r.language;

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
    // A shared portfolio must be on the shelf of the person's chain.
    if (r.portfolios !== null && r.portfolios.length > 0) {
      const slugs = r.portfolios.map((name) => portfolioSlug(name, portfolios));
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
    // A refusal must be written: "no stocks", "sem ações", "no credit".
    const written = refusalsIn(text);
    if (r.cannotHold !== null && r.cannotHold.length > 0) {
      const kept = r.cannotHold.filter((cls) => written.classes.includes(cls));
      for (const cls of r.cannotHold)
        if (!written.classes.includes(cls)) flags.push(`not_in_text:cannotHold:${cls}`);
      limits.cannotHoldClasses = kept.length > 0 ? [...new Set(kept)].sort() : null;
    }
    if (r.noCredit === true) {
      if (written.noCredit) limits.creditTolerance = 'none';
      else flags.push('not_in_text:noCredit');
    }
    // What the model itself says it could not read.
    for (const field of r.unclear ?? [])
      if ((QUESTION_FIELDS as readonly string[]).includes(field))
        unclear.add(field as QuestionField);

    // A goal, a risk or a country the text has no word for is the model's suggestion, not a reading:
    // it is kept as the form's start and asked.
    if (draft.goal !== null && !goalCuesIn(text).includes(draft.goal)) {
      flags.push('no_cue:goal');
      unclear.add('goal');
    }
    if (draft.risk !== null && !riskCuesIn(text).includes(draft.risk)) {
      flags.push('no_cue:risk');
      unclear.add('risk');
    }
    if (draft.country !== null && !countryNamed(text, draft.country)) {
      flags.push('no_cue:country');
      unclear.add('country');
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

  // "70% ... and the other half" is more than the whole: the split is asked, never guessed.
  let mismatch: { pct: number; rest: number } | null = null;
  if (
    draft.sleeves === null &&
    split.mismatch &&
    split.pairs.length === 0 &&
    !('sleeves' in answers)
  ) {
    flags.push('split_mismatch');
    unclear.add('sleeves');
    mismatch = { pct: split.mismatch.pct, rest: 100 - split.mismatch.pct };
  }
  if (maxYieldAskedIn(text)) flags.push('max_yield_asked');

  const language: Language =
    answers.language ?? draft.language ?? input.language ?? rules.language ?? 'en';
  const P = PERSONAL_PARAMS;
  // A country no person lives in ("ZZ") is never taken, from the text or an answer: it is asked.
  for (const where of ['draft', 'answer'] as const) {
    const code = where === 'draft' ? draft.country : answers.country;
    if (code && !isCountryCode(code)) {
      flags.push(`not_a_country:${where}`);
      unclear.add('country');
    }
  }
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
    country: answers.country ?? draft.country,
    currency: answers.currency ?? draft.currency,
    themes: answers.themes ?? draft.themes,
  };
  if (value.country !== null && !isCountryCode(value.country)) value.country = null;
  const sleeves = answers.sleeves ?? draft.sleeves;
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
      !(field === 'country' && value.country === null)
    )
      return false;
    switch (field) {
      case 'goal':
      case 'amountUsd':
      case 'risk':
        return value[field] === null || unclear.has(field);
      case 'horizonMonths':
        return !horizonOpen && (value[field] === null || unclear.has(field));
      // Always asked when not given (Oct 6): some assets aren't offered everywhere, or to everyone.
      case 'country':
        return value[field] === null || unclear.has(field);
      case 'sleeves':
        return unclear.has(field);
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
    return { id: field, params: {} };
  };
  const questions: IntakeQuestion[] = QUESTION_FIELDS.filter(needed).map((field) =>
    question(field, language, templateOf(field), readOf(field, value)),
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
      country: value.country,
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
            questions.push(question(f, language, templateOf(f), readOf(f, value)));
        }
      }
  }

  // What was assumed from the person's words, said so they can correct it.
  const assumptions: string[] = [];
  const assume = (id: AssumptionId, params: Record<string, Value> = {}) =>
    assumptions.push(render(ASSUMPTION_TEMPLATES[id][language], params, language));
  const loose =
    answers.risk === undefined && value.risk !== null ? looseRiskWordsIn(text, value.risk) : null;
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
  if (sheet && !sheet.rules.glide && !horizonOpen && answers.rules === undefined)
    assume('GLIDE_OFFER');

  const said = sheet ? readBack(sheet, portfolios) : null;
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
  };
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
  Exclude<QuestionField, 'chains' | 'sleeves'>,
  string | number | string[] | null | undefined
>;
function readOf(field: QuestionField, value: Values): IntakeQuestion['read'] {
  if (field === 'chains' || field === 'sleeves') return undefined;
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
