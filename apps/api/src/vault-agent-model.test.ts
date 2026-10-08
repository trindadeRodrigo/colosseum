import Anthropic from '@anthropic-ai/sdk';
import type { VaultAgentModelReply, VaultAgentRequest, VaultState } from '@colosseum/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStockAttributes } from '../../../packages/engine/src/personal/stock-attributes';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import { INTAKE_TIMEOUT_MS, intakeSettings } from './llm';
import {
  type GoalAgentContext,
  replyToVaultConversation,
  type VaultAgentContext,
  type VaultAgentPrompt,
} from './orders/vault-agent';
import mockStocks from './testing/fixtures/mock-stocks.json';
import {
  acceptsEffort,
  acceptsTemperature,
  createAnthropicVaultAgentModel,
  repairRequest,
  VAULT_AGENT_EFFORT,
  VAULT_AGENT_MAX_TOKENS,
  VAULT_AGENT_REPAIR_MARGIN_MS,
  VAULT_AGENT_REPAIR_MIN_MS,
  VAULT_AGENT_REPLY_SCHEMA,
  VAULT_AGENT_SYSTEM,
  VAULT_AGENT_TIMEOUT_MS,
  vaultAgentEffort,
  vaultAgentModelId,
  vaultAgentTimeoutMs,
} from './vault-agent-model';

