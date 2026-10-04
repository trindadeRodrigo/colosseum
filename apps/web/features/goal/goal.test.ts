import { BasketSheet, BasketSheetDraft } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { json } from '../wallet/test/fake-port';
import { buildPlan, PERSONALIZE_PATH } from './build-plan';
import { COUNTRY_CODES, countryOptions } from './countries';
import { draftFromFirstReader, ReadGoalError, readGoal } from './read-goal';
import {
  checkSheet,
  dollars,
  FIELD_ID,
  fieldOfId,
  fieldsOfDraft,
  goalSentence,
  parseNumber,
  restoreGoal,
  type SheetFields,
  sheetGroups,
} from './sheet';
import { proposalFor, READ_IN_DOLLARS, READ_IN_REAIS, SHEET } from './test/plan';

// The goal screen without the screen: how a reading becomes the limits, how the limits are checked
// against the shared schema, and the two calls to the API (one that exists, one that does not yet).

const FIELDS: SheetFields = {
  goal: 'grow',
  amount: '40,000',
  income: '',
  horizon: '36',
  risk: 'medium',
  country: 'BR',
  holdings: 'yes',
  glide: 'yes',
  language: 'en',
};

describe('the first reader’s answer, as a draft of this product’s limits', () => {
  it('carries over what the money is for, the time frame, the risk and the language', () => {
    expect(draftFromFirstReader(READ_IN_REAIS)).toEqual({
      basketType: 'standard',
      goal: 'income',
      amountUsd: null,
      horizonMonths: 147,
      risk: 'low',
      themes: null,
      country: null,
      chains: null,
      incomeTargetUsdMonthly: null,
      rules: null,
      language: 'pt',
    });
  });

  it('never turns reais into dollars: an amount needs a source, and a conversion has none', () => {
    const draft = draftFromFirstReader(READ_IN_REAIS);
    expect(draft?.amountUsd).toBeNull();
    expect(draft?.incomeTargetUsdMonthly).toBeNull();
    // dollars it was told outright are dollars
    const told = { ...READ_IN_REAIS, sheet: { ...READ_IN_REAIS.sheet, initialCapitalUsd: 2500 } };
    expect(draftFromFirstReader(told)?.amountUsd).toBe(2500);
  });

  it('leaves empty what the reader filled with a default of its own', () => {
    const draft = draftFromFirstReader(READ_IN_DOLLARS);
    // it found no date and answered 36 months: that is not what the person said
    expect(draft?.horizonMonths).toBeNull();
    expect(draft?.amountUsd).toBeNull();
    expect(draft).toMatchObject({ goal: 'grow', risk: 'medium', language: 'en' });
  });

  it('is always a draft the shared schema takes, whatever the reader said', () => {
    for (const body of [READ_IN_REAIS, READ_IN_DOLLARS]) {
      const draft = draftFromFirstReader(body);
      expect(BasketSheetDraft.safeParse(draft).success).toBe(true);
    }
    const odd = {
      candidate: { profile: 'whatever', horizonMonths: 9999, riskBudget: 7, language: 'fr' },
      validationErrors: [],
    };
    expect(draftFromFirstReader(odd)).toMatchObject({
      goal: null,
      horizonMonths: null,
      risk: null,
      language: null,
    });
  });

  it('takes nothing that is not the reader’s answer', () => {
    for (const body of [null, 'ok', {}, { candidate: {} }, { validationErrors: [] }])
      expect(draftFromFirstReader(body)).toBeNull();
  });
});

