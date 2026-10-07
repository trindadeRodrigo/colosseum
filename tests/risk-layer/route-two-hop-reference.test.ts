import {
  type BuiltPool,
  buildPoolSim,
  decodeClmmPool,
  type PoolSim,
  type RoutedTrade,
  type RouteLeg,
  type RoutePool,
  routeTrade,
  type TwoHop,
  type TwoHopPool,
  usdCurves,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { captureBytes, loadCapture, type RegPool } from '../../scripts/risk/lib-split';
import { referenceRoute } from './helpers/two-hop-reference';

// PLAN-UNIVERSE RU.11 — the two-hop router against a second implementation. `referenceRoute` (helpers/two-hop-
// reference.ts) was written from the specification alone, without reading the two-hop code of `routeTrade`; this test
// holds the two against each other on real mainnet accounts frozen 2026-10-06T21:21:16Z by
// `pnpm risk:split-capture --two-hop --only QQQx` (fixtures/risk/route): the dollar and SOL pools of QQQx, SPYx and
// AMZNx, and the six pools that pair two of them. The simulators are built here by hand, as `pnpm risk:split-snapshot`
// builds them, so nothing but the pool decoders is shared with the code under test. No network.
const cap = loadCapture('fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz');
const USD_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const SOL = 'So11111111111111111111111111111111111111112';
const mintOf = new Map(cap.direct.map((p) => [p.assetSymbol, p.assetMint]));
const mint = (symbol: string) => {
  const m = mintOf.get(symbol);
  if (!m) throw new Error(`${symbol}: not in the fixture`);
  return m;
};

/**
 * The capture as routing inputs. `feeBps`, when given, sets a Token-2022 transfer fee per mint in place of the
 * registry's (zero on every mint of the capture): the simulators charge it and the pools declare it.
 */
function world(feeBps?: ReadonlyMap<string, number>) {
  const row = (p: RegPool): RegPool => {
    if (!feeBps) return p;
    const [mint0, mint1] = p.assetIsToken0
      ? [p.assetMint, p.quoteMint]
      : [p.quoteMint, p.assetMint];
    return {
      ...p,
      transferFeeBps0: feeBps.get(mint0) ?? 0,
      transferFeeBps1: feeBps.get(mint1) ?? 0,
    };
  };
  const bytes = (key: string) => captureBytes(cap, key);
  const builds = new Map<string, BuiltPool>();
  /** One pool's simulator from the frozen accounts, built once. */
  const built = (p: RegPool): BuiltPool => {
    const done = builds.get(p.address);
    if (done) return done;
    const head = bytes(p.address);
    if (!head) throw new Error(`${p.address}: the pool account is not in the fixture`);
    const cfg = p.venue === 'raydium_clmm' ? bytes(decodeClmmPool(head).ammConfig) : undefined;
    const kids: Uint8Array[] = [];
    for (const k of cap.children[p.address] ?? []) {
      const d = bytes(k);
      if (d) kids.push(d);
    }
    const b = buildPoolSim(p, head, kids, cfg);
    builds.set(p.address, b);
    return b;
  };
  // the pool's two sides as the registry files them: its asset (the stock it is filed under) and its quote
  const filed = (p: RegPool) => ({
    decAsset: p.assetIsToken0 ? p.decimals0 : p.decimals1,
    decQuote: p.assetIsToken0 ? p.decimals1 : p.decimals0,
    feeAsset: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
    feeQuote: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
  });

  // the dollar and SOL pools of each stock, in the order of the capture
  const directOf = new Map<string, RoutePool[]>();
  for (const p of cap.direct.map(row)) {
    const quoteUsd = USD_MINTS.has(p.quoteMint) ? 1 : p.quoteMint === SOL ? cap.solUsd : null;
    if (!quoteUsd) throw new Error(`${p.address}: no dollar value for quote ${p.quoteMint}`);
    const b = built(p);
    const f = filed(p);
    const midUsd = usdCurves(b.sim, f.decAsset, f.decQuote, quoteUsd, [100]).midUsd;
    if (!(midUsd > 0)) throw new Error(`${p.address}: no mid`);
    directOf.set(p.assetMint, [
      ...(directOf.get(p.assetMint) ?? []),
      {
        pool: p.address,
        sim: b.sim,
        decAsset: f.decAsset,
        decQuote: f.decQuote,
        quoteUsd,
        midUsd,
        tvlUsd: p.tvlUsd,
        feeRate: b.feeRate,
        transferFeeBps: { asset: f.feeAsset, quote: f.feeQuote },
      },
    ]);
  }

  /** Every stock-to-stock pool the asset is in, either side, and the dollar and SOL pools of each other stock. */
  const twoHopOf = (asset: string): TwoHop => {
    const pools: TwoHopPool[] = [];
    for (const p of cap.twoHopPools.map(row)) {
      if (p.assetMint !== asset && p.quoteMint !== asset) continue;
      const assetIsSimAsset = p.assetMint === asset;
      const b = built(p);
      const f = filed(p);
      pools.push({
        pool: p.address,
        sim: b.sim,
        assetIsSimAsset,
        via: assetIsSimAsset ? p.quoteMint : p.assetMint,
        decAsset: assetIsSimAsset ? f.decAsset : f.decQuote,
        decVia: assetIsSimAsset ? f.decQuote : f.decAsset,
        tvlUsd: p.tvlUsd,
        feeRate: b.feeRate,
        transferFeeBps: assetIsSimAsset
          ? { asset: f.feeAsset, via: f.feeQuote }
          : { asset: f.feeQuote, via: f.feeAsset },
      });
    }
    const via = new Map<string, RoutePool[]>();
    for (const p of pools) {
      const own = directOf.get(p.via);
      if (own) via.set(p.via, own);
    }
    return { pools, via };
  };

  return (symbol: string) => {
    const direct = directOf.get(mint(symbol));
    if (!direct) throw new Error(`${symbol}: no dollar or SOL pool in the fixture`);
    return { direct, twoHop: twoHopOf(mint(symbol)) };
  };
}
const captured = world();
// no mint of the capture charges a transfer fee, so as captured that part of the split is zero on both sides: here
// every stock charges one (basis points), in the simulators and in what the pools declare
const charged = world(
  new Map([
    [mint('QQQx'), 30],
    [mint('SPYx'), 20],
    [mint('AMZNx'), 10],
  ]),
);

const SYMBOLS = ['QQQx', 'SPYx', 'AMZNx'] as const;
const NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const SIDES = ['sell', 'buy'] as const;
const CHUNKS = 32;
// the reference runs each via token's route again for every candidate: slow by design
const SLOW = 120_000;

// ---- the comparison: relative 1e-9, absolute 1e-12 for a value near zero ----
const REL = 1e-9;
const ABS = 1e-12;
const close = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return d <= ABS || d <= REL * Math.max(Math.abs(a), Math.abs(b));
};

