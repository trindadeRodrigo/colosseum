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
  bestRoute,
  buildLendingPoolFacts,
  costAt,
  coverageRatio,
  type DepthCurve,
  defaultLendingReportParams,
  defaultRegimeParams,
  type GapDeposit,
  type GapPosition,
  gapStats,
  type IssuerModel,
  type LendingCollateralInput,
  type LiquidationInput,
  lendingGapSim,
  liquidationCapacity,
  liquidationRoutes,
  liquidationTable,
  type ObservedLiquidation,
  type OracleGapObs,
  observedLiquidation,
  observedRoutes,
  observedSale,
  quantileOf,
  REGIMES,
  type Read,
  type ReallocationLeg,
  type Regime,
  reallocationSummary,
  regimeAt,
  type Supplier,
  saleCapacity,
  supplierConcentration,
  variation,
  vaultExit,
  weekendDepthRatio,
} from '@colosseum/risk';
import { collectFacts, LendingPoolFacts, type LiquidationRoute } from '@colosseum/schemas';
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
// PLAN-ANALYTICS item 8 adds sections 6 and 7: the liquidation routes compared (margin per route, size and regime,
// `packages/risk/src/lending/route.ts`) and the coverage ratio on the liquidator's margin beside the earlier one.
// Item 9 adds section 8: the routes liquidations actually took, from the decoded events (no new fetch).
// Output: data/risk/lending-history/report/lending-report-<stamp>.json, and the tables printed.

const METHOD = 'lending-report-0.2';
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
  liquidator?: string;
  position?: string;
  otherPrograms: string[];
  sales: Array<{
    pool: string;
    venue: string;
    mintIn: string;
    mintOut: string;
    amountIn: string;
    realisedPrice: number;
  }>;
};
const liqRows = await rows<{ block_time: string; venue: string; market: string | null; liq: Liq }>(
  sql`select block_time, venue, market, detail->'liquidation' liq from risk_lending_events where kind = 'liquidation'`,
);
// liquidators and liquidated positions are wallets: none may reach the output (DA4)
for (const r of liqRows)
  for (const a of [r.liq.liquidator, r.liq.position]) if (a) privateAddresses.add(a);
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
  { gaps: number[]; ages: number[]; multipliers: number[]; unit: string; from: string; to: string }
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
  const o = oracleObs.get(k) ?? {
    gaps: [],
    ages: [],
    multipliers: [],
    unit,
    from: r.fetchedAt,
    to: r.fetchedAt,
  };
  o.gaps.push(price / mid - 1);
  if (r.fetchedAt < o.from) o.from = r.fetchedAt;
  if (r.fetchedAt > o.to) o.to = r.fetchedAt;
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
// the oracle labels of section 4, so a seizure is priced at its own venue's oracle gap (item 8)
const kaminoOracle = (st: LiveRow) =>
  `kamino ${st.symbol} @${st.marketName ? String(st.marketName) : String(st.market).slice(0, 8)}`;
const jlOracle = (v: LiveRow) => `jupiter_lend ${v.symbol}/${v.debtSymbol}`;

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
      oracle: kaminoOracle(st),
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
        oracle: jlOracle(v),
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
    from: c.data_from ? new Date(c.data_from).toISOString() : null,
    to: c.data_to ? new Date(c.data_to).toISOString() : null,
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

// =============================================================================================== 6. liquidation routes
// PLAN-ANALYTICS item 8. Each venue oracle's median gap to the routed reference mid, by regime (section 4's rows).
const oracleGaps = new Map<string, Partial<Record<Regime, OracleGapObs>>>();
for (const [k, o] of oracleObs) {
  const [oracle, regime] = k.split('|') as [string, Regime];
  const median = gapStats(o.gaps).median;
  if (median === null) continue;
  const m = oracleGaps.get(oracle) ?? {};
  m[regime] = {
    value: median,
    samples: o.gaps.length,
    fetchedAt: o.to,
    dataFrom: o.from,
    source: 'lending collector 5-minute rows (venue oracle) against risk_asset_snapshots refMidUsd',
    method: `median(oracle / routed reference mid − 1), matched within ${P.oracleMatchSec}s`,
    methodVersion: METHOD,
    provenance: 'live',
  };
  oracleGaps.set(oracle, m);
}
const curveMeta = {
  source: 'risk_depth_curves (risk-0.3, routed sale across dollar and SOL pools)',
  method: 'routed_greedy_32_chunks',
  methodVersion: 'risk-0.3',
  provenance: 'live' as const,
};
const gapOf = (oracle: string) =>
  Object.fromEntries(
    Object.entries(oracleGaps.get(oracle) ?? {}).map(([r, o]) => [r, (o as OracleGapObs).value]),
  ) as Partial<Record<Regime, number>>;
// two-hop exits: pools pairing the stock with a token the collector does not price (registry, tiers A and B)
const twoHopRows = await rows<{ asset_mint: string; pools: string; tvl: number | null }>(
  sql`select asset_mint, count(*) pools, sum(tvl_usd) tvl from risk_pools
  where exit_path in ('other', 'via_xstock') and tier in ('A', 'B') group by asset_mint`,
);
const twoHopOf = new Map(
  twoHopRows.map((r) => [r.asset_mint, { pools: Number(r.pools), tvlUsd: Number(r.tvl ?? 0) }]),
);
const issuerFile = JSON.parse(readFileSync('fixtures/risk/issuer-models.json', 'utf8')) as {
  fetchedAt: string;
  models: Record<string, IssuerModel>;
};
const xstocksIssuer = issuerFile.models.xstocks
  ? { ...issuerFile.models.xstocks, fetchedAt: issuerFile.fetchedAt }
  : null;