describe('reading a goal: POST /goals', () => {
  const NOW = () => new Date('2026-10-04T12:00:00.000Z');

  it('sends the text and the language, and hands back the draft with how it was read', async () => {
    const api = vi.fn(async () => json(READ_IN_DOLLARS));
    const reading = await readGoal(api, 'Grow $40,000 by June 2028', 'en', NOW);
    expect(api).toHaveBeenCalledWith('/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Grow $40,000 by June 2028', language: 'en' }),
    });
    expect(reading.source).toEqual({
      method: 'llm',
      model: 'a-model',
      fetchedAt: '2026-10-04T12:00:00.000Z',
      provenance: 'live',
    });
    expect(reading.firstReader).toBe(true);
    expect(reading.draft.goal).toBe('grow');
  });

  it('says why when it cannot be read', async () => {
    const kind = async (answer: () => Promise<Response>) => {
      const e = await readGoal(answer, 'x', 'en').catch((error: unknown) => error);
      expect(e).toBeInstanceOf(ReadGoalError);
      return (e as ReadGoalError).kind;
    };
    expect(await kind(async () => json({ error: 'too short' }, 400))).toBe('too_short');
    expect(await kind(async () => json({}, 429))).toBe('busy');
    expect(await kind(async () => json({}, 500))).toBe('unreachable');
    expect(
      await kind(async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBe('unreachable');
    expect(await kind(async () => json({ hello: 'world' }))).toBe('unreadable');
    expect(await kind(async () => new Response('<html>'))).toBe('unreadable');
  });
});

describe('building a plan: the one call, against a double of the route that is not there yet', () => {
  it('sends the sheet to POST /v1/baskets/personalize and reads back the plan and its id', async () => {
    const proposal = proposalFor(SHEET);
    const api = vi.fn(async () => json({ id: 'plan-1', proposal }));
    expect(await buildPlan(api, SHEET)).toEqual({ kind: 'built', id: 'plan-1', proposal });
    expect(PERSONALIZE_PATH).toBe('/v1/baskets/personalize');
    expect(api).toHaveBeenCalledWith(PERSONALIZE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheet: SHEET }),
    });
  });

  it('says the route is not there when the API has none, which is today', async () => {
    for (const status of [404, 405, 501])
      expect(await buildPlan(async () => json({ error: 'not found' }, status), SHEET)).toEqual({
        kind: 'unavailable',
      });
  });

  it('shows nothing that is not a plan in the frozen shape', async () => {
    const proposal = proposalFor(SHEET);
    const lopsided = {
      ...proposal,
      lines: proposal.lines.map((line) => ({ ...line, weightBps: 4000 })),
    };
    for (const body of [
      { id: 'plan-1', proposal: lopsided },
      { id: 'plan-1', proposal: { lines: [] } },
      { proposal },
      { id: '', proposal },
      proposal,
      'ok',
    ])
      expect(await buildPlan(async () => json(body), SHEET)).toEqual({ kind: 'unreadable' });
  });

  it('tells a sheet the server refused from limits no plan fits, and both from no answer', async () => {
    const answers = (status: number, body: unknown = {}) =>
      buildPlan(async () => json(body, status), SHEET);
    expect(await answers(400, { error: 'body/sheet/amountUsd too small' })).toEqual({
      kind: 'refused',
    });
    // each thing a person can do something about is told apart from a refusal of the limits
    expect(await answers(409, { error: 'pick the chain your plans live on first' })).toEqual({
      kind: 'no-chain',
    });
    for (const status of [401, 403])
      expect(await answers(status, { error: 'sign in first' })).toEqual({ kind: 'signed-out' });
    expect(await answers(409, { error: 'no plan', code: 'GOAL_NOT_ACHIEVABLE' })).toEqual({
      kind: 'no-plan',
    });
    expect(await answers(422, { error: 'no plan', code: 'GOAL_NOT_ACHIEVABLE' })).toEqual({
      kind: 'no-plan',
    });
    expect(await answers(429)).toEqual({ kind: 'busy' });
    expect(await answers(500)).toEqual({ kind: 'unreachable' });
    expect(
      await buildPlan(async () => {
        throw new TypeError('fetch failed');
      }, SHEET),
    ).toEqual({ kind: 'unreachable' });
  });
});

