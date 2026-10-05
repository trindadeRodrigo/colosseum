import type { LegOrder, LiquidityAssessment, Policy } from '@colosseum/schemas';
import { computeDrift, type PositionValue } from './drift';

export type RebalanceInput = {
  policy: Policy;
  targets: Record<string, number>;
  positions: PositionValue[];
  /** Assets that can be swapped directly on a DEX (Token program). Others need withdraw/deposit and stay user-signed. */
  dexAssets: Set<string>;
  minOrderUsd?: number;
  now?: Date;
  lastRebalanceAt?: Date;
  /** Optional liquidity assessment (risk layer). A likely breach takes precedence over drift. */
  liquidity?: LiquidityAssessment;
};

export type RebalanceProposal = { triggered: boolean; reason: string; orders: LegOrder[] };

/**
 * Deterministic rebalance: when any asset is outside its band (or drift exceeds the trigger), move value from the
 * most over-weight assets to the most under-weight ones until each is back at target. One swap per order.
 * Invariants (tested): only allowed assets; destination is always the owner; no order exceeds the over-weight
 * excess; mechanism is `delegated` only when both legs are DEX assets, the policy allows it, and the delegate
 * approval covers the amount.
 */
export function proposeRebalance(input: RebalanceInput): RebalanceProposal {
  const { policy, targets, positions, dexAssets } = input;
  const minOrderUsd = input.minOrderUsd ?? 1;
  const now = input.now ?? new Date();
  if (
    input.lastRebalanceAt &&
    now.getTime() - input.lastRebalanceAt.getTime() < policy.trigger.minIntervalHours * 3600_000
  ) {
    return { triggered: false, reason: 'inside minimum interval', orders: [] };
  }
  const allowed = new Set(policy.allowedAssets);
  const d = computeDrift(
    policy,
    targets,
    positions.filter((p) => allowed.has(p.assetId)),
  );
  if (d.total <= 0) return { triggered: false, reason: 'no positions', orders: [] };
  if (input.liquidity?.likelyBreach && input.liquidity.orders.length > 0)
    return liquidityProposal(input, d.total, positions);
  const triggered = d.anyOutOfBand || d.maxAbsDrift * 100 >= policy.trigger.driftPct;
  if (!triggered)
    return {
      triggered: false,
      reason: `max drift ${(d.maxAbsDrift * 100).toFixed(2)}% within trigger ${policy.trigger.driftPct}% and bands`,
      orders: [],
    };

  const over = d.rows
    .filter((r) => allowed.has(r.assetId) && r.drift > 0)
    .map((r) => ({ id: r.assetId, excess: r.drift * d.total }))
    .sort((a, b) => b.excess - a.excess);
  const under = d.rows
    .filter((r) => allowed.has(r.assetId) && r.drift < 0)
    .map((r) => ({ id: r.assetId, need: -r.drift * d.total }))
    .sort((a, b) => b.need - a.need);
  const orders: LegOrder[] = [];
  for (const o of over) {
    for (const u of under) {
      // small tolerance: drift arithmetic in floating point can land a hair under the minimum
      if (o.excess < minOrderUsd - 1e-6) break;
      if (u.need < minOrderUsd - 1e-6) continue;
      const amountUsd = Math.min(o.excess, u.need);
      orders.push({
        fromAssetId: o.id,
        toAssetId: u.id,
        amountUsd: round2(amountUsd),
        mechanism: mechanismFor(policy, o.id, u.id, amountUsd, dexAssets),
        destination: policy.withdrawalDestination,
        reason: `${o.id} over target by ${round2(o.excess)} USD, ${u.id} under by ${round2(u.need)} USD`,
      });
      o.excess -= amountUsd;
      u.need -= amountUsd;
    }
  }
  return {
    triggered: true,
    reason: d.anyOutOfBand
      ? 'an asset is outside its band'
      : `max drift ${(d.maxAbsDrift * 100).toFixed(2)}% >= trigger ${policy.trigger.driftPct}%`,
    orders,
  };
}

function mechanismFor(
  policy: Policy,
  from: string,
  to: string,
  amountUsd: number,
  dexAssets: Set<string>,
): 'delegated' | 'user_signed' {
  const perAsset = (id: string) => policy.mechanismByAsset[id] ?? policy.mechanism;
  if (perAsset(from) !== 'delegated' || perAsset(to) !== 'delegated') return 'user_signed';
  if (!dexAssets.has(from) || !dexAssets.has(to)) return 'user_signed';
  const approved = policy.delegation?.approvedBase[from];
  // Approval is in base units of `from`; without a price we require the approval to cover the USD amount at par
  // (conservative for assets trading above 1 USD, checked exactly at execution time).
  if (!approved || Number(approved) / 1_000_000 < amountUsd) return 'user_signed';
  return 'delegated';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Liquidity-breach proposal: sell illiquid legs to USDC ahead of a withdrawal that the measured exit capacity
 * may not cover under the dry stress. Invariants (tested): only allowed assets; destination is always the owner;
 * orders only reduce the legs the assessment names, never by more than their current value; USDC never ends
 * above its band max.
 */
function liquidityProposal(
  input: RebalanceInput,
  total: number,
  positions: RebalanceInput['positions'],
): RebalanceProposal {
  const { policy, dexAssets } = input;
  const a = input.liquidity as LiquidityAssessment;
  const allowed = new Set(policy.allowedAssets);
  if (!allowed.has('usdc'))
    return {
      triggered: false,
      reason: 'liquidity_breach found but USDC is not an allowed asset in this policy',
      orders: [],
    };
  const value = new Map(positions.map((p) => [p.assetId, p.valueUsd]));
  const band = policy.bands.find((b) => b.assetId === 'usdc');
  let usdcRoom = band
    ? Math.max(0, band.max * total - (value.get('usdc') ?? 0))
    : Number.POSITIVE_INFINITY;
  const orders: LegOrder[] = [];
  for (const o of a.orders) {
    if (!allowed.has(o.fromAssetId) || o.fromAssetId === 'usdc') continue;
    const amount = Math.min(o.amountUsd, value.get(o.fromAssetId) ?? 0, usdcRoom);
    if (amount < (input.minOrderUsd ?? 1) - 1e-6) continue;
    usdcRoom -= amount;
    orders.push({
      fromAssetId: o.fromAssetId,
      toAssetId: 'usdc',
      amountUsd: round2(amount),
      mechanism: mechanismFor(policy, o.fromAssetId, 'usdc', amount, dexAssets),
      destination: policy.withdrawalDestination,
      reason: `liquidity_breach: shortfall ${round2(a.shortfallUsd)} USD under the dry stress in ${a.monthsAtRisk.join(', ')} (${a.methodVersion})`,
    });
  }
  return {
    triggered: orders.length > 0,
    reason:
      orders.length > 0
        ? 'liquidity_breach'
        : 'liquidity_breach found but no order fits the policy limits',
    orders,
  };
}
