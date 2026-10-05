import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  activeLiquidity,
  chronological,
  clSim,
  clStateFromLayout,
  decodeClmmAmmConfig,
  decodeClmmTickArray,
  decodeWhirlpool,
  decodeWpTickArray,
  defaultRegimeParams,
  LayoutCursor,
  type LiquidityChange,
  liquidityChanges,
  type PoolEvent,
  regimeAt,
  type TickMap,
  tickAtSqrtPriceX64,
  tickMapOf,
  usdCurves,
} from '@colosseum/risk';
import { HISTORY_DIR, type RegistryPool, valuePools } from '../lib-history';

// Step 5b.5 — pool state at every UTC hour boundary of the fetched history, for the CL value pools.
// Layout = the anchor raw snapshot (the newest one inside the walked window) with the liquidity events
// between it and the hour undone or applied (exact). Price = the post-state of the last event before the
// hour. Depth: the same simulator as the live collector (risk-0.3 single-pool curves).
// Quote in USD: 1 for USDC; otherwise implied from the same asset's largest USDC pool at the same hour
// (`quoteUsdMethod: implied_from_<pool>`), so no external price feed is needed. Hours without one are skipped.
// Checks, per hour: no tick with negative gross liquidity after rewinding (a missed add shows here), and
// for Raydium CLMM active liquidity from the layout = the last swap's reported liquidity.
// Output: hourly/<pool>.jsonl, and hourly/summary.json.  Usage: tsx reconstruct.ts [poolPrefix]
const METHOD = 'history-replay-0.1';
const SOURCE = 'Solana RPC history (getTransaction) + hourly raw pool snapshots';
const SIZES = [1_000, 10_000, 50_000, 100_000, 250_000, 1_000_000];
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RAW = join(homedir(), '.colosseum', 'risk', 'raw');
const OUT = join(HISTORY_DIR, 'hourly');
mkdirSync(OUT, { recursive: true });
const P = defaultRegimeParams(
  JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ),
);
type Row = { s: string; q: number; sl: number; t: number; ev: PoolEvent[] | null };

function anchorOf(p: RegistryPool, newestSlot: number) {
  let best: { slot: number; ticks: TickMap; feeRate: number; at: string } | undefined;
  if (!existsSync(RAW)) return best;
  for (const d of readdirSync(RAW))
    for (const h of readdirSync(join(RAW, d))) {
      const f = join(RAW, d, h, `${p.address}.json.gz`);
      if (!existsSync(f)) continue;
      const j = JSON.parse(gunzipSync(readFileSync(f)).toString());
      if (j.slot > newestSlot || (best && j.slot < best.slot)) continue;
      const head = new Uint8Array(Buffer.from(j.head, 'base64'));
      const kids = Object.values<string>(j.children).map(
        (b) => new Uint8Array(Buffer.from(b, 'base64')),
      );
      if (p.venue === 'raydium_clmm') {
        const arrays = kids.map(decodeClmmTickArray).filter((a) => a?.pool === p.address);
        const fee = j.config
          ? decodeClmmAmmConfig(new Uint8Array(Buffer.from(j.config, 'base64'))).tradeFeeRate / 1e6
          : Number.NaN;
        best = {
          slot: j.slot,
          at: j.fetchedAt,
          feeRate: fee,
          ticks: tickMapOf(arrays.flatMap((a) => a?.ticks ?? [])),
        };
      } else if (p.venue === 'orca_whirlpool') {
        const h0 = decodeWhirlpool(head);
        const arrays = kids
          .map((k) => decodeWpTickArray(k, h0.tickSpacing))
          .filter((a) => a?.pool === p.address);
        best = {
          slot: j.slot,
          at: j.fetchedAt,
          feeRate: h0.feeRate / 1e6,
          ticks: tickMapOf(arrays.flatMap((a) => a?.ticks ?? [])),
        };
      }
    }
  return best;
}

/** The live collector's 5-minute reads of a pool (`~/.colosseum/risk/pools/*.jsonl`). */
function collectorRows(pool: string) {
  const dir = join(homedir(), '.colosseum', 'risk', 'pools');
  const out: Array<{ slot: number; midUsd: number; depth2pct?: { sellQuoteOut: number } }> = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')))
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n'))
      if (l.includes(pool)) {
        const r = JSON.parse(l);
        if (r.pool === pool && r.slot) out.push(r);
      }
  return out;
}

type HourPoint = {
  hour: string;
  slot: number;
  sqrtPriceX64: bigint;
  tick: number;
  reportedLiquidity?: bigint;
  liqIndex: number;
  swaps: number;
};

