import type { BasketAsset, ChainId, VaultState } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel } from '../vault-agent-model';
import {
  replyToVaultConversation,
  type VaultAgentContext,
  withoutRepeatedQuestion,
} from './vault-agent';

// Rodrigo, Oct 9, on the hosted app: "all in tGOOGLx" on an income vault was refused ("he is not
// obeying"), and the reply asked its question twice. A stock the person names for the whole vault is
// asked for in their own words (gates ANY-COMPOSITION, PROTECT-NO-STOCKS): the draft holds it at the
// share they said, with the warning. Offline model replies are fixtures; no model is called.

/** A chain's catalog as its test network lists it: tGOOGLx stands in for GOOGLx, tGOOGL for GOOGL. */
function testNetwork(chain: ChainId): BasketAsset[] {
  return launchShelf()
    .assets.filter((asset) => asset.chain === chain)
    .map((asset) =>
      asset.cls === 'cash'
        ? asset
        : {
            ...asset,
            id: chain === 'robinhood' ? `${chain}:t${asset.symbol.toLowerCase()}` : asset.id,
            symbol: `t${asset.symbol}`,
            provenance: 'sandbox' as const,
          },
    );
}
const now = '2026-10-09T20:00:00.000Z';
const noted: ['app', string] = ['app', 'Noted.'];
type Turn = string | ['app' | 'person', string];

function world(chain: ChainId, goal: 'income' | 'protect' | 'grow' = 'income') {
  const assets = testNetwork(chain);
  const by = (underlying: string) => {
    const asset = assets.find((candidate) => candidate.underlying === underlying);
    if (!asset) throw new Error(`No ${underlying} on ${chain}`);
    return asset;
  };
  const cash = assets.find((asset) => asset.cls === 'cash');
  const reserves = assets.filter((asset) => asset.cls === 'dollar_yield');
  const [reserve, other] = reserves;
  if (!cash || !reserve) throw new Error('Incomplete offline catalog fixture');
  const googl = by('GOOGL');
  const nvda = by('NVDA');
  const tsla = by('TSLA');
  const held = (asset: BasketAsset, targetBps: number) => ({
    asset: asset.id,
    raw: '10000000',
    display: '10',
    multiplier: '1',
    targetBps,
    lastKeeperAt: null,
  });
  const state: VaultState = {
    chain,
    address: cash.address,
    owner: cash.address,
    basketId: '1',
    keeper: cash.address,
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    cash: { asset: cash.id, raw: '1000000000', display: '1000', multiplier: '1' },
    positions: [held(reserve, 5000), ...(other ? [held(other, 2500)] : [])],
    lossUsedBps: 0,
    observedAt: now,
    pending: null,
  };
  const context: VaultAgentContext = {
    person: 'owner-fixture',
    state,
    assets,
    currentGoals: [{ goal, objective: 'Earn an income every month' }],
    evidence: assets.map((asset) => ({
      id: `catalog:${asset.id}`,
      assetId: asset.id,
      source: 'offline catalog',
      method: 'listed assets',
      fetchedAt: now,
      provenance: 'sandbox',
    })),
    stockAttributes: {
      stocks: [
        { symbol: googl.symbol, company: 'Alphabet Inc.' },
        { symbol: nvda.symbol, company: 'NVIDIA Corporation' },
        { symbol: tsla.symbol, company: 'Tesla, Inc.' },
      ],
    } as unknown as VaultAgentContext['stockAttributes'],
    liquidity: [],
    unknowns: [],
  };
  const pick = (asset: BasketAsset) => ({
    assetId: asset.id,
    why: 'You asked for it.',
    evidenceIds: [`catalog:${asset.id}`],
  });
  /** The model as it should answer: a draft of the assets given. */
  const drafting = (...picked: BasketAsset[]) => ({
    message: 'Here is a draft for your vault. Nothing changes until you review and confirm it.',
    question: null,
    proposal: {
      objective: 'Hold what you asked for',
      summary: 'The draft holds the asset you named.',
      allocations: picked.map(pick),
      stated: [],
      tradeoffs: ['A single stock token can lose value quickly.'],
      unknowns: [],
    },
  });
  /** The model as it answered on the hosted app: no draft, and its question twice. */
  const refusing = () => ({
    message: `I can see you want all of it in ${googl.symbol}, but your vault is on an income plan with low risk, and a plan with this goal cannot hold stock tokens like ${googl.symbol}. So I have not put it into a draft, and your vault still holds ${reserve.symbol} with cash. If you want Alphabet exposure, that would need a separate growth draft with a different goal, which you would review and confirm before anything changed. Would you like me to start a separate growth draft for Alphabet, or keep this vault on income-eligible tokens?`,
    question:
      'Would you like a separate growth draft for Alphabet, or keep this vault on income-eligible tokens?',
    proposal: null,
  });
  async function reply(turns: Turn[], answer: unknown, extra: Partial<VaultAgentContext> = {}) {
    const model: VaultAgentModel = { read: vi.fn(async () => ({ reply: answer })) };
    const messages = turns.map((turn) =>
      Array.isArray(turn)
        ? { who: turn[0], text: turn[1] }
        : { who: 'person' as const, text: turn },
    );
    const out = await replyToVaultConversation(
      { version: 1, language: 'en', messageId: 'turn', messages },
      { ...context, ...extra },
      model,
    );
    const calls = vi.mocked(model.read).mock.calls;
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    return {
      out,
      reply: out.reply,
      requested: calls[0]?.[1].requestedOutsideGoal ?? [],
      constraints: calls[0]?.[1].allocationConstraints ?? [],
      prompt: calls[0]?.[1],
      repairs: calls.slice(1).map((call) => call[2]?.problems.join(' ') ?? ''),
      lines: out.reply.proposal?.allocations.map((line) => [line.assetId, line.weightBps]),
    };
  }
  return { assets, googl, nvda, tsla, reserve, cash, context, drafting, refusing, reply };
}

