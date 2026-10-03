import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createDb, riskPools } from '@colosseum/db';
import {
  clmmState,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeDlmmBinArray,
  decodeDlmmPair,
  decodeWhirlpool,
  decodeWpTickArray,
  swapExactIn,
  whirlpoolState,
} from '@colosseum/risk';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clDistribution,
  clSegments,
  clTokenBetween,
  type Distribution,
  distributionFromBytes,
  dlmmDistribution,
  type PoolRow,
} from '../pool-liquidity';
import {
  type ChainReader,
  poolLiquidityService,
  registerPoolLiquidityRoute,
} from './risk-pool-liquidity';

// GET /risk/pools/:address/liquidity, on the frozen mainnet pools of fixtures/risk/pools (head + tick/bin arrays,
// 2026-10-01). Decimals and orientation as in risk_pools: the xStock is token0 (8 decimals), USDC 6, SOL 9.
type Fx = {
  pool: string;
  inMint: string;
  accounts: Record<string, string>;
  children: Record<string, string>;
};
const load = (f: string) =>
  JSON.parse(gunzipSync(readFileSync(`fixtures/risk/pools/${f}`)).toString()) as Fx;
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const RAY = load('raydium-GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG.json.gz');
const ORCA = load('orca-Fae5dWVntUt6zbWu2voXxioDpMii7SqQwtsxBmoVCsHR.json.gz');
const DLMM = load('dlmm-5JWX8pQhJNpFMjPwKhFSSVWRpss4wSyoqgRGnBNJfyuX.json.gz');
const CPMM = load('cpmm-7sY6BrhDBkJdcYFrDd1M49hinSXrqk2bzS3rT6Juanch.json.gz');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const row = (fx: Fx, venue: string, decimals1: number): PoolRow => ({
  address: fx.pool,
  venue,
  assetMint: fx.inMint,
  decimals0: 8,
  decimals1,
  assetIsToken0: 1,
});

const rayState = () => {
  const h = decodeClmmPool(b(RAY.accounts[RAY.pool] as string));
  const arrays = Object.values(RAY.children)
    .map((x) => decodeClmmTickArray(b(x)))
    .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === RAY.pool);
  return { h, s: clmmState(h, 0, arrays) };
};
const near = (a: number, x: number, rel = 1e-9) =>
  expect(Math.abs(a - x)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(x)));
const sideSums = (d: Distribution) => ({
  asset: d.bands.filter((x) => x.side === 'asset').reduce((s, x) => s + x.amount, 0),
  quote: d.bands.filter((x) => x.side === 'quote').reduce((s, x) => s + x.amount, 0),
});