/** Hour boundaries with the price state just before each, and the number of liquidity rows applied. */
function scan(p: RegistryPool, checkpointSlots: number[] = []) {
  const cps = [...checkpointSlots].sort((a, b) => a - b);
  const checkpoints: Array<HourPoint & { atSlot: number }> = [];
  const dir = join(HISTORY_DIR, 'events', p.address);
  const days = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const liq: Array<{ slot: number; seq: number; changes: LiquidityChange[] }> = [];
  const hours: HourPoint[] = [];
  let price: { sqrtPriceX64: bigint; tick: number; liquidity?: bigint } | undefined;
  let curHour: number | undefined;
  let lastSlot = 0;
  let swaps = 0;
  for (const d of days) {
    const rows = readFileSync(join(dir, d), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row)
      .map((r) => ({ ...r, slot: r.sl, seq: r.q }))
      .sort(chronological);
    for (const r of rows) {
      while (cps.length && (cps[0] as number) < r.sl && price) {
        const atSlot = cps.shift() as number;
        checkpoints.push({
          hour: '',
          atSlot,
          slot: lastSlot,
          ...price,
          reportedLiquidity: price.liquidity,
          liqIndex: liq.length,
          swaps: 0,
        });
      }
      const h = Math.floor(r.t / 3600);
      if (curHour !== undefined && h > curHour && price)
        for (let k = curHour + 1; k <= h; k++)
          hours.push({
            hour: new Date(k * 3_600_000).toISOString(),
            slot: lastSlot,
            ...price,
            reportedLiquidity: price.liquidity,
            liqIndex: liq.length,
            swaps,
          });
      if (curHour === undefined || h > curHour) {
        curHour = h;
        swaps = 0;
      }
      for (const e of r.ev ?? [])
        if (e.kind === 'swap' && e.sqrtPriceX64) {
          swaps++;
          const sq = BigInt(e.sqrtPriceX64);
          price = {
            sqrtPriceX64: sq,
            tick: e.tick ?? tickAtSqrtPriceX64(sq),
            ...(e.liquidity ? { liquidity: BigInt(e.liquidity) } : {}),
          };
        } else if (e.kind === 'liquidity' && price && e.poolLiquidityAfter)
          price = { ...price, liquidity: BigInt(e.poolLiquidityAfter) };
      const changes = liquidityChanges(r.ev ?? []);
      if (changes.length) liq.push({ slot: r.sl, seq: r.q, changes });
      lastSlot = r.sl;
    }
  }
  return { liq, hours, checkpoints };
}