describe('"all in tGOOGLx" on an income vault', () => {
  const w = world('solana');
  const warned = {
    code: 'outside_goal_requested',
    assetId: w.googl.id,
    evidenceId: `catalog:${w.googl.id}`,
  };

  it('is a draft with the stock at the whole vault, warned, when the model drafts it', async () => {
    const out = await w.reply(['all in tGOOGLx'], w.drafting(w.googl));
    expect(w.googl.symbol).toBe('tGOOGLx');
    expect(out.requested).toEqual([w.googl.id]);
    expect(out.constraints).toEqual([
      {
        assetIds: [w.googl.id],
        minWeightBps: 10_000,
        maxWeightBps: 10_000,
        personQuote: 'all in tGOOGLx',
      },
    ]);
    expect(out.lines).toEqual([[w.googl.id, 10_000]]);
    expect(out.reply.warnings).toEqual([warned]);
    expect(out.reply.weightNotes).toEqual([
      { code: 'stated', assetIds: [w.googl.id], quote: 'all in tGOOGLx' },
    ]);
    expect(out.out.repair).toBeUndefined();
  });

  it('is still that draft when the model refuses twice: the server writes it, with no refusal', async () => {
    const out = await w.reply(['all in tGOOGLx'], w.refusing());
    expect(out.lines).toEqual([[w.googl.id, 10_000]]);
    expect(out.reply.warnings).toEqual([warned]);
    expect(out.out.repair).toEqual({ failed: 'asked_not_proposed', outcome: 'repaired' });
    // The model's one correction is told what the person asked for and that it may be held.
    expect(out.repairs[0]).toContain(w.googl.id);
    expect(out.repairs[0]).toContain('all in tGOOGLx');
    const said = JSON.stringify(out.reply);
    expect(said).not.toMatch(/cannot hold|separate growth draft|have not put it/u);
    // The names a person sees on the page, not the test network's.
    expect(out.reply.message).toBe(
      'Your request was: “all in tGOOGLx”. This draft holds GOOGLx alone. Nothing changes until you review and confirm it.',
    );
    expect(out.reply.question).toBeNull();
    expect(out.reply.proposal?.tradeoffs.join(' ')).toMatch(/outside/u);
  });

  it('adds the measured-exit warning where the share is above what can be sold', async () => {
    const out = await w.reply(['all in tGOOGLx'], w.drafting(w.googl), {
      caps: { [w.googl.id]: 2000 },
      evidence: [
        ...w.context.evidence,
        {
          id: `liquidity:${w.googl.id}`,
          assetId: w.googl.id,
          source: 'offline exits',
          method: 'measured exit capacity',
          fetchedAt: now,
          provenance: 'sandbox',
        },
      ],
    });
    expect(out.lines).toEqual([[w.googl.id, 10_000]]);
    expect(out.reply.warnings.map((warning) => warning.code)).toEqual([
      'over_exit_capacity',
      'outside_goal_requested',
    ]);
  });

  it.each([
    'all in GOOGLx',
    'All in tGOOGLx.',
    'all in GOOGL',
    'all in Alphabet',
    '100% Alphabet',
    '100% tGOOGLx',
    'put everything in Google',
    'Put it all in Google, please.',
    'swap it all to tGOOGLx',
    'move everything to GOOGLx',
    'go all in on Alphabet',
    'I want it all in tGOOGLx',
    'I want everything in tGOOGLx.',
    'ok, all of it in tGOOGLx',
    'put all my money in Google',
  ])('reads the same from %j', async (text) => {
    for (const answer of [w.drafting(w.googl), w.refusing()]) {
      const out = await w.reply([text], answer);
      expect(out.requested).toEqual([w.googl.id]);
      expect(out.lines).toEqual([[w.googl.id, 10_000]]);
      expect(out.reply.warnings).toEqual([warned]);
    }
  });

  it('reads "only X" as asked for, with no share of its own', async () => {
    for (const text of ['only tGOOGLx', 'I want only Google.', 'Only GOOGLx, please.']) {
      const out = await w.reply([text], w.drafting(w.googl, w.reserve));
      expect(out.requested, text).toEqual([w.googl.id]);
      expect(out.constraints, text).toEqual([]);
      expect(out.lines, text).toEqual([
        [w.googl.id, 5000],
        [w.reserve.id, 5000],
      ]);
      expect(out.reply.warnings, text).toEqual([warned]);
    }
  });

  it("applies the person's stated share exactly, with or without an asking verb", async () => {
    for (const text of ['30% Alphabet', 'tGOOGLx 30%', 'I want 30% GOOGLx.', '30% in Google']) {
      const out = await w.reply([text], w.drafting(w.googl, w.reserve));
      expect(out.requested, text).toEqual([w.googl.id]);
      expect(out.lines, text).toEqual([
        [w.googl.id, 3000],
        [w.reserve.id, 7000],
      ]);
      expect(out.reply.warnings, text).toEqual([warned]);
    }
  });

  it('holds only the stock the person named: one the model adds is left out and said', async () => {
    const out = await w.reply(['all in tGOOGLx'], w.drafting(w.googl, w.nvda));
    expect(out.requested).toEqual([w.googl.id]);
    expect(out.lines).toEqual([[w.googl.id, 10_000]]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [w.nvda.id],
    });
    expect(out.reply.warnings).toEqual([warned]);
    expect(out.out.repair?.failed).toBe('allocation_ineligible');
  });

  it.each([
    'what about google?',
    'all in tGOOGLx?',
    'Should I go all in tGOOGLx',
    'not all in tGOOGLx',
    'never all in on Google',
    'my friend said all in tGOOGLx',
    'if it is safe, all in tGOOGLx',
    '"all in tGOOGLx", they told me',
    'all in tGOOGLx is too risky',
    'all in tGOOGLx scares me',
    'I was all in tGOOGLx last year',
    'all in all, Google is fine',
    'take it all out of tGOOGLx',
    'at most 10% tGOOGLx',
    '0% tGOOGLx',
    'tGOOGLx fell 30%',
  ])('still refuses a stock the person did not ask for: %j', async (text) => {
    const out = await w.reply([text], w.drafting(w.googl, w.reserve));
    expect(out.requested).toEqual([]);
    expect(out.reply.proposal?.allocations.map((line) => line.assetId) ?? []).not.toContain(
      w.googl.id,
    );
    expect(out.reply.warnings).toEqual([]);
  });

  it('never drafts a stock by itself when the person named none', async () => {
    const out = await w.reply(['make it safer'], w.refusing());
    expect(out.reply.proposal).toBeNull();
    expect(out.out.repair).toBeUndefined();
  });

  it('replaces the shares stated before it, and says which', async () => {
    const gold = w.assets.find((asset) => asset.cls === 'gold');
    if (!gold) throw new Error('No gold on the offline catalog');
    const grow = world('solana', 'grow');
    const out = await grow.reply(
      ['I want 20% gold.', noted, 'all in tGOOGLx'],
      grow.drafting(grow.googl),
    );
    expect(out.lines).toEqual([[grow.googl.id, 10_000]]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'share_withdrawn',
      assetIds: w.assets.filter((asset) => asset.cls === 'gold').map((asset) => asset.id),
      quote: '20% gold',
    });
  });

  it('lets a later refusal take the request back, and the share with it', async () => {
    for (const refusal of ['No stocks.', 'no GOOGLx', 'I want no stocks.']) {
      const out = await w.reply(['all in tGOOGLx', noted, refusal], w.drafting(w.reserve));
      expect(out.requested, refusal).toEqual([]);
      expect(out.constraints, refusal).toEqual([]);
      expect(out.lines, refusal).toEqual([[w.reserve.id, 10_000]]);
      expect(out.reply.weightNotes, refusal).toContainEqual({
        code: 'share_withdrawn',
        assetIds: [w.googl.id],
        quote: 'all in tGOOGLx',
      });
      expect(out.reply.message, refusal).not.toMatch(/cannot be met|did not meet/u);
      // and the turn after it is a turn like any other
      const next = await w.reply(
        ['all in tGOOGLx', noted, refusal, noted, 'make it safer'],
        w.drafting(w.reserve),
      );
      expect(next.constraints, refusal).toEqual([]);
      expect(next.lines, refusal).toEqual([[w.reserve.id, 10_000]]);
    }
    // A share on a class the goal bars whoever asks is not a stock's: it stays, and the goal is why.
    const gold = w.assets.find((asset) => asset.cls === 'gold');
    if (!gold) throw new Error('No gold on the offline catalog');
    const barred = await w.reply([`I want 30% ${gold.symbol}`], w.drafting(w.reserve));
    expect(barred.reply.proposal).toBeNull();
    expect(barred.reply.message).toContain('a plan with your goal cannot hold that asset');
  });

  it('tells the model the names a person sees', async () => {
    const out = await w.reply(['all in tGOOGLx'], w.drafting(w.googl));
    const names = new Map(out.prompt?.catalog.map((row) => [row.id, row.name]));
    expect(names.get(w.googl.id)).toBe('GOOGLx');
    expect(names.get('solana:jlusdc')).toBe('jlUSDC');
    expect(names.get('solana:syrupusdc')).toBe('syrupUSDC');
    expect(names.get(w.cash.id)).toBe(w.cash.symbol);
  });
});

