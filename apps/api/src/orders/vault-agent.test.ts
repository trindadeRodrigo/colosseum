import { readFileSync } from 'node:fs';
import { checkCreatorLimits } from '@colosseum/basket';
import type { Price, VaultAgentStatedShare, VaultState } from '@colosseum/schemas';
import { VaultAgentRequest } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel } from '../vault-agent-model';
import {
  type AgentAnalytics,
  type AgentAnalyticsResult,
  analyticsGap,
  buildGoalAgentContext,
  buildVaultAgentContext,
  readAgentAnalytics,
  replyToVaultConversation,
  type VaultAgentContext,
  type VaultAgentPrompt,
} from './vault-agent';

// Offline model replies are fixtures. No model, node, database, order builder, or allocator is called.
const shelf = launchShelf();
const assets = shelf.assets.filter((asset) => asset.chain === 'solana');
const cash = assets.find((asset) => asset.cls === 'cash');
const stock = assets.find((asset) => asset.cls === 'stock');
const reserves = assets.filter((asset) => asset.cls === 'dollar_yield');
const reserve = reserves[0];
const otherReserve = reserves[1];
if (!cash || !stock || !reserve || !otherReserve)
  throw new Error('Incomplete offline catalog fixture');
const now = '2026-10-07T20:00:00.000Z';
const state: VaultState = {
  chain: 'solana',
  address: cash.address,
  owner: cash.address,
  basketId: '1',
  keeper: cash.address,
  recipeOnchainId: null,
  acceptedVersion: 0,
  autoFollow: false,
  cash: { asset: cash.id, raw: '1000000000', display: '1000', multiplier: '1' },
  positions: [
    {
      asset: stock.id,
      raw: '10000000',
      display: '10',
      multiplier: '1',
      targetBps: 2000,
      lastKeeperAt: null,
    },
  ],
  lossUsedBps: 0,
  observedAt: now,
  pending: null,
};
const prices: Price[] = [cash, stock].map((asset) => ({
  asset: asset.id,
  usdPerToken: asset.cls === 'cash' ? '1' : '100',
  ageSeconds: 0,
  maxAgeSeconds: 300,
  market: 'open',
  source: 'offline reference fixture',
  method: 'fixture',
  fetchedAt: now,
  provenance: 'mock',
}));
const context: VaultAgentContext = {
  person: 'owner-fixture',
  state,
  assets,
  currentGoals: [{ goal: 'grow', objective: 'Keep a liquid cushion while seeking growth' }],
  evidence: [stock, reserve, otherReserve].map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog',
    method: 'listed assets',
    fetchedAt: now,
    provenance: 'mock',
  })),
  stockAttributes: null,
  liquidity: [],
  unknowns: ['Measured exit cost is unavailable for this preview.'],
};
const request = (text = 'I would like more of the named stock and a liquid cushion') => ({
  version: 1 as const,
  language: 'en' as const,
  messageId: 'person-turn',
  messages: [
    { who: 'app' as const, text: 'What would you like to discuss about this vault?' },
    { who: 'person' as const, text },
  ],
});
// The model picks assets and says why; the server sets the weights (an equal split unless the person
// stated shares), so no fixture carries a weight.
const proposal = () => ({
  message: 'Here is a possible direction for your vault. This is a preview for discussion.',
  question: null,
  proposal: {
    objective: 'Seek growth while keeping a liquid cushion',
    summary: 'Increase exposure to the named stock and retain a reserve.',
    allocations: [
      {
        assetId: stock.id,
        why: 'This expresses your stated stock preference.',
        evidenceIds: [`catalog:${stock.id}`],
      },
      {
        assetId: reserve.id,
        why: 'This reserve diversifies the proposed holdings.',
        evidenceIds: [`catalog:${reserve.id}`],
      },
      {
        assetId: otherReserve.id,
        why: 'This retains exposure outside the named stock.',
        evidenceIds: [`catalog:${otherReserve.id}`],
      },
    ],
    stated: [] as VaultAgentStatedShare[],
    tradeoffs: ['Stock concentration can increase losses.'],
    unknowns: ['The future price path is unknown.'],
  },
});
const listedStocks = assets
  .filter((asset) => asset.cls === 'stock' || asset.cls === 'etf')
  .map((asset) => asset.id);
/** The shares the model reports the person stated, with the person's own words. */
const withStated = <T extends ReturnType<typeof proposal>>(
  value: T,
  ...stated: VaultAgentStatedShare[]
): T => {
  value.proposal.stated = stated;
  return value;
};
const stocksAtLeast = (bps: number, quote: string): VaultAgentStatedShare => ({
  assetIds: listedStocks,
  kind: 'min',
  bps,
  quote,
});
/** Picks with no stock: a stated stock minimum cannot be met by them. */
const reservesOnly = () => {
  const value = proposal();
  value.proposal.allocations = value.proposal.allocations.filter(
    (line) => line.assetId !== stock.id,
  );
  return value;
};
const weightsOf = (out: Awaited<ReturnType<typeof replyToVaultConversation>>) =>
  out.kind === 'reply' ? out.reply.proposal?.allocations.map((line) => line.weightBps) : out;
const fake = (reply: unknown): VaultAgentModel => ({ read: vi.fn(async () => ({ reply })) });
// The reply failed `detail`, the model was asked once to correct it, and sent the same reply again.
// A pick outside the goal was left out, and the model's one correction picked it again.
const leftOutTwice = { failed: 'allocation_ineligible', outcome: 'allocation_ineligible' };
const rejected = (detail: string) => ({
  kind: 'failure',
  reason: 'invalid',
  detail,
  repair: { failed: detail, outcome: detail },
});

