import Anthropic from '@anthropic-ai/sdk';
import type { VaultAgentModelReply, VaultAgentRequest, VaultState } from '@colosseum/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStockAttributes } from '../../../packages/engine/src/personal/stock-attributes';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import {
  type GoalAgentContext,
  replyToVaultConversation,
  type VaultAgentContext,
  type VaultAgentPrompt,
} from './orders/vault-agent';
import mockStocks from './testing/fixtures/mock-stocks.json';
import {
  createAnthropicVaultAgentModel,
  VAULT_AGENT_REPLY_SCHEMA,
  VAULT_AGENT_SYSTEM,
} from './vault-agent-model';

const sdk = vi.hoisted(() => ({ create: vi.fn(), options: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class Timeout extends Error {}
  return {
    default: class {
      static APIConnectionTimeoutError = Timeout;
      messages = { create: sdk.create };
      constructor(options: unknown) {
        sdk.options(options);
      }
    },
  };
});
const prompt = {
  version: 1,
  language: 'en',
  messages: [{ who: 'person', text: 'Discuss my vault.' }],
} as VaultAgentPrompt;
const options = {
  apiKey: 'offline-test-placeholder',
  model: 'configured-fixture-model',
  timeoutMs: 6000,
};

beforeEach(() => {
  sdk.create.mockReset();
  sdk.options.mockClear();
});

describe('vault proposal provider uses the existing model settings and a shared reservation', () => {
  it('makes one structured call with the configured settings, exact context, and no independent budget', async () => {
    const reserve = vi.fn(() => null);
    sdk.create.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: '{"message":"Discuss it.","question":null,"proposal":null}' },
      ],
    });
    const model = createAnthropicVaultAgentModel({ ...options, quota: { reserve } });
    const before = sdk.create.mock.calls.length;
    expect(await model.read('owner', prompt)).toEqual({
      reply: { message: 'Discuss it.', question: null, proposal: null },
    });
    expect(reserve).toHaveBeenCalledExactlyOnceWith('owner');
    expect(sdk.create.mock.calls.length - before).toBe(1);
    expect(sdk.options).toHaveBeenLastCalledWith({
      apiKey: options.apiKey,
      timeout: 6000,
      maxRetries: 0,
    });
    expect(sdk.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: options.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: JSON.stringify(prompt) }],
        output_config: { format: { type: 'json_schema', schema: VAULT_AGENT_REPLY_SCHEMA } },
      }),
    );
  });

  it.each(['model_budget_spent', 'model_person_budget_spent'] as const)(
    'reserves no SDK call when the shared quota reports %s',
    async (reason) => {
      const model = createAnthropicVaultAgentModel({
        ...options,
        quota: { reserve: () => reason },
      });
      const before = sdk.create.mock.calls.length;
      expect(await model.read('owner', prompt)).toEqual({ reply: null, why: 'budget' });
      expect(sdk.create.mock.calls.length).toBe(before);
    },
  );

  it('returns typed timeout and malformed-output failures without retrying or using a wizard', async () => {
    const model = createAnthropicVaultAgentModel({ ...options, quota: { reserve: () => null } });
    sdk.create.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError({}));
    expect(await model.read('owner', prompt)).toEqual({ reply: null, why: 'timeout' });
    sdk.create.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [] });
    expect(await model.read('owner', prompt)).toEqual({ reply: null, why: 'invalid' });
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not JSON' }],
    });
    expect(await model.read('owner', prompt)).toEqual({ reply: null, why: 'invalid' });
  });
});

