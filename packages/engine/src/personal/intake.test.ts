import { BasketSheetDraft } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { draftFromRules } from './draft';
import evalSet from './fixtures/goals-eval.json';
import recorded from './fixtures/intake-replies.json';
import {
  conversationText,
  type IntakeAnswers,
  type IntakeInput,
  QUESTION_FIELDS,
  readReply,
  runIntake,
  type ShelfPortfolio,
} from './intake';
import {
  amountInText,
  countryNamed,
  exitTimesIn,
  goalCuesIn,
  horizonsIn,
  mentionsIn,
  refusalsIn,
  riskCuesIn,
} from './intake-text';
import { QUESTION_TEMPLATES, render } from './templates';
import { launchShelf } from './testing';
import { PersonalSheet } from './types';

// The guided intake (gate GUIDED-INTAKE; C14 and C16 to C18 of ENG-3 slice 4). The model's replies are
// MOCK: written by hand in the shape the API asks the model for, and replayed here. No test reaches a
// network. What is under test is everything after the model: the checks in pure code, the questions,
// the sheet the person confirms.

type Goal = (typeof evalSet.goals)[number];
const goals = evalSet.goals as Goal[];
const replies = recorded.replies as Record<string, unknown>;
const adversarial = recorded.adversarial as Record<string, { goal: string; reply: unknown }>;
const NOW = evalSet.nowMonth;

const portfolios: ShelfPortfolio[] = launchShelf().families.map((f) => ({
  slug: f.meta.slug,
  name: f.meta.name,
}));
const goalOf = (id: string): Goal => {
  const g = goals.find((x) => x.id === id);
  if (!g) throw new Error(`no goal ${id}`);
  return g;
};
const run = (id: string, over: Partial<IntakeInput> = {}) =>
  runIntake({
    text: goalOf(id).text,
    nowMonth: NOW,
    reply: replies[id] ?? null,
    homeChain: 'solana',
    portfolios,
    ...over,
  });

// Answers a person might give to whatever is asked, one per field.
const ANSWER: Required<Pick<IntakeAnswers, 'goal' | 'amountUsd' | 'horizonMonths' | 'risk'>> &
  IntakeAnswers = {
  goal: 'grow',
  amountUsd: 2500,
  incomeTargetUsdMonthly: 20,
  horizonMonths: 24,
  risk: 'medium',
  country: 'US',
  currency: 'USD',
  themes: [],
};
const answersFor = (questions: { field: string }[]): IntakeAnswers =>
  Object.fromEntries(
    questions
      .filter((q) => q.field !== 'chains')
      .map((q) => [q.field, ANSWER[q.field as keyof IntakeAnswers]]),
  ) as IntakeAnswers;

describe('the recorded replies (MOCK) are labelled as such', () => {
  it('says they are hand-written, not recorded from a live model, and has one per goal', () => {
    expect(recorded.provenance).toBe('mock');
    expect(recorded.about).toMatch(/^MOCK\./);
    expect(recorded.about).toMatch(/not recorded from a live model/);
    expect(Object.keys(replies).sort()).toEqual(goals.map((g) => g.id).sort());
  });
});