describe('a number as a person types one', () => {
  it('reads the English and the Portuguese way of writing it, whatever the language of the page', () => {
    for (const [typed, means] of [
      ['40000', 40000],
      ['$40,000', 40000],
      ['40.000', 40000],
      ['US$ 40.000', 40000],
      ['US$\u00a040.000', 40000],
      ['1,500.50', 1500.5],
      ['1.500,50', 1500.5],
      ['1,000,000', 1_000_000],
      ['1.000.000', 1_000_000],
      ['9.99', 9.99],
      ['9,99', 9.99],
      ['1500,5', 1500.5],
      ['10', 10],
    ] as const)
      expect(parseNumber(typed), typed).toBe(means);
  });

  it('is null for nothing typed', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('  $ ')).toBeNull();
  });

  it('is not a number when it is not one, or can be read two ways', () => {
    for (const text of [
      'forty',
      '40k',
      '-5',
      '1e9',
      '4 0 0 x',
      // three digits after the mark and a zero before it: half a dollar, or five hundred
      '0.500',
      '1.5000',
      '1,50,000',
      '1.500.50',
      '1,500,50',
      '40,',
      ',5',
      '1..5',
    ])
      expect(parseNumber(text), text).toBeNaN();
  });

  it('means the same amount before and after the page changes language', () => {
    // typed in English, read on a Portuguese page, and the other way round
    for (const typed of ['40,000', '40.000', '1,500.50', '1.500,50'])
      expect(
        checkSheet({ ...FIELDS, amount: typed, language: 'pt' }, 'solana').sheet?.amountUsd,
        typed,
      ).toBe(checkSheet({ ...FIELDS, amount: typed, language: 'en' }, 'solana').sheet?.amountUsd);
    expect(checkSheet({ ...FIELDS, amount: '40,000' }, 'solana').sheet?.amountUsd).toBe(40000);
    expect(goalSentence({ ...FIELDS, amount: '40,000' }, dictionary('pt'), 'pt')).toMatch(
      /US\$\s40\.000/,
    );
  });
});

describe('the limits, checked against the shared schema', () => {
  it('hands on the parsed sheet, on the chain of the wallet, when everything fits', () => {
    const { errors, sheet } = checkSheet(FIELDS, 'robinhood');
    expect(errors).toEqual({});
    expect(sheet).toEqual({
      basketType: 'standard',
      goal: 'grow',
      amountUsd: 40000,
      horizonMonths: 36,
      risk: 'medium',
      themes: [],
      country: 'BR',
      chains: ['robinhood'],
      rules: { useHoldings: true, glide: true },
      language: 'en',
    });
    expect(BasketSheet.parse(sheet)).toEqual(sheet);
  });

  it('parses nothing without a chain: the chain is the wallet’s, and there is none yet', () => {
    expect(checkSheet(FIELDS, null)).toEqual({ errors: {}, sheet: null });
  });

  it('says what does not fit, field by field, and parses nothing', () => {
    const wrong = (over: Partial<SheetFields>) => checkSheet({ ...FIELDS, ...over }, 'solana');
    expect(wrong({ amount: '' })).toEqual({ errors: { amount: 'amountEmpty' }, sheet: null });
    expect(wrong({ amount: 'forty' }).errors).toEqual({ amount: 'amountNumber' });
    expect(wrong({ amount: '9.99' }).errors).toEqual({ amount: 'amountLow' });
    expect(wrong({ amount: '1,000,001' }).errors).toEqual({ amount: 'amountHigh' });
    expect(wrong({ goal: '' }).errors).toEqual({ goal: 'goal' });
    expect(wrong({ risk: '' }).errors).toEqual({ risk: 'risk' });
    expect(wrong({ country: '' }).errors).toEqual({ country: 'country' });
    for (const horizon of ['', '0', '481', '12.5', 'three years'])
      expect(wrong({ horizon }).errors, horizon).toEqual({ horizon: 'horizon' });
    expect(wrong({ goal: '', amount: '', horizon: '', risk: '', country: '' }).errors).toEqual({
      goal: 'goal',
      amount: 'amountEmpty',
      horizon: 'horizon',
      risk: 'risk',
      country: 'country',
    });
  });

  it('holds the limits to the bounds of the schema itself', () => {
    const fits = (over: Partial<SheetFields>) =>
      checkSheet({ ...FIELDS, ...over }, 'solana').sheet !== null;
    expect([fits({ amount: '10' }), fits({ amount: '1,000,000' })]).toEqual([true, true]);
    expect([fits({ horizon: '1' }), fits({ horizon: '480' })]).toEqual([true, true]);
    expect(BasketSheet.shape.amountUsd.safeParse(9.99).success).toBe(false);
    expect(BasketSheet.shape.amountUsd.safeParse(1_000_000.01).success).toBe(false);
    expect(BasketSheet.shape.horizonMonths.safeParse(481).success).toBe(false);
  });

  it('reads a monthly income only for an income goal, and takes it or leaves it', () => {
    const income = { ...FIELDS, goal: 'income' as const };
    expect(checkSheet({ ...income, income: '1,500' }, 'solana').sheet).toMatchObject({
      goal: 'income',
      incomeTargetUsdMonthly: 1500,
    });
    // left empty, the sheet fits and carries no figure
    const noFigure = checkSheet(income, 'solana').sheet;
    expect(noFigure).toMatchObject({ goal: 'income' });
    expect(noFigure && 'incomeTargetUsdMonthly' in noFigure).toBe(false);
    expect(checkSheet({ ...income, income: 'a lot' }, 'solana').errors).toEqual({
      income: 'income',
    });
    expect(checkSheet({ ...income, income: '0' }, 'solana').errors).toEqual({
      income: 'income',
    });
    // typed for another goal, it is not on the sheet
    const grown = checkSheet({ ...FIELDS, income: '1,500' }, 'solana').sheet;
    expect(grown && 'incomeTargetUsdMonthly' in grown).toBe(false);
  });

  it('carries the two rules and the language of the explanations', () => {
    expect(
      checkSheet({ ...FIELDS, holdings: 'no', glide: 'no', language: 'pt' }, 'solana').sheet,
    ).toMatchObject({ rules: { useHoldings: false, glide: false }, language: 'pt' });
  });
});

