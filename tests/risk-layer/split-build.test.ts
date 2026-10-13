import {
  buildPoolSim,
  decodeClmmPool,
  type PoolSim,
  type RoutePool,
  routeTrade,
  type TwoHopPool,
  usdCurves,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  type BuiltSplit,
  buildSplit,
  captureBytes,
  loadCapture,
  type RegPool,
  type SplitCapture,
} from '../../scripts/risk/lib-split';

// PLAN-UNIVERSE RU.11 — buildSplit turns one frozen split snapshot into router inputs, with no I/O. On the mainnet
// accounts frozen 2026-10-06T21:21:16Z by `pnpm risk:split-capture --two-hop --only QQQx` (fixtures/risk/route): the
// dollar and SOL pools of SPYx, QQQx and AMZNx, and the six pools that pair two of them. The reference for the dollar
// and SOL pools is the loop the snapshot ran at `split-0.1`, copied from scripts/risk/split-snapshot.ts as it stood
// before this item. No test calls the network.
const c = loadCapture('fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz');

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const AMZNX = 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg';
// the six stock-to-stock pools, in the capture's order ("A/B": filed under A, B the quote side)
const FN27 = 'FN27PwZpDnSBNZR5vzx6B7waxowV84ZNFQrzgr6XeYbf'; // QQQx/SPYx, Raydium CLMM
const P7MYF = '7mYFrN2TQtYc2HMZEXuVfWkPu9n5EFfX9Ha59X3n6PWE'; // QQQx/SPYx, Orca
const HIYU = 'HiyUy53Ytjfw2Wz2Rs6n5y3AVYc9r4w9sx3nX9HoWbzy'; // QQQx/SPYx, Orca
const P9YSI = '9YSi9RRBShzkFuBDcv7LjpSKGYzNGW4bLDH67M75ThVf'; // SPYx/QQQx, Meteora DLMM
const P9U6G = '9u6gCwPRVmcf7P61ActRqJBhJrqZEftL6FpfsndhPNp'; // QQQx/AMZNx, Meteora DLMM
const CAXN = 'CaXn3BMd41fCyuCsZQwL5j1Tgsnf9DFjhE75ts4RGfAd'; // SPYx/QQQx, Meteora DLMM
// three of the dollar pools, named where a test takes one away
const GMJG = 'GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG'; // QQQx/USDC, Raydium CLMM, QQQx's largest
const FAE5 = 'Fae5dWVntUt6zbWu2voXxioDpMii7SqQwtsxBmoVCsHR'; // SPYx/USDC, Orca
const EV4O = 'eV4ogmq1yriacUmvXnFr2shVnXDrVidDvVcU24irEEo'; // QQQx/USDC, Meteora DLMM
const P2GSU = '2GSuWELUCV3CcGNAHKnD1xpZ6H4nbqDc4SAv5b5U9wJ5'; // AMZNx/SOL, Raydium CLMM, alone on its fee config

// --- the snapshot's loop at split-0.1 (scripts/risk/split-snapshot.ts before RU.11), reading a capture ---
const USD_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const SOL = 'So11111111111111111111111111111111111111112';
const NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const b = (cap: SplitCapture, key: string): Uint8Array | undefined => {
  const s = cap.accounts[key];
  return s ? new Uint8Array(Buffer.from(s, 'base64')) : undefined;
};
const simByHand = (cap: SplitCapture, p: RegPool, head: Uint8Array) => {
  const cfg = p.venue === 'raydium_clmm' ? b(cap, decodeClmmPool(head).ammConfig) : undefined;
  const kids = (cap.children[p.address] ?? [])
    .map((k) => b(cap, k))
    .filter((d): d is Uint8Array => !!d);
  return buildPoolSim(p, head, kids, cfg);
};
function byHand(cap: SplitCapture) {
  const byAsset = new Map<string, RoutePool[]>();
  const meta = new Map<string, { symbol: string }>();
  const failures: string[] = [];
  for (const p of cap.direct) {
    const head = b(cap, p.address);
    if (!head) {
      failures.push(`${p.address}: head missing`);
      continue;
    }
    const quoteUsd = USD_MINTS.has(p.quoteMint) ? 1 : p.quoteMint === SOL ? cap.solUsd : null;
    if (!quoteUsd) {
      failures.push(`${p.address}: no USD for quote ${p.quoteMint}`);
      continue;
    }
    try {
      const built = simByHand(cap, p, head);
      const decAsset = p.assetIsToken0 ? p.decimals0 : p.decimals1;
      const decQuote = p.assetIsToken0 ? p.decimals1 : p.decimals0;
      const midUsd = usdCurves(built.sim, decAsset, decQuote, quoteUsd, [100]).midUsd;
      if (!(midUsd > 0)) continue;
      byAsset.set(p.assetMint, [
        ...(byAsset.get(p.assetMint) ?? []),
        {
          pool: p.address,
          sim: built.sim,
          decAsset,
          decQuote,
          quoteUsd,
          midUsd,
          tvlUsd: p.tvlUsd,
          feeRate: built.feeRate,
          transferFeeBps: {
            asset: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
            quote: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
          },
        },
      ]);
      meta.set(p.assetMint, { symbol: p.assetSymbol });
    } catch (e) {
      failures.push(`${p.address}: ${String(e).slice(0, 80)}`);
    }
  }
  return { byAsset, meta, failures };
}

