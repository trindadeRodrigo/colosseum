import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeClmmPool, ROUTE_CHUNKS, type RoutePool, routeTrade } from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  gapOf,
  isGap,
  mean,
  median,
  parseQuotes,
  type StoredQuote,
  stockShares,
} from '../../scripts/risk/lib-routing-gap';
import { buildSplit, loadCapture } from '../../scripts/risk/lib-split';
import {
  FROZEN,
  frozenByreal,
  frozenRobinhood,
  frozenSolana,
  readFrozen,
  readQuotes,
  trackedStocks,
} from '../../scripts/risk/venues/frozen';
import {
  byrealProbe,
  type CutPoolRow,
  classifyPool,
  classKey,
  clmmArrayStart,
  cutPoolRows,
  type DiscoveryRow,
  discoveryTable,
  type ExcludedPool,
  forkPoolMoney,
  type GapShare,
  gapAccount,
  type KnownPool,
  poolMints,
  quoteLegs,
  robinhoodTable,
  routedShares,
} from '../../scripts/risk/venues/lib';
import {
  dollarsOfStockLeg,
  gapShareOf,
  gapWithLegs,
  OUTSIDE,
} from '../../scripts/risk/venues/replay';
import { venuesReport } from '../../scripts/risk/venues/run';
import {
  ACCOUNTS_NOT_DECODED,
  gapByStockMarkdown,
  gapMarkdown,
  NO_PAIR_LISTED,
  type RegistryRow,
  robinhoodMarkdown,
  solanaMarkdown,
  solanaRanking,
  solanaTable,
} from '../../scripts/risk/venues/table';
import { PROPRIETARY_MARKET_MAKERS, VENUE_FACTS } from '../../scripts/risk/venues/venue-facts';

// PLAN-UNIVERSE RU.13 — the venues we do not read, ranked. Every row here is a real one, frozen under fixtures/:
// - Jupiter's stored quotes of 2026-10-06 21:15Z to 2026-10-07 01:10Z, line for line (720 rows, twelve runs), and
//   thirteen rows of other days, one for each shape of route the shares have to get right;
// - the chain read of the 198 pools on the stored routes (owner, size, the pool account where it can be decoded,
//   the vaults of the Raydium-sized forks), 2026-10-07 12:22Z;
// - the Byreal probe: one pool account, the list of its arrays, one array, 2026-10-07 12:22Z;
// - the registry run of Oct 1 (the frozen copies RU.1 and RU.4 made, and its excluded pools);
// - DexScreener's rows of Oct 1 for the 18 tracked stocks;
// - Robinhood Chain: the 28-day flow row of each of the cut's 427 pools, and the cut's pools with what discovery read.
// Each share is recomputed here from the row's own amounts, by a reference written apart from the code. No test calls
// the network, the collector's home or the database.
const gz = <T>(file: string): T => readFrozen<T>(file);
const frozen = frozenSolana();
const routePools = frozen.routePools;
const windowQuotes = frozen.quotes as StoredQuote[];
const cases = readQuotes(FROZEN.cases);
const excludedFile = {
  fetchedAt: frozen.registry.fetchedAt,
  minPoolTvlUsd: frozen.registry.minPoolTvlUsd as number,
  excluded: frozen.registry.excluded as ExcludedPool[],
};
const discovery = gz<{ dexIdsInTheFile: Record<string, number>; rows: DiscoveryRow[] }>(
  FROZEN.discovery,
);
const robinhood = frozenRobinhood();
const byrealFile = frozenByreal();

// the registry run of Oct 1, from the copies frozen for RU.1 and RU.4
const base = {
  source: frozen.known.source,
  fetched_at: frozen.known.fetchedAt,
  pools: frozen.known.pools as KnownPool[],
};
const knownByAddress = new Map(base.pools.map((p) => [p.address, p]));
const registryRows = frozen.registry.pools as RegistryRow[];
const tracked = trackedStocks();
const ctx = {
  registry: new Map(registryRows.map((p) => [p.address, p])),
  known: knownByAddress,
  routePools: new Map(routePools.pools.map((p) => [p.address, p])),
  tracked: new Set(tracked.keys()),
};
const keyOf = (pool: string) => classKey(classifyPool(pool, ctx));

const BYREAL = 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2';
const GOONFI = 'goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE';
const KIPSELI = '3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU';
const pctOf = (a: string, of: string) => (Number(BigInt(a)) / Number(BigInt(of))) * 100;
const legsOf = (q: StoredQuote) => {
  const r = quoteLegs(q);
  if (!r.resolved) throw new Error(`${q.asset}: ${r.reason}`);
  return r.legs;
};
const find = (is: (q: StoredQuote) => boolean) => {
  const q = cases.find(is);
  if (!q) throw new Error('case row not found');
  return q;
};
const shape = (q: StoredQuote) =>
  legsOf(q)
    .map((l) => ({ direct: 'D', stock_hop: 'S', dollar_hop: '$', middle_hop: 'M' })[l.role])
    .join('');

