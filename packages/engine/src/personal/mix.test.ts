import type { ChainId } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { candidates, compose, composeAs, riskForMix } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  allReasons,
  expectedSleeves,
  fixtureContext,
  fixtureLiquidity,
  fixtureYields,
  LIQUIDITY_SOURCE,
  launchShelf,
  NOW,
  sheet,
  sleeveBps,
  usdBrl,
  violations,
  withCapsOf,
} from './testing';
import {
  type ComposeContext,
  PersonalInputError,
  type PersonalMix,
  PersonalParameters,
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

  it('goes one risk up where what is set aside sits with the issuer of the stocks', () => {
    // Robinhood Chain: half in stocks fits one issuer at low risk. With withdrawals, the $1,800 set
    // aside is held in SGOV, a rate leg of the same issuer: that leaves the stocks 32% at low risk
    // and all of their 50% at medium. The mix alone does not show it; the plan as built does.
    const s = sheet({
      chains: ['robinhood'],
      rules: noGlide,
      mix: mix({ growthBps: 5000, cashBps: 5000 }),
    });
    expect(run(s).sheet.risk).toBe('low');
    const withdrawing = { ...s, obligations: monthly(300, 8) };
    const plan = run(withdrawing);
    expect(plan.sheet.risk).toBe('medium');
    expect(riskForMix(withdrawing, shelf, ctx)).toBe('medium');
    expect(heldIn(plan)).toEqual({ growth: 5000, dollarYield: 1800, gold: 0, cash: 3200 });
    expect(plan.flags).toContain('limits_from_mix:medium');
    expect(said(plan, 'robinhood:spy').find((r) => r.rule === 'MIX_LIMITS')?.params).toMatchObject({
      risk: 'medium',
      issuerCapBps: 7000,
    });
    expect(rules(plan)).not.toContain('OVERFLOW_ISSUER');
  });

  it('goes one risk up where what the person holds moves the plan toward one name', () => {
    // 70% in The Seven is 10% a name: the limits of medium risk (20% in one stock, 70% with one
    // issuer). Holding six of the seven, the plan buys the seventh alone, 25% of it: over medium's
    // cap on one stock, and within the 35% of high risk. The cap that binds here is the one on a
    // single stock, kept out before anything is placed; the issuer's is the case above.
    const s = sheet({
      themes: ['the-seven'],
      rules: noGlide,
      mix: mix({ growthBps: 7000, cashBps: 3000 }),
    });
    expect(run(s).sheet.risk).toBe('medium');
    const holding = fixtureContext({
      holdings: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA'].map((underlying) => ({
        underlying,
        valueUsd: 20_000,
      })),
    });
    const plan = run(s, holding);
    expect(plan.sheet.risk).toBe('high');
    expect(riskForMix(s, shelf, holding)).toBe('high');
    expect(plan.lines.map((l) => l.assetId)).toEqual(['solana:nvdax', 'solana:usdc']);
    expect(sleeveBps(plan, shelf, 'growth')).toBeGreaterThan(2000);
    expect(rules(plan)).not.toContain('OVERFLOW_STOCK_CAP');
    expect(rules(plan)).toContain('MORE_BECAUSE_HELD');
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

  it('a date that moves money out of stocks leaves the plan the limits of what is left', () => {
    // 70% in stocks takes the limits of medium risk. A date a year out leaves 10% in stocks, and the
    // limits of low risk hold that whole: the plan takes those, and its line names the share they
    // are taken for. This test pinned medium until the second review of Oct 6: the rule was then
    // "the mix alone, and up from there", so a date never lowered the limits. It is now the lowest
    // risk at which the plan holds the most, whatever moved the money.
    const s = sheet({ horizonMonths: 12, mix: mix({ growthBps: 7000, cashBps: 3000 }) });
    const plan = run(s);
    expect(plan.sheet.risk).toBe('low');
    expect(heldIn(plan).growth).toBe(1000);
    expect(said(plan, 'solana:spyx').map((r) => r.rule)).toEqual(
      expect.arrayContaining(['MIX_LIMITS', 'GLIDE']),
    );
    expect(said(plan, 'solana:spyx').find((r) => r.rule === 'MIX_LIMITS')?.params).toEqual({
      sleeveBps: 1000,
      risk: 'low',
      stockCapBps: 1000,
      issuerCapBps: 5000,
    });
    // The mix on its own takes medium. The plan is under it, so it says of no limit that it was raised.
    expect(riskForMix({ ...s, rules: noGlide }, shelf, ctx)).toBe('medium');
    expect(rules(plan)).not.toContain('MIX_LIMITS_RAISED');
    expect(plan.flags.some((f) => f.startsWith('limits_raised:'))).toBe(false);
  });

  it('takes the risk of the plan as it is held, at each amount', () => {
    // This test pinned one risk for a mix at any amount until the second review of Oct 6: the mix was
    // tried alone at a size where no ceiling binds, and the plan went up from there. The risk is now
    // read from the plan itself, so it follows what the plan can hold at its size. At $1,000.01 and at
    // $10,000 the risks are the ones that test had.
    const cases: [string[], PersonalMix, RiskLevel][] = [
      [['the-seven'], mix({ growthBps: 10_000 }), 'high'],
      [[], mix({ growthBps: 7000, cashBps: 3000 }), 'medium'],
      [['the-500', 'home-team'], mix({ growthBps: 10_000 }), 'medium'],
      [[], mix({ growthBps: 5000, goldBps: 3000, cashBps: 2000 }), 'high'],
      [[], mix({ growthBps: 5000, dollarYieldBps: 5000 }), 'low'],
    ];
    const RISKS: RiskLevel[] = ['low', 'medium', 'high'];
    const at = (themes: string[], m: PersonalMix, amountUsd: number) => {
      const s = sheet({ amountUsd, themes, rules: { useHoldings: false, glide: false }, mix: m });
      const plan = run(s);
      expect(riskForMix(s, shelf, ctx), `${themes} at ${amountUsd}`).toBe(plan.sheet.risk);
      // What the plan holds in stocks under the caps of each risk, in cents.
      const held = RISKS.map((risk) =>
        Math.round(
          100 *
            (compose(s, shelf, {
              ...ctx,
              params: withCapsOf(PERSONAL_PARAMS, risk),
            }).sleeves.find((x) => x.sleeve === 'growth')?.amountUsd ?? 0),
        ),
      );
      return { risk: plan.sheet.risk, held };
    };
    for (const [themes, m, risk] of cases)
      for (const amountUsd of [1000.01, 10_000])
        expect(at(themes, m, amountUsd).risk, `${themes} at ${amountUsd}`).toBe(risk);
    // $1,000,000 all in The Seven: the ceilings of its names hold 24.32% of the plan from medium
    // risk up, and 20% at low. Medium holds as much as high does, so medium is taken.
    const large = at(['the-seven'], mix({ growthBps: 10_000 }), 1_000_000);
    expect(large.held).toEqual([20_000_000, 24_320_000, 24_320_000]);
    expect(large.risk).toBe('medium');
    // $10: a seventh of it is under the least a line can be at any risk. Nothing is held, at the lowest.
    const small = at(['the-seven'], mix({ growthBps: 10_000 }), 10);
    expect(small.held).toEqual([0, 0, 0]);
    expect(small.risk).toBe('low');
  });
});