describe('the same on a vault whose goal is to protect, and on Robinhood Chain', () => {
  it('drafts the asked-for stock on a protect vault, with its warning', async () => {
    const w = world('solana', 'protect');
    for (const answer of [w.drafting(w.googl), w.refusing()]) {
      const out = await w.reply(['all in tGOOGLx'], answer);
      expect(out.prompt?.eligibilityGoal).toBe('protect');
      expect(out.requested).toEqual([w.googl.id]);
      expect(out.lines).toEqual([[w.googl.id, 10_000]]);
      expect(out.reply.warnings).toEqual([
        {
          code: 'outside_goal_requested',
          assetId: w.googl.id,
          evidenceId: `catalog:${w.googl.id}`,
        },
      ]);
    }
    const unasked = await w.reply(['make it safer'], w.drafting(w.googl, w.reserve));
    expect(unasked.lines).toEqual([[w.reserve.id, 10_000]]);
  });

  it.each(['all in tGOOGL', 'all in GOOGL', '100% Alphabet', 'put everything in Google'])(
    'reads %j on Robinhood Chain',
    async (text) => {
      const w = world('robinhood');
      expect(w.googl.id).toBe('robinhood:tgoogl');
      for (const answer of [w.drafting(w.googl), w.refusing()]) {
        const out = await w.reply([text], answer);
        expect(out.requested).toEqual([w.googl.id]);
        expect(out.lines).toEqual([[w.googl.id, 10_000]]);
        expect(out.reply.warnings.map((warning) => warning.code)).toEqual([
          'outside_goal_requested',
        ]);
      }
    },
  );
});

