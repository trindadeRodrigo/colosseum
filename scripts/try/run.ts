import {
  type ComposeContext,
  candidates,
  compose,
  type IntakeResult,
  type PersonalCandidates,
  PersonalInputError,
  type PersonalProposal,
  type QuestionField,
  runIntake,
} from '@colosseum/engine/personal';
import { currencyOf, type Language } from '@colosseum/schemas';
import type { IntakeModel } from '../../apps/api/src/llm';
import type { DataSource } from './data';
import type { PromptGoal } from './prompt-file';

// One goal through the real pipeline, as the API runs it: the intake (the model when one is given,
// else the rules parser), the file's answers through the same `runIntake` the route calls, and once
// the sheet is whole, `candidates()` and `compose` for the plain plan, on the chain's shelf and figures.

/** The key to write under `answers` for each field the intake may ask about. */
export const ANSWER_KEY: Record<QuestionField, string> = {
  goal: 'goal',
  amountUsd: 'amount',
  sleeves: 'sleeves',
  incomeTargetUsdMonthly: 'income',
  horizonMonths: 'horizon',
  risk: 'risk',
  country: 'country',
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
  /** The symbol of each token on the chain's shelf, by asset id. */
  symbols: Record<string, string>;
};

export type RunOptions = {
  data: DataSource;
  model: IntakeModel | null;
  /** The time the plans are made at; the intake counts "by 2031" from its month. */
  now: Date;
  /** Who the model's per-person budget counts against. */
  who?: string;
};

export async function runGoal(goal: PromptGoal, opts: RunOptions): Promise<GoalRun> {
  const nowIso = opts.now.toISOString();
  const nowMonth = nowIso.slice(0, 7);
  const data = await opts.data.forChain(goal.chain);
  const language: Language | undefined = goal.answers.language;
  // A reply pasted in the file (a model run outside this tool) is read as the model's, and checked
  // the same way; it is never live, so it is labelled mock.
  const read = goal.reply
    ? { reply: goal.reply.value }
    : opts.model
      ? await opts.model.read(goal.text, nowMonth, language, opts.who ?? 'plan-playground')
      : { reply: null, why: 'model_not_configured' };
  const intake = runIntake({
    text: goal.text,
    nowMonth,
    ...(language ? { language } : {}),
    reply: read.reply,
    answers: goal.answers,
    homeChain: goal.chain,
    portfolios: data.portfolios,
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
  return { goal, reader, intake, open, plain, made, error, sources: data.sources, symbols };
}