describe('the share of a quote through each leg', () => {
  it('a row with no route gives nothing', () => {
    const failed = cases.filter((q) => !q.route);
    expect(failed.map((q) => q.error)).toEqual(['429', 'no_ref_price']);
    for (const q of failed) expect(quoteLegs(q)).toEqual({ resolved: false, reason: 'no_route' });
  });

  it('one pool: the whole stock and the whole dollars', () => {
    const q = find((x) => x.side === 'sell' && x.route?.length === 1 && x.asset === 'NVDAx');
    const [leg] = legsOf(q);
    expect(leg).toMatchObject({ role: 'direct', stockPct: 100, dollarPct: 100, sharePct: 100 });
  });

  it('three pools, a purchase: each by the stock it delivers, and the three add up to the quote', () => {
    const q = find((x) => x.side === 'buy' && x.route?.length === 3 && x.asset === 'SPYx');
    const route = q.route as NonNullable<StoredQuote['route']>;
    const legs = legsOf(q);
    expect(legs.map((l) => l.role)).toEqual(['direct', 'direct', 'direct']);
    // by hand from the row: 441,512,762 + 675,380,735 + 181,829,065 = 1,298,722,562 raw units of SPYx
    expect(441_512_762n + 675_380_735n + 181_829_065n).toBe(BigInt(q.outAmount as string));
    legs.forEach((l, i) => {
      expect(l.stockPct).toBeCloseTo(
        pctOf(route[i]?.outAmount as string, q.outAmount as string),
        12,
      );
      expect(l.dollarPct).toBeCloseTo(pctOf(route[i]?.inAmount as string, q.amountIn), 12);
    });
    // Byreal's leg: 14% of the dollars and 14.0006% of the stock, not Jupiter's rounded `percent`
    expect(legs[2]?.label).toBe('Byreal');
    expect(legs[2]?.dollarPct).toBeCloseTo(14, 10);
    expect(legs[2]?.stockPct).toBeCloseTo(14.000608, 5);
    expect(legs.reduce((t, l) => t + (l.stockPct as number), 0)).toBeCloseTo(100, 10);
  });

  it('a leg through two pools is two legs, each counted once with its own share', () => {
    // a sale: the stock to SOL in one pool, SOL to dollars in another
    const sale = find((x) => x.side === 'sell' && x.asset === 'SPCXx' && x.route?.length === 2);
    expect(shape(sale)).toBe('S$');
    const [stock, dollars] = legsOf(sale);
    expect(stock).toMatchObject({ label: 'Raydium CLMM', stockPct: 100, dollarPct: null });
    expect(dollars).toMatchObject({ label: 'TesseraV', stockPct: null, dollarPct: 100 });
    // a purchase runs the other way: dollars to SOL first, then SOL to the stock
    const buy = find((x) => x.side === 'buy' && x.asset === 'MSTRx' && x.route?.length === 2);
    expect(shape(buy)).toBe('$S');
    expect(legsOf(buy)[0]).toMatchObject({ label: 'Kipseli', stockPct: null, sharePct: 100 });
    expect(legsOf(buy)[1]).toMatchObject({ label: 'Raydium CLMM', stockPct: 100 });
  });

  it('a direct leg beside a two-hop path: the stock end and the dollar end each add up to the whole', () => {
    const q = find((x) => x.asset === 'QQQx' && x.route?.length === 3);
    expect(shape(q)).toBe('DS$');
    const legs = legsOf(q);
    // the stock: 140,861,534 + 8,991,156 = 149,852,690; the dollars: 1,048,822,112 + 66,952,444 = 1,115,774,556
    expect(140_861_534n + 8_991_156n).toBe(BigInt(q.amountIn));
    expect(1_048_822_112n + 66_952_444n).toBe(BigInt(q.outAmount as string));
    expect(legs[0]?.stockPct).toBeCloseTo((140_861_534 / 149_852_690) * 100, 12);
    expect(legs[1]?.stockPct).toBeCloseTo((8_991_156 / 149_852_690) * 100, 12);
    expect(legs[2]?.stockPct).toBeNull();
    expect(legs[2]?.dollarPct).toBeCloseTo((66_952_444 / 1_115_774_556) * 100, 12);
    // Jupiter's `percent` says 100 on the second hop: it is the percent of that hop's own token, not of the quote
    expect(q.route?.[2]?.percent).toBe(100);
    expect(legs[2]?.sharePct).toBeCloseTo(6.00054, 4);
  });

  it('a hop between two middle tokens takes the share of the leg that feeds it', () => {
    const q = find((x) => x.route?.some((h) => h.label === 'Manifest') === true);
    expect(shape(q)).toBe('SM$');
    const legs = legsOf(q);
    expect(legs[1]).toMatchObject({ label: 'Manifest', role: 'middle_hop', sharePct: 100 });
    expect(legs[1]?.stockPct).toBeNull();
    expect(legs[1]?.dollarPct).toBeNull();
  });

  it('two stock legs into one dollar leg, and one stock leg into two dollar legs', () => {
    const merged = find((x) => x.asset === 'MSTRx' && x.side === 'sell' && x.route?.length === 3);
    expect(shape(merged)).toBe('SS$');
    expect(legsOf(merged).map((l) => l.stockPct)).toEqual([
      pctOf('6413435', merged.amountIn),
      pctOf('634930098', merged.amountIn),
      null,
    ]);
    expect(legsOf(merged)[2]?.dollarPct).toBe(100);
    const split = find((x) => x.route?.some((h) => h.label === 'Obsidian') === true);
    expect(shape(split)).toBe('S$$');
    const legs = legsOf(split);
    expect(legs[1]?.dollarPct).toBeCloseTo((560_229_177 / 1_000_337_544) * 100, 12);
    expect(legs[2]?.dollarPct).toBeCloseTo((440_108_367 / 1_000_337_544) * 100, 12);
    expect((legs[1]?.dollarPct as number) + (legs[2]?.dollarPct as number)).toBeCloseTo(100, 10);
  });

  it('where two legs pay the same amount the dollar end is not guessed: the legs follow their chain', () => {
    const q = find((x) => x.route?.some((h) => h.label === 'Deriverse') === true);
    const legs = legsOf(q);
    // the stock end is told apart (26% and 74%); two legs pay 259,883,202, so the dollar end is not
    expect(legs.every((l) => l.dollarPct === null)).toBe(true);
    expect(legs.map((l) => l.stockPct?.toFixed(4) ?? null)).toEqual([
      '26.0000',
      null,
      null,
      '74.0000',
    ]);
    // Byreal takes what the first leg pays, Deriverse what Byreal pays: both carry that leg's 26%
    expect(legs[1]?.label).toBe('Byreal');
    expect(legs[2]?.label).toBe('Deriverse');
    expect(legs[1]?.sharePct).toBeCloseTo(26, 4);
    expect(legs[2]?.sharePct).toBe(legs[1]?.sharePct);
  });

  it('on every frozen row the stock legs add up to the quote, to the raw unit, and are the ones RU.11 finds', () => {
    let rows = 0;
    for (const q of [...windowQuotes, ...cases]) {
      if (!q.route) continue;
      rows++;
      const legs = legsOf(q);
      const sell = q.side === 'sell';
      const raw = (q.route ?? [])
        .filter((_, i) => legs[i]?.stockPct !== null)
        .reduce((t, h) => t + BigInt((sell ? h.inAmount : h.outAmount) as string), 0n);
      expect(raw).toBe(BigInt((sell ? q.amountIn : q.outAmount) as string));
      expect(legs.reduce((t, l) => t + (l.stockPct ?? 0), 0)).toBeCloseTo(100, 9);
      // the function RU.11 wrote and tested, leg by leg
      expect(legs.map((l) => l.stockPct)).toEqual(stockShares(q));
      const dollars = legs.filter((l) => l.dollarPct !== null);
      if (dollars.length)
        expect(dollars.reduce((t, l) => t + (l.dollarPct as number), 0)).toBeCloseTo(100, 9);
      // a leg off the stock end has a share, or the amounts did not say: never a zero
      for (const l of legs) if (l.sharePct !== null) expect(l.sharePct).toBeGreaterThan(0);
    }
    expect(rows).toBe(693 + 11);
  });
});

describe('what each pool on a route is', () => {
  it('every pool of the chain read is owned by the program Jupiter labels it with', () => {
    const labels = routePools.programLabels.labels;
    expect(routePools.pools).toHaveLength(198);
    for (const p of routePools.pools) {
      expect(p.labels).toHaveLength(1);
      expect(labels[p.owner as string]).toBe(p.labels[0]);
    }
  });

  it('the pools by class', () => {
    const count: Record<string, number> = {};
    for (const p of routePools.pools) {
      const kind = classifyPool(p.address, ctx).kind;
      count[kind] = (count[kind] ?? 0) + 1;
    }
    // 77 in the collector's registry, 8 of a tracked stock outside it, 37 of another market, 76 of a program not decoded
    expect(count).toEqual({ read: 77, registry: 8, other_market: 37, unread: 76 });
    expect(classifyPool('5pobXosbeGSCRG3HdaRiw2TaihDDQMXkHFVbUTF24weM', ctx)).toEqual({
      kind: 'unread',
      program: BYREAL,
    });
    expect(classifyPool('not-a-pool-of-the-read', ctx)).toEqual({
      kind: 'unknown',
      why: 'pool_not_in_the_chain_read',
    });
  });

  it('a pool of a tracked stock outside the registry is dust of the run, or was not found by it', () => {
    const outside = routePools.pools
      .map((p) => ({ p, c: classifyPool(p.address, ctx) }))
      .filter((x) => x.c.kind === 'registry');
    for (const { p, c } of outside) {
      const mints = poolMints(p) as [string, string];
      expect(mints.some((m) => tracked.has(m))).toBe(true);
      expect(ctx.registry.has(p.address)).toBe(false);
      if (c.kind === 'registry')
        expect(c.why).toBe(
          knownByAddress.has(p.address)
            ? 'dust_at_the_registry_run'
            : 'not_found_by_the_registry_run',
        );
    }
    // SPCXx/USDC on Meteora and SPYx/GLDx on Raydium: neither is among the 5,951 pools of Oct 1
    expect(
      outside.filter((x) => x.c.kind === 'registry' && x.c.why !== 'dust_at_the_registry_run'),
    ).toHaveLength(2);
  });
});

