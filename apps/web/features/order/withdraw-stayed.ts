'use client';
import type { ChainId, OrderDetail } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { readVault } from '../shared/shared-api';
import type { SharedTerms } from '../shared/terms';

// A withdrawal that is done, held to the vault itself. A step that takes all of a token can confirm
// and still leave it behind: on an EVM chain "everything" is the contract's `withdrawAll`, which
// passes over a token it cannot move and tells the order nothing. So once the order is done the vault
// is read again (GET /v1/vaults/{chain}/{address}), and a token a confirmed step was to take whole
// that the vault still holds is said to have stayed. The order is never called plainly done before
// that read answers, nor when it does not.

export type Stayed =
  /** Not a withdrawal that is done: nothing to ask. */
  | { kind: 'none' }
  | { kind: 'reading' }
  /** The tokens that stayed, by asset id: empty when every one left. */
  | { kind: 'read'; assets: string[] }
  /** The vault could not be read again: what stayed is not known. */
  | { kind: 'unread' };

/** The tokens the order's confirmed steps were to take whole. */
export const takenWhole = (order: OrderDetail): string[] => [
  ...new Set(
    order.legs
      .filter((leg) => leg.status === 'confirmed')
      .flatMap((leg) => leg.withdrawals ?? [])
      .filter((w) => w.amountRaw === null)
      .map((w) => w.asset),
  ),
];

export function useStayed(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  order: OrderDetail | null,
  terms: SharedTerms | undefined,
  chain: ChainId | undefined,
): Stayed {
  const [stayed, setStayed] = useState<Stayed>({ kind: 'none' });
  const vault = terms?.kind === 'withdraw' ? terms.vault : null;
  const whole = order?.status === 'done' && vault ? takenWhole(order).join('|') : null;
  useEffect(() => {
    if (whole === null || !vault || !chain) return setStayed({ kind: 'none' });
    if (whole === '') return setStayed({ kind: 'read', assets: [] });
    let live = true;
    setStayed({ kind: 'reading' });
    readVault(apiFetch, chain, vault).then((read) => {
      if (!live) return;
      if (read.kind !== 'read') return setStayed({ kind: 'unread' });
      const held = [read.value.vault.cash, ...read.value.vault.positions];
      setStayed({
        kind: 'read',
        assets: whole
          .split('|')
          .filter((asset) => held.some((h) => h.asset === asset && !/^0+$/.test(h.raw))),
      });
    });
    return () => {
      live = false;
    };
  }, [apiFetch, chain, vault, whole]);
  return stayed;
}
