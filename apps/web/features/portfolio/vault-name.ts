import { type ChainId, chainFamily, VaultName, VaultNameResponse } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import type { PortfolioChain, Vault } from './portfolio';

// A vault's name, which its owner gives it (PUT /v1/vaults/{chain}/{address}/name) and the portfolio
// answers with the vault. It is plain text of 1 to 60 characters, trimmed, with no control characters:
// the shared `VaultName` says so here before anything is sent, and the server says so again. A vault
// with no name is called by the goal of its plan, and with neither by its chain.

/** The name as it would be kept, or null when it is not one. */
export function readName(text: string): string | null {
  const read = VaultName.safeParse(text);
  return read.success ? read.data : null;
}

export type RenameOutcome =
  /** Kept: the name as the server has it now, or null once it is taken off. */
  | { kind: 'saved'; name: string | null }
  /** 400: not a name. */
  | { kind: 'invalid' }
  /** 401 or 403. */
  | { kind: 'signed-out' }
  /** 404: no vault with that address that is this person's. */
  | { kind: 'not-yours' }
  /** 429. */
  | { kind: 'busy' }
  | { kind: 'unreachable' };

/** Names the vault, or with null takes its name off. */
export async function renameVault(
  apiFetch: ApiFetch,
  vault: { chain: ChainId; address: string },
  name: string | null,
): Promise<RenameOutcome> {
  let res: Response;
  try {
    res = await apiFetch(`/v1/vaults/${vault.chain}/${encodeURIComponent(vault.address)}/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.status === 400 || res.status === 422) return { kind: 'invalid' };
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (res.status === 404) return { kind: 'not-yours' };
  if (res.status === 429) return { kind: 'busy' };
  if (!res.ok) return { kind: 'unreachable' };
  const said = VaultNameResponse.safeParse(await res.json().catch(() => null));
  return said.success ? { kind: 'saved', name: said.data.name } : { kind: 'unreachable' };
}

/** One address as another, as its chain writes it: an EVM address in any case. */
export const sameAddress = (chain: ChainId, a: string, b: string): boolean =>
  chainFamily(chain) === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The person's vault at this address on this chain, with its chain's entry, among the ones read. */
export function ownVault(
  chains: readonly PortfolioChain[],
  chain: string,
  address: string,
): { entry: PortfolioChain; vault: Vault } | null {
  for (const entry of chains) {
    if (entry.chain !== chain) continue;
    const vault = entry.vaults.find((v) => sameAddress(entry.chain, v.address, address));
    if (vault) return { entry, vault };
  }
  return null;
}

/**
 * What a vault is called (Thom, Oct 9): the name its owner gave it; else "Vault #N", its number among
 * the person's vaults, where the server gives one; else, until it does, by its chain. One rule, so a
 * vault goes by one name wherever this is asked.
 */
export function vaultTitle(
  vault: { name?: string | null; number?: number | null },
  words: { unnamed: (chain: string) => string; numbered: (number: number) => string },
  chainName: string,
): string {
  if (vault.name) return vault.name;
  return typeof vault.number === 'number' ? words.numbered(vault.number) : words.unnamed(chainName);
}
