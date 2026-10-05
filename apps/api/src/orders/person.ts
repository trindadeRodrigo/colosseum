import { type Db, users } from '@colosseum/db';
import { type Chain, ChainId, type PersonResponse, type Principal } from '@colosseum/schemas';
import { eq, isNull, sql } from 'drizzle-orm';
import type { ChainRegistry } from './chains';
import { Refusal } from './errors';

// The chain a person's plans live on (gates ONE-CHAIN and CHAIN-PICK). One place decides it, and every
// route that needs "the person's chain" asks here: the orders, the funding check and the portfolio.

/**
 * The chain a wallet family means. A Solana wallet is on Solana. An EVM address serves every EVM chain,
 * so the family alone does not name one: while Base is not deployed it means Robinhood Chain.
 */
export const HOME_CHAIN: Record<Chain, ChainId> = { solana: 'solana', evm: 'robinhood' };

type PersonChain = Pick<PersonResponse, 'chain' | 'chainSource' | 'chainOptions'>;

/**
 * The chain of the outside wallet a person connected: the home chain of its family. Null when they
 * connected none, or wallets of both families, which names no single chain.
 */
function walletChain(principal: Principal): ChainId | null {
  const families = new Set(
    principal.wallets.filter((w) => w.kind === 'external').map((w) => w.family),
  );
  const [only] = families;
  return families.size === 1 && only ? HOME_CHAIN[only] : null;
}

/** What a person with no chain yet may pick: the home chain of each family they hold a wallet of. */
function pickable(principal: Principal): ChainId[] {
  const held = new Set(principal.wallets.map((w) => HOME_CHAIN[w.family]));
  return ChainId.options.filter((chain) => held.has(chain));
}

type Stored = { chain: ChainId; source: 'picked' | 'wallet' };

/** The chain on the user's row, and whether it was picked or came from a wallet (no pick time). */
async function storedChain(db: Db, principal: Principal): Promise<Stored | null> {
  if (!principal.userId) return null;
  const [row] = await db
    .select({ chain: users.chainId, pickedAt: users.chainPickedAt })
    .from(users)
    .where(eq(users.privyId, principal.userId));
  return row?.chain ? { chain: row.chain, source: row.pickedAt ? 'picked' : 'wallet' } : null;
}

/**
 * Writes the chain on the user, once. A row whose chain is set is never written again: of two writes
 * at the same moment the first stands, and the answer is what the row holds afterwards. `pickedAt` is
 * the time of a pick, and null for a chain that an outside wallet named.
 */
async function storeChain(
  db: Db,
  privyId: string,
  chain: ChainId,
  pickedAt: Date | null,
): Promise<void> {
  await db
    .insert(users)
    .values({ privyId, chainId: chain, chainPickedAt: pickedAt })
    .onConflictDoUpdate({
      target: users.privyId,
      set: { chainId: sql`excluded.chain_id`, chainPickedAt: sql`excluded.chain_picked_at` },
      setWhere: isNull(users.chainId),
    });
}

/**
 * Where this person's plans live.
 * - A stored chain stands, whatever wallets came later: the plan lives there. It is stored at a pick,
 *   and the first time an outside wallet names it.
 * - With nothing stored, an outside wallet names the chain of its family, and that is stored now. So a
 *   person who later links a wallet of the other family keeps their chain, as a person who picked does.
 * - Otherwise there is none yet: the person made their wallet in the app and has not picked, or
 *   connected outside wallets of both families at once.
 */
export async function personChain(db: Db, principal: Principal): Promise<PersonChain> {
  const answer = (s: Stored): PersonChain => ({
    chain: s.chain,
    chainSource: s.source,
    chainOptions: [],
  });
  const stored = await storedChain(db, principal);
  if (stored) return answer(stored);
  const fromWallet = walletChain(principal);
  if (fromWallet) {
    if (principal.userId) {
      await storeChain(db, principal.userId, fromWallet, null);
      const now = await storedChain(db, principal);
      if (now) return answer(now);
    }
    return answer({ chain: fromWallet, source: 'wallet' });
  }
  return { chain: null, chainSource: null, chainOptions: pickable(principal) };
}

/** The person's chain, for a route that cannot go on without one. */
export async function homeChain(db: Db, principal: Principal): Promise<ChainId> {
  const { chain } = await personChain(db, principal);
  if (!chain)
    throw new Refusal(409, 'pick the chain your plans live on first', {
      fix: 'Pick Solana or Robinhood Chain once, with PUT /v1/me/chain.',
      details: { retryable: false },
    });
  return chain;
}

/**
 * Stores the pick. Once: the same chain again changes nothing and answers as before, and another chain
 * is refused, whether the first came from a pick or from an outside wallet. The chain has to be one the
 * person holds a wallet for, and one this server runs.
 */
export async function pickChain(
  db: Db,
  chains: ChainRegistry,
  principal: Principal,
  chain: ChainId,
  now: Date,
): Promise<PersonChain> {
  if (!principal.userId) throw new Refusal(401, 'sign in first');
  const current = await personChain(db, principal);
  if (current.chain) {
    if (current.chain === chain) return current;
    throw new Refusal(
      409,
      current.chainSource === 'picked'
        ? `the chain is picked once, and it is ${chains.name(current.chain)}`
        : `your plans live on ${chains.name(current.chain)}, the chain of the wallet you connected`,
      { details: { retryable: false } },
    );
  }
  if (!current.chainOptions.length) throw new Refusal(422, 'no wallet is linked to this sign-in');
  if (!current.chainOptions.includes(chain))
    throw new Refusal(422, `${chains.name(chain)} is not a chain you can pick`, {
      fix: `Pick ${current.chainOptions.map((c) => chains.name(c)).join(' or ')}.`,
    });
  // Refuses a chain that is switched off here, before anything is stored.
  chains.get(chain);
  // Of two picks at once, the first stands.
  await storeChain(db, principal.userId, chain, now);
  const stored = await storedChain(db, principal);
  if (stored?.chain !== chain)
    throw new Refusal(
      409,
      `the chain is picked once, and it is ${chains.name(stored?.chain ?? chain)}`,
      { details: { retryable: false } },
    );
  return { chain, chainSource: stored.source, chainOptions: [] };
}
