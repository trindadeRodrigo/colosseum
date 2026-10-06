import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  attributeKey,
  isMatchedSlug,
  parseStockAttributes,
  parseThemeList,
  type StockAttributesFile,
  type ThemeList,
} from '@colosseum/engine/personal';
import { trackedSet, type UniversePool } from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { type CutInput, cutReport } from '../scripts/risk-evm/cut';

// The stock labels (gate THEMES) and the sourced attributes of the tracked stocks (gate
// THEME-MATCHED), as `content/` holds them. A label names only tracked tokens of its chain, and the
// tracked tokens are the ones the documents name: on Solana the 18 stocks of gate UNIVERSE and the
// launch shelf's stock tokens, on Robinhood Chain the launch shelf's tokens of listed securities and
// the stocks of the 80% cut (docs/risk/PLAN-UNIVERSE.md sections 2 and 6).

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const gunzip = (path: string): unknown =>
  JSON.parse(gunzipSync(readFileSync(join(ROOT, path))).toString());
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

const CHAINS = ['solana', 'robinhood'] as const;
type Chain = (typeof CHAINS)[number];

const stocks = Object.fromEntries(
  CHAINS.map((chain) => {
    const path = `content/stocks/${chain}.json`;
    return [chain, parseStockAttributes(read(path), path)];
  }),
) as Record<Chain, StockAttributesFile>;

const labels: { chain: string; file: string; list: ThemeList }[] = readdirSync(
  join(ROOT, 'content/themes'),
).flatMap((chain) =>
  readdirSync(join(ROOT, 'content/themes', chain))
    .sort()
    .map((file) => {
      const path = `content/themes/${chain}/${file}`;
      return { chain, file, list: parseThemeList(read(path), path) };
    }),
);

type SeedAsset = { symbol: string; cls: string };
const seed = read('docs/vault/research/open-questions/launch-shelf.seed.json') as {
  assets: Record<string, SeedAsset[]>;
};
/** The launch shelf's tokens of listed securities on a chain: stocks, funds, gold and commodity funds, and SGOV. */
const onShelf = (chain: Chain) =>
  (seed.assets[chain] ?? [])
    .filter(
      (a) => ['stock', 'stock-index', 'gold', 'commodity'].includes(a.cls) || a.symbol === 'SGOV',
    )
    .map((a) => a.symbol);
const inSet = (chain: Chain, set: string) =>
  sorted(stocks[chain].stocks.filter((s) => s.sets.includes(set as never)).map((s) => s.symbol));

