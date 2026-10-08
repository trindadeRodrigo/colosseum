import {
  conversationText,
  parseStockAttributes,
  parseThemeList,
  runIntake,
} from '@colosseum/engine/personal';
import { describe, expect, it, vi } from 'vitest';
import stockCatalog from '../../../../../content/stocks/solana.json';
import evTheme from '../../../../../content/themes/solana/ev-autonomy.json';
import { launchShelf } from '../../../../../packages/engine/src/personal/testing';
import { budgetedModel, type IntakeVocabulary } from '../../llm';
import { contextualIntake, executionHistory, IntakeRequest, namedCompanyDialogue } from './intake';

// MOCK semantic interpretations. Real pure engine checks run; no network or database is used.
const NOW = '2026-10';
const interest = (quote: string, keywords: string[] = []) => ({
  clarification: { kind: 'interest', quote, keywords },
});
const grow = {
  goal: 'grow',
  amountUsd: 2000,
  horizonMonths: 120,
  risk: 'high',
  currency: 'USD',
};
const complete = 'Grow USD $2,000 for ten years, high risk';
const vocabulary: IntakeVocabulary = {
  sectors: [],
  industries: [],
  subIndustries: [],
  keywords: ['GLP-1'],
};
const read = (text: string, reply: unknown, latest = text, words = vocabulary) => {
  const engine = runIntake({ text, nowMonth: NOW, reply, homeChain: 'solana', portfolios: [] });
  return {
    engine,
    response: contextualIntake(engine, reply, latest, NOW, words, {
      pendingInterest: null,
      sourceTurn: 0,
    }),
  };
};

