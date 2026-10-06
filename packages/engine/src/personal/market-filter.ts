import { z } from 'zod';

// A filter over the sourced attributes of the tracked stocks (gate THEME-MATCHED): how an ask that no
// curated label covers is served without a model picking an asset. The model, or the intake's fixed
// word lists, name only the filter ("defense" is industry: Aerospace & Defense; "obesity drugs" is
// keyword: GLP-1). Pure code then selects the stocks whose attributes carry that value, and the theme
// sleeve holds them as it holds a curated list, said as matched, not curated.
//
// The filter travels in the sheet as the theme sleeve's slug, so a stored sheet says by itself what it
// was matched by: `matched-industry-aerospace-defense`, `matched-keyword-glp-1`. A curated list never
// takes a slug that starts with `matched-`.
//
// This file is the one contract between the intake (which names a filter) and the theme sleeve (which
// fills it). It imports nothing of either.

/** What a filter reads: a stock's sector, industry or sub-industry (GICS-style), or a business-line keyword. */
export const MARKET_FILTER_BY = ['sector', 'industry', 'sub_industry', 'keyword'] as const;
export type MarketFilterBy = (typeof MARKET_FILTER_BY)[number];

/** LOCAL TYPE. One attribute and the value it must carry, as written ("Aerospace & Defense", "GLP-1"). */
export const MarketFilter = z
  .object({
    by: z.enum(MARKET_FILTER_BY),
    value: z.string().trim().min(1).max(80),
  })
  .strict();
export type MarketFilter = z.infer<typeof MarketFilter>;

/**
 * How two writings of one value are held equal: lower case, no accents, words joined by a hyphen, and
 * no "and" or "&" ("Aerospace & Defense" and "aerospace and defense" are `aerospace-defense`). Nothing
 * else is folded: no plural, no synonym. A value matches only where its key is the attribute's key.
 */
export const attributeKey = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && word !== 'and')
    .join('-');

/** A theme sleeve whose slug starts with this is filled by a filter, not from a curated list. */
export const MATCHED_PREFIX = 'matched-';
const BY_IN_SLUG: Record<MarketFilterBy, string> = {
  sector: 'sector',
  industry: 'industry',
  sub_industry: 'subindustry',
  keyword: 'keyword',
};

export const isMatchedSlug = (slug: string): boolean => slug.startsWith(MATCHED_PREFIX);

/** The slug of the theme sleeve a filter fills. Null when the value has no letter or digit to match by. */
export function matchedSlug(filter: MarketFilter): string | null {
  const key = attributeKey(filter.value);
  return key === '' ? null : `${MATCHED_PREFIX}${BY_IN_SLUG[filter.by]}-${key}`;
}

/**
 * The filter a matched slug names: what it reads, and the key of its value (`attributeKey`). Null for
 * any other slug, and for one that is not written as `matchedSlug` writes it.
 */
export function filterOfSlug(slug: string): { by: MarketFilterBy; key: string } | null {
  if (!isMatchedSlug(slug)) return null;
  const rest = slug.slice(MATCHED_PREFIX.length);
  for (const by of MARKET_FILTER_BY) {
    const head = `${BY_IN_SLUG[by]}-`;
    if (!rest.startsWith(head)) continue;
    const key = rest.slice(head.length);
    return key !== '' && attributeKey(key) === key ? { by, key } : null;
  }
  return null;
}

/**
 * A curated stock label on the person's chain (gate THEMES), as the intake needs it. `listed` is how
 * many of its names the shelf lists on that chain: a label with none holds nothing yet.
 */
export type ShelfLabel = {
  slug: string;
  name: { en: string; pt: string };
  status: 'proposed' | 'confirmed';
  listed: number;
};

/**
 * What a filter matches on the person's chain: the value as the attributes write it ("Aerospace &
 * Defense"), and how many of the stocks that carry it the shelf lists there.
 */
export type FilterMatch = { value: string; listed: number };