describe('the sourced attributes of the tracked stocks (content/stocks)', () => {
  it('each file is of its chain and reads on the day its sources were read', () => {
    for (const chain of CHAINS) {
      expect(stocks[chain].chain).toBe(chain);
      for (const s of stocks[chain].stocks)
        for (const source of s.sources) {
          expect(source.url, `${chain} ${s.symbol}`).toMatch(/^https:\/\//);
          expect(source.readOn <= stocks[chain].readOn, `${chain} ${s.symbol}`).toBe(true);
        }
    }
  });

  it('on Solana: the 18 stocks of gate UNIVERSE, by the rule on the frozen registry, and the shelf', () => {
    const fx = gunzip('fixtures/risk/universe/solana-registry-20261001T0139.json.gz') as {
      pools: UniversePool[];
    };
    const universe = trackedSet(fx.pools, { share: 0.8, minPoolUsd: 1000 }).assets;
    expect(universe).toHaveLength(18);
    expect(inSet('solana', 'universe')).toEqual(sorted(universe));
    expect(inSet('solana', 'shelf')).toEqual(sorted(onShelf('solana')));
    expect(inSet('solana', 'cut')).toEqual([]);
  });

  it('on Robinhood Chain: the shelf, and the stocks of the 80% cut on the frozen discovery', () => {
    const fx = gunzip(
      'fixtures/risk/universe/robinhood-discovery-20261005T1947.json.gz',
    ) as CutInput;
    const cut = cutReport(fx, { share: 0.8, minPoolUsd: 1000, collected: [] }).tracked;
    expect(cut).toHaveLength(30);
    expect(inSet('robinhood', 'cut')).toEqual(sorted(cut.map((t) => t.symbol)));
    expect(inSet('robinhood', 'shelf')).toEqual(sorted(onShelf('robinhood')));
    expect(inSet('robinhood', 'universe')).toEqual([]);
  });

  it('a row is there because a set names it, and names its token as the chain writes it', () => {
    for (const s of stocks.solana.stocks) expect(s.symbol).toBe(`${s.underlying}x`);
    for (const s of stocks.robinhood.stocks) expect(s.symbol).toBe(s.underlying);
    for (const chain of CHAINS)
      for (const s of stocks[chain].stocks)
        expect(s.sets.length, `${chain} ${s.symbol}`).toBeGreaterThan(0);
  });

  it('one listed security carries the same facts on every chain', () => {
    const facts = (s: StockAttributesFile['stocks'][number]) => ({
      kind: s.kind,
      company: s.company,
      headquarters: s.headquarters,
      sector: s.sector,
      industry: s.industry,
      subIndustry: s.subIndustry,
      keywords: s.keywords,
      tracks: s.tracks,
      sources: s.sources,
      unverified: s.unverified,
    });
    const onSolana = new Map(stocks.solana.stocks.map((s) => [s.underlying, s]));
    const shared = stocks.robinhood.stocks.filter((s) => onSolana.has(s.underlying));
    expect(shared.length).toBeGreaterThan(10);
    for (const s of shared)
      expect(facts(s), s.underlying).toEqual(
        facts(onSolana.get(s.underlying) as StockAttributesFile['stocks'][number]),
      );
  });

  it('writes one value one way: no two spellings of a sector, an industry or a sub-industry', () => {
    for (const field of ['sector', 'industry', 'subIndustry'] as const) {
      const spellings = new Map<string, Set<string>>();
      for (const chain of CHAINS)
        for (const s of stocks[chain].stocks) {
          const value = s[field];
          if (value === null) continue;
          const key = attributeKey(value);
          spellings.set(key, (spellings.get(key) ?? new Set()).add(value));
        }
      for (const [key, written] of spellings)
        expect([...written], `${field} ${key}`).toHaveLength(1);
    }
  });

  it('records no figure: no price, yield, revenue or market value', () => {
    for (const chain of CHAINS)
      for (const s of stocks[chain].stocks) {
        const text = [...s.keywords, s.tracks ?? '', s.note ?? ''].join(' ');
        expect(text, `${chain} ${s.symbol}`).not.toMatch(/\d\s?%|\$\s?\d|\bAPY\b|\bAPR\b/i);
      }
  });
});

describe('the stock labels (content/themes)', () => {
  it('there are labels on both chains, each file named by its slug in the folder of its chain', () => {
    expect(labels.length).toBeGreaterThan(20);
    for (const { chain, file, list } of labels) {
      expect(list.chain, `${chain}/${file}`).toBe(chain);
      expect(`${list.slug}.json`, `${chain}/${file}`).toBe(file);
      // A slug that starts with `matched-` is a filter's, never a curated list's.
      expect(isMatchedSlug(list.slug), `${chain}/${file}`).toBe(false);
    }
    for (const chain of CHAINS)
      expect(labels.filter((l) => l.chain === chain).length, chain).toBeGreaterThan(5);
  });

  it('every member is a tracked token of its chain', () => {
    for (const { chain, file, list } of labels) {
      const tracked = new Set(stocks[chain as Chain]?.stocks.map((s) => s.symbol));
      for (const m of list.members)
        expect(tracked.has(m.symbol), `${chain}/${file} ${m.symbol}`).toBe(true);
    }
  });

  it('a label has one name and one slug across chains, and a stock one reason per label', () => {
    const names = new Map<string, string>();
    const reasons = new Map<string, string>();
    const underlying = (chain: string, symbol: string) =>
      stocks[chain as Chain].stocks.find((s) => s.symbol === symbol)?.underlying ?? symbol;
    for (const { chain, list } of labels) {
      const name = JSON.stringify(list.name);
      expect(names.get(list.slug) ?? name, `${chain}/${list.slug}`).toBe(name);
      names.set(list.slug, name);
      for (const m of list.members) {
        const key = `${list.slug} ${underlying(chain, m.symbol)}`;
        const reason = JSON.stringify(m.reason);
        expect(reasons.get(key) ?? reason, `${chain}/${key}`).toBe(reason);
        reasons.set(key, reason);
      }
    }
  });

  it('a confirmed list names the decision that confirmed it, and docs/GATES.md has that row', () => {
    const gates = readFileSync(join(ROOT, 'docs/GATES.md'), 'utf8');
    const confirmed = labels.filter((l) => l.list.status === 'confirmed');
    // The Solana AI list (gate THEME-AI-SOLANA) is confirmed; no test here confirms another.
    expect(confirmed.map((l) => `${l.chain}/${l.list.slug}`)).toContain('solana/ai');
    for (const { chain, file, list } of confirmed) {
      expect(list.gate, `${chain}/${file}`).toBeDefined();
      expect(gates, `${chain}/${file}`).toContain(`| **${list.gate}** |`);
    }
  });
});
