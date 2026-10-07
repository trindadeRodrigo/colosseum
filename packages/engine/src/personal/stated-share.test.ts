import { describe, expect, it } from 'vitest';
import evalSet from './fixtures/goals-eval.json';
import { type IntakeInput, runIntake, type ShelfPortfolio } from './intake';
import type { ShelfLabel } from './market-filter';
import { launchShelf } from './testing';

// A share the person writes for what they want held, beside the share they keep safe (gate
// EXPLICIT-MIX; Rodrigo's test of `/plan-chat` on Oct 7): "8k safe and liquid, the 20% rest in a
// stock portfolio that follows big tech" was asked the risk of the 20%, and at low risk the plan held
// 12% in stocks. A written share is held as written and the risk is not asked; with no share written
// for what is held, the risk is asked. The model's replies are MOCK, written by hand in the shape the
// API asks the model for. No test reaches a network.

const NOW = evalSet.nowMonth;
const portfolios: ShelfPortfolio[] = launchShelf().families.map((f) => ({
  slug: f.meta.slug,
  name: f.meta.name,
}));
const LABELS: ShelfLabel[] = [
  { slug: 'ai', name: { en: 'AI', pt: 'IA' }, status: 'confirmed', listed: 9 },
];

const split = (safePct: number, goalPct: number) => [
  { kind: 'safe_yield', sharePct: safePct },
  { kind: 'goal', sharePct: goalPct },
];
const reply = (over: Record<string, unknown> = {}) => ({
  goal: 'grow',
  amountUsd: 10000,
  incomeTargetUsdMonthly: null,
  horizonMonths: 60,
  risk: null,
  currency: null,
  chain: null,
  portfolios: [],
  language: 'en',
  noCredit: false,
  cannotHold: [],
  unclear: [],
  openEnded: false,
  mayNeedInMonths: null,
  sleeves: null,
  markets: [],
  mix: null,
  marketFilter: null,
  ...over,
});
const intake = (text: string, r: unknown, over: Partial<IntakeInput> = {}) =>
  runIntake({
    text,
    nowMonth: NOW,
    reply: r,
    homeChain: 'solana',
    portfolios,
    labels: LABELS,
    ...over,
  });
const fields = (r: { questions: { field: string }[] }) => r.questions.map((q) => q.field);
const GOAL = 'I have $10,000 to grow over 5 years.';
const mixOf = (growthBps: number) => ({
  growthBps,
  dollarYieldBps: 0,
  goldBps: 0,
  cashBps: 10_000 - growthBps,
});

