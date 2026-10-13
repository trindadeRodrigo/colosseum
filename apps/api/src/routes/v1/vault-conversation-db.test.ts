import { randomUUID } from 'node:crypto';
import { mockAddress } from '@colosseum/chain-mock';
import type { VaultConversationWrite, VaultState } from '@colosseum/schemas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConversationConflict, conversationStore } from '../../orders/vault-conversation';
import type { ConversationIdentity } from '../../orders/vault-conversation-owner';
import { person, testApp, testDb, testIssuer } from '../../testing/harness';

// Real Postgres tests: the CI service applies generated0019 before running these.
// Every row belongs to a fresh test person; cleanup deletes exactly those people.
let data: Awaited<ReturnType<typeof testDb>>;
let issuer: Awaited<ReturnType<typeof testIssuer>>;
const close: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  issuer = await testIssuer('vault-conversation-db');
  data = await testDb();
});
afterAll(async () => {
  for (const work of close.reverse()) await work();
  await data?.cleanUp();
});
const write = (text: string, expectedRevision = 0): VaultConversationWrite => ({
  version: 1,
  expectedNetwork: 'testnet',
  expectedRevision,
  transcript: [
    { id: randomUUID(), who: 'person', text },
    {
      id: randomUUID(),
      who: 'app',
      text: 'A private display reply, not an executable instruction.',
    },
  ],
  checkpoint: null,
});
const identity = async (): Promise<ConversationIdentity> => {
  const who = data.track(await person(issuer, 'passkey'));
  return {
    privyId: who.sub,
    chain: 'solana',
    address: mockAddress('solana', randomUUID()),
    provenance: 'mock',
    network: 'testnet',
  };
};
describe('durable owner-scoped vault history on Postgres', () => {
  it('roundtrips model display messages without creating a plan, order or confirmation', async () => {
    const a = await identity();
    const store = conversationStore(data.db);
    const body = write('Discuss technology and gold for my private savings');
    expect(await store.read(a)).toMatchObject({ revision: 0, transcript: [], checkpoint: null });
    const saved = await store.write(a, body, new Date('2026-10-08T12:00:00Z'));
    expect(saved).toMatchObject({ revision: 1, transcript: body.transcript, checkpoint: null });
    expect(await conversationStore(data.db).read(a)).toEqual(saved);
    const stale = await store.write(a, write('stale words'), new Date()).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConversationConflict);
    expect(stale).toMatchObject({ revision: 1 });
    expect(await store.read(a)).toEqual(saved);
  });

  it.each([0, 1])(
    'allows exactly one winner among concurrent writes at revision %s',
    async (revision) => {
      const a = await identity();
      const store = conversationStore(data.db);
      if (revision) await store.write(a, write('initial'), new Date());
      const bodies = [write('first writer', revision), write('second writer', revision)];
      const results = await Promise.allSettled(
        bodies.map((body) => store.write(a, body, new Date())),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(ConversationConflict);
      const saved = await store.read(a);
      expect(saved.revision).toBe(revision + 1);
      expect(bodies.map((b) => b.transcript)).toContainEqual(saved.transcript);
    },
  );

  it('separates account, address, chain, provenance and network even for the same vault words', async () => {
    const a = await identity();
    const other = await identity();
    const store = conversationStore(data.db);
    const body = write('Only this account and vault may read my words');
    await store.write(a, body, new Date());
    const variants: ConversationIdentity[] = [
      { ...a, privyId: other.privyId },
      { ...a, address: other.address },
      { ...a, chain: 'robinhood' },
      { ...a, provenance: 'sandbox' },
      { ...a, network: 'local' },
    ];
    for (const variant of variants) {
      expect(await store.read(variant)).toMatchObject({ revision: 0, transcript: [] });
      await store.write(variant, write('Separate context'), new Date());
    }
    expect((await store.read(a)).transcript).toEqual(body.transcript);
  });

  it('proves ownership on every HTTP read/write and never transfers old account history', async () => {
    const who = data.track(await person(issuer, 'passkey'));
    const other = data.track(await person(issuer, 'passkey'));
    const { app, registry } = await testApp({ issuer: issuer.issuer, db: data.db });
    close.push(() => app.close());
    const address = mockAddress('solana', randomUUID());
    let owner = who.solana;
    const reader = vi
      .spyOn(registry.get('solana').adapter, 'getVault')
      .mockImplementation(async (addr) =>
        addr === address ? ({ chain: 'solana', address, owner } as VaultState) : null,
      );
    const url = `/v1/vaults/solana/${address}/conversation`;
    const body = write('Private model conversation for this owner');
    expect(
      (await app.inject({ method: 'PUT', url, headers: who.headers, payload: body })).statusCode,
    ).toBe(200);
    const reopened = await app.inject({ url, headers: who.headers });
    expect(reopened.json()).toMatchObject({
      revision: 1,
      transcript: body.transcript,
      checkpoint: null,
      network: 'testnet',
    });
    expect(reopened.headers['cache-control']).toBe('private, no-store');
    owner = other.solana;
    expect((await app.inject({ url, headers: who.headers })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers: who.headers,
          payload: write('forbidden', 1),
        })
      ).statusCode,
    ).toBe(404);
    const fresh = await app.inject({ url, headers: other.headers });
    expect(fresh.json()).toMatchObject({ revision: 0, transcript: [] });
    expect(reader).toHaveBeenCalledTimes(5);
  });
});
