import { apportion, formatDecimal, measureVault, rebalancePlan } from '@colosseum/basket';
import {
  BasketAsset,
  BasketLine,
  FxObservation,
  type Language,
  LiquidityAssessment,
  Obligation,
  PlanSplitSleeve,
  Price,
  RawAmount,
  type Reason,
  type RebalancePlan,
  type Target,
  VaultState,
  YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import { legTypesOf } from './leg-types';
import { BPS, byName, split, sum, toCents, toUsd } from './money';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal } from './registry';
import { reason } from './templates';
import { PersonalInputError, PersonalParameters, PersonalSheet } from './types';
import { monthAfter } from './world';

// Rebalancing, sleeve by sleeve (ENG-3 slice 4; docs/vault/PROMPT-BUILD-SOLVER.md). The output is a
// list of proposals the person taps: nothing here is sent, and the keeper does not rebalance on drift
// in the MVP. Pure: the stored plan, the vault as read, the prices and the readings come in as
// arguments, the time with them, and the same inputs give the same proposals in any order.
//
// The order, first to last:
//   1. A likely liquidity breach (the risk layer's assessment, as the policy engine reads it): its
//      sales to cash come first, alone, and every other proposal waits.
//   2. With `restoreSplit` on, the split itself, once the sleeves are the drift band away from the
//      shares the person set. That one proposal brings every sleeve to its targets too.
//   3. Each sleeve against its own targets: a switch of the safe-yield sleeve on the switch rule, the
//      goal sleeve's set-aside refilled, a deposit or a withdrawal, or drift at the band.
//
// Trades come from `rebalancePlan` of packages/basket, on a vault cut to the sleeve: its share of each
// token and of the cash. No second rebalancer is written here.

/** One of the person's sleeves, as a proposal names it. */
export type SleeveRef = { kind: PlanSplitSleeve['kind']; theme?: string };

export type SleeveRebalanceKind =
  | 'liquidity_breach'
  | 'restore_split'
  | 'safe_yield_switch'
  | 'set_aside_refill'
  | 'flow'
  | 'drift';

/** A proposal: the trades and why, for one sleeve, or for the whole plan (`sleeve: null`). */
export type SleeveProposal = {
  kind: SleeveRebalanceKind;
  sleeve: SleeveRef | null;
  /** Half the sum of absolute differences from the stored targets, before, in bps of the sleeve (or plan). */
  driftBps: number;
  /** What the sleeve (or the plan) holds once the trades land, in bps of it; cash is the rest. */
  targets: Target[];
  /** Sales first, then purchases, every trade through the vault's cash token. */
  plan: RebalancePlan;
  reasons: Reason[];
  /** The yield readings a switch was decided on, each with its source, time and method. */
  observations?: YieldObservation[];
};

export type SleeveProposals = {
  proposals: SleeveProposal[];
  /** What a liquidity breach holds back: planned again once its sales are done. */
  waiting: { kind: SleeveRebalanceKind; sleeve: SleeveRef | null }[];
  /** How far the sleeves are from the person's shares, in bps of the plan. */
  splitDriftBps: number;
  flags: string[];
};

/** The parts of a stored plan a rebalance reads: the shared `BasketProposal` fits. */
export const StoredPlan = z.object({
  sheet: PersonalSheet,
  lines: z.array(BasketLine.pick({ assetId: true, amountUsd: true })),
  split: z.array(PlanSplitSleeve).optional(),
});
export type StoredPlan = z.input<typeof StoredPlan>;

export const SleeveRebalanceContext = z.object({
  /** ISO time the proposals are made at. */
  now: z.string().datetime(),
  /** The plan's vault, as read from its chain. */
  vault: VaultState,
  prices: z.array(Price),
  /** The chain's asset list: decimals, symbols, classes. */
  assets: z.array(BasketAsset),
  /** Cash about to come in, in raw units of the vault's cash token. */
  deposit: RawAmount.optional(),
  /** Cash about to go out to the person, in raw units of the vault's cash token. */
  withdrawal: RawAmount.optional(),
  /** The last month whose withdrawal is paid. Left out: none of this month's is. */
  paidThrough: Obligation.shape.month.optional(),
  /** Dated yield readings, keyed by asset id: the history the safe-yield switch reads. */
  yields: z.array(YieldObservation).optional(),
  /** FX readings, pair `USD<currency>`, for a withdrawal not in dollars. */
  fx: z.array(FxObservation).optional(),
  /** The risk layer's assessment of the vault and its withdrawals (`LiquidityProvider.assess`). */
  liquidity: LiquidityAssessment.optional(),
  params: PersonalParameters.optional(),
});
export type SleeveRebalanceContext = z.input<typeof SleeveRebalanceContext>;

