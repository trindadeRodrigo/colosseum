import type { ChainId, Shelf } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import { Book } from './placement';
import { scheduleOf } from './schedule';
import { reason } from './templates';
import {
  allReasons,
  ceilingUsd,
  fixtureContext,
  fixtureLiquidity,
  fixtureYields,
  launchShelf,
  NOW,
  pooledLiquidity,
  secondRateToken,
  secondRateYield,
  sheet,
  usdBrl,
  violations,
  withReais,
} from './testing';
import {
  type ComposeContext,
  PersonalInputError,
  type PersonalProposal,
  type PersonalSheet,
} from './types';
import { buildWorld, monthAfter } from './world';

// Slice 2 of docs/vault/PROMPT-BUILD-SOLVER.md, steps 3 to 6: what is set aside for the next
// withdrawals, the coverage check (C6), the schedule in the goal's currency (C7), and the tests the
// prompt names. Every token and figure added here is a fixture, labelled MOCK.

const launch = launchShelf();
const ctx = fixtureContext();
const run = (s: PersonalSheet, shelf: Shelf = launch, c: ComposeContext = ctx) => {
  const plan = compose(s, shelf, c);
  expect(violations(plan, shelf, c)).toEqual([]);
  return plan;
};
const line = (plan: PersonalProposal, id: string) => plan.lines.find((l) => l.assetId === id);
const rules = (plan: PersonalProposal) => allReasons(plan).map((r) => r.rule);
/** The month `n` after the plan's month (October 2026). */
const inMonths = (n: number) => monthAfter(NOW, n);

describe('setting aside the next six months of withdrawals', () => {
  it('on Solana, with no token that pays a rate alone, a dollar withdrawal is set aside in cash, and says so', () => {
    const plan = run(
      sheet({
        goal: 'income',
        amountUsd: 50_000,
        obligations: [{ month: inMonths(1), amount: 3000, currency: 'USD' }],
      }),
    );
    const cash = line(plan, 'solana:usdc');
    expect(cash?.reasons.map((r) => r.rule)).toEqual(
      expect.arrayContaining(['SET_ASIDE', 'WITHDRAWAL', 'SET_ASIDE_CASH']),
    );
    expect(cash?.amountUsd).toBeGreaterThanOrEqual(3000);
    expect(cash?.reasons.find((r) => r.rule === 'WITHDRAWAL')?.text).toBe(
      'You withdraw 3,000 USD in November 2026.',
    );
  });

  it('on Robinhood Chain, it is set aside in SGOV, a rate leg, and the rest of the goal shares what is left', () => {
    const base = sheet({ goal: 'grow', chains: ['robinhood'], amountUsd: 50_000 });
    const without = run(base);
    const plan = run({
      ...base,
      obligations: [{ month: inMonths(2), amount: 5000, currency: 'USD' }],
    });
    const sgov = line(plan, 'robinhood:sgov');
    expect(sgov?.reasons.map((r) => r.rule)).toContain('SET_ASIDE');
    expect(sgov?.amountUsd).toBeGreaterThanOrEqual(5000);
    // The $5,000 comes off the goal before the table is scaled: stocks hold less than without it.
    const growth = (p: PersonalProposal) =>
      p.sleeves.find((x) => x.sleeve === 'growth')?.amountUsd ?? 0;
    expect(growth(plan)).toBeLessThan(growth(without));
  });

  it('a withdrawal past the next six months is not set aside, and one already past counts for nothing', () => {
    const later = run(
      sheet({
        goal: 'income',
        obligations: [{ month: inMonths(6), amount: 1000, currency: 'USD' }],
      }),
    );
    expect(rules(later)).not.toContain('SET_ASIDE');
    expect(later.schedule?.monthsWithWithdrawal).toBe(1);
    const past = run(
      sheet({
        goal: 'income',
        obligations: [{ month: monthAfter(NOW, -1), amount: 1000, currency: 'USD' }],
      }),
    );
    expect(past.flags).toContain('obligations_past');
    expect(rules(past)).not.toContain('SET_ASIDE');
    expect(past.schedule).toBeUndefined();
  });

  it('withdrawals larger than the goal sleeve set all of it aside and say what is not covered', () => {
    const plan = run(
      sheet({
        goal: 'income',
        amountUsd: 10_000,
        obligations: [{ month: inMonths(0), amount: 12_000, currency: 'USD' }],
      }),
    );
    expect(plan.flags).toContain('set_aside_short');
    const short = allReasons(plan).find((r) => r.rule === 'SET_ASIDE_SHORT');
    expect(short?.params).toMatchObject({ owedUsd: 12_000, shortUsd: 2000 });
    expect(plan.schedule?.monthsPaid).toBe(0);
    expect(plan.flags).toContain('schedule_unpaid');
  });

  it('a withdrawal in reais with no FX reading is refused, never guessed', () => {
    const s = sheet({ obligations: [{ month: inMonths(1), amount: 5000, currency: 'BRL' }] });
    expect(() => compose(s, launch, ctx)).toThrow(PersonalInputError);
    try {
      compose(s, launch, ctx);
    } catch (error) {
      expect((error as PersonalInputError).code).toBe('InvalidContext');
    }
  });
});

