'use client';
import type { ChainId } from '@colosseum/schemas';
import { type ReactNode, useCallback } from 'react';
import { useAccount } from '../account/AccountProvider';
import { BearingProvider } from './BearingProvider';

// Bearing inside the app: it follows the chain the app's bar is on (gate CHAIN-SWITCH), which the
// account says: the chain of a person who has one, or the one someone signed out is looking at. For
// someone signed out the toggle on the page moves the bar too, so the two never disagree. Signed in,
// it does not: the bar's chain is where that person's plans are made, and the toggle only filters the
// page.

export function BearingFromBar({ children }: { children: ReactNode }) {
  const { account, chain, choose } = useAccount();
  const moveBar = useCallback((next: ChainId) => void choose(next), [choose]);
  // undefined while the account loads: the provider waits for it before it picks a chain
  const barChain = account.status === 'loading' ? undefined : chain;
  return (
    <BearingProvider
      barChain={barChain}
      followsBar
      moveBar={account.status === 'signed-out' ? moveBar : undefined}
    >
      {children}
    </BearingProvider>
  );
}