describe('a question is asked once', () => {
  const w = world('solana');
  const question =
    'Would you like a separate growth draft for Alphabet, or keep this vault on income-eligible tokens?';
  const body = 'Your vault holds income tokens today.';

  it('drops the end of the message that asks what the question asks', async () => {
    const out = await w.reply(['what do you think of google?'], w.refusing());
    expect(out.reply.question).toBe(question);
    expect(out.reply.message).not.toContain('Would you like');
    expect(out.reply.message.endsWith('before anything changed.')).toBe(true);
  });

  it.each([
    // the same question, with words added or left out
    `${body} Would you like me to start a separate growth draft for Alphabet, or keep this vault on income-eligible tokens?`,
    `${body} ${question}`,
    `${body} So: would you like a separate growth draft for Alphabet, or keep this vault on income-eligible tokens?`,
    `${body}\n\n**${question}**`,
  ])('says once: %j', (message) => {
    expect(withoutRepeatedQuestion(message, question, [])).toEqual({ message: body, question });
  });

  it('keeps a message that ends on another question, or on no question', () => {
    for (const message of [
      `${body} Would you like a separate growth draft for NVDAx, or keep this vault on income-eligible tokens?`,
      `${body} Do you want it?`,
      `${body} Would you like a draft?`,
      `${body} It depends on whether you would like a separate growth draft for Alphabet, or keep this vault on income-eligible tokens.`,
      body,
    ])
      expect(withoutRepeatedQuestion(message, question, []), message).toEqual({
        message,
        question,
      });
    expect(withoutRepeatedQuestion(body, null, [])).toEqual({ message: body, question: null });
  });

  it('keeps the message when the message is the question, and asks nothing beside it', () => {
    expect(withoutRepeatedQuestion(question, question, [])).toEqual({
      message: question,
      question: null,
    });
  });
});

