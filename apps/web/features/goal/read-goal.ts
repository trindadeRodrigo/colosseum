import { BasketSheetDraft, type Language } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import type { WordField } from './pre-read';

// Reading a typed goal into a draft of the limits. The reader is the API's; what it leaves empty, or
// answers with a default of its own (`readerGuesses`), the words of the goal may fill (pre-read.ts).
//
// What `staging` offers today is POST /goals, the first structurer's reader. It was made for goals in
// reais and answers in its own sheet, so its answer is carried over field by field into the draft of
// the sheet this product uses (`BasketSheetDraft`, every field null when the text did not say). A field
// it has no counterpart for, or filled with a default of its own, is left null: the person fills it.
// When the API serves /v1/baskets/parse, which answers the draft itself, only this file changes.

/** What a reading gives the screen. */
export type GoalReading = {
  draft: BasketSheetDraft;
  /** How it was read, for the sheet's source line. */
  source: { method: string; model?: string; fetchedAt: string; provenance: 'live' };
  /**
   * Read by the first structurer's reader, which was made for goals in reais: the screen says so, so
   * the person knows why a dollar amount was not found.
   */
  firstReader: boolean;
  /** The fields the reader answered with a default of its own, not from the text. */
  guessed: ReadonlySet<WordField>;
};

/** What the reader takes: the API's own bounds on the text of a goal (PostGoalsRequest). */
export const GOAL_TEXT = { min: 3, max: 2000 } as const;

/**
 * Why a reading failed. `too_short` and `too_long`: the text is outside what the reader takes, and
 * it is not sent. `busy`: the API asked for fewer requests. `unreachable`: it did not answer.
 * `unreadable`: it answered in a form this app cannot read, a refusal of the request included.
 */
type ReadFailure = 'too_short' | 'too_long' | 'busy' | 'unreachable' | 'unreadable';

export class ReadGoalError extends Error {
  readonly kind: ReadFailure;
  constructor(kind: ReadFailure) {
    super(kind);
    this.name = 'ReadGoalError';
    this.kind = kind;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const GOAL_OF_PROFILE: Record<string, 'grow' | 'income'> = {
  income: 'income',
  accumulation: 'grow',
  high_risk: 'grow',
};

/**
 * The first structurer's answer as a draft of this product's sheet. Carried over: what the money is
 * for, the time frame, the risk and the language. Not carried over: the amount, which it reads in
 * reais (a conversion would be a figure with no source), and whatever it has no word for.
 */
export function draftFromFirstReader(body: unknown): BasketSheetDraft | null {
  const answer = record(body);
  if (!('candidate' in answer) || !Array.isArray(answer.validationErrors)) return null;
  const read = record(answer.sheet ?? answer.candidate);
  const missed = new Set(answer.validationErrors.map((e) => String(record(e).path ?? '')));
  const horizon = read.horizonMonths;
  const capital = read.initialCapitalUsd;
  const draft = BasketSheetDraft.safeParse({
    basketType: 'standard',
    goal: GOAL_OF_PROFILE[String(read.profile)] ?? null,
    // Dollars it was told outright, never reais converted.
    amountUsd:
      typeof capital === 'number' && capital >= 10 && capital <= 1_000_000 ? capital : null,
    // With no date in the text it answers 36 months of its own: that is not what the person said.
    horizonMonths:
      typeof horizon === 'number' &&
      Number.isInteger(horizon) &&
      horizon >= 1 &&
      horizon <= 480 &&
      !missed.has('target.byMonth')
        ? horizon
        : null,
    risk: ['low', 'medium', 'high'].includes(String(read.riskBudget)) ? read.riskBudget : null,
    themes: null,
    country: null,
    chains: null,
    incomeTargetUsdMonthly: null,
    rules: null,
    language: read.language === 'pt' || read.language === 'en' ? read.language : null,
  });
  return draft.success ? draft.data : null;
}

/**
 * The fields the first structurer's reader answers with a default of its own rather than from the
 * text: "accumulation" for any goal with no monthly figure (and "high_risk" for one that names stocks
 * or risk, which is not a goal), "medium" for any risk (it has no word for medium), and the low risk
 * and the ten years it gives any income. The words of the goal may fill these (pre-read.ts).
 */
export function readerGuesses(body: unknown): Set<WordField> {
  const answer = record(body);
  const read = record(answer.sheet ?? answer.candidate);
  const guessed = new Set<WordField>();
  if (read.profile === 'accumulation' || read.profile === 'high_risk') guessed.add('goal');
  if (read.riskBudget === 'medium') guessed.add('risk');
  if (read.profile === 'income') {
    guessed.add('risk');
    guessed.add('horizonMonths');
  }
  return guessed;
}

/** POST /goals with the text, and the answer as a draft. Throws a `ReadGoalError`. */
export async function readGoal(
  apiFetch: ApiFetch,
  text: string,
  language: Language,
  now: () => Date = () => new Date(),
): Promise<GoalReading> {
  // The reader's own bounds, checked here: each has its own sentence, and neither needs the server.
  if (text.length < GOAL_TEXT.min) throw new ReadGoalError('too_short');
  if (text.length > GOAL_TEXT.max) throw new ReadGoalError('too_long');
  let res: Response;
  try {
    res = await apiFetch('/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language }),
    });
  } catch {
    throw new ReadGoalError('unreachable');
  }
  // A refusal of a text inside the bounds is not about its length: the reason is not guessed.
  if (res.status === 400) throw new ReadGoalError('unreadable');
  if (res.status === 429) throw new ReadGoalError('busy');
  if (!res.ok) throw new ReadGoalError('unreachable');
  const body: unknown = await res.json().catch(() => null);
  const draft = draftFromFirstReader(body);
  if (!draft) throw new ReadGoalError('unreadable');
  const parser = record(record(body).parser);
  return {
    draft,
    source: {
      method: typeof parser.method === 'string' ? parser.method : 'rules',
      model: typeof parser.model === 'string' ? parser.model : undefined,
      fetchedAt: now().toISOString(),
      provenance: 'live',
    },
    firstReader: true,
    guessed: readerGuesses(body),
  };
}