type Cents = Map<string, number>;
type Raw = Map<string, bigint>;

type Sleeve = {
  ref: SleeveRef;
  key: string;
  shareBps: number;
  /** The stored targets, by token, in cents of the plan as it was made (cash included). */
  planned: Cents;
};

const KIND_ORDER: Record<PlanSplitSleeve['kind'], number> = { goal: 0, safe_yield: 1, theme: 2 };
const keyOf = (s: SleeveRef) => (s.kind === 'theme' ? `theme:${s.theme ?? ''}` : s.kind);
const add = <K>(m: Map<K, number>, k: K, n: number) => m.set(k, (m.get(k) ?? 0) + n);
const totalOf = (m: Cents) => sum([...m.values()]);
const sortedKeys = <V>(m: Map<string, V>) => [...m.keys()].sort();

/** Half the sum of absolute differences, in bps of `total`, rounded down. */
function driftOf(values: Cents, targets: Cents, total: number): number {
  if (total <= 0) return 0;
  const keys = new Set([...values.keys(), ...targets.keys()]);
  const apart = sum([...keys].map((k) => Math.abs((values.get(k) ?? 0) - (targets.get(k) ?? 0))));
  return Math.floor((apart * BPS) / (2 * total));
}

/** `total` cents in the weights' proportions, exactly; all zero weights give all zeros. */
function scaled(total: number, weights: Cents): Cents {
  const keys = sortedKeys(weights);
  const parts = split(
    Math.max(0, total),
    keys.map((k) => weights.get(k) ?? 0),
  );
  return new Map(keys.map((k, i) => [k, parts[i] ?? 0]));
}

/** The UTC day of an ISO time, `back` days before, as a number that orders and compares days. */
function dayOf(iso: string, back = 0): number {
  const [y = 0, m = 1, d = 1] = iso.split('T')[0]?.split('-').map(Number) ?? [];
  return Date.UTC(y, m - 1, d - back);
}

/**
 * The rebalance proposals for a stored plan and its vault now. Throws `PersonalInputError` with
 * `InvalidContext` for input it cannot use; it never guesses.
 */
