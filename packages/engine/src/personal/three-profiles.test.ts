import { describe, expect, it } from 'vitest';
import { compose } from './index';
import {
  distanceBps,
  fixtureContext,
  launchShelf,
  sheet,
  sleeveBps,
  sleeveDistanceBps,
  violations,
} from './testing';
import type { HeldPosition, PersonalProposal, PersonalSheet } from './types';

// The three-profile test (DESIGN-VAULT section 13; on the never-cut list, and part of the gate before
// the link is shared): three people with different goals get three plans at least 3,000 basis points
// apart, with a reason on every line. It runs on the launch shelf and the starting numbers.
//
// A plan lives on one chain, the chain of the wallet the person signed in with. Ana is on Robinhood
// Chain, the only chain where the shared portfolio she chose is published. Bruno and Carla are on
// Solana, which lists gold and two dollar-yield tokens.
//
// NOT MET FOR ONE PAIR, and waiting for Thom's word. Since gate PROTECT-NO-STOCKS (Oct 3) a plan to
// protect holds dollar yield and gold, and an income plan holds dollar yield. On one chain the two
// can differ by the gold share and by how the dollar yield is split, and no more: Bruno and Carla are
// 2,000 basis points apart, under the 3,000 the design asks of every pair. The plan to grow is at
// least 3,000 from both, by token and by sleeve. The pair is pinned at what it is, below.

const shelf = launchShelf();

const PEOPLE: Record<string, { sheet: PersonalSheet; holdings: HeldPosition[] }> = {
  // Grow a small amount over ten years, at high risk, starting from a shared portfolio.
  ana: {
    sheet: sheet({
      goal: 'grow',
      amountUsd: 2_000,
      horizonMonths: 120,
      risk: 'high',
      themes: ['sand-to-server'],
      chains: ['robinhood'],
    }),
    holdings: [],
  },
  // Protect a larger amount needed in 18 months, at low risk. Already holds some Nvidia.
  bruno: {
    sheet: sheet({
      goal: 'protect',
      amountUsd: 50_000,
      horizonMonths: 18,
      risk: 'low',
      language: 'pt',
    }),
    holdings: [{ underlying: 'NVDA', valueUsd: 4_000 }],
  },
  // Live off the income of a larger amount: $300 a month, at medium risk.
  carla: {
    sheet: sheet({
      goal: 'income',
      amountUsd: 80_000,
      horizonMonths: 60,
      risk: 'medium',
      themes: ['the-seven'],
      incomeTargetUsdMonthly: 300,
      language: 'pt',
    }),
    holdings: [{ underlying: 'SOL', valueUsd: 20_000 }],
  },
};

const plans = Object.fromEntries(
  Object.entries(PEOPLE).map(([name, p]) => [
    name,
    compose(p.sheet, shelf, fixtureContext({ holdings: p.holdings })),
  ]),
) as Record<keyof typeof PEOPLE, PersonalProposal>;
const { ana, bruno, carla } = plans as {
  ana: PersonalProposal;
  bruno: PersonalProposal;
  carla: PersonalProposal;
};
const line = (plan: PersonalProposal, id: string) => plan.lines.find((l) => l.assetId === id);