const ROUTE_SIZES = [10_000, 100_000, 1_000_000];
// every (asset, oracle) seized at some gap of the grid, with the smallest bonus its liquidators earn
const seizedOracles = new Map<string, { asset: string; oracle: string; bonus: number }>();
for (const g of atRisk)
  for (const a of g.byAsset)
    for (const [oracle, o] of Object.entries(a.byOracle)) {
      const k = `${a.asset}|${oracle}`;
      const prev = seizedOracles.get(k);
      seizedOracles.set(k, {
        asset: a.asset,
        oracle,
        bonus: prev ? Math.min(prev.bonus, o.minBonus) : o.minBonus,
      });
    }
const routesSection = [...seizedOracles.values()]
  .sort((a, b) => a.asset.localeCompare(b.asset) || a.oracle.localeCompare(b.oracle))
  .map(({ asset, oracle, bonus }) => {
    const mint = xstockMintOf.get(asset);
    const curves = mint ? (curvesOf.get(mint) ?? null) : null;
    const wr = weekendRatio.get(asset);
    const cap = curves
      ? liquidationCapacity(
          curves,
          Object.keys(curves.byRegime) as Regime[],
          { bonus, oracleGap: gapOf(oracle), minMargin: P.minLiquidatorMarginPct / 100 },
          wr ? { ratio: wr.ratio, from: 'us_market_hours' } : null,
        )
      : null;
    return {
      asset,
      oracle,
      bonus,
      oracleGap: oracleGaps.get(oracle) ?? {},
      capacity: cap,
      byRegime: REGIMES.map((regime) => ({
        regime,
        bySize: ROUTE_SIZES.map((seizedUsd) => {
          const routes: LiquidationRoute[] = liquidationRoutes({
            regime,
            seizedUsd,
            bonus,
            oracleGap: oracleGaps.get(oracle) ?? {},
            curves,
            curveMeta,
            twoHop: (mint && twoHopOf.get(mint)) || { pools: 0, tvlUsd: 0 },
            issuer: xstocksIssuer,
          });
          return { seizedUsd, best: bestRoute(routes)?.route ?? null, routes };
        }),
      })),
    };
  });

// =============================================================================================== 7. coverage, both
// The earlier ratio (section 5, unchanged) beside the ratio on the liquidator's margin: per asset, the smallest
// capacity among the venue oracles whose positions are seized at that gap.
const coverageBoth = atRisk.flatMap((g) =>
  g.byAsset.map((a) => {
    const mint = xstockMintOf.get(a.asset);
    const curves = mint ? curvesOf.get(mint) : undefined;
    const wr = weekendRatio.get(a.asset);
    const perOracle = Object.entries(a.byOracle).map(([oracle, o]) => ({
      oracle,
      seizedUsd: o.seizedUsd,
      bonus: o.minBonus,
      ...(curves
        ? liquidationCapacity(
            curves,
            Object.keys(curves.byRegime) as Regime[],
            {
              bonus: o.minBonus,
              oracleGap: gapOf(oracle),
              minMargin: P.minLiquidatorMarginPct / 100,
            },
            wr ? { ratio: wr.ratio, from: 'us_market_hours' } : null,
          )
        : { worst: null, byRegime: [], missing: [] }),
    }));
    const priced = perOracle.filter((o) => o.worst !== null);
    const limiting = priced.reduce<(typeof priced)[number] | null>(
      (w, o) => (!w || (o.worst?.capacityUsd as number) < (w.worst?.capacityUsd as number) ? o : w),
      null,
    );
    const capacityUsd = limiting?.worst?.capacityUsd ?? null;
    return {
      gapPct: g.gapPct,
      asset: a.asset,
      seizedUsd: a.seizedUsd,
      earlier: { capacityUsd: a.capacityUsd, regime: a.capacityRegime, ratio: a.coverageRatio },
      margin: {
        capacityUsd,
        regime: limiting?.worst?.regime ?? null,
        derived: limiting?.worst?.derived ?? null,
        lowerBound: limiting?.worst?.lowerBound ?? null,
        tau: limiting?.worst?.tau ?? null,
        limitingOracle: limiting?.oracle ?? null,
        ratio: capacityUsd === null ? null : coverageRatio(capacityUsd, a.seizedUsd),
        reason:
          capacityUsd === null ? (curves ? 'no_samples_in_regime' : 'not_collected') : undefined,
        oraclesNotPriced: perOracle.filter((o) => o.worst === null).map((o) => o.oracle),
        regimesMissing: [
          ...new Set(perOracle.flatMap((o) => o.missing.map((m) => `${m.regime}:${m.reason}`))),
        ],
      },
      perOracle: perOracle.map((o) => ({
        oracle: o.oracle,
        seizedUsd: o.seizedUsd,
        bonus: o.bonus,
        worst: o.worst,
        missing: o.missing,
      })),
    };
  }),
);

