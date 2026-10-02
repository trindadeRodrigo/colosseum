import {
  type LiquidityProvider,
  type Quote,
  RiskRollUp,
  type RollUpContext,
} from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rollUp } from './roll-up';
import { asset, shelf } from './testing';

const SHELF = shelf([
  asset('solana:usdc', { decimals: 6, cls: 'cash', issuer: 'circle' }),
  asset('solana:spy', { cls: 'etf', issuer: 'backed' }),
  asset('solana:nvda', { cls: 'stock', issuer: 'backed' }),
  asset('solana:yield', { cls: 'dollar_yield', issuer: 'ondo', decimals: 6 }),
  asset('robinhood:usdc', { decimals: 6, cls: 'cash', issuer: 'circle' }),
  asset('robinhood:gold', { cls: 'gold', issuer: 'paxos', decimals: 18 }),
]);

/** A stored quote that sells `id` and pays out `outUsd` dollars of the chain's cash. */
function quote(id: string, outUsd: number, costBps: number, fetchedAt: string, over = {}): Quote {
  return {
    source: 'test',
    method: 'stored quote',
    fetchedAt,
    provenance: 'live',
    trade: { sell: id, buy: `${id.split(':')[0]}:usdc`, amountInRaw: '1' },
    outRaw: String(Math.round(outUsd * 1e6)),
    minOutRaw: '0',
    costBps,
    against: 'reference',
    venue: 'test',
    ...over,
  };
}

/** A provider with a cost per asset as a function of size; null is "beyond what was measured". */
function provider(
  curves: Record<string, (usd: number) => number | null>,
  capacityUsd = 1_000_000,
  provenance: LiquidityProvider['provenance'] = 'live',
): LiquidityProvider {
  return {
    methodVersion: 'test-0',
    provenance,
    covers: (id) => id in curves,
    exitCapacity: () => null,
    exitCost: (id, usd) => curves[id]?.(usd) ?? null,
    weekendRatio: () => null,
    entry: (id, ctx) =>
      id in curves
        ? {
            assetId: id,
            score: Math.min(1, capacityUsd / ctx.legAmountUsd),
            capacityUsd,
            capacityLowerBound: false,
            worstRegime: 'weekend',
            tau: ctx.tau,
            windowDays: ctx.windowDays,
            legAmountUsd: ctx.legAmountUsd,
            weekendRatio: null,
            lpExitCostPct: null,
            primaryPath: null,
            samples: 10,
            dataFrom: null,
            dataTo: null,
            methodVersion: 'test-0',
            provenance,
          }
        : null,
    assess: () => {
      throw new Error('not used by rollUp');
    },
  };
}

const PLAN = [
  { asset: 'solana:spy', amountUsd: 6000 },
  { asset: 'solana:nvda', amountUsd: 2000 },
  { asset: 'robinhood:gold', amountUsd: 1500 },
  { asset: 'solana:usdc', amountUsd: 500 },
];
const T1 = '2026-10-02T10:00:00.000Z';
const T2 = '2026-10-02T10:15:00.000Z';
const T3 = '2026-10-02T10:30:00Z';

