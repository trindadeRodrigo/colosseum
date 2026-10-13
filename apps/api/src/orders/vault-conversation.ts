import { type Db, users, vaultConversations } from '@colosseum/db';
import type { VaultConversationResponse, VaultConversationWrite } from '@colosseum/schemas';
import { and, eq, sql } from 'drizzle-orm';

import type { ConversationIdentity } from './vault-conversation-owner';

export type { ConversationIdentity } from './vault-conversation-owner';
export type ConversationData = Pick<
  VaultConversationResponse,
  'revision' | 'transcript' | 'checkpoint' | 'updatedAt'
>;
export const emptyConversation = (): ConversationData => ({
  revision: 0,
  transcript: [],
  checkpoint: null,
  updatedAt: null,
});
export class ConversationConflict extends Error {
  constructor(readonly revision: number) {
    super('conversation changed');
  }
}
/** Driver errors may quote the private request. Never retain their cause or message. */
export class ConversationStoreError extends Error {
  constructor() {
    super('conversation storage unavailable');
  }
}
export type ConversationStore = {
  read(identity: ConversationIdentity): Promise<ConversationData>;
  write(
    identity: ConversationIdentity,
    body: VaultConversationWrite,
    now: Date,
  ): Promise<ConversationData>;
};
const toData = (r: typeof vaultConversations.$inferSelect): ConversationData => ({
  revision: r.revision,
  transcript: r.transcript,
  checkpoint: r.checkpoint,
  updatedAt: r.updatedAt.toISOString(),
});
export function conversationStore(db: Db): ConversationStore {
  const where = (a: ConversationIdentity, userId: string) =>
    and(
      eq(vaultConversations.userId, userId),
      eq(vaultConversations.chainId, a.chain),
      eq(vaultConversations.address, a.address),
      eq(vaultConversations.provenance, a.provenance),
      eq(vaultConversations.network, a.network),
    );
  return {
    async read(a) {
      try {
        const [r] = await db
          .select({ data: vaultConversations })
          .from(vaultConversations)
          .innerJoin(users, eq(users.id, vaultConversations.userId))
          .where(
            and(
              eq(users.privyId, a.privyId),
              eq(vaultConversations.chainId, a.chain),
              eq(vaultConversations.address, a.address),
              eq(vaultConversations.provenance, a.provenance),
              eq(vaultConversations.network, a.network),
            ),
          );
        return r ? toData(r.data) : emptyConversation();
      } catch {
        throw new ConversationStoreError();
      }
    },
    async write(a, body, now) {
      try {
        return await db.transaction(async (tx) => {
          // Serialize the empty-row race too, before the user/conversation row exists.
          const key = JSON.stringify([a.privyId, a.chain, a.address, a.provenance, a.network]);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`vault-conversation:${key}`}, 0))`,
          );
          await tx
            .insert(users)
            .values({ privyId: a.privyId })
            .onConflictDoNothing({ target: users.privyId });
          const [u] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.privyId, a.privyId));
          if (!u) throw new ConversationStoreError();
          const [current] = await tx.select().from(vaultConversations).where(where(a, u.id));
          const revision = current?.revision ?? 0;
          if (body.expectedRevision !== revision) throw new ConversationConflict(revision);
          const values = {
            revision: revision + 1,
            version: 1,
            transcript: body.transcript,
            checkpoint: body.checkpoint,
            updatedAt: now,
          };
          const [saved] = current
            ? await tx.update(vaultConversations).set(values).where(where(a, u.id)).returning()
            : await tx
                .insert(vaultConversations)
                .values({
                  userId: u.id,
                  chainId: a.chain,
                  address: a.address,
                  provenance: a.provenance,
                  network: a.network,
                  ...values,
                })
                .returning();
          if (!saved) throw new ConversationStoreError();
          return toData(saved);
        });
      } catch (e) {
        if (e instanceof ConversationConflict) throw e;
        throw new ConversationStoreError();
      }
    },
  };
}