// =============================================================================================== 8. observed routes
// PLAN-ANALYTICS item 9. The same liquidation rows as section 3, followed into the registry pools that sold the
// seized collateral in the same transaction. The simulated sale is compared where the routed curve of the
// liquidation's regime covers its time and a reference mid was read within oracleMatchSec.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const AGGREGATORS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
]);
const observedCtx = {
  decimalsOf: (m: string) => decimalsOf.get(m) ?? null,
  symbolOf: (m: string) => symbolOfMint.get(m) ?? null,
  dollarMints: DOLLAR_MINTS,
  solMint: SOL_MINT,
  aggregators: AGGREGATORS,
  regimeOf: (at: Date) => regimeAt(at, RP),
  poolMid,
};
const observedRows: ObservedLiquidation[] = liqRows.map((r) => {
  const l = r.liq;
  const at = new Date(r.block_time);
  const row = observedLiquidation(
    { blockTime: r.block_time, venue: r.venue, liq: { ...l, market: r.market ?? undefined } },
    observedCtx,
  );
  const sales = row.sales;
  if (!sales.length) return row;
  const o = observedSale(row);
  const curve = curvesOf.get(l.collateralMint)?.byRegime[row.regime];
  const mid = nearestMid(l.collateralMint, at.getTime());
  const covered =
    curve?.from && curve.to && row.at >= String(curve.from) && row.at <= String(curve.to);
  let simulated: ObservedLiquidation['simulated'];
  if (!curve) simulated = { reason: 'no_samples_in_regime' };
  else if (!covered) simulated = { reason: 'before_routed_curves' };
  else if (mid === null || o.realisedUsd === null) simulated = { reason: 'no_reference_mid' };
  else {
    const c = costAt(curve, o.soldUnits * mid);
    simulated =
      c === null
        ? { reason: 'beyond_measured_size' }
        : { simulatedRecovered: 1 - c, observedRecovered: o.realisedUsd / mid };
  }
  return { ...row, simulated };
});
const observed = observedRoutes(observedRows, P.sizeBucketsUsd);
const observedTotals = {
  liquidations: observedRows.length,
  followed: observedRows.filter((r) => r.sales.length).length,
  notFollowed: observedRows.filter((r) => !r.sales.length).length,
  notFollowedWithAggregator: observedRows.filter((r) => !r.sales.length && r.aggregator).length,
  from: observedRows.map((r) => r.at).sort()[0] ?? null,
  to:
    observedRows
      .map((r) => r.at)
      .sort()
      .at(-1) ?? null,
  routedCurvesFrom:
    [...curvesOf.values()]
      .flatMap((a) => Object.values(a.byRegime).map((c) => c?.from))
      .filter((t): t is string => !!t)
      .map(String)
      .sort()[0] ?? null,
};

// =============================================================================================== 9. lending pool facts
// PLAN-ANALYTICS item 10. One LendingPoolFacts sheet per lending pool a lender supplies into: each Kamino debt reserve
// (its market's stock collateral) and each Jupiter Lend vault (its lenders are the liquidity layer of its debt token).
// Built from this run's rows; item 11 imports the sheets so the API serves them.
const SHEET_ROUTE_SIZE_USD = 100_000;
const RATE_WINDOW_DAYS = 30;
const RATE_MIN_SAMPLES = 24;
const reportMeta = { method: METHOD, methodVersion: METHOD };
const latestRows = await rows<{
  account: string;
  kind: string;
  observed_at: string;
  supplied: number | null;
  borrowed: number | null;
  available: number | null;
  share_lent_out: number | null;
  supply_apy: number | null;
  borrow_apy: number | null;
  price_usd: number | null;
  supplied_usd: number | null;
  detail: Record<string, unknown>;
  source: string;
  method: string;
  method_version: string;
}>(sql`select distinct on (account, kind) account, kind, observed_at, supplied, borrowed, available, share_lent_out,
  supply_apy, borrow_apy, price_usd, supplied_usd, detail, source, method, method_version from risk_lending_snapshots
  where kind in ('kamino_reserve', 'jl_vault', 'jl_liquidity') order by account, kind, observed_at desc`);
const latestOf = (account: string, kind: string) =>
  latestRows.find((r) => r.account === account && r.kind === kind) ?? null;
const rateSeries = await rows<{
  account: string;
  kind: string;
  xs: number[];
  from: string;
  to: string;
}>(
  sql`select account, kind, array_agg(supply_apy order by observed_at) xs, min(observed_at) "from", max(observed_at) "to"
  from risk_lending_snapshots where supply_apy is not null and kind in ('kamino_reserve_hourly')
  and observed_at > now() - make_interval(days => ${RATE_WINDOW_DAYS}) group by account, kind`,
);
const posLatest = await rows<{
  market: string;
  collateral_asset: string;
  observed_at: string;
  collateral_usd: number | null;
  usd_null_reason: string | null;
  source: string;
  method: string;
  method_version: string;
}>(sql`select distinct on (market, collateral_asset) market, collateral_asset, observed_at, collateral_usd,
  usd_null_reason, source, method, method_version from risk_lending_positions
  order by market, collateral_asset, observed_at desc`);
const paramChanges = await rows<{ market: string; n: string }>(
  sql`select market, count(*) n from risk_lending_events where kind = 'config_change'
  and ix not like 'updateReserveAllocation%' and block_time > now() - interval '30 days' group by market`,
);
const socialised = await rows<{ market: string; n: string }>(
  sql`select market, count(*) n from risk_lending_events where kind = 'socialize_loss' group by market`,
);
const iso = (t: string | Date) => new Date(t).toISOString();
const read = (
  value: number | null | undefined,
  meta: {
    source: string;
    method: string;
    methodVersion: string;
    fetchedAt: string;
    dataFrom?: string;
    samples?: number;
  },
  reason: Read extends infer R
    ? R extends { reason: infer Q }
      ? Q
      : never
    : never = 'not_collected',
  detail?: string,
): Read =>
  value === null || value === undefined || !Number.isFinite(value)
    ? { reason, ...(detail ? { detail } : {}) }
    : { value, provenance: 'live', ...meta };