export function proposeSleeveRebalances(
  planIn: StoredPlan,
  contextIn: SleeveRebalanceContext,
): SleeveProposals {
  const parsedPlan = StoredPlan.safeParse(planIn);
  const parsed = SleeveRebalanceContext.safeParse(contextIn);
  const issues = [
    ...(parsedPlan.success ? [] : parsedPlan.error.issues.map((i) => ({ ...i, at: 'plan' }))),
    ...(parsed.success ? [] : parsed.error.issues.map((i) => ({ ...i, at: 'context' }))),
  ];
  if (!parsedPlan.success || !parsed.success)
    throw new PersonalInputError(
      'InvalidContext',
      issues.map((i) => ({ path: [i.at, ...i.path].join('.'), message: i.message })),
    );
  const plan = parsedPlan.data;
  const ctx = parsed.data;
  const P = ctx.params ?? PERSONAL_PARAMS;
  const { sheet } = plan;
  const lang: Language = sheet.language;
  const band = P.driftBandBps;
  const flags = new Set<string>();
  const refuse = (path: string, message: string): never => {
    throw new PersonalInputError('InvalidContext', [{ path, message }]);
  };

  // ---- The vault, valued: each token's raw units and cents, in a fixed order.
  const vault = ctx.vault;
  const chain = sheet.chains[0];
  if (vault.chain !== chain)
    refuse(
      'context.vault.chain',
      `the plan lives on ${chain}, and this vault is on ${vault.chain}`,
    );
  const assets = byName(ctx.assets, (a) => a.id);
  const prices = byName(ctx.prices, (p) => p.asset);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const cashId = vault.cash.asset;
  const cashAsset = byId.get(cashId);
  if (!cashAsset) return refuse('context.assets', `${cashId}, the vault's cash, is not listed`);
  const merged = new Map<string, bigint>();
  for (const p of vault.positions) merged.set(p.asset, (merged.get(p.asset) ?? 0n) + BigInt(p.raw));
  const positionOf = new Map(vault.positions.map((p) => [p.asset, p]));
  const sortedVault: VaultState = {
    ...vault,
    positions: sortedKeys(merged).map((asset) => ({
      ...(positionOf.get(asset) ?? vault.positions[0]),
      asset,
      raw: (merged.get(asset) ?? 0n).toString(),
    })) as VaultState['positions'],
  };
  const measured = measureVault(sortedVault, prices, assets);
  const centsOfScaled = (v: bigint) => toCents(Number(formatDecimal(v)));
  const cashCents = (raw: bigint) => toCents(Number(raw) / 10 ** cashAsset.decimals);
  const heldRaw: Raw = new Map([[cashId, measured.cash.raw]]);
  const heldCents: Cents = new Map([[cashId, centsOfScaled(measured.cash.value ?? 0n)]]);
  const unpriced = new Set<string>();
  for (const m of measured.positions) {
    if (m.raw === 0n) continue;
    heldRaw.set(m.asset, m.raw);
    heldCents.set(m.asset, m.value === null ? 0 : centsOfScaled(m.value));
    if (m.value === null) unpriced.add(m.asset);
  }
  const priced = (id: string) =>
    id === cashId ||
    (prices.some((p) => p.asset === id && Number(p.usdPerToken) > 0) && byId.has(id));

  // ---- Cash moving now.
  const depositRaw = BigInt(ctx.deposit ?? '0');
  const withdrawalRaw = BigInt(ctx.withdrawal ?? '0');
  const depositCents = cashCents(depositRaw);
  const withdrawalCents = cashCents(withdrawalRaw);
  const vaultCents = totalOf(heldCents);
  if (withdrawalCents > vaultCents + depositCents)
    refuse('context.withdrawal', 'the withdrawal is more than the vault holds');

  // ---- The sleeves and their stored targets. The goal sleeve is the rest of every line.
  const lineCents: Cents = new Map();
  for (const l of plan.lines) add(lineCents, l.assetId, toCents(l.amountUsd));
  const planCents = totalOf(lineCents);
  const stored = plan.split ?? [
    { kind: 'goal' as const, shareBps: BPS, amountUsd: toUsd(planCents), holds: [] },
  ];
  const sleeves: Sleeve[] = stored
    .map((x) => {
      const ref: SleeveRef =
        x.kind === 'theme' ? { kind: 'theme', theme: x.theme ?? '' } : { kind: x.kind };
      const planned: Cents = new Map();
      for (const h of x.holds) add(planned, h.assetId, toCents(h.amountUsd));
      return { ref, key: keyOf(ref), shareBps: x.shareBps, planned };
    })
    .sort((a, b) =>
      a.ref.kind === b.ref.kind
        ? a.key < b.key
          ? -1
          : 1
        : KIND_ORDER[a.ref.kind] - KIND_ORDER[b.ref.kind],
    );
  const goal = sleeves.find((s) => s.ref.kind === 'goal');
  if (goal) {
    goal.planned = new Map();
    for (const id of sortedKeys(lineCents)) {
      const others = sum(sleeves.filter((s) => s !== goal).map((s) => s.planned.get(id) ?? 0));
      const rest = (lineCents.get(id) ?? 0) - others;
      if (rest > 0) goal.planned.set(id, rest);
    }
  }

  // ---- What each sleeve holds now: each token shared out in the proportions the plan gave it. A
  // token no sleeve was given goes to the goal sleeve (the rest of every line), or the first.
  const owner = goal ?? sleeves[0];
  const holding = new Map<string, { raw: Raw; cents: Cents }>(
    sleeves.map((s) => [s.key, { raw: new Map(), cents: new Map() }]),
  );
  for (const id of sortedKeys(heldRaw)) {
    let weights = sleeves.map((s) => s.planned.get(id) ?? 0);
    if (sum(weights) === 0)
      weights =
        id === cashId ? sleeves.map((s) => s.shareBps) : sleeves.map((s) => (s === owner ? 1 : 0));
    const raws = apportion(
      weights.map((w) => BigInt(w)),
      heldRaw.get(id) ?? 0n,
    );
    const cents = split(heldCents.get(id) ?? 0, weights);
    sleeves.forEach((s, i) => {
      const h = holding.get(s.key);
      if (!h || (raws[i] ?? 0n) === 0n) return;
      h.raw.set(id, raws[i] ?? 0n);
      h.cents.set(id, cents[i] ?? 0);
    });
  }
  const valueOfSleeve = (s: Sleeve) => totalOf(holding.get(s.key)?.cents ?? new Map());

  // ---- The deposit and the withdrawal, shared between the sleeves. With `restoreSplit` off, in
  // proportion to what each holds, so the split stays as it is (gate SLEEVES: between sleeves nothing
  // moves). With it on, new money goes to the sleeves under their share first and a withdrawal comes
  // from those over it first.
  const after = vaultCents + depositCents - withdrawalCents;
  const restore = sheet.restoreSplit === true && sleeves.length > 1;
  const flowWeights = (deposit: boolean): number[] => {
    const values = sleeves.map(valueOfSleeve);
    if (!restore) return values;
    const wanted = split(
      after,
      sleeves.map((s) => s.shareBps),
    );
    const gaps = values.map((v, i) =>
      Math.max(0, deposit ? (wanted[i] ?? 0) - v : v - (wanted[i] ?? 0)),
    );
    return sum(gaps) > 0 ? gaps : values;
  };
  const shareOut = (cents: number, raw: bigint, deposit: boolean) => {
    const weights = flowWeights(deposit);
    const safe = sum(weights) > 0 ? weights : sleeves.map((s) => s.shareBps);
    const c = split(cents, safe);
    const r = apportion(
      safe.map((w) => BigInt(w)),
      raw,
    );
    return sleeves.map((_, i) => ({ cents: c[i] ?? 0, raw: r[i] ?? 0n }));
  };
  const deposits = shareOut(depositCents, depositRaw, true);
  const withdrawals = shareOut(withdrawalCents, withdrawalRaw, false);

  // ---- The safe-yield sleeve: a switch, on the switch rule only.
  const switchOf = new Map<string, Switch>();
  const safe = sleeves.find((s) => s.ref.kind === 'safe_yield');
  if (safe) {
    const sw = switchFor(safe, sleeves, {
      P,
      sheet,
      chain,
      cashId,
      assets,
      priced,
      yields: ctx.yields ?? [],
      now: ctx.now,
      planCents,
      lang,
      flags,
    });
    if (sw) switchOf.set(safe.key, sw);
  }

  // ---- The goal sleeve's set-aside: the withdrawals of this month and the next, `setAsideMonths`
  // in all, less those already paid, in dollars.
  const refill = goal ? setAsideOwed(sheet.obligations ?? [], ctx, P, flags) : null;
  const isReserve = (id: string) => {
    if (id === cashId) return true;
    const a = byId.get(id);
    if (!a) return false;
    if (a.cls === 'cash') return true;
    const types = legTypesOf(a.symbol)?.types ?? [];
    return types.length > 0 && types.every((t) => t === 'rate');
  };

  /** A sleeve's targets at `value` cents: the stored ones, switched and refilled where they are. */
  const targetsOf = (s: Sleeve, value: number): Cents => {
    const weights = switchOf.get(s.key)?.weights ?? s.planned;
    const T = scaled(value, weights);
    if (s === goal && refill && refill.owed > 0) {
      const reserve = sum(
        sortedKeys(T)
          .filter(isReserve)
          .map((k) => T.get(k) ?? 0),
      );
      const short = Math.min(refill.owed, value) - reserve;
      if (short > 0) {
        const others = new Map(
          sortedKeys(T)
            .filter((k) => !isReserve(k))
            .map((k) => [k, T.get(k) ?? 0]),
        );
        const cut = scaled(Math.min(short, totalOf(others)), others);
        for (const [k, c] of cut) T.set(k, (T.get(k) ?? 0) - c);
        add(T, cashId, totalOf(cut));
      }
    }
    return T;
  };

  const costBps = Math.round(P.tau * BPS);
  /** `rebalancePlan` on the vault cut to these holdings, toward these targets (cents, cash left out). */
  const planFor = (cashRaw: bigint, held: Raw, targets: Cents, total: number): RebalancePlan => {
    const positions = sortedKeys(held)
      .filter((id) => id !== cashId && (held.get(id) ?? 0n) > 0n)
      .map((asset) => ({
        ...(positionOf.get(asset) ?? sortedVault.positions[0]),
        asset,
        raw: (held.get(asset) ?? 0n).toString(),
      })) as VaultState['positions'];
    const weights: Target[] = sortedKeys(targets)
      .filter((id) => id !== cashId && (targets.get(id) ?? 0) > 0)
      .map((asset) => ({
        asset,
        weightBps: total > 0 ? Math.floor(((targets.get(asset) ?? 0) * BPS) / total) : 0,
      }))
      .filter((t) => t.weightBps > 0);
    return rebalancePlan(
      { ...sortedVault, cash: { ...sortedVault.cash, raw: cashRaw.toString() }, positions },
      weights,
      prices,
      { bandBps: 0, minTradeUsd: P.minLineUsd, costBps },
      assets,
    );
  };
  const asTargets = (targets: Cents, total: number): Target[] =>
    sortedKeys(targets)
      .filter((id) => id !== cashId)
      .map((asset) => ({
        asset,
        weightBps: total > 0 ? Math.floor(((targets.get(asset) ?? 0) * BPS) / total) : 0,
      }))
      .filter((t) => t.weightBps > 0);

  // ---- Each sleeve's proposal, if it has one.
  const sleeveProposal = (s: Sleeve, i: number): SleeveProposal | null => {
    const h = holding.get(s.key) ?? { raw: new Map(), cents: new Map() };
    const part = s.key;
    if ([...h.raw.keys()].some((id) => unpriced.has(id))) {
      flags.add(`sleeve_not_weighed:${s.key}`);
      return null;
    }
    const V = totalOf(h.cents);
    const dIn = deposits[i] ?? { cents: 0, raw: 0n };
    const wOut = withdrawals[i] ?? { cents: 0, raw: 0n };
    const driftBps = driftOf(h.cents, scaled(V, s.planned), V);
    const T = targetsOf(s, V + dIn.cents - wOut.cents);
    // The vault as the sleeve plans on it: the deposit in its cash, the withdrawal still there and
    // held in cash as a target of its own, so it is what the trades leave behind.
    const total = V + dIn.cents;
    const tPrime = new Map(T);
    add(tPrime, cashId, wOut.cents);
    const values = new Map(h.cents);
    add(values, cashId, dIn.cents);
    const cashRaw = (h.raw.get(cashId) ?? 0n) + dIn.raw;
    const reasons: Reason[] = [];
    if (dIn.cents > 0)
      reasons.push(reason('REBALANCE_DEPOSIT', { usd: toUsd(dIn.cents), part }, lang));
    if (wOut.cents > 0)
      reasons.push(reason('REBALANCE_WITHDRAWAL', { usd: toUsd(wOut.cents), part }, lang));
    const sw = switchOf.get(s.key);
    let kind: SleeveRebalanceKind | null = null;
    let targets = tPrime;
    if (sw) {
      kind = 'safe_yield_switch';
      reasons.push(...sw.reasons);
    } else {
      const reserveHeld =
        sum(
          sortedKeys(values)
            .filter(isReserve)
            .map((k) => values.get(k) ?? 0),
        ) - wOut.cents;
      const short = s === goal && refill ? refill.owed - reserveHeld : 0;
      const refilling = refill !== null && short > 0 && toUsd(short) >= P.minLineUsd;
      if (refilling && refill)
        reasons.push(
          reason(
            'SET_ASIDE_REFILL',
            {
              from: refill.from,
              to: refill.to,
              owedUsd: toUsd(refill.owed),
              heldUsd: toUsd(Math.max(0, reserveHeld)),
              shortUsd: toUsd(short),
              part,
            },
            lang,
          ),
        );
      if (refilling || dIn.cents > 0 || wOut.cents > 0) {
        kind = refilling ? 'set_aside_refill' : 'flow';
        // Deposits and withdrawals first: only what moves through the cash moves. Cash under its
        // target is raised from what is over its own; cash over it buys what is under.
        targets = throughCash(values, tPrime, cashId);
        const left = driftOf(targets, tPrime, total);
        if (left >= band) {
          targets = tPrime;
          reasons.push(reason('REBALANCE_DRIFT', { driftBps: left, bandBps: band, part }, lang));
        }
      } else if (driftBps >= band) {
        kind = 'drift';
        reasons.push(reason('REBALANCE_DRIFT', { driftBps, bandBps: band, part }, lang));
      }
    }
    if (kind === null) return null;
    const planned = planFor(cashRaw, h.raw, targets, total);
    if (!planned.weighed) flags.add(`sleeve_not_weighed:${s.key}`);
    if (planned.trades.length === 0) return null;
    return {
      kind,
      sleeve: s.ref,
      driftBps,
      targets: asTargets(T, V + dIn.cents - wOut.cents),
      plan: planned,
      reasons,
      ...(sw ? { observations: sw.observations } : {}),
    };
  };

  // ---- The split, between the sleeves.
  const values = sleeves.map(valueOfSleeve);
  const wanted = split(
    vaultCents,
    sleeves.map((s) => s.shareBps),
  );
  const splitDriftBps = driftOf(
    new Map(sleeves.map((s, i) => [s.key, values[i] ?? 0])),
    new Map(sleeves.map((s, i) => [s.key, wanted[i] ?? 0])),
    vaultCents,
  );

  const restoreProposal = (): SleeveProposal | null => {
    if (!restore) return null;
    const postValues = new Map(
      sleeves.map((s, i) => [
        s.key,
        (values[i] ?? 0) + (deposits[i]?.cents ?? 0) - (withdrawals[i]?.cents ?? 0),
      ]),
    );
    const shares = split(
      after,
      sleeves.map((s) => s.shareBps),
    );
    const left = driftOf(
      postValues,
      new Map(sleeves.map((s, i) => [s.key, shares[i] ?? 0])),
      after,
    );
    if (left < band) return null;
    if (unpriced.size > 0) {
      flags.add('split_not_weighed');
      return null;
    }
    const T: Cents = new Map();
    sleeves.forEach((s, i) => {
      for (const [k, c] of targetsOf(s, shares[i] ?? 0)) add(T, k, c);
    });
    const tPrime = new Map(T);
    add(tPrime, cashId, withdrawalCents);
    const planned = planFor(
      (heldRaw.get(cashId) ?? 0n) + depositRaw,
      heldRaw,
      tPrime,
      vaultCents + depositCents,
    );
    if (planned.trades.length === 0) return null;
    return {
      kind: 'restore_split',
      sleeve: null,
      driftBps: splitDriftBps,
      targets: asTargets(T, after),
      plan: planned,
      reasons: [
        reason('RESTORE_SPLIT', { driftBps: left, bandBps: band }, lang),
        ...[...switchOf.values()].flatMap((x) => x.reasons),
      ],
    };
  };

  const restored = restoreProposal();
  const ordinary = restored
    ? [restored]
    : sleeves.flatMap((s, i) => {
        const p = sleeveProposal(s, i);
        return p ? [p] : [];
      });

  // ---- A likely liquidity breach comes before everything, as in the policy engine.
  const breach = breachProposal(ctx.liquidity, {
    vault: sortedVault,
    heldRaw,
    prices,
    byId,
    cashId,
    P,
    lang,
  });
  if (breach)
    return {
      proposals: [breach],
      waiting: ordinary.map((p) => ({ kind: p.kind, sleeve: p.sleeve })),
      splitDriftBps,
      flags: [...flags].sort(),
    };
  return { proposals: ordinary, waiting: [], splitDriftBps, flags: [...flags].sort() };
}

