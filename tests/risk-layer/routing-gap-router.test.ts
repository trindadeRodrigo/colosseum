import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type PoolSim, ROUTE_CHUNKS, type RoutePool, routeTrade } from '@colosseum/risk';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type GapRow,
  gapOf,
  isGap,
  mean,
  median,
  PAIR_WINDOW_MS,
  pairingOf,
  pairQuotes,
  parseQuotes,
  parseRouterArgs,
  provenanceOf,
  ROUTING_GAP_ROUTER_METHOD,
  type StoredQuote,
  stockShares,
  summarize,
  usableCaptures,
} from '../../scripts/risk/lib-routing-gap';
import {
  type BuiltSplit,
  buildSplit,
  loadCapture,
  type SplitCapture,
  twoHopWholeFor,
} from '../../scripts/risk/lib-split';

// PLAN-UNIVERSE RU.11 — `pnpm risk:routing-gap --router`: each stored Jupiter quote against routeTrade on frozen
// pools, with one hop and with two. The pools are the mainnet accounts frozen 2026-10-06T21:21:16Z
// (fixtures/risk/route), the quotes the collector's twelve rows for QQQx and SPYx taken within five minutes of them.
// The capture was cut to QQQx (`only`): it holds every pool of QQQx but only part of the stock-to-stock pools of
// SPYx, so the report compares the six QQQx quotes and names the six SPYx ones as not compared. Viewed as a whole run
// (`only` removed, here only) all twelve are compared, which is how the arithmetic of both stocks is checked.
// Every gap is recomputed here from a direct routeTrade call. The script is run as a child process on files only:
// no test calls the network, and RISK_HOME points at a temporary folder.
const CAPTURE = 'fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz';
const QUOTES = 'fixtures/risk/route/jupiter-quotes-20261006T2119.json';
const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const AMZNX = 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg';

const cap = loadCapture(CAPTURE);
// the same capture viewed as a whole run: the pools do not change, only which stocks are compared
const whole: SplitCapture = { ...cap, only: null };
const built = buildSplit(cap);
const quotes = parseQuotes(readFileSync(QUOTES, 'utf8'));
const row = (
  q: StoredQuote,
  b: BuiltSplit = built,
  c: SplitCapture = whole,
  chunks?: number,
): GapRow => {
  const g = gapOf(q, c, b, chunks);
  if (!isGap(g)) throw new Error(`${q.asset}: ${g.skipped}`);
  return g;
};
const fixtureQuote = (asset: string, side: string, notionalUsd: number): StoredQuote => {
  const q = quotes.find(
    (x) => x.asset === asset && x.side === side && x.notionalUsd === notionalUsd,
  );
  if (!q) throw new Error(`no ${asset} ${side} ${notionalUsd} in the fixture`);
  return q;
};

const quoteAt = (fetchedAt: string, over: Partial<StoredQuote> = {}): StoredQuote => ({
  asset: 'AAAx',
  assetMint: 'MintA',
  side: 'sell',
  notionalUsd: 1000,
  amountIn: '1000000000',
  outAmount: '1000000000',
  route: [],
  error: null,
  fetchedAt,
  ...over,
});

describe('pairQuotes', () => {
  const at2100 = { fetchedAt: '2026-10-06T21:00:00.000Z', name: 'first' };
  const at2108 = { fetchedAt: '2026-10-06T21:08:00.000Z', name: 'second' };

  it('pairs a quote inside the window and counts one outside it as unpaired', () => {
    const r = pairQuotes(
      [
        quoteAt('2026-10-06T21:04:59.000Z'),
        quoteAt('2026-10-06T21:05:00.000Z'),
        quoteAt('2026-10-06T21:05:00.001Z'),
        quoteAt('2026-10-06T20:54:59.999Z'),
      ],
      [at2100],
    );
    expect(r.pairs.map((p) => p.quote.fetchedAt)).toEqual([
      '2026-10-06T21:04:59.000Z',
      '2026-10-06T21:05:00.000Z',
    ]);
    expect(r.unpaired).toBe(2);
    expect(r.withoutAQuote).toBe(0);
    expect(PAIR_WINDOW_MS).toBe(5 * 60_000);
  });

  it('takes the window it is given', () => {
    const q = [quoteAt('2026-10-06T21:01:30.000Z')];
    expect(pairQuotes(q, [at2100], 60_000).pairs).toHaveLength(0);
    expect(pairQuotes(q, [at2100], 90_000).pairs).toHaveLength(1);
  });

  it('sends a quote to the nearest of two captures, and to the earlier one on a tie', () => {
    const r = pairQuotes(
      [
        quoteAt('2026-10-06T21:03:00.000Z'),
        quoteAt('2026-10-06T21:05:00.000Z'),
        quoteAt('2026-10-06T21:04:00.000Z'),
        quoteAt('2026-10-06T21:12:00.000Z'),
      ],
      [at2100, at2108],
    );
    expect(r.pairs.map((p) => p.capture.name)).toEqual(['first', 'second', 'first', 'second']);
    expect(
      pairQuotes([quoteAt('2026-10-06T21:04:00.000Z')], [at2108, at2100]).pairs[0]?.capture,
    ).toBe(at2108);
    expect(r.unpaired).toBe(0);
  });

  it('never pairs a quote with an error or with no amount', () => {
    const r = pairQuotes(
      [
        quoteAt('2026-10-06T21:00:10.000Z', { error: 'COULD_NOT_FIND_ANY_ROUTE' }),
        quoteAt('2026-10-06T21:00:10.000Z', { outAmount: null }),
        quoteAt('2026-10-06T21:00:10.000Z', { outAmount: '0' }),
        quoteAt('2026-10-06T21:00:10.000Z'),
      ],
      [at2100],
    );
    expect(r.pairs).toHaveLength(1);
    expect(r.withoutAQuote).toBe(3);
    expect(r.unpaired).toBe(0);
  });

  it('pairs nothing with no capture or with a date that does not parse', () => {
    expect(pairQuotes([quoteAt('2026-10-06T21:00:10.000Z')], [])).toMatchObject({
      pairs: [],
      unpaired: 1,
    });
    expect(pairQuotes([quoteAt('not a date')], [at2100]).unpaired).toBe(1);
  });
});

describe('usableCaptures', () => {
  it('leaves out a capture taken without two hops, by name, and keeps the others in their order', () => {
    const a = { file: 'a.json.gz', fetchedAt: '2026-10-06T21:00:00.000Z', twoHop: true };
    const b = { file: 'b.json.gz', fetchedAt: '2026-10-06T21:01:00.000Z', twoHop: false };
    const c = { file: 'c.json.gz', fetchedAt: '2026-10-06T21:02:00.000Z', twoHop: true };
    const r = usableCaptures([a, b, c]);
    expect(r.usable).toEqual([a, c]);
    expect(r.usable[0]).toBe(a);
    expect(r.notUsed).toEqual([{ file: 'b.json.gz', reason: 'taken_without_two_hops' }]);
    expect(usableCaptures([])).toEqual({ usable: [], notUsed: [] });
  });

  it('a one-hop view of the fixture takes no quote, even first in the list and as near as the fixture', () => {
    const view = { ...cap, twoHop: false, file: 'one-hop-view' };
    const full = { ...cap, file: 'fixture' };
    // both at the same time: on the tie the earlier one would take every quote
    expect(pairQuotes(quotes, [view, full]).pairs.every((p) => p.capture === view)).toBe(true);
    const { usable, notUsed } = usableCaptures([view, full]);
    expect(notUsed).toEqual([{ file: 'one-hop-view', reason: 'taken_without_two_hops' }]);
    const paired = pairQuotes(quotes, usable);
    expect(paired.pairs).toHaveLength(12);
    expect(paired.pairs.every((p) => p.capture === full)).toBe(true);
    // alone, it leaves every quote without a capture: nothing is scored
    const alone = pairQuotes(quotes, usableCaptures([view]).usable);
    expect(alone.pairs).toEqual([]);
    expect(alone.unpaired).toBe(12);
  });
});

