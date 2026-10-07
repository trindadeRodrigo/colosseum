import { BasketSheet, BasketSheetDraft, Language } from '@colosseum/schemas';
import { type ApiFetch, signInRefusal } from '../account/person';
import { GOAL_TEXT } from '../goal/read-goal';

// The guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7), as the Invest screen calls it:
//
//   POST /v1/baskets/intake   (signed in)
//   body  { text, language?, followUps?, answers?, answersThen? }
//   200   { reader, language, draft, questions, sheet, readBack, assumptions, mix, narratives, … }
//
// The person sends the text of their goal; each later turn sends the same text with their own later
// words (`followUps`), their answers by field (`answers`, from a tap on a fact or a quick reply), and
// the answers as they stood when each later message was sent (`answersThen`). The answer is what was
// read, one question per field still open or unclear, in the person's language from fixed
// templates, and once none is left the sheet the plan will be made from and its read-back, sentence
// by sentence. The person's confirm sends that sheet, as it came, to `POST /v1/baskets/personalize`:
// the web never builds one of its own. The route's types are the engine's, which the web does not
// import (tests/boundaries.test.ts), so the part read here is checked here.

export const INTAKE_PATH = '/v1/baskets/intake';
/** The most later messages the route takes (`IntakeRequest.followUps`). */
export const MAX_FOLLOW_UPS = 10;

/** The fields a question can be about (the engine's `QUESTION_FIELDS`). */
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

export type IntakeQuestion = {
  field: QuestionField;
  template: string;
  /** The question, in the person's language, from the server's fixed templates. */
  text: string;
  /** The choices, for a field that has a fixed set. */
  options?: string[];
  /**
   * What the text was read as, where it was read and our server asks to be sure: a value of the
   * field, offered as the first reply. A mix read this way is not kept: the person says it.
   */
  read?: string | number;
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
  return {
    field: q.field as QuestionField,
    template: q.template,
    text: q.text,
    ...(q.options ? { options: q.options as string[] } : {}),
    ...(isText(q.read) || (typeof q.read === 'number' && Number.isFinite(q.read))
      ? { read: q.read }
      : {}),
  };
}

/**
 * The answers this screen sends, by field: a quick reply or a tap on a fact. Each is held to the
 * sheet's own schema. What a person says in words (a mix, a theme, a refusal) goes in `followUps`.
 */
export const IntakeAnswers = BasketSheet.pick({
  goal: true,
  amountUsd: true,
  incomeTargetUsdMonthly: true,
  horizonMonths: true,
  horizonOpen: true,
  risk: true,
  currency: true,
})
  .partial()
  .strict();
export type IntakeAnswers = ReturnType<typeof IntakeAnswers.parse>;

/** The sheet the person confirms: the shared sheet, and whatever else the server put on it. */
const ConfirmedSheet = BasketSheet.loose();

/** What the person said to hold (gate EXPLICIT-MIX), as shares of the whole plan in basis points. */
export type HeldMix = {
  growthBps: number;
  dollarYieldBps: number;
  goldBps: number;
  cashBps: number;
};
const MIX_KEYS = ['growthBps', 'dollarYieldBps', 'goldBps', 'cashBps'] as const;

function mixOf(v: unknown): HeldMix | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const share = (x: unknown) =>
    typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 10_000;
  if (!MIX_KEYS.every((key) => share(m[key]))) return undefined;
  const mix = Object.fromEntries(MIX_KEYS.map((key) => [key, m[key]])) as HeldMix;
  return MIX_KEYS.reduce((n, key) => n + mix[key], 0) === 10_000 ? mix : undefined;
}

/** A market or theme the text asks for, and what code read it to on the person's chain. */
type Narrative = { kind: string; slug: string | null; name: string | null };

function narrativeOf(v: unknown): Narrative | null {
  if (typeof v !== 'object' || v === null) return null;
  const n = v as Record<string, unknown>;
  if (!['portfolio', 'label', 'matched', 'none'].includes(n.kind as string)) return null;
  if (!(n.slug === null || isText(n.slug)) || !(n.name === null || isText(n.name))) return null;
  return { kind: n.kind as string, slug: n.slug as string | null, name: n.name as string | null };
}

/** A theme the plan holds: its name as the server says it, and its share where it is a sleeve. */
export type HeldTheme = { name: string; shareBps: number | null };

export type IntakeReading = {
  reader: { method: 'model' | 'rules'; why: string | null };
  language: Language;
  /** What the text says after the server's checks: every field null that it does not say. */
  draft: BasketSheetDraft;
  questions: IntakeQuestion[];
  /** The sheet as the server sent it, to send back unchanged; null while anything is left to ask. */
  sheet: BasketSheet | null;
  /** What was understood, sentence by sentence, from the server's templates. */
  readBack: string[] | null;
  /** What was assumed from the person's words, from the server's templates. */
  assumptions: string[];
  mix: HeldMix | null;
  themes: HeldTheme[];
};

