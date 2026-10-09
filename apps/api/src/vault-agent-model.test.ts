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
  vaultAgentContent,
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
  catalog: [],
  stockAttributes: null,
  evidence: [],
  analytics: null,
} as unknown as VaultAgentPrompt;
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
        messages: [{ role: 'user', content: vaultAgentContent(prompt) }],
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
          { role: 'user', content: vaultAgentContent(prompt) },
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

  it('asks for the goal and risk as the person said them, with their words, and to ask when unsaid', () => {
    const { purpose } = VAULT_AGENT_REPLY_SCHEMA.properties as unknown as {
      purpose: { required: string[] };
    };
    expect(purpose.required).toEqual(['goal', 'goalQuote', 'risk', 'riskQuote']);
    expect(VAULT_AGENT_REPLY_SCHEMA.required).toContain('purpose');
    expect(VAULT_AGENT_SYSTEM).toContain('copied exactly from one person message');
    expect(VAULT_AGENT_SYSTEM).toContain('Never infer either');
    expect(VAULT_AGENT_SYSTEM).toContain('use question to ask for what is missing');
  });

  it('asks the model for picks only: no weight in its schema, and the prompt says the server sets them', () => {
    expect(JSON.stringify(VAULT_AGENT_REPLY_SCHEMA)).not.toContain('weightBps');
    expect(VAULT_AGENT_SYSTEM).toContain('the server sets the weights');
    expect(VAULT_AGENT_SYSTEM).toContain('Never give a weight');
    expect(VAULT_AGENT_SYSTEM).not.toMatch(
      /only in weightBps|choose listed assets and allocation weights/,
    );
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
        why:
          language === 'pt'
            ? 'Veículos elétricos estão entre os negócios descritos nos atributos de amostra.'
            : 'Electric vehicles appear in the supplied sample business attributes.',
        evidenceIds: [`catalog:${tesla.id}`, `stock:${tesla.id}:0`],
      },
      {
        assetId: cash.id,
        why:
          language === 'pt'
            ? 'Caixa preserva flexibilidade fora da empresa escolhida.'
            : 'Cash retains flexibility outside the chosen company.',
        evidenceIds: [`catalog:${cash.id}`],
      },
    ],
    stated: [],
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
/** The prompt the model read: its parts as one object, the evidence of the first and the last together. */
function sentPrompt(call = sdk.create.mock.calls.at(-1)): VaultAgentPrompt {
  const parts = ((call?.[0].messages[0].content ?? []) as Array<{ text: string }>).map(({ text }) =>
    JSON.parse(text),
  );
  return Object.assign({}, ...parts, {
    evidence: parts.flatMap((part) => part.evidence ?? []),
  });
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
      // The rows without their source lists: those reach the model as evidence it may cite. They go
      // out sorted by symbol, in the cached block.
      stockAttributes: {
        ...attributes,
        stocks: attributes.stocks
          .map(({ sources: _sources, ...row }) => row)
          .sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
      },
      allocationConstraints: [],
    });
    expect(JSON.stringify(sentPrompt().stockAttributes)).not.toContain('"sources"');
    // Evidence goes out as what the model cites; its source and method stay on the server.
    expect(sentPrompt().evidence).toContainEqual({
      id: `stock:${tesla.id}:0`,
      assetId: tesla.id,
      provenance: 'mock',
    });
    expect(
      sentPrompt().evidence.filter(
        (row) => 'source' in row || 'method' in row || 'fetchedAt' in row,
      ),
    ).toEqual([]);
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
      // What the server reads in it: the number and the asset beside it.
      const said = language === 'pt' ? 'pelo menos 40% em ações' : 'at least 40% stocks';
      const messages: VaultAgentRequest['messages'] = [{ who: 'person', text: instruction }];
      // The model reports the person's minimum with their words; the server holds it to them.
      const minimum = {
        assetIds: catalog
          .filter((asset) => asset.cls === 'stock' || asset.cls === 'etf')
          .map((asset) => asset.id),
        kind: 'min' as const,
        bps: 4000,
        quote: instruction,
      };
      const drafted = () => {
        const value = draft(language);
        if (!value.proposal) throw new Error('Missing fixture proposal');
        value.proposal.stated = [minimum];
        return value;
      };
      respond(drafted());
      const first = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(first.kind).toBe('reply');
      if (first.kind !== 'reply' || !first.reply.proposal) throw new Error('Preview rejected');
      expect(first.reply.question).toBeNull();
      expect(first.reply.weightNotes).toEqual([
        { code: 'stated', assetIds: [tesla.id], quote: said },
        { code: 'equal_split', assetIds: [cash.id] },
      ]);
      expect(first.reply.proposal.objective).toBe(draft(language).proposal?.objective);
      // Two picks, equal: the stated minimum of stocks is already met.
      expect(first.reply.proposal.allocations[0]).toMatchObject({
        assetId: tesla.id,
        symbol: tesla.symbol,
        weightBps: 5000,
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
      respond(drafted());
      const refined = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(refined.kind === 'reply' && refined.reply.proposal?.allocations[0]?.weightBps).toBe(
        5000,
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
            personQuote: said,
          },
        ],
      });
      expect(sentPrompt().vault?.positions[0]?.asset).toBe(nvidia.id);
      expect(sentPrompt().vault?.positions[0]?.targetBps).toBe(1000);
      const reduced = drafted();
      if (!reduced.proposal) throw new Error('Missing fixture proposal');
      // Cash alone cannot hold the stock minimum.
      reduced.proposal.allocations = reduced.proposal.allocations.filter(
        (allocation) => allocation.assetId !== tesla.id,
      );
      // The repair call returns the same picks, so the limit is raised with the person.
      respond(reduced);
      respond(reduced);
      const mismatch = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(mismatch.kind).toBe('reply');
      if (mismatch.kind !== 'reply') throw new Error('Missing constraint explanation');
      expect(mismatch.repair).toEqual({
        failed: 'allocation_constraint',
        outcome: 'allocation_constraint',
      });
      expect(sdk.create.mock.calls.at(-1)?.[0].messages[2].content).toContain(
        `The person said “${said}”: the picks cannot meet it.`,
      );
      expect(mismatch.reply.proposal).toBeNull();
      expect(mismatch.reply.message).toContain(`“${said}”`);
      messages.push({
        who: 'person',
        text: language === 'pt' ? 'Quero pelo menos 10% em ações.' : 'Make that at least 10%.',
      });
      respond(draft(language));
      const amended = await replyToVaultConversation(
        turn(messages, language),
        conversationContext,
        model,
      );
      expect(amended.kind === 'reply' && amended.reply.proposal?.allocations[0]?.weightBps).toBe(
        5000,
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
  ])(
    'rejects a provider fixture with %s while keeping the grounded proposal boundary',
    async (fault, detail) => {
      const value = draft();
      const allocation = value.proposal?.allocations[0];
      if (!allocation || !value.proposal) throw new Error('Missing fixture allocation');
      if (fault === 'invented-source') allocation.evidenceIds = ['stock:invented:0'];
      if (fault === 'wrong-asset-source') allocation.evidenceIds = [`catalog:${cash.id}`];
      if (fault === 'invented-figure') allocation.why = 'The stock will return 12%.';
      const context = conversationContext;
      const text = 'I want electric vehicle stocks.';
      // The repair call returns the same reply: it is refused again, never shown or substituted.
      respond(value);
      respond(value);
      expect(
        await replyToVaultConversation(turn([{ who: 'person', text }]), context, offlineModel()),
      ).toMatchObject(
        // A figure the repair still states costs its sentence, here the whole reason; the rest is refused.
        detail === 'prose_figure'
          ? {
              kind: 'reply',
              repair: { failed: detail, outcome: 'prose_figure_trimmed', sentencesCut: 1 },
              reply: {
                proposal: {
                  allocations: [
                    expect.objectContaining({
                      why: 'This part of the draft was left out because it stated a figure that could not be confirmed.',
                    }),
                    expect.objectContaining({ assetId: cash.id }),
                  ],
                },
              },
            }
          : {
              kind: 'failure',
              reason: 'invalid',
              detail,
              repair: { failed: detail, outcome: detail },
            },
      );
      expect(sdk.create).toHaveBeenCalledTimes(2);
      expect(sdk.create.mock.calls[1]?.[0].messages).toEqual([
        sdk.create.mock.calls[0]?.[0].messages[0],
        { role: 'assistant', content: JSON.stringify(value) },
        { role: 'user', content: expect.stringContaining('could not accept your previous reply') },
      ]);
    },
  );

  it('leaves out a stock the provider adds on its own in a protect goal, after asking once for a reply without it', async () => {
    const value = draft();
    // The repair call returns the same reply: the stock is left out again, and the reply says so.
    respond(value);
    respond(value);
    const out = await replyToVaultConversation(
      turn([{ who: 'person', text: 'Keep my savings safe.' }]),
      { ...conversationContext, currentGoals: [{ goal: 'protect' }] },
      offlineModel(),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.proposal?.allocations.map((line) => line.assetId)).toEqual([cash.id]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [tesla.id],
    });
    expect(out.repair).toEqual({
      failed: 'allocation_ineligible',
      outcome: 'allocation_ineligible',
    });
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(sdk.create.mock.calls[1]?.[0].messages.at(-1)?.content).toContain(tesla.id);
  });

  it('passes a requested stock in a protect goal and a weight over exit capacity, each with a server warning', async () => {
    const value = draft();
    respond(value);
    const measured = {
      id: `liquidity:${tesla.id}`,
      assetId: tesla.id,
      label: 'Measured exit capacity at the current vault size',
      value: 120,
      unit: 'USD',
      source: 'offline measured fixture',
      method: 'offline-exit-fixture',
      fetchedAt: observedAt,
      provenance: 'mock' as const,
    };
    const out = await replyToVaultConversation(
      turn([{ who: 'person', text: 'I want electric vehicle stocks.' }]),
      {
        ...conversationContext,
        currentGoals: [{ goal: 'protect' }],
        evidence: [...conversationContext.evidence, measured],
        caps: { [tesla.id]: 100 },
      },
      offlineModel(),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.reply.warnings).toEqual([
      { code: 'over_exit_capacity', assetId: tesla.id, evidenceId: measured.id },
      { code: 'outside_goal_requested', assetId: tesla.id, evidenceId: `catalog:${tesla.id}` },
    ]);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sentPrompt()).toMatchObject({
      eligibilityGoal: 'protect',
      exitCapacityBps: { [tesla.id]: 100 },
      requestedOutsideGoal: expect.arrayContaining([tesla.id]),
    });
    expect(VAULT_AGENT_SYSTEM).toContain('any composition of listed assets');
    expect(VAULT_AGENT_SYSTEM).toContain('requestedOutsideGoal');
    expect(VAULT_AGENT_SYSTEM).not.toContain('catalog and guardrail caps');
  });
});