describe('the risk is the lowest at which the plan holds the most (review 2 of Oct 6, findings 1 and 2)', () => {
  const tokens = new Map(shelf.assets.map((a) => [a.id, a]));
  /** What a plan holds with one issuer, over every class but the plan's own cash, in basis points. */
  const withIssuer = (plan: PersonalProposal, issuer: string) =>
    plan.lines
      .filter((l) => {
        const a = tokens.get(l.assetId);
        return a !== undefined && a.cls !== 'cash' && a.issuer === issuer;
      })
      .reduce((n, l) => n + l.weightBps, 0);
  const limits = (plan: PersonalProposal) =>
    allReasons(plan).find((r) => r.rule === 'MIX_LIMITS')?.params;
  /** What this sheet holds in stocks and crypto under the caps of one risk, in basis points. */
  const under = (s: PersonalSheet, risk: RiskLevel) =>
    sleeveBps(
      compose(s, shelf, { ...ctx, params: withCapsOf(PERSONAL_PARAMS, risk) }),
      shelf,
      'growth',
    );

  it('a portfolio held whole counts with its issuer as any stocks do: half in gold on Solana', () => {
    // The gold token and the stock tokens of Solana have one issuer. Half in gold beside half in
    // stocks is all of the plan with it, whether the stocks are The 500, opened, or The Seven, held
    // whole: the limits of high risk. A portfolio held whole was booked before the gold and never
    // counted beside it: the plan took low and said "50% with one issuer" with that issuer at 100%.
    for (const themes of [[], ['the-seven']]) {
      const s = sheet({ themes, rules: noGlide, mix: mix({ growthBps: 5000, goldBps: 5000 }) });
      const plan = run(s);
      expect(plan.sheet.risk, String(themes)).toBe('high');
      expect(heldIn(plan)).toEqual({ growth: 5000, dollarYield: 0, gold: 5000, cash: 0 });
      expect(withIssuer(plan, 'Backed (xStocks)')).toBe(10_000);
      expect(limits(plan)).toMatchObject({ risk: 'high', issuerCapBps: 10_000 });
      expect([under(s, 'low'), under(s, 'medium'), under(s, 'high')]).toEqual([0, 2000, 5000]);
    }
    // At the risk whose limits have the room, The Seven is still held whole.
    expect(
      rules(
        run(
          sheet({
            themes: ['the-seven'],
            rules: noGlide,
            mix: mix({ growthBps: 5000, goldBps: 5000 }),
          }),
        ),
      ),
    ).toContain('FOLLOWS');
  });

  it('and so with what is set aside on Robinhood Chain, whether the portfolio is held whole or opened', () => {
    // Half in stocks and half in cash, $300 a month for 8 months. $1,800 is set aside in SGOV, of the
    // issuer of every stock there, so the stocks have 32% of the plan at low risk and their 50% at
    // medium. The Seven and Sand to Server, held whole, took low with 68% at that issuer.
    for (const themes of [[], ['the-seven'], ['sand-to-server']]) {
      const s = sheet({
        chains: ['robinhood'],
        themes,
        rules: noGlide,
        obligations: monthly(300, 8),
        mix: mix({ growthBps: 5000, cashBps: 5000 }),
      });
      const plan = run(s);
      expect(plan.sheet.risk, String(themes)).toBe('medium');
      expect(heldIn(plan)).toEqual({ growth: 5000, dollarYield: 1800, gold: 0, cash: 3200 });
      expect(withIssuer(plan, 'Robinhood')).toBe(6800);
      expect(limits(plan)).toMatchObject({ risk: 'medium', issuerCapBps: 7000 });
      expect(under(s, 'low')).toBe(3200);
    }
  });

  it('a cap on one asset that moves money to names with no room for it counts: Home Team, $60,000', () => {
    // At medium risk JitoSOL is held to 20%. What is over moves to the other four names, and two of
    // them stop at their own ceiling of $10,000: 93.32% is held, and the plan says a ceiling kept the
    // rest out, never a cap by risk. The rule read only what a cap by risk was said to keep out, and
    // stayed at medium. At high risk JitoSOL takes 35% and all of it is held.
    const s = sheet({
      amountUsd: 60_000,
      themes: ['home-team'],
      rules: noGlide,
      mix: mix({ growthBps: 10_000 }),
    });
    const plan = run(s);
    expect(plan.sheet.risk).toBe('high');
    expect(heldIn(plan)).toEqual({ growth: 10_000, dollarYield: 0, gold: 0, cash: 0 });
    expect([under(s, 'low'), under(s, 'medium'), under(s, 'high')]).toEqual([5000, 9332, 10_000]);
    const atMedium = compose(s, shelf, { ...ctx, params: withCapsOf(PERSONAL_PARAMS, 'medium') });
    expect(rules(atMedium)).toContain('OVERFLOW_CEILING');
    expect(rules(atMedium)).not.toContain('OVERFLOW_STOCK_CAP');
    expect(rules(atMedium)).not.toContain('OVERFLOW_ISSUER');
    // At $10,000 no ceiling is in the way, and the limits of medium risk hold all of it.
    expect(run({ ...s, amountUsd: 10_000 }).sheet.risk).toBe('medium');
  });

  it('and so does the number of lines: The Seven with Home Team, all in stocks, $5,000', () => {
    // Twelve names and eight lines. At low risk each line holds 10% at the most and 60% is held; at
    // medium and at high, 70%. The plan said "a plan holds at most 8 parts" and stayed at low.
    const s = sheet({
      amountUsd: 5000,
      themes: ['the-seven', 'home-team'],
      rules: noGlide,
      mix: mix({ growthBps: 10_000 }),
    });
    const plan = run(s);
    expect([under(s, 'low'), under(s, 'medium'), under(s, 'high')]).toEqual([6000, 7000, 7000]);
    // Medium holds as much as high: the lower of the two is taken.
    expect(plan.sheet.risk).toBe('medium');
    expect(heldIn(plan).growth).toBe(7000);
    expect(rules(plan)).toContain('OVERFLOW_MAX_LINES');
  });

  it('a higher risk that holds more is taken, however little more: Sand to Server, $20,000', () => {
    // 70% in stocks on Robinhood Chain. A ceiling of $1,500 on three of the names keeps some out at
    // any risk: 68.93% is held at medium and 69.1% at high, where NVDA may take more of the rest.
    const s = sheet({
      chains: ['robinhood'],
      amountUsd: 20_000,
      themes: ['sand-to-server'],
      rules: noGlide,
      mix: mix({ growthBps: 7000, cashBps: 3000 }),
    });
    expect([under(s, 'low'), under(s, 'medium'), under(s, 'high')]).toEqual([5000, 6893, 6910]);
    expect(run(s).sheet.risk).toBe('high');
  });
});

