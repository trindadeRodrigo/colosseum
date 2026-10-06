// The pages of Bearing's analytics, in the order of the side menu (Rodrigo's Analytics 2.0). Each lede
// is the one line of the page in the display face.

export const PAGES = [
  {
    id: 'stocks',
    label: 'Stocks',
    mark: 'St',
    lede: 'What it costs to leave a stock, and how much the pools can take.',
  },
  {
    id: 'commodities',
    label: 'Commodities',
    mark: 'Co',
    lede: 'What it costs to leave gold, and how much the pools can take.',
  },
  {
    id: 'stablecoins',
    label: 'Stablecoins',
    mark: 'Sc',
    lede: 'How much of each stablecoin is lent out, and how much you could withdraw now.',
  },
  {
    id: 'lending',
    label: 'Lending',
    mark: 'Le',
    lede: 'If the collateral had to be sold today, how much of it the pools would take.',
  },
  {
    id: 'simulation',
    label: 'Simulation',
    mark: 'Si',
    lede: 'Sell a position now: what you would lose, and the best way out.',
  },
] as const;

export type PageId = (typeof PAGES)[number]['id'];
export const PAGE_IDS: readonly string[] = PAGES.map((p) => p.id);
export const isPageId = (s: string): s is PageId => PAGE_IDS.includes(s);

export const METHODOLOGY = {
  id: 'methodology',
  label: 'Methodology',
  lede: 'How every figure on these pages is measured, and what it is not.',
} as const;

/** The section's address: /analytics/<page>. */
export const href = (id: string) => `/analytics/${id}`;