describe('the checks after the model, on the evaluation set (C14)', () => {
  it('turns each recorded reply into the draft the set expects, and the refusals it expects', () => {
    for (const g of goals) {
      const result = run(g.id);
      expect(result.method, g.id).toBe('model');
      expect(BasketSheetDraft.safeParse(result.draft).success, g.id).toBe(true);
      expect(result.draft, g.id).toEqual(g.expect);
      expect(result.limits, g.id).toEqual(g.expectLimits);
    }
  });

  it('a goal in reais: the amount the model read as dollars is dropped, and asked in dollars', () => {
    const result = run('pt-protect-reais-sem-acoes');
    expect(result.draft.amountUsd).toBeNull();
    expect(result.draft.currency).toBe('BRL');
    expect(result.flags).toContain('other_currency:amountUsd');
    const ask = result.questions.find((q) => q.field === 'amountUsd');
    expect(ask?.template).toBe('amountOtherCurrency');
    expect(ask?.text).toBe(
      'Você escreveu 3.000 BRL. Quanto é isso em dólares, a moeda em que o plano é aplicado?',
    );
    // The model said it could not read the risk, and the rules parser reads "guardar" as a goal to
    // grow where the model reads one to protect: both are asked, in the person's language.
    expect(result.flags).toContain('disagrees_with_rules:goal');
    expect(result.questions.map((q) => q.field)).toEqual(['goal', 'amountUsd', 'risk', 'country']);
  });

  it('two amounts in one sentence: each is held to the text, and one figure for both is doubted', () => {
    for (const id of ['en-income-two-amounts', 'pt-income-two-amounts-mil']) {
      const result = run(id);
      expect(
        result.flags.filter((f) => !f.startsWith('disagrees_with_rules:')),
        id,
      ).toEqual([]);
      expect(result.draft.amountUsd, id).not.toBe(result.draft.incomeTargetUsdMonthly);
    }
    const swapped = adversarial.income_swapped as { goal: string; reply: unknown };
    const result = run(swapped.goal, { reply: swapped.reply });
    // $250 is written as a rate a month: it is the income, never the sum put in.
    expect(result.flags).toContain('wrong_role:amountUsd');
    expect(result.draft.amountUsd).toBeNull();
    // The two figures swapped: each is written, in the other role, and neither is taken.
    const base = replies['en-income-two-amounts'] as Record<string, unknown>;
    const crossed = run('en-income-two-amounts', {
      reply: { ...base, amountUsd: 250, incomeTargetUsdMonthly: 40_000 },
    });
    expect(crossed.flags).toEqual(
      expect.arrayContaining(['wrong_role:amountUsd', 'wrong_role:incomeTargetUsdMonthly']),
    );
    expect(crossed.draft).toMatchObject({ amountUsd: null, incomeTargetUsdMonthly: null });
    expect(result.questions.map((q) => q.field)).toContain('amountUsd');
  });

  it('drops what the text does not hold, and asks about it', () => {
    const cases: [string, string[], Partial<Record<string, unknown>>, string[]][] = [
      ['amount_not_in_text', ['not_in_text:amountUsd'], { amountUsd: null }, ['amountUsd']],
      [
        'horizon_not_in_text',
        ['not_in_text:horizonMonths'],
        { horizonMonths: null },
        ['horizonMonths'],
      ],
      ['portfolio_not_on_shelf', ['not_on_shelf:themes'], { themes: null }, ['themes']],
      ['currency_not_in_text', ['not_in_text:currency'], { currency: null }, ['currency']],
      [
        'invalid_fields',
        ['model_invalid:goal', 'model_invalid:risk', 'model_invalid:country'],
        { goal: null, risk: null, country: null },
        ['goal', 'risk', 'country'],
      ],
    ];
    for (const [name, flags, draft, asked] of cases) {
      const { goal, reply } = adversarial[name] as { goal: string; reply: unknown };
      const result = run(goal, { reply });
      expect(result.flags, name).toEqual(expect.arrayContaining(flags));
      expect(result.draft, name).toMatchObject(draft);
      expect(
        result.questions.map((q) => q.field),
        name,
      ).toEqual(expect.arrayContaining(asked));
      expect(result.sheet, name).toBeNull();
    }
  });

  it('keeps a refusal only where the text writes it', () => {
    const { goal, reply } = adversarial.refusal_not_in_text as { goal: string; reply: unknown };
    const result = run(goal, { reply });
    expect(result.limits).toEqual({ creditTolerance: null, cannotHoldClasses: null });
    expect(result.flags).toEqual(
      expect.arrayContaining(['not_in_text:cannotHold:gold', 'not_in_text:noCredit']),
    );
  });

  it('a reply that is not an object: every field is null, and every field is asked', () => {
    const { goal, reply } = adversarial.not_an_object as { goal: string; reply: unknown };
    const result = run(goal, { reply });
    expect(result.flags).toEqual(['model_unreadable']);
    expect(result.questions.map((q) => q.field)).toEqual([
      'goal',
      'amountUsd',
      'horizonMonths',
      'risk',
      'country',
    ]);
  });

  it('flags every field where the model and the rules parser disagree, and asks about it', () => {
    const result = run('en-protect-country-no-stocks');
    // The rules parser reads "no stocks" as high risk; the model reads low. Neither wins: the person says.
    expect(result.disagreements).toContainEqual({ field: 'risk', model: 'low', rules: 'high' });
    expect(result.flags).toContain('disagrees_with_rules:risk');
    const risk = result.questions.find((q) => q.field === 'risk');
    expect(risk?.read).toBe('low');
    expect(risk?.options).toEqual(['low', 'medium', 'high']);
    // On every goal, a disagreement is flagged by field and the field is asked unless it is the language.
    for (const g of goals) {
      const r = run(g.id);
      const rules = draftFromRules(g.text, NOW).draft;
      for (const field of ['goal', 'horizonMonths', 'risk'] as const) {
        const [a, b] = [r.draft[field], rules[field]];
        // One month apart is the same time frame (the rules parser counts "for 5 years" as 61).
        const near =
          field === 'horizonMonths' && typeof a === 'number' && typeof b === 'number'
            ? Math.abs(a - b) <= 1
            : false;
        // The rules parser's "medium" where the text has no word for it is its default, not a reading
        // (Oct 6): "risco alto" is high, and asking again would make the person repeat themselves.
        const rulesDefault =
          field === 'risk' && b === 'medium' && !riskCuesIn(g.text).includes('medium');
        const differ = a !== null && b !== null && a !== b && !near && !rulesDefault;
        expect(r.flags.includes(`disagrees_with_rules:${field}`), `${g.id} ${field}`).toBe(differ);
        if (differ)
          expect(
            r.questions.map((q) => q.field),
            g.id,
          ).toContain(field);
      }
    }
  });

  it('names the wallet chain when the text names another, and builds on the wallet chain', () => {
    const result = run('en-grow-by-2031-theme-chain', { homeChain: 'robinhood' });
    expect(result.flags).toContain('other_chain:solana');
  });
});

