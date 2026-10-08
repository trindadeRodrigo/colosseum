import { mockAddress } from '@colosseum/chain-mock';
import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags, type VaultState } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { person, testIssuer } from '../../testing/harness';
import type { VaultAgentModel } from '../../vault-agent-model';
import { registerV1Routes } from '.';

// The whole /v1 table, as the server builds it: the reader handed to it reaches both conversations, and
// the routes registered beside them are there.
// A database with no rows: any query, however it is built, answers none. The vault conversation reads
// the vault's stored plan through it and finds no plan.
const noRows = (): unknown =>
  new Proxy(() => noRows(), {
    get: (_target, key) =>
      key === 'then' ? (resolve: (rows: unknown[]) => unknown) => resolve([]) : () => noRows(),
  });
const emptyDb = new Proxy({}, { get: () => () => noRows() }) as unknown as Db;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

describe("the conversations' analytics through the /v1 table", () => {
  it('hands the reader to the new-goal and the vault conversation, beside the mix routes', async () => {
    const issuer = await testIssuer('analytics-wiring');
    const owner = await person(issuer, 'passkey');
    const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), {
      seed: 'analytics-wiring',
    });
    const listed = await chains.get('solana').adapter.listAssets();
    const cash = listed.find((asset) => asset.cls === 'cash');
    if (!cash) throw new Error('cash fixture missing');
    const address = mockAddress('solana', 'analytics-wiring');
    const state: VaultState = {
      chain: 'solana',
      address,
      owner: owner.solana,
      basketId: '1',
      keeper: owner.solana,
      recipeOnchainId: null,
      acceptedVersion: 0,
      autoFollow: false,
      cash: { asset: cash.id, raw: '250000000', display: '250', multiplier: '1' },
      positions: [],
      lossUsedBps: 0,
      observedAt: '2026-10-07T20:00:00.000Z',
      pending: null,
    };
    vi.spyOn(chains.get('solana').adapter, 'getVault').mockImplementation(async (at) =>
      at === address ? state : null,
    );
    const analytics = vi.fn<AgentAnalytics>(async ({ sizeUsd }) => ({
      sizeUsd: sizeUsd ?? 10_000,
      basis: sizeUsd === null ? 'reference' : 'vault',
      tau: 0.01,
      assets: [],
    }));
    const model: VaultAgentModel = {
      read: vi.fn(async () => ({
        reply: { message: 'Tell me more.', question: 'What matters most?', proposal: null },
      })),
    };
    const app = Fastify();
    cleanup.push(() => app.close());
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await registerV1Routes(
      app,
      {},
      {
        auth: issuer.issuer,
        db: emptyDb,
        chains,
        testFunds: [],
        agentAnalytics: analytics,
        vaultAgentModel: model,
        now: () => new Date('2026-10-08T01:00:00.000Z'),
      },
    );
    await app.ready();
    const body = {
      version: 1,
      language: 'en',
      messageId: 'latest',
      messages: [{ who: 'person', text: 'I would like something steady.' }],
    };
    const post = (url: string) =>
      app.inject({ method: 'POST', url, headers: owner.headers, payload: body });

    const goal = await post('/v1/conversations/solana/goal/reply');
    expect(goal.statusCode, goal.body).toBe(200);
    expect(analytics).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: 'solana', sizeUsd: null }),
    );
    const vault = await post(`/v1/vaults/solana/${address}/conversation/reply`);
    expect(vault.statusCode, vault.body).toBe(200);
    expect(analytics).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: 'solana', sizeUsd: 250 }),
    );
    expect(analytics).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(model.read).mock.calls)
      expect(call[1].analytics).toMatchObject({ assets: [], unknowns: [] });

    // What staging registered beside them is still in the table.
    for (const [method, url] of [
      ['POST', '/v1/conversations/:chain/goal/accept'],
      ['POST', '/v1/vaults/:chain/:address/targets'],
      ['GET', '/v1/vaults/:chain/:address/conversation'],
      ['GET', '/v1/baskets/:id/thread'],
    ] as const)
      expect([url, app.hasRoute({ method, url })]).toEqual([url, true]);
  });
});