// Provider-stub scenarios exercise the actual wire context and the proposal validator together.
// The replies are offline fixtures, not evidence that a live model will follow every instruction.
const catalog = launchShelf().assets.filter((asset) => asset.chain === 'solana');
const tesla = catalog.find((asset) => asset.underlying === 'TSLA');
const nvidia = catalog.find((asset) => asset.underlying === 'NVDA');
const cash = catalog.find((asset) => asset.cls === 'cash');
if (!tesla || !nvidia || !cash) throw new Error('Incomplete offline conversation catalog');
const attributes = parseStockAttributes(mockStocks);
const observedAt = '2026-10-07T20:00:00.000Z';
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
      asset: nvidia.id,
      raw: '10000000',
      display: '10',
      multiplier: '1',
      targetBps: 1000,
      lastKeeperAt: null,
    },
  ],
  lossUsedBps: 0,
  observedAt,
  pending: null,
};
const conversationContext: VaultAgentContext = {
  person: 'owner-fixture',
  state,
  assets: catalog,
  currentGoals: [{ goal: 'grow', objective: 'Explore stock businesses with a cash cushion' }],
  evidence: [
    ...catalog.map((asset) => ({
      id: `catalog:${asset.id}`,
      assetId: asset.id,
      source: 'offline catalog fixture',
      method: 'listed assets',
      fetchedAt: observedAt,
      provenance: 'mock' as const,
    })),
    {
      id: `stock:${tesla.id}:0`,
      assetId: tesla.id,
      source: 'https://example.com/mock',
      method: 'offline stock attributes fixture; no source was read',
      fetchedAt: observedAt,
      provenance: 'mock',
    },
  ],
  stockAttributes: attributes,
  liquidity: catalog.map((asset) => ({ assetId: asset.id, observation: null })),
  unknowns: ['Measured exit evidence is unavailable for this sample.'],
};
const draft = (language: 'en' | 'pt' = 'en'): VaultAgentModelReply => ({
  message:
    language === 'pt'
      ? 'Podemos explorar o negócio de veículos elétricos da Tesla, mantendo caixa.'
      : 'We can explore Tesla’s electric vehicle business while retaining cash.',
  question: null,
  proposal: {
    objective:
      language === 'pt'
        ? 'Explorar veículos elétricos com uma reserva em caixa'
        : 'Explore electric vehicles with a cash cushion',
    summary:
      language === 'pt'
        ? 'A proposta inclui Tesla e caixa; as posições atuais continuam separadas.'
        : 'The preview includes Tesla and cash; current holdings remain separate.',
    allocations: [
      {
        assetId: tesla.id,
        weightBps: 4000,
        why:
          language === 'pt'
            ? 'Veículos elétricos estão entre os negócios descritos nos atributos de amostra.'
            : 'Electric vehicles appear in the supplied sample business attributes.',
        evidenceIds: [`catalog:${tesla.id}`, `stock:${tesla.id}:0`],
      },
      {
        assetId: cash.id,
        weightBps: 6000,
        why:
          language === 'pt'
            ? 'Caixa preserva flexibilidade fora da empresa escolhida.'
            : 'Cash retains flexibility outside the chosen company.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ],
    tradeoffs: [
      language === 'pt'
        ? 'Concentração em uma empresa pode ampliar perdas.'
        : 'Concentration in a company can increase losses.',
    ],
    unknowns: [
      language === 'pt' ? 'O preço futuro é desconhecido.' : 'The future price path is unknown.',
    ],
  },
});
const turn = (messages: VaultAgentRequest['messages'], language: 'en' | 'pt' = 'en') => ({
  version: 1 as const,
  language,
  messageId: 'offline-turn',
  messages,
});
function respond(reply: VaultAgentModelReply) {
  sdk.create.mockResolvedValueOnce({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(reply) }],
  });
}
function sentPrompt(): VaultAgentPrompt {
  return JSON.parse(sdk.create.mock.calls.at(-1)?.[0].messages[0].content);
}
const offlineModel = () =>
  createAnthropicVaultAgentModel({ ...options, quota: { reserve: () => null } });