describe('the limits as the sheet draws them', () => {
  const en = dictionary('en');
  const pt = dictionary('pt');
  const drawn = (fields: SheetFields, said = en) =>
    sheetGroups(fields, FIELDS, checkSheet(fields, 'solana').errors, en, said, 'en');
  const every = (fields: SheetFields, said = en) => {
    const { groups, amount } = drawn(fields, said);
    return [...groups.flatMap((g) => g.fields), amount];
  };

  it('has no field for the chain: it is the wallet’s', () => {
    const labels = every(FIELDS).map((f) => f.label.toLowerCase());
    expect(labels.some((label) => /chain|network|rede/.test(label))).toBe(false);
    expect(every(FIELDS).some((f) => /chain/i.test(f.schemaKey ?? ''))).toBe(false);
    expect(Object.keys(FIELD_ID)).not.toContain('chain');
  });

  it('labels every field in words, with its schema key for developers only', () => {
    for (const field of every({ ...FIELDS, goal: 'income' })) {
      expect(field.label, field.id).not.toMatch(/[A-Z][a-z]+[A-Z]|_/);
      expect(field.schemaKey, field.id).toBeTruthy();
      expect(fieldOfId(field.id)).toBeDefined();
      if (field.options)
        for (const option of field.options) expect(option.label).not.toMatch(/_|^[a-z]{2}$/);
    }
  });

  it('shows the monthly income only for an income goal, and says an income plan holds no stock tokens', () => {
    expect(every(FIELDS).map((f) => f.id)).not.toContain(FIELD_ID.income);
    const income = every({ ...FIELDS, goal: 'income' });
    expect(income.map((f) => f.id)).toContain(FIELD_ID.income);
    expect(income.find((f) => f.id === FIELD_ID.goal)?.caption).toBe(en.goal.captions.income);
    expect(every({ ...FIELDS, goal: 'protect' }).find((f) => f.id === FIELD_ID.goal)?.caption).toBe(
      en.goal.captions.protect,
    );
  });

  it('marks what the person changed after the reading', () => {
    const edited = every({ ...FIELDS, horizon: '48' }).filter((f) => f.edited);
    expect(edited.map((f) => f.id)).toEqual([FIELD_ID.horizon]);
  });

  it('says what does not fit in the language of the sheet, never in the validator’s words', () => {
    const fields = { ...FIELDS, amount: '', horizon: '0' };
    const inEnglish = every(fields).filter((f) => f.error);
    expect(inEnglish.map((f) => f.error)).toEqual([
      en.goal.errors.horizon,
      en.goal.errors.amountEmpty,
    ]);
    const inPortuguese = every(fields, pt).filter((f) => f.error);
    expect(inPortuguese.map((f) => f.error)).toEqual([
      pt.goal.errors.horizon,
      pt.goal.errors.amountEmpty,
    ]);
    for (const field of [...inEnglish, ...inPortuguese])
      expect(field.error).not.toMatch(/expected|received|invalid|too_small|NaN/i);
  });

  it('offers every country by name, in the language of the page', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
    const inEnglish = countryOptions('en');
    const inPortuguese = countryOptions('pt-BR');
    expect(inEnglish.find((c) => c.value === 'BR')?.label).toBe('Brazil');
    expect(inPortuguese.find((c) => c.value === 'BR')?.label).toBe('Brasil');
    expect(inPortuguese.find((c) => c.value === 'US')?.label).toBe('Estados Unidos');
    // a name, never the code itself
    for (const option of inEnglish) expect(option.label, option.value).not.toBe(option.value);
    expect(inEnglish.map((c) => c.label)).toEqual(
      [...inEnglish.map((c) => c.label)].sort((a, b) => a.localeCompare(b, 'en')),
    );
  });
});

