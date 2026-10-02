import {
  decodeKaminoReserve,
  KAMINO_RESERVE_SIZE,
  KAMINO_SLOTS_PER_YEAR,
  type KaminoCurvePoint,
  kaminoCurveRate,
} from './kamino';
import type { LendingEvent } from './tx';
import { type ReserveKeys, reserveDeltas } from './verify';

// Step 10b item 7 — reconstruction of lending-pool state from the decoded history (pure functions; the script that
// feeds them is scripts/risk/lending-reconstruct.ts).
//   Kamino reserve   forward from its `initReserve`: available liquidity and cToken supply are sums of the decoded
//                    token flows and mint-supply changes (exact); borrowed, the cumulative borrow index and the
//                    protocol fees are compounded between transactions exactly as klend does (`compoundInterest`,
//                    `approximate_compounded_interest`), with the reserve's configuration replayed from its own
//                    `updateReserveConfig` history.
//   Kamino obligation  collateral cTokens per reserve (exact flows) and debt per reserve as an amount normalised by
//                    the reserve's index at each borrow and repay (debt at time t = normalised × index(t)).
//   Jupiter Lend vault  collateral and debt from the liquidity layer's own records: each `LogOperate` of the vault
//                    gives the amount and the token's exchange prices at that moment, so raw amounts are exact and
//                    token amounts at any hour follow from the exchange prices observed around it.
//   LTV buckets      policy input `ltvBucketsPct`, upper edges in percent.

/** Policy inputs of the reconstruction, stored with every output. Changed here only, never in a test expectation. */
export type LendingReconstructParams = {
  /** Upper edges of the LTV buckets, percent; a last bucket holds everything above the last edge. */
  ltvBucketsPct: number[];
  /** Smallest raw amount whose ratio to a position's raw change is used as a Jupiter Lend vault exchange price
   *  observation (rounding of one raw unit is then at most 1e-6). */
  minExchangeObsRaw: number;
  /** An obligation debt below this share of its largest debt (or below one raw unit) after a repay is closed. */
  debtDustRel: number;
  /** Observations in the rolling median of a Jupiter Lend vault's exchange-price factor. */
  vaultFactorWindow: number;
};
export const defaultLendingReconstructParams = (): LendingReconstructParams => ({
  ltvBucketsPct: [10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 100],
  minExchangeObsRaw: 1_000_000,
  debtDustRel: 1e-6,
  vaultFactorWindow: 25,
});

// ---------------------------------------------------------------------------------------------------------------
// Kamino reserve configuration history

/** The fields of a klend `ReserveConfig` that accrual and the hourly rows use. */
export type KaminoAccrualConfig = {
  status: number;
  interestRateBasis: number;
  hostFixedInterestRateBps: number;
  protocolTakeRatePct: number;
  loanToValuePct: number;
  liquidationThresholdPct: number;
  borrowRateCurve: KaminoCurvePoint[];
  depositLimit: bigint;
  borrowLimit: bigint;
};

/** A reserve's configuration right after `initReserve`: all zero, as klend initialises it. */
export const emptyKaminoConfig = (): KaminoAccrualConfig => ({
  status: 0,
  interestRateBasis: 0,
  hostFixedInterestRateBps: 0,
  protocolTakeRatePct: 0,
  loanToValuePct: 0,
  liquidationThresholdPct: 0,
  borrowRateCurve: Array.from({ length: 11 }, () => ({ utilizationBps: 0, borrowRateBps: 0 })),
  depositLimit: 0n,
  borrowLimit: 0n,
});

/** Offset of `config` in a Reserve account; a `ReserveConfig` is 920 bytes. */
const RESERVE_CONFIG_OFFSET = 4856;
const RESERVE_CONFIG_SIZE = 920;

const pick = (c: ReturnType<typeof decodeKaminoReserve>['config']): KaminoAccrualConfig => ({
  status: c.status,
  interestRateBasis: c.interestRateBasis,
  hostFixedInterestRateBps: c.hostFixedInterestRateBps,
  protocolTakeRatePct: c.protocolTakeRatePct,
  loanToValuePct: c.loanToValuePct,
  liquidationThresholdPct: c.liquidationThresholdPct,
  borrowRateCurve: c.borrowRateCurve,
  depositLimit: c.depositLimit,
  borrowLimit: c.borrowLimit,
});

