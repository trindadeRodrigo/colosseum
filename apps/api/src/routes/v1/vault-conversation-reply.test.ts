import { mockAddress } from '@colosseum/chain-mock';
import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags, type VaultState } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import type { VaultAgentModel } from '../../vault-agent-model';
import { registerVaultConversationReplyRoute } from './vault-conversation-reply';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(available = true, analytics?: AgentAnalytics) {
  const issuer = await testIssuer('vault-reply');
  const a = await person(issuer, 'passkey');
  const b = await person(issuer, 'passkey');
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), {
    seed: 'vault-reply',
  });
  const address = mockAddress('solana', 'vault-reply');
  const evm = mockAddress('robinhood', 'vault-reply');
  let owner = a.solana;
  const listed = await chains.get('solana').adapter.listAssets();
  const cash = listed.find((asset) => asset.cls === 'cash');
  if (!cash) throw new Error('cash fixture missing');
  const state: VaultState = {
    chain: 'solana',
    address,
    owner,
    basketId: '1',
    keeper: a.solana,
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    cash: { asset: cash.id, raw: '0', display: '0', multiplier: '1' },
    positions: [],
    lossUsedBps: 0,
    observedAt: '2026-10-07T20:00:00.000Z',
    pending: null,
  };
  const read = vi
    .spyOn(chains.get('solana').adapter, 'getVault')
    .mockImplementation(async (addr) => (addr === address ? { ...state, owner } : null));
  vi.spyOn(chains.get('robinhood').adapter, 'getVault').mockImplementation(async (addr) =>
    addr.toLowerCase() === evm
      ? {
          ...state,
          chain: 'robinhood',
          address: `0x${evm.slice(2).toUpperCase()}`,
          owner: `0x${a.evm.slice(2).toUpperCase()}`,
        }
      : null,
  );
  const assets = vi.spyOn(chains.get('solana').adapter, 'listAssets');
  const inputs = vi.fn(async () => ({}));
  const model: VaultAgentModel = {
    read: vi.fn(async () => ({
      reply: {
        message: 'Which direction would you like to explore?',
        question: 'What would you like to change?',
        proposal: null,
      },
    })),
  };
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('Private DB access forbidden');
      },
    },
  ) as Db;
  const app = Fastify();
  cleanup.push(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app, issuer.issuer);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof Refusal
      ? reply.code(error.status).send(error.body())
      : reply.code(400).send({ error: 'invalid request' }),
  );
  registerVaultConversationReplyRoute(
    app,
    { db, chains, now: () => new Date(state.observedAt) },
    available ? model : null,
    inputs,
    analytics,
  );
  const body = {
    version: 1,
    language: 'en',
    messageId: 'latest',
    messages: [
      { who: 'app', text: 'Earlier conversation' },
      { who: 'person', text: 'I would like to discuss this vault' },
    ],
  };
  const path = `/v1/vaults/solana/${address}/conversation/reply`;
  const post = (who = a, url = path, payload: object = body) =>
    app.inject({ method: 'POST', url, headers: who.headers, payload });
  return {
    a,
    b,
    app,
    address,
    evm,
    state,
    chains,
    body,
    path,
    post,
    model,
    read,
    assets,
    inputs,
    setOwner: (value: string) => {
      owner = value;
    },
  };
}
describe('private model-led vault reply route', () => {
  it('requires matching sign-in tokens before reading any vault or calling the model', async () => {
    const s = await setup();
    const none = await s.app.inject({ method: 'POST', url: s.path, payload: s.body });
    const mismatch = await s.app.inject({
      method: 'POST',
      url: s.path,
      payload: s.body,
      headers: {
        authorization: s.a.headers.authorization ?? '',
        'privy-id-token': s.b.headers['privy-id-token'] ?? '',
      },
    });
    expect([none.statusCode, mismatch.statusCode]).toEqual([401, 401]);
    expect(none.headers['cache-control']).toBe('private, no-store');
    expect(s.read).not.toHaveBeenCalled();
    expect(s.model.read).not.toHaveBeenCalled();
  });
  it('gives equal private 404s for nonowner, missing and malformed addresses without reading context', async () => {
    const s = await setup();
    const results = await Promise.all([
      s.post(s.b),
      s.post(s.a, s.path.replace(s.address, mockAddress('solana', 'missing'))),
      s.post(s.a, s.path.replace(s.address, 'bad')),
    ]);
    expect(results.map((res) => res.statusCode)).toEqual([404, 404, 404]);
    expect(results.map((res) => res.json())).toEqual([
      results[0]?.json(),
      results[0]?.json(),
      results[0]?.json(),
    ]);
    expect(results.every((res) => res.headers['cache-control'] === 'private, no-store')).toBe(true);
    expect(s.assets).not.toHaveBeenCalled();
    expect(s.model.read).not.toHaveBeenCalled();
  });
  it('sends exact history, real vault and sourced context while performing zero DB operations', async () => {
    const s = await setup();
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      version: 1,
      messageId: 'latest',
      chain: 'solana',
      address: s.address,
      proposal: null,
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(s.model.read).toHaveBeenCalledWith(
      s.a.sub,
      expect.objectContaining({ messages: s.body.messages, vault: s.state, currentGoals: [] }),
    );
    expect(s.inputs).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'solana', provenance: 'mock' }),
    );
  });
  it("reads Bearing's analytics at the vault's value, and at the reference size when it has none", async () => {
    const analytics = vi.fn<AgentAnalytics>(async ({ sizeUsd }) => ({
      sizeUsd: sizeUsd ?? 10_000,
      basis: sizeUsd === null ? 'reference' : 'vault',
      tau: 0.01,
      assets: [],
    }));
    const s = await setup(true, analytics);
    const empty = await s.post();
    expect(empty.statusCode, empty.body).toBe(200);
    // An empty vault is worth nothing: the costs refer to the reference size.
    expect(analytics).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: 'solana', provenance: 'mock', sizeUsd: 0 }),
    );
    s.state.cash = { ...s.state.cash, raw: '2500000000', display: '2500' };
    expect((await s.post()).statusCode).toBe(200);
    const [cashPrice] = await s.chains.get('solana').adapter.getPrices([s.state.cash.asset]);
    const sized = analytics.mock.calls.at(-1)?.[0].sizeUsd;
    expect(sized).toBe(2500 * Number(cashPrice?.usdPerToken));
    expect(sized).toBeGreaterThan(0);
    expect(vi.mocked(s.model.read).mock.calls.at(-1)?.[1].analytics).toMatchObject({
      sizeUsd: sized,
      basis: 'vault',
      assets: [],
      unknowns: [],
    });
    const failing = await setup(true, async () => {
      throw new Error('the pool is exhausted');
    });
    expect((await failing.post()).statusCode).toBe(200);
  });
  it('checks fresh ownership after a transfer and normalizes EVM casing', async () => {
    const s = await setup();
    s.setOwner(s.b.solana);
    expect((await s.post()).statusCode).toBe(404);
    expect((await s.post(s.b)).statusCode).toBe(200);
    const evm = await s.post(
      s.a,
      `/v1/vaults/robinhood/0x${s.evm.slice(2).toUpperCase()}/conversation/reply`,
    );
    expect(evm.statusCode, evm.body).toBe(200);
    expect(evm.json()).toMatchObject({ chain: 'robinhood', address: s.evm });
  });
  it('checks ownership before model availability and skips expensive input reads when unavailable', async () => {
    const s = await setup(false);
    expect((await s.post(s.b)).statusCode).toBe(404);
    expect((await s.post()).json()).toMatchObject({
      reason: 'unavailable',
      code: 'VAULT_AGENT_UNAVAILABLE',
    });
    expect(s.assets).not.toHaveBeenCalled();
    expect(s.inputs).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'budget', 'invalid'] as const)(
    'returns sanitized %s failures without changed-vault claims',
    async (why) => {
      const s = await setup();
      vi.mocked(s.model.read).mockResolvedValueOnce({ reply: null, why });
      const res = await s.post();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ reason: why });
      vi.mocked(s.model.read).mockRejectedValueOnce(new Error('private SQL and request words'));
      const failed = await s.post();
      expect(failed.body).not.toContain('private SQL');
    },
  );
  it('serves the corrected reply when the first one fails a check, and never the first', async () => {
    const s = await setup();
    vi.mocked(s.model.read).mockResolvedValueOnce({
      reply: { message: 'I rebalanced your portfolio.', question: null, proposal: null },
    });
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().message).toBe('Which direction would you like to explore?');
    expect(res.body).not.toContain('rebalanced');
    expect(s.model.read).toHaveBeenCalledTimes(2);
  });
  it('serves a reply whose repair attempt still states a figure without that sentence', async () => {
    const s = await setup();
    const figure = {
      message: 'Which direction would you like to explore? It will return 12% a year.',
      question: null,
      proposal: null,
    };
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    const res = await s.post();
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe(
      'Which direction would you like to explore?\nPart of this reply was left out because it stated a figure that could not be confirmed.',
    );
    expect(res.body).not.toContain('12%');
    expect(s.model.read).toHaveBeenCalledTimes(2);
  });
  it('rejects wrong-chain state and malformed histories before model invocation', async () => {
    const s = await setup();
    s.read.mockResolvedValueOnce({ ...s.state, chain: 'robinhood' });
    expect((await s.post()).statusCode).toBe(404);
    expect(
      (
        await s.post(s.a, s.path, {
          ...s.body,
          messages: [{ who: 'app', text: 'not a person instruction' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(s.model.read).not.toHaveBeenCalled();
  });
});