describe('where the limits are above the ones the mix takes on its own, the plan says so (review 2 of Oct 6, finding 4)', () => {
  /** The mix on its own, as a read-back asks before the rest of the sheet is known. */
  const alone = (s: PersonalSheet): PersonalSheet => {
    const { obligations: _o, limits: _l, ...rest } = s;
    return { ...rest, rules: { useHoldings: false, glide: false } };
  };
  const raised = (plan: PersonalProposal) =>
    allReasons(plan).filter((r) => r.rule === 'MIX_LIMITS_RAISED');
  const raisedFlags = (plan: PersonalProposal) =>
    plan.flags.filter((f) => f.startsWith('limits_raised:'));

  it('withdrawals: what is set aside sits with the issuer of the stocks', () => {
    const s = sheet({
      chains: ['robinhood'],
      rules: noGlide,
      obligations: monthly(300, 8),
      mix: mix({ growthBps: 5000, cashBps: 5000 }),
    });
    expect(riskForMix(alone(s), shelf, ctx)).toBe('low');
    const plan = run(s);
    expect(plan.sheet.risk).toBe('medium');
    expect(raisedFlags(plan)).toEqual(['limits_raised:low:withdrawals']);
    // Said on every line of stocks and crypto, beside the limits themselves, and nowhere else.
    for (const l of plan.lines)
      expect(
        l.reasons.some((r) => r.rule === 'MIX_LIMITS_RAISED'),
        l.assetId,
      ).toBe(l.assetId === 'robinhood:spy');
    expect(raised(plan)[0]?.text).toBe(
      'On its own, this mix takes the limits for low risk. Because of what is set aside for your withdrawals, the plan uses the limits one step up, for medium risk: at lower limits it would hold less in stocks and crypto.',
    );
    expect(raised(run({ ...s, language: 'pt' }))[0]?.text).toBe(
      'Sozinha, esta composição usa os limites de risco baixo. Por causa de o que fica separado para os seus saques, o plano usa os limites um nível acima, de risco médio: com limites mais baixos ele teria menos em ações e cripto.',
    );
    // Every candidate shown takes the plan's limits, and says the same of them.
    for (const c of candidates(s, shelf, ctx).shown) {
      expect(violations(c.plan, shelf, ctx), c.id).toEqual([]);
      expect(raisedFlags(c.plan), c.id).toEqual(['limits_raised:low:withdrawals']);
    }
  });

  it('what the person holds, and what they cannot hold', () => {
    const s = sheet({
      themes: ['the-seven'],
      rules: noGlide,
      mix: mix({ growthBps: 7000, cashBps: 3000 }),
    });
    expect(riskForMix(alone(s), shelf, ctx)).toBe('medium');
    expect(raised(run(s))).toEqual([]);
    // Six of the seven already held: the plan buys the seventh alone, over medium's cap on one stock.
    const holding = fixtureContext({
      holdings: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA'].map((underlying) => ({
        underlying,
        valueUsd: 20_000,
      })),
    });
    const held = run(s, holding);
    expect(held.sheet.risk).toBe('high');
    expect(raised(held)[0]?.params).toEqual({
      alone: 'medium',
      risk: 'high',
      by: 'holdings',
      steps: 1,
    });
    expect(raisedFlags(held)).toEqual(['limits_raised:medium:holdings']);
    // Four of the seven ruled out: three names for 70%, over medium's 20% a name.
    const without = run({
      ...s,
      limits: { cannotHold: { underlyings: ['TSLA', 'META', 'AMZN', 'AAPL'] } },
    });
    expect(without.sheet.risk).toBe('high');
    expect(raised(without)[0]?.text).toBe(
      'On its own, this mix takes the limits for medium risk. Because of what you cannot hold, the plan uses the limits one step up, for high risk: at lower limits it would hold less in stocks and crypto.',
    );
    expect(raisedFlags(without)).toEqual(['limits_raised:medium:cannotHold']);
  });

  it('says nothing where the rest of the sheet leaves the limits as they are, or lower', () => {
    // Withdrawals the mix has the cash for, on a chain where cash and stocks have other issuers.
    const same = run(
      sheet({
        rules: noGlide,
        obligations: monthly(300, 8),
        mix: mix({ growthBps: 7000, cashBps: 3000 }),
      }),
    );
    expect(same.sheet.risk).toBe('medium');
    expect(raised(same)).toEqual([]);
    expect(raisedFlags(same)).toEqual([]);
    // A date that halves the stocks: the limits of low risk hold what is left of them.
    const dated = sheet({
      chains: ['robinhood'],
      horizonMonths: 36,
      rules: { useHoldings: true, glide: true },
      mix: mix({ growthBps: 4000, cashBps: 6000 }),
    });
    expect(riskForMix(alone(dated), shelf, ctx)).toBe('low');
    const lower = run(dated);
    expect(lower.sheet.risk).toBe('low');
    expect(raised(lower)).toEqual([]);
  });
});