// --- helpers ---
// a simulator as numbers: its mid and what it pays for four sizes each way (raw units)
const SIZES = [1e6, 1e8, 1e10, 1e12];
const simShape = (s: PoolSim) => ({
  midRaw: s.midRaw,
  sell: SIZES.map((x) => s.sellAsset(x)),
  buy: SIZES.map((x) => s.buyAsset(x)),
});
// a whole result as text: every field in its order, every number in full
const shape = (s: BuiltSplit) =>
  JSON.stringify({
    assets: [...s.byAsset].map(([mint, a]) => ({
      mint,
      symbol: a.symbol,
      pools: a.pools.map((p) => ({ ...p, sim: simShape(p.sim) })),
      twoHop: a.twoHop.map((t) => ({ ...t, sim: simShape(t.sim) })),
    })),
    via: [...s.via].map(([mint, pools]) => [mint, pools.map((p) => p.pool)]),
    failures: s.failures,
    notRouted: s.notRouted,
  });
const asset = (s: BuiltSplit, mint: string) => {
  const a = s.byAsset.get(mint);
  if (!a) throw new Error(`no asset ${mint}`);
  return a;
};
const twoHopOf = (s: BuiltSplit, mint: string) =>
  (s.byAsset.get(mint)?.twoHop ?? []).map((t) => [t.pool, t.assetIsSimAsset, t.via]);
const row = (cap: SplitCapture, address: string) => {
  const r = [...cap.direct, ...cap.twoHopPools].find((p) => p.address === address);
  if (!r) throw new Error(`no row ${address}`);
  return r;
};
const refOf = (pools: readonly RoutePool[]) =>
  [...pools].sort((x, y) => y.tvlUsd - x.tvlUsd)[0] as RoutePool;
// via tokens per asset token at the pool's mid, whole tokens
const viaPerAsset = (t: TwoHopPool) =>
  (t.assetIsSimAsset ? t.sim.midRaw : 1 / t.sim.midRaw) * 10 ** (t.decAsset - t.decVia);
// the capture with some accounts gone (not read at all) or null (the chain did not return them)
const without = (keys: string[], as: 'gone' | 'null' = 'gone'): SplitCapture => ({
  ...c,
  accounts: Object.fromEntries(
    Object.entries(c.accounts)
      .filter(([k]) => as === 'null' || !keys.includes(k))
      .map(([k, v]) => [k, keys.includes(k) ? null : v]),
  ),
});
const truncated = (key: string) =>
  Buffer.from(c.accounts[key] as string, 'base64')
    .subarray(0, 16)
    .toString('base64');
// the capture with some pools read without their tick or bin arrays: the collector's cache lists none for them
// ('none'), or it lists them and the chain returned none ('null')
const withoutArrays = (pools: string[], as: 'none' | 'null'): SplitCapture =>
  as === 'none'
    ? { ...c, children: { ...c.children, ...Object.fromEntries(pools.map((p) => [p, []])) } }
    : without(
        pools.flatMap((p) => c.children[p] as string[]),
        'null',
      );
// the fee config a Raydium pool account names, and the Raydium pools of the capture that name the same one
const feeConfigOf = (pool: string) => decodeClmmPool(b(c, pool) as Uint8Array).ammConfig;
const poolsOnConfig = (key: string) =>
  [...c.direct, ...c.twoHopPools]
    .filter((p) => p.venue === 'raydium_clmm' && feeConfigOf(p.address) === key)
    .map((p) => p.address);
// a Raydium pool account naming a fee config the capture does not hold: the first byte that is part of the key, changed
const namingAnotherConfig = (pool: string) => {
  const head = Buffer.from(c.accounts[pool] as string, 'base64');
  const key = decodeClmmPool(head).ammConfig;
  const flipped = (i: number) => {
    const h = Buffer.from(head);
    h[i] = (h[i] as number) ^ 1;
    return h;
  };
  const at = head.findIndex((_, i) => decodeClmmPool(flipped(i)).ammConfig !== key);
  return flipped(at).toString('base64');
};
// nothing in a result may come from outside the capture it was built from
const expectOnlyFrom = (s: BuiltSplit, cap: SplitCapture) => {
  for (const [mint, a] of s.byAsset) {
    for (const p of a.pools) {
      expect(cap.accounts[p.pool]).toBeTruthy();
      expect(row(cap, p.pool).assetMint).toBe(mint);
    }
    for (const t of a.twoHop) {
      expect(cap.accounts[t.pool]).toBeTruthy();
      expect(cap.tracked).toContain(t.via);
      expect(s.via.get(t.via)?.length).toBeGreaterThan(0);
    }
  }
  for (const [mint, pools] of s.via) expect(pools).toBe(asset(s, mint).pools);
};

// one direction of a stock-to-stock pool as `notRouted` lists it: `from` traded through `via`
const listed = (pool: string, from: string, via: string, reason: string) => {
  const r = row(c, pool);
  const sym = (mint: string) => (mint === r.assetMint ? r.assetSymbol : r.quoteSymbol);
  return {
    pool,
    asset: sym(from),
    assetMint: from,
    via,
    viaSymbol: sym(via),
    tvlUsd: r.tvlUsd,
    reason,
  };
};

const full = buildSplit(c);

