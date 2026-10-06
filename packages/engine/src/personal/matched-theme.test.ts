import { describe, expect, it } from 'vitest';
import {
  attributeKey,
  filterOfSlug,
  MARKET_FILTER_BY,
  type MarketFilter,
  type MarketFilterBy,
  matchedSlug,
} from './market-filter';
import {
  attributeVocabularyOf,
  filterMatchOf,
  matchedListOf,
  matchStocks,
  shelfLabelsOf,
} from './matched-theme';
import { parseStockAttributes } from './stock-attributes';
import { WORDS } from './templates';
import { aiList, fixtureStocks, launchShelf } from './testing';
import type { ThemeList } from './theme-list';

// ENG-3, gate THEME-MATCHED: a filter names one sourced attribute of a tracked stock and the value it
// must carry, and pure code selects the stocks. Nothing here composes a plan: this is the selection,
// the list a theme sleeve is then filled from, and what the intake reads to name a filter.
//
// The attributes are `fixtureStocks` of ./testing.ts: a few rows written for the tests, each labelled
// as a fixture. TSMx writes two values another way than NVDAx does; LMTx and LLYx are on no shelf.

const shelf = launchShelf();
const stocks = fixtureStocks('solana');
const rows = stocks.stocks;
const ai = aiList();
const symbols = (filter: MarketFilter) => matchStocks(filter, rows).map((row) => row.symbol);
const slugOf = (by: MarketFilterBy, value: string): string => {
  const slug = matchedSlug({ by, value });
  if (slug === null) throw new Error(`no slug for ${value}`);
  return slug;
};
/** A list in another order, which depends only on the seed. */
const shuffled = <T>(items: readonly T[], key: (item: T) => string, seed: number): T[] => {
  const order = (text: string) =>
    [...text].reduce((n, ch) => (n * seed + ch.charCodeAt(0)) % 9973, seed);
  return [...items].sort((a, b) => order(key(a)) - order(key(b)));
};
const turned = (seed: number) => ({
  ...stocks,
  stocks: shuffled(rows, (row) => row.symbol, seed),
});

describe('the fixture attributes', () => {
  it('are valid on each chain, each stock under the symbol that chain’s shelf writes', () => {
    for (const chain of ['solana', 'base', 'robinhood'] as const) {
      const file = fixtureStocks(chain);
      expect(parseStockAttributes(structuredClone(file))).toEqual(file);
      expect(file.chain).toBe(chain);
      const listed = new Set(shelf.assets.filter((a) => a.chain === chain).map((a) => a.symbol));
      // A row is in the shelf's set exactly when the launch shelf lists its symbol there.
      for (const row of file.stocks)
        expect(row.sets.includes('shelf'), `${chain} ${row.symbol}`).toBe(listed.has(row.symbol));
      // Every row says it is a fixture: no source was read, and no field is supported.
      for (const row of file.stocks) {
        expect(row.sources.map((s) => s.title).join(' ')).toContain('MOCK');
        expect(row.unverified.length).toBe(9);
      }
    }
    expect(fixtureStocks('solana').stocks.map((row) => row.symbol)).toContain('NVDAx');
    expect(fixtureStocks('base').stocks.map((row) => row.symbol)).toContain('NVDAc');
    expect(fixtureStocks('robinhood').stocks.map((row) => row.symbol)).toContain('NVDA');
  });
});