describe('a mix with withdrawals (review of Oct 6, finding 2)', () => {
  /** $300 a month for eight months: $1,800 in the six months that are set aside. */
  const withdrawing = (m: PersonalMix, over: Partial<PersonalSheet> = {}) =>
    sheet({ rules: noGlide, obligations: monthly(300, 8), mix: m, ...over });
  const aside = (plan: PersonalProposal) =>
    allReasons(plan)
      .filter((r) => r.rule === 'MIX_SET_ASIDE')
      .map((r) => r.params);

  it('all in stocks: the six months are set aside first, in full, and the stocks say what that leaves', () => {
    const plan = run(withdrawing(mix({ growthBps: 10_000 })));
    expect(heldIn(plan)).toEqual({ growth: 8200, dollarYield: 0, gold: 0, cash: 1800 });
    // Set aside from the start: nothing falls short, and the coverage check has nothing to move.
    for (const flag of ['set_aside_short', 'coverage_moved', 'coverage_short'])
      expect(plan.flags).not.toContain(flag);
    expect(
      said(plan, 'solana:spyx')
        .slice(0, 3)
        .map((r) => r.text),
    ).toEqual([
      'You asked for all of it in stocks and crypto.',
      '$1,800 of the 100% you asked for in stocks and crypto is set aside for your withdrawals from October 2026 to March 2027 instead, which leaves 82% of the plan for stocks and crypto: what your withdrawals need in those months is set aside before the mix is held.',
      // The share the limits are taken for is the one the plan sets out to hold: what the sentence
      // before it says the withdrawals leave. It said 100% until the second review of Oct 6.
      'To hold 82% of the plan in stocks and crypto, the plan uses the limits for high risk: at most 35% in one stock or crypto asset, and 100% with one issuer.',
    ]);
    const cash = said(plan, 'solana:usdc');
    expect(cash.map((r) => r.rule)).toEqual([
      'SET_ASIDE',
      ...Array.from({ length: 6 }, () => 'WITHDRAWAL'),
      'MIX_SET_ASIDE',
      'SET_ASIDE_CASH',
    ]);
    expect(cash[0]?.text).toBe(
      '$1,800 of the plan is set aside for your withdrawals from October 2026 to March 2027, the next 6 months of them; this line holds some or all of it.',
    );
    // No sentence states a figure that is not so: nothing is "kept for your goal" at $0.
    for (const r of allReasons(plan)) expect(r.text).not.toMatch(/\$0 of the plan/);
    expect(rules(plan)).not.toContain('SET_ASIDE_SHORT');
    expect(rules(plan)).not.toContain('COVERAGE_MOVED_UNCOUNTED');
  });

  it('says it in Portuguese', () => {
    const plan = run(withdrawing(mix({ growthBps: 10_000 }), { language: 'pt' }));
    expect(said(plan, 'solana:spyx')[1]?.text).toBe(
      'US$ 1.800 dos 100% que você pediu em ações e cripto ficam separados para os seus saques de outubro de 2026 a março de 2027, o que deixa 82% do plano para ações e cripto: o que os seus saques precisam nesses meses fica separado antes de a composição ser montada.',
    );
  });

  it('all in gold: the same six months are set aside, out of the gold', () => {
    const plan = run(withdrawing(mix({ goldBps: 10_000 })));
    // 82% is left for gold; one issuer holds half the plan at most, and the rest is in dollar yield.
    expect(heldIn(plan)).toEqual({ growth: 0, dollarYield: 3200, gold: 5000, cash: 1800 });
    expect(aside(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sleeve: 'gold', usd: 1800, askedBps: 10_000, leftBps: 8200 }),
      ]),
    );
    expect(said(plan, 'solana:gldx').map((r) => r.rule)).toEqual(
      expect.arrayContaining(['MIX_ALL', 'MIX_SET_ASIDE', 'ISSUER_CAP_PLAN']),
    );
    expect(said(plan, 'solana:usdc').map((r) => r.rule)).toContain('SET_ASIDE');
  });

  it('where the mix has the cash for it, the plan is the mix: 70% stocks and 30% cash', () => {
    const plan = run(withdrawing(mix({ growthBps: 7000, cashBps: 3000 })));
    expect(heldIn(plan)).toEqual({ growth: 7000, dollarYield: 0, gold: 0, cash: 3000 });
    expect(aside(plan)).toEqual([]);
    expect(said(plan, 'solana:usdc').map((r) => r.rule)).toEqual(
      expect.arrayContaining(['MIX', 'SET_ASIDE']),
    );
  });

  it('what is set aside counts as the class of the mix it is held as: cash on Solana, a rate leg on Robinhood Chain', () => {
    const m = mix({ growthBps: 5000, dollarYieldBps: 2000, cashBps: 3000 });
    const solana = run(withdrawing(m));
    expect(heldIn(solana)).toEqual({ growth: 5000, dollarYield: 2000, gold: 0, cash: 3000 });
    expect(aside(solana)).toEqual([]);
    expect(said(solana, 'solana:usdc').map((r) => r.rule)).toContain('SET_ASIDE');
    const robinhood = run(withdrawing(m, { chains: ['robinhood'] }));
    expect(heldIn(robinhood)).toEqual({ growth: 5000, dollarYield: 2000, gold: 0, cash: 3000 });
    expect(aside(robinhood)).toEqual([]);
    expect(said(robinhood, 'robinhood:sgov').map((r) => r.rule)).toContain('SET_ASIDE');
  });

  it('a class gives where its own is not what holds it: dollar yield to cash on Solana, cash to a rate leg on Robinhood Chain', () => {
    const solana = run(withdrawing(mix({ growthBps: 5000, dollarYieldBps: 5000 })));
    expect(heldIn(solana)).toEqual({ growth: 5000, dollarYield: 3200, gold: 0, cash: 1800 });
    expect(aside(solana)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sleeve: 'dollarYield', askedBps: 5000, leftBps: 3200 }),
      ]),
    );
    expect(said(solana, 'solana:jlusdc').map((r) => r.rule)).toContain('MIX_SET_ASIDE');
    const robinhood = run(
      withdrawing(mix({ growthBps: 5000, cashBps: 5000 }), { chains: ['robinhood'] }),
    );
    expect(heldIn(robinhood)).toEqual({ growth: 5000, dollarYield: 1800, gold: 0, cash: 3200 });
    expect(said(robinhood, 'robinhood:usdg').find((r) => r.rule === 'MIX_SET_ASIDE')?.text).toBe(
      '$1,800 of the 50% you asked for in cash is set aside for your withdrawals from October 2026 to March 2027 instead, which leaves 32% of the plan for cash: what your withdrawals need in those months is set aside before the mix is held.',
    );
  });

  it('stocks and crypto give before gold, and only what dollar yield and cash cannot', () => {
    const halves = run(withdrawing(mix({ growthBps: 5000, goldBps: 5000 })));
    expect(heldIn(halves)).toEqual({ growth: 3200, dollarYield: 0, gold: 5000, cash: 1800 });
    expect(aside(halves).map((x) => x.sleeve)).toEqual(['growth', 'growth']);
    // 10% in cash covers $1,000 of the $1,800: the stocks give the other $800, and no more.
    const tenth = run(withdrawing(mix({ growthBps: 9000, cashBps: 1000 })));
    expect(heldIn(tenth)).toEqual({ growth: 8200, dollarYield: 0, gold: 0, cash: 1800 });
    expect(aside(tenth)[0]).toMatchObject({
      sleeve: 'growth',
      usd: 800,
      askedBps: 9000,
      leftBps: 8200,
    });
  });

  it('withdrawals larger than the plan set all of it aside, and the sentence names the plan, not $0', () => {
    const plan = run(
      sheet({
        rules: noGlide,
        obligations: [{ month: monthAfter(NOW, 0), amount: 12_000, currency: 'USD' }],
        mix: mix({ growthBps: 10_000 }),
      }),
    );
    expect(heldIn(plan)).toEqual({ growth: 0, dollarYield: 0, gold: 0, cash: 10_000 });
    expect(plan.flags).toContain('set_aside_short');
    const short = allReasons(plan).find((r) => r.rule === 'SET_ASIDE_SHORT');
    expect(short?.params).toMatchObject({ owedUsd: 12_000, goalUsd: 10_000, shortUsd: 2000 });
    expect(short?.text).toBe(
      'Your withdrawals from October 2026 to March 2027 come to $12,000, more than the $10,000 of the plan kept for your goal: all of it is set aside, and $2,000 of them is not covered.',
    );
    expect(aside(plan)[0]).toMatchObject({ sleeve: 'growth', usd: 10_000, leftBps: 0 });
  });

  it('the candidates say what they are measured against, and each one shown holds it', () => {
    const all = candidates(withdrawing(mix({ growthBps: 10_000 })), shelf, ctx);
    expect(all.shown.length).toBeGreaterThan(0);
    for (const c of all.shown) {
      expect(violations(c.plan, shelf, ctx), c.id).toEqual([]);
      expect(sleeveBps(c.plan, shelf, 'growth'), c.id).toBe(8200);
    }
    // Cover sets a year aside: 76% would be left for stocks, another share than the plan's 82%.
    expect(all.notShown.find((n) => n.id === 'cover')?.why).toBe(
      'Cover is not shown: it would hold 76% of the plan in stocks and crypto, where the plan for the mix you asked for holds 82%.',
    );
    const pt = candidates(withdrawing(mix({ growthBps: 10_000 }), { language: 'pt' }), shelf, ctx);
    expect(pt.notShown.find((n) => n.id === 'cover')?.why).toBe(
      'Cobertura não aparece: ele teria 76% do plano em ações e cripto, e o plano para a composição que você pediu tem 82%.',
    );
  });
});

