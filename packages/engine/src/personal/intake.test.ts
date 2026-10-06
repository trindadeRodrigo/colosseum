import { BasketSheetDraft } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { draftFromRules } from './draft';
import evalSet from './fixtures/goals-eval.json';
import recorded from './fixtures/intake-replies.json';
import {
  type IntakeAnswers,
  type IntakeInput,
  QUESTION_FIELDS,
  readReply,
  runIntake,
  type ShelfPortfolio,
} from './intake';
import { amountInText, horizonsIn, mentionsIn, refusalsIn } from './intake-text';
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
    expect(result.flags).toContain('same_figure_twice');
    expect(result.questions.map((q) => q.field)).toEqual(
      expect.arrayContaining(['amountUsd', 'incomeTargetUsdMonthly']),
    );
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
        const differ =
          r.draft[field] !== null && rules[field] !== null && r.draft[field] !== rules[field];
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
          if (q.template !== 'amountOtherCurrency')
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
      expect(result.draft, g.id).toEqual(draftFromRules(g.text, NOW).draft);
      expect(result.flags, g.id).toEqual([]);
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
