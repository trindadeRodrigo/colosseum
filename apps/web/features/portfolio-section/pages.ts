import type { ChainId } from '@colosseum/schemas';

// The pages of the portfolio section, in the order of the side menu. Their names are in the section's
// dictionary (i18n/portfolio), each page's in its own file. A plan's own page is not in the menu: it
// is opened from the plan's card.

export const PAGES = [
  { id: 'overview', mark: 'Ov' },
  { id: 'rebalancing', mark: 'Re' },
  { id: 'exposure', mark: 'Ex' },
] as const;

export type PageId = (typeof PAGES)[number]['id'];

export const METHODOLOGY = 'methodology' as const;
export const PLAN = 'plan' as const;

/** Every page of the section, the two that are not in the menu's list among them. */
export type SectionPage = PageId | typeof METHODOLOGY | typeof PLAN;

/** Where the section lives. */
export const SECTION = '/portfolio';

/** A page's address: the overview is the section's own, the others are under it. */
export const href = (id: PageId | typeof METHODOLOGY): string =>
  id === 'overview' ? SECTION : `${SECTION}/${id}`;

/** The page of one plan: the vault it is held in, on its chain. */
export const planHref = (chain: ChainId, address: string): string =>
  `${SECTION}/${PLAN}/${chain}/${encodeURIComponent(address)}`;

/** Which page an address of the section is. One the section does not know is the overview. */
export function pageOf(pathname: string): SectionPage {
  const [, section, page] = pathname.split('/');
  if (`/${section}` !== SECTION || page === undefined || page === '') return 'overview';
  if (page === METHODOLOGY || page === PLAN) return page;
  return PAGES.find((p) => p.id === page)?.id ?? 'overview';
}
