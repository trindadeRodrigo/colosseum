// A plan's own page (/portfolio/plan/<chain>/<address>), in English. The frame takes the two keys
// below; the page's builder adds the rest here, one key a line.

export const plan = {
  /** The browser tab's name for the page. */
  label: 'A plan',
  /** The page's title. */
  title: 'This plan over time.',
};

export type Plan = typeof plan;