const fromSnap = (r: (typeof latestRows)[number]) => ({
  source: `risk_lending_snapshots (${r.kind}; ${r.source})`,
  method: r.method,
  methodVersion: r.method_version,
  fetchedAt: iso(r.observed_at),
});
const fromReport = (source: string, fetchedAt: string) => ({
  source,
  ...reportMeta,
  fetchedAt,
});
const posAt = posFetchedAt ? iso(posFetchedAt) : generatedAt.toISOString();

/** Stock collateral of one oracle (a Kamino collateral reserve or a Jupiter Lend vault), as a sheet input. */
function collateralInput(c: {
  asset: string;
  market: string;
  oracle: string;
  threshold: number | null;
  bonus: number | null;
  thresholdMeta: { source: string; method: string; methodVersion: string; fetchedAt: string };
  bonusMeta: { source: string; method: string; methodVersion: string; fetchedAt: string };
}): LendingCollateralInput {
  const pos = posLatest.find((p) => p.market === c.market && p.collateral_asset === c.asset);
  const mint = xstockMintOf.get(c.asset);
  const curves = mint ? (curvesOf.get(mint) ?? null) : null;
  const gaps = oracleGaps.get(c.oracle) ?? {};
  const cov = coverageBoth.filter((x) => x.asset === c.asset);
  const covSource = fromReport(
    `lending report section 7 (coverage on the liquidator's margin; positions hour ${posHour}, all markets: the pools share the DEX)`,
    posAt,
  );
  const obs = observedRows.filter((o) => o.market === c.market && o.asset === c.asset);
  const followed = obs.filter((o) => o.sales.length);
  const vsMid = followed
    .map((o) => observedSale(o).saleVsMid)
    .filter((x): x is number => x !== null);
  const obsMeta = fromReport(
    'risk_lending_events (liquidations, Step 10b decode pass) and Step 5b hourly pool mids',
    observedTotals.to ?? generatedAt.toISOString(),
  );
  return {
    asset: c.asset,
    collateralUsd: pos
      ? read(
          pos.collateral_usd,
          {
            source: `risk_lending_positions (${pos.source})`,
            method: pos.method,
            methodVersion: pos.method_version,
            fetchedAt: iso(pos.observed_at),
          },
          'no_reference_price',
          pos.usd_null_reason ?? undefined,
        )
      : { reason: 'not_imported', detail: 'no positions row for this market and asset' },
    liquidationThreshold: read(c.threshold, c.thresholdMeta),
    liquidationBonus: read(c.bonus, c.bonusMeta),
    oracleGap: gaps,
    coverageByGap: P.gapGridPct.map((gapPct) => {
      const row = cov.find((x) => x.gapPct === gapPct);
      if (!row)
        return {
          gapPct,
          ratio: {
            reason: 'not_applicable' as const,
            detail: 'no position is liquidated at this gap',
          },
        };
      const m = row.margin;
      return {
        gapPct,
        ratio:
          m.ratio === null
            ? {
                reason: (m.reason ?? 'no_samples_in_regime') as
                  | 'no_samples_in_regime'
                  | 'not_collected',
              }
            : {
                value: m.ratio,
                ...covSource,
                provenance: 'live' as const,
                ...(m.regime ? { regime: m.regime } : {}),
                lowerBound: m.lowerBound === true,
              },
      };
    }),
    regimesMissing: [
      ...new Set(cov.flatMap((x) => x.margin.regimesMissing.map((k) => k.split(':')[0] as Regime))),
    ],
    routes: REGIMES.flatMap((regime) =>
      c.bonus === null
        ? []
        : liquidationRoutes({
            regime,
            seizedUsd: SHEET_ROUTE_SIZE_USD,
            bonus: c.bonus,
            oracleGap: gaps,
            curves,
            curveMeta,
            twoHop: (mint && twoHopOf.get(mint)) || { pools: 0, tvlUsd: 0 },
            issuer: xstocksIssuer,
          }),
    ),
    observed: {
      liquidations: { value: obs.length, provenance: 'live', ...obsMeta },
      soldInSameTxShare: obs.length
        ? {
            value: followed.length / obs.length,
            provenance: 'live',
            ...obsMeta,
            samples: obs.length,
          }
        : { reason: 'not_applicable', detail: 'no liquidation of this collateral here' },
      realisedVsMid: vsMid.length
        ? { value: quantileOf(vsMid, 0.5), provenance: 'live', ...obsMeta, samples: vsMid.length }
        : followed.length
          ? {
              reason: 'not_collected',
              detail: 'Step 5b pool mids start 2026-09-04; no followed sale since is in its pools',
            }
          : { reason: obs.length ? 'not_followed' : 'not_applicable' },
    },
  };
}

