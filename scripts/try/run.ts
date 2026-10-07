import {
  attributeVocabularyOf,
  type ComposeContext,
  candidates,
  companyNamesOf,
  compose,
  filterMatchOf,
  type IntakeResult,
  type PersonalCandidates,
  PersonalInputError,
  type PersonalProposal,
  type QuestionField,
  riskForMix,
  riskForMixEstimate,
  riskForSleeves,
  runIntake,
  type ShelfLabel,
  type ShelfPortfolio,
} from '@colosseum/engine/personal';
import { currencyOf, type Language } from '@colosseum/schemas';
import type { IntakeModel } from '../../apps/api/src/llm';
import type { DataSource, LeftOffPlans } from './data';
import type { PromptGoal } from './prompt-file';

// One goal through the real pipeline, as the API runs it: the intake (the model when one is given,
// else the rules parser), the file's answers through the same `runIntake` the route calls, and once
// the sheet is whole, `candidates()` and `compose` for the plain plan, on the chain's shelf and figures.

/** The messages of a prompt file the answers are said to stand for: more than the intake reads one by one. */
const ANSWERS_THEN = 12;

/** The key to write under `answers` for each field the intake may ask about. */
export const ANSWER_KEY: Record<QuestionField, string> = {
  goal: 'goal',
  amountUsd: 'amount',
  sleeves: 'sleeves',
  mix: 'mix',
  limits: 'limits',
  incomeTargetUsdMonthly: 'income',
  horizonMonths: 'horizon',
  risk: 'risk',
  currency: 'currency',
  themes: 'themes',
  chains: 'chain',
};

export type Reader = {
  method: 'model' | 'rules';
  /** The model's id, when a model read the goal. */
  model: string | null;
  provenance: 'live' | 'mock' | null;
  /** Why no model read it: `model_not_configured`, `model_timeout`, ... */
  why: string | null;
};

export type GoalRun = {
  goal: PromptGoal;
  reader: Reader;
  intake: IntakeResult;
  /** The questions left open, each with the key to answer it under. */
  open: { field: QuestionField; key: string; text: string; options?: string[]; read?: unknown }[];
  plain: PersonalProposal | null;
  made: PersonalCandidates | null;
  /** Why no plan was made from a whole sheet: the engine's own words. */
  error: string | null;
  sources: string[];
  /** What the chain's shelf lists and leaves out of every plan, each with its reason. */
  heldOut: LeftOffPlans[];
  /** The symbol of each token on the chain's shelf, by asset id. */
  symbols: Record<string, string>;
  /**
   * What the chain's shelf can hold for a narrative: its shared portfolios, its curated labels (each
   * with its status and how many of its names the shelf lists), and the keywords a filter can match by.
   */
  offers: { portfolios: ShelfPortfolio[]; labels: ShelfLabel[]; keywords: string[] };
};

export type RunOptions = {
  data: DataSource;
  model: IntakeModel | null;
  /** The time the plans are made at; the intake counts "by 2031" from its month. */
  now: Date;
  /** Who the model's per-person budget counts against. */
  who?: string;
};

/**
 * The amount the engine is asked the risk of a mix or of theme sleeves at, while the person has not
 * given theirs yet. Not a figure of the plan: once the amount is known, the person's own is used.
 */
const RISK_PROBE_USD = 10_000;