describe('the review of Oct 5: what the model gives that the text does not support is asked', () => {
  it('a country, a goal or a risk with no word for it in the text is the suggestion, not the reading', () => {
    const cases: [string, string, string, unknown][] = [
      ['country_not_in_text', 'country', 'no_cue:country', 'BR'],
      ['goal_without_cue', 'goal', 'no_cue:goal', 'protect'],
      ['risk_without_cue', 'risk', 'no_cue:risk', 'high'],
    ];
    for (const [name, field, flag, value] of cases) {
      const { goal, reply } = adversarial[name] as { goal: string; reply: unknown };
      const result = run(goal, { reply, answers: field === 'country' ? {} : { country: 'US' } });
      expect(result.flags, name).toContain(flag);
      const q = result.questions.find((x) => x.field === field);
      expect(q, name).toMatchObject({ read: value });
      expect(result.sheet, name).toBeNull();
    }
    // Where the text says it, it is taken: "I live in Brazil", "Moro no Brasil".
    for (const id of ['en-protect-country-no-stocks', 'pt-protect-country-no-stocks'])
      expect(run(id).flags, id).not.toContain('no_cue:country');
  });

  it('an amount in euros, pounds or another currency never passes as dollars', () => {
    for (const text of [
      'Grow 3k€ for 2 years',
      'Grow 3.000 € for 2 years',
      'Grow EUR 3,000 for 2 years',
      'Grow 3,000 in euros for 2 years',
      'Grow £3,000 for 2 years',
      'Grow C$ 3,000 for 2 years',
      'Crescer 3 mil pesos por 2 anos',
    ])
      expect(amountInText(text, 3000), text).toBe('other_currency');
    expect(amountInText('Grow 3,000 for 2 years', 3000)).toBe('dollars');
    expect(amountInText('Grow US$ 3,000, not 3,000 €', 3000)).toBe('dollars');
    const euro = runIntake({
      text: 'Grow 3k€ over 2 years, high risk.',
      nowMonth: NOW,
      reply: { goal: 'grow', amountUsd: 3000, horizonMonths: 24, risk: 'high', language: 'en' },
      homeChain: 'solana',
      portfolios,
    });
    expect(euro.draft.amountUsd).toBeNull();
    expect(euro.questions.find((q) => q.field === 'amountUsd')?.text).toBe(
      'You wrote 3,000 EUR. How much is that in dollars, the currency the plan is funded in?',
    );
  });

  it('binds each amount to its role', () => {
    const text = 'From $40,000 I want $250 a month of income for 10 years.';
    expect(amountInText(text, 40_000, 'amount')).toBe('dollars');
    expect(amountInText(text, 250, 'income')).toBe('dollars');
    expect(amountInText(text, 250, 'amount')).toBe('wrong_role');
    expect(amountInText(text, 40_000, 'income')).toBe('wrong_role');
    expect(amountInText('A monthly income of $300 from $80,000', 300, 'income')).toBe('dollars');
  });

  it('a duration is a time frame only where the text says it as one, never an age', () => {
    expect(horizonsIn('I am 35 years old and want to grow $5,000 over 10 years', NOW)).toEqual([
      120,
    ]);
    expect(horizonsIn('Tenho 35 anos de idade', NOW)).toEqual([]);
    expect(horizonsIn('My 2 kids, 5 years apart', NOW)).toEqual([]);
    const aged = runIntake({
      text: 'I am 35 years old and want to grow $5,000, high risk.',
      nowMonth: NOW,
      reply: { goal: 'grow', amountUsd: 5000, horizonMonths: 420, risk: 'high', language: 'en' },
      homeChain: 'solana',
      portfolios,
    });
    expect(aged.flags).toContain('not_in_text:horizonMonths');
    expect(aged.draft.horizonMonths).toBeNull();
  });
});