/** Every field where `routeTrade` and the reference differ, in words. Empty when they agree. */
function differences(actual: RoutedTrade, expected: RoutedTrade): string[] {
  const out: string[] = [];
  const num = (what: string, a: number | undefined, e: number | undefined) => {
    if (a === undefined || e === undefined || !close(a, e))
      out.push(`${what}: routeTrade ${a}, reference ${e}`);
  };
  const same = (what: string, a: unknown, e: unknown) => {
    if (a !== e) out.push(`${what}: routeTrade ${String(a)}, reference ${String(e)}`);
  };
  const legs = (what: string, a: RouteLeg[], e: RouteLeg[]) => {
    same(`${what}.length`, a.length, e.length);
    for (let i = 0; i < Math.min(a.length, e.length); i++) {
      const [x, y] = [a[i] as RouteLeg, e[i] as RouteLeg];
      const at = `${what}[${i}]`;
      same(`${at}.pool`, x.pool, y.pool);
      num(`${at}.amountIn`, x.amountIn, y.amountIn);
      num(`${at}.unfilledShare`, x.unfilledShare, y.unfilledShare);
      num(`${at}.outUsd`, x.outUsd, y.outUsd);
      num(`${at}.midUsd`, x.midUsd, y.midUsd);
      num(`${at}.feeRate`, x.feeRate, y.feeRate);
      // no `via` key on a leg that is not a two-hop leg
      same(`${at} has via`, 'via' in x, 'via' in y);
      same(`${at}.via.mint`, x.via?.mint, y.via?.mint);
      if (x.via && y.via) num(`${at}.via.amount`, x.via.amount, y.via.amount);
    }
  };
  same('side', actual.side, expected.side);
  num('notionalUsd', actual.notionalUsd, expected.notionalUsd);
  num('outUsd', actual.outUsd, expected.outUsd);
  num('costPct', actual.costPct, expected.costPct);
  same('poolsUsed', actual.poolsUsed, expected.poolsUsed);
  same('refPool', actual.refPool, expected.refPool);
  num('refMidUsd', actual.refMidUsd, expected.refMidUsd);
  legs('legs', actual.legs, expected.legs);
  for (const part of ['total', 'poolFee', 'transferFee', 'basis', 'impact'] as const)
    num(`split.${part}`, actual.split[part], expected.split[part]);
  // no `viaTrades` key unless a two-hop leg carries an amount
  same('has viaTrades', 'viaTrades' in actual, 'viaTrades' in expected);
  const [av, ev] = [actual.viaTrades ?? [], expected.viaTrades ?? []];
  same('viaTrades, in order', av.map((v) => v.via).join(' '), ev.map((v) => v.via).join(' '));
  for (let i = 0; i < Math.min(av.length, ev.length); i++) {
    const [x, y] = [av[i] as (typeof av)[number], ev[i] as (typeof ev)[number]];
    const at = `viaTrades[${i}]`;
    same(`${at}.via`, x.via, y.via);
    num(`${at}.amount`, x.amount, y.amount);
    num(`${at}.usd`, x.usd, y.usd);
    same(`${at}.refPool`, x.refPool, y.refPool);
    num(`${at}.refMidUsd`, x.refMidUsd, y.refMidUsd);
    legs(`${at}.legs`, x.legs, y.legs);
  }
  return out;
}

