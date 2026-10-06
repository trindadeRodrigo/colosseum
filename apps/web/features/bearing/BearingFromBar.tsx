'use client';
import type { ReactNode } from 'react';
import { useAccount } from '../account/AccountProvider';
import { BearingProvider } from './BearingProvider';

// Bearing inside the app: it follows the chain the app's bar is on (gate CHAIN-SWITCH), which the
// account says: the chain of a person who has one, or the one someone signed out is looking at.

export function BearingFromBar({ children }: { children: ReactNode }) {
  const { account, chain } = useAccount();
  // undefined while the account loads: the provider waits for it before it picks a chain
  const barChain = account.status === 'loading' ? undefined : chain;
  return (
    <BearingProvider barChain={barChain} followsBar>
      {children}
    </BearingProvider>
  );
}
