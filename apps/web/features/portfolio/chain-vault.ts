'use client';
import type { ChainId, Target } from '@colosseum/schemas';
import {
  type ChainVault,
  evmVaultAddress,
  type GuardDeployment,
  type RpcCall,
  readEvmVault,
  readSolanaVault,
  readSolanaVaultCash,
  vaultOf,
} from '@colosseum/sdk';
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
// Even then the address is not our server's word: it is derived here from the deployment, the wallet
// and the plan's number (`derivedVault`), with no node asked, and an address or a number our server
// named that is not that vault's has `failed`.
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

/**
 * The vault of `owner` for the plan number `basketId`, as this app derives it from the committed
 * deployment: what the guard holds every step of an add to. No node is asked.
 */
export function derivedVault(
  deployment: GuardDeployment,
  owner: string,
  basketId: string,
): string | null {
  try {
    return deployment.family === 'evm'
      ? evmVaultAddress(deployment, owner, basketId)
      : vaultOf(deployment, owner, basketId);
  } catch {
    return null;
  }
}

/** The targets above zero as an add buys them, or null when one is a token the app does not list. */
export function buyableTargets(vault: ChainVault): Target[] | null {
  const lines = vault.targets.filter((t) => t.weightBps > 0);
  return lines.every((t) => t.asset !== null)
    ? lines.map((t) => ({ asset: t.asset as string, weightBps: t.weightBps }))
    : null;
}

/** Read-only chain seam shared by owned-vault views and strategy publication. */
export function readChainVault(
  node: RpcCall,
  deployment: Exclude<GuardDeployment, { family: 'mock' }>,
  at: { owner: string; basketId: string },
): Promise<ChainVault | null> {
  return deployment.family === 'solana'
    ? readSolanaVault(node, deployment, at)
    : readEvmVault(node, deployment, at);
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
    else {
      const deployment = deploymentsFor(chain, mock)?.[chain];
      const node = mock ? undefined : chainNode(chain);
      const derived = deployment ? derivedVault(deployment, owner, basketId) : null;
      if (!deployment) say({ state: 'unverified', why: 'no-deployment' });
      // The address and the number our server named are not the vault of this wallet for that
      // number: nothing is offered, whether or not there is a node to read.
      else if (!derived || !sameAddress(chain, derived, address)) say({ state: 'failed' });
      else if (deployment.family === 'mock') say({ state: 'unverified', why: 'mock' });
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

// A vault as it stands on its chain right now, read from this app's own node and not from our server,
// for the offer to finish a stopped buy with the cash in it (features/order/OrderScreen.tsx): whether
// auto-follow is on (then the keeper buys with the cash, and no order is made for it), and how much
// cash it holds (an order that finishes another in a browser that never reviewed the first is not
// offered for more than that). The vault is the one this app derives from the person's wallet and the
// plan's number.
//
// Solana only: the route that finishes a buy refuses an EVM chain. Where there is no node, no
// deployment, or the read fails, the answer is `unknown`, and the offer stands on what it stood on
// before: our server's refusals, and the person's review of the new order.

export type VaultNow =
  | { state: 'reading' }
  | { state: 'unknown' }
  | { state: 'read'; autoFollow: boolean; cashRaw: bigint };

type SolanaAt = Parameters<typeof readSolanaVaultCash>[1] & Parameters<typeof readSolanaVault>[1];

/** The read itself: null when the chain has no such vault. Throws when the node does not answer it. */
export async function readVaultNow(
  node: RpcCall,
  deployment: SolanaAt,
  at: { owner: string; basketId: string },
): Promise<{ autoFollow: boolean; cashRaw: bigint } | null> {
  const [vault, cashRaw] = await Promise.all([
    readSolanaVault(node, deployment, at),
    readSolanaVaultCash(node, deployment, at),
  ]);
  return vault ? { autoFollow: vault.autoFollow, cashRaw } : null;
}

/**
 * How long the read may take. A node that never answers must not hide the offer for as long as its
 * request hangs (`rpcAt` has no limit of its own): past this the answer is `unknown`.
 */
export const VAULT_READ_WAIT_MS = 5_000;

/** Reads it once per chain, owner and number, and only when `at` is given. */
export function useVaultNow(
  chain: ChainId | null,
  mock: boolean,
  at: { owner: string; basketId: string } | null,
): VaultNow {
  const [now, setNow] = useState<VaultNow>({ state: 'reading' });
  const owner = at?.owner ?? null;
  const basketId = at?.basketId ?? null;
  useEffect(() => {
    let mine = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const say = (next: VaultNow) => {
      if (mine) setNow(next);
    };
    const deployment = chain ? deploymentsFor(chain, mock)?.[chain] : undefined;
    const node = chain && !mock ? chainNode(chain) : undefined;
    if (!chain || !owner || !basketId) say({ state: 'reading' });
    else if (deployment?.family !== 'solana' || !node) say({ state: 'unknown' });
    else {
      say({ state: 'reading' });
      // Whichever comes first: the read, its failure, or the end of the wait. A late answer is not
      // taken: the offer was already made, or not, on `unknown`.
      let settled = false;
      const once = (next: VaultNow) => {
        if (settled) return;
        settled = true;
        say(next);
      };
      timer = setTimeout(() => once({ state: 'unknown' }), VAULT_READ_WAIT_MS);
      readVaultNow(node, deployment, { owner, basketId }).then(
        (read) => once(read ? { state: 'read', ...read } : { state: 'unknown' }),
        () => once({ state: 'unknown' }),
      );
    }
    return () => {
      mine = false;
      clearTimeout(timer);
    };
  }, [chain, mock, owner, basketId]);
  return now;
}