describe('buildSplit: the dollar and SOL pools', () => {
  it('gives SPYx, QQQx and AMZNx in the order of the capture, with 10, 7 and 4 pools', () => {
    expect(c.direct.length).toBe(21);
    expect([...full.byAsset].map(([mint, a]) => [mint, a.symbol, a.pools.length])).toEqual([
      [SPYX, 'SPYx', 10],
      [QQQX, 'QQQx', 7],
      [AMZNX, 'AMZNx', 4],
    ]);
    for (const [mint, a] of full.byAsset)
      expect(a.pools.map((p) => p.pool)).toEqual(
        c.direct.filter((p) => p.assetMint === mint).map((p) => p.address),
      );
    expect(full.failures).toEqual([]);
  });

  it('each pool is the one the snapshot built at split-0.1: same fields, same order, same numbers', () => {
    const hand = byHand(c);
    expect(hand.failures).toEqual([]);
    expect([...full.byAsset.keys()]).toEqual([...hand.byAsset.keys()]);
    for (const [mint, pools] of hand.byAsset) {
      const a = asset(full, mint);
      expect(a.symbol).toBe(hand.meta.get(mint)?.symbol);
      expect(JSON.stringify(a.pools)).toBe(JSON.stringify(pools));
      a.pools.forEach((p, i) => {
        expect(Object.keys(p)).toEqual(Object.keys(pools[i] as RoutePool));
        expect(simShape(p.sim)).toEqual(simShape((pools[i] as RoutePool).sim));
      });
    }
  });

  it('routes to the rows the snapshot wrote, byte for byte, at every size and side', () => {
    const hand = byHand(c);
    let rows = 0;
    for (const [mint, pools] of hand.byAsset)
      for (const side of ['sell', 'buy'] as const)
        for (const n of NOTIONALS) {
          expect(JSON.stringify(routeTrade(asset(full, mint).pools, n, side))).toBe(
            JSON.stringify(routeTrade(pools, n, side)),
          );
          rows++;
        }
    expect(rows).toBe(48);
  });

  it('keeps the same failures in the same order, and the same skips, on a capture with holes', () => {
    // no SOL price, one head the chain did not return, one head cut short, one DLMM pool with no bins read
    const holes: SplitCapture = {
      ...without([GMJG], 'null'),
      solUsd: null,
      children: { ...c.children, [EV4O]: [] },
    };
    holes.accounts[FAE5] = truncated(FAE5);
    const got = buildSplit(holes);
    const hand = byHand(holes);
    // line for line what the old loop pushed (the six stock-to-stock pools are whole here and add none)
    expect(got.failures).toEqual(hand.failures);
    // and what those lines are, in the order of the capture's pools: one per pool, none for the pool with no mid
    const sol = c.direct.filter((p) => p.quoteMint === SOL).length;
    expect(sol).toBe(8);
    expect(got.failures.length).toBe(1 + sol + 1);
    expect(got.failures).toEqual(
      c.direct.flatMap((p) =>
        p.address === GMJG
          ? [`${p.address}: head missing`]
          : p.quoteMint === SOL
            ? [`${p.address}: no USD for quote ${SOL}`]
            : p.address === FAE5
              ? [expect.stringMatching(new RegExp(`^${FAE5}: RangeError`))]
              : [],
      ),
    );
    for (const f of got.failures) {
      const address = f.slice(0, f.indexOf(': '));
      expect(f.length).toBeLessThanOrEqual(address.length + 2 + 80);
    }
    // the DLMM pool with no bins has no mid: skipped without a line, as before
    expect(got.failures.some((f) => f.startsWith(EV4O))).toBe(false);
    // the order is the order of the first pool built, so it moves when a first pool fails
    expect([...got.byAsset].map(([mint, a]) => [mint, a.pools.length])).toEqual([
      [SPYX, 6],
      [AMZNX, 1],
      [QQQX, 3],
    ]);
    expect([...got.byAsset.keys()]).toEqual([...hand.byAsset.keys()]);
    for (const [mint, pools] of hand.byAsset)
      expect(JSON.stringify(asset(got, mint).pools)).toBe(JSON.stringify(pools));
  });

  it('names an asset by the last of its pools built, as the snapshot did', () => {
    const ofQqqx = c.direct.filter((p) => p.assetMint === QQQX);
    const last = ofQqqx[ofQqqx.length - 1] as RegPool;
    const cap: SplitCapture = {
      ...c,
      direct: c.direct.map((p) => (p === last ? { ...p, assetSymbol: 'QQQx renamed' } : p)),
    };
    expect(asset(buildSplit(cap), QQQX).symbol).toBe('QQQx renamed');
    expect(byHand(cap).meta.get(QQQX)?.symbol).toBe('QQQx renamed');
  });
});

