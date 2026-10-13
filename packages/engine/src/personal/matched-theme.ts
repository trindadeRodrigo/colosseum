import type { BasketAsset, ChainId } from '@colosseum/schemas';
import {
  attributeKey,
  type FilterMatch,
  filterOfSlug,
  type MarketFilter,
  type MarketFilterBy,
  type ShelfLabel,
} from './market-filter';
import { byName } from './money';
import { STOCK_KEYWORDS } from './params';
import { sleeveOfClass } from './registry';
import type { StockAttributes, StockAttributesFile } from './stock-attributes';
import { WORDS } from './templates';
import type { ThemeList } from './theme-list';

// A matched theme (gate THEME-MATCHED): the second way to fill a theme sleeve. A filter names one
// sourced attribute of a tracked stock and the value it must carry; this file selects the stocks, and
// nothing else does. The intake, or a model, names only the filter: it is never handed a symbol or a
// company's name (`attributeVocabularyOf`), and it picks no asset. The theme sleeve then holds the
// stocks as it holds a curated list, and says on every line that they are matched, not curated.
//
// Pure: the same filter over the same rows gives the same stocks, whatever order the rows come in.

/** A filter as it is named (the value as written), or as a slug carries it (the value's key). */
export type FilterRead = MarketFilter | { by: MarketFilterBy; key: string };

const keyOf = (filter: FilterRead): string =>
  'key' in filter ? filter.key : attributeKey(filter.value);

/** The field of a row each kind of filter reads. */
const FIELD = {
  sector: 'sector',
  industry: 'industry',
  sub_industry: 'subIndustry',
  keyword: 'keywords',
} as const satisfies Record<MarketFilterBy, keyof StockAttributes>;

/**
 * What a row writes for one attribute, as far as a filter may read it.
 * - Nothing where the row marks that field unverified: a filter matches only on what a source read
 *   supports, since the plan says the match is from sourced attributes.
 * - A fund has no sector, industry or sub-industry of its own, so it is matched by keyword only. So
 *   is a preferred stock: its row carries its issuer's classification, and a person who names a
 *   sector asks for its companies, not for a share that pays a set dividend.
 */
function writtenBy(row: StockAttributes, by: MarketFilterBy): string[] {
  if (row.unverified.includes(FIELD[by])) return [];
  if (by === 'keyword') return row.keywords;
  if (row.kind === 'preferred') return [];
  const value = by === 'sector' ? row.sector : by === 'industry' ? row.industry : row.subIndustry;
  return value === null ? [] : [value];
}

/** The value a filter asks for as this row writes it, or null when the row does not carry it. */
const carried = (row: StockAttributes, by: MarketFilterBy, key: string): string | null =>
  writtenBy(row, by).find((value) => attributeKey(value) === key) ?? null;

/**
 * The stocks a filter matches: the rows whose attribute carries its value, two writings of one value
 * held equal as `attributeKey` holds them and nothing else folded. In the order of their symbols, so
 * the order of the rows decides nothing. The rows are one file's: a symbol is there once.
 *
 * A keyword selects nothing unless at least `STOCK_KEYWORDS.carriers` rows carry it. A keyword one
 * stock alone carries would be that stock's name by another word, and whoever named it, a model
 * included, would have picked the stock.
 */
export function matchStocks(
  filter: FilterRead,
  rows: readonly StockAttributes[],
): StockAttributes[] {
  const key = keyOf(filter);
  if (key === '') return [];
  const found = byName(
    rows.filter((row) => carried(row, filter.by, key) !== null),
    (row) => row.symbol,
  );
  return filter.by === 'keyword' && found.length < STOCK_KEYWORDS.carriers ? [] : found;
}

/**
 * What a matched theme sleeve is filled from, in the shape a curated list has: a name, and members by
 * the symbol the shelf lists each under, each with why it is there. It has no curator and no status:
 * its membership is the sourced attributes'.
 */
export type MatchedList = {
  slug: string;
  /**
   * The value as the attributes write it, taken from the first matching stock by symbol ("Aerospace &
   * Defense"): the same in each language, as these names are not translated. The key of the slug
   * where no stock carries it.
   */
  name: { en: string; pt: string };
  /** What it was matched by, the key of the value, and the value as written (null: none carries it). */
  matched: { by: MarketFilterBy; key: string; value: string | null };
  /** The attributes it was matched from: their version, and the day their sources were read. Null: none were given. */
  attributes: { version: number; readOn: string } | null;
  /** Each matched stock, with one line built from its own row: "<company>: its industry is <value>". */
  members: { symbol: string; reason: { en: string; pt: string } }[];
};

/** What fills a theme sleeve: a curated list (gate THEMES) or a matched one (gate THEME-MATCHED). */
export type SleeveList = ThemeList | MatchedList;

export const isMatchedList = (list: SleeveList): list is MatchedList => 'matched' in list;

