import 'dotenv/config';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import { createDb, riskLendingPools } from '@colosseum/db';
import {
  type AssetCurves,
  alarmShare,
  coverageRatio,
  type DepthCurve,
  defaultLendingReportParams,
  defaultRegimeParams,
  type GapDeposit,
  type GapPosition,
  gapStats,
  type LiquidationInput,
  lendingGapSim,
  liquidationTable,
  type ReallocationLeg,
  type Regime,
  reallocationSummary,
  regimeAt,
  type Supplier,
  saleCapacity,
  supplierConcentration,
  vaultExit,
  weekendDepthRatio,
} from '@colosseum/risk';
import { LendingMarket } from '@kamino-finance/klend-sdk';
import { sql } from 'drizzle-orm';
import { HISTORY_DIR } from './lib-history';
import { LENDING_HISTORY_DIR, multipleAccounts, RISK_HOME } from './lib-lending';

// Step 10b item 9 — `pnpm risk:lending-report`: can the market absorb the collateral? Report only (no API, no UI).
// Reads, never writes, the item 8 tables (pools, hourly reserve history, events), the collector's 5-minute rows and the
// latest complete hour of positions (~/.colosseum/risk; positions are read locally and published only as aggregates,
// D13), the routed depth curves (risk_depth_curves, risk-0.3), Step 5b's hourly pool rows (weekend depth ratio, pool
// mids) and the decode pass's curated-vault reallocations. One RPC call: the 4 Kamino market accounts (close factor
// and full-liquidation LTV), decoded with klend-sdk. Policy inputs: `defaultLendingReportParams()`.
// Output: data/risk/lending-history/report/lending-report-<stamp>.json, and the tables printed.

const METHOD = 'lending-report-0.1';
const P = defaultLendingReportParams();
const RP = defaultRegimeParams(
  JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ),
);
const generatedAt = new Date();
const STAMP = generatedAt.toISOString().replace(/[-:]/g, '').slice(0, 13);
const OUT = join(LENDING_HISTORY_DIR, 'report');
mkdirSync(OUT, { recursive: true });
const DOLLAR_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const USDC_SYMBOLS = new Set(['USDC']);

const { db, client } = createDb();
const rows = async <T>(q: ReturnType<typeof sql>) => {
  const r = (await db.execute(q)) as unknown as { rows?: T[] } & T[];
  return (r.rows ?? r) as T[];
};
const registry = await db.select().from(riskLendingPools);
const byAccount = new Map(registry.map((r) => [r.account, r]));
const decimalsOf = new Map(registry.map((r) => [r.mint, r.decimals]));
const symbolOfMint = new Map(registry.map((r) => [r.mint, r.symbol]));
const xstockMintOf = new Map(
  registry.filter((r) => r.dexAssetMint).map((r) => [r.symbol, r.dexAssetMint as string]),
);
const params = (r: { params: unknown }) => r.params as Record<string, number>;
const pct = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined ? '—' : `${(100 * x).toFixed(d)}%`;
const usd = (x: number | null | undefined) =>
  x === null || x === undefined
    ? '—'
    : Math.abs(x) >= 1e6
      ? `$${(x / 1e6).toFixed(2)}M`
      : Math.abs(x) >= 1e3
        ? `$${(x / 1e3).toFixed(1)}k`
        : `$${x.toFixed(0)}`;
function table(title: string, data: Array<Record<string, unknown>>) {
  console.log(`\n${title}`);
  if (!data.length) return console.log('  (none)');
  const cols = Object.keys(data[0] as object);
  const w = cols.map((c) => Math.max(c.length, ...data.map((r) => String(r[c] ?? '').length)));
  const line = (r: Record<string, unknown>) =>
    `  ${cols.map((c, i) => String(r[c] ?? '').padEnd(w[i] as number)).join('  ')}`;
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  for (const r of data) console.log(line(r));
}
const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString() : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

// ------------------------------------------------------------------------------------------- live collector rows
type LiveRow = Record<string, unknown> & { kind: string; account: string; fetchedAt: string };
const liveDir = join(RISK_HOME, 'lending');
const live: LiveRow[] = readdirSync(liveDir)
  .filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))
  .sort()
  .flatMap((f) => readJsonl<LiveRow>(join(liveDir, f)));
const liveFrom = live[0]?.fetchedAt ?? null;
const liveTo = live.at(-1)?.fetchedAt ?? null;

// latest complete hour of positions
const posRoot = join(RISK_HOME, 'lending-positions');
const posHour = readdirSync(posRoot)
  .sort()
  .flatMap((d) =>
    readdirSync(join(posRoot, d))
      .filter((h) => existsSync(join(posRoot, d, h, '.done')))
      .map((h) => `${d}/${h}`),
  )
  .at(-1);
