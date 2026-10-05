import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
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
  type Regime,
  regimeAt,
  type TickMap,
  tickAtSqrtPriceX64,
  tickMapOf,
} from '@colosseum/risk';
import { HISTORY_DIR, type RegistryPool, valuePools } from '../lib-history';

// Step 5b.6 — the founder's question: how large trades move the price and how LPs react.
// Per transaction (net of round trips inside it): pre/post price, notional, and size relative to the
// same-side depth within ±2% at that moment (exact layout replay). A trade is "large" when it is at least
// LARGE_SHARE of that depth. After each large trade: time for the price to recover 50% / 90% of the move
// (capped at 24 h), and LP activity in the next REACT_MIN minutes near the post-trade price (ranges
// overlapping ±2%): adds, removes, range moves (a remove and an add in one tx), distinct positions —
// against the pool's baseline rate per REACT_MIN window. Hourly depth (reconstruct.ts) gives the measured
// dry factor per asset: min over regimes of median ±2% sell depth ÷ the US-market-hours median.
// Usage: tsx report.ts [largeShare=0.05] [reactMin=30] [poolPrefix]
const LARGE_SHARE = Number(process.argv[2] ?? 0.05);
const REACT_MIN = Number(process.argv[3] ?? 30);
const FILTER = process.argv[4];
const METHOD = 'history-report-0.1';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RAW = join(homedir(), '.colosseum', 'risk', 'raw');
const OUT = join(HISTORY_DIR, 'report');
mkdirSync(OUT, { recursive: true });
const P = defaultRegimeParams(
  JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ),
);
type Row = { s: string; q: number; sl: number; t: number; ev: PoolEvent[] | null };

function anchorOf(p: RegistryPool, newestSlot: number) {
  let best: { slot: number; ticks: TickMap; feeRate: number } | undefined;
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
        best = {
          slot: j.slot,
          feeRate: j.config
            ? decodeClmmAmmConfig(new Uint8Array(Buffer.from(j.config, 'base64'))).tradeFeeRate /
              1e6
            : 0,
          ticks: tickMapOf(arrays.flatMap((a) => a?.ticks ?? [])),
        };
      } else if (p.venue === 'orca_whirlpool') {
        const h0 = decodeWhirlpool(head);
        const arrays = kids
          .map((k) => decodeWpTickArray(k, h0.tickSpacing))
          .filter((a) => a?.pool === p.address);
        best = {
          slot: j.slot,
          feeRate: h0.feeRate / 1e6,
          ticks: tickMapOf(arrays.flatMap((a) => a?.ticks ?? [])),
        };
      }
    }
  return best;
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)] as number;
};
const priceOf = (sq: bigint) => (Number(sq) / 2 ** 64) ** 2;

type Large = {
  pool: string;
  asset: string;
  sig: string;
  at: string;
  regime: Regime;
  side: 'sell' | 'buy';
  notionalUsd: number;
  depthUsd: number;
  shareOfDepth: number;
  moveBps: number;
  recover50Min: number | null;
  recover90Min: number | null;
  lpAdds: number;
  lpRemoves: number;
  lpRangeMoves: number;
  lpPositions: number;
  lpNetLiquidityNearPct: number;
};

const larges: Large[] = [];
const baselines: Record<string, { windows: number; adds: number; removes: number; moves: number }> =
  {};