describe('conversation context and grounded replies through the provider stub', () => {
  it('resolves admiration, a name correction, then explicit stock intent without losing the conversation', async () => {
    const model = offlineModel();
    const messages: VaultAgentRequest['messages'] = [{ who: 'person', text: 'i like elon' }];
    const admiration = {
      message: 'Do you mean Elon Musk?',
      question: 'Are you interested in exploring related businesses?',
      proposal: null,
    };
    respond(admiration);
    const first = await replyToVaultConversation(turn(messages), conversationContext, model);
    expect(first.kind === 'reply' && first.reply.proposal).toBeNull();
    messages.push(
      { who: 'app', text: `${admiration.message} ${admiration.question}` },
      { who: 'person', text: 'elon musk!' },
    );
    const clarified = {
      message: 'Elon Musk, understood. We can look at businesses in this chain’s catalog.',
      question: 'Would you like to explore an investment direction?',
      proposal: null,
    };
    respond(clarified);
    await replyToVaultConversation(turn(messages), conversationContext, model);
    expect(sentPrompt().latestPerson).toBe('elon musk!');
    messages.push(
      { who: 'app', text: `${clarified.message} ${clarified.question}` },
      { who: 'person', text: 'I want to invest in stocks that benefit from Elon Musk' },
    );
    const discussion = {
      message:
        'Understood: you want a stock direction. The sample catalog describes Tesla’s electric vehicles and batteries, but does not establish a Musk relationship or future benefit.',
      question: 'Would you like to explore those businesses as a theme?',
      proposal: null,
    };
    respond(discussion);
    const final = await replyToVaultConversation(turn(messages), conversationContext, model);
    expect(final.kind === 'reply' && final.reply.message).toBe(discussion.message);
    expect(sentPrompt()).toMatchObject({
      messages,
      latestPerson: messages.at(-1)?.text,
      vault: state,
      stockAttributes: attributes,
      allocationConstraints: [],
    });
    expect(sdk.create).toHaveBeenCalledTimes(3);
    expect(VAULT_AGENT_SYSTEM).toContain('resolve the name clarification');
    expect(VAULT_AGENT_SYSTEM).toContain('use that intent instead of repeating');
    expect(VAULT_AGENT_SYSTEM).toContain('does not prove an affiliation');
  });

  it.each(['en', 'pt'] as const)(
    'proposes a supported business direction in %s and retains a stock minimum after refinement',
    async (language) => {
      const model = offlineModel();
      const instruction =
        language === 'pt'
          ? 'Quero investir em veículos elétricos, com pelo menos 40% em ações.'
          : 'I want electric vehicle stocks, with at least 40% stocks.';
      const messages: VaultAgentRequest['messages'] = [{ who: 'person', text: instruction }];
      respond(draft(language));
      const first = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(first.kind).toBe('reply');
      if (first.kind !== 'reply' || !first.reply.proposal) throw new Error('Preview rejected');
      expect(first.reply.question).toBeNull();
      expect(first.reply.proposal.objective).toBe(draft(language).proposal?.objective);
      expect(first.reply.proposal.allocations[0]).toMatchObject({
        assetId: tesla.id,
        symbol: tesla.symbol,
        weightBps: 4000,
      });
      expect(first.reply.proposal.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `stock:${tesla.id}:0`, provenance: 'mock' }),
        ]),
      );
      messages.push(
        { who: 'app', text: first.reply.message },
        {
          who: 'person',
          text: language === 'pt' ? 'Mantenha uma reserva em caixa.' : 'Keep a cash cushion.',
        },
      );
      respond(draft(language));
      const refined = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(refined.kind === 'reply' && refined.reply.proposal?.allocations[0]?.weightBps).toBe(
        4000,
      );
      expect(sentPrompt()).toMatchObject({
        language,
        vault: state,
        allocationConstraints: [
          {
            assetIds: catalog
              .filter((asset) => asset.cls === 'stock' || asset.cls === 'etf')
              .map((asset) => asset.id),
            minWeightBps: 4000,
            maxWeightBps: 10000,
            personQuote: instruction,
          },
        ],
      });
      expect(sentPrompt().vault?.positions[0]?.asset).toBe(nvidia.id);
      expect(sentPrompt().vault?.positions[0]?.targetBps).toBe(1000);
      const reduced = draft(language);
      if (!reduced.proposal) throw new Error('Missing fixture proposal');
      reduced.proposal.allocations = reduced.proposal.allocations.map((allocation) => ({
        ...allocation,
        weightBps: allocation.assetId === tesla.id ? 1000 : 9000,
      }));
      respond(reduced);
      const mismatch = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(mismatch.kind).toBe('reply');
      if (mismatch.kind !== 'reply') throw new Error('Missing constraint explanation');
      expect(mismatch.reply.proposal).toBeNull();
      expect(mismatch.reply.message).toContain(instruction);
      messages.push({
        who: 'person',
        text: language === 'pt' ? 'Quero pelo menos 10% em ações.' : 'Make that at least 10%.',
      });
      respond(reduced);
      const amended = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(amended.kind === 'reply' && amended.reply.proposal?.allocations[0]?.weightBps).toBe(
        1000,
      );
      expect(sentPrompt().allocationConstraints[0]?.minWeightBps).toBe(1000);
      expect(VAULT_AGENT_SYSTEM).toContain('without requiring a choice of grow/income/protect');
      expect(VAULT_AGENT_SYSTEM).toContain('Use the requested language for all prose');
    },
  );

  it('can discuss or preview a new stock goal without inventing a balance or financial terms', async () => {
    const context: GoalAgentContext = {
      ...conversationContext,
      kind: 'new_goal',
      chain: 'solana',
      state: null,
      currentGoals: [],
      unknowns: ['The planning amount and size-dependent exit feasibility are unknown.'],
    };
    respond(draft());
    const out = await replyToVaultConversation(
      turn([{ who: 'person', text: 'I want to explore Tesla’s electric vehicle business.' }]),
      context,
      offlineModel(),
    );
    expect(out.kind).toBe('reply');
    if (out.kind !== 'reply') throw new Error('New-goal preview rejected');
    expect(out.reply.question).toBeNull();
    expect(out.reply.proposal?.unknowns).toContain(context.unknowns[0]);
    expect(sentPrompt()).toMatchObject({ kind: 'new_goal', vault: null, eligibilityGoal: null });
    expect(VAULT_AGENT_SYSTEM).toContain('Gather financial terms separately');
  });

  it('explains an unavailable theme without silently substituting a listed stock', async () => {
    respond({
      message:
        'The supplied catalog has no lunar mining instrument or verified lunar mining exposure. Tesla’s sample electric vehicle business is a different direction.',
      question: 'Would you like to discuss a business the catalog does support?',
      proposal: null,
    });
    const out = await replyToVaultConversation(
      turn([{ who: 'person', text: 'I want stocks that mine the Moon.' }]),
      conversationContext,
      offlineModel(),
    );
    expect(out.kind).toBe('reply');
    if (out.kind !== 'reply') throw new Error('Discussion rejected');
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.message).toContain('no lunar mining instrument');
    expect(VAULT_AGENT_SYSTEM).toContain('a stockAttributes row does not');
    expect(VAULT_AGENT_SYSTEM).toContain('do not replace it without explaining and asking');
  });

  it.each(['invented-source', 'wrong-asset-source', 'invented-figure', 'over-cap', 'ineligible'])(
    'rejects a provider fixture with %s while keeping the grounded proposal boundary',
    async (fault) => {
      const value = draft();
      const allocation = value.proposal?.allocations[0];
      if (!allocation || !value.proposal) throw new Error('Missing fixture allocation');
      if (fault === 'invented-source') allocation.evidenceIds = ['stock:invented:0'];
      if (fault === 'wrong-asset-source') allocation.evidenceIds = [`catalog:${cash.id}`];
      if (fault === 'invented-figure') allocation.why = 'The stock will return 12%.';
      const context = {
        ...conversationContext,
        ...(fault === 'over-cap' ? { caps: { [tesla.id]: 1000 } } : {}),
        ...(fault === 'ineligible' ? { currentGoals: [{ goal: 'protect' }] } : {}),
      };
      respond(value);
      expect(
        await replyToVaultConversation(
          turn([{ who: 'person', text: 'I want electric vehicle stocks.' }]),
          context,
          offlineModel(),
        ),
      ).toEqual({ kind: 'failure', reason: 'invalid' });
      expect(sdk.create).toHaveBeenCalledTimes(1);
    },
  );
});