/**
 * Only what moves through the cash: when the cash is under its target, it is raised from what is
 * over its own, in proportion to how far over; when it is over, it buys what is under, in proportion
 * to how far under. Nothing is sold to buy something else.
 */
function throughCash(values: Cents, targets: Cents, cashId: string): Cents {
  const out = new Map(values);
  const gap = (targets.get(cashId) ?? 0) - (values.get(cashId) ?? 0);
  const others = [...new Set([...values.keys(), ...targets.keys()])]
    .filter((k) => k !== cashId)
    .sort();
  const room = new Map(
    others.map((k) => {
      const d = (values.get(k) ?? 0) - (targets.get(k) ?? 0);
      return [k, Math.max(0, gap > 0 ? d : -d)];
    }),
  );
  const moved = scaled(Math.min(Math.abs(gap), totalOf(room)), room);
  for (const [k, c] of moved) {
    out.set(k, (out.get(k) ?? 0) + (gap > 0 ? -c : c));
    out.set(cashId, (out.get(cashId) ?? 0) + (gap > 0 ? c : -c));
  }
  return out;
}

type Switch = { weights: Cents; reasons: Reason[]; observations: YieldObservation[] };

/**
 * The safe-yield sleeve's switch rule (gate SOLVER-PARAMS): a token it holds moves to another rate
 * token only when that one's yield after haircut was ahead by more than `yieldBand` on each of the
 * last `switchDays` days. A day counts only with a reading of both; a missing day is not "ahead", and
 * breaks the run. The last day is the day of `now`, or the day before when no reading of that day is
 * in yet. Of several that qualify, the highest yield on the last day, ties by id. The move stops at
 * the other token's cap per asset of the plan.
 */