describe('parseQuotes', () => {
  it('reads the fixture shape, an array, and the collector lines', () => {
    expect(quotes).toHaveLength(12);
    const lines = quotes.map((q) => JSON.stringify(q)).join('\n');
    expect(parseQuotes(`${lines}\n`)).toEqual(quotes);
    expect(parseQuotes(JSON.stringify(quotes))).toEqual(quotes);
    expect(parseQuotes(JSON.stringify(quotes[0]))).toEqual([quotes[0]]);
    expect(parseQuotes('  \n')).toEqual([]);
    expect(() => parseQuotes('12')).toThrow();
  });
});

describe('the frozen quotes against the frozen pools', () => {
  const paired = pairQuotes(quotes, [cap]);

  it('pairs all twelve: every quote is within five minutes of the capture', () => {
    expect(paired.pairs).toHaveLength(12);
    expect(paired.unpaired).toBe(0);
    expect(paired.withoutAQuote).toBe(0);
    expect(new Set(quotes.map((q) => `${q.asset} ${q.side} ${q.notionalUsd}`)).size).toBe(12);
  });

  it.each(quotes.map((q) => [`${q.asset} ${q.side} $${q.notionalUsd}`, q] as const))(
    '%s: the gap is the one a direct routeTrade call gives',
    (_name, q) => {
      const a = built.byAsset.get(q.assetMint);
      if (!a) throw new Error('asset not in the fixture');
      // the reference pool by hand: the largest by TVL, the earlier one on a tie
      let ref = a.pools[0] as RoutePool;
      for (const p of a.pools) if (p.tvlUsd > ref.tvlUsd) ref = p;
      // the stock's decimals from the registry row, not from the router's pools
      const reg = cap.direct.find((p) => p.assetMint === q.assetMint);
      if (!reg) throw new Error('no registry row');
      const dec = reg.assetIsToken0 ? reg.decimals0 : reg.decimals1;
      expect(dec).toBe(8);
      const sell = q.side === 'sell';
      const side = sell ? 'sell' : 'buy';
      const amount = sell ? Number(q.amountIn) / 10 ** dec : Number(q.amountIn) / 1e6;
      const notional = sell ? amount * ref.midUsd : amount;
      const one = routeTrade(a.pools, notional, side);
      const two = routeTrade(a.pools, notional, side, ROUTE_CHUNKS, {
        pools: a.twoHop,
        via: built.via,
      });
      // the legs add up to the quote's amount: units of the stock for a sale, dollars for a purchase
      for (const r of [one, two]) {
        const sent = r.legs.reduce((t, l) => t + l.amountIn, 0);
        expect(Math.abs(sent / amount - 1)).toBeLessThan(1e-12);
        expect(r.refPool).toBe(ref.pool);
        // What the pools of a sale are sent is that amount to a few raw units, not to the unit: it went through a
        // float notional, and each leg is floored to raw units, so at most one unit a leg is left out.
        if (sell) {
          const raw = r.legs.reduce((t, l) => t + Math.floor(l.amountIn * 10 ** dec), 0);
          expect(Number(q.amountIn) - raw).toBeGreaterThanOrEqual(0);
          expect(Number(q.amountIn) - raw).toBeLessThanOrEqual(r.legs.length);
        }
      }
      const jupiter = sell ? Number(q.outAmount) / 1e6 : Number(q.outAmount) / 10 ** dec;
      const oursOne = sell ? one.outUsd : one.outUsd / ref.midUsd;
      const oursTwo = sell ? two.outUsd : two.outUsd / ref.midUsd;

      const g = row(q);
      expect(g.asset).toBe(q.asset);
      expect(g.side).toBe(q.side);
      expect(g.notionalUsd).toBe(q.notionalUsd);
      expect(g.quoteFetchedAt).toBe(q.fetchedAt);
      expect(g.captureFetchedAt).toBe(cap.fetchedAt);
      expect(g.quoteProvenance).toBe('live');
      expect(g.captureProvenance).toBe('live');
      expect(g.unit).toBe(sell ? 'usd' : 'tokens');
      expect(g.jupiter).toBe(jupiter);
      expect(g.oneHop).toBe(oursOne);
      expect(g.twoHop).toBe(oursTwo);
      expect(g.gapOneHopBp).toBe((jupiter / oursOne - 1) * 10_000);
      expect(g.gapTwoHopBp).toBe((jupiter / oursTwo - 1) * 10_000);
      expect(g.gainBp).toBe(g.gapOneHopBp - g.gapTwoHopBp);
      // the two-hop legs are the legs of the second route that go through a stock-to-stock pool of this asset
      expect(g.twoHopLegs).toEqual(two.legs.filter((l) => l.via));
      const own = new Set(a.twoHop.map((p) => p.pool));
      for (const l of g.twoHopLegs) {
        expect(own.has(l.pool)).toBe(true);
        expect(l.amountIn).toBeGreaterThan(0);
      }
      // with no chunk sent through two hops the two routes are the same numbers, so nothing is gained or lost
      if (!g.twoHopLegs.length) expect(g.gainBp).toBe(0);
      // the gain is our two routes against each other, on the same pools: Jupiter's amount scales it and no more
      expect(g.gainBp).toBeCloseTo((jupiter / oursOne) * (1 - oursOne / oursTwo) * 10_000, 6);
      // a gap on the same pools minutes apart is a matter of basis points, not of percent
      expect(Math.abs(g.gapOneHopBp)).toBeLessThan(100);
    },
  );

  it('the capture as it was cut compares the six QQQx quotes and not the six SPYx ones', () => {
    expect(cap.only).toEqual(['QQQx']);
    expect(twoHopWholeFor(cap, 'QQQx')).toBe(true);
    expect(twoHopWholeFor(cap, 'SPYx')).toBe(false);
    let compared = 0;
    let notCompared = 0;
    for (const q of quotes) {
      const g = gapOf(q, cap, built);
      if (q.asset === 'QQQx') {
        // the gap recomputed by hand above: the selection changes which quotes are compared, not a figure
        expect(g).toEqual(row(q));
        compared++;
      } else {
        expect(q.asset).toBe('SPYx');
        expect(g).toEqual({ skipped: 'asset_outside_the_capture_selection', asset: 'SPYx' });
        notCompared++;
      }
    }
    expect([compared, notCompared]).toEqual([6, 6]);
    // viewed as a whole run, all twelve give a gap
    expect(quotes.every((q) => isGap(gapOf(q, whole, built)))).toBe(true);
  });

  it('a stock whose stock-to-stock pool was not read is not scored as a gain of zero', () => {
    const qqq = fixtureQuote('QQQx', 'sell', 100000);
    // one of QQQx's stock-to-stock pools came back without its arrays: its two-hop route was not measured
    const pool = whole.twoHopPools.find((p) => p.assetSymbol === 'QQQx');
    if (!pool) throw new Error('the fixture has no stock-to-stock pool filed under QQQx');
    const holed: SplitCapture = { ...whole, children: { ...whole.children, [pool.address]: [] } };
    const b = buildSplit(holed);
    expect(b.notRouted.some((n) => n.asset === 'QQQx' && n.reason === 'pool_read_incomplete')).toBe(
      true,
    );
    expect(gapOf(qqq, holed, b)).toEqual({ skipped: 'two_hop_pools_not_read', asset: 'QQQx' });
    // a via token that is not tracked is the rule, not a read that failed: the pair is still compared
    const untracked: SplitCapture = {
      ...whole,
      tracked: whole.tracked.filter((m) => m !== pool.quoteMint),
    };
    const u = buildSplit(untracked);
    expect(u.notRouted.some((n) => n.asset === 'QQQx' && n.reason === 'via_not_tracked')).toBe(
      true,
    );
    expect(isGap(gapOf(qqq, untracked, u))).toBe(true);
  });

  it('reads the selection by the capture’s own symbol for the mint, not by the name on the quote', () => {
    const spy = fixtureQuote('SPYx', 'sell', 1000);
    const qqq = fixtureQuote('QQQx', 'sell', 1000);
    expect(gapOf({ ...spy, asset: 'QQQx' }, cap, built)).toEqual({
      skipped: 'asset_outside_the_capture_selection',
      asset: 'QQQx',
    });
    expect(isGap(gapOf({ ...qqq, asset: 'SPYx' }, cap, built))).toBe(true);
    // a capture cut to both stocks compares both, one cut to the other stock leaves this one out
    expect(isGap(gapOf(spy, { ...cap, only: ['QQQx', 'SPYx'] }, built))).toBe(true);
    expect(gapOf(qqq, { ...cap, only: ['SPYx'] }, built)).toMatchObject({
      skipped: 'asset_outside_the_capture_selection',
    });
    // a capture written before the field existed is a whole run
    const { only: _only, ...noField } = cap;
    expect(isGap(gapOf(spy, noField, built))).toBe(true);
  });

  it('uses two hops on some of the twelve, so the two routes are not the same route twice', () => {
    const rows = quotes.map((q) => row(q));
    expect(rows.some((r) => r.twoHopLegs.length > 0)).toBe(true);
    expect(rows.some((r) => r.gainBp !== 0)).toBe(true);
    // and on the six the report compares on the capture as cut
    const qqq = rows.filter((r) => r.assetMint === QQQX);
    expect(qqq).toHaveLength(6);
    expect(qqq.some((r) => r.gainBp !== 0)).toBe(true);
  });

  // The report never does this: a capture taken without two hops is not used at all (usableCaptures). It is the
  // library's own arithmetic that is checked here, on the dollar and SOL pools alone.
  it('with the stock-to-stock pools taken out of the capture, two hops change nothing', () => {
    const oneHopOnly = buildSplit({ ...cap, twoHop: false });
    for (const q of quotes) {
      const g = row(q, oneHopOnly);
      expect(g.twoHop).toBe(g.oneHop);
      expect(g.gainBp).toBe(0);
      expect(g.twoHopLegs).toEqual([]);
      expect(g.oneHop).toBe(row(q).oneHop);
    }
  });

  it('tells the stock hops of every route from the onward ones, and their shares add up to 100', () => {
    for (const q of quotes) {
      const shares = stockShares(q);
      expect(shares).not.toBeNull();
      const sum = (shares ?? []).reduce((t: number, s) => t + (s ?? 0), 0);
      expect(sum).toBeCloseTo(100, 9);
    }
    // a purchase through SOL: dollars to SOL on one venue, then SOL to the stock on a Raydium pool
    const viaSol = fixtureQuote('SPYx', 'buy', 100_000);
    const shares = stockShares(viaSol) as Array<number | null>;
    expect(viaSol.route?.map((h) => h.label)).toEqual([
      'Raydium CLMM',
      'Raydium CLMM',
      'BisonFi',
      'Raydium CLMM',
    ]);
    expect(shares[2]).toBeNull();
    const out = Number(viaSol.outAmount);
    expect(shares[0]).toBe((Number(viaSol.route?.[0]?.outAmount) / out) * 100);
    expect(shares[3]).toBe((Number(viaSol.route?.[3]?.outAmount) / out) * 100);
    // a sale split over three pools: each hop's share of the stock sold
    const split = fixtureQuote('SPYx', 'sell', 1000);
    expect((stockShares(split) as number[]).map((s) => Math.round(s))).toEqual([33, 4, 63]);
  });
});