describe('the filter: pure code selects the stocks', () => {
  it('matches by each kind of attribute, in the order of the symbols', () => {
    expect(symbols({ by: 'sector', value: 'Information Technology' })).toEqual([
      'AAPLx',
      'MSFTx',
      'NVDAx',
      'TSMx',
    ]);
    expect(symbols({ by: 'industry', value: 'Capital Markets' })).toEqual(['COINx', 'HOODx']);
    expect(symbols({ by: 'sub_industry', value: 'Systems Software' })).toEqual(['MSFTx']);
    expect(symbols({ by: 'keyword', value: 'cloud' })).toEqual(['AMZNx', 'GOOGLx', 'MSFTx']);
    // These four are every kind of filter there is.
    expect([...MARKET_FILTER_BY].sort()).toEqual(['industry', 'keyword', 'sector', 'sub_industry']);
  });

  it('holds two writings of one value equal: capitals, spaces, "&" and "and"', () => {
    // NVDAx writes "Semiconductors & Semiconductor Equipment", TSMx "... and ...".
    for (const value of [
      'Semiconductors & Semiconductor Equipment',
      'semiconductors and semiconductor equipment',
      'SEMICONDUCTORS  &  SEMICONDUCTOR EQUIPMENT',
    ])
      expect(symbols({ by: 'industry', value }), value).toEqual(['NVDAx', 'TSMx']);
    // NVDAx writes "ai chips", TSMx "AI chips".
    expect(symbols({ by: 'keyword', value: 'AI Chips' })).toEqual(['NVDAx', 'TSMx']);
    expect(symbols({ by: 'keyword', value: 'GLP-1' })).toEqual(['LLYx']);
  });

  it('reads the one attribute it names, and folds nothing but the writing', () => {
    // "Semiconductors" is a sub-industry here: not an industry, a sector or a keyword.
    expect(symbols({ by: 'sub_industry', value: 'Semiconductors' })).toEqual(['NVDAx', 'TSMx']);
    for (const by of ['sector', 'industry', 'keyword'] as const)
      expect(symbols({ by, value: 'Semiconductors' }), by).toEqual([]);
    expect(symbols({ by: 'sector', value: 'cloud' })).toEqual([]);
    // No plural, no synonym, no part of a value.
    expect(symbols({ by: 'keyword', value: 'data centers' })).toEqual(['NVDAx']);
    expect(symbols({ by: 'keyword', value: 'data center' })).toEqual([]);
    expect(symbols({ by: 'keyword', value: 'chips' })).toEqual([]);
    expect(symbols({ by: 'sector', value: 'Technology' })).toEqual([]);
    // A value with no letter or digit has nothing to match by.
    expect(symbols({ by: 'keyword', value: '&' })).toEqual([]);
    // Nor is a stock found by its own name or where it is based: a filter reads these four only.
    for (const by of MARKET_FILTER_BY)
      for (const value of ['NVDAx', 'NVDA', 'NVIDIA Corporation', 'United States'])
        expect(symbols({ by, value }), `${by} ${value}`).toEqual([]);
  });

  it('matches a fund by keyword only: never by sector, industry or sub-industry', () => {
    const funds = rows.filter((row) => row.kind === 'fund').map((row) => row.symbol);
    expect(funds.sort()).toEqual(['GLDx', 'QQQx', 'SPYx']);
    const vocabulary = attributeVocabularyOf(stocks);
    const classified = [
      ['sector', vocabulary.sectors],
      ['industry', vocabulary.industries],
      ['sub_industry', vocabulary.subIndustries],
    ] as const;
    for (const [by, values] of classified) {
      expect(values.length).toBeGreaterThan(0);
      for (const value of values)
        for (const symbol of symbols({ by, value }))
          expect(funds, `${by} ${value}`).not.toContain(symbol);
      // Not by what it tracks, by its name or by one of its own keywords either.
      for (const value of ['the price of gold', 'SPDR Gold Shares', 'gold', 'index fund'])
        expect(symbols({ by, value }), `${by} ${value}`).toEqual([]);
    }
    expect(symbols({ by: 'keyword', value: 'gold' })).toEqual(['GLDx']);
    expect(symbols({ by: 'keyword', value: 'index fund' })).toEqual(['QQQx', 'SPYx']);
  });

  it('gives the same stocks whatever order the rows and their keywords come in', () => {
    const vocabulary = attributeVocabularyOf(stocks);
    const filters: MarketFilter[] = [
      ...vocabulary.sectors.map((value) => ({ by: 'sector' as const, value })),
      ...vocabulary.industries.map((value) => ({ by: 'industry' as const, value })),
      ...vocabulary.subIndustries.map((value) => ({ by: 'sub_industry' as const, value })),
      ...vocabulary.keywords.map((value) => ({ by: 'keyword' as const, value })),
    ];
    expect(filters.length).toBeGreaterThan(40);
    for (const filter of filters) {
      const base = matchStocks(filter, rows);
      const names = base.map((row) => row.symbol);
      expect(names.length, filter.value).toBeGreaterThan(0);
      expect(names).toEqual([...names].sort());
      for (let seed = 1; seed <= 20; seed += 1) {
        const again = turned(seed).stocks;
        expect(matchStocks(filter, again)).toEqual(base);
        const reversed = again.map((row) => ({ ...row, keywords: [...row.keywords].reverse() }));
        expect(matchStocks(filter, reversed).map((row) => row.symbol)).toEqual(names);
      }
    }
  });

  it('takes a filter as it is named, or as a slug carries it', () => {
    const carried = filterOfSlug(slugOf('keyword', 'Cloud'));
    if (!carried) throw new Error('no filter');
    expect(carried).toEqual({ by: 'keyword', key: 'cloud' });
    expect(matchStocks(carried, rows)).toEqual(
      matchStocks({ by: 'keyword', value: 'Cloud' }, rows),
    );
    expect(matchStocks({ by: 'keyword', key: '' }, rows)).toEqual([]);
    expect(matchStocks({ by: 'keyword', value: 'cloud' }, [])).toEqual([]);
  });
});