describe('the re-review of Oct 5', () => {
  it('a country named only under a negation is no cue for it', () => {
    expect(countryNamed('Not in Brazil anymore, I moved to Portugal', 'BR')).toBe(false);
    expect(countryNamed('Not in Brazil anymore, I moved to Portugal', 'PT')).toBe(true);
    expect(countryNamed('I no longer live in Brazil', 'BR')).toBe(false);
    expect(countryNamed('Não moro mais no Brasil', 'BR')).toBe(false);
    expect(countryNamed('Saí do Brasil em 2024', 'BR')).toBe(false);
    expect(countryNamed('Moro no Brasil', 'BR')).toBe(true);
    expect(countryNamed('I left Chile and now live in Brazil', 'BR')).toBe(true);
    const moved = runIntake({
      text: 'Not in Brazil anymore, I moved to Portugal. Grow $5,000 over 2 years, high risk.',
      nowMonth: NOW,
      reply: { goal: 'grow', amountUsd: 5000, horizonMonths: 24, risk: 'high', country: 'BR' },
      homeChain: 'solana',
      portfolios,
    });
    expect(moved.flags).toContain('no_cue:country');
    expect(moved.questions.find((q) => q.field === 'country')).toMatchObject({ read: 'BR' });
  });

  it('cues match whole words only: "highly" is not high, "lowest" not low, "keeper" not keep', () => {
    expect(riskCuesIn('I am highly motivated')).toEqual([]);
    expect(riskCuesIn('the lowest fees, a medium-sized sum')).toEqual(['medium']);
    expect(riskCuesIn('risco alto')).toEqual(['high']);
    expect(goalCuesIn('a goalkeeper with an incomer')).toEqual([]);
    expect(goalCuesIn('Grow it')).toEqual(['grow']);
    const highly = runIntake({
      text: 'I am highly motivated to grow $5,000 over 2 years.',
      nowMonth: NOW,
      reply: { goal: 'grow', amountUsd: 5000, horizonMonths: 24, risk: 'high' },
      homeChain: 'solana',
      portfolios,
    });
    expect(highly.flags).toContain('no_cue:risk');
  });

  describe('"for the next N years" is a time frame, in both readers', () => {
    const cases: [string, number][] = [
      ['for the next 15 years', 180],
      ['over the next 10 years', 120],
      ['in the next 18 months', 18],
      ['within 5 years', 60],
      ['for the coming 3 years', 36],
      ['pelos próximos 15 anos', 180],
      ['nos próximos 10 anos', 120],
      ['durante 5 anos', 60],
      ['em até 3 anos', 36],
    ];
    for (const [phrase, months] of cases)
      it(`"${phrase}" is ${months} months`, () => {
        expect(horizonsIn(phrase, NOW)).toEqual([months]);
        const text = /anos|meses/.test(phrase)
          ? `Quero crescer US$ 5.000 ${phrase}, risco alto.`
          : `Grow $5,000 ${phrase}, high risk.`;
        const result = runIntake({
          text,
          nowMonth: NOW,
          reply: { goal: 'grow', amountUsd: 5000, horizonMonths: months, risk: 'high' },
          homeChain: 'solana',
          portfolios,
        });
        expect(result.draft.horizonMonths).toBe(months);
        expect(result.flags.filter((f) => f.includes('horizonMonths'))).toEqual([]);
        expect(result.questions.map((q) => q.field)).not.toContain('horizonMonths');
      });

    it('an income paid "for the next 15 years" asks no time-frame question', () => {
      const result = runIntake({
        text: 'pay me around $500 a month for the next 15 years',
        nowMonth: NOW,
        reply: { goal: 'income', incomeTargetUsdMonthly: 500, horizonMonths: 180 },
        homeChain: 'solana',
        portfolios,
      });
      expect(result.draft.horizonMonths).toBe(180);
      expect(result.flags.filter((f) => f.includes('horizonMonths'))).toEqual([]);
      expect(result.questions.map((q) => q.field)).not.toContain('horizonMonths');
    });

    it('an age is still no time frame, and beside a real one only the real one is read', () => {
      expect(horizonsIn('I am 35 years old', NOW)).toEqual([]);
      expect(horizonsIn('tenho 40 anos de idade', NOW)).toEqual([]);
      expect(horizonsIn("I'm 40 and want to retire in 25 years", NOW)).toEqual([300]);
      expect(draftFromRules('I am 35 years old', NOW).draft.horizonMonths).toBeNull();
    });
  });

  it('a time frame one month from the rules parser is the same one: no disagreement is flagged', () => {
    // The rules parser reads "for 5 years" as 61 months; the model's 60 is the same time frame.
    const rules = draftFromRules(goalOf('en-income-300-month').text, NOW).draft;
    expect(rules.horizonMonths).toBe(61);
    const result = run('en-income-300-month');
    expect(result.draft.horizonMonths).toBe(60);
    expect(result.flags).not.toContain('disagrees_with_rules:horizonMonths');
    expect(result.disagreements.map((d) => d.field)).not.toContain('horizonMonths');
    expect(result.questions.map((q) => q.field)).not.toContain('horizonMonths');
  });
});