describe('the same goal in dollars and in reais (C5, C19)', () => {
  const shelf = withReais();
  const c = fixtureContext({ fx: [usdBrl(5.5)] });
  const months = [inMonths(1), inMonths(3)];
  const dollars = run(
    sheet({
      goal: 'income',
      amountUsd: 50_000,
      obligations: months.map((month) => ({ month, amount: 2000, currency: 'USD' })),
    }),
    shelf,
    c,
  );
  const reais = run(
    sheet({
      goal: 'income',
      amountUsd: 50_000,
      currency: 'BRL',
      obligations: months.map((month) => ({ month, amount: 11_000, currency: 'BRL' })),
    }),
    shelf,
    c,
  );

  it('the dollar plan has no matching leg, no FX reading and no open-FX line', () => {
    expect(line(dollars, 'solana:brlx')).toBeUndefined();
    expect(rules(dollars)).not.toContain('FX_OPEN');
    expect(dollars.flags.filter((f) => f.startsWith('fx_') || f.includes('matching'))).toEqual([]);
    expect(dollars.observations.some((o) => o.kind === 'fx')).toBe(false);
    expect(dollars.schedule?.currency).toBe('USD');
  });

  it('the reais plan holds its withdrawals in the matching leg, and is open to the rate on every other line', () => {
    expect(line(reais, 'solana:brlx')?.amountUsd).toBe(4000);
    expect(reais.flags).toContain('fx_open:BRL');
    expect(reais.flags).not.toContain('no_matching_leg:BRL');
    for (const l of reais.lines)
      expect(l.reasons.some((r) => r.rule === 'FX_OPEN')).toBe(l.assetId !== 'solana:brlx');
    expect(reais.observations.some((o) => o.kind === 'fx' && o.id === 'USDBRL')).toBe(true);
    expect(reais.schedule?.currency).toBe('BRL');
    expect(reais.schedule?.rows[1]?.withdrawal).toBe(11_000);
  });

  it('they differ only by the matching leg and the dollar cash that funded it', () => {
    const rest = (p: PersonalProposal) =>
      p.lines
        .filter((l) => !['solana:usdc', 'solana:brlx'].includes(l.assetId))
        .map((l) => [l.assetId, l.amountUsd]);
    expect(rest(reais)).toEqual(rest(dollars));
    expect(
      (line(reais, 'solana:usdc')?.amountUsd ?? 0) + (line(reais, 'solana:brlx')?.amountUsd ?? 0),
    ).toBeCloseTo(line(dollars, 'solana:usdc')?.amountUsd ?? 0, 2);
  });
});

