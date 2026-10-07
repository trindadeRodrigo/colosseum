import { describe, expect, it } from 'vitest';
import evalSet from './fixtures/goals-eval.json';
import {
  conversationText,
  type IntakeAnswers,
  type IntakeInput,
  riskForMixEstimate,
  runIntake,
  type ShelfPortfolio,
} from './intake';
import {
  amountInText,
  type Market,
  marketMentionsIn,
  marketShareIn,
  marketsIn,
  mixIn,
  mixSaidIn,
  refusalsIn,
  refusalsSaidIn,
  riskCuesIn,
  risksRuledOutIn,
  shareSaidIn,
  splitIn,
  timeFramesIn,
  yesOrNoSaidIn,
} from './intake-text';
import {
  attributeKey,
  type FilterMatch,
  type MarketFilter,
  type ShelfLabel,
} from './market-filter';
import { PERSONAL_PARAMS } from './params';
import { launchShelf } from './testing';
import type { PersonalMix, PersonalSheet } from './types';

// The independent review of Oct 6 (gates COUNTRY-REMOVED and EXPLICIT-MIX), the findings on the
// intake: 1 (it read the opposite of what was written), 4 (an answered risk was replaced without a
// word), 6 (a stated holding the text check could not read fell through to the risk question) and 9
// (the model could pick a portfolio), with the two that came with them: a time frame is said back the
// way the person said it, and a share said in words on a later turn is read as the answer it is. And
// the one the playground found after them: with no model, a refusal the text writes was lost.
//
// Every sentence of the review's lists is a case here, with the reading it must have. The principle:
// a holding is taken from the text only where its clause states it as what the person wants held. A
// clause that rules it out, hedges it, asks it or says it of something else is not taken; where the
// person may still mean a holding it is asked once; nothing is ever built from the opposite.
//
// The model's replies are MOCK, written by hand in the shape the API asks the model for. Each case is
// read three ways: by a faithful reader, by one that errs toward the very misreading the review
// found, and with no model at all. The labels and the attributes are MOCK too. No test reaches a
// network.

const NOW = evalSet.nowMonth;
const portfolios: ShelfPortfolio[] = launchShelf().families.map((f) => ({
  slug: f.meta.slug,
  name: f.meta.name,
}));
const LABELS: ShelfLabel[] = [
  { slug: 'ai', name: { en: 'AI', pt: 'IA' }, status: 'confirmed', listed: 9 },
  {
    slug: 'semiconductors',
    name: { en: 'Semiconductors', pt: 'Semicondutores' },
    status: 'confirmed',
    listed: 6,
  },
];
const ATTRIBUTES: Record<string, FilterMatch> = {
  'industry:aerospace-defense': { value: 'Aerospace & Defense', listed: 4 },
};
const matchOf = (filter: MarketFilter): FilterMatch | null =>
  ATTRIBUTES[`${filter.by}:${attributeKey(filter.value)}`] ?? null;

