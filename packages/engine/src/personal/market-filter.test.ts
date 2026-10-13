import { describe, expect, it } from 'vitest';
import {
  attributeKey,
  filterOfSlug,
  isMatchedSlug,
  MARKET_FILTER_BY,
  MarketFilter,
  matchedSlug,
} from './market-filter';

describe('a market filter (gate THEME-MATCHED)', () => {
  it('holds two writings of one value equal, and folds nothing else', () => {
    expect(attributeKey('Aerospace & Defense')).toBe('aerospace-defense');
    expect(attributeKey('aerospace and defense')).toBe('aerospace-defense');
    expect(attributeKey('  Semiconductors &  Semiconductor Equipment ')).toBe(
      'semiconductors-semiconductor-equipment',
    );
    expect(attributeKey('GLP-1')).toBe('glp-1');
    expect(attributeKey('Inteligência artificial')).toBe('inteligencia-artificial');
    // No plural and no synonym: these are two values.
    expect(attributeKey('data centers')).not.toBe(attributeKey('data center'));
    expect(attributeKey('&')).toBe('');
  });

  it('writes a filter as a slug and reads it back', () => {
    const cases: [MarketFilter, string][] = [
      [{ by: 'industry', value: 'Aerospace & Defense' }, 'matched-industry-aerospace-defense'],
      [{ by: 'keyword', value: 'GLP-1' }, 'matched-keyword-glp-1'],
      [{ by: 'sector', value: 'Health Care' }, 'matched-sector-health-care'],
      [{ by: 'sub_industry', value: 'Semiconductors' }, 'matched-subindustry-semiconductors'],
    ];
    for (const [filter, slug] of cases) {
      expect(matchedSlug(filter)).toBe(slug);
      expect(isMatchedSlug(slug)).toBe(true);
      expect(filterOfSlug(slug)).toEqual({ by: filter.by, key: attributeKey(filter.value) });
    }
  });

  it('gives every kind of filter its own slug, in any order of the kinds', () => {
    const slugs = MARKET_FILTER_BY.map((by) => matchedSlug({ by, value: 'Industry Sector' }));
    expect(new Set(slugs).size).toBe(MARKET_FILTER_BY.length);
    for (const [i, by] of MARKET_FILTER_BY.entries())
      expect(filterOfSlug(slugs[i] as string)).toEqual({ by, key: 'industry-sector' });
  });

  it('reads no filter from a curated slug or a slug it would not write', () => {
    expect(isMatchedSlug('ai')).toBe(false);
    for (const slug of [
      'ai',
      'semiconductors',
      'matched-',
      'matched-industry-',
      'matched-industry',
      'matched-country-brazil',
      'matched-industry-Aerospace',
      'matched-industry-aerospace-and-defense',
      'matched-keyword-glp--1',
    ])
      expect(filterOfSlug(slug)).toBeNull();
  });

  it('makes no slug from a value with nothing to match by', () => {
    expect(matchedSlug({ by: 'keyword', value: '&' })).toBeNull();
    expect(MarketFilter.safeParse({ by: 'keyword', value: '   ' }).success).toBe(false);
    expect(MarketFilter.safeParse({ by: 'country', value: 'Brazil' }).success).toBe(false);
    expect(MarketFilter.safeParse({ by: 'keyword', value: 'cloud', pick: 'NVDA' }).success).toBe(
      false,
    );
  });
});
