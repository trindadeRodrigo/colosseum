import { BasketSheet, Language } from '@colosseum/schemas';
import { type ApiFetch, signInRefusal } from '../account/person';
import { GOAL_TEXT } from './read-goal';

// The guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7), the one reader of the goal screen:
//
//   POST /v1/baskets/intake   (signed in)
//   body  { text, language?, followUps?, answers? }
//   200   { reader, language, draft, questions, sheet, readBack, assumptions, … }
//
// The person sends the text of their goal; each later turn sends the same text with their own later
// words (`followUps`) and their answers to the questions so far (`answers`, by field, from the form).
// The answer is what was read, one question per field still open or unclear, in the person's
// language from fixed templates, and once none is left the sheet the plan will be made from and its
// read-back, sentence by sentence. The person's confirm sends that sheet, as it came, to
// `POST /v1/baskets/personalize`: the web never builds one of its own. The route's types are the
// engine's, which the web does not import (tests/boundaries.test.ts), so the part read here is
// checked here.

export const INTAKE_PATH = '/v1/baskets/intake';

/** The fields a question can be about (the engine's `QUESTION_FIELDS`). */
export const QUESTION_FIELDS = [
  'goal',
  'amountUsd',
  'sleeves',
  'incomeTargetUsdMonthly',
  'horizonMonths',
  'risk',
  'currency',
  'themes',
  'chains',
] as const;
export type QuestionField = (typeof QUESTION_FIELDS)[number];

export type IntakeQuestion = {
  field: QuestionField;
  template: string;
  text: string;
  /** The choices, for a field that has a fixed set. */
  options?: string[];
  /** What the text was read as, when it was read and is unclear: the form starts from it. */
  read?: string | number | string[];
};

const isText = (v: unknown): v is string => typeof v === 'string';

/** A question as the route sends it, or null for anything else. */
function questionOf(v: unknown): IntakeQuestion | null {
  if (typeof v !== 'object' || v === null) return null;
  const q = v as Record<string, unknown>;
  if (!(QUESTION_FIELDS as readonly unknown[]).includes(q.field)) return null;
  if (!isText(q.template) || !isText(q.text) || q.text.trim() === '') return null;
  if (q.options !== undefined && !(Array.isArray(q.options) && q.options.every(isText)))
    return null;
  const read = q.read;
  const readOk =
    read === undefined ||
    isText(read) ||
    (typeof read === 'number' && Number.isFinite(read)) ||
    (Array.isArray(read) && read.every(isText));
  if (!readOk) return null;
  return {
    field: q.field as QuestionField,
    template: q.template,
    text: q.text,
    ...(q.options ? { options: q.options as string[] } : {}),
    ...(read !== undefined ? { read: read as IntakeQuestion['read'] } : {}),
  };
}

/** The answers the form sends, by field: each held to the sheet's own schema. */
export const IntakeAnswers = BasketSheet.pick({
  goal: true,
  amountUsd: true,
  incomeTargetUsdMonthly: true,
  horizonMonths: true,
  horizonOpen: true,
  risk: true,
  currency: true,
  themes: true,
  obligations: true,
})
  .partial()
  .strict();
export type IntakeAnswers = ReturnType<typeof IntakeAnswers.parse>;

/** The sheet the person confirms: the shared sheet, and whatever else the server put on it (limits). */
const ConfirmedSheet = BasketSheet.loose();

export type IntakeReading = {
  reader: {
    method: 'model' | 'rules';
    model: string | null;
    provenance: 'live' | 'mock' | null;
  };
  language: Language;
  questions: IntakeQuestion[];
  /** The sheet as the server sent it, to send back unchanged; null while anything is left to ask. */
  sheet: BasketSheet | null;
  /** What was understood, sentence by sentence, the last one asking to confirm. */
  readBack: string[] | null;
};

