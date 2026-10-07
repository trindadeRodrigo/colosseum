import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compose } from './compose';
import { RISKS } from './mix';
import { PERSONAL_PARAMS } from './params';
import { riskForSleeves } from './sleeve-risk';
import { aiList, fixtureContext, launchShelf, sheet } from './testing';
import type { PersonalProposal, PersonalSheet, RiskLevel } from './types';

// The risk whose limits a sheet held in theme sleeves takes (./sleeve-risk.ts): the lowest risk at
// which the plan holds the most in its theme sleeves' names that it holds at any risk.
//
// It is held two ways, and against no number of the engine's in either:
// 1. On MOCK plans, written here risk by risk: what is counted, and which risk is taken.
// 2. On the engine's own plans, made here at each risk: the answer is the risk the rule names for
//    them, with the names read off the theme's list and not off the class of a token.
// What the engine holds at a risk is its own to decide, and may move with its caps.

vi.mock('./compose', async (original) => {
  const actual = await original<typeof import('./compose')>();
  return { ...actual, compose: vi.fn(actual.compose) };
});
// Each test starts with the engine's own `compose`; one on MOCK plans puts them in its place.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('./compose')>('./compose');
  vi.mocked(compose).mockReset();
  vi.mocked(compose).mockImplementation(actual.compose);
});

const shelf = launchShelf();
const context = fixtureContext({ themes: [aiList()] });
const WHOLE = 10_000;
const CENTS = 100;
/** A sheet with `shareBps` in the AI theme and the rest kept safe. */
const themed = (shareBps: number, over: Partial<PersonalSheet> = {}): PersonalSheet =>
  sheet({
    chains: ['solana'],
    sleeves: [
      { kind: 'theme', theme: 'ai', shareBps },
      ...(shareBps < WHOLE ? [{ kind: 'safe_yield' as const, shareBps: WHOLE - shareBps }] : []),
    ],
    ...over,
  });
/** The lowest risk at which `held` (cents, by risk) is the most, to `rounding` cents. */
const lowestWithMost = (held: number[], rounding: number): RiskLevel | undefined =>
  RISKS[held.findIndex((cents) => cents + rounding >= Math.max(...held))];

