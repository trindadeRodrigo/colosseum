import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import { fixtureContext, launchShelf, sheet, violations } from './testing';
import type { PersonalParameters, PersonalProposal, PersonalSheet } from './types';

// Decided on Oct 3 (gate PROTECT-NO-STOCKS): a plan whose goal is to protect holds dollar yield, gold
// and cash, and nothing else. The asset list's eligibility is what holds it (registry.test.ts); these
// are the plans that come out.

const shelf = launchShelf();
const classOf = new Map(shelf.assets.map((a) => [a.id, a.cls]));
const CHAINS = ['solana', 'robinhood', 'base'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const ALLOWED = ['cash', 'dollar_yield', 'gold'];

function plan(over: Partial<PersonalSheet>, params?: PersonalParameters): PersonalProposal {
  const ctx = fixtureContext(params ? { params } : {});
  const made = compose(sheet({ goal: 'protect', ...over }), shelf, ctx);
  expect(violations(made, shelf, ctx)).toEqual([]);
  return made;
}
const sleevesOf = (made: PersonalProposal) =>
  Object.fromEntries(made.sleeves.map((x) => [x.sleeve, x.weightBps]));
const reasonsOn = (made: PersonalProposal, id: string) =>
  made.lines.find((l) => l.assetId === id)?.reasons ?? [];

describe('a plan to protect', () => {
  it('holds no stock token, no crypto and no other commodity, whatever the chain, the risk and what is chosen', () => {
    const chosen = [
      [],
      ['the-seven'],
      ['storm-cellar'],
      ['crypto-in-a-suit', 'home-team'],
      ['storm-cellar', 'the-500', 'the-seven'],
    ];
    for (const chain of CHAINS)
      for (const risk of RISKS)
        for (const themes of chosen) {
          const made = plan({ chains: [chain], risk, themes, amountUsd: 25_000 });
          for (const l of made.lines)
            expect(ALLOWED, `${l.assetId} on ${chain} at ${risk} risk`).toContain(
              classOf.get(l.assetId),
            );
          expect(sleevesOf(made).growth, `${chain} ${risk}`).toBe(0);
        }
  });

  it('holds none under a table that gives it a stock sleeve: the asset list refuses, not the table', () => {
    const withStocks: PersonalParameters = {
      ...PERSONAL_PARAMS,
      sleeves: {
        ...PERSONAL_PARAMS.sleeves,
        'protect:medium': { growthBps: 3500, dollarYieldBps: 4000, goldBps: 2500 },
      },
      defaultTheme: { ...PERSONAL_PARAMS.defaultTheme, protect: 'storm-cellar' },
    };
    const made = plan({}, withStocks);
    for (const l of made.lines) expect(ALLOWED, l.assetId).toContain(classOf.get(l.assetId));
    // What the table meant for stocks is held in dollar yield, and the plan says what was refused.
    expect(sleevesOf(made)).toEqual({ growth: 0, dollarYield: 7500, gold: 2500, cash: 0 });
    expect(made.removed.find((r) => r.ref === 'SPY')?.reasons.map((r) => r.text)).toEqual([
      'SPY is left out: the asset list does not allow it in a plan for a goal to protect.',
    ]);
  });

  it('leaves out a chosen portfolio that holds stock tokens, whole, and names the token in the way', () => {
    const made = plan({ themes: ['storm-cellar'] });
    expect(made.removed.map((r) => [r.ref, r.reasons.map((x) => x.text)])).toEqual([
      [
        'storm-cellar',
        [
          'Storm Cellar is left out: it holds SPY, and the asset list does not allow SPY in a plan for a goal to protect.',
        ],
      ],
    ]);
    // Not followed, and not opened for its gold either: no line says it comes from it.
    const said = made.lines.flatMap((l) => l.reasons);
    expect(said.filter((r) => ['FROM_THEME', 'FOLLOWS', 'OPENED'].includes(r.rule))).toEqual([]);
    expect(reasonsOn(made, 'solana:gldx').map((r) => r.text)).toContain(
      'GLD holds the gold share of this plan: no shared portfolio you chose fills it.',
    );
    // In Portuguese too.
    const pt = plan({ themes: ['storm-cellar'], language: 'pt' });
    expect(pt.removed[0]?.reasons[0]?.text).toBe(
      'Storm Cellar fica de fora: tem SPY, e a lista de ativos não permite SPY em um plano para um objetivo de proteção.',
    );
  });

  it('with nothing chosen is built from the sleeves: dollar yield by its yield, gold from the table', () => {
    const made = plan({});
    expect(sleevesOf(made)).toEqual({ growth: 0, dollarYield: 7500, gold: 2500, cash: 0 });
    expect(made.removed).toEqual([]);
    expect(reasonsOn(made, 'solana:gldx').map((r) => r.text)).toEqual(
      expect.arrayContaining([
        'For a goal to protect at medium risk, the starting share of gold is 25%.',
        'GLD: where a goal to protect starts when you choose no shared portfolio.',
      ]),
    );
    expect(reasonsOn(made, 'solana:syrupusdc').map((r) => r.rule)).toEqual(
      expect.arrayContaining(['SLEEVE', 'BY_YIELD']),
    );
  });

  it('leaves a plan to grow as it was: Storm Cellar is still held', () => {
    const ctx = fixtureContext();
    const made = compose(sheet({ goal: 'grow', themes: ['storm-cellar'] }), shelf, ctx);
    expect(violations(made, shelf, ctx)).toEqual([]);
    expect(reasonsOn(made, 'solana:spyx').map((r) => r.rule)).toContain('FROM_THEME');
    expect(made.removed.some((r) => r.ref === 'storm-cellar')).toBe(false);
  });

  it('leaves out of an income plan, the same way, a portfolio that holds what pays no income', () => {
    const ctx = fixtureContext();
    const made = compose(sheet({ goal: 'income', themes: ['storm-cellar'] }), shelf, ctx);
    expect(violations(made, shelf, ctx)).toEqual([]);
    expect(made.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)])).toEqual([
      ['storm-cellar', ['THEME_NOT_FOR_GOAL']],
    ]);
  });
});