describe('contextual interest questions at the API / execution-reader seam', () => {
  it('offers only available confirmed catalog themes for a person-named company and reports an unlisted instrument honestly', () => {
    const stocks = parseStockAttributes(stockCatalog);
    const themes = [parseThemeList(evTheme)];
    const assets = launchShelf().assets;
    expect(namedCompanyDialogue('i like elon', stocks, themes, assets, 'en')).toBeUndefined();
    const company = namedCompanyDialogue('Tesla', stocks, themes, assets, 'en');
    expect(company).toMatchObject({ quote: 'Tesla', name: 'Tesla, Inc.', listed: true });
    expect(company?.options).toEqual([`I want to invest in ${evTheme.name.en}.`]);
    const unavailable = namedCompanyDialogue('Tesla', stocks, themes, [], 'en');
    expect(unavailable).toMatchObject({ listed: false, options: [] });
    const engine = runIntake({
      text: 'Tesla',
      nowMonth: NOW,
      reply: {},
      homeChain: 'solana',
      portfolios: [],
    });
    const out = contextualIntake(
      engine,
      {},
      'Tesla',
      NOW,
      vocabulary,
      { pendingInterest: { quote: 'i like elon', sourceTurn: 0 }, sourceTurn: 1 },
      unavailable,
    );
    expect(out.questions[0]?.text).toContain('not listed on this chain');
    expect(out.sheet).toBeNull();
  });
  it('advances the screenshot sequence without losing the original person source or inferring an asset', () => {
    const pending = { quote: 'i like elon', sourceTurn: 0 };
    const latest = 'I want to invest in stocks that will benefit from Elon Musk';
    const reply = { ...interest(latest), interestResolution: { kind: 'business', quote: latest } };
    const engine = runIntake({
      text: conversationText(pending.quote, ['elon musk!', latest]),
      nowMonth: NOW,
      reply,
      homeChain: 'solana',
      portfolios: [],
    });
    const out = contextualIntake(engine, reply, latest, NOW, vocabulary, {
      pendingInterest: pending,
      sourceTurn: 2,
    });
    expect(out.pendingInterest).toEqual(pending);
    expect(out.questions[0]?.text).toContain('Which particular company or sector');
    expect(out.sheet).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/Tesla|TSLA/);
    const declined = contextualIntake(engine, null, 'Ignore that interest.', NOW, vocabulary, {
      pendingInterest: pending,
      sourceTurn: 3,
    });
    expect(declined.pendingInterest).toBeNull();
  });

  it('validated market resolution takes precedence over contradictory fresh clarification', () => {
    const latest = 'I want to invest in electric vehicle businesses';
    const reply = {
      markets: ['ev_autonomy'],
      ...interest(latest),
      interestResolution: { kind: 'business', quote: latest },
    };
    const engine = runIntake({
      text: latest,
      nowMonth: NOW,
      reply,
      homeChain: 'solana',
      portfolios: [],
    });
    const out = contextualIntake(engine, reply, latest, NOW, vocabulary, {
      pendingInterest: { quote: 'i like elon', sourceTurn: 0 },
      sourceTurn: 1,
    });
    expect(out.pendingInterest).toBeNull();
    expect(out.questions.some((q) => q.template === 'interestClarification')).toBe(false);
  });
  it('retains reviewed 200-message/22,000-character capacity with aligned origin and form arrays', () => {
    const followUps = Array.from({ length: 199 }, () => 'a');
    expect(
      IntakeRequest.safeParse({
        text: 'goal',
        followUps,
        answersThen: followUps.map(() => ({})),
        dialogueVersion: 1,
        questionThen: followUps.map(() => null),
      }).success,
    ).toBe(true);
    expect(IntakeRequest.safeParse({ text: 'goal', followUps: [...followUps, 'a'] }).success).toBe(
      false,
    );
    const boundary = {
      text: 'x'.repeat(2000),
      followUps: Array.from({ length: 10 }, () => 'x'.repeat(1998)),
    };
    expect(conversationText(boundary.text, boundary.followUps)).toHaveLength(22000);
    expect(IntakeRequest.safeParse(boundary).success).toBe(true);
    expect(
      IntakeRequest.safeParse({ ...boundary, followUps: [...boundary.followUps, 'a'] }).success,
    ).toBe(false);
    expect(
      IntakeRequest.safeParse({ text: 'goal', followUps: ['yes'], answersThen: [] }).success,
    ).toBe(false);
  });
  it('legacy clients never receive contextual questions or pending state', () => {
    const engine = runIntake({
      text: 'i like elon',
      nowMonth: NOW,
      reply: interest('i like elon'),
      homeChain: 'solana',
      portfolios: [],
    });
    expect(contextualIntake(engine, interest('i like elon'), 'i like elon', NOW, vocabulary)).toBe(
      engine,
    );
  });

  it.each(['Ignore that interest.', 'Ignore esse interesse.'])(
    'an explicit authored decline works without a model and returns only validated ordinary readback: %s',
    (latest) => {
      const engine = runIntake({
        text: conversationText(complete, ['i like elon', latest]),
        nowMonth: NOW,
        reply: null,
        answers: {
          goal: 'grow',
          amountUsd: 2000,
          horizonMonths: 120,
          risk: 'high',
          currency: 'USD',
        },
        homeChain: 'solana',
        portfolios: [],
      });
      expect(engine.sheet).not.toBeNull();
      const response = contextualIntake(engine, null, latest, NOW, vocabulary, {
        pendingInterest: { quote: 'i like elon', sourceTurn: 1 },
        sourceTurn: 2,
      });
      expect(response.pendingInterest).toBeNull();
      expect(response.sheet).toEqual(engine.sheet);
      expect(response.readBack).toEqual(engine.readBack);
      expect(response.questions).toEqual([]);
    },
  );

  it.each([
    '"Ignore that interest."',
    'Do not ignore that interest.',
    'My friend said Ignore that interest.',
    'Ignore that interest? No, keep it.',
  ])(
    'quoted, negated, historical or reversed declines never clear without a model: %s',
    (latest) => {
      const engine = runIntake({
        text: conversationText(complete, ['i like elon', latest]),
        nowMonth: NOW,
        reply: null,
        homeChain: 'solana',
        portfolios: [],
      });
      const response = contextualIntake(engine, null, latest, NOW, vocabulary, {
        pendingInterest: { quote: 'i like elon', sourceTurn: 1 },
        sourceTurn: 2,
      });
      expect(response.pendingInterest).toEqual({ quote: 'i like elon', sourceTurn: 1 });
      expect(response.sheet).toBeNull();
    },
  );

  it('rules-only complete new instruction remains conservatively pending until explicit decline or a model-validated reply', () => {
    const engine = runIntake({
      text: conversationText('i like elon', [complete]),
      nowMonth: NOW,
      reply: null,
      answers: { goal: 'grow', amountUsd: 2000, horizonMonths: 120, risk: 'high', currency: 'USD' },
      homeChain: 'solana',
      portfolios: [],
    });
    expect(engine.sheet).not.toBeNull();
    const response = contextualIntake(engine, null, complete, NOW, vocabulary, {
      pendingInterest: { quote: 'i like elon', sourceTurn: 0 },
      sourceTurn: 1,
    });
    expect(response.pendingInterest).toEqual({ quote: 'i like elon', sourceTurn: 0 });
    expect(response.sheet).toBeNull();
  });

  it.each(['thanks', 'yes', 'no', 'sim', 'não', 'obrigado'])(
    'pending interest survives historic ready facts followed by %s and model fallback',
    (latest) => {
      const text = conversationText(complete, ['i like elon', latest]);
      for (const reply of [grow, null, { ...grow, ...interest('i like elon') }]) {
        const engine = runIntake({
          text,
          nowMonth: NOW,
          reply,
          homeChain: 'solana',
          portfolios: [],
        });
        const pending = { quote: 'i like elon', sourceTurn: 1 };
        const response = contextualIntake(engine, reply, latest, NOW, vocabulary, {
          pendingInterest: pending,
          sourceTurn: 2,
        });
        expect(response.pendingInterest).toEqual(pending);
        expect(response.sheet).toBeNull();
        expect(response.readBack).toBeNull();
        expect(response.questions[0]?.text).toContain('i like elon');
      }
    },
  );

  it('removes only marked ambiguous contextual replies and matching snapshots from execution history', () => {
    const body = IntakeRequest.parse({
      text: complete,
      followUps: ['i like elon', 'yes', 'I want to invest in EV businesses'],
      answersThen: [{ currency: 'USD' }, { themes: ['the-seven'] }, { amountUsd: 2000 }],
      dialogueVersion: 1,
      pendingInterest: { quote: 'i like elon', sourceTurn: 1 },
      questionThen: [null, 'interestClarification', 'interestClarification'],
    });
    const execution = executionHistory(body);
    expect(execution.text).toBe(
      conversationText(complete, ['i like elon', 'I want to invest in EV businesses']),
    );
    expect(execution.answersThen).toEqual([{ currency: 'USD' }, { amountUsd: 2000 }]);
    expect(body.followUps).toEqual(['i like elon', 'yes', 'I want to invest in EV businesses']);
    expect(body.pendingInterest?.sourceTurn).toBe(1);
    expect(executionHistory({ ...body, questionThen: [null, null, null] }).text).toBe(
      conversationText(complete, body.followUps),
    );
  });

  it('a yes addressed to contextual interest cannot confirm the older Seven question even after explicit resolution', () => {
    const text = `${complete}. My pick is the seven.`;
    const body = IntakeRequest.parse({
      text,
      followUps: ['i like elon', 'yes'],
      dialogueVersion: 1,
      pendingInterest: { quote: 'i like elon', sourceTurn: 1 },
      questionThen: [null, 'interestClarification'],
      answersThen: [{}, {}],
    });
    const reply = { ...grow, portfolios: ['The Seven'] };
    const engine = runIntake({
      ...executionHistory(body),
      nowMonth: NOW,
      reply,
      homeChain: 'solana',
      portfolios: [{ name: 'The Seven', slug: 'the-seven' }],
    });
    expect(engine.flags).not.toContain('portfolio_confirmed');
    expect(engine.sheet).toBeNull();
    expect(engine.questions.some((q) => q.template === 'startFrom')).toBe(true);
    const response = contextualIntake(engine, reply, 'yes', NOW, vocabulary, {
      pendingInterest: body.pendingInterest ?? null,
      sourceTurn: 2,
    });
    expect(response.pendingInterest).toEqual(body.pendingInterest);
    expect(response.sheet).toBeNull();
    const finalWords = 'Ignore that interest';
    const resolved = contextualIntake(
      engine,
      { ...reply, interestResolution: { kind: 'decline', quote: finalWords } },
      finalWords,
      NOW,
      vocabulary,
      { pendingInterest: body.pendingInterest ?? null, sourceTurn: 3 },
    );
    expect(resolved.pendingInterest).toBeNull();
    expect(resolved.questions.some((q) => q.template === 'startFrom')).toBe(true);
    expect(resolved.sheet).toBeNull();
  });

  it.each([
    ['I want to invest in electric vehicle businesses', 'business'],
    ['Quero investir em negócios de veículos elétricos', 'business'],
    ['Put 40% in stocks and 60% in cash', 'allocation'],
    ['Ignore that interest', 'decline'],
    ['Esqueça esse interesse', 'decline'],
  ])(
    'explicit person instruction %s resolves pending interest while ordinary missing facts remain',
    (latest, kind) => {
      const reply = { interestResolution: { kind, quote: latest } };
      const engine = runIntake({
        text: conversationText('i like elon', [latest]),
        nowMonth: NOW,
        reply,
        homeChain: 'solana',
        portfolios: [],
      });
      const response = contextualIntake(engine, reply, latest, NOW, vocabulary, {
        pendingInterest: { quote: 'i like elon', sourceTurn: 0 },
        sourceTurn: 1,
      });
      expect(response.pendingInterest).toBeNull();
      expect(response.questions).toEqual(engine.questions);
      expect(response.sheet).toBeNull();
    },
  );

  it.each([
    'yes',
    'thanks',
    'My friend said I want to invest in EV businesses',
    'If I want to invest in EV businesses',
    'I do not want to invest in EV businesses',
    '"I want to invest in EV businesses"',
    'I want you to explain what Elon does',
    'I want to know about electric vehicle businesses',
    'I want Elon businesses to succeed',
    'If I wanted to grow USD $2,000 for ten years at high risk, would that work?',
    'My friend wants to grow USD $2,000 for ten years at high risk.',
    'I have a friend who wants to grow USD $2,000 for ten years at high risk.',
  ])('unsafe or ambiguous semantic resolution cannot discharge pending interest: %s', (latest) => {
    const reply = { ...grow, interestResolution: { kind: 'business', quote: latest } };
    const engine = runIntake({
      text: conversationText(complete, ['i like elon', latest]),
      nowMonth: NOW,
      reply,
      homeChain: 'solana',
      portfolios: [],
    });
    const response = contextualIntake(engine, reply, latest, NOW, vocabulary, {
      pendingInterest: { quote: 'i like elon', sourceTurn: 1 },
      sourceTurn: 2,
    });
    expect(response.pendingInterest).toEqual({ quote: 'i like elon', sourceTurn: 1 });
    expect(response.sheet).toBeNull();
  });

  it.each([
    { questionThen: [] },
    { questionThen: [null, null] },
    { questionThen: ['startFrom'] },
    { pendingInterest: { quote: 'not written', sourceTurn: 0 } },
    { pendingInterest: { quote: 'i like elon', sourceTurn: 2 } },
    { answersThen: [] },
  ])('rejects misaligned/forged context state: %j', (patch) => {
    expect(
      IntakeRequest.safeParse({
        text: 'i like elon',
        followUps: ['yes'],
        dialogueVersion: 1,
        questionThen: ['interestClarification'],
        pendingInterest: { quote: 'i like elon', sourceTurn: 0 },
        ...patch,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['i like elon', 'en', 'When you say “i like elon”'],
    ['eu gosto do elon', 'pt', 'Quando você diz “eu gosto do elon”'],
  ])(
    'asks a relevant question for %s without adopting a company or asset',
    (text, language, prefix) => {
      const { engine, response } = read(text, { ...interest(text), language });
      expect(response.questions[0]).toMatchObject({
        field: 'themes',
        template: 'interestClarification',
        text: expect.stringContaining(prefix),
      });
      expect(response.questions[0]?.options).toEqual([
        language === 'pt' ? 'Ignore esse interesse.' : 'Ignore that interest.',
      ]);
      expect(response.draft).toEqual(engine.draft);
      expect(response.mix).toBeNull();
      expect(response.narratives).toEqual([]);
      expect(response.sheet).toBeNull();
      expect(response.readBack).toBeNull();
      expect(JSON.stringify(response)).not.toMatch(/Tesla|TSLA/);
      expect(response.questions.slice(1)).toEqual(engine.questions);
    },
  );

  it('blocks historic ready facts for a new unresolved interest without changing the draft', () => {
    const text = conversationText(complete, ['i like elon']);
    const { engine, response } = read(text, { ...grow, ...interest('i like elon') }, 'i like elon');
    expect(engine.sheet).not.toBeNull();
    expect(response.sheet).toBeNull();
    expect(response.readBack).toBeNull();
    expect(response.draft).toEqual(engine.draft);
  });

  it('does not prepend exploration to a complete valid latest instruction even with wrong metadata', () => {
    const { engine, response } = read(complete, { ...grow, ...interest('Grow') });
    expect(engine.sheet).not.toBeNull();
    expect(response).toEqual({ ...engine, pendingInterest: null });
    expect(response.readBack).not.toBeNull();
  });

  it('drops stale first-turn interest after a later explicit instruction and resumes read-back', () => {
    const text = conversationText('i like elon', [complete]);
    const { engine, response } = read(text, { ...grow, ...interest('i like elon') }, complete);
    expect(engine.sheet).not.toBeNull();
    expect(response).toEqual({ ...engine, pendingInterest: null });
    expect(response.readBack).not.toBeNull();
  });

  it('a later explicit business request resumes ordinary facts, never repeats the old interest', () => {
    const latest = 'I want to invest in electric vehicle businesses';
    const text = conversationText('i like elon', [latest]);
    const { engine, response } = read(
      text,
      { markets: ['ev_autonomy'], ...interest('i like elon') },
      latest,
    );
    expect(response).toEqual({ ...engine, pendingInterest: null });
    expect(response.questions.some((q) => q.template === 'interestClarification')).toBe(false);
    expect(response.questions.some((q) => q.field === 'goal')).toBe(true);
  });

  it('plain yes cannot adopt an earlier exploratory interest as a holding or a themes answer', () => {
    const text = conversationText('i like elon', ['yes']);
    const { engine, response } = read(text, interest('i like elon'), 'yes');
    expect(response).toEqual({ ...engine, pendingInterest: null });
    expect(response.sheet).toBeNull();
    expect(response.narratives).toEqual([]);
    expect(response.draft.themes).toBeNull();
    expect(response.questions.some((q) => q.field === 'goal')).toBe(true);
  });

  it('only offers person-written supplied catalog keywords as new natural-language messages', () => {
    const { response } = read('I like GLP-1', interest('I like GLP-1', ['GLP-1']));
    expect(response.questions[0]?.options).toEqual([
      'I want to invest in businesses related to GLP-1.',
      'Ignore that interest.',
    ]);
    const pt = read('Eu gosto de GLP-1', {
      ...interest('Eu gosto de GLP-1', ['GLP-1']),
      language: 'pt',
    });
    expect(pt.response.questions[0]?.options).toEqual([
      'Quero investir em negócios ligados a GLP-1.',
      'Ignore esse interesse.',
    ]);
    const inferred = read('i like elon', interest('i like elon', ['GLP-1']));
    expect(inferred.response.questions[0]?.options).toEqual(['Ignore that interest.']);
  });

  it.each([
    null,
    {},
    { clarification: null },
    interest('not written'),
    interest(' i like elon'),
    interest('i like elon', ['Tesla']),
    { clarification: { kind: 'interest', quote: 'i like elon', keywords: [], asset: 'TSLA' } },
    interest('i like elon', ['GLP-1', 'GLP-1', 'GLP-1', 'GLP-1']),
  ])('invalid or absent metadata safely preserves the ordinary engine response: %j', (reply) => {
    const { engine, response } = read('i like elon', reply);
    expect(response).toEqual({ ...engine, pendingInterest: null });
  });

  it.each([
    'My friend said "I like Elon".',
    'I do not like Elon.',
    'If I liked Elon, would that mean all in stocks?',
    'Yesterday I read a story about Elon.',
  ])('a non-interest model interpretation does not create an allocation: %s', (text) => {
    const { engine, response } = read(text, { clarification: null, markets: [], mix: null });
    expect(response).toEqual({ ...engine, pendingInterest: null });
    expect(response.mix).toBeNull();
    expect(response.sheet).toBeNull();
  });

  it('uses the existing budget/cache call once and falls back after a timeout with no new read', async () => {
    const call = vi.fn(async () => ({ reply: interest('i like elon') }));
    const model = budgetedModel(call);
    const first = await model.read('i like elon', NOW, 'en', 'person');
    const again = await model.read('i like elon', NOW, 'en', 'person');
    read('i like elon', first.reply);
    read('i like elon', again.reply);
    expect(call).toHaveBeenCalledTimes(1);
    const timeout = vi.fn(async () => ({ reply: null, why: 'model_timeout' }));
    const fallback = await budgetedModel(timeout).read('i like elon', NOW, 'en', 'person');
    const { engine, response } = read('i like elon', fallback.reply);
    expect(response).toEqual({ ...engine, pendingInterest: null });
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