const marketHistory = (market: string, venue: string) => {
  const liqs = observedRows.filter((o) => o.market === market);
  const usdKnown = liqs.filter((o) => o.seizedUsd !== null);
  const meta = fromReport(
    'risk_lending_events (Step 10b decode pass)',
    observedTotals.to ?? generatedAt.toISOString(),
  );
  const pc = paramChanges.find((x) => x.market === market);
  const soc = socialised.find((x) => x.market === market);
  return {
    liquidations: { value: liqs.length, provenance: 'live' as const, ...meta },
    liquidatedUsd: {
      value: usdKnown.reduce((s, o) => s + (o.seizedUsd as number), 0),
      provenance: 'live' as const,
      ...meta,
      samples: usdKnown.length,
      lowerBound: usdKnown.length < liqs.length,
    },
    socialisedLossUsd:
      venue === 'kamino' && !soc
        ? {
            value: 0,
            provenance: 'live' as const,
            ...meta,
            method: 'socialize_loss events (none decoded)',
          }
        : {
            reason: 'not_collected' as const,
            detail:
              venue === 'kamino'
                ? 'socialize_loss events found; amounts not summed yet'
                : 'Jupiter Lend absorbed debt is read live only (D12)',
          },
    parameterChanges30d: {
      value: Number(pc?.n ?? 0),
      provenance: 'live' as const,
      ...meta,
      method: 'config_change events except curated-vault allocations, last 30 days',
    },
  };
};