describe('pool liquidity: pure functions', () => {
  it('CL token amounts agree with the swap simulator walking the same ticks (fee 0), both directions', () => {
    const { s } = rayState();
    const segs = clSegments(s);
    const sc = s.sqrtPrice;
    for (const k of [1.05, 1.3]) {
      // up: token1 paid in, token0 out
      const up = sc * Math.sqrt(k);
      const in1 = clTokenBetween(segs, sc, up, 1);
      const out0 = swapExactIn({ ...s, feeRate: 0 }, in1, false).amountOut;
      near(out0, clTokenBetween(segs, sc, up, 0), 1e-6);
      // down: token0 paid in, token1 out
      const down = sc / Math.sqrt(k);
      const in0 = clTokenBetween(segs, down, sc, 0);
      const out1 = swapExactIn({ ...s, feeRate: 0 }, in0, true).amountOut;
      near(out1, clTokenBetween(segs, down, sc, 1), 1e-6);
    }
  });

  it('band sums do not depend on the band count, and equal the decoded state over the same range', () => {
    const { s } = rayState();
    const o = { assetIs0: true, decAsset: 8, decQuote: 6, quoteUsd: 1, rangePct: 0.3 };
    const one = clDistribution(s, { ...o, bands: 2 });
    for (const n of [7, 60, 199]) {
      const d = clDistribution(s, { ...o, bands: n });
      near(sideSums(d).asset, sideSums(one).asset);
      near(sideSums(d).quote, sideSums(one).quote);
      near(d.totalAssetUsd as number, d.totalAsset * d.midPrice);
    }
    const segs = clSegments(s);
    const sc = s.sqrtPrice;
    // over mid × (1 ± 0.3): asset = token0 above, quote = token1 below, in UI units
    const up = Math.sqrt(one.midPrice * 1.3 * 10 ** (6 - 8));
    const down = Math.sqrt(one.midPrice * 0.7 * 10 ** (6 - 8));
    near(one.totalAsset, clTokenBetween(segs, sc, up, 0) / 1e8);
    near(one.totalQuote, clTokenBetween(segs, down, sc, 1) / 1e6);
    expect(one.totalAsset).toBeGreaterThan(0);
    expect(one.totalQuote).toBeGreaterThan(0);
  });

  it('assigns sides around the current price; the band holding the price is split at it', () => {
    for (const [fx, venue] of [
      [RAY, 'raydium_clmm'],
      [ORCA, 'orca_whirlpool'],
    ] as const) {
      const d = distributionFromBytes(
        row(fx, venue, 6),
        b(fx.accounts[fx.pool] as string),
        Object.values(fx.children).map(b),
        { quoteUsd: 1, bands: 9, rangePct: 0.3 },
      ) as Distribution;
      expect(d.bands).toHaveLength(10); // 9 bands, the middle one split at the price
      for (const x of d.bands) {
        if (x.side === 'asset') expect(x.priceLow).toBeGreaterThanOrEqual(d.midPrice);
        else expect(x.priceHigh).toBeLessThanOrEqual(d.midPrice);
        expect(x.priceHigh).toBeGreaterThan(x.priceLow);
        expect(x.amount).toBeGreaterThanOrEqual(0);
      }
      expect(d.bands.filter((x) => x.priceLow === d.midPrice)).toHaveLength(1);
      expect(d.bands.filter((x) => x.priceHigh === d.midPrice)).toHaveLength(1);
      // the bands touching the price hold liquidity on both sides
      expect(d.bands.find((x) => x.priceLow === d.midPrice)?.amount).toBeGreaterThan(0);
      expect(d.bands.find((x) => x.priceHigh === d.midPrice)?.amount).toBeGreaterThan(0);
    }
    // orca's mid is the whirlpool head's price
    const h = decodeWhirlpool(b(ORCA.accounts[ORCA.pool] as string));
    const arrays = Object.values(ORCA.children)
      .map((x) => decodeWpTickArray(b(x), h.tickSpacing))
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === ORCA.pool);
    const d = clDistribution(whirlpoolState(h, arrays), {
      assetIs0: true,
      decAsset: 8,
      decQuote: 6,
      quoteUsd: 1,
      bands: 60,
      rangePct: 0.3,
    });
    near(d.midPrice, (Number(h.sqrtPriceX64) / 2 ** 64) ** 2 * 100);
    expect(d.bands).toHaveLength(60); // even: the price is an edge
  });

  it('DLMM: band sums equal the bins in range, by side, from the bins’ own amounts', () => {
    const h = decodeDlmmPair(b(DLMM.accounts[DLMM.pool] as string));
    const bins = Object.values(DLMM.children)
      .map((x) => decodeDlmmBinArray(b(x)))
      .filter((a) => a.pair === DLMM.pool)
      .flatMap((a) => a.bins);
    const assetIsX = h.mintX === DLMM.inMint;
    expect(assetIsX).toBe(true);
    for (const rangePct of [0.1, 0.3, 0.9]) {
      const d = dlmmDistribution(h, bins, {
        assetIsX,
        decAsset: 8,
        decQuote: 9,
        quoteUsd: null,
        bands: 60,
        rangePct,
      });
      const ui = (p: number) => p * 10 ** (8 - 9);
      const [lo, hi] = [d.midPrice * (1 - rangePct), d.midPrice * (1 + rangePct)];
      const inRange = (p: number) => p >= lo * (1 - 1e-12) && p <= hi * (1 + 1e-12);
      // bins above the price hold X (the asset), below hold Y; the active bin both
      const asset = bins
        .filter((x) => x.id >= h.activeId && inRange(Math.max(ui(x.price), d.midPrice)))
        .reduce((s, x) => s + x.amountX / 1e8, 0);
      const quote = bins
        .filter((x) => x.id <= h.activeId && inRange(Math.min(ui(x.price), d.midPrice)))
        .reduce((s, x) => s + x.amountY / 1e9, 0);
      near(d.totalAsset, asset);
      near(d.totalQuote, quote);
      expect(d.totalAssetUsd).toBeNull();
      expect(d.bands.every((x) => x.amountUsd === null && x.liquidity === null)).toBe(true);
      // no X below the active bin, no Y above it: nothing was clamped across the price
      expect(bins.filter((x) => x.id < h.activeId && x.amountX > 0)).toEqual([]);
      expect(bins.filter((x) => x.id > h.activeId && x.amountY > 0)).toEqual([]);
    }
  });
});