/** The route's answer, the parts the screen reads; null when it is not in that shape. */
function answerOf(body: unknown):
  | (Omit<IntakeReading, 'sheet' | 'readBack'> & {
      sheet: BasketSheet | null;
      readBack: string[] | null;
    })
  | null {
  if (typeof body !== 'object' || body === null) return null;
  const a = body as Record<string, unknown>;
  const reader = (a.reader ?? null) as Record<string, unknown> | null;
  if (
    !reader ||
    (reader.method !== 'model' && reader.method !== 'rules') ||
    !(reader.model === null || isText(reader.model)) ||
    !(reader.provenance === null || reader.provenance === 'live' || reader.provenance === 'mock')
  )
    return null;
  const language = Language.safeParse(a.language);
  if (!language.success || !Array.isArray(a.questions)) return null;
  const questions = a.questions.map(questionOf);
  if (questions.some((q) => q === null)) return null;
  const sheet = a.sheet === null ? null : ConfirmedSheet.safeParse(a.sheet);
  if (sheet && !sheet.success) return null;
  const readBack = a.readBack;
  if (!(readBack === null || (Array.isArray(readBack) && readBack.every(isText)))) return null;
  return {
    reader: {
      method: reader.method,
      model: reader.model as string | null,
      provenance: reader.provenance as 'live' | 'mock' | null,
    },
    language: language.data,
    questions: questions as IntakeQuestion[],
    sheet: sheet ? (sheet.data as BasketSheet) : null,
    readBack: readBack as string[] | null,
  };
}

export type IntakeOutcome =
  | { kind: 'read'; reading: IntakeReading }
  /** The text is outside what the reader takes: it is not sent. */
  | { kind: 'too_short' | 'too_long' }
  /** The route is not there: the API this app talks to has no intake yet. */
  | { kind: 'unavailable' }
  /** The server does not know this sign-in (401 or 403): sign in. */
  | { kind: 'signed-out' }
  /** The server was sent no identity token (401): the sign-in service did not give one. */
  | { kind: 'no-identity' }
  /** The server refused what was sent (400): an answer it does not take. */
  | { kind: 'refused' }
  | { kind: 'busy' }
  | { kind: 'unreachable' }
  | { kind: 'unreadable' };

export type IntakeRequest = {
  text: string;
  language: Language;
  followUps: string[];
  answers: IntakeAnswers;
};

export async function readIntake(apiFetch: ApiFetch, ask: IntakeRequest): Promise<IntakeOutcome> {
  const text = ask.text.trim();
  if (text.length < GOAL_TEXT.min) return { kind: 'too_short' };
  if (text.length > GOAL_TEXT.max) return { kind: 'too_long' };
  // Only answers the sheet's schema takes are sent: a form can hold nothing else.
  const answers = IntakeAnswers.safeParse(ask.answers);
  if (!answers.success) return { kind: 'refused' };
  let res: Response;
  try {
    res = await apiFetch(INTAKE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        language: ask.language,
        ...(ask.followUps.length > 0 ? { followUps: ask.followUps } : {}),
        ...(Object.keys(answers.data).length > 0 ? { answers: answers.data } : {}),
      }),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501)
    return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'busy' };
  if (res.status === 401 && (await signInRefusal(res)) === 'no_identity')
    return { kind: 'no-identity' };
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (res.status >= 400 && res.status < 500) return { kind: 'refused' };
  if (!res.ok) return { kind: 'unreachable' };
  const body = answerOf(await res.json().catch(() => null));
  if (!body) return { kind: 'unreadable' };
  const { sheet, readBack, questions } = body;
  // A sheet is confirmed only with nothing left to ask and its read-back beside it.
  const whole = sheet !== null && questions.length === 0 && readBack !== null;
  return {
    kind: 'read',
    reading: {
      reader: body.reader,
      language: body.language,
      questions,
      sheet: whole ? sheet : null,
      readBack: whole ? readBack : null,
    },
  };
}