/**
 * The whole grid, both sides, for one set of pools: what differs, and what the reference's routes went through, so
 * each test can say which paths its comparison covered.
 */
function compareGrid(
  label: string,
  direct: readonly RoutePool[],
  twoHop: TwoHop,
  chunks: number = CHUNKS,
) {
  const found: string[] = [];
  const routes: RoutedTrade[] = [];
  for (const side of SIDES)
    for (const size of NOTIONALS) {
      const expected = referenceRoute(direct, size, side, chunks, twoHop);
      const actual = routeTrade(direct, size, side, chunks, twoHop);
      for (const d of differences(actual, expected)) found.push(`${label} ${side} ${size}: ${d}`);
      routes.push(expected);
    }
  const hopLegs = (r: RoutedTrade) => r.legs.filter((l) => l.via);
  const filedUnderAsset = new Set(twoHop.pools.filter((p) => p.assetIsSimAsset).map((p) => p.pool));
  return {
    found,
    trades: routes.length,
    /** Trades with an amount through a stock-to-stock pool. */
    twoHopTrades: routes.filter((r) => r.viaTrades).length,
    /** By side: the most via tokens one trade went through, and the most pools into one via token. */
    bySide: SIDES.map((side) => {
      const rs = routes.filter((r) => r.side === side);
      const poolsPerVia = rs.flatMap((r) =>
        (r.viaTrades ?? []).map((v) => hopLegs(r).filter((l) => l.via?.mint === v.via).length),
      );
      return {
        side,
        vias: Math.max(...rs.map((r) => r.viaTrades?.length ?? 0)),
        poolsIntoOneVia: Math.max(0, ...poolsPerVia),
        // both ways round: a pool filed under the traded asset, and one filed under the other stock
        filedUnderAsset: rs.some((r) => hopLegs(r).some((l) => filedUnderAsset.has(l.pool))),
        filedUnderVia: rs.some((r) => hopLegs(r).some((l) => !filedUnderAsset.has(l.pool))),
      };
    }),
    transferFeeMax: Math.max(...routes.map((r) => r.split.transferFee)),
  };
}
const none = (found: string[]) => expect(found.slice(0, 25), `${found.length} differences`);

