import {
  type AssetCurves,
  liquidityScore,
  measuredRegimes,
  weekendRatio,
  worstMeasuredCapacity,
} from './assess';
import type { RegimeParams } from './time';
import { REGIMES, regimesIn } from './time';

/**
 * Liquidity breach (method risk-0.2). Withdrawals are drawn in order from the BRL leg, cash, then liquid
 * USD legs; what remains (`need`) must come from illiquid legs. Capacity per withdrawal is
 * Σ min(holding, shareOfDepth × worst-regime exit capacity at tau inside [t − window, t]).
 *   breach        some withdrawal has capacity < need
 *   likelyBreach  same under the dry stress: capacity × d, d = max(dryFactorFloor, min(1, weekend ratio))
 * Recommended orders sell illiquid legs to USDC now, least liquid first, until likelyBreach is false.
 */
export type BreachInput = {
  cashUsd: number;
  brlUsd: number;
  liquid: Array<{ assetId: string; valueUsd: number }>;
  illiquid: Array<{ assetId: string; valueUsd: number; curves: AssetCurves }>;
  withdrawals: Array<{ at: string; usd: number }>;
  windowDays: number;
  tau: number;
  shareOfDepth: number;
  dryFactorFloor: number;
  regimeParams: RegimeParams;
};

export type WithdrawalCheck = {
  at: string;
  usd: number;
  need: number;
  capacity: number;
  capacityDry: number;
  breach: boolean;
  likelyBreach: boolean;
};

export type LiquidityOrder = {
  fromAssetId: string;
  toAssetId: 'usdc';
  amountUsd: number;
  reason: 'liquidity_breach';
};

function check(inp: BreachInput): WithdrawalCheck[] {
  let brl = inp.brlUsd;
  let cash = inp.cashUsd;
  const liquid = inp.liquid.map((l) => ({ ...l }));
  const ill = inp.illiquid.map((l) => ({ ...l }));
  const out: WithdrawalCheck[] = [];
  for (const w of [...inp.withdrawals].sort((a, b) => a.at.localeCompare(b.at))) {
    let need = w.usd;
    const fromBrl = Math.min(brl, need);
    brl -= fromBrl;
    need -= fromBrl;
    const fromCash = Math.min(cash, need);
    cash -= fromCash;
    need -= fromCash;
    const liqTotal = liquid.reduce((s, l) => s + l.valueUsd, 0);
    const fromLiq = Math.min(liqTotal, need);
    for (const l of liquid) l.valueUsd -= liqTotal > 0 ? (l.valueUsd / liqTotal) * fromLiq : 0;
    need -= fromLiq;
    const t = new Date(w.at);
    const from = new Date(t.getTime() - inp.windowDays * 86_400_000);
    const regimes = regimesIn(from, inp.windowDays * 24, inp.regimeParams);
    let capacity = 0;
    let capacityDry = 0;
    const caps = ill.map((l) => {
      // a regime the curves do not measure is skipped and named, never read as zero capacity (DA2)
      const w = worstMeasuredCapacity(l.curves, regimes, inp.tau);
      const c = Math.min(l.valueUsd, inp.shareOfDepth * (w?.capacityUsd ?? 0));
      const rho = weekendRatio(l.curves, inp.tau);
      const d = Math.max(inp.dryFactorFloor, Math.min(1, rho ?? inp.dryFactorFloor));
      capacity += c;
      capacityDry += c * d;
      return c;
    });
    out.push({
      at: w.at,
      usd: w.usd,
      need,
      capacity,
      capacityDry,
      breach: capacity + 1e-9 < need,
      likelyBreach: capacityDry + 1e-9 < need,
    });
    // the illiquid legs fund the need (pro rata to capacity) before the next withdrawal
    const capTotal = caps.reduce((s, c) => s + c, 0);
    if (need > 0 && capTotal > 0)
      ill.forEach((l, i) => {
        l.valueUsd = Math.max(
          0,
          l.valueUsd - ((caps[i] as number) / capTotal) * Math.min(need, capTotal),
        );
      });
  }
  return out;
}

