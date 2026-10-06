import { MARKET_FILTER_BY, MARKET_IDS, readReply } from '@colosseum/engine/personal';
import { describe, expect, it } from 'vitest';
import {
  budgetedModel,
  INTAKE_REPLY_SCHEMA,
  type IntakeVocabulary,
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
