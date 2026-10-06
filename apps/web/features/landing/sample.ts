import type { PinSource } from '../../components/ui/provenance';

// The two sample people of his showcase (goal-showcase-case.md), and every figure their cases show.
// All of it is MOCK: made up to show how the same pieces fit two lives, worked out once from his
// prototype's sample weights (hero-3d.html, `MOCK`) and written down here as the amounts it printed.
// There is no rate in this file: what a figure stands on is said by its pin, with `provenance: 'mock'`,
// so the page can never show one as live. The words are the dictionary's (`landing.show`).

/** What every figure of the showcase is handed: sample, not live. */
export const SAMPLE: PinSource = {
  source: 'sample',
  fetchedAt: '2026-10-01T00:00:00Z',
  method: 'illustrative weights v1, hero-3d.html',
  provenance: 'mock',
};

/** The cash token and the stock tokens the sample legs name: tickers, not words to translate. */
export const TICKERS = { cash: 'USDC', stocks: 'SPYx, QQQx' } as const;

/** A part of a sample plan: its share, and the chart colour of its place in the bar. */
export type SampleLeg = { weightBps: number; chart: 1 | 2 | 3 | 4 };

export const TRIP = {
  legs: [
    { weightBps: 1500, chart: 1 },
    { weightBps: 5500, chart: 2 },
    { weightBps: 3000, chart: 3 },
  ] satisfies SampleLeg[],
  /** What the person puts in each month, in dollars. */
  saveUsd: 106,
  /** What each of the three trip months pays out, in dollars. */
  payoutUsd: 1000,
  months: 27,
  /** Dollars earned on top of what was put in, by the trip. */
  earnedUsd: 127,
  oddsPct: 97,
  /** The balance at the end of each month: 27 months of saving, then three months of $1,000. */
  balances: [
    107, 214, 321, 429, 537, 645, 754, 863, 972, 1082, 1192, 1303, 1413, 1524, 1636, 1748, 1860,
    1972, 2085, 2198, 2312, 2425, 2540, 2654, 2769, 2884, 3000, 2009, 1015, 19,
  ],
  /** Months as `YYYY-MM`, written out in the language of the view. */
  start: '2026-10',
  payoutFrom: '2029-01',
  end: '2029-03',
} as const;

export const GROWTH = {
  legs: [
    { weightBps: 2500, chart: 1 },
    { weightBps: 2000, chart: 2 },
    { weightBps: 4500, chart: 3 },
    { weightBps: 1000, chart: 4 },
  ] satisfies SampleLeg[],
  addUsd: 120,
  baseUsd: 37_484,
  baseWhen: '2031-12',
  oddsPct: 71,
  dropPct: 25,
  targetUsd: 35_000,
  /** Every third month from Oct 2026 to Dec 2031 (63 months), then the last: base, weak and strong. */
  base: [
    20000, 20701, 21414, 22138, 22875, 23625, 24387, 25161, 25949, 26750, 27565, 28393, 29236,
    30092, 30963, 31848, 32749, 33665, 34596, 35542, 36505, 37484,
  ],
  weak: [
    20000, 19635, 19871, 20201, 20579, 20990, 21424, 21876, 22344, 22826, 23320, 23826, 24342,
    24868, 25404, 25950, 26505, 27070, 27643, 28225, 28817, 29417,
  ],
  strong: [
    20000, 21825, 23076, 24262, 25427, 26590, 27759, 28940, 30136, 31349, 32582, 33836, 35113,
    36413, 37737, 39087, 40463, 41866, 43297, 44756, 46245, 47763,
  ],
  start: '2026-10',
  end: '2031-12',
} as const;
