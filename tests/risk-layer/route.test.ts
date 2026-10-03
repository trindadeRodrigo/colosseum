import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  clSim,
  decodeDlmmBinArray,
  decodeDlmmPair,
  decodeWhirlpool,
  decodeWpTickArray,
  dlmmFeeRate,
  dlmmSim,
  type PoolSim,
  type RoutePool,
  routeTrade,
  usdCurves,
  whirlpoolState,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 3 — the router as a pure function. On frozen mainnet pool accounts (fixtures/risk/pools): SPYx
// against USDC on Orca and against SOL on Meteora DLMM. The SOL price is the cross rate of the two pools' own mids,
// so no price enters the test from outside the fixtures. The reference is the collector's own routing code, copied
// verbatim from scripts/risk/collector/pools.ts (`writeRoutedCurves` → `route`), which is not edited before Oct 12.
const load = (f: string) =>
  JSON.parse(gunzipSync(readFileSync(`fixtures/risk/pools/${f}`)).toString()) as {
    pool: string;
    inMint: string;
    accounts: Record<string, string>;
    children: Record<string, string>;
  };
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
// token decimals (mint constants, not prices): xStocks 8, USDC 6, SOL 9
const DEC = { spyx: 8, usdc: 6, sol: 9 };

const orcaFx = load('orca-Fae5dWVntUt6zbWu2voXxioDpMii7SqQwtsxBmoVCsHR.json.gz');
const wh = decodeWhirlpool(b(orcaFx.accounts[orcaFx.pool] as string));
const orcaState = whirlpoolState(
  wh,
  Object.values(orcaFx.children)
    .map((k) => decodeWpTickArray(b(k), wh.tickSpacing))
    .filter((a) => a !== null && a.pool === orcaFx.pool) as NonNullable<
    ReturnType<typeof decodeWpTickArray>
  >[],
);
const orcaSim = clSim(orcaState, wh.mintA === SPYX);
const orcaMid = usdCurves(orcaSim, DEC.spyx, DEC.usdc, 1, [100]).midUsd;

const dlmmFx = load('dlmm-5JWX8pQhJNpFMjPwKhFSSVWRpss4wSyoqgRGnBNJfyuX.json.gz');
const pair = decodeDlmmPair(b(dlmmFx.accounts[dlmmFx.pool] as string));
const dlmmState = {
  activeId: pair.activeId,
  feeRate: dlmmFeeRate(pair),
  bins: Object.values(dlmmFx.children)
    .map((k) => decodeDlmmBinArray(b(k)))
    .filter((a) => a.pair === dlmmFx.pool)
    .flatMap((a) => a.bins),
};
const dlmm = dlmmSim(dlmmState, pair.mintX === SPYX);
// SOL in USD implied by the two frozen pools: (USD per SPYx on Orca) ÷ (SOL per SPYx on the DLMM pool)
const solPerSpyx = usdCurves(dlmm, DEC.spyx, DEC.sol, 1, [100]).midUsd;
const solUsd = orcaMid / solPerSpyx;
const dlmmMid = usdCurves(dlmm, DEC.spyx, DEC.sol, solUsd, [100]).midUsd;

const pools = (tvl: [number, number]): RoutePool[] => [
  {
    pool: orcaFx.pool,
    sim: orcaSim,
    decAsset: DEC.spyx,
    decQuote: DEC.usdc,
    quoteUsd: 1,
    midUsd: orcaMid,
    tvlUsd: tvl[0],
    feeRate: orcaState.feeRate,
    transferFeeBps: { asset: 0, quote: 0 },
  },
  {
    pool: dlmmFx.pool,
    sim: dlmm,
    decAsset: DEC.spyx,
    decQuote: DEC.sol,
    quoteUsd: solUsd,
    midUsd: dlmmMid,
    tvlUsd: tvl[1],
    feeRate: dlmmState.feeRate,
    transferFeeBps: { asset: 0, quote: 0 },
  },
];

// ---- the collector's routing, verbatim (scripts/risk/collector/pools.ts, writeRoutedCurves) ----
type Exit = {
  p: { tvlUsd: number };
  sim: PoolSim;
  decAsset: number;
  decQuote: number;
  quoteUsd: number;
  midUsd: number;
};
const ROUTE_CHUNKS = 32;
function collectorRoute(es: Exit[], n: number, side: 'sell' | 'buy') {
  const ref = [...es].sort((a, b) => b.p.tvlUsd - a.p.tvlUsd)[0] as (typeof es)[number];
  const alloc = es.map(() => 0); // sell: asset UI units per pool; buy: USD per pool
  const outAt = (i: number, x: number) => {
    const e = es[i] as (typeof es)[number];
    if (x <= 0) return 0;
    if (side === 'sell') {
      const r = e.sim.sellAsset(Math.floor(x * 10 ** e.decAsset));
      return (r.out / 10 ** e.decQuote) * e.quoteUsd * (1 - r.unfilledShare);
    }
    const r = e.sim.buyAsset(Math.floor((x / e.quoteUsd) * 10 ** e.decQuote));
    return (r.out / 10 ** e.decAsset) * ref.midUsd * (1 - r.unfilledShare);
  };
  const total = side === 'sell' ? n / ref.midUsd : n;
  const chunk = total / ROUTE_CHUNKS;
  const cur = es.map(() => 0);
  for (let k = 0; k < ROUTE_CHUNKS; k++) {
    let bi = 0;
    let bGain = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < es.length; i++) {
      const g = outAt(i, (alloc[i] as number) + chunk) - (cur[i] as number);
      if (g > bGain) {
        bGain = g;
        bi = i;
      }
    }
    alloc[bi] = (alloc[bi] as number) + chunk;
    cur[bi] = outAt(bi, alloc[bi] as number);
  }
  const outUsd = cur.reduce((t, v) => t + v, 0);
  return {
    notionalUsd: n,
    outUsd,
    costPct: (1 - outUsd / n) * 100,
    poolsUsed: alloc.filter((a) => a > 0).length,
  };
}
// ---- end of the verbatim copy ----

const NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe('routeTrade', () => {
  it('equals the collector routing to 1e-9 on frozen pools, both sides, every grid size, either reference pool', () => {
    let n = 0;
    for (const tvl of [
      [2, 1],
      [1, 2],
    ] as Array<[number, number]>) {
      const ps = pools(tvl);
      const exits: Exit[] = ps.map((p) => ({ ...p, p: { tvlUsd: p.tvlUsd } }));
      for (const side of ['sell', 'buy'] as const)
        for (const size of NOTIONALS) {
          const a = routeTrade(ps, size, side);
          const c = collectorRoute(exits, size, side);
          expect(rel(a.outUsd, c.outUsd), `${side} ${size}`).toBeLessThan(1e-9);
          expect(rel(a.costPct, c.costPct)).toBeLessThan(1e-9);
          expect(a.poolsUsed).toBe(c.poolsUsed);
          n++;
        }
    }
    expect(n).toBe(32);
  });

  it('both pools are used at size, and what each pool returns sums to the total', () => {
    const r = routeTrade(pools([2, 1]), 250_000, 'sell');
    expect(r.poolsUsed).toBe(2);
    expect(r.refPool).toBe(orcaFx.pool);
    expect(
      rel(
        r.legs.reduce((s, l) => s + l.outUsd, 0),
        r.outUsd,
      ),
    ).toBeLessThan(1e-12);
    // every chunk went somewhere: units sent sum to the notional at the reference mid
    expect(
      rel(
        r.legs.reduce((s, l) => s + l.amountIn, 0),
        250_000 / orcaMid,
      ),
    ).toBeLessThan(1e-12);
  });

  it('the four parts of the split sum to the total exactly, every size and side', () => {
    for (const side of ['sell', 'buy'] as const)
      for (const size of NOTIONALS) {
        const s = routeTrade(pools([2, 1]), size, side).split;
        expect(Math.abs(s.poolFee + s.transferFee + s.basis + s.impact - s.total)).toBeLessThan(
          1e-15,
        );
      }
  });

  it('a small sale on one pool costs its fee, plus nearly nothing else; basis is zero on the reference pool alone', () => {
    const r = routeTrade(pools([2, 1]).slice(0, 1), 100, 'sell');
    expect(r.poolsUsed).toBe(1);
    expect(r.split.basis).toBe(0);
    expect(r.split.transferFee).toBe(0);
    expect(rel(r.split.poolFee, orcaState.feeRate)).toBeLessThan(1e-6);
    expect(Math.abs(r.split.impact)).toBeLessThan(r.split.poolFee);
  });

  it('basis is each leg against the reference mid: the formula, with its sign', () => {
    // the cross rate makes both mids equal; price the SOL pool 0.2% richer so its leg sells above the reference
    const richer = 1.002;
    const ps = pools([2, 1]).map((p, i) =>
      i === 1 ? { ...p, quoteUsd: p.quoteUsd * richer, midUsd: p.midUsd * richer } : p,
    );
    const r = routeTrade(ps, 1_000_000, 'sell');
    const expected =
      r.legs.reduce((s, l) => s + l.amountIn * (1 - l.unfilledShare) * (orcaMid - l.midUsd), 0) /
      1_000_000;
    expect(r.legs.length).toBe(2);
    expect(rel(r.split.basis, expected)).toBeLessThan(1e-12);
    // a smaller pool priced better: negative basis, which is why small sales can show a negative cost
    expect(r.split.basis).toBeLessThan(0);
  });

  it('a transfer fee on the quote leg lands in transferFee, not impact', () => {
    const base = pools([2, 1]).slice(0, 1);
    const fee = base.map((p) => ({ ...p, transferFeeBps: { asset: 0, quote: 100 } }));
    // the sim itself does not charge it here: model it by scaling the pool output, as Token-2022 would
    const charged = fee.map((p) => ({
      ...p,
      sim: {
        ...p.sim,
        sellAsset: (a: number) => {
          const r = p.sim.sellAsset(a);
          return { ...r, out: r.out * 0.99 };
        },
      },
    }));
    const a = routeTrade(base, 10_000, 'sell').split;
    const c = routeTrade(charged, 10_000, 'sell').split;
    expect(rel(c.total - a.total, c.transferFee)).toBeLessThan(1e-9);
    expect(rel(c.impact, a.impact)).toBeLessThan(1e-6);
  });
});