/** The accrual fields of a reserve account's current configuration. */
export const kaminoAccrualConfig = (r: ReturnType<typeof decodeKaminoReserve>) => pick(r.config);

/** Decode a whole `ReserveConfig` (the value of `UpdateEntireReserveConfig`) with the reserve reader. */
export function kaminoConfigFromBlob(hex: string): KaminoAccrualConfig {
  const blob = Buffer.from(hex, 'hex');
  if (blob.length !== RESERVE_CONFIG_SIZE) throw new Error(`reserve config blob ${blob.length}`);
  const bytes = new Uint8Array(KAMINO_RESERVE_SIZE);
  bytes.set(blob, RESERVE_CONFIG_OFFSET);
  return pick(decodeKaminoReserve(bytes).config);
}

const curveFromHex = (hex: string): KaminoCurvePoint[] => {
  const b = Buffer.from(hex, 'hex');
  if (b.length !== 88) throw new Error(`borrow rate curve ${b.length}`);
  return Array.from({ length: 11 }, (_, i) => ({
    utilizationBps: b.readUInt32LE(8 * i),
    borrowRateBps: b.readUInt32LE(8 * i + 4),
  }));
};

/** Apply one `updateReserveConfig` change (klend `UpdateConfigMode` name, decoded value) to a configuration.
 *  Returns false when the parameter does not affect the fields kept here. */
