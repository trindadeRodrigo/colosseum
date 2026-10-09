import type { Db } from '@colosseum/db';
import { vaultConversations } from '@colosseum/db';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ConversationStoreError, conversationStore } from './vault-conversation';

const identity = {
  privyId: 'did:privy:person',
  chain: 'solana' as const,
  address: 'vault',
  provenance: 'mock' as const,
  network: 'testnet' as const,
};
describe('vault conversation storage boundary', () => {
  it('does not retain SQL, private person words or driver causes in read/write failures', async () => {
    const failure = new DrizzleQueryError(
      'SQL private financial goal',
      ['did:privy:secret', 'private financial goal'],
      new Error('private driver details'),
    );
    const db = {
      select: () => {
        throw failure;
      },
      transaction: async () => {
        throw failure;
      },
    } as unknown as Db;
    const store = conversationStore(db);
    for (const operation of [
      () => store.read(identity),
      () =>
        store.write(
          identity,
          {
            version: 1,
            expectedNetwork: 'testnet',
            expectedRevision: 0,
            transcript: [],
            checkpoint: null,
          },
          new Date(),
        ),
    ]) {
      const result = await operation().catch((e: unknown) => e);
      expect(result).toBeInstanceOf(ConversationStoreError);
      expect(String(result)).not.toContain('financial goal');
      expect(String(result)).not.toContain('SQL');
      expect(result).not.toHaveProperty('cause');
    }
  });
  it('isolates owner, chain, normalized vault address and network label without proposal/snapshot dependencies', () => {
    const config = getTableConfig(vaultConversations);
    expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual([
      'user_id',
      'chain_id',
      'address',
      'provenance',
      'network',
    ]);
    expect(config.foreignKeys.map((fk) => fk.reference().foreignTable)).toHaveLength(2);
    expect(config.columns.map((c) => c.name)).not.toEqual(
      expect.arrayContaining(['proposal_id', 'thread_id', 'vault_snapshot_id']),
    );
    expect(config.checks.map((c) => c.name)).toEqual([
      'vault_conversations_revision_positive',
      'vault_conversations_version_one',
    ]);
  });
});