describe('model-led private vault proposals', () => {
  it('accepts real-catalog cash residual previews and refuses an exit share without its measured figure', async () => {
    const cashContext = {
      ...context,
      evidence: [
        ...context.evidence,
        {
          id: `catalog:${cash.id}`,
          assetId: cash.id,
          source: 'offline catalog',
          method: 'cash residual',
          fetchedAt: now,
          provenance: 'mock' as const,
        },
      ],
    };
    const value = proposal();
    value.proposal.allocations = [
      {
        assetId: cash.id,
        why: 'Keep cash while discussing the strategy.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ];
    const model = fake(value);
    const onlyCash = await replyToVaultConversation(request(), cashContext, model);
    expect(weightsOf(onlyCash)).toEqual([10000]);
    expect(model.read).toHaveBeenCalledWith(
      'owner-fixture',
      expect.objectContaining({
        exitCapacityBps: {},
        catalog: expect.arrayContaining([expect.objectContaining({ id: cash.id })]),
      }),
    );
    // A shared portfolio's ceiling is not sent: it does not bind the person's own vault.
    const sent = vi.mocked(model.read).mock.calls[0]?.[1];
    expect(sent?.catalog.every((asset) => !('maxWeightBps' in asset))).toBe(true);
    value.proposal.allocations = [
      proposal().proposal.allocations[0] as (typeof value.proposal.allocations)[number],
      {
        assetId: cash.id,
        why: 'Retain the rest as cash.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ];
    expect(weightsOf(await replyToVaultConversation(request(), cashContext, fake(value)))).toEqual([
      5000, 5000,
    ]);
    const unsourced = fake(value);
    expect(
      await replyToVaultConversation(
        request(),
        { ...cashContext, caps: { [cash.id]: 5000 } },
        unsourced,
      ),
    ).toEqual({ kind: 'failure', reason: 'invalid', detail: 'context_caps' });
    expect(unsourced.read).not.toHaveBeenCalled();
  });

  it('keeps an explicit stock minimum through later refinement and asks when the picks cannot meet it', async () => {
    const minimum = request('I want at least 40% stocks in this vault.');
    const forty = stocksAtLeast(4000, 'I want at least 40% stocks in this vault.');
    const wrong = fake(withStated(reservesOnly(), forty));
    const result = await replyToVaultConversation(minimum, context, wrong);
    expect(result.kind).toBe('reply');
    if (result.kind !== 'reply') throw new Error('Missing explanation');
    // The repair sent the same draft, so the person is asked about the limit as before.
    expect(wrong.read).toHaveBeenCalledTimes(2);
    expect(result.repair).toEqual({
      failed: 'allocation_constraint',
      outcome: 'allocation_constraint',
    });
    expect(result.reply.proposal).toBeNull();
    // The quote is the server's own read of the person's message: the number and the asset beside it.
    expect(result.reply.message).toContain('“at least 40% stocks”');
    expect(result.reply.question).toContain('within that limit');
    expect(result.reply.weightNotes).toEqual([
      { code: 'share_unmet', assetIds: listedStocks, quote: 'at least 40% stocks' },
    ]);
    const later = {
      ...minimum,
      messages: [
        ...minimum.messages,
        { who: 'app' as const, text: result.reply.message },
        { who: 'person' as const, text: 'Please keep it diversified.' },
      ],
    };
    const held = await replyToVaultConversation(
      later,
      context,
      fake(withStated(reservesOnly(), forty)),
    );
    if (held.kind !== 'reply') throw new Error('Missing explanation');
    expect(held.reply.proposal).toBeNull();
    // With a stock among the picks the server meets the minimum itself: the stock at 40%, the
    // reserves sharing the rest equally.
    const correct = await replyToVaultConversation(
      minimum,
      context,
      fake(withStated(proposal(), forty)),
    );
    expect(weightsOf(correct)).toEqual([4000, 3000, 3000]);
    expect(correct.kind === 'reply' && correct.reply.weightNotes).toEqual([
      { code: 'stated', assetIds: [stock.id], quote: 'at least 40% stocks' },
      { code: 'equal_split', assetIds: [reserve.id, otherReserve.id] },
    ]);
    // The server holds the minimum from the person's words even when the model reports no share.
    expect(weightsOf(await replyToVaultConversation(minimum, context, fake(proposal())))).toEqual([
      4000, 3000, 3000,
    ]);
    expect(
      weightsOf(
        await replyToVaultConversation(later, context, fake(withStated(proposal(), forty))),
      ),
    ).toEqual([4000, 3000, 3000]);
    const amended = {
      ...later,
      messages: [...later.messages, { who: 'person' as const, text: 'Make that at least 10%.' }],
    };
    // An equal split already meets the amended minimum, so nothing moves.
    const ten = stocksAtLeast(1000, 'Make that at least 10% stocks.');
    const replacement = await replyToVaultConversation(
      { ...amended, messages: [...later.messages, { who: 'person', text: ten.quote }] },
      context,
      fake(withStated(proposal(), ten)),
    );
    expect(weightsOf(replacement)).toEqual([3334, 3333, 3333]);
    // "Make that at least 10%." names no asset: the server reads it as a new number for the one share
    // that stands, and says so with the person's words.
    const unnamed = { ...ten, quote: 'Make that at least 10%.' };
    const remade = await replyToVaultConversation(
      amended,
      context,
      fake(withStated(proposal(), unnamed)),
    );
    expect(remade).toMatchObject({
      kind: 'reply',
      reply: {
        weightNotes: [
          { code: 'stated', assetIds: [stock.id], quote: 'Make that at least 10%' },
          { code: 'equal_split', assetIds: [reserve.id, otherReserve.id] },
        ],
      },
    });
    expect(remade.repair).toBeUndefined();
    expect(weightsOf(remade)).toEqual([3334, 3333, 3333]);
    // With two shares standing, "that" is not one share: the words are said back as unread.
    const two = await replyToVaultConversation(
      {
        ...minimum,
        messages: [
          { who: 'person', text: `I want at least 40% stocks and at least 20% ${reserve.symbol}.` },
          { who: 'person', text: 'Make that at least 10%.' },
        ],
      },
      context,
      fake(proposal()),
    );
    expect(weightsOf(two)).toEqual([4000, 3000, 3000]);
    expect(two.kind === 'reply' && two.reply.weightNotes.at(-1)).toEqual({
      code: 'share_unread',
      assetIds: [],
      quote: 'Make that at least 10%',
    });
    const dropped = {
      ...later,
      messages: [...later.messages, { who: 'person' as const, text: 'Ignore that stock minimum.' }],
    };
    const declined = await replyToVaultConversation(dropped, context, fake(reservesOnly()));
    expect(weightsOf(declined)).toEqual([5000, 5000]);
  });

  it.each([
    '"I want at least 40% stocks."',
    'If I want at least 40% stocks, would that be sensible?',
    'My friend said I want at least 40% stocks.',
    'I do not want at least 40% stocks.',
    'I want to discuss at least 40% stocks as an example.',
  ])('does not turn non-instructions into a holding limit: %s', async (text) => {
    const out = await replyToVaultConversation(request(text), context, fake(proposal()));
    if (out.kind !== 'reply') throw new Error('Fixture rejected');
    expect(out.reply.proposal).not.toBeNull();
  });

  it('allows figures only inside exact attributed person quotes, never as invented measurements', async () => {
    const value = proposal();
    value.proposal.objective = 'You said “I want to grow my $2000.” Keep a reserve.';
    expect(
      (await replyToVaultConversation(request('I want to grow my $2000.'), context, fake(value)))
        .kind,
    ).toBe('reply');
    expect(
      await replyToVaultConversation(request('I want to grow my $1000.'), context, fake(value)),
    ).toEqual(rejected('prose_figure'));
    value.proposal.objective = 'Grow my $2000 while keeping a reserve.';
    expect(
      await replyToVaultConversation(request('I want to grow my $2000.'), context, fake(value)),
    ).toEqual(rejected('prose_figure'));
    value.proposal.objective = 'Grow with a reserve.';
    value.proposal.allocations[0]!.why = 'The measured price is $1000.';
    expect(
      await replyToVaultConversation(request('I want to invest $1000.'), context, fake(value)),
    ).toEqual(rejected('prose_figure'));
  });

  it('holds a casually worded stock minimum, and says back one that names no asset', async () => {
    const text = 'i think i want way more stocks on them. like at least 40% stocks';
    const share = stocksAtLeast(4000, text);
    const out = await replyToVaultConversation(
      request(text),
      context,
      fake(withStated(reservesOnly(), share)),
    );
    if (out.kind !== 'reply') throw new Error('Missing conflict explanation');
    expect(out.reply.message).toContain('“at least 40% stocks”');
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.question).toBeTruthy();
    // The number in a sentence of its own, with the asset in the one before: the server does not
    // guess which asset it is. The split is equal and the person is told their words were not applied.
    const apart = 'i think i want way more stocks on them. like at least 40%';
    const unread = await replyToVaultConversation(
      request(apart),
      context,
      fake(withStated(reservesOnly(), stocksAtLeast(4000, apart))),
    );
    expect(weightsOf(unread)).toEqual([5000, 5000]);
    expect(unread).toMatchObject({
      repair: { failed: 'stated_ungrounded', outcome: 'repaired' },
      reply: {
        weightNotes: [
          { code: 'equal_split', assetIds: [reserve.id, otherReserve.id] },
          { code: 'share_unread', assetIds: [], quote: 'like at least 40%' },
        ],
      },
    });
    // With a stock picked, the server meets the stated minimum itself.
    expect(
      weightsOf(
        await replyToVaultConversation(request(text), context, fake(withStated(proposal(), share))),
      ),
    ).toEqual([4000, 3000, 3000]);
  });

  it('permits an exact trusted catalog name containing a digit', async () => {
    const value = proposal();
    value.proposal.summary = 'Consider 3M with a liquid reserve.';
    const namedContext = {
      ...context,
      assets: context.assets.map((asset) =>
        asset.id === stock.id ? { ...asset, underlying: '3M' } : asset,
      ),
    };
    expect((await replyToVaultConversation(request(), namedContext, fake(value))).kind).toBe(
      'reply',
    );
    expect(await replyToVaultConversation(request(), context, fake(value))).toEqual(
      rejected('prose_figure'),
    );
  });

  it.each([
    'I changed your vault.',
    'I applied your allocations.',
    'I have updated your strategy.',
    'I rebalanced your portfolio.',
    'Eu alterei seu cofre.',
    'Apliquei sua alocação.',
    'Eu atualizei sua estratégia.',
    'Rebalanceei sua carteira.',
  ])('rejects a false application assertion: %s', async (message) => {
    expect(
      await replyToVaultConversation(request(), context, fake({ ...proposal(), message })),
    ).toEqual(rejected('prose_claims_applied'));
  });

  it.each([
    'I can draft a change for your vault. Nothing was applied.',
    'Posso preparar uma proposta. Nada foi aplicado.',
  ])('accepts truthful preview wording: %s', async (message) => {
    expect(
      (await replyToVaultConversation(request(), context, fake({ ...proposal(), message }))).kind,
    ).toBe('reply');
  });
  it('weighs different model-picked assets equally, hydrates catalog symbols/sources, and sends actual goals and targets', async () => {
    const model = fake(proposal());
    const first = await replyToVaultConversation(request(), context, model);
    const second = await replyToVaultConversation(
      request('I now prefer more stock exposure'),
      context,
      fake({
        ...proposal(),
        proposal: {
          ...proposal().proposal,
          allocations: proposal().proposal.allocations.slice(0, 2),
        },
      }),
    );
    expect(first.kind).toBe('reply');
    expect(second.kind).toBe('reply');
    if (first.kind !== 'reply' || second.kind !== 'reply')
      throw new Error('fixture preview rejected');
    expect(first.reply.proposal?.allocations[0]).toMatchObject({
      weightBps: 3334,
      symbol: stock.symbol,
    });
    // The remainder basis point goes to the first pick.
    expect(weightsOf(first)).toEqual([3334, 3333, 3333]);
    expect(weightsOf(second)).toEqual([5000, 5000]);
    expect(first.reply.proposal?.sources).toEqual(context.evidence);
    expect(first.reply.proposal?.unknowns).toContain(context.unknowns[0]);
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(model.read).toHaveBeenCalledWith(
      'owner-fixture',
      expect.objectContaining({
        messages: request().messages,
        latestPerson: request().messages.at(-1)?.text,
        vault: state,
        currentGoals: context.currentGoals,
      }),
    );
    expect(first.reply.proposal).not.toHaveProperty('sheet');
    expect(first.reply.proposal).not.toHaveProperty('order');
  });

  it.each([
    'asset',
    'crosschain',
    'model-weight',
    'duplicate',
    'evidence',
    'wrong-reference',
    'financial-figure',
    'written-figure',
    'symbol',
    'infinity',
  ])('rejects a model reply that violates %s without substituting an allocation', async (fault) => {
    const expected: Record<string, string> = {
      asset: 'allocation_unlisted',
      crosschain: 'allocation_unlisted',
      // The model never sets a weight: one it sends is refused, never used.
      'model-weight': 'reply_schema',
      duplicate: 'allocation_duplicate',
      evidence: 'allocation_evidence',
      'wrong-reference': 'allocation_evidence',
      'financial-figure': 'prose_figure',
      'written-figure': 'prose_figure',
      symbol: 'reply_schema',
      infinity: 'reply_schema',
    };
    const value = proposal();
    const [allocation, remainder] = value.proposal.allocations;
    if (!allocation || !remainder) throw new Error('Incomplete allocation fixture');
    if (fault === 'asset') allocation.assetId = 'solana:unlisted';
    if (fault === 'crosschain') allocation.assetId = 'robinhood:unlisted';
    if (fault === 'model-weight') Object.assign(allocation, { weightBps: 7000 });
    if (fault === 'duplicate') remainder.assetId = stock.id;
    if (fault === 'evidence') allocation.evidenceIds = ['invented-risk-observation'];
    if (fault === 'wrong-reference') allocation.evidenceIds = [`catalog:${reserve.id}`];
    if (fault === 'financial-figure') allocation.why = 'The yield is 12%.';
    if (fault === 'written-figure') allocation.why = 'It pays ten percent annually.';
    if (fault === 'symbol') Object.assign(allocation, { symbol: 'MADEUP' });
    if (fault === 'infinity') Object.assign(allocation, { weightBps: Number.POSITIVE_INFINITY });
    expect(await replyToVaultConversation(request(), context, fake(value))).toEqual(
      rejected(expected[fault] ?? 'unmapped'),
    );
  });

  it('returns a conversational question without inventing an allocation from admiration', async () => {
    const out = await replyToVaultConversation(
      request('i like elon'),
      context,
      fake({
        message: 'What interests you about him?',
        question: 'Would you like to explore a particular business or discuss the idea first?',
        proposal: null,
      }),
    );
    expect(out.kind).toBe('reply');
    if (out.kind === 'reply') expect(out.reply.proposal).toBeNull();
    expect(VAULT_AGENT_SYSTEM).toContain('Admiration for a person alone');
  });

  it.each(['unavailable', 'timeout', 'budget', 'invalid'] as const)(
    'preserves typed model failure %s without a wizard fallback',
    async (why) => {
      const model: VaultAgentModel = { read: async () => ({ reply: null, why }) };
      expect(await replyToVaultConversation(request(), context, model)).toEqual({
        kind: 'failure',
        reason: why,
      });
      const detailed: VaultAgentModel = {
        read: async () => ({ reply: null, why, detail: 'model_error_400' }),
      };
      expect(await replyToVaultConversation(request(), context, detailed)).toEqual({
        kind: 'failure',
        reason: why,
        detail: 'model_error_400',
      });
    },
  );

  it('asks the model once to correct a reply that fails a check, and returns the corrected one', async () => {
    const repaired = await replyToVaultConversation(request(), context, {
      read: vi
        .fn()
        .mockResolvedValueOnce({ reply: { ...proposal(), message: 'I changed your vault.' } })
        .mockResolvedValueOnce({ reply: proposal() }),
    });
    expect(repaired).toMatchObject({
      kind: 'reply',
      repair: { failed: 'prose_claims_applied', outcome: 'repaired' },
    });
    if (repaired.kind !== 'reply') throw new Error('repair rejected');
    expect(repaired.reply.message).toBe(proposal().message);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: { ...proposal(), message: 'I changed your vault.' } })
      .mockResolvedValueOnce({ reply: proposal() });
    await replyToVaultConversation(request(), context, { read });
    expect(read).toHaveBeenCalledTimes(2);
    const [person, prompt] = read.mock.calls[0] ?? [];
    expect(read.mock.calls[1]).toEqual([
      person,
      prompt,
      {
        previous: { ...proposal(), message: 'I changed your vault.' },
        problems: [expect.stringContaining('nothing has been applied')],
        elapsedMs: expect.any(Number),
      },
    ]);
  });

  it('names where a structure check failed on the repair call, and keeps the second failure', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: { question: null, proposal: null } })
      .mockResolvedValueOnce({ reply: null, why: 'timeout', detail: 'model_timeout' });
    expect(await replyToVaultConversation(request(), context, { read })).toEqual({
      kind: 'failure',
      reason: 'timeout',
      detail: 'model_timeout',
      repair: { failed: 'reply_schema', outcome: 'model_timeout' },
    });
    expect(read.mock.calls[1]?.[2]).toMatchObject({
      problems: [
        expect.stringContaining('required structure'),
        expect.stringMatching(/^At message: /),
      ],
    });
  });

  it('repairs picks that cannot meet a stated limit, naming the limit but never a weight', async () => {
    const minimum = request('I want at least 40% stocks in this vault.');
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        reply: withStated(
          reservesOnly(),
          stocksAtLeast(4000, 'I want at least 40% stocks in this vault.'),
        ),
      })
      .mockResolvedValueOnce({
        reply: withStated(
          proposal(),
          stocksAtLeast(4000, 'I want at least 40% stocks in this vault.'),
        ),
      });
    const repaired = await replyToVaultConversation(minimum, context, { read });
    expect(repaired).toMatchObject({
      kind: 'reply',
      repair: { failed: 'allocation_constraint', outcome: 'repaired' },
    });
    if (repaired.kind !== 'reply') throw new Error('Repair rejected');
    expect(weightsOf(repaired)).toEqual([4000, 3000, 3000]);
    const problems: string[] = read.mock.calls[1]?.[2].problems;
    expect(problems).toEqual([
      expect.stringContaining('cannot meet a share the person stated'),
      'The person said “at least 40% stocks”: the picks cannot meet it.',
    ]);
    // No weight is repeated back: the server's equal split is not the model's to argue with.
    expect(problems.join(' ')).not.toMatch(/5000|3334|3333/);
    // A maximum over every pick cannot be met: only stocks were picked.
    const maximum = request('I want at most 10% stocks in this vault.');
    const atMost: VaultAgentStatedShare = {
      assetIds: listedStocks,
      kind: 'max',
      bps: 1000,
      quote: 'I want at most 10% stocks in this vault.',
    };
    const onlyStock = withStated(proposal(), atMost);
    onlyStock.proposal.allocations = onlyStock.proposal.allocations.slice(0, 1);
    const over = vi
      .fn()
      .mockResolvedValueOnce({ reply: onlyStock })
      .mockResolvedValueOnce({ reply: withStated(proposal(), atMost) });
    const capped = await replyToVaultConversation(maximum, context, { read: over });
    expect(capped).toMatchObject({
      kind: 'reply',
      repair: { failed: 'allocation_constraint', outcome: 'repaired' },
    });
    expect(weightsOf(capped)).toEqual([1000, 4500, 4500]);
    expect(over.mock.calls[1]?.[2].problems[1]).toBe(
      'The person said “at most 10% stocks”: the picks cannot meet it.',
    );
  });

  it('keeps the question about a stated limit when its repair fails another way', async () => {
    const minimum = request('I want at least 40% stocks in this vault.');
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        reply: withStated(
          reservesOnly(),
          stocksAtLeast(4000, 'I want at least 40% stocks in this vault.'),
        ),
      })
      .mockResolvedValueOnce({ reply: null, why: 'timeout', detail: 'model_timeout' });
    const out = await replyToVaultConversation(minimum, context, { read });
    expect(out).toMatchObject({
      kind: 'reply',
      repair: { failed: 'allocation_constraint', outcome: 'model_timeout' },
    });
    if (out.kind !== 'reply') throw new Error('Missing explanation');
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.message).toContain('“at least 40% stocks”');
    expect(out.reply.question).toContain('within that limit');
    // A repair that fails a structure check also leaves the question standing.
    const schema = vi
      .fn()
      .mockResolvedValueOnce({
        reply: withStated(
          reservesOnly(),
          stocksAtLeast(4000, 'I want at least 40% stocks in this vault.'),
        ),
      })
      .mockResolvedValueOnce({ reply: { question: null, proposal: null } });
    expect(await replyToVaultConversation(minimum, context, { read: schema })).toMatchObject({
      kind: 'reply',
      reply: { proposal: null, question: expect.stringContaining('within that limit') },
      repair: { failed: 'allocation_constraint', outcome: 'reply_schema' },
    });
  });

  it('repairs a reply that fails the final preview shape, and names where', async () => {
    // A catalog symbol too long for the preview: only the final reply, with server symbols, fails.
    const long = { ...otherReserve, symbol: 'R'.repeat(81) };
    const shapeContext = {
      ...context,
      assets: assets.map((asset) => (asset.id === otherReserve.id ? long : asset)),
      evidence: [
        ...context.evidence,
        {
          id: `catalog:${cash.id}`,
          assetId: cash.id,
          source: 'offline catalog',
          method: 'cash residual',
          fetchedAt: now,
          provenance: 'mock' as const,
        },
      ],
    };
    const fixed = proposal();
    fixed.proposal.allocations = [
      proposal().proposal.allocations[0] as (typeof fixed.proposal.allocations)[number],
      {
        assetId: cash.id,
        why: 'Retain the rest as cash.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ];
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: proposal() })
      .mockResolvedValueOnce({ reply: fixed });
    const out = await replyToVaultConversation(request(), shapeContext, { read });
    expect(out).toMatchObject({
      kind: 'reply',
      repair: { failed: 'reply_shape', outcome: 'repaired' },
    });
    expect(read.mock.calls[1]?.[2]).toMatchObject({
      previous: proposal(),
      problems: [
        expect.stringContaining('final preview limits'),
        expect.stringMatching(/^At proposal\.allocations\.2\.symbol: /),
      ],
    });
    // The same reply again is refused with the shape code.
    expect(await replyToVaultConversation(request(), shapeContext, fake(proposal()))).toEqual(
      rejected('reply_shape'),
    );
  });

  it('gives the repair the time the first call actually took', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const read = vi
        .fn()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(1_000_000 + 7_250);
          return { reply: { ...proposal(), message: 'I changed your vault.' } };
        })
        .mockResolvedValueOnce({ reply: proposal() });
      await replyToVaultConversation(request(), context, { read });
      expect(read.mock.calls[1]?.[2]).toMatchObject({ elapsedMs: 7_250 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ reply: null, why: 'timeout', detail: 'model_timeout' }, 'timeout'],
    [{ reply: null, why: 'budget', detail: 'model_person_budget_spent' }, 'budget'],
    [{ reply: null, why: 'invalid', detail: 'model_cut_off' }, 'invalid'],
    [{ reply: null, why: 'unavailable', detail: 'model_error_529' }, 'unavailable'],
  ] as const)('does not repair a model failure: %o', async (output, reason) => {
    const read = vi.fn(async () => output);
    expect(await replyToVaultConversation(request(), context, { read })).toEqual({
      kind: 'failure',
      reason,
      detail: output.detail,
    });
    expect(read).toHaveBeenCalledOnce();
    const thrown = vi.fn(async () => {
      throw new Error('socket closed');
    });
    expect(await replyToVaultConversation(request(), context, { read: thrown })).toEqual({
      kind: 'failure',
      reason: 'unavailable',
      detail: 'model_threw',
    });
    expect(thrown).toHaveBeenCalledOnce();
  });

  // Gate ANY-COMPOSITION: any listed mix; the weights are the person's (equal unless they stated
  // shares); exit capacity and goal eligibility warn.
  const seventy = request(`I want 70% ${stock.symbol} and the rest in reserves.`);

  it('puts a single asset at seventy percent only when the person said so, above its shared-portfolio ceiling, which still binds a shared portfolio', async () => {
    expect(stock.maxWeightBps).toBeLessThan(7000);
    // Without the person's share, the same picks are equal.
    expect(weightsOf(await replyToVaultConversation(request(), context, fake(proposal())))).toEqual(
      [3334, 3333, 3333],
    );
    const out = await replyToVaultConversation(
      seventy,
      context,
      fake(
        withStated(proposal(), {
          assetIds: [stock.id],
          kind: 'exact',
          bps: 7000,
          quote: `70% ${stock.symbol}`,
        }),
      ),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.proposal?.allocations.map((line) => line.weightBps)).toEqual([
      7000, 1500, 1500,
    ]);
    expect(out.reply.warnings).toEqual([]);
    expect(out).not.toHaveProperty('repair');
    // The same weights as a shared portfolio are still refused at the asset's ceiling.
    const limits = {
      assets: [stock, reserve, otherReserve].map(({ id, maxWeightBps, cls }) => ({
        id,
        maxWeightBps,
        cls,
      })),
      now: 1_791_212_400,
      lastPublishAt: null,
      hasPending: false,
      publishDelay: 172_800,
    };
    expect(
      checkCreatorLimits(
        null,
        [
          { asset: stock.id, weightBps: 7000 },
          { asset: reserve.id, weightBps: 1500 },
          { asset: otherReserve.id, weightBps: 1500 },
        ],
        limits,
      ),
    ).toMatchObject({ ok: false, code: 'WeightAboveCeiling' });
  });

  it('warns on a weight above the measured exit share and cites that figure', async () => {
    const measured = {
      id: `liquidity:${stock.id}`,
      assetId: stock.id,
      label: 'Measured exit capacity at the current vault size',
      value: 250,
      unit: 'USD',
      source: 'offline measured fixture',
      method: 'offline-exit-fixture',
      fetchedAt: now,
      provenance: 'mock' as const,
    };
    const out = await replyToVaultConversation(
      request(),
      { ...context, evidence: [...context.evidence, measured], caps: { [stock.id]: 2000 } },
      fake(proposal()),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.warnings).toEqual([
      { code: 'over_exit_capacity', assetId: stock.id, evidenceId: measured.id },
    ]);
    expect(out.reply.proposal?.sources).toContainEqual(measured);
  });

  it.each(['income', 'protect'] as const)(
    'in a %s goal, takes a stock only when the person asked for it, with a warning',
    async (goal) => {
      const goalContext = { ...context, currentGoals: [{ goal }] };
      const outside = {
        code: 'outside_goal_requested',
        assetId: stock.id,
        evidenceId: `catalog:${stock.id}`,
      };
      // Naming the asset asks for it alone; asking for stocks asks for every listed stock.
      const stocks = assets.filter((asset) => asset.cls === 'stock' || asset.cls === 'etf');
      for (const [asked, requested] of [
        [`I want ${stock.symbol} in this vault.`, [stock.id]],
        ['I want stocks in it as well.', stocks.map((asset) => asset.id)],
        ['Quero ações também.', stocks.map((asset) => asset.id)],
        ['I want at least 10% stocks.', stocks.map((asset) => asset.id)],
      ] as const) {
        const model = fake(proposal());
        const out = await replyToVaultConversation(request(asked), goalContext, model);
        if (out.kind !== 'reply') throw new Error(`${asked} refused: ${JSON.stringify(out)}`);
        expect(out.reply.warnings).toEqual([outside]);
        expect(out.reply.proposal?.sources).toContainEqual(
          expect.objectContaining({ id: `catalog:${stock.id}` }),
        );
        expect(vi.mocked(model.read).mock.calls[0]?.[1]).toMatchObject({
          eligibilityGoal: goal,
          requestedOutsideGoal: requested,
        });
      }
      // The model adding a stock on its own, a refusal, a question or a request for another asset
      // is not the person asking for that stock: it is left out, and the reply says so.
      for (const [unasked, language] of [
        ['Keep my savings safe.', 'en'],
        ['I do not want stocks.', 'en'],
        ['Should I buy stocks?', 'en'],
        [`I want ${reserve.symbol} in this vault.`, 'en'],
        ['Não quero ações.', 'pt'],
        ['Devo comprar ações?', 'pt'],
        ['Quero proteger minhas economias.', 'pt'],
      ] as const) {
        const model = fake(proposal());
        const out = await replyToVaultConversation(
          { ...request(unasked), language },
          goalContext,
          model,
        );
        if (out.kind !== 'reply') throw new Error(`${unasked} refused: ${JSON.stringify(out)}`);
        expect(
          out.reply.proposal?.allocations.map((line) => [line.assetId, line.weightBps]),
        ).toEqual([
          [reserve.id, 5000],
          [otherReserve.id, 5000],
        ]);
        expect(out.reply.warnings).toEqual([]);
        expect(out.reply.weightNotes).toContainEqual({
          code: 'pick_outside_goal',
          assetIds: [stock.id],
        });
        expect(out.repair).toEqual(leftOutTwice);
        expect(vi.mocked(model.read).mock.calls[0]?.[1]).toMatchObject({
          requestedOutsideGoal: [],
        });
        // The model is asked once to write the reply without the stock, and told which pick it was.
        expect(vi.mocked(model.read).mock.calls[1]?.[2]?.problems.join(' ')).toContain(stock.id);
      }
    },
  );

  // A class the review of a mix refuses outright for the goal (mix.ts: `NOT_FOR_GOAL:<asset>`), which
  // the person asking for it does not change.
  const crypto = { ...stock, id: 'solana:fixture-crypto', cls: 'crypto' as const, symbol: 'FIXC' };
  const commodity = {
    ...stock,
    id: 'solana:fixture-commodity',
    cls: 'commodity' as const,
    symbol: 'FIXO',
  };
  const others = [crypto, commodity].map((asset) => ({ ...asset, underlying: asset.symbol }));
  const withOthers = (goal: 'grow' | 'income' | 'protect'): VaultAgentContext => ({
    ...context,
    currentGoals: [{ goal }],
    assets: [...context.assets, ...others],
    evidence: [
      ...context.evidence,
      ...others.map((asset) => ({
        id: `catalog:${asset.id}`,
        assetId: asset.id,
        source: 'offline catalog',
        method: 'listed assets',
        fetchedAt: now,
        provenance: 'mock' as const,
      })),
    ],
  });
  const picking = (...picked: Array<{ id: string }>) => {
    const value = proposal();
    value.proposal.allocations = picked.map((asset) => ({
      assetId: asset.id,
      why: 'This follows the direction you described.',
      evidenceIds: [`catalog:${asset.id}`],
    }));
    return value;
  };

  it.each(['income', 'protect'] as const)(
    'in a %s goal, leaves out crypto and commodities even when the person asks, and says so',
    async (goal) => {
      for (const [asked, language] of [
        [`I want ${crypto.symbol} and ${commodity.symbol} in this vault.`, 'en'],
        [`Quero ${crypto.symbol} e ${commodity.symbol} neste cofre.`, 'pt'],
      ] as const) {
        const model = fake(picking(crypto, commodity, reserve));
        const out = await replyToVaultConversation(
          { ...request(asked), language },
          withOthers(goal),
          model,
        );
        if (out.kind !== 'reply') throw new Error(`${asked} refused: ${JSON.stringify(out)}`);
        expect(
          out.reply.proposal?.allocations.map((line) => [line.assetId, line.weightBps]),
        ).toEqual([[reserve.id, 10_000]]);
        expect(out.reply.warnings).toEqual([]);
        expect(out.reply.weightNotes).toContainEqual({
          code: 'pick_outside_goal',
          assetIds: [crypto.id, commodity.id],
        });
        expect(out.reply.proposal?.sources.map((source) => source.id)).toEqual([
          `catalog:${reserve.id}`,
        ]);
        // The model is told what the goal cannot hold, and that only the asked-for stock may pass.
        expect(vi.mocked(model.read).mock.calls[0]?.[1]).toMatchObject({
          eligibilityGoal: goal,
          outsideGoal: expect.arrayContaining([crypto.id, commodity.id, stock.id]),
          requestedOutsideGoal: [],
        });
      }
    },
  );

  it.each([
    ['en', 'A plan with your goal cannot hold the assets picked for this draft'],
    ['pt', 'Um plano com o seu objetivo não pode ter os ativos escolhidos'],
  ] as const)(
    'proposes nothing when every pick is outside the goal (%s)',
    async (language, said) => {
      const out = await replyToVaultConversation(
        { ...request(`I want ${crypto.symbol}.`), language },
        withOthers('protect'),
        fake(picking(crypto)),
      );
      if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
      expect(out.reply.proposal).toBeNull();
      expect(out.reply.message).toContain(said);
      expect(out.reply.question).not.toBeNull();
      expect(out.reply.weightNotes).toEqual([{ code: 'pick_outside_goal', assetIds: [crypto.id] }]);
      expect(out.repair).toEqual(leftOutTwice);
    },
  );

  // The other listed stock, for a message that names two.
  const otherStock = assets.find(
    (asset) => (asset.cls === 'stock' || asset.cls === 'etf') && asset.id !== stock.id,
  );
  if (!otherStock) throw new Error('The fixture needs two stocks');
  const requestedFor = async (text: string, language: 'en' | 'pt' = 'en') => {
    const model = fake(proposal());
    const out = await replyToVaultConversation(
      { ...request(text), language },
      { ...context, currentGoals: [{ goal: 'income' }] },
      model,
    );
    const sent = vi.mocked(model.read).mock.calls[0]?.[1] as VaultAgentPrompt;
    return { out, requested: sent.requestedOutsideGoal };
  };

  // Naming a stock beside an asking verb is not asking for it: to remove, reduce, compare against or
  // worry about it leaves it out of an income plan (review of #194, blocking 1).
  it.each([
    [`I want to get rid of ${stock.symbol}.`, 'en'],
    [`I want to reduce ${stock.symbol}.`, 'en'],
    [`I want to move away from ${stock.symbol}.`, 'en'],
    [`I want something safer than ${stock.symbol}.`, 'en'],
    [`I prefer bonds to ${stock.symbol}.`, 'en'],
    [`I want steady income, ${stock.symbol} worries me.`, 'en'],
    [`I want to swap ${stock.symbol} for income.`, 'en'],
    [`Quero sair de ${stock.symbol}.`, 'pt'],
    [`Quero reduzir ${stock.symbol}.`, 'pt'],
    [`Quero trocar ${stock.symbol} por renda.`, 'pt'],
    [`Quero renda, ${stock.symbol} me preocupa.`, 'pt'],
    // Unclear is not asking either.
    [`I want protection from ${stock.symbol}.`, 'en'],
    [`I want income, ${stock.symbol} is in the news.`, 'en'],
    [`I want ${stock.symbol} sold.`, 'en'],
    ['I want protection from stocks.', 'en'],
    [`I want ${stock.symbol} to shrink.`, 'en'],
    [`I want ${stock.symbol} off my plan.`, 'en'],
    [`I do not want ${otherStock.symbol} or ${stock.symbol}.`, 'en'],
    [`Sell ${otherStock.symbol} and ${stock.symbol}.`, 'en'],
    [`Sell ${otherStock.symbol}, just ${stock.symbol}.`, 'en'],
  ] as const)('does not read "%s" as asking for the stock', async (text, language) => {
    const { out, requested } = await requestedFor(text, language);
    expect(requested).toEqual([]);
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.proposal?.allocations.map((line) => line.assetId)).toEqual([
      reserve.id,
      otherReserve.id,
    ]);
    expect(out.reply.warnings).toEqual([]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [stock.id],
    });
  });

  it.each([
    [`Add ${stock.symbol}`, 'en'],
    [`I want some ${stock.symbol} in it`, 'en'],
    [`I want to add ${stock.symbol} to my vault.`, 'en'],
    [`keep ${stock.symbol}`, 'en'],
    [`More ${stock.symbol}, please.`, 'en'],
    [`I want steady income and a little ${stock.symbol}.`, 'en'],
    [`Can you add ${stock.symbol}?`, 'en'],
    [`Sell ${otherStock.symbol} and add ${stock.symbol}.`, 'en'],
    [`I want less ${otherStock.symbol}, more ${stock.symbol}.`, 'en'],
    [`Quero incluir ${stock.symbol}`, 'pt'],
    [`Quero manter ${stock.symbol}.`, 'pt'],
    [`Vende ${otherStock.symbol} e compra ${stock.symbol}.`, 'pt'],
  ] as const)('reads "%s" as asking for that stock alone', async (text, language) => {
    const { out, requested } = await requestedFor(text, language);
    expect(requested).toEqual([stock.id]);
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.warnings).toEqual([
      { code: 'outside_goal_requested', assetId: stock.id, evidenceId: `catalog:${stock.id}` },
    ]);
  });

  it('reads a list after one asking verb, and a list after one refusal', async () => {
    expect(
      (await requestedFor(`I want ${otherStock.symbol}, ${stock.symbol} and a reserve.`)).requested,
    ).toEqual(expect.arrayContaining([stock.id, otherStock.id]));
    // The later refusal withdraws the earlier ask.
    expect(
      (await requestedFor(`Add ${stock.symbol}. I want to get rid of ${stock.symbol}.`)).requested,
    ).toEqual([]);
  });

  // The model wrote about a pick the server then removed, on both attempts (review of #194, blocking 2).
  it.each([
    [
      'en',
      `This draft leaves out ${stock.symbol}: a plan with your goal cannot hold it.`,
      'Keep my savings safe.',
    ],
    [
      'pt',
      `Esta proposta deixa de fora ${stock.symbol}: um plano com o seu objetivo não pode ter esse ativo.`,
      'Quero proteger minhas economias.',
    ],
  ] as const)(
    'serves no sentence about a pick it left out, and says what was left out (%s)',
    async (language, said, asked) => {
      const value = proposal();
      value.message = `I added ${stock.symbol} next to a reserve.`;
      value.proposal.summary = `This draft holds ${stock.symbol} and a reserve.`;
      value.proposal.tradeoffs = [`${stock.symbol} can fall.`, 'A reserve earns less.'];
      value.proposal.unknowns = [`How ${stock.symbol} trades next is unknown. Rates may change.`];
      value.proposal.allocations = value.proposal.allocations.slice(0, 2);
      const out = await replyToVaultConversation(
        { ...request(asked), language },
        { ...context, currentGoals: [{ goal: 'income' }] },
        fake(value),
      );
      if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
      expect(out.repair).toEqual(leftOutTwice);
      expect(out.reply.message).toBe(said);
      expect(out.reply.proposal).toMatchObject({
        objective: 'Seek growth while keeping a liquid cushion',
        summary: said,
        tradeoffs: ['A reserve earns less.'],
        allocations: [{ assetId: reserve.id, weightBps: 10_000 }],
      });
      expect(out.reply.proposal?.unknowns).toContain('Rates may change.');
      const prose = JSON.stringify(out.reply).replaceAll(said, '');
      expect(prose).not.toContain(stock.symbol);
    },
  );

  it('keeps the sentences that do not name the pick, whole, and ends a sentence at no full stop inside a name or a number', async () => {
    const value = picking(stock, reserve, crypto);
    value.message = `You said: “keep 1.5 safe” so ${crypto.symbol} is in. I also added ${crypto.symbol} next to Fixture Holdings Inc. as a pair. The reserve stays liquid!`;
    (value as { question: string | null }).question = `Is ${crypto.symbol} right for you?`;
    value.proposal.allocations[1] = {
      assetId: reserve.id,
      why: `It steadies the draft. It offsets ${crypto.symbol}.`,
      evidenceIds: [`catalog:${reserve.id}`],
    };
    const out = await replyToVaultConversation(
      request(`I want ${stock.symbol} in this vault, keep 1.5 safe`),
      {
        ...withOthers('income'),
        stockAttributes: {
          stocks: [{ symbol: stock.symbol, company: 'Fixture Holdings Inc.' }],
        } as never,
      },
      fake(value),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.message).toBe(
      `The reserve stays liquid! This draft leaves out ${crypto.symbol}: a plan with your goal cannot hold it.`,
    );
    expect(out.reply.question).toBeNull();
    expect(out.reply.proposal?.allocations.map((line) => [line.assetId, line.why])).toEqual([
      [stock.id, 'This follows the direction you described.'],
      [reserve.id, 'It steadies the draft.'],
    ]);
  });

  it('asks the model again, and fails, when a kept pick has no reason left without the removed asset', async () => {
    const value = picking(reserve, crypto);
    value.proposal.allocations[0] = {
      assetId: reserve.id,
      why: `It offsets ${crypto.symbol}.`,
      evidenceIds: [`catalog:${reserve.id}`],
    };
    const model = fake(value);
    expect(await replyToVaultConversation(request(), withOthers('income'), model)).toEqual(
      rejected('allocation_ineligible'),
    );
    expect(vi.mocked(model.read).mock.calls[1]?.[2]?.problems.join(' ')).toContain(crypto.id);
  });

  // A share on an asset the goal cannot hold is unmet whatever the model picks: the reply says the
  // goal is why, and never that the requirement still stands.
  it.each([
    ['en', `I want 30% ${commodity.symbol}`, 'a plan with your goal cannot hold that asset'],
    ['pt', `Quero 30% ${commodity.symbol}`, 'um plano com o seu objetivo não pode ter esse ativo'],
  ] as const)('says the goal is why a share cannot be met (%s)', async (language, asked, said) => {
    for (const picked of [picking(reserve), picking(commodity, reserve)]) {
      const model = fake(picked);
      const out = await replyToVaultConversation(
        { ...request(asked), language },
        withOthers('income'),
        model,
      );
      if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
      expect(out.reply.proposal).toBeNull();
      expect(out.reply.message).toContain(said);
      expect(out.reply.message).toContain(`30% ${commodity.symbol}`);
      expect(out.reply.message).not.toMatch(/still stands|continua valendo/u);
      expect(out.reply.question).not.toMatch(/within that limit|respeitando esse limite/u);
      expect(out.reply.weightNotes).toContainEqual({
        code: 'share_unmet',
        assetIds: [commodity.id],
        quote: `30% ${commodity.symbol}`,
      });
      // The model's one correction is told the goal is why.
      expect(vi.mocked(model.read).mock.calls[1]?.[2]?.problems.join(' ')).toContain('cannot hold');
    }
  });

  it('returns the corrected reply of the model when its repair leaves the pick out', async () => {
    const read = vi
      .fn<VaultAgentModel['read']>()
      .mockResolvedValueOnce({ reply: picking(crypto, reserve) })
      .mockResolvedValueOnce({ reply: picking(reserve) });
    const out = await replyToVaultConversation(request(), withOthers('income'), { read });
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.weightNotes.map((note) => note.code)).toEqual(['equal_split']);
    expect(out.repair).toEqual({ failed: 'allocation_ineligible', outcome: 'repaired' });
  });

  it('keeps the corrected reply when the repair call fails', async () => {
    const read = vi
      .fn<VaultAgentModel['read']>()
      .mockResolvedValueOnce({ reply: picking(crypto, reserve) })
      .mockResolvedValueOnce({ reply: null, why: 'timeout', detail: 'model_timeout' });
    const out = await replyToVaultConversation(request(), withOthers('income'), { read });
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.proposal?.allocations.map((line) => line.assetId)).toEqual([reserve.id]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [crypto.id],
    });
    expect(out.repair).toEqual({ failed: 'allocation_ineligible', outcome: 'model_timeout' });
  });

  it('holds no pick to a goal in a plan to grow, or where the server holds no goal', async () => {
    for (const held of [withOthers('grow'), { ...withOthers('grow'), currentGoals: [] }]) {
      const model = fake(picking(crypto, commodity, stock));
      const out = await replyToVaultConversation(request(), held, model);
      if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
      expect(out.reply.proposal?.allocations.map((line) => line.assetId)).toEqual([
        crypto.id,
        commodity.id,
        stock.id,
      ]);
      expect(out.reply.warnings).toEqual([]);
      expect(out.repair).toBeUndefined();
      expect(vi.mocked(model.read).mock.calls[0]?.[1]).toMatchObject({ outsideGoal: [] });
    }
  });

  it('refuses more than sixteen assets besides cash', async () => {
    const many = Array.from({ length: 17 }, (_, index) => ({
      ...stock,
      id: `solana:fixture-${index}`,
      symbol: `FIX${String.fromCharCode(65 + index)}`,
      underlying: `FIX${String.fromCharCode(65 + index)}`,
    }));
    const value = proposal();
    value.proposal.allocations = many.map((asset) => ({
      assetId: asset.id,
      why: 'Spread across listed names.',
      evidenceIds: [`catalog:${asset.id}`],
    }));
    const wide = {
      ...context,
      assets: [...context.assets, ...many],
      evidence: [
        ...context.evidence,
        ...many.map((asset) => ({
          id: `catalog:${asset.id}`,
          assetId: asset.id,
          source: 'offline catalog',
          method: 'listed assets',
          fetchedAt: now,
          provenance: 'mock' as const,
        })),
      ],
    };
    expect(await replyToVaultConversation(request(), wide, fake(value))).toEqual(
      rejected('allocation_lines'),
    );
    value.proposal.allocations = value.proposal.allocations.slice(0, 16);
    // Sixteen equal lines: 625 basis points each, no remainder.
    expect(weightsOf(await replyToVaultConversation(request(), wide, fake(value)))).toEqual(
      Array(16).fill(625),
    );
  });

  it('rejects counterfeit server metrics before calling the model', async () => {
    const model = fake(proposal());
    const firstSource = context.evidence[0];
    if (!firstSource) throw new Error('Missing evidence fixture');
    expect(
      await replyToVaultConversation(
        request(),
        { ...context, evidence: [{ ...firstSource, value: Number.NaN }] },
        model,
      ),
    ).toEqual({ kind: 'failure', reason: 'invalid', detail: 'context_non_finite' });
    expect(model.read).not.toHaveBeenCalled();
  });

  it.each(['income', 'protect'] as const)(
    'does not silently replace known %s eligibility with a stock proposal',
    async (goal) => {
      const kept = await replyToVaultConversation(
        request('Let us discuss growth'),
        { ...context, currentGoals: [{ goal }] },
        fake(proposal()),
      );
      if (kept.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(kept)}`);
      expect(kept.reply.proposal?.allocations.map((line) => line.assetId)).toEqual([
        reserve.id,
        otherReserve.id,
      ]);
      expect(kept.reply.weightNotes).toContainEqual({
        code: 'pick_outside_goal',
        assetIds: [stock.id],
      });
      const explicit = await replyToVaultConversation(
        request(),
        { ...context, currentGoals: [{ goal }], confirmedGoal: 'grow' },
        fake(proposal()),
      );
      expect(explicit.kind).toBe('reply');
    },
  );

  it('warns above measured exit capacity, citing the figure, and retains server unknowns even if the model fills its unknown list', async () => {
    const provider = {
      entry: (assetId: string) =>
        assetId === stock.id
          ? {
              assetId,
              capacityUsd: 100,
              samples: 12,
              dataTo: now,
              methodVersion: 'offline-exit-fixture',
              provenance: 'mock',
            }
          : null,
    } as unknown as NonNullable<
      Parameters<typeof buildVaultAgentContext>[0]['prepared']['figures']['liquidity']
    >['provider'];
    const built = buildVaultAgentContext({
      state,
      entry: { source: 'offline adapter', provenance: 'mock' } as Parameters<
        typeof buildVaultAgentContext
      >[0]['entry'],
      prices,
      prepared: { shelf, figures: { liquidity: { provider, source: 'offline measured fixture' } } },
      person: 'owner-fixture',
    });
    expect(built.caps?.[stock.id]).toBe(500);
    const over = await replyToVaultConversation(request(), built, fake(proposal()));
    if (over.kind !== 'reply') throw new Error(`over capacity refused: ${JSON.stringify(over)}`);
    expect(over.reply.warnings).toEqual([
      { code: 'over_exit_capacity', assetId: stock.id, evidenceId: `liquidity:${stock.id}` },
    ]);
    expect(over.reply.proposal?.sources).toContainEqual(
      expect.objectContaining({ id: `liquidity:${stock.id}`, value: 100, unit: 'USD' }),
    );
    // A warning, not a trim: the equal split stands.
    expect(over.reply.proposal?.allocations[0]).toMatchObject({
      assetId: stock.id,
      weightBps: 3334,
    });
    // At or under the measured share, as the person set it: no warning.
    const under = await replyToVaultConversation(
      request(`I want at most 5% ${stock.symbol}.`),
      built,
      fake(
        withStated(proposal(), {
          assetIds: [stock.id],
          kind: 'max',
          bps: 500,
          quote: `at most 5% ${stock.symbol}`,
        }),
      ),
    );
    expect(weightsOf(under)).toEqual([500, 4750, 4750]);
    expect(under.kind === 'reply' && under.reply.warnings).toEqual([]);
    const crowded = proposal();
    crowded.proposal.unknowns = Array.from({ length: 12 }, () => 'Model uncertainty.');
    const accepted = await replyToVaultConversation(request(), context, fake(crowded));
    if (accepted.kind !== 'reply') throw new Error('fixture rejected');
    expect(accepted.reply.proposal?.unknowns).toContain(context.unknowns[0]);
  });

  it.each([
    { samples: 0, dataTo: null, measured: false },
    { samples: 12, dataTo: null, measured: false },
    { samples: 12, dataTo: now, measured: true },
  ])(
    'distinguishes unknown from measured zero exit capacity: %j',
    ({ samples, dataTo, measured }) => {
      const provider = {
        entry: () => ({
          capacityUsd: 0,
          samples,
          dataTo,
          methodVersion: 'fixture',
          provenance: 'mock',
        }),
      } as unknown as NonNullable<
        Parameters<typeof buildVaultAgentContext>[0]['prepared']['figures']['liquidity']
      >['provider'];
      const built = buildVaultAgentContext({
        state,
        prices,
        person: 'owner-fixture',
        entry: { source: 'offline adapter', provenance: 'mock' } as Parameters<
          typeof buildVaultAgentContext
        >[0]['entry'],
        prepared: { shelf, figures: { liquidity: { provider, source: 'offline exit fixture' } } },
      });
      expect(built.caps?.[stock.id]).toBe(measured ? 0 : undefined);
      expect(
        built.evidence.some(
          (source) => source.id === `liquidity:${stock.id}` && source.value === 0,
        ),
      ).toBe(measured);
      expect(built.liquidity.find((row) => row.assetId === stock.id)?.observation === null).toBe(
        !measured,
      );
      expect(built.unknowns.join(' ').includes('Measured exit evidence is missing')).toBe(
        !measured,
      );
    },
  );

  it('includes catalog tiers and explicitly sourced tier observations in the model context', async () => {
    const built = buildVaultAgentContext({
      state,
      prices,
      person: 'owner-fixture',
      entry: { source: 'offline adapter', provenance: 'mock' } as Parameters<
        typeof buildVaultAgentContext
      >[0]['entry'],
      prepared: {
        shelf,
        figures: {
          tiers: [
            {
              assetId: stock.id,
              tier: stock.tier,
              source: 'tier source',
              fetchedAt: now,
              method: 'observed tier classification',
              provenance: 'mock',
            },
          ],
        },
      },
    });
    expect(built.evidence.find((source) => source.id === `tier:${stock.id}`)).toMatchObject({
      source: 'tier source',
      method: 'observed tier classification',
    });
    expect(built.evidence.find((source) => source.id === `tier:${cash.id}`)?.method).toContain(
      'not a measured risk observation',
    );
    const model = fake(proposal());
    await replyToVaultConversation(request(), built, model);
    expect(model.read).toHaveBeenCalledWith(
      'owner-fixture',
      expect.objectContaining({
        catalog: expect.arrayContaining([
          expect.objectContaining({ id: stock.id, tier: stock.tier }),
        ]),
      }),
    );
  });

  it('builds its context from actual vault/catalog/price inputs and says missing measurements are unknown', () => {
    const built = buildVaultAgentContext({
      state,
      entry: { source: 'offline adapter', provenance: 'mock' } as Parameters<
        typeof buildVaultAgentContext
      >[0]['entry'],
      prices,
      prepared: { shelf, figures: {} },
      person: 'owner-fixture',
      currentGoals: context.currentGoals,
    });
    expect(built.state).toBe(state);
    expect(
      built.evidence.some((source) => source.id === `price:${stock.id}` && source.value === 100),
    ).toBe(true);
    expect(built.liquidity.every((item) => item.observation === null)).toBe(true);
    expect(built.unknowns.join(' ')).toContain('missing');
    const source = readFileSync(new URL('./vault-agent.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:compose|personalize|buildOrder|prepareIntent)\s*\(/);
  });

  it('keeps distinct provenance for multiple historical yield observations of the same asset', async () => {
    const yields = [now, '2026-10-06T20:00:00.000Z'].map((fetchedAt) => ({
      assetId: reserve.id,
      quotedYield: 0.05,
      haircutYield: 0.04,
      haircutRule: 'offline fixture haircut',
      source: 'offline historical yields',
      fetchedAt,
      method: 'observed fixture',
      provenance: 'mock' as const,
    }));
    const built = buildVaultAgentContext({
      state,
      prices,
      person: 'owner-fixture',
      entry: { source: 'offline adapter', provenance: 'mock' } as Parameters<
        typeof buildVaultAgentContext
      >[0]['entry'],
      prepared: { shelf, figures: { yields } },
    });
    const rows = built.evidence.filter((source) => source.id.startsWith(`yield:${reserve.id}:`));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    expect(new Set(rows.map((row) => row.fetchedAt)).size).toBe(2);
    const model = fake(proposal());
    expect((await replyToVaultConversation(request(), built, model)).kind).toBe('reply');
    expect(model.read).toHaveBeenCalledOnce();
  });

  it('keeps exact bounded message chronology and refuses an app message as the latest input', () => {
    expect(VaultAgentRequest.safeParse(request()).success).toBe(true);
    expect(
      VaultAgentRequest.safeParse({ ...request(), messages: [{ who: 'app', text: 'Apply it.' }] })
        .success,
    ).toBe(false);
    expect(
      VaultAgentRequest.safeParse({
        ...request(),
        messages: Array.from({ length: 201 }, () => ({ who: 'person', text: 'hello' })),
      }).success,
    ).toBe(false);
    expect(
      VaultAgentRequest.safeParse({
        ...request(),
        messages: [
          { who: 'app', text: 'a'.repeat(8000) },
          { who: 'person', text: 'p'.repeat(2000) },
        ],
      }).success,
    ).toBe(true);
    expect(
      VaultAgentRequest.safeParse({
        ...request(),
        messages: [{ who: 'person', text: 'p'.repeat(2001) }],
      }).success,
    ).toBe(false);
    expect(VaultAgentRequest.safeParse({ ...request(), messageId: 'x'.repeat(65) }).success).toBe(
      false,
    );
  });
});

describe("Bearing's analytics in the conversation context", () => {
  type Built = Parameters<typeof buildVaultAgentContext>[0];
  const offline = { source: 'offline adapter', provenance: 'mock' } as Built['entry'];
  const pin = {
    unit: 'fraction' as const,
    source: 'offline fact sheet',
    method: 'fixture (facts-0.1)',
    fetchedAt: now,
    provenance: 'mock' as const,
  };
  const sheet = (over: Partial<Extract<AgentAnalyticsResult, { assets: unknown }>> = {}) =>
    ({
      sizeUsd: 10_000,
      basis: 'reference',
      tau: 0.01,
      assets: [
        {
          assetId: stock.id,
          modelledOn: null,
          figures: [
            { metric: 'exit_worst', regime: 'us_offhours_weekday', value: 0.004, ...pin },
            { metric: 'exit', regime: 'us_market_hours', value: 0.002, ...pin },
            { metric: 'exit', regime: 'weekend', value: null, reason: 'no_samples_in_regime' },
            { metric: 'weekend', value: null, reason: 'no_samples_in_regime' },
            { metric: 'lp_top1', value: 0.4, ...pin },
            { metric: 'volatility', value: null, reason: 'no_reference_price' },
            { metric: 'drawdown', value: null, reason: 'no_reference_price' },
          ],
        },
        { assetId: reserve.id, modelledOn: null, figures: null },
        { assetId: cash.id, modelledOn: null, figures: null },
      ],
      ...over,
    }) satisfies AgentAnalyticsResult;
  const built = (
    analytics: AgentAnalyticsResult | null,
    prepared: Built['prepared'] = {
      shelf,
      figures: {},
    },
  ) =>
    buildVaultAgentContext({
      state,
      entry: offline,
      prices,
      prepared,
      person: 'owner-fixture',
      currentGoals: context.currentGoals,
      analytics,
    });
  const sent = (model: VaultAgentModel) =>
    vi.mocked(model.read).mock.calls[0]?.[1] as VaultAgentPrompt;

  it('makes each measured figure citable, labelled with its size and regime, and each missing one an unknown with its reason', async () => {
    const ctx = built(sheet());
    expect(ctx.evidence.find((row) => row.id === `exit:${stock.id}:worst`)).toEqual({
      id: `exit:${stock.id}:worst`,
      assetId: stock.id,
      label: 'Exit cost at the reference size, worst measured regime (weekday off-hours)',
      value: 0.004,
      unit: 'fraction',
      source: 'offline fact sheet',
      method: 'fixture (facts-0.1)',
      fetchedAt: now,
      provenance: 'mock',
    });
    expect(ctx.evidence.find((row) => row.id === `lp:${stock.id}:top1`)?.value).toBe(0.4);
    expect(ctx.evidence.find((row) => row.id === `exit:${stock.id}:us_market_hours`)).toMatchObject(
      { label: 'Exit cost at the reference size in that regime (US market hours)', value: 0.002 },
    );
    // Missing is never a zero: no evidence id, a line that says what and why.
    for (const id of [`exit:${stock.id}:weekend`, `weekend:${stock.id}`, `vol:${stock.id}`])
      expect(ctx.evidence.some((row) => row.id === id)).toBe(false);
    expect(ctx.analytics?.unknowns).toEqual([
      `Exit cost at the reference size in that regime (weekend): unknown (no samples in that regime yet), for ${stock.symbol}.`,
      `Weekend ÷ market-hours exit capacity: unknown (no samples in that regime yet), for ${stock.symbol}.`,
      `Annualised price volatility: unknown (no reference prices collected), for ${stock.symbol}.`,
      `Largest price drawdown: unknown (no reference prices collected), for ${stock.symbol}.`,
      `No Bearing fact sheet, so exit, liquidity and market figures are unknown, for ${reserve.symbol}.`,
    ]);
    // The model reads the figures once, by id, with what each id measures said once.
    expect(ctx.analytics).toMatchObject({
      sizeUsd: 10_000,
      basis: 'reference',
      assets: [
        {
          assetId: stock.id,
          provenance: 'mock',
          worstRegime: 'us_offhours_weekday',
          values: {
            [`exit:${stock.id}:worst`]: 0.004,
            [`exit:${stock.id}:us_market_hours`]: 0.002,
            [`lp:${stock.id}:top1`]: 0.4,
          },
        },
      ],
    });
    expect(ctx.analytics?.legend?.['exit:<asset>:worst']).toBe(
      'Exit cost at the reference size, worst measured regime',
    );
    // No label holds a number the model could repeat into its prose.
    for (const text of [
      ...ctx.evidence
        .filter((row) => /^(?:exit|lp|lpexit|weekend|capvar|volume|vol|drawdown):/.test(row.id))
        .map((row) => row.label ?? ''),
      ...Object.values(ctx.analytics?.legend ?? {}),
      ...(ctx.analytics?.unknowns ?? []),
    ])
      expect([
        text,
        /\p{N}/u.test(text.replaceAll(stock.symbol, '').replaceAll(reserve.symbol, '')),
      ]).toEqual([text, false]);
    // The person's unknowns stay the server's few lines; the analytics gaps are the model's to weigh.
    expect(ctx.unknowns.join(' ')).not.toContain('reference prices');

    const value = proposal();
    value.proposal.allocations[0]?.evidenceIds.push(
      `exit:${stock.id}:worst`,
      `lp:${stock.id}:top1`,
    );
    const model = fake(value);
    const result = await replyToVaultConversation(request(), ctx, model);
    if (result.kind !== 'reply') throw new Error('analytics citation rejected');
    // The figure goes to the model once, in the analytics block, not again as an evidence row.
    expect(sent(model).evidence.some((row) => row.id === `exit:${stock.id}:worst`)).toBe(false);
    expect(sent(model).analytics).toEqual(ctx.analytics);
    expect(sent(model).exitCostTolerance).toBe(0.01);
    expect(VAULT_AGENT_SYSTEM).toContain("not this person's amount");
    expect(VAULT_AGENT_SYSTEM).toContain('they are not limits on weights');
    // The reply carries the server's whole source.
    expect(result.reply.proposal?.sources).toContainEqual(
      ctx.evidence.find((row) => row.id === `exit:${stock.id}:worst`),
    );
    expect(result.reply.proposal?.unknowns.join(' ')).not.toContain('reference prices');

    const borrowed = proposal();
    borrowed.proposal.allocations[1]?.evidenceIds.push(`exit:${stock.id}:worst`);
    expect(await replyToVaultConversation(request(), ctx, fake(borrowed))).toEqual(
      rejected('allocation_evidence'),
    );
  });

  it('keeps the fully measured analytics of the whole catalog compact', () => {
    const figures = [
      { metric: 'exit_worst' as const, regime: 'weekend' as const, value: 0.0123, ...pin },
      ...(['us_market_hours', 'us_offhours_weekday', 'us_holiday'] as const).map((regime) => ({
        metric: 'exit' as const,
        regime,
        value: 0.0045,
        ...pin,
      })),
      { metric: 'weekend' as const, value: 0.42, ...pin, unit: 'ratio' as const },
      { metric: 'lp_top1' as const, value: 0.41, ...pin },
      { metric: 'lp_exit' as const, value: 0.031, ...pin },
      { metric: 'cap_variation' as const, regime: 'weekend' as const, value: 0.18, ...pin },
      { metric: 'volume_28d' as const, value: 1_234_567, ...pin, unit: 'usd' as const },
      { metric: 'volatility' as const, value: 0.27, ...pin },
      { metric: 'drawdown' as const, value: 0.19, ...pin },
    ];
    const listed = assets.filter((asset) => asset.cls !== 'cash');
    const ctx = built(
      sheet({
        assets: listed.map((asset) => ({ assetId: asset.id, modelledOn: null, figures })),
      }),
    );
    expect(ctx.analytics?.assets).toHaveLength(listed.length);
    expect(Object.keys(ctx.analytics?.assets?.[0]?.values ?? {})).toHaveLength(figures.length);
    // Each figure once, by id, with what it measures said once for all: under the prompt's budget.
    expect(JSON.stringify(ctx.analytics).length).toBeLessThan(25_000);
  });

  it('keeps the first of two figures that would share an id, so a doubled row never fails the reply', async () => {
    const twice = [
      { metric: 'exit_worst' as const, regime: 'weekend' as const, value: 0.02, ...pin },
      { metric: 'exit' as const, regime: 'us_market_hours' as const, value: 0.002, ...pin },
      { metric: 'exit' as const, regime: 'us_market_hours' as const, value: 0.009, ...pin },
      { metric: 'lp_top1' as const, value: 0.4, ...pin },
    ];
    const ctx = built(
      sheet({
        assets: [
          { assetId: stock.id, modelledOn: null, figures: twice },
          {
            assetId: stock.id,
            modelledOn: null,
            figures: [{ metric: 'lp_top1', value: 0.7, ...pin }],
          },
        ],
      }),
    );
    const ids = ctx.evidence.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ctx.evidence.find((row) => row.id === `exit:${stock.id}:us_market_hours`)?.value).toBe(
      0.002,
    );
    expect(ctx.evidence.find((row) => row.id === `lp:${stock.id}:top1`)?.value).toBe(0.4);
    expect(ctx.analytics?.assets).toHaveLength(1);
    expect(ctx.analytics?.assets?.[0]?.values).toEqual({
      [`exit:${stock.id}:worst`]: 0.02,
      [`exit:${stock.id}:us_market_hours`]: 0.002,
      [`lp:${stock.id}:top1`]: 0.4,
    });
    expect((await replyToVaultConversation(request(), ctx, fake(proposal()))).kind).toBe('reply');
  });

  it('keeps a sixteen-asset test-network vault with every figure measured small, and its words free of numbers', () => {
    const figures = [
      {
        metric: 'exit_worst' as const,
        regime: 'weekend' as const,
        value: 0.0123,
        lowerBound: true,
      },
      ...(['us_market_hours', 'us_offhours_weekday', 'us_holiday'] as const).map((regime) => ({
        metric: 'exit' as const,
        regime,
        value: 0.0045,
      })),
      { metric: 'weekend' as const, value: 0.42, unit: 'ratio' as const },
      { metric: 'lp_top1' as const, value: 0.41 },
      { metric: 'lp_exit' as const, value: 0.031, sizeUsd: 100_000 },
      { metric: 'cap_variation' as const, regime: 'weekend' as const, value: 0.18 },
      { metric: 'volume_28d' as const, value: 1_234_567, unit: 'usd' as const },
      { metric: 'volatility' as const, value: 0.27 },
      { metric: 'drawdown' as const, value: 0.19 },
    ].map((figure) => ({ ...pin, provenance: 'sandbox' as const, ...figure }));
    const sixteen = assets.filter((asset) => asset.cls !== 'cash').slice(0, 16);
    expect(sixteen).toHaveLength(16);
    const ctx = built(
      sheet({
        sizeUsd: 37_000,
        basis: 'vault',
        assets: sixteen.map((asset) => ({
          assetId: asset.id,
          modelledOn: asset.symbol,
          figures,
        })),
      }),
    );
    expect(ctx.analytics?.assets).toHaveLength(16);
    expect(ctx.analytics?.unknowns).toEqual([]);
    // 9,286 characters with every flag set on every asset: each figure once by id, the legend once.
    expect(JSON.stringify(ctx.analytics).length).toBeLessThan(11_000);
    const names = assets.flatMap((asset) => [asset.symbol, asset.underlying ?? '']).filter(Boolean);
    const analyticsRows = ctx.evidence.filter((row) =>
      /^(?:exit|lp|lpexit|weekend|capvar|volume|vol|drawdown):/.test(row.id),
    );
    expect(analyticsRows).toHaveLength(16 * figures.length);
    for (const text of [
      ...analyticsRows.map((row) => row.label ?? ''),
      ...Object.values(ctx.analytics?.legend ?? {}),
    ])
      expect([
        text,
        /[\p{N}%$]/u.test(names.reduce((rest, name) => rest.replaceAll(name, ''), text)),
      ]).toEqual([text, false]);
    // Every figure keeps its pin on the server, and none on a test network says live.
    for (const row of analyticsRows)
      expect(row).toMatchObject({
        source: pin.source,
        fetchedAt: now,
        provenance: 'sandbox',
        method: expect.stringContaining(pin.method),
      });
  });

  it('says a gap once for every asset it holds for, and names assets still being read', () => {
    const gap = {
      metric: 'volatility' as const,
      value: null,
      reason: 'no_reference_price' as const,
    };
    const ctx = built(
      sheet({
        assets: [
          ...[stock, reserve].map((asset) => ({
            assetId: asset.id,
            modelledOn: null,
            figures: [gap],
          })),
          { assetId: otherReserve.id, modelledOn: null, figures: null, unread: 'reading' as const },
        ],
      }),
    );
    expect(ctx.analytics?.unknowns).toEqual([
      'Annualised price volatility: unknown (no reference prices collected), for every asset with a sheet.',
      `Bearing's figures are still being read, so unknown for this reply, for ${otherReserve.symbol}.`,
    ]);
  });

  it('names the vault size, a larger measured size, a lower bound and the mainnet model in words', () => {
    const ctx = built(
      sheet({
        sizeUsd: 2_000,
        basis: 'vault',
        assets: [
          {
            assetId: stock.id,
            modelledOn: 'SPYx',
            figures: [
              { metric: 'lp_exit', value: 0.015, ...pin, provenance: 'sandbox', sizeUsd: 25_000 },
              {
                metric: 'exit_worst',
                value: 0.004,
                ...pin,
                provenance: 'sandbox',
                lowerBound: true,
              },
            ],
          },
        ],
      }),
    );
    // The size it was read at is a figure: in the pin, not the words.
    expect(ctx.evidence.find((row) => row.id === `lpexit:${stock.id}`)).toMatchObject({
      label:
        "Exit cost at the nearest measured size above about the vault's size if the largest liquidity providers leave; SPYx mainnet figures on a test network",
      method: 'fixture (facts-0.1); measured at $25,000',
      provenance: 'sandbox',
    });
    expect(ctx.evidence.find((row) => row.id === `exit:${stock.id}:worst`)?.label).toBe(
      "Exit cost at about the vault's size, worst measured regime; a lower bound, the true figure is at least this; SPYx mainnet figures on a test network",
    );
    expect(ctx.analytics?.assets?.[0]).toMatchObject({
      modelledOn: 'SPYx',
      provenance: 'sandbox',
      lowerBound: [`exit:${stock.id}:worst`],
      largerSize: [`lpexit:${stock.id}`],
    });
    expect(ctx.analytics).toMatchObject({ sizeUsd: 2_000, basis: 'vault' });
  });

  it('turns analytics that could not be read, or a figure that is not a valid source, into unknowns', async () => {
    const down = built({ unavailable: 'analytics_timeout' });
    expect(down.evidence.some((row) => /^(?:exit|lp|vol):/.test(row.id))).toBe(false);
    expect(down.analytics).toEqual({
      unknowns: [
        "Bearing's exit, liquidity and market analytics could not be read for this reply; those figures are unknown, not zero.",
      ],
    });
    expect(await readAgentAnalytics(undefined, {} as never)).toBeNull();
    expect(
      await readAgentAnalytics(
        (async () => {
          throw new Error('pool exhausted');
        }) as AgentAnalytics,
        {} as never,
      ),
    ).toEqual({ unavailable: 'analytics_threw' });
    expect(analyticsGap({ unavailable: 'analytics_timeout' })).toBe('analytics_timeout');
    expect(analyticsGap({ ...sheet(), incomplete: 'analytics_partial_1_of_3' })).toBe(
      'analytics_partial_1_of_3',
    );
    expect(analyticsGap(sheet())).toBeNull();

    const bad = built(
      sheet({
        assets: [
          {
            assetId: stock.id,
            modelledOn: null,
            figures: [{ metric: 'volume_28d', value: 5, ...pin, fetchedAt: 'yesterday' }],
          },
        ],
      }),
    );
    expect(bad.evidence.some((row) => row.id === `volume:${stock.id}`)).toBe(false);
    expect(bad.analytics?.unknowns).toEqual([
      `Traded volume over the last four weeks: unknown (the stored figure could not be read), for ${stock.symbol}.`,
    ]);
    expect((await replyToVaultConversation(request(), bad, fake(proposal()))).kind).toBe('reply');
  });

  it("keeps one figure per measure: the vault's weekend ratio and LP-exit cost are the analytics'", () => {
    const provider = {
      entry: (assetId: string) =>
        assetId === stock.id
          ? {
              assetId,
              capacityUsd: 50_000,
              samples: 12,
              dataTo: now,
              weekendRatio: 0.6,
              lpExitCostPct: 1.5,
              methodVersion: 'offline-exit-fixture',
              provenance: 'mock',
            }
          : null,
    } as unknown as NonNullable<Built['prepared']['figures']['liquidity']>['provider'];
    const ctx = built(null, {
      shelf,
      figures: { liquidity: { provider, source: 'offline measured fixture' } },
    });
    expect(ctx.evidence.filter((row) => row.id.startsWith(`liquidity:${stock.id}`))).toEqual([
      expect.objectContaining({ id: `liquidity:${stock.id}` }),
    ]);
    expect(ctx.analytics).toBeUndefined();
  });

  it('gives a new goal the size-free exit capacity of each measured asset, and never fails on a bad reading', () => {
    const capacity = (measured: boolean, dataTo = now) => ({
      covers: () => true,
      exitCapacity: vi.fn((assetId: string) =>
        measured || assetId === stock.id
          ? {
              capacityUsd: 80_000,
              lowerBound: assetId === otherReserve.id,
              regime: 'us_offhours_weekday',
              samples: 30,
              dataFrom: '2026-10-06T00:00:00.000Z',
              dataTo,
            }
          : null,
      ),
      entry: vi.fn(() => {
        throw new Error('A new goal has no amount to size an entry');
      }),
      methodVersion: 'offline-exit-fixture',
      provenance: 'sandbox',
    });
    const goal = (provider: ReturnType<typeof capacity>) =>
      buildGoalAgentContext({
        chain: 'solana',
        observedAt: now,
        entry: offline,
        prices,
        person: 'owner-fixture',
        prepared: {
          shelf,
          figures: {
            liquidity: {
              provider: provider as unknown as NonNullable<
                Built['prepared']['figures']['liquidity']
              >['provider'],
              source: 'offline measured fixture',
            },
          },
        },
      });
    const some = capacity(false);
    const partial = goal(some);
    expect(partial.evidence.find((row) => row.id === `capacity:${stock.id}`)).toEqual({
      id: `capacity:${stock.id}`,
      assetId: stock.id,
      label:
        'Largest sale within the cost tolerance, worst regime of the exit window; does not depend on an amount',
      value: 80_000,
      unit: 'USD',
      source: 'offline measured fixture',
      fetchedAt: now,
      method: 'offline-exit-fixture; cost tolerance 0.01',
      provenance: 'sandbox',
    });
    expect(partial.evidence.some((row) => row.id === `capacity:${reserve.id}`)).toBe(false);
    expect(partial.evidence.some((row) => row.id === `capacity:${cash.id}`)).toBe(false);
    expect(partial.unknowns.join(' ')).toContain('Measured exit evidence is missing');
    expect(some.entry).not.toHaveBeenCalled();
    const all = goal(capacity(true));
    expect(all.unknowns.join(' ')).not.toContain('Measured exit evidence is missing');
    expect(all.evidence.find((row) => row.id === `capacity:${otherReserve.id}`)?.label).toContain(
      'a lower bound, the true figure is at least this',
    );
    // A reading whose date is not one is not measured: an unknown, never a failed reply.
    const dateless = goal(capacity(true, 'yesterday'));
    expect(dateless.evidence.some((row) => row.id.startsWith('capacity:'))).toBe(false);
    expect(dateless.unknowns.join(' ')).toContain('Measured exit evidence is missing');
  });
});
