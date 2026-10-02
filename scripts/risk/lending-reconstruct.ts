import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  applyKaminoConfigChange,
  decodeKaminoObligation,
  decodeKaminoReserve,
  defaultLendingReconstructParams,
  type ExchangeObs,
  exchangeAt,
  impliedApr,
  KAMINO_OBLIGATION_SIZE,
  KAMINO_RESERVE_SIZE,
  type KaminoReserveSim,
  kaminoAccrualConfig,
  kaminoAccrue,
  kaminoApplyStep,
  kaminoRates,
  kaminoReserveStep,
  kaminoTotalSupply,
  kaminoViewAt,
  type LendingEvent,
  ltvTable,
  newKaminoReserveSim,
  obligationCollateral,
  type PositionValue,
  rollingMedianAt,
} from '@colosseum/risk';
import { latestRegistryFile, type RegistryPool, valuePools } from './lib-history';
import { LENDING_HISTORY_DIR, RISK_HOME, readAddressSignatures, USDC } from './lib-lending';

// Step 10b item 7 — hourly reconstruction of every lending pool since its first transaction
// (`pnpm risk:lending-reconstruct`). Reads only what is on disk: the decode pass (`decoded/`), the lending registry,
// the Step 5b hourly pool rows (`data/risk/history-full/hourly/`, for USD), and, for the checks, the hourly raw
// reserve bytes (`raw-markets/`), the hourly obligation bytes (`lending-positions/`) and the hourly API rows.
// Output in `<dir>/hourly/` (gitignored):
//   reserves.jsonl.gz   one row per Kamino reserve and hour: supplied, borrowed, available, share lent out, rates
//                       (configured and realised), cToken exchange rate, borrow index, config (LTV, threshold,
//                       caps), units and USD
//   markets.jsonl.gz    one row per Kamino market and hour: positions, collateral and debt by asset, LTV buckets by
//                       collateral asset (aggregates only; no obligation is named)
//   jl-vaults.jsonl.gz  one row per Jupiter Lend vault and hour: collateral and debt (layer and vault level), the
//                       debt token's implied borrow APR, positions and LTV buckets
//   summary.json        coverage and every check below
// Checks (they decide whether the series can be trusted):
//   K-snap   the forward replay at every hourly raw reserve snapshot inside the window: available and cToken
//            supply exact; borrowed, borrow index and protocol fees: relative error; configuration equal
//   K-ob     every live obligation not changed after the window: debt normalised by the index (borrowedAmountSf /
//            its cumulative borrow index) against the replay's normalised debt; collateral cTokens exact
//   K-api    supplied and borrowed against the hourly API rows (the API read falls between transactions)
//   J-api    Jupiter Lend layer-level and vault-level totals against the API rows
// USD: Step 5b's hourly mid of the asset's reference USDC pool (the first USDC value pool by TVL with that hour,
// as Step 5b prices other quotes); USDC at par (as Step 5b). Anything else, or hours outside Step 5b's window,
// keeps units with USD null and `usdNullReason: 'no_price_source'`.
// Usage: tsx scripts/risk/lending-reconstruct.ts [dir=data/risk/lending-history]
const DIR = process.argv[2] ?? LENDING_HISTORY_DIR;
const OUT = join(DIR, 'hourly');
mkdirSync(OUT, { recursive: true });
const P = defaultLendingReconstructParams();
const METHOD = 'lending-reconstruct-0.1';
const SOURCE =
  'lending history decode pass (Solana RPC getTransaction) + Step 5b hourly pool mids; klend accrual replayed';
const fetchedAt = new Date().toISOString();
const prov = { source: SOURCE, fetched_at: fetchedAt, method: METHOD, provenance: 'live' };
const t0 = Date.now();
const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
const SF = 2 ** 60;
const sf = (x: bigint) => Number(x) / SF;

// ------------------------------------------------------------------------------------------------- registry
type RegRow = {
  account: string;
  venue: string;
  role: string;
  market: string | null;
  marketName?: string;
  symbol: string | null;
  mint?: string;
  decimals: number;
  debtMint?: string;
  debtSymbol?: string;
  accounts: Record<string, string>;
};
const reg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
  rows: RegRow[];
};
const reserves = reg.rows.filter((r) => r.venue === 'kamino');
const jlVaults = reg.rows.filter((r) => r.venue === 'jupiter_lend');
const reserveBy = new Map(reserves.map((r) => [r.account, r]));
const keysOf = (r: RegRow) => ({
  reserve: r.account,
  liquiditySupplyVault: r.accounts.liquiditySupplyVault as string,
  collateralMint: r.accounts.collateralMint as string,
});
// what points from an event to a reserve: its accounts, its vaults, its cToken mint
const toReserve = new Map<string, string>();
for (const r of reserves) {
  toReserve.set(r.account, r.account);
  for (const k of ['liquiditySupplyVault', 'collateralSupplyVault', 'collateralMint'])
    toReserve.set(r.accounts[k] as string, r.account);
}
const collateralVaults = new Set(reserves.map((r) => r.accounts.collateralSupplyVault as string));
const vaultToReserve = new Map(
  reserves.map((r) => [r.accounts.collateralSupplyVault as string, r.account]),
);
const decimals = new Map<string, number>();
for (const r of reg.rows) if (r.mint) decimals.set(r.mint, r.decimals);
decimals.set(USDC, 6);
decimals.set('JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', 6);

// the window: the VL-4 walk (as lending-verify)
type Addr = { i: number; address: string };
const addrs = JSON.parse(readFileSync(join(DIR, 'addresses.json'), 'utf8')) as Addr[];
const vl4 = readJsonl<{ at: string; vl: string; value: { seconds: number } }>(
  'data/risk/lending-measure.jsonl',
)
  .filter((r) => r.vl === 'VL-4')
  .at(-1);
if (!vl4) throw new Error('no VL-4 row');
const walkStart = Math.floor(Date.parse(vl4.at) / 1000) - vl4.value.seconds;
let cutSlot = 0;
for (const a of addrs) {
  const head = readAddressSignatures(DIR, a.address).next().value;
  if (head && head.blockTime <= walkStart && head.slot > cutSlot) cutSlot = head.slot;
}
const lastHour = Math.floor(walkStart / 3600) * 3600; // the last whole hour inside the window

// ------------------------------------------------------------------------------------------------- prices
// Step 5b hourly rows: asset → hour → { usd, pool }, from the first USDC value pool by TVL holding the hour
const hourlyDir = 'data/risk/history-full/hourly';
const usdcPools = valuePools(0.8, latestRegistryFile())
  .filter((p: RegistryPool) => p.mint0 === USDC || p.mint1 === USDC)
  .sort((a, b) => b.tvlUsd - a.tvlUsd);