describe('questions', () => {
  it('asks one question per field, from its template, in the person language, in a fixed order', () => {
    for (const g of goals)
      for (const reply of [replies[g.id], null]) {
        const result = run(g.id, { reply });
        const fields = result.questions.map((q) => q.field);
        expect(new Set(fields).size, g.id).toBe(fields.length);
        expect(fields, g.id).toEqual(QUESTION_FIELDS.filter((f) => fields.includes(f)));
        for (const q of result.questions) {
          const template = QUESTION_TEMPLATES[q.template as keyof typeof QUESTION_TEMPLATES];
          expect(template, q.template).toBeDefined();
          if (q.template !== 'amountOtherCurrency' && q.template !== 'sleevesMismatch')
            expect(q.text).toBe(render(template[result.language], {}, result.language));
        }
      }
  });

  it('asks for the chain while the person has none, and makes no sheet', () => {
    const result = run('en-grow-10y-high', { homeChain: null });
    expect(result.questions.map((q) => q.field)).toEqual(['country', 'chains']);
    const answered = run('en-grow-10y-high', { homeChain: null, answers: { country: 'US' } });
    expect(answered.questions.map((q) => q.field)).toEqual(['chains']);
    expect(answered.sheet).toBeNull();
  });

  it('a portfolio answered off the shelf is refused and asked again', () => {
    const result = run('en-grow-10y-high', {
      answers: { country: 'US', themes: ['moon-rockets'] },
    });
    expect(result.flags).toContain('answer_not_on_shelf:themes');
    expect(result.questions.map((q) => q.field)).toEqual(['themes']);
    expect(result.sheet).toBeNull();
  });
});

describe('the person confirms a sheet', () => {
  it('once every question is answered, the sheet validates, on the wallet chain, with its read-back', () => {
    for (const g of goals)
      for (const reply of [replies[g.id], null]) {
        const first = run(g.id, { reply });
        expect(first.sheet === null, g.id).toBe(first.questions.length > 0);
        const done = run(g.id, { reply, answers: answersFor(first.questions) });
        expect(done.questions, g.id).toEqual([]);
        expect(done.sheet, g.id).not.toBeNull();
        expect(PersonalSheet.safeParse(done.sheet).success, g.id).toBe(true);
        expect(done.sheet?.chains, g.id).toEqual(['solana']);
        expect(done.readBack?.length, g.id).toBeGreaterThan(3);
      }
  });

  it('the answers win over what was read, and the refusals read become limits', () => {
    const result = run('pt-protect-reais-sem-acoes', {
      answers: { goal: 'protect', amountUsd: 550, risk: 'low', country: 'BR' },
    });
    expect(result.sheet).toMatchObject({
      goal: 'protect',
      amountUsd: 550,
      horizonMonths: 12,
      risk: 'low',
      currency: 'BRL',
      country: 'BR',
      language: 'pt',
      limits: { cannotHold: { classes: ['stock'] } },
    });
    const noCredit = run('en-grow-3y-no-credit', { answers: { country: 'US' } });
    expect(noCredit.sheet?.limits).toEqual({ creditTolerance: 'none' });
  });

  it('the same goal sent 10 times gives one sheet (C16)', () => {
    for (const g of goals) {
      const first = run(g.id);
      const answers = answersFor(first.questions);
      const sent = Array.from({ length: 10 }, () => JSON.stringify(run(g.id, { answers })));
      expect(new Set(sent).size, g.id).toBe(1);
    }
  });
});

describe('the model off (C17)', () => {
  it('pre-fills from the rules parser, asks the same kind of questions, and never fails', () => {
    for (const g of goals) {
      const result = run(g.id, { reply: null });
      expect(result.method).toBe('rules');
      const rules = draftFromRules(g.text, NOW).draft;
      expect(result.draft, g.id).toEqual(rules);
      // Every field the rules parser read is put to the person once, its reading the start.
      const read = (['goal', 'horizonMonths', 'risk'] as const).filter((f) => rules[f] !== null);
      expect(result.flags, g.id).toEqual(read.map((f) => `from_rules:${f}`));
      for (const f of read)
        expect(
          result.questions.find((q) => q.field === f),
          `${g.id} ${f}`,
        ).toMatchObject({ read: rules[f] });
      // Nothing the rules parser cannot read is guessed: it reads no amount, so the amount is asked.
      expect(
        result.questions.map((q) => q.field),
        g.id,
      ).toContain('amountUsd');
    }
  });
});