function switchFor(
  safe: Sleeve,
  sleeves: Sleeve[],
  c: {
    P: PersonalParameters;
    sheet: PersonalSheet;
    chain: string | undefined;
    cashId: string;
    assets: BasketAsset[];
    priced: (id: string) => boolean;
    yields: YieldObservation[];
    now: string;
    planCents: number;
    lang: Language;
    flags: Set<string>;
  },
): Switch | null {
  const { P, sheet, lang } = c;
  const isRateOnly = (a: BasketAsset) => {
    const types = legTypesOf(a.symbol)?.types ?? [];
    return types.length > 0 && types.every((t) => t === 'rate');
  };
  const cannot = sheet.limits?.cannotHold;
  const canHold = (a: BasketAsset) =>
    a.chain === c.chain &&
    !a.blockedCountries.includes(sheet.country) &&
    eligibleForGoal(a, sheet.goal) &&
    !(cannot?.assets ?? []).includes(a.id) &&
    !(cannot?.classes ?? []).some((x) => x === a.cls) &&
    !(cannot?.underlyings ?? []).some((u) => u.toLowerCase() === a.underlying.toLowerCase());

  // The latest reading of each token on each day; ties by source, then method.
  const daily = new Map<string, Map<number, YieldObservation>>();
  const ordered = [...c.yields].sort((a, b) =>
    a.fetchedAt === b.fetchedAt
      ? `${a.source} ${a.method}` < `${b.source} ${b.method}`
        ? -1
        : 1
      : a.fetchedAt < b.fetchedAt
        ? -1
        : 1,
  );
  for (const y of ordered) {
    const days = daily.get(y.assetId) ?? new Map<number, YieldObservation>();
    days.set(dayOf(y.fetchedAt), y);
    daily.set(y.assetId, days);
  }
  const today = dayOf(c.now);
  const anyToday = [...daily.values()].some((d) => d.has(today));
  const back = anyToday ? 0 : 1;
  const days = Array.from({ length: P.switchDays }, (_, k) => dayOf(c.now, back + k));
  const last = days[0] ?? today;
  // Compared in hundredths of a basis point, so a difference exactly at the band is not over it.
  const fine = (x: number) => Math.round(x * BPS * 100);
  const bandFine = fine(P.yieldBand);

  const candidates = c.assets.filter(
    (a) => a.id !== c.cashId && isRateOnly(a) && canHold(a) && c.priced(a.id),
  );
  const weights = new Map(safe.planned);
  const reasons: Reason[] = [];
  const observations: YieldObservation[] = [];
  for (const held of sortedKeys(safe.planned)) {
    if (held === c.cashId || (weights.get(held) ?? 0) <= 0) continue;
    const mine = daily.get(held);
    const ahead = candidates.filter((a) => {
      if (a.id === held) return false;
      const theirs = daily.get(a.id);
      return days.every((d) => {
        const x = theirs?.get(d);
        const y = mine?.get(d);
        return (
          x !== undefined &&
          y !== undefined &&
          fine(x.haircutYield) - fine(y.haircutYield) > bandFine
        );
      });
    });
    const to = [...ahead].sort((a, b) => {
      const ya = daily.get(a.id)?.get(last)?.haircutYield ?? 0;
      const yb = daily.get(b.id)?.get(last)?.haircutYield ?? 0;
      return fine(yb) - fine(ya) || (a.id < b.id ? -1 : 1);
    })[0];
    if (!to) continue;
    const from = c.assets.find((a) => a.id === held);
    // The cap per asset, as placement reads it: by symbol, else the smallest of its leg types.
    const capBps =
      P.capPerAssetBps.bySymbol[to.symbol] ??
      Math.min(
        ...(legTypesOf(to.symbol)?.types ?? []).map((t) => P.capPerAssetBps.byLegType[t] ?? BPS),
      );
    const plannedTo = sum(
      sleeves.map((s) => (s === safe ? (weights.get(to.id) ?? 0) : (s.planned.get(to.id) ?? 0))),
    );
    const room = Math.floor((c.planCents * capBps) / BPS) - plannedTo;
    const have = weights.get(held) ?? 0;
    const moved = Math.max(0, Math.min(have, room));
    if (moved <= 0) {
      c.flags.add(`switch_capped:${to.id}`);
      continue;
    }
    weights.set(held, have - moved);
    add(weights, to.id, moved);
    const fromName = from?.symbol ?? held;
    reasons.push(
      reason(
        'SAFE_YIELD_SWITCH',
        {
          from: fromName,
          to: to.symbol,
          days: P.switchDays,
          bandBps: Math.round(P.yieldBand * BPS),
          part: safe.key,
        },
        lang,
      ),
    );
    if (moved < have)
      reasons.push(
        reason(
          'SAFE_YIELD_SWITCH_CAPPED',
          { usd: toUsd(have - moved), from: fromName, to: to.symbol, capBps },
          lang,
        ),
      );
    for (const d of days)
      for (const id of [held, to.id]) {
        const o = daily.get(id)?.get(d);
        if (o) observations.push(o);
      }
  }
  if (reasons.length === 0) return null;
  return { weights, reasons, observations };
}