// A reference written from the definition, apart from the code: every subset of legs is listed, the one that adds up
// is kept, and the shares are added pool by pool before any pool is given its class.
function reference(quotes: readonly StoredQuote[]) {
  const subsets = (target: bigint, amounts: bigint[], skip = -1): number[][] => {
    const out: number[][] = [];
    const walk = (i: number, picked: number[], sum: bigint) => {
      if (i === amounts.length) {
        if (picked.length && sum === target) out.push(picked);
        return;
      }
      walk(i + 1, picked, sum);
      if (i !== skip) walk(i + 1, [...picked, i], sum + (amounts[i] as bigint));
    };
    walk(0, [], 0n);
    return out;
  };
  const groups = new Map<
    string,
    { n: number; stock: Map<string, number>; onward: Map<string, number> }
  >();
  for (const q of quotes) {
    if (!q.route?.length) continue;
    const sell = q.side === 'sell';
    const ins = q.route.map((h) => BigInt(h.inAmount as string));
    const outs = q.route.map((h) => BigInt(h.outAmount as string));
    const stockSets = subsets(
      BigInt(sell ? q.amountIn : (q.outAmount as string)),
      sell ? ins : outs,
    );
    if (stockSets.length !== 1) throw new Error('stock end not told apart');
    const stockEnd = stockSets[0] as number[];
    const dollarSets = subsets(
      BigInt(sell ? (q.outAmount as string) : q.amountIn),
      sell ? outs : ins,
    );
    const dollarEnd = dollarSets.length === 1 ? (dollarSets[0] as number[]) : [];
    const share: Array<number | null> = q.route.map((h, i) =>
      stockEnd.includes(i)
        ? pctOf(
            (sell ? h.inAmount : h.outAmount) as string,
            sell ? q.amountIn : (q.outAmount as string),
          )
        : dollarEnd.includes(i)
          ? pctOf(
              (sell ? h.outAmount : h.inAmount) as string,
              sell ? (q.outAmount as string) : q.amountIn,
            )
          : null,
    );
    for (let pass = 0; pass < share.length; pass++)
      share.forEach((s, i) => {
        if (s !== null) return;
        for (const [target, amounts] of [
          [ins[i], outs],
          [outs[i], ins],
        ] as Array<[bigint, bigint[]]>) {
          const feeders = subsets(target, amounts, i);
          if (feeders.length === 1 && (feeders[0] as number[]).every((k) => share[k] !== null)) {
            share[i] = (feeders[0] as number[]).reduce((t, k) => t + (share[k] as number), 0);
            return;
          }
        }
      });
    const key = `${q.side}|${q.notionalUsd}`;
    const g = groups.get(key) ?? { n: 0, stock: new Map(), onward: new Map() };
    groups.set(key, g);
    g.n++;
    q.route.forEach((h, i) => {
      const to = stockEnd.includes(i) ? g.stock : g.onward;
      if (share[i] !== null) to.set(h.pool, (to.get(h.pool) ?? 0) + (share[i] as number));
    });
  }
  return groups;
}

describe('where Jupiter routes the amount', () => {
  const shares = routedShares(windowQuotes, keyOf, (pool) => {
    const row = ctx.routePools.get(pool);
    return row ? poolMints(row) : null;
  });

  it('the window: 720 rows, 693 with a route, every stock end told apart, ten stocks', () => {
    expect(shares.rows).toBe(720);
    expect(shares.withoutARoute).toBe(27);
    expect(shares.notResolved).toEqual({});
    expect(shares.assets).toHaveLength(10);
    expect(shares.groups.map((g) => [g.side, g.notionalUsd, g.quotes, g.resolved])).toEqual([
      ['sell', 1000, 115, 115],
      ['sell', 10000, 115, 115],
      ['sell', 100000, 116, 116],
      ['buy', 1000, 115, 115],
      ['buy', 10000, 116, 116],
      ['buy', 100000, 116, 116],
    ]);
  });

  it('every share of every class, at every side and size, is the reference’s', () => {
    const ref = reference(windowQuotes);
    for (const g of shares.groups) {
      const r = ref.get(`${g.side}|${g.notionalUsd}`);
      if (!r) throw new Error('group missing from the reference');
      expect(g.resolved).toBe(r.n);
      const byClass = (pools: Map<string, number>) => {
        const out: Record<string, number> = {};
        for (const [pool, sum] of pools) out[keyOf(pool)] = (out[keyOf(pool)] ?? 0) + sum / r.n;
        return out;
      };
      const stock = byClass(r.stock);
      const onward = byClass(r.onward);
      for (const key of new Set([
        ...Object.keys(g.byClass),
        ...Object.keys(stock),
        ...Object.keys(onward),
      ])) {
        expect(g.byClass[key]?.stockPct ?? 0).toBeCloseTo(stock[key] ?? 0, 9);
        expect(g.byClass[key]?.onwardPct ?? 0).toBeCloseTo(onward[key] ?? 0, 9);
      }
      // the stock amount is all somewhere: the classes add up to the whole
      expect(Object.values(g.byClass).reduce((t, c) => t + c.stockPct, 0)).toBeCloseTo(100, 9);
      // and so does each stock's own
      for (const a of Object.values(g.byAsset))
        expect(Object.values(a.byClass).reduce((t, c) => t + c.stockPct, 0)).toBeCloseTo(100, 9);
      expect(g.onwardLegsWithoutAShare).toBe(0);
    }
  });

  it('figures of the window, as a reference in another language gave them', () => {
    const at = (side: string, size: number) =>
      shares.groups.find((g) => g.side === side && g.notionalUsd === size)?.byClass ?? {};
    expect(at('sell', 100000)[`unread:${BYREAL}`]?.stockPct).toBeCloseTo(6.922414, 6);
    expect(at('buy', 100000)[`unread:${BYREAL}`]?.stockPct).toBeCloseTo(6.893869, 6);
    expect(at('sell', 100000)[`unread:${BYREAL}`]?.quotes).toBe(72);
    expect(at('sell', 100000)[`unread:${GOONFI}`]?.stockPct).toBeCloseTo(3.034483, 6);
    // a market maker on the second hop: a share of the amount that crossed it, and none of the stock
    expect(at('sell', 100000)[`unread:${KIPSELI}`]).toMatchObject({ stockPct: 0, quotes: 19 });
    expect(at('sell', 100000)[`unread:${KIPSELI}`]?.onwardPct).toBeCloseTo(5.464827, 6);
    expect(at('sell', 100000)['read:direct_usd']?.stockPct).toBeCloseTo(76.224138, 6);
    expect(at('sell', 100000)['read:other']?.stockPct).toBeCloseTo(4.586207, 6);
    expect(at('buy', 10000)['registry:not_found_by_the_registry_run']?.stockPct).toBeCloseTo(
      2.000079,
      6,
    );
  });

  it('the stock end agrees with the chain: no stock leg sits in a pool that does not hold the stock', () => {
    // by hand: the stock legs RU.11's function finds, in a pool whose account the chain read holds
    let withMints = 0;
    for (const q of windowQuotes)
      (stockShares(q) ?? []).forEach((share, i) => {
        if (share !== null && ctx.routePools.get(q.route?.[i]?.pool as string)?.data) withMints++;
      });
    expect(shares.stockLegsChecked).toBe(withMints);
    expect(withMints).toBeGreaterThan(1000);
    expect(shares.stockLegsInPoolsWithoutTheStock).toBe(0);
    // and the check does bite: with the mints of another stock's pool, every leg is refused
    const wrong = routedShares(windowQuotes, keyOf, () => ['not-the-stock', 'nor-this']);
    expect(wrong.stockLegsInPoolsWithoutTheStock).toBe(wrong.stockLegsChecked);
  });
});