describe('buildSplit: the pools that pair two stocks', () => {
  it('offers each pool in both directions: six for QQQx, five for SPYx, one for AMZNx', () => {
    expect(c.twoHopPools.map((p) => p.address)).toEqual([FN27, P7MYF, HIYU, P9YSI, P9U6G, CAXN]);
    // true where the pool is filed under the traded stock, false where the traded stock is its quote side
    expect(twoHopOf(full, QQQX)).toEqual([
      [FN27, true, SPYX],
      [P7MYF, true, SPYX],
      [HIYU, true, SPYX],
      [P9YSI, false, SPYX],
      [P9U6G, true, AMZNX],
      [CAXN, false, SPYX],
    ]);
    expect(twoHopOf(full, SPYX)).toEqual([
      [FN27, false, QQQX],
      [P7MYF, false, QQQX],
      [HIYU, false, QQQX],
      [P9YSI, true, QQQX],
      [CAXN, true, QQQX],
    ]);
    expect(twoHopOf(full, AMZNX)).toEqual([[P9U6G, false, QQQX]]);
    expect(full.notRouted).toEqual([]);
    for (const [mint, a] of full.byAsset)
      for (const t of a.twoHop) {
        const r = row(c, t.pool);
        expect(t.assetIsSimAsset).toBe(r.assetMint === mint);
        expect(t.via).toBe(r.assetMint === mint ? r.quoteMint : r.assetMint);
      }
  });

  it('builds each pool once, as the decoders do by hand, with the fee and the TVL of its row', () => {
    for (const r of c.twoHopPools) {
      const hand = simByHand(c, r, b(c, r.address) as Uint8Array);
      const uses = [...full.byAsset.values()].flatMap((a) =>
        a.twoHop.filter((t) => t.pool === r.address),
      );
      expect(uses.length).toBe(2);
      // one simulator, shared by the two directions
      expect((uses[0] as TwoHopPool).sim).toBe((uses[1] as TwoHopPool).sim);
      for (const t of uses) {
        expect(Object.keys(t)).toEqual([
          'pool',
          'sim',
          'assetIsSimAsset',
          'via',
          'decAsset',
          'decVia',
          'tvlUsd',
          'feeRate',
          'transferFeeBps',
        ]);
        expect(Object.keys(t.transferFeeBps)).toEqual(['asset', 'via']);
        expect(simShape(t.sim)).toEqual(simShape(hand.sim));
        expect(t.feeRate).toBe(hand.feeRate);
        expect(t.tvlUsd).toBe(r.tvlUsd);
      }
    }
  });

  it('takes decimals and transfer fees for the right side of the row, in both directions', () => {
    // the rows of the fixture carry the same numbers on both sides, so two rows are given numbers that differ:
    // FN27 with the stock it is filed under as token 0, 7mYF marked as token 1
    const marked: SplitCapture = {
      ...c,
      twoHopPools: c.twoHopPools.map((p) =>
        p.address === FN27 || p.address === P7MYF
          ? {
              ...p,
              assetIsToken0: p.address === FN27,
              decimals0: 7,
              decimals1: 9,
              transferFeeBps0: 11,
              transferFeeBps1: 22,
            }
          : p,
      ),
    };
    const s = buildSplit(marked);
    const side = (mint: string, pool: string) => {
      const t = asset(s, mint).twoHop.find((x) => x.pool === pool) as TwoHopPool;
      return [t.assetIsSimAsset, t.decAsset, t.decVia, t.transferFeeBps];
    };
    expect(side(QQQX, FN27)).toEqual([true, 7, 9, { asset: 11, via: 22 }]);
    expect(side(SPYX, FN27)).toEqual([false, 9, 7, { asset: 22, via: 11 }]);
    expect(side(QQQX, P7MYF)).toEqual([true, 9, 7, { asset: 22, via: 11 }]);
    expect(side(SPYX, P7MYF)).toEqual([false, 7, 9, { asset: 11, via: 22 }]);
    // and on the fixture as frozen: both sides have the decimals of the row
    for (const a of full.byAsset.values())
      for (const t of a.twoHop) {
        const r = row(c, t.pool);
        expect([t.decAsset, t.decVia].sort()).toEqual([r.decimals0, r.decimals1].sort());
        expect(t.transferFeeBps).toEqual({ asset: 0, via: 0 });
      }
  });

  it('labels each direction the way the pool trades: its mid agrees with the two reference prices', () => {
    let directions = 0;
    for (const a of full.byAsset.values())
      for (const t of a.twoHop) {
        const mid = viaPerAsset(t);
        const expected = refOf(a.pools).midUsd / refOf(asset(full, t.via).pools).midUsd;
        // closer to the ratio of the reference prices than to its inverse
        expect(Math.abs(Math.log(mid / expected))).toBeLessThan(Math.abs(Math.log(mid * expected)));
        // a small sale of the asset pays out the via token, below the mid (the pool keeps its fee)
        const x = 0.01;
        const raw = Math.floor(x * 10 ** t.decAsset);
        const r = t.assetIsSimAsset ? t.sim.sellAsset(raw) : t.sim.buyAsset(raw);
        const y = (r.out / 10 ** t.decVia) * (1 - r.unfilledShare);
        expect(y).toBeGreaterThan(0);
        expect(y / x).toBeLessThan(mid);
        directions++;
      }
    expect(directions).toBe(12);
  });

  it("the second hop is each tracked stock's own pools from the same capture, the same arrays", () => {
    expect(c.tracked.length).toBe(18);
    // in the order of the tracked list
    expect([...full.via.keys()]).toEqual([AMZNX, QQQX, SPYX]);
    expect([...full.via.keys()]).toEqual(c.tracked.filter((m) => full.byAsset.has(m)));
    for (const [mint, pools] of full.via) expect(pools).toBe(asset(full, mint).pools);
    expectOnlyFrom(full, c);
  });
});

