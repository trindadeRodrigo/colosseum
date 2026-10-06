// The pages of Bearing's analytics, in the order of the side menu (Rodrigo's Analytics 2.0). Their
// names and their one line each are in the dictionary (i18n, `bearing.pages`).

export const PAGES = [
  { id: 'stocks', mark: 'St' },
  { id: 'commodities', mark: 'Co' },
  { id: 'stablecoins', mark: 'Sc' },
  { id: 'lending', mark: 'Le' },
  { id: 'simulation', mark: 'Si' },
] as const;

export type PageId = (typeof PAGES)[number]['id'];
export const PAGE_IDS: readonly string[] = PAGES.map((p) => p.id);
export const isPageId = (s: string): s is PageId => PAGE_IDS.includes(s);

export const METHODOLOGY = 'methodology' as const;

/** The section's address: /analytics/<page>. */
export const href = (id: string) => `/analytics/${id}`;