describe('the risk a sheet held in theme sleeves takes, on MOCK plans', () => {
  /** The tokens of one class the fixture shelf lists on Solana. */
  const tokensOf = (cls: string): string[] => {
    const found = shelf.assets.filter((a) => a.chain === 'solana' && a.cls === cls);
    if (found.length === 0) throw new Error(`the fixture shelf lists no ${cls} on Solana`);
    return found.map((a) => a.id);
  };
  const [stock = '', other = stock] = tokensOf('stock');
  const [dollarYield = ''] = tokensOf('dollar_yield');
  const [cash = ''] = tokensOf('cash');
  type Hold = { assetId: string; amountUsd: number };
  const hold = (assetId: string, amountUsd: number): Hold => ({ assetId, amountUsd });
  /** A MOCK plan: nothing of it is written but what each of its theme sleeves holds. */
  const mockPlan = (sleeves: Hold[][]): PersonalProposal =>
    ({
      split: sleeves.map((holds) => ({
        kind: 'theme',
        theme: 'ai',
        shareBps: Math.floor(WHOLE / sleeves.length),
        amountUsd: holds.reduce((usd, h) => usd + h.amountUsd, 0),
        holds,
      })),
    }) as unknown as PersonalProposal;
  /** MOCK plans by risk: `compose` answers with the one written for the risk of the sheet it gets. */
  const plansAre = (byRisk: Record<RiskLevel, Hold[][]>) =>
    vi.mocked(compose).mockImplementation((made) => mockPlan(byRisk[made.risk]));
  /** MOCK plans of one sleeve whose names hold `usd` at each risk, lowest first. */
  const namesHold = (...usd: [number, number, number]) => {
    const [low, medium, high] = usd.map((amountUsd) => [[hold(stock, amountUsd)]]);
    plansAre({ low: low ?? [], medium: medium ?? [], high: high ?? [] });
  };
  const risk = (over: Partial<PersonalSheet> = {}, figures = context) =>
    riskForSleeves(themed(WHOLE, over), shelf, figures);

  it('counts what the names hold, and not what the sleeve keeps in dollar yield and cash', () => {
    // The sleeve holds the same sum at every risk: only what its names take of it rises.
    plansAre({
      low: [[hold(stock, 1000), hold(dollarYield, 800), hold(cash, 200)]],
      medium: [[hold(stock, 1400), hold(dollarYield, 600)]],
      high: [[hold(stock, 2000)]],
    });
    expect(risk()).toBe('high');
    // Money kept safe is never what the most is measured by: here the lowest risk keeps the most of it.
    plansAre({
      low: [[hold(stock, 1000), hold(dollarYield, 5000)]],
      medium: [[hold(stock, 1400), hold(cash, 600)]],
      high: [[hold(stock, 1400), hold(dollarYield, 600)]],
    });
    expect(risk()).toBe('medium');
  });

  it('a tie goes to the lower risk', () => {
    namesHold(1000, 2000, 2000);
    expect(risk()).toBe('medium');
    namesHold(2000, 2000, 2000);
    expect(risk()).toBe('low');
  });

  it('takes the lowest risk where no name holds anything at any', () => {
    const kept = [[hold(dollarYield, 1600), hold(cash, 400)]];
    plansAre({ low: kept, medium: kept, high: kept });
    expect(risk()).toBe('low');
    plansAre({ low: [[]], medium: [[]], high: [[]] });
    expect(risk()).toBe('low');
  });

  it('is the most at any risk, and not what the highest risk holds', () => {
    namesHold(1000, 2000, 1500);
    expect(risk()).toBe('medium');
    namesHold(2000, 1500, 1800);
    expect(risk()).toBe('low');
  });

  it('adds up the names of every theme sleeve of the plan', () => {
    plansAre({
      low: [[hold(stock, 500)], [hold(other, 500)]],
      medium: [[hold(stock, 900)], [hold(other, 500), hold(cash, 400)]],
      high: [[hold(stock, 900)], [hold(other, 400), hold(dollarYield, 500)]],
    });
    expect(risk()).toBe('medium');
    // What one theme gains another may lose: the plan holds as much, and the lower risk is taken.
    plansAre({
      low: [[hold(stock, 500)], [hold(other, 900)]],
      medium: [[hold(stock, 900)], [hold(other, 500)]],
      high: [[hold(stock, 700)], [hold(other, 700)]],
    });
    expect(risk()).toBe('low');
  });

  it('a cent for each line a plan may hold is the rounding of its parts, and one cent more is not', () => {
    const lines = PERSONAL_PARAMS.maxLinesPerChain;
    const most = 2000;
    namesHold(most - lines / CENTS, most, most);
    expect(risk()).toBe('low');
    namesHold(most - (lines + 1) / CENTS, most, most);
    expect(risk()).toBe('medium');
    // The lines are those of the table the plan is made with: with twice as many, twice the cents.
    const wider = { ...context, params: { ...PERSONAL_PARAMS, maxLinesPerChain: lines + lines } };
    namesHold(most - (lines + lines) / CENTS, most, most);
    expect(risk({}, wider)).toBe('low');
    expect(risk()).toBe('medium');
  });

  it('makes the plan once at each risk, of the same sheet on the same shelf and figures', () => {
    namesHold(1000, 1400, 2000);
    const asked = themed(7000, { amountUsd: 2000, risk: 'medium' });
    riskForSleeves(asked, shelf, context);
    const calls = vi.mocked(compose).mock.calls;
    expect(calls.map(([made]) => made.risk)).toEqual([...RISKS]);
    for (const [made, on, figures] of calls) {
      expect({ ...made, risk: asked.risk }).toEqual(asked);
      expect(on).toBe(shelf);
      expect(figures).toBe(context);
    }
  });

  it('does not depend on the risk the sheet came with', () => {
    namesHold(1000, 1400, 2000);
    expect(new Set(RISKS.map((came) => risk({ risk: came })))).toEqual(new Set(['high']));
  });

  it('a sheet with no theme sleeve takes its own risk, and no plan is made to find it', () => {
    namesHold(1000, 1400, 2000);
    const split = [
      { kind: 'goal' as const, shareBps: 7000 },
      { kind: 'safe_yield' as const, shareBps: 3000 },
    ];
    for (const own of RISKS) {
      expect(riskForSleeves(sheet({ risk: own }), shelf, context)).toBe(own);
      expect(riskForSleeves(sheet({ risk: own, sleeves: split }), shelf, context)).toBe(own);
    }
    expect(compose).not.toHaveBeenCalled();
  });
});