describe('buildSplit: a second hop that is not measured in this capture is listed, not routed', () => {
  it('(a) the via token is not tracked: via_not_tracked, and its pools are no second hop', () => {
    const cap: SplitCapture = { ...c, tracked: c.tracked.filter((m) => m !== SPYX) };
    const s = buildSplit(cap);
    expect(s.notRouted).toEqual(
      [FN27, P7MYF, HIYU, P9YSI, CAXN].map((p) => listed(p, QQQX, SPYX, 'via_not_tracked')),
    );
    expect(s.notRouted.map((n) => [n.asset, n.viaSymbol])).toEqual(
      Array.from({ length: 5 }, () => ['QQQx', 'SPYx']),
    );
    expect(twoHopOf(s, QQQX)).toEqual([[P9U6G, true, AMZNX]]);
    expect([...s.via.keys()]).toEqual([AMZNX, QQQX]);
    // the other direction still has a tracked via token with pools: SPYx sold through QQQx
    expect(twoHopOf(s, SPYX)).toEqual(twoHopOf(full, SPYX));
    expect(twoHopOf(s, AMZNX)).toEqual(twoHopOf(full, AMZNX));
    expect(s.failures).toEqual([]);
    // the dollar and SOL pools do not depend on the tracked list
    for (const [mint, a] of full.byAsset)
      expect(JSON.stringify(asset(s, mint).pools)).toBe(JSON.stringify(a.pools));
    expectOnlyFrom(s, cap);
  });

  it("(b) the via token's pools were not read: via_has_no_pool_in_this_run, never a pool from elsewhere", () => {
    const amzn = c.direct.filter((p) => p.assetMint === AMZNX).map((p) => p.address);
    expect(amzn.length).toBe(4);
    for (const as of ['gone', 'null'] as const) {
      const cap = without(amzn, as);
      // the full capture was built first, in this same process: nothing of it may be used here
      const s = buildSplit(cap);
      expect(s.failures).toEqual(amzn.map((p) => `${p}: head missing`));
      expect([...s.byAsset.keys()]).toEqual([SPYX, QQQX]);
      expect([...s.via.keys()]).toEqual([QQQX, SPYX]);
      expect(s.notRouted).toEqual([
        listed(P9U6G, QQQX, AMZNX, 'via_has_no_pool_in_this_run'),
        // and AMZNx itself has no reference price in this capture, so it gets no rows
        listed(P9U6G, AMZNX, QQQX, 'asset_has_no_pool_in_this_run'),
      ]);
      expect(twoHopOf(s, QQQX)).toEqual(twoHopOf(full, QQQX).filter(([, , v]) => v !== AMZNX));
      expect(twoHopOf(s, QQQX).length).toBe(5);
      expect(twoHopOf(s, SPYX)).toEqual(twoHopOf(full, SPYX));
      for (const mint of [SPYX, QQQX])
        expect(JSON.stringify(asset(s, mint).pools)).toBe(JSON.stringify(asset(full, mint).pools));
      expectOnlyFrom(s, cap);
    }
  });

  it('(c) the stock-to-stock pool itself was not read: pool_not_built in both directions, one line', () => {
    for (const as of ['gone', 'null'] as const) {
      const cap = without([P9U6G], as);
      const s = buildSplit(cap);
      expect(s.failures).toEqual([`${P9U6G}: head missing`]);
      expect(s.notRouted).toEqual([
        listed(P9U6G, QQQX, AMZNX, 'pool_not_built'),
        listed(P9U6G, AMZNX, QQQX, 'pool_not_built'),
      ]);
      expect(twoHopOf(s, QQQX).some(([p]) => p === P9U6G)).toBe(false);
      expect(twoHopOf(s, QQQX).length).toBe(5);
      expect(twoHopOf(s, AMZNX)).toEqual([]);
      expect(twoHopOf(s, SPYX)).toEqual(twoHopOf(full, SPYX));
      // AMZNx keeps its own pools and stays a possible second hop for others
      expect([...s.via.keys()]).toEqual([AMZNX, QQQX, SPYX]);
      expectOnlyFrom(s, cap);
    }
  });

  it("a pool account that does not decode is pool_not_built too, with the decoder's words", () => {
    // cut short: the decoder throws, and the line carries its words, cut to 80 characters
    for (const pool of [FN27, P7MYF, P9U6G]) {
      const cap: SplitCapture = { ...c, accounts: { ...c.accounts, [pool]: truncated(pool) } };
      const s = buildSplit(cap);
      expect(s.failures.length).toBe(1);
      expect(s.failures[0]).toMatch(new RegExp(`^${pool}: (Range)?Error`));
      expect((s.failures[0] as string).length).toBeLessThanOrEqual(pool.length + 2 + 80);
      expect(s.notRouted.map((n) => [n.pool, n.reason])).toEqual([
        [pool, 'pool_not_built'],
        [pool, 'pool_not_built'],
      ]);
      for (const a of s.byAsset.values()) expect(a.twoHop.some((t) => t.pool === pool)).toBe(false);
    }
  });

  it('a pool that builds with a mid of 0 is pool_not_built, with no line', () => {
    // a constant-product pool: the snapshot reads no vault for it, so it has no reserves and no mid
    const cpmm: SplitCapture = {
      ...c,
      twoHopPools: c.twoHopPools.map((p) =>
        p.address === P9U6G ? { ...p, venue: 'raydium_cpmm' } : p,
      ),
    };
    // a Meteora pool whose bin arrays were read but are another pair's: no bin of its own, no mid
    const foreign: SplitCapture = {
      ...c,
      children: { ...c.children, [P9U6G]: c.children[P9YSI] as string[] },
    };
    for (const cap of [cpmm, foreign]) {
      // nothing throws on the way: the pool reaches its simulator, and the simulator's mid is 0
      expect(simByHand(cap, row(cap, P9U6G), b(cap, P9U6G) as Uint8Array).sim.midRaw).toBe(0);
      const s = buildSplit(cap);
      expect(s.failures).toEqual([]);
      expect(s.notRouted).toEqual([
        listed(P9U6G, QQQX, AMZNX, 'pool_not_built'),
        listed(P9U6G, AMZNX, QQQX, 'pool_not_built'),
      ]);
      for (const a of s.byAsset.values())
        expect(a.twoHop.some((t) => t.pool === P9U6G)).toBe(false);
      expect(twoHopOf(s, SPYX)).toEqual(twoHopOf(full, SPYX));
    }
  });

  it('a pool read without its tick or bin arrays is pool_read_incomplete, never routed, on each venue', () => {
    // Raydium and Orca would otherwise be simulated as one range with no end, Meteora with no mid
    for (const [pool, from, via] of [
      [FN27, QQQX, SPYX],
      [P7MYF, QQQX, SPYX],
      [P9U6G, QQQX, AMZNX],
    ] as const)
      for (const as of ['none', 'null'] as const) {
        const s = buildSplit(withoutArrays([pool], as));
        expect(s.failures).toEqual([`${pool}: no tick or bin array read`]);
        expect(s.notRouted).toEqual([
          listed(pool, from, via, 'pool_read_incomplete'),
          listed(pool, via, from, 'pool_read_incomplete'),
        ]);
        for (const a of s.byAsset.values())
          expect(a.twoHop.some((t) => t.pool === pool)).toBe(false);
        // the stocks keep their own pools, read whole: they stay a second hop for the other pools
        expect([...s.via.keys()]).toEqual([AMZNX, QQQX, SPYX]);
      }
  });

  it('a pool with one of its arrays missing is incomplete too: it would trade with a hole in its liquidity', () => {
    const missingOne = (pool: string): SplitCapture => ({
      ...c,
      accounts: { ...c.accounts, [(c.children[pool] as string[])[0] as string]: null },
    });
    // the stock-to-stock pool itself: listed, with how many arrays did not come back
    for (const [pool, from, via] of [
      [FN27, QQQX, SPYX],
      [P7MYF, QQQX, SPYX],
      [P9U6G, QQQX, AMZNX],
    ] as const) {
      const n = (c.children[pool] as string[]).length;
      expect(n).toBeGreaterThan(1);
      const s = buildSplit(missingOne(pool));
      expect(s.failures).toEqual([`${pool}: 1 of ${n} tick or bin arrays not read`]);
      expect(s.notRouted).toEqual([
        listed(pool, from, via, 'pool_read_incomplete'),
        listed(pool, via, from, 'pool_read_incomplete'),
      ]);
      for (const a of s.byAsset.values()) expect(a.twoHop.some((t) => t.pool === pool)).toBe(false);
    }
    // a dollar pool of a stock: the stock is no via token, and its own rows keep what split-0.1 did
    const s = buildSplit(missingOne(GMJG));
    expect(s.via.has(QQQX)).toBe(false);
    for (const a of s.byAsset.values()) expect(a.twoHop.filter((t) => t.via === QQQX)).toEqual([]);
    expect(s.notRouted.filter((n) => n.via === QQQX).map((n) => n.reason)).toEqual(
      c.twoHopPools
        .filter((p) => [p.assetMint, p.quoteMint].includes(QQQX))
        .map(() => 'via_pool_read_incomplete'),
    );
    expect(asset(s, QQQX).pools.length).toBe(7);
  });

  it('a Raydium pool read without its fee config is pool_read_incomplete too: it would trade at a fee of 0', () => {
    // FN27's account naming a fee config that was not read; every other pool is whole
    const cap: SplitCapture = {
      ...c,
      accounts: { ...c.accounts, [FN27]: namingAnotherConfig(FN27) },
    };
    const named = decodeClmmPool(b(cap, FN27) as Uint8Array).ammConfig;
    expect(named).not.toBe(feeConfigOf(FN27));
    expect(named in cap.accounts).toBe(false);
    // what the guard keeps out: built by hand, the pool has no fee, where the capture as frozen gives it one
    expect(simByHand(cap, row(cap, FN27), b(cap, FN27) as Uint8Array).feeRate).toBe(0);
    expect(simByHand(c, row(c, FN27), b(c, FN27) as Uint8Array).feeRate).toBeGreaterThan(0);
    const s = buildSplit(cap);
    expect(s.failures).toEqual([`${FN27}: no fee config read`]);
    expect(s.notRouted).toEqual([
      listed(FN27, QQQX, SPYX, 'pool_read_incomplete'),
      listed(FN27, SPYX, QQQX, 'pool_read_incomplete'),
    ]);
    for (const a of s.byAsset.values()) expect(a.twoHop.some((t) => t.pool === FN27)).toBe(false);
    expect(twoHopOf(s, QQQX)).toEqual(twoHopOf(full, QQQX).filter(([p]) => p !== FN27));
    expect(twoHopOf(s, SPYX)).toEqual(twoHopOf(full, SPYX).filter(([p]) => p !== FN27));
    expect([...s.via.keys()]).toEqual([AMZNX, QQQX, SPYX]);
    expectOnlyFrom(s, cap);
    // with no tick array either, the one line names the arrays: they are looked at first
    const both = buildSplit({ ...cap, children: { ...cap.children, [FN27]: [] } });
    expect(both.failures).toEqual([`${FN27}: no tick or bin array read`]);
    expect(both.notRouted.map((n) => [n.pool, n.reason])).toEqual([
      [FN27, 'pool_read_incomplete'],
      [FN27, 'pool_read_incomplete'],
    ]);
  });

  it('an account the chain returned with no data is zero bytes, as the snapshot saw it, not a missing one', () => {
    const empty: SplitCapture = { ...c, accounts: { ...c.accounts, [GMJG]: '' } };
    expect(captureBytes(empty, GMJG)).toEqual(new Uint8Array(0));
    expect(captureBytes({ ...c, accounts: { ...c.accounts, [GMJG]: null } }, GMJG)).toBeUndefined();
    const s = buildSplit(empty);
    // the old script passed the empty bytes to the decoder, which throws: a line with its words, not "head missing"
    expect(s.failures.length).toBe(1);
    expect(s.failures[0]).toMatch(new RegExp(`^${GMJG}: (Range)?Error`));
  });

  it('gives each direction one reason, in a fixed order: the pool, then the via token, then the asset', () => {
    const amzn = c.direct.filter((p) => p.assetMint === AMZNX).map((p) => p.address);
    // AMZNx neither tracked nor read: "not tracked" is said before "no pool"
    const untracked = c.tracked.filter((m) => m !== AMZNX);
    expect(buildSplit({ ...without(amzn), tracked: untracked }).notRouted).toEqual([
      listed(P9U6G, QQQX, AMZNX, 'via_not_tracked'),
      listed(P9U6G, AMZNX, QQQX, 'asset_has_no_pool_in_this_run'),
    ]);
    // and a pool that was not read is said before anything about its two stocks
    const s = buildSplit({ ...without([...amzn, P9U6G]), tracked: [] });
    expect(s.notRouted.filter((n) => n.pool === P9U6G)).toEqual([
      listed(P9U6G, QQQX, AMZNX, 'pool_not_built'),
      listed(P9U6G, AMZNX, QQQX, 'pool_not_built'),
    ]);
  });
});