describe('rollUp', () => {
  it('shows where the money is concentrated: by issuer, by chain and by class', () => {
    const r = rollUp(PLAN, { shelf: SHELF, quotes: [] });
    expect(RiskRollUp.parse(r)).toEqual(r);
    expect(r.byIssuer).toEqual([
      { key: 'backed', bps: 8000 },
      { key: 'paxos', bps: 1500 },
      { key: 'circle', bps: 500 },
    ]);
    expect(r.byChain).toEqual([
      { key: 'solana', bps: 8500 },
      { key: 'robinhood', bps: 1500 },
    ]);
    expect(r.byClass).toEqual([
      { key: 'etf', bps: 6000 },
      { key: 'stock', bps: 2000 },
      { key: 'gold', bps: 1500 },
      { key: 'cash', bps: 500 },
    ]);
    // One issuer holds 80%.
    expect(r.flags).toContain('issuer_concentration');
    // Nothing quoted and nothing measured: null, never zero. The cash alone counts as measured.
    expect(r.exit).toEqual({
      quotedBps: null,
      quotedAt: null,
      measuredWorstBps: 0,
      measuredShareBps: 500,
    });
    expect(r.flags).toEqual(expect.arrayContaining(['exit_quote_missing', 'exit_partly_measured']));
  });

  it('gives no measured cost when nothing but cash was measured', () => {
    // The review of BAS-1: $200 of cash and $800 of stock with no curve read as "0 bps, measured".
    const r = rollUp(
      [
        { asset: 'solana:usdc', amountUsd: 200 },
        { asset: 'solana:spy', amountUsd: 800 },
      ],
      { shelf: SHELF, quotes: [] },
    );
    expect(r.exit.measuredWorstBps).toBeNull();
    expect(r.exit.quotedBps).toBeNull();
    expect(r.flags).toContain('exit_not_measured');
    expect(r.flags).not.toContain('exit_partly_measured');
  });

  it('takes the stored quote at the nearest size, the latest one, and says how old it is', () => {
    const quotes = [
      quote('solana:spy', 1000, 5, T2),
      quote('solana:spy', 10_000, 20, T1),
      // The same size a quarter of an hour later, a little off in dollars because the price moved.
      quote('solana:spy', 10_050, 12, T2),
      quote('solana:spy', 50_000, 40, T3),
      quote('solana:nvda', 1000, 8, T3),
      quote('robinhood:gold', 1000, 30, T1),
      // A quote the other way round is an entry, not an exit.
      quote('solana:nvda', 2000, 99, T3, {
        trade: { sell: 'solana:usdc', buy: 'solana:nvda', amountInRaw: '1' },
      }),
    ];
    const r = rollUp(PLAN, { shelf: SHELF, quotes });
    // SPY $6,000 is nearer $10,000 than $1,000: 12 bps. NVDA 8, gold 30, cash 0.
    // (6000 × 12 + 2000 × 8 + 1500 × 30 + 500 × 0) / 10,000 = 13.3
    expect(r.exit.quotedBps).toBe(13.3);
    // The oldest of the quotes used.
    expect(r.exit.quotedAt).toBe(T1);
    expect(r.flags).not.toContain('exit_quote_missing');
    expect(r.flags).not.toContain('exit_quote_partial');
    expect(RiskRollUp.parse(r)).toEqual(r);

    // With one line unquoted, the number covers the rest and a flag says so.
    const part = rollUp(PLAN, { shelf: SHELF, quotes: quotes.slice(0, 5) });
    // (6000 × 12 + 2000 × 8 + 500 × 0) / 8500
    expect(part.exit.quotedBps).toBe(10.35);
    expect(part.flags).toContain('exit_quote_partial');
    expect(part.exit.quotedAt).toBe(T2);
  });

  it('gives the measured worst-regime cost at the size of each line, and the share measured', () => {
    const liquidity = provider({
      // 0.32% at any size.
      'solana:spy': () => 0.0032,
      // Measured up to $1,000 only.
      'solana:nvda': (usd) => (usd <= 1000 ? 0.001 : null),
    });
    const r = rollUp(PLAN, { shelf: SHELF, liquidity, quotes: [] });
    // SPY 32 bps on $6,000 and cash 0 on $500: 6000 × 32 / 6500 = 29.54. NVDA and gold: no number.
    expect(r.exit.measuredWorstBps).toBe(29.54);
    expect(r.exit.measuredShareBps).toBe(6500);
    expect(r.flags).toEqual(
      expect.arrayContaining(['exit_partly_measured', 'exit_beyond_measured_size']),
    );
    expect(r.flags).not.toContain('exit_capacity_short');
    // The two numbers are separate: still nothing quoted.
    expect(r.exit.quotedBps).toBeNull();

    // A smaller plan fits what was measured for NVDA.
    const small = rollUp(
      [
        { asset: 'solana:spy', amountUsd: 3000 },
        { asset: 'solana:nvda', amountUsd: 1000 },
      ],
      { shelf: SHELF, liquidity, quotes: [] },
    );
    // (3000 × 32 + 1000 × 10) / 4000
    expect(small.exit).toMatchObject({ measuredWorstBps: 26.5, measuredShareBps: 10_000 });
    expect(small.flags).not.toContain('exit_partly_measured');
  });

  it('flags a line larger than what can be sold at 1%, and data that is not live', () => {
    const liquidity = provider({ 'solana:spy': () => 0.02 }, 4000, 'fixture');
    const quotes = [quote('solana:spy', 5000, 15, T1, { provenance: 'mock' })];
    const r = rollUp([{ asset: 'solana:spy', amountUsd: 6000 }], {
      shelf: SHELF,
      liquidity,
      quotes,
    });
    expect(r.exit).toEqual({
      quotedBps: 15,
      quotedAt: T1,
      measuredWorstBps: 200,
      measuredShareBps: 10_000,
    });
    expect(r.flags).toEqual([
      'exit_capacity_short',
      'issuer_concentration',
      'provenance:fixture',
      'provenance:mock',
    ]);
  });

  it('adds lines for one asset together, ignores empty ones, and names what is not on the shelf', () => {
    const r = rollUp(
      [
        { asset: 'solana:spy', amountUsd: 100 },
        { asset: 'solana:spy', amountUsd: 200 },
        { asset: 'solana:nvda', amountUsd: 0 },
        { asset: 'solana:doge', amountUsd: 100 },
      ],
      { shelf: SHELF, quotes: [] },
    );
    expect(r.byIssuer).toEqual([
      { key: 'backed', bps: 7500 },
      { key: 'unknown', bps: 2500 },
    ]);
    expect(r.flags).toContain('asset_not_on_shelf');
  });

  it('has nothing to say about an empty plan, and nothing to charge an all-cash one', () => {
    const empty = rollUp([], { shelf: SHELF, quotes: [] });
    expect(empty).toEqual({
      byIssuer: [],
      byChain: [],
      byClass: [],
      flags: [],
      exit: { quotedBps: null, quotedAt: null, measuredWorstBps: null, measuredShareBps: 0 },
    });
    const cash = rollUp([{ asset: 'solana:usdc', amountUsd: 250 }], { shelf: SHELF, quotes: [] });
    expect(cash.exit).toEqual({
      quotedBps: 0,
      quotedAt: null,
      measuredWorstBps: 0,
      measuredShareBps: 10_000,
    });
    expect(cash.flags).toEqual(['issuer_concentration']);
  });
});