describe('the coverage check (C6): legs that share one pool', () => {
  // MOCK: two rate legs on Robinhood Chain, each measured at $1,000,000 a window alone, that sell
  // into one pool that takes $30,000 a window for both together.
  const shelf: Shelf = { ...launch, assets: [...launch.assets, secondRateToken()] };
  const capacities = { 'robinhood:sgov': 1_000_000, 'robinhood:usdy': 1_000_000 };
  const yields = [...fixtureYields(), secondRateYield()];
  const alone = fixtureContext({ yields, liquidity: fixtureLiquidity(capacities) });
  const pooled = fixtureContext({
    yields,
    liquidity: pooledLiquidity(
      capacities,
      { 'robinhood:sgov': 'tbills', 'robinhood:usdy': 'tbills' },
      { tbills: 30_000 },
    ),
  });
  const s = sheet({
    goal: 'income',
    chains: ['robinhood'],
    amountUsd: 100_000,
    obligations: [{ month: inMonths(0), amount: 60_000, currency: 'USD' }],
  });

  it('token by token the caps pass, and nothing moves', () => {
    const plan = run(s, shelf, alone);
    expect(plan.flags).not.toContain('coverage_moved');
    expect(plan.flags).not.toContain('coverage_short');
    for (const id of ['robinhood:sgov', 'robinhood:usdy']) {
      const asset = shelf.assets.find((a) => a.id === id);
      if (!asset) throw new Error(id);
      expect(line(plan, id)?.amountUsd ?? 0).toBeLessThanOrEqual(ceilingUsd(asset, alone));
    }
  });

  it('on one pool they cannot both be sold in time: money moves to cash, and the plan says why', () => {
    const before = run(s, shelf, alone);
    const plan = run(s, shelf, pooled);
    expect(plan.flags).toContain('coverage_moved');
    expect(plan.flags).not.toContain('coverage_short');
    const moved = allReasons(plan).find((r) => r.rule === 'COVERAGE_MOVED');
    expect(moved?.params.assets).toBe('SGOV,USDY');
    expect(moved?.text).toContain('SGOV and USDY can be sold for');
    const cash = (p: PersonalProposal) => line(p, 'robinhood:usdg')?.amountUsd ?? 0;
    expect(cash(plan)).toBeGreaterThan(cash(before));
    expect(line(plan, 'robinhood:usdg')?.reasons.map((r) => r.rule)).toContain('COVERAGE_CASH');
    // After the move, cash and what the pool sells in one window pay the $60,000.
    expect(cash(plan) + 30_000).toBeGreaterThanOrEqual(60_000);
    // The pool is in the hash of the inputs: the same plan with another pool is another plan.
    expect(plan.inputsHash).not.toBe(before.inputsHash);
  });
});

describe('the schedule, in the goal’s currency (C7)', () => {
  it('pays each month of withdrawals from what is set aside, and keeps the yield legs', () => {
    const plan = run(
      sheet({
        goal: 'income',
        amountUsd: 50_000,
        obligations: Array.from({ length: 12 }, (_, m) => ({
          month: inMonths(m),
          amount: 500,
          currency: 'USD',
        })),
      }),
    );
    const sc = plan.schedule;
    expect(sc?.rows[0]?.month).toBe(inMonths(0));
    expect(sc?.monthsWithWithdrawal).toBe(12);
    expect(sc?.monthsPaid).toBe(12);
    expect(sc?.shortfall).toBe(0);
    expect(sc?.rows.length).toBe(120);
  });

  const CHAINS: ChainId[] = ['solana', 'robinhood'];
  it('with a provider, months paid fall or hold against the par draw, never rise', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CHAINS),
        fc.constantFrom('grow', 'income', 'protect'),
        fc.integer({ min: 1000, max: 500_000 }),
        fc.array(
          fc.record({
            month: fc.integer({ min: 0, max: 30 }).map(inMonths),
            amount: fc.integer({ min: 100, max: 80_000 }),
            currency: fc.constant('USD'),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.array(fc.integer({ min: 0, max: 200_000 }), { minLength: 6, maxLength: 6 }),
        (chain, goal, amountUsd, obligations, caps) => {
          const tokens = launch.assets.filter((a) => a.chain === chain && a.cls !== 'cash');
          const liquidity = fixtureLiquidity(
            Object.fromEntries(tokens.slice(0, caps.length).map((a, i) => [a.id, caps[i] ?? 0])),
          );
          const c = fixtureContext({ liquidity });
          const plan = compose(sheet({ goal, chains: [chain], amountUsd, obligations }), launch, c);
          expect(violations(plan, launch, c)).toEqual([]);
          const inputs = {
            lines: plan.lines,
            byId: new Map(launch.assets.map((a) => [a.id, a])),
            yields: new Map(fixtureYields().map((y) => [y.assetId, y])),
            withdrawals: obligations.map((o) => ({ ...o, cents: o.amount * 100 })),
            currency: 'USD',
            rate: 1,
            nowMonth: inMonths(0),
            months: 36,
            liquidity,
            tau: PERSONAL_PARAMS.tau,
            ceilingUsdOf: (a: (typeof launch.assets)[number]) =>
              PERSONAL_PARAMS.tierCeilingUsd[a.tier],
          };
          const withCost = scheduleOf(inputs);
          const atPar = scheduleOf({ ...inputs, atPar: true });
          expect(withCost.monthsPaid).toBeLessThanOrEqual(atPar.monthsPaid);
          withCost.rows.forEach((row, i) => {
            expect(row.balance).toBeLessThanOrEqual((atPar.rows[i]?.balance ?? 0) + 0.01);
          });
        },
      ),
      { numRuns: 200 },
    );
  }, 60_000);
});