// The route and its cache, with recorded bytes in place of the RPC.
function fakeReader(fx: Fx, solUsd: number | null = null) {
  const calls = { accounts: 0, children: 0, sol: 0 };
  const bytes = new Map(
    Object.entries({ ...fx.accounts, ...fx.children }).map(([k, v]) => [k, b(v)]),
  );
  let first = true;
  const reader: ChainReader = {
    async accounts(keys) {
      calls.accounts++;
      const data = new Map<string, Uint8Array>();
      for (const k of keys) if (bytes.has(k)) data.set(k, bytes.get(k) as Uint8Array);
      return { slot: 123, data };
    },
    async children() {
      calls.children++;
      // every child once, on the first offset asked
      const out = first ? Object.keys(fx.children) : [];
      first = false;
      return out;
    },
    async solUsd() {
      calls.sol++;
      return solUsd === null ? null : { usd: solUsd, source: 'fixture' };
    },
  };
  return { reader, calls };
}

describe('pool liquidity: cache', () => {
  it('keeps each answer 60 s and the child list longer; a failed read is not kept', async () => {
    const { reader, calls } = fakeReader(ORCA);
    let t = 1_000_000;
    const svc = poolLiquidityService(reader, () => t);
    const p = { ...row(ORCA, 'orca_whirlpool', 6), program: 'x', quoteMint: USDC };
    const a = await svc.get(p, 60, 0.3);
    await svc.get(p, 60, 0.3);
    expect(calls).toMatchObject({ accounts: 1, children: 2 }); // two offsets for a whirlpool
    t += 61_000;
    const c = await svc.get(p, 60, 0.3);
    expect(calls).toMatchObject({ accounts: 2, children: 2 });
    expect(c.distribution?.totalAsset).toBe(a.distribution?.totalAsset);
    const failing = poolLiquidityService(
      {
        ...reader,
        accounts: async () => {
          throw new Error('the Solana RPC did not answer getMultipleAccounts');
        },
      },
      () => t,
    );
    await expect(failing.get(p, 60, 0.3)).rejects.toThrow('did not answer');
    await expect(failing.get(p, 60, 0.3)).rejects.toThrow('did not answer');
  });
});