export function applyKaminoConfigChange(
  c: KaminoAccrualConfig,
  param: string,
  value: string,
): boolean {
  switch (param) {
    case 'UpdateEntireReserveConfig':
    case 'DeprecatedUpdateEntireReserveConfig':
      Object.assign(c, kaminoConfigFromBlob(value));
      return true;
    case 'UpdateBorrowRateCurve':
      c.borrowRateCurve = curveFromHex(value);
      return true;
    case 'UpdateProtocolTakeRate':
      c.protocolTakeRatePct = Number(value);
      return true;
    case 'UpdateHostFixedInterestRateBps':
      c.hostFixedInterestRateBps = Number(value);
      return true;
    case 'UpdateInterestRateBasis':
      c.interestRateBasis = Number(value);
      return true;
    case 'UpdateLoanToValuePct':
      c.loanToValuePct = Number(value);
      return true;
    case 'UpdateLiquidationThresholdPct':
      c.liquidationThresholdPct = Number(value);
      return true;
    case 'UpdateDepositLimit':
      c.depositLimit = BigInt(value);
      return true;
    case 'UpdateBorrowLimit':
      c.borrowLimit = BigInt(value);
      return true;
    case 'UpdateReserveStatus':
      c.status = Number(value);
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Kamino accrual

/** klend `approximate_compounded_interest`: (1 + rate/unitsPerYear)^units, exact up to 4 units, else the
 *  third-order expansion the program uses. */
export function kaminoCompound(rate: number, units: number, unitsPerYear: number): number {
  const base = rate / unitsPerYear;
  if (units <= 0) return 1;
  if (units <= 4) return (1 + base) ** units;
  const first = base * units;
  const second = (first * base * (units - 1)) / 2;
  const third = (second * base * (units - 2)) / 3;
  return 1 + first + second + third;
}

export const KAMINO_TRUE_APR_SECONDS_PER_YEAR = 31_536_000;

/** A Kamino reserve being replayed. `borrowed` and `fees` are raw units (floats: klend keeps them as 60-bit scaled
 *  fractions); `index` is the cumulative borrow index (1 at `initReserve`). */
export type KaminoReserveSim = {
  available: bigint;
  ctoken: bigint;
  borrowed: number;
  fees: number;
  index: number;
  lastSlot: number;
  lastTs: number;
  config: KaminoAccrualConfig;
};

export const newKaminoReserveSim = (slot: number, ts: number): KaminoReserveSim => ({
  available: 0n,
  ctoken: 0n,
  borrowed: 0,
  fees: 0,
  index: 1,
  lastSlot: slot,
  lastTs: ts,
  config: emptyKaminoConfig(),
});

export const kaminoTotalSupply = (s: Pick<KaminoReserveSim, 'available' | 'borrowed' | 'fees'>) =>
  Number(s.available) + s.borrowed - s.fees;
export const kaminoUtilization = (s: Pick<KaminoReserveSim, 'available' | 'borrowed' | 'fees'>) => {
  const supply = kaminoTotalSupply(s);
  return supply > 0 ? s.borrowed / supply : 0;
};

/** klend `Reserve::compound_interest` from the last refresh to (slot, ts), in place. The variable rate is the
 *  curve value at the utilisation before accrual, plus the host fixed rate; the protocol keeps its take rate of the
 *  variable interest and all of the fixed interest (no referrer fees). Legacy reserves count slots, TrueApr ones
 *  seconds. */
export function kaminoAccrue(s: KaminoReserveSim, slot: number, ts: number) {
  const trueApr = s.config.interestRateBasis === 1;
  const units = trueApr ? ts - s.lastTs : slot - s.lastSlot;
  const perYear = trueApr ? KAMINO_TRUE_APR_SECONDS_PER_YEAR : KAMINO_SLOTS_PER_YEAR;
  if (units > 0 && s.borrowed > 0) {
    const variable = kaminoCurveRate(s.config.borrowRateCurve, kaminoUtilization(s));
    const fixed = s.config.hostFixedInterestRateBps / 10_000;
    const g = kaminoCompound(variable + fixed, units, perYear);
    const gFixed = kaminoCompound(fixed, units, perYear);
    const prev = s.borrowed;
    const fixedFee = prev * gFixed - prev;
    const netNew = prev * g - prev - fixedFee;
    s.fees += netNew * (s.config.protocolTakeRatePct / 100) + fixedFee;
    s.borrowed = prev * g;
    s.index *= g;
  } else if (units > 0) {
    // no debt: the index still moves with the curve's rate at zero utilisation
    const rate =
      kaminoCurveRate(s.config.borrowRateCurve, 0) + s.config.hostFixedInterestRateBps / 10_000;
    s.index *= kaminoCompound(rate, units, perYear);
  }
  if (slot > s.lastSlot) s.lastSlot = slot;
  if (ts > s.lastTs) s.lastTs = ts;
}

/** A copy accrued to (slot, ts), for reporting without moving the replay. */
export const kaminoViewAt = (s: KaminoReserveSim, slot: number, ts: number) => {
  const v = { ...s, config: s.config };
  kaminoAccrue(v, slot, ts);
  return v;
};

/** Rates of a reserve state. `slotMs` is the measured slot duration around the time: a Legacy reserve's configured
 *  per-slot rate is realised at 500 / slotMs of its nominal value (as `kaminoReserveState`). */
export function kaminoRates(s: KaminoReserveSim, slotMs: number) {
  const u = kaminoUtilization(s);
  const configured =
    kaminoCurveRate(s.config.borrowRateCurve, u) + s.config.hostFixedInterestRateBps / 10_000;
  const legacy = s.config.interestRateBasis === 0;
  const factor = legacy ? 500 / slotMs : 1;
  const borrowApr = configured * factor;
  const supplyApr = borrowApr * u * (1 - s.config.protocolTakeRatePct / 100);
  const periods = legacy ? KAMINO_SLOTS_PER_YEAR * factor : KAMINO_TRUE_APR_SECONDS_PER_YEAR;
  const apy = (apr: number) => (1 + apr / periods) ** periods - 1;
  return {
    utilization: u,
    borrowAprConfigured: configured,
    borrowApr,
    supplyApr,
    borrowApy: apy(borrowApr),
    supplyApy: apy(supplyApr),
  };
}

export type KaminoReserveStep = {
  available: bigint;
  borrowed: bigint;
  ctoken: bigint;
  /** Protocol fees paid out of the supply vault (`redeemFees`), raw units, positive. */
  feesRedeemed: bigint;
  unsupported: number;
};

/** What one transaction's events did to a reserve (as `reserveDeltas`), plus the fees `redeemFees` moved out of
 *  the supply vault (they leave both the available liquidity and the accumulated fees). */
export function kaminoReserveStep(events: readonly LendingEvent[], k: ReserveKeys) {
  const d = reserveDeltas(events, k);
  let feesRedeemed = 0n;
  for (const e of events)
    if (e.program === 'klend' && e.ix === 'redeemFees' && e.accounts.reserve === k.reserve)
      for (const f of e.flows)
        if (f.account === k.liquiditySupplyVault) feesRedeemed -= BigInt(f.delta);
  return { ...d, feesRedeemed } satisfies KaminoReserveStep;
}

/** Apply a step after accrual. The seed liquidity of `initReserve` mints the same number of cTokens (klend starts
 *  every reserve at an exchange rate of 1), which the decoded supply changes do not show. */
export function kaminoApplyStep(s: KaminoReserveSim, d: KaminoReserveStep, init = false) {
  s.available += d.available;
  s.ctoken += d.ctoken;
  if (init && d.ctoken === 0n) s.ctoken += d.available;
  s.borrowed += Number(d.borrowed);
  s.fees -= Number(d.feesRedeemed);
}

// ---------------------------------------------------------------------------------------------------------------
// Positions and LTV buckets

/** Bucket label for an LTV in percent: `≤10`, …, `≤100`, `>100`. */
export function ltvBucket(ltvPct: number, edges: readonly number[]): string {
  for (const e of edges) if (ltvPct <= e) return `<=${e}`;
  return `>${edges.at(-1)}`;
}
export const ltvBucketLabels = (edges: readonly number[]) => [
  ...edges.map((e) => `<=${e}`),
  `>${edges.at(-1)}`,
];

export type BucketRow = {
  positions: number;
  collateralUnits: number;
  collateralUsd: number;
  debtUsd: number;
};

/** One position for the hourly LTV table: its collateral asset (dominant by USD when it has several), collateral
 *  in whole units and USD, and debt in USD. USD is null when a price is missing. */
export type PositionValue = {
  asset: string;
  collateralUnits: number;
  collateralUsd: number | null;
  debtUsd: number | null;
  /**
   * Loan-to-value in percent on the venue's own oracle (PLAN-RISK D21): debt over collateral, both at the price the
   * venue liquidates on. When given, it decides the bucket, and the USD fields only feed the bucket's totals; null
   * means the venue's oracle had no recent price. When absent, the bucket comes from `debtUsd / collateralUsd`.
   */
  ltvPct?: number | null;
};

const bucketIn = (m: Record<string, BucketRow>, label: string): BucketRow => {
  const b = m[label] ?? { positions: 0, collateralUnits: 0, collateralUsd: 0, debtUsd: 0 };
  m[label] = b;
  return b;
};

/** Aggregate positions into per-asset LTV buckets. Positions without debt are counted in `<=edges[0]` (LTV 0);
 *  positions with no LTV are counted under `ltvNull` with their units; positions that have an LTV (`ltvPct`) and
 *  no USD value are in their bucket and counted under `usdNull`, so a bucket's USD totals are known to be short. */
export function ltvTable(positions: readonly PositionValue[], edges: readonly number[]) {
  const out: Record<
    string,
    {
      positions: number;
      collateralUnits: number;
      ltvNull: number;
      ltvNullUnits: number;
      usdNull: number;
      buckets: Record<string, BucketRow>;
    }
  > = {};
  for (const p of positions) {
    out[p.asset] ??= {
      positions: 0,
      collateralUnits: 0,
      ltvNull: 0,
      ltvNullUnits: 0,
      usdNull: 0,
      buckets: {},
    };
    const a = out[p.asset] as NonNullable<(typeof out)[string]>;
    a.positions++;
    a.collateralUnits += p.collateralUnits;
    if (p.ltvPct !== undefined) {
      if (p.ltvPct === null) {
        a.ltvNull++;
        a.ltvNullUnits += p.collateralUnits;
        continue;
      }
      const b = bucketIn(a.buckets, ltvBucket(p.ltvPct, edges));
      b.positions++;
      b.collateralUnits += p.collateralUnits;
      if (p.collateralUsd === null || p.debtUsd === null) a.usdNull++;
      else {
        b.collateralUsd += p.collateralUsd;
        b.debtUsd += p.debtUsd;
      }
      continue;
    }
    if (p.collateralUsd === null || p.debtUsd === null || p.collateralUsd <= 0) {
      if (p.debtUsd === 0 && p.collateralUnits > 0 && p.collateralUsd === null) {
        // no debt: LTV is 0 whatever the price
        const b = bucketIn(a.buckets, ltvBucket(0, edges));
        b.positions++;
        b.collateralUnits += p.collateralUnits;
        continue;
      }
      a.ltvNull++;
      a.ltvNullUnits += p.collateralUnits;
      continue;
    }
    const b = bucketIn(a.buckets, ltvBucket((100 * p.debtUsd) / p.collateralUsd, edges));
    b.positions++;
    b.collateralUnits += p.collateralUnits;
    b.collateralUsd += p.collateralUsd;
    b.debtUsd += p.debtUsd;
  }
  // buckets in edge order
  const order = ltvBucketLabels(edges);
  for (const a of Object.values(out))
    a.buckets = Object.fromEntries(
      order.flatMap((l) => (a.buckets[l] ? [[l, a.buckets[l] as BucketRow]] : [])),
    );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Exchange-price series (Jupiter Lend)

export type ExchangeObs = { t: number; v: number };

/** Value at time t from observations sorted by time: log-linear between the two around t; past the last one,
 *  extended at the rate of the last two (flagged); before the first, the first. */
export function exchangeAt(obs: readonly ExchangeObs[], t: number) {
  if (!obs.length) return null;
  let lo = 0;
  let hi = obs.length - 1;
  if (t <= (obs[0] as ExchangeObs).t) return { v: (obs[0] as ExchangeObs).v, method: 'first' };
  const last = obs[hi] as ExchangeObs;
  if (t >= last.t) {
    const prev = obs[hi - 1];
    if (!prev || last.t === prev.t || prev.v <= 0)
      return { v: last.v, method: 'last', ageSec: t - last.t };
    const rate = Math.log(last.v / prev.v) / (last.t - prev.t);
    return { v: last.v * Math.exp(rate * (t - last.t)), method: 'extended', ageSec: t - last.t };
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((obs[mid] as ExchangeObs).t <= t) lo = mid;
    else hi = mid;
  }
  const a = obs[lo] as ExchangeObs;
  const b = obs[hi] as ExchangeObs;
  if (b.t === a.t || a.v <= 0) return { v: a.v, method: 'interpolated', spanSec: b.t - a.t };
  const w = (t - a.t) / (b.t - a.t);
  return { v: a.v * (b.v / a.v) ** w, method: 'interpolated', spanSec: b.t - a.t };
}

/** Annual rate implied by an exchange-price series around t (log growth between the observations around it). */
export function impliedApr(obs: readonly ExchangeObs[], t: number): number | null {
  if (obs.length < 2) return null;
  let i = obs.findIndex((o) => o.t > t);
  if (i <= 0) i = i === 0 ? 1 : obs.length - 1;
  const a = obs[i - 1] as ExchangeObs;
  const b = obs[i] as ExchangeObs;
  if (b.t <= a.t || a.v <= 0) return null;
  return (Math.log(b.v / a.v) / (b.t - a.t)) * KAMINO_TRUE_APR_SECONDS_PER_YEAR;
}

/** Median of the observations' values among the `k` latest at or before t (the `k` first when t is earlier). A
 *  Jupiter Lend vault's exchange price is the liquidity layer's times a factor that moves only with the vault's
 *  rate magnifier; single observations of that factor are noisy (positions are snapped to ticks), the median of
 *  the recent ones is not. */
export function rollingMedianAt(obs: readonly ExchangeObs[], t: number, k: number): number | null {
  if (!obs.length) return null;
  let hi = obs.findIndex((o) => o.t > t);
  if (hi === -1) hi = obs.length;
  const lo = Math.max(0, hi - k);
  const win = (hi > 0 ? obs.slice(lo, hi) : obs.slice(0, k)).map((o) => o.v).sort((a, b) => a - b);
  return win[Math.floor(win.length / 2)] ?? null;
}