describe('stockShares', () => {
  const base = fixtureQuote('SPYx', 'sell', 10_000);
  const hops = base.route as NonNullable<StoredQuote['route']>;

  it('guesses nothing when the amounts do not add up, or add up in two ways', () => {
    const off = hops.map((h, i) => (i === 0 ? { ...h, inAmount: '1' } : h));
    expect(stockShares({ ...base, route: off })).toBeNull();
    // a hop of zero can be counted in or out: two sets add up
    const zero = [...hops, { pool: 'Zero', label: 'x', inAmount: '0', outAmount: '0' }];
    expect(stockShares({ ...base, route: zero })).toBeNull();
  });

  it('gives no shares for a route with no hops or with an amount missing', () => {
    expect(stockShares({ ...base, route: null })).toBeNull();
    expect(stockShares({ ...base, route: [] })).toBeNull();
    const missing = hops.map((h, i) => (i === 1 ? { ...h, inAmount: null } : h));
    expect(stockShares({ ...base, route: missing })).toBeNull();
    expect(stockShares({ ...base, amountIn: '' })).toBeNull();
  });

  it('reads a sale by what goes in and a purchase by what comes out', () => {
    const route = [
      { pool: 'A', label: 'x', inAmount: '30', outAmount: '7' },
      { pool: 'B', label: 'y', inAmount: '70', outAmount: '13' },
    ];
    const sale = quoteAt('2026-10-06T21:00:00.000Z', { amountIn: '100', outAmount: '20', route });
    expect(stockShares(sale)).toEqual([30, 70]);
    expect(stockShares({ ...sale, side: 'buy' })).toEqual([35, 65]);
  });
});

// one pool that trades at its mid with no fee: 100 dollars a token, 8 and 6 decimals, so every figure is known by hand
const flat: PoolSim = {
  midRaw: 1,
  sellAsset: (raw) => ({ out: raw, unfilledShare: 0 }),
  buyAsset: (raw) => ({ out: raw, unfilledShare: 0 }),
  depthWithin: () => ({ sellQuoteOut: 0, buyAssetOut: 0 }),
};
const flatPool = (pool: string, tvlUsd: number): RoutePool => ({
  pool,
  sim: flat,
  decAsset: 8,
  decQuote: 6,
  quoteUsd: 1,
  midUsd: 100,
  tvlUsd,
  feeRate: 0,
  transferFeeBps: { asset: 0, quote: 0 },
});
const toy: BuiltSplit = {
  byAsset: new Map([
    ['MintA', { symbol: 'AAAx', pools: [flatPool('Small', 1), flatPool('Large', 2)], twoHop: [] }],
  ]),
  via: new Map(),
  failures: [],
  notRouted: [],
};

describe('gapOf: the sign and the cases with no gap', () => {
  const at = '2026-10-06T21:00:00.000Z';

  it('a sale: Jupiter above ours is a positive gap, below ours a negative one', () => {
    // 10 tokens sold at 100 dollars: ours is 1,000 dollars
    const above = row(quoteAt(at, { amountIn: '1000000000', outAmount: '1001000000' }), toy);
    expect(above.unit).toBe('usd');
    expect(above.oneHop).toBeCloseTo(1000, 6);
    expect(above.jupiter).toBe(1001);
    expect(above.gapOneHopBp).toBeCloseTo(10, 3);
    expect(above.gapOneHopBp).toBeGreaterThan(0);
    const below = row(quoteAt(at, { amountIn: '1000000000', outAmount: '998000000' }), toy);
    expect(below.gapOneHopBp).toBeCloseTo(-20, 3);
    expect(below.gapOneHopBp).toBeLessThan(0);
    expect(above.gainBp).toBe(0);
  });

  it('a purchase compares tokens: more tokens from Jupiter is a positive gap', () => {
    // 1,000 dollars at 100 dollars a token: ours is 10 tokens
    const above = row(
      quoteAt(at, { side: 'buy', amountIn: '1000000000', outAmount: '1002000000' }),
      toy,
    );
    expect(above.unit).toBe('tokens');
    expect(above.oneHop).toBeCloseTo(10, 8);
    expect(above.jupiter).toBe(10.02);
    expect(above.gapOneHopBp).toBeCloseTo(20, 3);
    const below = row(
      quoteAt(at, { side: 'buy', amountIn: '1000000000', outAmount: '999000000' }),
      toy,
    );
    expect(below.gapOneHopBp).toBeCloseTo(-10, 3);
  });

  it('on the frozen pools, a quote moved one percent above our route gives about 100 basis points', () => {
    const q = fixtureQuote('QQQx', 'sell', 1000);
    const ours = row(q).twoHop;
    const up = row({ ...q, outAmount: String(Math.round(ours * 1.01 * 1e6)) });
    const down = row({ ...q, outAmount: String(Math.round(ours * 0.99 * 1e6)) });
    expect(up.gapTwoHopBp).toBeCloseTo(100, 2);
    expect(down.gapTwoHopBp).toBeCloseTo(-100, 2);
  });

  it('the gain is not a comparison with Jupiter: moving Jupiter’s amount moves both gaps and only scales the gain', () => {
    const q = fixtureQuote('QQQx', 'sell', 100_000);
    const base = row(q);
    expect(base.gainBp).toBeGreaterThan(1);
    const moved = row({ ...q, outAmount: String(Math.round(Number(q.outAmount) * 1.01)) });
    // our side does not read Jupiter's amount
    expect(moved.oneHop).toBe(base.oneHop);
    expect(moved.twoHop).toBe(base.twoHop);
    expect(moved.twoHopLegs).toEqual(base.twoHopLegs);
    // one percent more from Jupiter is about a hundred basis points more on each gap
    expect(moved.gapOneHopBp - base.gapOneHopBp).toBeCloseTo(100, 0);
    expect(moved.gapTwoHopBp - base.gapTwoHopBp).toBeCloseTo(100, 0);
    // and one percent more of the gain itself: one part in ten thousand for each basis point of gap
    expect(moved.gainBp / base.gainBp).toBeCloseTo(1.01, 6);
    expect(moved.gainBp).toBeCloseTo(
      moved.jupiter * (1 / base.oneHop - 1 / base.twoHop) * 10_000,
      6,
    );
  });

  it('gives a reason and no gap for an asset the capture does not hold, and for a row it cannot read', () => {
    const q = fixtureQuote('QQQx', 'sell', 1000);
    expect(gapOf({ ...q, assetMint: 'NotInTheCapture' }, cap, built)).toEqual({
      skipped: 'asset_not_in_capture',
      asset: 'QQQx',
    });
    expect(gapOf({ ...q, side: 'hold' }, cap, built)).toMatchObject({
      skipped: 'side_not_sell_or_buy',
    });
    expect(gapOf({ ...q, outAmount: null }, cap, built)).toMatchObject({
      skipped: 'quote_has_no_amount',
    });
    expect(gapOf({ ...q, amountIn: '0' }, cap, built)).toMatchObject({
      skipped: 'our_route_returns_nothing',
    });
    expect(isGap(gapOf(q, cap, built))).toBe(true);
  });
});