/** What the set-aside should hold now, in cents of dollars, or null when it cannot be counted. */
function setAsideOwed(
  obligations: Obligation[],
  ctx: z.output<typeof SleeveRebalanceContext>,
  P: PersonalParameters,
  flags: Set<string>,
): { owed: number; from: string; to: string } | null {
  if (P.setAsideMonths <= 0) return null;
  const from = monthAfter(ctx.now, 0);
  const to = monthAfter(from, P.setAsideMonths - 1);
  const due = obligations.filter(
    (o) =>
      o.month >= from &&
      o.month <= to &&
      (ctx.paidThrough === undefined || o.month > ctx.paidThrough),
  );
  if (due.length === 0) return null;
  let owed = 0;
  for (const o of byName(due, (x) => `${x.month} ${x.currency} ${x.amount}`)) {
    if (o.currency === 'USD') {
      owed += toCents(o.amount);
      continue;
    }
    const pair = `USD${o.currency}`;
    const rate = [...(ctx.fx ?? [])]
      .filter((f) => f.pair === pair)
      .sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1))[0];
    if (!rate) {
      // Never guessed: with no reading, the set-aside is not counted, and the answer says so.
      flags.add(`refill_no_fx:${o.currency}`);
      return null;
    }
    owed += toCents(o.amount / rate.value);
  }
  return { owed, from, to };
}

