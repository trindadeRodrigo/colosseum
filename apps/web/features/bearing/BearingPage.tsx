'use client';
import { DexPage } from './DexPage';
import { LendingPage } from './LendingPage';
import type { PageId } from './pages';
import { SimPage } from './SimPage';
import { StablePage } from './StablePage';

/** The page for an id of the side menu. */
export function BearingPage({ page }: { page: PageId }) {
  if (page === 'stocks' || page === 'commodities') return <DexPage key={page} page={page} />;
  if (page === 'stablecoins') return <StablePage />;
  if (page === 'lending') return <LendingPage />;
  return <SimPage />;
}