describe('the number of chunks both routes are cut in', () => {
  // not the router's own number, and few enough that a chunk of the larger sizes is more than the small pools take
  const OTHER = 8;

  it('is the router’s own when none is given', () => {
    for (const q of quotes) expect(row(q)).toEqual(row(q, built, whole, ROUTE_CHUNKS));
  });

  it.each(quotes.map((q) => [`${q.asset} ${q.side} $${q.notionalUsd}`, q] as const))(
    '%s: another number goes to both routes',
    (_name, q) => {
      expect(OTHER).not.toBe(ROUTE_CHUNKS);
      const a = built.byAsset.get(q.assetMint);
      if (!a) throw new Error('asset not in the fixture');
      let ref = a.pools[0] as RoutePool;
      for (const p of a.pools) if (p.tvlUsd > ref.tvlUsd) ref = p;
      const sell = q.side === 'sell';
      const side = sell ? 'sell' : 'buy';
      const amount = sell ? Number(q.amountIn) / 10 ** ref.decAsset : Number(q.amountIn) / 1e6;
      const notional = sell ? amount * ref.midUsd : amount;
      const one = routeTrade(a.pools, notional, side, OTHER);
      const two = routeTrade(a.pools, notional, side, OTHER, { pools: a.twoHop, via: built.via });
      const g = row(q, built, whole, OTHER);
      expect(g.oneHop).toBe(sell ? one.outUsd : one.outUsd / ref.midUsd);
      expect(g.twoHop).toBe(sell ? two.outUsd : two.outUsd / ref.midUsd);
      expect(g.twoHopLegs).toEqual(two.legs.filter((l) => l.via));
      expect(g.gainBp).toBe(g.gapOneHopBp - g.gapTwoHopBp);
      // every leg is a whole number of chunks of the amount: the route was cut in this number and no other
      for (const r of [one, two])
        for (const l of r.legs) {
          const parts = l.amountIn / (amount / OTHER);
          expect(Math.abs(parts - Math.round(parts))).toBeLessThan(1e-9);
          expect(Math.round(parts)).toBeGreaterThanOrEqual(1);
        }
    },
  );

  it('moves both routes, and the gain with them: a measured gain depends on the chunk size', () => {
    const at32 = quotes.map((q) => row(q));
    const at8 = quotes.map((q) => row(q, built, whole, OTHER));
    expect(at8.some((r, i) => r.oneHop !== at32[i]?.oneHop)).toBe(true);
    expect(at8.some((r, i) => r.twoHop !== at32[i]?.twoHop)).toBe(true);
    expect(at8.some((r, i) => r.gainBp !== at32[i]?.gainBp)).toBe(true);
    // Jupiter's side is the quote's own and does not depend on it
    expect(at8.map((r) => r.jupiter)).toEqual(at32.map((r) => r.jupiter));
  });
});

describe('parseRouterArgs', () => {
  it('passes over the bare "--" pnpm hands on', () => {
    expect(parseRouterArgs(['--', '--router', 'a.json.gz', '--chunks', '8'])).toEqual({
      paths: ['a.json.gz'],
      quotesFile: null,
      chunks: 8,
    });
  });

  it('takes the captures named, and the router’s own number of chunks when none is given', () => {
    expect(parseRouterArgs(['--router', 'a.json.gz'])).toEqual({
      paths: ['a.json.gz'],
      quotesFile: null,
      chunks: ROUTE_CHUNKS,
    });
    expect(ROUTE_CHUNKS).toBe(32);
  });

  it('takes --quotes and --chunks wherever they stand, and neither value as a capture', () => {
    expect(
      parseRouterArgs(['--router', 'a.json.gz', 'folder', '--quotes', 'q.json', '--chunks', '8']),
    ).toEqual({ paths: ['a.json.gz', 'folder'], quotesFile: 'q.json', chunks: 8 });
    expect(
      parseRouterArgs(['--chunks', '1', '--quotes', 'q.json', 'a.json.gz', '--router']),
    ).toEqual({ paths: ['a.json.gz'], quotesFile: 'q.json', chunks: 1 });
    expect(parseRouterArgs(['--router', 'a.json.gz', '--chunks', '064']).chunks).toBe(64);
  });

  it('refuses a number of chunks that is not an integer of 1 or more', () => {
    for (const bad of ['0', '-3', '1.5', 'x', '', '8x', '1e2', ' 8'])
      expect(() => parseRouterArgs(['--router', 'a.json.gz', '--chunks', bad])).toThrow(
        /--chunks takes an integer of 1 or more[\s\S]*usage/,
      );
  });

  it('refuses no capture, a flag with no value, and a flag it does not know', () => {
    expect(() => parseRouterArgs([])).toThrow(/usage/);
    expect(() => parseRouterArgs(['--router'])).toThrow(/usage/);
    expect(() => parseRouterArgs(['--router', '--quotes', 'q.json'])).toThrow(/usage/);
    expect(() => parseRouterArgs(['--router', 'a.json.gz', '--quotes'])).toThrow(/usage/);
    expect(() => parseRouterArgs(['--router', 'a.json.gz', '--chunks'])).toThrow(/usage/);
    expect(() => parseRouterArgs(['--router', 'a.json.gz', '--quotes', '--chunks', '8'])).toThrow(
      /usage/,
    );
    expect(() => parseRouterArgs(['--router', 'a.json.gz', '--chunk', '8'])).toThrow(
      /--chunk: not a flag of --router[\s\S]*usage/,
    );
  });
});