/**
 * The risk layer's likely breach, as `proposeRebalance` of the policy engine reads it: when the
 * assessment finds one and names orders, each sells its token to cash, no more than the vault holds.
 */
function breachProposal(
  a: LiquidityAssessment | undefined,
  c: {
    vault: VaultState;
    heldRaw: Raw;
    prices: Price[];
    byId: Map<string, BasketAsset>;
    cashId: string;
    P: PersonalParameters;
    lang: Language;
  },
): SleeveProposal | null {
  if (!a?.likelyBreach || a.orders.length === 0) return null;
  const amounts = new Map<string, number>();
  for (const o of a.orders)
    if (o.fromAssetId !== c.cashId) add(amounts, o.fromAssetId, o.amountUsd);
  const trades = sortedKeys(amounts).flatMap((id) => {
    const held = c.heldRaw.get(id) ?? 0n;
    const price = Number(c.prices.find((p) => p.asset === id)?.usdPerToken ?? 0);
    const asset = c.byId.get(id);
    const usd = amounts.get(id) ?? 0;
    if (held === 0n || price <= 0 || !asset || usd < c.P.minLineUsd) return [];
    const want = BigInt(Math.floor((usd / price) * 10 ** asset.decimals));
    const raw = want < held ? want : held;
    return raw > 0n ? [{ sell: id, buy: c.cashId, amountInRaw: raw.toString() }] : [];
  });
  if (trades.length === 0) return null;
  const first = [...a.monthsAtRisk].sort()[0];
  return {
    kind: 'liquidity_breach',
    sleeve: null,
    driftBps: 0,
    targets: [],
    plan: { trades, unpriced: [], weighed: true },
    reasons: first
      ? [reason('LIQUIDITY_BREACH', { first, shortfallUsd: a.shortfallUsd }, c.lang)]
      : [],
  };
}
