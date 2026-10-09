import { INTAKE_LIMITS, MARKET_FILTER_BY, MARKET_IDS, readReply } from '@colosseum/engine/personal';
import { describe, expect, it } from 'vitest';
import {
  budgetedModel,
  INTAKE_REPLY_SCHEMA,
  INTAKE_SYSTEM,
  type IntakeVocabulary,
  intakeModelFromEnv,
  intakeSettings,
  intakeUserMessage,
  type ReadCall,
} from './llm';

// The reader behind the guided intake (gate GUIDED-INTAKE), without the model: what it is asked for,
// what it is sent, and the cache around a call. No test reaches Anthropic: the call is a function
// handed in, and its replies are MOCK, written here.

const TEXT = 'I have $2,000 to invest in obesity drugs for 5 years';
// MOCK. Attribute values as a caller with the stocks' sourced attributes would hand them in.
const VOCABULARY: IntakeVocabulary = {
  sectors: ['Health Care', 'Industrials'],
  industries: ['Aerospace & Defense', 'Pharmaceuticals'],
  subIndustries: [],
  keywords: ['GLP-1'],
};

describe('what the model is asked for', () => {
  it('asks for bounded non-executable latest-person interest metadata, never advice or an inferred company', () => {
    const [interest, none] = INTAKE_REPLY_SCHEMA.properties.clarification.anyOf;
    expect(none).toEqual({ type: 'null' });
    expect(interest.additionalProperties).toBe(false);
    expect(interest.required).toEqual(['kind', 'quote', 'keywords']);
    expect(interest.properties.quote).toEqual({ type: 'string' });
    expect(interest.properties.keywords).toEqual({ type: 'array', items: { type: 'string' } });
    expect(INTAKE_SYSTEM).toContain('latest message');
    expect(INTAKE_SYSTEM).toContain('Do not infer Tesla');
    expect(INTAKE_SYSTEM).toContain("someone else's preference");
    expect(INTAKE_SYSTEM).toContain('A complete financial instruction must proceed normally');
  });
  it('names a market only by an id of the engine list, and a filter only as one attribute and one value', () => {
    const { properties, required } = INTAKE_REPLY_SCHEMA;
    expect(properties.markets.items.enum).toEqual([...MARKET_IDS]);
    const [filter, none] = properties.marketFilter.anyOf;
    expect(none).toEqual({ type: 'null' });
    expect(filter).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['by', 'value', 'words'],
      properties: {
        by: { type: 'string', enum: [...MARKET_FILTER_BY] },
        value: { type: 'string' },
        words: { type: 'string' },
      },
    });
    // Every field is asked for, each nullable or a list: none is left to the model to add or leave out.
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
    expect(INTAKE_REPLY_SCHEMA.additionalProperties).toBe(false);
  });

  it('may name health care and social media (Oct 6), and is told what every id of the list is', () => {
    const ids: readonly string[] = INTAKE_REPLY_SCHEMA.properties.markets.items.enum;
    expect(ids).toEqual(expect.arrayContaining(['health_care', 'social_media']));
    // An id the instructions do not describe would be one the model can send and cannot know.
    for (const id of MARKET_IDS) expect(INTAKE_SYSTEM, id).toMatch(new RegExp(`\\b${id} \\(`));
    // What the fixed lists read is no longer an example of a filter.
    const filterLine = INTAKE_SYSTEM.split('\n').find((line) => line.startsWith('marketFilter:'));
    expect(filterLine).toBeDefined();
    expect(filterLine).not.toMatch(/pharma|health care/i);
    // The reader is told what the checks hold it to: what is ruled out, asked or held elsewhere is
    // no mix and no market, and a portfolio is only one the text writes.
    expect(INTAKE_SYSTEM).toMatch(/rules out, only asks about/);
    expect(INTAKE_SYSTEM).toMatch(/already holds elsewhere/);
    expect(INTAKE_SYSTEM).toMatch(/never one the text does not write/);
  });

  it('a filter value or words longer than the engine reads are dropped where the reply is read', () => {
    const filter = (value: string, words: string) => ({ by: 'keyword', value, words });
    expect(INTAKE_LIMITS).toMatchObject({ filterValueChars: 80, filterWordsChars: 100 });
    const ok = filter(
      'x'.repeat(INTAKE_LIMITS.filterValueChars),
      'y'.repeat(INTAKE_LIMITS.filterWordsChars),
    );
    expect(readReply({ marketFilter: ok }).flags).toEqual([]);
    for (const marketFilter of [
      filter('x'.repeat(INTAKE_LIMITS.filterValueChars + 1), 'obesity drugs'),
      filter('GLP-1', 'y'.repeat(INTAKE_LIMITS.filterWordsChars + 1)),
    ]) {
      const read = readReply({ marketFilter });
      expect(read.flags).toEqual(['model_invalid:marketFilter']);
      expect(read.reply.marketFilter).toBeNull();
    }
  });

  it('a reply in that shape is what the engine reads, and a filter that names a stock is not', () => {
    const marketFilter = { by: 'keyword', value: 'GLP-1', words: 'obesity drugs' };
    const read = readReply({ markets: [...MARKET_IDS], marketFilter });
    expect(read.flags).toEqual([]);
    expect(read.reply.markets).toEqual([...MARKET_IDS]);
    expect(read.reply.marketFilter).toEqual(marketFilter);
    for (const bad of [
      { ...marketFilter, pick: 'LLY' },
      { ...marketFilter, by: 'ticker' },
      { by: 'keyword', value: 'GLP-1' },
    ]) {
      const refused = readReply({ marketFilter: bad });
      expect(refused.flags, JSON.stringify(bad)).toEqual(['model_invalid:marketFilter']);
      expect(refused.reply.marketFilter, JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('what the model is sent', () => {
  it('the month, the page language where there is one, and the goal as written', () => {
    expect(intakeUserMessage(TEXT, '2026-10')).toBe(
      `Current month: 2026-10.\n\nThe goal:\n${TEXT}`,
    );
    expect(intakeUserMessage(TEXT, '2026-10', 'pt')).toBe(
      `Current month: 2026-10. Page language: pt.\n\nThe goal:\n${TEXT}`,
    );
  });

  it('with a vocabulary, the attribute values of the shelf on a line of their own', () => {
    expect(intakeUserMessage(TEXT, '2026-10', 'en', VOCABULARY)).toBe(
      [
        'Current month: 2026-10. Page language: en.',
        'Attribute values on this shelf: sectors: Health Care, Industrials; industries: Aerospace & Defense, Pharmaceuticals; sub-industries: none; keywords: GLP-1.',
        '',
        'The goal:',
        TEXT,
      ].join('\n'),
    );
  });
});

describe('the cache around a call', () => {
  it('sends exact latest-turn context and distinguishes pending-question boundaries in the same call cache', async () => {
    const calls: unknown[] = [];
    const model = budgetedModel(
      async (_text, _month, _language, _vocabulary, dialogue) => {
        calls.push(dialogue);
        return { reply: { read: calls.length } };
      },
      { provenance: 'mock' },
    );
    const context = {
      turns: ['i like elon', 'elon musk!'],
      latestTurn: 1,
      pendingInterest: { quote: 'i like elon', sourceTurn: 0 },
      questionOrigin: 'interestClarification' as const,
    };
    const text = context.turns.join('\n\n');
    const first = await model.read(text, '2026-10', 'en', 'person', undefined, context);
    expect(await model.read(text, '2026-10', 'en', 'person', undefined, context)).toEqual(first);
    expect(
      await model.read(text, '2026-10', 'en', 'person', undefined, {
        ...context,
        questionOrigin: null,
      }),
    ).not.toEqual(first);
    expect(calls).toHaveLength(2);
    const message = intakeUserMessage(text, '2026-10', 'en', undefined, context);
    expect(message).toContain(JSON.stringify(context));
    expect(message).toContain('Latest person message:\nelon musk!');
  });
  it('hands the vocabulary to the call, and reads the same goal with another vocabulary again', async () => {
    const seen: (IntakeVocabulary | undefined)[] = [];
    const call: ReadCall = async (_text, _month, _language, vocabulary) => {
      seen.push(vocabulary);
      return { reply: { read: seen.length } };
    };
    const model = budgetedModel(call, { provenance: 'mock' });
    const read = (vocabulary?: IntakeVocabulary) =>
      model.read(TEXT, '2026-10', 'en', 'someone', vocabulary);
    const none = await read();
    const first = await read(VOCABULARY);
    expect(none).toEqual({ reply: { read: 1 } });
    expect(first).toEqual({ reply: { read: 2 } });
    // The same goal with the same vocabulary is read once, whatever order its values come in.
    expect(await read(VOCABULARY)).toEqual(first);
    expect(await read()).toEqual(none);
    const reordered: IntakeVocabulary = {
      ...VOCABULARY,
      sectors: [...VOCABULARY.sectors].reverse(),
      industries: [...VOCABULARY.industries].reverse(),
    };
    expect(await read(reordered)).toEqual(first);
    // Another vocabulary is another read.
    const other = { ...VOCABULARY, keywords: [] };
    expect(await read(other)).toEqual({ reply: { read: 3 } });
    // A value moved to another list is another vocabulary too.
    const moved = { ...VOCABULARY, keywords: [], subIndustries: ['GLP-1'] };
    expect(await read(moved)).toEqual({ reply: { read: 4 } });
    expect(seen).toEqual([undefined, VOCABULARY, other, moved]);
  });

  it('a failed call is not kept, with or without a vocabulary', async () => {
    let calls = 0;
    const call: ReadCall = async () => {
      calls += 1;
      return calls === 1 ? { reply: null, why: 'model_timeout' } : { reply: { read: calls } };
    };
    const model = budgetedModel(call, { provenance: 'mock' });
    expect(await model.read(TEXT, '2026-10', 'en', 'someone', VOCABULARY)).toEqual({
      reply: null,
      why: 'model_timeout',
    });
    expect(await model.read(TEXT, '2026-10', 'en', 'someone', VOCABULARY)).toEqual({
      reply: { read: 2 },
    });
    expect(calls).toBe(2);
  });
});

describe('the model’s settings, from the environment', () => {
  it('are today’s values where nothing is set, and the environment’s where it is', () => {
    expect(intakeSettings({})).toEqual({
      model: 'claude-haiku-4-5',
      timeoutMs: 6_000,
      dailyCalls: 1_000,
      dailyCallsPerPerson: 30,
    });
    expect(
      intakeSettings({
        INTAKE_MODEL: ' claude-sonnet-5-5 ',
        INTAKE_MODEL_TIMEOUT_MS: '12000',
        INTAKE_MODEL_DAILY_CALLS: '0',
        INTAKE_MODEL_DAILY_CALLS_PER_PERSON: '200',
      }),
    ).toEqual({
      model: 'claude-sonnet-5-5',
      timeoutMs: 12_000,
      dailyCalls: 0,
      dailyCallsPerPerson: 200,
    });
    // set and empty is not set
    expect(intakeSettings({ INTAKE_MODEL: '', INTAKE_MODEL_TIMEOUT_MS: ' ' }).timeoutMs).toBe(
      6_000,
    );
  });

  it('stop the start on a value that cannot be read, naming the variable and never a value', () => {
    const KEY = 'a-test-key-not-real';
    for (const [name, value] of [
      ['INTAKE_MODEL', 'haiku please'],
      ['INTAKE_MODEL', 'x'.repeat(101)],
      ['INTAKE_MODEL_TIMEOUT_MS', '6s'],
      ['INTAKE_MODEL_TIMEOUT_MS', '100'],
      ['INTAKE_MODEL_TIMEOUT_MS', '600000'],
      ['INTAKE_MODEL_DAILY_CALLS', '-1'],
      ['INTAKE_MODEL_DAILY_CALLS', '1e3'],
      ['INTAKE_MODEL_DAILY_CALLS_PER_PERSON', 'thirty'],
      ['INTAKE_MODEL_DAILY_CALLS_PER_PERSON', '2.5'],
    ] as const) {
      // with a key and without one: the setting is read either way
      for (const env of [{ [name]: value }, { [name]: value, ANTHROPIC_API_KEY: KEY }]) {
        let said = '';
        try {
          intakeModelFromEnv(env);
        } catch (e) {
          said = (e as Error).message;
        }
        expect(said, `${name}=${value}`).toMatch(new RegExp(`^${name} must be `));
        expect(said).not.toContain(value);
        expect(said).not.toContain(KEY);
      }
    }
  });

  it('give no model with no key, and one that says the model it runs with a key', () => {
    expect(intakeModelFromEnv({ INTAKE_MODEL: 'claude-sonnet-5-5' })).toBeNull();
    const model = intakeModelFromEnv({
      ANTHROPIC_API_KEY: 'a-test-key-not-real',
      INTAKE_MODEL: 'claude-sonnet-5-5',
    });
    expect(model).toMatchObject({ id: 'claude-sonnet-5-5', provenance: 'live' });
    expect(intakeModelFromEnv({ ANTHROPIC_API_KEY: 'a-test-key-not-real' })?.id).toBe(
      'claude-haiku-4-5',
    );
  });
});