describe('a candidate that would change a share the mix states is not made', () => {
  it('only credit: Spread would hold 60% in dollar yield where the plan holds 90%', () => {
    const all = candidates(
      sheet({ rules: noGlide, mix: mix({ dollarYieldBps: 10_000, creditBps: 10_000 }) }),
      shelf,
      ctx,
    );
    for (const c of all.shown) expect(sleeveBps(c.plan, shelf, 'dollarYield'), c.id).toBe(9000);
    expect(all.notShown.find((n) => n.id === 'spread')?.why).toBe(
      'Spread is not shown: it would hold 60% of the plan in dollar yield, where the plan for the mix you asked for holds 90%.',
    );
  });

  it('a class the mix gives no share to is not measured: all in gold, Cover sets more aside and is shown', () => {
    const all = candidates(
      sheet({ rules: noGlide, obligations: monthly(300, 8), mix: mix({ goldBps: 10_000 }) }),
      shelf,
      ctx,
    );
    expect(all.shown.map((c) => c.id)).toEqual(['cover', 'carry']);
    for (const c of all.shown) {
      expect(violations(c.plan, shelf, ctx), c.id).toEqual([]);
      expect(sleeveBps(c.plan, shelf, 'gold'), c.id).toBe(5000);
    }
    expect(all.notShown.map((n) => n.why)).toEqual([
      'Spread is not shown: it would hold 30% of the plan in gold, where the plan for the mix you asked for holds 50%.',
    ]);
  });
});

