import type { ChainId } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { candidates, compose, composeAs, riskForMix } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  allReasons,
  expectedSleeves,
  fixtureContext,
  fixtureYields,
  launchShelf,
  NOW,
  sheet,
  sleeveBps,
  violations,
  withCapsOf,
} from './testing';
import {
  type ComposeContext,
  PersonalInputError,
  type PersonalMix,
  type PersonalProposal,
  PersonalSheet,
  type RiskLevel,
} from './types';
import { monthAfter } from './world';

// Gate EXPLICIT-MIX (Rodrigo, Oct 6): when a person states what they want held, the plan holds it and
// no risk question is asked. The mix replaces the table's row; the limits are the lowest risk whose
// caps admit it, said once; the caps on one asset, one issuer and the exit still hold, and each line
// says where they keep the plan from the mix. No stocks in a plan for income or to protect.

const shelf = launchShelf();
const ctx = fixtureContext();
const run = (s: PersonalSheet, c: ComposeContext = ctx) => {
  const plan = compose(s, shelf, c);
  expect(violations(plan, shelf, c)).toEqual([]);
  return plan;
};
const mix = (over: Partial<PersonalMix>): PersonalMix => ({
  growthBps: 0,
  dollarYieldBps: 0,
  goldBps: 0,
  cashBps: 0,
  ...over,
});
const rules = (plan: ReturnType<typeof compose>) => allReasons(plan).map((r) => r.rule);
const noGlide = { useHoldings: true, glide: false };
/** `usd` a month for `months` months, from the month the plan is made in (October 2026). */
const monthly = (usd: number, months: number) =>
  Array.from({ length: months }, (_, m) => ({
    month: monthAfter(NOW, m),
    amount: usd,
    currency: 'USD',
  }));
const said = (plan: PersonalProposal, assetId: string) =>
  plan.lines.find((l) => l.assetId === assetId)?.reasons ?? [];
const heldIn = (plan: PersonalProposal) => ({
  growth: sleeveBps(plan, shelf, 'growth'),
  dollarYield: sleeveBps(plan, shelf, 'dollarYield'),
  gold: sleeveBps(plan, shelf, 'gold'),
  cash: sleeveBps(plan, shelf, 'cash'),
});

describe('the chat of Oct 6: $2,000 in big tech, all of it in stocks, about 5 years', () => {
  // The intake reads "big tech" as The Seven, "all of it in stocks" as the mix, and "I would say
  // 5 years" as a soft horizon with no glide. The risk on the sheet is whatever the intake had: the
  // plan takes the limits from the mix.
  const chat = sheet({
    amountUsd: 2000,
    horizonMonths: 60,
    risk: 'low',
    themes: ['the-seven'],
    rules: { useHoldings: true, glide: false },
    mix: mix({ growthBps: 10_000 }),
  });

  it('holds all $2,000 in stock tokens, The Seven whole, within the caps', () => {
    const plan = run(chat);
    expect(sleeveBps(plan, shelf, 'growth')).toBe(10_000);
    expect(plan.lines.map((l) => l.assetId).sort()).toEqual(
      ['AAPLx', 'AMZNx', 'GOOGLx', 'METAx', 'MSFTx', 'NVDAx', 'TSLAx']
        .map((s) => `solana:${s.toLowerCase()}`)
        .sort(),
    );
    expect(rules(plan)).toContain('FOLLOWS');
  });

  it('takes the high-risk limits, says so once per line with the caps, and never the table row', () => {
    const plan = run(chat);
    expect(plan.sheet.risk).toBe('high');
    expect(riskForMix(chat, shelf, ctx)).toBe('high');
    expect(plan.flags).toContain('limits_from_mix:high');
    expect(rules(plan)).not.toContain('SLEEVE');
    const said = plan.lines[0]?.reasons.map((r) => r.text) ?? [];
    expect(said).toContain('You asked for all of it in stocks and crypto.');
    expect(said).toContain(
      'To hold 100% of the plan in stocks and crypto, the plan uses the limits for high risk: at most 35% in one stock or crypto asset, and 100% with one issuer.',
    );
    for (const l of plan.lines)
      expect(l.reasons.filter((r) => r.rule === 'MIX_LIMITS')).toHaveLength(1);
  });

  it('says it in Portuguese', () => {
    const plan = run({ ...chat, language: 'pt' });
    const said = plan.lines[0]?.reasons.map((r) => r.text) ?? [];
    expect(said).toContain('Você pediu tudo em ações e cripto.');
  });

  it('no glide: a soft horizon of 5 years moves nothing into dollar yield', () => {
    const plan = run(chat);
    expect(rules(plan)).not.toContain('GLIDE');
    expect(sleeveBps(plan, shelf, 'dollarYield')).toBe(0);
  });

  it('the candidates keep the mix: one plan, the others the same choice', () => {
    const all = candidates(chat, shelf, ctx);
    for (const c of all.shown) {
      expect(sleeveBps(c.plan, shelf, 'growth')).toBe(10_000);
      expect(violations(c.plan, shelf, ctx)).toEqual([]);
    }
    expect(all.shown.length + all.notShown.length).toBe(3);
  });
});

