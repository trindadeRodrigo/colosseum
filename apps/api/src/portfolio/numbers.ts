import { baskets, type Db, users, vaultNumbers, vaults } from '@colosseum/db';
import { type ChainId, chainFamily, type Principal } from '@colosseum/schemas';
import { eq, or } from 'drizzle-orm';
import type { JoinLog } from '../orders/plan-join';
import { loggable } from '../plugins/loggable';
import { ownedOn, type PersonScope } from './scope';

// A vault's number among its person's vaults (gate VAULT-NUMBER): a vault with no name is called
// "Vault #N". Neither chain numbers a person's vaults (Solana's vault is found by owner and plan
// number, the EVM factory lists them by wallet, not by person), no table says when a vault was made,
// and a vault made outside the app has no order. So the number is given here and kept
// (`vault_numbers`): the next free one of the person, when the server first holds the vault as theirs.
//
// Why a number never changes. It is read from its row, and no code updates or deletes one. Nothing
// about the read decides it again: a chain that does not answer, a vault that holds nothing, or a
// wallet the person adds later, whose vaults take the next numbers however old they are. Vaults that
// get their numbers in one go get them oldest first: by the time of the order that opened each, as the
// goal join holds it, then by chain, then by address; one no order of theirs opened comes after.
//
// The vaults are the cache's (`vaults`), under the scope every portfolio route reads by (`ownedOn`),
// never a chain's list at that moment: a vault is in the cache from the step that opens it
// (`rememberVault`) and from any read of the portfolio, so a chain that is down hides none.

/** A vault as it is told from every other: an EVM address in any case is one address. */
const keyOf = (chain: ChainId, address: string) =>
  `${chain}:${chainFamily(chain) === 'evm' ? address.toLowerCase() : address}`;

/** A vault of the person's with no number yet, and when the order that opened it was made. */
export type Unnumbered = { chain: ChainId; address: string; openedAt: Date | null };

/** Oldest first: by the opening order's time, then chain, then address. One with no order is last. */
export function oldestFirst(fresh: readonly Unnumbered[]): Unnumbered[] {
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...fresh].sort((a, b) => {
    if (a.openedAt && b.openedAt && a.openedAt.getTime() !== b.openedAt.getTime())
      return a.openedAt.getTime() - b.openedAt.getTime();
    if (!a.openedAt !== !b.openedAt) return a.openedAt ? -1 : 1;
    return text(a.chain, b.chain) || text(a.address, b.address);
  });
}

/**
 * The numbers these vaults take, after the ones the person already has: one past the highest, oldest
 * first. A number is never one that was given before, also where an earlier one is no longer shown.
 */
export function nextNumbers(
  taken: readonly number[],
  fresh: readonly Unnumbered[],
): { chain: ChainId; address: string; number: number }[] {
  let last = taken.reduce((highest, n) => Math.max(highest, n), 0);
  return oldestFirst(fresh).map(({ chain, address }) => {
    last += 1;
    return { chain, address, number: last };
  });
}

/** The person's numbers, asked by vault. */
export type VaultNumbers = { of(chain: ChainId, address: string): number | undefined };

const NONE: VaultNumbers = { of: () => undefined };

/**
 * Gives numbers to the person's vaults that have none, in one transaction that holds the person's row:
 * two reads at the same moment wait for each other there, and the second finds the first one's
 * numbers. The person's user row is made where there is none, as the goal join makes it.
 */
async function giveNumbers(db: Db, privyId: string, fresh: readonly Unnumbered[]) {
  return db.transaction(async (tx) => {
    await tx.insert(users).values({ privyId }).onConflictDoNothing({ target: users.privyId });
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.privyId, privyId))
      .for('update');
    if (!user) throw new Error('the user row vanished');
    const have = await tx
      .select({
        chain: vaultNumbers.chainId,
        address: vaultNumbers.address,
        number: vaultNumbers.number,
      })
      .from(vaultNumbers)
      .where(eq(vaultNumbers.userId, user.id));
    const numbered = new Set(have.map((row) => keyOf(row.chain, row.address)));
    const given = nextNumbers(
      have.map((row) => row.number),
      fresh.filter((vault) => !numbered.has(keyOf(vault.chain, vault.address))),
    );
    if (given.length)
      await tx.insert(vaultNumbers).values(
        given.map(({ chain, address, number }) => ({
          userId: user.id,
          chainId: chain,
          address,
          number,
        })),
      );
    return [...have, ...given];
  });
}

/**
 * The numbers of the signed-in person's vaults, giving one to each vault of theirs that has none.
 *
 * `scope` is the person's whole scope, never one narrowed to a chain or a vault: which vaults get a
 * number, and in what order, must not depend on what a request asked to see. A number is answered only
 * for a vault the cache holds as the person's now (`ownedOn`), so nobody is answered another person's,
 * and how many vaults a person has is said to them alone.
 *
 * It never fails the read it is part of: where the numbers cannot be read or given, none is answered,
 * the log says why, and the caller names the vault some other way.
 */
export async function vaultNumbersOf(
  db: Db,
  scope: PersonScope,
  principal: Principal,
  log: JoinLog,
): Promise<VaultNumbers> {
  const privyId = principal.userId;
  if (principal.kind !== 'user' || !privyId || scope.chains.length === 0) return NONE;
  try {
    const mine = await db
      .select({ chain: vaults.chainId, address: vaults.address, openedAt: baskets.createdAt })
      .from(vaults)
      .leftJoin(baskets, eq(baskets.id, vaults.basketId))
      .where(or(...scope.chains.map((scoped) => ownedOn(vaults, scoped))));
    if (mine.length === 0) return NONE;
    const have = await db
      .select({
        chain: vaultNumbers.chainId,
        address: vaultNumbers.address,
        number: vaultNumbers.number,
      })
      .from(vaultNumbers)
      .innerJoin(users, eq(users.id, vaultNumbers.userId))
      .where(eq(users.privyId, privyId));
    const numberOf = new Map(have.map((row) => [keyOf(row.chain, row.address), row.number]));
    const fresh = mine.filter((vault) => !numberOf.has(keyOf(vault.chain, vault.address)));
    if (fresh.length)
      for (const row of await giveNumbers(db, privyId, fresh))
        numberOf.set(keyOf(row.chain, row.address), row.number);
    const held = new Set(mine.map((vault) => keyOf(vault.chain, vault.address)));
    return {
      of: (chain, address) => {
        const key = keyOf(chain, address);
        return held.has(key) ? numberOf.get(key) : undefined;
      },
    };
  } catch (err) {
    log.error({ err: loggable(err) }, "the numbers of the person's vaults could not be read");
    return NONE;
  }
}

/** A vault's number as an answer carries it: the field where there is one, and nothing where not. */
export const numbered = (numbers: VaultNumbers, chain: ChainId, address: string) => {
  const number = numbers.of(chain, address);
  return number === undefined ? {} : { number };
};