/**
 * The matched list of a slug, from the attributes of the person's chain. Null when the slug names no
 * filter (it is a curated list's, or not written as `matchedSlug` writes it). A list with no member is
 * a valid answer: no stock carries the value, or no attributes were given.
 */
export function matchedListOf(
  slug: string,
  file: StockAttributesFile | null | undefined,
): MatchedList | null {
  const filter = filterOfSlug(slug);
  if (!filter) return null;
  const { by, key } = filter;
  const rows = file ? matchStocks(filter, file.stocks) : [];
  const [first] = rows;
  const value = first ? carried(first, by, key) : null;
  // Where no stock carries the value, the key's own words name it.
  const name = value ?? key.replaceAll('-', ' ');
  // A fund's keywords say what it holds or is, not a line of business.
  const whyOf = (row: StockAttributes, lang: 'en' | 'pt') =>
    `${row.company}: ${
      by === 'keyword' && row.kind === 'fund' ? WORDS[lang].fundIs : WORDS[lang].itsBy[by]
    } ${carried(row, by, key) ?? name}`;
  return {
    slug,
    name: { en: name, pt: name },
    matched: { by, key, value },
    attributes: file ? { version: file.version, readOn: file.readOn } : null,
    members: rows.map((row) => ({
      symbol: row.symbol,
      reason: { en: whyOf(row, 'en'), pt: whyOf(row, 'pt') },
    })),
  };
}

/**
 * The symbols a theme can name on a chain: a token the shelf lists there that is not a dollar-yield or
 * cash token. This is the test the theme sleeve applies before it asks whether the person can hold
 * the token (`namesOf`).
 */
function nameable(tokens: readonly BasketAsset[], chain: ChainId): Set<string> {
  return new Set(
    tokens
      .filter(
        (a) => a.chain === chain && a.cls !== 'cash' && sleeveOfClass(a.cls) !== 'dollarYield',
      )
      .map((a) => a.symbol),
  );
}

/**
 * The curated labels as the intake needs them, in the order of their slugs: each with how many of its
 * names the shelf lists on its chain. A label with none holds nothing yet.
 */
export function shelfLabelsOf(lists: ThemeList[], tokens: BasketAsset[]): ShelfLabel[] {
  return byName(lists, (list) => `${list.slug} ${list.chain}`).map((list) => {
    const listed = nameable(tokens, list.chain);
    return {
      slug: list.slug,
      name: { en: list.name.en, pt: list.name.pt },
      status: list.status,
      listed: list.members.filter((m) => listed.has(m.symbol)).length,
    };
  });
}

/**
 * What a filter matches on the chain of the attributes: the value as they write it (in the first
 * matching stock by symbol), and how many of the matching stocks the shelf lists there. Null when no
 * stock carries the value, or no attributes were given.
 */
export function filterMatchOf(
  filter: MarketFilter,
  file: StockAttributesFile | null | undefined,
  tokens: BasketAsset[],
): FilterMatch | null {
  if (!file) return null;
  const rows = matchStocks(filter, file.stocks);
  const [first] = rows;
  if (!first) return null;
  const listed = nameable(tokens, file.chain);
  return {
    value: carried(first, filter.by, attributeKey(filter.value)) ?? filter.value,
    listed: rows.filter((row) => listed.has(row.symbol)).length,
  };
}

/**
 * The companies the attributes know on their chain, each by its name, its ticker and its token's
 * symbol, in the order of the symbols: what the intake holds a name a person rules out to
 * (`IntakeInput.names`). Never shown to a model.
 */
export function companyNamesOf(file: StockAttributesFile | null | undefined): string[] {
  const rows = file ? byName(file.stocks, (row) => row.symbol) : [];
  return [...new Set(rows.flatMap((row) => [row.company, row.underlying, row.symbol]))];
}

/**
 * Every value the attributes carry, by what a filter reads: what a model is shown so that it can name
 * a filter. Only these four fields are read, so no symbol and no company's name is in it. Each value
 * once however it is written, as the first stock by symbol writes it, in the order of its key.
 */
export function attributeVocabularyOf(file: StockAttributesFile | null | undefined): {
  sectors: string[];
  industries: string[];
  subIndustries: string[];
  keywords: string[];
} {
  const rows = file ? byName(file.stocks, (row) => row.symbol) : [];
  const valuesOf = (by: MarketFilterBy): string[] => {
    const written = new Map<string, string>();
    for (const row of rows)
      for (const value of writtenBy(row, by)) {
        const key = attributeKey(value);
        // Only a value a filter can select by: one with a letter or digit, that is not unverified on
        // its row, and for a keyword that enough stocks carry (`matchStocks`).
        if (key !== '' && !written.has(key) && matchStocks({ by, key }, rows).length > 0)
          written.set(key, value);
      }
    return byName([...written], ([key]) => key).map(([, value]) => value);
  };
  return {
    sectors: valuesOf('sector'),
    industries: valuesOf('industry'),
    subIndustries: valuesOf('sub_industry'),
    keywords: valuesOf('keyword'),
  };
}