describe('the matched list: what a theme sleeve is filled from', () => {
  const SEMIS = slugOf('industry', 'semiconductors and semiconductor equipment');
  const TECH = slugOf('sector', 'Information Technology');
  const UTILITIES = slugOf('sector', 'Utilities');

  it('is named as the first matching stock by symbol writes the value, with a line for each stock from its own row', () => {
    const list = matchedListOf(SEMIS, stocks);
    expect(list).toEqual({
      slug: 'matched-industry-semiconductors-semiconductor-equipment',
      name: {
        en: 'Semiconductors & Semiconductor Equipment',
        pt: 'Semiconductors & Semiconductor Equipment',
      },
      matched: {
        by: 'industry',
        key: 'semiconductors-semiconductor-equipment',
        value: 'Semiconductors & Semiconductor Equipment',
      },
      attributes: { version: 3, readOn: '2026-10-06' },
      members: [
        {
          symbol: 'NVDAx',
          reason: {
            en: 'NVIDIA Corporation: its industry is Semiconductors & Semiconductor Equipment',
            pt: 'NVIDIA Corporation: a indústria dela é Semiconductors & Semiconductor Equipment',
          },
        },
        {
          symbol: 'TSMx',
          reason: {
            en: 'Taiwan Semiconductor Manufacturing Company Limited: its industry is Semiconductors and Semiconductor Equipment',
            pt: 'Taiwan Semiconductor Manufacturing Company Limited: a indústria dela é Semiconductors and Semiconductor Equipment',
          },
        },
      ],
    });
    // The order of the rows decides nothing: not the members, not which writing names the list.
    for (let seed = 1; seed <= 20; seed += 1)
      expect(matchedListOf(SEMIS, turned(seed))).toEqual(list);
    // It has no curator and no status: nothing in it is a person's to confirm.
    expect(list).not.toHaveProperty('curator');
    expect(list).not.toHaveProperty('status');
  });

  it('says each kind of attribute in its own words, in both languages', () => {
    const why = (by: MarketFilterBy, value: string) =>
      matchedListOf(slugOf(by, value), stocks)?.members[0]?.reason;
    expect(why('sector', 'Health Care')).toEqual({
      en: 'Eli Lilly and Company: its sector is Health Care',
      pt: 'Eli Lilly and Company: o setor dela é Health Care',
    });
    expect(why('industry', 'Aerospace & Defense')).toEqual({
      en: 'Lockheed Martin Corporation: its industry is Aerospace & Defense',
      pt: 'Lockheed Martin Corporation: a indústria dela é Aerospace & Defense',
    });
    expect(why('sub_industry', 'Systems Software')).toEqual({
      en: 'Microsoft Corporation: its sub-industry is Systems Software',
      pt: 'Microsoft Corporation: a subindústria dela é Systems Software',
    });
    expect(why('keyword', 'GLP-1')).toEqual({
      en: 'Eli Lilly and Company: one of its business lines is glp-1',
      pt: 'Eli Lilly and Company: uma das linhas de negócio dela é glp-1',
    });
    // Each kind has its words, and none ends the sentence it is written into.
    for (const by of MARKET_FILTER_BY)
      for (const lang of ['en', 'pt'] as const) {
        expect(WORDS[lang].by[by].length).toBeGreaterThan(0);
        expect(WORDS[lang].itsBy[by]).not.toMatch(/[.!:]$/);
      }
  });

  it('has no member where no stock carries the value, or no attributes are given', () => {
    expect(matchedListOf(UTILITIES, stocks)).toEqual({
      slug: UTILITIES,
      name: { en: 'utilities', pt: 'utilities' },
      matched: { by: 'sector', key: 'utilities', value: null },
      attributes: { version: 3, readOn: '2026-10-06' },
      members: [],
    });
    for (const none of [null, undefined])
      expect(matchedListOf(TECH, none)).toEqual({
        slug: TECH,
        name: { en: 'information-technology', pt: 'information-technology' },
        matched: { by: 'sector', key: 'information-technology', value: null },
        attributes: null,
        members: [],
      });
  });

  it('is no list for a slug that names no filter', () => {
    for (const slug of [
      'ai',
      'matched-',
      'matched-country-brazil',
      'matched-industry-Aerospace',
      'matched-industry-aerospace-and-defense',
    ])
      expect(matchedListOf(slug, stocks), slug).toBeNull();
  });
});

