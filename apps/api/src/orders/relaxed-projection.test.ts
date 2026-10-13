import type { VaultAgentSource } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { type ProjectionInput, project, readingsOf, series } from './relaxed-projection';

// The relaxed intake's arithmetic (gate RELAXED-INTAKE): from the server's sourced readings only, said
// as past-rate arithmetic, a reading that is not live named as such.

const reading = (
  assetId: string,
  kind: 'quoted' | 'haircut',
  value: number,
  fetchedAt: string,
  provenance: VaultAgentSource['provenance'] = 'live',
): VaultAgentSource => ({
  id: `yield:${assetId}:1:${kind}`,
  assetId,
  value,
  source: `${assetId} feed`,
  method: kind,
  fetchedAt,
  provenance,
});

const symbol = (id: string) => id.replace(/^solana:/, '').toUpperCase();
const today = new Date('2026-01-01T00:00:00.000Z');

function input(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    lines: [{ assetId: 'solana:usdy', symbol: 'USDY', weightBps: 10_000 }],
    readings: readingsOf(
      [reading('solana:usdy', 'quoted', 0.05, '2026-01-01T00:00:00.000Z')],
      symbol,
    ),
    today,
    currency: 'USD',
    amount: 1000,
    needBy: null,
    monthly: null,
    months: null,
    withdrawStart: null,
    ...over,
  };
}

describe('readingsOf', () => {
  it('takes the haircut reading over the quoted one, and the latest of each', () => {
    const readings = readingsOf(
      [
        reading('solana:usdy', 'quoted', 0.05, '2026-01-01T00:00:00.000Z'),
        reading('solana:usdy', 'quoted', 0.06, '2026-01-02T00:00:00.000Z'),
        reading('solana:usdy', 'haircut', 0.045, '2026-01-02T00:00:00.000Z'),
        { ...reading('solana:x', 'quoted', 0.1, '2026-01-01T00:00:00.000Z'), value: null },
        { ...reading('solana:y', 'quoted', 0.1, '2026-01-01T00:00:00.000Z'), id: 'price:solana:y' },
      ],
      symbol,
    );
    expect([...readings.keys()]).toEqual(['solana:usdy']);
    expect(readings.get('solana:usdy')).toMatchObject({
      rate: 0.045,
      quoted: 0.06,
      haircut: 0.045,
      symbol: 'USDY',
      ids: ['yield:solana:usdy:1:quoted', 'yield:solana:usdy:1:haircut'],
    });
  });
});

describe('project', () => {
  it('says what the amount grows to by the day it is needed, as past-rate arithmetic', () => {
    const p = project(input({ needBy: '2027-01-01' }));
    expect(p?.text).toMatch(/^Projection, computed by Tenonfi from past rates, not a promise: /);
    expect(p?.text).toContain(
      'By 1 Jan 2027, $1,000 placed today would earn about $50, to about $1,050.',
    );
    expect(p?.text).toContain('Rate: 5.00% a year across the plan, from USDY at 5.00%');
    expect(p?.sourceIds).toEqual(['yield:solana:usdy:1:quoted']);
  });

  it('defaults to five years when no date is given, and counts a line with no reading at zero', () => {
    const p = project(
      input({
        lines: [
          { assetId: 'solana:usdy', symbol: 'USDY', weightBps: 5000 },
          { assetId: 'solana:usdc', symbol: 'USDC', weightBps: 5000 },
        ],
      }),
    );
    expect(p?.text).toContain('With no date given, over five years');
    expect(p?.text).toContain('Rate: 2.50% a year');
    expect(p?.text).toContain('Counted as earning nothing: USDC.');
  });

  it('works out monthly withdrawals: what they need today and what the amount covers', () => {
    const p = project(input({ amount: 300, monthly: 100, months: 3, withdrawStart: '2026-02-01' }));
    expect(p?.text).toContain('3 withdrawals of $100 a month from 1 Feb 2026 need about $');
    expect(p?.text).toContain('$300 placed today covers all 3 withdrawals of $100');
  });

  it('names a reading that is not live: a test network’s, and a sample’s without the word MOCK', () => {
    const sandbox = project(
      input({
        needBy: '2027-01-01',
        readings: readingsOf(
          [reading('solana:usdy', 'quoted', 0.05, '2026-01-01T00:00:00.000Z', 'sandbox')],
          symbol,
        ),
      }),
    );
    expect(sandbox?.text).toContain('a mainnet reading applied on the test network');
    const mock = project(
      input({
        needBy: '2027-01-01',
        readings: readingsOf(
          [reading('solana:usdy', 'quoted', 0.05, '2026-01-01T00:00:00.000Z', 'mock')],
          symbol,
        ),
      }),
    );
    expect(mock?.text).toContain('a sample reading, not live');
    expect(mock?.text).not.toMatch(/MOCK/);
  });

  it('projects nothing with no lines, or with neither an amount nor a monthly sum', () => {
    expect(project(input({ lines: [] }))).toBeNull();
    expect(project(input({ amount: null }))).toBeNull();
  });
});

describe('series', () => {
  it('is none for a plan with no sourced reading (stocks only)', () => {
    expect(
      series(input({ lines: [{ assetId: 'solana:tslax', symbol: 'TSLAX', weightBps: 10_000 }] })),
    ).toBeNull();
  });

  it('runs month by month to the term, and asks for the amount when it is not known', () => {
    const s = series(input({ needBy: '2026-04-01' }));
    expect(s?.step).toBe(1);
    expect(s?.months.map((m) => m.month)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ]);
    expect(s?.months.at(-1)?.balance).toBeGreaterThan(1000);
    expect(series(input({ amount: null }))?.months).toEqual([]);
  });

  it('takes each withdrawal on its day', () => {
    const s = series(input({ monthly: 100, months: 2, withdrawStart: '2026-02-01' }));
    expect(s?.months.reduce((a, m) => a + m.withdrawn, 0)).toBe(200);
  });

  it('uses one point a year past five years', () => {
    expect(series(input({ needBy: '2036-01-01' }))?.step).toBe(12);
  });

  it('names test-network and sample readings in its basis, never the word MOCK', () => {
    const basis = (provenance: VaultAgentSource['provenance']) =>
      series(
        input({
          readings: readingsOf(
            [reading('solana:usdy', 'quoted', 0.05, '2026-01-01T00:00:00.000Z', provenance)],
            symbol,
          ),
        }),
      )?.basis ?? '';
    expect(basis('live')).not.toMatch(/test network|sample/);
    expect(basis('sandbox')).toContain('(mainnet reading on a test network)');
    expect(basis('mock')).toContain('(sample reading, not live)');
    expect(basis('mock')).not.toMatch(/MOCK/);
    expect(basis('live')).toMatch(/^Projected from past rates, not a promise: /);
  });
});