describe('buildSplit: a stock with a dollar or SOL pool read with a gap is no second hop', () => {
  // the dollar and SOL pools are what the old loop builds on the same capture, gap or not: so are the split-0.1 rows
  const expectOldPools = (s: BuiltSplit, cap: SplitCapture) => {
    const hand = byHand(cap);
    expect([...s.byAsset.keys()]).toEqual([...hand.byAsset.keys()]);
    for (const [m, pools] of hand.byAsset)
      expect(JSON.stringify(asset(s, m).pools)).toBe(JSON.stringify(pools));
    expectOnlyFrom(s, cap);
  };
  // what holds whenever `mint` is refused as a via token: no entry, no pool that trades through it, and every
  // direction through it listed, in the capture's order
  const expectNoSecondHop = (s: BuiltSplit, cap: SplitCapture, mint: string) => {
    expect(s.via.has(mint)).toBe(false);
    for (const a of s.byAsset.values()) expect(a.twoHop.filter((t) => t.via === mint)).toEqual([]);
    expect(s.notRouted.filter((n) => n.via === mint)).toEqual(
      c.twoHopPools
        .filter((p) => [p.assetMint, p.quoteMint].includes(mint))
        .map((p) =>
          listed(
            p.address,
            p.assetMint === mint ? p.quoteMint : p.assetMint,
            mint,
            'via_pool_read_incomplete',
          ),
        ),
    );
    expectOldPools(s, cap);
  };

  it('Raydium, no tick array read: the pool is still built as one range, and its stock is no via token', () => {
    for (const as of ['none', 'null'] as const) {
      const cap = withoutArrays([GMJG], as);
      const s = buildSplit(cap);
      expectNoSecondHop(s, cap, QQQX);
      // no line: the dollar and SOL pools keep the lines the old loop gave them, and it gave none for this
      expect(s.failures).toEqual([]);
      expect(byHand(cap).failures).toEqual([]);
      expect(asset(s, QQQX).pools.map((p) => p.pool)).toContain(GMJG);
      expect(asset(s, QQQX).pools.length).toBe(7);
      expect([...s.via.keys()]).toEqual([AMZNX, SPYX]);
      // five pools pair QQQx with SPYx and one with AMZNx: six directions through QQQx, and nothing else is listed
      expect(s.notRouted.length).toBe(6);
      expect(twoHopOf(s, SPYX)).toEqual([]);
      expect(twoHopOf(s, AMZNX)).toEqual([]);
      // QQQx itself is still traded through the other two, whose pools are whole
      expect(twoHopOf(s, QQQX)).toEqual(twoHopOf(full, QQQX));
    }
  });

  it('Orca, no tick array read: the same', () => {
    for (const as of ['none', 'null'] as const) {
      const cap = withoutArrays([FAE5], as);
      const s = buildSplit(cap);
      expectNoSecondHop(s, cap, SPYX);
      expect(s.failures).toEqual([]);
      expect(byHand(cap).failures).toEqual([]);
      expect(asset(s, SPYX).pools.map((p) => p.pool)).toContain(FAE5);
      expect([...s.via.keys()]).toEqual([AMZNX, QQQX]);
      expect(s.notRouted.length).toBe(5);
      expect(twoHopOf(s, QQQX)).toEqual([[P9U6G, true, AMZNX]]);
      expect(twoHopOf(s, SPYX)).toEqual(twoHopOf(full, SPYX));
      expect(twoHopOf(s, AMZNX)).toEqual(twoHopOf(full, AMZNX));
    }
  });

  it('Raydium, no fee config read: the pool is still built with a fee of 0, and its stock is no via token', () => {
    const config = feeConfigOf(P2GSU);
    expect(poolsOnConfig(config)).toEqual([P2GSU]);
    for (const as of ['gone', 'null'] as const) {
      const cap = without([config], as);
      const s = buildSplit(cap);
      expectNoSecondHop(s, cap, AMZNX);
      expect(s.failures).toEqual([]);
      expect(byHand(cap).failures).toEqual([]);
      const feeOf = (x: BuiltSplit) => asset(x, AMZNX).pools.find((p) => p.pool === P2GSU)?.feeRate;
      expect(feeOf(s)).toBe(0);
      expect(feeOf(full)).toBeGreaterThan(0);
      expect([...s.via.keys()]).toEqual([QQQX, SPYX]);
      expect(s.notRouted.length).toBe(1);
      expect(twoHopOf(s, QQQX)).toEqual(twoHopOf(full, QQQX).filter(([, , v]) => v !== AMZNX));
      // AMZNx itself is still sold through QQQx
      expect(twoHopOf(s, AMZNX)).toEqual(twoHopOf(full, AMZNX));
    }
  });

  it('one fee config not returned takes every pool that names it: the stock-to-stock pool and all three stocks', () => {
    const config = feeConfigOf(FN27);
    const named = poolsOnConfig(config);
    expect(named).toContain(FN27);
    for (const mint of [SPYX, QQQX, AMZNX])
      expect(c.direct.some((p) => p.assetMint === mint && named.includes(p.address))).toBe(true);
    const cap = without([config], 'null');
    const s = buildSplit(cap);
    // one line, for the stock-to-stock pool; the dollar and SOL pools get none, as before
    expect(s.failures).toEqual([`${FN27}: no fee config read`]);
    expect(byHand(cap).failures).toEqual([]);
    expect(s.via.size).toBe(0);
    for (const a of s.byAsset.values()) expect(a.twoHop).toEqual([]);
    // the pool's own reason is said before anything about its two stocks
    expect(s.notRouted.map((n) => [n.pool, n.reason])).toEqual(
      c.twoHopPools.flatMap((p) => {
        const reason = p.address === FN27 ? 'pool_read_incomplete' : 'via_pool_read_incomplete';
        return [
          [p.address, reason],
          [p.address, reason],
        ];
      }),
    );
    expectOldPools(s, cap);
    // which is to say with a fee of 0 on each dollar or SOL pool that names the config
    for (const a of s.byAsset.values())
      for (const p of a.pools) if (named.includes(p.pool)) expect(p.feeRate).toBe(0);
  });

  it('Meteora, no bin array read: the pool has no mid and is not built, so its stock keeps its other pools as a second hop', () => {
    for (const as of ['none', 'null'] as const) {
      const cap = withoutArrays([EV4O], as);
      const s = buildSplit(cap);
      expect(s.failures).toEqual([]);
      expect(s.notRouted).toEqual([]);
      expect([...s.via.keys()]).toEqual([AMZNX, QQQX, SPYX]);
      expect(s.via.get(QQQX)?.map((p) => p.pool)).toEqual(
        c.direct.filter((p) => p.assetMint === QQQX && p.address !== EV4O).map((p) => p.address),
      );
      expect(s.via.get(QQQX)?.length).toBe(6);
      for (const mint of [SPYX, QQQX, AMZNX])
        expect(twoHopOf(s, mint)).toEqual(twoHopOf(full, mint));
      expectOnlyFrom(s, cap);
    }
  });

  it('a via token that is not tracked is said before one read with a gap, and two hops off list nothing', () => {
    const cap = withoutArrays([FAE5], 'none');
    const untracked = buildSplit({ ...cap, tracked: c.tracked.filter((m) => m !== SPYX) });
    expect(untracked.notRouted).toEqual(
      [FN27, P7MYF, HIYU, P9YSI, CAXN].map((p) => listed(p, QQQX, SPYX, 'via_not_tracked')),
    );
    const off = buildSplit({ ...cap, twoHop: false });
    expect(off.notRouted).toEqual([]);
    expect(off.via.size).toBe(0);
    expect(JSON.stringify(asset(off, SPYX).pools)).toBe(
      JSON.stringify(asset(buildSplit(cap), SPYX).pools),
    );
  });
});

