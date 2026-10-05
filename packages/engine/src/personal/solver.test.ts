import type { BasketAsset, YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { LEG_TYPES } from './leg-types';
import { PERSONAL_PARAMS } from './params';
import {
  editShelf,
  fixtureContext,
  fixtureLiquidity,
  fixtureYields,
  launchShelf,
  sheet,
  violations,
} from './testing';
import type { ComposeContext, PersonalProposal } from './types';

// Slice 1 of docs/vault/PROMPT-BUILD-SOLVER.md: the banded fill and the caps, through `compose`, on
// the starting table of gate SOLVER-PARAMS. The fill alone is in fill.test.ts.

const shelf = launchShelf();
const income = sheet({ goal: 'income', amountUsd: 10_000 });

const line = (plan: PersonalProposal, id: string) => plan.lines.find((l) => l.assetId === id);
const rulesOn = (plan: PersonalProposal, id: string) =>
  line(plan, id)?.reasons.map((r) => r.rule) ?? [];
const run = (s = income, ctx: ComposeContext = fixtureContext(), on = shelf) => {
  const plan = compose(s, on, ctx);
  expect(violations(plan, on, ctx)).toEqual([]);
  return plan;
};
const withYield = (id: string, haircutYield: number): YieldObservation[] =>
  fixtureYields().map((y) => (y.assetId === id ? { ...y, haircutYield } : y));

describe('the caps on dollar yield (C5, C8)', () => {
  it('an income plan on Solana: jlUSDC at the issuer cap, syrupUSDC at the credit budget, the rest in cash', () => {
    const plan = run();
    expect(plan.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:jlusdc', 5000],
      ['solana:syrupusdc', 2500],
      ['solana:usdc', 2500],
    ]);
    expect(rulesOn(plan, 'solana:jlusdc')).toContain('ISSUER_CAP_PLAN');
    expect(rulesOn(plan, 'solana:syrupusdc')).toContain('CREDIT_BUDGET_UNSAID');
    expect(rulesOn(plan, 'solana:usdc')).toContain('UNPLACED');
    expect(plan.flags).toContain('unplaced');
  });

  it('the credit budget follows what the person accepts', () => {
    const none = run(sheet({ ...income, limits: { creditTolerance: 'none' } }));
    expect(line(none, 'solana:syrupusdc')).toBeUndefined();
    const accept = run(sheet({ ...income, limits: { creditTolerance: 'accept' } }));
    // Half the plan may be credit; syrupUSDC's own cap (40%) binds first, and the line says so.
    expect(line(accept, 'solana:syrupusdc')?.weightBps).toBe(4000);
    expect(line(accept, 'solana:syrupusdc')?.reasons.map((r) => r.text)).toContain(
      'syrupUSDC takes at most 40% of the plan, $4,000: the limit for one token of its kind.',
    );
    expect(rulesOn(accept, 'solana:syrupusdc')).not.toContain('CREDIT_BUDGET');
  });

  it('a measured exit capacity under the cap is the limit, and it is named', () => {
    const ctx = fixtureContext({
      liquidity: fixtureLiquidity({ 'solana:jlusdc': 4_000, 'solana:syrupusdc': 2_000_000 }),
    });
    const plan = run(income, ctx);
    // 0.25 × $4,000: $1,000, under the issuer cap of $5,000.
    expect(line(plan, 'solana:jlusdc')?.amountUsd).toBe(1000);
    expect(rulesOn(plan, 'solana:jlusdc')).toContain('EXIT_CEILING');
    expect(rulesOn(plan, 'solana:jlusdc')).not.toContain('TIER_CEILING');
    expect(plan.flags).not.toContain('ceiling_from_tier:solana:jlusdc');
  });

  it('an unmeasured token takes its tier as a fallback, and the line and a flag say so', () => {
    const plan = run(sheet({ ...income, amountUsd: 200_000 }));
    // Half of $200,000 is over the tier ceiling of $50,000: the tier binds and is named as a tier.
    expect(line(plan, 'solana:jlusdc')?.amountUsd).toBe(50_000);
    expect(rulesOn(plan, 'solana:jlusdc')).toContain('TIER_CEILING');
    expect(plan.flags).toContain('ceiling_from_tier:solana:jlusdc');
  });

  it('holds one issuer to half the plan across several of its tokens', () => {
    // jlUSDC made a Maple token: syrupUSDC and jlUSDC now share one issuer.
    const oneIssuer = editShelf(shelf, (a) =>
      a.id === 'solana:jlusdc' ? { ...a, issuer: 'Maple' } : a,
    );
    const plan = run(
      sheet({ ...income, limits: { creditTolerance: 'accept' } }),
      fixtureContext(),
      oneIssuer,
    );
    const maple =
      (line(plan, 'solana:jlusdc')?.weightBps ?? 0) +
      (line(plan, 'solana:syrupusdc')?.weightBps ?? 0);
    expect(maple).toBe(5000);
    expect(rulesOn(plan, 'solana:jlusdc')).toContain('ISSUER_CAP_PLAN');
  });

  it('the issuer cap is for dollar yield and gold: stocks keep the cap by risk', () => {
    const grow = run(sheet({ risk: 'high' }));
    const stocks = grow.lines
      .filter((l) => l.assetId.endsWith('x') && l.assetId !== 'solana:gldx')
      .reduce((n, l) => n + l.weightBps, 0);
    expect(stocks).toBeGreaterThan(PERSONAL_PARAMS.issuerCapBps);
  });
});

