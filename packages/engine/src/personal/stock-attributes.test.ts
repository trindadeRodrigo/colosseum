import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStockAttributes, STOCK_FACTS, StockAttributesFile } from './stock-attributes';
import { PersonalInputError } from './types';

// ENG-3, gate THEME-MATCHED: the sourced attributes of the stocks tracked on a chain are data
// (`content/stocks/<chain>.json`), validated before anything reads them. The rows here are written
// for the test and say so: no source was read for them.

const source = {
  url: 'https://example.com/fixture',
  title: 'MOCK: no source was read for this test fixture',
  readOn: '2026-10-06',
};
const nvda = {
  symbol: 'NVDAx',
  underlying: 'NVDA',
  kind: 'common',
  company: 'NVIDIA Corporation',
  headquarters: 'United States',
  sector: 'Information Technology',
  industry: 'Semiconductors & Semiconductor Equipment',
  subIndustry: 'Semiconductors',
  keywords: ['gpus', 'ai chips', 'data centers'],
  tracks: null,
  sets: ['universe', 'shelf'],
  sources: [source],
  unverified: [...STOCK_FACTS],
};
const qqq = {
  symbol: 'QQQx',
  underlying: 'QQQ',
  kind: 'fund',
  company: 'Invesco QQQ Trust',
  headquarters: null,
  sector: null,
  industry: null,
  subIndustry: null,
  keywords: ['nasdaq-100', 'large companies', 'index fund'],
  tracks: 'the Nasdaq-100 index',
  sets: ['shelf'],
  sources: [source],
  unverified: [...STOCK_FACTS],
  note: 'A fund: what it tracks, and no classification of its own.',
};
const file = {
  chain: 'solana',
  version: 1,
  readOn: '2026-10-06',
  note: 'MOCK: a test fixture, not a reading of any source',
  stocks: [nvda, qqq],
};
/** The file with one row, changed. */
const one = (over: Record<string, unknown>, of: Record<string, unknown> = nvda) => ({
  ...file,
  stocks: [{ ...of, ...over }],
});
const refused = (raw: unknown, what: string) =>
  expect(() => parseStockAttributes(raw), what).toThrow(PersonalInputError);
const taken = (raw: unknown, what: string) =>
  expect(() => parseStockAttributes(raw), what).not.toThrow();

