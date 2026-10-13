import {
  type Address,
  type ChainId,
  type ChainUnavailable,
  normalizeAddress,
  type Principal,
} from '@colosseum/schemas';
import { type AnyColumn, and, eq, inArray, type SQL } from 'drizzle-orm';
import type { ChainEntry, ChainRegistry } from '../orders/chains';
import { chainsHeld } from '../orders/person';

// Whose rows a route of the portfolio section may read (PORT-2). The four routes answer from the
// database alone, so nothing but this file stands between a caller and another person's history: a
// row is the caller's when its owner is one of the wallets of their verified identity token, on a
// chain this server runs, under the label that chain's figures carry here. Every query of those
// routes takes its `where` from `ownedOn`.

/** One chain of the person's that this server runs. */
export type ScopedChain = {
  entry: ChainEntry;
  /** The person's wallets on the chain's family. Never empty. */
  owners: Address[];
};

export type PersonScope = {
  /** In the server's order, as GET /v1/portfolio lists them. */
  chains: ScopedChain[];
  /** The chains the person holds a wallet for that are switched off here. */
  unavailable: ChainUnavailable[];
};

/**
 * The chains a signed-in person's rows are read on, each with the person's wallets there, and the
 * chains of theirs this server does not run. `only` narrows both to one chain.
 */
export function personScope(
  registry: ChainRegistry,
  principal: Principal,
  only?: ChainId,
): PersonScope {
  const held = chainsHeld(principal).filter((chain) => only === undefined || chain === only);
  const active = registry.active();
  const on = new Set(active.map((entry) => entry.chain));
  return {
    chains: active
      .filter((entry) => held.includes(entry.chain))
      .map((entry) => ({
        entry,
        owners: principal.wallets
          .filter((w) => w.family === entry.config.family)
          .map((w) => w.address),
      })),
    unavailable: held
      .filter((chain) => !on.has(chain))
      .map((chain) => ({
        chain,
        name: registry.name(chain),
        code: 'CHAIN_UNAVAILABLE',
        error: `${registry.name(chain)} is switched off on this server`,
        retryable: false,
      })),
  };
}

/**
 * The rows of a table that are the person's on one chain: the chain's, owned by one of their wallets,
 * and read under the label the chain has on this server. A database can hold rows read from the mock
 * beside rows read from a test network, and a mock row is never answered as a test network's.
 * `vaults` and `vault_snapshots` both fit.
 */
export function ownedOn(
  table: { chainId: AnyColumn; owner: AnyColumn; provenance: AnyColumn },
  scoped: ScopedChain,
): SQL {
  const mine = and(
    eq(table.chainId, scoped.entry.chain),
    inArray(table.owner, scoped.owners),
    eq(table.provenance, scoped.entry.provenance),
  );
  if (!mine) throw new Error('no scope');
  return mine;
}

/**
 * The vault address a query named, in the form the chain's rows hold it: an EVM address is taken in
 * any case and lower-cased, as the rest of the API takes one (`sameVaultAddress`). Null when it is not
 * an address of the chain's family at all: the chain then answers nothing, and the text is never
 * handed to the database.
 */
export function addressOn(scoped: ScopedChain, address: string): Address | null {
  try {
    return normalizeAddress(scoped.entry.config.family, address);
  } catch {
    return null;
  }
}

/** What a chain's entry in an answer opens with. */
export const frame = (entry: ChainEntry) => ({
  chain: entry.chain,
  name: entry.config.name,
  provenance: entry.provenance,
});
