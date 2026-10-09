import { describe, expect, it } from 'vitest';
import { collectFacts, Fact, finiteFacts } from './facts';

// No figure of a fact sheet goes out as Infinity or NaN: the routes that answer one pass it through
// `finiteFacts`, whatever built it. A division by a stored zero under one fact refused the whole
// sheet (the hosted API, Oct 7: "expected number, received Infinity" at `value`).

const measured = (value: number, more: object = {}) => ({
  value,
  quality: 'measured',
  unit: 'fraction',
  source: 'a table',
  method: 'a median',
  methodVersion: 'facts-0.1',
  fetchedAt: '2026-10-07T18:43:01.000Z',
  provenance: 'live',
  ...more,
});

describe('a fact sheet’s figures', () => {
  it('are left as they are when every one is a finite number', () => {
    const sheet = {
      asset: 'TSLAx',
      tracking: [{ against: 'kamino_scope', gap: measured(0.0021, { samples: 40 }) }],
      exit: {
        cost: measured(0, { sizeUsd: 1000 }),
        none: { value: null, reason: 'not_collected', unit: 'usd' },
      },
      samples: 3,
    };
    expect(finiteFacts(sheet)).toEqual(sheet);
  });

  it('are answered as missing, with their unit, regime and size, where the number is not finite', () => {
    const sheet = {
      tracking: [
        { against: 'kamino_scope', gap: measured(Number.POSITIVE_INFINITY, { regime: 'weekend' }) },
        { against: 'jupiter_lend_oracle', gap: measured(0.01) },
      ],
      flow: {
        imbalance: measured(Number.NaN),
        turnover: measured(Number.NEGATIVE_INFINITY, { sizeUsd: 5000 }),
      },
    };
    const out = finiteFacts(sheet);
    expect(out.tracking[0]?.gap).toEqual({
      value: null,
      reason: 'not_a_number',
      unit: 'fraction',
      regime: 'weekend',
      detail: 'the measured value was not a finite number',
    });
    expect(out.tracking[1]?.gap).toEqual(sheet.tracking[1]?.gap);
    expect(out.flow.imbalance).toMatchObject({ value: null, reason: 'not_a_number' });
    expect(out.flow.turnover).toMatchObject({ value: null, reason: 'not_a_number', sizeUsd: 5000 });
    // every fact of the sheet is one the answer's schema takes, and none is left that it refuses
    const { facts, invalid } = collectFacts(out);
    expect(invalid).toEqual([]);
    expect(facts).toHaveLength(4);
    for (const { fact, path } of facts) {
      expect(Fact.safeParse(fact).success, path).toBe(true);
      expect(fact.value === null || Number.isFinite(fact.value), path).toBe(true);
    }
    // self-check: before the guard, the schema refuses the sheet's first fact
    expect(Fact.safeParse(sheet.tracking[0]?.gap).success).toBe(false);
  });

  it('touch nothing that is not a fact: a number elsewhere, a string, a null', () => {
    const other = {
      value: Number.POSITIVE_INFINITY,
      note: 'no unit: not a fact',
      n: [1, null, 'x'],
    };
    expect(finiteFacts(other)).toEqual(other);
    expect(finiteFacts(null)).toBeNull();
  });
});