describe('the goal as one sentence', () => {
  const en = dictionary('en');
  const pt = dictionary('pt');

  it('is made of the goal, the amount and the time frame, in the language of the page', () => {
    expect(goalSentence(FIELDS, en, 'en')).toBe('Grow $40,000 over 36 months.');
    expect(goalSentence({ ...FIELDS, goal: 'protect', horizon: '1' }, en, 'en')).toBe(
      'Protect $40,000 for 1 month.',
    );
    expect(goalSentence({ ...FIELDS, amount: '40.000' }, pt, 'pt')).toMatch(
      /^Fazer US\$\s40\.000 crescer em 36 meses\.$/,
    );
    expect(dollars(1500.5, 'en')).toBe('$1,500.5');
  });

  it('is not made while any of the three cannot be read', () => {
    for (const over of [{ goal: '' as const }, { amount: '' }, { amount: 'x' }, { horizon: '' }])
      expect(goalSentence({ ...FIELDS, ...over }, en, 'en')).toBeNull();
  });
});

describe('what the screen keeps in the tab', () => {
  const stored = {
    text: 'Grow $40,000 by June 2028',
    sheet: {
      goalText: 'Grow $40,000 by June 2028',
      source: { method: 'rules', fetchedAt: '2026-10-04T12:00:00.000Z', provenance: 'live' },
      firstReader: true,
      read: fieldsOfDraft(draftFromFirstReader(READ_IN_DOLLARS) as BasketSheetDraft, 'en'),
      fields: FIELDS,
    },
  };

  it('reads back what it stored', () => {
    expect(restoreGoal(JSON.stringify(stored))).toEqual(stored);
    expect(restoreGoal(JSON.stringify({ text: 'half a sentence', sheet: null }))).toEqual({
      text: 'half a sentence',
      sheet: null,
    });
  });

  it('drops anything that is not in that form, whole', () => {
    const broken = (over: object) => JSON.stringify({ ...stored, ...over });
    for (const raw of [
      null,
      '',
      '{',
      '"text"',
      JSON.stringify({ sheet: null }),
      broken({ text: 'x'.repeat(2001) }),
      broken({ sheet: 'a sheet' }),
      broken({ sheet: { ...stored.sheet, fields: { ...FIELDS, goal: 'gamble' } } }),
      broken({ sheet: { ...stored.sheet, fields: { ...FIELDS, country: 'Atlantis' } } }),
      broken({ sheet: { ...stored.sheet, read: {} } }),
      broken({
        sheet: { ...stored.sheet, source: { ...stored.sheet.source, provenance: 'mock' } },
      }),
      broken({ sheet: { ...stored.sheet, firstReader: 'yes' } }),
    ])
      expect(restoreGoal(raw), String(raw).slice(0, 60)).toBeNull();
  });

  it('starts the reading’s fields from what was read, with the two rules on', () => {
    expect(stored.sheet.read).toEqual({
      goal: 'grow',
      amount: '',
      income: '',
      horizon: '',
      risk: 'medium',
      country: '',
      holdings: 'yes',
      glide: 'yes',
      language: 'en',
    });
  });
});