const lendingPoolFacts = [
  // Kamino debt reserves
  ...kaminoReserves
    .filter((r) => r.role === 'debt')
    .map((r) => {
      const snapRow = latestOf(r.account, 'kamino_reserve');
      const hist = snap.find((x) => x.account === r.account && x.kind.endsWith('_hourly'));
      const rates = rateSeries.find((x) => x.account === r.account);
      const v = rates ? variation(rates.xs.map(Number), RATE_MIN_SAMPLES) : null;
      const lend = lenders.find((l) => l?.reserve === r.account) as
        | (Record<string, unknown> & { topNLowerBound: boolean })
        | undefined;
      const lendMeta = fromReport(
        `lending report section 2 (obligation deposits and curated vaults, positions hour ${posHour})`,
        posAt,
      );
      // no attributed supplier: the shares would read 0, which is missing data, not concentration
      const top = (k: string): Read =>
        lend && Number(lend.suppliers) > 0 && typeof lend[k] === 'number'
          ? {
              value: lend[k] as number,
              provenance: 'live',
              ...lendMeta,
              samples: Number(lend.suppliers),
              lowerBound: lend.topNLowerBound,
            }
          : {
              reason: 'not_collected',
              detail: 'no supplier attributed: cTokens held outside obligations and curated vaults',
            };
      const collateral = kaminoReserves
        .filter((c) => c.market === r.market && c.role === 'collateral' && c.dexAssetMint)
        .map((c) => {
          const st = reserveRow.get(c.account);
          const regMeta = {
            source: 'risk_lending_pools (registry, on-chain reserve config)',
            method: 'kamino_reserve_decode',
            methodVersion: c.methodVersion,
            fetchedAt: iso(c.fetchedAt),
          };
          return collateralInput({
            asset: c.symbol,
            market: c.market,
            oracle: st ? kaminoOracle(st) : `kamino ${c.symbol} @${c.marketName}`,
            threshold: st ? Number(st.liquidationThresholdPct) / 100 : null,
            bonus: (params(c).minLiquidationBonusBps as number) / 10_000,
            thresholdMeta: st
              ? {
                  source: 'lending collector 5-minute reserve row',
                  method: String(st.method),
                  methodVersion: String(st.methodVersion),
                  fetchedAt: String(st.fetchedAt),
                }
              : regMeta,
            bonusMeta: regMeta,
          });
        });
      return buildLendingPoolFacts({
        account: r.account,
        chain: r.chain,
        venue: r.venue,
        market: r.marketName ?? r.market,
        symbol: r.symbol,
        verification: r.verification as 'onchain' | 'api',
        provenance: 'live',
        withdrawal: {
          // a price of 0 is a missing price, not a worthless reserve
          suppliedUsd: snapRow
            ? read(
                (snapRow.price_usd ?? 0) > 0 ? snapRow.supplied_usd : null,
                fromSnap(snapRow),
                'no_reference_price',
              )
            : { reason: 'not_collected' },
          availableUsd: snapRow
            ? read(
                snapRow.available !== null && (snapRow.price_usd ?? 0) > 0
                  ? snapRow.available * (snapRow.price_usd as number)
                  : null,
                fromSnap(snapRow),
                'no_reference_price',
              )
            : { reason: 'not_collected' },
          shareLentOut: snapRow
            ? read(snapRow.share_lent_out, fromSnap(snapRow))
            : { reason: 'not_collected' },
          hoursAboveAlarmShare:
            hist && Number(hist.slo) > 0
              ? {
                  value: Number(hist.above) / Number(hist.slo),
                  provenance: 'live',
                  source: `risk_lending_snapshots (hourly history; > ${P.utilAlarmPct}% lent out)`,
                  method: 'share_of_hours_above_utilAlarmPct',
                  methodVersion: METHOD,
                  fetchedAt: iso(hist.last),
                  dataFrom: iso(hist.first),
                  samples: Number(hist.slo),
                }
              : { reason: 'insufficient_samples' },
        },
        rates: {
          supplyApy: snapRow
            ? read(snapRow.supply_apy, fromSnap(snapRow))
            : { reason: 'not_collected' },
          borrowApy: snapRow
            ? read(snapRow.borrow_apy, fromSnap(snapRow))
            : { reason: 'not_collected' },
          supplyApyVariation:
            v && rates
              ? {
                  value: v.sd,
                  provenance: 'live',
                  source: 'risk_lending_snapshots (kamino_reserve_hourly supply_apy)',
                  method: `stdev of hourly supply APY, last ${RATE_WINDOW_DAYS} days`,
                  methodVersion: METHOD,
                  fetchedAt: iso(rates.to),
                  dataFrom: iso(rates.from),
                  samples: v.n,
                }
              : { reason: 'insufficient_samples' },
        },
        lenders: {
          top1Share: top('top1'),
          top3Share: top('top3'),
          top10Share: top('top10'),
        },
        collateral,
        history: marketHistory(r.market, 'kamino'),
        dataFrom: hist ? iso(hist.first) : null,
        dataTo: snapRow ? iso(snapRow.observed_at) : null,
      });
    }),
  // Jupiter Lend vaults: lenders are the liquidity layer of the debt token (live only, D12)
  ...registry
    .filter((r) => r.venue === 'jupiter_lend' && r.role === 'vault')
    .map((r) => {
      const vRow = latestOf(r.account, 'jl_vault');
      const debtSymbol = String(vRow?.detail.debtSymbol ?? r.debtSymbol ?? '');
      const layer =
        latestRows.find((x) => x.kind === 'jl_liquidity' && x.detail.symbol === debtSymbol) ?? null;
      const layerSeries = live
        .filter((x) => x.kind === 'jl_liquidity' && x.symbol === debtSymbol)
        .map((x) => Math.exp(Number(x.supplyApr)) - 1);
      const lv = variation(layerSeries, RATE_MIN_SAMPLES);
      const alarm = jlLayer.find((x) => x.symbol === debtSymbol);
      const hist = snap.find((x) => x.account === r.account && x.kind.endsWith('_hourly'));
      const live5 = vaultRowById.get(Number(String(r.market).split(':')[1]));
      const apr = (k: string) =>
        layer && Number.isFinite(Number(layer.detail[k])) ? Number(layer.detail[k]) : null;
      const layerMeta = layer
        ? { ...fromSnap(layer), method: `${layer.method}; APY = exp(APR) − 1` }
        : null;
      const regMeta = {
        source: 'lending collector 5-minute vault row',
        method: 'jupiter_lend_vault_decode',
        methodVersion: live5 ? String(live5.methodVersion) : r.methodVersion,
        fetchedAt: live5 ? String(live5.fetchedAt) : iso(r.fetchedAt),
      };
      return buildLendingPoolFacts({
        account: r.account,
        chain: r.chain,
        venue: r.venue,
        market: r.marketName ?? r.market,
        symbol: `${r.symbol}/${debtSymbol}`,
        verification: r.verification as 'onchain' | 'api',
        provenance: 'live',
        withdrawal: {
          // the debt token's liquidity layer, shared by every vault that borrows it; debt valued at par
          suppliedUsd: layer
            ? read(layer.supplied, { ...fromSnap(layer), method: `${layer.method}; at par` })
            : { reason: 'not_collected' },
          availableUsd: layer
            ? read(layer.available, { ...fromSnap(layer), method: `${layer.method}; at par` })
            : { reason: 'not_collected' },
          shareLentOut: layer
            ? read(layer.share_lent_out, fromSnap(layer))
            : { reason: 'not_collected' },
          hoursAboveAlarmShare:
            alarm?.share !== null && alarm?.share !== undefined
              ? {
                  value: alarm.share,
                  provenance: 'live',
                  source: `lending collector 5-minute liquidity-layer rows (${debtSymbol}; > ${P.utilAlarmPct}% lent out)`,
                  method: 'share_of_5min_rows_above_utilAlarmPct',
                  methodVersion: METHOD,
                  fetchedAt: liveTo ?? generatedAt.toISOString(),
                  ...(liveFrom ? { dataFrom: liveFrom } : {}),
                  samples: alarm.n,
                }
              : { reason: 'insufficient_samples' },
        },
        rates: {
          supplyApy: layerMeta
            ? read(
                apr('supplyApr') === null ? null : Math.exp(apr('supplyApr') as number) - 1,
                layerMeta,
              )
            : { reason: 'not_collected' },
          borrowApy: layerMeta
            ? read(
                apr('borrowApr') === null ? null : Math.exp(apr('borrowApr') as number) - 1,
                layerMeta,
              )
            : { reason: 'not_collected' },
          supplyApyVariation: lv
            ? {
                value: lv.sd,
                provenance: 'live',
                source: `lending collector 5-minute liquidity-layer rows (${debtSymbol})`,
                method: 'stdev of exp(supplyApr) − 1 over the 5-minute rows (live only, D12)',
                methodVersion: METHOD,
                fetchedAt: liveTo ?? generatedAt.toISOString(),
                ...(liveFrom ? { dataFrom: liveFrom } : {}),
                samples: lv.n,
              }
            : { reason: 'insufficient_samples' },
        },
        lenders: {
          top1Share: {
            reason: 'not_collected',
            detail: 'Jupiter Lend liquidity-layer supply positions are not read',
          },
          top3Share: {
            reason: 'not_collected',
            detail: 'Jupiter Lend liquidity-layer supply positions are not read',
          },
          top10Share: {
            reason: 'not_collected',
            detail: 'Jupiter Lend liquidity-layer supply positions are not read',
          },
        },
        collateral: live5
          ? [
              collateralInput({
                asset: r.symbol,
                market: r.market,
                oracle: jlOracle(live5),
                threshold: Number(live5.liquidationThreshold),
                bonus: Number(live5.liquidationPenalty),
                thresholdMeta: regMeta,
                bonusMeta: regMeta,
              }),
            ]
          : [],
        history: marketHistory(r.market, 'jupiter_lend'),
        dataFrom: hist ? iso(hist.first) : null,
        dataTo: vRow ? iso(vRow.observed_at) : null,
      });
    }),
];