describe('three people, three goals, three plans', () => {
  it('puts the plan to grow at least 3,000 basis points from the other two, by token and by sleeve', () => {
    // Ana is on another chain, so by token she is far from anyone on Solana whatever she holds. The
    // distance by sleeve does not see the chain: it is the shape of the plan that differs.
    for (const [name, other] of [
      ['bruno', bruno],
      ['carla', carla],
    ] as const) {
      expect(distanceBps(ana, other), `ana and ${name}, by token`).toBeGreaterThanOrEqual(3000);
      expect(sleeveDistanceBps(ana, other), `ana and ${name}, by sleeve`).toBeGreaterThanOrEqual(
        3000,
      );
    }
    expect(sleeveDistanceBps(ana, bruno)).toBe(9500);
    expect(sleeveDistanceBps(ana, carla)).toBe(9500);
  });

  it('Bruno and Carla, a plan to protect and an income plan, are 2,000 apart: under the 3,000 asked', () => {
    // See the note at the top: this pair does not meet the design's 3,000 since PROTECT-NO-STOCKS.
    // What sets them apart is Bruno's gold, the cash flow, and Carla's verdict.
    expect(distanceBps(bruno, carla)).toBe(2000);
    expect(sleeveDistanceBps(bruno, carla)).toBe(2000);
    expect(sleeveBps(bruno, shelf, 'gold') - sleeveBps(carla, shelf, 'gold')).toBe(2000);
    expect([bruno.card.cashFlow, carla.card.cashFlow]).toEqual(['at_end', 'monthly']);
    expect([bruno.verdict, carla.verdict?.met]).toEqual([undefined, false]);
  });

  it('gives every line a reason, in the words of the person, naming what they said', () => {
    for (const [name, plan] of Object.entries(plans)) {
      expect(plan.lines.length, name).toBeGreaterThan(1);
      for (const l of plan.lines) {
        expect(l.reasons.length, `${name} ${l.assetId}`).toBeGreaterThan(0);
        expect(
          l.reasons.some((r) => r.inputs.length > 0),
          `${name} ${l.assetId}`,
        ).toBe(true);
        for (const r of l.reasons) expect(r.text, `${name} ${l.assetId}`).toMatch(/\.$/);
      }
    }
    expect(line(ana, 'robinhood:nvda')?.reasons.map((r) => r.text)).toContain(
      'From Sand to Server, a shared portfolio you chose, in its version for Robinhood Chain.',
    );
    expect(line(bruno, 'solana:gldx')?.reasons.map((r) => r.text)).toContain(
      'Para um objetivo de proteção, com risco baixo, a parcela inicial de ouro é 25%.',
    );
  });

  it('makes each plan one a vault can hold: target rules, ceilings, caps, nothing ineligible', () => {
    for (const [name, p] of Object.entries(PEOPLE)) {
      const plan = plans[name];
      if (!plan) throw new Error(name);
      expect(violations(plan, shelf, fixtureContext({ holdings: p.holdings })), name).toEqual([]);
    }
  });

  it('shows three shapes at a glance: the sleeves and the cash flow differ', () => {
    expect([ana, bruno, carla].map((p) => p.card.cashFlow)).toEqual(['none', 'at_end', 'monthly']);
    expect(sleeveBps(ana, shelf, 'growth')).toBe(9500);
    // A plan to protect holds no stocks: dollar yield and gold.
    expect(sleeveBps(bruno, shelf, 'growth')).toBe(0);
    // Dollar yield on Solana is held to the plan's caps (gate SOLVER-PARAMS): jlUSDC to half the plan
    // (one issuer), syrupUSDC to a quarter (the credit budget). What neither takes stays in cash.
    expect(sleeveBps(bruno, shelf, 'dollarYield')).toBe(7500);
    expect(sleeveBps(bruno, shelf, 'gold')).toBe(2000);
    expect(sleeveBps(bruno, shelf, 'cash')).toBe(500);
    expect(sleeveBps(carla, shelf, 'dollarYield')).toBe(7500);
    expect(sleeveBps(carla, shelf, 'cash')).toBe(2500);
  });

  it('Ana follows the shared portfolio she chose, whole, in one recipe on her chain', () => {
    expect(ana.recipes).toEqual([
      {
        chain: 'robinhood',
        amountUsd: 2000,
        components: [
          { kind: 'index', family: 'sand-to-server', weightBps: 9500 },
          { kind: 'asset', asset: 'robinhood:sgov', weightBps: 500 },
        ],
      },
    ]);
    expect(ana.lines.filter((l) => l.viaIndex === 'sand-to-server')).toHaveLength(7);
    expect(line(ana, 'robinhood:nvda')).toMatchObject({ weightBps: 2850, amountUsd: 570 });
    expect(ana.lines.every((l) => l.chain === 'robinhood')).toBe(true);
  });

  it('Bruno: gold stops at its exit capacity, and the rest is held in dollar yield on the same chain', () => {
    expect(bruno.lines.every((l) => l.chain === 'solana')).toBe(true);
    expect(bruno.recipes.map((r) => [r.chain, r.amountUsd])).toEqual([['solana', 50_000]]);
    expect(line(bruno, 'solana:gldx')).toMatchObject({ amountUsd: 10_000, weightBps: 2000 });
    expect(line(bruno, 'solana:gldx')?.reasons.map((r) => r.text)).toContain(
      'GLDx fica limitado a US$ 10.000: acima disso, vender custaria caro demais.',
    );
    // syrupUSDC pays more after haircut, but it lends to borrowers: a quarter of the plan at most, at
    // the credit risk he did not state. jlUSDC takes half, the most with one issuer. The $2,500 gold
    // could not take finds no room in dollar yield and stays in cash, and the cash line says why.
    expect(line(bruno, 'solana:syrupusdc')).toMatchObject({ weightBps: 2500 });
    expect(line(bruno, 'solana:jlusdc')).toMatchObject({ weightBps: 5000 });
    expect(line(bruno, 'solana:usdc')).toMatchObject({ weightBps: 500 });
    expect(bruno.lines).toHaveLength(4);
    expect(line(bruno, 'solana:usdc')?.reasons.map((r) => r.text)).toContain(
      'US$ 2.500 que iria para GLD fica em rendimento em dólar ou caixa: GLDx comporta no máximo US$ 10.000.',
    );
    expect(line(bruno, 'solana:jlusdc')?.reasons.map((r) => r.rule)).toContain('ISSUER_CAP_PLAN');
    expect(line(bruno, 'solana:syrupusdc')?.reasons.map((r) => r.rule)).toContain(
      'CREDIT_BUDGET_UNSAID',
    );
    // He holds Nvidia already; this plan holds none, so there is nothing to cut.
    expect(bruno.lines.some((l) => l.assetId.includes('nvda'))).toBe(false);
  });

  it('Carla: an income plan holds no stock token, and says the goal is not met as set', () => {
    for (const l of carla.lines) expect(l.assetId).toMatch(/usdc|sgov|usdg/);
    expect(carla.removed.find((r) => r.ref === 'the-seven')?.reasons.map((r) => r.rule)).toEqual([
      'THEME_NOT_FOR_GOAL',
    ]);
    expect(carla.verdict?.met).toBe(false);
    expect(carla.verdict?.gapUsdMonthly).toBeGreaterThan(0);
    expect(carla.verdict?.ways.map((w) => w.closesGap)).toContain(true);
    expect(ana.verdict).toBeUndefined();
  });
});
