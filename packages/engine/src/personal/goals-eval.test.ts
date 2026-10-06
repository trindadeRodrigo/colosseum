import { BasketSheetDraft } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { draftFromRules } from './draft';
import evalSet from './fixtures/goals-eval.json';
import { launchShelf } from './testing';

// The 12-goal evaluation set for the sentence parser (DESIGN-VAULT section 7): goal sentences in
// English and Portuguese, each with the draft of the sheet it should parse to. It is the measure for
// whatever reads the sentence. Here it is run against the structurer's rules parser, which is the
// fallback when no model answers. The model path is not called.
//
// The second half records what the rules parser gets right today. It is a record, not a target: the
// parser was written for goals in reais, and it is not changed here. When the parser changes, this
// record changes with it, in the same commit.

type Goal = { id: string; text: string; expect: Record<string, unknown> };
const goals = evalSet.goals as Goal[];
const FIELDS = Object.keys(BasketSheetDraft.shape);

/** The fields of the draft that the rules parser did not read as the set expects. */
function misses(goal: Goal): string[] {
  const { draft } = draftFromRules(goal.text, evalSet.nowMonth);
  const got = draft as Record<string, unknown>;
  return FIELDS.filter((key) => JSON.stringify(got[key]) !== JSON.stringify(goal.expect[key]));
}

describe('the 12-goal evaluation set', () => {
  it('holds twelve goals, six in each language, each with a whole draft', () => {
    expect(goals).toHaveLength(12);
    expect(new Set(goals.map((g) => g.id)).size).toBe(12);
    expect(goals.filter((g) => g.expect.language === 'en')).toHaveLength(6);
    expect(goals.filter((g) => g.expect.language === 'pt')).toHaveLength(6);
    for (const g of goals) {
      expect(BasketSheetDraft.safeParse(g.expect).success, g.id).toBe(true);
      expect(Object.keys(g.expect).sort(), g.id).toEqual([...FIELDS].sort());
      expect(g.id.slice(0, 2), g.id).toBe(g.expect.language);
    }
  });

  it('covers every kind of goal, an income target, a negation, and a named portfolio, chain and country', () => {
    const said = (key: string) => goals.map((g) => g.expect[key]);
    expect(new Set(said('goal'))).toEqual(new Set(['grow', 'income', 'protect']));
    expect(new Set(said('risk'))).toEqual(new Set(['low', 'medium', 'high', null]));
    expect(said('incomeTargetUsdMonthly').filter((x) => x !== null)).toHaveLength(2);
    expect(goals.filter((g) => /no stocks|sem ações/.test(g.text))).toHaveLength(2);
    const slugs = launchShelf().families.map((f) => f.meta.slug);
    for (const themes of said('themes'))
      for (const slug of (themes as string[] | null) ?? []) expect(slugs).toContain(slug);
    expect(said('themes').filter((x) => x !== null)).toHaveLength(2);
    expect(said('chains').filter((x) => x !== null)).toHaveLength(2);
    expect(said('country').filter((x) => x !== null)).toHaveLength(2);
    // The amount and the time frame are in every sentence: a parser must find them in the text.
    for (const g of goals) {
      expect(g.expect.amountUsd, g.id).toEqual(expect.any(Number));
      expect(g.expect.horizonMonths, g.id).toEqual(expect.any(Number));
    }
  });
});

describe('the rules parser on the evaluation set, as it is today', () => {
  it('reads the draft through the rules path only, and never guesses an amount in dollars', () => {
    for (const g of goals) {
      const { draft, outcome } = draftFromRules(g.text, evalSet.nowMonth);
      expect(outcome.method, g.id).toBe('rules');
      expect(BasketSheetDraft.safeParse(draft).success, g.id).toBe(true);
      expect(draft.amountUsd, g.id).toBeNull();
      expect(draft.incomeTargetUsdMonthly, g.id).toBeNull();
    }
  });

  it('gets 0 of the 12 goals wholly right: what it misses, goal by goal', () => {
    const missed = Object.fromEntries(goals.map((g) => [g.id, misses(g)]));
    expect(missed).toEqual({
      'en-grow-10y-high': ['amountUsd', 'horizonMonths', 'currency'],
      'en-protect-18m-low': ['goal', 'amountUsd', 'currency'],
      'en-income-300-month': [
        'amountUsd',
        'horizonMonths',
        'risk',
        'incomeTargetUsdMonthly',
        'currency',
      ],
      'en-grow-by-2031-theme-chain': ['amountUsd', 'risk', 'themes', 'chains', 'currency'],
      'en-protect-country-no-stocks': [
        'goal',
        'amountUsd',
        'horizonMonths',
        'risk',
        'country',
        'currency',
      ],
      'en-grow-6m-conservative': ['amountUsd', 'horizonMonths', 'currency'],
      'pt-grow-10y-high': ['amountUsd', 'risk', 'currency'],
      'pt-protect-18m-low': ['goal', 'amountUsd', 'risk', 'currency'],
      'pt-income-300-month': [
        'amountUsd',
        'horizonMonths',
        'risk',
        'incomeTargetUsdMonthly',
        'currency',
      ],
      'pt-grow-by-2031-theme-chain': [
        'amountUsd',
        'risk',
        'themes',
        'chains',
        'language',
        'currency',
      ],
      'pt-protect-country-no-stocks': [
        'goal',
        'amountUsd',
        'horizonMonths',
        'risk',
        'country',
        'currency',
      ],
      'pt-grow-6m-conservative': ['amountUsd', 'horizonMonths', 'currency'],
    });
    expect(Object.values(missed).filter((fields) => fields.length === 0)).toHaveLength(0);
  });

  it('field by field: how many of the 12 it reads as the set expects', () => {
    const right = Object.fromEntries(
      FIELDS.map((key) => [key, goals.filter((g) => !misses(g).includes(key)).length]),
    );
    expect(right).toEqual({
      basketType: 12,
      goal: 8,
      amountUsd: 0,
      horizonMonths: 5,
      risk: 4,
      themes: 10,
      country: 10,
      chains: 10,
      incomeTargetUsdMonthly: 10,
      rules: 12,
      language: 11,
      // The rules parser reads every amount as reais and says nothing of the goal's currency; the model
      // is to read it (GUIDED-INTAKE). It says nothing of withdrawals, sleeves or the restore choice,
      // and none of the twelve does either.
      currency: 0,
      obligations: 12,
      sleeves: 12,
      restoreSplit: 12,
    });
  });
});