if (!posHour) throw new Error('no complete positions hour');
const posDir = join(posRoot, posHour);
type Obligation = {
  obligation: string;
  owner: string;
  fetchedAt: string;
  market: string;
  deposits: Array<{ reserve: string; symbol: string; amount: number | null; usd: number | null }>;
  borrows: Array<{ reserve: string; symbol: string; amount: number | null; usd: number | null }>;
  debtUsd: number | null;
};
type JlPos = {
  position: string;
  positionMint: string;
  nftId: number;
  vaultId: number;
  fetchedAt: string;
  collateral: number;
  debt: number;
  liquidatedBranch?: boolean;
};
const obligations = readdirSync(posDir)
  .filter((f) => f.startsWith('kamino-') && f.endsWith('.jsonl.gz'))
  .flatMap((f) => readJsonl<Obligation>(join(posDir, f)));
const jlPositions = readdirSync(posDir)
  .filter((f) => f.startsWith('jupiter_lend-') && f.endsWith('.jsonl.gz'))
  .flatMap((f) => readJsonl<JlPos>(join(posDir, f)));
const posFetchedAt = obligations[0]?.fetchedAt ?? jlPositions[0]?.fetchedAt;
const runRows = live.filter((r) => r.fetchedAt === posFetchedAt);
const reserveRow = new Map(
  runRows.filter((r) => r.kind === 'kamino_reserve').map((r) => [r.account, r]),
);
const vaultRowById = new Map(
  runRows.filter((r) => r.kind === 'jl_vault').map((r) => [Number(r.vaultId), r]),
);
const kvaultRows = runRows.filter((r) => r.kind === 'kvault');
// every address that identifies a wallet or a position at this hour: none may reach the output
const privateAddresses = new Set<string>([
  ...obligations.flatMap((o) => [o.obligation, o.owner]),
  ...jlPositions.flatMap((p) => [p.position, p.positionMint]),
  ...registry.filter((r) => r.manager).map((r) => r.manager as string),
]);

// =============================================================================================== 1. pools
const snap = await rows<{
  account: string;
  kind: string;
  n: string;
  first: string;
  last: string;
  slo: string;
  above: string;
  max: number | null;
}>(sql`select account, kind, count(*) n, min(observed_at) first, max(observed_at) last,
  count(share_lent_out) slo, count(*) filter (where 100 * share_lent_out > ${P.utilAlarmPct}) above,
  max(share_lent_out) max from risk_lending_snapshots group by account, kind`);
const events = await rows<{ pool: string | null; kind: string; n: string }>(
  sql`select pool, kind, count(*) n from risk_lending_events group by pool, kind`,
);
const eventsByPool = new Map<string, Record<string, number>>();
for (const e of events) {
  const k = e.pool ?? '(none)';
  const m = eventsByPool.get(k) ?? {};
  m[e.kind] = Number(e.n);
  eventsByPool.set(k, m);
}
const poolsSection = registry
  .filter((r) => r.status === 'active' || r.role === 'curated_vault')
  .map((r) => {
    const hourly = snap.find((s) => s.account === r.account && s.kind.endsWith('_hourly'));
    const fiveMin = snap.find((s) => s.account === r.account && !s.kind.endsWith('_hourly'));
    const ev = eventsByPool.get(r.account) ?? {};
    const hist = hourly
      ? { n: Number(hourly.slo), above: Number(hourly.above), max: hourly.max }
      : null;
    const lv = fiveMin
      ? { n: Number(fiveMin.slo), above: Number(fiveMin.above), max: fiveMin.max }
      : null;
    return {
      account: r.account,
      venue: r.venue,
      market: r.marketName ?? r.market,
      symbol: r.symbol,
      role: r.role,
      historyFrom: hourly?.first ?? null,
      historyTo: hourly?.last ?? null,
      historyHours: hourly ? Number(hourly.n) : 0,
      events: ev,
      eventsTotal: Object.entries(ev)
        .filter(([k]) => k !== 'config_change')
        .reduce((s, [, v]) => s + v, 0),
      configChanges: ev.config_change ?? 0,
      alarmHistory: hist?.n ? { ...hist, share: hist.above / hist.n } : null,
      alarmLive5m: lv?.n ? { ...lv, share: lv.above / lv.n } : null,
    };
  });
// Jupiter Lend: the lent-out share is the liquidity layer's (D12, live only): per debt token from the 5-minute rows
const jlLayer = [
  ...new Set(live.filter((r) => r.kind === 'jl_liquidity').map((r) => String(r.symbol))),
].map((sym) => {
  const xs = live.filter((r) => r.kind === 'jl_liquidity' && r.symbol === sym);
  return {
    symbol: sym,
    ...alarmShare(
      xs.map((r) => Number(r.utilization)),
      P.utilAlarmPct,
    ),
  };
});

