'use client';
import type { ChainId, Target } from '@colosseum/schemas';
import { type ChainVault, readEvmVault, readSolanaVault } from '@colosseum/sdk';
import { useEffect, useState } from 'react';
import { chainNode } from '../order/chain-node';
import { deploymentsFor } from '../order/readiness';
import { sameAddress } from './vault-name';

// A vault's targets, read from this app's own node, not from our server: what more money into the
// vault is held to. The guard holds a swap to the vault and to the tokens the deployment lists, not to
// the vault's targets, so the trades of an add are held to these before anything is signed
// (order-check.ts, `checkVaultAdd`). The vault is the one this app derives from the signing wallet and
// the plan's number; an address our server named that is not that one is not read as it.
//
// Where it cannot read, it says which reason, and the screen shows our server's targets as unverified:
//
//   mock           the chain runs on the mock: there is no chain to read
//   no-node        no node of this chain is set for this app (NEXT_PUBLIC_CHAIN_READ_RPC_<CHAIN>)
//   no-deployment  no deployment is committed for the chain's network
//
// Where it has a node and a deployment and still cannot read, or reads another vault than the one
// named, the read has `failed`, and no add is offered: a server that lies can cause it.

export type VaultCheck =
  | { state: 'reading' }
  | {
      state: 'read';
      vault: ChainVault;
      /**
       * What an add buys: the targets above zero, in the chain's order. Null when one of them is a
       * token this app does not list, and then no add is offered.
       */
      targets: Target[] | null;
    }
  /** The chain has no vault of this wallet for this plan number. */
  | { state: 'missing' }
  | { state: 'failed' }
  | { state: 'unverified'; why: 'mock' | 'no-node' | 'no-deployment' };

/** The targets above zero as an add buys them, or null when one is a token the app does not list. */
export function buyableTargets(vault: ChainVault): Target[] | null {
  const lines = vault.targets.filter((t) => t.weightBps > 0);
  return lines.every((t) => t.asset !== null)
    ? lines.map((t) => ({ asset: t.asset as string, weightBps: t.weightBps }))
    : null;
}

export const sameTargets = (a: readonly Target[], b: readonly Target[]) =>
  a.length === b.length &&
  a.every((t, i) => t.asset === b[i]?.asset && t.weightBps === b[i]?.weightBps);

/** Reads the vault once per chain, owner, number and address named. */
export function useChainVault(
  chain: ChainId | null,
  mock: boolean,
  vault: { owner: string; basketId: string; address: string } | null,
): VaultCheck {
  const [check, setCheck] = useState<VaultCheck>({ state: 'reading' });
  const owner = vault?.owner ?? null;
  const basketId = vault?.basketId ?? null;
  const address = vault?.address ?? null;
  useEffect(() => {
    let mine = true;
    const say = (next: VaultCheck) => {
      if (mine) setCheck(next);
    };
    if (!chain || !owner || !basketId || !address) say({ state: 'reading' });
    else if (mock) say({ state: 'unverified', why: 'mock' });
    else {
      const deployment = deploymentsFor(chain, false)?.[chain];
      const node = chainNode(chain);
      if (!deployment || deployment.family === 'mock')
        say({ state: 'unverified', why: 'no-deployment' });
      else if (!node) say({ state: 'unverified', why: 'no-node' });
      else {
        say({ state: 'reading' });
        const at = { owner, basketId };
        (deployment.family === 'solana'
          ? readSolanaVault(node, deployment, at)
          : readEvmVault(node, deployment, at)
        ).then(
          (read) => {
            if (!read) return say({ state: 'missing' });
            // The vault read is the one this app derived: the address our server named is held to it.
            if (!sameAddress(chain, read.address, address)) return say({ state: 'failed' });
            say({ state: 'read', vault: read, targets: buyableTargets(read) });
          },
          () => say({ state: 'failed' }),
        );
      }
    }
    return () => {
      mine = false;
    };
  }, [chain, mock, owner, basketId, address]);
  return check;
}
