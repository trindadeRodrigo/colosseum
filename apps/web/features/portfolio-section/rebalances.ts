import type { Provenance, RebalanceEntry } from '@colosseum/schemas';
import { explorerUrlFor, networkFor } from '../order/readiness';
import type { RebalancesAnswer, RebalancesChain } from './api';

// How the rebalancing page orders what GET /v1/portfolio/rebalances answers, and where a step's
// transaction can be opened. Nothing here is a figure: the entries are handed on as they came, sorted
// and filed under their vault.

/** The steps of one vault, or the steps on one chain that the server could file under no vault. */
export type StepGroup = {
  /** The chain's entry in the answer: its name and the label of every figure under it. */
  chain: RebalancesChain;
  /** Null for the steps whose vault the server has not cached. */
  vault: string | null;
  /** Newest first. */
  entries: RebalanceEntry[];
};

const at = (entry: RebalanceEntry) => Date.parse(entry.at);

/**
 * The answer's entries by vault, each vault's newest first, and the vaults in the order of their
 * newest step. The steps with no vault come last, a group a chain. Where two times are equal the
 * answer's own order stands: an owner's step ahead of a keeper's trade.
 */
export function groupsOf(answer: RebalancesAnswer): StepGroup[] {
  const known: StepGroup[] = [];
  const loose: StepGroup[] = [];
  for (const chain of answer.chains) {
    const filed = new Map<string, RebalanceEntry[]>();
    const unfiled: RebalanceEntry[] = [];
    for (const entry of chain.entries) {
      if (entry.vault === null) unfiled.push(entry);
      else filed.set(entry.vault, [...(filed.get(entry.vault) ?? []), entry]);
    }
    const newestFirst = (entries: RebalanceEntry[]) => [...entries].sort((a, b) => at(b) - at(a));
    for (const [vault, entries] of filed)
      known.push({ chain, vault, entries: newestFirst(entries) });
    if (unfiled.length > 0) loose.push({ chain, vault: null, entries: newestFirst(unfiled) });
  }
  const newest = (group: StepGroup) => Math.max(...group.entries.map(at));
  return [...known.sort((a, b) => newest(b) - newest(a)), ...loose];
}

/**
 * A step's transaction on the explorer of the network this app signs for, from this app's own chain
 * table and never the answer's `explorerUrl`, which could point anywhere. Null where no page shows it:
 * the step has no transaction; it is on the sample chain, whose transactions are on no network (the
 * mock's own `mock://` address is never a link); or it is on another network of the chain than this
 * app's (a test network's step, in an app set to mainnet), whose explorer would not have it.
 */
export function explorerHref(
  entry: Pick<RebalanceEntry, 'chain' | 'txId'>,
  label: Provenance,
): string | null {
  if (entry.txId === null) return null;
  const network = label === 'live' ? 'mainnet' : label === 'sandbox' ? 'testnet' : null;
  if (network === null || networkFor(entry.chain, false) !== network) return null;
  const url = explorerUrlFor(entry.chain, entry.txId, false);
  return url !== null && /^https:\/\//.test(url) ? url : null;
}