describe('lines go to tokens that can take money', () => {
  it('a token with no room takes no line: the one after it does, and a token with no line is named', () => {
    const one = { ...PERSONAL_PARAMS, maxLinesPerChain: 1 };
    // No credit risk: syrupUSDC has no room at all, so the one line goes to jlUSDC.
    const none = run(
      sheet({ ...income, limits: { creditTolerance: 'none' } }),
      fixtureContext({ params: one }),
    );
    expect(none.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:jlusdc', 5000],
      ['solana:usdc', 5000],
    ]);
    expect(none.removed.find((r) => r.ref === 'syrupUSDC')?.reasons.map((r) => r.rule)).toEqual([
      'CREDIT_NONE',
    ]);
    // One line and two tokens that can take money: the second is named as left out for want of a line.
    const limited = run(income, fixtureContext({ params: one }));
    expect(limited.lines.map((l) => l.assetId)).toEqual(['solana:syrupusdc', 'solana:usdc']);
    expect(rulesOn(limited, 'solana:usdc')).toContain('MAX_LINES');
  });

  it('what the person says of credit risk moves the plan, and a reason names it', () => {
    const base = run();
    const none = run(sheet({ ...income, limits: { creditTolerance: 'none' } }));
    expect(line(none, 'solana:syrupusdc')).toBeUndefined();
    expect(none.removed.flatMap((r) => r.reasons).some((r) => r.inputs.includes('credit'))).toBe(
      true,
    );
    expect(JSON.stringify(none.lines)).not.toBe(JSON.stringify(base.lines));
  });
});