// =============================================================================================== 2. lenders
const reallocFile = join(LENDING_HISTORY_DIR, 'decoded', 'reallocations.jsonl');
const kaminoReserves = registry.filter((r) => r.venue === 'kamino' && r.role !== 'curated_vault');
const registered = new Set(kaminoReserves.map((r) => r.account));
const legsBy = new Map<string, ReallocationLeg[]>();
if (existsSync(reallocFile)) {
  const rl = createInterface({ input: createReadStream(reallocFile) });
  for await (const line of rl) {
    if (!line) continue;
    const j = JSON.parse(line) as {
      time: string;
      vault: string;
      legs: Array<{ reserve: string; delta: string }>;
    };
    for (const l of j.legs) {
      if (!registered.has(l.reserve) || l.delta === '0') continue;
      const k = `${j.vault}:${l.reserve}`;
      const a = legsBy.get(k) ?? [];
      a.push({ at: j.time, delta: BigInt(l.delta) });
      legsBy.set(k, a);
    }
  }
}
const lenders = kaminoReserves
  .map((r) => {
    const st = reserveRow.get(r.account);
    if (!st) return null;
    const supplied = Number(st.suppliedUi);
    const borrowed = Number(st.borrowedUi);
    const available = Number(st.availableUi);
    const perObligation: Supplier[] = obligations
      .map((o) => ({
        amount: o.deposits
          .filter((d) => d.reserve === r.account)
          .reduce((s, d) => s + (d.amount ?? 0), 0),
      }))
      .filter((s) => s.amount > 0);
    const vaults = kvaultRows.flatMap((v) =>
      (v.allocations as Array<{ reserve: string; liquidity: number }>)
        .filter((a) => a.reserve === r.account && a.liquidity > 0)
        .map((a) => ({ vault: v.account, name: String(v.name), liquidity: a.liquidity })),
    );
    const conc = supplierConcentration(
      [...perObligation, ...vaults.map((v) => ({ amount: v.liquidity, named: v.name }))],
      supplied,
      P.topN,
    );
    // the largest supplier leaving (an aggregate: no identity is kept)
    const largest = Math.max(
      0,
      ...perObligation.map((s) => s.amount),
      ...vaults.map((v) => v.liquidity),
    );
    const largestExit = vaultExit({ supplied, borrowed, available }, largest);
    const curated = registry
      .filter((v) => v.role === 'curated_vault')
      .map((v) => {
        const held = vaults.find((x) => x.vault === v.account);
        const legs = legsBy.get(`${v.account}:${r.account}`) ?? [];
        if (!held && !legs.length) return null;
        return {
          vault: v.marketName ?? v.account,
          account: v.account,
          offered: v.offered ?? 0,
          ...vaultExit({ supplied, borrowed, available }, held?.liquidity ?? 0),
          reallocations: reallocationSummary(legs, r.decimals),
        };
      })
      .filter((x) => x !== null);
    return {
      reserve: r.account,
      market: r.marketName ?? r.market,
      symbol: r.symbol,
      role: r.role,
      supplied,
      borrowed,
      available,
      shareLentOut: supplied > 0 ? borrowed / supplied : null,
      obligationSuppliers: perObligation.length,
      ...conc,
      largestSupplierExit: {
        withdrawableNowShare: largest > 0 ? largestExit.withdrawableNow / largest : null,
        shareLentOutAfter: largestExit.shareLentOutAfter,
      },
      curated,
    };
  })
  .filter((x) => x !== null && x.supplied > 0);