describe('discovery: DexScreener’s rows of Oct 1 (estimates)', () => {
  const excluded = new Map(excludedFile.excluded.map((e) => [e.address, e]));
  const table = discoveryTable(discovery.rows, tracked, {
    registry: ctx.registry,
    known: knownByAddress,
    excluded,
  });

  it('18 rows, 17 at the cap of 30, one minute of Oct 1', () => {
    expect(discovery.rows).toHaveLength(18);
    expect(table.capPairsPerToken).toBe(30);
    expect(table.atCap).toHaveLength(17);
    expect(table.atCap).not.toContain('STRCx');
    expect(discovery.rows.find((r) => r.symbol === 'STRCx')?.pairs).toHaveLength(16);
    expect(table.missing).toEqual([]);
    expect(table.first?.slice(0, 16)).toBe('2026-10-01T00:49');
    expect(table.estimate).toBe(true);
  });

  it('no pair of the whole file is on Byreal, a market maker or an order book', () => {
    expect(Object.keys(discovery.dexIdsInTheFile).sort()).toEqual([
      'fluxbeam',
      'meteora',
      'meteoradbc',
      'orca',
      'pumpfun',
      'pumpswap',
      'raydium',
    ]);
    expect(table.pairs.some((p) => p.program === BYREAL)).toBe(false);
  });

  it('a pair of two tracked stocks is one pair', () => {
    const listed = discovery.rows.reduce((t, r) => t + (r.pairs?.length ?? 0), 0);
    expect(listed).toBe(17 * 30 + 16);
    expect(table.pairs).toHaveLength(519);
    expect(table.pairs.filter((p) => p.stocks.length === 2)).toHaveLength(listed - 519);
  });

  it('a figure DexScreener did not give is no figure, not a zero', () => {
    const pump = table.venues.find((v) => v.dex === 'pumpfun');
    expect(pump).toMatchObject({ pools: 41, liquidityUsd: null, withoutLiquidity: 41 });
    expect(pump?.volume24hUsd).toBeCloseTo(643_796, 0);
    expect(pump?.programs).toEqual(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
    const swap = table.venues.find((v) => v.dex === 'pumpswap');
    expect(swap?.pools).toBe(18);
    expect(swap?.liquidityUsd).toBeCloseTo(203_488, 0);
  });

  it('each pair is where the registry run left it', () => {
    const fates: Record<string, number> = {};
    for (const p of table.pairs) fates[p.fate] = (fates[p.fate] ?? 0) + 1;
    expect(fates.excluded_unsupported_program).toBe(41 + 18 + 12 + 2 + 1);
    expect((fates.collected ?? 0) + (fates.dust_at_the_registry_run ?? 0) + 74).toBe(519);
    expect(fates.not_in_the_registry_run).toBeUndefined();
    for (const p of table.pairs.filter((x) => x.fate === 'excluded_unsupported_program'))
      expect(excluded.get(p.address)?.reason).toBe(`unsupported program ${p.program}`);
  });
});

describe('the table', () => {
  const table = solanaTable(frozen);
  const text = solanaMarkdown(table, byrealProbe(byrealFile));
  const row = (key: string) => {
    const r = table.rows.find((x) => x.key === key);
    if (!r) throw new Error(`no row ${key}`);
    return r;
  };

  it('says which stocks are quoted and which are not', () => {
    expect(table.tracked.stocks).toHaveLength(18);
    expect(table.tracked.quoted).toEqual([
      'COINx',
      'CRCLx',
      'GLDx',
      'HOODx',
      'MSTRx',
      'NVDAx',
      'QQQx',
      'SPCXx',
      'SPYx',
      'TSLAx',
    ]);
    expect(table.tracked.notQuoted).toEqual([
      'AAPLx',
      'AMZNx',
      'GMEx',
      'GOOGLx',
      'MCDx',
      'METAx',
      'MSFTx',
      'STRCx',
    ]);
    for (const s of table.tracked.notQuoted) expect(text).toContain(s);
  });

  it('has a row for every program not decoded: those on a route and those the registry excluded', () => {
    const unread = table.rows.filter((r) => r.group === 'unread').map((r) => r.program);
    // every program of `excluded` that holds a pair of a tracked stock
    for (const program of [
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
      'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
      'FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X',
    ])
      expect(unread).toContain(program);
    expect(unread).toContain(BYREAL);
    expect(unread).toContain(GOONFI);
    // every one of them is told apart by its program and has what a page says of it
    for (const r of table.rows.filter((x) => x.group === 'unread')) {
      expect(r.program).toBeTruthy();
      expect(VENUE_FACTS[r.program as string]).toBeDefined();
    }
  });

  it('a venue with no data has a row that says so, not a zero', () => {
    const byreal = row(`unread:${BYREAL}`);
    expect(byreal.discovery).toEqual({ none: NO_PAIR_LISTED });
    // and the text says once what that leaves open: the cap
    expect(text).toContain(
      'none of DexScreener’s 519 pairs for the 18 stocks is on that program; with 17 stocks at the cap of 30',
    );
    // a market maker's accounts are not decoded: what it holds is not a number
    expect(row(`unread:${GOONFI}`).measured).toEqual({ none: ACCOUNTS_NOT_DECODED });
    // a program on no route says so, in words
    const pump = row('unread:6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(pump.onRoutes).toEqual({ pools: 0, withAStockLeg: 0 });
    const line = text.split('\n').find((l) => l.startsWith('| Pump.fun |')) as string;
    expect(line).toContain('on none of the 346 routes');
    expect(line).toContain('41 · no figure · $643,796');
    // the liquidity nobody gave is not printed as a zero between the two dots
    expect(line).not.toContain('· $0 ·');
    expect(row('registry:not_found_by_the_registry_run').measured).toEqual({
      none: 'not in the registry: nothing measured what they hold',
    });
  });

  it('labels every estimate as one, with the cap and its date', () => {
    expect(text).toContain('*Estimates:* DexScreener');
    expect(text).toContain('at most 30 pairs a token');
    expect(text).toContain('2026-10-01 00:49Z');
    expect(text).toContain('17 of them at the cap (all but STRCx)');
    for (const header of text
      .split('\n')
      .filter((l) => l.startsWith('| Venue') || l.startsWith('| Pools | Measured')))
      expect(header).toContain('Discovery, estimate');
    expect(text).toContain('*Measured:* Jupiter’s quotes stored by the collector');
  });

  it('Byreal: on the routes of nine stocks, with what its pools held', () => {
    const byreal = row(`unread:${BYREAL}`);
    expect(byreal.name).toBe('Byreal');
    expect(byreal.fact?.decodable).toBe('from_accounts');
    expect(byreal.onRoutes.pools).toBeLessThanOrEqual(18);
    expect(byreal.stocks).not.toContain('GLDx');
    if ('none' in byreal.measured) throw new Error('Byreal has no measured money');
    expect(byreal.measured.pools).toBe(9);
    const money = table.forkMoney.filter(
      (m) => m.tvlUsd !== null && ctx.routePools.get(m.pool)?.owner === BYREAL,
    );
    expect(byreal.measured.usd).toBeCloseTo(
      money.reduce((t, m) => t + (m.tvlUsd as number), 0),
      6,
    );
    expect(row(`unread:${GOONFI}`).stocks).toEqual(['NVDAx']);
  });

  it('the registry rows carry what the run of Oct 1 measured', () => {
    const other = row('read:other').measured;
    const direct = row('read:direct_usd').measured;
    const dust = row('registry:dust_at_the_registry_run').measured;
    if ('none' in other || 'none' in direct || 'none' in dust)
      throw new Error('a row has no money');
    // PLAN-UNIVERSE section 2: 71 dollar pools, 58 SOL pools, 22 stock-to-stock, 718 others; RU.11: $5,610,870
    expect([direct.pools, other.pools]).toEqual([71, 718]);
    expect(Math.round(other.usd)).toBe(5_610_870);
    expect(row('read:via_sol').measured).toMatchObject({ pools: 58 });
    // 22 are filed under a tracked stock; one more pairs SPYx with TQQQx and is filed under TQQQx (RU.12's 260th)
    expect(
      registryRows.filter((p) => p.exitPath === 'via_xstock' && tracked.has(p.assetMint)),
    ).toHaveLength(22);
    const twoStocks = row('read:via_xstock').measured;
    if ('none' in twoStocks) throw new Error('no money');
    expect(twoStocks.pools).toBe(23);
    expect(Math.round(twoStocks.usd)).toBe(235_360);
    expect(twoStocks.notMeasured).toBeUndefined();
    expect(dust.pools).toBe(4553);
  });

  it('every pair DexScreener listed is in one row, and one row only', () => {
    const listed = table.rows.reduce(
      (t, r) => t + ('none' in r.discovery ? 0 : r.discovery.pools),
      0,
    );
    expect(listed).toBe(table.discovery?.pairs.length);
    expect(listed).toBe(519);
  });

  it('a volume of zero on a day with trades is DexScreener’s own figure, and is said', () => {
    const curve = row('unread:dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN').discovery;
    if ('none' in curve) throw new Error('no discovery figure');
    expect(curve).toMatchObject({
      pools: 2,
      liquidityUsd: null,
      volume24hUsd: 0,
      zeroVolumeWithTrades: 2,
    });
    const line = text.split('\n').find((l) => l.startsWith('| Dynamic Bonding Curve |')) as string;
    expect(line).toContain('2 · no figure · $0, 2 of them at $0 on a day with trades');
  });

  it('a pair the registry run did not open has a row of its own, and no venue is then said to have none', () => {
    // what a discovery file newer than the registry would hold: one more pair of SPYx, never opened on chain
    const newer = (frozen.discovery as DiscoveryRow[]).map((r) =>
      r.symbol === 'SPYx'
        ? {
            ...r,
            pairs: [
              ...(r.pairs ?? []),
              {
                pairAddress: 'a-pair-listed-after-the-registry-run',
                dexId: 'byreal',
                liquidity: { usd: 1000 },
                volume: { h24: 50 },
              },
            ],
          }
        : r,
    );
    const later = solanaTable({ ...frozen, discovery: newer });
    const unopened = later.rows.find((r) => r.key === 'unopened:byreal');
    expect(unopened?.discovery).toMatchObject({
      pools: 1,
      liquidityUsd: 1000,
      volume24hUsd: 50,
      stocks: ['SPYx'],
    });
    expect(unopened?.measured).toEqual({
      none: 'not opened on chain: neither its program nor what it holds was read',
    });
    expect(later.rows.find((r) => r.key === `unread:${BYREAL}`)?.discovery).toEqual({
      none: 'no pair of it listed among the pairs the registry run opened (not opened by that run, program not known: 1)',
    });
    // with the files of one run, as frozen, nothing is unopened
    expect(table.rows.some((r) => r.key.startsWith('unopened:'))).toBe(false);
  });

  it('the pools of a second hop are named by the tokens the chain read found in them', () => {
    const name = row('other_market:whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc').name;
    expect(name).toMatch(/^Whirlpool: pools that hold no tracked stock \(/);
    expect(name).toContain('SOL');
    expect(name).toContain('USDC');
  });

  it('the ranking lists what carries the stock, largest first, and marks what cannot be decoded', () => {
    const ranking = solanaRanking(table, null);
    expect(ranking[0]?.key).toBe(`unread:${BYREAL}`);
    expect(ranking[0]?.decodable).toBe('from_accounts');
    expect(ranking[0]?.closesBp).toEqual({ sell: null, buy: null });
    expect(ranking.find((r) => r.key === `unread:${GOONFI}`)?.decodable).toBe('not_from_accounts');
    expect(ranking.find((r) => r.key === 'read:other')?.decodable).toBe('registry_matter');
    for (const r of ranking) expect(r.sharePct.sell + r.sharePct.buy).toBeGreaterThan(0);
    // a venue with no stock leg at the largest size is not in it, whatever crosses it on a second hop
    expect(ranking.some((r) => r.key === `unread:${KIPSELI}`)).toBe(false);
  });

  it('the market makers are grouped by what a page says, and the two no page describes are left out', () => {
    for (const program of PROPRIETARY_MARKET_MAKERS)
      expect(VENUE_FACTS[program]?.decodable).not.toBe('from_accounts');
    expect(PROPRIETARY_MARKET_MAKERS).not.toContain(KIPSELI);
    expect(VENUE_FACTS[KIPSELI]?.decodable).toBe('not_established');
    for (const fact of Object.values(VENUE_FACTS)) expect(fact.basis.length).toBeGreaterThan(20);
  });
});

describe('the Byreal probe', () => {
  const probe = byrealProbe(byrealFile);

  it('the pool account decodes with Raydium’s header', () => {
    expect(byrealFile.program).toBe(BYREAL);
    expect(probe.pool).toMatchObject({
      decodes: true,
      mint0: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu',
      mint1: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tickSpacing: 10,
    });
    expect(tracked.get(probe.pool.mint0 as string)).toBe('COINx');
  });

  it('most of its arrays are not Raydium’s size', () => {
    expect(probe.children).toEqual({
      count: 38,
      raydiumFixed: 4,
      headerAndTicks: 32,
      bitmapExtensionSize: 1,
      other: 1,
      decoderReturnsNull: 29,
      decoderMisreads: 3,
    });
    // by hand: a size is 216 bytes and a whole number of 168-byte ticks
    const sizes = byrealFile.children.map((c) => c.space as number);
    expect(sizes.filter((s) => s === 10_240)).toHaveLength(4);
    expect(sizes.filter((s) => s !== 10_240 && s > 216 && (s - 216) % 168 === 0)).toHaveLength(32);
  });

  it('the array at the current tick is misread by the Raydium decoder, and fits a header and its ticks', () => {
    const a = probe.array;
    if (!a) throw new Error('no array');
    expect(a.startTickIndex).toBe(clmmArrayStart(probe.pool.tickCurrent as number, 10));
    expect(a.space).toBe(216 + 60 * 168);
    expect(a.isRaydiumSize).toBe(false);
    // every tick the Raydium layout reads is off the grid of 10 or outside the array's 600 ticks
    expect(a.asRaydium.ticks).toBe(11);
    expect(a.asRaydium.offGridOrOutOfRange).toBe(11);
    expect(a.asHeaderAndTicks).toEqual({
      fits: true,
      allocated: 60,
      ticksInPlace: 60,
      initialized: 10,
      initializedInHeader: 10,
    });
    expect(probe.invariantWithRaydiumDecoders).toBe('cannot_hold');
  });

  it('an array of Raydium’s own layout is not called a misread', () => {
    const fixed = gz<{ accounts: Record<string, string>; children: Record<string, string> }>(
      'fixtures/risk/pools/raydium-GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG.json.gz',
    );
    const pool = 'GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG';
    const header = decodeClmmPool(Buffer.from(fixed.accounts[pool] as string, 'base64'));
    const start = clmmArrayStart(header.tickCurrent, header.tickSpacing);
    // the Raydium pool's own array at its current tick
    const array = Object.entries(fixed.children).find(([, data]) => {
      const bytes = Buffer.from(data, 'base64');
      return bytes.length === 10_240 && bytes.readInt32LE(40) === start;
    });
    if (!array) throw new Error('the Raydium fixture holds no array at the current tick');
    const own = byrealProbe({
      ...byrealFile,
      pool: { address: pool, slot: 0, data: fixed.accounts[pool] as string },
      children: [{ address: array[0], space: 10_240, startTickIndex: start }],
      tickArray: { address: array[0], data: array[1] },
    });
    expect(own.array?.isRaydiumSize).toBe(true);
    expect(own.array?.asRaydium.ticks).toBeGreaterThan(0);
    expect(own.array?.asRaydium.offGridOrOutOfRange).toBe(0);
    expect(own.invariantWithRaydiumDecoders).toBe('not_refuted_by_this_array');
  });
});

describe('what a pool of a Raydium-sized fork held', () => {
  const pool = routePools.pools.find(
    (p) => p.address === '5pobXosbeGSCRG3HdaRiw2TaihDDQMXkHFVbUTF24weM',
  );
  if (!pool) throw new Error('the Byreal pool is not in the chain read');

  it('is the two vault balances, the stock at the pool’s own price', () => {
    const money = forkPoolMoney(pool, routePools.vaults, tracked);
    if (money.tvlUsd === null) throw new Error(money.reason);
    const data = Buffer.from(pool.data as string, 'base64');
    const coin = Object.values(routePools.vaults).filter((v) => tracked.get(v.mint) === 'COINx');
    // by hand: the vaults named at bytes 137 and 169 of the header, the price from the u128 at byte 253
    const sqrt = Number(data.readBigUInt64LE(253) + (data.readBigUInt64LE(261) << 64n)) / 2 ** 64;
    const price = sqrt ** 2 * 10 ** (8 - 6);
    const usdc = Number(
      Object.values(routePools.vaults).find(
        (v) => v.amount === String(Math.round(money.dollarUsd * 1e6)),
      )?.amount,
    );
    expect(money.stock).toBe('COINx');
    expect(money.dollarUsd).toBe(usdc / 1e6);
    expect(
      coin.some((v) => Math.abs((Number(v.amount) / 1e8) * price - money.stockUsd) < 1e-6),
    ).toBe(true);
    expect(money.tvlUsd).toBe(money.stockUsd + money.dollarUsd);
  });

  it('refuses a vault that does not hold the pool’s mint, and says when a vault was not read', () => {
    const vaults = Object.fromEntries(
      Object.entries(routePools.vaults).map(([k, v]) => [k, { ...v, mint: 'another-mint' }]),
    );
    expect(forkPoolMoney(pool, vaults, tracked)).toMatchObject({
      tvlUsd: null,
      reason: 'vault_mint_is_not_the_pools',
    });
    expect(forkPoolMoney(pool, {}, tracked)).toMatchObject({
      tvlUsd: null,
      reason: 'vault_not_read',
    });
    // a pool with no tracked stock against dollars has no dollar figure here
    const usdcUsdt = routePools.pools.find(
      (p) => p.address === '23XoPQqGw9WMsLoqTu8HMzJLD6RnXsufbKyWPLJywsCT',
    );
    expect(forkPoolMoney(usdcUsdt as typeof pool, routePools.vaults, tracked)).toMatchObject({
      tvlUsd: null,
      reason: 'no_dollar_side',
    });
  });
});

describe('the gap to Jupiter, and what a row accounts for', () => {
  // RU.11's fixture: the pools of QQQx and SPYx frozen 2026-10-06 21:21Z and the twelve quotes taken beside them
  const capture = {
    ...loadCapture('fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz'),
    only: null,
  };
  const built = buildSplit(capture);
  const quotes = parseQuotes(
    readFileSync('fixtures/risk/route/jupiter-quotes-20261006T2119.json', 'utf8'),
  );
  const routed = (key: string) => key === 'read:direct_usd' || key === 'read:via_sol';
  const poolsOf = (q: StoredQuote) => built.byAsset.get(q.assetMint)?.pools as RoutePool[];
  const plain = (q: StoredQuote) => {
    const g = gapOf(q, capture, built);
    if (!isGap(g)) throw new Error(g.skipped);
    return g.gapOneHopBp;
  };
  const pick = (asset: string, side: string, size: number) =>
    quotes.find(
      (q) => q.asset === asset && q.side === side && q.notionalUsd === size,
    ) as StoredQuote;

  it('the dollars of a stock leg: its own, or those at the end of its one chain', () => {
    const direct = find((x) => x.side === 'buy' && x.route?.length === 3 && x.asset === 'SPYx');
    expect(dollarsOfStockLeg(direct, legsOf(direct), 2)).toBe(1_400_000_000n);
    const twoHop = find((x) => x.side === 'sell' && x.asset === 'SPCXx' && x.route?.length === 2);
    expect(dollarsOfStockLeg(twoHop, legsOf(twoHop), 0)).toBe(1_001_508_407n);
    const buy = find((x) => x.side === 'buy' && x.asset === 'MSTRx' && x.route?.length === 2);
    expect(dollarsOfStockLeg(buy, legsOf(buy), 1)).toBe(1_000_000_000n);
    const threeHops = find((x) => x.route?.some((h) => h.label === 'Manifest') === true);
    expect(dollarsOfStockLeg(threeHops, legsOf(threeHops), 0)).toBe(999_886_387n);
    // two legs into one, or one into two: nothing is apportioned
    const merged = find((x) => x.asset === 'MSTRx' && x.side === 'sell' && x.route?.length === 3);
    expect(dollarsOfStockLeg(merged, legsOf(merged), 0)).toBeNull();
    const split = find((x) => x.route?.some((h) => h.label === 'Obsidian') === true);
    expect(dollarsOfStockLeg(split, legsOf(split), 0)).toBeNull();
  });

  it('with no leg taken, the replay is the plain gap of the router report', () => {
    for (const q of quotes) {
      const r = gapWithLegs(q, legsOf(q), [], poolsOf(q), ROUTE_CHUNKS);
      expect(r?.baseGapBp).toBeCloseTo(plain(q), 9);
      expect(r?.gapBp).toBeCloseTo(plain(q), 9);
    }
  });

  it('a sale with Byreal’s leg as Jupiter quoted it, by hand', () => {
    const q = pick('QQQx', 'sell', 100000);
    const legs = legsOf(q);
    const at = legs.findIndex((l) => l.label === 'Byreal');
    expect(legs[at]?.role).toBe('direct');
    const leg = q.route?.[at] as NonNullable<StoredQuote['route']>[number];
    const pools = poolsOf(q);
    const ref = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0] as RoutePool;
    // our router sells what Jupiter did not send to Byreal; Byreal's own dollars are added as quoted
    const rest = ((Number(q.amountIn) - Number(leg.inAmount)) / 1e8) * ref.midUsd;
    const ours = routeTrade(pools, rest, 'sell', ROUTE_CHUNKS).outUsd + Number(leg.outAmount) / 1e6;
    const expected = (Number(q.outAmount) / 1e6 / ours - 1) * 10_000;
    const r = gapWithLegs(q, legs, [at], pools, ROUTE_CHUNKS);
    expect(r?.gapBp).toBeCloseTo(expected, 6);
    expect(r?.baseGapBp).toBeCloseTo(plain(q), 9);
    // Jupiter is 13 bp ahead of our router on this sale; with Byreal's 17% as it used it, our route is ahead
    expect(plain(q)).toBeCloseTo(13.0019, 3);
    expect(r?.gapBp).toBeCloseTo(-2.8533, 3);
  });

  it('a purchase with Byreal’s leg as Jupiter quoted it, by hand', () => {
    const q = pick('SPYx', 'buy', 10000);
    const legs = legsOf(q);
    const at = legs.findIndex((l) => l.label === 'Byreal');
    const leg = q.route?.[at] as NonNullable<StoredQuote['route']>[number];
    const pools = poolsOf(q);
    const routedRest = routeTrade(
      pools,
      (Number(q.amountIn) - Number(leg.inAmount)) / 1e6,
      'buy',
      ROUTE_CHUNKS,
    );
    const tokens = routedRest.outUsd / routedRest.refMidUsd + Number(leg.outAmount) / 1e8;
    const r = gapWithLegs(q, legs, [at], pools, ROUTE_CHUNKS);
    expect(r?.gapBp).toBeCloseTo((Number(q.outAmount) / 1e8 / tokens - 1) * 10_000, 6);
  });

  it('the whole quote taken as Jupiter quoted it leaves no gap', () => {
    const q = pick('QQQx', 'sell', 1000);
    expect(q.route).toHaveLength(1);
    expect(gapWithLegs(q, legsOf(q), [0], poolsOf(q), ROUTE_CHUNKS)?.gapBp).toBeCloseTo(0, 6);
  });

  it('a pair as the account reads it: each class the router does not use, and all of them together', () => {
    // Jupiter: 33% Byreal, 4% PancakeSwap, 63% a Raydium pool of the registry
    const q = pick('SPYx', 'sell', 1000);
    const legs = legsOf(q);
    const share = gapShareOf(q, legs, plain(q), poolsOf(q), keyOf, routed, ROUTE_CHUNKS);
    const pancake = 'unread:HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq';
    expect(Object.keys(share.stockPctByClass).sort()).toEqual(
      [OUTSIDE, 'read:direct_usd', `unread:${BYREAL}`, pancake].sort(),
    );
    expect(share.stockPctByClass[OUTSIDE]).toBeCloseTo(
      (share.stockPctByClass[`unread:${BYREAL}`] as number) +
        (share.stockPctByClass[pancake] as number),
      9,
    );
    expect(share.stockPctByClass[OUTSIDE]).toBeCloseTo(37, 4);
    const at = (label: string) => legs.findIndex((l) => l.label === label);
    const by = (indexes: number[]) =>
      gapWithLegs(q, legs, indexes, poolsOf(q), ROUTE_CHUNKS)?.gapBp;
    expect(share.gapWithClassBp?.[`unread:${BYREAL}`]).toBeCloseTo(by([at('Byreal')]) as number, 9);
    expect(share.gapWithClassBp?.[pancake]).toBeCloseTo(by([at('PancakeSwap')]) as number, 9);
    expect(share.gapWithClassBp?.[OUTSIDE]).toBeCloseTo(
      by([at('Byreal'), at('PancakeSwap')]) as number,
      9,
    );
    // the classes the router uses are not replayed
    expect(share.gapWithClassBp?.['read:direct_usd']).toBeUndefined();
    // a plain gap that is not the replay's own is refused: the two were not run on the same pools
    expect(() =>
      gapShareOf(q, legs, plain(q) + 1, poolsOf(q), keyOf, routed, ROUTE_CHUNKS),
    ).toThrow('the replay’s plain gap is not the router report’s'.replace(/’/g, "'"));
    // a pair inside the router's pools has nothing outside
    const inside = pick('QQQx', 'sell', 1000);
    const own = gapShareOf(
      inside,
      legsOf(inside),
      plain(inside),
      poolsOf(inside),
      keyOf,
      routed,
      ROUTE_CHUNKS,
    );
    expect(own.stockPctByClass).toEqual({ 'read:direct_usd': 100 });
    expect(own.gapWithClassBp).toEqual({});
  });

  it('the ranking carries what a row closes, and says when the gap sample never saw it', () => {
    const rows = quotes.map((q) =>
      gapShareOf(q, legsOf(q), plain(q), poolsOf(q), keyOf, routed, ROUTE_CHUNKS),
    );
    const account = gapAccount(rows, routed);
    const ranking = solanaRanking(solanaTable(frozen), account);
    const group = account.find((g) => g.side === 'sell' && g.notionalUsd === 100000);
    const byreal = group?.rows.find((r) => r.key === `unread:${BYREAL}`);
    if (!byreal?.asJupiterUsedIt) throw new Error('no replay');
    expect(ranking.find((r) => r.key === `unread:${BYREAL}`)?.closesBp.sell).toEqual(
      byreal.asJupiterUsedIt.closesBp,
    );
    // GoonFi V2 is in the table and on none of these twelve pairs: no figure, which is not "closes nothing"
    expect(ranking.find((r) => r.key === `unread:${GOONFI}`)?.closesBp.sell).toEqual({
      none: 'no pair of the gap sample uses it at this size',
    });
    // both $100k sales use Byreal and nothing else outside: the row for everything together is Byreal's
    expect(group?.rows.find((r) => r.key === OUTSIDE)?.asJupiterUsedIt).toEqual(
      byreal.asJupiterUsedIt,
    );
    // by stock: QQQx's sale of $100k is 13.00 bp behind Jupiter, and 2.85 bp ahead with Byreal's leg
    const byStock = ['QQQx', 'SPYx'].map((asset) => ({
      asset,
      account: gapAccount(
        rows.filter((r) => r.asset === asset && r.notionalUsd === 100000),
        routed,
      ),
    }));
    const lines = gapByStockMarkdown(
      byStock,
      (key) => (key === `unread:${BYREAL}` ? 'Byreal' : key),
      OUTSIDE,
    );
    expect(lines).toContain('| QQQx | 1 · 13.00 → -2.85 | Byreal 15.86 |');
    expect(lines).toContain('at $100k, by stock');
    expect(lines.split('\n').filter((l) => l.startsWith('| SPYx |'))).toHaveLength(1);
  });

  it('the account of a group, recomputed by hand', () => {
    // every class the router does not use, each with its own legs; the pools of the capture are the routed ones
    const inCapture = (q: StoredQuote) => new Set(poolsOf(q).map((p) => p.pool));
    const rows: GapShare[] = quotes.map((q) => {
      const legs = legsOf(q);
      const stockPctByClass: Record<string, number> = {};
      const legsOfClass = new Map<string, number[]>();
      legs.forEach((l, i) => {
        if (l.stockPct === null) return;
        const key = inCapture(q).has(l.pool) ? 'read:direct_usd' : `unread:${l.label}`;
        stockPctByClass[key] = (stockPctByClass[key] ?? 0) + l.stockPct;
        legsOfClass.set(key, [...(legsOfClass.get(key) ?? []), i]);
      });
      const gapWithClassBp: Record<string, number | null> = {};
      for (const [key, indexes] of legsOfClass)
        if (!routed(key))
          gapWithClassBp[key] =
            gapWithLegs(q, legs, indexes, poolsOf(q), ROUTE_CHUNKS)?.gapBp ?? null;
      return {
        asset: q.asset,
        side: q.side as 'sell' | 'buy',
        notionalUsd: q.notionalUsd,
        gapBp: plain(q),
        stockPctByClass,
        gapWithClassBp,
      };
    });
    const account = gapAccount(rows, routed);
    expect(account).toHaveLength(6);
    const g = account.find((x) => x.side === 'sell' && x.notionalUsd === 100000);
    if (!g) throw new Error('no group');
    const group = rows.filter((r) => r.side === 'sell' && r.notionalUsd === 100000);
    expect(g.pairs).toBe(2);
    expect(g.gapBp.mean).toBeCloseTo(mean(group.map((r) => r.gapBp)) as number, 9);
    expect(g.gapBp.median).toBeCloseTo(median(group.map((r) => r.gapBp)) as number, 9);
    // both sales of $100k use Byreal: none stayed inside the router's pools
    expect(g.withinRoutedPools).toEqual({ pairs: 0, median: null, mean: null });
    const byreal = g.rows.find((r) => r.key === 'unread:Byreal');
    if (!byreal?.asJupiterUsedIt) throw new Error('no replay');
    expect(byreal.pairs).toBe(2);
    expect(byreal.meanSharePct).toBeCloseTo(
      mean(group.map((r) => r.stockPctByClass['unread:Byreal'] as number)) as number,
      9,
    );
    const after = group.map((r) => r.gapWithClassBp?.['unread:Byreal'] as number);
    expect(byreal.asJupiterUsedIt.pairsReplayed).toBe(2);
    expect(byreal.asJupiterUsedIt.gapBp.mean).toBeCloseTo(mean(after) as number, 9);
    expect(byreal.asJupiterUsedIt.closesBp.mean).toBeCloseTo(
      (mean(group.map((r) => r.gapBp)) as number) - (mean(after) as number),
      9,
    );
    // a pair that does not use the class keeps its own gap in the gap that is left
    const small = account.find((x) => x.side === 'buy' && x.notionalUsd === 1000);
    expect(small?.rows).toEqual([]);
    expect(small?.withinRoutedPools.pairs).toBe(2);
    expect(gapMarkdown(account, (k) => k, 'the frozen pairs')).toContain('unread:Byreal');
  });
});

describe('Robinhood Chain, by venue', () => {
  const table = robinhoodTable(robinhood.flow.rows, robinhood.cut.pools);
  const venue = (name: string) => {
    const v = table.venues.find((x) => x.venue === name);
    if (!v) throw new Error(`no venue ${name}`);
    return v;
  };
  const cutOf = (is: (p: CutPoolRow) => boolean) => robinhood.cut.pools.filter(is);
  const volumeOf = (pools: CutPoolRow[]) => {
    const ids = new Set(pools.map((p) => p.address.toLowerCase()));
    return robinhood.flow.rows
      .filter((f) => ids.has(f.pool.toLowerCase()))
      .reduce((t, f) => t + f.sellUsd + f.buyUsd, 0);
  };

  it('427 pools of 30 stocks, each with its 28 days', () => {
    expect(table.pools).toBe(427);
    expect(table.stocks).toHaveLength(30);
    expect(table.poolsWithoutAFlowRow).toBe(0);
    expect(table.flowRowsOutsideTheCut).toBe(0);
    expect(table.dataFrom).toBe('2026-09-08T03:00:00.000Z');
    expect(table.dataTo).toBe('2026-10-06T02:46:36.000Z');
    expect(robinhood.cut.dexscreenerAtCap).toHaveLength(21);
  });

  it('each venue’s volume is the sum of its pools’ rows, and the shares add up', () => {
    const total = robinhood.flow.rows.reduce((t, f) => t + f.sellUsd + f.buyUsd, 0);
    expect(table.volume28dUsd).toBeCloseTo(total, 2);
    expect(Math.round(total / 1e6)).toBe(4210);
    const ramses = cutOf((p) => p.venue === 'ramses-v3');
    expect(venue('ramses-v3')).toMatchObject({ pools: 21, reached: false, fit: 'v3_interface' });
    expect(venue('ramses-v3').volume28dUsd).toBeCloseTo(volumeOf(ramses), 2);
    expect(venue('ramses-v3').volumeSharePct).toBeCloseTo((volumeOf(ramses) / total) * 100, 9);
    expect(venue('ramses-v3').tvlUsd).toBeCloseTo(
      ramses.reduce((t, p) => t + (p.tvlUsd ?? 0), 0),
      6,
    );
    expect(table.venues.reduce((t, v) => t + (v.volumeSharePct ?? 0), 0)).toBeCloseTo(100, 9);
    expect(table.venues.reduce((t, v) => t + v.pools, 0)).toBe(427);
  });

  it('the vault’s swap path reaches Uniswap v3 and the v4 pools with no hook, and nothing else', () => {
    expect(table.venues.filter((v) => v.reached).map((v) => v.venue)).toEqual([
      'uniswap-v3',
      'uniswap-v4 (no hook)',
    ]);
    expect(venue('uniswap-v3').pools).toBe(101);
    expect(venue('uniswap-v4 (no hook)').pools).toBe(173);
    expect(venue('uniswap-v4 (hook)')).toMatchObject({ pools: 59, reached: false, fit: 'hook' });
    const reached = volumeOf(cutOf((p) => p.reachable));
    expect(table.reachedVolumeSharePct).toBeCloseTo((reached / table.volume28dUsd) * 100, 9);
    expect(table.reachedVolumeSharePct).toBeCloseTo(80.84, 2);
  });

  it('a venue the walk decoded no swap of has no volume, not a volume of zero', () => {
    const giga = venue('giga-v3');
    expect(giga).toMatchObject({
      pools: 11,
      swaps: 0,
      volume28dUsd: null,
      volumeReason: 'no_swap_decoded_by_the_walk',
      volumeSharePct: null,
      fit: 'v3_reads_other_swap_log',
    });
    // DexScreener gave these pools volume on the day of discovery: they trade, under a log the walk does not read
    expect(giga.dexscreener.volume24hUsd).toBeGreaterThan(5_000_000);
    const text = robinhoodMarkdown(table, { flow: 'the frozen rows', cut: 'the frozen cut' });
    const line = text.split('\n').find((l) => l.startsWith('| giga-v3')) as string;
    expect(line).toContain('no data: the walk decoded no swap of its pools');
    expect(line).not.toContain('$0 ·');
    // a pool with no swap inside a venue that has swaps is a measured zero, and is counted
    expect(
      venue('uniswap-v4 (no hook)').poolsWithoutASwap +
        venue('uniswap-v4 (hook)').poolsWithoutASwap,
    ).toBe(3);
  });

  it('what each venue is to the code we have, from what its pools answered', () => {
    expect(venue('up-v3').fit).toBe('v3_interface');
    expect(venue('sushiswap-v3').fit).toBe('v3_interface');
    // no pool of these answers slot0(): concentrated liquidity behind another interface
    expect(
      cutOf((p) => p.venue === 'alandale').every((p) => !p.answers.slot0 && p.answers.liquidity),
    ).toBe(true);
    expect(venue('alandale').fit).toBe('cl_other_interface');
    expect(venue('kittenswap').fit).toBe('cl_other_interface');
    expect(venue('uniswap-v2').fit).toBe('not_cl');
  });

  it('a figure DexScreener did not give is counted, and a v4 pool is named by why it is left out', () => {
    const pools = robinhood.cut.pools.map((p, i) => ({
      ...p,
      // one listed pool with no liquidity figure
      dexscreener:
        i === robinhood.cut.pools.findIndex((x) => x.venue === 'ramses-v3')
          ? { liquidityUsd: null, volumeH24Usd: p.dexscreener?.volumeH24Usd ?? null }
          : p.dexscreener,
    }));
    const t = robinhoodTable(robinhood.flow.rows, pools);
    const ramses = t.venues.find((v) => v.venue === 'ramses-v3');
    expect(ramses?.dexscreener.withoutLiquidity).toBe(1);
    expect(ramses?.dexscreener.pools).toBe(21);
    expect(ramses?.dexscreener.liquidityUsd).toBeLessThan(
      venue('ramses-v3').dexscreener.liquidityUsd,
    );
    expect(venue('ramses-v3').dexscreener).toMatchObject({ withoutLiquidity: 0, withoutVolume: 0 });
    // every v4 pool the path leaves out today has a hook; one left out for another reason is not called a hook
    expect(
      cutOf((p) => p.venue === 'uniswap-v4' && !p.reachable).every(
        (p) => p.unreachableReason === 'has_hook',
      ),
    ).toBe(true);
    const other = robinhoodTable(
      robinhood.flow.rows,
      robinhood.cut.pools.map((p) =>
        p.venue === 'uniswap-v4' && !p.reachable ? { ...p, unreachableReason: 'paused' } : p,
      ),
    );
    expect(other.venues.some((v) => v.venue === 'uniswap-v4 (hook)')).toBe(false);
    expect(other.venues.find((v) => v.venue === 'uniswap-v4 (paused)')).toMatchObject({
      pools: 59,
      fit: 'not_reached',
    });
  });

  it('the join of the cut with its discovery refuses a pool the discovery does not hold', () => {
    const p = {
      address: '0xabc',
      symbol: 'NVDA',
      venue: 'x',
      kind: 'cl',
      reachable: false,
      tvlUsd: 1,
    };
    expect(() => cutPoolRows([p], [])).toThrow('in the cut and not in its discovery file');
    expect(
      cutPoolRows([p], [{ id: '0xABC', factory: '0xF', sqrtPriceX96: '1', liquidity: null }])[0],
    ).toMatchObject({
      factory: '0xF',
      answers: { slot0: true, liquidity: false, fee: false, tickSpacing: false },
      dexscreener: null,
    });
  });
});

describe('the command, from the frozen rows alone', () => {
  // no collector's home, no database, no network: the folders it would read by default do not exist here
  const run = (...args: string[]) =>
    venuesReport(['--fixtures', ...args], {
      RISK_HOME: '/no-such-folder/risk-home',
      RISK_DATA_DIR: '/no-such-folder/data',
      RISK_EVM_DIR: '/no-such-folder/evm',
    });

  it('prints the tables the functions give', async () => {
    const text = await run('--md');
    expect(text).toContain(solanaMarkdown(solanaTable(frozen), byrealProbe(byrealFile)));
    expect(text).toContain(
      robinhoodMarkdown(robinhoodTable(robinhood.flow.rows, robinhood.cut.pools), {
        flow: `${FROZEN.robinhood}: ${robinhood.flow.source}`,
        cut: `the same file: ${robinhood.cut.source.split(':')[0]} (${robinhood.cut.method}, ${robinhood.cut.fetchedAt.slice(0, 16)}Z)`,
      }),
    );
    // no captures were named: no gap table, and nothing said about a gap
    expect(text).not.toContain('Table 4');
  });

  it('as JSON with RU.11’s frozen capture: the gap of the pairs it can compare, and the ranking', async () => {
    const out = JSON.parse(await run('--captures', 'fixtures/risk/route', '--no-robinhood')) as {
      method: string;
      robinhood: unknown;
      gap: {
        source: string;
        bySideAndSize: Array<{ side: string; notionalUsd: number; pairs: number }>;
      };
      ranking: { solana: Array<{ key: string; closesBp: { sell: unknown } }> };
      solana: { quotes: { rows: number; withARoute: number }; shares?: unknown };
    };
    expect(out.method).toBe('venues-0.1');
    expect(out.robinhood).toBeNull();
    expect(out.solana.quotes).toMatchObject({ rows: 720, withARoute: 693 });
    // the capture is cut to QQQx: only its quotes within five minutes are compared
    expect(out.gap.bySideAndSize.length).toBeGreaterThan(0);
    for (const g of out.gap.bySideAndSize) expect(g.pairs).toBeGreaterThan(0);
    expect(out.ranking.solana[0]?.key).toBe(`unread:${BYREAL}`);
    expect(out.ranking.solana[0]?.closesBp.sell).toHaveProperty('median');
  });

  it('takes the frozen quotes and the frozen Robinhood file by name as well', async () => {
    const text = await run('--quotes', FROZEN.cases, '--robinhood', FROZEN.robinhood, '--md');
    // the thirteen case rows: eleven with a route
    expect(text).toContain('13 rows, 11 with a route');
    expect(text).toContain('**Table 5. Robinhood Chain, by venue.**');
  });

  it('refuses an option with no value, and a time that is not one', async () => {
    await expect(run('--until')).rejects.toThrow('--until takes a value');
    await expect(run('--until', 'yesterday')).rejects.toThrow('not a time');
  });
});

describe('nothing here reads an oracle', () => {
  it('no file of the table names a price feed, an oracle table or a price package', () => {
    const dir = 'scripts/risk/venues';
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const source = readFileSync(join(dir, name), 'utf8');
      // the code only: the two notes that say nothing reads an oracle are comments and a sentence of the output
      const code = source
        .split('\n')
        .filter(
          (l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.includes('note:'),
        )
        .join('\n');
      for (const word of [
        'risk_price_observations',
        'risk_reference_prices',
        'scope',
        'chainlink',
        '/prices/',
      ])
        expect(code.toLowerCase(), `${name}: ${word}`).not.toContain(word);
      // Pyth is named once, in what a page says of Byreal's fee: nothing reads it
      if (name !== 'venue-facts.ts') expect(code.toLowerCase(), name).not.toContain('pyth');
    }
  });
});