const reply = (over: Record<string, unknown> = {}) => ({
  goal: 'grow',
  amountUsd: 5000,
  incomeTargetUsdMonthly: null,
  horizonMonths: 60,
  risk: 'medium',
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
const intake = (text: string, r: unknown = reply(), over: Partial<IntakeInput> = {}) =>
  runIntake({
    text,
    nowMonth: NOW,
    reply: r,
    homeChain: 'solana',
    portfolios,
    labels: LABELS,
    matchOf,
    ...over,
  });
const fields = (r: { questions: { field: string }[] }) => r.questions.map((q) => q.field);
const pct = (growthPct: number, cashPct: number, dollarYieldPct = 0, goldPct = 0) => ({
  growthPct,
  dollarYieldPct,
  goldPct,
  cashPct,
  creditPct: null,
});
const bps = (growthBps: number, cashBps: number, dollarYieldBps = 0, goldBps = 0) => ({
  growthBps,
  dollarYieldBps,
  goldBps,
  cashBps,
});
const ALL_STOCKS = bps(10_000, 0);
const theme = (slug: string, shareBps = 10_000) => ({
  kind: 'theme' as const,
  theme: slug,
  shareBps,
});
const safe = (shareBps: number) => ({ kind: 'safe_yield' as const, shareBps });

/**
 * With no model a holding the text states is asked once, with its reading as the form's start, and
 * never taken (the second review, Oct 7). `asked` is the turn that asks it, `question` what it asks,
 * and `done` the turn after the person confirms that reading on the form.
 */
const confirmed = (text: string, answers: IntakeAnswers = {}, over: Partial<IntakeInput> = {}) => {
  const asked = intake(text, null, { ...over, answers });
  const question = asked.questions.find((q) => q.field === 'mix');
  const done = intake(text, null, {
    ...over,
    answers: { ...answers, mix: question?.read as PersonalMix },
  });
  return { asked, question, done };
};

// The goal the review's scripts put before each sentence.
const LEAD = 'I want to grow $5,000 over 5 years at medium risk. ';
// What the rules parser reads is put to the person once: with no model these are answered here.
const ANSWERED: IntakeAnswers = { goal: 'grow', amountUsd: 5000, horizonMonths: 60 };

describe('finding 1: nothing is built from the opposite of what is written', () => {
  it('the shelf used here holds what the misreadings would have built on', () => {
    expect(portfolios.map((p) => p.slug)).toEqual(expect.arrayContaining(['the-seven', 'the-500']));
  });

  it('"I am retired so no stocks please" is a refusal: English "so" is not Portuguese "só"', () => {
    const text =
      'I want to grow $20,000 for 3 years at low risk. I am retired so no stocks please.';
    expect(mixIn(text)).toBeNull();
    expect(mixSaidIn(text)).toBeNull();
    // A faithful reader: the refusal, the risk as said, and no mix. The rules parser reads the risk
    // another way, so the person confirms it: nothing else is asked.
    const faithful = reply({
      amountUsd: 20_000,
      horizonMonths: 36,
      risk: 'low',
      cannotHold: ['stock'],
    });
    const asked = intake(text, faithful);
    expect(asked.mix).toBeNull();
    expect(fields(asked)).toEqual(['risk']);
    expect(asked.limits.cannotHoldClasses).toEqual(['etf', 'stock']);
    const done = intake(text, faithful, { answers: { risk: 'low' } });
    expect(done.questions).toEqual([]);
    const sheet = done.sheet as PersonalSheet;
    expect(sheet.risk).toBe('low');
    expect(sheet.mix).toBeUndefined();
    expect(sheet.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    const said = done.readBack ?? [];
    expect(said).toContain('You left out stocks and stock funds.');
    expect(said[0]).toBe('You set a goal to grow with $20,000 over 3 years, at low risk.');
    // What the review saw said back: none of it.
    expect(said.join(' ')).not.toMatch(/of the plan in stocks|limits for high risk|so no stocks/);
    // A reader that errs and answers "all in stocks": never taken. It is asked once, and the form
    // does not open on the stocks the text refuses.
    const erring = intake(text, { ...faithful, mix: pct(100, 0) });
    expect(erring.mix).toBeNull();
    expect(erring.sheet).toBeNull();
    expect(erring.flags).toEqual(expect.arrayContaining(['no_cue:mix', 'mix_asked:model']));
    const ask = erring.questions.find((q) => q.field === 'mix');
    expect(ask?.template).toBe('mix');
    expect(ask?.read).toBeUndefined();
    // With no model: no mix either.
    const rules = intake(text, null);
    expect(rules.mix).toBeNull();
    expect(fields(rules)).not.toContain('mix');
    expect(rules.flags.filter((f) => /mix/.test(f))).toEqual([]);
    // And the refusal is not lost with it: read by code, carried to the sheet and said back (the
    // cases below hold the rule).
    const answered = intake(text, null, {
      answers: { goal: 'grow', amountUsd: 20_000, horizonMonths: 36, risk: 'low' },
    });
    expect(answered.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(answered.readBack).toContain('You left out stocks and stock funds.');
  });

  it('"so" before an English word is "so"; before a Portuguese one, with no accent, it is "só"', () => {
    for (const text of [
      'I am young so stocks are fine',
      'I have bills so cash matters',
      'so stocks',
      'so no stocks please',
      'so gold is out',
    ]) {
      expect(mixIn(text), text).toBeNull();
      expect(mixSaidIn(text), text).toBeNull();
    }
    for (const text of ['só ações', 'so acoes', 'quero só ações', 'so quero ações', 'só em ações'])
      expect(mixIn(text)?.mix, text).toEqual(ALL_STOCKS);
    // And "so" that starts a clause which does state a holding leaves it stated.
    for (const text of ['I am young so all in stocks', "I'm not rich, so put it all in stocks"])
      expect(mixIn(text)?.mix, text).toEqual(ALL_STOCKS);
  });

  // The review's list of mixes read as the opposite, each with how its clause says the mix, and the
  // misreading a reader that errs would send. `none`: the text writes no mix at all.
  const MIXES: [string, 'none' | 'negated' | 'wondered', ReturnType<typeof pct>][] = [
    ['I am young so stocks are fine for me.', 'none', pct(100, 0)],
    ['I have bills so cash matters to me.', 'none', pct(0, 100)],
    ["I wouldn't put all of it in stocks.", 'negated', pct(100, 0)],
    ["I can't have everything in crypto.", 'negated', pct(100, 0)],
    ['I want more than just stocks.', 'negated', pct(100, 0)],
    ['I cannot be all in stocks.', 'negated', pct(100, 0)],
    ["It's not a good idea to put everything in crypto.", 'negated', pct(100, 0)],
    ["I don't think I should put all of it in stocks.", 'negated', pct(100, 0)],
    ['I would rather avoid being all in stocks.', 'negated', pct(100, 0)],
    ['Putting everything in gold is too risky for me.', 'negated', pct(0, 0, 0, 100)],
    ['Should I put all of it in stocks?', 'wondered', pct(100, 0)],
    ['I want to diversify beyond just stocks.', 'negated', pct(100, 0)],
    ['instead of only stocks I want a balance.', 'negated', pct(100, 0)],
    ['I just cash out every December.', 'none', pct(0, 100)],
  ];

  it('reads how the clause of each sentence of the review says the mix, and takes none of them', () => {
    for (const [sentence, stance] of MIXES) {
      // Alone, and with a goal written before it.
      expect(mixIn(sentence), sentence).toBeNull();
      expect(mixIn(LEAD + sentence), sentence).toBeNull();
      expect(mixSaidIn(sentence)?.stance ?? 'none', sentence).toBe(stance);
      expect(mixSaidIn(LEAD + sentence)?.stance ?? 'none', sentence).toBe(stance);
    }
  });

  it('builds no mix from any of them: with a faithful reader, with one that errs, and with no model', () => {
    for (const [sentence, stance, misread] of MIXES) {
      const text = LEAD + sentence;
      // A faithful reader sends no mix. The risk is the person's (the rules parser reads "stocks" as
      // high risk in some of these, so it is confirmed here): the sheet is the goal's alone.
      const faithful = intake(text, reply(), { answers: { risk: 'medium' } });
      expect(faithful.mix, sentence).toBeNull();
      expect(
        faithful.flags.filter((f) => /^mix_from|^risk_from/.test(f)),
        sentence,
      ).toEqual([]);
      // A reader that errs sends the opposite as a mix: never held.
      const erring = intake(text, reply({ mix: misread }), { answers: { risk: 'medium' } });
      expect(erring.mix, sentence).toBeNull();
      expect(erring.sheet?.mix, sentence).toBeUndefined();
      const rules = intake(text, null, { answers: { ...ANSWERED, risk: 'medium' } });
      expect(rules.mix, sentence).toBeNull();
      if (stance === 'wondered') {
        // The person may mean it: asked once, with the reading as the form's start, never taken.
        for (const result of [faithful, erring, rules]) {
          expect(fields(result), sentence).toEqual(['mix']);
          expect(result.questions[0], sentence).toMatchObject({
            template: 'mix',
            read: ALL_STOCKS,
          });
          expect(result.flags, sentence).toContain('mix_asked:wondered');
          expect(result.sheet, sentence).toBeNull();
        }
        continue;
      }
      // Ruled out, or not a mix at all: nothing is asked of it, and the sheet holds no mix.
      for (const result of [faithful, rules]) {
        expect(result.questions, sentence).toEqual([]);
        expect(result.sheet, sentence).toMatchObject({ risk: 'medium', themes: [] });
        expect(result.sheet?.mix, sentence).toBeUndefined();
        expect((result.readBack ?? []).join(' '), sentence).not.toMatch(
          /of the plan in|limits for|limites de/,
        );
      }
      if (stance === 'negated') {
        // The text rules out the very mix the model sent: dropped, flagged, and not asked.
        expect(erring.flags, sentence).toEqual(
          expect.arrayContaining(['mix_negated', 'no_cue:mix']),
        );
        expect(erring.questions, sentence).toEqual([]);
        expect(erring.sheet, sentence).toMatchObject({ risk: 'medium' });
      } else {
        // The text writes no mix and the model reads one: the checks cannot confirm it, so it is
        // asked (finding 6), never taken.
        expect(fields(erring), sentence).toEqual(['mix']);
        expect(erring.flags, sentence).toContain('mix_asked:model');
      }
    }
  });

  it('a mix the person only wonders about is asked once, and what they answer is what is held', () => {
    const text = `${LEAD}Should I put all of it in stocks?`;
    const asked = intake(text);
    expect(asked.questions).toEqual([
      {
        field: 'mix',
        template: 'mix',
        text: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
        read: ALL_STOCKS,
      },
    ]);
    const yes = intake(text, reply(), { answers: { mix: ALL_STOCKS } });
    expect(yes.questions).toEqual([]);
    expect(yes.sheet).toMatchObject({ risk: 'high', mix: ALL_STOCKS });
    // "No mix" is an answer too. The rules parser reads "all of it in stocks" as high risk where the
    // text says medium, so the risk is the person's to confirm, as for any such goal.
    expect(fields(intake(text, reply(), { answers: { mix: null } }))).toEqual(['risk']);
    const no = intake(text, reply(), { answers: { mix: null, risk: 'medium' } });
    expect(no.questions).toEqual([]);
    expect(no.sheet).toMatchObject({ risk: 'medium' });
    expect(no.sheet?.mix).toBeUndefined();
    // Other ways to hedge it, in both languages.
    for (const hedge of [
      'Maybe all in stocks.',
      'I could go all in on stocks.',
      'What about 70% stocks and 30% cash?',
      'Why not all in stocks.',
      'I am thinking of putting everything in crypto.',
      'Talvez tudo em ações.',
      'Será que coloco tudo em ações?',
    ]) {
      expect(mixSaidIn(hedge)?.stance, hedge).toBe('wondered');
      expect(mixIn(hedge), hedge).toBeNull();
      expect(fields(intake(LEAD + hedge)), hedge).toEqual(['mix']);
    }
    // A question the person answers themself in the next clause is answered: the answer is stated.
    const answered = 'Should I put all of it in stocks? No, 50% stocks and 50% cash';
    expect(mixIn(answered)?.mix).toEqual(bps(5000, 5000));
  });

  // The review's list of markets read against what was written: "any invest in <market> counts as
  // the whole", "markets have no negation check".
  const MARKETS: [string, Market, 'negated' | 'aside'][] = [
    ["I don't want to invest in big tech", 'big_tech', 'negated'],
    ['I am already heavily invested in US stocks and want something else', 'us_market', 'aside'],
    ['I would never invest in big tech', 'big_tech', 'negated'],
    ['não quero investir em IA', 'ai', 'negated'],
    ['I already invest in the S&P 500 through my pension', 'us_market', 'aside'],
    ['Not big tech', 'big_tech', 'negated'],
    ['no AI please', 'ai', 'negated'],
    ['anything but AI', 'ai', 'negated'],
    ['avoid big tech', 'big_tech', 'negated'],
    ['sem big tech', 'big_tech', 'negated'],
  ];

  it('reads each market of the review as written: ruled out, or said of what the person holds elsewhere', () => {
    for (const [sentence, market, skipped] of MARKETS) {
      expect(
        marketMentionsIn(sentence).map((m) => [m.market, m.skipped]),
        sentence,
      ).toEqual([[market, skipped]]);
      expect(marketsIn(sentence), sentence).toEqual([]);
      expect(marketsIn(LEAD + sentence), sentence).toEqual([]);
    }
  });

  it('holds none of them and asks nothing of them, on a shelf that has The Seven, The 500 and the AI label', () => {
    for (const [sentence, market, skipped] of MARKETS) {
      const text = `${LEAD}${sentence}.`;
      const faithful = intake(text, reply(), { answers: { risk: 'medium' } });
      // A reader that errs names the market the text rules out.
      const erring = intake(text, reply({ markets: [market] }), { answers: { risk: 'medium' } });
      const rules = intake(text, null, { answers: { ...ANSWERED, risk: 'medium' } });
      for (const result of [faithful, erring, rules]) {
        expect(result.narratives, sentence).toEqual([]);
        expect(result.mix, sentence).toBeNull();
        expect(result.draft.themes, sentence).toBeNull();
        expect(result.draft.sleeves, sentence).toBeNull();
        // Neither the market's share ("How much of the $5,000 for big tech?") nor anything else.
        expect(result.questions, sentence).toEqual([]);
        expect(result.sheet, sentence).toMatchObject({ risk: 'medium', themes: [] });
        expect(result.sheet?.mix, sentence).toBeUndefined();
        expect(result.sheet?.sleeves, sentence).toBeUndefined();
        expect((result.readBack ?? []).join(' '), sentence).not.toMatch(
          /starts from|of the plan|limits for|parte de|do plano/,
        );
        expect(
          result.flags.filter((f) => /mix_from|share_unclear|sleeves_from|no_cue:market/.test(f)),
          sentence,
        ).toEqual([]);
      }
      // What the model named and the text does not ask for is flagged by why, never asked.
      expect(erring.flags, sentence).toContain(`market_${skipped}:${market}`);
      expect(
        faithful.flags.filter((f) => f.startsWith('market_')),
        sentence,
      ).toEqual([]);
    }
  });

  it('what a clause says of someone else, or of another time, is not the person asking for it', () => {
    for (const text of [
      'My brother is all in crypto',
      'My friends went all in on crypto',
      'I was all in stocks before',
      'I used to be all in crypto',
      'I already have everything in stocks at my broker',
      'Meu irmão tem tudo em ações',
    ]) {
      expect(mixIn(text), text).toBeNull();
      expect(mixSaidIn(text)?.stance, text).toBe('aside');
      const result = intake(`${LEAD}${text}.`, reply(), { answers: { risk: 'medium' } });
      expect(result.mix, text).toBeNull();
      expect(fields(result), text).not.toContain('mix');
    }
    for (const text of [
      'Everyone invests in big tech',
      'My friends are all in on AI',
      'I used to invest in big tech',
      'They say big tech is the future',
    ]) {
      expect(marketsIn(text), text).toEqual([]);
      const result = intake(`${LEAD}${text}.`, reply(), { answers: { risk: 'medium' } });
      expect(result.narratives, text).toEqual([]);
      expect(result.mix, text).toBeNull();
      expect(result.questions, text).toEqual([]);
    }
    // With "I" or "we" in it the clause is the person's own again.
    expect(mixIn('My wife and I want all of it in stocks')?.mix).toEqual(ALL_STOCKS);
    expect(marketsIn('My wife and I want to invest in big tech').map((m) => m.market)).toEqual([
      'big_tech',
    ]);
  });

  it('what a clause does state is still taken: a negation, a hedge or an aside stops at its own clause', () => {
    for (const text of [
      'I want all of it in stocks',
      'Put everything in crypto',
      'only stocks',
      "I don't like bonds and want everything in stocks",
      'No crypto, all of it in stocks',
      'not sure about bonds, but all of it in stocks',
      'I do not want bonds. Stocks only.',
      'I have no doubt: all of it in stocks',
      "I can't wait to put all of it in stocks",
      'nothing but stocks',
      'Não quero títulos, quero tudo em ações',
    ])
      expect(mixIn(text)?.mix, text).toEqual(ALL_STOCKS);
    const asked = (text: string) =>
      marketMentionsIn(text)
        .filter((m) => m.skipped === null)
        .map((m) => m.market);
    expect(asked("I don't want bonds, I want big tech")).toEqual(['big_tech']);
    expect(asked('no stocks, invest in AI')).toEqual(['ai']);
    expect(asked('not only AI')).toEqual(['ai']);
    expect(asked('I like AI but not big tech')).toEqual(['ai']);
    expect(asked('invest in AI, not big tech')).toEqual(['ai']);
    // A list under one negation is ruled out item by item; a list that is asked is asked item by item.
    expect(asked("I don't want to invest in big tech, AI or crypto stocks")).toEqual([]);
    expect(asked('big tech, AI or chips')).toEqual(['big_tech', 'ai', 'semiconductors']);
    // Through the intake: the stated holding is held, and the risk is never asked.
    const held = intake('I want to grow $5,000 over 5 years. No crypto, all of it in stocks.', {
      ...reply({ risk: null, mix: pct(100, 0), cannotHold: ['crypto'] }),
    });
    expect(held.questions).toEqual([]);
    expect(held.sheet).toMatchObject({ risk: 'high', mix: ALL_STOCKS });
    const market = intake(
      "I want to grow $5,000 over 5 years. I don't want bonds, invest in big tech.",
      {
        ...reply({ risk: null, markets: ['big_tech'] }),
      },
    );
    expect(market.questions).toEqual([]);
    expect(market.sheet).toMatchObject({ themes: ['the-seven'], mix: ALL_STOCKS });
  });

  it('"cash out", "cash flow" and "credit card" are no part of a mix', () => {
    for (const text of [
      'I just cash out every December',
      'only cash flow matters to me',
      'I pay everything in cash out of habit',
      'all in credit cards',
      'only credit card debt',
    ]) {
      expect(mixIn(text), text).toBeNull();
      expect(mixSaidIn(text), text).toBeNull();
    }
    expect(mixIn('all in cash')?.mix).toEqual(bps(0, 10_000));
    expect(mixIn('only credit')?.mix.creditBps).toBe(10_000);
  });
});

// Found by running the playground on this branch with no model: finding 1 stopped "so no stocks
// please" from becoming a plan all in stocks, and the person still got the stocks they refused. A
// refusal lowers what the plan may hold, so it is taken from the text where its clause states it,
// with or without a model, and said back for the person to confirm. It is taken, not asked.
describe('a refusal the text writes is never lost: it is taken from the text, with or without a model', () => {
  const GOAL = 'I want to grow $20,000 for 3 years at low risk. ';
  const ANSWERS: IntakeAnswers = {
    goal: 'grow',
    amountUsd: 20_000,
    horizonMonths: 36,
    risk: 'low',
  };
  // A reply as a model gives it for this goal; `cannotHold` and `noCredit` are what each case sets.
  const model = (over: Record<string, unknown> = {}) =>
    reply({ amountUsd: 20_000, horizonMonths: 36, risk: 'low', ...over });
  const NONE = { creditTolerance: null, cannotHoldClasses: null };
  /** What a refusal of these classes leaves out: the classes, and stock funds where stocks are refused. */
  const leftOutWith = (classes: readonly string[]): string[] =>
    [...new Set([...classes, ...(classes.includes('stock') ? ['etf'] : [])])].sort();

  it('the playground case: with no model, "I am retired so no stocks please" leaves stocks out, and the read-back says so', () => {
    const text = `${GOAL}I am retired so no stocks please.`;
    // Read before any answer, and not asked: what the rules reader read is asked, the refusal is not.
    const first = intake(text, null);
    expect(first.method).toBe('rules');
    expect(first.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['etf', 'stock'] });
    expect(fields(first)).toEqual(['goal', 'amountUsd', 'horizonMonths', 'risk']);
    // With the goal, the amount, the date and the risk answered: the sheet carries it.
    const done = intake(text, null, { answers: ANSWERS });
    expect(done.questions).toEqual([]);
    const sheet = done.sheet as PersonalSheet;
    expect(sheet.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(sheet.mix).toBeUndefined();
    expect(done.readBack).toEqual([
      'You set a goal to grow with $20,000 over 3 years, at low risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'You left out stocks and stock funds.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
    // It is the sheet a faithful model gives for the same words.
    const byModel = intake(text, model({ cannotHold: ['stock'] }), { answers: { risk: 'low' } });
    expect(byModel.sheet).toEqual(sheet);
    expect(byModel.flags.filter((f) => /cannotHold|refusal/.test(f))).toEqual([]);
  });

  it('"sem ações", "no credit" and their like are taken the same way, with no model', () => {
    const pt = intake(
      'Quero fazer US$ 20.000 crescer por 3 anos com risco baixo, sem ações.',
      null,
      {
        answers: ANSWERS,
        language: 'pt',
      },
    );
    expect(pt.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['etf', 'stock'] });
    expect(pt.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(pt.readBack).toContain('Você deixou de fora ações e fundos de ações.');
    const credit = intake(`${GOAL}No credit.`, null, { answers: ANSWERS });
    expect(credit.limits).toEqual({ creditTolerance: 'none', cannotHoldClasses: null });
    expect(credit.sheet?.limits).toEqual({ creditTolerance: 'none' });
    expect(credit.readBack).toContain('No tokens that lend to borrowers or trade a spread.');
    const semCredito = intake('Quero fazer US$ 20.000 crescer por 3 anos, sem crédito.', null, {
      answers: ANSWERS,
      language: 'pt',
    });
    expect(semCredito.sheet?.limits).toEqual({ creditTolerance: 'none' });
    expect(semCredito.readBack).toContain(
      'Nenhum token que empresta a tomadores ou opera um spread.',
    );
    // Several at once, each in its own words.
    const several = intake(`${GOAL}No stocks, no crypto and no lending.`, null, {
      answers: ANSWERS,
    });
    expect(several.sheet?.limits).toEqual({
      creditTolerance: 'none',
      cannotHold: { classes: ['crypto', 'etf', 'stock'] },
    });
    expect(several.readBack).toEqual(
      expect.arrayContaining([
        'You left out stocks, stock funds and crypto.',
        'No tokens that lend to borrowers or trade a spread.',
      ]),
    );
    for (const [words, limits] of [
      ['no stocks', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['without crypto', { cannotHold: { classes: ['crypto'] } }],
      ['zero stocks', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['avoid crypto', { cannotHold: { classes: ['crypto'] } }],
      ['no gold', { cannotHold: { classes: ['gold'] } }],
      ['no stocks or crypto', { cannotHold: { classes: ['crypto', 'etf', 'stock'] } }],
      ['no stocks at all', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['no stocks in my plan', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['no exposure to crypto', { cannotHold: { classes: ['crypto'] } }],
      ['avoid all stocks', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['não quero ações', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['não quero investir em ações', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['não quero nada de ações', { cannotHold: { classes: ['etf', 'stock'] } }],
      ['nada de cripto', { cannotHold: { classes: ['crypto'] } }],
      ['no lending', { creditTolerance: 'none' }],
      ['sem empréstimos', { creditTolerance: 'none' }],
    ] as const) {
      const result = intake(`${GOAL}Also: ${words}.`, null, { answers: ANSWERS });
      expect(result.sheet?.limits, words).toEqual(limits);
    }
    // A refusal stops at its own clause, and a negation before it in another clause leaves it stated.
    for (const sentence of [
      "I don't like risk and no stocks please.",
      "I'm not rich so no stocks.",
      'Not sure about bonds, but no stocks.',
      'Should I avoid stocks? Yes, no stocks.',
      'No stocks, right?',
      'My wife and I want no stocks.',
      'I want to have no stocks.',
    ]) {
      const result = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(result.sheet?.limits, sentence).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    }
    // A stated holding beside a refusal of another class is still held. With no model the holding
    // is asked once, its reading the start (Oct 7), and the refusal is taken either way.
    const both = confirmed('I want to grow $20,000 for 3 years. No crypto, all of it in stocks.', {
      goal: 'grow',
      amountUsd: 20_000,
      horizonMonths: 36,
    });
    expect(both.asked.sheet).toBeNull();
    expect(both.asked.limits.cannotHoldClasses).toEqual(['crypto']);
    expect(both.question).toMatchObject({ template: 'mix', read: ALL_STOCKS });
    expect(both.asked.flags).toContain('mix_asked:rules');
    expect(both.done.sheet).toMatchObject({
      limits: { cannotHold: { classes: ['crypto'] } },
      mix: ALL_STOCKS,
    });
  });

  // What the clause says of each. `negated`: the "no" is of another word, or the refusal is itself
  // negated. `aside`: said of what the person holds, of someone else, of another time, or of another
  // thing. `wondered`: a question or a maybe.
  const NOT_REFUSALS: [string, 'negated' | 'aside' | 'wondered'][] = [
    ['I have no problem with stocks.', 'negated'],
    ['No doubt about stocks.', 'negated'],
    ["I can't do without stocks.", 'negated'],
    ['Not without stocks.', 'negated'],
    ["I wouldn't say no to stocks.", 'negated'],
    ['No limit on stocks.', 'negated'],
    ['Não quero ficar sem ações.', 'negated'],
    ['Sem dúvida ações.', 'negated'],
    ['My brother holds no stocks.', 'aside'],
    ['They say no stocks.', 'aside'],
    ['I have no stocks yet.', 'aside'],
    ['I currently hold no stocks.', 'aside'],
    ['My portfolio has no stocks.', 'aside'],
    ['I used to avoid stocks.', 'aside'],
    ['No stock market crash scares me.', 'aside'],
    ['I want no more stocks.', 'aside'],
    // A refusal of a part of the class is no refusal of the class: a sheet leaves out a class.
    ['No tech stocks.', 'aside'],
    ['No meme stocks.', 'aside'],
    ['No stocks from China.', 'aside'],
    ['No stocks except Apple.', 'aside'],
    ['Sem ações de tecnologia.', 'aside'],
    ['No stocks? Not sure.', 'wondered'],
    ['Maybe no stocks.', 'wondered'],
    ['Should I avoid stocks?', 'wondered'],
    ['No stocks, not sure.', 'wondered'],
    ['Talvez sem ações.', 'wondered'],
  ];

  it('a refusal its clause negates, says of something else or only wonders about is not taken', () => {
    for (const [sentence, stance] of NOT_REFUSALS) {
      const result = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(result.limits, sentence).toEqual(NONE);
      expect(result.questions, sentence).toEqual([]);
      expect(result.sheet?.limits, sentence).toBeUndefined();
      expect((result.readBack ?? []).join(' '), sentence).not.toMatch(
        /You left out|deixou de fora/,
      );
      expect(
        result.flags.filter((f) => f.startsWith('refusal_')),
        sentence,
      ).toEqual([`refusal_${stance}:stock`]);
      // How each is read, and that the words are written all the same.
      expect(
        refusalsSaidIn(sentence).map((r) => [r.what, r.stance]),
        sentence,
      ).toEqual([['stock', stance]]);
      expect(refusalsIn(sentence).classes, sentence).toEqual(['stock']);
      // One the person is not sure of is said back, so it is never dropped in silence. One they
      // do not mean is not.
      const said = result.assumptions.filter((a) => /^I did not read|^Não li/.test(a));
      expect(said.length, sentence).toBe(stance === 'wondered' ? 1 : 0);
    }
    // Credit, by the same rule.
    for (const [sentence, stance] of [
      ['I have no credit card debt.', 'aside'],
      ['I have no loans.', 'aside'],
      ['No credit? Not sure.', 'wondered'],
    ] as const) {
      const result = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(result.limits, sentence).toEqual(NONE);
      expect(result.flags, sentence).toContain(`refusal_${stance}:credit`);
    }
    // Words that write no refusal at all: nothing is read and nothing is flagged.
    for (const sentence of [
      "I don't mind stocks.",
      'No rush, stocks are fine.',
      'No. Stocks are fine.',
      'I have no deadline. Stocks are fine.',
      'No more than 30% in stocks.',
    ]) {
      const result = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(result.limits, sentence).toEqual(NONE);
      expect(
        result.flags.filter((f) => f.startsWith('refusal_')),
        sentence,
      ).toEqual([]);
    }
  });

  it('a class word inside the words of a narrative rules out the narrative, and leaves out no class', () => {
    // "No defense stocks", "no US stocks", "no crypto stocks": finding 1 reads the narrative as ruled
    // out, so it is not asked. It is no refusal of every stock, nor of crypto.
    for (const [sentence, classes] of [
      ['No defense stocks.', ['stock']],
      ['No US stocks.', ['stock']],
      ['No crypto stocks.', ['crypto', 'stock']],
      ['Sem ações americanas.', ['stock']],
      ['No bitcoin miners.', ['crypto']],
    ] as const) {
      expect(
        refusalsSaidIn(sentence).map((r) => [r.what, r.stance]),
        sentence,
      ).toEqual(classes.map((c) => [c, 'aside']));
      expect(marketsIn(sentence), sentence).toEqual([]);
      for (const r of [model(), null]) {
        const result = intake(GOAL + sentence, r, { answers: ANSWERS });
        expect(result.limits, sentence).toEqual(NONE);
        expect(result.narratives, sentence).toEqual([]);
        expect(result.questions, sentence).toEqual([]);
        expect(result.sheet?.limits, sentence).toBeUndefined();
      }
    }
    // "No commodities" is the class and the narrative at once: the class is left out.
    const commodities = intake(`${GOAL}No commodities.`, null, { answers: ANSWERS });
    expect(commodities.sheet?.limits).toEqual({ cannotHold: { classes: ['commodity'] } });
    expect(commodities.narratives).toEqual([]);
  });

  // The end of the same sentence. "No stocks" gave `cannotHold.classes = ['stock']` and the plan still
  // held the S&P 500 fund token, which is class `etf`. The product holds a fund of stocks as a stock
  // token (gate PROTECT-NO-STOCKS, and the registry: `stock` and `etf` are held by the same goals, and
  // every `etf` on the shelf is a stock index fund), so "no stocks" is no stocks through a fund either.
  it('a refusal of stocks leaves out stock funds too, with no model and with one, and says so', () => {
    const text = `${GOAL}I am retired so no stocks please.`;
    const BOTH = { cannotHold: { classes: ['etf', 'stock'] } };
    // No model.
    const rules = intake(text, null, { answers: ANSWERS });
    expect(rules.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['etf', 'stock'] });
    expect(rules.sheet?.limits).toEqual(BOTH);
    expect(rules.readBack).toContain('You left out stocks and stock funds.');
    // A model that reads the refusal as the person said it: stocks. Both classes are left out, and
    // the class that goes with stocks is no disagreement with the model.
    const byModel = intake(text, model({ cannotHold: ['stock'] }), { answers: { risk: 'low' } });
    expect(byModel.method).toBe('model');
    expect(byModel.sheet?.limits).toEqual(BOTH);
    expect(byModel.readBack).toContain('You left out stocks and stock funds.');
    expect(byModel.flags.filter((f) => /cannotHold|not_in_text|refusal_/.test(f))).toEqual([]);
    expect(byModel.sheet).toEqual(rules.sheet);
    // A model that names both, or the fund class alone, or neither: the same sheet. Only a refusal
    // the text states and the model missed is flagged, and the fund class is never "not written".
    for (const [cannotHold, flagged] of [
      [['stock', 'etf'], []],
      [['etf'], ['disagrees_with_rules:cannotHold:stock']],
      [[], ['disagrees_with_rules:cannotHold:stock']],
    ] as const) {
      const result = intake(text, model({ cannotHold }), { answers: { risk: 'low' } });
      expect(result.sheet?.limits, JSON.stringify(cannotHold)).toEqual(BOTH);
      expect(
        result.flags.filter((f) => /cannotHold|not_in_text|refusal_/.test(f)),
        JSON.stringify(cannotHold),
      ).toEqual(flagged);
    }
    // In Portuguese, and by its other names.
    const pt = intake(
      'Quero fazer US$ 20.000 crescer por 3 anos com risco baixo, sem ações.',
      null,
      {
        answers: ANSWERS,
        language: 'pt',
      },
    );
    expect(pt.sheet?.limits).toEqual(BOTH);
    expect(pt.readBack).toContain('Você deixou de fora ações e fundos de ações.');
    const ptModel = intake(
      'Quero fazer US$ 20.000 crescer por 3 anos com risco baixo, sem ações.',
      model({ language: 'pt', cannotHold: ['stock'] }),
      { answers: { risk: 'low' } },
    );
    expect(ptModel.sheet?.limits).toEqual(BOTH);
    expect(ptModel.readBack).toContain('Você deixou de fora ações e fundos de ações.');
    for (const words of [
      'No shares.',
      'No equities.',
      'No stocks at all.',
      "I don't want any stocks.",
      "I can't hold stocks.",
      'Não quero ações.',
      'Nenhuma ação.',
    ]) {
      const result = intake(GOAL + words, null, { answers: ANSWERS });
      expect(result.sheet?.limits, words).toEqual(BOTH);
    }
    // With another class refused beside them, each is said once, stocks and their funds first.
    const more = intake(`${GOAL}No stocks, no crypto and no gold.`, null, { answers: ANSWERS });
    expect(more.sheet?.limits).toEqual({
      cannotHold: { classes: ['crypto', 'etf', 'gold', 'stock'] },
    });
    expect(more.readBack).toContain('You left out stocks, stock funds, gold and crypto.');
  });

  // The class is named by its own words. Bare "funds" and "fundos" were read as it until Oct 7: they
  // are money ("no funds needed before then"), and name no class (the case after this one).
  it('a refusal of funds alone leaves out the stock funds, and single stocks may still be held', () => {
    for (const [sentence, language, said] of [
      ['No ETFs.', 'en', 'You left out stock funds.'],
      ['No index funds please.', 'en', 'You left out stock funds.'],
      ['No stock funds.', 'en', 'You left out stock funds.'],
      ["I don't want any ETFs.", 'en', 'You left out stock funds.'],
      ['Sem fundos de índice.', 'pt', 'Você deixou de fora fundos de ações.'],
      ['Sem fundos de ações.', 'pt', 'Você deixou de fora fundos de ações.'],
      ['Sem ETFs.', 'pt', 'Você deixou de fora fundos de ações.'],
    ] as const) {
      for (const r of [null, model({ language, cannotHold: ['etf'] })]) {
        const result = intake(GOAL + sentence, r, { answers: ANSWERS, language });
        expect(result.limits, sentence).toEqual({
          creditTolerance: null,
          cannotHoldClasses: ['etf'],
        });
        expect(result.sheet?.limits, sentence).toEqual({ cannotHold: { classes: ['etf'] } });
        expect(result.readBack, sentence).toContain(said);
        expect((result.readBack ?? []).join(' '), sentence).not.toMatch(
          /left out stocks|de fora ações/,
        );
        expect(
          result.flags.filter((f) => /cannotHold|refusal_/.test(f)),
          sentence,
        ).toEqual([]);
      }
    }
    // Funds and stocks both said: the same two classes, each said once.
    const both = intake(`${GOAL}No stocks and no ETFs.`, null, { answers: ANSWERS });
    expect(both.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(both.readBack).toContain('You left out stocks and stock funds.');
  });

  // The second review (Oct 7): "no funds needed before then" left out the stock funds, and the plan
  // then held no index fund. Bare "funds" is money.
  it('bare "funds" and "fundos" are money, not the class of stock funds: they leave out nothing', () => {
    for (const [sentence, language] of [
      ['No funds please.', 'en'],
      ['No funds needed before then, so I can take risk.', 'en'],
      ['I need no funds from this until 2031.', 'en'],
      ['I have no funds elsewhere.', 'en'],
      ['Sem fundos.', 'pt'],
      ['Sem fundos de emergência ainda.', 'pt'],
      ['Não tenho fundos guardados.', 'pt'],
    ] as const) {
      expect(refusalsSaidIn(sentence), sentence).toEqual([]);
      expect(refusalsIn(sentence), sentence).toEqual({ classes: [], noCredit: false });
      for (const r of [null, model({ language })]) {
        const result = intake(GOAL + sentence, r, { answers: ANSWERS, language });
        expect(result.limits, sentence).toEqual(NONE);
        expect(result.sheet, sentence).not.toBeNull();
        expect(result.sheet?.limits, sentence).toBeUndefined();
        expect((result.readBack ?? []).join(' '), sentence).not.toMatch(/left out|deixou de fora/);
        expect(
          result.flags.filter((f) => /cannotHold|refusal_/.test(f)),
          sentence,
        ).toEqual([]);
      }
    }
    // A model that reads the class from them is not followed: the text does not write it.
    const erring = intake(`${GOAL}No funds needed before then.`, model({ cannotHold: ['etf'] }), {
      answers: ANSWERS,
    });
    expect(erring.limits).toEqual(NONE);
    expect(erring.flags).toContain('not_in_text:cannotHold:etf');
    // "No stock funds" names the funds, not the stocks.
    expect(refusalsSaidIn('No stock funds.').map((r) => [r.what, r.stance])).toEqual([
      ['etf', 'stated'],
    ]);
    expect(intake(`${GOAL}No stock funds.`, null, { answers: ANSWERS }).sheet?.limits).toEqual({
      cannotHold: { classes: ['etf'] },
    });
  });

  // The second review (Oct 7): "No stocks, crypto or gold" read the stocks alone, and dropped the
  // crypto and the gold a model read as not written.
  it('a refusal leads its list: what is said of the first is said of each', () => {
    for (const [sentence, classes, noCredit] of [
      ['No stocks, crypto or gold.', ['crypto', 'etf', 'gold', 'stock'], false],
      ['No stocks, no crypto, no gold.', ['crypto', 'etf', 'gold', 'stock'], false],
      ['Without crypto, gold or credit.', ['crypto', 'gold'], true],
      ["I don't want stocks, ETFs or crypto.", ['crypto', 'etf', 'stock'], false],
      ['Sem ações, cripto ou ouro.', ['crypto', 'etf', 'gold', 'stock'], false],
      ['Sem ações nem cripto.', ['crypto', 'etf', 'stock'], false],
    ] as const) {
      for (const r of [null, model()]) {
        const result = intake(GOAL + sentence, r, { answers: ANSWERS });
        expect(result.limits, sentence).toEqual({
          creditTolerance: noCredit ? 'none' : null,
          cannotHoldClasses: [...classes],
        });
      }
    }
    // Where the list ends and another clause starts, the next thing is no item of it.
    for (const [sentence, classes] of [
      ['No stocks, gold is fine.', ['etf', 'stock']],
      ['No stocks, gold only.', ['etf', 'stock']],
      ['No crypto, stocks are what I want.', ['crypto']],
    ] as const)
      expect(
        intake(GOAL + sentence, null, { answers: ANSWERS }).limits.cannotHoldClasses,
        sentence,
      ).toEqual([...classes]);
    // A model that reads the three agrees with the text: nothing is flagged.
    const agreed = intake(
      `${GOAL}No stocks, crypto or gold.`,
      model({ cannotHold: ['stock', 'crypto', 'gold'] }),
      { answers: ANSWERS },
    );
    expect(agreed.flags.filter((f) => /cannotHold/.test(f))).toEqual([]);
    expect(agreed.readBack).toContain('You left out stocks, stock funds, gold and crypto.');
  });

  it('"leave out", the words the intake itself uses, is a refusal', () => {
    for (const [sentence, what] of [
      ['Leave out stocks.', 'stock'],
      ['Please leave out crypto.', 'crypto'],
      ['Deixe de fora ações.', 'stock'],
      ['Pode deixar fora cripto.', 'crypto'],
    ] as const)
      expect(
        refusalsSaidIn(sentence).map((r) => [r.what, r.stance]),
        sentence,
      ).toEqual([[what, 'stated']]);
  });

  it('stocks the person is not sure of, or does not refuse, leave out no fund either', () => {
    for (const sentence of [
      'No stocks? Not sure.',
      'Maybe no stocks.',
      'I have no problem with stocks.',
      "I can't do without stocks.",
      'My brother holds no stocks.',
      'No US stocks.',
    ]) {
      const result = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(result.limits, sentence).toEqual(NONE);
      expect(result.sheet?.limits, sentence).toBeUndefined();
    }
    // Stocks stated and the funds only wondered about: both are left out by the stocks, and no line
    // says the funds were not taken.
    const result = intake(`${GOAL}No stocks. Maybe no ETFs?`, null, { answers: ANSWERS });
    expect(result.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(result.flags.filter((f) => f.startsWith('refusal_'))).toEqual([]);
    expect(result.assumptions.join(' ')).not.toMatch(/I did not read/);
    // The form's own entry stays as entered: the classes there are the person's, one by one.
    const form = intake(`${GOAL}No stocks please.`, null, {
      answers: { ...ANSWERS, limits: { cannotHold: { classes: ['stock'] } } },
    });
    expect(form.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
    expect(form.readBack).toContain('You left out stocks.');
  });

  // The ways a person says a refusal that the check did not read at all: with a model its correct
  // `cannotHold` was dropped as not written (`not_in_text`), and with none nothing read it.
  const SAID_OTHERWISE: [string, ('stock' | 'crypto' | 'gold')[], boolean][] = [
    ["I don't want stocks.", ['stock'], false],
    ["I don't want any stocks.", ['stock'], false],
    ['I do not want any crypto.', ['crypto'], false],
    ['I do not want to hold stocks.', ['stock'], false],
    ["I don't want to invest in stocks.", ['stock'], false],
    ["I don't want to be in stocks.", ['stock'], false],
    ["I don't want stocks or crypto.", ['crypto', 'stock'], false],
    ["I won't touch crypto.", ['crypto'], false],
    ["I can't hold stocks.", ['stock'], false],
    ['I am not allowed to own stocks.', ['stock'], false],
    ['Never crypto.', ['crypto'], false],
    ['Keep me out of stocks.', ['stock'], false],
    ['I want to stay away from crypto.', ['crypto'], false],
    ['Neither stocks nor crypto.', ['crypto', 'stock'], false],
    ["I don't want bonds nor stocks.", ['stock'], false],
    ['Nem ações nem cripto.', ['crypto', 'stock'], false],
    ['Não quero ter nenhuma ação.', ['stock'], false],
    ['Quero ficar longe de cripto.', ['crypto'], false],
    ['Não posso ter ações.', ['stock'], false],
    ["I don't want any lending.", [], true],
  ];

  it('reads the ways a person says a refusal: not wanting it, not being able to hold it, keeping out of it', () => {
    for (const [sentence, classes, noCredit] of SAID_OTHERWISE) {
      // What is said, and what that leaves out: stocks are no stocks through a fund either.
      const leftOut = leftOutWith(classes);
      const limits = {
        ...(noCredit ? { creditTolerance: 'none' } : {}),
        ...(leftOut.length > 0 ? { cannotHold: { classes: leftOut } } : {}),
      };
      // With no model.
      const rules = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(rules.sheet?.limits, sentence).toEqual(limits);
      // With a model that reads it: kept, and no longer dropped as not written.
      const read = intake(GOAL + sentence, model({ cannotHold: classes, noCredit }), {
        answers: { risk: 'low' },
      });
      expect(read.sheet?.limits, sentence).toEqual(limits);
      expect(
        read.flags.filter((f) => /not_in_text|refusal_|cannotHold|noCredit/.test(f)),
        sentence,
      ).toEqual([]);
      // With a model that misses it: taken all the same.
      const missed = intake(GOAL + sentence, model(), { answers: { risk: 'low' } });
      expect(missed.sheet?.limits, sentence).toEqual(limits);
    }
  });

  it('and what only looks like one: how much, how held, of another time, or the opposite', () => {
    for (const [sentence, stance] of [
      ["I don't want only stocks.", 'aside'],
      ["I don't want too many stocks.", 'aside'],
      ["I don't want more stocks.", 'aside'],
      ["I don't want to be all in stocks.", 'aside'],
      ["I can't have everything in crypto.", 'aside'],
      ["I don't want to miss stocks.", 'aside'],
      ['I never had stocks.', 'aside'],
      ['I never said no stocks.', 'aside'],
      ["I'm not in stocks yet.", 'aside'],
      ['Não tenho nenhuma ação.', 'aside'],
      ['Estou sem ações.', 'aside'],
      ['Nem todas as ações.', 'aside'],
      ["I don't want US stocks.", 'aside'],
      ['My brother never wants stocks.', 'aside'],
      ["I don't want to be without stocks.", 'negated'],
      ['Never without stocks.', 'negated'],
      ['Should I stay away from stocks?', 'wondered'],
      ["Maybe I don't want stocks.", 'wondered'],
    ] as const) {
      const what = /crypto/.test(sentence) ? 'crypto' : 'stock';
      for (const r of [null, model()]) {
        const result = intake(GOAL + sentence, r, { answers: ANSWERS });
        expect(result.limits, sentence).toEqual(NONE);
        expect(result.sheet?.limits, sentence).toBeUndefined();
        expect(result.flags, sentence).toContain(`refusal_${stance}:${what}`);
      }
    }
    // Words that write no refusal at all, and a mix its clause rules out (finding 1) is no refusal
    // of the class either.
    for (const sentence of [
      "I don't have stocks.",
      "I don't own stocks.",
      "I don't like stocks.",
      "I can't wait to buy stocks.",
      "I can't decide about stocks.",
      "I don't want all of it in stocks.",
      "I wouldn't put all of it in stocks.",
      'I cannot be all in stocks.',
      "I don't want to sell my stocks.",
      "I don't want to invest in big tech.",
    ]) {
      expect(refusalsSaidIn(sentence), sentence).toEqual([]);
      const result = intake(GOAL + sentence, null, { answers: ANSWERS });
      expect(result.limits, sentence).toEqual(NONE);
    }
  });

  it('a refusal the person is not sure of is said back in their words, in both languages', () => {
    const en = intake(`${GOAL}No stocks? Not sure.`, null, { answers: ANSWERS });
    expect(en.readBack).toEqual([
      'You set a goal to grow with $20,000 over 3 years, at low risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'I did not read “No stocks” as something to leave out. Say so if you want it left out.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
    const pt = intake('Quero fazer US$ 20.000 crescer por 3 anos. Talvez sem ações.', null, {
      answers: ANSWERS,
      language: 'pt',
    });
    expect(pt.assumptions).toContain(
      'Não li “sem ações” como algo a deixar de fora. Diga se quiser que fique de fora.',
    );
    // Said the same once the person does say it: the refusal is then taken, and the line is gone.
    const sure = intake(`${GOAL}No stocks? Not sure. Actually yes, no stocks.`, null, {
      answers: ANSWERS,
    });
    expect(sure.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(sure.assumptions.join(' ')).not.toMatch(/I did not read/);
    // On the form, the limits the person enters are theirs, over what was read.
    const form = intake(`${GOAL}No stocks? Not sure.`, null, {
      answers: { ...ANSWERS, limits: { cannotHold: { classes: ['stock'] } } },
    });
    expect(form.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
  });

  it('a model reply that misses a written refusal: the text is taken, and the disagreement flagged', () => {
    const text = `${GOAL}I am retired so no stocks please.`;
    // The model reads the goal and gives no refusal at all.
    const missed = intake(text, model({ cannotHold: [], noCredit: false }), {
      answers: { risk: 'low' },
    });
    expect(missed.method).toBe('model');
    expect(missed.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['etf', 'stock'] });
    expect(missed.flags).toContain('disagrees_with_rules:cannotHold:stock');
    expect(missed.questions).toEqual([]);
    expect(missed.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(missed.readBack).toContain('You left out stocks and stock funds.');
    // It reads one of two, or credit and not the class.
    const half = intake(
      `${GOAL}No stocks, no crypto and no lending.`,
      model({ cannotHold: ['crypto'] }),
      {
        answers: { risk: 'low' },
      },
    );
    expect(half.sheet?.limits).toEqual({
      creditTolerance: 'none',
      cannotHold: { classes: ['crypto', 'etf', 'stock'] },
    });
    expect(half.flags).toEqual(
      expect.arrayContaining([
        'disagrees_with_rules:cannotHold:stock',
        'disagrees_with_rules:noCredit',
      ]),
    );
    expect(half.flags).not.toContain('disagrees_with_rules:cannotHold:crypto');
    // A reply that agrees is flagged for nothing.
    const agreed = intake(text, model({ cannotHold: ['stock'] }), { answers: { risk: 'low' } });
    expect(agreed.flags.filter((f) => /cannotHold|noCredit|refusal_/.test(f))).toEqual([]);
    expect(agreed.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
  });

  it('the model adds none: what it gives that the text does not state is not taken, and never in silence', () => {
    // Not written at all: not taken and flagged, as before; and asked once, since no reader decides
    // alone (the third review, Oct 7). It was dropped with the flag.
    const unwritten = intake(GOAL, model({ cannotHold: ['gold'], noCredit: true }));
    expect(unwritten.limits).toEqual(NONE);
    expect(unwritten.flags).toEqual(
      expect.arrayContaining(['not_in_text:cannotHold:gold', 'not_in_text:noCredit']),
    );
    expect(unwritten.sheet).toBeNull();
    expect(unwritten.questions.filter((q) => q.field === 'limits')).toEqual([
      {
        field: 'limits',
        template: 'limits',
        text: 'Do you want to leave out gold and tokens that lend to borrowers or trade a spread?',
        read: ['gold', 'credit'],
      },
    ]);
    // Written, and the clause says otherwise: the text's reading stands, and because the other
    // reader took it for a refusal it is asked, where it was said back in a line.
    for (const [sentence, stance, words] of [
      ['No stocks? Not sure.', 'wondered', 'No stocks'],
      ['My brother holds no stocks.', 'aside', 'no stocks'],
      ["I can't do without stocks.", 'negated', 'without stocks'],
    ] as const) {
      const result = intake(GOAL + sentence, model({ cannotHold: ['stock'] }), {
        answers: { risk: 'low' },
      });
      expect(result.limits, sentence).toEqual(NONE);
      expect(result.sheet, sentence).toBeNull();
      expect(result.flags, sentence).toContain(`refusal_${stance}:stock`);
      expect(result.flags, sentence).not.toContain('not_in_text:cannotHold:stock');
      expect(
        result.questions.map((q) => q.text),
        sentence,
      ).toEqual(['Do you want to leave out stocks and stock funds?']);
      // The question takes the place of the line that said it was not read as one.
      expect(result.assumptions.join(' '), sentence).not.toContain(words);
      // With no model there is no second reader: nothing is asked, and one the person is not sure
      // of is said back as before.
      const alone = intake(GOAL + sentence, null, {
        answers: { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'low' },
      });
      expect(alone.questions, sentence).toEqual([]);
      expect(
        alone.assumptions.includes(
          `I did not read “${words}” as something to leave out. Say so if you want it left out.`,
        ),
        sentence,
      ).toBe(stance === 'wondered');
    }
    // The model's mix is never offered as the start of a question where the text refuses its class.
    const erring = intake(`${GOAL}I am retired so no stocks please.`, model({ mix: pct(100, 0) }));
    expect(erring.questions.find((q) => q.field === 'mix')?.read).toBeUndefined();
    expect(erring.limits.cannotHoldClasses).toEqual(['etf', 'stock']);
  });

  it('the same refusals are read whoever reads the rest: every goal of the evaluation set', () => {
    for (const g of evalSet.goals) {
      const expected = g.expectLimits as {
        creditTolerance: string | null;
        cannotHoldClasses: string[] | null;
      };
      // With no model the intake reads what the set expects of the model's reply.
      const rules = runIntake({
        text: g.text,
        nowMonth: NOW,
        reply: null,
        homeChain: 'solana',
        portfolios,
      });
      expect(rules.limits.cannotHoldClasses, g.id).toEqual(expected.cannotHoldClasses);
      expect(rules.limits.creditTolerance, g.id).toEqual(expected.creditTolerance);
      // And every refusal of the set is one its clause states, with the stock funds a refusal of
      // stocks leaves out too.
      const said = refusalsSaidIn(g.text).filter((r) => r.stance === 'stated');
      const classes = leftOutWith([
        ...new Set(said.flatMap((r) => (r.what === 'credit' ? [] : [r.what]))),
      ]);
      expect(classes.length > 0 ? classes : null, g.id).toEqual(expected.cannotHoldClasses);
      expect(said.some((r) => r.what === 'credit') ? 'none' : null, g.id).toEqual(
        expected.creditTolerance,
      );
    }
    // The set holds refusals of each kind: the check above is not idle.
    const kinds = evalSet.goals.map((g) => JSON.stringify(g.expectLimits));
    expect(kinds.some((k) => /"stock"/.test(k))).toBe(true);
    expect(kinds.some((k) => /"crypto"/.test(k))).toBe(true);
    expect(kinds.some((k) => /"creditTolerance":"none"/.test(k))).toBe(true);
  });
});

describe('finding 4: a risk the person gave is never replaced in silence', () => {
  const LIMITS = /limits for|limites de/;
  const limitsOf = (r: { readBack: string[] | null }) =>
    (r.readBack ?? []).filter((s) => LIMITS.test(s));

  it('the review case: all in stocks with the risk answered low gives a sheet at high risk, and one line says both', () => {
    const text = 'I want to grow $2,000 over 5 years. I want all of it in stocks';
    const r = reply({ amountUsd: 2000, risk: null, mix: pct(100, 0) });
    const result = intake(text, r, { answers: { risk: 'low' } });
    expect(result.questions).toEqual([]);
    const sheet = result.sheet as PersonalSheet;
    // The sheet carries the risk the engine will take for the mix, not the answer.
    expect(sheet.mix).toEqual(ALL_STOCKS);
    expect(sheet.risk).toBe('high');
    expect(sheet.risk).toBe(riskForMixEstimate(sheet.mix as { growthBps: number }));
    expect(result.flags).toEqual(
      expect.arrayContaining(['risk_from_mix', 'risk_said_not_used:low']),
    );
    // And the read-back says it: their answer, and the limits the plan uses to hold what they asked.
    expect(limitsOf(result)).toEqual([
      'You said low risk, but to hold “all of it in stocks” the plan uses the limits for high risk.',
    ]);
    expect(result.assumptions.filter((s) => LIMITS.test(s))).toEqual(limitsOf(result));
    // The goal line names no risk, so the read-back says one risk only.
    expect(result.readBack?.[0]).toBe('You set a goal to grow with $2,000 over 5 years.');
    expect((result.readBack ?? []).join(' ')).not.toMatch(/at low risk|at high risk/);
  });

  it('the same for a risk written in the text, with no model, in Portuguese, and for a market', () => {
    // Written in the text and read by the model.
    const written = intake(
      'I want to grow $2,000 over 5 years at low risk. I want all of it in stocks',
      reply({ amountUsd: 2000, risk: 'low', mix: pct(100, 0) }),
    );
    expect(written.questions).toEqual([]);
    expect(written.sheet?.risk).toBe('high');
    expect(limitsOf(written)).toEqual([
      'You said low risk, but to hold “all of it in stocks” the plan uses the limits for high risk.',
    ]);
    // With no model, the risk answered on the form, and the mix confirmed on it (with no model a
    // mix the text states is asked once, with it as the start: Oct 7).
    const rules = confirmed('I want to grow $2,000 over 5 years. I want all of it in stocks', {
      goal: 'grow',
      amountUsd: 2000,
      horizonMonths: 60,
      risk: 'medium',
    }).done;
    expect(rules.questions).toEqual([]);
    expect(rules.sheet?.risk).toBe('high');
    expect(limitsOf(rules)).toEqual([
      'You said medium risk, but to hold “all of it in stocks” the plan uses the limits for high risk.',
    ]);
    // In Portuguese.
    const pt = intake(
      'Quero fazer US$ 2.000 crescer em 5 anos com risco baixo. Quero tudo em ações.',
      reply({ amountUsd: 2000, language: 'pt', risk: 'low', mix: pct(100, 0) }),
      // The rules parser reads the risk another way: the person confirms theirs.
      { answers: { risk: 'low' } },
    );
    expect(pt.sheet?.risk).toBe('high');
    expect(limitsOf(pt)).toEqual([
      'Você disse risco baixo, mas para manter “tudo em ações” o plano usa os limites de risco alto.',
    ]);
    // A market held as a mix.
    const market = intake(
      'Invest $2,000 in big tech for 5 years',
      reply({ amountUsd: 2000, risk: null, markets: ['big_tech'] }),
      { answers: { risk: 'low' } },
    );
    expect(market.sheet).toMatchObject({ risk: 'high', themes: ['the-seven'], mix: ALL_STOCKS });
    expect(limitsOf(market)).toEqual([
      'You said low risk, but to hold “big tech” the plan uses the limits for high risk.',
    ]);
    // A mix that needs less than the person said: the limits follow what is held all the same.
    const less = intake(
      'I want to grow $2,000 over 5 years, 30% stocks and 70% cash',
      reply({ amountUsd: 2000, risk: null, mix: pct(30, 70) }),
      { answers: { risk: 'high' } },
    );
    expect(less.sheet?.risk).toBe('low');
    expect(limitsOf(less)).toEqual([
      'You said high risk, but to hold “30% stocks and 70% cash” the plan uses the limits for low risk.',
    ]);
  });

  it('where the risk said is the one the mix needs, or none was said, the plain line is said', () => {
    const text = 'I want to grow $2,000 over 5 years. I want all of it in stocks';
    const r = reply({ amountUsd: 2000, risk: null, mix: pct(100, 0) });
    const PLAIN = 'To hold “all of it in stocks”, the plan uses the limits for high risk.';
    for (const answers of [{}, { risk: 'high' as const }]) {
      const result = intake(text, r, { answers });
      expect(result.sheet?.risk).toBe('high');
      expect(limitsOf(result)).toEqual([PLAIN]);
      expect(result.flags.filter((f) => f.startsWith('risk_said_not_used'))).toEqual([]);
    }
    // A risk the model suggests with no word for it in the text is not the person's.
    const suggested = intake(text, { ...r, risk: 'low' });
    expect(suggested.sheet?.risk).toBe('high');
    expect(limitsOf(suggested)).toEqual([PLAIN]);
  });

  it('whatever the mix and whatever the risk answered, the sheet and the read-back say the same risk', () => {
    for (const growthPct of [0, 30, 50, 70, 80, 100])
      for (const risk of ['low', 'medium', 'high'] as const) {
        const text = `I want to grow $2,000 over 5 years, ${growthPct}% stocks and ${100 - growthPct}% cash`;
        const result = intake(
          text,
          reply({ amountUsd: 2000, risk: null, mix: pct(growthPct, 100 - growthPct) }),
          { answers: { risk } },
        );
        const where = `${growthPct}% at ${risk}`;
        const sheet = result.sheet as PersonalSheet;
        const needed = riskForMixEstimate({ growthBps: growthPct * 100 });
        expect(sheet.risk, where).toBe(needed);
        const [line, ...more] = limitsOf(result);
        expect(more, where).toEqual([]);
        expect(line, where).toMatch(new RegExp(`the limits for ${needed} risk\\.$`));
        expect(/^You said /.test(line ?? ''), where).toBe(risk !== needed);
        if (risk !== needed)
          expect(line, where).toMatch(new RegExp(`^You said ${risk} risk, but `));
      }
  });
});

describe('finding 6: a stated holding the text check cannot read is asked, never dropped to the risk question', () => {
  it('a mix only the model reads: the mix question, once, with the model reading as the start', () => {
    const text = 'I want to grow $2,000 over 5 years. Mostly stocks.';
    expect(mixIn(text)).toBeNull();
    const r = reply({ amountUsd: 2000, risk: null, mix: pct(80, 20) });
    const asked = intake(text, r);
    expect(asked.flags).toEqual(expect.arrayContaining(['no_cue:mix', 'mix_asked:model']));
    expect(asked.mix).toBeNull();
    expect(asked.questions).toEqual([
      {
        field: 'mix',
        template: 'mix',
        text: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
        read: bps(8000, 2000),
      },
    ]);
    // Never the risk in its place.
    expect(fields(asked)).not.toContain('risk');
    const held = intake(text, r, { answers: { mix: bps(8000, 2000) } });
    expect(held.questions).toEqual([]);
    expect(held.sheet).toMatchObject({ risk: 'high', mix: bps(8000, 2000) });
    // Answered "no mix": then, and only then, the risk is asked as for any goal.
    const none = intake(text, r, { answers: { mix: null } });
    expect(fields(none)).toEqual(['risk']);
    // In another language than the checks read: asked the same way.
    const es = intake('Quiero invertir 2000 dólares a 5 años, todo en acciones', {
      ...r,
      language: 'es',
      mix: pct(100, 0),
    });
    expect(es.mix).toBeNull();
    expect(fields(es)).toContain('mix');
    expect(fields(es)).not.toContain('risk');
  });

  // The phrasings of the review, each with the mix it states. All were unread before, but for the
  // first of each kind.
  const PHRASINGS: [string, ReturnType<typeof bps>][] = [
    ['stocks only', bps(10_000, 0)],
    ['all stocks', bps(10_000, 0)],
    ['100 percent stocks', bps(10_000, 0)],
    ['70% in stocks and the rest in cash', bps(7000, 3000)],
    ['60/40 stocks and bonds', bps(6000, 0, 4000)],
    ['I only want stocks', bps(10_000, 0)],
    ['nothing but stocks', bps(10_000, 0)],
    ['put everything into the stock market', bps(10_000, 0)],
    ['fully invested in equities', bps(10_000, 0)],
    ['half stocks, half cash', bps(5000, 5000)],
    ['half in stocks and half in gold', bps(5000, 0, 0, 5000)],
    ['70/30 stocks and cash', bps(7000, 3000)],
    ['all in on stocks', bps(10_000, 0)],
    ['I want it all in equities', bps(10_000, 0)],
    ['everything in bitcoin', bps(10_000, 0)],
    ['só quero ações', bps(10_000, 0)],
    ['quero só ações', bps(10_000, 0)],
    ['apenas em ações', bps(10_000, 0)],
    ['100% em ações', bps(10_000, 0)],
    ['tudo na bolsa', bps(10_000, 0)],
    ['metade em ações e metade em caixa', bps(5000, 5000)],
    ['70% ações e o resto em caixa', bps(7000, 3000)],
    ['tudo em renda fixa', bps(0, 0, 10_000)],
    ['somente ouro', bps(0, 0, 0, 10_000)],
    ['tudo em cripto', bps(10_000, 0)],
  ];

  it('reads the natural ways to state a mix, in English and Portuguese', () => {
    for (const [words, mix] of PHRASINGS) expect(mixIn(words)?.mix, words).toEqual(mix);
    // What says no share is not filled in: it is asked through the model's reading (above).
    for (const words of ['mostly stocks', 'a bit of everything', 'stocks and gold', '70% stocks'])
      expect(mixIn(words), words).toBeNull();
  });

  it('holds each of them with no question, and never asks the risk', () => {
    for (const [words, mix] of PHRASINGS) {
      const text = `I want to grow $2,000 over 5 years. ${words}.`;
      const asModel = {
        growthPct: mix.growthBps / 100,
        dollarYieldPct: mix.dollarYieldBps / 100,
        goldPct: mix.goldBps / 100,
        cashPct: mix.cashBps / 100,
        creditPct: null,
      };
      const byModel = intake(text, reply({ amountUsd: 2000, risk: null, mix: asModel }));
      expect(byModel.flags, words).not.toContain('no_cue:mix');
      expect(byModel.questions, words).toEqual([]);
      expect(byModel.sheet?.mix, words).toEqual(mix);
      expect(byModel.sheet?.risk, words).toBe(riskForMixEstimate(mix));
      // With no model the same mix is read, and the risk is not among what is asked. It is asked
      // once, with that reading as the form's start, and never taken (Oct 7): confirmed, it is held.
      const byRules = intake(text, null);
      expect(byRules.mix, words).toBeNull();
      expect(byRules.sheet, words).toBeNull();
      expect(
        byRules.questions.find((q) => q.field === 'mix'),
        words,
      ).toMatchObject({ template: 'mix', read: mix });
      expect(byRules.flags, words).toContain('mix_asked:rules');
      expect(fields(byRules), words).not.toContain('risk');
      expect(fields(byRules), words).not.toContain('sleeves');
      const held = intake(text, null, { answers: { mix } });
      expect(held.mix, words).toEqual(mix);
      expect(fields(held), words).not.toContain('risk');
      expect(fields(held), words).not.toContain('mix');
    }
  });

  it('a percent or a half said of a market is that market share: in stocks for a shared portfolio, the rest in cash', () => {
    for (const [words, growthBps, market, slug] of [
      ['Put 50% in big tech', 5000, 'big_tech', 'the-seven'],
      ['put half in big tech', 5000, 'big_tech', 'the-seven'],
      ['Half of it in the S&P 500', 5000, 'us_market', 'the-500'],
      ['30 percent in big tech', 3000, 'big_tech', 'the-seven'],
      ['Colocar 40% em big techs', 4000, 'big_tech', 'the-seven'],
    ] as const) {
      const text = `I want to grow $2,000 over 5 years. ${words}.`;
      for (const r of [reply({ amountUsd: 2000, risk: null, markets: [market] }), null]) {
        const where = `${words} ${r === null ? 'rules' : 'model'}`;
        const answers: IntakeAnswers = r === null ? { ...ANSWERED, amountUsd: 2000 } : {};
        const first = intake(text, r, { answers });
        const share = bps(growthBps, 10_000 - growthBps);
        // With a model both readers read it: held with no question. With no model the share the
        // text states is asked once, with it as the form's start, and held once confirmed (Oct 7).
        if (r === null) {
          expect(first.flags, where).toContain('from_rules:market');
          expect(first.flags, where).not.toContain('mix_from_market');
          expect(first.sheet, where).toBeNull();
          expect(first.questions, where).toHaveLength(1);
          expect(first.questions[0], where).toMatchObject({
            field: 'mix',
            template: 'marketShare',
            read: share,
          });
        } else expect(first.flags, where).toContain('mix_from_market');
        const result =
          r === null ? intake(text, r, { answers: { ...answers, mix: share } }) : first;
        // The percent is the market's: no split is read from it, and none is asked.
        expect(result.questions, where).toEqual([]);
        expect(result.sheet?.mix, where).toEqual(bps(growthBps, 10_000 - growthBps));
        expect(result.sheet?.sleeves, where).toBeUndefined();
        expect(result.sheet?.themes, where).toEqual([slug]);
        expect(result.sheet?.risk, where).toBe(riskForMixEstimate({ growthBps }));
      }
    }
    // The review case, with what it said was lost: the 50%.
    const fifty = intake(
      'I want to grow $5,000 over 5 years. Put 50% in big tech.',
      reply({ risk: null, markets: ['big_tech'] }),
    );
    expect(fifty.readBack).toEqual(
      expect.arrayContaining([
        'The plan starts from The Seven.',
        '50% of the plan in stocks and crypto.',
        '50% of the plan in cash.',
        'To hold “big tech”, the plan uses the limits for low risk.',
      ]),
    );
    // Shares of two markets add up; shares over the whole are asked, never cut to fit.
    const two = intake(
      'I want to grow $2,000 over 5 years. Put 30% in big tech and 20% in the S&P 500.',
      reply({ amountUsd: 2000, risk: null, markets: ['big_tech', 'us_market'] }),
    );
    expect(two.sheet?.mix).toEqual(bps(5000, 5000));
    expect(two.sheet?.themes).toEqual(['the-seven', 'the-500']);
    const over = intake(
      'I want to grow $2,000 over 5 years. Put 70% in big tech and 60% in the S&P 500.',
      reply({ amountUsd: 2000, risk: null, markets: ['big_tech', 'us_market'] }),
    );
    expect(over.mix).toBeNull();
    expect(fields(over)).toEqual(['mix']);
    expect(over.flags).toContain('market_share_unclear');
    // A percent and a sum together.
    const both = intake(
      'I want to grow $2,000 over 5 years. Put 30% in big tech and $400 in the S&P 500.',
      reply({ amountUsd: 2000, risk: null, markets: ['big_tech', 'us_market'] }),
    );
    expect(both.sheet?.mix).toEqual(bps(5000, 5000));
  });

  it('for a label or a matched narrative the percent is the theme sleeve share, with the rest kept safe', () => {
    const r = (markets: string[]) => reply({ amountUsd: 2000, risk: null, markets });
    const ai = intake('I want to grow $2,000 over 5 years. 30% in AI.', r(['ai']));
    expect(ai.questions).toEqual([]);
    expect(ai.sheet?.sleeves).toEqual([theme('ai', 3000), safe(7000)]);
    expect(ai.sheet?.mix).toBeUndefined();
    expect(ai.sheet?.risk).toBe('low');
    expect(ai.readBack).toEqual(
      expect.arrayContaining([
        '30% of the plan for the theme AI.',
        '70% of the plan for dollar yield from a rate alone.',
        'To hold “AI”, the plan uses the limits for low risk.',
      ]),
    );
    const half = intake('I want to grow $2,000 over 5 years. Half in AI.', r(['ai']));
    expect(half.sheet?.sleeves).toEqual([theme('ai', 5000), safe(5000)]);
    const pt = intake('Quero fazer US$ 2.000 crescer em 5 anos. Metade em semicondutores.', {
      ...r(['semiconductors']),
      language: 'pt',
    });
    expect(pt.sheet?.sleeves).toEqual([theme('semiconductors', 5000), safe(5000)]);
    // A matched narrative, by the same rule.
    const matched = intake(
      'I want to grow $2,000 over 5 years. Put 80% in defense stocks.',
      r(['defense']),
    );
    expect(matched.sheet?.sleeves).toEqual([
      theme('matched-industry-aerospace-defense', 8000),
      safe(2000),
    ]);
    expect(matched.sheet?.risk).toBe('high');
    // Two themes, each with its percent; a percent and a sum; with no model.
    const two = intake(
      'I want to grow $2,000 over 5 years. Put 30% in AI and 20% in semiconductors.',
      r(['ai', 'semiconductors']),
    );
    expect(two.sheet?.sleeves).toEqual([
      theme('ai', 3000),
      theme('semiconductors', 2000),
      safe(5000),
    ]);
    const mixed = intake(
      'I want to grow $2,000 over 5 years. Put 30% in AI and $400 in semiconductors.',
      r(['ai', 'semiconductors']),
    );
    expect(mixed.sheet?.sleeves).toEqual([
      theme('ai', 3000),
      theme('semiconductors', 2000),
      safe(5000),
    ]);
    // With no model the share the text states is asked once, with it as the start, and held once
    // confirmed (Oct 7).
    const rules = confirmed('I want to grow $2,000 over 5 years. 30% in AI.', {
      ...ANSWERED,
      amountUsd: 2000,
    });
    expect(rules.asked.questions).toEqual([
      {
        field: 'mix',
        template: 'marketShare',
        text: 'How much of the $2,000 for AI?',
        read: bps(3000, 7000),
      },
    ]);
    expect(rules.asked.sheet).toBeNull();
    expect(rules.done.questions).toEqual([]);
    expect(rules.done.sheet?.sleeves).toEqual([theme('ai', 3000), safe(7000)]);
    // The whole in percent is the whole plan, and shares over the whole are asked.
    const whole = intake('I want to grow $2,000 over 5 years. 100% in AI.', r(['ai']));
    expect(whole.sheet?.sleeves).toEqual([theme('ai')]);
    const over = intake(
      'I want to grow $2,000 over 5 years. Put 70% in AI and 50% in semiconductors.',
      r(['ai', 'semiconductors']),
    );
    expect(over.sheet).toBeNull();
    expect(fields(over)).toEqual(['sleeves']);
  });

  it('reads the share before a market: the whole, a sum, a percent, a half, or none said', () => {
    const share = (text: string) => {
      const [m] = marketMentionsIn(text).filter((x) => x.skipped === null);
      return m ? marketShareIn(text, m.at, m.end) : undefined;
    };
    expect(share('invest in big tech')).toEqual({ kind: 'whole' });
    expect(share('put $500 in big tech')).toEqual({ kind: 'amount', value: 500 });
    expect(share('put 50% in big tech')).toEqual({ kind: 'percent', value: 50 });
    expect(share('50 percent of the money in the S&P 500')).toEqual({ kind: 'percent', value: 50 });
    expect(share('put half in big tech')).toEqual({ kind: 'percent', value: 50 });
    expect(share('metade do dinheiro em IA')).toEqual({ kind: 'percent', value: 50 });
    expect(share('colocar 30% em IA')).toEqual({ kind: 'percent', value: 30 });
    expect(share('I like big tech')).toBeNull();
    // A percent that is no share of the money is none: a fall, a yield.
    expect(share('after a 20% fall in big tech')).toBeNull();
    // Two things named after one verb: the whole goes to neither.
    expect(share('invest in big tech and gold')).toBeNull();
  });
});

describe('finding 9: the model reads the portfolio the person named, it picks none', () => {
  const GOAL = 'I want to grow $5,000 over 5 years at medium risk';

  it('the review case: a portfolio in the reply that the text does not write is dropped and flagged, not asked', () => {
    const result = intake(GOAL, reply({ portfolios: ['The Seven'] }));
    expect(result.flags).toContain('no_cue:portfolios');
    expect(result.draft.themes).toBeNull();
    expect(result.questions).toEqual([]);
    expect(result.sheet?.themes).toEqual([]);
    expect((result.readBack ?? []).join(' ')).not.toMatch(/starts from|The Seven/);
    // By its slug, or one that is on no shelf: the same.
    for (const named of ['the-seven', 'Moon Rockets', 'The 500']) {
      const other = intake(GOAL, reply({ portfolios: [named] }));
      expect(other.flags, named).toContain('no_cue:portfolios');
      expect(other.flags, named).not.toContain('not_on_shelf:themes');
      expect(other.sheet?.themes, named).toEqual([]);
      expect(fields(other), named).not.toContain('themes');
    }
  });

  it('one the text writes, by its name or its slug, is kept; written and off the shelf, it is asked', () => {
    for (const written of ['The Seven', 'the seven', 'THE SEVEN', 'the-seven']) {
      const result = intake(
        `${GOAL}, starting from ${written}`,
        reply({ portfolios: ['The Seven'] }),
      );
      expect(result.flags, written).not.toContain('no_cue:portfolios');
      expect(result.sheet?.themes, written).toEqual(['the-seven']);
      expect(result.readBack, written).toContain('The plan starts from The Seven.');
    }
    // The model names it by its slug, the text by its name.
    const bySlug = intake(`${GOAL}, starting from The Seven`, reply({ portfolios: ['the-seven'] }));
    expect(bySlug.sheet?.themes).toEqual(['the-seven']);
    // Two named by the model, one written: the one written is kept, the other dropped and flagged.
    const one = intake(
      `${GOAL}, starting from The Seven`,
      reply({ portfolios: ['The Seven', 'The 500'] }),
    );
    expect(one.flags).toContain('no_cue:portfolios');
    expect(one.sheet?.themes).toEqual(['the-seven']);
    // Written, and not on the shelf of the person's chain: asked, as before.
    const off = intake(
      `${GOAL}, starting from Moon Rockets`,
      reply({ portfolios: ['Moon Rockets'] }),
    );
    expect(off.flags).toContain('not_on_shelf:themes');
    expect(off.flags).not.toContain('no_cue:portfolios');
    expect(fields(off)).toEqual(['themes']);
    // A name that is part of another word is not written.
    const inside = intake(`${GOAL}. I am seventeen`, reply({ portfolios: ['Seven'] }));
    expect(inside.flags).toContain('no_cue:portfolios');
  });
});

describe('a time frame is said back the way the person said it', () => {
  const first = (text: string, r: unknown, over: Partial<IntakeInput> = {}) =>
    intake(text, r, over).readBack?.[0];

  it('"about 5 years" comes back in years, months in months, and a date as a date', () => {
    expect(first('I have $5,000 to grow for about 5 years, at medium risk', reply())).toBe(
      'You set a goal to grow with $5,000 over 5 years, at medium risk.',
    );
    expect(first('I have $5,000 to grow for 60 months, at medium risk', reply())).toBe(
      'You set a goal to grow with $5,000 over 60 months, at medium risk.',
    );
    expect(
      first('I want to grow $5,000 over 18 months, at medium risk', reply({ horizonMonths: 18 })),
    ).toBe('You set a goal to grow with $5,000 over 18 months, at medium risk.');
    // "By 2031" from October 2026: January 2031, as the months are counted.
    expect(NOW).toBe('2026-10');
    expect(
      first('I want to grow $5,000 by 2031, at medium risk', reply({ horizonMonths: 51 })),
    ).toBe('You set a goal to grow with $5,000 by January 2031, at medium risk.');
    expect(
      first('I want to grow $5,000 for a year, at medium risk', reply({ horizonMonths: 12 })),
    ).toBe('You set a goal to grow with $5,000 over 1 year, at medium risk.');
    // In Portuguese.
    const pt = (over: Record<string, unknown>) => reply({ language: 'pt', ...over });
    expect(first('Quero fazer US$ 5.000 crescer por 5 anos, com risco médio', pt({}))).toBe(
      'Você definiu um objetivo de crescimento com US$ 5.000 em 5 anos, com risco médio.',
    );
    expect(
      first('Quero fazer US$ 5.000 crescer por um ano, com risco médio', pt({ horizonMonths: 12 })),
    ).toBe('Você definiu um objetivo de crescimento com US$ 5.000 em 1 ano, com risco médio.');
    expect(
      first(
        'Quero fazer US$ 5.000 crescer em 18 meses, com risco médio',
        pt({ horizonMonths: 18 }),
      ),
    ).toBe('Você definiu um objetivo de crescimento com US$ 5.000 em 18 meses, com risco médio.');
    expect(
      first('Quero fazer US$ 5.000 crescer até 2031, com risco médio', pt({ horizonMonths: 51 })),
    ).toBe(
      'Você definiu um objetivo de crescimento com US$ 5.000 até janeiro de 2031, com risco médio.',
    );
    // With a mix the line names no risk, and the years are said the same way.
    expect(
      first(
        'I want to grow $5,000 over 5 years, all of it in stocks',
        reply({ risk: null, mix: pct(100, 0) }),
      ),
    ).toBe('You set a goal to grow with $5,000 over 5 years.');
  });

  it('months the text does not write are said in months; the last way the text writes them is the one said', () => {
    // An answer on the form, where the text writes no time frame.
    expect(
      first('I want to grow $5,000 at medium risk', reply({ horizonMonths: null }), {
        answers: { horizonMonths: 60 },
      }),
    ).toBe('You set a goal to grow with $5,000 over 60 months, at medium risk.');
    // An answer that differs from what the text writes is the answer's months.
    expect(
      first('I want to grow $5,000 over 5 years at medium risk', reply(), {
        answers: { horizonMonths: 48 },
      }),
    ).toBe('You set a goal to grow with $5,000 over 48 months, at medium risk.');
    // An answer that is what the text writes is said as the text writes it.
    expect(
      first('I want to grow $5,000 over 5 years at medium risk', reply(), {
        answers: { horizonMonths: 60 },
      }),
    ).toBe('You set a goal to grow with $5,000 over 5 years, at medium risk.');
    // Years first, then the same time in months on a later turn: the last way written.
    expect(
      first(
        conversationText('I want to grow $5,000 over 5 years at medium risk', [
          'make it for 60 months',
        ]),
        reply(),
      ),
    ).toBe('You set a goal to grow with $5,000 over 60 months, at medium risk.');
    // No date: no time frame is said at all.
    const open = intake(
      'I want to grow $5,000 at medium risk, no deadline',
      reply({ horizonMonths: null, openEnded: true }),
    );
    expect(open.readBack?.[0]).toBe(
      'You set a goal to grow with $5,000, with no date set, at medium risk.',
    );
    // The sheet holds months whatever is said.
    expect(
      intake('I have $5,000 to grow for about 5 years, at medium risk').sheet?.horizonMonths,
    ).toBe(60);
  });

  it('reads how each time frame is written', () => {
    const said = (text: string) => timeFramesIn(text, NOW).map((t) => [t.months, t.said]);
    expect(said('for about 5 years')).toEqual([[60, 'years']]);
    expect(said('over 60 months')).toEqual([[60, 'months']]);
    expect(said('by 2031')).toEqual([[51, 'date']]);
    expect(said('for a year')).toEqual([[12, 'years']]);
    expect(said('por um ano')).toEqual([[12, 'years']]);
    expect(said('em 18 meses')).toEqual([[18, 'months']]);
    // An age and a time to get out are no time frame.
    expect(said('I am 30 years old and want to invest for 10 years')).toEqual([[120, 'years']]);
    expect(said('can take up to 3 months to get out')).toEqual([]);
  });
});

describe('a share or a mix said in words on a later turn is read as the answer it is', () => {
  const FIRST = 'I want to grow $2,000 over 5 years. I like big tech';
  const THEME = 'I want to grow $2,000 over 5 years. I like semiconductors';
  const r = (over: Record<string, unknown> = {}) => reply({ amountUsd: 2000, risk: null, ...over });
  const bigTech = r({ markets: ['big_tech'] });
  const semis = r({ markets: ['semiconductors'] });

  it('turn 1 asks how much of the money, once, and never the risk', () => {
    expect(intake(FIRST, bigTech).questions).toEqual([
      { field: 'mix', template: 'marketShare', text: 'How much of the $2,000 for big tech?' },
    ]);
    expect(intake(THEME, semis).questions).toEqual([
      { field: 'mix', template: 'marketShare', text: 'How much of the $2,000 for semiconductors?' },
    ]);
  });

  it('"70-30", "half", "all of it", a percent, a sum and a stated mix answer it, for a shared portfolio', () => {
    for (const [words, growthBps] of [
      ['70-30', 7000],
      ['its 70-30', 7000],
      ['70/30', 7000],
      ['half', 5000],
      ['make it half please', 5000],
      ['all of it', 10_000],
      ['everything', 10_000],
      ['50%', 5000],
      ['$500', 2500],
      ['500 dollars', 2500],
      ['all of it in stocks', 10_000],
      ['70% stocks and 30% cash', 7000],
      ['metade', 5000],
      ['tudo', 10_000],
    ] as const) {
      const result = intake(conversationText(FIRST, [words]), bigTech);
      expect(result.flags, words).toContain('mix_from_words');
      expect(result.questions, words).toEqual([]);
      expect(result.sheet?.mix, words).toEqual(bps(growthBps, 10_000 - growthBps));
      expect(result.sheet?.themes, words).toEqual(['the-seven']);
      expect(result.sheet?.risk, words).toBe(riskForMixEstimate({ growthBps }));
      // With no model the same words are read the same way.
      const rules = intake(conversationText(FIRST, [words]), null, {
        answers: { ...ANSWERED, amountUsd: 2000 },
      });
      expect(rules.sheet?.mix, `${words} rules`).toEqual(bps(growthBps, 10_000 - growthBps));
    }
  });

  it('the same words answer it for a theme: that share is the theme sleeve, the rest kept safe', () => {
    for (const [words, shareBps] of [
      ['70-30', 7000],
      ['half', 5000],
      ['all of it', 10_000],
      ['all of it in stocks', 10_000],
      ['$500', 2500],
      ['50%', 5000],
    ] as const) {
      const result = intake(conversationText(THEME, [words]), semis);
      expect(result.flags, words).toEqual(
        expect.arrayContaining(['mix_from_words', 'sleeves_from_mix_answer']),
      );
      expect(result.questions, words).toEqual([]);
      expect(result.sheet?.sleeves, words).toEqual(
        shareBps === 10_000
          ? [theme('semiconductors')]
          : [theme('semiconductors', shareBps), safe(10_000 - shareBps)],
      );
      expect(result.sheet?.mix, words).toBeUndefined();
    }
  });

  it('whatever the model makes of the short reply, the words are read the same', () => {
    // The model sees the two messages with no question between them: it may read nothing, call the
    // split unclear, read a split either way round, or read a mix.
    const readings: Record<string, unknown>[] = [
      {},
      { unclear: ['sleeves'] },
      {
        sleeves: [
          { kind: 'safe_yield', sharePct: 70 },
          { kind: 'goal', sharePct: 30 },
        ],
      },
      {
        sleeves: [
          { kind: 'goal', sharePct: 70 },
          { kind: 'safe_yield', sharePct: 30 },
        ],
      },
      { mix: pct(70, 30) },
      { mix: pct(30, 70) },
    ];
    for (const reading of readings) {
      const result = intake(conversationText(FIRST, ['70-30']), { ...bigTech, ...reading });
      const where = JSON.stringify(reading);
      expect(result.questions, where).toEqual([]);
      expect(result.sheet?.mix, where).toEqual(bps(7000, 3000));
      expect(result.sheet?.sleeves, where).toBeUndefined();
      const themed = intake(conversationText(THEME, ['70-30']), { ...semis, ...reading });
      expect(themed.questions, where).toEqual([]);
      expect(themed.sheet?.sleeves, where).toEqual([theme('semiconductors', 7000), safe(3000)]);
    }
  });

  it('the answer stays on the turns after it, and an answer on the form wins over the words', () => {
    const later = intake(conversationText(FIRST, ['half', 'thanks, that is all']), bigTech);
    expect(later.questions).toEqual([]);
    expect(later.sheet?.mix).toEqual(bps(5000, 5000));
    const form = intake(conversationText(FIRST, ['half']), bigTech, {
      answers: { mix: bps(2000, 8000) },
    });
    expect(form.flags).not.toContain('mix_from_words');
    expect(form.sheet?.mix).toEqual(bps(2000, 8000));
    // The same conversation read 10 times gives one answer.
    const sent = Array.from({ length: 10 }, () =>
      JSON.stringify(intake(conversationText(FIRST, ['70-30']), bigTech)),
    );
    expect(new Set(sent).size).toBe(1);
  });

  it('the generic question is answered in the order it asks: stocks first, then cash', () => {
    const wondered = 'I want to grow $2,000 over 5 years. Should I put all of it in stocks?';
    expect(fields(intake(wondered, r()))).toEqual(['mix']);
    for (const [words, growthBps] of [
      ['70-30', 7000],
      ['half and half', 5000],
      ['60%', 6000],
      ['all of it in stocks', 10_000],
      ['half stocks, half cash', 5000],
    ] as const) {
      const result = intake(conversationText(wondered, [words]), r());
      expect(result.questions, words).toEqual([]);
      expect(result.sheet?.mix, words).toEqual(bps(growthBps, 10_000 - growthBps));
    }
    // "All of it" and a sum say how much for a market, and nothing of how the whole is held: asked
    // again, not guessed.
    for (const words of ['all of it', '$500']) {
      const result = intake(conversationText(wondered, [words]), r());
      expect(result.mix, words).toBeNull();
      expect(fields(result), words).toContain('mix');
    }
  });

  it('words that are no share, or that answer no open question, are not taken for one', () => {
    // More than a share: read with the rest of the text, by the same checks, and asked again.
    const more = intake(conversationText(FIRST, ['70-30 between safe and risky']), bigTech);
    expect(more.flags).not.toContain('mix_from_words');
    expect(more.mix).toBeNull();
    expect(more.sheet).toBeNull();
    const none = intake(conversationText(FIRST, ['I am not sure yet']), bigTech);
    expect(none.flags).not.toContain('mix_from_words');
    expect(fields(none)).toEqual(['mix']);
    // No question about what is held was open: "half" is no mix of its own.
    const plain = 'I want to grow $2,000 over 5 years';
    const half = intake(conversationText(plain, ['half']), r());
    expect(half.flags).not.toContain('mix_from_words');
    expect(half.mix).toBeNull();
    // A mix question that is there only because the model read a mix from the short reply itself was
    // never asked of the person: the reply is not taken as its answer. It is asked, with the model's
    // reading as the start.
    const guessed = intake(conversationText(plain, ['70-30']), r({ mix: pct(70, 30) }));
    expect(guessed.flags).not.toContain('mix_from_words');
    expect(guessed.mix).toBeNull();
    expect(guessed.questions.find((q) => q.field === 'mix')).toMatchObject({
      template: 'mix',
      read: bps(7000, 3000),
    });
    // A market the chain has nothing for asks no share, so a share said after it answers nothing.
    const off = intake(
      conversationText('I want to grow $2,000 over 5 years. I like space stocks', ['half']),
      {
        ...r({ markets: ['space'] }),
      },
    );
    expect(off.flags).not.toContain('mix_from_words');
    expect(off.mix).toBeNull();
    expect(off.draft.sleeves).toBeNull();
  });

  it('reads a share only where the message says nothing else', () => {
    expect(shareSaidIn('70-30')).toEqual({ kind: 'pair', first: 70, second: 30 });
    expect(shareSaidIn('70 e 30')).toEqual({ kind: 'pair', first: 70, second: 30 });
    expect(shareSaidIn('half')).toEqual({ kind: 'percent', value: 50 });
    expect(shareSaidIn('50%')).toEqual({ kind: 'percent', value: 50 });
    expect(shareSaidIn('100%')).toEqual({ kind: 'whole' });
    expect(shareSaidIn('all of it')).toEqual({ kind: 'whole' });
    expect(shareSaidIn('$500')).toEqual({ kind: 'amount', value: 500 });
    for (const words of [
      '70-30 between safe and risky',
      '80-30',
      '0%',
      '150%',
      'yes',
      'half of my friends do this',
      'all of it in stocks',
      'R$ 500',
    ])
      expect(shareSaidIn(words), words).toBeNull();
  });

  it('a long text in many paragraphs is read as one message: only its last few are tried as answers', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Note ${i + 1}.`).join('\n\n');
    const text = `${FIRST}\n\n${many}\n\nhalf`;
    const result = intake(text, bigTech);
    expect(result.questions).toEqual([]);
    expect(result.sheet?.mix).toEqual(bps(5000, 5000));
  });
});

describe('a mix said of a part of the money is asked, never guessed', () => {
  const text = 'I want to grow $2,000 over 5 years: 70% safe, and the other 30% all in stocks';

  it('"70% safe, and the other 30% all in stocks" is no plan all in stocks', () => {
    expect(mixIn(text)).toBeNull();
    expect(mixSaidIn(text)?.stance).toBe('part');
    const split = {
      sleeves: [
        { kind: 'safe_yield', sharePct: 70 },
        { kind: 'goal', sharePct: 30 },
      ],
    };
    const asked = intake(text, reply({ amountUsd: 2000, risk: null, ...split }));
    expect(asked.mix).toBeNull();
    expect(asked.flags).toEqual(expect.arrayContaining(['mix_part', 'mix_asked:part']));
    // Asked once, with no start: the intake does not guess what the whole would hold.
    expect(asked.questions).toEqual([
      {
        field: 'mix',
        template: 'mix',
        text: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
      },
    ]);
    // The person says it as a mix of the whole, or keeps the split they wrote.
    const mixed = intake(text, reply({ amountUsd: 2000, risk: null, ...split }), {
      answers: { mix: bps(3000, 0, 7000) },
    });
    expect(mixed.sheet?.mix).toEqual(bps(3000, 0, 7000));
    expect(mixed.sheet?.sleeves).toBeUndefined();
    const kept = intake(text, reply({ amountUsd: 2000, risk: null, ...split }), {
      answers: { mix: null, risk: 'high' },
    });
    expect(kept.sheet?.mix).toBeUndefined();
    expect(kept.sheet?.sleeves).toEqual([safe(7000), { kind: 'goal', shareBps: 3000 }]);
    // With no model: asked too.
    const rules = intake(text, null);
    expect(rules.mix).toBeNull();
    expect(fields(rules)).toContain('mix');
  });
});

// ---------------------------------------------------------------------------------------------------
// The second independent review (Oct 7), on the intake: its scripts b1 to b7 (`review2-intake`).
//
// The fix for the first review was a list of the ways a clause turns a holding down, and the second
// showed that such a list cannot be finished: most of its new sentences were still read as stated.
// So the rules these cases hold are no list of phrases. Each says who must read a holding before it
// is taken:
//   1. With a model, a holding needs both readers: the model's reply and the text check. Words the
//      text check finds that the reply does not read are not taken, not asked and not said.
//   2. With no model, a holding the text check reads is asked once, its reading the start, and is
//      never taken. A question has a way out ("none") and does not come back once answered.
//   3. The last word wins: a later message decides over an earlier one.
//   4. A refusal the text states is taken, with or without a model; one the model did not read is
//      said in a line of its own; a refusal and a holding of one class are asked, never both held.
//   5. A share is taken only in its plain forms.
// Rules 6 and 7 (a filter never picks one stock; what a caller hands in) are in narratives.test.ts.
//
// Every sentence of the review's scripts is a case, on both paths: with the model reply its script
// used, and with none. The replies are MOCK, written by hand. The labels and the attributes are MOCK,
// set to what the review's shelf held for each case. No test reaches a network.
describe('the second review (Oct 7): every sentence of its scripts, with a model and with none', () => {
  // What the stocks' attributes carry on this MOCK shelf, by `attributeKey`, and how many of those
  // names the chain lists: one car maker, two names in a broad sector, as the review's shelf had.
  const ATTRIBUTES_2: Record<string, FilterMatch> = {
    ...ATTRIBUTES,
    'industry:automobiles': { value: 'Automobiles', listed: 1 },
    'sub_industry:automobile-manufacturers': { value: 'Automobile Manufacturers', listed: 1 },
    'sector:consumer-discretionary': { value: 'Consumer Discretionary', listed: 2 },
    'industry:semiconductors-semiconductor-equipment': {
      value: 'Semiconductors & Semiconductor Equipment',
      listed: 1,
    },
    'keyword:bitcoin-treasury': { value: 'bitcoin treasury', listed: 1 },
    'keyword:index-fund': { value: 'index fund', listed: 3 },
    'keyword:cloud': { value: 'cloud', listed: 5 },
  };
  const matchOf2 = (filter: MarketFilter): FilterMatch | null =>
    ATTRIBUTES_2[`${filter.by}:${attributeKey(filter.value)}`] ?? null;
  /** The reply of the review's scripts where a faithful model reads no holding: every field null. */
  const NOTHING_READ = reply({ goal: null, amountUsd: null, horizonMonths: null, risk: null });
  /**
   * The form answers its scripts gave: the goal, the amount and the time; and the risk, so that what
   * is left to ask is only what a holding raises.
   */
  const FORM: IntakeAnswers = { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'medium' };
  const read = (text: string, r: unknown, answers: IntakeAnswers = FORM) =>
    intake(text, r, { matchOf: matchOf2, answers });
  type Result = ReturnType<typeof read>;
  /** What a sheet holds of a mix, a theme or a shared portfolio; nothing where there is no sheet. */
  const heldBy = (r: Result) => ({
    mix: r.sheet?.mix ?? null,
    sleeves: r.sheet?.sleeves ?? null,
    themes: r.sheet?.themes ?? [],
  });
  const NOTHING_HELD = { mix: null, sleeves: null, themes: [] };
  /** The questions about what is held: a mix, a share of the money, a split. */
  const askedOfAHolding = (r: Result) =>
    r.questions.filter((q) => q.field === 'mix' || q.field === 'sleeves');
  /** The lines that say a holding: a part of the plan, a theme, the limits a holding takes. */
  const SAYS_A_HOLDING =
    /% of the plan|% do plano|limits for|limites de|starts from|parte de|matched by|filtrados por/;
  const saidOfAHolding = (r: Result) =>
    [...(r.readBack ?? []), ...r.assumptions].filter((s) => SAYS_A_HOLDING.test(s));

  const STOCKS = bps(10_000, 0);
  const CASH = bps(0, 10_000);
  const GOLD = bps(0, 0, 0, 10_000);
  const SIXTY_FORTY = bps(6000, 0, 4000);
  const HALVES = bps(5000, 5000);

  // b1: a mix written in a clause that does not state it as what the person wants held. How the text
  // check reads each: `stated` (it cannot tell, and reads the mix in the third column), `negated` or
  // `aside` (it reads the clause), `unread` (it reads no mix).
  const B1: [string, 'stated' | 'negated' | 'aside' | 'unread', ReturnType<typeof bps>?][] = [
    ['I have all my money in stocks and want to diversify', 'stated', STOCKS],
    ['My savings are all in cash and I want to grow them', 'stated', CASH],
    ["Today I'm all in crypto and it's stressing me out", 'stated', STOCKS],
    ["I'm tired of being all in on stocks", 'stated', STOCKS],
    ["I'm worried about having everything in stocks", 'stated', STOCKS],
    ['I want to stop being all in on stocks', 'stated', STOCKS],
    ['I want to move away from everything in crypto', 'stated', STOCKS],
    ['Being all in stocks cost me a lot in 2022', 'stated', STOCKS],
    ['I lost money going all in on crypto', 'stated', STOCKS],
    ["I'm scared of putting all of it in stocks", 'stated', STOCKS],
    ['all in stocks is what I want to avoid', 'stated', STOCKS],
    ['all in stocks makes me nervous', 'stated', STOCKS],
    ['Only stocks worries me', 'stated', STOCKS],
    ['Only stocks keeps me up at night', 'stated', STOCKS],
    ['I heard only stocks is the way to go but I am cautious', 'stated', STOCKS],
    ['Everyone tells me to go all in on crypto', 'aside'],
    ['The last thing I want is everything in crypto', 'stated', STOCKS],
    ['I regret going all in on crypto', 'stated', STOCKS],
    ["I'd hate to have everything in stocks", 'negated'],
    ["No way I'm putting everything in crypto", 'negated'],
    ['It would be foolish to put everything into bitcoin', 'stated', STOCKS],
    ['Under no circumstances all in stocks', 'negated'],
    ["I'm too old to go all in on stocks", 'stated', STOCKS],
    ['People who go all in on stocks get burned', 'aside'],
    ['100% stocks is too much for me', 'negated'],
    ["I can't stomach 80% stocks and 20% cash", 'negated'],
    ['My wife wants 70% stocks and 30% cash but I disagree', 'aside'],
    ['Would 60/40 stocks and bonds be ok', 'stated', SIXTY_FORTY],
    ['half stocks, half cash is what my dad did', 'stated', HALVES],
    ['I only want stocks if the market is cheap', 'stated', STOCKS],
    ['just cash for now, stocks later', 'stated', CASH],
    ['My advisor says stocks only', 'stated', STOCKS],
    ['stocks only? no thanks', 'negated'],
    ['I keep everything in gold at home', 'stated', GOLD],
    ['Right now I have everything in bitcoin', 'stated', STOCKS],
    ['I sold everything in stocks last year', 'stated', STOCKS],
    ['My pension is all in stocks, so this money should be calm', 'stated', STOCKS],
    ['I inherited a portfolio that is all in stocks', 'stated', STOCKS],
    ['I am fully invested in equities at work and want this safe', 'stated', STOCKS],
    ['less of everything in stocks, more balance', 'stated', STOCKS],
    ['Less than all of it in stocks', 'stated', STOCKS],
    ['A friend put all of it in gold. I want something else', 'stated', GOLD],
    ['Tenho tudo em ações e quero diversificar', 'stated', STOCKS],
    ['Hoje está tudo em caixa e quero fazer render', 'stated', CASH],
    ['Cansei de ter tudo em ações', 'stated', STOCKS],
    ['Tenho medo de colocar tudo em ações', 'stated', STOCKS],
    ['Tudo em ações me assusta', 'stated', STOCKS],
    ['Tudo em cripto foi meu erro', 'stated', STOCKS],
    ['Perdi dinheiro com tudo em cripto', 'stated', STOCKS],
    ['Meu gerente disse só ações, eu discordo', 'stated', STOCKS],
    ['Só ações me deixa nervoso', 'stated', STOCKS],
    ['Deus me livre de tudo em bolsa', 'stated', STOCKS],
    ['Jamais tudo em ações', 'stated', STOCKS],
    ['Prefiro fugir de tudo em cripto', 'stated', STOCKS],
    ['Minha previdência está toda em ações, então aqui quero calma', 'unread'],
    ['Se eu fosse jovem colocaria tudo em ações', 'stated', STOCKS],
  ];

  it('b1, rules 1 and 2: a mix its clause does not state is not taken, asked or said with a model that reads none, and is asked once with no model', () => {
    expect(B1).toHaveLength(56);
    for (const [sentence, how, mix] of B1) {
      // With a model that reads no mix: the words the text check finds are not taken, not asked and
      // not said, however the check itself reads the clause.
      const model = read(sentence, NOTHING_READ);
      expect(model.mix, sentence).toBeNull();
      expect(model.questions, sentence).toEqual([]);
      expect(model.sheet, sentence).toMatchObject({ goal: 'grow', risk: 'medium' });
      expect(heldBy(model), sentence).toEqual(NOTHING_HELD);
      expect(saidOfAHolding(model), sentence).toEqual([]);
      expect(
        model.flags.filter((f) => /^text_only:|^mix_/.test(f)),
        sentence,
      ).toEqual(how === 'stated' ? ['text_only:mix'] : how === 'unread' ? [] : [`mix_${how}`]);
      // With no model: never taken. Where the text check reads it as stated, it is the only reader,
      // so it asks once with its reading as the start. Where it reads the clause, nothing is asked.
      const rules = read(sentence, null);
      expect(rules.mix, sentence).toBeNull();
      expect(heldBy(rules), sentence).toEqual(NOTHING_HELD);
      const asked = rules.questions.filter((q) => q.field === 'mix');
      if (how !== 'stated') {
        expect(asked, sentence).toEqual([]);
        continue;
      }
      expect(rules.sheet, sentence).toBeNull();
      expect(rules.questions, sentence).toHaveLength(1);
      expect(asked[0], sentence).toMatchObject({ template: 'mix', read: mix });
      expect(rules.flags, sentence).toContain('mix_asked:rules');
      // The way out: "none" answers it, the question does not come back, and no mix is held.
      const none = read(sentence, null, { ...FORM, mix: null });
      expect(none.questions, sentence).toEqual([]);
      expect(heldBy(none), sentence).toEqual(NOTHING_HELD);
      expect(saidOfAHolding(none), sentence).toEqual([]);
    }
  });

  it('b1 and b2, a year gone by is no date the money is needed by: the glide stays off', () => {
    // Found by these sentences: "in 2022" turned the glide on, and the read-back said the plan
    // would move to cash as a date neared that nobody had named.
    for (const sentence of [
      'Being all in stocks cost me a lot in 2022',
      'I got burned by big tech in 2022',
    ]) {
      const result = read(sentence, NOTHING_READ);
      expect(result.sheet?.rules.glide, sentence).toBe(false);
      expect((result.readBack ?? []).join(' '), sentence).not.toMatch(/As the date nears/);
    }
    // A year to come still is one.
    expect(
      intake('I want to grow $5,000 by 2031, at medium risk', reply({ horizonMonths: 51 })).sheet
        ?.rules.glide,
    ).toBe(true);
  });

  // b2: a narrative's words that are not about investing, or said of something else. The id is the
  // narrative the text check reads as an ask, null where it reads none; then its words, and what the
  // no-model path does with it on this shelf: `asked` (how much of the money, once) or `said` (the
  // chain has nothing for it, in one line).
  const B2: ([string, null] | [string, Market, string, 'asked' | 'said'])[] = [
    ['I work in AI and have $5,000 to invest', null],
    ['The space between jobs left me with $5,000 to invest', null],
    ['In defense of my plan, I want low risk', null],
    ['I have a cloud of doubt about the market right now', 'cloud_software', 'cloud', 'asked'],
    [
      'After chips and salsa at the party we talked about investing',
      'semiconductors',
      'chips',
      'asked',
    ],
    ['I spend too much on chips, so I want to save', 'semiconductors', 'chips', 'asked'],
    ['My car needs an oil change, so I can only invest $200 a month', 'commodities', 'oil', 'said'],
    ['The silver lining is that I have $5,000 to invest', 'commodities', 'silver', 'said'],
    ['I am in software sales and want to invest my bonus', 'cloud_software', 'software', 'asked'],
    ['I got this money from selling my cloud consulting business', null],
    ['My kid loves rockets and I am saving for his college', 'space', 'rockets', 'said'],
    ['I am from Asia and want to invest for 10 years', 'emerging_markets', 'Asia', 'said'],
    ['I am in space research and have some savings', 'space', 'space', 'said'],
    ['I am tired of brokers charging me fees', 'fintech', 'brokers', 'said'],
    ['ChatGPT and other AI tools told me to keep it simple', 'ai', 'AI', 'asked'],
    ['After I pay off the EV I can invest more', 'ev_autonomy', 'EV', 'said'],
    ['I use AI at work every day. I want something safe.', 'ai', 'AI', 'asked'],
    ['I read about AI in the news, not sure what to do', 'ai', 'AI', 'asked'],
    ['I do not understand AI so keep it simple', null],
    ['My pharma job pays well and I can invest $5,000', null],
    [
      'I am a nurse in health care and want to grow my savings',
      'health_care',
      'health care',
      'said',
    ],
    ['I spend a lot in health care each year', 'health_care', 'health care', 'said'],
    ['Software ate my weekend, anyway I have $5,000', 'cloud_software', 'Software', 'asked'],
    [
      'I sold my Tesla, EVs are expensive to insure, and now I have cash to invest',
      'ev_autonomy',
      'EVs',
      'said',
    ],
    ['The oil and gas bill is killing me', 'commodities', 'oil and gas', 'said'],
    ['I play quantum chess, anyway invest my money safely', 'quantum', 'quantum', 'said'],
    ['Put my money to work in the cloud of uncertainty we live in', null],
    ['I lost money in emerging markets once', 'emerging_markets', 'emerging markets', 'said'],
    ['Nothing fancy like quantum computing', 'quantum', 'quantum computing', 'said'],
    ['Unlike my friends I am not into meme stocks', null],
    ['Forget about AI', 'ai', 'AI', 'asked'],
    ['AI is overhyped', 'ai', 'AI', 'asked'],
    ['AI is a bubble and I want nothing to do with it', 'ai', 'AI', 'asked'],
    ['Stay clear of big tech', 'big_tech', 'big tech', 'asked'],
    ['I am skeptical of big tech', 'big_tech', 'big tech', 'asked'],
    ['Big tech is too expensive now', null],
    ['I think AI will crash', 'ai', 'AI', 'asked'],
    ['I would skip semiconductors', 'semiconductors', 'semiconductors', 'asked'],
    ['Less AI, more boring things', 'ai', 'AI', 'asked'],
    ['Semiconductors scare me', 'semiconductors', 'Semiconductors', 'asked'],
    ['I got burned by big tech in 2022', 'big_tech', 'big tech', 'asked'],
    [
      'My portfolio at the bank is big tech heavy, so this one should differ',
      'big_tech',
      'big tech',
      'asked',
    ],
    ['I hold the S&P 500 at my broker', null],
    ['Besides my index funds I want something safe', null],
    ['Gasto muito em saúde e quero guardar dinheiro', 'health_care', 'saúde', 'said'],
    ['Trabalho com IA e quero investir meu bônus', null],
    ['Ai, não sei o que fazer com esse dinheiro', null],
    ['As corretoras cobram muito, quero algo simples', 'fintech', 'corretoras', 'said'],
    ['Ganhei uma medalha de prata e um prêmio em dinheiro', 'commodities', 'prata', 'said'],
    ['O preço do petróleo me preocupa', 'commodities', 'petróleo', 'said'],
    ['IA é uma bolha', 'ai', 'IA', 'asked'],
    ['Fujo de big tech', 'big_tech', 'big tech', 'asked'],
    ['Tenho medo de semicondutores', 'semiconductors', 'semicondutores', 'asked'],
    ['Chega de big tech', 'big_tech', 'big tech', 'asked'],
    ['Minha filha estuda na Ásia e preciso pagar a faculdade', null],
    ['Vi na nuvem de notícias que o mercado caiu', 'cloud_software', 'nuvem', 'asked'],
  ];

  it('b2, rules 1 and 2: words of a narrative that are no ask are not read, asked or said with a model that names none; with no model they are asked once or said, never held', () => {
    expect(B2).toHaveLength(56);
    for (const [sentence, id, words, rulesPath] of B2) {
      const model = read(sentence, NOTHING_READ);
      expect(model.narratives, sentence).toEqual([]);
      expect(model.questions, sentence).toEqual([]);
      expect(heldBy(model), sentence).toEqual(NOTHING_HELD);
      expect(saidOfAHolding(model), sentence).toEqual([]);
      expect(
        model.assumptions.filter((s) => /no stock|only one stock|nenhuma ação|só uma ação/.test(s)),
        sentence,
      ).toEqual([]);
      expect(
        model.flags.filter((f) => /^text_only:|^market_|^no_cue:market/.test(f)),
        sentence,
      ).toEqual(id ? [`text_only:market:${id}`] : []);
      const rules = read(sentence, null);
      expect(rules.mix, sentence).toBeNull();
      expect(heldBy(rules), sentence).toEqual(NOTHING_HELD);
      if (!id) {
        expect(rules.narratives, sentence).toEqual([]);
        expect(rules.questions, sentence).toEqual([]);
        continue;
      }
      expect(
        rules.narratives.map((n) => [n.id, n.words]),
        sentence,
      ).toEqual([[id, words]]);
      const asked = askedOfAHolding(rules);
      if (rulesPath === 'asked') {
        // The only reader read it: how much of the money, once, with no start, and no sheet yet.
        expect(rules.sheet, sentence).toBeNull();
        expect(rules.questions, sentence).toHaveLength(1);
        expect(asked[0], sentence).toMatchObject({ field: 'mix', template: 'marketShare' });
        expect(asked[0]?.text, sentence).toContain(words);
        expect(asked[0]?.read, sentence).toBeUndefined();
        // "None" answers it for good.
        const none = read(sentence, null, { ...FORM, mix: null });
        expect(none.questions, sentence).toEqual([]);
        expect(heldBy(none), sentence).toEqual(NOTHING_HELD);
      } else {
        // Nothing on the chain for it: said in one line that names the words; nothing asked.
        expect(asked, sentence).toEqual([]);
        expect(rules.narratives[0]?.kind, sentence).toBe('none');
        expect(
          rules.assumptions.filter((s) => s.includes(`“${words}”`)),
          sentence,
        ).toHaveLength(1);
      }
    }
  });

  // b7: "invest in X" in a clause that turns it down. The text check reads each as an ask.
  const B7: [string, Market, string][] = [
    ["I'm done investing in AI", 'ai', 'AI'],
    ['I stopped investing in big tech', 'big_tech', 'big tech'],
    ['I regret investing in big tech', 'big_tech', 'big tech'],
    ['I lost money investing in semiconductors', 'semiconductors', 'semiconductors'],
    ["It's too late to invest in AI", 'ai', 'AI'],
    ["I'm afraid to invest in AI", 'ai', 'AI'],
    ["I'd be nervous putting everything in big tech", 'big_tech', 'big tech'],
    ['I got burned investing in big tech', 'big_tech', 'big tech'],
    ['Stop me from investing in AI', 'ai', 'AI'],
    ['The last thing I want is to invest in big tech', 'big_tech', 'big tech'],
    ['Only a fool would invest in AI now', 'ai', 'AI'],
    ['Please talk me out of investing in AI', 'ai', 'AI'],
    ['I am tired of hearing that I should invest in AI', 'ai', 'AI'],
    ['My bank keeps pushing me to invest in big tech', 'big_tech', 'big tech'],
    ['I think it is a bad time to invest in the S&P 500', 'us_market', 'S&P 500'],
    ['I am scared to put it in US stocks', 'us_market', 'US stocks'],
    ['It would be reckless to put it all in big tech', 'big_tech', 'big tech'],
    ['I have had enough of putting everything in AI', 'ai', 'AI'],
    ['Tenho medo de investir em IA', 'ai', 'IA'],
    ['Desisti de investir em big techs', 'big_tech', 'big techs'],
    ['Me arrependo de investir em IA', 'ai', 'IA'],
    ['É tarde demais para investir em IA', 'ai', 'IA'],
    ['Cansei de colocar tudo em big techs', 'big_tech', 'big techs'],
    ['Seria loucura investir em semicondutores agora', 'semiconductors', 'semicondutores'],
  ];

  it('b7, rules 1 and 2: "invest in X" in a clause that turns it down is not taken as the whole plan: nothing with a model that names none, one question with no model', () => {
    expect(B7).toHaveLength(24);
    for (const [sentence, id, words] of B7) {
      const model = read(sentence, NOTHING_READ);
      expect(model.narratives, sentence).toEqual([]);
      expect(model.questions, sentence).toEqual([]);
      expect(heldBy(model), sentence).toEqual(NOTHING_HELD);
      expect(saidOfAHolding(model), sentence).toEqual([]);
      expect(model.flags, sentence).toContain(`text_only:market:${id}`);
      const rules = read(sentence, null);
      expect(rules.sheet, sentence).toBeNull();
      expect(rules.mix, sentence).toBeNull();
      expect(
        rules.narratives.map((n) => [n.id, n.words]),
        sentence,
      ).toEqual([[id, words]]);
      expect(rules.questions, sentence).toHaveLength(1);
      expect(rules.questions[0], sentence).toMatchObject({ field: 'mix', template: 'marketShare' });
      expect(rules.questions[0]?.text, sentence).toContain(words);
      const none = read(sentence, null, { ...FORM, mix: null });
      expect(none.questions, sentence).toEqual([]);
      expect(heldBy(none), sentence).toEqual(NOTHING_HELD);
    }
  });

  // b3: a refusal written in a clause that negates it, hedges it or says it of something else. What
  // the text check takes as stated (rule 4: the class, and the words it read), or null and the flag
  // that says how it read the clause. A refusal lowers what the plan may hold, so one the check
  // reads as stated is taken on both paths, and is said: with a model that did not read it, in a
  // line of its own that names the words; with no model, in the read-back the person confirms.
  type Taken = 'stock' | 'crypto' | 'gold' | 'credit';
  const B3: ([string, Taken, string, 'beside a holding'?] | [string, null, string | null])[] = [
    ['A portfolio without stocks makes no sense to me', 'stock', 'without stocks'],
    ['without stocks my plan is incomplete', 'stock', 'without stocks'],
    ['no stocks is what my wife says, but I disagree', 'stock', 'no stocks'],
    ['It would be silly to avoid stocks', 'stock', 'avoid stocks'],
    ["There's no reason to avoid stocks", 'stock', 'avoid stocks'],
    ['I see no reason to exclude crypto', 'crypto', 'exclude crypto'],
    ["I'd be crazy to avoid stocks at my age", 'stock', 'avoid stocks'],
    ["It's a mistake to stay away from stocks", 'stock', 'stay away from stocks'],
    ['Nobody should avoid stocks at my age', 'stock', 'avoid stocks'],
    ['I stopped avoiding stocks last year', 'stock', 'avoiding stocks'],
    ['I no longer avoid crypto', null, 'refusal_aside:crypto'],
    ["I'm done avoiding stocks", 'stock', 'avoiding stocks'],
    ['Zero stocks today, which I want to change', 'stock', 'Zero stocks'],
    ['So far nothing in crypto, which I want to change', 'crypto', 'nothing in crypto'],
    ['Currently zero crypto in my wallet, time to add some', 'crypto', 'zero crypto'],
    ['no funds needed before then, so I can take risk', null, null],
    ['I need no funds from this until 2031', null, null],
    ['no stocks are too risky for me', 'stock', 'no stocks'],
    ['I am not one of those no stocks people', null, 'refusal_negated:stock'],
    ['The no crypto crowd is wrong', 'crypto', 'no crypto'],
    ['I was told no stocks at my age, which is nonsense', null, 'refusal_aside:stock'],
    ['Do not leave me with no stocks', null, 'refusal_negated:stock'],
    ['Make sure I am never without stocks', null, 'refusal_negated:stock'],
    ['I want stocks, never mind gold', null, 'refusal_aside:gold'],
    ['Why would anyone want no stocks', 'stock', 'no stocks'],
    ['If there were no stocks I would be bored', null, 'refusal_aside:stock'],
    ['Excluding stocks would be a mistake', 'stock', 'Excluding stocks'],
    ['I have no fear of crypto', null, 'refusal_negated:crypto'],
    ['I have zero doubts about stocks', null, 'refusal_negated:stock'],
    ['no gold coins at home, so I want some gold here', 'gold', 'no gold'],
    ['I own no gold and would like some', null, 'refusal_aside:gold'],
    ['There is no gold in my portfolio and I want some', null, 'refusal_aside:gold'],
    ['With no credit card debt I can invest more', null, 'refusal_aside:credit'],
    ['I have no loans and no debts', null, 'refusal_aside:credit'],
    ['My loans are paid, no loans anymore', 'credit', 'no loans'],
    ['Without credit I could not have bought my house', 'credit', 'Without credit'],
    ['No stocks in my IRA, so here I want all stocks', 'stock', 'No stocks', 'beside a holding'],
    ['My last plan had no stocks and went nowhere', 'stock', 'no stocks'],
    ['My advisor told me no crypto, I think he is wrong', 'crypto', 'no crypto'],
    ['no equity in my house yet', 'stock', 'no equity'],
    ['I have no shares in my company anymore', null, 'refusal_aside:stock'],
    ['never bitcoin? I think that is outdated', null, 'refusal_wondered:crypto'],
    ['I avoid nothing: stocks, crypto, gold, all fine', null, null],
    ['Avoiding crypto was my mistake', 'crypto', 'Avoiding crypto'],
    ['Ficar sem ações seria um erro', 'stock', 'sem ações'],
    ['Sem ações não dá', 'stock', 'Sem ações'],
    ['Fora ações, o que mais vocês têm?', 'stock', 'Fora ações'],
    ['Não faz sentido ficar sem ações', null, 'refusal_negated:stock'],
    ['Nenhuma ação na carteira hoje, quero começar', 'stock', 'Nenhuma ação'],
    ['Quem fica sem cripto perde', 'crypto', 'sem cripto'],
    ['Seria besteira evitar ações', 'stock', 'evitar ações'],
    ['Parei de evitar ações', 'stock', 'evitar ações'],
    ['Meu pai dizia nada de ações, eu penso diferente', null, 'refusal_aside:stock'],
    ['Sem crédito no banco, quero investir o que tenho', 'credit', 'Sem crédito'],
    ['Estou sem ouro e quero um pouco', null, 'refusal_aside:gold'],
    ['Zero cripto hoje, quero entrar', 'crypto', 'Zero cripto'],
  ];
  const LEFT_OUT: Record<
    Taken,
    { classes: string[] | null; en: string; pt: string; read: string }
  > = {
    stock: {
      classes: ['etf', 'stock'],
      en: 'You left out stocks and stock funds.',
      pt: 'Você deixou de fora ações e fundos de ações.',
      read: 'leaving out stocks and stock funds',
    },
    crypto: {
      classes: ['crypto'],
      en: 'You left out crypto.',
      pt: 'Você deixou de fora cripto.',
      read: 'leaving out crypto',
    },
    gold: {
      classes: ['gold'],
      en: 'You left out gold.',
      pt: 'Você deixou de fora ouro.',
      read: 'leaving out gold',
    },
    credit: {
      classes: null,
      en: 'No tokens that lend to borrowers or trade a spread.',
      pt: 'Nenhum token que empresta a tomadores ou opera um spread.',
      read: 'no tokens that lend to borrowers or trade a spread',
    },
  };

  it('b3, rule 4: a refusal the text check reads as stated is taken on both paths and said; one it reads as negated, aside or wondered is not', () => {
    expect(B3).toHaveLength(56);
    expect(B3.filter(([, taken]) => taken !== null)).toHaveLength(35);
    for (const [sentence, taken, said, beside] of B3)
      for (const r of [NOTHING_READ, null]) {
        const where = `${sentence} (${r === null ? 'no model' : 'model'})`;
        const result = read(sentence, r);
        if (taken === null) {
          expect(result.limits, where).toEqual({ creditTolerance: null, cannotHoldClasses: null });
          expect(result.sheet, where).not.toBeNull();
          expect(result.sheet?.limits, where).toBeUndefined();
          expect(
            result.flags.filter((f) => /^refusal_|cannotHold|noCredit/.test(f)),
            where,
          ).toEqual(said === null ? [] : [said]);
          // One the person is not sure of is said back, so it is never dropped in silence.
          expect(
            result.assumptions.filter((s) => /^I did not read|^Não li/.test(s)),
            where,
          ).toHaveLength(said?.startsWith('refusal_wondered') ? 1 : 0);
          continue;
        }
        const { classes, en, pt, read: readAs } = LEFT_OUT[taken];
        expect(result.limits, where).toEqual({
          creditTolerance: taken === 'credit' ? 'none' : null,
          cannotHoldClasses: classes,
        });
        const line = `I read “${said}” as ${readAs}. Say so if that is not what you meant.`;
        // The model did not read it: taken all the same, flagged, and said in a line of its own.
        // With no model there is no second reader to differ from, and no such line.
        expect(result.assumptions.includes(line), where).toBe(r !== null);
        expect(
          result.flags.includes(
            `disagrees_with_rules:${taken === 'credit' ? 'noCredit' : `cannotHold:${taken}`}`,
          ),
          where,
        ).toBe(r !== null);
        // Beside a holding of the same class it is one question, never a sheet with both (below).
        if (beside && r === null) continue;
        expect(result.questions, where).toEqual([]);
        expect(result.sheet?.limits, where).toEqual(
          taken === 'credit' ? { creditTolerance: 'none' } : { cannotHold: { classes } },
        );
        expect(result.readBack, where).toContain(result.language === 'pt' ? pt : en);
      }
  });

  // The same goal before each case below, and a reply that reads it and nothing of a holding.
  const GOAL = 'I want to grow $5,000 over 5 years. ';
  const goal = (over: Record<string, unknown> = {}) => reply({ risk: null, ...over });
  const turns = (...messages: string[]) => conversationText(messages[0] ?? '', messages.slice(1));
  /**
   * What a result holds or asks of a holding, in one line: `hold` and what the sheet holds (a mix as
   * stocks and crypto / dollar yield / gold / cash, the sleeves each at its share, the shared
   * portfolios it starts from); else `ask`, the field and the template, and the start where the
   * question has one; else `none`.
   */
  const outcome = (r: Result): string => {
    const parts = (m: PersonalMix) =>
      `${m.growthBps}/${m.dollarYieldBps}/${m.goldBps}/${m.cashBps}`;
    const { mix, sleeves, themes } = heldBy(r);
    if (mix || sleeves || themes.length > 0)
      return [
        'hold',
        ...(mix ? [`mix ${parts(mix)}`] : []),
        ...(sleeves
          ? [sleeves.map((s) => `${s.kind === 'theme' ? s.theme : s.kind}@${s.shareBps}`).join('+')]
          : []),
        ...(themes.length > 0 ? [`from ${themes.join(',')}`] : []),
      ].join(' ');
    const asked = r.questions.filter((q) => ['mix', 'sleeves', 'themes'].includes(q.field));
    if (asked.length === 0) return 'none';
    return asked
      .map((q) => {
        const start = q.read as PersonalMix | undefined;
        return `ask ${q.field}/${q.template}${start ? ` start ${parts(start)}` : ''}`;
      })
      .join(' & ');
  };

  it('rule 1: a mix or a narrative is taken where both readers read it, asked where only the model does, and nothing where only the text check does', () => {
    // A mix.
    const both = read(`${GOAL}All of it in stocks.`, goal({ mix: pct(100, 0) }), {});
    expect(outcome(both)).toBe('hold mix 10000/0/0/0');
    expect(both.questions).toEqual([]);
    const textOnly = read(`${GOAL}All of it in stocks.`, goal());
    expect(outcome(textOnly)).toBe('none');
    expect(textOnly.flags).toContain('text_only:mix');
    expect(saidOfAHolding(textOnly)).toEqual([]);
    const modelOnly = read(`${GOAL}Mostly stocks.`, goal({ mix: pct(80, 20) }), {});
    expect(outcome(modelOnly)).toBe('ask mix/mix start 8000/0/0/2000');
    expect(modelOnly.flags).toEqual(expect.arrayContaining(['no_cue:mix', 'mix_asked:model']));
    // A narrative.
    const market = read(`${GOAL}Invest in big tech.`, goal({ markets: ['big_tech'] }), {});
    expect(outcome(market)).toBe('hold mix 10000/0/0/0 from the-seven');
    const unnamed = read(`${GOAL}Invest in big tech.`, goal());
    expect(outcome(unnamed)).toBe('none');
    expect(unnamed.narratives).toEqual([]);
    expect(unnamed.flags).toContain('text_only:market:big_tech');
    const invented = read(GOAL, goal({ markets: ['ai'] }));
    expect(invented.narratives).toEqual([]);
    expect(invented.flags).toContain('no_cue:market:ai');
    expect(heldBy(invented)).toEqual(NOTHING_HELD);
    // The words of a filter the model names count as the model naming the market those words are:
    // the fixed list reads them, and the model's own filter is dropped.
    const byFilter = read(
      'Invest $5,000 in chip makers for 5 years',
      goal({
        marketFilter: {
          by: 'industry',
          value: 'Semiconductors & Semiconductor Equipment',
          words: 'chip makers',
        },
      }),
      {},
    );
    expect(outcome(byFilter)).toBe('hold semiconductors@10000');
    expect(byFilter.flags).toContain('market_covers:marketFilter');
    expect(byFilter.flags).not.toContain('text_only:market:semiconductors');
    // The shares of a mix the model did not read are no split of the plan either.
    const noSplit = read(`${GOAL}Only stocks is what my bank sells, 100% stocks they say.`, goal());
    expect(noSplit.flags).toContain('text_only:mix');
    expect(askedOfAHolding(noSplit)).toEqual([]);
  });

  it('rule 2: with no model a holding the text states is asked once, with its reading as the start, and "none" is a way out that stays', () => {
    // A stated mix: the `mix` question, the mix as its start.
    const mix = read(`${GOAL}All of it in stocks.`, null);
    expect(outcome(mix)).toBe('ask mix/mix start 10000/0/0/0');
    expect(mix.flags).toContain('mix_asked:rules');
    // One narrative with its share: how much of the money, the share as its start.
    const share = read(`${GOAL}Put 30% in AI.`, null);
    expect(outcome(share)).toBe('ask mix/marketShare start 3000/0/0/7000');
    expect(share.questions[0]?.text).toBe('How much of the $5,000 for AI?');
    expect(share.flags).toContain('from_rules:market');
    // Confirmed on the form, it is held.
    expect(outcome(read(`${GOAL}Put 30% in AI.`, null, { ...FORM, mix: bps(3000, 7000) }))).toBe(
      'hold ai@3000+safe_yield@7000',
    );
    // Several themes: one question that names them, in the person's words.
    const two = `${GOAL}Invest in AI and semiconductors.`;
    const asked = read(two, null);
    expect(outcome(asked)).toBe('ask sleeves/themeShares');
    expect(asked.questions[0]?.text).toBe(
      'How do you want to split the money between AI and semiconductors?',
    );
    // In words: an even split, a pair in the order asked, a share for each by name.
    for (const [words, held] of [
      ['half each', 'hold ai@5000+semiconductors@5000'],
      ['50-50', 'hold ai@5000+semiconductors@5000'],
      ['equally', 'hold ai@5000+semiconductors@5000'],
      ['60/40', 'hold ai@6000+semiconductors@4000'],
      ['70% in AI and 30% in semiconductors', 'hold ai@7000+semiconductors@3000'],
    ] as const) {
      const answered = read(turns(two, words), null);
      expect(outcome(answered), words).toBe(held);
      expect(answered.flags, words).toContain('sleeves_from_words');
      expect(answered.questions, words).toEqual([]);
    }
    // "None" leaves both out for good; "nothing for AI" leaves that one out, and the other is asked.
    const none = read(turns(two, 'none'), null);
    expect(outcome(none)).toBe('none');
    expect(none.questions).toEqual([]);
    expect(none.flags).toEqual(
      expect.arrayContaining([
        'none_from_words',
        'market_left_out:ai',
        'market_left_out:semiconductors',
      ]),
    );
    const one = read(turns(two, 'nothing for AI'), null);
    expect(one.flags).toEqual(expect.arrayContaining(['none_from_words', 'market_left_out:ai']));
    expect(one.narratives.map((n) => n.id)).toEqual(['semiconductors']);
    expect(outcome(one)).toBe('ask mix/marketShare');
    // The ways a person says none of the money, and that it stays said on the turns after.
    for (const words of ['none', 'zero', '0%', 'Nothing for AI, I just mentioned my job'])
      for (const more of [[], ['medium risk is fine']]) {
        const left = read(turns(`${GOAL}I like AI.`, words, ...more), null);
        expect(outcome(left), words).toBe('none');
        expect(left.questions, words).toEqual([]);
        expect(left.narratives, words).toEqual([]);
        expect(left.flags, words).toEqual(
          expect.arrayContaining(['none_from_words', 'market_left_out:ai']),
        );
      }
    // The form's `mix: null` leaves a shared portfolio's narrative out too.
    const form = read(`${GOAL}I like big tech.`, null, { ...FORM, mix: null });
    expect(outcome(form)).toBe('none');
    expect(form.questions).toEqual([]);
    expect(form.flags).toContain('market_left_out:big_tech');
    // A text with a model's reply reads "none" the same way.
    const byModel = read(turns(`${GOAL}I like AI.`, 'none'), goal({ markets: ['ai'] }));
    expect(outcome(byModel)).toBe('none');
    expect(byModel.flags).toEqual(
      expect.arrayContaining(['none_from_words', 'market_left_out:ai']),
    );
  });

  it('rule 3: the last word wins, for a mix, a narrative and a refusal', () => {
    const first = 'I want to grow $5,000 over 5 years, all of it in stocks';
    // A mix: the last message that says one decides.
    const corrected = turns(first, 'Sorry, I meant 60% stocks and 40% cash');
    expect(outcome(read(corrected, goal({ mix: pct(60, 40) }), {}))).toBe('hold mix 6000/0/0/4000');
    expect(outcome(read(corrected, null))).toBe('hold mix 6000/0/0/4000');
    // One a later message rules out is no mix, whatever the model still reads.
    const takenBack = read(turns(first, 'Actually not all in stocks'), goal({ mix: pct(100, 0) }));
    expect(outcome(takenBack)).toBe('none');
    expect(takenBack.flags).toContain('mix_negated');
    // A mix whose class a later message refuses is dropped, and the refusal is taken.
    for (const r of [goal({ mix: pct(100, 0), cannotHold: ['stock'] }), null]) {
      const refused = read(turns(first, 'No stocks.'), r);
      expect(refused.mix).toBeNull();
      expect(heldBy(refused)).toEqual(NOTHING_HELD);
      expect(refused.flags).toContain('mix_refused_later');
      expect(refused.limits.cannotHoldClasses).toEqual(['etf', 'stock']);
      // The form never opens on the stocks the person refused.
      expect(refused.questions.find((q) => q.field === 'mix')?.read).toBeUndefined();
    }
    // A narrative: one a later message only rules out is not asked for, whoever still names it.
    const ai = 'I want to invest $5,000 in AI for 5 years';
    for (const markets of [[], ['ai']]) {
      const dropped = read(turns(ai, 'Actually, no AI.'), goal({ markets }));
      expect(outcome(dropped), String(markets)).toBe('none');
      expect(dropped.narratives, String(markets)).toEqual([]);
    }
    const kept = read(
      turns(ai, 'Actually, no AI. Just put all of it in stocks.'),
      goal({ markets: ['ai'], mix: pct(100, 0) }),
      {},
    );
    expect(outcome(kept)).toBe('hold mix 10000/0/0/0');
    expect(kept.flags).toContain('market_negated:ai');
    // And one a later message asks for stands again; within one message any ask stands.
    for (const text of [
      turns(`${GOAL}No AI.`, 'Actually, invest in AI.'),
      `${GOAL}No AI. Actually, invest in AI.`,
    ])
      expect(outcome(read(text, goal({ markets: ['ai'] }), {})), text).toBe('hold ai@10000');
    // A refusal: a later message that names the class as held, or as no problem, takes it back,
    // and that is said. With a model both readers must agree: a refusal it still reads stands.
    const refusal = 'I want to grow $5,000 over 5 years at medium risk. No stocks.';
    for (const later of [
      'I changed my mind, stocks are fine',
      'Ignore what I said about stocks, include them',
    ])
      for (const r of [goal({ risk: 'medium' }), null]) {
        const back = read(turns(refusal, later), r);
        expect(back.limits.cannotHoldClasses, later).toBeNull();
        expect(back.sheet?.limits, later).toBeUndefined();
        expect(back.flags, later).toContain('refusal_withdrawn:stock');
        expect(back.assumptions, later).toContain(
          'I did not read “No stocks” as something to leave out. Say so if you want it left out.',
        );
      }
    const stands = read(
      turns(refusal, 'I changed my mind, stocks are fine'),
      goal({ risk: 'medium', cannotHold: ['stock'] }),
    );
    expect(stands.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(stands.flags).not.toContain('refusal_withdrawn:stock');
    // The other way round, the later refusal is the last word.
    const later = read(
      turns(
        'I want to grow $5,000 over 5 years at medium risk. Stocks are fine.',
        'On reflection, no stocks',
      ),
      null,
    );
    expect(later.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
  });

  it('rule 4: a refusal and a holding of one class are one question, never a sheet with both; a share takes the refusal back, "none" keeps it', () => {
    const ira = 'No stocks in my IRA, so here I want all stocks';
    // With a model that reads the mix, and with none: one question, by the `mix` field, with no
    // start, that names both in the person's words.
    for (const r of [reply({ ...NOTHING_READ, mix: pct(100, 0) }), null]) {
      const asked = read(ira, r);
      expect(outcome(asked)).toBe('ask mix/holdOrLeaveOut');
      expect(asked.questions).toEqual([
        {
          field: 'mix',
          template: 'holdOrLeaveOut',
          text: 'You wrote “No stocks” and also “all stocks”. Which one stands? Say how much of the money goes to it, or none.',
        },
      ]);
      expect(asked.flags).toContain('refusal_conflict:stock');
      expect(asked.sheet).toBeNull();
    }
    // A share for the holding takes the refusal back, and that is said; "none" keeps the refusal.
    for (const answer of [
      read(ira, null, { ...FORM, mix: STOCKS }),
      read(turns(ira, 'all of it in stocks'), null),
    ]) {
      expect(outcome(answer)).toBe('hold mix 10000/0/0/0');
      expect(answer.sheet?.limits).toBeUndefined();
      expect(answer.flags).toContain('refusal_withdrawn:stock');
      expect(answer.assumptions).toContain(
        'I did not read “No stocks” as something to leave out. Say so if you want it left out.',
      );
    }
    for (const answer of [
      read(ira, null, { ...FORM, mix: null }),
      read(turns(ira, 'none'), null),
    ]) {
      expect(outcome(answer)).toBe('none');
      expect(answer.questions).toEqual([]);
      expect(answer.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
      expect(answer.readBack).toContain('You left out stocks and stock funds.');
    }
    // A narrative, which is held in stocks, against a refusal of stocks: the same question.
    const theme = `${GOAL}No stocks. Invest in AI.`;
    const r = goal({ markets: ['ai'], cannotHold: ['stock'] });
    const asked = read(theme, r);
    expect(outcome(asked)).toBe('ask mix/holdOrLeaveOut');
    expect(asked.questions[0]?.text).toBe(
      'You wrote “No stocks” and also “AI”. Which one stands? Say how much of the money goes to it, or none.',
    );
    const half = read(turns(theme, 'half'), r);
    expect(outcome(half)).toBe('hold ai@5000+safe_yield@5000');
    expect(half.flags).toContain('refusal_withdrawn:stock');
    const none = read(turns(theme, 'none'), r);
    expect(outcome(none)).toBe('none');
    expect(none.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
    expect(none.flags).toContain('market_left_out:ai');
    // A refusal of a part of a class is not applied, and that is said on both paths.
    for (const reader of [goal({ risk: 'medium' }), null]) {
      const part = read(`${GOAL}No stocks from China.`, reader);
      expect(part.limits.cannotHoldClasses).toBeNull();
      expect(part.flags).toContain('part_refused');
      expect(part.assumptions).toContain(
        'A plan can leave out a whole class, not a part of one, so “No stocks from China” was not applied.',
      );
    }
  });

  // b4: a share or a sum attached to the wrong thing, two narratives, a narrative beside a mix or a
  // split. The narratives a reply names where it names what the text asks for; what is held or asked
  // with that reply, and with no model (`outcome`); and a line that is said on both, where one is.
  // With the reply of the review's script, which names none, nothing is held, asked or said.
  const TESLA = (words: string) =>
    `A plan cannot leave one company out of a list it holds, so “${words}” was not applied.`;
  const B4: [string, Market[], string, string, string?][] = [
    [
      'Half in stocks and half in AI',
      ['ai'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
    [
      '30% in AI and the rest in stocks',
      ['ai'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
    ['$1,000 in AI and the rest in stocks', ['ai'], 'ask mix/marketShare', 'ask mix/marketShare'],
    [
      'Put half in AI and the other half in gold',
      ['ai'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
    [
      'Put 20% in AI and keep the rest in bitcoin',
      ['ai'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
    [
      'I put $500 in AI last year, now I want to invest the $5,000',
      ['ai'],
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    ['I can lose 30% in AI and be fine', ['ai'], 'ask mix/marketShare', 'ask mix/marketShare'],
    ['70% of experts say invest in AI', ['ai'], 'ask mix/marketShare', 'ask mix/marketShare'],
    [
      'My salary went up 20% in software this year',
      ['cloud_software'],
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    [
      'All of it in AI except $1,000 that I need in cash',
      ['ai'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
    ['No more than 20% in AI', [], 'none', 'none'],
    ['At least 30% in big tech', ['big_tech'], 'ask mix/marketShare', 'ask mix/marketShare'],
    ['Up to 30% in big tech', ['big_tech'], 'ask mix/marketShare', 'ask mix/marketShare'],
    [
      'At most 10% in semiconductors',
      ['semiconductors'],
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    [
      'Invest in AI but no Tesla',
      ['ai'],
      'hold ai@10000',
      'ask mix/marketShare start 10000/0/0/0',
      TESLA('no Tesla'),
    ],
    [
      'Invest in AI, but I do not want Tesla or Meta in it',
      ['ai'],
      'hold ai@10000',
      'ask mix/marketShare start 10000/0/0/0',
      TESLA('do not want Tesla or Meta'),
    ],
    [
      'Invest in big tech without Tesla',
      ['big_tech'],
      'hold mix 10000/0/0/0 from the-seven',
      'ask mix/marketShare start 10000/0/0/0',
      TESLA('without Tesla'),
    ],
    // Both have a list on this shelf, as on the chain the review ran it on a second time.
    [
      'Invest in AI and defense',
      ['ai', 'defense'],
      'ask sleeves/themeShares',
      'ask sleeves/themeShares',
    ],
    ['Invest in AI and big tech', ['big_tech', 'ai'], 'ask sleeves/sleeves', 'ask sleeves/sleeves'],
    [
      'half in AI and half in semiconductors',
      ['ai', 'semiconductors'],
      'hold ai@5000+semiconductors@5000',
      'ask sleeves/themeShares',
    ],
    [
      'half in semiconductors and half in AI',
      ['ai', 'semiconductors'],
      'hold semiconductors@5000+ai@5000',
      'ask sleeves/themeShares',
    ],
    ['all in stocks, mostly AI', ['ai'], 'ask mix/marketShare', 'ask mix/marketShare'],
    [
      '70% stocks and 30% cash, with the stocks in AI',
      ['ai'],
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    [
      'Put 50% in AI, 30% in gold and 20% in cash',
      ['ai'],
      'ask sleeves/sleeves',
      'ask sleeves/sleeves',
    ],
    [
      'I want 60% in the S&P 500, 20% in gold and 20% in AI',
      ['us_market', 'ai'],
      'ask sleeves/sleeves',
      'ask sleeves/sleeves',
    ],
    [
      'Invest in AI. Actually no, make it semiconductors.',
      ['ai', 'semiconductors'],
      'ask sleeves/themeShares',
      'ask sleeves/themeShares',
    ],
    // A limit, held here so that it is seen: within one message the later sentence takes AI back in
    // words the text check does not read, so a reply that still names AI holds it.
    [
      'Invest in AI. On second thought, forget AI, just all in stocks.',
      ['ai'],
      'hold ai@10000',
      'ask mix/marketShare start 10000/0/0/0',
    ],
    [
      'Invest in AI or maybe semiconductors, you choose',
      ['ai', 'semiconductors'],
      'ask sleeves/themeShares',
      'ask sleeves/themeShares',
    ],
    [
      'Either AI or big tech, whichever is better',
      ['big_tech', 'ai'],
      'ask sleeves/sleeves',
      'ask sleeves/sleeves',
    ],
    [
      'Invest in whatever is hot: AI, EVs, quantum computing',
      ['ai', 'quantum', 'ev_autonomy'],
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    [
      'Invest everything in AI stocks, I can afford to lose all of it',
      ['ai'],
      'hold ai@10000',
      'ask mix/marketShare start 10000/0/0/0',
    ],
    ['Tudo em IA', ['ai'], 'hold ai@10000', 'ask mix/marketShare start 10000/0/0/0'],
    [
      'Metade em IA e metade em ações',
      ['ai'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
    ['30% em IA e o resto em ouro', ['ai'], 'ask sleeves/themeAndRest', 'ask sleeves/themeAndRest'],
    [
      'Coloque 20% em semicondutores e o resto na bolsa',
      ['semiconductors'],
      'ask sleeves/themeAndRest',
      'ask sleeves/themeAndRest',
    ],
  ];

  it('b4, rule 5: a share is taken only in its plain forms; the rest, a sum carved out, a bound, a past sum or a loss is asked, never taken', () => {
    // 35 sentences; the review ran "Invest in AI and defense" twice, and its other run is below.
    expect(B4).toHaveLength(35);
    for (const [sentence, markets, named, noModel, said] of B4) {
      // The reply of the review's script reads nothing: nothing is held, asked or said.
      const script = read(sentence, NOTHING_READ);
      expect(outcome(script), sentence).toBe('none');
      expect(script.narratives, sentence).toEqual([]);
      expect(script.questions, sentence).toEqual([]);
      expect(saidOfAHolding(script), sentence).toEqual([]);
      // A reply that names what the text asks for, and no model.
      const byReply = read(sentence, reply({ ...NOTHING_READ, markets }));
      expect(outcome(byReply), `${sentence} (a reply that names it)`).toBe(named);
      const rules = read(sentence, null);
      expect(outcome(rules), `${sentence} (no model)`).toBe(noModel);
      // With no model nothing is ever held: a share the text states is the start of one question.
      expect(heldBy(rules), sentence).toEqual(NOTHING_HELD);
      for (const result of [byReply, rules])
        expect(
          result.assumptions.filter((s) => /cannot leave one company out/.test(s)),
          sentence,
        ).toEqual(said ? [said] : []);
    }
  });

  it('b4, the review\'s second run of "Invest in AI and defense": a list carries what leads it, and two things named after one verb share the whole', () => {
    const sentence = 'Invest in AI and defense';
    // "Defense" alone is read only after a word that puts money there: as an item of the list too.
    expect(
      marketMentionsIn(sentence).map((m) => [
        m.market,
        m.skipped,
        marketShareIn(sentence, m.at, m.end),
      ]),
    ).toEqual([
      ['ai', null, null],
      ['defense', null, null],
    ]);
    for (const [text, ids] of [
      ['AI, space or defense', ['ai', 'space', 'defense']],
      ['invest in health care and AI', ['health_care', 'ai']],
      ['Invest in AI, big tech and social media', ['ai', 'big_tech', 'social_media']],
      ['investir em IA e defesa', ['ai', 'defense']],
    ] as const)
      expect(
        marketMentionsIn(text).map((m) => m.market),
        text,
      ).toEqual(ids);
    // What is said of the first is said of each; and the word alone is still no narrative.
    expect(marketMentionsIn('I work in AI and defense').map((m) => m.skipped)).toEqual([
      'aside',
      'aside',
    ]);
    expect(
      marketMentionsIn("I don't want to invest in AI or defense").map((m) => m.skipped),
    ).toEqual(['negated', 'negated']);
    for (const text of ['The defense rested', 'In defense of my plan', 'the space of two years'])
      expect(marketMentionsIn(text), text).toEqual([]);
    // Where both have a list, the question names both, and "half each" answers it.
    const both = reply({ ...NOTHING_READ, markets: ['ai', 'defense'] });
    const asked = read(sentence, both);
    expect(asked.questions).toEqual([
      {
        field: 'sleeves',
        template: 'themeShares',
        text: 'How do you want to split the money between AI and defense?',
      },
    ]);
    expect(outcome(read(turns(sentence, 'half each'), both))).toBe(
      'hold ai@5000+matched-industry-aerospace-defense@5000',
    );
    // Where the chain has nothing for defense (the review's first run), that is said, and AI is not
    // given the whole by guessing: how much is asked.
    for (const r of [both, null]) {
      const none = intake(sentence, r, { matchOf: () => null, answers: FORM });
      expect(outcome(none)).toBe('ask mix/marketShare');
      expect(none.questions[0]?.text).toBe('How much of the $5,000 for AI?');
      expect(none.assumptions).toContain(
        'There is no stock for “defense” on Solana at the moment. We will be adding more soon.',
      );
    }
    // A reply that names one of the two reads the other as the text check alone does: not at all.
    const one = read(sentence, reply({ ...NOTHING_READ, markets: ['ai'] }));
    expect(outcome(one)).toBe('ask mix/marketShare');
    expect(one.flags).toContain('text_only:market:defense');
  });

  // b5: a later message that corrects an earlier one, and answers in words to the intake's own
  // questions. The messages; what the review's reply read beside the goal; the narrative a reply
  // names where it also names what the first message asks for; then what is held or asked with the
  // review's reply, with that reply, and with no model.
  const A_JOB = `${GOAL}I use AI at work every day.`;
  const LIKES_AI = `${GOAL}I like AI.`;
  const LIKES_BIG_TECH = `${GOAL}I like big tech.`;
  const AI_FIRST = 'I want to invest $5,000 in AI for 5 years';
  const STOCKS_FIRST = 'I want to grow $5,000 over 5 years, all of it in stocks';
  const NO_STOCKS = 'I want to grow $5,000 over 5 years at medium risk. No stocks.';
  const B5: [string[], Record<string, unknown>, Market[], string, string | null, string][] = [
    [
      [AI_FIRST, 'Actually, no AI. Just put all of it in stocks.'],
      { mix: pct(100, 0) },
      ['ai'],
      'hold mix 10000/0/0/0',
      'hold mix 10000/0/0/0',
      'hold mix 10000/0/0/0',
    ],
    [
      [AI_FIRST, 'Scrap the AI idea, I want medium risk and nothing fancy'],
      { risk: 'medium' },
      ['ai'],
      'none',
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    [
      [STOCKS_FIRST, 'On reflection that is too much. Medium risk please.'],
      { risk: 'medium' },
      [],
      'none',
      null,
      'ask mix/mix start 10000/0/0/0',
    ],
    [
      [STOCKS_FIRST, 'Sorry, I meant 60% stocks and 40% cash'],
      { mix: pct(60, 40) },
      [],
      'hold mix 6000/0/0/4000',
      null,
      'hold mix 6000/0/0/4000',
    ],
    [
      [NO_STOCKS, 'I changed my mind, stocks are fine'],
      { risk: 'medium' },
      [],
      'none',
      null,
      'none',
    ],
    [
      [NO_STOCKS, 'Ignore what I said about stocks, include them'],
      { risk: 'medium' },
      [],
      'none',
      null,
      'none',
    ],
    [[A_JOB, 'none'], {}, ['ai'], 'none', 'none', 'none'],
    [[A_JOB, 'zero'], {}, ['ai'], 'none', 'none', 'none'],
    [[A_JOB, '0%'], {}, ['ai'], 'none', 'none', 'none'],
    [[A_JOB, 'Nothing for AI, I just mentioned my job'], {}, ['ai'], 'none', 'none', 'none'],
    [[A_JOB, 'I do not want AI'], {}, ['ai'], 'none', 'none', 'none'],
    [
      [LIKES_AI, 'a third'],
      {},
      ['ai'],
      'none',
      'hold ai@3333+safe_yield@6667',
      'hold ai@3333+safe_yield@6667',
    ],
    [
      [LIKES_AI, '20%'],
      {},
      ['ai'],
      'none',
      'hold ai@2000+safe_yield@8000',
      'hold ai@2000+safe_yield@8000',
    ],
    [
      [LIKES_AI, 'not sure, maybe 20%'],
      {},
      ['ai'],
      'none',
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
    [[LIKES_AI, '20% at most'], {}, ['ai'], 'none', 'ask mix/marketShare', 'ask mix/marketShare'],
    [[LIKES_AI, '$20'], {}, ['ai'], 'none', 'ask mix/marketShare', 'ask mix/marketShare'],
    [[LIKES_AI, '5'], {}, ['ai'], 'none', 'ask mix/marketShare', 'ask mix/marketShare'],
    [[LIKES_AI, '5 years'], {}, ['ai'], 'none', 'ask mix/marketShare', 'ask mix/marketShare'],
    [
      [LIKES_BIG_TECH, 'all of it'],
      {},
      ['big_tech'],
      'none',
      'hold mix 10000/0/0/0 from the-seven',
      'hold mix 10000/0/0/0 from the-seven',
    ],
    [
      [LIKES_BIG_TECH, 'everything except $1,000'],
      {},
      ['big_tech'],
      'none',
      'ask mix/marketShare',
      'ask mix/marketShare',
    ],
  ];

  it('b5, rules 2, 3 and 5: a later message corrects an earlier one, and answers the open question only where it says a share plainly', () => {
    expect(B5).toHaveLength(20);
    for (const [messages, readBeside, markets, script, named, noModel] of B5) {
      const text = turns(...messages);
      const where = messages[1] ?? '';
      expect(outcome(read(text, goal(readBeside), {})), `${where} (the review's reply)`).toBe(
        script,
      );
      if (named !== null)
        expect(
          outcome(read(text, goal({ ...readBeside, markets }), {})),
          `${where} (a reply that names it)`,
        ).toBe(named);
      expect(outcome(read(text, null)), `${where} (no model)`).toBe(noModel);
    }
    // Where the question stays, it is the one that was asked, with no start: never the split, and
    // never a share read from words that hedge it or bound it.
    for (const words of ['not sure, maybe 20%', '20% at most', '$20', '5', '5 years'])
      for (const r of [goal({ markets: ['ai'] }), null]) {
        const again = read(turns(LIKES_AI, words), r);
        expect(askedOfAHolding(again), words).toEqual([
          { field: 'mix', template: 'marketShare', text: 'How much of the $5,000 for AI?' },
        ]);
        expect(again.flags, words).not.toContain('mix_from_words');
      }
  });

  it('rule 3, "Scrap the AI idea": the last message that names a narrative says its share, and where it says none the earlier share no longer stands', () => {
    const scrapped = turns(AI_FIRST, 'Scrap the AI idea, I want medium risk and nothing fancy');
    // Whoever still names AI: it is not held on the first message's "invest $5,000 in AI". How much
    // is asked once, with no start, and "none" answers it.
    for (const r of [goal({ risk: 'medium', markets: ['ai'] }), null]) {
      const asked = read(scrapped, r);
      expect(heldBy(asked)).toEqual(NOTHING_HELD);
      expect(asked.flags).toEqual(
        expect.arrayContaining(['share_not_last:ai', 'market_share_unclear']),
      );
      expect(askedOfAHolding(asked)).toEqual([
        { field: 'mix', template: 'marketShare', text: 'How much of the $5,000 for AI?' },
      ]);
      const none = read(turns(scrapped, 'none'), r);
      expect(outcome(none)).toBe('none');
      expect(none.sheet).toMatchObject({ risk: 'medium' });
    }
    // A later message that gives a share in a plain form is the last word on it.
    expect(outcome(read(turns(AI_FIRST, 'Make it 30% in AI'), goal({ markets: ['ai'] }), {}))).toBe(
      'hold ai@3000+safe_yield@7000',
    );
    // One that only says it of the person names no holding, and leaves the first message's stand.
    expect(
      outcome(read(turns(AI_FIRST, 'I work in AI by the way'), goal({ markets: ['ai'] }), {})),
    ).toBe('hold ai@10000');
    // Within one message a second sentence about it takes nothing back.
    expect(outcome(read(`${AI_FIRST}. AI is the future.`, goal({ markets: ['ai'] }), {}))).toBe(
      'hold ai@10000',
    );
  });

  it('rule 5, "$20": a share no line of a plan can be is not taken, and the line says the least a plan of that size can hold', () => {
    const LEAST =
      'The smallest part a plan of this size can hold is $25, so a smaller one was not taken.';
    // In answer to "How much of the $5,000 for AI?", on both paths; and for a shared portfolio.
    for (const [first, r] of [
      [LIKES_AI, goal({ markets: ['ai'] })],
      [LIKES_AI, null],
      [LIKES_BIG_TECH, goal({ markets: ['big_tech'] })],
    ] as const) {
      const small = read(turns(first, '$20'), r);
      expect(heldBy(small)).toEqual(NOTHING_HELD);
      expect(small.flags).toContain('share_too_small');
      expect(small.flags).not.toContain('mix_from_words');
      expect(small.assumptions).toContain(LEAST);
      expect(askedOfAHolding(small)).toHaveLength(1);
      expect(askedOfAHolding(small)[0]).toMatchObject({ field: 'mix', template: 'marketShare' });
    }
    // The floor is the table's: the least a line can be, in dollars and as a share of the amount.
    expect(PERSONAL_PARAMS).toMatchObject({ minLineUsd: 5, minLineBps: 50 });
    expect(outcome(read(turns(LIKES_AI, '$25'), goal({ markets: ['ai'] }), {}))).toBe(
      'hold ai@50+safe_yield@9950',
    );
    expect(outcome(read(turns(LIKES_AI, '$20', '$500'), goal({ markets: ['ai'] }), {}))).toBe(
      'hold ai@1000+safe_yield@9000',
    );
    // A sum the first message writes is held to the same floor, for a theme and a shared portfolio.
    for (const [text, r] of [
      [`${GOAL}Put $10 in AI.`, goal({ markets: ['ai'] })],
      [`${GOAL}Put $10 in AI.`, null],
      [`${GOAL}Put $10 in big tech.`, goal({ markets: ['big_tech'] })],
    ] as const) {
      const small = read(text, r);
      expect(outcome(small), text).toBe('ask mix/marketShare');
      expect(small.flags, text).toContain('share_too_small');
      expect(small.assumptions, text).toContain(LEAST);
    }
  });

  it('rule 5, the plain forms: the whole, a sum, a percent and a half are a share where the ask opens its clause or follows the person own words of wanting', () => {
    const shares = (text: string) =>
      marketMentionsIn(text)
        .filter((m) => m.skipped === null)
        .map((m) => marketShareIn(text, m.at, m.end));
    const WHOLE_OF_IT = { kind: 'whole' };
    for (const [text, share] of [
      ['invest in big tech', WHOLE_OF_IT],
      ['I want to invest in big tech', WHOLE_OF_IT],
      ["I'd like to invest in big tech", WHOLE_OF_IT],
      ['I have $5,000 to invest in big tech', WHOLE_OF_IT],
      ['I have 2k that I want to invest in the big tech industry', WHOLE_OF_IT],
      ['please put it all in AI', WHOLE_OF_IT],
      ['Quero investir em IA', WHOLE_OF_IT],
      ['Tenho US$ 5.000 para investir em IA', WHOLE_OF_IT],
      ['My plan is to invest in AI', WHOLE_OF_IT],
      ["I'd rather invest in big tech", WHOLE_OF_IT],
      ['Meu objetivo é investir em IA', WHOLE_OF_IT],
      ['Looking to invest $5,000 in AI', { kind: 'amount', value: 5000 }],
      ["I've decided to put half in AI", { kind: 'percent', value: 50 }],
      ["let's put half in AI", { kind: 'percent', value: 50 }],
      ['I will put 30% in AI', { kind: 'percent', value: 30 }],
      ['Vou colocar metade em IA', { kind: 'percent', value: 50 }],
      ['I want growth and 30% in AI', { kind: 'percent', value: 30 }],
    ] as const)
      expect(shares(text), text).toEqual([share]);
    // After any other word the same figure is no share of this money: what a person fears, did,
    // was told, could lose or would cap.
    for (const text of [
      "I'm afraid to invest in big tech",
      'I regret investing in AI',
      'It is too late to put 30% in AI',
      'I can lose 30% in AI',
      'at least 30% in big tech',
      'I put $500 in AI last year',
      'we hold 30% in AI',
      'My advisor says put half in AI',
      'His plan is to invest in AI',
      '70% of experts say invest in AI',
    ])
      expect(shares(text), text).toEqual([null]);
    // A list is as plain as what leads it, and two things after one share take it to neither.
    expect(shares('Put 30% in big tech and 20% in the S&P 500')).toEqual([
      { kind: 'percent', value: 30 },
      { kind: 'percent', value: 20 },
    ]);
    expect(shares("I'm afraid to put 30% in big tech and 20% in the S&P 500")).toEqual([
      null,
      null,
    ]);
    expect(shares('put 30% in AI and semiconductors')).toEqual([null, null]);
    // b7 again, with a reply that errs and names the market each sentence turns down: with both
    // readers wrong, it is asked once with no start, and never the whole plan.
    for (const [sentence, id] of B7)
      for (const r of [reply({ ...NOTHING_READ, markets: [id] }), null]) {
        const result = read(sentence, r);
        expect(heldBy(result), sentence).toEqual(NOTHING_HELD);
        expect(outcome(result), sentence).toBe('ask mix/marketShare');
        expect(result.flags, sentence).not.toContain('from_rules:market');
      }
    // And b2: named by a reply that errs, its words are asked once or said, never held.
    for (const [sentence, id] of B2)
      if (id)
        expect(heldBy(read(sentence, reply({ ...NOTHING_READ, markets: [id] }))), sentence).toEqual(
          NOTHING_HELD,
        );
  });

  it('rule 5, a percent of the money: one that says where it goes; a percent of something else is no share of a split', () => {
    for (const [text, ofMoney] of [
      ['70% safe and 30% to grow', [70, 30]],
      ['keep 30% in cash', [30]],
      ['I want 70% of it in a safe liquid investment', [70]],
      ['70% safe, 30% high risk', [70, 30]],
      ['70% seguro e 30% para crescer', [70, 30]],
      ['I can lose 30% and I am 70% sure', []],
      ['70% of experts say invest in AI', []],
      ['20% of my salary goes to rent', []],
      ['maybe 20%', []],
      ['20% at most', []],
      ['I can take a 20% fall', []],
    ] as const)
      expect(splitIn(text).ofMoney, text).toEqual(ofMoney);
    // A pair is a split whatever is around it.
    expect(splitIn('its 70-30').pairs).toEqual([[70, 30]]);
    // With no model a percent that is no share asks no split, and the percents of a mix the text
    // rules out are the mix's.
    for (const sentence of [
      'I can lose 30% and I am 70% sure.',
      '70% of experts say this is a good time.',
      '100% stocks is too much for me.',
      "I can't stomach 80% stocks and 20% cash.",
    ])
      expect(read(`${GOAL}${sentence}`, null).questions, sentence).toEqual([]);
    expect(fields(read(`${GOAL}Keep 30% safe and 70% to grow.`, null))).toEqual(['sleeves']);
  });

  // b6: hostile or mistaken replies, and what a reply can decide that code does not check. Each
  // case: the text, what the reply gives beside the goal, the amount and the time, what is held or
  // asked of a holding (`outcome`), every field that is asked, the flags that say why, and the one
  // line that is said of it, where one is.
  const T1 = 'I want to invest $5,000 in my future over 5 years';
  const T2 = 'I want to grow $5,000 over 5 years at medium risk';
  const SAFE = 'I want to put $5,000 in something safe for 5 years';
  const filter = (by: string, value: string, words: string) => ({
    marketFilter: { by, value, words },
  });
  const ONE = (words: string) =>
    `There is only one stock for “${words}” on Solana at the moment, and a theme is not made of one. We will be adding more soon.`;
  const NO_STOCK = (words: string) =>
    `There is no stock for “${words}” on Solana at the moment. We will be adding more soon.`;
  const ONE_NAME = ['filter_one_name:marketFilter', 'market_not_on_shelf:marketFilter'];
  const NO_MATCH = ['filter_no_match:marketFilter', 'market_not_on_shelf:marketFilter'];
  const MEDIUM = { risk: 'medium' };
  const B6: [string, Record<string, unknown>, string, string[], string[], string?][] = [
    // A filter whose words are not in the text; then any words of the text, with a value that
    // selects one stock: a filter is never used to pick one (rule 6).
    [
      T2,
      { ...MEDIUM, ...filter('industry', 'Automobiles', 'cars') },
      'none',
      [],
      ['no_cue:marketFilter'],
    ],
    [
      T1,
      filter('industry', 'Automobiles', 'my future'),
      'none',
      ['risk'],
      ONE_NAME,
      ONE('my future'),
    ],
    [
      T1,
      filter('industry', 'Hotels, Restaurants & Leisure', 'my future'),
      'none',
      ['risk'],
      NO_MATCH,
      NO_STOCK('my future'),
    ],
    [
      T1,
      filter('sub_industry', 'Automobile Manufacturers', 'future'),
      'none',
      ['risk'],
      ['market_negated:marketFilter'],
    ],
    // Two names in a broad sector, for words that do not write it: the model's own link. Never
    // taken; one question that says the match, with the share the person wrote as its start.
    [
      T1,
      filter('sector', 'Consumer Discretionary', 'my future'),
      'ask mix/matchedShare start 10000/0/0/0',
      ['mix'],
      ['filter_not_written'],
    ],
    [
      T2,
      { ...MEDIUM, ...filter('industry', 'Automobiles', 'grow') },
      'none',
      [],
      ONE_NAME,
      ONE('grow'),
    ],
    [
      T2,
      { ...MEDIUM, ...filter('industry', 'Automobiles', 'medium risk') },
      'none',
      [],
      ONE_NAME,
      ONE('medium risk'),
    ],
    [
      SAFE,
      { goal: 'protect', ...filter('industry', 'Automobiles', 'something safe') },
      'none',
      ['goal', 'risk'],
      ONE_NAME,
      ONE('something safe'),
    ],
    [
      SAFE,
      { goal: 'grow', ...filter('industry', 'Automobiles', 'something safe') },
      'none',
      ['goal', 'risk'],
      ONE_NAME,
      ONE('something safe'),
    ],
    [
      'I want to invest $5,000 in something safe for 5 years',
      filter('industry', 'Automobiles', 'something safe'),
      'none',
      ['risk'],
      ONE_NAME,
      ONE('something safe'),
    ],
    // Words a fixed list reads: the list reads them, and the model's filter is dropped.
    [
      'Invest $5,000 in index funds for 5 years',
      filter('industry', 'Automobiles', 'index funds'),
      'hold matched-keyword-index-fund@10000',
      [],
      ['market_covers:marketFilter'],
    ],
    // A ticker or a company as the value.
    [
      'I want to invest $5,000 in Tesla over 5 years',
      filter('keyword', 'TSLAx', 'Tesla'),
      'none',
      ['risk'],
      NO_MATCH,
      NO_STOCK('Tesla'),
    ],
    [
      'I want to invest $5,000 in Tesla over 5 years',
      filter('keyword', 'Tesla', 'Tesla'),
      'none',
      ['risk'],
      NO_MATCH,
      NO_STOCK('Tesla'),
    ],
    [
      'I want to invest $5,000 in Tesla over 5 years',
      filter('industry', 'Automobiles', 'Tesla'),
      'none',
      ['risk'],
      ONE_NAME,
      ONE('Tesla'),
    ],
    [
      'I want to invest $5,000 in Nvidia over 5 years',
      filter('industry', 'Semiconductors & Semiconductor Equipment', 'Nvidia'),
      'none',
      ['risk'],
      ONE_NAME,
      ONE('Nvidia'),
    ],
    [
      'I want to invest $5,000 in McDonalds over 5 years',
      filter('industry', 'Hotels, Restaurants & Leisure', 'McDonalds'),
      'none',
      ['risk'],
      NO_MATCH,
      NO_STOCK('McDonalds'),
    ],
    [
      'I want to invest $5,000 in Strategy over 5 years',
      filter('keyword', 'bitcoin treasury', 'Strategy'),
      'none',
      ['risk'],
      ONE_NAME,
      ONE('Strategy'),
    ],
    // An invented market id, a market the text does not name, a portfolio never written.
    [T2, { ...MEDIUM, markets: ['robots'] }, 'none', [], ['model_invalid:markets']],
    [T2, { ...MEDIUM, markets: ['ai'] }, 'ask themes/themes', ['themes'], ['no_cue:market:ai']],
    [T2, { ...MEDIUM, portfolios: ['The Seven'] }, 'none', [], ['no_cue:portfolios']],
    // The words of a portfolio's name, said of something else.
    [
      `${T2}, the seven of us are saving`,
      { ...MEDIUM, portfolios: ['The Seven'] },
      'none',
      [],
      ['no_cue:portfolios'],
    ],
    [
      `${T2}. My kids are the 500 reasons I save.`,
      { ...MEDIUM, portfolios: ['The 500'] },
      'none',
      [],
      ['no_cue:portfolios'],
    ],
    // A risk word under a negation.
    [
      "I want to grow $5,000 over 5 years. I can't take high risk.",
      { risk: 'high' },
      'none',
      ['risk'],
      ['risk_negated:high'],
    ],
    [
      'I want to grow $5,000 over 5 years. Not low risk, I want more than that.',
      { risk: 'low' },
      'none',
      ['risk'],
      ['risk_negated:low'],
    ],
    [
      'I want to grow $5,000 over 5 years. I am not aggressive.',
      { risk: 'high' },
      'none',
      ['risk'],
      ['risk_negated:high'],
    ],
    // A figure that is in the text in another sense.
    [
      'I am 35 and want to grow $5,000 over 5 years at medium risk',
      { ...MEDIUM, amountUsd: 35 },
      'none',
      ['amountUsd'],
      ['not_a_sum:amountUsd'],
    ],
    [
      `${T2}, and in 2 years I buy a car`,
      { ...MEDIUM, horizonMonths: 24 },
      'none',
      ['horizonMonths'],
      ['horizon_several'],
    ],
    // A mix the text does not write, and a split from percents of another sense.
    [
      T2,
      { ...MEDIUM, mix: pct(100, 0) },
      'ask mix/mix start 10000/0/0/0',
      ['mix'],
      ['no_cue:mix', 'mix_asked:model'],
    ],
    [
      'I can lose 30% and I am 70% sure. Grow $5,000 over 5 years at medium risk.',
      {
        ...MEDIUM,
        sleeves: [
          { kind: 'goal', sharePct: 70 },
          { kind: 'safe_yield', sharePct: 30 },
        ],
      },
      'ask sleeves/sleeves',
      ['sleeves'],
      ['not_in_text:sleeves'],
    ],
  ];

  it('b6: what a hostile or mistaken reply gives is held to the text; nothing it adds is taken', () => {
    // The review's script has 29 cases.
    expect(B6).toHaveLength(29);
    for (const [text, hostile, held, asked, flags, said] of B6) {
      const where = `${text} ${JSON.stringify(hostile)}`;
      const result = read(text, goal(hostile), {});
      expect(outcome(result), where).toBe(held);
      expect(fields(result), where).toEqual(asked);
      expect(result.flags, where).toEqual(expect.arrayContaining(flags));
      // The one line said of what the reply named, and no line that says a holding where none is.
      expect(
        result.assumptions.filter((s) => /no stock|only one stock/.test(s)),
        where,
      ).toEqual(said ? [said] : []);
      if (!held.startsWith('hold')) expect(heldBy(result), where).toEqual(NOTHING_HELD);
      // What the sheet does hold, where there is one, is the text's: the amount, the time, the risk.
      if (result.sheet)
        expect(result.sheet, where).toMatchObject({
          amountUsd: 5000,
          horizonMonths: 60,
          risk: held.startsWith('hold') ? 'high' : 'medium',
        });
    }
    // With no model none of these texts holds or asks anything of a holding, but the one whose
    // words a fixed list reads: asked once, with its reading as the start.
    for (const text of new Set(B6.map(([text]) => text))) {
      const rules = read(text, null);
      expect(heldBy(rules), text).toEqual(NOTHING_HELD);
      expect(outcome(rules), text).toBe(
        /index funds/.test(text) ? 'ask mix/marketShare start 10000/0/0/0' : 'none',
      );
    }
  });

  it('b6, a filter the model names for words that do not write its value: the question says the match, with the share the person wrote as its start, and nothing is held until it is answered', () => {
    const r = goal(filter('sector', 'Consumer Discretionary', 'my future'));
    const asked = read(T1, r, {});
    expect(asked.sheet).toBeNull();
    expect(asked.flags).not.toContain('sleeves_from_market');
    // "Invest $5,000 in my future" of $5,000 is the whole: that is the start, not what is held.
    expect(asked.questions).toEqual([
      {
        field: 'mix',
        template: 'matchedShare',
        text: 'I read “my future” as names matched by sector: Consumer Discretionary. How much of the $5,000 for them? Say none if that is not what you meant.',
        read: STOCKS,
      },
    ]);
    // "None", or a plain no, leaves it out for good.
    for (const words of ['none', 'no', 'No.', "no, that's not what I meant", 'não']) {
      const none = read(turns(T1, words), r, {});
      expect(none.narratives, words).toEqual([]);
      expect(none.flags, words).toEqual(
        expect.arrayContaining(['none_from_words', 'market_left_out:marketFilter']),
      );
      expect(outcome(none), words).toBe('none');
      expect(fields(none), words).toEqual(['risk']);
    }
    // A plain yes holds what the person wrote; the person's own answer is the second reader.
    for (const words of ['yes', 'Yes, please', "that's right", 'ok', 'sim', 'isso', 'isso mesmo']) {
      const yes = read(turns(T1, words), r, {});
      expect(outcome(yes), words).toBe('hold matched-sector-consumer-discretionary@10000');
      expect(yes.flags, words).toContain('mix_confirmed');
      expect(yes.questions, words).toEqual([]);
      expect(yes.readBack, words).toContain(
        '100% of the plan for names matched by sector: Consumer Discretionary.',
      );
    }
    // A share in the answer replaces the one in the text.
    const half = read(turns(T1, 'half'), r, {});
    expect(outcome(half)).toBe('hold matched-sector-consumer-discretionary@5000+safe_yield@5000');
    expect(half.readBack).toContain(
      '50% of the plan for names matched by sector: Consumer Discretionary.',
    );
    expect(outcome(read(turns(T1, 'yes, 30%'), r, {}))).toBe(
      'hold matched-sector-consumer-discretionary@3000+safe_yield@7000',
    );
    // A share that is a part of the money is the start too; with no share written there is none,
    // and then a plain yes answers nothing (the question stays), while a no still leaves it out.
    const part = `${GOAL}Put $1,000 in my future.`;
    expect(outcome(read(part, r, {}))).toBe('ask mix/matchedShare start 2000/0/0/8000');
    expect(outcome(read(turns(part, 'yes'), r, {}))).toBe(
      'hold matched-sector-consumer-discretionary@2000+safe_yield@8000',
    );
    const bare = `${GOAL}I care about my future.`;
    expect(outcome(read(bare, r, {}))).toBe('ask mix/matchedShare');
    expect(outcome(read(turns(bare, 'yes'), r, {}))).toBe('ask mix/matchedShare');
    expect(outcome(read(turns(bare, 'no'), r, {}))).toBe('none');
    // In Portuguese, the question and the answers.
    const pt = read(
      'Quero investir US$ 5.000 no meu futuro por 5 anos',
      goal({ language: 'pt', ...filter('sector', 'Consumer Discretionary', 'meu futuro') }),
      {},
    );
    expect(pt.questions).toEqual([
      {
        field: 'mix',
        template: 'matchedShare',
        text: 'Li “meu futuro” como nomes filtrados por setor: Consumer Discretionary. Quanto dos US$ 5.000 para eles? Diga nada se não era isso que você quis dizer.',
        read: STOCKS,
      },
    ]);
    for (const [words, held] of [
      ['sim', 'hold matched-sector-consumer-discretionary@10000'],
      ['isso', 'hold matched-sector-consumer-discretionary@10000'],
      ['metade', 'hold matched-sector-consumer-discretionary@5000+safe_yield@5000'],
      ['não', 'none'],
      ['nada', 'none'],
    ] as const)
      expect(
        outcome(
          read(
            turns('Quero investir US$ 5.000 no meu futuro por 5 anos', words),
            goal({ language: 'pt', ...filter('sector', 'Consumer Discretionary', 'meu futuro') }),
            {},
          ),
        ),
        words,
      ).toBe(held);
    // Words that write the value have both readers, and need no question.
    const written = read(
      'I want to invest $5,000 in consumer discretionary names over 5 years',
      goal(filter('sector', 'Consumer Discretionary', 'consumer discretionary names')),
      {},
    );
    expect(outcome(written)).toBe('hold matched-sector-consumer-discretionary@10000');
    expect(written.flags).not.toContain('filter_not_written');
  });

  it('a plain yes or no answers the one question asked about what is held: yes takes its start, no leaves it out', () => {
    // The same rule for every question with a start. With no model, a stated mix:
    const mix = 'I want to grow $5,000 over 5 years, all of it in stocks';
    expect(outcome(read(mix, null))).toBe('ask mix/mix start 10000/0/0/0');
    const yes = read(turns(mix, 'yes'), null);
    expect(outcome(yes)).toBe('hold mix 10000/0/0/0');
    expect(yes.flags).toContain('mix_confirmed');
    const no = read(turns(mix, 'no'), null);
    expect(outcome(no)).toBe('none');
    expect(no.questions).toEqual([]);
    // A narrative's share the text states, with no model; the share stays the narrative's once it
    // is left out, and asks no split of the plan.
    const share = `${GOAL}Put 30% in AI.`;
    expect(outcome(read(turns(share, 'sim'), null))).toBe('hold ai@3000+safe_yield@7000');
    for (const words of ['no', 'none']) {
      const left = read(turns(share, words), null);
      expect(outcome(left), words).toBe('none');
      expect(left.questions, words).toEqual([]);
      expect(left.flags, words).toContain('market_left_out:ai');
    }
    // A mix the person wondered about, with a model.
    expect(
      outcome(read(turns(`${GOAL}Should I put all of it in stocks?`, "that's right"), goal(), {})),
    ).toBe('hold mix 10000/0/0/0');
    // A question with no start has nothing to say yes to: it stays.
    const liked = turns(`${GOAL}I like AI.`, 'yes');
    expect(outcome(read(liked, goal({ markets: ['ai'] }), {}))).toBe('ask mix/marketShare');
    // The question that asks which of two things stands is not a yes or no question.
    for (const words of ['yes', 'no'])
      expect(
        outcome(read(turns('No stocks in my IRA, so here I want all stocks', words), null)),
        words,
      ).toBe('ask mix/holdOrLeaveOut');
    // With another question open, nothing says which one the word answers: it is not taken.
    for (const words of ['yes', 'no']) {
      const two = read(turns(mix, words), null, { goal: 'grow', amountUsd: 5000 });
      expect(fields(two), words).toEqual(['mix', 'horizonMonths']);
      expect(two.flags, words).not.toContain('mix_confirmed');
      expect(two.flags, words).not.toContain('none_from_words');
    }
    // And what is no plain yes or no is read as before.
    for (const [words, said] of [
      ['yes', 'yes'],
      ['Yes!', 'yes'],
      ["that's right, thanks", 'yes'],
      ['sim, por favor', 'yes'],
      ['é isso', 'yes'],
      ['no', 'no'],
      ['não, não era isso', 'no'],
      ['yes, half', null],
      ['yes but only 20%', null],
      ['no stocks', null],
      ['not sure', null],
      ['none', null],
    ] as const)
      expect(yesOrNoSaidIn(words), words).toBe(said);
  });

  it('b6, a portfolio name must be said as a holding: after a word that picks it, as the shelf writes it, or alone', () => {
    const named = (text: string, portfolio = 'The Seven') =>
      read(text, goal({ ...MEDIUM, portfolios: [portfolio] }), {});
    for (const text of [
      `${T2}, starting from The Seven`,
      `${T2}, starting from the seven`,
      `${T2}. Put it in the seven.`,
      `${T2}. I like The Seven.`,
      turns(T2, 'the seven'),
      turns(T2, 'ok, the seven please'),
    ]) {
      expect(outcome(named(text)), text).toBe('hold from the-seven');
      expect(named(text).readBack, text).toContain('The plan starts from The Seven.');
    }
    // Words that nothing says name the portfolio are not read: dropped, flagged, nothing asked.
    for (const [text, portfolio] of [
      [`${T2}, the seven of us are saving`, 'The Seven'],
      [`${T2}. My kids are the 500 reasons I save.`, 'The 500'],
      [`${T2}. The seven years I worked abroad taught me patience.`, 'The Seven'],
    ] as const) {
      const result = named(text, portfolio);
      expect(result.flags, text).toContain('no_cue:portfolios');
      expect(result.questions, text).toEqual([]);
      expect(result.sheet?.themes, text).toEqual([]);
      expect((result.readBack ?? []).join(' '), text).not.toMatch(/starts from/);
    }
    // One its clause rules out, or says of someone else, is dropped and flagged by how.
    for (const [sentence, flag] of [
      ['I do not want The Seven.', 'portfolio_negated'],
      ['Anything but The Seven.', 'portfolio_negated'],
      ['My brother holds The Seven.', 'portfolio_aside'],
    ] as const) {
      const result = named(`${T2}. ${sentence}`);
      expect(result.flags, sentence).toContain(flag);
      expect(result.questions, sentence).toEqual([]);
      expect(result.sheet?.themes, sentence).toEqual([]);
    }
    // One the person only wonders about is asked once, by the portfolio question, with no start.
    const wondered = named(`${T2}. Should I start from The Seven?`);
    expect(wondered.flags).toContain('portfolio_wondered');
    expect(wondered.questions).toEqual([
      {
        field: 'themes',
        template: 'themes',
        text: 'Which shared portfolio, if any, do you want to start from?',
      },
    ]);
  });

  it('b6, a risk word under a negation is no word for that risk: the risk is asked with no start, on both paths', () => {
    for (const [sentence, ruledOut, cues] of [
      ["I can't take high risk.", ['high'], []],
      ['Not low risk, I want more than that.', ['low'], []],
      ['I am not aggressive.', ['high'], []],
      ['No high risk for me.', ['high'], []],
      ['Não quero risco alto.', ['high'], []],
      ['I want low risk, not high.', ['high'], ['low']],
      // A negation of something else is not of the risk; nor is one in another clause.
      ['No stocks and low risk please.', [], ['low']],
      ["I don't want to lose money so low risk.", [], ['low']],
      ['High risk is fine.', [], ['high']],
    ] as const) {
      expect(riskCuesIn(sentence), sentence).toEqual(cues);
      expect(risksRuledOutIn(sentence), sentence).toEqual(ruledOut);
    }
    for (const [sentence, risk] of [
      ["I can't take high risk.", 'high'],
      ['Not low risk, I want more than that.', 'low'],
      ['I am not aggressive.', 'high'],
    ] as const) {
      // A reply that gives the risk the text rules out, and the rules parser, which reads it too.
      for (const r of [goal({ risk }), null]) {
        const result = read(`${GOAL}${sentence}`, r, {
          goal: 'grow',
          amountUsd: 5000,
          horizonMonths: 60,
        });
        expect(result.sheet, sentence).toBeNull();
        expect(result.flags, sentence).toContain(`risk_negated:${risk}`);
        expect(result.questions, sentence).toEqual([
          {
            field: 'risk',
            template: 'risk',
            text: 'How much risk can you take: low, medium or high?',
            options: ['low', 'medium', 'high'],
          },
        ]);
      }
    }
    // The risk the person does say beside it is theirs.
    const said = read(`${GOAL}I want low risk, not high.`, goal({ risk: 'low' }), {});
    expect(said.sheet?.risk).toBe('low');
    expect(read(`${GOAL}I want low risk, not high.`, goal({ risk: 'high' }), {}).flags).toContain(
      'risk_negated:high',
    );
  });

  it('b6, a number said of the person, or bare beside a sum written as money, is no amount', () => {
    for (const [text, value, how] of [
      ['I am 35 and want to grow $5,000', 35, 'not_a_sum'],
      ['I am 35 and want to grow $5,000', 5000, 'dollars'],
      ['I am 35 and want to invest 5000', 35, 'not_a_sum'],
      ['I am 35 and want to invest 5000', 5000, 'dollars'],
      ["I'm 40 with 20000 saved", 40, 'not_a_sum'],
      ['My 25 clients keep me busy, I want to grow $5,000', 25, 'not_a_sum'],
      // A bare number is still the sum where the text writes no other as money, and a rate a
      // month is marked by its own words.
      ['Grow 3,000 for 2 years', 3000, 'dollars'],
      ['I have 5000 and want $200 a month', 5000, 'dollars'],
      ['Guardar 3 mil dólares', 3000, 'dollars'],
    ] as const)
      expect(amountInText(text, value), `${text}: ${value}`).toBe(how);
    const age = read(
      'I am 35 and want to grow $5,000 over 5 years at medium risk',
      goal({ ...MEDIUM, amountUsd: 35 }),
      {},
    );
    expect(age.sheet).toBeNull();
    expect(age.draft.amountUsd).toBeNull();
    expect(age.flags).toContain('not_a_sum:amountUsd');
    expect(age.questions).toEqual([
      { field: 'amountUsd', template: 'amountUsd', text: 'How much do you put in, in dollars?' },
    ]);
    // The reply that reads the sum the text writes is taken as before.
    expect(
      read('I am 35 and want to grow $5,000 over 5 years at medium risk', goal(MEDIUM), {}).sheet,
    ).toMatchObject({ amountUsd: 5000 });
  });

  it('b6, a text that writes two time frames in one message: the date is asked; across messages the last one decides', () => {
    const car = `${T2}, and in 2 years I buy a car`;
    // Whichever of the two the reply gives: asked once, with no start.
    for (const horizonMonths of [24, 60]) {
      const asked = read(car, goal({ ...MEDIUM, horizonMonths }), {});
      expect(asked.sheet, String(horizonMonths)).toBeNull();
      expect(asked.flags, String(horizonMonths)).toContain('horizon_several');
      expect(asked.questions, String(horizonMonths)).toEqual([
        {
          field: 'horizonMonths',
          template: 'horizonMonths',
          text: 'Is there a date by which you need this money? If not, say so and the plan has none.',
        },
      ]);
    }
    expect(
      read(car, goal({ ...MEDIUM, horizonMonths: 24 }), { horizonMonths: 60 }).sheet,
    ).toMatchObject({
      horizonMonths: 60,
    });
    // One time frame, an age beside it, or the same one said twice is no doubt.
    for (const text of [T2, `I am 35 years old. ${T2}`, turns(T2, 'yes, 60 months')])
      expect(
        read(text, goal(MEDIUM), {}).flags.filter((f) => f.startsWith('horizon_')),
        text,
      ).toEqual([]);
    // A reply that gives an earlier message's time frame is not the last word: asked, with the
    // last one written as the start.
    const earlier = read(
      turns(T2, 'Make it for 3 years'),
      goal({ ...MEDIUM, horizonMonths: 60 }),
      {},
    );
    expect(earlier.flags).toContain('horizon_not_last');
    expect(earlier.questions.find((q) => q.field === 'horizonMonths')?.read).toBe(36);
  });

  it('riskOfMix and riskOfSleeves: the risk a holding takes is the caller rule, handed what is held, the portfolios and the amount of the sheet', () => {
    const seen: unknown[] = [];
    const riskOfMix: NonNullable<IntakeInput['riskOfMix']> = (mix, themes, amountUsd) => {
      seen.push([mix, themes, amountUsd]);
      return amountUsd !== undefined && amountUsd >= 5000 ? 'medium' : 'high';
    };
    const text = `${GOAL}Invest in big tech.`;
    const held = intake(text, goal({ markets: ['big_tech'] }), { riskOfMix });
    expect(seen).toEqual([[STOCKS, ['the-seven'], 5000]]);
    // The amount handed in is the sheet's own, and the risk said is the caller's.
    expect(held.sheet).toMatchObject({ amountUsd: 5000, risk: 'medium', mix: STOCKS });
    expect(held.assumptions).toContain(
      'To hold “big tech”, the plan uses the limits for medium risk.',
    );
    // An amount answered on the form is the sheet's too.
    seen.length = 0;
    const answered = intake(text, goal({ markets: ['big_tech'], amountUsd: null }), {
      riskOfMix,
      answers: { amountUsd: 1200 },
    });
    expect(seen).toEqual([[STOCKS, ['the-seven'], 1200]]);
    expect(answered.sheet).toMatchObject({ amountUsd: 1200, risk: 'high' });
    // Left out, the estimate on the issuer caps, as before.
    expect(intake(text, goal({ markets: ['big_tech'] })).sheet?.risk).toBe(
      riskForMixEstimate(STOCKS),
    );
    // The same for a sheet held in themes: the caller's rule is handed the sleeves, the shared
    // portfolios and the amount of the sheet.
    const sleeved: unknown[] = [];
    const themed = intake(`${GOAL}Put 30% in AI.`, goal({ markets: ['ai'] }), {
      riskOfSleeves: (sleeves, themes, amountUsd) => {
        sleeved.push([sleeves, themes, amountUsd]);
        return 'medium';
      },
    });
    expect(sleeved).toEqual([[[theme('ai', 3000), safe(7000)], [], 5000]]);
    expect(themed.sheet).toMatchObject({ amountUsd: 5000, risk: 'medium' });
    expect(themed.assumptions).toContain('To hold “AI”, the plan uses the limits for medium risk.');
    // A caller that takes two arguments still fits.
    const two: IntakeInput['riskOfMix'] = (_mix, _themes) => 'low';
    expect(intake(text, goal({ markets: ['big_tech'] }), { riskOfMix: two }).sheet?.risk).toBe(
      'low',
    );
  });
});

// The third independent review (Oct 7) ran 412 new sentences and 22,000 generated texts against the
// rules of the second. What held is in the blocks above. Where it did not, one reader still decided
// alone, and an answer stood against the last word. The rule built for it: no reader decides alone,
// and the last word wins over an answer. Each finding below has the review's own sentences and
// others in other words, in English and Portuguese, with a reply that reads them, one that errs,
// and none. Every reply is MOCK.
describe('the third review (Oct 7): no reader decides alone, and the last word wins over an answer', () => {
  const FORM: IntakeAnswers = { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'medium' };
  /** A reply that reads no goal, so the form's answers stand, and what `over` says it read. */
  const reads = (over: Record<string, unknown> = {}) =>
    reply({ goal: null, amountUsd: null, horizonMonths: null, risk: null, ...over });
  /** The messages of a conversation, in order, read with a reply or with none. */
  const said = (messages: string[], r: unknown, answers: IntakeAnswers = FORM) =>
    intake(conversationText(messages[0] ?? '', messages.slice(1)), r, { answers });
  const asked = (r: { questions: { text: string }[] }) => r.questions.map((q) => q.text);

  describe('B1: a refusal the reply reads that the text check does not confirm is asked once', () => {
    type Refusal = {
      text: string;
      pt?: true;
      reply: Record<string, unknown>;
      question: string;
      line: string;
      limits: PersonalSheet['limits'];
      declined: string;
    };
    const STOCKS: Omit<Refusal, 'text' | 'reply'> = {
      question: 'Do you want to leave out stocks and stock funds?',
      line: 'You left out stocks and stock funds.',
      limits: { cannotHold: { classes: ['etf', 'stock'] } },
      declined: 'You said not to leave out stocks and stock funds, so the plan may hold them.',
    };
    const ACOES: Omit<Refusal, 'text' | 'reply'> = {
      pt: true,
      question: 'Você quer deixar de fora ações e fundos de ações?',
      line: 'Você deixou de fora ações e fundos de ações.',
      limits: { cannotHold: { classes: ['etf', 'stock'] } },
      declined:
        'Você disse para não deixar de fora ações e fundos de ações, então o plano pode ter.',
    };
    const CASES: Refusal[] = [
      // The review's own.
      { text: 'Do not buy stocks for me.', reply: { cannotHold: ['stock'] }, ...STOCKS },
      {
        text: 'I want nothing to do with crypto.',
        reply: { cannotHold: ['crypto'] },
        question: 'Do you want to leave out crypto?',
        line: 'You left out crypto.',
        limits: { cannotHold: { classes: ['crypto'] } },
        declined: 'You said not to leave out crypto, so the plan may hold them.',
      },
      { text: 'Stocks are off the table.', reply: { cannotHold: ['stock'] }, ...STOCKS },
      { text: 'Nada de bolsa.', reply: { language: 'pt', cannotHold: ['stock'] }, ...ACOES },
      // In other words.
      {
        text: 'Count me out of anything in the stock market.',
        reply: { cannotHold: ['stock'] },
        ...STOCKS,
      },
      {
        text: 'Lending is not something I am comfortable with.',
        reply: { noCredit: true },
        question: 'Do you want to leave out tokens that lend to borrowers or trade a spread?',
        line: 'No tokens that lend to borrowers or trade a spread.',
        limits: { creditTolerance: 'none' },
        declined:
          'You said not to leave out tokens that lend to borrowers or trade a spread, so the plan may hold them.',
      },
      {
        text: 'Whatever you do, the yellow metal is not for me.',
        reply: { cannotHold: ['gold'] },
        question: 'Do you want to leave out gold?',
        line: 'You left out gold.',
        limits: { cannotHold: { classes: ['gold'] } },
        declined: 'You said not to leave out gold, so the plan may hold them.',
      },
      {
        text: 'Bolsa de valores não é para mim.',
        reply: { language: 'pt', cannotHold: ['stock'] },
        ...ACOES,
      },
      {
        text: 'Ouro está fora de questão.',
        pt: true,
        reply: { language: 'pt', cannotHold: ['gold'] },
        question: 'Você quer deixar de fora ouro?',
        line: 'Você deixou de fora ouro.',
        limits: { cannotHold: { classes: ['gold'] } },
        declined: 'Você disse para não deixar de fora ouro, então o plano pode ter.',
      },
    ];

    it('asked once, with what a yes would leave out; never taken and never dropped in silence', () => {
      for (const c of CASES) {
        // The text check reads no refusal in these words: the reply is the one reader.
        expect(refusalsSaidIn(c.text), c.text).toEqual([]);
        const first = said([c.text], reads(c.reply));
        expect(asked(first), c.text).toEqual([c.question]);
        expect(first.questions[0], c.text).toMatchObject({ field: 'limits', template: 'limits' });
        expect(first.sheet, c.text).toBeNull();
        expect(first.limits, c.text).toEqual({ creditTolerance: null, cannotHoldClasses: null });
      }
    });

    it('a yes takes it, and the read-back says what is left out; the question does not come back', () => {
      for (const c of CASES)
        for (const yes of c.pt ? ['sim', 'isso'] : ['yes', "that's right"]) {
          const taken = said([c.text, yes], reads(c.reply));
          expect(taken.questions, `${c.text} / ${yes}`).toEqual([]);
          expect(taken.sheet?.limits, `${c.text} / ${yes}`).toEqual(c.limits);
          expect(taken.readBack, `${c.text} / ${yes}`).toContain(c.line);
          // A later message that says nothing of it leaves it taken.
          const later = said([c.text, yes, c.pt ? 'obrigado' : 'thanks'], reads(c.reply));
          expect(later.questions, c.text).toEqual([]);
          expect(later.sheet?.limits, c.text).toEqual(c.limits);
        }
    });

    it('a no leaves the class in, and one line says so; the question does not come back', () => {
      for (const c of CASES) {
        const left = said([c.text, c.pt ? 'não' : 'no'], reads(c.reply));
        expect(left.questions, c.text).toEqual([]);
        expect(left.sheet, c.text).not.toBeNull();
        expect(left.sheet?.limits, c.text).toBeUndefined();
        expect(left.assumptions, c.text).toContain(c.declined);
        expect(left.readBack, c.text).toContain(c.declined);
      }
    });

    it('with a reply that errs: a refusal nobody wrote is asked, never taken; one it misses has no reader', () => {
      // The reply reads a refusal where the text names nothing to leave out.
      const invented = said(['I want my savings to grow.'], reads({ cannotHold: ['stock'] }));
      expect(asked(invented)).toEqual(['Do you want to leave out stocks and stock funds?']);
      expect(invented.sheet).toBeNull();
      // And where the text states the class as what to hold: the holding is still read by both,
      // the refusal is asked, and no sheet is made with either meanwhile.
      const against = said(
        ['Put all of it in stocks.'],
        reads({ mix: pct(100, 0), cannotHold: ['stock'] }),
      );
      expect(asked(against)).toContain('Do you want to leave out stocks and stock funds?');
      expect(against.sheet).toBeNull();
      for (const c of CASES) {
        // The reply misses it, or there is no model: the words are in no reader's forms, so nothing
        // is asked and nothing is left out. With no model only the fixed forms are read.
        for (const r of [reads(c.pt ? { language: 'pt' } : {}), null]) {
          const unread = said([c.text], r);
          expect(unread.questions, c.text).toEqual([]);
          expect(unread.sheet?.limits, c.text).toBeUndefined();
        }
      }
    });

    it('the same refusal in a form the text check reads is taken with no question, with or without a model', () => {
      for (const r of [reads({ cannotHold: ['stock'] }), reads(), null]) {
        const taken = said(['No stocks for me.'], r);
        expect(taken.questions).toEqual([]);
        expect(taken.sheet?.limits).toEqual({ cannotHold: { classes: ['etf', 'stock'] } });
      }
    });

    it('a yes or no answers it only where it is the one question asked, and the form’s own limits stand over it', () => {
      const r = reads({ cannotHold: ['stock'] });
      // The risk is open too: nothing says which of the two a "yes" answers.
      const two = said(['Do not buy stocks for me.', 'yes'], r, {
        goal: 'grow',
        amountUsd: 5000,
        horizonMonths: 60,
      });
      expect(two.questions.map((q) => q.field)).toEqual(['limits', 'risk']);
      // The form says what is left out: nothing is asked.
      for (const limits of [{}, { cannotHold: { classes: ['gold' as const] } }]) {
        const formed = said(['Do not buy stocks for me.'], r, { ...FORM, limits });
        expect(formed.questions).toEqual([]);
        expect(formed.sheet?.limits ?? {}).toEqual(limits);
      }
    });
  });

  describe('B2: a class the clause of a refusal goes on to name is left out with it', () => {
    const BOTH = { cannotHold: { classes: ['etf', 'stock'] } };
    const STOCKS_ONLY = { cannotHold: { classes: ['stock'] } };
    // Each with a reply that reads both, one that reads the stocks alone, one that reads nothing,
    // and none: the funds go with the stocks whoever reads the rest.
    const REPLIES = [
      (pt: boolean) => reads({ cannotHold: ['stock', 'etf'], ...(pt ? { language: 'pt' } : {}) }),
      (pt: boolean) => reads({ cannotHold: ['stock'], ...(pt ? { language: 'pt' } : {}) }),
      (pt: boolean) => reads(pt ? { language: 'pt' } : {}),
      () => null,
    ];
    it('"including ETFs", "same goes for ETFs", "isso vale para ETFs": the funds are left out too, and nothing is asked', () => {
      for (const [text, pt] of [
        // The review's own.
        ['No stocks, including ETFs.', false],
        ['No stocks. Same goes for ETFs.', false],
        // In other words.
        ['No stocks, and that includes ETFs.', false],
        ['No stocks, ETFs too.', false],
        ['No stocks; the same for stock funds.', false],
        ['Sem ações, inclusive ETFs.', true],
        ['Sem ações. Isso vale para ETFs.', true],
      ] as const)
        for (const r of REPLIES) {
          const result = said([text], r(pt));
          expect(result.questions, text).toEqual([]);
          expect(result.sheet?.limits, text).toEqual(BOTH);
          expect(
            result.flags.filter((f) => f.startsWith('not_in_text')),
            text,
          ).toEqual([]);
        }
    });

    it('the funds stay in only where their own clause holds them: an ask, a contrast with the refusal, or something said of them', () => {
      for (const [text, pt] of [
        ['No stocks, but ETFs are fine.', false],
        ['No stocks, although I want ETFs.', false],
        ['No stocks. Put it in ETFs instead.', false],
        ['No stocks. ETFs are ok though.', false],
        ['Sem ações, mas ETFs pode.', true],
      ] as const)
        for (const r of [REPLIES[1], REPLIES[3]]) {
          const result = said([text], r?.(pt) ?? null);
          expect(result.limits.cannotHoldClasses, text).toEqual(['stock']);
          expect(result.sheet?.limits ?? STOCKS_ONLY, text).toEqual(STOCKS_ONLY);
        }
    });
  });
});

describe('the third review (Oct 7), B5: where the two readers read different mixes, neither is taken', () => {
  const FORM: IntakeAnswers = { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'medium' };
  const reads = (over: Record<string, unknown> = {}) =>
    reply({ goal: null, amountUsd: null, horizonMonths: null, risk: null, ...over });
  const said = (messages: string[], r: unknown) =>
    intake(conversationText(messages[0] ?? '', messages.slice(1)), r, { answers: FORM });
  const MIX_EN =
    'How do you want the money held: how much in stocks and crypto, and how much in cash?';
  const MIX_PT = 'Como você quer o dinheiro: quanto em ações e cripto, e quanto em caixa?';
  // The messages, the mix a faithful reply reads, and the words that then say it.
  const CASES: [string[], ReturnType<typeof pct>, string, ReturnType<typeof bps>, 'pt'?][] = [
    // The review's own.
    [
      ['My advisor wants 60/40 stocks and bonds, but I want all in stocks.'],
      pct(100, 0),
      'all of it in stocks',
      bps(10_000, 0),
    ],
    [
      ['The bank proposed everything in bonds. I say everything in stocks.'],
      pct(100, 0),
      'all of it in stocks',
      bps(10_000, 0),
    ],
    [
      ['Put 60% in stocks and 40% in cash.', 'Make the cash 50%.'],
      pct(50, 50),
      '50% stocks and 50% cash',
      bps(5000, 5000),
    ],
    // In other words.
    [
      ['Put 70% in stocks and 30% in cash.', 'Actually make the stocks half.'],
      pct(50, 50),
      'half in stocks and half in cash',
      bps(5000, 5000),
    ],
    [
      ['The robo-adviser suggests everything in cash. I would rather have everything in stocks.'],
      pct(100, 0),
      'everything in stocks',
      bps(10_000, 0),
    ],
    [
      ['Meu gerente sugeriu 60% em ações e 40% em renda fixa, mas eu quero tudo em ações.'],
      pct(100, 0),
      'tudo em ações',
      bps(10_000, 0),
      'pt',
    ],
    [
      ['Quero 80% em ações e 20% em caixa.', 'Pensando bem, deixa o caixa em 40%.'],
      pct(60, 40),
      '60% em ações e 40% em caixa',
      bps(6000, 4000),
      'pt',
    ],
  ];

  it('with a reply that reads the person’s mix: asked once with no start, never the text check’s reading taken', () => {
    for (const [messages, mix, , , pt] of CASES) {
      const where = messages.join(' / ');
      const result = said(messages, reads({ mix, ...(pt ? { language: 'pt' } : {}) }));
      expect(result.flags, where).toEqual(
        expect.arrayContaining(['disagrees_with_rules:mix', 'mix_asked:differs']),
      );
      expect(result.questions, where).toEqual([
        { field: 'mix', template: 'mix', text: pt ? MIX_PT : MIX_EN },
      ]);
      expect(result.sheet, where).toBeNull();
      expect(result.mix, where).toBeNull();
    }
  });

  it('the person then says it: taken as said; a yes has no start to take, and a no leaves no mix', () => {
    for (const [messages, mix, words, held, pt] of CASES) {
      const where = messages.join(' / ');
      const r = reads({ mix, ...(pt ? { language: 'pt' } : {}) });
      const answered = said([...messages, words], r);
      expect(answered.questions, where).toEqual([]);
      expect(answered.sheet?.mix, where).toEqual(held);
      expect(answered.flags, where).toContain('mix_from_words');
      // A plain yes confirms nothing: there was no start. The question stays.
      expect(said([...messages, pt ? 'sim' : 'yes'], r).questions, where).toHaveLength(1);
      const none = said([...messages, pt ? 'nenhum' : 'none'], r);
      expect(none.questions, where).toEqual([]);
      expect(none.sheet, where).not.toBeNull();
      expect(none.sheet?.mix, where).toBeUndefined();
    }
  });

  it('with a reply that errs: a mix against what the text states is asked, never taken, and never the form’s start', () => {
    for (const [text, hostile] of [
      ['Put all of it in stocks.', pct(0, 100)],
      ['I want 70% stocks and 30% cash.', pct(100, 0)],
      ['Quero tudo em ações.', pct(0, 0, 0, 100)],
    ] as const) {
      const result = said([text], reads({ mix: hostile }));
      expect(result.sheet, text).toBeNull();
      expect(
        result.questions.map((q) => [q.field, q.read]),
        text,
      ).toEqual([['mix', undefined]]);
    }
  });

  it('with no model: the mix the text check reads is asked once with it as the start, as before', () => {
    for (const [messages] of CASES) {
      const result = said([messages[0] ?? ''], null);
      expect(result.sheet, messages[0]).toBeNull();
      expect(
        result.questions.map((q) => q.field),
        messages[0],
      ).toEqual(['mix']);
      expect(result.flags, messages[0]).toContain('mix_asked:rules');
    }
  });

  it('where both read the same mix it is taken with no question, as before', () => {
    const same = said(['Put 60% in stocks and 40% in cash.'], reads({ mix: pct(60, 40) }));
    expect(same.questions).toEqual([]);
    expect(same.sheet?.mix).toEqual(bps(6000, 4000));
  });
});