describe('buildSplit: two hops off, and the same answer twice', () => {
  it('with two hops off nothing two-hop is built, and the dollar and SOL pools are the same', () => {
    // the flag alone decides, even with the stock-to-stock rows and the tracked list still in the capture
    const off = buildSplit({ ...c, twoHop: false });
    // and as the capture tool writes it with two hops off
    const plain = buildSplit({ ...c, twoHop: false, twoHopPools: [], tracked: [], listed: null });
    for (const s of [off, plain]) {
      expect(s.via.size).toBe(0);
      expect(s.notRouted).toEqual([]);
      expect(s.failures).toEqual([]);
      expect([...s.byAsset.keys()]).toEqual([...full.byAsset.keys()]);
      for (const [mint, a] of s.byAsset) {
        expect(a.twoHop).toEqual([]);
        expect(a.symbol).toBe(asset(full, mint).symbol);
        expect(JSON.stringify(a.pools)).toBe(JSON.stringify(asset(full, mint).pools));
        for (const side of ['sell', 'buy'] as const)
          for (const n of NOTIONALS)
            expect(JSON.stringify(routeTrade(a.pools, n, side))).toBe(
              JSON.stringify(routeTrade(asset(full, mint).pools, n, side)),
            );
      }
    }
  });

  it('two hops on with nothing tracked routes nothing and lists every direction', () => {
    const s = buildSplit({ ...c, tracked: [] });
    expect(s.via.size).toBe(0);
    for (const a of s.byAsset.values()) expect(a.twoHop).toEqual([]);
    expect(s.notRouted.length).toBe(12);
    expect(new Set(s.notRouted.map((n) => n.reason))).toEqual(new Set(['via_not_tracked']));
  });

  it('is deterministic, keeps no state between calls and does not change the capture', () => {
    const before = JSON.stringify(c);
    const first = shape(buildSplit(c));
    buildSplit(without([P9U6G, GMJG]));
    buildSplit({ ...c, twoHop: false });
    expect(shape(buildSplit(c))).toBe(first);
    expect(shape(full)).toBe(first);
    expect(JSON.stringify(c)).toBe(before);
  });
});
