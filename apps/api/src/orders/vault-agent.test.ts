import { readFileSync } from 'node:fs';
import type { Price, VaultState } from '@colosseum/schemas';
import { VaultAgentRequest } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel } from '../vault-agent-model';
import {
  buildVaultAgentContext,
  replyToVaultConversation,
  type VaultAgentContext,
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
const proposal = (share: number) => ({
  message: 'Here is a possible direction for your vault. This is a preview for discussion.',
  question: null,
  proposal: {
    objective: 'Seek growth while keeping a liquid cushion',
    summary: 'Increase exposure to the named stock and retain a reserve.',
    allocations: [
      {
        assetId: stock.id,
        weightBps: share,
        why: 'This expresses your stated stock preference.',
        evidenceIds: [`catalog:${stock.id}`],
      },
      {
        assetId: reserve.id,
        weightBps: 5500 - share,
        why: 'This reserve diversifies the proposed holdings.',
        evidenceIds: [`catalog:${reserve.id}`],
      },
      {
        assetId: otherReserve.id,
        weightBps: 4500,
        why: 'This retains exposure outside the named stock.',
        evidenceIds: [`catalog:${otherReserve.id}`],
      },
    ],
    tradeoffs: ['Stock concentration can increase losses.'],
    unknowns: ['The future price path is unknown.'],
  },
});
const fake = (reply: unknown): VaultAgentModel => ({ read: vi.fn(async () => ({ reply })) });
// The reply failed `detail`, the model was asked once to correct it, and sent the same reply again.
const rejected = (detail: string) => ({
  kind: 'failure',
  reason: 'invalid',
  detail,
  repair: { failed: detail, outcome: detail },
});

describe('model-led private vault proposals', () => {
  it('accepts real-catalog cash residual previews while honoring explicit additional cash caps', async () => {
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
    const value = proposal(1000);
    value.proposal.allocations = [
      {
        assetId: cash.id,
        weightBps: 10000,
        why: 'Keep cash while discussing the strategy.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ];
    const model = fake(value);
    const onlyCash = await replyToVaultConversation(request(), cashContext, model);
    expect(onlyCash.kind).toBe('reply');
    expect(model.read).toHaveBeenCalledWith(
      'owner-fixture',
      expect.objectContaining({
        caps: expect.objectContaining({ [cash.id]: 10000 }),
        catalog: expect.arrayContaining([
          expect.objectContaining({ id: cash.id, maxWeightBps: 10000 }),
        ]),
      }),
    );
    value.proposal.allocations = [
      proposal(1000).proposal.allocations[0] as (typeof value.proposal.allocations)[number],
      {
        assetId: cash.id,
        weightBps: 9000,
        why: 'Retain the rest as cash.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ];
    expect((await replyToVaultConversation(request(), cashContext, fake(value))).kind).toBe(
      'reply',
    );
    expect(
      await replyToVaultConversation(
        request(),
        { ...cashContext, caps: { [cash.id]: 5000 } },
        fake(value),
      ),
    ).toEqual(rejected('allocation_over_cap'));
  });

  it('keeps an explicit stock minimum through later refinement and asks about a mismatched draft without reweighting', async () => {
    const minimum = request('I want at least 40% stocks in this vault.');
    const wrong = fake(proposal(1000));
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
    expect(result.reply.message).toContain(minimum.messages[1]?.text);
    expect(result.reply.question).toContain('within that limit');
    const later = {
      ...minimum,
      messages: [
        ...minimum.messages,
        { who: 'app' as const, text: result.reply.message },
        { who: 'person' as const, text: 'Please keep it diversified.' },
      ],
    };
    expect((await replyToVaultConversation(later, context, fake(proposal(1000)))).kind).toBe(
      'reply',
    );
    const held = await replyToVaultConversation(later, context, fake(proposal(1000)));
    if (held.kind !== 'reply') throw new Error('Missing explanation');
    expect(held.reply.proposal).toBeNull();
    const correct = await replyToVaultConversation(minimum, context, fake(proposal(4000)));
    expect(correct.kind).toBe('reply');
    if (correct.kind === 'reply')
      expect(correct.reply.proposal?.allocations[0]?.weightBps).toBe(4000);
    const amended = {
      ...later,
      messages: [...later.messages, { who: 'person' as const, text: 'Make that at least 10%.' }],
    };
    const replacement = await replyToVaultConversation(amended, context, fake(proposal(1000)));
    if (replacement.kind !== 'reply') throw new Error('Replacement rejected');
    expect(replacement.reply.proposal).not.toBeNull();
    const dropped = {
      ...later,
      messages: [...later.messages, { who: 'person' as const, text: 'Ignore that stock minimum.' }],
    };
    const declined = await replyToVaultConversation(dropped, context, fake(proposal(1000)));
    if (declined.kind !== 'reply') throw new Error('Decline rejected');
    expect(declined.reply.proposal).not.toBeNull();
  });

  it.each([
    '"I want at least 40% stocks."',
    'If I want at least 40% stocks, would that be sensible?',
    'My friend said I want at least 40% stocks.',
    'I do not want at least 40% stocks.',
    'I want to discuss at least 40% stocks as an example.',
  ])('does not turn non-instructions into a holding limit: %s', async (text) => {
    const out = await replyToVaultConversation(request(text), context, fake(proposal(1000)));
    if (out.kind !== 'reply') throw new Error('Fixture rejected');
    expect(out.reply.proposal).not.toBeNull();
  });

  it('allows figures only inside exact attributed person quotes, never as invented measurements', async () => {
    const value = proposal(1000);
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

  it('preserves the exact reported stock-minimum wording across its sentence boundary', async () => {
    const text = 'i think i want way more stocks on them. like at least 40%';
    const out = await replyToVaultConversation(request(text), context, fake(proposal(1000)));
    if (out.kind !== 'reply') throw new Error('Missing conflict explanation');
    expect(out.reply.message).toContain(text);
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.question).toBeTruthy();
  });

  it('permits an exact trusted catalog name containing a digit', async () => {
    const value = proposal(1000);
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
      await replyToVaultConversation(request(), context, fake({ ...proposal(1000), message })),
    ).toEqual(rejected('prose_claims_applied'));
  });

  it.each([
    'I can draft a change for your vault. Nothing was applied.',
    'Posso preparar uma proposta. Nada foi aplicado.',
  ])('accepts truthful preview wording: %s', async (message) => {
    expect(
      (await replyToVaultConversation(request(), context, fake({ ...proposal(1000), message })))
        .kind,
    ).toBe('reply');
  });
  it('accepts different model-selected allocations, hydrates catalog symbols/sources, and sends actual goals and targets', async () => {
    const model = fake(proposal(1000));
    const first = await replyToVaultConversation(request(), context, model);
    const second = await replyToVaultConversation(
      request('I now prefer more stock exposure'),
      context,
      fake(proposal(1500)),
    );
    expect(first.kind).toBe('reply');
    expect(second.kind).toBe('reply');
    if (first.kind !== 'reply' || second.kind !== 'reply')
      throw new Error('fixture preview rejected');
    expect(first.reply.proposal?.allocations[0]).toMatchObject({
      weightBps: 1000,
      symbol: stock.symbol,
    });
    expect(second.reply.proposal?.allocations[0]?.weightBps).toBe(1500);
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
    'cap',
    'sum',
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
      cap: 'allocation_over_cap',
      sum: 'allocation_sum',
      duplicate: 'allocation_duplicate',
      evidence: 'allocation_evidence',
      'wrong-reference': 'allocation_evidence',
      'financial-figure': 'prose_figure',
      'written-figure': 'prose_figure',
      symbol: 'reply_schema',
      infinity: 'reply_schema',
    };
    const value = proposal(1000);
    const [allocation, remainder] = value.proposal.allocations;
    if (!allocation || !remainder) throw new Error('Incomplete allocation fixture');
    if (fault === 'asset') allocation.assetId = 'solana:unlisted';
    if (fault === 'crosschain') allocation.assetId = 'robinhood:unlisted';
    if (fault === 'cap') {
      allocation.weightBps = 9000;
      remainder.weightBps = 1000;
    }
    if (fault === 'sum') allocation.weightBps = 500;
    if (fault === 'duplicate') remainder.assetId = stock.id;
    if (fault === 'evidence') allocation.evidenceIds = ['invented-risk-observation'];
    if (fault === 'wrong-reference') allocation.evidenceIds = [`catalog:${reserve.id}`];
    if (fault === 'financial-figure') allocation.why = 'The yield is 12%.';
    if (fault === 'written-figure') allocation.why = 'It pays ten percent annually.';
    if (fault === 'symbol') Object.assign(allocation, { symbol: 'MADEUP' });
    if (fault === 'infinity') allocation.weightBps = Number.POSITIVE_INFINITY;
    const caps = fault === 'cap' ? { [stock.id]: 2000 } : undefined;
    expect(
      await replyToVaultConversation(
        request(),
        { ...context, ...(caps ? { caps } : {}) },
        fake(value),
      ),
    ).toEqual(rejected(expected[fault] ?? 'unmapped'));
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
        .mockResolvedValueOnce({ reply: { ...proposal(1000), message: 'I changed your vault.' } })
        .mockResolvedValueOnce({ reply: proposal(1000) }),
    });
    expect(repaired).toMatchObject({
      kind: 'reply',
      repair: { failed: 'prose_claims_applied', outcome: 'repaired' },
    });
    if (repaired.kind !== 'reply') throw new Error('repair rejected');
    expect(repaired.reply.message).toBe(proposal(1000).message);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: { ...proposal(1000), message: 'I changed your vault.' } })
      .mockResolvedValueOnce({ reply: proposal(1000) });
    await replyToVaultConversation(request(), context, { read });
    expect(read).toHaveBeenCalledTimes(2);
    const [person, prompt] = read.mock.calls[0] ?? [];
    expect(read.mock.calls[1]).toEqual([
      person,
      prompt,
      {
        previous: { ...proposal(1000), message: 'I changed your vault.' },
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

  it('repairs a draft that breaks a stated limit, naming the limit but never the draft weights', async () => {
    const minimum = request('I want at least 40% stocks in this vault.');
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: proposal(1000) })
      .mockResolvedValueOnce({ reply: proposal(4000) });
    const repaired = await replyToVaultConversation(minimum, context, { read });
    expect(repaired).toMatchObject({
      kind: 'reply',
      repair: { failed: 'allocation_constraint', outcome: 'repaired' },
    });
    if (repaired.kind !== 'reply') throw new Error('Repair rejected');
    expect(repaired.reply.proposal?.allocations[0]?.weightBps).toBe(4000);
    const problems: string[] = read.mock.calls[1]?.[2].problems;
    expect(problems).toEqual([
      expect.stringContaining('broke a limit the person stated'),
      'At allocationConstraints.0 (the person said “I want at least 40% stocks in this vault.”): the weightBps of its assetIds together came below its minWeightBps.',
    ]);
    // The draft's own weights are not repeated back.
    expect(problems.join(' ')).not.toMatch(/1000|4500/);
    const maximum = request('I want at most 10% stocks in this vault.');
    const over = vi
      .fn()
      .mockResolvedValueOnce({ reply: proposal(4000) })
      .mockResolvedValueOnce({ reply: proposal(1000) });
    expect(await replyToVaultConversation(maximum, context, { read: over })).toMatchObject({
      kind: 'reply',
      repair: { failed: 'allocation_constraint', outcome: 'repaired' },
    });
    expect(over.mock.calls[1]?.[2].problems[1]).toContain('came above its maxWeightBps');
  });

  it('keeps the question about a stated limit when its repair fails another way', async () => {
    const minimum = request('I want at least 40% stocks in this vault.');
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: proposal(1000) })
      .mockResolvedValueOnce({ reply: null, why: 'timeout', detail: 'model_timeout' });
    const out = await replyToVaultConversation(minimum, context, { read });
    expect(out).toMatchObject({
      kind: 'reply',
      repair: { failed: 'allocation_constraint', outcome: 'model_timeout' },
    });
    if (out.kind !== 'reply') throw new Error('Missing explanation');
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.message).toContain(minimum.messages[1]?.text);
    expect(out.reply.question).toContain('within that limit');
    // A repair that fails a structure check also leaves the question standing.
    const schema = vi
      .fn()
      .mockResolvedValueOnce({ reply: proposal(1000) })
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
    const fixed = proposal(1000);
    fixed.proposal.allocations = [
      proposal(1000).proposal.allocations[0] as (typeof fixed.proposal.allocations)[number],
      {
        assetId: cash.id,
        weightBps: 9000,
        why: 'Retain the rest as cash.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ];
    const read = vi
      .fn()
      .mockResolvedValueOnce({ reply: proposal(1000) })
      .mockResolvedValueOnce({ reply: fixed });
    const out = await replyToVaultConversation(request(), shapeContext, { read });
    expect(out).toMatchObject({
      kind: 'reply',
      repair: { failed: 'reply_shape', outcome: 'repaired' },
    });
    expect(read.mock.calls[1]?.[2]).toMatchObject({
      previous: proposal(1000),
      problems: [
        expect.stringContaining('final preview limits'),
        expect.stringMatching(/^At proposal\.allocations\.2\.symbol: /),
      ],
    });
    // The same reply again is refused with the shape code.
    expect(await replyToVaultConversation(request(), shapeContext, fake(proposal(1000)))).toEqual(
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
          return { reply: { ...proposal(1000), message: 'I changed your vault.' } };
        })
        .mockResolvedValueOnce({ reply: proposal(1000) });
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

  it('rejects counterfeit server metrics before calling the model', async () => {
    const model = fake(proposal(1000));
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
      expect(
        await replyToVaultConversation(
          request('Let us discuss growth'),
          { ...context, currentGoals: [{ goal }] },
          fake(proposal(1000)),
        ),
      ).toEqual(rejected('allocation_ineligible'));
      const explicit = await replyToVaultConversation(
        request(),
        { ...context, currentGoals: [{ goal }], confirmedGoal: 'grow' },
        fake(proposal(1000)),
      );
      expect(explicit.kind).toBe('reply');
    },
  );

  it('enforces a measured exit-capacity ceiling and retains server unknowns even if the model fills its unknown list', async () => {
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
    expect(await replyToVaultConversation(request(), built, fake(proposal(1000)))).toEqual(
      rejected('allocation_over_cap'),
    );
    const crowded = proposal(1000);
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
    const model = fake(proposal(1000));
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
    const model = fake(proposal(1000));
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