describe('the prompt says what the code enforces', () => {
  it('names the asked-for exception, the one place of a question and the names to use', () => {
    // An asked-for stock is drafted, never refused or sent to another draft.
    expect(VAULT_AGENT_SYSTEM).toContain('in requestedOutsideGoal, the person asked for it');
    expect(VAULT_AGENT_SYSTEM).toContain('do not propose it: ask in question');
    expect(VAULT_AGENT_SYSTEM).toContain('A question goes in question and nowhere else');
    expect(VAULT_AGENT_SYSTEM).toContain(
      "catalog[].name is the asset's name as the person sees it",
    );
  });
});

// Review of #229 (6f47a41d): the first cut read a piece of a message alone, so a side of "but", a line
// of a list, a sentence between two others or a share in someone else's portfolio counted as asking.
// The new readings hold only when the whole message is that one request, courtesies aside.
describe('the new readings hold only when the whole message is the one request', () => {
  const w = world('solana');
  const drafted = () => w.drafting(w.tsla, w.googl, w.nvda, w.reserve);

  it.each([
    // 1. a share the server does not apply, or one in a longer message
    'My friend said put 60% in bonds, 30% Tesla, 10% cash',
    'My old portfolio was 60% bonds, 30% Tesla, 10% cash',
    'should I do 60% bonds, 30% Tesla, 10% cash',
    '30% Tesla, no way',
    "I don't want gold or 30% Tesla",
    'sell NVDA and 30% Tesla',
    'I want no stocks, 30% Tesla',
    'when it drops, 100% Tesla',
    'Hypothetically, 100% Tesla',
    'He holds bonds and 30% Tesla',
    'remove gold, 30% Tesla',
    'I sold NVDA, Tesla 30%',
    'Tesla 30%, ouch',
    'Maybe, 30% Tesla',
    // 2. a side of "but", a fragment, a line, a sentence among others
    'Anything but all in Tesla',
    "I'd do anything but go all in on Tesla",
    'Anything but 100% Tesla',
    'anything but only Tesla',
    'not gold but all in Tesla',
    "I'm torn: bonds vs. all in Tesla",
    'e.g. all in Tesla',
    'i.e. 100% Tesla',
    'Things my advisor told me not to do:\nall in Tesla',
    'Here is what I will never do. All in Tesla.',
    'My friend did something wild last year. All in Tesla. He lost a lot.',
    "all in Tesla. Actually no, don't do that.",
    'all in Tesla. no',
    'all in Tesla\nkidding',
    'all in Tesla. Kidding. Keep it as is.',
    'Options I am weighing:\n1. all in Tesla\n2. only bonds',
    'Which is better?\n1. all in Tesla\n2. only bonds',
    'My last portfolio.\nTesla 30%\nNVDA 20%\nIt went badly.',
    'I read a post. 100% Tesla. Wild.',
    'Explain this to me. Tesla 30%.',
    'Before.\n30% Tesla',
    'Bad idea; all in Tesla',
    'No way! All in Tesla',
    'all in Tesla. Is that too risky?',
    'Is it too risky? all in Tesla.',
    'What do you think? 30% Tesla.',
    'all in Tesla ?',
    'all in Tesla, lol',
    'all in Tesla, maybe',
    'all in Tesla I guess',
    'maybe all in Tesla',
    'all in Tesla, but keep 20% cash',
    'all in Tesla ...',
    'all in Tesla... not',
    'ok then all in Tesla',
    'all to Tesla',
    'everything on Tesla',
    'the whole thing in Tesla',
    'we want all in Tesla',
    // past tense, third person, a condition, a negation
    'I put everything in Tesla last year',
    'We put everything in Tesla',
    'I went all in on Tesla',
    'He went all in on Tesla',
    'if it drops, all in Tesla',
    'not all in Tesla',
    'not only Tesla',
    'if only Tesla',
    // 3. a price move
    'Tesla -30%',
    'TSLA -30%',
    'Tesla - 30%',
    'Tesla +30%',
    'Tesla -30%, ouch',
    'Down today: Tesla -30%',
  ])('is no request, and drafts no stock: %j', async (text) => {
    for (const answer of [drafted(), w.refusing()]) {
      const out = await w.reply([text], answer);
      expect(out.requested).toEqual([]);
      expect(out.reply.proposal?.allocations.map((line) => line.assetId) ?? []).not.toContain(
        w.tsla.id,
      );
      expect(out.reply.warnings).toEqual([]);
      // never the server's own draft, and never asked again for it
      expect(out.out.repair?.failed).not.toBe('asked_not_proposed');
    }
  });

  it.each([
    'Anything but all in Tesla',
    "I'm torn: bonds vs. all in Tesla",
    'e.g. all in Tesla',
    'Things my advisor told me not to do:\nall in Tesla',
    'Here is what I will never do. All in Tesla.',
    'My friend did something wild last year. All in Tesla. He lost a lot.',
    "all in Tesla. Actually no, don't do that.",
    'Which is better?\n1. all in Tesla\n2. only bonds',
    'all in Tesla. Is that too risky?',
    'all in Tesla\nkidding',
  ])('sets no share and withdraws none: %j', async (text) => {
    const grow = world('solana', 'grow');
    const gold = grow.assets.find((asset) => asset.cls === 'gold');
    if (!gold) throw new Error('No gold on the offline catalog');
    const out = await grow.reply(
      ['I want at least 20% gold.', noted, text],
      grow.drafting(grow.tsla, gold, grow.reserve),
    );
    expect(out.constraints.map((share) => share.personQuote)).toEqual(['at least 20% gold']);
    expect(out.reply.weightNotes.map((note) => note.code)).not.toContain('share_withdrawn');
    expect(out.lines?.find(([id]) => id === grow.tsla.id)?.[1]).not.toBe(10_000);
  });

  it('answers "all in Tesla. Is that too risky?" as a question: no draft of it, no refusal of a request', async () => {
    const out = await w.reply(['all in Tesla. Is that too risky?'], w.refusing());
    expect(out.requested).toEqual([]);
    expect(out.constraints).toEqual([]);
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.message).not.toMatch(/cannot be met/u);
    expect(out.out.repair).toBeUndefined();
    expect(VAULT_AGENT_SYSTEM).toContain('do not propose it: ask in question');
  });

  it.each([
    'all in Tesla',
    'All in Tesla.',
    'ALL IN TSLA!!!',
    'ok, all in Tesla',
    'Yes, please: all in Tesla',
    'hi, put everything in Tesla, thanks',
    'I would like to go all in on Tesla',
    'change it all to Tesla',
    '100% Tesla',
    'Tesla 100%',
  ])('still reads the whole message %j', async (text) => {
    for (const answer of [w.drafting(w.tsla), w.refusing()]) {
      const out = await w.reply([text], answer);
      expect(out.requested).toEqual([w.tsla.id]);
      expect(out.lines).toEqual([[w.tsla.id, 10_000]]);
    }
  });

  it('lets a whole of a class and a ceiling on one of its assets stand together', async () => {
    const grow = world('solana', 'grow');
    for (const whole of ['100% stocks', 'all in stocks']) {
      const out = await grow.reply(
        ['I want at most 10% Tesla.', noted, whole],
        grow.drafting(grow.tsla, grow.googl),
      );
      expect(
        out.constraints.map((share) => share.personQuote),
        whole,
      ).toEqual(['at most 10% Tesla', whole]);
      expect(
        out.reply.weightNotes.map((note) => note.code),
        whole,
      ).not.toContain('share_withdrawn');
      // As on staging, the weights function cannot yet meet a class share with a ceiling inside
      // it: the person is asked about it. What matters here is that nothing was withdrawn.
      expect(
        out.reply.weightNotes.map((note) => note.code),
        whole,
      ).toEqual(['share_unmet']);
    }
  });
});