// =============================================================================================== 3. liquidations
const step5bHourly = join(HISTORY_DIR, 'hourly');
const midCache = new Map<string, Map<string, number>>();
const poolMid = (pool: string, hour: string) => {
  if (!midCache.has(pool)) {
    const f = join(step5bHourly, `${pool}.jsonl`);
    const m = new Map<string, number>();
    if (existsSync(f))
      for (const r of readJsonl<{ hour: string; midUsd: number | null }>(f))
        if (r.midUsd) m.set(r.hour, r.midUsd);
    midCache.set(pool, m);
  }
  return midCache.get(pool)?.get(hour) ?? null;
};
type Liq = {
  collateralMint: string;
  collateralSeized: string;
  collateralPrice: number | null;
  priceUnit: string;
  debtMint: string;
  impliedBonus: number | null;
  sales: Array<{
    pool: string;
    mintIn: string;
    mintOut: string;
    amountIn: string;
    realisedPrice: number;
  }>;
};
const liqRows = await rows<{ block_time: string; venue: string; liq: Liq }>(
  sql`select block_time, venue, detail->'liquidation' liq from risk_lending_events where kind = 'liquidation'`,
);
const liqInputs: Array<LiquidationInput & { venue: string; asset: string }> = liqRows.map((r) => {
  const l = r.liq;
  const at = new Date(r.block_time);
  const dec = decimalsOf.get(l.collateralMint) ?? null;
  const units = dec === null ? null : Number(l.collateralSeized) / 10 ** dec;
  const debtIsUsdc = symbolOfMint.get(l.debtMint) === 'USDC' || DOLLAR_MINTS.has(l.debtMint);
  const priceUsd =
    l.collateralPrice === null
      ? null
      : l.priceUnit === 'usd' || (l.priceUnit === 'debt_token' && debtIsUsdc)
        ? l.collateralPrice
        : null;
  const sales = l.sales.filter((s) => s.mintIn === l.collateralMint && DOLLAR_MINTS.has(s.mintOut));
  const soldUnits = sales.reduce((s, x) => s + Number(x.amountIn), 0);
  const realised =
    soldUnits > 0
      ? sales.reduce((s, x) => s + x.realisedPrice * Number(x.amountIn), 0) / soldUnits
      : null;
  const hour = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString();
  const mids = sales
    .map((s) => ({ m: poolMid(s.pool, hour), w: Number(s.amountIn) }))
    .filter((x) => x.m !== null) as Array<{ m: number; w: number }>;
  const midW = mids.reduce((s, x) => s + x.w, 0);
  const mid = midW > 0 ? mids.reduce((s, x) => s + x.m * x.w, 0) / midW : null;
  return {
    venue: r.venue,
    asset: symbolOfMint.get(l.collateralMint) ?? l.collateralMint.slice(0, 6),
    regime: regimeAt(at, RP),
    usd: units !== null && priceUsd !== null ? units * priceUsd : null,
    saleVsOracle: realised !== null && l.collateralPrice ? realised / l.collateralPrice - 1 : null,
    saleVsMid: realised !== null && mid !== null ? realised / mid - 1 : null,
    impliedBonus: l.impliedBonus,
  };
});
const liqByRegime = liquidationTable(liqInputs);
const liqByVenueAsset = [...new Set(liqInputs.map((l) => `${l.venue}|${l.asset}`))].map((k) => {
  const [venue, asset] = k.split('|') as [string, string];
  const t = liquidationTable(liqInputs.filter((l) => l.venue === venue && l.asset === asset)).find(
    (x) => x.regime === 'all',
  );
  return { venue, asset, ...t };
});