describe('what the text holds, read by code', () => {
  it('reads one amount in its four ways, and only the reais as another currency', () => {
    expect(amountInText('Guardar R$ 3.000,00', 3000)).toBe('other_currency');
    expect(amountInText('Guardar 3 mil dólares', 3000)).toBe('dollars');
    expect(amountInText('Grow $3k', 3000)).toBe('dollars');
    expect(amountInText('Grow 3,000 for a year', 3000)).toBe('dollars');
    expect(amountInText('Grow 3,000 for a year', 30_000)).toBe('absent');
    expect(mentionsIn('US$ 1.500,50 e 2,5 mil').map((m) => m.value)).toEqual([1500.5, 2500]);
  });

  it('reads time frames in months, years, words and dates, and not a rate as a time frame', () => {
    expect(horizonsIn('for 18 months', NOW)).toEqual([18]);
    expect(horizonsIn('em 10 anos', NOW)).toEqual([120]);
    expect(horizonsIn('for five years', NOW)).toEqual([60]);
    expect(horizonsIn('por um ano', NOW)).toEqual([12]);
    expect(horizonsIn('for half a year', NOW)).toEqual([6]);
    expect(horizonsIn('by 2031', NOW)).toEqual([51]);
    expect(horizonsIn('$300 a month', NOW)).toEqual([]);
  });

  it('reads refusals, and not a class named without a negation', () => {
    expect(refusalsIn('sem ações')).toEqual({ classes: ['stock'], noCredit: false });
    expect(refusalsIn('no credit, without crypto')).toEqual({
      classes: ['crypto'],
      noCredit: true,
    });
    expect(refusalsIn('I like stocks and gold')).toEqual({ classes: [], noCredit: false });
  });

  it('reads each field of a reply on its own', () => {
    const { reply, flags } = readReply({ goal: 'grow', risk: 'extreme', amountUsd: '5000' });
    expect(reply.goal).toBe('grow');
    expect(reply.risk).toBeNull();
    expect(reply.amountUsd).toBeNull();
    expect(flags).toEqual(['model_invalid:amountUsd', 'model_invalid:risk']);
  });
});

