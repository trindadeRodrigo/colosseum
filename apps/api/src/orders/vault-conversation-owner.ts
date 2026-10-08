import {
  ChainError,
  type ChainId,
  chainFamily,
  normalizeAddress,
  type Principal,
  type Provenance,
  type VaultState,
} from '@colosseum/schemas';
import type { ChainEntry } from './chains';
import { Refusal, refusing } from './errors';
import type { OrderDeps } from './legs';
export type ConversationIdentity = {
  privyId: string;
  chain: ChainId;
  address: string;
  provenance: Provenance;
};

export type OwnedConversationVault = {
  identity: ConversationIdentity;
  state: VaultState;
  entry: ChainEntry;
};
/** Fresh chain-reader ownership; independent of cached DB, plan ids and snapshot workers. */
export async function resolveVaultConversationOwner(
  deps: Pick<OrderDeps, 'chains'>,
  params: { chain: ChainId; address: string },
  principal: Principal,
): Promise<OwnedConversationVault> {
  const { chain } = params;
  const missing = () => new Refusal(404, 'no vault with that address that is yours');
  let address: string;
  try {
    address = normalizeAddress(chainFamily(chain), params.address);
  } catch {
    throw missing();
  }
  const entry = deps.chains.get(chain);
  const owners = principal.wallets
    .filter((w) => w.family === entry.config.family)
    .flatMap((w) => {
      try {
        return [normalizeAddress(entry.config.family, w.address)];
      } catch {
        return [];
      }
    });
  if (!owners.length || !principal.userId) throw missing();
  const state = await refusing(async () => {
    try {
      return await entry.adapter.getVault(address);
    } catch (e) {
      if (e instanceof ChainError && e.code === 'VaultNotFound') return null;
      throw e;
    }
  });
  if (!state || state.chain !== chain) throw missing();
  let owner: string;
  try {
    owner = normalizeAddress(entry.config.family, state.owner);
  } catch {
    throw missing();
  }
  if (!owners.includes(owner)) throw missing();
  let actual: string;
  try {
    actual = normalizeAddress(entry.config.family, state.address);
  } catch {
    throw missing();
  }
  if (actual !== address) throw missing();
  return {
    identity: { privyId: principal.userId, chain, address, provenance: entry.provenance },
    state,
    entry,
  };
}