/** The themes the sheet holds, by the name the server gave each: a sleeve's share from the sheet. */
function themesOf(narratives: Narrative[], sheet: BasketSheet | null): HeldTheme[] {
  return narratives.flatMap((n) => {
    if (n.kind === 'none' || n.name === null) return [];
    const sleeve = sheet?.sleeves?.find((s) => s.kind === 'theme' && s.theme === n.slug);
    return [{ name: n.name, shareBps: sleeve ? sleeve.shareBps : null }];
  });
}

/** The route's answer, the parts the screen reads; null when it is not in that shape. */
function answerOf(body: unknown): IntakeReading | null {
  if (typeof body !== 'object' || body === null) return null;
  const a = body as Record<string, unknown>;
  const reader = (a.reader ?? null) as Record<string, unknown> | null;
  if (!reader || (reader.method !== 'model' && reader.method !== 'rules')) return null;
  const language = Language.safeParse(a.language);
  const draft = BasketSheetDraft.safeParse(a.draft);
  if (!language.success || !draft.success || !Array.isArray(a.questions)) return null;
  const questions = a.questions.map(questionOf);
  if (questions.some((q) => q === null)) return null;
  const sheet = a.sheet === null ? null : ConfirmedSheet.safeParse(a.sheet);
  if (sheet && !sheet.success) return null;
  const readBack = a.readBack;
  if (!(readBack === null || (Array.isArray(readBack) && readBack.every(isText)))) return null;
  const assumptions = a.assumptions ?? [];
  if (!Array.isArray(assumptions) || !assumptions.every(isText)) return null;
  const mix = mixOf(a.mix);
  const narratives = Array.isArray(a.narratives ?? []) ? (a.narratives ?? []) : null;
  const read = (narratives as unknown[] | null)?.map(narrativeOf) ?? null;
  if (mix === undefined || read === null || read.some((n) => n === null)) return null;
  // A sheet is confirmed only with nothing left to ask and its read-back beside it.
  const whole = sheet !== null && questions.length === 0 && readBack !== null;
  const confirmed = whole ? (sheet.data as BasketSheet) : null;
  return {
    reader: { method: reader.method, why: isText(reader.why) ? reader.why : null },
    language: language.data,
    draft: draft.data,
    questions: questions as IntakeQuestion[],
    sheet: confirmed,
    readBack: whole ? (readBack as string[]) : null,
    assumptions,
    mix,
    themes: themesOf(read as Narrative[], confirmed),
  };
}

export type IntakeOutcome =
  | { kind: 'read'; reading: IntakeReading }
  /** The text is outside what the reader takes: it is not sent. */
  | { kind: 'too_short' | 'too_long' }
  /** The route is not there, or this person may not use it: another reader reads the goal. */
  | { kind: 'unavailable' | 'signed-out' | 'no-identity' }
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
  answersThen: IntakeAnswers[];
  /** The answer to what is held, by a press: a mix, or null for none. Left out: not answered. */
  mix?: HeldMix | null;
  /**
   * What our server's own sheet already held when earlier messages were left out of the request: its
   * fields, as it sent them, under the answers. Nothing in it is this app's or the person's typing.
   */
  base?: Record<string, unknown>;
};

/** The fields of a confirmed sheet that the route takes back as answers. */
const BASE_KEYS = [
  'goal',
  'amountUsd',
  'incomeTargetUsdMonthly',
  'horizonMonths',
  'horizonOpen',
  'risk',
  'currency',
  'themes',
  'obligations',
  'sleeves',
  'limits',
  'mix',
] as const;

/** What a confirmed sheet holds, as answers: sent in place of the messages it was read from. */
export function baseOf(sheet: BasketSheet): Record<string, unknown> {
  const from = sheet as unknown as Record<string, unknown>;
  return Object.fromEntries(
    BASE_KEYS.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]),
  );
}

export async function readIntake(apiFetch: ApiFetch, ask: IntakeRequest): Promise<IntakeOutcome> {
  const text = ask.text.trim();
  if (text.length < GOAL_TEXT.min) return { kind: 'too_short' };
  if (text.length > GOAL_TEXT.max) return { kind: 'too_long' };
  // Only answers the sheet's schema takes are sent: a tap can hold nothing else.
  const answers = IntakeAnswers.safeParse(ask.answers);
  const then = IntakeAnswers.array().safeParse(ask.answersThen);
  // a mix is sent only as one: four shares that add up to the whole, or none
  const held = ask.mix === undefined ? undefined : mixOf(ask.mix);
  if (!answers.success || !then.success || (ask.mix !== undefined && held === undefined))
    return { kind: 'refused' };
  let res: Response;
  try {
    res = await apiFetch(INTAKE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        language: ask.language,
        ...(ask.followUps.length > 0 ? { followUps: ask.followUps, answersThen: then.data } : {}),
        ...(Object.keys(answers.data).length > 0 || held !== undefined || ask.base
          ? {
              answers: {
                ...ask.base,
                ...answers.data,
                ...(held !== undefined ? { mix: held } : {}),
              },
            }
          : {}),
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
  const reading = answerOf(await res.json().catch(() => null));
  return reading ? { kind: 'read', reading } : { kind: 'unreadable' };
}
