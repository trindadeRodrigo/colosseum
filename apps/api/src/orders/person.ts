import { type Db, users } from '@colosseum/db';
import { type Chain, ChainId, type PersonResponse, type Principal } from '@colosseum/schemas';
import { eq, isNull, sql } from 'drizzle-orm';
import type { ChainRegistry } from './chains';
import { Refusal } from './errors';

// The person's current chain: where their new plans are made (gates ONE-CHAIN and CHAIN-SWITCH). One
// place decides it, and every route that needs it asks here: a new plan, a buy of a shared portfolio and
// the funding check with no plan named. A stored plan is bought on its own chain, whatever this says.

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

/** The chains a person can sign on, and so may switch to: the home chain of each family they hold. */
export function chainsHeld(principal: Principal): ChainId[] {
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
 * Writes the chain on the user. `pickedAt` is the time of a pick, and null for a chain that an outside
 * wallet named: that one is written only on a row with no chain, so it never undoes a pick. A pick
 * always writes, and of two at the same moment the later stands.
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
      ...(pickedAt ? {} : { setWhere: isNull(users.chainId) }),
    });
}

/**
 * The person's current chain, and the chains they may switch to.
 * - A stored chain stands, whatever wallets came later, until the person switches. It is stored at a
 *   pick, and the first time an outside wallet names it.
 * - With nothing stored, an outside wallet names the chain of its family, and that is stored now. So a
 *   person who later links a wallet of the other family keeps their chain, as a person who picked does.
 * - Otherwise there is none yet: the person made their wallet in the app and has not picked, or
 *   connected outside wallets of both families at once.
 */
export async function personChain(db: Db, principal: Principal): Promise<PersonChain> {
  const options = chainsHeld(principal);
  const answer = (s: Stored): PersonChain => ({
    chain: s.chain,
    chainSource: s.source,
    chainOptions: options,
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
  return { chain: null, chainSource: null, chainOptions: options };
}

/** The person's current chain, for a route that cannot go on without one. */
export async function homeChain(db: Db, principal: Principal): Promise<ChainId> {
  const { chain } = await personChain(db, principal);
  if (!chain)
    throw new Refusal(409, 'pick the chain for your new plans first', {
      fix: 'Pick Solana or Robinhood Chain with PUT /v1/me/chain. You can switch later.',
      details: { retryable: false },
    });
  return chain;
}

/** The chains a pick may name: the home chain of a family. Base is not offered while it is not deployed. */
const OFFERED: readonly ChainId[] = Object.values(HOME_CHAIN);

/**
 * Switches the person's current chain (gate CHAIN-SWITCH), for a person who made their wallets in the
 * app and for one whose outside wallets sign on both families. The same chain again changes nothing.
 * A chain the person holds no wallet for is refused with 409 `NO_WALLET_FOR_CHAIN`: an EVM wallet alone
 * cannot sign on Solana. Plans already made stay on their chains. The answer is what the row holds.
 */
export async function switchChain(
  db: Db,
  chains: ChainRegistry,
  principal: Principal,
  chain: ChainId,
  now: Date,
): Promise<PersonChain> {
  if (!principal.userId) throw new Refusal(401, 'sign in first');
  const current = await personChain(db, principal);
  if (current.chain === chain) return current;
  if (!current.chainOptions.length) throw new Refusal(422, 'no wallet is linked to this sign-in');
  if (!OFFERED.includes(chain))
    throw new Refusal(422, `${chains.name(chain)} is not a chain you can pick`, {
      fix: `Pick ${current.chainOptions.map((c) => chains.name(c)).join(' or ')}.`,
    });
  if (!current.chainOptions.includes(chain))
    throw new Refusal(409, `no wallet you signed in with signs on ${chains.name(chain)}`, {
      code: 'NO_WALLET_FOR_CHAIN',
      fix: `Sign in with a wallet that signs on ${chains.name(chain)}, or with a passkey.`,
      details: { retryable: false },
    });
  // Refuses a chain that is switched off here, before anything is stored.
  chains.get(chain);
  await storeChain(db, principal.userId, chain, now);
  const stored = await storedChain(db, principal);
  return {
    chain: stored?.chain ?? chain,
    chainSource: stored?.source ?? 'picked',
    chainOptions: current.chainOptions,
  };
}