describe('the limits follow the mix', () => {
  it('70% stocks and 30% cash holds it, at the lowest risk whose issuer cap admits 70%', () => {
    const plan = run(sheet({ mix: mix({ growthBps: 7000, cashBps: 3000 }) }));
    // The 500 is one ETF token: no single-stock cap, and one issuer at medium holds 70%.
    expect(plan.sheet.risk).toBe('medium');
    expect(sleeveBps(plan, shelf, 'growth')).toBe(7000);
    expect(sleeveBps(plan, shelf, 'cash')).toBe(3000);
    expect(allReasons(plan).map((r) => r.text)).toContain('You asked for 30% of the plan in cash.');
  });

  it('a mix with no stocks takes low risk', () => {
    const plan = run(sheet({ mix: mix({ dollarYieldBps: 6000, goldBps: 2000, cashBps: 2000 }) }));
    expect(plan.sheet.risk).toBe('low');
    expect(rules(plan)).not.toContain('MIX_LIMITS');
  });

  it('a stated risk higher than the mix needs is lowered to the lowest that admits it', () => {
    const plan = run(sheet({ risk: 'high', mix: mix({ growthBps: 5000, dollarYieldBps: 5000 }) }));
    expect(plan.sheet.risk).toBe('low');
  });
});

describe('only credit: credit and basis tokens up to the caps', () => {
  it('on Solana, syrupUSDC fills first to its own cap, past the 25% budget of the table', () => {
    const plan = run(sheet({ mix: mix({ dollarYieldBps: 10_000, creditBps: 10_000 }) }));
    const syrup = plan.lines.find((l) => l.assetId === 'solana:syrupusdc');
    expect(syrup?.weightBps).toBe(4000);
    expect(syrup?.reasons.map((r) => r.rule)).toContain('ASSET_CAP');
    const said = rules(plan);
    expect(said).not.toContain('CREDIT_BUDGET_UNSAID');
    expect(said).not.toContain('CREDIT_BUDGET');
    // The rest goes to the nearest holding the caps allow: another dollar-yield token, then cash.
    expect(sleeveBps(plan, shelf, 'dollarYield') + sleeveBps(plan, shelf, 'cash')).toBe(10_000);
  });

  it("a credit share under the caps is the budget, said as the person's", () => {
    const plan = run(sheet({ mix: mix({ dollarYieldBps: 10_000, creditBps: 1000 }) }));
    expect(plan.lines.find((l) => l.assetId === 'solana:syrupusdc')?.weightBps).toBe(1000);
    expect(rules(plan)).toContain('CREDIT_BUDGET_MIX');
  });
});

describe('a mix with no credit', () => {
  it('leaves credit tokens out with the mix as the reason, never a tolerance the person did not state', () => {
    const plan = run(sheet({ mix: mix({ dollarYieldBps: 10_000, creditBps: 0 }) }));
    expect(plan.lines.find((l) => l.assetId === 'solana:syrupusdc')).toBeUndefined();
    expect(rules(plan)).toContain('CREDIT_NONE_MIX');
    expect(rules(plan)).not.toContain('CREDIT_NONE');
  });
});