describe('jupiterWithinModelledPools', () => {
  const q = fixtureQuote('QQQx', 'sell', 1000);
  const qqq = built.byAsset.get(QQQX);
  const spy = built.byAsset.get(SPYX);
  if (!qqq || !spy) throw new Error('fixture assets missing');
  const hop = (pool: string) => ({ pool, label: 'x', percent: 100 });
  const ownPool = (qqq.pools[0] as RoutePool).pool;
  const stockToStock = qqq.twoHop[0]?.pool as string;
  const viaPool = (spy.pools[0] as RoutePool).pool;

  it('is true only when every pool of the route is one we model for the asset', () => {
    expect(row(q).jupiterWithinModelledPools).toBe(true);
    expect(row({ ...q, route: [hop(ownPool)] }).jupiterWithinModelledPools).toBe(true);
    // a stock-to-stock pool of the asset, and the pools of the via token it leads to, are modelled too
    expect(qqq.twoHop.some((p) => p.via === SPYX)).toBe(true);
    expect(row({ ...q, route: [hop(stockToStock), hop(viaPool)] }).jupiterWithinModelledPools).toBe(
      true,
    );
    const mixed = row({ ...q, route: [hop(ownPool), hop('PoolWeDoNotModel')] });
    expect(mixed.jupiterWithinModelledPools).toBe(false);
    expect(mixed.jupiterRoute.map((h) => h.modelled)).toEqual([true, false]);
    expect(row({ ...q, route: [hop('PoolWeDoNotModel')] }).jupiterWithinModelledPools).toBe(false);
  });

  it('counts a via token’s pools for the asset whose own pools lead to it, not for every asset', () => {
    // QQQx has a pool with AMZNx; SPYx has none, so AMZNx's dollar pools are no part of an SPYx route we model
    const amzn = built.byAsset.get(AMZNX);
    if (!amzn) throw new Error('fixture asset missing');
    const amznPool = (amzn.pools[0] as RoutePool).pool;
    expect(qqq.twoHop.some((p) => p.via === AMZNX)).toBe(true);
    expect(spy.twoHop.some((p) => p.via === AMZNX)).toBe(false);
    expect(row({ ...q, route: [hop(amznPool)] }).jupiterWithinModelledPools).toBe(true);
    const spyQuote = fixtureQuote('SPYx', 'sell', 1000);
    expect(row({ ...spyQuote, route: [hop(amznPool)] }).jupiterWithinModelledPools).toBe(false);
    expect(row({ ...spyQuote, route: [hop(ownPool)] }).jupiterWithinModelledPools).toBe(true);
  });

  it('is false for a quote stored with no route', () => {
    expect(row({ ...q, route: [] }).jupiterWithinModelledPools).toBe(false);
    expect(row({ ...q, route: null }).jupiterWithinModelledPools).toBe(false);
  });

  it('leaves out every Jupiter route with a SOL leg: the venue of its SOL to USDC step is never modelled', () => {
    const rows = quotes.map((x) => row(x));
    // an onward hop is the other step of a path through SOL; the two large purchases of the fixture hold one
    const withSolLeg = rows.filter((r) => r.jupiterRoute.some((h) => h.sharePct === null));
    expect(withSolLeg.map((r) => `${r.asset} ${r.side} ${r.notionalUsd}`)).toEqual([
      'SPYx buy 100000',
      'QQQx buy 100000',
    ]);
    for (const r of withSolLeg) {
      expect(r.jupiterWithinModelledPools).toBe(false);
      for (const h of r.jupiterRoute) if (h.sharePct === null) expect(h.modelled).toBe(false);
      // the stock's own hop into SOL is a pool we model: it is the onward step that is not
      expect(r.jupiterRoute.some((h) => h.sharePct !== null && h.modelled)).toBe(true);
    }
    // what is left on the fixture: the three small quotes Jupiter sent through one pool we model
    expect(
      rows
        .filter((r) => r.jupiterWithinModelledPools)
        .map((r) => `${r.asset} ${r.side} ${r.notionalUsd}`),
    ).toEqual(['SPYx buy 1000', 'QQQx sell 1000', 'QQQx buy 1000']);
  });

  it('is not a comparison on the same pools: our route still splits over pools Jupiter did not use', () => {
    const r = row(q);
    expect(r.jupiterWithinModelledPools).toBe(true);
    const jupiterPools = new Set(r.jupiterRoute.map((h) => h.pool));
    expect(jupiterPools.size).toBe(1);
    // our one-hop route of the same sale, from a direct call: the reference pool is the largest by TVL
    let ref = qqq.pools[0] as RoutePool;
    for (const p of qqq.pools) if (p.tvlUsd > ref.tvlUsd) ref = p;
    const amount = Number(q.amountIn) / 10 ** ref.decAsset;
    const ours = routeTrade(qqq.pools, amount * ref.midUsd, 'sell');
    expect(ours.outUsd).toBe(r.oneHop);
    expect(ours.legs.length).toBeGreaterThan(1);
    expect(ours.legs.some((l) => !jupiterPools.has(l.pool))).toBe(true);
  });

  it('counts another stock’s pools only when a stock-to-stock pool of this capture leads to them', () => {
    const oneHopOnly = buildSplit({ ...cap, twoHop: false });
    expect(row({ ...q, route: [hop(ownPool)] }, oneHopOnly).jupiterWithinModelledPools).toBe(true);
    expect(row({ ...q, route: [hop(viaPool)] }, oneHopOnly).jupiterWithinModelledPools).toBe(false);
    expect(row({ ...q, route: [hop(stockToStock)] }, oneHopOnly).jupiterWithinModelledPools).toBe(
      false,
    );
  });
});

describe('median and mean', () => {
  it('an odd count gives the middle value, an even count the mean of the two middle ones', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([7])).toBe(7);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([10, -2])).toBe(4);
    expect(median([5, 1, 100, 3, 2])).toBe(3);
    expect(median([])).toBeNull();
  });

  it('does not reorder what it is given, and the mean is the plain mean', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
});