describe('the conversation prompt is ordered for prompt caching', () => {
  const usage = {
    input_tokens: 900,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5200,
    output_tokens: 310,
  };
  const reference = {
    sizeUsd: 10_000,
    basis: 'reference' as const,
    legend: { 'vol:<asset>': 'Annualised price volatility' },
    assets: [
      { assetId: tesla.id, values: { [`vol:${tesla.id}`]: 0.5 }, provenance: 'mock' as const },
    ],
    unknowns: [],
  };
  const volatility = {
    id: `vol:${tesla.id}`,
    assetId: tesla.id,
    label: 'Annualised price volatility',
    value: 0.5,
    unit: 'fraction',
    source: 'offline analytics fixture',
    method: 'fixture',
    fetchedAt: observedAt,
    provenance: 'mock' as const,
  };
  const price = (usd: number, at: string) => ({
    id: `price:${tesla.id}`,
    assetId: tesla.id,
    label: 'Reference price',
    value: usd,
    unit: 'USD',
    source: 'offline reference fixture',
    method: 'fixture',
    fetchedAt: at,
    provenance: 'mock' as const,
  });
  // The same data with every object's keys inserted the other way round.
  const rekeyed = <T>(value: T): T =>
    (Array.isArray(value)
      ? value.map(rekeyed)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, inner]) => [key, rekeyed(inner)]),
          )
        : value) as T;
  const send = async (
    context: VaultAgentContext | GoalAgentContext,
    text: string,
    language: 'en' | 'pt' = 'en',
  ) => {
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"message":"Hi.","question":null,"proposal":null}' }],
      usage,
    });
    const out = await replyToVaultConversation(
      turn([{ who: 'person', text }], language),
      context,
      offlineModel(),
    );
    expect(out.kind, JSON.stringify(out)).toBe('reply');
    return sdk.create.mock.calls.at(-1)?.[0];
  };
  const breakpoints = (body: { messages: Array<{ content: unknown }> }) =>
    ((body.messages[0]?.content ?? []) as Array<{ text: string; cache_control?: unknown }>).map(
      (block) => block.cache_control ?? null,
    );

  it('ends the shared part in a breakpoint and leaves what is the person\u2019s after it', async () => {
    const body = await send(
      {
        ...conversationContext,
        evidence: [...conversationContext.evidence, price(250, observedAt)],
      },
      'I want electric vehicle stocks.',
    );
    expect(body.system).toBe(VAULT_AGENT_SYSTEM);
    expect(breakpoints(body)).toEqual([{ type: 'ephemeral' }, null]);
    const [shared, own] = (body.messages[0].content as Array<{ text: string }>).map(({ text }) =>
      JSON.parse(text),
    );
    expect(Object.keys(shared)).toEqual([
      'catalog',
      'chain',
      'evidence',
      'exitCostTolerance',
      'stockAttributes',
      'version',
    ]);
    expect(shared.catalog.map((asset: { id: string }) => asset.id)).toEqual(
      catalog.map((asset) => asset.id).sort(),
    );
    // The listing's evidence is shared; a price is read on every call and is not.
    expect(shared.evidence.map((source: { id: string }) => source.id)).toEqual(
      conversationContext.evidence.map((source) => source.id).sort(),
    );
    expect(own.evidence).toEqual([expect.objectContaining({ id: `price:${tesla.id}` })]);
    for (const key of ['messages', 'latestPerson', 'language', 'vault', 'currentGoals', 'kind'])
      expect(own, key).toHaveProperty(key);
    for (const key of ['eligibilityGoal', 'outsideGoal', 'requestedOutsideGoal', 'liquidity'])
      expect(own, key).toHaveProperty(key);
    for (const key of Object.keys(own).filter((key) => key !== 'evidence'))
      expect(shared, key).not.toHaveProperty(key);
    // Nothing of the moment in the shared part: no time, no address, no person.
    const text = body.messages[0].content[0].text as string;
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain(state.address);
    expect(text).not.toContain(conversationContext.person);
  });

  it('sends two people the same bytes up to the breakpoint, whatever order their data came in', async () => {
    const first = await send(
      {
        ...conversationContext,
        evidence: [...conversationContext.evidence, price(250, observedAt)],
      },
      'I want electric vehicle stocks.',
    );
    const other: VaultAgentContext = {
      ...conversationContext,
      person: 'another-owner',
      state: {
        ...state,
        address: state.owner,
        observedAt: '2026-10-08T09:30:00.000Z',
        cash: { ...state.cash, raw: '77000000', display: '77' },
      },
      currentGoals: [{ goal: 'protect', risk: 'low' }],
      // The listing and its evidence arrive in another order too.
      assets: rekeyed([...conversationContext.assets].reverse()),
      stockAttributes: rekeyed(conversationContext.stockAttributes),
      evidence: [
        price(311, '2026-10-08T09:30:00.000Z'),
        ...rekeyed([...conversationContext.evidence].reverse()),
      ],
      unknowns: ['Something only this vault lacks.'],
    };
    const second = await send(other, 'Quero proteger minhas economias.', 'pt');
    expect(second.system).toBe(first.system);
    expect(second.model).toBe(first.model);
    expect(second.output_config).toEqual(first.output_config);
    expect(second.messages[0].content[0]).toEqual(first.messages[0].content[0]);
    expect(second.messages[0].content[0].text).toBe(first.messages[0].content[0].text);
    expect(second.messages[0].content.at(-1).text).not.toBe(first.messages[0].content.at(-1).text);
    expect(sentPrompt().eligibilityGoal).toBe('protect');
  });

  it('gives the analytics a breakpoint of their own only at the reference size', async () => {
    const withAnalytics = (analytics: VaultAgentContext['analytics']) => ({
      ...conversationContext,
      evidence: [...conversationContext.evidence, volatility],
      analytics,
    });
    const shared = await send(withAnalytics(reference), 'I want electric vehicle stocks.');
    expect(breakpoints(shared)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }, null]);
    expect(JSON.parse(shared.messages[0].content[1].text)).toEqual({ analytics: reference });
    expect(JSON.parse(shared.messages[0].content[2].text)).not.toHaveProperty('analytics');
    // At a vault's own value the figures are that person's: after the breakpoint, with the rest.
    const sized = { ...reference, sizeUsd: 1234, basis: 'vault' as const };
    const own = await send(withAnalytics(sized), 'I want electric vehicle stocks.');
    expect(breakpoints(own)).toEqual([{ type: 'ephemeral' }, null]);
    expect(JSON.parse(own.messages[0].content[1].text).analytics).toEqual(sized);
    expect(own.messages[0].content[0].text).toBe(shared.messages[0].content[0].text);
    expect(sentPrompt().analytics).toEqual(sized);
  });

  it('keeps the first message, breakpoints and all, on the repair call', async () => {
    const model = offlineModel();
    const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage };
    await send(conversationContext, 'I want electric vehicle stocks.');
    const sent = sentPrompt();
    sdk.create.mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
    await model.read('owner', sent);
    await model.read('owner', sent, { previous: {}, problems: ['A.'], elapsedMs: 10 });
    const [first, repair] = sdk.create.mock.calls.slice(-2).map((call) => call[0]);
    expect(breakpoints(first)).toEqual([{ type: 'ephemeral' }, null]);
    expect(repair.messages).toHaveLength(3);
    expect(repair.messages[0]).toEqual(first.messages[0]);
  });

  it('reports each call\u2019s token counts, cached and not, and nothing of the person', async () => {
    const onUsage = vi.fn();
    const model = createAnthropicVaultAgentModel({
      ...options,
      quota: { reserve: () => null },
      onUsage,
    });
    const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] };
    sdk.create.mockResolvedValueOnce({ ...reply, usage }).mockResolvedValueOnce(reply);
    await model.read('a-person-id', prompt);
    await model.read('a-person-id', prompt, { previous: {}, problems: ['A.'], elapsedMs: 10 });
    expect(onUsage.mock.calls).toEqual([
      [{ model: options.model, call: 'first', ...usage }],
      [
        {
          model: options.model,
          call: 'repair',
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens: null,
        },
      ],
    ]);
    // A call that fails reports nothing.
    sdk.create.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError({}));
    await model.read('a-person-id', prompt);
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it('returns the answer when the usage logger throws', async () => {
    const model = createAnthropicVaultAgentModel({
      ...options,
      quota: { reserve: () => null },
      onUsage: () => {
        throw new Error('logger down');
      },
    });
    sdk.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"message":"ok"}' }],
      usage,
    });
    expect(await model.read('a-person-id', prompt)).toEqual({ reply: { message: 'ok' } });
  });

  it('sorts the stock attributes in the cached block, whatever order they were loaded in', () => {
    const stocks = ['TSLAx', 'AAPLx', 'NVDAx'].map((symbol) => ({ symbol, company: symbol }));
    const withStocks = (rows: typeof stocks) =>
      vaultAgentContent({ ...prompt, stockAttributes: { stocks: rows } as never })[0]?.text ?? '';
    expect(withStocks(stocks)).toBe(withStocks([...stocks].reverse()));
    expect(
      JSON.parse(withStocks(stocks)).stockAttributes.stocks.map(
        (row: { symbol: string }) => row.symbol,
      ),
    ).toEqual(['AAPLx', 'NVDAx', 'TSLAx']);
  });
});
