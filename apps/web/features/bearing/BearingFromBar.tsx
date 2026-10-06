'use client';
import type { ChainId } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { useAccount } from '../account/AccountProvider';
import { BearingProvider } from './BearingProvider';

// Bearing inside the app: it follows the chain the app's bar is on. The account says the chain of a
// person who has one; the bar's switcher (gate CHAIN-SWITCH) adds the chain someone signed out is
// looking at as `chain`, read here when the account value carries it.

export function BearingFromBar({ children }: { children: ReactNode }) {
  const value = useAccount();
  const looking = (value as { chain?: ChainId | null }).chain ?? null;
  // undefined while the account loads: the provider waits for it before it picks a chain
  const barChain =
    value.account.status === 'loading'
      ? undefined
      : (looking ?? (value.account.status === 'ready' ? value.account.chain : null));
  return (
    <BearingProvider barChain={barChain} followsBar>
      {children}
    </BearingProvider>
  );
}
