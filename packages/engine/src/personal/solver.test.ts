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

describe('one issuer by risk, whatever the plan holds with it (review 2 of Oct 6, finding 1)', () => {
  const tokens = new Map(shelf.assets.map((a) => [a.id, a]));
  /** What a plan holds with one issuer, over every class but the plan's own cash, in basis points. */
  const withIssuer = (plan: PersonalProposal, issuer: string) =>
    plan.lines
      .filter((l) => {
        const a = tokens.get(l.assetId);
        return a !== undefined && a.cls !== 'cash' && a.issuer === issuer;
      })
      .reduce((n, l) => n + l.weightBps, 0);
  const noGlide = { useHoldings: true, glide: false };
  /** The starting table with another row for a goal to grow at medium risk. */
  const withRow = (growthBps: number, dollarYieldBps: number, goldBps: number): ComposeContext =>
    fixtureContext({
      params: {
        ...PERSONAL_PARAMS,
        sleeves: {
          ...PERSONAL_PARAMS.sleeves,
          'grow:medium': { growthBps, dollarYieldBps, goldBps },
        },
      },
    });

  it('what stocks could not take is not put back with their issuer past its limit: Robinhood Chain', () => {
    // Every token of Robinhood Chain but its cash has one issuer. A goal to grow at low risk: 30% in
    // SGOV and 10% in gold come first, and the stocks take what is left of the issuer's 50%. The $5,000
    // the stocks could not take went on to SGOV, and the plan held 60% with the issuer it called "at
    // that limit". It stays in cash, and the sentence is so.
    const low = run(sheet({ chains: ['robinhood'], risk: 'low', rules: noGlide }));
    expect(low.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['robinhood:spy', 1000],
      ['robinhood:sgov', 3000],
      ['robinhood:gld', 1000],
      ['robinhood:usdg', 5000],
    ]);
    expect(withIssuer(low, 'Robinhood')).toBe(5000);
    expect(rulesOn(low, 'robinhood:usdg')).toEqual(
      expect.arrayContaining(['OVERFLOW_ISSUER', 'ISSUER_CAP', 'UNPLACED']),
    );
    expect(line(low, 'robinhood:usdg')?.reasons.find((r) => r.rule === 'ISSUER_CAP')?.text).toBe(
      'No more than 50% of the plan with one issuer at low risk: Robinhood is at that limit.',
    );
    // At medium risk: 70% with the issuer, where the plan held 95% and said 70%.
    const medium = run(sheet({ chains: ['robinhood'], risk: 'medium', rules: noGlide }));
    expect(withIssuer(medium, 'Robinhood')).toBe(7000);
    expect(line(medium, 'robinhood:usdg')?.weightBps).toBe(3000);
    // On Solana the dollar-yield tokens have issuers of their own, and take what the stocks could not.
    const solana = run(sheet({ risk: 'low', rules: noGlide }));
    expect(withIssuer(solana, 'Backed (xStocks)')).toBe(5000);
    expect(line(solana, 'solana:usdc')).toBeUndefined();
  });

  it('a portfolio held whole gives way to what is placed after it, and its lines say why', () => {
    // The Seven at 60% of the plan fits one issuer at medium risk, which may hold 70%, and it is
    // booked before the gold. With 20% in gold of the same issuer that is 80%: the portfolio is held
    // part by part, each stock cut alike, as stocks placed after the gold are.
    for (const [chain, row, issuer, other] of [
      ['solana', withRow(6000, 0, 2000), 'Backed (xStocks)', 'solana:gldx'],
      ['robinhood', withRow(6000, 2000, 0), 'Robinhood', 'robinhood:sgov'],
    ] as const) {
      const plan = run(sheet({ chains: [chain], themes: ['the-seven'], rules: noGlide }), row);
      expect(withIssuer(plan, issuer), chain).toBe(7000);
      expect(line(plan, other)?.weightBps, chain).toBe(2000);
      const nvda = plan.lines.find((l) => tokens.get(l.assetId)?.underlying === 'NVDA');
      expect(
        nvda?.reasons.map((r) => r.rule),
        chain,
      ).toEqual(expect.arrayContaining(['OPENED', 'NOT_WHOLE_ISSUER', 'ISSUER_CAP']));
      expect(nvda?.reasons.find((r) => r.rule === 'NOT_WHOLE_ISSUER')?.text, chain).toBe(
        `The Seven cannot be held whole: more than 70% of the plan would be with ${issuer}, the most with one issuer at medium risk.`,
      );
      expect(plan.recipes.flatMap((r) => r.components).every((c) => c.kind === 'asset')).toBe(true);
    }
  });

  it('and is held whole where its issuer has room for it beside the rest', () => {
    // 50% in The Seven and 20% in SGOV on Robinhood Chain: 70% with the one issuer, its limit.
    const plan = run(
      sheet({ chains: ['robinhood'], themes: ['the-seven'], rules: noGlide }),
      withRow(5000, 2000, 0),
    );
    expect(withIssuer(plan, 'Robinhood')).toBe(7000);
    expect(plan.recipes.flatMap((r) => r.components).map((c) => [c.kind, c.weightBps])).toEqual([
      ['index', 5000],
      ['asset', 2000],
    ]);
  });

  it('the plan’s own cap names what it counts: dollar yield, gold and other currencies', () => {
    const plan = run();
    expect(
      line(plan, 'solana:jlusdc')?.reasons.find((r) => r.rule === 'ISSUER_CAP_PLAN')?.text,
    ).toBe(
      'No more than 50% of the plan in dollar yield, gold and other currencies with one issuer: Jupiter Lend is at that limit.',
    );
    const pt = run(sheet({ ...income, language: 'pt' }));
    expect(line(pt, 'solana:jlusdc')?.reasons.find((r) => r.rule === 'ISSUER_CAP_PLAN')?.text).toBe(
      'No máximo 50% do plano em rendimento em dólar, ouro e outras moedas com um só emissor: Jupiter Lend está nesse limite.',
    );
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

describe('a line that took nothing is handed on', () => {
  it('two credit tokens and one plain one, two lines: the plain one gets the line the second credit token could not use', () => {
    // A second credit token at 4.0% after haircut: under syrupUSDC (4.68%) by more than the band, over
    // jlUSDC (3.1%). syrupUSDC uses up the credit budget, so the second takes nothing.
    const twin: BasketAsset = {
      ...(shelf.assets.find((a) => a.id === 'solana:syrupusdc') as BasketAsset),
      id: 'solana:syrupusdt',
      symbol: 'syrupUSDC',
      issuer: 'Twin',
      address: 'So11111111111111111111111111111111111111112',
    };
    const on = { ...shelf, assets: [...shelf.assets, twin] };
    const ys = [
      ...fixtureYields(),
      {
        ...(fixtureYields().find((y) => y.assetId === 'solana:syrupusdc') as YieldObservation),
        assetId: 'solana:syrupusdt',
        haircutYield: 0.04,
      },
    ];
    const ctx = fixtureContext({ yields: ys, params: { ...PERSONAL_PARAMS, maxLinesPerChain: 2 } });
    const plan = run(income, ctx, on);
    expect(line(plan, 'solana:jlusdc')?.weightBps).toBe(5000);
  });
});
