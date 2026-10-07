import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { MARKET_FILTER_BY, MARKET_IDS } from '@colosseum/engine/personal';
import type { EnvLike, Language } from '@colosseum/schemas';

// The model behind the guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7): Claude Haiku 4.5 on
// Anthropic's Messages API with structured outputs. It reads a goal into fields and says which it could
// not read. It never sets a weight, picks an asset or states a figure: what it answers is checked in
// pure code (`runIntake` in @colosseum/engine/personal), and the questions and the read-back come from
// templates. Shared portfolio names never reach it. A market or an industry the person names is given
// back as an id of a fixed list, or as one attribute and its value (gate THEME-MATCHED): never as a
// company, a ticker or a portfolio. Which stocks carry that attribute is found in code.
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
    'chain',
    'portfolios',
    'language',
    'noCredit',
    'cannotHold',
    'unclear',
    'openEnded',
    'mayNeedInMonths',
    'sleeves',
    'markets',
    'marketFilter',
    'mix',
  ],
  properties: {
    goal: { anyOf: [{ type: 'string', enum: ['grow', 'income', 'protect'] }, { type: 'null' }] },
    amountUsd: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    incomeTargetUsdMonthly: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    horizonMonths: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    risk: { anyOf: [{ type: 'string', enum: ['low', 'medium', 'high'] }, { type: 'null' }] },
    currency: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    chain: {
      anyOf: [{ type: 'string', enum: ['solana', 'base', 'robinhood'] }, { type: 'null' }],
    },
    portfolios: { type: 'array', items: { type: 'string' } },
    // Any language: an ISO 639-1 code (en, pt, es, fr). The intake answers en or pt, and en for others.
    language: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
          'currency',
          'themes',
          'sleeves',
        ],
      },
    },
    openEnded: { type: 'boolean' },
    mayNeedInMonths: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    sleeves: {
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'sharePct'],
            properties: {
              kind: { type: 'string', enum: ['goal', 'safe_yield'] },
              sharePct: { type: 'integer' },
            },
          },
        },
        { type: 'null' },
      ],
    },
    // The narratives the intake has fixed words for: the ids of the engine's own list.
    markets: {
      type: 'array',
      items: { type: 'string', enum: [...MARKET_IDS] },
    },
    // A market, an industry or a business the list above has no value for: one attribute of a stock
    // and the value it must carry, with the person's own words. Never a company, a ticker or a portfolio.
    marketFilter: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['by', 'value', 'words'],
          properties: {
            by: { type: 'string', enum: [...MARKET_FILTER_BY] },
            value: { type: 'string' },
            words: { type: 'string' },
          },
        },
        { type: 'null' },
      ],
    },
    mix: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['growthPct', 'dollarYieldPct', 'goldPct', 'cashPct', 'creditPct'],
          properties: {
            growthPct: { type: 'integer' },
            dollarYieldPct: { type: 'integer' },
            goldPct: { type: 'integer' },
            cashPct: { type: 'integer' },
            creditPct: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

/**
 * What the model is told. It names every id of `markets`, so a narrative added to the engine's list is
 * described here too (`llm.test.ts` holds that).
 */
export const INTAKE_SYSTEM = [
  "You read one person's financial goal into fields. The text may be in any language (English, Portuguese, Spanish, French or another): read it as written, and never translate a value. You are a reader, not an adviser.",
  'Fill a field only with what the text says. When the text does not say it, give null. Never guess, never pick a value for the person, never suggest anything.',
  'goal: grow (make the money grow), income (earn a monthly income from it) or protect (keep it safe). risk: low, medium or high, only as the person says it ("conservative" is low, "aggressive" is high). A mix is not a risk: "all in stocks" gives risk null.',
  'mix: only when the person states what they want held, of the whole money: "all of it in stocks" (growthPct 100), "70% stocks and 30% cash" (growthPct 70, cashPct 30), "only credit" or "only high yield" (dollarYieldPct 100, creditPct 100), "all in gold" (goldPct 100), "tudo em ações". growthPct is stocks and crypto; dollarYieldPct is dollar yield, including credit and bonds; creditPct is the part of dollarYieldPct in credit or high yield, else null. The four add up to 100, each as written. A market or a trend ("big tech", "AI") is not a mix, and a share of the money for one ("put 50% in big tech") is not a mix either. What the person rules out, only asks about, or says of what they or someone else already hold is not stated ("I wouldn\'t put all of it in stocks", "Should I put all of it in stocks?", "I already have everything in stocks at my broker"): null. Nothing stated to hold: null.',
  'markets: markets, industries or trends the person names to invest in, only from this list: big_tech ("big tech", "Magnificent 7", "US tech giants"), us_market ("the S&P", "the US market", "US stocks"), ai ("AI", "artificial intelligence"), semiconductors ("semiconductors", "chips", "chip makers"), ai_infrastructure ("AI infrastructure", "data centers"), crypto_economy ("crypto stocks", "crypto companies"; "crypto" alone is an asset, not this), fintech ("fintech", "brokers"), space ("space stocks", "rockets"), quantum ("quantum computing"), ev_autonomy ("electric vehicles", "EVs", "self-driving"), cloud_software ("cloud", "software", "SaaS"), emerging_markets ("emerging markets", "Asia"), commodities ("commodities", "oil", "silver"; gold is not this: "all in gold" is a mix), broad_market ("index funds", "the whole market"), retail_favourites ("meme stocks"), defense ("defense stocks", "weapons"), health_care ("health care stocks", "pharma", "pharmaceuticals"), social_media ("social media stocks", "social networks"). One the person rules out ("no big tech", "I would never invest in big tech", "anything but AI") or already holds elsewhere ("I already invest in the S&P 500 through my pension") is not named. None: an empty list. Do not name a portfolio, a company or a ticker for them.',
  'marketFilter: only when the person names a market, an industry or a kind of business to invest in that markets has no value for ("obesity drugs", "banks", "insurers"). It names one attribute of a stock and the value it must carry, never a company, a ticker or a portfolio. by is sector, industry or sub_industry, with value its GICS name ("banks" is by industry, value "Banks"; "insurers" is by industry, value "Insurance"; "utilities" is by sector, value "Utilities"), or keyword for a line of business that is none of those ("obesity drugs" is by keyword, value "GLP-1"). When a list of attribute values is given with the goal, take value from that list, as written there, and give null when none of them fits. words: the person\'s own words for it, as written in the text. The person names no such thing, or markets already covers it: null.',
  'amountUsd: the money the person puts in, as written, only when it is in dollars or has no currency; a sum in another currency is null and its currency goes in currency. incomeTargetUsdMonthly: the income a month the person wants, in dollars. Do not convert currencies.',
  'horizonMonths: the time frame of the goal in months (years times 12; "by YEAR" counts to January of that year from the current month given). A time to get the money out is not a time frame: "can take up to 3 months to get out", "I may need it in 3 months" go in mayNeedInMonths when they cover the whole plan, and nowhere when they cover one part; never in horizonMonths.',
  'openEnded: true only when the person says the goal has no date ("no hard cap", "no deadline", "open-ended", "sem prazo"); then horizonMonths is null.',
  'sleeves: when the person splits the money into a part kept safe and easy to take out and a part that seeks a return ("70% safe and liquid, 30% to risk"), two items: kind safe_yield for the safe part and kind goal for the rest, each sharePct as written, adding up to 100. When the shares they write do not add up to 100 ("70% here and the other half there"), give null and put sleeves in unclear. No split: null.',
  'risk with a split: the risk of the goal part ("as low as possible for the 70%, go crazy for the rest" is high). The safe part needs none.',
  "The text may hold several messages: the goal, then the person's answers to questions. Read them together; a later message corrects an earlier one.",
  'currency: the ISO code of the currency the goal is counted in (USD, BRL, EUR), only when written. chain: a blockchain the person names.',
  'portfolios: the names of shared portfolios the person names ("starting from The Seven"), as written in the text: never one the text does not write, whatever it would fit. noCredit: true only if the person rules out credit or lending. cannotHold: classes the person rules out ("no stocks", "sem ações").',
  'language: the ISO 639-1 code of the language the text is written in (en, pt, es, fr). unclear: every field the text mentions in a way you cannot read with confidence.',
].join('\n');

/**
 * The values the sourced attributes carry on the person's shelf, for the reader to name a
 * filter from (gate THEME-MATCHED). Attribute values only: never the name of an asset, a company, a
 * ticker or a shared portfolio.
 */
export type IntakeVocabulary = {
  sectors: string[];
  industries: string[];
  subIndustries: string[];
  keywords: string[];
};

/** What the intake reads with: a model, or nothing. Tests hand in a replay of recorded replies. */
export type IntakeModel = {
  id: string;
  /** `live` for Anthropic's API; `mock` for a replay (labelled so in every answer). */
  provenance: 'live' | 'mock';
  /**
   * The reply as it came, or null with why there is none. Never throws. `who` is the person asking,
   * whose own daily budget the call counts against. `vocabulary`, where the caller has one, is sent
   * with the goal, and the same goal read with another vocabulary is another read.
   */
  read(
    text: string,
    nowMonth: string,
    language: Language | undefined,
    who: string,
    vocabulary?: IntakeVocabulary,
  ): Promise<{ reply: unknown } | { reply: null; why: string }>;
};

/** The raw call: one request, the reply's JSON or a reason. */
export type ReadCall = (
  text: string,
  nowMonth: string,
  language?: Language,
  vocabulary?: IntakeVocabulary,
) => Promise<{ reply: unknown } | { reply: null; why: string }>;

const listed = (values: string[]) => (values.length > 0 ? values.join(', ') : 'none');
/**
 * What the model is sent beside its instructions: the month, the page's language, the attribute
 * values of the shelf where the caller has them, and the goal as written.
 */
export function intakeUserMessage(
  text: string,
  nowMonth: string,
  language?: Language,
  vocabulary?: IntakeVocabulary,
): string {
  const head = `Current month: ${nowMonth}.${language ? ` Page language: ${language}.` : ''}`;
  const values = vocabulary
    ? `\nAttribute values on this shelf: sectors: ${listed(vocabulary.sectors)}; industries: ${listed(vocabulary.industries)}; sub-industries: ${listed(vocabulary.subIndustries)}; keywords: ${listed(vocabulary.keywords)}.`
    : '';
  return `${head}${values}\n\nThe goal:\n${text}`;
}

/** Claude Haiku 4.5 over Anthropic's Messages API, with structured outputs. */
export function anthropicCall(apiKey: string): ReadCall {
  const client = new Anthropic({ apiKey, timeout: INTAKE_TIMEOUT_MS, maxRetries: 0 });
  return async (text, nowMonth, language, vocabulary) => {
    try {
      const response = await client.messages.create({
        model: INTAKE_MODEL_ID,
        max_tokens: 1_024,
        temperature: 0,
        system: INTAKE_SYSTEM,
        messages: [
          { role: 'user', content: intakeUserMessage(text, nowMonth, language, vocabulary) },
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

/**
 * The same text, page language, month and vocabulary read once: the key the cache keeps a reply
 * under. A vocabulary is the same one whatever order its values come in.
 */
const keyOf = (
  text: string,
  nowMonth: string,
  language?: Language,
  vocabulary?: IntakeVocabulary,
) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        text.trim().replace(/\s+/g, ' '),
        nowMonth,
        language ?? null,
        vocabulary
          ? [
              [...vocabulary.sectors].sort(),
              [...vocabulary.industries].sort(),
              [...vocabulary.subIndustries].sort(),
              [...vocabulary.keywords].sort(),
            ]
          : null,
      ]),
    )
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
    async read(text, nowMonth, language, who, vocabulary) {
      const key = keyOf(text, nowMonth, language, vocabulary);
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
      const answer = await call(text, nowMonth, language, vocabulary);
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