const sheetChecks = lendingPoolFacts.map((sh) => {
  const { facts, invalid } = collectFacts(sh);
  return {
    account: sh.account,
    parses: LendingPoolFacts.safeParse(sh).success,
    facts: facts.length,
    measured: facts.filter((x) => x.fact.value !== null).length,
    invalid,
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
  liquidationRoutes: {
    method: 'margin = (1 + b) × (P_m / P_o) × (1 − c) − 1 (PLAN-ANALYTICS §5); facts-0.1',
    rows: routesSection,
    assumptions: [
      'b = the smallest bonus the liquidators of that oracle earn on this asset (Kamino: the bonus at the threshold; Jupiter Lend: the penalty)',
      'P_o / P_m = the median of the venue oracle over the routed reference mid in that regime (section 4); a regime without rows is not measured',
      'routed_dex: the routed sale across dollar and SOL pools in the liquidation regime (risk-0.3 curves)',
      'two_hop: pools pairing the stock with a token the collector does not price; their dollar leg is not collected',
      'wait_for_market_open: the market-hours sale, the price held flat over the wait (market risk is item 12): an assumption',
      'issuer_redemption: redeemed at the venue oracle price less the issuer fee, from fixtures/risk/issuer-models.json: an assumption',
      'a route resting on an assumption is listed, never chosen as best over a measured one',
    ],
  },
  observedRoutes: {
    totals: observedTotals,
    rows: observed,
    assumptions: [
      'followed = the seized collateral sold in a registry pool in the liquidation transaction (Step 10b decode pass); not_followed waits for item 13',
      'notFollowedWithAggregator: the transaction called Jupiter but no registry pool sold the collateral (a pool outside the registry, or another asset)',
      'realised price: dollar-quoted sales only, units-weighted; against the program price (Jupiter Lend: debt token at par) and the sale pool hourly mid (Step 5b, from 2026-09-04)',
      'observed margin = (1 + implied bonus) × realised ÷ oracle − 1, on the units sold',
      `simulated against observed: recovered value of the routed sale at the sold size in the liquidation regime, against realised ÷ the routed reference mid within ${P.oracleMatchSec}s; only where the routed curve's window covers the liquidation`,
      'size buckets by seized USD; pools are pool accounts, never wallets',
    ],
  },
  lendingPoolFacts: {
    sheets: lendingPoolFacts,
    note: `PLAN-ANALYTICS item 10: one sheet per Kamino debt reserve and Jupiter Lend vault; routes at a seized $${SHEET_ROUTE_SIZE_USD} in each regime; coverage by gap is asset-wide (section 7)`,
  },
  coverageBoth: {
    rows: coverageBoth,
    definitions: {
      earlier:
        'capacity at sale cost ≤ the bonus at the threshold, in the worst measured regime (section 5, unchanged)',
      margin: `capacity at liquidator margin ≥ ${P.minLiquidatorMarginPct}% on the routed sale, at each regime's own oracle gap, worst regime where both the curve and the gap are measured; per asset, the smallest across the venue oracles seized at that gap. At gap 0 the cost tolerance is b / (1 + b), not b.`,
    },
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
const marginAt = (r: LiquidationRoute | undefined) =>
  !r
    ? '—'
    : r.liquidatorMargin.value === null
      ? r.liquidatorMargin.reason
      : `${pct(r.liquidatorMargin.value, 2)}${r.liquidatorMargin.quality === 'assumption' ? '~' : ''}`;
table(
  '6. Liquidation routes — liquidator margin by route, seized size and regime (best = measured route recovering most)',
  routesSection.flatMap((s) =>
    s.byRegime
      .filter(
        (x) => s.oracleGap[x.regime] || s.capacity?.byRegime.some((c) => c.regime === x.regime),
      )
      .map((x) => {
        const gap = s.oracleGap[x.regime];
        const cap = s.capacity?.byRegime.find((c) => c.regime === x.regime && !c.derived);
        const route = (size: number, name: string) =>
          x.bySize.find((b) => b.seizedUsd === size)?.routes.find((r) => r.route === name);
        return {
          asset: s.asset,
          oracle: s.oracle.replace(` ${s.asset}`, '').slice(0, 30),
          regime: x.regime,
          bonus: pct(s.bonus, 1),
          oracleGap: gap ? `${pct(gap.value, 2)} n=${gap.samples}` : '—',
          tau: cap ? pct(cap.tau, 2) : '—',
          capacity: cap ? `${usd(cap.capacityUsd)}${cap.lowerBound ? '+' : ''}` : '—',
          'dex@10k': marginAt(route(10_000, 'routed_dex')),
          'dex@100k': marginAt(route(100_000, 'routed_dex')),
          'dex@1M': marginAt(route(1_000_000, 'routed_dex')),
          'wait@100k': marginAt(route(100_000, 'wait_for_market_open')),
          'issuer@100k': marginAt(route(100_000, 'issuer_redemption')),
          twoHop: marginAt(route(100_000, 'two_hop')),
          best: x.bySize.find((b) => b.seizedUsd === 100_000)?.best ?? '—',
        };
      }),
  ),
);
table(
  `7. Coverage ratio, both definitions — earlier (cost ≤ bonus) beside the liquidator's margin ≥ ${P.minLiquidatorMarginPct}%`,
  coverageBoth.map((c) => ({
    gap: `${c.gapPct}%`,
    asset: c.asset,
    seized: usd(c.seizedUsd),
    capEarlier: usd(c.earlier.capacityUsd),
    ratioEarlier: c.earlier.ratio === null ? '—' : c.earlier.ratio.toFixed(2),
    capMargin: `${usd(c.margin.capacityUsd)}${c.margin.lowerBound ? '+' : ''}`,
    regime: `${c.margin.regime ?? '—'}${c.margin.derived ? '*' : ''}`,
    tau: c.margin.tau === null ? '—' : pct(c.margin.tau, 2),
    ratioMargin: c.margin.ratio === null ? (c.margin.reason ?? '—') : c.margin.ratio.toFixed(2),
    limitedBy: (c.margin.limitingOracle ?? '—').slice(0, 34),
    notPriced: c.margin.oraclesNotPriced.length,
    missing: c.margin.regimesMissing.join(' ') || '—',
  })),
);
const fv = (x: { value: number | null; reason?: string } | undefined, f: (v: number) => string) =>
  !x ? '—' : x.value === null ? (x.reason ?? '—') : f(x.value);
table(
  '9. Lending pool facts (item 10) — one sheet per pool a lender supplies into',
  lendingPoolFacts.map((sh, i) => {
    const c = sheetChecks[i] as (typeof sheetChecks)[number];
    return {
      pool: `${sh.symbol} ${sh.market.slice(0, 22)}`,
      supplied: fv(sh.withdrawal.suppliedUsd, usd),
      available: fv(sh.withdrawal.availableUsd, usd),
      lentOut: fv(sh.withdrawal.shareLentOut, (v) => pct(v)),
      alarm: fv(sh.withdrawal.hoursAboveAlarmShare, (v) => pct(v)),
      supplyApy: fv(sh.rates.supplyApy, (v) => pct(v, 2)),
      apySd: fv(sh.rates.supplyApyVariation, (v) => pct(v, 2)),
      top1: fv(sh.lenders.top1Share, (v) => pct(v)),
      collateral: sh.collateral.map((x) => x.asset).join(' ') || '—',
      'cov@20%': sh.collateral
        .map((x) => fv(x.coverageByGap.find((g) => g.gapPct === 20)?.value, (v) => v.toFixed(2)))
        .join(' '),
      liq: fv(sh.history.liquidations, String),
      params30d: fv(sh.history.parameterChanges30d, String),
      facts: `${c.measured}/${c.facts}${c.parses ? '' : ' SCHEMA'}${c.invalid.length ? ` ${c.invalid.length} invalid` : ''}`,
    };
  }),
);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
table(
  `8. Observed liquidation routes — ${observedTotals.followed} of ${observedTotals.liquidations} liquidations sold in a registry pool in the same transaction; ${observedTotals.notFollowed} not_followed (${observedTotals.notFollowedWithAggregator} called an aggregator)`,
  observed.map((o) => ({
    asset: o.asset,
    regime: o.regime,
    size: o.bucket,
    liq: o.liquidations,
    followed: o.followed,
    notFollowed: `${o.notFollowed}${o.notFollowedWithAggregator ? ` (${o.notFollowedWithAggregator} agg)` : ''}`,
    soldShare: o.soldShare.n ? pct(o.soldShare.median, 0) : '—',
    dexes: o.byDex
      ? Object.entries(o.byDex)
          .sort((a, b) => b[1] - a[1])
          .map(
            ([d, x]) =>
              `${d.replace('_whirlpool', '').replace('raydium_', 'ray-').replace('meteora_', '')} ${pct(x, 0)}`,
          )
          .join(' ')
      : 'not_followed',
    topPool: o.pools[0]
      ? `${short(o.pools[0].pool)} ${o.pools[0].quote} ${pct(o.pools[0].share, 0)}`
      : '—',
    vsOracle: o.saleVsOracle.n ? pct(o.saleVsOracle.median, 2) : (o.reason ?? '—'),
    vsMid: o.saleVsMid.n ? `${pct(o.saleVsMid.median, 2)} n=${o.saleVsMid.n}` : '—',
    margin: o.observedMargin.n ? pct(o.observedMargin.median, 2) : (o.reason ?? '—'),
    simVsObs: o.simulatedVsObserved.n
      ? `${pct(o.simulatedVsObserved.median, 2)} n=${o.simulatedVsObserved.n}`
      : Object.keys(o.simulatedVsObserved.reasons).join(' ') || '—',
  })),
);
console.log(
  `  liquidations ${observedTotals.from?.slice(0, 10)} → ${observedTotals.to?.slice(0, 10)}; routed curves from ${String(observedTotals.routedCurvesFrom).slice(0, 10)}; simVsObs = observed − simulated recovered value`,
);
console.log(
  '\n* derived weekend capacity; + capacity beyond the top of the measured grid (lower bound); ~ rests on an assumption',
);
console.log(
  `\nprivate addresses checked: ${privateAddresses.size}; found in the report: ${leaks.length}`,
);
console.log(`→ ${file}`);
await client.end();
const badSheets = sheetChecks.filter((c) => !c.parses || c.invalid.length);
if (badSheets.length)
  console.error(`lending pool facts failing the contract: ${JSON.stringify(badSheets)}`);
if (leaks.length || badSheets.length) process.exit(1);