const priceBy = new Map<string, Map<number, { usd: number; pool: string }>>();
for (const p of usdcPools) {
  const f = join(hourlyDir, `${p.address}.jsonl`);
  if (!existsSync(f)) continue;
  const m = priceBy.get(p.assetSymbol) ?? new Map();
  for (const r of readJsonl<{ hour: string; midUsd: number }>(f)) {
    const h = Date.parse(r.hour) / 1000;
    if (!m.has(h)) m.set(h, { usd: r.midUsd, pool: p.address });
  }
  priceBy.set(p.assetSymbol, m);
}
const symbolOfMint = new Map<string, string>();
for (const r of reg.rows) if (r.mint && r.symbol) symbolOfMint.set(r.mint, r.symbol);
function priceAt(mint: string, hour: number): { usd: number | null; source: string | null } {
  if (mint === USDC) return { usd: 1, source: 'usdc_at_par' };
  const sym = symbolOfMint.get(mint);
  const p = sym ? priceBy.get(sym)?.get(hour) : undefined;
  return p ? { usd: p.usd, source: `pool_mid:${p.pool}` } : { usd: null, source: null };
}
const priceWindow = [...priceBy.values()].flatMap((m) => [...m.keys()]);
const priceFrom = priceWindow.length ? Math.min(...priceWindow) : null;
const priceTo = priceWindow.length ? Math.max(...priceWindow) : null;

// ------------------------------------------------------------------------------------------------- checks' inputs
// hourly raw reserve bytes inside the window (raw-markets: pool collector, API-listed reserves)
type Snap = { at: string; slot: number; reserve: ReturnType<typeof decodeKaminoReserve> };
const snaps: Array<{ slot: number; at: string; reserves: Map<string, Snap['reserve']> }> = [];
const rawBase = join(RISK_HOME, 'raw-markets');
if (existsSync(rawBase))
  for (const d of readdirSync(rawBase).sort())
    for (const h of readdirSync(join(rawBase, d)).sort()) {
      const j = JSON.parse(gunzipSync(readFileSync(join(rawBase, d, h))).toString()) as {
        fetchedAt: string;
        slot: number;
        accounts: Record<string, string | { b64: string }>;
      };
      if (j.slot > cutSlot) continue;
      const m = new Map<string, Snap['reserve']>();
      for (const [acc, v] of Object.entries(j.accounts)) {
        if (!reserveBy.has(acc)) continue;
        const bytes = Buffer.from(typeof v === 'string' ? v : v.b64, 'base64');
        if (bytes.length === KAMINO_RESERVE_SIZE) m.set(acc, decodeKaminoReserve(bytes));
      }
      if (m.size) snaps.push({ slot: j.slot, at: j.fetchedAt, reserves: m });
    }
snaps.sort((a, b) => a.slot - b.slot);
// hourly API rows inside the window
type ApiRow = { venue: string; account: string; fetchedAt: string; api: Record<string, unknown> };
const apiRows = existsSync(join(RISK_HOME, 'markets'))
  ? readdirSync(join(RISK_HOME, 'markets'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .flatMap((f) => readJsonl<ApiRow>(join(RISK_HOME, 'markets', f)))
      .filter((r) => r.account && Date.parse(r.fetchedAt) / 1000 < walkStart)
      .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt))
  : [];