// =============================================================================================== 4. oracle vs DEX
type AssetSnap = { assetMint: string; fetchedAt: string; refMidUsd: number | null };
const assetsDir = join(RISK_HOME, 'assets');
const refMid = new Map<string, Array<{ t: number; mid: number }>>();
for (const f of readdirSync(assetsDir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort())
  for (const a of readJsonl<AssetSnap>(join(assetsDir, f)))
    if (a.refMidUsd && a.refMidUsd > 0) {
      const arr = refMid.get(a.assetMint) ?? [];
      arr.push({ t: Date.parse(a.fetchedAt), mid: a.refMidUsd });
      refMid.set(a.assetMint, arr);
    }
const nearestMid = (mint: string, t: number) => {
  const arr = refMid.get(mint);
  if (!arr?.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((arr[m] as { t: number }).t < t) lo = m + 1;
    else hi = m;
  }
  const c = [arr[lo], arr[lo - 1]].filter(Boolean) as Array<{ t: number; mid: number }>;
  const best = c.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return best && Math.abs(best.t - t) <= P.oracleMatchSec * 1000 ? best.mid : null;
};
const oracleObs = new Map<
  string,
  { gaps: number[]; ages: number[]; multipliers: number[]; unit: string }
>();
for (const r of live) {
  let mint: string | undefined;
  let price: number | null = null;
  let unit = '';
  let age: number | null = null;
  let label = '';
  if (r.kind === 'kamino_reserve' && byAccount.get(r.account)?.dexAssetMint) {
    mint = byAccount.get(r.account)?.dexAssetMint as string;
    price = Number(r.scopePriceUsd) || null;
    age = Number(r.scopePriceAgeSec);
    unit = 'USD (Scope)';
    label = `kamino ${r.symbol} @${r.marketName ? String(r.marketName) : String(r.market).slice(0, 8)}`;
  } else if (r.kind === 'jl_vault') {
    mint = String(r.collateralMint);
    price = Number(r.oraclePrice) || null;
    age = Number(r.oraclePriceAgeSec);
    unit = USDC_SYMBOLS.has(String(r.debtSymbol)) ? 'USDC' : String(r.debtSymbol);
    label = `jupiter_lend ${r.symbol}/${r.debtSymbol}`;
  }
  if (!mint || price === null) continue;
  const mid = nearestMid(mint, Date.parse(r.fetchedAt));
  if (mid === null) continue;
  const regime = regimeAt(new Date(r.fetchedAt), RP);
  const k = `${label}|${regime}`;
  const o = oracleObs.get(k) ?? { gaps: [], ages: [], multipliers: [], unit };
  o.gaps.push(price / mid - 1);
  if (age !== null && Number.isFinite(age)) o.ages.push(age);
  if (r.oracleMultiplier) o.multipliers.push(Number(r.oracleMultiplier));
  oracleObs.set(k, o);
}
const oracleSection = [...oracleObs]
  .map(([k, o]) => {
    const [oracle, regime] = k.split('|') as [string, string];
    return {
      oracle,
      unit: o.unit,
      regime,
      ...gapStats(o.gaps),
      medianAgeSec: o.ages.length ? gapStats(o.ages).median : null,
      medianMultiplier: o.multipliers.length ? gapStats(o.multipliers).median : null,
    };
  })
  .sort((a, b) => a.oracle.localeCompare(b.oracle) || a.regime.localeCompare(b.regime));

// =============================================================================================== 5. collateral at risk
// Kamino market rules (close factor, full-liquidation LTV): one read of the 4 market accounts
const marketKeys = [...new Set(kaminoReserves.map((r) => r.market))];
const ma = await multipleAccounts(marketKeys);
const marketRules = new Map(
  marketKeys.map((m) => {
    const acc = ma.accounts.get(m);
    if (!acc) throw new Error(`market ${m} not found`);
    const d = LendingMarket.decode(Buffer.from(acc.data));
    return [
      m,
      {
        closeFactor: d.liquidationMaxDebtCloseFactorPct / 100,
        fullLiqLtv: d.insolvencyRiskUnhealthyLtvPct / 100,
        maxLiquidatableDebtUsdAtOnce: Number(d.maxLiquidatableDebtMarketValueAtOnce.toString()),
        minFullLiquidationUsd: Number(d.minFullLiquidationValueThreshold.toString()),
        slot: ma.slot,
        bytes: Buffer.from(acc.data).toString('base64'),
      },
    ];
  }),
);
const marketReadAt = new Date().toISOString();

const gapPositions: GapPosition[] = [];
let unpriced = 0;
let stateUnknown = 0;
const bonusRanges: Array<Record<string, unknown>> = [];
for (const r of kaminoReserves.filter((r) => r.dexAssetMint)) {
  const p = params(r);
  if (p.minLiquidationBonusBps !== p.maxLiquidationBonusBps)
    bonusRanges.push({
      reserve: r.account,
      symbol: r.symbol,
      market: r.marketName,
      min: p.minLiquidationBonusBps,
      max: p.maxLiquidationBonusBps,
    });
}
for (const o of obligations) {
  if (!(o.debtUsd && o.debtUsd > 0)) continue;
  const rules = marketRules.get(o.market);
  if (!rules) continue;
  const deposits: GapDeposit[] = [];
  let ok = true;
  for (const d of o.deposits) {
    if (!(d.amount && d.amount > 0)) continue;
    const reg = byAccount.get(d.reserve);
    const st = reserveRow.get(d.reserve);
    if (d.usd === null || !reg || !st) {
      ok = false;
      break;
    }
    deposits.push({
      asset: d.symbol,
      usd: d.usd,
      liqThreshold: Number(st.liquidationThresholdPct) / 100,
      liqBonus: (params(reg).maxLiquidationBonusBps as number) / 10_000,
      liqBonusMin: (params(reg).minLiquidationBonusBps as number) / 10_000,
      stock: reg.dexAssetMint !== null,
    });
  }
  if (!ok || o.debtUsd === null) {
    unpriced++;
    continue;
  }
  gapPositions.push({
    deposits,
    debtUsd: o.debtUsd,
    closeFactor: rules.closeFactor,
    fullLiqLtv: rules.fullLiqLtv,
  });
}
for (const p of jlPositions) {
  if (!(p.debt > 0)) continue;
  if (p.liquidatedBranch) {
    stateUnknown++;
    continue;
  }
  const v = vaultRowById.get(p.vaultId);
  if (!v || !Number(v.oraclePrice)) {
    unpriced++;
    continue;
  }
  gapPositions.push({
    deposits: [
      {
        asset: String(v.symbol),
        usd: p.collateral * Number(v.oraclePrice),
        liqThreshold: Number(v.liquidationThreshold),
        liqBonus: Number(v.liquidationPenalty),
        stock: true,
      },
    ],
    debtUsd: p.debt,
    closeFactor: P.jlCloseFactor,
    fullLiqLtv: Number(
      byAccount.get(String(v.account))?.params
        ? params(byAccount.get(String(v.account)) as { params: unknown }).liquidationMaxLimit
        : 1,
    ),
  });
}

// routed sell curves, latest per asset and regime
const curveRows = await rows<{
  asset_mint: string;
  regime: Regime;
  points: DepthCurve['points'];
  insufficient_from: number | null;
  quantile: number;
  min_samples: number;
  samples: number;
  data_from: string | null;
  data_to: string | null;
}>(sql`select distinct on (asset_mint, regime) asset_mint, regime, points, insufficient_from, quantile,
  min_samples, samples, data_from, data_to from risk_depth_curves
  where side = 'sell' and method_version = 'risk-0.3' order by asset_mint, regime, computed_at desc`);
const curvesOf = new Map<string, AssetCurves>();
for (const c of curveRows) {
  const a = curvesOf.get(c.asset_mint) ?? { assetId: c.asset_mint, byRegime: {} };
  a.byRegime[c.regime] = {
    points: c.points,
    insufficientFrom: c.insufficient_from,
    quantile: c.quantile,
    minSamples: c.min_samples,
    from: c.data_from,
    to: c.data_to,
    samples: c.samples,
  };
  curvesOf.set(c.asset_mint, a);
}
// weekend depth ratio per asset from Step 5b's hourly rows (the routed curves have no weekend yet)
const depthRows = new Map<string, Array<{ hour: string; regime: Regime; depthUsd: number }>>();
if (existsSync(step5bHourly))
  for (const f of readdirSync(step5bHourly).filter((f) => f.endsWith('.jsonl')))
    for (const r of readJsonl<{
      asset: string;
      hour: string;
      regime: Regime;
      depth2pctSellUsd: number | null;
    }>(join(step5bHourly, f)))
      if (r.depth2pctSellUsd !== null) {
        const a = depthRows.get(r.asset) ?? [];
        a.push({ hour: r.hour, regime: r.regime, depthUsd: r.depth2pctSellUsd });
        depthRows.set(r.asset, a);
      }
const weekendRatio = new Map([...depthRows].map(([a, rs]) => [a, weekendDepthRatio(rs)]));

const atRisk = P.gapGridPct.map((g) => {
  const sim = lendingGapSim(gapPositions, g, P.bandPct);
  return {
    ...sim,
    byAsset: sim.byAsset.map((a) => {
      const mint = xstockMintOf.get(a.asset);
      const curves = mint ? curvesOf.get(mint) : undefined;
      const regimes = curves ? (Object.keys(curves.byRegime) as Regime[]) : [];
      const wr = weekendRatio.get(a.asset);
      const cap =
        curves && a.minBonus !== null
          ? saleCapacity(
              curves,
              regimes,
              a.minBonus,
              wr ? { ratio: wr.ratio, from: 'us_market_hours' } : null,
            )
          : null;
      return {
        ...a,
        tau: a.minBonus,
        capacityUsd: cap?.capacityUsd ?? null,
        capacityRegime: cap?.regime ?? null,
        capacityDerived: cap?.derived ?? null,
        capacityLowerBound: cap?.lowerBound ?? null,
        regimesMeasured: regimes,
        coverageRatio: cap ? coverageRatio(cap.capacityUsd, a.seizedUsd) : null,
        coverageOfAllLiquidatable: cap
          ? coverageRatio(cap.capacityUsd, a.liquidatableCollateralUsd)
          : null,
      };
    }),
  };
});

// =============================================================================================== output
const report = {
  method: METHOD,
  source:
    'risk_lending_pools/_snapshots/_events (item 8), ~/.colosseum/risk lending + lending-positions + assets, risk_depth_curves (risk-0.3), data/risk/history-full/hourly (Step 5b), lending decode pass reallocations, Kamino market accounts (Solana RPC getMultipleAccounts, klend-sdk LendingMarket.decode)',
  fetched_at: generatedAt.toISOString(),
  provenance: 'live',
  params: P,
  windows: {
    liveFrom,
    liveTo,
    positionsHour: posHour,
    positionsFetchedAt: posFetchedAt,
    obligations: obligations.length,
    jlPositions: jlPositions.length,
  },
  pools: { rows: poolsSection, jupiterLendLiquidityLayer: jlLayer },
  lenders: {
    rows: lenders,
    notMeasured:
      'Jupiter Lend lenders (liquidity-layer supply positions) are not read by the collector; Kamino cTokens held outside obligations and curated vaults are `unattributedShare`.',
  },
  liquidations: {
    byRegime: liqByRegime,
    byVenueAsset: liqByVenueAsset,
    note: 'USD at the collateral price the program used (Kamino: USD; Jupiter Lend: debt token, USD only for USDC debt, else usdMissing). saleVsMid needs the sale pool in Step 5b’s hourly window (value pools, from 2026-09-04); saleVsOracle uses the program’s own price.',
  },
  oracleVsDex: {
    rows: oracleSection,
    note: 'lending oracle price over the routed reference pool mid (risk_asset_snapshots refMidUsd) within oracleMatchSec; Jupiter Lend prices are in the vault debt token',
  },
  collateralAtRisk: {
    scenario:
      'every xStock gaps down by g at once; stablecoin and other collateral keep their value; positions of the hour',
    positions: gapPositions.length,
    positionsUnpriced: unpriced,
    positionsStateUnknown: stateUnknown,
    marketRules: Object.fromEntries(
      [...marketRules].map(([m, r]) => [m, { ...r, bytes: undefined, readAt: marketReadAt }]),
    ),
    kaminoStockReservesWithBonusRange: bonusRanges,
    weekendDepthRatio: Object.fromEntries(weekendRatio),
    grid: atRisk,
    assumptions: [
      'positions and prices of the latest complete collector hour; Kamino thresholds from that run’s reserve rows; Kamino seizures at the reserve maxLiquidationBonusBps, sale-cost tolerance at its minLiquidationBonusBps (the bonus at the threshold; it rises with how unhealthy the position is); Jupiter Lend threshold, penalty and liquidationMaxLimit from the vault row',
      'Kamino close factor and full-liquidation LTV from the market account (liquidationMaxDebtCloseFactorPct, insolvencyRiskUnhealthyLtvPct); one liquidation round, as gapSim; repeated rounds are bounded by `liquidatableCollateralUsd`',
      `Jupiter Lend: closeFactor ${P.jlCloseFactor} (policy input; the program liquidates by tick range), positions above liquidationMaxLimit treated as liquidated, not absorbed; liquidated-branch positions skipped (counted)`,
      'Jupiter Lend debt valued at par (USDC and JupUSD); collateral at the vault oracle price in the debt token',
      'Kamino borrow factors and elevation-group overrides not applied (thresholds of each deposit’s own reserve)',
      'seized collateral taken from xStock deposits first, pro rata; sold in one block at the routed sell curve; capacity in USD unchanged by the gap',
      'capacity = routed sell capacity at cost ≤ the smallest sale-cost tolerance (bonus at the threshold) among this asset’s seizures, in the worst measured regime; when lower, the weekend capacity derived as US-market-hours capacity × Step 5b weekend/market-hours median ±2% sell depth (`capacityDerived`)',
      `no oracle band (bandPct ${P.bandPct}); Kamino maxLiquidatableDebtMarketValueAtOnce caps one liquidation, not the total`,
    ],
  },
};
const json = JSON.stringify(report, null, 1);
const leaks = [...privateAddresses].filter((a) => json.includes(a));
const file = join(OUT, `lending-report-${STAMP}.json`);
writeFileSync(file, json);

// ----------------------------------------------------------------------------------------------- print
console.log(`lending report ${METHOD} — ${generatedAt.toISOString()}`);
console.log(
  `live rows ${liveFrom} → ${liveTo}; positions hour ${posHour} (${obligations.length} obligations, ${jlPositions.length} Jupiter Lend positions)`,
);
table(
  `1. Pools — history, events, hours with > ${P.utilAlarmPct}% lent out`,
  poolsSection
    .filter((p) => p.role !== 'collateral' || p.eventsTotal > 0)
    .map((p) => ({
      pool: `${p.symbol} ${p.role}`,
      market: String(p.market).slice(0, 26),
      from: p.historyFrom ? String(p.historyFrom).slice(0, 10) : '—',
      hours: p.historyHours,
      events: p.eventsTotal,
      liq: p.events.liquidation ?? 0,
      config: p.configChanges,
      alarmHist: p.alarmHistory
        ? `${pct(p.alarmHistory.share)} (${p.alarmHistory.above}/${p.alarmHistory.n})`
        : '—',
      maxHist: p.alarmHistory ? pct(p.alarmHistory.max) : '—',
      alarm5m: p.alarmLive5m
        ? `${pct(p.alarmLive5m.share)} (${p.alarmLive5m.above}/${p.alarmLive5m.n})`
        : '—',
    })),
);
table(
  'Jupiter Lend liquidity layer (live 5-minute rows only, D12)',
  jlLayer.map((l) => ({ token: l.symbol, rows: l.n, alarm: pct(l.share), max: pct(l.max) })),
);
table(
  '2. Lenders — supplier concentration (aggregates; curated vaults named)',
  lenders.map((l) => ({
    reserve: `${l?.symbol} ${String(l?.market).slice(0, 22)}`,
    supplied: l?.supplied.toFixed(0),
    lentOut: pct(l?.shareLentOut),
    suppliers: l?.suppliers,
    top1: pct((l as Record<string, unknown> | null)?.top1 as number),
    top3: pct((l as Record<string, unknown> | null)?.top3 as number),
    top10: pct((l as Record<string, unknown> | null)?.top10 as number),
    unattributed: pct(l?.unattributedShare),
    top1CanLeave: pct(l?.largestSupplierExit.withdrawableNowShare),
    lentOutAfter: pct(l?.largestSupplierExit.shareLentOutAfter),
  })),
);
table(
  'Curated vaults in our reserves — share, exit, past reallocations',
  lenders.flatMap((l) =>
    (l?.curated ?? []).map((c) => ({
      vault: String(c.vault).slice(0, 24),
      reserve: `${l?.symbol} ${String(l?.market).slice(0, 18)}`,
      share: pct(c.shareOfSupply, 2),
      lentOutNow: pct(c.shareLentOutNow),
      ifItLeaves: pct(c.shareLentOutAfter),
      stuck: (c.stuck ?? 0).toFixed(0),
      reallocs: `${c.reallocations.ins} in / ${c.reallocations.outs} out`,
      largestOut: c.reallocations.largestOut
        ? `${c.reallocations.largestOut.ui.toFixed(0)} ${c.reallocations.largestOut.at.slice(0, 10)}`
        : '—',
    })),
  ),
);
table(
  '3. Liquidations by regime (sale = same-transaction DEX sale of the seized stock)',
  liqByRegime.map((t) => ({
    regime: t.regime,
    count: t.count,
    usd: usd(t.usd),
    noUsd: t.usdMissing,
    largest: usd(t.largestUsd),
    withSale: t.withSale,
    saleVsOracle: t.saleVsOracle.n
      ? `${pct(t.saleVsOracle.median, 2)} (p05 ${pct(t.saleVsOracle.p05, 2)})`
      : '—',
    saleVsMid: t.saleVsMid.n ? `${pct(t.saleVsMid.median, 2)} n=${t.saleVsMid.n}` : '—',
    bonus: pct(t.impliedBonus.median, 2),
  })),
);
table(
  'Liquidations by venue and asset',
  liqByVenueAsset.map((t) => ({
    venue: t.venue,
    asset: t.asset,
    count: t.count,
    usd: usd(t.usd),
    largest: usd(t.largestUsd),
    saleVsOracle: t.saleVsOracle?.n ? pct(t.saleVsOracle.median, 2) : '—',
  })),
);
table(
  '4. Oracle against DEX mid (5-minute rows)',
  oracleSection.map((o) => ({
    oracle: o.oracle.slice(0, 40),
    unit: o.unit,
    regime: o.regime,
    n: o.n,
    median: pct(o.median, 2),
    p05: pct(o.p05, 2),
    p95: pct(o.p95, 2),
    maxAbs: pct(o.maxAbs, 2),
    ageSec: o.medianAgeSec?.toFixed(0) ?? '—',
    mult: o.medianMultiplier?.toFixed(4) ?? '—',
  })),
);
table(
  '5. Collateral at risk — liquidation coverage ratio (capacity at cost ≤ bonus ÷ seized)',
  atRisk.flatMap((g) =>
    g.byAsset.map((a) => ({
      gap: `${g.gapPct}%`,
      asset: a.asset,
      positions: a.positions,
      liquidatable: usd(a.liquidatableCollateralUsd),
      seized: usd(a.seizedUsd),
      tau: pct(a.tau),
      byBonus: Object.entries(a.seizedByBonusBps)
        .map(([b, v]) => `${Number(b) / 100}%:${usd(v)}`)
        .join(' '),
      capacity: `${usd(a.capacityUsd)}${a.capacityLowerBound ? '+' : ''}`,
      regime: `${a.capacityRegime ?? '—'}${a.capacityDerived ? '*' : ''}`,
      ratio: a.coverageRatio === null ? '—' : a.coverageRatio.toFixed(2),
      ratioAll: a.coverageOfAllLiquidatable === null ? '—' : a.coverageOfAllLiquidatable.toFixed(2),
    })),
  ),
);
table(
  'Totals per gap',
  atRisk.map((g) => ({
    gap: `${g.gapPct}%`,
    positions: g.positionsLiquidatable,
    debt: usd(g.liquidatableDebtUsd),
    repay: usd(g.repayUsd),
    seized: usd(g.seizedUsd),
    badDebt: usd(g.badDebtUsd),
  })),
);
console.log(
  '\n* derived weekend capacity; + capacity beyond the top of the measured grid (lower bound)',
);
console.log(
  `\nprivate addresses checked: ${privateAddresses.size}; found in the report: ${leaks.length}`,
);
console.log(`→ ${file}`);
await client.end();
if (leaks.length) process.exit(1);
