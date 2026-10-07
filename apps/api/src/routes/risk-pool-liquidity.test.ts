import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createDb, type Db, riskAssetSnapshots, riskPools } from '@colosseum/db';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  hourOfFile,
  RECORDED_ARRAYS_SOURCE,
  RECORDED_SOURCE,
  type RecordedStore,
  readRecorded,
  recordedDir,
  recordedDirs,
  recordedIndex,
  recordedStore,
} from '../pool-recorded';
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

  it('reads the RPC once per pool in 60 s whatever bands and range are asked, and answers each from that read', async () => {
    const { reader, calls } = fakeReader(ORCA);
    const t = 1_000_000;
    const svc = poolLiquidityService(reader, () => t);
    const p = { ...row(ORCA, 'orca_whirlpool', 6), program: 'x', quoteMint: USDC };
    const answers = [];
    for (let i = 0; i < 50; i++) answers.push(await svc.get(p, 2 + i, 0.3 + i * 1e-9));
    expect(calls).toMatchObject({ accounts: 1, children: 2 });
    expect(answers[10]?.distribution?.bands.length).not.toBe(
      answers[20]?.distribution?.bands.length,
    );
    expect(answers[49]?.slot).toBe(answers[0]?.slot);
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

// The collector's recordings, written in its own format into a temporary folder; the default is an empty folder, so
// no test reads this machine's recordings.
const RAW = mkdtempSync(join(tmpdir(), 'pool-recorded-'));
const EMPTY = mkdtempSync(join(tmpdir(), 'pool-recorded-empty-'));
function record(fx: Fx, venue: string, at: string, slot: number) {
  const dir = join(RAW, at.slice(0, 10), at.slice(11, 13));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${fx.pool}.json.gz`),
    gzipSync(
      JSON.stringify({
        pool: fx.pool,
        venue,
        slot,
        fetchedAt: at,
        head: fx.accounts[fx.pool],
        children: fx.children,
      }),
    ),
  );
}
afterAll(() => {
  rmSync(RAW, { recursive: true, force: true });
  rmSync(EMPTY, { recursive: true, force: true });
});

// the history window is counted back from this clock: Sep 5, before the collectors' first reference price (Oct 1)
const NOW = Date.parse('2026-09-05T00:00:00.000Z');
async function appWith(reader: ChainReader, raw: string = EMPTY) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerPoolLiquidityRoute(app, db, reader, recordedStore(raw), () => NOW);
  return app;
}
const gated = (fx: Fx) => ({
  ...fakeReader(fx).reader,
  children: async (): Promise<string[]> => {
    throw new Error(
      'gate DA3: getProgramAccounts scans start Mon Oct 5 (00:00 ET); this pool’s tick arrays cannot be listed before then',
    );
  },
});

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

describe('pool liquidity: the collector’s recordings', () => {
  it('a recording reads back to the same bytes; the index lists each pool’s files oldest first', () => {
    record(ORCA, 'orca_whirlpool', '2026-09-02T10:02:00.000Z', 10);
    record(ORCA, 'orca_whirlpool', '2026-09-02T11:02:00.000Z', 11);
    const files = recordedIndex(RAW).get(ORCA.pool) ?? [];
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/2026-09-02[/\\]10[/\\]/);
    const r = readRecorded(files[1] as string);
    expect(r).toMatchObject({ pool: ORCA.pool, slot: 11, fetchedAt: '2026-09-02T11:02:00.000Z' });
    expect(r?.kids).toHaveLength(Object.keys(ORCA.children).length);
    expect(Buffer.from(r?.head ?? []).toString('base64')).toBe(ORCA.accounts[ORCA.pool]);
  });

  it('gated live read: auto falls back to the newest recording with the live answer’s bands; live is 503; recorded alone needs a recording', async () => {
    record(ORCA, 'orca_whirlpool', '2026-09-02T10:02:00.000Z', 10);
    record(ORCA, 'orca_whirlpool', '2026-09-02T11:02:00.000Z', 11);
    const live = await appWith(fakeReader(ORCA).reader);
    const l = (await live.inject({ url: `/risk/pools/${ORCA.pool}/liquidity` })).json();
    await live.close();
    const app = await appWith(gated(ORCA), RAW);
    const a = (await app.inject({ url: `/risk/pools/${ORCA.pool}/liquidity` })).json();
    expect(a).toMatchObject({
      basis: 'recorded',
      fetchedAt: '2026-09-02T11:02:00.000Z',
      slot: 11,
      quoteUsd: 1,
      quoteUsdSource: 'stable_par',
      distribution: 'bands',
    });
    expect(l.basis).toBe('live');
    near(a.totalAssetUsd, l.totalAssetUsd);
    near(a.totalQuoteUsd, l.totalQuoteUsd);
    expect(a.bands).toHaveLength(l.bands.length);
    expect(a.source).toMatch(/hourly raw recording/);
    const strict = await app.inject({ url: `/risk/pools/${ORCA.pool}/liquidity?basis=live` });
    expect(strict.statusCode).toBe(503);
    expect(strict.json().error).toMatch(/^gate DA3/);
    await app.close();
    const none = await appWith(gated(ORCA));
    expect((await none.inject({ url: `/risk/pools/${ORCA.pool}/liquidity` })).statusCode).toBe(503);
    expect(
      (await none.inject({ url: `/risk/pools/${ORCA.pool}/liquidity?basis=recorded` })).statusCode,
    ).toBe(404);
    await none.close();
  });

  it('history: one point per recording, value = asset side + quote side; no SOL reference is no_quote_price, never 0; no recording is not_collected', async () => {
    record(ORCA, 'orca_whirlpool', '2026-09-02T10:02:00.000Z', 10);
    record(ORCA, 'orca_whirlpool', '2026-09-02T11:02:00.000Z', 11);
    // before the collectors' first reference price (2026-10-01): a SOL quote has no USD price at that hour
    record(DLMM, 'meteora_dlmm', '2026-09-03T11:05:00.000Z', 12);
    const app = await appWith(gated(ORCA), RAW);
    const h = (
      await app.inject({ url: `/risk/pools/${ORCA.pool}/liquidity/history?hours=744` })
    ).json();
    expect(h).toMatchObject({
      resolution: 'hour',
      from: '2026-09-02T10:02:00.000Z',
      to: '2026-09-02T11:02:00.000Z',
      reason: null,
    });
    expect(h.points).toHaveLength(2);
    for (const p of h.points) {
      expect(p.valueUsd).toBeGreaterThan(0);
      near(p.valueUsd, p.assetUsd + p.quoteSideUsd);
      expect(p.quoteUsd).toBe(1);
    }
    const d = (
      await app.inject({ url: `/risk/pools/${DLMM.pool}/liquidity/history?hours=744` })
    ).json();
    expect(d.points).toHaveLength(1);
    expect(d.points[0]).toMatchObject({
      valueUsd: null,
      assetUsd: null,
      usdNullReason: 'no_quote_price',
    });
    expect(d.points[0].midPrice).toBeGreaterThan(0);
    const c = (await app.inject({ url: `/risk/pools/${CPMM.pool}/liquidity/history` })).json();
    expect(c).toMatchObject({ points: [], reason: 'not_applicable' });
    await app.close();
    const empty = await appWith(gated(ORCA));
    expect(
      (await empty.inject({ url: `/risk/pools/${ORCA.pool}/liquidity/history` })).json(),
    ).toMatchObject({ points: [], reason: 'not_collected' });
    expect(
      (await empty.inject({ url: '/risk/pools/FIXTUREnope/liquidity/history' })).statusCode,
    ).toBe(404);
    await empty.close();
  });

  it('the recorded list: registry pools only, with hours and the first and last hour', async () => {
    record(ORCA, 'orca_whirlpool', '2026-09-02T10:02:00.000Z', 10);
    record(ORCA, 'orca_whirlpool', '2026-09-02T11:02:00.000Z', 11);
    writeFileSync(join(RAW, '2026-09-02', '11', 'NOTAREGISTRYPOOL.json.gz'), gzipSync('{}'));
    const app = await appWith(gated(ORCA), RAW);
    const r = (await app.inject({ url: '/risk/pools/recorded' })).json();
    const o = r.pools.find((x: { address: string }) => x.address === ORCA.pool);
    expect(o).toMatchObject({
      venue: 'orca_whirlpool',
      hours: 2,
      from: '2026-09-02T10:00:00.000Z',
      to: '2026-09-02T11:00:00.000Z',
    });
    expect(r.pools.some((x: { address: string }) => x.address === 'NOTAREGISTRYPOOL')).toBe(false);
    await app.close();
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

// RU.12: the raw-arrays job records, in the collector's file format and into a folder of its own, the
// concentrated-liquidity pools of the tracked stocks that the collector does not. The reader takes both folders, the
// collector's first. Every test below writes into folders of its own, so none sees another's recordings.
const made: string[] = [];
const folder = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `pool-recorded-${name}-`));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** The keys the job writes after the collector's seven. The reader passes over them. */
const JOB_KEYS = {
  slotHead: 7,
  childrenListedAt: '2026-09-02T10:07:00.000Z',
  source: 'fixture',
  method: 'fixture',
  methodVersion: 'raw-arrays-0.1',
  provenance: 'live',
};
function recordInto(
  dir: string,
  fx: Fx,
  venue: string,
  at: string,
  slot: number,
  by: 'collector' | 'raw-arrays' = 'collector',
  children: Record<string, string> = fx.children,
) {
  const d = join(dir, at.slice(0, 10), at.slice(11, 13));
  mkdirSync(d, { recursive: true });
  const file = join(d, `${fx.pool}.json.gz`);
  writeFileSync(
    file,
    gzipSync(
      JSON.stringify({
        pool: fx.pool,
        venue,
        slot,
        fetchedAt: at,
        head: fx.accounts[fx.pool],
        children,
        config: null,
        ...(by === 'raw-arrays' ? JOB_KEYS : {}),
      }),
    ),
  );
  return file;
}
const orcaAt = (dir: string, at: string, slot: number, by?: 'collector' | 'raw-arrays') =>
  recordInto(dir, ORCA, 'orca_whirlpool', `${at}:00.000Z`, slot, by);
/** Day and hour of each file, as `DDTHH`. */
const hoursOf = (files: string[] = []) => files.map((f) => hourOfFile(f)?.slice(8, 13));
/** The hours a store reads a pool's recordings from, as `DDTHH`: what its index holds of the pool, oldest first. */
const hoursRead = (store: RecordedStore, pool: string = ORCA.pool) =>
  [...store.since(pool, 0)].map((r) => r.fetchedAt.slice(8, 13));
/**
 * What the store's list of pools must say, made the long way: from every path of the index, as the list was made
 * at each call before the store kept it. `dirs` is the list of folders, the collector's first.
 */
const listTheLongWay = (dirs: string[], index = recordedIndex(dirs)) =>
  [...index].map(([pool, files]) => ({
    pool,
    hours: files.length,
    from: hourOfFile(files[0] as string),
    to: hourOfFile(files[files.length - 1] as string),
    ofArrays: files.filter((f) => !f.startsWith(dirs[0] as string)).length,
  }));
const BOTH_SOURCES = `${RECORDED_SOURCE}; ${RECORDED_ARRAYS_SOURCE}`;

describe('pool recordings: two folders, the collector’s and the raw-arrays job’s', () => {
  it('the folders: the collector’s first, each from its own setting, with the collector’s unchanged', () => {
    try {
      vi.stubEnv('RISK_RAW_DIR', '/x/raw');
      vi.stubEnv('RISK_RAW_ARRAYS_DIR', '/y/raw-arrays');
      expect(recordedDirs()).toEqual(['/x/raw', '/y/raw-arrays']);
      expect(recordedDir()).toBe('/x/raw');
      vi.stubEnv('RISK_RAW_DIR', undefined);
      vi.stubEnv('RISK_RAW_ARRAYS_DIR', undefined);
      // RISK_HOME is the job's setting, not this API's
      vi.stubEnv('RISK_HOME', '/z');
      const home = join(homedir(), '.colosseum', 'risk');
      expect(recordedDirs()).toEqual([join(home, 'raw'), join(home, 'raw-arrays')]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a file of the job reads as a collector file does: its own keys are passed over, an empty child is skipped', () => {
    const [C, A] = [folder('read-collector'), folder('read-arrays')];
    const c = readRecorded(orcaAt(C, '2026-09-02T11:02', 11));
    const a = readRecorded(orcaAt(A, '2026-09-02T11:02', 11, 'raw-arrays'), 'raw-arrays');
    expect(c).toMatchObject({
      pool: ORCA.pool,
      slot: 11,
      by: 'collector',
      source: RECORDED_SOURCE,
    });
    expect(a).toMatchObject({ slot: 11, by: 'raw-arrays', source: RECORDED_ARRAYS_SOURCE });
    expect({ ...a, by: null, source: null }).toEqual({ ...c, by: null, source: null });
    expect(Buffer.from(a?.head ?? []).toString('base64')).toBe(ORCA.accounts[ORCA.pool]);
    expect(RECORDED_SOURCE).toBe(
      'pool collector hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array), decoded by packages/risk/src/pools',
    );
    // an array the chain did not return is written as "", by the job as by the collector
    const keys = Object.keys(ORCA.children);
    const holed = { ...ORCA.children, [keys[1] as string]: '' };
    const h = readRecorded(
      recordInto(A, ORCA, 'orca_whirlpool', '2026-09-02T12:25:00.000Z', 12, 'raw-arrays', holed),
      'raw-arrays',
    );
    expect(h?.kids).toHaveLength(keys.length - 1);
    expect(h?.kids.every((k) => k.length > 0)).toBe(true);
  });

  it('the index of two folders: the first wins a pool’s hour, an hour only the second has is kept, oldest first across both', () => {
    const [C, A] = [folder('index-collector'), folder('index-arrays')];
    orcaAt(C, '2026-09-02T10:02', 1);
    orcaAt(C, '2026-09-02T12:02', 1);
    orcaAt(C, '2026-09-03T09:02', 1);
    orcaAt(A, '2026-09-01T23:25', 1, 'raw-arrays');
    orcaAt(A, '2026-09-02T11:25', 1, 'raw-arrays');
    orcaAt(A, '2026-09-02T12:25', 1, 'raw-arrays');
    orcaAt(A, '2026-09-03T10:25', 1, 'raw-arrays');
    recordInto(A, DLMM, 'meteora_dlmm', '2026-09-02T11:25:00.000Z', 1, 'raw-arrays');
    // the job's run log at the top of its folder, and a file it has not finished writing
    writeFileSync(join(A, 'runs.jsonl'), '{}\n');
    writeFileSync(join(A, '2026-09-02', '11', `${ORCA.pool}.json.gz.tmp`), 'half');
    const files = recordedIndex([C, A]).get(ORCA.pool) ?? [];
    expect(hoursOf(files)).toEqual(['01T23', '02T10', '02T11', '02T12', '03T09', '03T10']);
    expect(files.map((f) => (f.startsWith(C) ? 'collector' : 'raw-arrays'))).toEqual([
      'raw-arrays',
      'collector',
      'raw-arrays',
      'collector',
      'collector',
      'raw-arrays',
    ]);
    expect(recordedIndex([C, A]).get(DLMM.pool)).toHaveLength(1);
    expect([...recordedIndex([C, A]).keys()].sort()).toEqual([DLMM.pool, ORCA.pool].sort());
    // the order of the list is the precedence
    const swapped = recordedIndex([A, C]).get(ORCA.pool) ?? [];
    expect(hoursOf(swapped)).toEqual(hoursOf(files));
    expect(swapped[3]?.startsWith(A)).toBe(true);
    // one folder, as a string or a list of one; a folder that is not there holds nothing
    expect(hoursOf(recordedIndex(C).get(ORCA.pool))).toEqual(['02T10', '02T12', '03T09']);
    expect(recordedIndex([C])).toEqual(recordedIndex(C));
    expect(recordedIndex([C, join(A, 'none')])).toEqual(recordedIndex(C));
    expect(recordedIndex([join(A, 'none'), C])).toEqual(recordedIndex(C));
  });

  it('the store says which job wrote each recording, and counts the job’s files per pool', () => {
    const [C, A] = [folder('store-collector'), folder('store-arrays')];
    orcaAt(C, '2026-09-02T10:02', 10);
    orcaAt(C, '2026-09-02T12:02', 12);
    orcaAt(A, '2026-09-02T11:25', 11, 'raw-arrays');
    orcaAt(A, '2026-09-02T12:25', 99, 'raw-arrays');
    orcaAt(A, '2026-09-02T13:25', 13, 'raw-arrays');
    orcaAt(A, '2026-09-01T23:25', 9, 'raw-arrays');
    const store = recordedStore([C, A]);
    expect(store.latest(ORCA.pool)).toMatchObject({
      slot: 13,
      by: 'raw-arrays',
      source: RECORDED_ARRAYS_SOURCE,
    });
    const all = [...store.since(ORCA.pool, 0)];
    expect(all.map((r) => r.slot)).toEqual([9, 10, 11, 12, 13]);
    expect(all.map((r) => r.by)).toEqual([
      'raw-arrays',
      'collector',
      'raw-arrays',
      'collector',
      'raw-arrays',
    ]);
    expect(all[3]).toMatchObject({
      fetchedAt: '2026-09-02T12:02:00.000Z',
      source: RECORDED_SOURCE,
    });
    // the hour both folders hold is one hour, the collector's
    expect(store.pools()).toEqual([
      {
        pool: ORCA.pool,
        hours: 5,
        from: '2026-09-01T23:00:00.000Z',
        to: '2026-09-02T13:00:00.000Z',
        ofArrays: 3,
      },
    ]);
    expect(store.pools()).toEqual(listTheLongWay([C, A]));
    // one folder is the collector's
    const alone = recordedStore(C);
    expect(alone.latest(ORCA.pool)).toMatchObject({ slot: 12, by: 'collector' });
    expect(alone.pools()[0]).toMatchObject({ hours: 2, ofArrays: 0 });
    // the pools come in the order the folders list them, the first folder's first, not the oldest hour's first
    recordInto(A, DLMM, 'meteora_dlmm', '2026-09-01T22:25:00.000Z', 8, 'raw-arrays');
    expect([...recordedIndex([C, A]).keys()]).toEqual([ORCA.pool, DLMM.pool]);
    expect(
      recordedStore([C, A])
        .pools()
        .map((x) => x.pool),
    ).toEqual([ORCA.pool, DLMM.pool]);
    expect([...recordedIndex([A, C]).keys()]).toEqual([DLMM.pool, ORCA.pool]);
  });

  it('a day folder before yesterday is listed once and kept; yesterday’s and today’s are listed again at each refresh, at most once a minute', () => {
    const [C, A] = [folder('settled-collector'), folder('settled-arrays')];
    let t = Date.parse('2026-09-10T12:30:00.000Z');
    orcaAt(C, '2026-09-08T10:02', 1);
    orcaAt(A, '2026-09-08T11:25', 1, 'raw-arrays');
    orcaAt(C, '2026-09-09T23:02', 1);
    orcaAt(C, '2026-09-10T11:02', 1);
    const store = recordedStore([C, A], () => t);
    const hours = (s = store) => hoursRead(s);
    const first = ['08T10', '08T11', '09T23', '10T11'];
    expect(hours()).toEqual(first);
    // one more file into each: the day before yesterday, yesterday, today
    orcaAt(C, '2026-09-08T12:02', 1);
    orcaAt(A, '2026-09-09T22:25', 1, 'raw-arrays');
    orcaAt(A, '2026-09-10T12:25', 1, 'raw-arrays');
    t += 60_000;
    expect(hours()).toEqual(first);
    t += 1;
    // Sep 8 was not listed again, in either folder: its new file is not seen, and what was listed is still there
    expect(hours()).toEqual(['08T10', '08T11', '09T22', '09T23', '10T11', '10T12']);
    // the file is there: a store that has not listed the day yet sees it
    const fresh = recordedStore([C, A], () => t);
    expect(hours(fresh)).toEqual(['08T10', '08T11', '08T12', '09T22', '09T23', '10T11', '10T12']);
    // two days on, Sep 10 is before yesterday: listed that once more, then kept
    t += 2 * 86_400_000;
    orcaAt(C, '2026-09-10T13:02', 13);
    expect(hours()).toEqual(['08T10', '08T11', '09T22', '09T23', '10T11', '10T12', '10T13']);
    orcaAt(C, '2026-09-10T14:02', 14);
    t += 60_001;
    expect(hours()).toEqual(['08T10', '08T11', '09T22', '09T23', '10T11', '10T12', '10T13']);
    expect(store.latest(ORCA.pool)).toMatchObject({ slot: 13, by: 'collector' });
  });

  it('one bad entry does not stop the index: a file named like a day, or like an hour inside a day, is left out, in either folder, and everything else answers', async () => {
    // the bad entries in the collector's folder, then in the job's
    for (const bad of [0, 1]) {
      const [C, A] = [folder(`bad-${bad}-collector`), folder(`bad-${bad}-arrays`)];
      orcaAt(C, '2026-09-02T10:02', 10);
      orcaAt(A, '2026-09-02T12:25', 12, 'raw-arrays');
      recordInto(A, DLMM, 'meteora_dlmm', '2026-09-02T12:25:00.000Z', 22, 'raw-arrays');
      const dir = [C, A][bad] as string;
      writeFileSync(join(dir, '2026-10-01'), 'a file, not a day folder');
      writeFileSync(join(dir, '2026-09-02', '11'), 'a file, not an hour folder');
      expect(hoursOf(recordedIndex([C, A]).get(ORCA.pool))).toEqual(['02T10', '02T12']);
      expect(hoursOf(recordedIndex(dir).get(ORCA.pool))).toEqual([bad ? '02T12' : '02T10']);
      const store = recordedStore([C, A]);
      expect(store.pools().map((x) => [x.pool, x.hours, x.ofArrays])).toEqual([
        [ORCA.pool, 2, 1],
        [DLMM.pool, 1, 1],
      ]);
      expect(store.latest(ORCA.pool)).toMatchObject({ slot: 12, by: 'raw-arrays' });
      expect(store.latest(DLMM.pool)).toMatchObject({ slot: 22, by: 'raw-arrays' });
      expect([...store.since(ORCA.pool, 0)].map((r) => r.slot)).toEqual([10, 12]);
      // and over HTTP: both folders' pools answer
      const app = await appOf(gated(ORCA), [C, A]);
      const url = `/risk/pools/${ORCA.pool}/liquidity`;
      const a = await app.inject({ url: `${url}?basis=recorded` });
      expect(a.statusCode).toBe(200);
      expect(a.json()).toMatchObject({ slot: 12, source: RECORDED_ARRAYS_SOURCE });
      const h = await app.inject({ url: `${url}/history?hours=744` });
      expect(h.statusCode).toBe(200);
      expect(h.json().points.map((p: { slot: number }) => p.slot)).toEqual([10, 12]);
      const list = await app.inject({ url: '/risk/pools/recorded' });
      expect(list.statusCode).toBe(200);
      type Listed = { address: string; hours: number };
      expect(
        Object.fromEntries(list.json().pools.map((x: Listed) => [x.address, x.hours])),
      ).toEqual({ [ORCA.pool]: 2, [DLMM.pool]: 1 });
      await app.close();
    }
    // a folder of the list that is itself a file holds nothing, and the other folder still answers
    const [C, F] = [folder('bad-top-collector'), join(folder('bad-top'), 'raw-arrays')];
    orcaAt(C, '2026-09-02T10:02', 10);
    writeFileSync(F, 'a file, not a folder');
    expect(recordedIndex([C, F])).toEqual(recordedIndex(C));
    expect(recordedIndex([F, C])).toEqual(recordedIndex(C));
    expect(recordedIndex(F).size).toBe(0);
    expect(recordedStore([F, C]).latest(ORCA.pool)).toMatchObject({ slot: 10 });
    expect(recordedStore([C, F]).latest(ORCA.pool)).toMatchObject({ slot: 10, by: 'collector' });
  });

  it('a day before yesterday that could not be listed whole is not kept: it is listed again until it is whole, then kept', () => {
    const C = folder('unsettled');
    let t = Date.parse('2026-09-10T12:30:00.000Z');
    orcaAt(C, '2026-09-02T10:02', 10);
    orcaAt(C, '2026-09-02T12:02', 12);
    writeFileSync(join(C, '2026-09-02', '11'), 'a file, not an hour folder');
    const store = recordedStore(C, () => t);
    const hours = () => hoursRead(store);
    expect(hours()).toEqual(['02T10', '02T12']);
    // the entry is put right: the day is listed again at the next refresh, although it is before yesterday
    rmSync(join(C, '2026-09-02', '11'));
    orcaAt(C, '2026-09-02T11:02', 11);
    t += 60_001;
    expect(hours()).toEqual(['02T10', '02T11', '02T12']);
    // now it was listed whole, so it is kept as any day before yesterday is
    orcaAt(C, '2026-09-02T13:02', 13);
    t += 60_001;
    expect(hours()).toEqual(['02T10', '02T11', '02T12']);
    expect(store.latest(ORCA.pool)).toMatchObject({ slot: 12 });
  });

  it('the index keeps a pointer a recording, not a path: 31 days of 259 pools by 24 hours grow the heap by under 4 MB', () => {
    // 192,696 recordings. Each hour folder is a link to one folder of 259 empty files, so the test makes a thousand
    // entries, not two hundred thousand (23 s to write, when measured); a linked folder is listed as any other.
    const [C, one] = [folder('heap'), folder('heap-one-hour')];
    for (let i = 0; i < 259; i++)
      writeFileSync(join(one, `${String(i).padStart(3, '0')}${ORCA.pool.slice(3)}.json.gz`), '');
    for (let d = 1; d <= 31; d++) {
      const day = join(C, `2026-08-${String(d).padStart(2, '0')}`);
      mkdirSync(day);
      for (let h = 0; h < 24; h++) symlinkSync(one, join(day, String(h).padStart(2, '0')));
    }
    // A full collection before each reading, so that what is read is what is kept and not what waits to be
    // collected. vitest does not run with --expose-gc: the flag is set for the one context `gc` is taken from.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    v8.setFlagsFromString('--no-expose-gc');
    const heap = () => {
      gc();
      gc();
      return v8.getHeapStatistics().used_heap_size;
    };
    let t = Date.parse('2026-09-05T00:00:00.000Z');
    const before = heap();
    const store = recordedStore(C, () => t);
    expect(store.latest('none')).toBeNull(); // lists every folder
    const listed = heap() - before;
    t += 60_001;
    expect(store.latest('none')).toBeNull(); // a refresh
    const refreshed = heap() - before;
    // Measured here: 1.9 MB, about 10 bytes a recording (a pointer to the pool's one name, and the hour folders).
    // With a path kept per recording, as it was, this reads 179 MB; with a path made beside each name, or with the
    // names not shared between hours, 22 MB.
    expect(listed).toBeLessThan(4e6);
    expect(refreshed).toBeLessThan(4e6);
    // the index is all there: every pool with its 744 hours
    const pools = store.pools();
    expect(pools).toHaveLength(259);
    expect(pools.every((x) => x.hours === 31 * 24 && x.ofArrays === 0)).toBe(true);
    const last = pools[258] as (typeof pools)[number];
    expect(last).toMatchObject({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:00:00.000Z',
    });
    // The list of pools is 259 small objects kept with the index, made once: a hundred calls give that one list, so
    // nothing of the 192,696 recordings is gone through again, and holding them all holds nothing more.
    const held = Array.from({ length: 100 }, () => store.pools());
    expect(held.every((x) => x === pools)).toBe(true);
    expect(heap() - before).toBeLessThan(4e6);
    // a path is made when it is asked for, and the list says what every path of the index says
    const index = recordedIndex(C);
    const files = index.get(last.pool) ?? [];
    expect(files[0]).toBe(join(C, '2026-08-01', '00', `${last.pool}.json.gz`));
    expect(files[743]).toBe(join(C, '2026-08-31', '23', `${last.pool}.json.gz`));
    expect(pools).toEqual(listTheLongWay([C], index));
  });

  it('the list of pools is made once for each refresh of the index and kept: every call until the next is given that one list, with no path in it and no folder listed again', () => {
    const [C, A] = [folder('kept-collector'), folder('kept-arrays')];
    let t = Date.parse('2026-09-10T12:30:00.000Z');
    // a day before yesterday, yesterday and today; the job's folder is the older in its first hour
    recordInto(A, DLMM, 'meteora_dlmm', '2026-09-07T22:25:00.000Z', 1, 'raw-arrays');
    orcaAt(A, '2026-09-07T23:25', 1, 'raw-arrays');
    orcaAt(C, '2026-09-09T10:02', 1);
    orcaAt(A, '2026-09-09T10:25', 1, 'raw-arrays');
    orcaAt(A, '2026-09-10T11:25', 1, 'raw-arrays');
    const store = recordedStore([C, A], () => t);
    const first = store.pools();
    // the collector's pool first although the job's folder holds the older hour; the hour both hold counted once
    expect(first).toEqual([
      {
        pool: ORCA.pool,
        hours: 3,
        from: '2026-09-07T23:00:00.000Z',
        to: '2026-09-10T11:00:00.000Z',
        ofArrays: 2,
      },
      {
        pool: DLMM.pool,
        hours: 1,
        from: '2026-09-07T22:00:00.000Z',
        to: '2026-09-07T22:00:00.000Z',
        ofArrays: 1,
      },
    ]);
    expect(first).toEqual(listTheLongWay([C, A]));
    // no path, and nothing of a path: neither a file's name nor a folder's
    expect(JSON.stringify(first)).not.toMatch(/json\.gz|pool-recorded-/);
    // Within the minute a new hour in today's folder is not seen: no folder is listed again. And each call is given
    // the list itself, not one made again: were it made at each call, from the index or from its paths, each call
    // would be given another. This is what fails if the list goes back to work that grows with the recordings.
    orcaAt(C, '2026-09-10T12:02', 1);
    recordInto(C, DLMM, 'meteora_dlmm', '2026-09-10T12:05:00.000Z', 1);
    t += 60_000;
    for (let i = 0; i < 1000; i++) expect(store.pools()).toBe(first);
    // reading recordings between two calls does not make it again either
    expect(store.latest(ORCA.pool)).toMatchObject({ by: 'raw-arrays' });
    expect(hoursRead(store)).toEqual(['07T23', '09T10', '10T11']);
    expect(store.pools()).toBe(first);
    expect(first[0]).toMatchObject({ hours: 3, to: '2026-09-10T11:00:00.000Z' });
    // After the minute the index is listed again, whichever call asks first, and the list is made again from it,
    // once: the new hour is in it for both pools, and the list given before is as it was.
    t += 1;
    expect(store.latest(ORCA.pool)).toMatchObject({ by: 'collector' });
    const second = store.pools();
    expect(second).not.toBe(first);
    expect(second).toEqual([
      { ...first[0], hours: 4, to: '2026-09-10T12:00:00.000Z' },
      { ...first[1], hours: 2, to: '2026-09-10T12:00:00.000Z' },
    ]);
    expect(second).toEqual(listTheLongWay([C, A]));
    for (let i = 0; i < 1000; i++) expect(store.pools()).toBe(second);
    expect(first[0]).toMatchObject({ hours: 3, to: '2026-09-10T11:00:00.000Z' });
  });

  it('the order of the list is the order the folders list the pools in, whichever hour a pool is first met in: a pool the first folder holds comes before every pool only the second holds', () => {
    // three made-up pools, empty files: the list is of the files the folders list, and opens none
    const [C, A] = [folder('order-collector'), folder('order-arrays')];
    const put = (dir: string, at: string, pools: string[]) => {
      const d = join(dir, at.slice(0, 10), at.slice(11, 13));
      mkdirSync(d, { recursive: true });
      for (const p of pools) writeFileSync(join(d, `${p}.json.gz`), '');
    };
    // ONE is met first in the job's folder, hours before the collector's; TWO only ever in the job's, and first of
    // all; THREE in the collector's oldest hour
    put(A, '2026-09-01T05', ['TWO']);
    put(A, '2026-09-01T06', ['ONE', 'TWO']);
    put(C, '2026-09-01T07', ['THREE']);
    put(C, '2026-09-01T09', ['ONE']);
    put(A, '2026-09-01T09', ['ONE', 'THREE']);
    const order = (dirs: string[]) =>
      recordedStore(dirs)
        .pools()
        .map((x) => x.pool);
    expect(order([C, A])).toEqual(['THREE', 'ONE', 'TWO']);
    expect(order([C, A])).toEqual([...recordedIndex([C, A]).keys()]);
    expect(recordedStore([C, A]).pools()).toEqual(listTheLongWay([C, A]));
    expect(recordedStore([C, A]).pools()).toEqual([
      {
        pool: 'THREE',
        hours: 2,
        from: '2026-09-01T07:00:00.000Z',
        to: '2026-09-01T09:00:00.000Z',
        ofArrays: 1,
      },
      {
        pool: 'ONE',
        hours: 2,
        from: '2026-09-01T06:00:00.000Z',
        to: '2026-09-01T09:00:00.000Z',
        ofArrays: 1,
      },
      {
        pool: 'TWO',
        hours: 2,
        from: '2026-09-01T05:00:00.000Z',
        to: '2026-09-01T06:00:00.000Z',
        ofArrays: 2,
      },
    ]);
    // the order of the folders is the precedence, in the list as in the index
    expect(order([A, C])).toEqual([...recordedIndex([A, C]).keys()]);
    expect(recordedStore([A, C]).pools()).toEqual(listTheLongWay([A, C]));
  });
});

async function appOf(reader: ChainReader, dirs: string[], database: Db = db) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerPoolLiquidityRoute(app, database, reader, recordedStore(dirs), () => NOW);
  return app;
}
/** Runs `body` on rows that exist only inside a transaction, then rolls it back. */
async function withRows(body: (tx: Db) => Promise<void>) {
  class Undo extends Error {}
  try {
    await db.transaction(async (tx) => {
      await body(tx as unknown as Db);
      throw new Undo();
    });
  } catch (e) {
    if (!(e instanceof Undo)) throw e;
  }
}

describe('the liquidity routes on two folders', () => {
  it('a pool only the job records answers basis=recorded, and the gated auto read, with the job’s source', async () => {
    const [C, A] = [folder('only-collector'), folder('only-arrays')];
    orcaAt(A, '2026-09-02T11:25', 31, 'raw-arrays');
    orcaAt(C, '2026-09-02T11:25', 31);
    const app = await appOf(gated(ORCA), [EMPTY, A]);
    const url = `/risk/pools/${ORCA.pool}/liquidity`;
    const res = await app.inject({ url: `${url}?basis=recorded` });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a).toMatchObject({
      basis: 'recorded',
      fetchedAt: '2026-09-02T11:25:00.000Z',
      slot: 31,
      distribution: 'bands',
      quoteUsd: 1,
      quoteUsdSource: 'stable_par',
      usdNullReason: null,
      source: RECORDED_ARRAYS_SOURCE,
      provenance: 'live',
    });
    expect(a.bands).toHaveLength(60);
    expect(a.totalAssetUsd).toBeGreaterThan(0);
    expect((await app.inject({ url })).json()).toEqual(a);
    const strict = await app.inject({ url: `${url}?basis=live` });
    expect(strict.statusCode).toBe(503);
    await app.close();
    // the same bytes in the collector's folder: the same answer but for whose recording it is
    const collector = await appOf(gated(ORCA), [C, EMPTY]);
    const c = (await collector.inject({ url: `${url}?basis=recorded` })).json();
    await collector.close();
    expect(c.source).toBe(RECORDED_SOURCE);
    expect(c.method).not.toMatch(/raw-arrays/);
    expect({ ...a, source: null }).toEqual({ ...c, source: null });
  });

  it('the history and the recorded list name the job or jobs whose recordings they hold, and no other: a pool only the job records does not name the collector', async () => {
    const [C, A] = [folder('whose-collector'), folder('whose-arrays')];
    orcaAt(A, '2026-09-02T11:25', 11, 'raw-arrays');
    orcaAt(A, '2026-09-02T12:25', 12, 'raw-arrays');
    const url = `/risk/pools/${ORCA.pool}/liquidity/history`;
    const slots = (h: { points: Array<{ slot: number }> }) => h.points.map((p) => p.slot);
    const job = await appOf(gated(ORCA), [C, A]);
    const h = (await job.inject({ url: `${url}?hours=744` })).json();
    expect(slots(h)).toEqual([11, 12]);
    expect(h.source).toBe(RECORDED_ARRAYS_SOURCE);
    const list = (await job.inject({ url: '/risk/pools/recorded' })).json();
    expect(list.pools).toMatchObject([{ address: ORCA.pool, hours: 2 }]);
    expect(list.source).toBe(RECORDED_ARRAYS_SOURCE);
    // a window with no point in it names the collector, as an answer with no recording always did
    const none = (await job.inject({ url: `${url}?hours=6` })).json();
    expect(none).toMatchObject({ points: [], reason: 'not_collected', source: RECORDED_SOURCE });
    await job.close();
    // one hour of the collector's beside them: both are named, in the history and in the list
    orcaAt(C, '2026-09-02T13:02', 13);
    const both = await appOf(gated(ORCA), [C, A]);
    const hb = (await both.inject({ url: `${url}?hours=744` })).json();
    expect(slots(hb)).toEqual([11, 12, 13]);
    expect(hb.source).toBe(BOTH_SOURCES);
    expect((await both.inject({ url: '/risk/pools/recorded' })).json().source).toBe(BOTH_SOURCES);
    await both.close();
    // the collector's folder alone: the collector alone; a list of no pool names it too
    const collector = await appOf(gated(ORCA), [C, EMPTY]);
    const hc = (await collector.inject({ url: `${url}?hours=744` })).json();
    expect(slots(hc)).toEqual([13]);
    expect(hc.source).toBe(RECORDED_SOURCE);
    expect((await collector.inject({ url: '/risk/pools/recorded' })).json().source).toBe(
      RECORDED_SOURCE,
    );
    await collector.close();
    const nothing = await appOf(gated(ORCA), [EMPTY, join(EMPTY, 'none')]);
    expect((await nothing.inject({ url: '/risk/pools/recorded' })).json()).toMatchObject({
      pools: [],
      source: RECORDED_SOURCE,
    });
    await nothing.close();
  });

  it('the same pool and hour in both folders is read from the collector’s', async () => {
    const [C, A] = [folder('same-collector'), folder('same-arrays')];
    orcaAt(C, '2026-09-02T11:02', 41);
    orcaAt(A, '2026-09-02T11:25', 42, 'raw-arrays');
    const app = await appOf(gated(ORCA), [C, A]);
    const url = `/risk/pools/${ORCA.pool}/liquidity`;
    for (const u of [`${url}?basis=recorded`, url])
      expect((await app.inject({ url: u })).json()).toMatchObject({
        basis: 'recorded',
        fetchedAt: '2026-09-02T11:02:00.000Z',
        slot: 41,
        source: RECORDED_SOURCE,
      });
    const h = (await app.inject({ url: `${url}/history?hours=744` })).json();
    expect(h.points.map((p: { slot: number }) => p.slot)).toEqual([41]);
    expect(h.source).toBe(RECORDED_SOURCE);
    const list = (await app.inject({ url: '/risk/pools/recorded' })).json();
    expect(list.pools).toMatchObject([{ address: ORCA.pool, hours: 1 }]);
    expect(list.source).toBe(RECORDED_SOURCE);
    await app.close();
  });

  it('an hour is not lost to one file that does not read: it is read from the next folder that holds the pool in that hour, and the recording says whose it is', async () => {
    const [C, A] = [folder('half-collector'), folder('half-arrays')];
    orcaAt(C, '2026-09-02T10:02', 40);
    const ofCollector = orcaAt(C, '2026-09-02T11:02', 41);
    const ofJob = orcaAt(A, '2026-09-02T11:25', 42, 'raw-arrays');
    const whole = { collector: readFileSync(ofCollector), job: readFileSync(ofJob) };
    const half = (b: Buffer) => b.subarray(0, b.length >> 1);
    const slots = (s: RecordedStore) => [...s.since(ORCA.pool, 0)].map((r) => [r.slot, r.by]);
    // The collector writes a file with one plain write, so a reader can find it half written. The newest recording
    // was then the hour before's and the history had no point for the hour, although the job's file of it reads.
    writeFileSync(ofCollector, half(whole.collector));
    expect(readRecorded(ofCollector)).toBeNull();
    const store = recordedStore([C, A]);
    expect(store.latest(ORCA.pool)).toMatchObject({
      slot: 42,
      fetchedAt: '2026-09-02T11:25:00.000Z',
      by: 'raw-arrays',
      source: RECORDED_ARRAYS_SOURCE,
    });
    const all = [...store.since(ORCA.pool, 0)];
    expect(all.map((r) => [r.slot, r.by, r.source])).toEqual([
      [40, 'collector', RECORDED_SOURCE],
      [42, 'raw-arrays', RECORDED_ARRAYS_SOURCE],
    ]);
    // The same store, a moment later, when the collector's write has ended: its file is the one read. A file that
    // did not read is not kept as unreadable, or the job's would answer for the hour as long as the pool is asked.
    writeFileSync(ofCollector, whole.collector);
    expect(store.latest(ORCA.pool)).toMatchObject({ slot: 41, by: 'collector' });
    writeFileSync(ofCollector, half(whole.collector));
    // the routes answer from the job's file and say so
    const app = await appOf(gated(ORCA), [C, A]);
    const url = `/risk/pools/${ORCA.pool}/liquidity`;
    for (const u of [`${url}?basis=recorded`, url])
      expect((await app.inject({ url: u })).json()).toMatchObject({
        basis: 'recorded',
        fetchedAt: '2026-09-02T11:25:00.000Z',
        slot: 42,
        distribution: 'bands',
        source: RECORDED_ARRAYS_SOURCE,
      });
    const h = (await app.inject({ url: `${url}/history?hours=744` })).json();
    expect(h.points.map((p: { slot: number }) => p.slot)).toEqual([40, 42]);
    expect(h.source).toBe(BOTH_SOURCES);
    // the recorded list is of the files the folders hold and opens none: the hour is one hour, the first folder's
    const list = (await app.inject({ url: '/risk/pools/recorded' })).json();
    expect(list.pools).toMatchObject([{ address: ORCA.pool, hours: 2 }]);
    expect(list.source).toBe(RECORDED_SOURCE);
    await app.close();
    // a file with nothing in it yet is passed over the same way
    writeFileSync(ofCollector, '');
    expect(recordedStore([C, A]).latest(ORCA.pool)).toMatchObject({ slot: 42, by: 'raw-arrays' });
    expect(slots(recordedStore([C, A]))).toEqual([
      [40, 'collector'],
      [42, 'raw-arrays'],
    ]);
    // neither file of the hour reads: the hour has no recording, and the newest is the hour before's
    writeFileSync(ofJob, half(whole.job));
    expect(recordedStore([C, A]).latest(ORCA.pool)).toMatchObject({ slot: 40, by: 'collector' });
    expect(slots(recordedStore([C, A]))).toEqual([[40, 'collector']]);
    // the collector's reads again: it is the one read, whether the job's reads or not
    writeFileSync(ofCollector, whole.collector);
    expect(recordedStore([C, A]).latest(ORCA.pool)).toMatchObject({ slot: 41, by: 'collector' });
    writeFileSync(ofJob, whole.job);
    const both = recordedStore([C, A]);
    expect(both.latest(ORCA.pool)).toMatchObject({ slot: 41, source: RECORDED_SOURCE });
    expect(slots(both)).toEqual([
      [40, 'collector'],
      [41, 'collector'],
    ]);
    // and the order of the folders is still the precedence: with the job's folder first, its file is the one read
    expect(recordedStore([A, C]).latest(ORCA.pool)).toMatchObject({ slot: 42 });
  });

  it('a pool with different hours in each folder has one history, oldest first, and names both sources', async () => {
    const [C, A] = [folder('merged-collector'), folder('merged-arrays')];
    orcaAt(C, '2026-09-02T10:02', 10);
    orcaAt(C, '2026-09-02T12:02', 12);
    orcaAt(A, '2026-09-02T11:25', 11, 'raw-arrays');
    orcaAt(A, '2026-09-02T12:25', 99, 'raw-arrays');
    orcaAt(A, '2026-09-02T13:25', 13, 'raw-arrays');
    orcaAt(A, '2026-09-01T23:25', 9, 'raw-arrays');
    const app = await appOf(gated(ORCA), [C, A]);
    const url = `/risk/pools/${ORCA.pool}/liquidity`;
    const h = (await app.inject({ url: `${url}/history?hours=744` })).json();
    expect(h.points.map((p: { t: string }) => p.t)).toEqual([
      '2026-09-01T23:25:00.000Z',
      '2026-09-02T10:02:00.000Z',
      '2026-09-02T11:25:00.000Z',
      '2026-09-02T12:02:00.000Z',
      '2026-09-02T13:25:00.000Z',
    ]);
    expect(h.points.map((p: { slot: number }) => p.slot)).toEqual([9, 10, 11, 12, 13]);
    expect(h).toMatchObject({
      from: '2026-09-01T23:25:00.000Z',
      to: '2026-09-02T13:25:00.000Z',
      reason: null,
      source: BOTH_SOURCES,
    });
    for (const p of h.points) {
      expect(p.valueUsd).toBeGreaterThan(0);
      near(p.valueUsd, p.assetUsd + p.quoteSideUsd);
      expect(p).toMatchObject({ quoteUsd: 1, usdNullReason: null });
    }
    // the newest recording is the job's
    expect((await app.inject({ url: `${url}?basis=recorded` })).json()).toMatchObject({
      slot: 13,
      source: RECORDED_ARRAYS_SOURCE,
    });
    await app.close();
    // a window whose points are all the collector's names the collector alone, whatever the pool's other hours
    orcaAt(C, '2026-09-04T20:02', 20);
    const later = await appOf(gated(ORCA), [C, A]);
    const w = (await later.inject({ url: `${url}/history?hours=6` })).json();
    expect(w.points.map((p: { slot: number }) => p.slot)).toEqual([20]);
    expect(w.source).toBe(RECORDED_SOURCE);
    expect(w.method).not.toMatch(/raw-arrays/);
    const all = (await later.inject({ url: `${url}/history?hours=744` })).json();
    expect(all.points.map((p: { slot: number }) => p.slot)).toEqual([9, 10, 11, 12, 13, 20]);
    expect(all.source).toBe(BOTH_SOURCES);
    await later.close();
  });

  it('/risk/pools/recorded lists the pools of both folders', async () => {
    const [C, A] = [folder('list-collector'), folder('list-arrays')];
    orcaAt(C, '2026-09-02T10:02', 10);
    orcaAt(C, '2026-09-02T11:02', 11);
    recordInto(A, DLMM, 'meteora_dlmm', '2026-09-03T11:25:00.000Z', 12, 'raw-arrays');
    writeFileSync(join(A, '2026-09-03', '11', 'NOTAREGISTRYPOOL.json.gz'), gzipSync('{}'));
    const app = await appOf(gated(ORCA), [C, A]);
    const r = (await app.inject({ url: '/risk/pools/recorded' })).json();
    expect(r.pools.map((x: { address: string }) => x.address).sort()).toEqual(
      [ORCA.pool, DLMM.pool].sort(),
    );
    expect(r.pools.find((x: { address: string }) => x.address === ORCA.pool)).toMatchObject({
      venue: 'orca_whirlpool',
      hours: 2,
      from: '2026-09-02T10:00:00.000Z',
      to: '2026-09-02T11:00:00.000Z',
    });
    expect(r.pools.find((x: { address: string }) => x.address === DLMM.pool)).toMatchObject({
      venue: 'meteora_dlmm',
      hours: 1,
      from: '2026-09-03T11:00:00.000Z',
      to: '2026-09-03T11:00:00.000Z',
    });
    expect(r.source).toBe(BOTH_SOURCES);
    await app.close();
    // the job's files of a pool the registry does not hold do not make the list name the job
    const [C2, A2] = [folder('list-collector-2'), folder('list-arrays-2')];
    orcaAt(C2, '2026-09-02T10:02', 10);
    mkdirSync(join(A2, '2026-09-03', '11'), { recursive: true });
    writeFileSync(join(A2, '2026-09-03', '11', 'NOTAREGISTRYPOOL.json.gz'), gzipSync('{}'));
    const other = await appOf(gated(ORCA), [C2, A2]);
    const o = (await other.inject({ url: '/risk/pools/recorded' })).json();
    expect(o.pools.map((x: { address: string }) => x.address)).toEqual([ORCA.pool]);
    expect(o.source).toBe(RECORDED_SOURCE);
    await other.close();
    // and the collector's files of a pool the registry does not hold do not make the list name the collector
    const [C3, A3] = [folder('list-collector-3'), folder('list-arrays-3')];
    mkdirSync(join(C3, '2026-09-03', '11'), { recursive: true });
    writeFileSync(join(C3, '2026-09-03', '11', 'NOTAREGISTRYPOOL.json.gz'), gzipSync('{}'));
    recordInto(A3, DLMM, 'meteora_dlmm', '2026-09-03T11:25:00.000Z', 12, 'raw-arrays');
    const third = await appOf(gated(ORCA), [C3, A3]);
    const j = (await third.inject({ url: '/risk/pools/recorded' })).json();
    expect(j.pools.map((x: { address: string }) => x.address)).toEqual([DLMM.pool]);
    expect(j.source).toBe(RECORDED_ARRAYS_SOURCE);
    await third.close();
  });

  it('with nothing in the second folder every answer is the one-folder answer, byte for byte', async () => {
    const C = folder('alone-collector');
    orcaAt(C, '2026-09-02T10:02', 10);
    orcaAt(C, '2026-09-02T11:02', 11);
    recordInto(C, DLMM, 'meteora_dlmm', '2026-09-03T11:05:00.000Z', 12);
    const one = await appWith(gated(ORCA), C);
    const two = await appOf(gated(ORCA), [C, join(EMPTY, 'none')]);
    for (const url of [
      `/risk/pools/${ORCA.pool}/liquidity?basis=recorded`,
      `/risk/pools/${ORCA.pool}/liquidity`,
      `/risk/pools/${ORCA.pool}/liquidity/history?hours=744`,
      `/risk/pools/${DLMM.pool}/liquidity?basis=recorded&bands=20`,
      `/risk/pools/${DLMM.pool}/liquidity/history?hours=744`,
      '/risk/pools/recorded',
    ]) {
      const [a, b] = [await one.inject({ url }), await two.inject({ url })];
      expect(a.statusCode).toBe(200);
      expect(b.payload).toBe(a.payload);
      expect(a.json().source).toBe(RECORDED_SOURCE);
    }
    await one.close();
    await two.close();
  });

  it('exit_path other has no quote price on the recorded basis whichever job wrote the recording: the collector’s too, which was priced from the reference price before RU.12; token amounts are kept; via_sol and via_xstock are implied from the reference price in both, and have no price when there is none within 2 hours before the recording', async () => {
    const [C, A] = [folder('other-collector'), folder('other-arrays')];
    recordInto(C, DLMM, 'meteora_dlmm', '2026-09-04T10:05:00.000Z', 51);
    recordInto(A, DLMM, 'meteora_dlmm', '2026-09-04T10:25:00.000Z', 52, 'raw-arrays');
    // the same bytes recorded again 2 hours later, in folders of their own
    const [C2, A2] = [folder('late-collector'), folder('late-arrays')];
    recordInto(C2, DLMM, 'meteora_dlmm', '2026-09-04T12:05:00.000Z', 53);
    recordInto(A2, DLMM, 'meteora_dlmm', '2026-09-04T12:25:00.000Z', 54, 'raw-arrays');
    // USD per asset, 5 and 25 minutes before the recordings; the rows below exist inside the transaction only
    const REF = 600;
    await withRows(async (tx) => {
      const exitPath = (path: string) =>
        tx.update(riskPools).set({ exitPath: path }).where(eq(riskPools.address, DLMM.pool));
      // the same bytes recorded by each job, each in its own folder
      const collector = await appOf(gated(DLMM), [C, EMPTY], tx);
      const arrays = await appOf(gated(DLMM), [EMPTY, A], tx);
      const jobs = [
        { app: collector, slot: 51, source: RECORDED_SOURCE },
        { app: arrays, slot: 52, source: RECORDED_ARRAYS_SOURCE },
      ];
      const url = `/risk/pools/${DLMM.pool}/liquidity`;
      type B = { amount: number; amountUsd: number | null };

      // A quote with a measured way to dollars is implied from the asset's reference price, the newest within 2
      // hours before the recording. With none there, it has no price: null with its reason, the token amounts kept,
      // in either job's recording. The row this file seeds on a fresh database says exit_path other (a collected
      // database holds the pool as via_sol), so the path is set here: on a fresh database no other test comes this
      // far with a quote that can be priced.
      const unpriced = async (of: typeof jobs) => {
        for (const path of ['via_sol', 'via_xstock']) {
          await exitPath(path);
          for (const { app, slot, source } of of) {
            const v = (await app.inject({ url: `${url}?basis=recorded` })).json();
            expect(v).toMatchObject({
              basis: 'recorded',
              slot,
              distribution: 'bands',
              reason: null,
              quoteUsd: null,
              quoteUsdSource: null,
              usdNullReason: 'no_quote_price',
              totalAssetUsd: null,
              totalQuoteUsd: null,
              source,
            });
            expect(v.totalAsset).toBeGreaterThan(0);
            expect(v.totalQuote).toBeGreaterThan(0);
            expect(v.bands.every((x: B) => x.amountUsd === null)).toBe(true);
            const hv = (await app.inject({ url: `${url}/history?hours=744` })).json();
            expect(hv.points).toHaveLength(1);
            expect(hv.points[0]).toMatchObject({
              slot,
              valueUsd: null,
              assetUsd: null,
              quoteSideUsd: null,
              quoteUsd: null,
              usdNullReason: 'no_quote_price',
            });
            expect(hv.points[0].midPrice).toBeGreaterThan(0);
            expect(hv).toMatchObject({ reason: null, source });
          }
        }
      };
      // no reference price at all: none is stored before Oct 1, and the row below is not there yet
      await unpriced(jobs);
      await tx.insert(riskAssetSnapshots).values({
        assetMint: DLMM.inMint,
        asset: 'SPYx',
        fetchedAt: new Date('2026-09-04T10:00:00.000Z'),
        refPool: DLMM.pool,
        refMidUsd: REF,
        pools: 1,
        sell: [],
        buy: [],
        methodVersion: 'fixture',
        source: 'fixture rows',
        method: 'fixture',
        provenance: 'fixture',
      });
      // a reference price 2 hours and 5 minutes, and 2 hours and 25 minutes, before the recording is too old
      const late = [
        { app: await appOf(gated(DLMM), [C2, EMPTY], tx), slot: 53, source: RECORDED_SOURCE },
        {
          app: await appOf(gated(DLMM), [EMPTY, A2], tx),
          slot: 54,
          source: RECORDED_ARRAYS_SOURCE,
        },
      ];
      await unpriced(late);
      for (const { app } of late) await app.close();
      /** An answer without what says which recording it is: the rest is the rule, the same for both jobs. */
      const rule = (x: Record<string, unknown>) => ({ ...x, slot: 0, fetchedAt: '', source: '' });
      const hourRule = (h: { points: Array<Record<string, unknown>> }) => ({
        ...h,
        from: '',
        to: '',
        source: '',
        points: h.points.map((p) => ({ ...p, t: '', slot: 0 })),
      });
      const methods = { liquidity: new Set<string>(), history: new Set<string>() };

      // a quote with a measured way to dollars is implied from the reference price, in either job's recording
      let priced: Record<string, unknown> & { bands: B[] } = { bands: [] };
      for (const path of ['via_sol', 'via_xstock']) {
        await exitPath(path);
        const answers = [];
        for (const { app, slot, source } of jobs) {
          const v = (await app.inject({ url: `${url}?basis=recorded` })).json();
          expect(v).toMatchObject({
            basis: 'recorded',
            slot,
            distribution: 'bands',
            quoteUsdSource: 'implied_from_reference_mid',
            usdNullReason: null,
            source,
          });
          near(v.quoteUsd, REF / v.midPrice);
          near(v.totalAssetUsd, v.totalAsset * REF);
          near(v.totalQuoteUsd, v.totalQuote * v.quoteUsd);
          expect((await app.inject({ url })).json()).toEqual(v);
          const hv = (await app.inject({ url: `${url}/history?hours=744` })).json();
          expect(hv.points).toHaveLength(1);
          expect(hv.points[0]).toMatchObject({ slot, usdNullReason: null });
          near(hv.points[0].quoteUsd, REF / hv.points[0].midPrice);
          expect(hv.points[0].valueUsd).toBeGreaterThan(0);
          near(hv.points[0].valueUsd, hv.points[0].assetUsd + hv.points[0].quoteSideUsd);
          expect(hv.source).toBe(source);
          answers.push({ v, hv });
          methods.liquidity.add(v.method);
          methods.history.add(hv.method);
        }
        expect(rule(answers[1]?.v)).toEqual(rule(answers[0]?.v));
        expect(hourRule(answers[1]?.hv)).toEqual(hourRule(answers[0]?.hv));
        priced = answers[0]?.v;
      }

      // no measured way to dollars: token amounts, no price for the quote, no USD figure. The collector's
      // recording of such a pool was priced from the reference price until RU.12; now the rule is the pool's.
      await exitPath('other');
      const answers = [];
      for (const { app, slot, source } of jobs) {
        const a = (await app.inject({ url: `${url}?basis=recorded` })).json();
        expect(a).toMatchObject({
          basis: 'recorded',
          slot,
          distribution: 'bands',
          reason: null,
          quoteUsd: null,
          quoteUsdSource: null,
          usdNullReason: 'no_quote_price',
          totalAssetUsd: null,
          totalQuoteUsd: null,
          source,
        });
        expect(a.method).toMatch(/exit_path is other/);
        expect(a.method).not.toMatch(/raw-arrays|collector/);
        expect(a.midPrice).toBe(priced.midPrice);
        expect(a.totalAsset).toBe(priced.totalAsset);
        expect(a.totalQuote).toBe(priced.totalQuote);
        expect(a.totalAsset).toBeGreaterThan(0);
        expect(a.totalQuote).toBeGreaterThan(0);
        expect(a.bands.map((x: B) => x.amount)).toEqual(priced.bands.map((x) => x.amount));
        expect(a.bands.every((x: B) => x.amountUsd === null)).toBe(true);
        // the gated auto read falls back to the same answer
        expect((await app.inject({ url })).json()).toEqual(a);
        const ha = (await app.inject({ url: `${url}/history?hours=744` })).json();
        expect(ha.points).toHaveLength(1);
        expect(ha.points[0]).toMatchObject({
          slot,
          valueUsd: null,
          assetUsd: null,
          quoteSideUsd: null,
          quoteUsd: null,
          usdNullReason: 'no_quote_price',
        });
        expect(ha.points[0].midPrice).toBeGreaterThan(0);
        expect(ha).toMatchObject({ reason: null, source });
        answers.push({ a, ha });
        methods.liquidity.add(a.method);
        methods.history.add(ha.method);
      }
      expect(rule(answers[1]?.a)).toEqual(rule(answers[0]?.a));
      expect(hourRule(answers[1]?.ha)).toEqual(hourRule(answers[0]?.ha));
      // one sentence states the rule in every recorded answer, whatever the pool's exit path and whoever recorded it
      expect([methods.liquidity.size, methods.history.size]).toEqual([1, 1]);
      expect([...methods.history][0]).toMatch(/exit_path is other/);
      await collector.close();
      await arrays.close();
    });
  });
});