export async function runGoal(goal: PromptGoal, opts: RunOptions): Promise<GoalRun> {
  const nowIso = opts.now.toISOString();
  const nowMonth = nowIso.slice(0, 7);
  const data = await opts.data.forChain(goal.chain);
  const language: Language | undefined = goal.answers.language;
  // What a model is shown to name a filter by: our own keywords, never a symbol or a company's name,
  // and no name of the stock classification (DESIGN-VAULT section 17, item 30).
  const keywords = attributeVocabularyOf(data.stocks).keywords;
  const vocabulary = data.stocks
    ? { sectors: [], industries: [], subIndustries: [], keywords }
    : undefined;
  // A reply pasted in the file (a model run outside this tool) is read as the model's, and checked
  // the same way; it is never live, so it is labelled mock.
  const read = goal.reply
    ? { reply: goal.reply.value }
    : opts.model
      ? await opts.model.read(
          goal.text,
          nowMonth,
          language,
          opts.who ?? 'plan-playground',
          vocabulary,
        )
      : { reply: null, why: 'model_not_configured' };
  // What the read-back's risk is found on: this chain's shelf and figures, at the time of the run.
  const shelfNow: ComposeContext = { ...data.context, now: nowIso };
  /**
   * The sheet the engine is asked the risk of: what is held, the shared portfolios read and the
   * chain, with no date, withdrawal or holding in the way. The amount is the person's where the
   * intake knows it (the engine's rule depends on it); before they have given one, a fixed
   * `RISK_PROBE_USD` stands in.
   */
  const probe = (themes: string[], amountUsd: number | undefined) => ({
    basketType: 'standard' as const,
    goal: 'grow' as const,
    amountUsd: amountUsd ?? RISK_PROBE_USD,
    horizonMonths: 120,
    risk: 'low' as const,
    themes,
    chains: [goal.chain],
    rules: { useHoldings: false, glide: false },
    language: 'en' as const,
  });
  const intake = runIntake({
    text: goal.text,
    nowMonth,
    ...(language ? { language } : {}),
    reply: read.reply,
    answers: goal.answers,
    // A prompt file is one conversation written whole: its answers stand for every message of it,
    // so a plain yes or no in the text is read with them (`IntakeInput.answersThen`).
    answersThen: Array.from({ length: ANSWERS_THEN }, () => goal.answers),
    homeChain: goal.chain,
    portfolios: data.portfolios,
    // The curated labels of the chain and what a filter matches there (gates THEMES, THEME-MATCHED):
    // pure code over the lists and the sourced attributes, as the API's route hands them.
    labels: data.labels,
    matchOf: (filter) => filterMatchOf(filter, data.stocks, data.shelf.assets),
    // The companies the chain's attributes know: what a name the person rules out is held to.
    names: companyNamesOf(data.stocks),
    // What the chain lists could not be read: nothing is resolved on it (never so with the two
    // sources here; see `ChainData.shelfKnown`).
    ...(data.shelfKnown === false ? { shelfKnown: false } : {}),
    // The read-back names the limits the engine will take for a stated mix: its own rule, on this
    // chain's shelf and the portfolios read, at the person's amount where the intake knows it
    // (gate EXPLICIT-MIX).
    riskOfMix: (mix, themes, amountUsd) =>
      riskForMix({ ...probe(themes, amountUsd), mix }, data.shelf, shelfNow),
    // And the limits a sheet held in themes takes, by the same engine: the lowest risk at which
    // the plan holds the most in its theme sleeves' names. Where the engine cannot make the plan of
    // such a sheet, the intake's estimate on the caps stands.
    riskOfSleeves: (sleeves, themes, amountUsd) => {
      try {
        return riskForSleeves({ ...probe(themes, amountUsd), sleeves }, data.shelf, shelfNow);
      } catch (err) {
        if (!(err instanceof PersonalInputError)) throw err;
        return riskForMixEstimate({
          growthBps: sleeves.reduce((n, x) => (x.kind === 'theme' ? n + x.shareBps : n), 0),
        });
      }
    },
  });
  const pasted = goal.reply !== undefined && read.reply !== null;
  const byModel = read.reply !== null && opts.model !== null && !pasted;
  const reader: Reader = {
    method: intake.method,
    model: pasted
      ? `pasted reply (${goal.reply?.by})`
      : byModel && opts.model
        ? opts.model.id
        : null,
    provenance: pasted ? 'mock' : byModel && opts.model ? opts.model.provenance : null,
    why: 'why' in read && typeof read.why === 'string' ? read.why : null,
  };
  const open = intake.questions.map((q) => ({
    field: q.field,
    key: ANSWER_KEY[q.field],
    text: q.text,
    ...(q.options ? { options: q.options } : {}),
    ...(q.read !== undefined ? { read: q.read } : {}),
  }));

  let plain: PersonalProposal | null = null;
  let made: PersonalCandidates | null = null;
  let error: string | null = null;
  if (intake.sheet) {
    const sheet = intake.sheet;
    // An exchange rate is handed in only to a goal that counts or pays in another currency.
    const needsFx =
      currencyOf(sheet) !== 'USD' || (sheet.obligations ?? []).some((o) => o.currency !== 'USD');
    const context: ComposeContext = {
      ...data.context,
      now: nowIso,
      ...(goal.holdings.length ? { holdings: goal.holdings } : {}),
      ...(needsFx && data.fx.length ? { fx: data.fx } : {}),
    };
    try {
      plain = compose(sheet, data.shelf, context);
      made = candidates(sheet, data.shelf, context);
    } catch (e) {
      if (!(e instanceof PersonalInputError)) throw e;
      error = e.message;
    }
  }
  const symbols = Object.fromEntries(data.shelf.assets.map((a) => [a.id, a.symbol]));
  return {
    goal,
    reader,
    intake,
    open,
    plain,
    made,
    error,
    sources: data.sources,
    heldOut: data.heldOut,
    symbols,
    offers: { portfolios: data.portfolios, labels: data.labels, keywords },
  };
}