describe('summarize', () => {
  const leg = { pool: 'S2S', amountIn: 1, unfilledShare: 0, outUsd: 1, midUsd: 1, feeRate: 0 };
  const made = (over: Partial<GapRow>): GapRow => {
    const gapOneHopBp = over.gapOneHopBp ?? 0;
    const gapTwoHopBp = over.gapTwoHopBp ?? gapOneHopBp;
    return {
      asset: 'AAAx',
      assetMint: 'MintA',
      side: 'sell',
      notionalUsd: 1000,
      quoteFetchedAt: '2026-10-06T21:00:00.000Z',
      captureFetchedAt: '2026-10-06T21:01:00.000Z',
      quoteProvenance: 'live',
      captureProvenance: 'live',
      unit: 'usd',
      jupiter: 1,
      oneHop: 1,
      twoHop: 1,
      twoHopLegs: [],
      jupiterWithinModelledPools: false,
      jupiterRoute: [],
      ...over,
      gapOneHopBp,
      gapTwoHopBp,
      gainBp: gapOneHopBp - gapTwoHopBp,
    };
  };
  const rows = [
    made({ gapOneHopBp: 1, gapTwoHopBp: 1, jupiterWithinModelledPools: true }),
    made({ gapOneHopBp: 2, gapTwoHopBp: 0.5, twoHopLegs: [leg], jupiterWithinModelledPools: true }),
    made({ gapOneHopBp: 10, gapTwoHopBp: 4, twoHopLegs: [leg], asset: 'BBBx' }),
    made({ gapOneHopBp: 30, gapTwoHopBp: 30, asset: 'BBBx' }),
    made({ gapOneHopBp: 27, gapTwoHopBp: 25, notionalUsd: 100_000, twoHopLegs: [leg] }),
    made({ gapOneHopBp: -3, side: 'buy', unit: 'tokens', notionalUsd: 100_000 }),
    made({
      gapOneHopBp: 5,
      side: 'buy',
      unit: 'tokens',
      notionalUsd: 100_000,
      jupiterWithinModelledPools: true,
    }),
    made({ gapOneHopBp: 19, side: 'buy', unit: 'tokens', notionalUsd: 100_000 }),
  ];
  const s = summarize(rows);

  it('groups by side and size: sales first, sizes smallest first', () => {
    expect(s.bySideAndSize.map((g) => `${g.side} ${g.notionalUsd} ${g.pairs}`)).toEqual([
      'sell 1000 4',
      'sell 100000 1',
      'buy 100000 3',
    ]);
  });

  it('gives the median and the mean of each gap and of the gain, the smallest and the largest beside them, and the share that used two hops', () => {
    const g = s.bySideAndSize[0];
    // one-hop 1, 2, 10, 30; two-hop 1, 0.5, 4, 30; gains 0, 1.5, 6, 0
    expect(g?.gapOneHopBp).toEqual({ median: 6, mean: 10.75, min: 1, max: 30 });
    expect(g?.gapTwoHopBp).toEqual({ median: 2.5, mean: 8.88, min: 0.5, max: 30 });
    expect(g?.gainBp).toEqual({ median: 0.75, mean: 1.88, min: 0, max: 6 });
    expect(g?.twoHopUsedShare).toBe(0.5);
    // one pair: all four are that pair's figure
    const one = s.bySideAndSize[1];
    expect(one?.gapOneHopBp).toEqual({ median: 27, mean: 27, min: 27, max: 27 });
    expect(one?.gainBp).toEqual({ median: 2, mean: 2, min: 2, max: 2 });
    const buy = s.bySideAndSize[2];
    // one-hop -3, 5, 19, with no two-hop leg
    expect(buy?.gapOneHopBp).toEqual({ median: 5, mean: 7, min: -3, max: 19 });
    expect(buy?.gainBp).toEqual({ median: 0, mean: 0, min: 0, max: 0 });
    expect(buy?.twoHopUsedShare).toBe(0);
  });

  it('gives the same figures for the pairs where Jupiter used only pools we model', () => {
    const within = s.bySideAndSize[0]?.jupiterWithinModelledPools;
    expect(within?.pairs).toBe(2);
    // one-hop 1, 2; two-hop 1, 0.5; gains 0, 1.5
    expect(within?.gapOneHopBp).toEqual({ median: 1.5, mean: 1.5, min: 1, max: 2 });
    expect(within?.gapTwoHopBp).toEqual({ median: 0.75, mean: 0.75, min: 0.5, max: 1 });
    expect(within?.gainBp).toEqual({ median: 0.75, mean: 0.75, min: 0, max: 1.5 });
    expect(within?.twoHopUsedShare).toBe(0.5);
    // none in the group: counted as none, with no figure invented
    const none = { median: null, mean: null, min: null, max: null };
    expect(s.bySideAndSize[1]?.jupiterWithinModelledPools).toEqual({
      pairs: 0,
      gapOneHopBp: none,
      gapTwoHopBp: none,
      gainBp: none,
      twoHopUsedShare: null,
    });
    // the old name of the key is gone
    expect(Object.keys(s.bySideAndSize[0] ?? {})).toEqual([
      'side',
      'notionalUsd',
      'pairs',
      'gapOneHopBp',
      'gapTwoHopBp',
      'gainBp',
      'twoHopUsedShare',
      'jupiterWithinModelledPools',
    ]);
  });

  it('gives each asset at each side and size, assets by name', () => {
    expect(s.byAsset.map((g) => `${g.asset} ${g.side} ${g.notionalUsd} ${g.pairs}`)).toEqual([
      'AAAx sell 1000 2',
      'AAAx sell 100000 1',
      'AAAx buy 100000 3',
      'BBBx sell 1000 2',
    ]);
    // BBBx: one-hop 10, 30; gains 6, 0
    expect(s.byAsset[3]?.gapOneHopBp).toEqual({ median: 20, mean: 20, min: 10, max: 30 });
    expect(s.byAsset[3]?.gainBp).toEqual({ median: 3, mean: 3, min: 0, max: 6 });
  });

  it('says where Jupiter’s routes go: by label, the pools we do not model named', () => {
    const h = (pool: string, label: string, sharePct: number | null, modelled: boolean) => ({
      pool,
      label,
      sharePct,
      modelled,
    });
    const routed = summarize([
      made({ jupiterRoute: [h('R1', 'Raydium CLMM', 80, true), h('B1', 'Byreal', 20, false)] }),
      made({
        jupiterRoute: [
          h('R1', 'Raydium CLMM', 60, true),
          h('R9', 'Raydium CLMM', 30, false),
          h('B2', 'Byreal', 10, false),
          h('X1', 'BisonFi', null, false),
          h('X2', 'BisonFi', null, false),
        ],
      }),
      // stock hops not told apart: left out of the shares, counted as not resolved
      made({ jupiterRoute: [h('R1', 'Raydium CLMM', null, true), h('Q1', 'Other', null, false)] }),
      made({ jupiterRoute: [] }),
    ]).jupiterRoutes;
    expect(routed).toHaveLength(1);
    expect(routed[0]).toEqual({
      side: 'sell',
      notionalUsd: 1000,
      quotes: 4,
      resolved: 2,
      byLabel: [
        { label: 'Raydium CLMM', modelled: true, sharePct: 70, pools: ['R1'] },
        { label: 'Byreal', modelled: false, sharePct: 15, pools: ['B1', 'B2'] },
        { label: 'Raydium CLMM', modelled: false, sharePct: 15, pools: ['R9'] },
      ],
      notModelledPct: 30,
      onwardHops: [{ label: 'BisonFi', modelled: false, quotes: 1, pools: ['X1', 'X2'] }],
    });
    const none = summarize([made({ jupiterRoute: [] })]).jupiterRoutes[0];
    expect(none).toMatchObject({ quotes: 1, resolved: 0, byLabel: [], notModelledPct: null });
  });

  it('on the frozen pairs: twelve groups of one pair for each stock, and shares that add up to 100', () => {
    const real = summarize(quotes.map((q) => row(q)));
    expect(real.bySideAndSize.map((g) => `${g.side} ${g.notionalUsd} ${g.pairs}`)).toEqual([
      'sell 1000 2',
      'sell 10000 2',
      'sell 100000 2',
      'buy 1000 2',
      'buy 10000 2',
      'buy 100000 2',
    ]);
    expect(real.byAsset).toHaveLength(12);
    for (const r of real.jupiterRoutes) {
      expect(r.resolved).toBe(2);
      expect(r.byLabel.reduce((t, b) => t + b.sharePct, 0)).toBeCloseTo(100, 1);
    }
    // the venue Jupiter uses for the SOL leg of a large purchase is an onward hop, not a pool of the stock
    const big = real.jupiterRoutes.find((r) => r.side === 'buy' && r.notionalUsd === 100_000);
    expect(big?.onwardHops.map((o) => o.label)).toEqual(['BisonFi']);
    expect(big?.byLabel.some((b) => b.label === 'BisonFi')).toBe(false);
  });

  it('on the capture as it was cut: six groups of one pair, all of QQQx', () => {
    const compared = quotes.map((q) => gapOf(q, cap, built)).filter(isGap);
    const real = summarize(compared);
    expect(real.bySideAndSize.map((g) => `${g.side} ${g.notionalUsd} ${g.pairs}`)).toEqual([
      'sell 1000 1',
      'sell 10000 1',
      'sell 100000 1',
      'buy 1000 1',
      'buy 10000 1',
      'buy 100000 1',
    ]);
    expect(real.byAsset.map((g) => g.asset)).toEqual(Array(6).fill('QQQx'));
    // with one pair in a group the four figures are that pair's own, to two decimals
    for (const g of real.byAsset) {
      const r = compared.find((x) => x.side === g.side && x.notionalUsd === g.notionalUsd);
      const own = Number((r as GapRow).gainBp.toFixed(2));
      expect(g.gainBp).toEqual({ median: own, mean: own, min: own, max: own });
    }
  });
});