describe('the risk a sheet held in theme sleeves takes, on the plans of the engine', () => {
  /** The tokens the AI list names on Solana: read off the list, whatever their class. */
  const listed = new Set(aiList().members.map((m) => m.symbol));
  const names = new Set(
    shelf.assets.filter((a) => a.chain === 'solana' && listed.has(a.symbol)).map((a) => a.id),
  );
  /** What the theme sleeves of a plan hold in the names of the list, in cents. */
  const heldInNames = (plan: PersonalProposal): number =>
    (plan.split ?? [])
      .filter((s) => s.kind === 'theme')
      .flatMap((s) => s.holds)
      .reduce((n, h) => (names.has(h.assetId) ? n + Math.round(h.amountUsd * CENTS) : n), 0);
  const rounding = (context.params ?? PERSONAL_PARAMS).maxLinesPerChain;

  it('is the lowest risk at which the plan holds the most in the names of its list, at every share and amount tried', () => {
    let somewhere = 0;
    for (const shareBps of [1000, 3000, 5000, 7000, WHOLE])
      for (const amountUsd of [500, 2000, 50_000, 500_000]) {
        const asked = themed(shareBps, { amountUsd });
        const held = RISKS.map((at) =>
          heldInNames(compose({ ...asked, risk: at }, shelf, context)),
        );
        expect(riskForSleeves(asked, shelf, context), `${shareBps} of ${amountUsd}`).toBe(
          lowestWithMost(held, rounding),
        );
        somewhere = Math.max(somewhere, ...held);
      }
    // The rule is not read off empty plans: somewhere on the grid the names hold something.
    expect(somewhere).toBeGreaterThan(0);
  });

  it('the plan made at that risk holds in its names the most any risk holds, to the rounding', () => {
    for (const shareBps of [3000, WHOLE]) {
      const asked = themed(shareBps, { amountUsd: 2000 });
      const taken = riskForSleeves(asked, shelf, context);
      const there = heldInNames(compose({ ...asked, risk: taken }, shelf, context));
      for (const at of RISKS) {
        const held = heldInNames(compose({ ...asked, risk: at }, shelf, context));
        expect(there + rounding, `${shareBps}: ${taken} beside ${at}`).toBeGreaterThanOrEqual(held);
        // And no lower risk holds as much: that one would have been taken.
        if (RISKS.indexOf(at) < RISKS.indexOf(taken))
          expect(held + rounding, `${shareBps}: ${at} below ${taken}`).toBeLessThan(
            Math.max(
              ...RISKS.map((r) => heldInNames(compose({ ...asked, risk: r }, shelf, context))),
            ),
          );
      }
    }
  });

  it('does not depend on the risk the sheet came with, and is the same each time', () => {
    const answers = RISKS.map((came) =>
      riskForSleeves(themed(7000, { risk: came }), shelf, context),
    );
    expect(new Set(answers).size).toBe(1);
    expect(RISKS).toContain(answers[0]);
    expect(riskForSleeves(themed(7000), shelf, context)).toBe(answers[0]);
  });
});