describe('what is left out, and why (C3, C9)', () => {
  it('a token with no yield reading is left out with the reason, never counted as zero', () => {
    const ctx = fixtureContext({
      yields: fixtureYields().filter((y) => y.assetId !== 'solana:jlusdc'),
    });
    const plan = run(income, ctx);
    expect(line(plan, 'solana:jlusdc')).toBeUndefined();
    expect(plan.removed.find((r) => r.ref === 'jlUSDC')?.reasons.map((r) => r.text)).toEqual([
      'jlUSDC is left out: there is no yield reading for it, and the plan never counts a missing yield as zero.',
    ]);
  });

  it('a dollar-yield token whose kind of yield is not listed is left out with the reason', () => {
    const renamed = editShelf(shelf, (a) =>
      a.id === 'solana:jlusdc' ? { ...a, symbol: 'newUSDC' } : a,
    );
    const plan = run(income, fixtureContext(), renamed);
    expect(line(plan, 'solana:jlusdc')).toBeUndefined();
    expect(plan.removed.find((r) => r.ref === 'newUSDC')?.reasons.map((r) => r.rule)).toEqual([
      'NO_LEG_TYPE',
    ]);
  });

  it('every dollar-yield token on the launch shelf has a leg type, with its source and the date it was read', () => {
    for (const a of shelf.assets.filter((x: BasketAsset) => x.cls === 'dollar_yield')) {
      const row = LEG_TYPES[a.symbol];
      expect(row, a.symbol).toBeDefined();
      expect(row?.types.length, a.symbol).toBeGreaterThan(0);
      expect(row?.source.length, a.symbol).toBeGreaterThan(10);
      expect(row?.readAt, a.symbol).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // syrupUSDC is both: it lends, and its disclosures allow basis trades.
    expect(LEG_TYPES.syrupUSDC?.types).toEqual(['credit', 'basis']);
  });
});

describe('the band (C2), through compose', () => {
  const accept = sheet({ ...income, limits: { creditTolerance: 'accept' } });

  it('two tokens 0.3 points apart share the sleeve evenly, and each line says why', () => {
    // syrupUSDC is 4.68%. A plan to grow: its dollar yield is small enough that no cap binds.
    const ctx = fixtureContext({ yields: withYield('solana:jlusdc', 0.0438) });
    const plan = run(sheet({ limits: { creditTolerance: 'accept' } }), ctx);
    expect(line(plan, 'solana:jlusdc')?.weightBps).toBeGreaterThan(0);
    expect(line(plan, 'solana:jlusdc')?.weightBps).toBe(line(plan, 'solana:syrupusdc')?.weightBps);
    expect(rulesOn(plan, 'solana:jlusdc')).toContain('SHARED_IN_BAND');
    expect(line(plan, 'solana:jlusdc')?.reasons.map((r) => r.text)).toContain(
      'Yields after haircut that differ by 0.5% or less count as equal, so syrupUSDC and jlUSDC share this part equally, each up to its limit.',
    );
  });

  it('0.8 points apart, the higher fills first, up to its limit', () => {
    const ctx = fixtureContext({ yields: withYield('solana:jlusdc', 0.0388) });
    const plan = run(accept, ctx);
    expect(line(plan, 'solana:syrupusdc')?.weightBps).toBe(4000);
    expect(line(plan, 'solana:jlusdc')?.weightBps).toBe(5000);
    expect(rulesOn(plan, 'solana:jlusdc')).not.toContain('SHARED_IN_BAND');
  });
});

describe('the same inputs give the same plan (C1)', () => {
  function shuffled<T>(xs: T[], seed: number): T[] {
    const out = [...xs];
    let s = seed;
    for (let i = out.length - 1; i > 0; i -= 1) {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  it('shuffling the shelf and the yields 100 times gives the same plan, byte for byte', () => {
    const people = [
      income,
      sheet({ goal: 'income', amountUsd: 120_000, limits: { creditTolerance: 'accept' } }),
      sheet({ risk: 'high', themes: ['the-seven'] }),
      sheet({ goal: 'protect', chains: ['robinhood'], amountUsd: 30_000 }),
    ];
    for (const person of people) {
      const first = JSON.stringify(compose(person, shelf, fixtureContext()));
      for (let n = 1; n <= 100; n += 1) {
        const ctx = fixtureContext({ yields: shuffled(fixtureYields(), n) });
        const on = { ...shelf, assets: shuffled(shelf.assets, n * 7) };
        expect(JSON.stringify(compose(person, on, ctx))).toBe(first);
      }
    }
  });
});
