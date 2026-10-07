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
  type Market,
  marketMentionsIn,
  marketShareIn,
  marketsIn,
  mixIn,
  mixSaidIn,
  refusalsIn,
  refusalsSaidIn,
  shareSaidIn,
  timeFramesIn,
} from './intake-text';
import {
  attributeKey,
  type FilterMatch,
  type MarketFilter,
  type ShelfLabel,
} from './market-filter';
import { launchShelf } from './testing';
import type { PersonalSheet } from './types';

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
    expect(asked.limits.cannotHoldClasses).toEqual(['stock']);
    const done = intake(text, faithful, { answers: { risk: 'low' } });
    expect(done.questions).toEqual([]);
    const sheet = done.sheet as PersonalSheet;
    expect(sheet.risk).toBe('low');
    expect(sheet.mix).toBeUndefined();
    expect(sheet.limits).toEqual({ cannotHold: { classes: ['stock'] } });
    const said = done.readBack ?? [];
    expect(said).toContain('You left out stocks.');
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
    expect(answered.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
    expect(answered.readBack).toContain('You left out stocks.');
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

  it('the playground case: with no model, "I am retired so no stocks please" leaves stocks out, and the read-back says so', () => {
    const text = `${GOAL}I am retired so no stocks please.`;
    // Read before any answer, and not asked: what the rules reader read is asked, the refusal is not.
    const first = intake(text, null);
    expect(first.method).toBe('rules');
    expect(first.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['stock'] });
    expect(fields(first)).toEqual(['goal', 'amountUsd', 'horizonMonths', 'risk']);
    // With the goal, the amount, the date and the risk answered: the sheet carries it.
    const done = intake(text, null, { answers: ANSWERS });
    expect(done.questions).toEqual([]);
    const sheet = done.sheet as PersonalSheet;
    expect(sheet.limits).toEqual({ cannotHold: { classes: ['stock'] } });
    expect(sheet.mix).toBeUndefined();
    expect(done.readBack).toEqual([
      'You set a goal to grow with $20,000 over 3 years, at low risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'You left out stocks.',
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
    expect(pt.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['stock'] });
    expect(pt.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
    expect(pt.readBack).toContain('Você deixou de fora ações.');
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
      cannotHold: { classes: ['crypto', 'stock'] },
    });
    expect(several.readBack).toEqual(
      expect.arrayContaining([
        'You left out crypto and stocks.',
        'No tokens that lend to borrowers or trade a spread.',
      ]),
    );
    for (const [words, limits] of [
      ['no stocks', { cannotHold: { classes: ['stock'] } }],
      ['without crypto', { cannotHold: { classes: ['crypto'] } }],
      ['zero stocks', { cannotHold: { classes: ['stock'] } }],
      ['avoid crypto', { cannotHold: { classes: ['crypto'] } }],
      ['no gold', { cannotHold: { classes: ['gold'] } }],
      ['no stocks or crypto', { cannotHold: { classes: ['crypto', 'stock'] } }],
      ['no stocks at all', { cannotHold: { classes: ['stock'] } }],
      ['no stocks in my plan', { cannotHold: { classes: ['stock'] } }],
      ['no exposure to crypto', { cannotHold: { classes: ['crypto'] } }],
      ['avoid all stocks', { cannotHold: { classes: ['stock'] } }],
      ['não quero ações', { cannotHold: { classes: ['stock'] } }],
      ['não quero investir em ações', { cannotHold: { classes: ['stock'] } }],
      ['não quero nada de ações', { cannotHold: { classes: ['stock'] } }],
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
      expect(result.sheet?.limits, sentence).toEqual({ cannotHold: { classes: ['stock'] } });
    }
    // A stated holding beside a refusal of another class is still held.
    const both = intake(
      'I want to grow $20,000 for 3 years. No crypto, all of it in stocks.',
      null,
      {
        answers: { goal: 'grow', amountUsd: 20_000, horizonMonths: 36 },
      },
    );
    expect(both.sheet).toMatchObject({
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
    expect(sure.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
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
    expect(missed.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['stock'] });
    expect(missed.flags).toContain('disagrees_with_rules:cannotHold:stock');
    expect(missed.questions).toEqual([]);
    expect(missed.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
    expect(missed.readBack).toContain('You left out stocks.');
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
      cannotHold: { classes: ['crypto', 'stock'] },
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
    expect(agreed.sheet?.limits).toEqual({ cannotHold: { classes: ['stock'] } });
  });

  it('the model adds none: what it gives that the text does not state is not taken, and never in silence', () => {
    // Not written at all: dropped and flagged, as before.
    const unwritten = intake(GOAL, model({ cannotHold: ['gold'], noCredit: true }));
    expect(unwritten.limits).toEqual(NONE);
    expect(unwritten.flags).toEqual(
      expect.arrayContaining(['not_in_text:cannotHold:gold', 'not_in_text:noCredit']),
    );
    expect(unwritten.sheet?.limits).toBeUndefined();
    // Written, and the clause says otherwise: the text's reading stands, and because a reader took
    // it for a refusal it is said back for the person to settle.
    for (const [sentence, stance, words] of [
      ['No stocks? Not sure.', 'wondered', 'No stocks'],
      ['My brother holds no stocks.', 'aside', 'no stocks'],
      ["I can't do without stocks.", 'negated', 'without stocks'],
    ] as const) {
      const result = intake(GOAL + sentence, model({ cannotHold: ['stock'] }), {
        answers: { risk: 'low' },
      });
      expect(result.limits, sentence).toEqual(NONE);
      expect(result.sheet?.limits, sentence).toBeUndefined();
      expect(result.flags, sentence).toContain(`refusal_${stance}:stock`);
      expect(result.flags, sentence).not.toContain('not_in_text:cannotHold:stock');
      expect(result.assumptions, sentence).toContain(
        `I did not read “${words}” as something to leave out. Say so if you want it left out.`,
      );
    }
    // The model's mix is never offered as the start of a question where the text refuses its class.
    const erring = intake(`${GOAL}I am retired so no stocks please.`, model({ mix: pct(100, 0) }));
    expect(erring.questions.find((q) => q.field === 'mix')?.read).toBeUndefined();
    expect(erring.limits.cannotHoldClasses).toEqual(['stock']);
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
      // And every refusal of the set is one its clause states.
      const said = refusalsSaidIn(g.text).filter((r) => r.stance === 'stated');
      const classes = [
        ...new Set(said.flatMap((r) => (r.what === 'credit' ? [] : [r.what]))),
      ].sort();
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
    // With no model, the risk answered on the form.
    const rules = intake('I want to grow $2,000 over 5 years. I want all of it in stocks', null, {
      answers: { goal: 'grow', amountUsd: 2000, horizonMonths: 60, risk: 'medium' },
    });
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
      // With no model the same mix is read, and the risk is not among what is asked.
      const byRules = intake(text, null);
      expect(byRules.mix, words).toEqual(mix);
      expect(fields(byRules), words).not.toContain('risk');
      expect(fields(byRules), words).not.toContain('mix');
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
        const result = intake(
          text,
          r,
          r === null ? { answers: { ...ANSWERED, amountUsd: 2000 } } : {},
        );
        const where = `${words} ${r === null ? 'rules' : 'model'}`;
        expect(result.flags, where).toContain('mix_from_market');
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
    const rules = intake('I want to grow $2,000 over 5 years. 30% in AI.', null, {
      answers: { ...ANSWERED, amountUsd: 2000 },
    });
    expect(rules.questions).toEqual([]);
    expect(rules.sheet?.sleeves).toEqual([theme('ai', 3000), safe(7000)]);
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