const { db, client } = createDb();
const seeded: string[] = [];
const pools = [
  [ORCA, 'orca_whirlpool', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', USDC, 'USDC', 6],
  [DLMM, 'meteora_dlmm', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', SOL, 'SOL', 9],
  [CPMM, 'raydium_cpmm', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', CPMM.inMint, null, 6],
] as const;

beforeAll(async () => {
  // the registry rows of the frozen pools; rows already present (a collected database) are left as they are
  for (const [fx, venue, program, quoteMint, quoteSymbol, decimals1] of pools) {
    const r = await db
      .insert(riskPools)
      .values({
        address: fx.pool,
        program,
        venue,
        assetMint: fx.inMint,
        assetSymbol: 'SPYx',
        quoteMint,
        quoteSymbol,
        exitPath: 'other',
        assetIsToken0: 1,
        decimals0: 8,
        decimals1,
        tier: 'X',
        status: 'fixture',
        methodVersion: 'fixture',
        source: 'fixture rows',
        method: 'fixture',
        fetchedAt: new Date(),
        provenance: 'fixture',
      })
      .onConflictDoNothing()
      .returning({ a: riskPools.address });
    seeded.push(...r.map((x) => x.a));
  }
});
afterAll(async () => {
  for (const a of seeded) await db.delete(riskPools).where(eq(riskPools.address, a));
  await client.end();
});

async function appWith(reader: ChainReader) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerPoolLiquidityRoute(app, db, reader);
  return app;
}

describe('GET /risk/pools/:address/liquidity', () => {
  it('a whirlpool: 60 bands, totals equal the bands, USDC at par', async () => {
    const { reader } = fakeReader(ORCA);
    const app = await appWith(reader);
    const res = await app.inject({ url: `/risk/pools/${ORCA.pool}/liquidity` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      pool: ORCA.pool,
      venue: 'orca_whirlpool',
      priceUnit: 'quote per asset',
      distribution: 'bands',
      reason: null,
      slot: 123,
      quoteUsd: 1,
      quoteUsdSource: 'stable_par',
      provenance: 'live',
      methodVersion: 'pool-liquidity-0.1',
    });
    expect(body.bands).toHaveLength(60);
    const sum = (side: string) =>
      body.bands
        .filter((x: { side: string }) => x.side === side)
        .reduce((s: number, x: { amountUsd: number }) => s + x.amountUsd, 0);
    near(body.totalAssetUsd, sum('asset'));
    near(body.totalQuoteUsd, sum('quote'));
    expect(body.disclaimer).toBeTruthy();
    await app.close();
  });

  it('a DLMM SOL pool is priced with the SOL price it was given; without one, USD is null with its reason', async () => {
    const priced = await appWith(fakeReader(DLMM, 150).reader);
    const a = (await priced.inject({ url: `/risk/pools/${DLMM.pool}/liquidity?bands=20` })).json();
    expect(a).toMatchObject({ quoteUsd: 150, quoteUsdSource: 'fixture', usdNullReason: null });
    near(a.totalQuoteUsd, a.totalQuote * 150);
    await priced.close();
    const bare = await appWith(fakeReader(DLMM, null).reader);
    const c = (await bare.inject({ url: `/risk/pools/${DLMM.pool}/liquidity?bands=20` })).json();
    expect(c).toMatchObject({
      quoteUsd: null,
      totalAssetUsd: null,
      usdNullReason: 'no_quote_price',
    });
    expect(c.totalAsset).toBeGreaterThan(0);
    await bare.close();
  });

  it('a constant-product pool is not_applicable with no RPC read; unknown pool 404; no RPC is 503 without a URL', async () => {
    const { reader, calls } = fakeReader(CPMM);
    const app = await appWith(reader);
    const c = (await app.inject({ url: `/risk/pools/${CPMM.pool}/liquidity` })).json();
    expect(c).toMatchObject({ distribution: null, reason: 'not_applicable', bands: null });
    expect(calls).toEqual({ accounts: 0, children: 0, sol: 0 });
    expect((await app.inject({ url: '/risk/pools/FIXTUREnope/liquidity' })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/risk/pools/${ORCA.pool}/liquidity?bands=1` })).statusCode,
    ).toBe(400);
    await app.close();
    const noRpc = await appWith({
      ...reader,
      children: async () => {
        throw new Error('SOLANA_RPC_URL is not set (see .env.example)');
      },
    });
    const r = await noRpc.inject({ url: `/risk/pools/${ORCA.pool}/liquidity` });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/no Solana RPC configured/);
    expect(r.json().error).not.toMatch(/:\/\//);
    await noRpc.close();
  });
});

describe('pool liquidity: DA3 gate', () => {
  it('refuses the getProgramAccounts scan before Mon Oct 5 00:00 ET and allows it from then', async () => {
    const { assertScanAllowed, DA3_SCANS_FROM } = await import('./risk-pool-liquidity');
    expect(() => assertScanAllowed(Date.parse('2026-10-03T03:00:00Z'))).toThrow(/^gate DA3/);
    expect(() => assertScanAllowed(DA3_SCANS_FROM - 1)).toThrow(/^gate DA3/);
    expect(() => assertScanAllowed(DA3_SCANS_FROM)).not.toThrow();
  });
});