// ------------------------------------------------------------------------------------------------- the decoded days
type Dec = { s: string; sl: number; t: number; a: number[]; rf?: number; ev?: LendingEvent[] };
// a transaction seen on a reserve's own walk that refreshes it accrues it even when it moves nothing (klend
// compounds at every refresh with the rate of the utilisation at that moment)
const reserveOfAddr = new Map<number, string>();
for (const a of addrs) if (reserveBy.has(a.address)) reserveOfAddr.set(a.i, a.address);
// a reserve's interest basis at `initReserve`: Legacy for every reserve whose history changes the basis; otherwise
// (no change in its whole life, and the program refuses a change back to Legacy) the basis its account shows today
const basisChanged = new Set<string>();
for (const l of readFileSync(join(DIR, 'decoded', 'config-changes.jsonl'), 'utf8').split('\n')) {
  if (!l.includes('InterestRateBasis') && !l.includes('EntireReserveConfig')) continue;
  const c = JSON.parse(l) as { target: string; param: string };
  if (c.param === 'UpdateInterestRateBasis' || c.param.endsWith('EntireReserveConfig'))
    basisChanged.add(c.target);
}
const basisToday = new Map<string, number>();
for (const store of ['raw-markets', 'raw-lending']) {
  const base = join(RISK_HOME, store);
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base).sort())
    for (const h of readdirSync(join(base, d)).sort()) {
      const j = JSON.parse(gunzipSync(readFileSync(join(base, d, h))).toString()) as {
        accounts: Record<string, string | { b64: string }>;
      };
      for (const [acc, v] of Object.entries(j.accounts)) {
        if (!reserveBy.has(acc)) continue;
        const bytes = Buffer.from(typeof v === 'string' ? v : v.b64, 'base64');
        if (bytes.length === KAMINO_RESERVE_SIZE)
          basisToday.set(acc, decodeKaminoReserve(bytes).config.interestRateBasis);
      }
    }
}
const initialBasis = (res: string) => (basisChanged.has(res) ? 0 : (basisToday.get(res) ?? 0));
const decDir = join(DIR, 'decoded');
const days = readdirSync(decDir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
  .map((f) => f.slice(0, 10))
  .sort();

// slot ↔ time from every transaction (for hour boundaries and the measured slot duration)
const slotTime: Array<[number, number]> = [];

// Kamino state
const sims = new Map<string, KaminoReserveSim>();
const initAt = new Map<string, number>();
type Ob = {
  market: string;
  norm: Map<string, number>; // debt reserve → debt / index
  peak: Map<string, number>;
};
const obs = new Map<string, Ob>();
const obColl = new Map<string, Map<string, bigint>>();
const kStats = {
  txs: 0,
  reserveSteps: 0,
  unsupported: 0,
  configApplied: 0,
  configIgnored: 0,
  debtClosedAsDust: 0,
  refreshAccruals: 0,
  negativeDebt: 0,
};

// Jupiter Lend events, kept for a second pass (exchange prices are interpolated with later observations)
type JlOp = { t: number; vault: string; token: string; supply: number; borrow: number };
const jlOps: JlOp[] = [];
const exSupply = new Map<string, ExchangeObs[]>();
const exBorrow = new Map<string, ExchangeObs[]>();
type JlPos = {
  t: number;
  vault: string;
  nft: number;
  col: bigint;
  debt: bigint;
  tick: number;
  newCol: bigint;
  newDebt: bigint;
};
const jlPosEvents: JlPos[] = [];
const jlLiq: Array<{ t: number; vault: string; endTick: number }> = [];
const jlVaultSet = new Set(jlVaults.map((v) => v.account));
const jlVaultById = new Map<number, string>();

// outputs
const reserveRows: string[] = [];
const marketRows: string[] = [];
const checks = {
  snap: [] as Array<Record<string, unknown>>,
  api: [] as Array<Record<string, unknown>>,
};

let nextHour = 0;
let snapIdx = 0;
let apiIdx = 0;
/** Slot at a time just after the last transaction seen, at the slot duration measured over the last hour. */
const slotAt = (t: number) => {
  const last = slotTime.at(-1);
  if (!last) return 0;
  const back = slotTime[Math.max(0, slotTime.length - 2000)] as [number, number];
  const perSec = last[1] > back[1] ? (last[0] - back[0]) / (last[1] - back[1]) : 2.5;
  return last[0] + Math.round((t - last[1]) * perSec);
};

function emitHour(h: number, slot: number, slotMs: number) {
  // reserves
  const views = new Map<string, KaminoReserveSim>();
  for (const [acc, s] of sims) {
    if ((initAt.get(acc) as number) >= h) continue;
    const v = kaminoViewAt(s, slot, h);
    views.set(acc, v);
    const r = reserveBy.get(acc) as RegRow;
    const rates = kaminoRates(v, slotMs);
    const dec = r.decimals;
    const supply = kaminoTotalSupply(v);
    const price = priceAt(r.mint as string, h);
    const ui = (x: number) => x / 10 ** dec;
    const usd = (x: number) => (price.usd === null ? null : +(ui(x) * price.usd).toFixed(2));
    reserveRows.push(
      JSON.stringify({
        hour: new Date(h * 1000).toISOString(),
        chain: 'solana',
        venue: 'kamino',
        market: r.market,
        reserve: acc,
        symbol: r.symbol,
        role: r.role,
        slot,
        supplied: ui(supply),
        borrowed: ui(v.borrowed),
        available: ui(Number(v.available)),
        shareLentOut: +rates.utilization.toFixed(8),
        borrowAprConfigured: +rates.borrowAprConfigured.toFixed(8),
        borrowApr: +rates.borrowApr.toFixed(8),
        supplyApr: +rates.supplyApr.toFixed(8),
        borrowApy: +rates.borrowApy.toFixed(8),
        supplyApy: +rates.supplyApy.toFixed(8),
        slotMs: +slotMs.toFixed(1),
        interestRateBasis: v.config.interestRateBasis === 1 ? 'TrueApr' : 'Legacy',
        cTokenSupply: v.ctoken.toString(),
        exchangeRate: v.ctoken > 0n ? supply / Number(v.ctoken) : null,
        borrowIndex: v.index,
        protocolFees: ui(v.fees),
        loanToValuePct: v.config.loanToValuePct,
        liquidationThresholdPct: v.config.liquidationThresholdPct,
        depositLimit: ui(Number(v.config.depositLimit)),
        borrowLimit: ui(Number(v.config.borrowLimit)),
        status: v.config.status,
        priceUsd: price.usd,
        priceSource: price.source,
        suppliedUsd: usd(supply),
        borrowedUsd: usd(v.borrowed),
        availableUsd: usd(Number(v.available)),
        ...(price.usd === null ? { usdNullReason: 'no_price_source' } : {}),
        ...prov,
      }),
    );
  }
  // markets: positions and LTV buckets
  const byMarket = new Map<string, PositionValue[]>();
  const coll = new Map<string, Map<string, { units: number; usd: number | null }>>();
  const debt = new Map<string, Map<string, { units: number; usd: number | null }>>();
  const counts = new Map<string, { positions: number; withDebt: number }>();
  const add = (
    m: Map<string, Map<string, { units: number; usd: number | null }>>,
    market: string,
    sym: string,
    units: number,
    usd: number | null,
  ) => {
    const mm = m.get(market) ?? new Map();
    const x = mm.get(sym) ?? { units: 0, usd: 0 };
    x.units += units;
    x.usd = x.usd === null || usd === null ? null : x.usd + usd;
    mm.set(sym, x);
    m.set(market, mm);
  };
  for (const [id, o] of obs) {
    let cUnits = 0;
    let cUsd: number | null = 0;
    let best: { sym: string; usd: number; units: number } | null = null;
    let syms = new Set<string>();
    for (const [vault, ct] of obColl.get(id) ?? []) {
      if (ct <= 0n) continue;
      const res = vaultToReserve.get(vault) as string;
      const v = views.get(res);
      const r = reserveBy.get(res) as RegRow;
      if (!v) continue;
      const rate = v.ctoken > 0n ? kaminoTotalSupply(v) / Number(v.ctoken) : 1;
      const units = (Number(ct) * rate) / 10 ** r.decimals;
      const p = priceAt(r.mint as string, h);
      const usd = p.usd === null ? null : units * p.usd;
      add(coll, o.market, r.symbol as string, units, usd);
      cUnits += units;
      cUsd = cUsd === null || usd === null ? null : cUsd + usd;
      syms.add(r.symbol as string);
      if (!best || (usd ?? -1) > best.usd)
        best = { sym: r.symbol as string, usd: usd ?? -1, units };
    }
    let dUsd: number | null = 0;
    let hasDebt = false;
    for (const [res, n] of o.norm) {
      if (n <= 0) continue;
      const v = views.get(res);
      const r = reserveBy.get(res) as RegRow;
      if (!v) continue;
      const units = (n * v.index) / 10 ** r.decimals;
      const p = priceAt(r.mint as string, h);
      const usd = p.usd === null ? null : units * p.usd;
      add(debt, o.market, r.symbol as string, units, usd);
      hasDebt = true;
      dUsd = dUsd === null || usd === null ? null : dUsd + usd;
    }
    if (!best && !hasDebt) continue;
    const c = counts.get(o.market) ?? { positions: 0, withDebt: 0 };
    c.positions++;
    if (hasDebt) c.withDebt++;
    counts.set(o.market, c);
    const asset = !best ? 'none' : syms.size > 1 && cUsd === null ? 'mixed' : best.sym;
    const arr = byMarket.get(o.market) ?? [];
    arr.push({ asset, collateralUnits: cUnits, collateralUsd: cUsd, debtUsd: dUsd });
    byMarket.set(o.market, arr);
    syms = new Set();
  }
  for (const [market, c] of counts) {
    const obj = (m: Map<string, { units: number; usd: number | null }> | undefined) =>
      Object.fromEntries(
        [...(m ?? new Map())].map(([k, v]) => [
          k,
          { units: v.units, usd: v.usd === null ? null : +v.usd.toFixed(2) },
        ]),
      );
    marketRows.push(
      JSON.stringify({
        hour: new Date(h * 1000).toISOString(),
        chain: 'solana',
        venue: 'kamino',
        market,
        marketName: reserves.find((r) => r.market === market)?.marketName ?? null,
        positions: c.positions,
        positionsWithDebt: c.withDebt,
        collateralByAsset: obj(coll.get(market)),
        debtByAsset: obj(debt.get(market)),
        ltvBucketsPct: P.ltvBucketsPct,
        ltvByCollateralAsset: ltvTable(byMarket.get(market) ?? [], P.ltvBucketsPct),
        ...prov,
      }),
    );
  }
}

function checkSnapshot(sn: (typeof snaps)[number]) {
  for (const [acc, r] of sn.reserves) {
    const s = sims.get(acc);
    if (!s) {
      checks.snap.push({ at: sn.at, reserve: acc, ok: false, error: 'not initialised in history' });
      continue;
    }
    const upd = Number(r.lastUpdateSlot);
    const v = kaminoViewAt(s, upd, r.lastUpdateTimestamp || slotTimeAt(upd));
    const rel = (a: number, b: number) =>
      b === 0 ? (a === 0 ? 0 : Number.POSITIVE_INFINITY) : a / b - 1;
    const cfg = kaminoAccrualConfig(r);
    const cfgDiff = (Object.keys(cfg) as Array<keyof typeof cfg>).filter(
      (k) =>
        JSON.stringify(cfg[k], (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) !==
        JSON.stringify(v.config[k], (_k, x) => (typeof x === 'bigint' ? x.toString() : x)),
    );
    const sym = reserveBy.get(acc)?.symbol;
    checks.snap.push({
      at: sn.at,
      slot: sn.slot,
      reserve: acc,
      symbol: sym,
      available: { expected: r.availableAmount.toString(), got: v.available.toString() },
      availableOk: r.availableAmount === v.available,
      ctoken: { expected: r.collateralMintTotalSupply.toString(), got: v.ctoken.toString() },
      ctokenOk: r.collateralMintTotalSupply === v.ctoken,
      borrowedRelErr: rel(v.borrowed, sf(r.borrowedAmountSf)),
      indexRelErr: rel(v.index, sf(r.cumulativeBorrowRateBsf)),
      feesRelErr: rel(v.fees, sf(r.accumulatedProtocolFeesSf)),
      feesAbsErrUnits:
        (v.fees - sf(r.accumulatedProtocolFeesSf)) / 10 ** (reserveBy.get(acc)?.decimals ?? 0),
      referrerFees: sf(r.accumulatedReferrerFeesSf + r.pendingReferrerFeesSf),
      configDiff: cfgDiff,
    });
  }
}

// the API's state is not exactly the one at its read time (it is served from Kamino's own indexer): each API row is
// compared with the replayed state at the read and after each of the reserve's transactions within API_LAG_SEC on
// either side (accrued to the read time when older), and the closest one is kept with its lag
const API_LAG_SEC = 300;
const recent = new Map<string, Array<{ t: number; s: KaminoReserveSim }>>();
const clone = (s: KaminoReserveSim): KaminoReserveSim => ({ ...s, config: { ...s.config } });
function remember(res: string, s: KaminoReserveSim, t: number) {
  const arr = recent.get(res) ?? [];
  arr.push({ t, s: clone(s) });
  while (arr.length && (arr[0] as { t: number }).t < t - 2 * API_LAG_SEC) arr.shift();
  recent.set(res, arr);
}
const pendingApi: Array<{ a: ApiRow; t: number; now: KaminoReserveSim }> = [];
function queueApi(a: ApiRow, t: number) {
  if (a.venue !== 'kamino') return; // Jupiter Lend rows are checked in the second pass
  const s = sims.get(a.account);
  if (s) pendingApi.push({ a, t, now: clone(s) });
}
function settleApi(upTo: number) {
  while (pendingApi.length && (pendingApi[0] as { t: number }).t + API_LAG_SEC <= upTo) {
    const { a, t, now } = pendingApi.shift() as (typeof pendingApi)[number];
    const r = reserveBy.get(a.account) as RegRow;
    const ui = (x: number) => x / 10 ** r.decimals;
    const rel = (got: number, api: number) =>
      api === 0 ? (got === 0 ? 0 : Number.POSITIVE_INFINITY) : got / api - 1;
    const api = { supplied: Number(a.api.totalSupply), borrowed: Number(a.api.totalBorrow) };
    const candidates = [
      { lag: 0, s: now },
      ...(recent.get(a.account) ?? [])
        .filter((x) => Math.abs(x.t - t) <= API_LAG_SEC)
        .map((x) => ({ lag: x.t - t, s: x.s })),
    ].map((c) => {
      const v = kaminoViewAt(c.s, slotTimeSlot(t), t);
      const e = {
        supplied: rel(ui(kaminoTotalSupply(v)), api.supplied),
        borrowed: rel(ui(v.borrowed), api.borrowed),
      };
      return { ...c, v, e, worst: Math.max(Math.abs(e.supplied), Math.abs(e.borrowed)) };
    });
    const best = [...candidates].sort(
      (x, y) => x.worst - y.worst || Math.abs(x.lag) - Math.abs(y.lag),
    )[0];
    // the raw reserve bytes the same collector run read (independent of the replay): is the API off the chain?
    const sn = snaps.find(
      (x) => Math.abs(Date.parse(x.at) / 1000 - t) <= 120 && x.reserves.has(a.account),
    );
    const chain = sn?.reserves.get(a.account);
    const chainSupply = chain
      ? ui(
          sf(
            (chain.availableAmount << 60n) +
              chain.borrowedAmountSf -
              chain.accumulatedProtocolFeesSf -
              chain.accumulatedReferrerFeesSf -
              chain.pendingReferrerFeesSf,
          ),
        )
      : null;
    const chainBorrowed = chain ? ui(sf(chain.borrowedAmountSf)) : null;
    const at = candidates[0];
    if (!best || !at) continue;
    for (const field of ['supplied', 'borrowed'] as const)
      checks.api.push({
        venue: 'kamino',
        account: a.account,
        symbol: r.symbol,
        apiAt: a.fetchedAt,
        field,
        api: api[field],
        got: field === 'supplied' ? ui(kaminoTotalSupply(best.v)) : ui(best.v.borrowed),
        relErr: best.e[field],
        relErrAtRead: at.e[field],
        stateLagSec: best.lag,
        chainSnapshotVsApiRelErr: (() => {
          const c = field === 'supplied' ? chainSupply : chainBorrowed;
          return c === null ? null : rel(c, api[field]);
        })(),
      });
  }
}
/** Slot at a time inside the history seen so far (interpolated), or just past it at the measured rate. */
function slotTimeSlot(t: number) {
  const last = slotTime.at(-1);
  if (last && t > last[1]) return slotAt(t);
  let lo = 0;
  let hi = slotTime.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((slotTime[mid] as [number, number])[1] <= t) lo = mid;
    else hi = mid;
  }
  const x = slotTime[lo] as [number, number];
  const y = slotTime[hi] as [number, number];
  return y[1] === x[1] ? x[0] : Math.round(x[0] + ((t - x[1]) * (y[0] - x[0])) / (y[1] - x[1]));
}

// slot → time for snapshot comparisons (after the pass has seen the slot)
function slotTimeAt(slot: number): number {
  let lo = 0;
  let hi = slotTime.length - 1;
  if (hi < 0) return 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((slotTime[mid] as [number, number])[0] <= slot) lo = mid;
    else hi = mid;
  }
  const a = slotTime[lo] as [number, number];
  const b = slotTime[hi] as [number, number];
  if (b[0] === a[0]) return a[1];
  return Math.round(a[1] + ((slot - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
}

let lastSlotForHour = 0;
let lastTimeForHour = 0;
let prevHourSlot = 0;
function flushHoursBefore(t: number, slot: number) {
  // hours strictly before this tx's time: state after every earlier tx; the hour's slot is interpolated between the
  // last tx before it and this one
  while (nextHour && nextHour <= t && nextHour <= lastHour) {
    const h = nextHour;
    const hs =
      slot > lastSlotForHour && t > lastTimeForHour
        ? Math.round(
            lastSlotForHour +
              ((h - lastTimeForHour) * (slot - lastSlotForHour)) / (t - lastTimeForHour),
          )
        : lastSlotForHour;
    const slotMs = prevHourSlot && hs > prevHourSlot ? 3_600_000 / (hs - prevHourSlot) : 400;
    emitHour(h, hs, slotMs);
    prevHourSlot = hs;
    nextHour += 3600;
  }
}

for (const day of days) {
  const rows = readJsonl<Dec>(join(decDir, `${day}.jsonl.gz`)).sort((a, b) => a.sl - b.sl);
  for (const r of rows) {
    if (r.sl > cutSlot) continue;
    // checkpoints before this transaction
    while (snapIdx < snaps.length && (snaps[snapIdx] as (typeof snaps)[number]).slot < r.sl)
      checkSnapshot(snaps[snapIdx++] as (typeof snaps)[number]);
    while (
      apiIdx < apiRows.length &&
      Date.parse((apiRows[apiIdx] as ApiRow).fetchedAt) / 1000 <= r.t
    )
      queueApi(
        apiRows[apiIdx] as ApiRow,
        Date.parse((apiRows[apiIdx++] as ApiRow).fetchedAt) / 1000,
      );
    settleApi(r.t);
    flushHoursBefore(r.t, r.sl);
    slotTime.push([r.sl, r.t]);
    lastSlotForHour = r.sl;
    lastTimeForHour = r.t;
    const ev = r.ev ?? [];
    if (r.rf)
      for (const i of r.a) {
        const res = reserveOfAddr.get(i);
        const s = res ? sims.get(res) : undefined;
        if (s) {
          kaminoAccrue(s, r.sl, r.t);
          kStats.refreshAccruals++;
        }
      }
    if (!ev.length) continue;
    kStats.txs++;

    // ---- Kamino: reserves touched
    const touched = new Set<string>();
    for (const e of ev) {
      if (e.program !== 'klend') continue;
      for (const a of Object.values(e.accounts)) {
        const res = toReserve.get(a);
        if (res) touched.add(res);
      }
      for (const f of e.flows) {
        const res = toReserve.get(f.account);
        if (res) touched.add(res);
      }
      for (const s of e.supply ?? []) {
        const res = toReserve.get(s.mint);
        if (res) touched.add(res);
      }
    }
    for (const res of touched) {
      const isInit = ev.some(
        (e) => e.program === 'klend' && e.ix === 'initReserve' && e.accounts.reserve === res,
      );
      let s = sims.get(res);
      if (!s) {
        if (!isInit) continue; // only reserves whose life starts in the history
        s = newKaminoReserveSim(r.sl, r.t);
        s.config.interestRateBasis = initialBasis(res);
        sims.set(res, s);
        initAt.set(res, r.t);
        if (!nextHour) nextHour = Math.floor(r.t / 3600) * 3600 + 3600;
      }
      kaminoAccrue(s, r.sl, r.t);
    }
    // obligations (debt is normalised by the index after accrual, before the step)
    for (const e of ev) {
      if (e.program !== 'klend' || !e.accounts.obligation) continue;
      const ob = e.accounts.obligation;
      const res = e.accounts.borrowReserve ?? e.accounts.repayReserve ?? e.accounts.reserve ?? null;
      const market =
        e.accounts.lendingMarket ?? (res ? reserveBy.get(res)?.market : undefined) ?? null;
      let o = obs.get(ob);
      if (e.ix === 'initObligation') {
        o = { market: market ?? '', norm: new Map(), peak: new Map() };
        obs.set(ob, o);
      }
      if (!o) {
        if (!market) continue;
        o = { market, norm: new Map(), peak: new Map() };
        obs.set(ob, o);
      }
      if (!o.market && market) o.market = market;
      for (const dr of [e.accounts.borrowReserve, e.accounts.repayReserve, e.accounts.reserve]) {
        if (!dr || !reserveBy.has(dr)) continue;
        const s = sims.get(dr);
        if (!s) continue;
        const d = kaminoReserveStep([e], keysOf(reserveBy.get(dr) as RegRow));
        if (!d.borrowed) continue;
        const n = (o.norm.get(dr) ?? 0) + Number(d.borrowed) / s.index;
        const peak = Math.max(o.peak.get(dr) ?? 0, n);
        o.peak.set(dr, peak);
        if (Math.abs(n) * s.index < 1 || Math.abs(n) <= peak * P.debtDustRel) {
          if (n !== 0) kStats.debtClosedAsDust++;
          o.norm.set(dr, 0);
        } else {
          if (n < 0) kStats.negativeDebt++;
          o.norm.set(dr, n);
        }
      }
    }
    obligationCollateral(ev, collateralVaults, obColl);
    // reserve steps and configuration
    for (const res of touched) {
      const s = sims.get(res);
      if (!s) continue;
      const isInit = ev.some(
        (e) => e.program === 'klend' && e.ix === 'initReserve' && e.accounts.reserve === res,
      );
      const d = kaminoReserveStep(ev, keysOf(reserveBy.get(res) as RegRow));
      kaminoApplyStep(s, d, isInit);
      if (d.available || d.borrowed || d.ctoken || d.feesRedeemed) remember(res, s, r.t);
      kStats.reserveSteps++;
      kStats.unsupported += d.unsupported;
      for (const e of ev)
        if (e.program === 'klend' && e.ix === 'updateReserveConfig' && e.accounts.reserve === res)
          for (const c of e.config ?? [])
            if (applyKaminoConfigChange(s.config, c.param, c.value)) kStats.configApplied++;
            else kStats.configIgnored++;
    }

    // ---- Jupiter Lend: liquidity-layer operations of the vaults, exchange prices, positions, liquidations
    for (const e of ev) {
      if (e.program === 'jl_liquidity' && e.ix === 'operate') {
        const f = e.events?.find((x) => x.name === 'LogOperate')?.fields;
        if (!f) continue;
        const token = String(f.token);
        const sEx = Number(f.supplyExchangePrice);
        const bEx = Number(f.borrowExchangePrice);
        const push = (m: Map<string, ExchangeObs[]>, v: number) => {
          const arr = m.get(token) ?? [];
          if (
            !arr.length ||
            (arr.at(-1) as ExchangeObs).t !== r.t ||
            (arr.at(-1) as ExchangeObs).v !== v
          )
            arr.push({ t: r.t, v });
          m.set(token, arr);
        };
        push(exSupply, sEx);
        push(exBorrow, bEx);
        const vault = String(f.user);
        if (jlVaultSet.has(vault))
          jlOps.push({
            t: r.t,
            vault,
            token,
            supply: (Number(f.supplyAmount) * 1e12) / sEx,
            borrow: (Number(f.borrowAmount) * 1e12) / bEx,
          });
      }
      if (e.program === 'jl_vaults' && jlVaultSet.has(e.accounts.vault_config as string)) {
        const vault = e.accounts.vault_config as string;
        for (const x of e.events ?? []) {
          if (x.name === 'LogUserPosition') {
            jlVaultById.set(Number(x.fields.vaultId), vault);
            const op = e.events?.find((y) => y.name === 'LogOperate')?.fields;
            jlPosEvents.push({
              t: r.t,
              vault,
              nft: Number(x.fields.nftId),
              col: BigInt(x.fields.col ?? 0),
              debt: BigInt(x.fields.borrow ?? 0),
              tick: Number(x.fields.tick),
              newCol: BigInt(op?.newCol ?? 0),
              newDebt: BigInt(op?.newDebt ?? 0),
            });
          }
          if (x.name === 'LogLiquidateInfo')
            jlLiq.push({ t: r.t, vault, endTick: Number(x.fields.endTick) });
        }
      }
    }
  }
}
// the last hours of the window and the remaining checkpoints
while (snapIdx < snaps.length) checkSnapshot(snaps[snapIdx++] as (typeof snaps)[number]);
while (apiIdx < apiRows.length)
  queueApi(apiRows[apiIdx] as ApiRow, Date.parse((apiRows[apiIdx++] as ApiRow).fetchedAt) / 1000);
settleApi(Number.POSITIVE_INFINITY);
flushHoursBefore(lastHour + 1, cutSlot);

// ------------------------------------------------------------------------------------------------- K-ob
const obCheck = {
  snapshot: null as string | null,
  obligations: 0,
  changedAfterWindow: 0,
  notInHistory: 0,
  checked: 0,
  borrows: 0,
  /** |replayed − on-chain| debt, normalised by the index, over the obligation's peak debt in the reserve */
  debtErrOfPeakMax: 0,
  debtErrOfPeakP50: 0,
  debtErrOfPeakP99: 0,
  debtOver1e6: 0,
  depositsChecked: 0,
  collateralMismatches: 0,
  modelDebtNotOnChain: 0,
};
const obExamples: Array<Record<string, unknown>> = [];
{
  const posBase = join(RISK_HOME, 'lending-positions');
  const first = existsSync(posBase)
    ? readdirSync(posBase)
        .sort()
        .flatMap((d) =>
          readdirSync(join(posBase, d))
            .sort()
            .map((h) => join(posBase, d, h)),
        )[0]
    : undefined;
  const errs: number[] = [];
  if (first) {
    obCheck.snapshot = first;
    for (const f of readdirSync(first).filter(
      (x) => x.startsWith('kamino-') && x.endsWith('.raw.json.gz'),
    )) {
      const j = JSON.parse(gunzipSync(readFileSync(join(first, f))).toString()) as {
        accounts: Record<string, string>;
      };
      for (const [ob, b64] of Object.entries(j.accounts)) {
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length !== KAMINO_OBLIGATION_SIZE) continue;
        obCheck.obligations++;
        const o = decodeKaminoObligation(new Uint8Array(bytes));
        if (o.lastUpdateSlot > BigInt(cutSlot)) {
          obCheck.changedAfterWindow++;
          continue;
        }
        const mine = obs.get(ob);
        if (!mine) {
          obCheck.notInHistory++;
          continue;
        }
        obCheck.checked++;
        for (const b of o.borrows) {
          obCheck.borrows++;
          const actual = sf(b.borrowedAmountSf) / sf(b.cumulativeBorrowRateBsf);
          const model = mine.norm.get(b.reserve) ?? 0;
          // measured against the obligation's largest debt in this reserve: the replay's resolution scales with
          // the amounts that went through it, and a repaid debt leaves dust of a few raw units
          const scale = Math.max(mine.peak.get(b.reserve) ?? 0, actual);
          const e = scale === 0 ? 0 : Math.abs(model - actual) / scale;
          errs.push(e);
          if (e > 1e-6) {
            obCheck.debtOver1e6++;
            // local file only (checks.json); never published
            if (obExamples.length < 50)
              obExamples.push({
                obligation: ob,
                reserve: b.reserve,
                symbol: reserveBy.get(b.reserve)?.symbol,
                actualNorm: actual,
                modelNorm: model,
                peakNorm: mine.peak.get(b.reserve) ?? 0,
                lastUpdateSlot: Number(o.lastUpdateSlot),
              });
          }
        }
        for (const [res, n] of mine.norm)
          if (
            n !== 0 &&
            !o.borrows.some((b) => b.reserve === res) &&
            Math.abs(n) > (mine.peak.get(res) ?? 0) * 1e-6
          ) {
            obCheck.modelDebtNotOnChain++;
            if (obExamples.length < 50)
              obExamples.push({ obligation: ob, reserve: res, actualNorm: null, modelNorm: n });
          }
        for (const d of o.deposits) {
          obCheck.depositsChecked++;
          const r = reserveBy.get(d.reserve);
          const got = r
            ? (obColl.get(ob)?.get(r.accounts.collateralSupplyVault as string) ?? 0n)
            : -1n;
          if (got !== d.depositedAmount) obCheck.collateralMismatches++;
        }
      }
    }
  }
  errs.sort((a, b) => a - b);
  obCheck.debtErrOfPeakMax = errs.at(-1) ?? 0;
  obCheck.debtErrOfPeakP50 = errs[Math.floor(errs.length / 2)] ?? 0;
  obCheck.debtErrOfPeakP99 = errs[Math.floor(errs.length * 0.99)] ?? 0;
}

// ------------------------------------------------------------------------------------------------- Jupiter Lend
for (const m of [exSupply, exBorrow]) for (const a of m.values()) a.sort((x, y) => x.t - y.t);
jlOps.sort((a, b) => a.t - b.t);
jlPosEvents.sort((a, b) => a.t - b.t);
jlLiq.sort((a, b) => a.t - b.t);
const jlRows: string[] = [];
const jlStats: Record<string, Record<string, unknown>> = {};
for (const v of jlVaults) {
  const colMint = v.mint as string;
  const debtMint = v.debtMint as string;
  const colDec = decimals.get(colMint) ?? 8;
  const debtDec = decimals.get(debtMint) ?? 6;
  const ops = jlOps.filter((o) => o.vault === v.account);
  const pos = jlPosEvents.filter((p) => p.vault === v.account);
  const liqs = jlLiq.filter((l) => l.vault === v.account);
  const first = Math.min(
    ops[0]?.t ?? Number.POSITIVE_INFINITY,
    pos[0]?.t ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(first)) continue;
  // vault exchange prices (tokens per position raw unit) = the liquidity layer's exchange price × a factor that moves
  // only with the vault's rate magnifiers. The factor is observed on operates with a large enough change (amount in
  // tokens over the position's raw change, over the layer's price at that moment) and taken as the rolling median.
  const vCol: ExchangeObs[] = [];
  const vDebt: ExchangeObs[] = [];
  {
    const last = new Map<number, JlPos>();
    const big = (x: bigint) => (x < 0n ? -x : x) >= BigInt(P.minExchangeObsRaw);
    for (const p of pos) {
      const prev = last.get(p.nft);
      const dCol = p.col - (prev?.col ?? 0n);
      const dDebt = p.debt - (prev?.debt ?? 0n);
      const ls = exchangeAt(exSupply.get(colMint) ?? [], p.t);
      const lb = exchangeAt(exBorrow.get(debtMint) ?? [], p.t);
      if (ls && big(dCol) && p.newCol !== 0n && p.newCol > 0n === dCol > 0n)
        vCol.push({ t: p.t, v: Number(p.newCol) / Number(dCol) / (ls.v / 1e12) });
      if (lb && big(dDebt) && p.newDebt !== 0n && p.newDebt > 0n === dDebt > 0n)
        vDebt.push({ t: p.t, v: Number(p.newDebt) / Number(dDebt) / (lb.v / 1e12) });
      last.set(p.nft, p);
    }
  }
  const vaultEx = (factors: ExchangeObs[], layer: ExchangeObs[], t: number) => {
    const f = rollingMedianAt(factors, t, P.vaultFactorWindow);
    const l = exchangeAt(layer, t);
    return f === null || !l ? null : { v: (f * l.v) / 1e12, method: l.method };
  };
  let supplyRaw = 0;
  let borrowRaw = 0;
  let oi = 0;
  let pi = 0;
  let li = 0;
  const positions = new Map<number, JlPos & { unknown: boolean }>();
  let hoursOut = 0;
  const apiChecks: Array<Record<string, unknown>> = [];
  const apiForVault = apiRows.filter((a) => a.venue === 'jupiter_lend' && a.account === v.account);
  const advance = (t: number) => {
    while (oi < ops.length && (ops[oi] as JlOp).t < t) {
      const o = ops[oi++] as JlOp;
      if (o.token === colMint) supplyRaw += o.supply;
      if (o.token === debtMint) borrowRaw += o.borrow;
    }
    while (pi < pos.length || li < liqs.length) {
      const p = pos[pi];
      const l = liqs[li];
      if (p && p.t < t && (!l || p.t <= l.t)) {
        positions.set(p.nft, { ...p, unknown: false });
        pi++;
      } else if (l && l.t < t) {
        // a liquidation moves every position above its end tick; their state is unknown until touched again
        for (const q of positions.values()) if (q.tick > l.endTick && q.debt > 0n) q.unknown = true;
        li++;
      } else break;
    }
  };
  const totals = (t: number) => {
    const se = exchangeAt(exSupply.get(colMint) ?? [], t);
    const be = exchangeAt(exBorrow.get(debtMint) ?? [], t);
    return {
      collateral: se ? (supplyRaw * se.v) / 1e12 : null,
      debt: be ? (borrowRaw * be.v) / 1e12 : null,
      se,
      be,
    };
  };
  for (const a of apiForVault) {
    const t = Date.parse(a.fetchedAt) / 1000;
    if (t < first) continue;
    advance(t);
    const tot = totals(t);
    const vc = vaultEx(vCol, exSupply.get(colMint) ?? [], t);
    const vd = vaultEx(vDebt, exBorrow.get(debtMint) ?? [], t);
    let sCol = 0;
    let sDebt = 0;
    let unknown = 0;
    for (const q of positions.values()) {
      sCol += Number(q.col);
      sDebt += Number(q.debt);
      if (q.unknown) unknown++;
    }
    const rel = (g: number | null, x: number) =>
      g === null ? null : x === 0 ? (g === 0 ? 0 : 1) : g / x - 1;
    apiChecks.push({
      apiAt: a.fetchedAt,
      layerCollateralRelErr: rel(tot.collateral, Number(a.api.totalSupplyLiquidity)),
      layerDebtRelErr: rel(tot.debt, Number(a.api.totalBorrowLiquidity)),
      vaultCollateralRelErr: vc ? rel(sCol * vc.v, Number(a.api.totalSupply)) : null,
      vaultDebtRelErr: vd ? rel(sDebt * vd.v, Number(a.api.totalBorrow)) : null,
      positionsUnknown: unknown,
    });
  }
  // hourly rows
  oi = 0;
  pi = 0;
  li = 0;
  supplyRaw = 0;
  borrowRaw = 0;
  positions.clear();
  for (let h = Math.floor(first / 3600) * 3600 + 3600; h <= lastHour; h += 3600) {
    advance(h);
    const tot = totals(h);
    const vc = vaultEx(vCol, exSupply.get(colMint) ?? [], h);
    const vd = vaultEx(vDebt, exBorrow.get(debtMint) ?? [], h);
    const pCol = priceAt(colMint, h);
    const pDebt = priceAt(debtMint, h);
    const list: PositionValue[] = [];
    let open = 0;
    let unknown = 0;
    for (const q of positions.values()) {
      if (q.col <= 0n && q.debt <= 0n) continue;
      open++;
      if (q.unknown) {
        unknown++;
        continue;
      }
      const cUnits = vc ? (Number(q.col) * vc.v) / 10 ** colDec : 0;
      const dUnits = vd ? (Number(q.debt) * vd.v) / 10 ** debtDec : q.debt > 0n ? Number.NaN : 0;
      list.push({
        asset: v.symbol as string,
        collateralUnits: cUnits,
        collateralUsd: pCol.usd === null || !vc ? null : cUnits * pCol.usd,
        debtUsd:
          dUnits === 0 ? 0 : pDebt.usd === null || Number.isNaN(dUnits) ? null : dUnits * pDebt.usd,
      });
    }
    const colUnits = tot.collateral === null ? null : tot.collateral / 10 ** colDec;
    const debtUnits = tot.debt === null ? null : tot.debt / 10 ** debtDec;
    jlRows.push(
      JSON.stringify({
        hour: new Date(h * 1000).toISOString(),
        chain: 'solana',
        venue: 'jupiter_lend',
        vault: v.account,
        marketName: v.marketName,
        symbol: v.symbol,
        debtSymbol: v.debtSymbol,
        collateral: colUnits,
        debt: debtUnits,
        exchangePriceMethod: { collateral: tot.se?.method ?? null, debt: tot.be?.method ?? null },
        debtBorrowAprImplied: impliedApr(exBorrow.get(debtMint) ?? [], h),
        positions: open,
        positionsStateUnknown: unknown,
        priceUsd: pCol.usd,
        priceSource: pCol.source,
        debtPriceUsd: pDebt.usd,
        debtPriceSource: pDebt.source,
        collateralUsd:
          colUnits === null || pCol.usd === null ? null : +(colUnits * pCol.usd).toFixed(2),
        debtUsd:
          debtUnits === null || pDebt.usd === null ? null : +(debtUnits * pDebt.usd).toFixed(2),
        ltvOfVault:
          colUnits && debtUnits !== null && pCol.usd !== null && pDebt.usd !== null
            ? (debtUnits * pDebt.usd) / (colUnits * pCol.usd)
            : null,
        ...(pCol.usd === null || pDebt.usd === null ? { usdNullReason: 'no_price_source' } : {}),
        ltvBucketsPct: P.ltvBucketsPct,
        ltvByCollateralAsset: ltvTable(list, P.ltvBucketsPct),
        ...prov,
      }),
    );
    hoursOut++;
  }
  const absMax = (k: string) =>
    Math.max(0, ...apiChecks.map((c) => Math.abs((c[k] as number | null) ?? 0)));
  jlStats[v.account] = {
    symbol: v.symbol,
    debtSymbol: v.debtSymbol,
    first: new Date(first * 1000).toISOString(),
    hours: hoursOut,
    layerOps: ops.length,
    positionEvents: pos.length,
    liquidations: liqs.length,
    vaultExchangeObs: { collateral: vCol.length, debt: vDebt.length },
    apiRows: apiChecks.length,
    apiMaxAbsRelErr: {
      layerCollateral: absMax('layerCollateralRelErr'),
      layerDebt: absMax('layerDebtRelErr'),
      vaultCollateral: absMax('vaultCollateralRelErr'),
      vaultDebt: absMax('vaultDebtRelErr'),
    },
    apiChecks,
  };
}

// ------------------------------------------------------------------------------------------------- outputs
const write = (name: string, rows: string[]) =>
  writeFileSync(join(OUT, name), gzipSync(rows.length ? `${rows.join('\n')}\n` : ''));
write('reserves.jsonl.gz', reserveRows);
write('markets.jsonl.gz', marketRows);
write('jl-vaults.jsonl.gz', jlRows);

const snapFails = checks.snap.filter((c) => c.availableOk === false || c.ctokenOk === false);
const configDiffs: Record<string, number> = {};
for (const c of checks.snap)
  for (const d of (c.configDiff as string[] | undefined) ?? []) {
    const k = `${c.symbol} ${c.reserve} ${d}`;
    configDiffs[k] = (configDiffs[k] ?? 0) + 1;
  }
// API rows that differ from the raw reserve bytes of the same collector run exactly as much as from the replay:
// the API was off the chain at that read
const apiBig = checks.api.filter(
  (c) => (c.api as number) > 0 && Math.abs(c.relErr as number) > 1e-5,
);
const apiOffChain = apiBig.filter(
  (c) =>
    c.chainSnapshotVsApiRelErr !== null &&
    Math.abs((c.chainSnapshotVsApiRelErr as number) - (c.relErr as number)) < 1e-6,
);
const maxAbs = (xs: Array<Record<string, unknown>>, k: string) =>
  Math.max(0, ...xs.map((c) => Math.abs((c[k] as number) ?? 0)).filter(Number.isFinite));
const summary = {
  ...prov,
  params: P,
  window: {
    walkStart: new Date(walkStart * 1000).toISOString(),
    cutSlot,
    lastHour: new Date(lastHour * 1000).toISOString(),
  },
  usd: {
    method:
      'Step 5b hourly mid of the asset reference USDC pool (first USDC value pool by TVL with the hour); USDC at par',
    from: priceFrom === null ? null : new Date(priceFrom * 1000).toISOString(),
    to: priceTo === null ? null : new Date(priceTo * 1000).toISOString(),
    assets: [...priceBy.keys()],
  },
  rows: { reserves: reserveRows.length, markets: marketRows.length, jlVaults: jlRows.length },
  kamino: {
    reserves: [...sims.keys()].map((acc) => ({
      reserve: acc,
      symbol: reserveBy.get(acc)?.symbol,
      market: reserveBy.get(acc)?.market,
      first: new Date((initAt.get(acc) as number) * 1000).toISOString(),
    })),
    reservesNotInitialised: reserves.filter((r) => !sims.has(r.account)).map((r) => r.account),
    stats: kStats,
    obligations: obs.size,
  },
  checks: {
    snapshots: {
      comparisons: checks.snap.length,
      snapshots: snaps.length,
      balanceFailures: snapFails.length,
      failureExamples: snapFails.slice(0, 10),
      configDiffs,
      availableExact: checks.snap.filter((c) => c.availableOk).length,
      ctokenExact: checks.snap.filter((c) => c.ctokenOk).length,
      borrowedRelErrMax: maxAbs(checks.snap, 'borrowedRelErr'),
      indexRelErrMax: maxAbs(checks.snap, 'indexRelErr'),
      feesRelErrMax: maxAbs(
        checks.snap.filter((c) => Number.isFinite(c.feesRelErr as number)),
        'feesRelErr',
      ),
      feesAbsErrUnitsMax: maxAbs(checks.snap, 'feesAbsErrUnits'),
      referrerFeesMax: maxAbs(checks.snap, 'referrerFees'),
      byReserve: Object.fromEntries(
        [...new Set(checks.snap.map((c) => c.reserve as string))].map((acc) => {
          const xs = checks.snap.filter((c) => c.reserve === acc);
          return [
            `${reserveBy.get(acc)?.symbol} ${acc}`,
            {
              n: xs.length,
              borrowedRelErrMax: maxAbs(xs, 'borrowedRelErr'),
              indexRelErrMax: maxAbs(xs, 'indexRelErr'),
              feesRelErrMax: maxAbs(
                xs.filter((c) => Number.isFinite(c.feesRelErr as number)),
                'feesRelErr',
              ),
              feesAbsErrUnitsMax: maxAbs(xs, 'feesAbsErrUnits'),
            },
          ];
        }),
      ),
    },
    obligations: obCheck,
    api: {
      kamino: {
        comparisons: checks.api.length,
        maxAbsRelErr: maxAbs(
          checks.api.filter((c) => (c.api as number) > 0),
          'relErr',
        ),
        maxAbsRelErrAtRead: maxAbs(
          checks.api.filter((c) => (c.api as number) > 0),
          'relErrAtRead',
        ),
        matchedOtherState: checks.api.filter((c) => (c.stateLagSec as number) !== 0).length / 2,
        over1e5: apiBig.length,
        over1e5ApiOffChain: apiOffChain.length,
        over1e5Unexplained: apiBig.length - apiOffChain.length,
        maxAbsRelErrExplained: maxAbs(
          checks.api.filter((c) => (c.api as number) > 0 && !apiOffChain.includes(c)),
          'relErr',
        ),
        stateLagSecMax: maxAbs(checks.api, 'stateLagSec'),
        byField: Object.fromEntries(
          ['supplied', 'borrowed'].map((f) => [
            f,
            maxAbs(
              checks.api.filter((c) => c.field === f && (c.api as number) > 0),
              'relErr',
            ),
          ]),
        ),
      },
      jupiterLend: Object.fromEntries(
        Object.entries(jlStats).map(([k, s]) => [k, { ...s, apiChecks: undefined }]),
      ),
    },
  },
  secs: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(
  join(OUT, 'checks.json'),
  JSON.stringify(
    {
      ...prov,
      snapshots: checks.snap,
      api: checks.api,
      obligations: obExamples,
      jupiterLend: jlStats,
    },
    null,
    1,
  ),
);
console.log(
  JSON.stringify({
    rows: summary.rows,
    snapshots: {
      ...summary.checks.snapshots,
      byReserve: undefined,
      failureExamples: snapFails.length,
    },
    obligations: obCheck,
    apiKamino: summary.checks.api.kamino,
    secs: summary.secs,
  }),
);
for (const [k, s] of Object.entries(jlStats))
  console.log(JSON.stringify({ vault: k, ...s, apiChecks: undefined }));