export function assessLiquidity(inp: BreachInput) {
  const checks = check(inp);
  const orders: LiquidityOrder[] = [];
  let state = inp;
  let after = checks;
  // least liquid first: lowest score at the plan's window
  // least liquid first, judged over every regime (no clock: the result must not depend on when it runs)
  const regimesAll = REGIMES;
  const order = [...inp.illiquid].sort(
    (a, b) =>
      liquidityScore(a.curves, regimesAll, inp.tau, a.valueUsd).score -
      liquidityScore(b.curves, regimesAll, inp.tau, b.valueUsd).score,
  );
  for (let iter = 0; iter < 20 && after.some((c) => c.likelyBreach); iter++) {
    const first = after.find((c) => c.likelyBreach) as WithdrawalCheck;
    let gap = first.need - first.capacityDry;
    for (const leg of order) {
      const held = state.illiquid.find((l) => l.assetId === leg.assetId);
      if (!held || held.valueUsd <= 0 || gap <= 0) continue;
      const amt = Math.min(held.valueUsd, gap);
      orders.push({
        fromAssetId: leg.assetId,
        toAssetId: 'usdc',
        amountUsd: Math.round(amt * 100) / 100,
        reason: 'liquidity_breach',
      });
      state = {
        ...state,
        cashUsd: state.cashUsd + amt,
        illiquid: state.illiquid.map((l) =>
          l.assetId === leg.assetId ? { ...l, valueUsd: l.valueUsd - amt } : l,
        ),
      };
      gap -= amt;
    }
    after = check(state);
    if (gap > 1e-6) break; // nothing left to sell
  }
  // merge orders per asset
  const merged = new Map<string, number>();
  for (const o of orders) merged.set(o.fromAssetId, (merged.get(o.fromAssetId) ?? 0) + o.amountUsd);
  const monthsAtRisk = checks.filter((c) => c.likelyBreach).map((c) => c.at.slice(0, 7));
  // regimes inside a withdrawal's window that a leg's curves do not measure (DA2)
  const missing = new Map<string, { assetId: string; regime: string }>();
  for (const w of inp.withdrawals) {
    const from = new Date(new Date(w.at).getTime() - inp.windowDays * 86_400_000);
    const regimes = regimesIn(from, inp.windowDays * 24, inp.regimeParams);
    for (const l of inp.illiquid)
      for (const m of measuredRegimes(l.curves, regimes).missing)
        missing.set(`${l.assetId}:${m.regime}`, { assetId: l.assetId, regime: m.regime });
  }
  return {
    breach: checks.some((c) => c.breach),
    likelyBreach: checks.some((c) => c.likelyBreach),
    shortfallUsd: Math.max(0, ...checks.map((c) => c.need - c.capacityDry)),
    monthsAtRisk,
    regimesMissing: [...missing.values()],
    checks,
    orders: [...merged.entries()].map(([fromAssetId, amountUsd]) => ({
      fromAssetId,
      toAssetId: 'usdc' as const,
      amountUsd: Math.round(amountUsd * 100) / 100,
      reason: 'liquidity_breach' as const,
    })),
    afterOrders: {
      breach: after.some((c) => c.breach),
      likelyBreach: after.some((c) => c.likelyBreach),
    },
    params: {
      windowDays: inp.windowDays,
      tau: inp.tau,
      shareOfDepth: inp.shareOfDepth,
      dryFactorFloor: inp.dryFactorFloor,
    },
  };
}

// ---------------------------------------------------------------- weekend-gap simulator

export type MarketParams = {
  /** Liquidation threshold as a fraction of collateral value. */
  ltvLiq: number;
  closeFactor: number;
  /** Above this LTV the whole debt can be liquidated at once. */
  fullLiqLtv: number;
  liqBonus: number;
  /** Max oracle move allowed while the primary market is closed (price band); 1 = no band. */
  bandPct: number;
  provenance: 'live' | 'fixture' | 'assumption';
  source: string;
};

/**
 * For a gap g at reopen: positions with debt > ltvLiq × C(1−g) become liquidatable; repay = closeFactor × debt
 * (or all above fullLiqLtv); seized collateral = repay × (1 + liqBonus), sold at the reopen cost curve.
 * While closed, the oracle can move at most bandPct, so debt that is underwater at C(1−g) but not at
 * C(1−min(g, bandPct)) cannot be liquidated until reopen.
 */
export function gapSim(
  market: MarketParams,
  positions: Array<{ collateralUsd: number; debtUsd: number }>,
  gapPct: number,
  reopenCost: (n: number) => number | null,
) {
  let liquidatableDebt = 0;
  let repay = 0;
  let seized = 0;
  let unliquidatableWhileClosed = 0;
  for (const p of positions) {
    const cGap = p.collateralUsd * (1 - gapPct);
    const cBand = p.collateralUsd * (1 - Math.min(gapPct, market.bandPct));
    if (p.debtUsd > market.ltvLiq * cGap) {
      liquidatableDebt += p.debtUsd;
      const full = cGap > 0 && p.debtUsd / cGap > market.fullLiqLtv;
      const r = full ? p.debtUsd : market.closeFactor * p.debtUsd;
      repay += r;
      seized += Math.min(cGap, r * (1 + market.liqBonus));
      if (p.debtUsd <= market.ltvLiq * cBand) unliquidatableWhileClosed += p.debtUsd;
    }
  }
  const cost = seized > 0 ? reopenCost(seized) : 0;
  return {
    gapPct,
    liquidatableDebtUsd: liquidatableDebt,
    repayUsd: repay,
    seizedCollateralUsd: seized,
    recoverableOfSeizedUsd: cost === null ? null : seized * (1 - cost),
    unliquidatableWhileClosedDebtUsd: unliquidatableWhileClosed,
    assumptions: [
      `ltvLiq ${market.ltvLiq}, closeFactor ${market.closeFactor}, fullLiqLtv ${market.fullLiqLtv}, liqBonus ${market.liqBonus}, bandPct ${market.bandPct} (${market.provenance}: ${market.source})`,
      'seized collateral sold in one block at the reopen-regime sell curve',
      'oracle tracks the gap fully at reopen; no partial recovery before reopen',
    ],
  };
}
