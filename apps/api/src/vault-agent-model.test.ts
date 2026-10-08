import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { VaultAgentPrompt } from './orders/vault-agent';
import { createAnthropicVaultAgentModel, VAULT_AGENT_REPLY_SCHEMA } from './vault-agent-model';

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