describe('a repeated question is dropped only when it is surely the same', () => {
  it.each<[string, string]>([
    ['Your vault holds income tokens. Do you not want Tesla?', 'Do you want Tesla?'],
    ['Should I keep gold and drop Tesla?', 'Should I drop gold and keep Tesla?'],
    ['I can draft it. Do you want TSLAx or NVDAx?', 'Do you want NVDAx or TSLAx?'],
    ['I can draft it either way. Do you want 30% in TSLAx?', 'Do you want 3% in TSLAx?'],
    [
      'Two options. Would you like me to draft TSLAx now?',
      'Would you like me to draft TSLAx now, or wait?',
    ],
    ['Ok. Want it?', 'Do you want it in this vault or another one?'],
    [
      'Which one would you like to hold? TSLAx is a stock token.',
      'Which one would you like to hold?',
    ],
    [
      'Would you like a draft with TSLAx, or would you like a draft without it?',
      'Would you like a draft with TSLAx?',
    ],
    [
      'I can do either. Would you like a draft without TSLAx?',
      'Would you like a draft with TSLAx?',
    ],
    ['I can do either. Would you like to sell TSLAx?', 'Would you like to hold TSLAx?'],
    // a list item, or a line with no end of its own, is never cut
    ['Here are two.\n- Would you like TSLAx?', 'Would you like TSLAx?'],
    ['Here are two.\n1. Would you like TSLAx?', 'Would you like TSLAx?'],
    ['The draft holds TSLAx and would you like it?', 'Would you like it?'],
  ])('keeps both: %j / %j', (message, question) => {
    expect(withoutRepeatedQuestion(message, question, ['TSLAx', 'NVDAx'])).toEqual({
      message,
      question,
    });
  });

  it('cuts the question on its own line and nothing of the list before it', () => {
    const list = 'Here is the draft.\n\n- TSLAx\n- NVDAx';
    const question = 'Which one would you like to hold?';
    expect(withoutRepeatedQuestion(`${list}\n\n${question}`, question, [])).toEqual({
      message: list,
      question,
    });
    expect(
      withoutRepeatedQuestion(
        'Is that right? Would you like a draft?',
        'Would you like a draft?',
        [],
      ),
    ).toEqual({
      message: 'Is that right?',
      question: 'Would you like a draft?',
    });
  });
});
