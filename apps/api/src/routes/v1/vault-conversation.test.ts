import { mockAddress } from '@colosseum/chain-mock';
import type { Db } from '@colosseum/db';
import {
  parseChainConfigs,
  parseFlags,
  type VaultConversationWrite,
  type VaultState,
} from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import {
  ConversationConflict,
  type ConversationData,
  type ConversationStore,
  emptyConversation,
} from '../../orders/vault-conversation';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import { registerVaultConversationRoutes } from './vault-conversation';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(enabled = true) {
  const issuer = await testIssuer('vault-conversation');
  const a = await person(issuer, 'passkey');
  const b = await person(issuer, 'passkey');
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), {
    seed: 'conversation',
  });
  const address = mockAddress('solana', 'vault-private');
  const evm = mockAddress('robinhood', 'vault-private');
  let owner = a.solana;
  const read = vi
    .spyOn(chains.get('solana').adapter, 'getVault')
    .mockImplementation(async (addr) =>
      addr === address ? ({ chain: 'solana', address, owner } as VaultState) : null,
    );
  vi.spyOn(chains.get('robinhood').adapter, 'getVault').mockImplementation(async (addr) =>
    addr.toLowerCase() === evm
      ? ({
          chain: 'robinhood',
          address: `0x${evm.slice(2).toUpperCase()}`,
          owner: `0x${a.evm.slice(2).toUpperCase()}`,
        } as VaultState)
      : null,
  );
  const rows = new Map<string, ConversationData>();
  const key = (v: Parameters<ConversationStore['read']>[0]) =>
    JSON.stringify([v.privyId, v.chain, v.address, v.provenance, v.network]);
  const store: ConversationStore = {
    read: vi.fn(async (identity) => rows.get(key(identity)) ?? emptyConversation()),
    write: vi.fn(async (identity, body, now) => {
      const k = key(identity);
      const prior = rows.get(k) ?? emptyConversation();
      if (prior.revision !== body.expectedRevision) throw new ConversationConflict(prior.revision);
      const saved = {
        revision: prior.revision + 1,
        transcript: body.transcript,
        checkpoint: body.checkpoint,
        updatedAt: now.toISOString(),
      };
      rows.set(k, saved);
      return saved;
    }),
  };
  const app = Fastify();
  cleanup.push(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app, issuer.issuer);
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof Refusal) return reply.code(e.status).send(e.body());
    return reply.code(400).send({ error: 'invalid request' });
  });
  registerVaultConversationRoutes(
    app,
    { db: {} as Db, chains, now: () => new Date('2026-10-07T12:00:00Z') },
    store,
    { enabled },
  );
  const path = `/v1/vaults/solana/${address}/conversation`;
  const write = (payload: object, who = a, url = path) =>
    app.inject({ method: 'PUT', url, headers: who.headers, payload });
  const get = (who = a, url = path) => app.inject({ method: 'GET', url, headers: who.headers });
  const body: VaultConversationWrite = {
    version: 1,
    expectedNetwork: 'testnet',
    expectedRevision: 0,
    transcript: [{ id: '1', who: 'person', text: 'private goal' }],
    checkpoint: null,
  };
  return {
    a,
    b,
    app,
    path,
    write,
    get,
    body,
    store,
    read,
    evm,
    setNetwork: (next: 'testnet' | 'local') => {
      chains.get('solana').config.network = next;
    },
    setOwner: (next: string) => {
      owner = next;
    },
  };
}
describe('owner private vault conversations', () => {
  it('resolves ownership before unavailable answers and avoids all DB reads when disabled', async () => {
    const s = await setup(false);
    expect((await s.get()).json()).toMatchObject({ code: 'CONVERSATION_STORE_UNAVAILABLE' });
    expect((await s.get(s.b)).statusCode).toBe(404);
    expect((await s.write(s.body)).statusCode).toBe(503);
    expect(s.store.read).not.toHaveBeenCalled();
    expect(s.store.write).not.toHaveBeenCalled();
  });
  it('reopens the same saved history with revision and private headers', async () => {
    const s = await setup();
    expect((await s.get()).json()).toMatchObject({ revision: 0, transcript: [], checkpoint: null });
    const saved = await s.write(s.body);
    expect(saved.statusCode).toBe(200);
    const read = await s.get();
    expect(read.json()).toMatchObject({
      revision: 1,
      transcript: s.body.transcript,
      network: 'testnet',
    });
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(s.read).toHaveBeenCalledTimes(3);
  });
  it('answers equal private 404s for nonowner, unknown and invalid addresses without reading storage', async () => {
    const s = await setup();
    const other = await s.get(s.b);
    const unknown = await s.get(
      s.a,
      s.path.replace(/\/[^/]+\/conversation$/, `/${mockAddress('solana', 'unknown')}/conversation`),
    );
    const invalid = await s.get(s.a, '/v1/vaults/solana/invalid/conversation');
    expect([other.statusCode, unknown.statusCode, invalid.statusCode]).toEqual([404, 404, 404]);
    expect(other.json()).toEqual(unknown.json());
    expect(other.json()).toEqual(invalid.json());
    expect(other.headers['cache-control']).toBe('private, no-store');
    expect(s.store.read).not.toHaveBeenCalled();
  });
  it('requires both matching signed identity tokens before ownership or storage', async () => {
    const s = await setup();
    const none = await s.app.inject({ url: s.path });
    const mismatch = await s.app.inject({
      url: s.path,
      headers: {
        authorization: s.a.headers.authorization ?? '',
        'privy-id-token': s.b.headers['privy-id-token'] ?? '',
      },
    });
    expect([none.statusCode, mismatch.statusCode]).toEqual([401, 401]);
    expect(s.read).not.toHaveBeenCalled();
    expect(s.store.read).not.toHaveBeenCalled();
  });
  it('rejects stale writes and allows one winner among competing initial writes', async () => {
    const s = await setup();
    const results = await Promise.all([
      s.write(s.body),
      s.write({ ...s.body, transcript: [{ id: '2', who: 'person', text: 'other goal' }] }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      details: { reason: 'REVISION_CONFLICT', revision: 1 },
    });
    expect((await s.get()).json().revision).toBe(1);
  });
  it('never gives a transferred vault owner the previous person private history', async () => {
    const s = await setup();
    await s.write(s.body);
    s.setOwner(s.b.solana);
    expect((await s.get()).statusCode).toBe(404);
    expect((await s.get(s.b)).json()).toMatchObject({ revision: 0, transcript: [] });
  });
  it('normalizes EVM address casing and keeps chain history separate', async () => {
    const s = await setup();
    await s.write(s.body);
    const lower = `/v1/vaults/robinhood/${s.evm}/conversation`;
    const upper = lower.replace(s.evm, `0x${s.evm.slice(2).toUpperCase()}`);
    expect((await s.get(s.a, lower)).json().revision).toBe(0);
    await s.write(s.body, s.a, upper);
    expect((await s.get(s.a, lower)).json()).toMatchObject({ address: s.evm, revision: 1 });
  });
  it('refuses a delayed old-network write before storage and accepts the freshly read network', async () => {
    const s = await setup();
    expect((await s.get()).json()).toMatchObject({ network: 'testnet', revision: 0 });
    s.setNetwork('local');
    const delayed = await s.write(s.body);
    expect(delayed.statusCode).toBe(409);
    expect(delayed.json()).toMatchObject({ details: { reason: 'NETWORK_CONFLICT' } });
    expect(delayed.headers['cache-control']).toBe('private, no-store');
    expect(s.store.write).not.toHaveBeenCalled();
    expect((await s.write(s.body, s.b)).statusCode).toBe(404);
    const fresh = await s.get();
    expect(fresh.json()).toMatchObject({ network: 'local', revision: 0, transcript: [] });
    const saved = await s.write({ ...s.body, expectedNetwork: 'local' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ network: 'local', revision: 1 });
    expect(s.read).toHaveBeenCalledTimes(5);
  });
  it('rejects invalid content before writes and never returns driver error text', async () => {
    const s = await setup();
    expect((await s.write({ ...s.body, confirmed: true })).statusCode).toBe(400);
    expect((await s.write({ ...s.body, network: 'local' })).statusCode).toBe(400);
    const { expectedNetwork: _expectedNetwork, ...unscoped } = s.body;
    expect((await s.write(unscoped)).statusCode).toBe(400);
    expect(s.store.write).not.toHaveBeenCalled();
    vi.mocked(s.store.write).mockRejectedValueOnce(new Error('private goal and SQL body'));
    const failed = await s.write(s.body);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('private goal');
    expect(failed.body).not.toContain('SQL');
    expect(failed.json()).toMatchObject({ code: 'CONVERSATION_STORE_UNAVAILABLE' });
    vi.mocked(s.store.read).mockRejectedValueOnce(new Error('42P01 SQL private goal'));
    const unavailable = await s.get();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: 'CONVERSATION_STORE_UNAVAILABLE' });
    expect(unavailable.body).not.toContain('SQL');
  });
});
