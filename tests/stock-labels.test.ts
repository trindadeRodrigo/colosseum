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

type SeedAsset = { symbol: string; cls: string; tier: string };
const seed = read('docs/vault/research/open-questions/launch-shelf.seed.json') as {
  assets: Record<string, SeedAsset[]>;
};
/**
 * The tokens of listed securities in the launch shelf's seed on a chain (stocks, funds, gold and
 * commodity funds, and SGOV): the ones the shelf lists (tier A to C), or the ones it measured too
 * thin to list (tier X).
 */
const inSeed = (chain: Chain, listed: boolean) =>
  (seed.assets[chain] ?? [])
    .filter(
      (a) => ['stock', 'stock-index', 'gold', 'commodity'].includes(a.cls) || a.symbol === 'SGOV',
    )
    .filter((a) => (a.tier === 'X') !== listed)
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
    expect(inSet('solana', 'shelf')).toEqual(sorted(inSeed('solana', true)));
    expect(inSet('solana', 'thin')).toEqual(sorted(inSeed('solana', false)));
    expect(inSet('solana', 'cut')).toEqual([]);
  });

  it('on Robinhood Chain: the shelf, and the stocks of the 80% cut on the frozen discovery', () => {
    const fx = gunzip(
      'fixtures/risk/universe/robinhood-discovery-20261005T1947.json.gz',
    ) as CutInput;
    const cut = cutReport(fx, { share: 0.8, minPoolUsd: 1000, collected: [] }).tracked;
    expect(cut).toHaveLength(30);
    expect(inSet('robinhood', 'cut')).toEqual(sorted(cut.map((t) => t.symbol)));
    expect(inSet('robinhood', 'shelf')).toEqual(sorted(inSeed('robinhood', true)));
    expect(inSet('robinhood', 'thin')).toEqual(sorted(inSeed('robinhood', false)));
    expect(inSet('robinhood', 'thin').length).toBeGreaterThan(0);
    expect(inSet('robinhood', 'universe')).toEqual([]);
  });

  it('a row is there because a set names it, and names its token as the chain writes it', () => {
    for (const s of stocks.solana.stocks) expect(s.symbol).toBe(`${s.underlying}x`);
    for (const s of stocks.robinhood.stocks) expect(s.symbol).toBe(s.underlying);
    for (const chain of CHAINS)
      for (const s of stocks[chain].stocks)
        expect(s.sets.length, `${chain} ${s.symbol}`).toBeGreaterThan(0);
  });

  // The facts of the security, not of a chain's token: what the token is has its own source per chain.
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

  // Found by the review of Oct 6: the Robinhood rows of 16 securities cited the Solana issuer's pages.
  it('says what each token is from its own issuer: Robinhood\u2019s registry there, Backed\u2019s page on Solana', () => {
    const hosts = (s: StockAttributesFile['stocks'][number]) =>
      s.sources.map((source) => new URL(source.url).host);
    for (const s of stocks.robinhood.stocks) {
      expect(hosts(s), `robinhood ${s.symbol}`).toContain('api.robinhood.com');
      expect(hosts(s), `robinhood ${s.symbol}`).not.toContain('assets.backed.fi');
      expect(s.note ?? '', `robinhood ${s.symbol}`).not.toMatch(/xStock/i);
    }
    for (const s of stocks.solana.stocks) {
      expect(hosts(s), `solana ${s.symbol}`).toContain('assets.backed.fi');
      expect(hosts(s), `solana ${s.symbol}`).not.toContain('api.robinhood.com');
    }
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

  // Membership is a person's call (gate THEMES): a list is confirmed here, by name, with the decision
  // that confirmed it and the members it confirmed, or it is proposed. Confirming a list, or changing
  // a name on a confirmed one, means changing this table with its gate row, in the same change: a
  // status flipped or a name changed in a file alone fails.
  /** The decisions that confirmed lists, as docs/GATES.md records them: the day, and who confirmed. */
  const DECISIONS: Record<string, { on: string; by: string }> = {
    'THEME-AI-SOLANA': { on: '2026-10-05', by: 'Rodrigo' },
    // "Confirm all" (Rodrigo, Oct 7): every list proposed on Oct 6, with the members it was proposed
    // with, on Solana and Robinhood Chain.
    'LABELS-CONFIRMED': { on: '2026-10-07', by: 'Rodrigo' },
  };
  /** Each confirmed list: the gate that confirmed it, and its members as confirmed. */
  const CONFIRMED: Record<string, [gate: string, members: string]> = {
    'solana/ai': ['THEME-AI-SOLANA', 'NVDAx MSFTx GOOGLx METAx AMZNx TSLAx AAPLx'],
    'solana/ai-infrastructure': ['LABELS-CONFIRMED', 'NVDAx MSFTx AMZNx GOOGLx'],
    'solana/big-tech': ['LABELS-CONFIRMED', 'AAPLx MSFTx GOOGLx AMZNx METAx NVDAx TSLAx'],
    'solana/broad-market': ['LABELS-CONFIRMED', 'SPYx QQQx'],
    'solana/cloud-software': ['LABELS-CONFIRMED', 'MSFTx AMZNx GOOGLx PLTRx'],
    'solana/commodities': ['LABELS-CONFIRMED', 'GLDx'],
    'solana/crypto-economy': ['LABELS-CONFIRMED', 'COINx CRCLx HOODx MSTRx'],
    'solana/defense': ['LABELS-CONFIRMED', 'PLTRx SPCXx'],
    'solana/ev-autonomy': ['LABELS-CONFIRMED', 'TSLAx GOOGLx'],
    'solana/fintech': ['LABELS-CONFIRMED', 'HOODx COINx CRCLx'],
    'solana/retail-favourites': ['LABELS-CONFIRMED', 'GMEx'],
    'solana/semiconductors': ['LABELS-CONFIRMED', 'NVDAx'],
    'solana/social-media': ['LABELS-CONFIRMED', 'METAx'],
    'solana/space': ['LABELS-CONFIRMED', 'SPCXx'],
    'robinhood/ai': ['LABELS-CONFIRMED', 'NVDA MSFT GOOGL META AMZN TSLA AAPL'],
    'robinhood/ai-infrastructure': [
      'LABELS-CONFIRMED',
      'NVDA AMD INTC MU TSM DELL CRWV NBIS ORCL MSFT AMZN GOOGL',
    ],
    'robinhood/big-tech': ['LABELS-CONFIRMED', 'AAPL MSFT GOOGL AMZN META NVDA TSLA'],
    'robinhood/broad-market': ['LABELS-CONFIRMED', 'SPY QQQ'],
    'robinhood/cloud-software': ['LABELS-CONFIRMED', 'MSFT AMZN GOOGL ORCL PLTR'],
    'robinhood/commodities': ['LABELS-CONFIRMED', 'GLD SLV USO USAR'],
    'robinhood/crypto-economy': ['LABELS-CONFIRMED', 'COIN CRCL MSTR CLSK'],
    'robinhood/defense': ['LABELS-CONFIRMED', 'PLTR RKLB SPCX'],
    'robinhood/emerging-markets-asia': ['LABELS-CONFIRMED', 'TSM BABA EWY'],
    'robinhood/ev-autonomy': ['LABELS-CONFIRMED', 'TSLA GOOGL'],
    'robinhood/fintech': ['LABELS-CONFIRMED', 'COIN CRCL'],
    'robinhood/health-care': ['LABELS-CONFIRMED', 'LLY HIMS'],
    'robinhood/quantum-computing': ['LABELS-CONFIRMED', 'IONQ RGTI'],
    'robinhood/retail-favourites': ['LABELS-CONFIRMED', 'GME AMC'],
    'robinhood/semiconductors': ['LABELS-CONFIRMED', 'NVDA AMD INTC MU TSM ASML SNDK'],
    'robinhood/social-media': ['LABELS-CONFIRMED', 'META RDDT DJT'],
    'robinhood/space': ['LABELS-CONFIRMED', 'SPCX RKLB'],
  };
  it('the confirmed lists are exactly the ones a recorded decision confirmed, each with the members it confirmed; every other is proposed', () => {
    const gates = readFileSync(join(ROOT, 'docs/GATES.md'), 'utf8').split('\n');
    const rowOf = (gate: string) => gates.find((l) => l.startsWith(`| **${gate}** |`)) ?? '';
    const confirmed = labels.filter((l) => l.list.status === 'confirmed');
    expect(confirmed.map((l) => `${l.chain}/${l.list.slug}`).sort()).toEqual(
      Object.keys(CONFIRMED).sort(),
    );
    for (const { chain, file, list } of confirmed) {
      const [gate = '', members = ''] = CONFIRMED[`${chain}/${list.slug}`] ?? [];
      expect(list.gate, `${chain}/${file}`).toBe(gate);
      // The decision is on record, names this label, and the file carries its day and who made it.
      expect(rowOf(gate), `${chain}/${file}`).toContain(list.name.en);
      expect({ on: list.decidedOn, by: list.curator }, `${chain}/${file}`).toEqual(DECISIONS[gate]);
      expect(list.members.map((m) => m.symbol).join(' '), `${chain}/${file}`).toBe(members);
    }
    for (const { chain, file, list } of labels)
      if (list.status !== 'confirmed') {
        expect(list.status, `${chain}/${file}`).toBe('proposed');
        expect(list.gate, `${chain}/${file}`).toBeUndefined();
      }
  });

  // Gate LABELS-CONFIRMED covers Solana and Robinhood Chain, and gate CHAINS-NOW keeps this work to
  // those two: there is no list for another chain.
  it('the lists are of Solana and Robinhood Chain, and of no other chain', () => {
    expect(sorted(labels.map((l) => l.chain))).toEqual([...CHAINS].sort());
  });
});