// Generated cases take a second or two alone and several when the machine is busy.
describe('rollUp, on generated plans', { timeout: 60_000 }, () => {
  const ids = SHELF.assets.map((a) => a.id);
  const lines = fc.array(
    fc.record({
      asset: fc.constantFrom(...ids, 'solana:doge'),
      amountUsd: fc.oneof(
        fc.constant(0),
        fc.integer({ min: 1, max: 100_000_000 }).map((cents) => cents / 100),
      ),
    }),
    { maxLength: 12 },
  );
  const ctx: RollUpContext = {
    shelf: SHELF,
    liquidity: provider({ 'solana:spy': (usd) => (usd < 50_000 ? usd / 1e7 : null) }),
    quotes: [quote('solana:spy', 1000, 5, T1), quote('solana:nvda', 1000, 8, T2)],
  };

  it('gives shares that add up to exactly 10,000 each way, and numbers the schema accepts', () => {
    fc.assert(
      fc.property(lines, (plan) => {
        const r = rollUp(plan, ctx);
        expect(RiskRollUp.parse(r)).toEqual(r);
        const total = plan.reduce((n, l) => n + l.amountUsd, 0);
        for (const shares of [r.byIssuer, r.byChain, r.byClass]) {
          expect(shares.reduce((n, s) => n + s.bps, 0)).toBe(total > 0 ? 10_000 : 0);
          expect(new Set(shares.map((s) => s.key)).size).toBe(shares.length);
          // Largest first.
          expect(shares.map((s) => s.bps)).toEqual(
            [...shares.map((s) => s.bps)].sort((a, b) => b - a),
          );
        }
        // A share is within a bp of the dollars behind it.
        const spy = plan.filter((l) => l.asset === 'solana:spy' || l.asset === 'solana:nvda');
        const backed = spy.reduce((n, l) => n + l.amountUsd, 0);
        const shown = r.byIssuer.find((s) => s.key === 'backed')?.bps ?? 0;
        if (total > 0) expect(Math.abs(shown - (backed / total) * 10_000)).toBeLessThan(1.001);
        expect(r.exit.measuredShareBps).toBeLessThanOrEqual(10_000);
        if (r.exit.quotedBps === null && total > 0) expect(r.flags).toContain('exit_quote_missing');
        expect(r.flags).toEqual([...r.flags].sort());
      }),
      { numRuns: 1500 },
    );
  });
});