describe('what the intake reads: labels, a filter’s match, the vocabulary', () => {
  it('shelfLabelsOf: each curated list with how many of its names the shelf lists on its chain', () => {
    expect(shelfLabelsOf([ai], shelf.assets)).toEqual([
      { slug: 'ai', name: { en: 'AI', pt: 'IA' }, status: 'confirmed', listed: 7 },
    ]);
    expect(shelfLabelsOf([], shelf.assets)).toEqual([]);
    // A name the chain does not list is not counted.
    const without = shelf.assets.filter((a) => a.id !== 'solana:amznx');
    expect(shelfLabelsOf([ai], without)[0]?.listed).toBe(6);
    // Nor is one listed on another chain only: the list is Solana's.
    const elsewhere = shelf.assets.filter((a) => a.chain !== 'solana');
    expect(shelfLabelsOf([ai], elsewhere)[0]?.listed).toBe(0);
    // A dollar-yield or cash token under a symbol is not a name, as the sleeve reads it. In the
    // order of the slugs, whatever order the lists come in; a proposed list says it is proposed.
    const mixed: ThemeList = {
      ...ai,
      slug: 'chips',
      status: 'proposed',
      name: { en: 'Chips', pt: 'Chips' },
      members: ['NVDAx', 'ZZZx', 'jlUSDC', 'USDC'].map((symbol) => ({
        symbol,
        reason: { en: 'a fixture', pt: 'um exemplo' },
      })),
    };
    const labels = shelfLabelsOf([mixed, ai], shelf.assets);
    expect(labels).toEqual([
      { slug: 'ai', name: { en: 'AI', pt: 'IA' }, status: 'confirmed', listed: 7 },
      { slug: 'chips', name: { en: 'Chips', pt: 'Chips' }, status: 'proposed', listed: 1 },
    ]);
    expect(shelfLabelsOf([ai, mixed], shelf.assets)).toEqual(labels);
  });

  it('filterMatchOf: the value as the attributes write it, and how many of its stocks the shelf lists', () => {
    const match = (by: MarketFilterBy, value: string, file = stocks, tokens = shelf.assets) =>
      filterMatchOf({ by, value }, file, tokens);
    expect(match('keyword', 'CLOUD')).toEqual({ value: 'cloud', listed: 3 });
    // TSMx carries it and Solana does not list TSMx: four stocks match, three are listed.
    expect(match('sector', 'information technology')).toEqual({
      value: 'Information Technology',
      listed: 3,
    });
    expect(match('industry', 'semiconductors and semiconductor equipment')).toEqual({
      value: 'Semiconductors & Semiconductor Equipment',
      listed: 1,
    });
    // Stocks carry it and the shelf lists none of them: a match, with nothing to hold yet.
    expect(match('industry', 'aerospace and defense')).toEqual({
      value: 'Aerospace & Defense',
      listed: 0,
    });
    // No stock carries it, or no attributes are given: no match.
    expect(match('sector', 'Utilities')).toBeNull();
    expect(filterMatchOf({ by: 'keyword', value: 'cloud' }, null, shelf.assets)).toBeNull();
    expect(filterMatchOf({ by: 'keyword', value: 'cloud' }, undefined, shelf.assets)).toBeNull();
    // Each chain by its own attributes and its own shelf: Robinhood Chain lists TSM.
    expect(match('sector', 'Information Technology', fixtureStocks('robinhood'))).toEqual({
      value: 'Information Technology',
      listed: 4,
    });
    const onBase = shelf.assets.filter((a) => a.chain === 'base');
    expect(match('keyword', 'cloud', stocks, onBase)).toEqual({ value: 'cloud', listed: 0 });
    expect(match('keyword', 'cloud', stocks, [])).toEqual({ value: 'cloud', listed: 0 });
    // A fund of gold is a gold token on the shelf, and counts as the sleeve counts it.
    expect(match('keyword', 'gold')).toEqual({ value: 'gold', listed: 1 });
    // The value is the one the matched list is named by, and the count is of its members.
    for (const [by, value] of [
      ['keyword', 'Cloud'],
      ['sector', 'Information Technology'],
      ['industry', 'aerospace and defense'],
    ] as const) {
      const list = matchedListOf(slugOf(by, value), stocks);
      const found = match(by, value);
      expect(found?.value).toBe(list?.name.en);
      expect(found?.listed).toBeLessThanOrEqual(list?.members.length ?? 0);
    }
  });

  it('attributeVocabularyOf: every value once as it is written, and no stock by any name', () => {
    const vocabulary = attributeVocabularyOf(stocks);
    expect(vocabulary.sectors).toEqual([
      'Communication Services',
      'Consumer Discretionary',
      'Financials',
      'Health Care',
      'Industrials',
      'Information Technology',
    ]);
    // Two writings of one value are one entry, as the first stock by symbol writes it.
    expect(vocabulary.industries).toContain('Semiconductors & Semiconductor Equipment');
    expect(vocabulary.industries).not.toContain('Semiconductors and Semiconductor Equipment');
    expect(vocabulary.keywords).toContain('ai chips');
    expect(vocabulary.keywords).not.toContain('AI chips');
    // A fund gives its keywords and nothing else.
    expect(vocabulary.keywords).toEqual(expect.arrayContaining(['gold', 'index fund']));
    const lists = Object.values(vocabulary);
    for (const list of lists) {
      const keys = list.map(attributeKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual([...keys].sort());
    }
    // A model is shown this, and must never see an asset: no symbol, no ticker, no company's name,
    // and nothing else of a row either.
    const all = lists.flat();
    const keys = new Set(all.map(attributeKey));
    for (const row of rows)
      for (const name of [row.symbol, row.underlying, row.company]) {
        expect(all, name).not.toContain(name);
        expect(keys.has(attributeKey(name)), name).toBe(false);
      }
    for (const other of ['United States', 'Taiwan', 'the price of gold', 'common', 'fund', 'shelf'])
      expect(all, other).not.toContain(other);
    expect(JSON.stringify(vocabulary)).not.toMatch(/example\.com|MOCK/);
    // Every value in it is one a filter matches, by the same writing, and a slug can carry.
    const byField = [
      ['sector', vocabulary.sectors],
      ['industry', vocabulary.industries],
      ['sub_industry', vocabulary.subIndustries],
      ['keyword', vocabulary.keywords],
    ] as const;
    for (const [by, values] of byField)
      for (const value of values) {
        expect(matchStocks({ by, value }, rows).length, `${by} ${value}`).toBeGreaterThan(0);
        expect(filterMatchOf({ by, value }, stocks, shelf.assets)?.value).toBe(value);
        expect(filterOfSlug(slugOf(by, value))).toEqual({ by, key: attributeKey(value) });
      }
    // The same whatever order the rows come in, and empty with no attributes.
    for (let seed = 1; seed <= 20; seed += 1)
      expect(attributeVocabularyOf(turned(seed))).toEqual(vocabulary);
    const none = { sectors: [], industries: [], subIndustries: [], keywords: [] };
    expect(attributeVocabularyOf(null)).toEqual(none);
    expect(attributeVocabularyOf(undefined)).toEqual(none);
  });
});