describe('the caps still hold, and say why', () => {
  it('all in gold: one issuer holds at most half, the rest goes to dollar yield, with why', () => {
    const plan = run(sheet({ mix: mix({ goldBps: 10_000 }) }));
    expect(sleeveBps(plan, shelf, 'gold')).toBeLessThanOrEqual(5000);
    expect(rules(plan)).toContain('ISSUER_CAP_PLAN');
  });

  it('all in stocks at low-risk caps would not fit: the plan takes high', () => {
    // The Seven at low risk: 10% per stock and 50% per issuer. Only high admits 100%.
    const s = sheet({
      themes: ['the-seven'],
      mix: mix({ growthBps: 10_000 }),
      rules: { useHoldings: true, glide: false },
    });
    expect(riskForMix(s, shelf, ctx)).toBe('high');
  });
});

describe('no stocks in a plan for income or to protect (gate PROTECT-NO-STOCKS)', () => {
  it.each(['income', 'protect'] as const)('a mix with stocks for %s is refused', (goal) => {
    const s = sheet({ goal, mix: mix({ growthBps: 10_000 }) });
    expect(PersonalSheet.safeParse(s).success).toBe(false);
    expect(() => compose(s, shelf, ctx)).toThrow(PersonalInputError);
  });

  it('a mix with no stocks for income holds it', () => {
    const plan = run(sheet({ goal: 'income', mix: mix({ dollarYieldBps: 8000, cashBps: 2000 }) }));
    expect(sleeveBps(plan, shelf, 'growth')).toBe(0);
  });

  it('a mix that does not add up, or with more credit than dollar yield, is refused', () => {
    expect(PersonalSheet.safeParse(sheet({ mix: mix({ growthBps: 9000 }) })).success).toBe(false);
    expect(
      PersonalSheet.safeParse(
        sheet({ mix: mix({ dollarYieldBps: 5000, cashBps: 5000, creditBps: 6000 }) }),
      ).success,
    ).toBe(false);
    expect(
      PersonalSheet.safeParse(
        sheet({
          mix: mix({ growthBps: 10_000 }),
          sleeves: [{ kind: 'goal', shareBps: 10_000 }],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('the limits admit the mix as placement places it (review of Oct 6, finding 3)', () => {
  it('Base, Chips & Agents, 60% stocks and 40% cash: the limits of medium risk, and the 60% is held', () => {
    // Nine tenths of the portfolio is Coinbase stock tokens and one tenth VIRTUAL. At low risk
    // Coinbase may hold 50% of the plan and its names ask for 54%: they are cut together, and VIRTUAL
    // keeps its own weight, so 56.67% is held. A sum of each issuer's room called that a fit.
    const s = sheet({
      chains: ['base'],
      themes: ['chips-and-agents'],
      rules: noGlide,
      mix: mix({ growthBps: 6000, cashBps: 4000 }),
    });
    const plan = run(s);
    expect(plan.sheet.risk).toBe('medium');
    expect(riskForMix(s, shelf, ctx)).toBe('medium');
    expect(heldIn(plan)).toEqual({ growth: 6000, dollarYield: 0, gold: 0, cash: 4000 });
    expect(rules(plan)).not.toContain('OVERFLOW_ISSUER');
  });

  it('Solana, The 500 with Home Team, all in stocks: the limits of medium risk, and all of it is held', () => {
    // At low risk Home Team's largest names pass the cap on one crypto asset. What is over moves to
    // the sleeve's other names, The 500 among them, whose issuer then passes its 50%: 91.67% held.
    const s = sheet({
      themes: ['the-500', 'home-team'],
      rules: noGlide,
      mix: mix({ growthBps: 10_000 }),
    });
    const plan = run(s);
    expect(plan.sheet.risk).toBe('medium');
    expect(riskForMix(s, shelf, ctx)).toBe('medium');
    expect(heldIn(plan)).toEqual({ growth: 10_000, dollarYield: 0, gold: 0, cash: 0 });
  });

  it('counts the gold and the dollar yield of the mix that sit with the issuer of the stocks', () => {
    // On Solana the gold token and the stock tokens have one issuer. 30% in gold leaves that issuer
    // room for 20% in stocks at low risk and 40% at medium: only the limits of high risk hold 50%.
    const solana = sheet({
      rules: noGlide,
      mix: mix({ growthBps: 5000, goldBps: 3000, cashBps: 2000 }),
    });
    expect(riskForMix(solana, shelf, ctx)).toBe('high');
    expect(heldIn(run(solana))).toEqual({ growth: 5000, dollarYield: 0, gold: 3000, cash: 2000 });
    // On Robinhood Chain the dollar-yield token and the gold token are that issuer's too.
    const robinhood = run(
      sheet({
        chains: ['robinhood'],
        rules: noGlide,
        mix: mix({ growthBps: 4000, dollarYieldBps: 3000, goldBps: 3000 }),
      }),
    );
    expect(robinhood.sheet.risk).toBe('high');
    expect(heldIn(robinhood).growth).toBe(4000);
  });

  it('the three candidates take the limits of the plan, and Carry is the plan', () => {
    const s = sheet({
      chains: ['robinhood'],
      rules: noGlide,
      obligations: monthly(300, 8),
      mix: mix({ growthBps: 5000, cashBps: 5000 }),
    });
    const plan = compose(s, shelf, ctx);
    expect(plan.sheet.risk).toBe('medium');
    for (const id of ['cover', 'spread', 'carry'] as const)
      expect(composeAs(id, s, shelf, ctx).sheet.risk, id).toBe('medium');
    const { candidate: _c, scorecard: _s, ...carry } = composeAs('carry', s, shelf, ctx);
    expect(carry).toEqual(plan);
  });

  it('takes the highest risk when none admits the mix, and the cap says what keeps the plan from it', () => {
    // Home Team with three of its five names ruled out: two crypto assets, 35% each at the most.
    const plan = run(
      sheet({
        themes: ['home-team'],
        rules: noGlide,
        limits: { cannotHold: { underlyings: ['RAY', 'MET', 'KMNO'] } },
        mix: mix({ growthBps: 10_000 }),
      }),
    );
    expect(plan.sheet.risk).toBe('high');
    expect(heldIn(plan).growth).toBe(7000);
    expect(said(plan, 'solana:jup').map((r) => r.rule)).toContain('SINGLE_STOCK_CAP');
    expect(rules(plan)).toContain('OVERFLOW_STOCK_CAP');
  });

  it('a date keeps the limits the mix takes: it moves money out of stocks whatever the risk', () => {
    // 70% in stocks takes the limits of medium risk. A date a year out leaves 10% in stocks. The
    // limits stay the ones the read-back stated for the mix, and the line says what the date did.
    const plan = run(sheet({ horizonMonths: 12, mix: mix({ growthBps: 7000, cashBps: 3000 }) }));
    expect(plan.sheet.risk).toBe('medium');
    expect(heldIn(plan).growth).toBe(1000);
    expect(said(plan, 'solana:spyx').map((r) => r.rule)).toEqual(
      expect.arrayContaining(['MIX_LIMITS', 'GLIDE']),
    );
  });

  it('the mix alone takes one risk at any amount, and it is the risk the plan takes', () => {
    // What a read-back asks before the amount is known: the mix, the portfolios and the chain.
    const cases: [string[], PersonalMix, RiskLevel][] = [
      [['the-seven'], mix({ growthBps: 10_000 }), 'high'],
      [[], mix({ growthBps: 7000, cashBps: 3000 }), 'medium'],
      [['the-500', 'home-team'], mix({ growthBps: 10_000 }), 'medium'],
      [[], mix({ growthBps: 5000, goldBps: 3000, cashBps: 2000 }), 'high'],
      [[], mix({ growthBps: 5000, dollarYieldBps: 5000 }), 'low'],
    ];
    for (const [themes, m, risk] of cases)
      for (const amountUsd of [10, 1000.01, 10_000, 1_000_000]) {
        const s = sheet({
          amountUsd,
          themes,
          rules: { useHoldings: false, glide: false },
          mix: m,
        });
        expect(riskForMix(s, shelf, ctx), `${themes} at ${amountUsd}`).toBe(risk);
        expect(compose(s, shelf, ctx).sheet.risk, `${themes} at ${amountUsd}`).toBe(risk);
      }
  });
});

describe('self-check: the measure sees what it measures (review of Oct 6, finding 8)', () => {
  /** A copy of a plan with something changed, as a broken engine would have made it. */
  const tampered = (plan: PersonalProposal, change: (copy: PersonalProposal) => void) => {
    const copy = structuredClone(plan);
    change(copy);
    return violations(copy, shelf, ctx);
  };
  const chips = sheet({
    chains: ['base'],
    themes: ['chips-and-agents'],
    rules: noGlide,
    mix: mix({ growthBps: 6000, cashBps: 4000 }),
  });

  it('a plan at a lower risk than the mix needs, or a higher one, is seen', () => {
    const plan = run(chips);
    expect(plan.sheet.risk).toBe('medium');
    const relabel = (risk: RiskLevel) => (copy: PersonalProposal) => {
      copy.sheet.risk = risk;
      copy.flags = copy.flags.map((f) =>
        f.startsWith('limits_from_mix:') ? `limits_from_mix:${risk}` : f,
      );
    };
    expect(tampered(plan, relabel('low'))).toContain(
      'the mix alone needs the limits of medium risk, and the plan took low',
    );
    expect(tampered(plan, relabel('high'))).toContain(
      'at medium risk no cap keeps stocks out of this plan, and it took high',
    );
  });

  it('a class that holds less than asked needs a reason of its own: a note on another line is not one', () => {
    // 10% moved from stocks to cash with no word. Every stock line still carries its tier note, and
    // the cash line its own sentence: neither says why stocks hold less.
    const plan = run(chips);
    const moved = tampered(plan, (copy) => {
      const stock = copy.lines.find((l) => l.assetId === 'base:nvdac');
      const cash = copy.lines.find((l) => l.assetId === 'base:usdc');
      if (!stock || !cash) throw new Error('no such line');
      stock.weightBps -= 1000;
      cash.weightBps += 1000;
    });
    expect(moved).toContain('growth holds 5000 bps of the 6000 asked, and no line of it says why');
    expect(moved).toContain(
      'cash holds 5000 bps, over the 4000 of the mix, and no line of it says why',
    );
    expect(allReasons(plan).some((r) => r.rule === 'TIER_CEILING')).toBe(true);
  });

  it('dollar yield and cash are measured too, each against its own share', () => {
    const plan = run(sheet({ rules: noGlide, mix: mix({ dollarYieldBps: 5000, cashBps: 5000 }) }));
    const swapped = tampered(plan, (copy) => {
      const dollarYield = copy.lines.find((l) => l.assetId === 'solana:jlusdc');
      const cash = copy.lines.find((l) => l.assetId === 'solana:usdc');
      if (!dollarYield || !cash) throw new Error('no such line');
      dollarYield.weightBps -= 1500;
      cash.weightBps += 1500;
    });
    expect(swapped).toEqual(
      expect.arrayContaining([
        'dollarYield holds 3500 bps of the 5000 asked, and no line of it says why',
        'cash holds 6500 bps, over the 5000 of the mix, and no line of it says why',
      ]),
    );
  });
});

describe('properties: any mix', () => {
  /** A mix in whole percents, adding up to 100%. */
  const mixes = fc
    .tuple(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
    )
    .map(([a, b, c, d, credit]): PersonalMix => {
      const total = a + b + c + d || 1;
      const growthBps = Math.floor((a * 10_000) / total);
      const dollarYieldBps = Math.floor((b * 10_000) / total);
      const goldBps = Math.floor((c * 10_000) / total);
      const cashBps = 10_000 - growthBps - dollarYieldBps - goldBps;
      return {
        growthBps,
        dollarYieldBps,
        goldBps,
        cashBps,
        ...(credit > 50 ? { creditBps: Math.floor((dollarYieldBps * credit) / 100) } : {}),
      };
    });

  it('keeps every rule of a plan, holds no more stocks or gold than asked, and the table never shows', () => {
    fc.assert(
      fc.property(
        mixes,
        fc.constantFrom<ChainId>('solana', 'robinhood', 'base'),
        fc.constantFrom<string[]>([], ['the-seven'], ['the-500'], ['storm-cellar']),
        fc.constantFrom(2000, 10_000, 250_000),
        fc.boolean(),
        (m, chain, themes, amountUsd, glide) => {
          const s = sheet({
            chains: [chain],
            themes,
            amountUsd,
            mix: m,
            rules: { useHoldings: true, glide },
          });
          const plan = compose(s, shelf, ctx);
          expect(violations(plan, shelf, ctx)).toEqual([]);
          const asked = expectedSleeves(plan.sheet, PERSONAL_PARAMS);
          expect(sleeveBps(plan, shelf, 'growth')).toBeLessThanOrEqual(
            asked.growth + plan.lines.length,
          );
          expect(compose(s, shelf, ctx)).toEqual(plan);
        },
      ),
      { numRuns: 60 },
    );
  }, 120_000);
});
describe('properties: the risk a mix takes', () => {
  const RISKS: RiskLevel[] = ['low', 'medium', 'high'];
  // A table with nothing in the way of a mix but the caps by risk: no ceiling at these amounts, a
  // line for every name, and a least line of one basis point. No date, no withdrawal, no holding.
  const roomy = {
    ...PERSONAL_PARAMS,
    tierCeilingUsd: { A: 10_000_000, B: 10_000_000, C: 10_000_000 },
    minLineBps: 1,
    minLineUsd: 0,
    maxLinesPerChain: 16,
  };
  const context: ComposeContext = { now: NOW, yields: fixtureYields(), params: roomy };
  /** A mix in whole percents: stocks first, then dollar yield, gold and cash of what is left. */
  const wholeMixes = fc
    .tuple(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
    )
    .map(([stocks, a, b]): PersonalMix => {
      const rest = 100 - stocks;
      const dollarYield = Math.floor((rest * a) / 200);
      const gold = Math.floor(((rest - dollarYield) * b) / 200);
      return mix({
        growthBps: stocks * 100,
        dollarYieldBps: dollarYield * 100,
        goldBps: gold * 100,
        cashBps: (rest - dollarYield - gold) * 100,
      });
    });
  const starts: [ChainId, string[]][] = [
    ['solana', []],
    ['solana', ['the-seven']],
    ['solana', ['the-500', 'home-team']],
    ['solana', ['the-seven', 'home-team']],
    ['solana', ['crypto-in-a-suit']],
    ['solana', ['storm-cellar']],
    ['base', ['chips-and-agents']],
    ['base', ['the-seven']],
    ['base', ['home-team', 'chips-and-agents']],
    ['robinhood', []],
    ['robinhood', ['sand-to-server']],
    ['robinhood', ['crypto-in-a-suit', 'the-500']],
    ['robinhood', ['storm-cellar']],
  ];

  it('at the risk taken the stated share is held unless no risk admits it, and no lower risk would hold it', () => {
    fc.assert(
      fc.property(
        wholeMixes,
        fc.constantFrom(...starts),
        fc.constantFrom(2000, 10_000, 250_000),
        (m, [chain, themes], amountUsd) => {
          const s = sheet({ chains: [chain], themes, amountUsd, rules: noGlide, mix: m });
          const plan = compose(s, shelf, context);
          expect(violations(plan, shelf, context)).toEqual([]);
          const growthUsd = (p: PersonalProposal) =>
            p.sleeves.find((x) => x.sleeve === 'growth')?.amountUsd ?? 0;
          const asked = (amountUsd * m.growthBps) / 10_000;
          const short = (p: PersonalProposal) => asked - growthUsd(p) >= amountUsd / 10_000;
          // What this sheet holds under the caps of each risk, composed by the engine's one entry
          // with those caps at every risk: no helper of the engine's says what fits.
          const holds = (risk: RiskLevel) =>
            !short(compose(s, shelf, { ...context, params: withCapsOf(roomy, risk) }));
          const lowest = RISKS.find(holds) ?? 'high';
          expect(plan.sheet.risk).toBe(lowest);
          expect(riskForMix(s, shelf, context)).toBe(lowest);
          // Held at the risk taken, unless no risk admits it: then the highest, and less is held.
          expect(short(plan)).toBe(!holds(lowest));
        },
      ),
      { numRuns: 100 },
    );
  }, 240_000);
});