const sdk = vi.hoisted(() => ({ create: vi.fn(), options: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class Timeout extends Error {}
  class APIError extends Error {
    constructor(readonly status: number) {
      super('provider error text that may echo the request');
    }
  }
  return {
    default: class {
      static APIConnectionTimeoutError = Timeout;
      static APIError = APIError;
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
        max_tokens: VAULT_AGENT_MAX_TOKENS,
        messages: [{ role: 'user', content: JSON.stringify(prompt) }],
        output_config: { format: { type: 'json_schema', schema: VAULT_AGENT_REPLY_SCHEMA } },
      }),
      { timeout: 6000 },
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
      expect(await model.read('owner', prompt)).toEqual({
        reply: null,
        why: 'budget',
        detail: reason,
      });
      expect(sdk.create.mock.calls.length).toBe(before);
    },
  );

  it('returns typed timeout and malformed-output failures without retrying or using a wizard', async () => {
    const model = createAnthropicVaultAgentModel({ ...options, quota: { reserve: () => null } });
    sdk.create.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError({}));
    expect(await model.read('owner', prompt)).toEqual({
      reply: null,
      why: 'timeout',
      detail: 'model_timeout',
    });
    sdk.create.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [] });
    expect(await model.read('owner', prompt)).toEqual({
      reply: null,
      why: 'invalid',
      detail: 'model_cut_off',
    });
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not JSON' }],
    });
    expect(await model.read('owner', prompt)).toEqual({
      reply: null,
      why: 'invalid',
      detail: 'model_not_json',
    });
    // A 400 (a parameter the model rejects) is named by its status, never by its message.
    sdk.create.mockRejectedValueOnce(
      new (Anthropic.APIError as unknown as new (s: number) => Error)(400),
    );
    expect(await model.read('owner', prompt)).toEqual({
      reply: null,
      why: 'unavailable',
      detail: 'model_error_400',
    });
  });

  it('repairs in one more reserved call that sees its reply and the problem, inside the overall time', async () => {
    const reserve = vi.fn(() => null);
    const model = createAnthropicVaultAgentModel({ ...options, quota: { reserve } });
    const previous = { message: 'I changed your vault.', question: null, proposal: null };
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"message":"Hi.","question":null,"proposal":null}' }],
    });
    expect(
      await model.read('owner', prompt, {
        previous,
        problems: ['Prose said something was applied.'],
        elapsedMs: 4000,
      }),
    ).toEqual({ reply: { message: 'Hi.', question: null, proposal: null } });
    expect(reserve).toHaveBeenCalledExactlyOnceWith('owner');
    expect(sdk.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: JSON.stringify(prompt) },
          { role: 'assistant', content: JSON.stringify(previous) },
          { role: 'user', content: repairRequest(['Prose said something was applied.']) },
        ],
      }),
      // 6,000 configured + the margin − 4,000 already spent.
      { timeout: 6000 + VAULT_AGENT_REPAIR_MARGIN_MS - 4000 },
    );
    expect(repairRequest(['A.', 'B.'])).toContain('\n- A.\n- B.\n');
    const calls = sdk.create.mock.calls.length;
    // Too little time left: no reservation and no call.
    const late = 6000 + VAULT_AGENT_REPAIR_MARGIN_MS - VAULT_AGENT_REPAIR_MIN_MS + 1;
    expect(
      await model.read('owner', prompt, { previous, problems: ['x'], elapsedMs: late }),
    ).toEqual({ reply: null, why: 'timeout', detail: 'repair_no_time' });
    expect(reserve).toHaveBeenCalledOnce();
    expect(sdk.create.mock.calls.length).toBe(calls);
    // A spent budget stops the repair like the first call.
    const spent = createAnthropicVaultAgentModel({
      ...options,
      quota: { reserve: () => 'model_person_budget_spent' },
    });
    expect(await spent.read('owner', prompt, { previous, problems: ['x'], elapsedMs: 0 })).toEqual({
      reply: null,
      why: 'budget',
      detail: 'model_person_budget_spent',
    });
    expect(sdk.create.mock.calls.length).toBe(calls);
    // A short configured time still gets its first call.
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"message":"Hi.","question":null,"proposal":null}' }],
    });
    await createAnthropicVaultAgentModel({
      ...options,
      timeoutMs: 1000,
      quota: { reserve: () => null },
    }).read('owner', prompt);
    expect(sdk.create).toHaveBeenLastCalledWith(expect.anything(), { timeout: 1000 });
  });

  it('reads VAULT_AGENT_MODEL, or falls back to the intake model', () => {
    expect(vaultAgentModelId({}, 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(vaultAgentModelId({ VAULT_AGENT_MODEL: ' ' }, 'claude-haiku-4-5')).toBe(
      'claude-haiku-4-5',
    );
    expect(vaultAgentModelId({ VAULT_AGENT_MODEL: 'claude-sonnet-4-6' }, 'claude-haiku-4-5')).toBe(
      'claude-sonnet-4-6',
    );
    expect(() =>
      vaultAgentModelId({ VAULT_AGENT_MODEL: 'sk-ant private key' }, 'claude-haiku-4-5'),
    ).toThrow(/^VAULT_AGENT_MODEL must be a model id/);
    try {
      vaultAgentModelId({ VAULT_AGENT_MODEL: 'sk-ant private key' }, 'claude-haiku-4-5');
    } catch (error) {
      expect(String(error)).not.toContain('sk-ant');
    }
  });

  it('has its own call time, not the intake one, read from VAULT_AGENT_TIMEOUT_MS', () => {
    expect(VAULT_AGENT_TIMEOUT_MS).toBeGreaterThan(INTAKE_TIMEOUT_MS);
    expect(vaultAgentTimeoutMs({})).toBe(VAULT_AGENT_TIMEOUT_MS);
    // The intake's own setting does not shorten the conversation's.
    const env = { INTAKE_MODEL_TIMEOUT_MS: '6000' };
    expect(intakeSettings(env).timeoutMs).toBe(6000);
    expect(vaultAgentTimeoutMs(env)).toBe(VAULT_AGENT_TIMEOUT_MS);
    expect(vaultAgentTimeoutMs({ VAULT_AGENT_TIMEOUT_MS: '45000' })).toBe(45000);
    for (const bad of ['999', '120001', '30s', '-1'])
      expect(() => vaultAgentTimeoutMs({ VAULT_AGENT_TIMEOUT_MS: bad })).toThrow(
        'VAULT_AGENT_TIMEOUT_MS',
      );
    expect(VAULT_AGENT_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
  });

  it('leaves room for thinking in the output budget, under the non-streaming limit', () => {
    expect(VAULT_AGENT_MAX_TOKENS).toBe(16_000);
  });

  it('reads VAULT_AGENT_EFFORT: low by default, low, medium or high, and nothing else', () => {
    expect(VAULT_AGENT_EFFORT).toBe('low');
    expect(vaultAgentEffort({})).toBe('low');
    expect(vaultAgentEffort({ VAULT_AGENT_EFFORT: ' ' })).toBe('low');
    expect(vaultAgentEffort({ VAULT_AGENT_EFFORT: 'medium' })).toBe('medium');
    expect(vaultAgentEffort({ VAULT_AGENT_EFFORT: ' high ' })).toBe('high');
    for (const bad of ['max', 'xhigh', 'LOW', 'sk-ant private key']) {
      expect(() => vaultAgentEffort({ VAULT_AGENT_EFFORT: bad })).toThrow(
        /^VAULT_AGENT_EFFORT must be low, medium or high$/,
      );
      try {
        vaultAgentEffort({ VAULT_AGENT_EFFORT: bad });
      } catch (error) {
        expect(String(error)).not.toContain(bad);
      }
    }
  });

  it.each([
    ['claude-opus-5-5', true],
    ['claude-sonnet-5-5', true],
    ['claude-haiku-5-5', true],
    ['claude-fable-5-1', true],
    ['claude-opus-5', true],
    ['claude-sonnet-5', true],
    ['claude-opus-4-5@20251101', true],
    ['claude-opus-4-6', true],
    ['claude-opus-4-7', true],
    ['claude-opus-4-8', true],
    ['claude-sonnet-4-6', true],
    // Haiku 4.5 and Sonnet 4.5 answer 400 to effort; unknown and future ids fail safe.
    ['claude-haiku-4-5', false],
    ['claude-haiku-4-5-20251001', false],
    ['claude-sonnet-4-5', false],
    ['claude-opus-4-9', false],
    ['claude-opus-6', false],
    ['claude-3-7-sonnet-latest', false],
    ['configured-fixture-model', false],
  ] as const)('sends effort to %s: %s', async (model, sent) => {
    expect(acceptsEffort(model)).toBe(sent);
    for (const effort of [undefined, 'high'] as const) {
      sdk.create.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"message":"Hi.","question":null,"proposal":null}' }],
      });
      await createAnthropicVaultAgentModel({
        ...options,
        model,
        ...(effort ? { effort } : {}),
        quota: { reserve: () => null },
      }).read('owner', prompt);
      const body = sdk.create.mock.calls.at(-1)?.[0];
      const format = { type: 'json_schema', schema: VAULT_AGENT_REPLY_SCHEMA };
      expect(body.output_config).toEqual(sent ? { effort: effort ?? 'low', format } : { format });
      expect(body.max_tokens).toBe(VAULT_AGENT_MAX_TOKENS);
      expect(body).not.toHaveProperty('thinking');
    }
  });

  it.each([
    ['claude-sonnet-5-5', false],
    ['claude-opus-5-5', false],
    ['claude-fable-5-1', false],
    ['claude-sonnet-5', false],
    ['claude-opus-4-8', false],
    ['claude-haiku-5-5', false],
    ['claude-opus-4-7', false],
    ['claude-opus-4-8@20260101', false],
    // Unknown and future ids fail safe: no temperature.
    ['claude-opus-6', false],
    ['claude-haiku-4-50', false],
    ['configured-fixture-model', false],
    ['claude-haiku-4-5', true],
    ['claude-haiku-4-5-20251001', true],
    ['claude-sonnet-4-5', true],
    ['claude-sonnet-4-6', true],
    ['claude-opus-4-5@20251101', true],
    ['claude-opus-4-6', true],
    ['claude-3-7-sonnet-latest', true],
    ['claude-3-haiku-20240307', true],
  ] as const)('sends temperature to %s: %s', async (model, sent) => {
    expect(acceptsTemperature(model)).toBe(sent);
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"message":"Hi.","question":null,"proposal":null}' }],
    });
    await createAnthropicVaultAgentModel({
      ...options,
      model,
      quota: { reserve: () => null },
    }).read('owner', prompt);
    const body = sdk.create.mock.calls.at(-1)?.[0];
    if (sent) expect(body).toMatchObject({ temperature: 0 });
    else expect(body).not.toHaveProperty('temperature');
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

  it.each([
    ['invented-source', 'allocation_evidence'],
    ['wrong-asset-source', 'allocation_evidence'],
    ['invented-figure', 'prose_figure'],
    ['over-cap', 'allocation_over_cap'],
    ['ineligible', 'allocation_ineligible'],
  ])(
    'rejects a provider fixture with %s while keeping the grounded proposal boundary',
    async (fault, detail) => {
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
      // The repair call returns the same reply: it is refused again, never shown or substituted.
      respond(value);
      respond(value);
      expect(
        await replyToVaultConversation(
          turn([{ who: 'person', text: 'I want electric vehicle stocks.' }]),
          context,
          offlineModel(),
        ),
      ).toEqual({
        kind: 'failure',
        reason: 'invalid',
        detail,
        repair: { failed: detail, outcome: detail },
      });
      expect(sdk.create).toHaveBeenCalledTimes(2);
      expect(sdk.create.mock.calls[1]?.[0].messages).toEqual([
        sdk.create.mock.calls[0]?.[0].messages[0],
        { role: 'assistant', content: JSON.stringify(value) },
        { role: 'user', content: expect.stringContaining('could not accept your previous reply') },
      ]);
    },
  );
});