describe('the stock attributes are data (content/stocks/<chain>.json)', () => {
  it('reads a file as it is written, and no field it does not know', () => {
    expect(parseStockAttributes(structuredClone(file))).toEqual(file);
    expect(StockAttributesFile.safeParse(file).success).toBe(true);
    refused({ ...file, curator: 'someone' }, 'a field on the file');
    refused(one({ ticker: 'NVDA' }), 'a field on a row');
    refused(one({ sources: [{ ...source, author: 'someone' }] }), 'a field on a source');
    // The notes are optional, and a file with no row is a chain with no tracked stock yet.
    const { note: _fileNote, ...bare } = file;
    const { note: _rowNote, ...plain } = qqq;
    taken({ ...bare, stocks: [plain] }, 'no notes');
    taken({ ...file, stocks: [] }, 'no rows');
    // What is matched or printed is kept without the space at its ends.
    const padded = parseStockAttributes(
      one({ company: '  NVIDIA Corporation ', symbol: ' NVDAx' }),
    );
    expect(padded.stocks[0]?.company).toBe('NVIDIA Corporation');
    expect(padded.stocks[0]?.symbol).toBe('NVDAx');
  });

  it('holds the file and each row to its shape', () => {
    refused({ ...file, chain: 'ethereum' }, 'a chain that is not one');
    for (const version of [0, -1, 1.5, '3']) refused({ ...file, version }, `version ${version}`);
    for (const readOn of ['2026-13-01', '2026-10-32', '06/10/2026', ''])
      refused({ ...file, readOn }, `read on ${readOn}`);
    refused({ ...file, stocks: [nvda, qqq, nvda] }, 'a symbol twice');
    refused(one({ kind: 'etf' }), 'a kind that is not one');
    for (const field of ['symbol', 'underlying', 'company'])
      for (const empty of ['', '   ', null])
        refused(one({ [field]: empty }), `${field}: ${JSON.stringify(empty)}`);
    // Three to eight keywords, each once however it is written.
    refused(one({ keywords: ['gpus', 'ai chips'] }), 'two keywords');
    refused(one({ keywords: 'abcdefghi'.split('') }), 'nine keywords');
    taken(one({ keywords: 'abcdefgh'.split('') }), 'eight keywords');
    refused(one({ keywords: ['gpus', 'AI chips', 'ai-chips'] }), 'a keyword twice by its key');
    refused(one({ keywords: ['gpus', 'ai chips', ''] }), 'an empty keyword');
    // Tracked for at least one reason, from at least one source.
    refused(one({ sets: [] }), 'no set');
    refused(one({ sets: ['watchlist'] }), 'a set that is not one');
    for (const set of ['universe', 'shelf', 'cut']) taken(one({ sets: [set] }), set);
    refused(one({ sources: [] }), 'no source');
    refused(one({ sources: [{ ...source, url: 'a brochure' }] }), 'a source with no address');
    refused(one({ sources: [{ ...source, title: '' }] }), 'a source with no title');
    refused(one({ sources: [{ ...source, readOn: 'today' }] }), 'a source with no day');
    // What no source supports is named by the facts of the row, and by nothing else.
    taken(one({ unverified: [] }), 'every field supported');
    taken(one({ unverified: ['sector', 'keywords'] }), 'two fields not supported');
    refused(one({ unverified: ['symbol'] }), 'the symbol is not a fact a source supports');
    refused(one({ unverified: ['price'] }), 'a field the row does not have');
  });

  it('a fund says what it tracks and has no classification; any other kind has all three and tracks nothing', () => {
    taken(one({}, qqq), 'a fund');
    refused(one({ tracks: null }, qqq), 'a fund that tracks nothing');
    refused(one({ tracks: '' }, qqq), 'a fund that tracks an empty text');
    for (const field of ['sector', 'industry', 'subIndustry', 'headquarters'])
      refused(one({ [field]: 'Financials' }, qqq), `a fund with a ${field}`);
    for (const kind of ['common', 'adr', 'preferred']) {
      taken(one({ kind }), kind);
      refused(one({ kind, tracks: 'the S&P 500 index' }), `${kind} that tracks something`);
      for (const field of ['sector', 'industry', 'subIndustry'])
        refused(one({ kind, [field]: null }), `${kind} with no ${field}`);
      // Where a company is based may be unknown; what it is classified as may not.
      taken(one({ kind, headquarters: null }), `${kind} with no headquarters`);
    }
  });

  it('says which file and which field is wrong', () => {
    const where = 'content/stocks/solana.json';
    expect(() => parseStockAttributes(one({ keywords: ['gpus'] }), where)).toThrow(
      'content/stocks/solana.json.stocks.0.keywords',
    );
    try {
      parseStockAttributes(one({ tracks: 'an index' }), where);
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(PersonalInputError);
      const error = e as PersonalInputError;
      expect(error.code).toBe('InvalidContext');
      expect(error.issues).toEqual([
        { path: `${where}.stocks.0.tracks`, message: 'only a fund tracks something' },
      ]);
    }
  });

  it('every file under content/stocks, when there is one, validates and sits at <chain>.json', () => {
    // None is checked in on the branch this was written on: the files come with the content, and
    // this holds each of them from then on.
    const root = join(import.meta.dirname, '../../../../content/stocks');
    const files = existsSync(root) ? readdirSync(root).filter((f) => f.endsWith('.json')) : [];
    for (const name of files) {
      const read = parseStockAttributes(JSON.parse(readFileSync(join(root, name), 'utf8')), name);
      expect(`${read.chain}.json`).toBe(name);
    }
  });
});