// Rodrigo's first /plan-chat of Oct 6 (gates GLIDE-OPT-IN, OUTCOME-VIEW, MAX-YIELD-SLEEVE), replayed
// message by message with a reply written by hand for each turn (MOCK). Each turn reads the whole
// conversation so far through the same reader and checks: an answer in the person's words counts.
describe('the first chat of Oct 6, replayed (MOCK replies)', () => {
  const chat = (
    recorded as unknown as {
      conversations: Record<
        string,
        { about: string; messages: string[]; replies: unknown[]; horizonFromExitTime: unknown }
      >;
    }
  ).conversations['first-chat-oct6'];
  if (!chat) throw new Error('no conversation first-chat-oct6');
  const turn = (n: number, reply: unknown = chat.replies[n - 1]) =>
    runIntake({
      text: conversationText(chat.messages[0] ?? '', chat.messages.slice(1, n)),
      nowMonth: NOW,
      reply,
      homeChain: 'solana',
      portfolios,
    });

  it('is labelled MOCK', () => {
    expect(chat.about).toMatch(/^MOCK\./);
  });

  it('turn 1: catches 70% and "the other half" as more than the whole, and asks the split once', () => {
    const first = turn(1);
    expect(first.flags).toContain('split_mismatch');
    const split = first.questions.filter((q) => q.field === 'sleeves');
    expect(split).toHaveLength(1);
    expect(split[0]?.template).toBe('sleevesMismatch');
    expect(split[0]?.text).toBe(
      'You wrote 70% and the other half, which come to more than the whole. Which split do you mean: 70% and 30%, or half and half?',
    );
    // "Highest yield" is read as high risk for the part that seeks it: one risk for the whole plan
    // is not asked.
    expect(first.questions.map((q) => q.field)).toEqual([
      'goal',
      'sleeves',
      'horizonMonths',
      'country',
    ]);
    expect(first.flags).toContain('max_yield_asked');
    // The country is asked with its reason.
    expect(first.questions.find((q) => q.field === 'country')?.text).toBe(
      "Some assets aren't offered in every country, and some can't be offered to people in certain countries. Where do you live?",
    );
  });

  it('turn 2: the answers in words are read; only the country is left, and nothing answered is asked', () => {
    const first = turn(1);
    const second = turn(2);
    expect(second.questions.map((q) => q.field)).toEqual(['country']);
    const answered = ['goal', 'sleeves', 'horizonMonths'];
    for (const f of answered) expect(second.questions.map((q) => q.field)).not.toContain(f);
    expect(first.questions.map((q) => q.field)).toEqual(expect.arrayContaining(answered));
    // "Can take up to 3 months to get out" is no time frame.
    expect(second.draft.horizonMonths).toBeNull();
    expect(
      horizonsIn(conversationText(chat.messages[0] ?? '', chat.messages.slice(1, 2)), NOW),
    ).toEqual([]);
  });

  it('turn 3: 70/30, grow, high risk on the part that seeks the goal, no date, no glide, Brazil', () => {
    const third = turn(3);
    expect(third.questions).toEqual([]);
    const sheet = third.sheet as PersonalSheet;
    expect(PersonalSheet.safeParse(sheet).success).toBe(true);
    expect(sheet.sleeves).toEqual([
      { kind: 'safe_yield', shareBps: 7000 },
      { kind: 'goal', shareBps: 3000 },
    ]);
    expect(sheet).toMatchObject({
      goal: 'grow',
      amountUsd: 2000,
      risk: 'high',
      country: 'BR',
      horizonOpen: true,
      rules: { useHoldings: true, glide: false },
    });
    // No 3-month horizon and no 3-month limit for the whole plan: the 70% is kept safe by its sleeve.
    expect(sheet.horizonMonths).not.toBe(3);
    expect(sheet.limits?.mayNeedInMonths).toBeUndefined();
    const said = third.readBack ?? [];
    expect(said[0]).toBe('You set a goal to grow with $2,000, with no date set, at high risk.');
    expect(said.join(' ')).not.toMatch(/date nears|over \d+ months/);
    // "3 months" only in the person's own words, said back as a time to get out.
    for (const s of said.filter((x) => /3 months/.test(x))) expect(s).toMatch(/^I read “/);
    expect(said).toContain('I took “go crazy” as high risk for the 30% that seeks the goal.');
    expect(said.find((s) => s.includes('as no date'))).toMatch(
      /“(?:dont|don't) have a hard cap”|“no hard cap”/,
    );
    expect(
      said.some((s) => /“can take up to 3 months to get out”|up to 3 months to get out/.test(s)),
    ).toBe(true);
    expect(said).toContain(
      'The high risk is for the part that seeks the goal. The part kept safe holds dollar yield from a rate alone, or cash, whatever the risk.',
    );
    expect(said.at(-1)).toBe('If this is right, confirm it and the plan is made from it.');
  });

  it('a model that reads the time to get out as the time frame is overruled, and nothing is asked', () => {
    const wrong = turn(2, chat.horizonFromExitTime);
    expect(wrong.flags).toContain('exit_time_not_horizon');
    expect(wrong.draft.horizonMonths).toBeNull();
    expect(wrong.questions.map((q) => q.field)).toEqual(['country']);
  });

  it('with the model off, "no hard cap" is still no date, and the split is still asked', () => {
    const off = turn(2, null);
    expect(off.questions.map((q) => q.field)).not.toContain('horizonMonths');
    expect(off.questions.map((q) => q.field)).toContain('sleeves');
  });

  it('always asks the country when none is given, and never takes ZZ or any default (Oct 6)', () => {
    const second = turn(2);
    expect(second.sheet).toBeNull();
    expect(second.questions.map((q) => q.field)).toEqual(['country']);
    // An answer, or a model reading, that is no country is asked again; nothing fills one in.
    const text = conversationText(chat.messages[0] ?? '', chat.messages.slice(1, 2));
    const base = { text, nowMonth: NOW, homeChain: 'solana' as const, portfolios };
    const answered = runIntake({ ...base, reply: chat.replies[1], answers: { country: 'ZZ' } });
    expect(answered.flags).toContain('not_a_country:answer');
    expect(answered.questions.map((q) => q.field)).toEqual(['country']);
    expect(answered.sheet).toBeNull();
    const read = runIntake({
      ...base,
      reply: { ...(chat.replies[1] as object), country: 'ZZ' },
    });
    expect(read.questions.map((q) => q.field)).toEqual(['country']);
    expect(runIntake({ ...base, reply: null }).questions.map((q) => q.field)).toContain('country');
  });
});

describe('the review of Oct 6', () => {
  const NOW_MONTH = NOW;
  const read = (text: string, reply: Record<string, unknown> | null) =>
    runIntake({
      text,
      nowMonth: NOW_MONTH,
      reply,
      homeChain: 'solana',
      portfolios,
      answers: { country: 'BR' },
    });

  it('a loose risk word under a negation, or a bare "crazy", is no cue for high', () => {
    for (const text of [
      "Grow $5,000 over 5 years, but don't go crazy.",
      'Grow $5,000 over 5 years, nothing crazy.',
      "Grow $5,000 over 5 years. I'm not crazy about crypto.",
      'Quero crescer US$ 5.000 em 5 anos, mas não pode arriscar tudo.',
    ])
      expect(riskCuesIn(text), text).not.toContain('high');
    for (const text of ['for the rest we can go crazy', 'the rest can go wild', 'pode arriscar'])
      expect(riskCuesIn(text), text).toContain('high');
    const calm = read("Grow $5,000 over 5 years, but don't go crazy.", {
      goal: 'grow',
      amountUsd: 5000,
      horizonMonths: 60,
      risk: 'high',
    });
    expect(calm.flags).toContain('no_cue:risk');
    expect(calm.questions.map((q) => q.field)).toContain('risk');
  });

  it('a written date beats "no rush", in English and Portuguese', () => {
    for (const [text, months] of [
      ['No rush, but I need $5,000 to grow by 2030, high risk.', 39],
      ['Sem pressa, mas preciso até 2030: fazer US$ 5.000 crescer, risco alto.', 39],
    ] as const) {
      const both = read(text, {
        goal: 'grow',
        amountUsd: 5000,
        horizonMonths: months,
        risk: 'high',
        openEnded: true,
      });
      expect(both.flags, text).toContain('date_in_text:openEnded');
      expect(both.sheet?.horizonOpen, text).toBeUndefined();
      expect(both.sheet?.horizonMonths, text).toBe(months);
      expect(both.sheet?.rules.glide, text).toBe(true);
      // A model that took "no rush" alone and missed the date: the date is asked, never left open.
      const missed = read(text, { goal: 'grow', amountUsd: 5000, risk: 'high', openEnded: true });
      expect(missed.sheet, text).toBeNull();
      expect(
        missed.questions.map((q) => q.field),
        text,
      ).toContain('horizonMonths');
      // With no model, the same.
      expect(read(text, null).sheet?.horizonOpen ?? false, text).toBe(false);
    }
  });

  it('"up to N years" after "for" or "invest" is a time frame; "take up to N to get out" is an exit time', () => {
    expect(horizonsIn('I want to invest for up to 5 years', NOW_MONTH)).toEqual([60]);
    expect(horizonsIn('the rest can take up to 3 months to get out', NOW_MONTH)).toEqual([]);
    expect(exitTimesIn('the rest can take up to 3 months to get out').map((e) => e.months)).toEqual(
      [3],
    );
    expect(exitTimesIn('I want to invest for up to 5 years')).toEqual([]);
  });

  it('a percent of the money outside the split is asked, never dropped', () => {
    const r = read('Grow $5,000 over 5 years, high risk: 70/30 safe and growth, but 50% in AI.', {
      goal: 'grow',
      amountUsd: 5000,
      horizonMonths: 60,
      risk: 'high',
      sleeves: [
        { kind: 'safe_yield', sharePct: 70 },
        { kind: 'goal', sharePct: 30 },
      ],
    });
    expect(r.flags).toContain('split_percent_unplaced');
    expect(r.draft.sleeves).toBeNull();
    expect(r.questions.filter((q) => q.field === 'sleeves')).toHaveLength(1);
    // A fall or a yield written as a percent is no share of the money.
    const fall = read(
      'Grow $5,000 over 5 years, high risk, 70% safe and 30% to grow; I can take a 20% fall.',
      {
        goal: 'grow',
        amountUsd: 5000,
        horizonMonths: 60,
        risk: 'high',
        sleeves: [
          { kind: 'safe_yield', sharePct: 70 },
          { kind: 'goal', sharePct: 30 },
        ],
      },
    );
    expect(fall.flags).not.toContain('split_percent_unplaced');
    expect(fall.sheet?.sleeves).toHaveLength(2);
  });

  it('with a part kept safe, the risk is still compared with the rules parser, against the risky part', () => {
    const text = 'Grow $5,000 over 5 years: 70% safe, 30% high risk.';
    const reply = {
      goal: 'grow',
      amountUsd: 5000,
      horizonMonths: 60,
      risk: 'low',
      sleeves: [
        { kind: 'safe_yield', sharePct: 70 },
        { kind: 'goal', sharePct: 30 },
      ],
    };
    // The rules parser reads "high risk"; the model's low for the risky part is flagged and asked.
    expect(draftFromRules(text, NOW_MONTH).draft.risk).toBe('high');
    const r = read(text, reply);
    expect(r.flags).toContain('disagrees_with_rules:risk');
    expect(r.questions.find((q) => q.field === 'risk')?.template).toBe('riskGoalPart');
  });
});

describe('the glide is opt-in (gate GLIDE-OPT-IN, Oct 6)', () => {
  const sheetOf = (text: string, horizonMonths: number) =>
    runIntake({
      text,
      nowMonth: NOW,
      reply: { goal: 'grow', amountUsd: 5000, horizonMonths, risk: 'high', country: 'US' },
      homeChain: 'solana',
      portfolios,
      answers: { country: 'US' },
    });
  it('is off for a time frame alone, and offered in one sentence', () => {
    const r = sheetOf('Grow $5,000 for the next 15 years, high risk.', 180);
    expect(r.sheet?.rules.glide).toBe(false);
    expect(r.sheet?.horizonMonths).toBe(180);
    expect(r.readBack?.join(' ')).toMatch(/unless you ask for it/);
  });
  it('is on for a date the money is needed by, or when the person asks for it', () => {
    expect(sheetOf('I need $5,000 to grow by 2031, high risk.', 51).sheet?.rules.glide).toBe(true);
    expect(
      sheetOf('Grow $5,000 over 10 years, high risk, and de-risk as the date nears.', 120).sheet
        ?.rules.glide,
    ).toBe(true);
    expect(
      sheetOf('I need this money in 5 years. Grow $5,000, high risk.', 60).sheet?.rules.glide,
    ).toBe(true);
  });
  it('a time to get out is never the time frame', () => {
    expect(horizonsIn('I may need it in 3 months', NOW)).toEqual([]);
    expect(exitTimesIn('the rest can take up to 3 months to get out').map((e) => e.months)).toEqual(
      [3],
    );
    expect(horizonsIn('posso precisar em 3 meses', NOW)).toEqual([]);
    expect(horizonsIn('Grow $5,000 in 3 months', NOW)).toEqual([3]);
  });
});
