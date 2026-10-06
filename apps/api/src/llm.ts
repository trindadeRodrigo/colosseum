import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { EnvLike, Language } from '@colosseum/schemas';

// The model behind the guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7): Claude Haiku 4.5 on
// Anthropic's Messages API with structured outputs. It reads a goal into fields and says which it could
// not read. It never sets a weight, picks an asset or states a figure: what it answers is checked in
// pure code (`runIntake` in @colosseum/engine/personal), and the questions and the read-back come from
// templates. Shared portfolio names never reach it.
//
// The call has a 6-second timeout and no retry, a daily budget of calls for everyone and one per
// person, and a cache by text: the same
// goal is read once, so it gives one sheet however often it is sent. With no key, past the budget, on a
// timeout or on any error, it answers null and the intake falls back to the rules parser. It never
// throws to the route.

export const INTAKE_MODEL_ID = 'claude-haiku-4-5';
export const INTAKE_TIMEOUT_MS = 6_000;
/** Calls a day, by default. At about $0.002 a read (DESIGN-VAULT section 7) this is about $2 a day. */
export const INTAKE_DAILY_CALLS = 1_000;
/**
 * Calls a day for one person, by default, on top of the budget above: one account sending varied
 * text cannot spend the day's budget for everyone.
 */
export const INTAKE_DAILY_CALLS_PER_PERSON = 30;
const CACHE_SIZE = 5_000;

/** What the model is asked for: the goal's fields as written, every one nullable. */
export const INTAKE_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'goal',
    'amountUsd',
    'incomeTargetUsdMonthly',
    'horizonMonths',
    'risk',
    'currency',
    'country',
    'chain',
    'portfolios',
    'language',
    'noCredit',
    'cannotHold',
    'unclear',
  ],
  properties: {
    goal: { anyOf: [{ type: 'string', enum: ['grow', 'income', 'protect'] }, { type: 'null' }] },
    amountUsd: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    incomeTargetUsdMonthly: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    horizonMonths: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    risk: { anyOf: [{ type: 'string', enum: ['low', 'medium', 'high'] }, { type: 'null' }] },
    currency: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    country: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    chain: {
      anyOf: [{ type: 'string', enum: ['solana', 'base', 'robinhood'] }, { type: 'null' }],
    },
    portfolios: { type: 'array', items: { type: 'string' } },
    language: { anyOf: [{ type: 'string', enum: ['en', 'pt'] }, { type: 'null' }] },
    noCredit: { type: 'boolean' },
    cannotHold: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['stock', 'etf', 'gold', 'commodity', 'dollar_yield', 'crypto'],
      },
    },
    unclear: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'goal',
          'amountUsd',
          'incomeTargetUsdMonthly',
          'horizonMonths',
          'risk',
          'country',
          'currency',
          'themes',
        ],
      },
    },
  },
} as const;

const SYSTEM = [
  "You read one person's financial goal, written in English or Portuguese, into fields. You are a reader, not an adviser.",
  'Fill a field only with what the text says. When the text does not say it, give null. Never guess, never pick a value for the person, never suggest anything.',
  'goal: grow (make the money grow), income (earn a monthly income from it) or protect (keep it safe). risk: low, medium or high, only as the person says it ("conservative" is low, "aggressive" is high).',
  'amountUsd: the money the person puts in, as written, only when it is in dollars or has no currency; a sum in another currency is null and its currency goes in currency. incomeTargetUsdMonthly: the income a month the person wants, in dollars. Do not convert currencies.',
  'horizonMonths: the time frame in months (years times 12; "by YEAR" counts to January of that year from the current month given).',
  'currency: the ISO code of the currency the goal is counted in (USD, BRL, EUR), only when written. country: ISO two-letter code of where the person lives, only when written. chain: a blockchain the person names.',
  'portfolios: the names of shared portfolios the person names ("starting from The Seven"), as written. noCredit: true only if the person rules out credit or lending. cannotHold: classes the person rules out ("no stocks", "sem ações").',
  'language: the language the text is written in. unclear: every field the text mentions in a way you cannot read with confidence.',
].join('\n');

/** What the intake reads with: a model, or nothing. Tests hand in a replay of recorded replies. */
export type IntakeModel = {
  id: string;
  /** `live` for Anthropic's API; `mock` for a replay (labelled so in every answer). */
  provenance: 'live' | 'mock';
  /**
   * The reply as it came, or null with why there is none. Never throws. `who` is the person asking,
   * whose own daily budget the call counts against.
   */
  read(
    text: string,
    nowMonth: string,
    language: Language | undefined,
    who: string,
  ): Promise<{ reply: unknown } | { reply: null; why: string }>;
};

/** The raw call: one request, the reply's JSON or a reason. */
export type ReadCall = (
  text: string,
  nowMonth: string,
  language?: Language,
) => Promise<{ reply: unknown } | { reply: null; why: string }>;

