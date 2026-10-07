import type { RunEnd } from './store';

// What the worker remembers of one chain between passes, and when it asks a chain for an owner's vaults.
//
// A vault is read by its address at every pass, which is cheap. Asking for everything an owner holds is
// the heavy read (getProgramAccounts on Solana, vaultsOf and a read of each vault on EVM), so it is
// made for every owner at the first pass and once an hour after it, and in between only for an owner
// the worker has not asked before. A vault opened outside the app is found within the hour.
//
// The memory is in this process only. A worker that starts again loads the addresses it has already
// written from `vault_snapshots` and asks every owner once more.

/** How long between two passes that ask every owner. */
export const DISCOVERY_EVERY_MS = 3_600_000;

export type ChainState = {
  /**
   * The addresses read at every pass beside those the `vaults` rows name: the ones `vault_snapshots`
   * held when the worker started, the ones an owner's read found, and the ones read since. Null until
   * the first pass loads it.
   */
  addresses: Set<string> | null;
  /** The owners already asked for their vaults. */
  owners: Set<string>;
  /** When every owner was last asked, in ms. Null before the first pass. */
  discoveredAt: number | null;
  /** Addresses where the chain had no vault. They are not asked again until every owner is. */
  empty: Set<string>;
  /**
   * A run of this worker whose end the database did not take. The next pass writes it before it opens
   * its own: left open, it would refuse the runs after it on the chain until a pass found it old
   * enough to close as left open (pass.ts), and its row would then say that and not how it ended.
   */
  unclosed: { id: string; end: RunEnd } | null;
};

export const newChainState = (): ChainState => ({
  addresses: null,
  owners: new Set(),
  discoveredAt: null,
  empty: new Set(),
  unclosed: null,
});

/**
 * The owners to ask at a pass that starts at `now`: all of them when none was asked yet or the hour has
 * passed (`all`), otherwise only those new to this worker.
 */
export function ownersDue(
  state: Pick<ChainState, 'owners' | 'discoveredAt'>,
  owners: readonly string[],
  now: Date,
): { all: boolean; due: string[] } {
  const all =
    state.discoveredAt === null || now.getTime() - state.discoveredAt >= DISCOVERY_EVERY_MS;
  return { all, due: all ? [...owners] : owners.filter((o) => !state.owners.has(o)) };
}

/**
 * Marks a pass that asks every owner: the hour counts from `now`, and an address that had no vault may
 * be asked again, since one can have been opened there since.
 */
export function startDiscovery(state: ChainState, now: Date): void {
  state.discoveredAt = now.getTime();
  state.empty.clear();
}