const dry: Record<string, Record<string, number>> = {};
for (const p of valuePools().filter(
  (x) =>
    (x.venue === 'raydium_clmm' || x.venue === 'orca_whirlpool') &&
    (!FILTER || x.address.startsWith(FILTER)),
)) {
  const evDir = join(HISTORY_DIR, 'events', p.address);
  if (!existsSync(evDir)) continue;
  const newestSlot = Number(
    readFileSync(join(HISTORY_DIR, 'sigs', p.address, '0000.tsv'), 'utf8').split('\t', 2)[1],
  );
  const anchor = anchorOf(p, newestSlot);
  if (!anchor) continue;
  const assetIs0 = p.assetIsToken0 === 1;
  const isUsdc = p.mint0 === USDC || p.mint1 === USDC;
  const decAsset = assetIs0 ? p.decimals0 : p.decimals1;
  const decQuote = assetIs0 ? p.decimals1 : p.decimals0;
  // quote USD per hour for non-USDC pools, from the hourly reconstruction
  const quoteUsd = new Map<string, number>();
  const hourlyFile = join(HISTORY_DIR, 'hourly', `${p.address}.jsonl`);
  if (existsSync(hourlyFile))
    for (const l of readFileSync(hourlyFile, 'utf8').split('\n').filter(Boolean)) {
      const h = JSON.parse(l);
      quoteUsd.set(h.hour, h.quoteUsd);
      const byAsset = dry[p.assetSymbol] ?? {};
      byAsset[`${p.address}|${h.regime}|${h.hour}`] = h.depth2pctSellUsd;
      dry[p.assetSymbol] = byAsset;
    }
  // pass 1: liquidity rows (small) for the layout cursor
  const days = readdirSync(evDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const load = (d: string) =>
    readFileSync(join(evDir, d), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row)
      .map((r) => ({ ...r, slot: r.sl, seq: r.q }))
      .sort(chronological);
  const liq: Array<{
    slot: number;
    seq: number;
    t: number;
    changes: LiquidityChange[];
    ev: PoolEvent[];
  }> = [];
  for (const d of days)
    for (const r of load(d)) {
      const changes = liquidityChanges(r.ev ?? []);
      if (changes.length) liq.push({ slot: r.sl, seq: r.q, t: r.t, changes, ev: r.ev ?? [] });
    }
  const cursor = new LayoutCursor(
    anchor.ticks,
    liq,
    liq.filter((r) => r.slot <= anchor.slot).length,
  );
  cursor.moveTo(0);
  let liqAt = 0;
  // baseline LP activity per REACT_MIN window
  const span = (liq.at(-1)?.t ?? 0) - (liq[0]?.t ?? 0);
  const b = { windows: Math.max(1, span / (REACT_MIN * 60)), adds: 0, removes: 0, moves: 0 };
  for (const r of liq) {
    const acts = r.ev
      .filter((e) => e.kind === 'liquidity')
      .map((e) => (e as { action: string }).action);
    if (acts.includes('decrease') && acts.some((a) => a !== 'decrease')) b.moves++;
    else if (acts.includes('decrease')) b.removes++;
    else b.adds++;
  }
  baselines[p.address] = b;
  // pass 2: trades, chronological, with the layout kept in step
  let price: bigint | undefined;
  const pending: Array<{ l: Large; p0: number; p1: number; t0: number; done50?: boolean }> = [];
  for (const d of days)
    for (const r of load(d)) {
      // close recovery windows with this row's pre-price
      while (liqAt < liq.length && chronological(liq[liqAt] as never, r as never) < 0) liqAt++;
      const swaps = (r.ev ?? []).filter((e) => e.kind === 'swap' && e.sqrtPriceX64) as Array<
        Extract<PoolEvent, { kind: 'swap' }>
      >;
      if (!swaps.length) continue;
      const first = swaps[0] as (typeof swaps)[number];
      const pre = first.preSqrtPriceX64 ? BigInt(first.preSqrtPriceX64) : price;
      const post = BigInt((swaps.at(-1) as (typeof swaps)[number]).sqrtPriceX64 as string);
      price = post;
      const pNow = priceOf(post);
      for (const x of pending) {
        const moved = Math.abs(pNow - x.p0);
        const full = Math.abs(x.p1 - x.p0);
        const mins = (r.t - x.t0) / 60;
        if (!x.done50 && moved <= 0.5 * full) {
          x.l.recover50Min = +mins.toFixed(2);
          x.done50 = true;
        }
        if (x.l.recover90Min === null && moved <= 0.1 * full) x.l.recover90Min = +mins.toFixed(2);
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        const x = pending[i] as (typeof pending)[number];
        if (x.l.recover90Min !== null || r.t - x.t0 > 86_400) pending.splice(i, 1);
      }
      if (pre === undefined) continue;
      // net asset flow of the tx (asset raw units; + = sold into the pool)
      let assetIn = 0n;
      for (const e of swaps) {
        const a = BigInt(assetIs0 ? e.amount0 : e.amount1);
        const sellsAsset = assetIs0 ? e.zeroForOne : !e.zeroForOne;
        assetIn += sellsAsset ? a : -a;
      }
      if (assetIn === 0n) continue;
      const hour = new Date(Math.floor(r.t / 3600) * 3_600_000).toISOString();
      const qUsd = isUsdc ? 1 : quoteUsd.get(hour);
      if (qUsd === undefined) continue;
      const p0 = priceOf(pre);
      const midQuotePerAsset = (assetIs0 ? p0 : 1 / p0) * 10 ** (decAsset - decQuote);
      const notionalUsd = (Math.abs(Number(assetIn)) / 10 ** decAsset) * midQuotePerAsset * qUsd;
      if (notionalUsd < 1_000) continue; // depth is only computed for trades that could be large
      const layout = cursor.moveTo(liqAt);
      const sim = clSim(
        clStateFromLayout(
          layout,
          { sqrtPriceX64: pre, tick: tickAtSqrtPriceX64(pre) },
          anchor.feeRate,
        ),
        assetIs0,
      );
      const dw = sim.depthWithin(0.02);
      const side = assetIn > 0n ? 'sell' : 'buy';
      const depthUsd =
        side === 'sell'
          ? (dw.sellQuoteOut / 10 ** decQuote) * qUsd
          : (dw.buyAssetOut / 10 ** decAsset) * midQuotePerAsset * qUsd;
      if (!(depthUsd > 0) || notionalUsd < LARGE_SHARE * depthUsd) continue;
      // LP reaction in the next REACT_MIN minutes, near the post-trade price
      const tLo = tickAtSqrtPriceX64(post) + Math.round(Math.log(0.98) / Math.log(1.0001));
      const tHi = tickAtSqrtPriceX64(post) + Math.round(Math.log(1.02) / Math.log(1.0001));
      let adds = 0;
      let removes = 0;
      let moves = 0;
      let netNear = 0n;
      const positions = new Set<string>();
      for (let k = liqAt; k < liq.length && (liq[k]?.t ?? 0) <= r.t + REACT_MIN * 60; k++) {
        const row = liq[k] as (typeof liq)[number];
        if (row.t < r.t) continue;
        const near = row.changes.filter((c) => c.tickUpper > tLo && c.tickLower < tHi);
        if (!near.length) continue;
        const acts = row.ev.filter((e) => e.kind === 'liquidity') as Array<
          Extract<PoolEvent, { kind: 'liquidity' }>
        >;
        for (const e of acts) positions.add(e.position ?? e.owner ?? row.slot.toString());
        if (acts.some((e) => e.action === 'decrease') && acts.some((e) => e.action !== 'decrease'))
          moves++;
        else if (acts.some((e) => e.action === 'decrease')) removes++;
        else adds++;
        for (const c of near) netNear += c.delta;
      }
      const activeNow = clStateFromLayout(
        layout,
        { sqrtPriceX64: pre, tick: tickAtSqrtPriceX64(pre) },
        0,
      ).liquidity;
      const l: Large = {
        pool: p.address,
        asset: p.assetSymbol,
        sig: r.s,
        at: new Date(r.t * 1000).toISOString(),
        regime: regimeAt(new Date(r.t * 1000), P),
        side,
        notionalUsd: Math.round(notionalUsd),
        depthUsd: Math.round(depthUsd),
        shareOfDepth: +(notionalUsd / depthUsd).toFixed(4),
        moveBps: +(Math.abs(pNow / p0 - 1) * 1e4).toFixed(2),
        recover50Min: null,
        recover90Min: null,
        lpAdds: adds,
        lpRemoves: removes,
        lpRangeMoves: moves,
        lpPositions: positions.size,
        lpNetLiquidityNearPct:
          activeNow > 0 ? +((Number(netNear) / activeNow) * 100).toFixed(2) : 0,
      };
      larges.push(l);
      pending.push({ l, p0, p1: pNow, t0: r.t });
    }
}

// aggregate per asset × regime
const groups = new Map<string, Large[]>();
for (const l of larges)
  groups.set(`${l.asset}|${l.regime}`, [...(groups.get(`${l.asset}|${l.regime}`) ?? []), l]);
const table = [...groups]
  .map(([k, ls]) => {
    const [asset, regime] = k.split('|');
    const base = ls.map((l) => baselines[l.pool]).filter(Boolean) as Array<
      (typeof baselines)[string]
    >;
    const baseRemoves = median(base.map((x) => x.removes / x.windows)) ?? 0;
    const baseAdds = median(base.map((x) => x.adds / x.windows)) ?? 0;
    return {
      asset,
      regime,
      trades: ls.length,
      medShareOfDepth: median(ls.map((l) => l.shareOfDepth)),
      medMoveBps: median(ls.map((l) => l.moveBps)),
      medRecover50Min: median(ls.map((l) => l.recover50Min).filter((x): x is number => x !== null)),
      medRecover90Min: median(ls.map((l) => l.recover90Min).filter((x): x is number => x !== null)),
      unrecovered90Share: +(ls.filter((l) => l.recover90Min === null).length / ls.length).toFixed(
        2,
      ),
      lpRemovesPerTrade: +(ls.reduce((s, l) => s + l.lpRemoves, 0) / ls.length).toFixed(2),
      lpRemovesBaseline: +baseRemoves.toFixed(2),
      lpAddsPerTrade: +(ls.reduce((s, l) => s + l.lpAdds, 0) / ls.length).toFixed(2),
      lpAddsBaseline: +baseAdds.toFixed(2),
      lpRangeMovesPerTrade: +(ls.reduce((s, l) => s + l.lpRangeMoves, 0) / ls.length).toFixed(2),
      medLpNetNearPct: median(ls.map((l) => l.lpNetLiquidityNearPct)),
    };
  })
  .sort(
    (a, b) =>
      (a.asset as string).localeCompare(b.asset as string) ||
      (a.regime as string).localeCompare(b.regime as string),
  );

// measured dry factor per asset: depth regime medians relative to US market hours (main pool per asset)
const dryFactors = Object.entries(dry).map(([asset, m]) => {
  const byPool = new Map<string, Map<string, number[]>>();
  for (const [k, v] of Object.entries(m)) {
    const [pool, regime] = k.split('|') as [string, string];
    const r = byPool.get(pool) ?? new Map<string, number[]>();
    r.set(regime, [...(r.get(regime) ?? []), v]);
    byPool.set(pool, r);
  }
  const sumByRegime = new Map<string, number>();
  for (const r of byPool.values())
    for (const [regime, vs] of r)
      sumByRegime.set(regime, (sumByRegime.get(regime) ?? 0) + (median(vs) ?? 0));
  const rth = sumByRegime.get('us_market_hours');
  const ratios = Object.fromEntries(
    [...sumByRegime].map(([k, v]) => [k, rth ? +(v / rth).toFixed(3) : null]),
  );
  const floor = Object.values(ratios).filter((x): x is number => x !== null);
  return {
    asset,
    depth2pctSellUsdByRegime: Object.fromEntries(sumByRegime),
    ratioToMarketHours: ratios,
    measuredDryFactor: floor.length ? Math.min(...floor) : null,
  };
});

const stamp = new Date().toISOString().slice(0, 16).replace(/[:-]/g, '');
writeFileSync(
  join(OUT, `large-trades-${stamp}.jsonl`),
  larges.map((l) => JSON.stringify(l)).join('\n'),
);
writeFileSync(
  join(OUT, `report-${stamp}.json`),
  JSON.stringify(
    {
      method: METHOD,
      largeShare: LARGE_SHARE,
      reactMin: REACT_MIN,
      generatedAt: new Date().toISOString(),
      provenance: 'live',
      table,
      dryFactors,
    },
    null,
    1,
  ),
);
console.log(
  `Large trades (≥ ${LARGE_SHARE * 100}% of same-side depth within ±2%), LP reaction within ${REACT_MIN} min; ${larges.length} trades`,
);
console.table(table);
console.log(
  'Measured dry factor: ±2% sell depth by regime ÷ US market hours (sum of per-pool medians)',
);
console.table(
  dryFactors.map((d) => ({
    asset: d.asset,
    ...d.ratioToMarketHours,
    measuredDryFactor: d.measuredDryFactor,
  })),
);