/** Claude Haiku 4.5 over Anthropic's Messages API, with structured outputs. */
export function anthropicCall(apiKey: string): ReadCall {
  const client = new Anthropic({ apiKey, timeout: INTAKE_TIMEOUT_MS, maxRetries: 0 });
  return async (text, nowMonth, language) => {
    try {
      const response = await client.messages.create({
        model: INTAKE_MODEL_ID,
        max_tokens: 1_024,
        temperature: 0,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Current month: ${nowMonth}.${language ? ` Page language: ${language}.` : ''}\n\nThe goal:\n${text}`,
          },
        ],
        output_config: { format: { type: 'json_schema', schema: INTAKE_REPLY_SCHEMA } },
      });
      if (response.stop_reason === 'refusal') return { reply: null, why: 'model_refused' };
      if (response.stop_reason === 'max_tokens') return { reply: null, why: 'model_cut_off' };
      const block = response.content.find((b) => b.type === 'text');
      if (block?.type !== 'text') return { reply: null, why: 'model_no_text' };
      try {
        return { reply: JSON.parse(block.text) as unknown };
      } catch {
        return { reply: null, why: 'model_not_json' };
      }
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError)
        return { reply: null, why: 'model_timeout' };
      if (err instanceof Anthropic.RateLimitError)
        return { reply: null, why: 'model_rate_limited' };
      if (err instanceof Anthropic.AuthenticationError)
        return { reply: null, why: 'model_not_authorized' };
      if (err instanceof Anthropic.APIError) return { reply: null, why: 'model_error' };
      return { reply: null, why: 'model_unreachable' };
    }
  };
}

/** The same text, page language and month read once: the key the cache keeps a reply under. */
const keyOf = (text: string, nowMonth: string, language?: Language) =>
  createHash('sha256')
    .update(JSON.stringify([text.trim().replace(/\s+/g, ' '), nowMonth, language ?? null]))
    .digest('hex');

/**
 * A model with the daily budgets and the cache around a call. A reply is kept by its text, so the same
 * goal gives one sheet. A failed call is not kept, so it is tried again next time: after a failure a
 * later turn may get a model reply, and the draft can change then (the answer's `reader` says which
 * read it each time). A call counts against the day's budget for everyone and against the asking
 * person's own (by `who`); a reply from the cache counts against neither. `now` dates the day (UTC).
 */
export function budgetedModel(
  call: ReadCall,
  opts: {
    id?: string;
    provenance?: 'live' | 'mock';
    dailyCalls?: number;
    dailyCallsPerPerson?: number;
    now?: () => Date;
  } = {},
): IntakeModel {
  const dailyCalls = opts.dailyCalls ?? INTAKE_DAILY_CALLS;
  const perPerson = opts.dailyCallsPerPerson ?? INTAKE_DAILY_CALLS_PER_PERSON;
  const now = opts.now ?? (() => new Date());
  const cache = new Map<string, unknown>();
  let day = '';
  let used = 0;
  const usedBy = new Map<string, number>();
  return {
    id: opts.id ?? INTAKE_MODEL_ID,
    provenance: opts.provenance ?? 'live',
    async read(text, nowMonth, language, who) {
      const key = keyOf(text, nowMonth, language);
      if (cache.has(key)) return { reply: cache.get(key) };
      const today = now().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        used = 0;
        usedBy.clear();
      }
      const mine = usedBy.get(who) ?? 0;
      if (mine >= perPerson) return { reply: null, why: 'model_person_budget_spent' };
      if (used >= dailyCalls) return { reply: null, why: 'model_budget_spent' };
      used += 1;
      usedBy.set(who, mine + 1);
      const answer = await call(text, nowMonth, language);
      if (answer.reply !== null) {
        if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
        cache.set(key, answer.reply);
      }
      return answer;
    },
  };
}

/**
 * The model the server runs with: Anthropic's, when `ANTHROPIC_API_KEY` is set, with the budgets from
 * `INTAKE_MODEL_DAILY_CALLS` (everyone) and `INTAKE_MODEL_DAILY_CALLS_PER_PERSON` (one person). Null when no key is set: the intake reads with the rules parser alone.
 */
export function intakeModelFromEnv(env: EnvLike, now?: () => Date): IntakeModel | null {
  // As written: keys are case-sensitive.
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const count = (value: string | undefined, fallback: number) => {
    const n = Number(value ?? fallback);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return budgetedModel(anthropicCall(key), {
    dailyCalls: count(env.INTAKE_MODEL_DAILY_CALLS, INTAKE_DAILY_CALLS),
    dailyCallsPerPerson: count(
      env.INTAKE_MODEL_DAILY_CALLS_PER_PERSON,
      INTAKE_DAILY_CALLS_PER_PERSON,
    ),
    now,
  });
}
