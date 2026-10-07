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
  riskForMixEstimate,
  runIntake,
  type ShelfPortfolio,
} from './intake';
import {
  amountInText,
  exitTimesIn,
  goalCuesIn,
  horizonsIn,
  marketShareIn,
  marketsIn,
  mentionsIn,
  mixIn,
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
    expect(result.questions.map((q) => q.field)).toEqual(['goal', 'amountUsd', 'risk']);
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
    // The shelf of a chain that does not hold The Seven.
    const noSeven = { portfolios: portfolios.filter((p) => p.slug !== 'the-seven') };
    const cases: [
      string,
      string[],
      Partial<Record<string, unknown>>,
      string[],
      Partial<IntakeInput>?,
    ][] = [
      ['amount_not_in_text', ['not_in_text:amountUsd'], { amountUsd: null }, ['amountUsd']],
      [
        'horizon_not_in_text',
        ['not_in_text:horizonMonths'],
        { horizonMonths: null },
        ['horizonMonths'],
      ],
      // A portfolio the text names ("starting from The Seven"), read on a shelf that does not hold it.
      ['portfolio_not_on_shelf', ['not_on_shelf:themes'], { themes: null }, ['themes'], noSeven],
      ['currency_not_in_text', ['not_in_text:currency'], { currency: null }, ['currency']],
      [
        'invalid_fields',
        ['model_invalid:goal', 'model_invalid:risk'],
        { goal: null, risk: null },
        ['goal', 'risk'],
      ],
    ];
    for (const [name, flags, draft, asked, over] of cases) {
      const { goal, reply } = adversarial[name] as { goal: string; reply: unknown };
      const result = run(goal, { reply, ...over });
      expect(result.flags, name).toEqual(expect.arrayContaining(flags));
      expect(result.draft, name).toMatchObject(draft);
      expect(
        result.questions.map((q) => q.field),
        name,
      ).toEqual(expect.arrayContaining(asked));
      expect(result.sheet, name).toBeNull();
    }
  });

  // The review of Oct 6, finding 9: the model reads what the person named, it picks nothing.
  it('a portfolio the model names that the text does not write is dropped and flagged, and nothing is asked about it', () => {
    const { goal, reply } = adversarial.portfolio_not_in_text as { goal: string; reply: unknown };
    // The text names The Seven; the model answers "Moon Rockets".
    expect(goalOf(goal).text).not.toMatch(/Moon Rockets/);
    const result = run(goal, { reply });
    expect(result.flags).toContain('no_cue:portfolios');
    expect(result.flags).not.toContain('not_on_shelf:themes');
    expect(result.draft.themes).toBeNull();
    expect(result.questions.map((q) => q.field)).not.toContain('themes');
    // The same for one that is on the shelf: being there is not being named.
    const picked = run('en-grow-10y-high', {
      reply: { ...(replies['en-grow-10y-high'] as object), portfolios: ['The Seven'] },
    });
    expect(picked.flags).toContain('no_cue:portfolios');
    expect(picked.draft.themes).toBeNull();
    expect(picked.sheet?.themes).toEqual([]);
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
  it('a goal or a risk with no word for it in the text is the suggestion, not the reading', () => {
    const cases: [string, string, string, unknown][] = [
      ['goal_without_cue', 'goal', 'no_cue:goal', 'protect'],
      ['risk_without_cue', 'risk', 'no_cue:risk', 'high'],
    ];
    for (const [name, field, flag, value] of cases) {
      const { goal, reply } = adversarial[name] as { goal: string; reply: unknown };
      const result = run(goal, { reply });
      expect(result.flags, name).toContain(flag);
      const q = result.questions.find((x) => x.field === field);
      expect(q, name).toMatchObject({ read: value });
      expect(result.sheet, name).toBeNull();
    }
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
    // No country is asked (gate COUNTRY-REMOVED, Oct 6): it was ['country', 'chains'].
    expect(result.questions.map((q) => q.field)).toEqual(['chains']);
    expect(result.sheet).toBeNull();
  });

  it('a portfolio answered off the shelf is refused and asked again', () => {
    const result = run('en-grow-10y-high', {
      answers: { themes: ['moon-rockets'] },
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
      answers: { goal: 'protect', amountUsd: 550, risk: 'low' },
    });
    expect(result.sheet).toMatchObject({
      goal: 'protect',
      amountUsd: 550,
      horizonMonths: 12,
      risk: 'low',
      currency: 'BRL',
      language: 'pt',
      // "Sem ações": no stocks, and none through a fund of stocks either.
      limits: { cannotHold: { classes: ['etf', 'stock'] } },
    });
    expect(result.readBack).toContain('Você deixou de fora ações e fundos de ações.');
    const noCredit = run('en-grow-3y-no-credit');
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
    expect(first.questions.map((q) => q.field)).toEqual(['goal', 'sleeves', 'horizonMonths']);
    expect(first.flags).toContain('max_yield_asked');
  });

  it('turn 2: the answers in words are read, nothing answered is asked, and nothing is left', () => {
    const first = turn(1);
    const second = turn(2);
    expect(second.questions).toEqual([]);
    const answered = ['goal', 'sleeves', 'horizonMonths'];
    for (const f of answered) expect(second.questions.map((q) => q.field)).not.toContain(f);
    expect(first.questions.map((q) => q.field)).toEqual(expect.arrayContaining(answered));
    // "Can take up to 3 months to get out" is no time frame.
    expect(second.draft.horizonMonths).toBeNull();
    expect(
      horizonsIn(conversationText(chat.messages[0] ?? '', chat.messages.slice(1, 2)), NOW),
    ).toEqual([]);
  });

  it('turn 2 makes the sheet: 70/30, grow, high risk on the part that seeks the goal, no date, no glide', () => {
    const third = turn(2);
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
    expect(wrong.questions).toEqual([]);
  });

  it('with the model off, "no hard cap" is still no date, and the split is still asked', () => {
    const off = turn(2, null);
    expect(off.questions.map((q) => q.field)).not.toContain('horizonMonths');
    expect(off.questions.map((q) => q.field)).toContain('sleeves');
  });

  // Gate COUNTRY-REMOVED (Rodrigo, Oct 6): the country is never asked, read or said back.
  it('never asks the country, reads none, and says none back', () => {
    const second = turn(2);
    expect(second.questions.map((q) => q.field)).not.toContain('country');
    expect(second.sheet?.country).toBeUndefined();
    expect((second.readBack ?? []).join(' ')).not.toMatch(/You live|Brazil|country/);
    const said = runIntake({
      text: 'I live in Brazil. Grow $5,000 over 5 years, high risk.',
      nowMonth: NOW,
      reply: { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'high', country: 'BR' },
      homeChain: 'solana',
      portfolios,
    });
    expect(said.draft.country).toBeNull();
    expect(said.sheet?.country).toBeUndefined();
    expect(said.questions).toEqual([]);
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

  it('the negation of a loose risk phrase stops at a comma or a sentence break', () => {
    expect(riskCuesIn('no stocks, go crazy')).toContain('high');
    expect(riskCuesIn('I have no fear, go crazy')).toContain('high');
    expect(riskCuesIn('No fear. Go crazy.')).toContain('high');
    expect(riskCuesIn("don't go crazy")).not.toContain('high');
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
      reply: { goal: 'grow', amountUsd: 5000, horizonMonths, risk: 'high' },
      homeChain: 'solana',
      portfolios,
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

// Gate EXPLICIT-MIX (Rodrigo, Oct 6): what the person says to hold, the plan holds, and no risk
// question is asked. The model's replies here are MOCK, written by hand in the shape the API asks for.
describe('a stated mix and a named market (gate EXPLICIT-MIX)', () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    goal: null,
    amountUsd: null,
    incomeTargetUsdMonthly: null,
    horizonMonths: null,
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
    ...over,
  });
  const ALL_STOCKS = { growthPct: 100, dollarYieldPct: 0, goldPct: 0, cashPct: 0, creditPct: null };
  const intake = (text: string, r: unknown, over: Partial<IntakeInput> = {}) =>
    runIntake({ text, nowMonth: NOW, reply: r, homeChain: 'solana', portfolios, ...over });

  // The chat that failed in /plan-chat: the risk was asked twice, and big tech had no list.
  const FIRST =
    'I have 2k that I want to invest in the big tech industry, I dont have a term, but I would say 5 years';
  const SECOND = 'I want all of it in stocks';
  const chatReply = reply({
    goal: 'grow',
    amountUsd: 2000,
    horizonMonths: 60,
    openEnded: true,
    markets: ['big_tech'],
    mix: ALL_STOCKS,
  });

  it('the shelf holds The Seven and The 500 on the chain used here', () => {
    expect(portfolios.map((p) => p.slug)).toEqual(expect.arrayContaining(['the-seven', 'the-500']));
  });

  it('the failed chat, as two turns: no risk question, The Seven, all in stocks, high risk said once', () => {
    const result = intake(conversationText(FIRST, [SECOND]), chatReply);
    expect(result.questions).toEqual([]);
    expect(result.questions.map((q) => q.field)).not.toContain('risk');
    expect(result.mix).toEqual({ growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 });
    const sheet = result.sheet as PersonalSheet;
    expect(sheet.themes).toEqual(['the-seven']);
    expect(sheet.mix?.growthBps).toBe(10_000);
    expect(sheet.risk).toBe('high');
    // A soft time frame is a time frame, with no glide and no "no date".
    expect(sheet.horizonMonths).toBe(60);
    expect(sheet.horizonOpen).toBeUndefined();
    expect(sheet.rules.glide).toBe(false);
    const limits = (result.readBack ?? []).filter((s) => /limits for high risk/.test(s));
    expect(limits).toEqual([
      'To hold “all of it in stocks”, the plan uses the limits for high risk.',
    ]);
    expect(result.assumptions.filter((s) => /high risk/.test(s))).toHaveLength(1);
    expect(result.readBack).toContain('100% of the plan in stocks and crypto.');
    expect(result.flags).toContain('risk_from_mix');
  });

  it('the failed chat, as one text, reads the same; with no model, the mix and the market still hold', () => {
    const joined = `${FIRST}. ${SECOND}`;
    const byModel = intake(joined, chatReply);
    expect(byModel.sheet?.mix?.growthBps).toBe(10_000);
    expect(byModel.sheet?.themes).toEqual(['the-seven']);
    const byRules = intake(joined, null);
    expect(byRules.mix?.growthBps).toBe(10_000);
    expect(byRules.draft.themes).toEqual(['the-seven']);
    expect(byRules.questions.map((q) => q.field)).not.toContain('risk');
  });

  it('a soft time frame with this exact text is 60 months and no glide', () => {
    expect(horizonsIn(FIRST, NOW)).toEqual([60]);
    const result = intake(FIRST, reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60 }), {
      answers: { risk: 'medium' },
    });
    expect(result.sheet?.horizonMonths).toBe(60);
    expect(result.sheet?.rules.glide).toBe(false);
    expect(result.sheet?.horizonOpen).toBeUndefined();
  });

  it('"70% stocks and 30% cash" is a mix of 7,000 and 3,000 at medium risk, with no split asked', () => {
    const text = 'I have $5,000 to invest for 10 years, 70% stocks and 30% cash';
    const r = reply({
      goal: 'grow',
      amountUsd: 5000,
      horizonMonths: 120,
      mix: { growthPct: 70, dollarYieldPct: 0, goldPct: 0, cashPct: 30, creditPct: null },
    });
    for (const result of [intake(text, r), intake(text, null, { answers: { goal: 'grow' } })]) {
      expect(result.mix).toEqual({ growthBps: 7000, dollarYieldBps: 0, goldBps: 0, cashBps: 3000 });
      expect(result.questions.map((q) => q.field)).not.toContain('risk');
      expect(result.questions.map((q) => q.field)).not.toContain('sleeves');
    }
    const sheet = intake(text, r).sheet as PersonalSheet;
    expect(sheet.risk).toBe('medium');
    expect(sheet.sleeves).toBeUndefined();
  });

  it('"only credit" is all dollar yield, all of it allowed in credit', () => {
    const text = 'I want to grow $3,000 over 5 years, only credit';
    const result = intake(
      text,
      reply({
        goal: 'grow',
        amountUsd: 3000,
        horizonMonths: 60,
        mix: { growthPct: 0, dollarYieldPct: 100, goldPct: 0, cashPct: 0, creditPct: 100 },
      }),
    );
    expect(result.mix).toEqual({
      growthBps: 0,
      dollarYieldBps: 10_000,
      goldBps: 0,
      cashBps: 0,
      creditBps: 10_000,
    });
    expect(result.sheet?.risk).toBe('low');
    expect(result.readBack).toContain(
      'Of the dollar yield, up to 100% of the plan in tokens that lend to borrowers or trade a spread.',
    );
  });

  it('reads the mixes it is meant to, in English and Portuguese, and nothing it cannot', () => {
    const growth = { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 };
    for (const text of [
      'all of it in stocks',
      'everything in stocks',
      'only stocks',
      '100% stocks',
      'quero tudo em ações',
      'só ações',
      'all in crypto',
    ])
      expect(mixIn(text)?.mix, text).toEqual(growth);
    expect(mixIn('all in gold')?.mix.goldBps).toBe(10_000);
    expect(mixIn('only high yield')?.mix.creditBps).toBe(10_000);
    expect(mixIn('só crédito')?.mix.creditBps).toBe(10_000);
    expect(mixIn('60% ações, 30% ouro e 10% caixa')?.mix).toEqual({
      growthBps: 6000,
      dollarYieldBps: 0,
      goldBps: 3000,
      cashBps: 1000,
    });
    for (const text of [
      "I don't want all of it in stocks",
      'não quero tudo em ações',
      'only stocks and gold',
      '70% stocks',
      '70% stocks, and keep 50% safe',
      'no stocks',
      'I like AI',
      'todo en acciones',
      'tout en actions',
    ])
      expect(mixIn(text), text).toBeNull();
  });

  // The review of Oct 6, finding 6: a holding the model reads that the text's words cannot confirm
  // is not taken, and it is not dropped into a risk question either.
  it('a mix the model reads that the text does not write is not taken: it is asked, with that reading as the start, and the risk is not', () => {
    const text = 'I want to grow $2,000 over 5 years';
    const r = reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, mix: ALL_STOCKS });
    const result = intake(text, r);
    expect(result.flags).toEqual(expect.arrayContaining(['no_cue:mix', 'mix_asked:model']));
    expect(result.mix).toBeNull();
    expect(result.sheet).toBeNull();
    expect(result.questions).toEqual([
      {
        field: 'mix',
        template: 'mix',
        text: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
        read: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
      },
    ]);
    // Asked once: the answer is the person's, a mix or none.
    const held = intake(text, r, {
      answers: { mix: { growthBps: 6000, dollarYieldBps: 0, goldBps: 0, cashBps: 4000 } },
    });
    expect(held.questions).toEqual([]);
    expect(held.sheet).toMatchObject({ risk: 'medium', mix: { growthBps: 6000, cashBps: 4000 } });
    const none = intake(text, r, { answers: { mix: null } });
    expect(none.mix).toBeNull();
    expect(none.questions.map((q) => q.field)).toEqual(['risk']);
  });

  it('income with "all in stocks" asks once whether the goal is to grow or the plan holds no stocks', () => {
    const text = 'I want $50 a month of income from $10,000, all of it in stocks';
    const r = reply({
      goal: 'income',
      amountUsd: 10_000,
      incomeTargetUsdMonthly: 50,
      openEnded: false,
      mix: ALL_STOCKS,
    });
    const asked = intake(text, r, { answers: { horizonMonths: 60 } });
    const goalQs = asked.questions.filter((q) => q.field === 'goal');
    expect(goalQs).toHaveLength(1);
    expect(goalQs[0]?.template).toBe('goalMixConflict');
    expect(goalQs[0]?.text).toMatch(/Do you mean a goal to grow, or the plan with no stocks\?$/);
    expect(asked.questions.map((q) => q.field)).not.toContain('risk');
    expect(asked.flags).toContain('mix_conflicts_goal');
    expect(asked.sheet).toBeNull();
    // To grow: the mix is held.
    const grow = intake(text, r, { answers: { horizonMonths: 60, goal: 'grow' } });
    expect(grow.sheet?.mix?.growthBps).toBe(10_000);
    expect(grow.sheet?.risk).toBe('high');
    // The goal kept: no stocks, said so, and the risk is asked as for any goal.
    const kept = intake(text, r, { answers: { horizonMonths: 60, goal: 'income' } });
    expect(kept.mix).toBeNull();
    expect(kept.flags).toContain('mix_dropped_for_goal');
    expect(kept.questions.map((q) => q.field)).toEqual(['risk']);
    const done = intake(text, r, { answers: { horizonMonths: 60, goal: 'income', risk: 'low' } });
    expect(done.sheet?.mix).toBeUndefined();
    expect(done.assumptions).toContain(
      'A plan for a goal of income holds no stocks or crypto, so “all of it in stocks” is not held.',
    );
    // Or the person answers with a mix with no stocks.
    const cash = intake(text, r, {
      answers: {
        horizonMonths: 60,
        risk: 'low',
        mix: { growthBps: 0, dollarYieldBps: 10_000, goldBps: 0, cashBps: 0 },
      },
    });
    expect(cash.sheet?.goal).toBe('income');
    expect(cash.sheet?.mix?.dollarYieldBps).toBe(10_000);
  });

  it('a market with no shared portfolio is said in one line; a market the text does not name is asked', () => {
    const ai = intake(
      'I want to grow $2,000 in AI over 5 years, all of it in stocks',
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets: ['ai'], mix: ALL_STOCKS }),
    );
    expect(ai.flags).toContain('market_not_on_shelf:ai');
    expect(ai.sheet?.themes).toEqual([]);
    expect(ai.assumptions).toContain(
      'There is no stock for “AI” on Solana at the moment, and we will be adding more soon. The nearest today is The Seven, which you can choose.',
    );
    const sp = intake(
      'I want to grow $2,000 in the S&P 500 over 5 years, all of it in stocks',
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, mix: ALL_STOCKS }),
    );
    expect(sp.sheet?.themes).toEqual(['the-500']);
    const unnamed = intake(
      'I want to grow $2,000 over 5 years, all of it in stocks',
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets: ['big_tech'] }),
    );
    expect(unnamed.flags).toContain('no_cue:market:big_tech');
    expect(unnamed.questions.map((q) => q.field)).toEqual(['themes']);
  });

  it('a market with its share of the money written is held, and the risk is never asked', () => {
    // Turn 1 of the failed chat: "invest in the big tech industry" is the whole 2k.
    const first = intake(
      FIRST,
      reply({
        goal: 'grow',
        amountUsd: 2000,
        horizonMonths: 60,
        openEnded: true,
        markets: ['big_tech'],
      }),
    );
    expect(first.questions).toEqual([]);
    expect(first.flags).toContain('mix_from_market');
    expect(first.mix).toEqual({ growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 });
    expect(first.sheet).toMatchObject({ themes: ['the-seven'], risk: 'high', horizonMonths: 60 });
    expect(first.sheet?.rules.glide).toBe(false);
    expect(first.assumptions.filter((s) => /limits for/.test(s))).toEqual([
      'To hold “big tech”, the plan uses the limits for high risk.',
    ]);
    // A sum: "put $500 in US stocks" of $2,000 is 25% in stocks, the rest in cash, at low risk.
    const sum = intake(
      'I want to grow $2,000 over 5 years. Put $500 in US stocks',
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets: ['us_market'] }),
    );
    expect(sum.mix).toEqual({ growthBps: 2500, dollarYieldBps: 0, goldBps: 0, cashBps: 7500 });
    expect(sum.sheet).toMatchObject({ themes: ['the-500'], risk: 'low' });
    // "All of it in AI", where the chain has nothing for AI (gate THEME-NONE-YET, Oct 6): no mix is
    // made from it and no share is asked. That is said, with the nearest portfolio offered, and the
    // risk is asked as for any goal.
    const ai = intake(
      'I want to grow $2,000 over 5 years, all of it in AI',
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets: ['ai'] }),
    );
    expect(ai.questions.map((q) => q.field)).toEqual(['risk']);
    expect(ai.mix).toBeNull();
    expect(ai.flags).not.toContain('mix_from_market');
    expect(ai.assumptions).toEqual([
      'There is no stock for “AI” on Solana at the moment, and we will be adding more soon. The nearest today is The Seven, which you can choose.',
    ]);
    for (const t of [
      'invest in big tech',
      'all of it in AI',
      'put it in US stocks',
      'investir em big techs',
    ])
      expect(marketShareIn(t, marketsIn(t)[0]?.at ?? 0), t).toEqual({ kind: 'whole' });
    for (const t of ['I like AI', "I'm interested in big tech", 'what about the S&P?'])
      expect(marketShareIn(t, marketsIn(t)[0]?.at ?? 0), t).toBeNull();
  });

  it('reads a sum as Portuguese writes it, and the second sum of a sentence', () => {
    const shares = (t: string) => marketsIn(t).map((m) => marketShareIn(t, m.at));
    // "US$ 2.000": a mark, a space, and a point for the thousands, which ends no sentence.
    expect(shares('Quero investir US$ 2.000 em big techs por 5 anos')).toEqual([
      { kind: 'amount', value: 2000 },
    ]);
    expect(shares('investir 2 mil dólares em IA')).toEqual([{ kind: 'amount', value: 2000 }]);
    expect(shares('Tenho US$ 2.000. Quero investir em big techs')).toEqual([{ kind: 'whole' }]);
    // The second sum of a sentence is the second market's.
    expect(shares('put $500 in big tech and $300 in AI')).toEqual([
      { kind: 'amount', value: 500 },
      { kind: 'amount', value: 300 },
    ]);
    // Through the intake: both sums are held, in one mix, and nothing is asked.
    const two = intake(
      'I want to grow $2,000 over 5 years. Put $500 in big tech and $300 in the S&P 500',
      reply({
        goal: 'grow',
        amountUsd: 2000,
        horizonMonths: 60,
        markets: ['big_tech', 'us_market'],
      }),
    );
    expect(two.questions).toEqual([]);
    expect(two.mix).toEqual({ growthBps: 4000, dollarYieldBps: 0, goldBps: 0, cashBps: 6000 });
    expect(two.sheet?.themes).toEqual(['the-seven', 'the-500']);
    const pt = intake(
      'Quero investir US$ 2.000 em big techs por 5 anos',
      reply({
        goal: 'grow',
        amountUsd: 2000,
        horizonMonths: 60,
        language: 'pt',
        markets: ['big_tech'],
      }),
    );
    expect(pt.questions).toEqual([]);
    expect(pt.mix?.growthBps).toBe(10_000);
    expect(pt.sheet?.themes).toEqual(['the-seven']);
  });

  it('a market with no share said asks how much of the money, once, and never the risk', () => {
    const r = reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets: ['big_tech'] });
    const text = 'I want to grow $2,000 over 5 years. I like big tech';
    const asked = intake(text, r);
    expect(asked.questions.map((q) => q.field)).toEqual(['mix']);
    expect(asked.questions[0]?.text).toBe('How much of the $2,000 for big tech?');
    expect(asked.flags).toContain('market_share_unclear');
    expect(asked.sheet).toBeNull();
    const pt = intake('Quero crescer US$ 2.000 em 5 anos. Gosto de big techs', {
      ...r,
      language: 'pt',
    });
    expect(pt.questions.map((q) => q.text)).toEqual(['Quanto dos US$ 2.000 para big techs?']);
    // The answer, as a mix: held, and the risk follows it.
    const answered = intake(text, r, {
      answers: { mix: { growthBps: 5000, dollarYieldBps: 0, goldBps: 0, cashBps: 5000 } },
    });
    expect(answered.questions).toEqual([]);
    expect(answered.sheet).toMatchObject({ risk: 'low', mix: { growthBps: 5000, cashBps: 5000 } });
    // A market the chain has nothing for is never asked its share (gate THEME-NONE-YET): the risk is.
    const none = intake(
      'I want to grow $2,000 over 5 years. I like AI',
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets: ['ai'] }),
    );
    expect(none.questions.map((q) => q.field)).toEqual(['risk']);
    expect(none.flags).not.toContain('market_share_unclear');
  });

  it('a market off the shelf offers the nearest: big tech and AI The Seven, the US market The 500', () => {
    const r = (markets: string[]) =>
      reply({ goal: 'grow', amountUsd: 2000, horizonMonths: 60, markets });
    const noSeven = portfolios.filter((p) => p.slug !== 'the-seven');
    const big = intake('Invest $2,000 in big tech for 5 years', r(['big_tech']), {
      portfolios: noSeven,
    });
    expect(big.assumptions).toContain(
      'There is no stock for “big tech” on Solana at the moment, and we will be adding more soon. The nearest today is The 500, which you can choose.',
    );
    const no500 = portfolios.filter((p) => p.slug !== 'the-500');
    const us = intake('Invest $2,000 in US stocks for 5 years', r(['us_market']), {
      portfolios: no500,
    });
    expect(us.assumptions).toContain(
      'There is no stock for “US stocks” on Solana at the moment, and we will be adding more soon. The nearest today is The Seven, which you can choose.',
    );
    const none = intake('Invest $2,000 in AI for 5 years', r(['ai']), { portfolios: [] });
    expect(none.assumptions).toContain(
      'There is no stock for “AI” on Solana at the moment. We will be adding more soon.',
    );
    // Nothing is held for a market the chain has nothing for, one of the first three included (gate
    // THEME-NONE-YET, Oct 6): no mix, no share asked, no limits line, and the risk asked as for any
    // goal. With the risk answered, the sheet is the goal's alone and the one sentence is said back.
    for (const result of [big, us, none]) {
      expect(result.questions.map((q) => q.field)).toEqual(['risk']);
      expect(result.mix).toBeNull();
      expect(result.draft.sleeves).toBeNull();
      expect(result.assumptions.filter((s) => /limits for/.test(s))).toEqual([]);
    }
    const answered = intake('Invest $2,000 in big tech for 5 years', r(['big_tech']), {
      portfolios: noSeven,
      answers: { risk: 'medium' },
    });
    expect(answered.questions).toEqual([]);
    expect(answered.sheet).toMatchObject({ risk: 'medium', themes: [] });
    expect(answered.sheet?.mix).toBeUndefined();
    expect(answered.sheet?.sleeves).toBeUndefined();
    expect(answered.readBack).toEqual([
      'You set a goal to grow with $2,000 over 5 years, at medium risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'There is no stock for “big tech” on Solana at the moment, and we will be adding more soon. The nearest today is The 500, which you can choose.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
  });

  it('the risk a mix needs: the lowest risk whose cap per issuer admits its stocks', () => {
    const at = (growthBps: number) => riskForMixEstimate({ growthBps });
    expect([at(0), at(5000), at(7000), at(7001), at(10_000)]).toEqual([
      'low',
      'low',
      'medium',
      'high',
      'high',
    ]);
  });
});