describe('pairingOf: when the compared quotes were taken, how far from their captures, and what they are', () => {
  const at = (
    quoteFetchedAt: string,
    over: Partial<GapRow> = {},
    captureFetchedAt = '2026-10-06T21:01:00.000Z',
  ) =>
    ({
      quoteFetchedAt,
      captureFetchedAt,
      quoteProvenance: 'live',
      captureProvenance: 'live',
      ...over,
    }) as GapRow;

  it('gives the first and the last quote, the seconds apart, and how many came before and after', () => {
    // against a capture at 21:01:00: 60 s before, 150.5 s after, at the same millisecond, 120 s before
    const p = pairingOf([
      at('2026-10-06T21:00:00.000Z'),
      at('2026-10-06T21:03:30.500Z'),
      at('2026-10-06T21:01:00.000Z'),
      at('2026-10-06T20:59:00.000Z'),
    ]);
    expect(p.first).toBe('2026-10-06T20:59:00.000Z');
    expect(p.last).toBe('2026-10-06T21:03:30.500Z');
    // 0, 60, 120, 150.5: the median is the mean of 60 and 120, the mean 330.5 ÷ 4
    expect(p.secondsApart).toEqual({ median: 90, mean: 82.625, min: 0, max: 150.5 });
    expect(p.quotesBeforeCapture).toBe(2);
    expect(p.quotesAfterCapture).toBe(1);
    expect(p.quotesAtCaptureTime).toBe(1);
    expect(p.provenance).toBe('live');
  });

  it('measures each quote against its own capture', () => {
    const p = pairingOf([
      at('2026-10-06T21:00:00.000Z', {}, '2026-10-06T21:00:10.000Z'),
      at('2026-10-06T22:00:00.000Z', {}, '2026-10-06T21:59:30.000Z'),
    ]);
    expect(p.secondsApart).toEqual({ median: 20, mean: 20, min: 10, max: 30 });
    expect([p.quotesBeforeCapture, p.quotesAfterCapture, p.quotesAtCaptureTime]).toEqual([1, 1, 0]);
  });

  it('gives no figure for no pair', () => {
    expect(pairingOf([])).toEqual({
      first: null,
      last: null,
      secondsApart: { median: null, mean: null, min: null, max: null },
      quotesBeforeCapture: 0,
      quotesAfterCapture: 0,
      quotesAtCaptureTime: 0,
      provenance: null,
    });
  });

  it('says live only when every quote and every capture says live', () => {
    const t = '2026-10-06T21:00:00.000Z';
    expect(pairingOf([at(t), at(t)]).provenance).toBe('live');
    expect(pairingOf([at(t), at(t, { quoteProvenance: 'sandbox' })]).provenance).toBe(
      'live, sandbox',
    );
    expect(pairingOf([at(t, { captureProvenance: 'fixture' })]).provenance).toBe('fixture, live');
    // a quote row that says nothing is not read as live
    expect(pairingOf([at(t), at(t, { quoteProvenance: null })]).provenance).toBe(
      'live, not_stated',
    );
    expect(provenanceOf(['live', 'live'])).toBe('live');
    expect(provenanceOf(['mock', 'live', undefined, 'mock', ''])).toBe('live, mock, not_stated');
    expect(provenanceOf([])).toBeNull();
  });

  it('on the frozen pairs: the six QQQx quotes, all taken before the capture, all live', () => {
    const compared = quotes.map((q) => gapOf(q, cap, built)).filter(isGap);
    const p = pairingOf(compared);
    // the collector asked for QQQx from 21:19:42.748Z to 21:19:49.632Z; the pools were read at 21:21:16.833Z
    expect(p.first).toBe('2026-10-06T21:19:42.748Z');
    expect(p.last).toBe('2026-10-06T21:19:49.632Z');
    expect(cap.fetchedAt).toBe('2026-10-06T21:21:16.833Z');
    expect(p.secondsApart.min).toBe(87.201);
    expect(p.secondsApart.max).toBe(94.085);
    expect(p.secondsApart.median).toBeGreaterThan(p.secondsApart.min as number);
    expect(p.secondsApart.median).toBeLessThan(p.secondsApart.max as number);
    expect([p.quotesBeforeCapture, p.quotesAfterCapture, p.quotesAtCaptureTime]).toEqual([6, 0, 0]);
    expect(p.provenance).toBe('live');
    // a row the collector stored with no provenance is carried as such, and the report says so
    const { provenance: _p, ...unstated } = fixtureQuote('QQQx', 'sell', 1000);
    expect(row(unstated).quoteProvenance).toBeNull();
    expect(pairingOf([row(unstated), ...compared]).provenance).toBe('live, not_stated');
  });
});

