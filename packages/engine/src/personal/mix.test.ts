import type { ChainId } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { candidates, compose, riskForMix } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  allReasons,
  expectedSleeves,
  fixtureContext,
  launchShelf,
  sheet,
  sleeveBps,
  violations,
} from './testing';
import { PersonalInputError, type PersonalMix, PersonalSheet } from './types';

// Gate EXPLICIT-MIX (Rodrigo, Oct 6): when a person states what they want held, the plan holds it and
// no risk question is asked. The mix replaces the table's row; the limits are the lowest risk whose
// caps admit it, said once; the caps on one asset, one issuer and the exit still hold, and each line
// says where they keep the plan from the mix. No stocks in a plan for income or to protect.

const shelf = launchShelf();
const ctx = fixtureContext();
const run = (s: PersonalSheet) => {
  const plan = compose(s, shelf, ctx);
  expect(violations(plan, shelf, ctx)).toEqual([]);
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