// Any language (gate EXPLICIT-MIX): the reader reads it, the intake answers in English, and what the
// English and Portuguese checks cannot find in the text is asked, never taken.
describe('a goal in another language than English or Portuguese', () => {
  const base = {
    incomeTargetUsdMonthly: null,
    risk: null,
    chain: null,
    portfolios: [],
    noCredit: false,
    cannotHold: [],
    unclear: [],
    openEnded: false,
    mayNeedInMonths: null,
    sleeves: null,
    currency: null,
  };

  it('Spanish: answered in English; the market and the mix it cannot find are asked', () => {
    const text = 'Tengo 3000 dólares y quiero todo en acciones de grandes tecnológicas';
    const result = runIntake({
      text,
      nowMonth: NOW,
      homeChain: 'solana',
      portfolios,
      reply: {
        ...base,
        goal: 'grow',
        amountUsd: 3000,
        horizonMonths: null,
        language: 'es',
        markets: ['big_tech'],
        mix: { growthPct: 100, dollarYieldPct: 0, goldPct: 0, cashPct: 0, creditPct: null },
      },
    });
    expect(result.language).toBe('en');
    expect(result.flags).toEqual(
      expect.arrayContaining(['language_other:es', 'no_cue:mix', 'no_cue:market:big_tech']),
    );
    expect(result.mix).toBeNull();
    expect(result.draft.themes).toBeNull();
    // "dólares" is dollars in Portuguese too: the amount is found, and taken.
    expect(result.draft.amountUsd).toBe(3000);
    // The mix the checks cannot find is asked, with the model's reading as the start, and the risk is
    // not asked in its place (the review of Oct 6, finding 6).
    const asked = result.questions.map((q) => q.field);
    expect(asked).toEqual(['goal', 'mix', 'horizonMonths', 'themes']);
    expect(result.questions.find((q) => q.field === 'mix')).toMatchObject({
      template: 'mix',
      read: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
    });
    expect(result.questions.every((q) => /^[\x20-\x7E’“”]+$/.test(q.text))).toBe(true);
    expect(result.sheet).toBeNull();
    // With no model: the same language, and nothing taken that the checks cannot find.
    const rules = runIntake({ text, nowMonth: NOW, homeChain: 'solana', portfolios, reply: null });
    expect(rules.language).toBe('en');
    expect(rules.mix).toBeNull();
    expect(rules.sheet).toBeNull();
  });

  it('French: answered in English; the amount in euros, the time frame and the mix are asked', () => {
    const text = "J'ai 5000 euros, je veux tout en actions, sur 10 ans";
    const result = runIntake({
      text,
      nowMonth: NOW,
      homeChain: 'solana',
      portfolios,
      reply: {
        ...base,
        goal: 'grow',
        amountUsd: 5000,
        horizonMonths: 120,
        language: 'fr',
        markets: [],
        mix: { growthPct: 100, dollarYieldPct: 0, goldPct: 0, cashPct: 0, creditPct: null },
      },
    });
    expect(result.language).toBe('en');
    expect(result.flags).toEqual(
      expect.arrayContaining([
        'language_other:fr',
        'no_cue:mix',
        'other_currency:amountUsd',
        'not_in_text:horizonMonths',
      ]),
    );
    expect(result.draft.amountUsd).toBeNull();
    expect(result.draft.horizonMonths).toBeNull();
    expect(result.mix).toBeNull();
    const asked = result.questions.map((q) => q.field);
    // The mix is asked, and the risk is not asked in its place.
    expect(asked).toEqual(['goal', 'amountUsd', 'mix', 'horizonMonths']);
    expect(result.questions.find((q) => q.field === 'mix')?.read).toEqual({
      growthBps: 10_000,
      dollarYieldBps: 0,
      goldBps: 0,
      cashBps: 0,
    });
    expect(result.questions.find((q) => q.field === 'amountUsd')?.text).toBe(
      'You wrote 5,000 EUR. How much is that in dollars, the currency the plan is funded in?',
    );
    const rules = runIntake({ text, nowMonth: NOW, homeChain: 'solana', portfolios, reply: null });
    expect(rules.language).toBe('en');
    expect(rules.sheet).toBeNull();
  });
});