const pools = valuePools().filter(
  (p) =>
    (p.venue === 'raydium_clmm' || p.venue === 'orca_whirlpool') &&
    (!process.argv[2] || p.address.startsWith(process.argv[2])),
);
// USDC pools first, so SOL / other quotes can be priced from them
pools.sort(
  (a, b) =>
    Number(b.mint1 === USDC || b.mint0 === USDC) - Number(a.mint1 === USDC || a.mint0 === USDC) ||
    b.tvlUsd - a.tvlUsd,
);
const assetUsd = new Map<string, Map<string, { usd: number; pool: string }>>(); // asset → hour → price
const summary: Record<string, unknown>[] = [];
for (const p of pools) {
  if (!existsSync(join(HISTORY_DIR, 'events', p.address))) continue;
  const newestSlot = Number(
    readFileSync(join(HISTORY_DIR, 'sigs', p.address, '0000.tsv'), 'utf8').split('\t', 2)[1],
  );
  const anchor = anchorOf(p, newestSlot);
  if (!anchor) {
    summary.push({
      pool: p.address,
      asset: p.assetSymbol,
      status: 'no raw snapshot inside the walked window',
    });
    continue;
  }
  const live = collectorRows(p.address).filter((r) => r.slot <= newestSlot);
  const { liq, hours, checkpoints } = scan(
    p,
    live.map((r) => r.slot),
  );
  const anchorIdx = liq.filter((r) => r.slot <= anchor.slot).length;
  const cursor = new LayoutCursor(anchor.ticks, liq, anchorIdx);
  const assetIs0 = p.assetIsToken0 === 1;
  const isUsdc = p.mint0 === USDC || p.mint1 === USDC;
  const decAsset = assetIs0 ? p.decimals0 : p.decimals1;
  const decQuote = assetIs0 ? p.decimals1 : p.decimals0;
  const lines: string[] = [];
  let checks = 0;
  let checkFails = 0;
  let negativeGross = 0;
  let skipped = 0;
  const priceMap = assetUsd.get(p.assetSymbol) ?? new Map();
  for (const h of hours) {
    const layout = cursor.moveTo(h.liqIndex);
    for (const v of layout.values()) if (v.gross < 0n) negativeGross++;
    if (h.reportedLiquidity !== undefined && p.venue === 'raydium_clmm') {
      checks++;
      if (activeLiquidity(layout, h.tick) !== h.reportedLiquidity) checkFails++;
    }
    const state = clStateFromLayout(layout, h, anchor.feeRate);
    const sim = clSim(state, assetIs0);
    const midUi = sim.midRaw * 10 ** (decAsset - decQuote);
    let quoteUsd = 1;
    let quoteUsdMethod = 'usdc_at_par';
    if (!isUsdc) {
      const ref = priceMap.get(h.hour);
      if (!ref) {
        skipped++;
        continue;
      }
      quoteUsd = ref.usd / midUi;
      quoteUsdMethod = `implied_from_${ref.pool}`;
    }
    const c = usdCurves(sim, decAsset, decQuote, quoteUsd, SIZES);
    if (isUsdc && !priceMap.has(h.hour)) priceMap.set(h.hour, { usd: c.midUsd, pool: p.address });
    const dw = sim.depthWithin(0.02);
    lines.push(
      JSON.stringify({
        pool: p.address,
        asset: p.assetSymbol,
        hour: h.hour,
        slot: h.slot,
        regime: regimeAt(new Date(h.hour), P),
        midUsd: +c.midUsd.toPrecision(8),
        quoteUsd: +quoteUsd.toPrecision(8),
        quoteUsdMethod,
        depth2pctSellUsd: Math.round((dw.sellQuoteOut / 10 ** decQuote) * quoteUsd),
        depth2pctBuyUsd: Math.round((dw.buyAssetOut / 10 ** decAsset) * c.midUsd),
        sellCostPct: c.sell.map((x) => [
          x.notionalUsd,
          +x.costPct.toFixed(4),
          +x.unfilledShare.toFixed(4),
        ]),
        buyCostPct: c.buy.map((x) => [
          x.notionalUsd,
          +x.costPct.toFixed(4),
          +x.unfilledShare.toFixed(4),
        ]),
        swapsInHour: h.swaps,
        source: SOURCE,
        method: METHOD,
        provenance: 'live',
      }),
    );
  }
  // validation against the live collector's own reads at the same slots (USDC pools)
  const errs: number[] = [];
  const midErrs: number[] = [];
  if (isUsdc) {
    const bySlot = new Map(live.map((r) => [r.slot, r]));
    for (const cp of checkpoints) {
      const lv = bySlot.get(cp.atSlot);
      if (!lv?.depth2pct) continue;
      const sim = clSim(
        clStateFromLayout(cursor.moveTo(cp.liqIndex), cp, anchor.feeRate),
        assetIs0,
      );
      const dw = sim.depthWithin(0.02);
      const mid = sim.midRaw * 10 ** (decAsset - decQuote);
      errs.push(Math.abs(dw.sellQuoteOut / 10 ** decQuote / lv.depth2pct.sellQuoteOut - 1));
      midErrs.push(Math.abs(mid / lv.midUsd - 1));
    }
  }
  const q = (a: number[], f: number) => {
    const v = [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * f)];
    return v === undefined ? null : +v.toExponential(2);
  };
  assetUsd.set(p.assetSymbol, priceMap);
  writeFileSync(join(OUT, `${p.address}.jsonl`), lines.length ? `${lines.join('\n')}\n` : '');
  const row = {
    pool: p.address,
    venue: p.venue,
    asset: p.assetSymbol,
    anchor: anchor.at,
    hours: lines.length,
    skippedNoQuoteUsd: skipped,
    first: hours[0]?.hour,
    last: hours.at(-1)?.hour,
    liquidityRows: liq.length,
    activeLiquidityChecks: checks,
    activeLiquidityFails: checkFails,
    negativeGrossTicks: negativeGross,
    vsCollector: {
      reads: errs.length,
      midRelErrP50: q(midErrs, 0.5),
      midRelErrMax: q(midErrs, 1),
      depth2pctRelErrP50: q(errs, 0.5),
      depth2pctRelErrP95: q(errs, 0.95),
      depth2pctRelErrMax: q(errs, 1),
    },
  };
  summary.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(
  join(OUT, 'summary.json'),
  JSON.stringify(
    { method: METHOD, source: SOURCE, generatedAt: new Date().toISOString(), pools: summary },
    null,
    1,
  ),
);
