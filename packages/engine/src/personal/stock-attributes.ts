import { ChainId } from '@colosseum/schemas';
import { z } from 'zod';
import { attributeKey } from './market-filter';
import { STOCK_KEYWORDS } from './params';
import { PersonalInputError } from './types';

// The sourced attributes of the stocks tracked on one chain (gate THEME-MATCHED): what a market filter
// reads. One file per chain, `content/stocks/<chain>.json`: each row names the sources it was read
// from, and lists the fields no source supports. The API reads the file of the person's chain and
// hands it to `compose` in its context, as it does the theme lists, so `compose` reads no file.

/** A day, YYYY-MM-DD. */
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
/** Text that is matched or printed: something in it, with no space at its ends. */
const Text = z.string().trim().min(1);

/** What a row is of: a company's common share, a depositary receipt, a preferred share, or a fund. */
export const STOCK_KINDS = ['common', 'adr', 'preferred', 'fund'] as const;
/** Why a row is tracked: the sets it is in. A row names at least one. */
export const STOCK_SETS = ['universe', 'shelf', 'cut'] as const;
/** The fields of a row that a source read supports, or does not (`unverified`). */
export const STOCK_FACTS = [
  'underlying',
  'kind',
  'company',
  'headquarters',
  'sector',
  'industry',
  'subIndustry',
  'keywords',
  'tracks',
] as const;

/** Where a row's facts were read: the page, its title, and the day it was read. */
const Source = z
  .object({
    url: z.string().regex(/^https?:\/\/\S+$/, 'expected a web address'),
    title: Text,
    readOn: Day,
  })
  .strict();

/**
 * LOCAL TYPE. One tracked stock by the token symbol the shelf lists it under on the chain, with what
 * it is and how it is classified (GICS-style sector, industry and sub-industry, and business-line
 * keywords). A fund has what it tracks and no classification of its own, so it is matched by keyword
 * only; any other kind has all three classification fields and tracks nothing.
 */
export const StockAttributes = z
  .object({
    symbol: Text,
    underlying: Text,
    kind: z.enum(STOCK_KINDS),
    company: Text,
    headquarters: Text.nullable(),
    sector: Text.nullable(),
    industry: Text.nullable(),
    subIndustry: Text.nullable(),
    /** Business lines, three to eight (`STOCK_KEYWORDS`), each once however it is written (`attributeKey`). */
    keywords: z
      .array(Text)
      .min(STOCK_KEYWORDS.least)
      .max(STOCK_KEYWORDS.most)
      .refine((words) => new Set(words.map(attributeKey)).size === words.length, {
        message: 'a keyword is on the row twice',
      }),
    tracks: Text.nullable(),
    sets: z.array(z.enum(STOCK_SETS)).min(1),
    sources: z.array(Source).min(1),
    /** The fields of this row that no source read supports. */
    unverified: z.array(z.enum(STOCK_FACTS)),
    note: z.string().optional(),
  })
  .strict()
  .refine((row) => row.kind !== 'fund' || row.tracks !== null, {
    message: 'a fund says what it tracks',
    path: ['tracks'],
  })
  .refine((row) => row.kind === 'fund' || row.tracks === null, {
    message: 'only a fund tracks something',
    path: ['tracks'],
  })
  .refine((row) => row.kind !== 'fund' || row.headquarters === null, {
    message: 'a fund has no headquarters',
    path: ['headquarters'],
  })
  .refine((row) => row.kind !== 'fund' || row.sector === null, {
    message: 'a fund has no sector',
    path: ['sector'],
  })
  .refine((row) => row.kind !== 'fund' || row.industry === null, {
    message: 'a fund has no industry',
    path: ['industry'],
  })
  .refine((row) => row.kind !== 'fund' || row.subIndustry === null, {
    message: 'a fund has no sub-industry',
    path: ['subIndustry'],
  })
  .refine((row) => row.kind === 'fund' || row.sector !== null, {
    message: 'a stock has a sector',
    path: ['sector'],
  })
  .refine((row) => row.kind === 'fund' || row.industry !== null, {
    message: 'a stock has an industry',
    path: ['industry'],
  })
  .refine((row) => row.kind === 'fund' || row.subIndustry !== null, {
    message: 'a stock has a sub-industry',
    path: ['subIndustry'],
  });
export type StockAttributes = z.infer<typeof StockAttributes>;

/**
 * LOCAL TYPE. The attributes of one chain's tracked stocks. `version` goes up with every change of a
 * row; `readOn` is the day the sources were read. A plan that holds a matched name says both.
 */
export const StockAttributesFile = z
  .object({
    chain: ChainId,
    version: z.number().int().positive(),
    readOn: Day,
    note: z.string().optional(),
    stocks: z
      .array(StockAttributes)
      .refine((rows) => new Set(rows.map((row) => row.symbol)).size === rows.length, {
        message: 'a symbol is in the file twice',
      }),
  })
  .strict();
export type StockAttributesFile = z.infer<typeof StockAttributesFile>;

/**
 * The attributes read from their file, validated. Throws `PersonalInputError` with the file's name
 * and what is wrong: a file that does not validate is never used.
 */
export function parseStockAttributes(raw: unknown, file = 'stock attributes'): StockAttributesFile {
  const parsed = StockAttributesFile.safeParse(raw);
  if (!parsed.success)
    throw new PersonalInputError(
      'InvalidContext',
      parsed.error.issues.map((i) => ({
        path: [file, ...i.path].join('.'),
        message: i.message,
      })),
    );
  return parsed.data;
}