describe('a shared portfolio held whole, when the coverage check takes money from one of its lines', () => {
  // Found by the mix's property test once it had withdrawals (Oct 6), and there without a mix too: a
  // table row with no dollar yield, Sand to Server held whole on Robinhood Chain, and $140 owed this
  // month. The $140 is set aside in SGOV, which nothing measures, so its sale is counted at a cost
  // and falls $1.40 short: that comes out of the largest stock line alone. The portfolio's lines are
  // then no longer in the weights it publishes. Kept as one component, the vault's target for that
  // line was the published 30% and its dollars five basis points less.
  const params = {
    ...PERSONAL_PARAMS,
    sleeves: {
      ...PERSONAL_PARAMS.sleeves,
      'grow:high': { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0 },
    },
  };
  const c = fixtureContext({ params });
  const s = sheet({
    chains: ['robinhood'],
    themes: ['sand-to-server'],
    risk: 'high',
    amountUsd: 2000,
    rules: { useHoldings: true, glide: false },
    obligations: [{ month: inMonths(0), amount: 140, currency: 'USD' }],
  });

  it('is held part by part: each line’s target is what its dollars come to, and the lines say so', () => {
    const plan = run(s, launch, c);
    expect(plan.flags).toContain('coverage_moved');
    const nvda = line(plan, 'robinhood:nvda');
    expect(nvda?.reasons.map((r) => r.rule)).toEqual(
      expect.arrayContaining(['OPENED', 'COVERAGE_MOVED_UNCOUNTED']),
    );
    expect(nvda?.reasons.map((r) => r.rule)).not.toContain('FOLLOWS');
    expect(nvda?.viaIndex).toBeUndefined();
    expect([nvda?.amountUsd, nvda?.weightBps]).toEqual([556.6, 2783]);
    expect(plan.recipes[0]?.components.every((x) => x.kind === 'asset')).toBe(true);
  });

  it('stays whole where nothing is taken from it', () => {
    const plan = run({ ...s, obligations: [] }, launch, c);
    expect(plan.flags).not.toContain('coverage_moved');
    expect(line(plan, 'robinhood:nvda')?.viaIndex).toBe('sand-to-server');
    expect(plan.recipes[0]?.components).toEqual([
      { kind: 'index', family: 'sand-to-server', weightBps: 10_000 },
    ]);
  });
});

describe('moving part of a line to cash', () => {
  it('takes the line’s own part first, and keeps what is through a shared portfolio within the line', () => {
    const w = buildWorld(sheet(), launch, ctx);
    const book = new Book(w);
    const token = w.tokens.find((a) => w.sleeveOf(a) === 'growth');
    if (!token) throw new Error('no stock token on Solana');
    const why = reason('COVERAGE_MOVED_UNCOUNTED', { usd: 0.5, month: inMonths(0) }, 'en');
    book.put(token, 60, []);
    book.put(token, 40, [], 'the-500');
    book.toCash(token.id, 50, why);
    expect(book.lines.get(token.id)?.cents).toBe(50);
    expect(book.lines.get(token.id)?.via.get('the-500')).toBe(40);
    book.toCash(token.id, 30, why);
    expect(book.lines.get(token.id)?.via.get('the-500')).toBe(20);
    expect(book.cash.cents).toBe(80);
  });
});