describe('a share written for what is held, beside the share kept safe', () => {
  it('a market that reads to a shared portfolio holds its share, and the risk is not asked', () => {
    const result = intake(
      `${GOAL} 80% safe and liquid, 20% in big tech.`,
      reply({ markets: ['big_tech'], sleeves: split(80, 20) }),
    );
    expect(result.questions).toEqual([]);
    expect(result.flags).toContain('mix_from_market');
    expect(result.flags).toContain('risk_from_mix');
    expect(result.sheet).toMatchObject({ themes: ['the-seven'] });
    expect(result.sheet?.mix).toEqual(mixOf(2000));
    expect(result.sheet?.sleeves).toBeUndefined();
    // The limits the share takes are said once, as an assumption.
    expect(result.assumptions.join(' ')).toMatch(
      /To hold “big tech”, the plan uses the limits for/,
    );
  });

  it('either order, and a share that needs higher limits says so', () => {
    const result = intake(
      `${GOAL} Put 70% in big tech and keep 30% safe and liquid.`,
      reply({ markets: ['big_tech'], sleeves: split(30, 70) }),
    );
    expect(result.questions).toEqual([]);
    expect(result.sheet?.mix).toEqual(mixOf(7000));
    expect(result.sheet?.risk).not.toBe('low');
    // Where the limits are above the ones for low risk, the person is told what that makes the plan.
    expect(result.assumptions).toContain('We count this as a plan that accepts more risk.');
    const low = intake(
      `${GOAL} 80% safe and liquid, 20% in big tech.`,
      reply({ markets: ['big_tech'], sleeves: split(80, 20) }),
    );
    expect(low.sheet?.risk).toBe('low');
    expect(low.assumptions).not.toContain('We count this as a plan that accepts more risk.');
  });

  it('a market that reads to a curated list holds its share, with the rest kept safe', () => {
    const result = intake(
      `${GOAL} 80% safe and liquid, 20% in AI.`,
      reply({ markets: ['ai'], sleeves: split(80, 20) }),
    );
    expect(result.questions).toEqual([]);
    expect(result.flags).toContain('sleeves_from_market');
    expect(result.sheet?.sleeves).toEqual([
      { kind: 'theme', theme: 'ai', shareBps: 2000 },
      { kind: 'safe_yield', shareBps: 8000 },
    ]);
    expect(result.sheet?.mix).toBeUndefined();
  });

  it('a share written for stocks holds it, and the risk is not asked', () => {
    const result = intake(
      `${GOAL} 80% safe and liquid, 20% in stocks.`,
      reply({ sleeves: split(80, 20) }),
    );
    expect(result.questions).toEqual([]);
    expect(result.flags).toContain('mix_from_split');
    expect(result.sheet?.mix).toEqual(mixOf(2000));
    expect(result.sheet?.sleeves).toBeUndefined();
    expect(result.assumptions.join(' ')).toMatch(
      /To hold “20% in stocks”, the plan uses the limits/,
    );
  });

  it('in Portuguese too', () => {
    const result = intake(
      'Tenho US$ 10.000 para crescer em 5 anos. 80% seguro e líquido, 20% em ações.',
      reply({ sleeves: split(80, 20), language: 'pt' }),
    );
    expect(result.questions).toEqual([]);
    expect(result.sheet?.mix).toEqual(mixOf(2000));
  });

  it('with no share written for what is held, the risk of that part is asked', () => {
    for (const text of [
      `${GOAL} 80% safe and liquid, 20% to risk.`,
      `${GOAL} 80% safe and liquid, 20% to seek a return.`,
    ]) {
      const result = intake(text, reply({ sleeves: split(80, 20) }));
      expect(fields(result), text).toEqual(['risk']);
      expect(result.flags, text).not.toContain('mix_from_split');
    }
  });

  it('a risk the person said, with a written share: the share is held and both are said', () => {
    const result = intake(
      `${GOAL} Low risk. 20% safe and liquid, 80% in big tech.`,
      reply({ markets: ['big_tech'], sleeves: split(20, 80), risk: 'low' }),
    );
    expect(result.questions).toEqual([]);
    expect(result.sheet?.mix).toEqual(mixOf(8000));
    expect(result.assumptions.join(' ')).toMatch(/You said low risk, but to hold “big tech”/);
  });

  it('is not taken where the shares do not say the same, or the message says more', () => {
    const asked = (text: string, r: unknown) => {
      const result = intake(text, r);
      expect(result.sheet?.mix ?? null, text).toBeNull();
      expect(result.questions.length, text).toBeGreaterThan(0);
      expect(result.flags, text).not.toContain('mix_from_market');
      expect(result.flags, text).not.toContain('mix_from_split');
    };
    // The market's share is not the share of the part that is not kept safe.
    asked(
      `${GOAL} 70% safe and liquid, 30% to grow, 20% in big tech.`,
      reply({ markets: ['big_tech'], sleeves: split(70, 30) }),
    );
    // Another holding beside it.
    asked(
      `${GOAL} 80% safe and liquid, 20% in big tech, and some gold too.`,
      reply({ markets: ['big_tech'], sleeves: split(80, 20) }),
    );
    // A third percent.
    asked(
      `${GOAL} 80% safe and liquid, 20% in stocks, but only 5% in any one of them.`,
      reply({ sleeves: split(80, 20) }),
    );
    // Not stated as what the person wants held.
    asked(
      `${GOAL} 80% safe and liquid. I would not put 20% in stocks.`,
      reply({ sleeves: split(80, 20) }),
    );
    // A class the person rules out.
    asked(
      `${GOAL} No stocks. 80% safe and liquid, 20% in stocks.`,
      reply({ sleeves: split(80, 20), cannotHold: ['stock'] }),
    );
  });

  it('a market named beside the split, its share not written in a plain form: how much is asked, not the risk', () => {
    for (const [text, start] of [
      // The share leads into the market in one sentence: it is where the form starts, so a plain
      // yes holds what was written.
      [`${GOAL} 80% safe and liquid, 20% in a stock portfolio that follows big tech.`, mixOf(2000)],
      // No share is tied to the market: the form has no start.
      [`${GOAL} 80% safe and liquid, 20% to grow. I like big tech.`, null],
    ] as const) {
      const r = reply({ markets: ['big_tech'], sleeves: split(80, 20) });
      const asked = intake(text, r);
      expect(fields(asked), text).toEqual(['mix']);
      expect(asked.flags, text).toContain('market_beside_split');
      expect(asked.questions[0]?.read ?? null, text).toEqual(start);
      const answered = intake(text, r, { answers: { mix: mixOf(2000) } });
      expect(answered.questions, text).toEqual([]);
      expect(answered.sheet?.mix, text).toEqual(mixOf(2000));
      expect(answered.sheet?.sleeves, text).toBeUndefined();
      // "None" for it leaves the split as written, and then the risk of its part is asked.
      const none = intake(text, r, { answers: { mix: null } });
      expect(fields(none), text).toEqual(['risk']);
    }
  });

  it('a split the person answered, beside a market: how much for it is asked, not the risk', () => {
    const text = `${GOAL} I want some of it safe, and a stock portfolio that follows big tech.`;
    const r = reply({ markets: ['big_tech'] });
    const sleeves = [
      { kind: 'safe_yield' as const, shareBps: 8000 },
      { kind: 'goal' as const, shareBps: 2000 },
    ];
    const asked = intake(text, r, { answers: { sleeves } });
    expect(fields(asked)).toEqual(['mix']);
    // The text ties no share to the market, so the form has no start for a plain yes to take.
    expect(asked.questions[0]?.read ?? null).toBeNull();
    // A risk answered before changes nothing of that: the share is asked, and then held whole.
    const withRisk = intake(text, r, { answers: { sleeves, risk: 'low' } });
    expect(fields(withRisk)).toEqual(['mix']);
    const held = intake(text, r, { answers: { sleeves, risk: 'low', mix: mixOf(2000) } });
    expect(held.questions).toEqual([]);
    expect(held.sheet?.mix).toEqual(mixOf(2000));
  });

  it('a share corrected in a later message is asked as the share, never as a risk', () => {
    const result = intake(
      `${GOAL} 80% safe and liquid, 20% in big tech.\n\nActually make it 30% in big tech.`,
      reply({ markets: ['big_tech'], sleeves: split(70, 30) }),
    );
    expect(fields(result)).toContain('mix');
    expect(fields(result)).not.toContain('risk');
    expect(result.sheet).toBeNull();
  });

  it('a market the person only wonders about: asked with no start, so a yes takes nothing', () => {
    const result = intake(
      `${GOAL} Keep 80% safe. Should I put 20% in big tech?`,
      reply({ markets: ['big_tech'], sleeves: split(80, 20) }),
    );
    expect(fields(result)).toEqual(['mix']);
    expect(result.questions[0]?.read ?? null).toBeNull();
  });

  // The independent review of the first build (Oct 7, 325 sentences): each of these was taken.
  const notTaken = (text: string, r: unknown) => {
    const result = intake(text, r);
    expect(result.sheet?.mix ?? null, text).toBeNull();
    expect(
      (result.sheet?.sleeves ?? []).some((x) => x.kind === 'theme'),
      text,
    ).toBe(false);
    expect(result.flags, text).not.toContain('mix_from_split');
    expect(result.flags, text).not.toContain('mix_from_market');
    return result;
  };
  const stocks = reply({ sleeves: split(80, 20) });
  const bigTech = reply({ markets: ['big_tech'], sleeves: split(80, 20) });

  it('a later message that is no answer leaves the share untaken: the last word is not passed over', () => {
    for (const later of [
      'Actually put the 20% in gold.',
      'Make that gold.',
      'No, 20% is too much.',
      'Wait, I am not sure about stocks.',
      'Or should it be gold?',
      'And some gold too.',
      'Make that 30%.',
      'Na verdade coloque os 20% em ouro.',
      'Esquece as ações.',
    ])
      notTaken(`${GOAL} 80% safe and liquid, 20% in stocks.\n\n${later}`, stocks);
  });

  it('a share said of another time, turned down or judged is not what the person wants held', () => {
    for (const said of [
      'I used to keep 80% safe and liquid, 20% in stocks.',
      '80% safe and liquid, 20% in stocks no way.',
      '80% safe and liquid, 20% in stocks never.',
      '80% safe and liquid, 20% in stocks scares me.',
      '80% safe and liquid, 20% in stocks returns.',
      '80% seguro e líquido, 20% em ações nem pensar.',
      '80% safe and liquid, 20% in stocks I guess.',
      '80% safe and liquid, 20% in stocks or is that too much?',
    ])
      notTaken(`${GOAL} ${said}`, stocks);
    for (const said of [
      'I used to keep 80% safe and liquid, 20% in big tech.',
      '80% safe and liquid, 20% in big tech was my old plan.',
      '80% safe and liquid, 20% in big tech no way.',
    ])
      notTaken(`${GOAL} ${said}`, bigTech);
  });

  it('a share of what is left is not a share of the money', () => {
    notTaken(`${GOAL} 80% safe and liquid. Of the remaining money, put 20% in big tech.`, bigTech);
    notTaken(`${GOAL} 80% safe and liquid. Of what is left, 20% in stocks.`, stocks);
    notTaken(`${GOAL} 80% seguro e líquido. Do restante, coloque 20% em big tech.`, bigTech);
  });

  it('the part kept safe is one the text says is kept safe, whatever the model read', () => {
    for (const first of ['80% high risk', '80% aggressive', '80% risky', '80% to my kids'])
      notTaken(`${GOAL} ${first}, 20% in stocks.`, stocks);
    for (const first of ['80% invested', '80% growth'])
      notTaken(`${GOAL} ${first}, 20% in big tech.`, bigTech);
  });

  it('the start of the share question is only what the text ties to the market: a yes takes nothing else', () => {
    const noStart = (text: string, r: unknown) => {
      const asked = intake(text, r);
      for (const q of asked.questions.filter((x) => x.field === 'mix'))
        expect(q.read ?? null, text).toBeNull();
      notTaken(`${text}\n\nyes`, r);
    };
    noStart(`${GOAL} 80% safe and liquid, 20% to grow. Big tech scares me.`, bigTech);
    noStart(
      `${GOAL} 80% safe and liquid, 20% to grow. I lost money in big tech last year.`,
      bigTech,
    );
    noStart(`${GOAL} 80% safe and liquid, 20% to grow. Big tech fell 20% last year.`, bigTech);
    noStart(`${GOAL} 80% safe and liquid, 20% in big tech and gold.`, bigTech);
    noStart(`${GOAL} 80% safe and liquid, 20% in big tech.\n\nForget big tech.`, bigTech);
    // A model that reads the two shares the wrong way round starts nothing.
    const swapped = reply({ markets: ['big_tech'], sleeves: split(20, 80) });
    const result = intake(`${GOAL} 80% safe and liquid, 20% in big tech.\n\nyes`, swapped);
    expect(result.sheet?.mix?.growthBps ?? 0).not.toBe(8000);
  });

  it('with no model the share the text states is asked, never taken', () => {
    const result = intake(`${GOAL} 80% safe and liquid, 20% in big tech.`, null);
    expect(result.sheet).toBeNull();
    expect(result.questions.length).toBeGreaterThan(0);
  });
});