describe('the script, run as a child process on files only', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'routing-gap-router-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const emptyHome = join(tmp, 'empty-home');
  mkdirSync(emptyHome);
  // a child that does not end is killed well inside the test's own limit
  const CHILD_TIMEOUT_MS = 45_000;
  const run = (args: string[], home: string) => {
    // A minimal environment: where node is, where temporary files go, and the RISK_HOME of the test. Nothing else of
    // the caller's reaches the script: not its own RISK_HOME, not its threshold for the old report, not a key.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, RISK_HOME: home };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    const r = spawnSync(
      join('node_modules', '.bin', 'tsx'),
      ['scripts/risk/routing-gap.ts', ...args],
      { encoding: 'utf8', env, timeout: CHILD_TIMEOUT_MS },
    );
    // a child killed by the timeout ends on a signal with no status: that is never read as the script's own answer
    expect(r.error).toBeUndefined();
    expect(r.signal).toBeNull();
    return r;
  };
  const qqqQuotes = quotes.filter((q) => q.assetMint === QQQX);
  const asJson = (x: unknown) => JSON.parse(JSON.stringify(x));
  const noFigure = { median: null, mean: null, min: null, max: null };

  it('--router on the frozen capture with --quotes on the frozen quotes prints one JSON: 12 paired, the 6 QQQx quotes compared', () => {
    const r = run(['--router', CAPTURE, '--quotes', QUOTES], emptyHome);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.method).toBe(ROUTING_GAP_ROUTER_METHOD);
    expect(out.method).toBe('routing-gap-router-0.1');
    expect(Number.isNaN(Date.parse(out.checkedAt))).toBe(false);
    expect(out.provenance).toBe('live');
    expect(out.positiveGap).toContain('Jupiter returns more than our router');
    expect(out.captures).toEqual({
      count: 1,
      first: cap.fetchedAt,
      last: cap.fetchedAt,
      withQuotes: 1,
      takenWithTwoHops: 1,
      poolsNotBuilt: 0,
      twoHopDirectionsNotRouted: built.notRouted.length,
      notCaptures: [],
      notUsed: [],
    });
    // the capture was cut to QQQx: the six SPYx quotes are paired with it and not compared
    expect(out.quotes).toEqual({
      read: 12,
      withoutAQuote: 0,
      paired: 12,
      unpaired: 0,
      compared: 6,
      notCompared: [{ reason: 'asset_outside_the_capture_selection', quotes: 6 }],
      first: '2026-10-06T21:19:42.748Z',
      last: '2026-10-06T21:19:49.632Z',
    });
    const rows = qqqQuotes.map((q) => row(q, built, cap));
    expect(rows).toHaveLength(6);
    // the pools were read at 21:21:16.833Z: every QQQx quote is from 87.201 to 94.085 seconds before them
    expect(out.pairing).toEqual({
      secondsApart: pairingOf(rows).secondsApart,
      quotesBeforeCapture: 6,
      quotesAfterCapture: 0,
      quotesAtCaptureTime: 0,
    });
    expect(out.pairing.secondsApart.min).toBe(87.201);
    expect(out.pairing.secondsApart.max).toBe(94.085);
    expect(out.windowMinutes).toBe(5);
    expect(out.chunks).toBe(ROUTE_CHUNKS);
    expect(out.note).toContain('same frozen pools');
    // what the gap contains, and that the gain is another kind of figure
    expect(out.note).toContain('no cost for the SOL to USDC step');
    expect(out.note).toContain('USDC delivered (a sale) or tokens for USDC paid (a purchase)');
    expect(out.note).toContain('the gap reads lower than it is, and it can read negative');
    expect(out.note).toContain('it is not a comparison with Jupiter');
    expect(out.note).toContain('exact to a few raw units');
    expect(out.jupiterWithinModelledPools).toContain(
      'every pool of Jupiter’s route is one we model',
    );
    expect(out.jupiterWithinModelledPools).toContain('not a comparison on the same pools');
    expect(out.jupiterWithinModelledPools).toContain(
      'leaves out every Jupiter route with a SOL leg',
    );
    // the summary is the library's, on the same pairs
    expect(out.summary).toEqual(asJson(summarize(rows)));
    expect(JSON.stringify(out)).not.toContain('samePools');
    expect(Object.keys(out)).toEqual([
      'checkedAt',
      'method',
      'source',
      'provenance',
      'positiveGap',
      'jupiterWithinModelledPools',
      'captures',
      'quotes',
      'pairing',
      'windowMinutes',
      'chunks',
      'summary',
      'note',
    ]);
  }, 60_000);

  it('--router on a folder reads every capture in it, and the quotes from RISK_HOME as the old report does', () => {
    const folder = join(tmp, 'captures');
    mkdirSync(folder);
    // A one-hop view of the fixture, first by name and at the fixture's own time: on that tie it would take every
    // quote, and each would be scored as a measured gain of zero. It is named and left out.
    const oneHop = join(folder, 'a-one-hop.json.gz');
    writeFileSync(oneHop, gzipSync(JSON.stringify({ ...cap, twoHop: false })));
    // the fixture viewed as a whole run: all twelve quotes are compared, as before the capture was cut
    writeFileSync(join(folder, 'b-whole.json.gz'), gzipSync(JSON.stringify(whole)));
    // not captures: a gzip of another kind, and a file with another ending
    writeFileSync(join(folder, 'c-other.json.gz'), gzipSync(JSON.stringify({ kind: 'other' })));
    writeFileSync(join(folder, 'notes.txt'), 'not read');
    const home = join(tmp, 'home-with-quotes');
    mkdirSync(join(home, 'quotes'), { recursive: true });
    const late = { ...fixtureQuote('QQQx', 'sell', 1000), fetchedAt: '2026-10-06T23:00:00.000Z' };
    const failed = { ...fixtureQuote('QQQx', 'buy', 1000), outAmount: null, error: 'no route' };
    const notHeld = { ...fixtureQuote('SPYx', 'sell', 1000), asset: 'ZZZx', assetMint: 'NotHeld' };
    // one more that is compared: taken 60 seconds after the pools were read, and stored with no provenance
    const { provenance: _p, ...after } = {
      ...fixtureQuote('QQQx', 'sell', 1000),
      fetchedAt: '2026-10-06T21:22:16.833Z',
    };
    writeFileSync(
      join(home, 'quotes', '2026-10-06.jsonl'),
      `${[...quotes, late, failed, notHeld, after].map((q) => JSON.stringify(q)).join('\n')}\n`,
    );
    const r = run(['--router', folder], home);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.captures).toEqual({
      count: 2,
      first: cap.fetchedAt,
      last: cap.fetchedAt,
      withQuotes: 1,
      takenWithTwoHops: 1,
      poolsNotBuilt: 0,
      twoHopDirectionsNotRouted: built.notRouted.length,
      notCaptures: [join(folder, 'c-other.json.gz')],
      notUsed: [{ file: oneHop, reason: 'taken_without_two_hops' }],
    });
    // first and last are of the quotes compared: the one at 23:00 has no capture and is in neither
    expect(out.quotes).toEqual({
      read: 16,
      withoutAQuote: 1,
      paired: 14,
      unpaired: 1,
      compared: 13,
      notCompared: [{ reason: 'asset_not_in_capture', quotes: 1 }],
      first: '2026-10-06T21:19:01.017Z',
      last: '2026-10-06T21:22:16.833Z',
    });
    const rows = [...quotes, after].map((q) => row(q));
    expect(out.pairing).toEqual({
      secondsApart: pairingOf(rows).secondsApart,
      quotesBeforeCapture: 12,
      quotesAfterCapture: 1,
      quotesAtCaptureTime: 0,
    });
    // the nearest is the one taken after, the farthest the first SPYx quote, at 21:19:01.017Z
    expect(out.pairing.secondsApart.min).toBe(60);
    expect(out.pairing.secondsApart.max).toBe(135.816);
    // one compared row says nothing of what it is, so the report does not say live
    expect(out.provenance).toBe('live, not_stated');
    expect(out.summary).toEqual(asJson(summarize(rows)));
    // every gain is one a two-hop capture measured: twelve fixture rows and the one added, none from the one-hop view
    expect(out.summary.byAsset.reduce((t: number, g: { pairs: number }) => t + g.pairs, 0)).toBe(
      13,
    );
  }, 60_000);

  it('--router on a capture taken without two hops names it, pairs no quote with it and reports no figure', () => {
    const file = join(tmp, 'one-hop-view.json.gz');
    writeFileSync(file, gzipSync(JSON.stringify({ ...cap, twoHop: false })));
    const r = run(['--router', file, '--quotes', QUOTES], emptyHome);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.captures).toEqual({
      count: 1,
      first: null,
      last: null,
      withQuotes: 0,
      takenWithTwoHops: 0,
      poolsNotBuilt: 0,
      twoHopDirectionsNotRouted: 0,
      notCaptures: [],
      notUsed: [{ file, reason: 'taken_without_two_hops' }],
    });
    expect(out.quotes).toEqual({
      read: 12,
      withoutAQuote: 0,
      paired: 0,
      unpaired: 12,
      compared: 0,
      notCompared: [],
      first: null,
      last: null,
    });
    expect(out.pairing).toEqual({
      secondsApart: noFigure,
      quotesBeforeCapture: 0,
      quotesAfterCapture: 0,
      quotesAtCaptureTime: 0,
    });
    expect(out.provenance).toBeNull();
    // not a gain of zero: no gain at all
    expect(out.summary).toEqual({ bySideAndSize: [], byAsset: [], jupiterRoutes: [] });
    expect(r.stdout).not.toContain('"gainBp"');
  }, 60_000);

  it('--chunks cuts both routes in the number given and prints it', () => {
    const r = run(['--router', CAPTURE, '--quotes', QUOTES, '--chunks', '8'], emptyHome);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.chunks).toBe(8);
    expect(out.quotes.compared).toBe(6);
    const at8 = asJson(summarize(qqqQuotes.map((q) => row(q, built, cap, 8))));
    expect(out.summary).toEqual(at8);
    // and that is not what the router's own number gives on the same pairs
    const atDefault = asJson(summarize(qqqQuotes.map((q) => row(q, built, cap))));
    expect(at8).not.toEqual(atDefault);
    expect(at8.byAsset.map((g: { gainBp: unknown }) => g.gainBp)).not.toEqual(
      atDefault.byAsset.map((g: { gainBp: unknown }) => g.gainBp),
    );
    expect(out.note).toContain('--chunks');
  }, 60_000);

  it('--router with no capture named, with a file that is not a capture, or with a number of chunks it cannot use, fails and prints no report', () => {
    const none = run(['--router'], emptyHome);
    expect(none.status).not.toBe(0);
    expect(none.stdout).toBe('');
    expect(none.stderr).toContain('usage');
    const wrong = run(['--router', QUOTES, '--quotes', QUOTES], emptyHome);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stdout).toBe('');
    const noChunks = run(['--router', CAPTURE, '--quotes', QUOTES, '--chunks', '0'], emptyHome);
    expect(noChunks.status).not.toBe(0);
    expect(noChunks.stdout).toBe('');
    expect(noChunks.stderr).toContain('--chunks takes an integer of 1 or more');
    expect(noChunks.stderr).toContain('usage');
  }, 60_000);

  it('with no flag and an empty RISK_HOME prints the old report’s shape', () => {
    const r = run([], emptyHome);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual([
      'checkedAt',
      'comparisons',
      'flagged',
      'flagThresholdPct',
      'note',
      'byAssetAndSize',
    ]);
    expect(out.comparisons).toBe(0);
    expect(out.flagged).toBe(0);
    expect(out.flagThresholdPct).toBe(0.2);
    expect(out.byAssetAndSize).toEqual([]);
    expect(out.method).toBeUndefined();
  }, 60_000);

  it('with no flag still compares a stored quote with the best single dollar pool, as before', () => {
    const home = join(tmp, 'home-old-report');
    mkdirSync(join(home, 'pools'), { recursive: true });
    mkdirSync(join(home, 'quotes'), { recursive: true });
    // one dollar pool at 100 a token that pays 990 for 1,000; Jupiter pays 999.9 for the same 10 tokens: +1%
    const snap = (pool: string, exitPath: string, outUsd: number) => ({
      pool,
      assetMint: 'MintA',
      fetchedAt: '2026-10-06T21:00:00.000Z',
      exitPath,
      midUsd: 100,
      sell: [{ notionalUsd: 1000, outUsd }],
    });
    writeFileSync(
      join(home, 'pools', '2026-10-06.jsonl'),
      `${[snap('Dollar', 'direct_usd', 990), snap('Sol', 'via_sol', 999)].map((s) => JSON.stringify(s)).join('\n')}\n`,
    );
    const stored = (over: Partial<StoredQuote>) =>
      quoteAt('2026-10-06T21:02:00.000Z', {
        amountIn: '1000000000',
        outAmount: '999900000',
        route: [{ pool: 'Dollar', percent: 100 }],
        ...over,
      });
    writeFileSync(
      join(home, 'quotes', '2026-10-06.jsonl'),
      `${[stored({}), stored({ side: 'buy' }), stored({ fetchedAt: '2026-10-06T21:30:00.000Z' })].map((q) => JSON.stringify(q)).join('\n')}\n`,
    );
    const r = run([], home);
    expect(r.status).toBe(0);
    const { checkedAt, ...rest } = JSON.parse(r.stdout);
    expect(Number.isNaN(Date.parse(checkedAt))).toBe(false);
    expect(rest).toEqual({
      comparisons: 1,
      flagged: 0,
      flagThresholdPct: 0.2,
      note: 'xStocks have 8 decimals (amountIn / 1e8). gap > 0 = routing beats our best single pool (curves are conservative).',
      byAssetAndSize: [{ key: 'AAAx $1000', samples: 1, medianGapPct: 1, minGapPct: 1 }],
    });
  }, 60_000);
});