describe('routeTrade with two hops, against a reference written from the specification alone', () => {
  it('the fixture holds what the comparison needs: 21 dollar and SOL pools, 6 stock-to-stock pools', () => {
    expect(SYMBOLS.map((s) => captured(s).direct.length)).toEqual([7, 10, 4]);
    expect(cap.twoHopPools.length).toBe(6);
    // QQQx is in all six (filed under it in four), SPYx in five, AMZNx in one; every via token has its own pools
    const sides = SYMBOLS.map((s) => {
      const t = captured(s).twoHop;
      return {
        pools: t.pools.length,
        filedUnderIt: t.pools.filter((p) => p.assetIsSimAsset).length,
        vias: [...t.via.keys()].length,
      };
    });
    expect(sides).toEqual([
      { pools: 6, filedUnderIt: 4, vias: 2 },
      { pools: 5, filedUnderIt: 2, vias: 1 },
      { pools: 1, filedUnderIt: 0, vias: 1 },
    ]);
  });

  it('one stock-to-stock pool, one pool of the via token, one chunk: both routes are the two swaps simulated by hand', () => {
    // what anchors the reference itself: QQQx through the largest QQQx/SPYx pool and SPYx's largest pool, then SPYx
    // through the same pool the other way round and QQQx's largest pool. The asset's own pool is its smallest, too
    // small for the trade, so the one chunk goes through two hops
    const pair = cap.twoHopPools[0]?.address;
    let n = 0;
    for (const [symbol, viaSymbol] of [
      ['QQQx', 'SPYx'],
      ['SPYx', 'QQQx'],
    ] as const) {
      const own = captured(symbol);
      const hop = own.twoHop.pools.find((p) => p.pool === pair) as TwoHopPool;
      const small = [...own.direct].sort((a, b) => a.tvlUsd - b.tvlUsd)[0] as RoutePool;
      const big = [...captured(viaSymbol).direct].sort(
        (a, b) => b.tvlUsd - a.tvlUsd,
      )[0] as RoutePool;
      const t: TwoHop = { pools: [hop], via: new Map([[hop.via, [big]]]) };
      expect(hop.assetIsSimAsset).toBe(symbol === 'QQQx');
      const size = 500;
      for (const side of SIDES) {
        let via: number;
        let usd: number;
        if (side === 'sell') {
          // the asset into the stock-to-stock pool, then the via tokens it paid into the via token's pool
          const raw = Math.floor((size / small.midUsd) * 10 ** hop.decAsset);
          const first = hop.assetIsSimAsset ? hop.sim.sellAsset(raw) : hop.sim.buyAsset(raw);
          via = (first.out / 10 ** hop.decVia) * (1 - first.unfilledShare);
          const second = big.sim.sellAsset(Math.floor(via * 10 ** big.decAsset));
          usd = (second.out / 10 ** big.decQuote) * big.quoteUsd * (1 - second.unfilledShare);
        } else {
          // dollars into the via token's pool, then the via tokens it paid into the stock-to-stock pool
          const first = big.sim.buyAsset(Math.floor((size / big.quoteUsd) * 10 ** big.decQuote));
          via = (first.out / 10 ** big.decAsset) * (1 - first.unfilledShare);
          const raw = Math.floor(via * 10 ** hop.decVia);
          const second = hop.assetIsSimAsset ? hop.sim.buyAsset(raw) : hop.sim.sellAsset(raw);
          usd = (second.out / 10 ** hop.decAsset) * (1 - second.unfilledShare) * small.midUsd;
        }
        // two real swaps of 500 dollars return 500 dollars less two pool fees and a little impact. The two stocks'
        // prices are 2.7% apart in this capture, so a swap the wrong way round cannot stay under 1%
        expect(Math.abs(usd / size - 1), `${symbol} ${side}`).toBeLessThan(0.01);
        for (const [who, r] of [
          ['reference', referenceRoute([small], size, side, 1, t)],
          ['routeTrade', routeTrade([small], size, side, 1, t)],
        ] as const) {
          const label = `${who} ${symbol} ${side}`;
          expect(r.legs.length, label).toBe(1);
          expect(r.legs[0]?.via?.mint, label).toBe(hop.via);
          expect(close(r.legs[0]?.via?.amount ?? Number.NaN, via), label).toBe(true);
          expect(close(r.outUsd, usd), `${label}: ${r.outUsd} against ${usd} by hand`).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBe(8);
  });

  it.each(SYMBOLS)(
    '%s: every grid size, both sides, 32 chunks: every leg, every via trade and the split agree to 1e-9',
    (symbol) => {
      const { direct, twoHop } = captured(symbol);
      const r = compareGrid(symbol, direct, twoHop);
      expect(r.trades).toBe(16);
      none(r.found).toEqual([]);
      // the comparison is not empty: the reference sends an amount through two hops on this asset
      expect(r.twoHopTrades).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'QQQx with 4 chunks agrees as well',
    () => {
      const { direct, twoHop } = captured('QQQx');
      const r = compareGrid('QQQx, 4 chunks', direct, twoHop, 4);
      expect(r.trades).toBe(16);
      none(r.found).toEqual([]);
      expect(r.twoHopTrades).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'QQQx as captured covers both ways round a stock-to-stock pool and several pools into one via token',
    () => {
      const { direct, twoHop } = captured('QQQx');
      for (const s of compareGrid('QQQx', direct, twoHop).bySide) {
        expect(s.filedUnderAsset, s.side).toBe(true);
        expect(s.filedUnderVia, s.side).toBe(true);
        expect(s.poolsIntoOneVia, s.side).toBeGreaterThan(1);
      }
    },
    SLOW,
  );

  it(
    'QQQx left with its three smallest dollar and SOL pools: most of a trade goes through two hops, and they still agree',
    () => {
      // the same frozen pools with less on the direct side, so the stock-to-stock pools carry the trade: on each side
      // a trade goes through both via tokens at once (as captured, no purchase does)
      const { direct, twoHop } = captured('QQQx');
      const thin = [...direct].sort((a, b) => a.tvlUsd - b.tvlUsd).slice(0, 3);
      const r = compareGrid('QQQx, thin', thin, twoHop);
      none(r.found).toEqual([]);
      expect(r.twoHopTrades).toBe(16);
      for (const s of r.bySide) expect(s.vias, s.side).toBe(2);
    },
    SLOW,
  );

  it(
    'with a transfer fee on every stock token the split agrees as well, the transfer fee part included',
    () => {
      for (const symbol of SYMBOLS) {
        const { direct, twoHop } = charged(symbol);
        const r = compareGrid(`${symbol}, transfer fees`, direct, twoHop);
        none(r.found).toEqual([]);
        expect(r.twoHopTrades, symbol).toBeGreaterThan(0);
        expect(r.transferFeeMax, symbol).toBeGreaterThan(0);
      }
    },
    SLOW,
  );

  it(
    'a stock-to-stock pool whose mid is not a positive finite number is left out by both, as if it were not listed',
    () => {
      // the capture has no such pool, so this one is made up: the labels of a real QQQx/SPYx pool on a simulator with
      // no fee and no limit that pays two raw units for each raw unit in, either way. Both routers want such a pool,
      // so what keeps it out of a route is its mid and nothing else
      const { direct, twoHop } = captured('QQQx');
      const real = twoHop.pools.find((p) => p.via === mint('SPYx')) as TwoHopPool;
      const sim = (midRaw: number): PoolSim => ({
        midRaw,
        sellAsset: (raw) => ({ out: raw * 2, unfilledShare: 0 }),
        buyAsset: (raw) => ({ out: raw * 2, unfilledShare: 0 }),
        depthWithin: () => ({ sellQuoteOut: 0, buyAssetOut: 0 }),
      });
      const withMadeUp = (midRaw: number, assetIsSimAsset: boolean): TwoHop => ({
        pools: [{ ...real, pool: 'made-up', sim: sim(midRaw), assetIsSimAsset }, ...twoHop.pools],
        via: twoHop.via,
      });
      let n = 0;
      for (const side of SIDES)
        for (const size of [500, 250_000]) {
          const without = JSON.stringify(referenceRoute(direct, size, side, CHUNKS, twoHop));
          // the mid is read both ways round: as the simulator gives it, and inverted
          for (const assetIsSimAsset of [true, false]) {
            // with a mid of one the made-up pool is routed by both, and they agree on the route
            const usable = withMadeUp(1, assetIsSimAsset);
            const routed = referenceRoute(direct, size, side, CHUNKS, usable);
            expect(routed.legs.some((l) => l.pool === 'made-up')).toBe(true);
            expect(differences(routeTrade(direct, size, side, CHUNKS, usable), routed)).toEqual([]);
            for (const midRaw of [0, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
              const label = `${side} ${size} ${assetIsSimAsset} mid ${midRaw}`;
              const t = withMadeUp(midRaw, assetIsSimAsset);
              const expected = referenceRoute(direct, size, side, CHUNKS, t);
              expect(JSON.stringify(expected), label).toBe(without);
              expect(
                differences(routeTrade(direct, size, side, CHUNKS, t), expected),
                label,
              ).toEqual([]);
              n++;
            }
          }
        }
      expect(n).toBe(32);
    },
    SLOW,
  );

  it('via trades come in the order their first pool with an amount comes, not the order their pools are listed', () => {
    // QQQx's stock-to-stock pools smallest first: a SPYx pool, the AMZNx pool, then four SPYx pools. A purchase of
    // 2,500 on the thin side sends nothing to the first SPYx pool, so the AMZNx trade is the first one used
    const { direct, twoHop } = captured('QQQx');
    const thin = [...direct].sort((a, b) => a.tvlUsd - b.tvlUsd).slice(0, 3);
    const smallestFirst = [...twoHop.pools].sort((a, b) => a.tvlUsd - b.tvlUsd);
    const t: TwoHop = { pools: smallestFirst, via: twoHop.via };
    expect(smallestFirst.slice(0, 2).map((p) => p.via)).toEqual([mint('SPYx'), mint('AMZNx')]);
    const expected = referenceRoute(thin, 2_500, 'buy', CHUNKS, t);
    expect(expected.legs.some((l) => l.pool === smallestFirst[0]?.pool)).toBe(false);
    expect(expected.viaTrades?.map((v) => v.via)).toEqual([mint('AMZNx'), mint('SPYx')]);
    expect(differences(routeTrade(thin, 2_500, 'buy', CHUNKS, t), expected)).toEqual([]);
  });

  it(
    'they agree off the grid too: 400 seeded draws of pools, order, size, side and chunks',
    () => {
      // a fixed seed, so the same 400 trades every run: a random part of the asset's dollar and SOL pools and of its
      // stock-to-stock pools, each in a random order; sometimes a random part of a via token's pools; sizes from about
      // 30 to 10 million dollars; 1 to 32 chunks; three draws in ten with the transfer fees
      let seed = 1;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)] as T;
      const part = <T>(xs: readonly T[], atLeast: number) => {
        const a = [...xs];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [a[i], a[j]] = [a[j] as T, a[i] as T];
        }
        return a.slice(0, Math.max(atLeast, Math.ceil(rnd() * a.length)));
      };
      const found: string[] = [];
      let twoHopTrades = 0;
      let twoVias = 0;
      for (let c = 0; c < 400; c++) {
        const { direct, twoHop } = (rnd() < 0.3 ? charged : captured)(pick(SYMBOLS));
        const d = part(direct, 1);
        const t: TwoHop = {
          pools: part(twoHop.pools, 1),
          via: new Map([...twoHop.via].map(([k, v]) => [k, rnd() < 0.3 ? part(v, 1) : v])),
        };
        const size = Math.round(10 ** (1.5 + rnd() * 5.5) * 100) / 100;
        const side = pick(SIDES);
        const chunks = pick([1, 2, 3, 4, 7, 16, CHUNKS, CHUNKS, CHUNKS]);
        const expected = referenceRoute(d, size, side, chunks, t);
        const actual = routeTrade(d, size, side, chunks, t);
        for (const x of differences(actual, expected))
          found.push(`draw ${c} (${side} ${size}, ${chunks} chunks): ${x}`);
        if (expected.viaTrades) twoHopTrades++;
        if ((expected.viaTrades?.length ?? 0) > 1) twoVias++;
      }
      none(found).toEqual([]);
      expect(twoHopTrades).toBeGreaterThan(100);
      expect(twoVias).toBeGreaterThan(5);
    },
    SLOW,
  );

  it('the comparison has teeth: a route that ignores two hops, and one number off by 1e-8, are both reported', () => {
    const { direct, twoHop } = captured('QQQx');
    const expected = referenceRoute(direct, 250_000, 'sell', CHUNKS, twoHop);
    expect(expected.viaTrades?.length).toBe(1);
    const oneHop = referenceRoute(direct, 250_000, 'sell', CHUNKS, undefined);
    expect(differences(oneHop, expected).length).toBeGreaterThan(0);
    const nudge = (change: (r: RoutedTrade) => void) => {
      const r = structuredClone(expected);
      change(r);
      return differences(r, expected);
    };
    const off = 1 + 1e-8;
    expect(
      nudge((r) => {
        const leg = r.legs.find((l) => l.via);
        if (leg?.via) leg.via.amount *= off;
      }),
    ).toHaveLength(1);
    expect(
      nudge((r) => {
        r.split.total *= off;
      }),
    ).toHaveLength(1);
    expect(
      nudge((r) => {
        const leg = r.viaTrades?.[0]?.legs[0];
        if (leg) leg.outUsd *= off;
      }),
    ).toHaveLength(1);
    // a `via` key on a direct leg, even an empty one, is a difference
    expect(
      nudge((r) => {
        (r.legs[0] as RouteLeg).via = undefined;
      }),
    ).toHaveLength(1);
  });

  it('with two hops absent, or nothing routable, the route is the one-hop route bit for bit', () => {
    let n = 0;
    for (const symbol of SYMBOLS) {
      const { direct, twoHop } = captured(symbol);
      // a via token with no pools of its own, or with an empty list, leaves its pools out of the route
      const noVia: TwoHop = { pools: twoHop.pools, via: new Map() };
      const emptyVia: TwoHop = {
        pools: twoHop.pools,
        via: new Map([...twoHop.via.keys()].map((k) => [k, []])),
      };
      const noPools: TwoHop = { pools: [], via: twoHop.via };
      for (const side of SIDES)
        for (const size of NOTIONALS) {
          const expected = referenceRoute(direct, size, side, CHUNKS, undefined);
          const today = JSON.stringify(expected);
          const label = `${symbol} ${side} ${size}`;
          const absent = routeTrade(direct, size, side, CHUNKS, undefined);
          expect(differences(absent, expected), label).toEqual([]);
          expect(JSON.stringify(absent), label).toBe(today);
          expect(JSON.stringify(routeTrade(direct, size, side)), label).toBe(today);
          for (const [what, t] of [
            ['no via entry', noVia],
            ['empty via entry', emptyVia],
            ['no two-hop pools', noPools],
          ] as const) {
            const routed = routeTrade(direct, size, side, CHUNKS, t);
            expect(JSON.stringify(routed), `${label}, ${what}`).toBe(today);
            expect(JSON.stringify(referenceRoute(direct, size, side, CHUNKS, t)), what).toBe(today);
          }
          n++;
        }
    }
    expect(n).toBe(48);
  });
});
