'use client';
import { usePathname } from 'next/navigation';
import { useBearing } from './BearingProvider';
import { DexWait } from './DexPage';
import { LendingWait } from './LendingPage';
import { NotOnChain } from './parts';
import { SimWait } from './SimPage';
import { StableWait } from './StablePage';

// A Bearing page's wait before the page itself runs (its `loading.tsx`). The address says which page
// is coming, so the wait is that page's own: its figures by their labels, the simulation's form, or
// the sentence of a page not collected on the chain. The page's wait takes over without a box moving.

export function RouteWait() {
  const { chain } = useBearing();
  const page = usePathname().split('/').filter(Boolean).at(-1);
  if (page === 'simulation') return <SimWait />;
  if (page === 'lending' || page === 'stablecoins') {
    if (chain !== 'solana') return <NotOnChain />;
    return page === 'lending' ? <LendingWait /> : <StableWait />;
  }
  return <DexWait />;
}