describe('a cent of rounding is not a limit', () => {
  it('$1,000.01, half in stocks and half in cash: the odd cent stays in cash, and nothing is kept out', () => {
    const plan = run(
      sheet({
        amountUsd: 1000.01,
        rules: noGlide,
        mix: mix({ growthBps: 5000, cashBps: 5000 }),
      }),
    );
    expect(plan.lines.map((l) => [l.assetId, l.amountUsd, l.weightBps])).toEqual([
      ['solana:spyx', 500, 5000],
      ['solana:usdc', 500.01, 5000],
    ]);
    expect(plan.sheet.risk).toBe('low');
    for (const rule of ['ISSUER_CAP', 'OVERFLOW_ISSUER', 'YIELD_TOO_SMALL', 'UNPLACED'])
      expect(rules(plan)).not.toContain(rule);
    expect(plan.flags).not.toContain('unplaced');
  });

  it('where the mix has no cash, the odd cents stay in cash and say what they are: no limit kept them out', () => {
    // Robinhood Chain, 60% in stocks and 40% in dollar yield: SGOV may hold 40% of a plan, so the
    // dollar yield sits at its cap. The odd cents of the split were sent on to dollar yield, and at 240
    // of these 300 amounts the plan said "$0.01 stays in cash: no token you can hold has room for it
    // at this size", with the flag `unplaced` (the second review of Oct 6).
    const at = (amountUsd: number, language: 'en' | 'pt' = 'en') =>
      run(
        sheet({
          chains: ['robinhood'],
          amountUsd,
          language,
          rules: noGlide,
          mix: mix({ growthBps: 6000, dollarYieldBps: 4000 }),
        }),
      );
    for (let i = 0; i < 300; i += 1) {
      const plan = at((100_000 + i * 37) / 100);
      expect(plan.flags, String(i)).not.toContain('unplaced');
      for (const rule of ['UNPLACED', 'YIELD_TOO_SMALL', 'OVERFLOW_ISSUER', 'OVERFLOW_ISSUER_PLAN'])
        expect(rules(plan), `${i} ${rule}`).not.toContain(rule);
    }
    const odd = at(1000.37);
    expect(odd.lines.map((l) => [l.assetId, l.amountUsd])).toEqual([
      ['robinhood:spy', 600.22],
      ['robinhood:sgov', 400.14],
      ['robinhood:usdg', 0.01],
    ]);
    expect(said(odd, 'robinhood:usdg').map((r) => r.text)).toEqual([
      '$0.01 is left over once each share of your mix is written in whole cents, and stays in cash.',
    ]);
    expect(said(at(1000.37, 'pt'), 'robinhood:usdg').map((r) => r.text)).toEqual([
      'US$ 0,01 sobram quando cada parcela da sua composição é escrita em centavos inteiros, e ficam em caixa.',
    ]);
    // Shares that come to whole cents leave nothing over, and the plan has no cash line.
    expect(at(1000).lines.map((l) => l.assetId)).toEqual(['robinhood:spy', 'robinhood:sgov']);
  });

  it('whatever the cents of the amount, stocks sized at their issuer’s cap spill nothing', () => {
    // 50% with one issuer at low risk, 70% at medium: the share is the cap. Amounts no ceiling binds
    // at, so the cap by risk is the one limit in play.
    fc.assert(
      fc.property(
        fc.integer({ min: 100_000, max: 10_000_000 }).map((cents) => cents / 100),
        fc.constantFrom<[number, number, number]>(
          [5000, 5000, 0],
          [7000, 3000, 0],
          [5000, 0, 5000],
        ),
        (amountUsd, [growthBps, cashBps, dollarYieldBps]) => {
          const plan = run(
            sheet({ amountUsd, rules: noGlide, mix: mix({ growthBps, cashBps, dollarYieldBps }) }),
          );
          expect(sleeveBps(plan, shelf, 'growth')).toBe(growthBps);
          expect(rules(plan)).not.toContain('OVERFLOW_ISSUER');
          expect(plan.flags).not.toContain('unplaced');
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);
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
      'the plan took the limits of low risk and holds 5666.66 in stocks and crypto, where at medium risk it holds 6000',
    );
    expect(tampered(plan, relabel('high'))).toContain(
      'the plan took the limits of high risk, and at medium risk it holds as much in stocks and crypto (6000 against 6000)',
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

  it('the reasons of a class that holds less account for the money missing: one that is there is not enough', () => {
    // Home Team, all in stocks, $60,000, under the caps of medium risk: the plan says $2,000 meant for
    // KMNO and $2,000 meant for MET are kept out by their ceilings, and holds 93.32% in stocks.
    const medium = { ...ctx, params: withCapsOf(PERSONAL_PARAMS, 'medium') };
    const home = sheet({
      amountUsd: 60_000,
      themes: ['home-team'],
      rules: noGlide,
      mix: mix({ growthBps: 10_000 }),
    });
    const plan = compose(home, shelf, medium);
    expect(violations(plan, shelf, medium)).toEqual([]);
    expect(sleeveBps(plan, shelf, 'growth')).toBe(9332);
    // The same plan with 15 points more moved from JitoSOL to cash, its own bookkeeping kept in step
    // and no sentence added: the two sentences about ceilings are still there, and say $4,000.
    const copy = structuredClone(plan);
    const [from, to] = ['solana:jitosol', 'solana:usdc'].map((id) =>
      copy.lines.find((l) => l.assetId === id),
    );
    if (!from || !to) throw new Error('no such line');
    const [moveBps, moveUsd] = [1500, 9000];
    from.weightBps -= moveBps;
    from.amountUsd -= moveUsd;
    to.weightBps += moveBps;
    to.amountUsd += moveUsd;
    for (const x of copy.sleeves) {
      const sign = x.sleeve === 'growth' ? -1 : x.sleeve === 'cash' ? 1 : 0;
      x.weightBps += sign * moveBps;
      x.amountUsd += sign * moveUsd;
    }
    for (const r of copy.recipes)
      for (const c of r.components)
        if (c.kind === 'asset' && c.asset === 'solana:jitosol') c.weightBps -= moveBps;
    for (const r of from.reasons)
      if (r.rule === 'NO_RETURN_ASSUMED') r.params.lossUsd = (from.amountUsd * 2000) / 10_000;
    copy.card.expectedReturn.lossInFallUsd -= (moveUsd * 2000) / 10_000;
    expect(violations(copy, shelf, medium)).toContain(
      'growth holds 7832 bps where its share is 10000, and its lines account for 668 of the 2168 missing',
    );
  });

  it('an issuer over the cap of the plan’s risk is seen, whatever it holds of that issuer', () => {
    // Half in stocks and 30% in gold on Solana: 80% with one issuer, at the limits of high risk. The
    // same lines called a plan at medium risk are 10 points over what one issuer may hold there. No
    // class alone is over a cap of its own: 50% in stocks is under medium's 70%, and 30% in gold is
    // under the plan's 50% for dollar yield and gold.
    const plan = run(
      sheet({ rules: noGlide, mix: mix({ growthBps: 5000, goldBps: 3000, cashBps: 2000 }) }),
    );
    expect(plan.sheet.risk).toBe('high');
    const called = tampered(plan, (copy) => {
      copy.sheet.risk = 'medium';
      copy.flags = copy.flags.map((f) =>
        f.startsWith('limits_from_mix:') ? 'limits_from_mix:medium' : f,
      );
    });
    expect(called).toContain(
      'Backed (xStocks) holds 8000 of the plan, over the 7000 one issuer may hold at medium risk',
    );
  });

  it('limits above the ones the mix takes on its own are held to their sentence and their flag', () => {
    const plan = run(
      sheet({
        chains: ['robinhood'],
        rules: noGlide,
        obligations: monthly(300, 8),
        mix: mix({ growthBps: 5000, cashBps: 5000 }),
      }),
    );
    const silent = tampered(plan, (copy) => {
      for (const l of copy.lines)
        l.reasons = l.reasons.filter((r) => r.rule !== 'MIX_LIMITS_RAISED');
      copy.flags = copy.flags.filter((f) => !f.startsWith('limits_raised:'));
    });
    expect(silent).toEqual(
      expect.arrayContaining([
        'the limits are above the ones the mix takes on its own (low risk) because of withdrawals, and the plan says []',
        "the flag for limits above the mix's own is [], not limits_raised:low:withdrawals",
      ]),
    );
    // A plan that names another cause than the one that raised them.
    const other = tampered(plan, (copy) => {
      for (const r of copy.lines.flatMap((l) => l.reasons))
        if (r.rule === 'MIX_LIMITS_RAISED') r.params.by = 'holdings';
    });
    expect(other.some((v) => v.startsWith('the limits are above the ones the mix takes'))).toBe(
      true,
    );
    // And one that says its limits were raised when they were not.
    const plain = run(sheet({ rules: noGlide, mix: mix({ growthBps: 7000, cashBps: 3000 }) }));
    const claimed = tampered(plain, (copy) => {
      copy.flags = [...copy.flags, 'limits_raised:low:withdrawals'].sort();
    });
    expect(claimed).toContain(
      'the plan says its limits are above the ones the mix takes on its own, and they are not: medium risk alone, medium with all of the sheet',
    );
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

  it('what is set aside from stocks is held to what the withdrawals need', () => {
    const plan = run(
      sheet({ rules: noGlide, obligations: monthly(300, 8), mix: mix({ growthBps: 10_000 }) }),
    );
    // A sentence that says stocks gave 30% where the withdrawals need 18%.
    const more = tampered(plan, (copy) => {
      for (const r of copy.lines.flatMap((l) => l.reasons))
        if (r.rule === 'MIX_SET_ASIDE') Object.assign(r.params, { usd: 3000, leftBps: 7000 });
    });
    expect(more).toContain(
      "stocks, crypto and gold give 3000 bps to what is set aside; the mix's dollar yield and cash leave 1800 to find",
    );
    // No sentence at all: the old engine's plan, which moved the money and never said it was set aside.
    const silent = tampered(plan, (copy) => {
      for (const l of copy.lines) l.reasons = l.reasons.filter((r) => r.rule !== 'MIX_SET_ASIDE');
    });
    expect(silent).toEqual(
      expect.arrayContaining([
        'growth holds 8200 bps of the 10000 asked, and no line of it says why',
        "stocks, crypto and gold give 0 bps to what is set aside; the mix's dollar yield and cash leave 1800 to find",
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

  /** The portfolios a plan may start from, by chain: one, two, or the goal's own. */
  const starts: [ChainId, string[]][] = [
    ['solana', []],
    ['solana', ['the-seven']],
    ['solana', ['the-500', 'home-team']],
    ['solana', ['the-seven', 'home-team']],
    ['solana', ['crypto-in-a-suit']],
    ['solana', ['storm-cellar']],
    ['base', []],
    ['base', ['chips-and-agents']],
    ['base', ['the-seven']],
    ['base', ['home-team', 'chips-and-agents']],
    ['robinhood', []],
    ['robinhood', ['sand-to-server']],
    ['robinhood', ['crypto-in-a-suit', 'the-500']],
    ['robinhood', ['storm-cellar']],
  ];
  /** Up to three withdrawals in dollars, each a share of the amount, from this month to nine on. */
  const withdrawals = fc.array(
    fc.record({
      inMonths: fc.integer({ min: 0, max: 9 }),
      percent: fc.integer({ min: 1, max: 45 }),
    }),
    { maxLength: 3 },
  );
  const owed = (amountUsd: number, list: { inMonths: number; percent: number }[]) =>
    list.map((x) => ({
      month: monthAfter(NOW, x.inMonths),
      amount: Math.round(amountUsd * x.percent) / 100,
      currency: 'USD',
    }));

  it('keeps every rule of a plan, holds no more stocks or gold than asked, and the table never shows', () => {
    fc.assert(
      fc.property(
        mixes,
        fc.constantFrom(...starts),
        fc.constantFrom(2000, 10_000, 250_000),
        fc.boolean(),
        withdrawals,
        (m, [chain, themes], amountUsd, glide, list) => {
          const s = sheet({
            chains: [chain],
            themes,
            amountUsd,
            mix: m,
            rules: { useHoldings: true, glide },
            ...(list.length > 0 ? { obligations: owed(amountUsd, list) } : {}),
          });
          const plan = compose(s, shelf, ctx);
          expect(violations(plan, shelf, ctx)).toEqual([]);
          const asked = expectedSleeves(plan.sheet, PERSONAL_PARAMS);
          expect(sleeveBps(plan, shelf, 'growth')).toBeLessThanOrEqual(
            asked.growth + plan.lines.length,
          );
          expect(sleeveBps(plan, shelf, 'gold')).toBeLessThanOrEqual(
            asked.gold + plan.lines.length,
          );
          // Withdrawals keep their rule with a mix: no plan says it kept $0 for the goal.
          for (const r of allReasons(plan)) expect(r.text).not.toMatch(/\$0 of the plan kept/);
          expect(compose(s, shelf, ctx)).toEqual(plan);
        },
      ),
      { numRuns: 120 },
    );
  }, 240_000);

  it('over one or two shared portfolios, held whole or opened, on each chain, with and without withdrawals and holdings', () => {
    // The second review of Oct 6: a portfolio held whole was booked before the rest of the plan and
    // never counted beside it, and a cap that moved money to names with no room for it was not seen.
    // Here the three things the rule must give are read off the plans themselves, beside the measure:
    // no issuer over the cap of the plan's risk, whatever it holds; no lower risk at which the plan
    // holds as much in stocks and crypto; and no higher risk at which it holds more.
    const portfolios: [ChainId, string[]][] = [
      ['solana', ['the-seven']],
      ['solana', ['home-team']],
      ['solana', ['crypto-in-a-suit']],
      ['solana', ['the-seven', 'home-team']],
      ['solana', ['crypto-in-a-suit', 'home-team']],
      ['solana', ['the-500', 'the-seven']],
      ['robinhood', ['the-seven']],
      ['robinhood', ['sand-to-server']],
      ['robinhood', ['crypto-in-a-suit']],
      ['robinhood', ['the-seven', 'crypto-in-a-suit']],
      ['robinhood', ['sand-to-server', 'the-500']],
      ['base', ['the-seven']],
      ['base', ['chips-and-agents']],
      ['base', ['home-team']],
      ['base', ['the-seven', 'home-team']],
      ['base', ['home-team', 'chips-and-agents']],
    ];
    const tokens = new Map(shelf.assets.map((a) => [a.id, a]));
    const names = [
      ...new Set(shelf.assets.filter((a) => a.cls !== 'cash').map((a) => a.underlying)),
    ];
    const RISKS: RiskLevel[] = ['low', 'medium', 'high'];
    const cents = (usd: number) => Math.round(usd * 100);
    const stocks = (plan: PersonalProposal) =>
      cents(plan.sleeves.find((x) => x.sleeve === 'growth')?.amountUsd ?? 0);
    let whole = 0;
    let opened = 0;
    fc.assert(
      fc.property(
        mixes,
        fc.constantFrom(...portfolios),
        fc.constantFrom(2000, 10_000, 60_000, 250_000),
        withdrawals,
        fc.array(
          fc.record({
            underlying: fc.constantFrom(...names),
            valueUsd: fc.integer({ min: 100, max: 50_000 }),
          }),
          { maxLength: 3 },
        ),
        (m, [chain, themes], amountUsd, list, holdings) => {
          const s = sheet({
            chains: [chain],
            themes,
            amountUsd,
            mix: m,
            rules: noGlide,
            ...(list.length > 0 ? { obligations: owed(amountUsd, list) } : {}),
          });
          const context = fixtureContext({ holdings });
          const plan = compose(s, shelf, context);
          expect(violations(plan, shelf, context)).toEqual([]);
          if (allReasons(plan).some((r) => r.rule === 'FOLLOWS')) whole += 1;
          if (allReasons(plan).some((r) => r.rule === 'OPENED')) opened += 1;
          // One issuer by risk, over everything the plan holds with it but its own cash.
          const cap = Math.floor(
            (cents(amountUsd) * (PERSONAL_PARAMS.capPerIssuerBps[plan.sheet.risk] ?? 0)) / 10_000,
          );
          const withIssuer = new Map<string, number>();
          for (const l of plan.lines) {
            const a = tokens.get(l.assetId);
            if (!a || a.cls === 'cash') continue;
            withIssuer.set(a.issuer, (withIssuer.get(a.issuer) ?? 0) + cents(l.amountUsd));
          }
          for (const [issuer, held] of withIssuer) expect(held, issuer).toBeLessThanOrEqual(cap);
          // The risk: the lowest at which the plan holds the most, a cent for each line aside.
          const held = RISKS.map((risk) =>
            stocks(compose(s, shelf, { ...context, params: withCapsOf(PERSONAL_PARAMS, risk) })),
          );
          const most = Math.max(...held);
          const rounding = PERSONAL_PARAMS.maxLinesPerChain;
          const due =
            m.growthBps === 0 ? 'low' : RISKS[held.findIndex((c) => c + rounding >= most)];
          expect(plan.sheet.risk).toBe(due);
          expect(riskForMix(s, shelf, context)).toBe(due);
          if (m.growthBps > 0) expect(stocks(plan)).toBe(held[RISKS.indexOf(plan.sheet.risk)]);
        },
      ),
      { numRuns: 150 },
    );
    // Both ways of holding a portfolio came up.
    expect(whole).toBeGreaterThan(5);
    expect(opened).toBeGreaterThan(5);
  }, 240_000);

  it('with withdrawals, each candidate shown keeps every rule and holds the shares the plan for the mix holds', () => {
    fc.assert(
      fc.property(
        mixes,
        fc.constantFrom(...starts),
        fc.constantFrom(2000, 10_000, 250_000),
        withdrawals,
        (m, [chain, themes], amountUsd, list) => {
          const s = sheet({
            chains: [chain],
            themes,
            amountUsd,
            mix: m,
            rules: { useHoldings: true, glide: false },
            ...(list.length > 0 ? { obligations: owed(amountUsd, list) } : {}),
          });
          const all = candidates(s, shelf, ctx);
          expect(all.shown.length).toBeGreaterThan(0);
          expect(all.shown.length + all.notShown.length).toBe(3);
          const carry = compose(s, shelf, ctx);
          const stated = {
            growth: m.growthBps,
            dollarYield: m.dollarYieldBps,
            gold: m.goldBps,
            cash: m.cashBps,
          };
          for (const c of all.shown) {
            expect(violations(c.plan, shelf, ctx), c.id).toEqual([]);
            // One risk for the three: the limits are the mix's, not a candidate's to vary.
            expect(c.plan.sheet.risk, c.id).toBe(carry.sheet.risk);
            // A share the mix states is the one the plan made for the mix as it is holds.
            for (const sleeve of ['growth', 'dollarYield', 'gold', 'cash'] as const)
              if (stated[sleeve] > 0)
                expect(
                  Math.abs(sleeveBps(c.plan, shelf, sleeve) - sleeveBps(carry, shelf, sleeve)),
                  `${c.id} ${sleeve}`,
                ).toBeLessThanOrEqual(Math.max(c.plan.lines.length, carry.lines.length));
          }
          // What a sentence says a candidate is measured against is what the plans shown hold.
          for (const n of all.notShown) {
            const held = /where the plan for the mix you asked for holds ([\d.]+)%/.exec(n.why);
            const of = / of the plan in (stocks and crypto|dollar yield|gold|cash),/.exec(n.why);
            if (!held || !of) continue;
            const sleeve = (
              {
                'stocks and crypto': 'growth',
                'dollar yield': 'dollarYield',
                gold: 'gold',
                cash: 'cash',
              } as const
            )[of[1] as 'gold'];
            expect(sleeveBps(carry, shelf, sleeve), n.why).toBe(Math.round(Number(held[1]) * 100));
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 240_000);

  // The mix's own properties above run on the fixture's figures, for someone who holds nothing and
  // sets no limit. Here the world moves too: what is measured, which yields are read, what the
  // person holds, what they must keep or may need, what they cannot hold, withdrawals in dollars and
  // in reais, a goal in either, and a table whose caps by risk come in any order.
  const launch = shelf;
  const TOKENS = launch.assets.filter((a) => a.cls !== 'cash');
  const TICKERS = [...new Set(TOKENS.map((a) => a.underlying))];
  const SLUGS = launch.families.map((f) => f.meta.slug);
  const bps = fc.integer({ min: 0, max: 10_000 });
  const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
  const filled = <T extends object>(value: T): T =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
  const byRisk = fc.record({ low: bps, medium: bps, high: bps });
  const tables = fc.oneof(
    fc.constant(PERSONAL_PARAMS),
    fc
      .record({
        capPerStockBps: byRisk,
        capPerIssuerBps: byRisk,
        issuerCapBps: bps,
        minLineBps: fc.integer({ min: 0, max: 600 }),
        minLineUsd: fc.integer({ min: 0, max: 200 }),
        maxLinesPerChain: fc.integer({ min: 1, max: 16 }),
      })
      .map((over) =>
        PersonalParameters.parse({ ...PERSONAL_PARAMS, ...over, version: 'generated' }),
      ),
  );
  const someone = fc
    .record({
      chain: fc.constantFrom<ChainId>('solana', 'robinhood', 'base'),
      goal: fc.constantFrom('grow' as const, 'income' as const, 'protect' as const),
      amountUsd: fc.oneof(
        fc.integer({ min: 10, max: 1_000_000 }),
        fc.integer({ min: 1000, max: 100_000_000 }).map((cents) => cents / 100),
      ),
      horizonMonths: fc.constantFrom(1, 6, 12, 24, 36, 60, 120),
      themes: fc.uniqueArray(fc.constantFrom(...SLUGS, 'no-such-portfolio'), { maxLength: 3 }),
      rules: fc.record({ useHoldings: fc.boolean(), glide: fc.boolean() }),
      language: fc.constantFrom('en' as const, 'pt' as const),
      currency: maybe(fc.constantFrom('USD', 'BRL')),
      keepShare: maybe(fc.integer({ min: 0, max: 100 })),
      mayNeedInMonths: maybe(fc.integer({ min: 1, max: 480 })),
      cannotHold: maybe(
        fc.uniqueArray(fc.constantFrom(...TICKERS), { maxLength: 3 }).map((underlyings) => ({
          underlyings,
        })),
      ),
      obligations: maybe(
        fc.array(
          fc.record({
            month: fc.integer({ min: -2, max: 14 }).map((m) => monthAfter(NOW, m)),
            amount: fc.integer({ min: 1, max: 200_000 }),
            currency: fc.constantFrom('USD', 'BRL'),
          }),
          { maxLength: 4 },
        ),
      ),
      mix: mixes,
    })
    .map(({ chain, keepShare, mayNeedInMonths, cannotHold, mix: m, ...rest }) => {
      const limits = filled({
        mustKeepUsd:
          keepShare === undefined ? undefined : Math.floor((rest.amountUsd * keepShare) / 100),
        mayNeedInMonths,
        cannotHold,
      });
      return PersonalSheet.parse(
        filled({
          ...sheet(),
          ...rest,
          chains: [chain],
          // No stocks for income or to protect: their share is asked for in cash instead.
          mix: rest.goal === 'grow' ? m : { ...m, growthBps: 0, cashBps: m.cashBps + m.growthBps },
          limits: Object.keys(limits).length > 0 ? limits : undefined,
        }),
      );
    });
  const worlds = fc.record({
    measured: fc.array(
      fc.tuple(fc.constantFrom(...TOKENS.map((a) => a.id)), fc.integer({ min: 0, max: 5_000_000 })),
      { maxLength: 12 },
    ),
    read: fc.subarray(fixtureYields().map((y) => y.assetId)),
    holdings: fc.array(
      fc.record({
        underlying: fc.constantFrom(...TICKERS),
        valueUsd: fc.integer({ min: 0, max: 300_000 }),
      }),
      { maxLength: 4 },
    ),
    params: tables,
  });

  it('the plan and each candidate shown keep every rule, and nothing makes the engine give up', () => {
    fc.assert(
      fc.property(someone, worlds, (s, raw) => {
        const context: ComposeContext = {
          now: NOW,
          holdings: raw.holdings,
          yields: fixtureYields().filter((y) => raw.read.includes(y.assetId)),
          liquidity: fixtureLiquidity(Object.fromEntries(raw.measured)),
          liquiditySource: LIQUIDITY_SOURCE,
          params: raw.params,
          fx: [usdBrl()],
        };
        expect(violations(compose(s, launch, context), launch, context)).toEqual([]);
        for (const c of candidates(s, launch, context).shown)
          expect(violations(c.plan, launch, context), c.id).toEqual([]);
      }),
      { numRuns: 100 },
    );
  }, 240_000);
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
