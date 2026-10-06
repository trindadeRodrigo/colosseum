import {
  apportion,
  EXIT_WINDOW_DAYS,
  measureVault,
  parseDecimal,
  rebalancePlan,
} from '@colosseum/basket';
import {
  AssetId,
  BasketAsset,
  BasketLine,
  FxObservation,
  type Language,
  LiquidityAssessment,
  type LiquidityProvider,
  Obligation,
  PlanCandidateId,
  PlanSplitSleeve,
  Price,
  Provenance,
  RawAmount,
  type Reason,
  type RebalancePlan,
  type Target,
  type Trade,
  VaultState,
  YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import { paramsHashOf } from './compose';
import { legTypesOf } from './leg-types';
import { BPS, byName, floorCents, split, sum, toCents, toUsd } from './money';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal } from './registry';
import { reason } from './templates';
import { PersonalInputError, PersonalParameters, PersonalSheet } from './types';
import { monthAfter, tableFor } from './world';

// Rebalancing, sleeve by sleeve (ENG-3 slice 4; docs/vault/PROMPT-BUILD-SOLVER.md). The output is a
// list of proposals the person taps: nothing here is sent, and the keeper does not rebalance on drift
// in the MVP. Pure: the stored plan, the vault as read, the sleeve book, the prices and the readings
// come in as arguments, the time with them, and the same inputs give the same proposals in any order.
//
// The order, first to last:
//   1. A likely liquidity breach (the risk layer's assessment, as the policy engine reads it): its
//      sales to cash come first, alone, and every other proposal waits.
//   2. With `restoreSplit` on, the split itself, once the sleeves are the drift band away from the
//      shares the person set. That one proposal brings every sleeve to its targets too.
//   3. Each sleeve against its own targets: a switch of the safe-yield sleeve on the switch rule, the
//      goal sleeve's set-aside refilled, a deposit or a withdrawal, or drift at the band.
//
// A vault holds tokens, not sleeves. Which sleeve owns what is the sleeve book: per sleeve, the raw
// units of each token it owns, cash included, adding up to the vault. Each sleeve trades on its own
// rows only, so value never crosses between sleeves unless the person chose to restore the split.
// Trades come from `rebalancePlan` of packages/basket on the vault cut to the sleeve's rows. No second
// rebalancer is written here.

/** One of the person's sleeves, as a proposal names it. */
export type SleeveRef = { kind: PlanSplitSleeve['kind']; theme?: string };

/**
 * LOCAL TYPE. The sleeve book: for each sleeve (`goal`, `safe_yield`, `theme:<slug>`), the raw units
 * of each token it owns, cash included. Its rows add up to the vault, token by token. The route
 * stores it beside the plan and settles it after every trade and every deposit or withdrawal
 * (`settleBook`). It moves to packages/schemas when the route that stores it is built.
 */
export const SleeveBook = z.array(
  z.object({
    sleeve: z.string().min(1),
    holds: z.array(z.object({ asset: AssetId, raw: RawAmount })),
  }),
);
export type SleeveBook = z.infer<typeof SleeveBook>;

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
  /**
   * The book once these trades land and the sleeve's withdrawal has left, at the given prices and
   * no cost: an estimate. The route settles the real one with `settleBook` from the vault it reads.
   */
  bookAfter: SleeveBook;
  /** The yield readings a switch was decided on, each with its source, time and method. */
  observations?: YieldObservation[];
  /** The FX readings a refill counted a withdrawal in another currency with. */
  fx?: FxObservation[];
  /** Present when the readings a switch was decided on are not live: never shown as live. */
  provenance?: 'mock' | 'sandbox';
};

export type SleeveProposals = {
  proposals: SleeveProposal[];
  /** What a liquidity breach holds back: planned again once its sales are done. */
  waiting: { kind: SleeveRebalanceKind; sleeve: SleeveRef | null }[];
  /** How far the sleeves are from the person's shares, in bps of the plan. */
  splitDriftBps: number;
  /** The book as read, with the deposit in each sleeve's cash. */
  book: SleeveBook;
  /** Where the book came from: given, the one sleeve owning all, or the plan's proportions (just bought). */
  bookFrom: 'given' | 'one_sleeve' | 'plan';
  /** What the vault holds that no sleeve owns: left out of every sleeve, never assigned silently. */
  unowned: { asset: string; raw: string }[];
  /** Each sleeve's part of the deposit and of the withdrawal, in raw units of the cash. */
  flows: { sleeve: string; depositRaw: string; withdrawalRaw: string }[];
  flags: string[];
};

/** The parts of a stored plan a rebalance reads: the shared `BasketProposal` fits. */
export const StoredPlan = z.object({
  sheet: PersonalSheet,
  lines: z.array(BasketLine.pick({ assetId: true, amountUsd: true })),
  split: z.array(PlanSplitSleeve).optional(),
  /** The candidate the plan was made as: its table is `tableFor` of the parameters, as in `compose`. */
  candidate: PlanCandidateId.optional(),
  /** The hash of the table the plan was made with: when given, the table used here must match it. */
  paramsHash: z.string().min(1).optional(),
});
export type StoredPlan = z.input<typeof StoredPlan>;

const isProvider = (p: unknown): p is LiquidityProvider =>
  typeof p === 'object' &&
  p !== null &&
  typeof (p as LiquidityProvider).covers === 'function' &&
  typeof (p as LiquidityProvider).exitCapacity === 'function';

export const SleeveRebalanceContext = z.object({
  /** ISO time the proposals are made at. */
  now: z.string().datetime(),
  /** The plan's vault, as read from its chain. */
  vault: VaultState,
  /**
   * The sleeve book. Required once the vault has moved from the plan with more than one sleeve;
   * left out, it is the plan's proportions, which holds only for a vault just bought.
   */
  book: SleeveBook.optional(),
  /**
   * The caller's word that the vault has not traded since it was bought as this plan: the only case
   * in which the book is read from the plan's proportions. Left out with no book and more than one
   * sleeve, the call is refused.
   */
  boughtAsPlanned: z.literal(true).optional(),
  prices: z.array(Price),
  /** The chain's asset list: decimals, symbols, classes, issuers, tiers. */
  assets: z.array(BasketAsset),
  /** Cash about to come in, in raw units of the vault's cash token. */
  deposit: RawAmount.optional(),
  /** Cash about to go out to the person, in raw units of the vault's cash token. */
  withdrawal: RawAmount.optional(),
  /** The last month whose withdrawal is paid. Left out: none of this month's is. */
  paidThrough: Obligation.shape.month.optional(),
  /** Dated yield readings, keyed by asset id: the history the safe-yield switch reads. */
  yields: z.array(YieldObservation).optional(),
  /**
   * The provenance a yield reading must have to count for the switch. Left out: live only. A switch
   * decided on anything else says so (`provenance` on the proposal).
   */
  readingsFrom: z.array(Provenance).min(1).optional(),
  /** FX readings, pair `USD<currency>`, for a withdrawal not in dollars. */
  fx: z.array(FxObservation).optional(),
  /** The risk layer's assessment of the vault and its withdrawals (`LiquidityProvider.assess`). */
  assessment: LiquidityAssessment.optional(),
  /** Measured exit capacity (Bearing), as `compose` takes it: what a switch may put in one token. */
  liquidity: z.custom<LiquidityProvider>(isProvider, 'a LiquidityProvider').optional(),
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
const addRaw = (m: Raw, k: string, n: bigint) => m.set(k, (m.get(k) ?? 0n) + n);
const totalOf = (m: Cents) => sum([...m.values()]);
const sortedKeys = <V>(m: Map<string, V>) => [...m.keys()].sort();
const big = (n: number) => BigInt(Math.max(0, Math.round(n)));
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

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

/**
 * `total` shared by `weights`, no part over its cap: what a capped part cannot take goes to the
 * others, by their weights, then by the room they have left. Exact; the caps must hold the total.
 */
function waterFill(total: bigint, weights: bigint[], caps: (bigint | null)[]): bigint[] {
  const out = weights.map(() => 0n);
  let left = total;
  for (let round = 0; round <= weights.length && left > 0n; round++) {
    const room = caps.map((cap, i) => (cap === null ? null : cap - (out[i] ?? 0n)));
    const open = (i: number) => {
      const r = room[i];
      return r === null || r === undefined || r > 0n;
    };
    let w = weights.map((x, i) => (open(i) ? x : 0n));
    if (w.every((x) => x === 0n)) w = room.map((r) => (r === null ? 1n : r > 0n ? r : 0n));
    if (w.every((x) => x === 0n)) break;
    const parts = apportion(w, left);
    parts.forEach((part, i) => {
      const r = room[i];
      const give = r === null || r === undefined ? part : minBig(part, r);
      out[i] = (out[i] ?? 0n) + give;
      left -= give;
    });
  }
  return out;
}

/** The UTC day of an ISO time, `back` days before, as a number that orders and compares days. */
function dayOf(iso: string, back = 0): number {
  const [y = 0, m = 1, d = 1] = iso.split('T')[0]?.split('-').map(Number) ?? [];
  return Date.UTC(y, m - 1, d - back);
}

const bookOf = (rows: Map<string, Raw>, order: string[]): SleeveBook =>
  order.map((sleeve) => {
    const r = rows.get(sleeve) ?? new Map<string, bigint>();
    return {
      sleeve,
      holds: sortedKeys(r)
        .filter((a) => (r.get(a) ?? 0n) > 0n)
        .map((asset) => ({ asset, raw: (r.get(asset) ?? 0n).toString() })),
    };
  });

const rowsOf = (book: SleeveBook): Map<string, Raw> =>
  new Map(
    book.map((row) => {
      const r: Raw = new Map();
      for (const h of row.holds) addRaw(r, h.asset, BigInt(h.raw));
      return [row.sleeve, r];
    }),
  );

/** What a vault holds, by token, cash included. */
function vaultRaw(v: VaultState): Raw {
  const r: Raw = new Map([[v.cash.asset, BigInt(v.cash.raw)]]);
  for (const p of v.positions) addRaw(r, p.asset, BigInt(p.raw));
  return r;
}

/** One proposal as carried out: what each of its trades really took in and brought out, in order. */
export type Execution = {
  proposal: Pick<SleeveProposal, 'kind' | 'sleeve' | 'plan' | 'bookAfter'>;
  fills: { inRaw: string; outRaw: string }[];
};

/**
 * The book once a vault has changed, trade by trade, so it adds up to the vault again.
 *
 * - `before` is the book as given to the call (without the deposit). `flows` (the call's answer) puts
 *   each sleeve's part of the deposit in its cash first and takes its part of the withdrawal out last.
 * - A sleeve's proposal: each trade's real amount in leaves that sleeve's row and its real amount out
 *   enters it, so a cost or a fill that differs from the plan lands on the sleeve that traded, even
 *   when several proposals are carried out in one batch.
 * - A breach: each sale is shared by the sleeves in proportion to what they own of the token, and so
 *   are its proceeds.
 * - The split restored: the trades are applied to the whole, then each token is shared by the
 *   proposal's `bookAfter`, which is what restoring the split means.
 * - What is then left between the book and `vaultAfter` (what no execution explains: an accrual, a
 *   rebase, a loss) is shared by the token's holders, a gain by what each held of it before, a loss
 *   by what each holds; only a token no sleeve holds or held is reported in `unowned`. A fill that takes more than its sleeve owns is refused.
 */
export function settleBook(
  before: SleeveBook,
  executions: Execution[],
  vaultAfter: VaultState,
  flows: { sleeve: string; depositRaw: string; withdrawalRaw: string }[] = [],
): { book: SleeveBook; unowned: { asset: string; raw: string }[] } {
  const rows = rowsOf(SleeveBook.parse(before));
  const vault = VaultState.parse(vaultAfter);
  const cashId = vault.cash.asset;
  for (const f of flows) rows.set(f.sleeve, rows.get(f.sleeve) ?? new Map());
  const order = () => [...rows.keys()].sort();
  const refuse = (message: string): never => {
    throw new PersonalInputError('InvalidContext', [{ path: 'executions', message }]);
  };
  const take = (row: Raw, asset: string, raw: bigint) => {
    const have = row.get(asset) ?? 0n;
    if (have < raw) refuse(`a fill takes ${raw} of ${asset} from a sleeve that owns ${have}`);
    row.set(asset, have - raw);
  };
  for (const f of flows) addRaw(rows.get(f.sleeve) ?? new Map(), cashId, BigInt(f.depositRaw));
  for (const { proposal, fills } of executions) {
    const trades = proposal.plan.trades;
    if (fills.length !== trades.length) refuse('one fill per trade, in the order of the trades');
    if (proposal.sleeve) {
      const key = keyOf(proposal.sleeve);
      const row = rows.get(key) ?? refuse(`${key} is not in the book`);
      trades.forEach((t, i) => {
        take(row, t.sell, BigInt(fills[i]?.inRaw ?? '0'));
        addRaw(row, t.buy, BigInt(fills[i]?.outRaw ?? '0'));
      });
      continue;
    }
    if (proposal.kind === 'liquidity_breach') {
      const keys = order();
      trades.forEach((t, i) => {
        const owned = keys.map((k) => rows.get(k)?.get(t.sell) ?? 0n);
        const sold = apportion(owned, BigInt(fills[i]?.inRaw ?? '0'));
        const got = apportion(sold, BigInt(fills[i]?.outRaw ?? '0'));
        keys.forEach((k, j) => {
          const row = rows.get(k) ?? new Map<string, bigint>();
          take(row, t.sell, sold[j] ?? 0n);
          addRaw(row, t.buy, got[j] ?? 0n);
        });
      });
      continue;
    }
    // The split restored: the whole traded, then shared as the proposal's book shares it.
    const whole: Raw = new Map();
    for (const r of rows.values()) for (const [k, n] of r) addRaw(whole, k, n);
    trades.forEach((t, i) => {
      take(whole, t.sell, BigInt(fills[i]?.inRaw ?? '0'));
      addRaw(whole, t.buy, BigInt(fills[i]?.outRaw ?? '0'));
    });
    const target = rowsOf(proposal.bookAfter);
    const keys = order();
    const next = new Map(keys.map((k) => [k, new Map<string, bigint>()]));
    for (const [asset, n] of whole) {
      const w = keys.map((k) => target.get(k)?.get(asset) ?? 0n);
      const parts = apportion(
        w.some((x) => x > 0n) ? w : keys.map((k) => (rows.get(k)?.get(asset) ?? 0n) + 1n),
        n,
      );
      keys.forEach((k, j) => {
        next.get(k)?.set(asset, parts[j] ?? 0n);
      });
    }
    for (const [k, r] of next) rows.set(k, r);
  }
  for (const f of flows) take(rows.get(f.sleeve) ?? new Map(), cashId, BigInt(f.withdrawalRaw));
  // What no execution explains. A gain (accrual, a rebase) is shared like a loss: by what each sleeve
  // held of the token before. Only a token no sleeve held, before or now, is unowned.
  const keys = order();
  const was = rowsOf(SleeveBook.parse(before));
  const actual = vaultRaw(vault);
  const tokens = [
    ...new Set([...actual.keys(), ...[...rows.values()].flatMap((r) => [...r.keys()])]),
  ].sort();
  const unowned: { asset: string; raw: string }[] = [];
  for (const k of tokens) {
    const held = keys.map((s) => rows.get(s)?.get(k) ?? 0n);
    const diff = (actual.get(k) ?? 0n) - held.reduce((n, x) => n + x, 0n);
    if (diff === 0n) continue;
    if (diff > 0n) {
      const before = keys.map((s) => was.get(s)?.get(k) ?? 0n);
      const weights = before.some((x) => x > 0n) ? before : held;
      if (weights.every((x) => x === 0n)) {
        unowned.push({ asset: k, raw: diff.toString() });
        continue;
      }
      const more = apportion(weights, diff);
      keys.forEach((s, j) => {
        rows.get(s)?.set(k, (held[j] ?? 0n) + (more[j] ?? 0n));
      });
      continue;
    }
    const less = apportion(held, -diff);
    keys.forEach((s, j) => {
      rows.get(s)?.set(k, (held[j] ?? 0n) - (less[j] ?? 0n));
    });
  }
  return { book: bookOf(rows, keys), unowned };
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
  // The table the plan was made with: the candidate's, as `compose` builds it.
  const P = tableFor(ctx.params ?? PERSONAL_PARAMS, plan.candidate ?? null);
  const { sheet } = plan;
  const lang: Language = sheet.language;
  const band = P.driftBandBps;
  const flags = new Set<string>();
  const refuse = (path: string, message: string): never => {
    throw new PersonalInputError('InvalidContext', [{ path, message }]);
  };
  if (plan.paramsHash !== undefined && paramsHashOf(P) !== plan.paramsHash)
    refuse(
      'context.params',
      'this plan was made with another parameter table: pass the table it was made with (its hash is the plan’s paramsHash)',
    );

  // ---- The vault, its prices, and dollars kept in the basket's scale until the last step.
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
  const ONE = parseDecimal('1');
  const priceOf = new Map<string, bigint>([[cashId, ONE]]);
  for (const p of prices) {
    const scaledPrice = parseDecimal(p.usdPerToken);
    if (p.asset !== cashId && scaledPrice > 0n && byId.has(p.asset))
      priceOf.set(p.asset, scaledPrice);
  }
  const unit = (id: string) => 10n ** BigInt(byId.get(id)?.decimals ?? 0);
  /** Dollars of `raw` units, scaled by the basket's one dollar; null with no price. */
  const usdScaled = (id: string, raw: bigint): bigint | null => {
    const price = priceOf.get(id);
    return price === undefined ? null : (raw * price) / unit(id);
  };
  const centsOf = (id: string, raw: bigint) => Number(((usdScaled(id, raw) ?? 0n) * 100n) / ONE);
  const cashRawFor = (id: string, raw: bigint) => ((usdScaled(id, raw) ?? 0n) * unit(cashId)) / ONE;
  const rawForCash = (id: string, cashRaw: bigint) => {
    const price = priceOf.get(id);
    return price ? (cashRaw * ONE * unit(id)) / (price * unit(cashId)) : 0n;
  };
  const held = vaultRaw(vault);
  const positionOf = new Map(vault.positions.map((p) => [p.asset, p]));
  // measureVault refuses what the basket cannot value; its own checks run on the vault as given.
  measureVault(vault, prices, assets);

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
  const keys = sleeves.map((s) => s.key);
  const goal = sleeves.find((s) => s.ref.kind === 'goal');
  if (goal) {
    goal.planned = new Map();
    for (const id of sortedKeys(lineCents)) {
      const others = sum(sleeves.filter((s) => s !== goal).map((s) => s.planned.get(id) ?? 0));
      const rest = (lineCents.get(id) ?? 0) - others;
      if (rest > 0) goal.planned.set(id, rest);
    }
  }

  // ---- The book: given; the one sleeve owning everything; or, for a vault just bought, the plan's
  // proportions. Never a guess once the vault has moved.
  let rows: Map<string, Raw>;
  let bookFrom: SleeveProposals['bookFrom'];
  if (ctx.book) {
    bookFrom = 'given';
    rows = rowsOf(ctx.book);
    for (const k of rows.keys())
      if (!keys.includes(k))
        refuse('context.book', `the book names ${k}, which is not a sleeve of this plan`);
    if (rows.size !== ctx.book.length) refuse('context.book', 'the book names a sleeve twice');
  } else if (sleeves.length === 1) {
    bookFrom = 'one_sleeve';
    rows = new Map([[keys[0] ?? 'goal', new Map(held)]]);
  } else {
    bookFrom = 'plan';
    // Only on the caller's word that nothing has traded since the plan was bought: any trade since
    // may have moved value between sleeves while the vault still looks like the plan.
    if (ctx.boughtAsPlanned !== true)
      refuse(
        'context.book',
        'which sleeve owns what is not known: pass the sleeve book, or boughtAsPlanned when the vault has not traded since it was bought as this plan',
      );
    // A cheap check of the word against what the vault shows: a keeper trade on any position, or a
    // version of a shared portfolio accepted by a vault that follows none. It cannot see a trade the
    // owner signed, a deposit or withdrawal, or a transfer: those leave no mark on `VaultState`.
    if (vault.positions.some((p) => p.lastKeeperAt !== null))
      refuse(
        'context.boughtAsPlanned',
        'the vault shows a keeper trade since it was bought: pass the sleeve book',
      );
    if (vault.recipeOnchainId === null && vault.acceptedVersion > 0)
      refuse(
        'context.boughtAsPlanned',
        'the vault shows an accepted version since it was bought: pass the sleeve book',
      );
    const heldCents: Cents = new Map(
      sortedKeys(held).map((k) => [k, centsOf(k, held.get(k) ?? 0n)]),
    );
    const value = totalOf(heldCents);
    const gap = driftOf(heldCents, scaled(value, lineCents), value);
    if (gap >= band || [...held.keys()].some((k) => !priceOf.has(k)))
      refuse(
        'context.book',
        `the vault is ${gap} bps from the plan it was bought as, which a vault that has not traded cannot be: pass the sleeve book`,
      );
    flags.add('book_from_plan');
    rows = new Map(keys.map((k) => [k, new Map<string, bigint>()]));
    for (const id of sortedKeys(held)) {
      const weights = sleeves.map((s) => big(s.planned.get(id) ?? 0));
      if (weights.every((w) => w === 0n)) continue;
      const parts = apportion(weights, held.get(id) ?? 0n);
      sleeves.forEach((s, i) => {
        if ((parts[i] ?? 0n) > 0n) rows.get(s.key)?.set(id, parts[i] ?? 0n);
      });
    }
  }
  for (const k of keys) if (!rows.has(k)) rows.set(k, new Map());
  // Rows add up to the vault, token by token: more than it holds is refused, less is reported.
  const unowned: { asset: string; raw: string }[] = [];
  const tokens = [
    ...new Set([...held.keys(), ...[...rows.values()].flatMap((r) => [...r.keys()])]),
  ].sort();
  for (const k of tokens) {
    const owned = keys.reduce((n, s) => n + (rows.get(s)?.get(k) ?? 0n), 0n);
    const has = held.get(k) ?? 0n;
    if (owned > has)
      refuse('context.book', `the book holds more ${k} than the vault (${owned} > ${has})`);
    if (owned < has) {
      unowned.push({ asset: k, raw: (has - owned).toString() });
      flags.add(`unowned:${k}`);
    }
  }
  const unpriced = new Set(tokens.filter((k) => !priceOf.has(k)));
  const centsRow = (r: Raw): Cents =>
    new Map(
      sortedKeys(r)
        .filter((k) => (r.get(k) ?? 0n) > 0n)
        .map((k) => [k, centsOf(k, r.get(k) ?? 0n)]),
    );
  const valueOfSleeve = (s: Sleeve) => totalOf(centsRow(rows.get(s.key) ?? new Map()));
  const values = sleeves.map(valueOfSleeve);
  const ownedCents = sum(values);

  // ---- The deposit and the withdrawal, shared between the sleeves. With `restoreSplit` off, in
  // proportion to what each holds, so the split stays as it is (gate SLEEVES). With it on, new money
  // goes to the sleeves under their share first and a withdrawal comes from those over it first. No
  // sleeve gives more than it holds with its part of the deposit.
  const depositRaw = BigInt(ctx.deposit ?? '0');
  const withdrawalRaw = BigInt(ctx.withdrawal ?? '0');
  const depositCents = centsOf(cashId, depositRaw);
  const withdrawalCents = centsOf(cashId, withdrawalRaw);
  if (withdrawalCents > ownedCents + depositCents)
    refuse('context.withdrawal', 'the withdrawal is more than the sleeves hold');
  const after = ownedCents + depositCents - withdrawalCents;
  const restore = sheet.restoreSplit === true && sleeves.length > 1;
  const shareWeights = sleeves.map((s) => big(s.shareBps));
  const gapWeights = (deposit: boolean, base: number[]): bigint[] => {
    if (!restore) return base.map(big);
    const wanted = split(
      after,
      sleeves.map((s) => s.shareBps),
    );
    const gaps = base.map((v, i) => big(deposit ? (wanted[i] ?? 0) - v : v - (wanted[i] ?? 0)));
    return gaps.some((g) => g > 0n) ? gaps : base.map(big);
  };
  const orAll = (w: bigint[]) => (w.some((x) => x > 0n) ? w : shareWeights);
  const depositParts = apportion(orAll(gapWeights(true, values)), depositRaw);
  const withDeposit = values.map((v, i) => v + centsOf(cashId, depositParts[i] ?? 0n));
  const caps = withDeposit.map((v) => (big(v) * unit(cashId)) / 100n);
  const withdrawalParts = waterFill(withdrawalRaw, orAll(gapWeights(false, withDeposit)), caps);
  const flows = sleeves.map((s, i) => ({
    sleeve: s.key,
    depositRaw: (depositParts[i] ?? 0n).toString(),
    withdrawalRaw: (withdrawalParts[i] ?? 0n).toString(),
  }));
  // The book as read, with the deposit in each sleeve's cash.
  for (const [i, s] of sleeves.entries())
    addRaw(rows.get(s.key) ?? new Map(), cashId, depositParts[i] ?? 0n);
  const rowCents = (s: Sleeve) => centsRow(rows.get(s.key) ?? new Map());

  // ---- The safe-yield sleeve: a switch, on the switch rule only.
  const switchOf = new Map<string, Switch>();
  const safe = sleeves.find((s) => s.ref.kind === 'safe_yield');
  if (safe) {
    const valueCents = (id: string) =>
      keys.reduce((n, s) => n + centsOf(id, rows.get(s)?.get(id) ?? 0n), 0);
    const sw = switchFor(safe, sleeves, {
      P,
      sheet,
      chain,
      cashId,
      assets,
      priced: (id) => priceOf.has(id),
      yields: ctx.yields ?? [],
      readingsFrom: ctx.readingsFrom ?? ['live'],
      liquidity: ctx.liquidity,
      now: ctx.now,
      planCents,
      vaultCents: ownedCents,
      heldCents: valueCents,
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
  /** `rebalancePlan` on the vault cut to these rows, toward these targets (cents, cash left out). */
  const planFor = (row: Raw, targets: Cents, total: number): RebalancePlan => {
    const positions = sortedKeys(row)
      .filter((id) => id !== cashId && (row.get(id) ?? 0n) > 0n)
      .map((asset) => ({
        ...(positionOf.get(asset) ?? {
          asset,
          raw: '0',
          multiplier: '1',
          display: '0',
          targetBps: 0,
          lastKeeperAt: null,
        }),
        asset,
        raw: (row.get(asset) ?? 0n).toString(),
      }));
    const weights: Target[] = sortedKeys(targets)
      .filter((id) => id !== cashId && (targets.get(id) ?? 0) > 0)
      .map((asset) => ({
        asset,
        weightBps: total > 0 ? Math.floor(((targets.get(asset) ?? 0) * BPS) / total) : 0,
      }))
      .filter((t) => t.weightBps > 0);
    return rebalancePlan(
      { ...vault, cash: { ...vault.cash, raw: (row.get(cashId) ?? 0n).toString() }, positions },
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
  /** A row after trades, at the given prices and no cost. */
  const traded = (row: Raw, trades: readonly Trade[]): Raw => {
    const out = new Map(row);
    for (const t of trades) {
      const amount = BigInt(t.amountInRaw);
      addRaw(out, t.sell, -amount);
      addRaw(out, t.buy, t.buy === cashId ? cashRawFor(t.sell, amount) : rawForCash(t.buy, amount));
    }
    return out;
  };
  const clampCash = (row: Raw, take: bigint): Raw => {
    const have = row.get(cashId) ?? 0n;
    if (have < take) flags.add('withdrawal_not_covered');
    row.set(cashId, have > take ? have - take : 0n);
    return row;
  };
  const withRow = (key: string, row: Raw): SleeveBook => {
    const next = new Map(rows);
    next.set(key, row);
    return bookOf(next, keys);
  };

  // ---- Each sleeve's proposal, if it has one.
  const sleeveProposal = (s: Sleeve, i: number): SleeveProposal | null => {
    const row = rows.get(s.key) ?? new Map<string, bigint>();
    const part = s.key;
    if ([...row.keys()].some((id) => unpriced.has(id) && (row.get(id) ?? 0n) > 0n)) {
      flags.add(`sleeve_not_weighed:${s.key}`);
      return null;
    }
    const depositC = centsOf(cashId, depositParts[i] ?? 0n);
    const withdrawalC = centsOf(cashId, withdrawalParts[i] ?? 0n);
    const current = rowCents(s);
    const total = totalOf(current);
    const V = total - depositC;
    const before = new Map(current);
    add(before, cashId, -depositC);
    const driftBps = driftOf(before, scaled(V, s.planned), V);
    const T = targetsOf(s, total - withdrawalC);
    // The withdrawal is still in the cash, as a target of its own, so it is what the trades leave.
    const tPrime = new Map(T);
    add(tPrime, cashId, withdrawalC);
    const reasons: Reason[] = [];
    if (depositC > 0)
      reasons.push(reason('REBALANCE_DEPOSIT', { usd: toUsd(depositC), part }, lang));
    if (withdrawalC > 0)
      reasons.push(reason('REBALANCE_WITHDRAWAL', { usd: toUsd(withdrawalC), part }, lang));
    // A switch already carried out is not proposed again: the sleeve holds its new targets.
    const switching = switchOf.get(s.key);
    const inForce = driftOf(before, targetsOf(s, V), V);
    const sw = switching && inForce >= band ? switching : undefined;
    let kind: SleeveRebalanceKind | null = null;
    let targets = tPrime;
    let fx: FxObservation[] | undefined;
    if (sw) {
      kind = 'safe_yield_switch';
      reasons.push(...sw.reasons);
    } else {
      const reserveHeld =
        sum(
          sortedKeys(current)
            .filter(isReserve)
            .map((k) => current.get(k) ?? 0),
        ) - withdrawalC;
      const short = s === goal && refill ? refill.owed - reserveHeld : 0;
      const refilling = refill !== null && short > 0 && toUsd(short) >= P.minLineUsd;
      if (refilling && refill) {
        fx = refill.fx.length > 0 ? refill.fx : undefined;
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
      }
      if (refilling || depositC > 0 || withdrawalC > 0) {
        kind = refilling ? 'set_aside_refill' : 'flow';
        // Deposits and withdrawals first: only what moves through the cash moves.
        targets = throughCash(current, tPrime, cashId);
        const left = driftOf(targets, tPrime, total);
        if (left >= band) {
          targets = tPrime;
          reasons.push(reason('REBALANCE_DRIFT', { driftBps: left, bandBps: band, part }, lang));
        }
      } else if (inForce >= band) {
        // Against the targets in force: a switch carried out, or the set-aside, moves them.
        kind = 'drift';
        reasons.push(reason('REBALANCE_DRIFT', { driftBps: inForce, bandBps: band, part }, lang));
      }
    }
    if (kind === null) return null;
    const planned = planFor(row, targets, total);
    if (!planned.weighed) flags.add(`sleeve_not_weighed:${s.key}`);
    if (planned.trades.length === 0) return null;
    return {
      kind,
      sleeve: s.ref,
      driftBps,
      targets: asTargets(T, total - withdrawalC),
      plan: planned,
      reasons,
      bookAfter: withRow(s.key, clampCash(traded(row, planned.trades), withdrawalParts[i] ?? 0n)),
      ...(sw ? { observations: sw.observations } : {}),
      ...(sw?.provenance ? { provenance: sw.provenance } : {}),
      ...(fx ? { fx } : {}),
    };
  };

  // ---- The split, between the sleeves.
  const wanted = split(
    ownedCents,
    sleeves.map((s) => s.shareBps),
  );
  const splitDriftBps = driftOf(
    new Map(sleeves.map((s, i) => [s.key, values[i] ?? 0])),
    new Map(sleeves.map((s, i) => [s.key, wanted[i] ?? 0])),
    ownedCents,
  );

  const restoreProposal = (): SleeveProposal | null => {
    if (!restore) return null;
    const postValues = new Map(
      sleeves.map((s, i) => [
        s.key,
        (withDeposit[i] ?? 0) - centsOf(cashId, withdrawalParts[i] ?? 0n),
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
    if ([...unpriced].some((k) => (held.get(k) ?? 0n) > 0n)) {
      flags.add('split_not_weighed');
      return null;
    }
    const perSleeve = sleeves.map((s, i) => targetsOf(s, shares[i] ?? 0));
    const T: Cents = new Map();
    for (const t of perSleeve) for (const [k, c] of t) add(T, k, c);
    const tPrime = new Map(T);
    add(tPrime, cashId, withdrawalCents);
    // The whole plan's rows (what no sleeve owns stays out), with the deposit in the cash.
    const whole: Raw = new Map();
    for (const r of rows.values()) for (const [k, n] of r) addRaw(whole, k, n);
    const planned = planFor(whole, tPrime, ownedCents + depositCents);
    if (planned.trades.length === 0) return null;
    // After: each token shared between the sleeves by their targets, the withdrawal gone.
    const out = clampCash(traded(whole, planned.trades), withdrawalRaw);
    const next = new Map(keys.map((k) => [k, new Map<string, bigint>()]));
    for (const k of sortedKeys(out)) {
      const weights = perSleeve.map((t) => big(t.get(k) ?? 0));
      const parts = apportion(
        weights.some((w) => w > 0n) ? weights : sleeves.map((s) => big(s.shareBps)),
        out.get(k) ?? 0n,
      );
      sleeves.forEach((s, i) => {
        if ((parts[i] ?? 0n) > 0n) next.get(s.key)?.set(k, parts[i] ?? 0n);
      });
    }
    const sw = [...switchOf.values()];
    return {
      kind: 'restore_split',
      sleeve: null,
      driftBps: splitDriftBps,
      targets: asTargets(T, after),
      plan: planned,
      reasons: [
        reason('RESTORE_SPLIT', { driftBps: left, bandBps: band }, lang),
        ...sw.flatMap((x) => x.reasons),
      ],
      bookAfter: bookOf(next, keys),
      ...(sw.length > 0 ? { observations: sw.flatMap((x) => x.observations) } : {}),
      ...(sw.find((x) => x.provenance)
        ? { provenance: sw.find((x) => x.provenance)?.provenance }
        : {}),
    };
  };

  const restored = restoreProposal();
  const ordinary = restored
    ? [restored]
    : sleeves.flatMap((s, i) => {
        const p = sleeveProposal(s, i);
        return p ? [p] : [];
      });

  const result = (
    proposals: SleeveProposal[],
    waiting: SleeveProposals['waiting'],
  ): SleeveProposals => ({
    proposals,
    waiting,
    splitDriftBps,
    book: bookOf(rows, keys),
    bookFrom,
    unowned,
    flows,
    flags: [...flags].sort(),
  });

  // ---- A likely liquidity breach comes before everything, as in the policy engine.
  const breach = breachProposal(ctx.assessment, {
    rows,
    keys,
    held,
    prices,
    byId,
    cashId,
    P,
    lang,
    cashRawFor,
  });
  if (breach)
    return result(
      [breach],
      ordinary.map((p) => ({ kind: p.kind, sleeve: p.sleeve })),
    );
  return result(ordinary, []);
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

type Switch = {
  weights: Cents;
  reasons: Reason[];
  observations: YieldObservation[];
  provenance?: 'mock' | 'sandbox';
};

/**
 * The safe-yield sleeve's switch rule (gate SOLVER-PARAMS): a token it holds moves to another rate
 * token only when that one's yield after haircut was ahead by more than `yieldBand` on each of the
 * last `switchDays` days. Only readings of the accepted provenance count (live, unless the caller
 * says otherwise, and then the proposal says so). A day counts only with a reading of both; a
 * missing day is not "ahead", and breaks the run. The last day is the day of `now`, or the day before
 * when either of the two has no reading of that day yet. Of several that qualify, the highest on its
 * last day, ties by id. The move stops at the smallest of the other token's cap per asset, its exit
 * ceiling (gate EXIT-SOURCE: `shareOfDepth` of its measured capacity, its tier where nothing is
 * measured, labelled) and the room left with its issuer across the plan; what does not fit stays.
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
    readingsFrom: Provenance[];
    liquidity: LiquidityProvider | undefined;
    now: string;
    planCents: number;
    vaultCents: number;
    heldCents: (id: string) => number;
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

  // The latest reading of each token on each day: by time, then value, then source and method, so
  // readings of one time give one answer in any order.
  const daily = new Map<string, Map<number, YieldObservation>>();
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = c.yields
    .filter((y) => c.readingsFrom.includes(y.provenance))
    .sort(
      (a, b) =>
        cmp(a.fetchedAt, b.fetchedAt) ||
        cmp(a.haircutYield, b.haircutYield) ||
        cmp(a.source, b.source) ||
        cmp(a.method, b.method),
    );
  for (const y of ordered) {
    const days = daily.get(y.assetId) ?? new Map<number, YieldObservation>();
    days.set(dayOf(y.fetchedAt), y);
    daily.set(y.assetId, days);
  }
  const today = dayOf(c.now);
  const fine = (x: number) => Math.round(x * BPS * 100);
  const bandFine = fine(P.yieldBand);
  /** The days the pair is compared on: ending today when both are read today, else yesterday. */
  const daysFor = (a: string, b: string) => {
    const back = daily.get(a)?.has(today) && daily.get(b)?.has(today) ? 0 : 1;
    return Array.from({ length: P.switchDays }, (_, k) => dayOf(c.now, back + k));
  };

  const candidates = c.assets.filter(
    (a) => a.id !== c.cashId && isRateOnly(a) && canHold(a) && c.priced(a.id),
  );
  const weights = new Map(safe.planned);
  const reasons: Reason[] = [];
  const observations: YieldObservation[] = [];
  // Room in cents of the plan as made: a figure of today's size is brought to that scale.
  const toPlan = (cents: number) =>
    c.vaultCents > 0 ? Math.floor((cents * c.planCents) / c.vaultCents) : 0;
  const plannedOf = (id: string) =>
    sum(sleeves.map((s) => (s === safe ? (weights.get(id) ?? 0) : (s.planned.get(id) ?? 0))));
  for (const heldId of sortedKeys(safe.planned)) {
    if (heldId === c.cashId || (weights.get(heldId) ?? 0) <= 0) continue;
    const mine = daily.get(heldId);
    const ahead = candidates.flatMap((a) => {
      if (a.id === heldId) return [];
      const theirs = daily.get(a.id);
      const days = daysFor(heldId, a.id);
      const ok = days.every((d) => {
        const x = theirs?.get(d);
        const y = mine?.get(d);
        return (
          x !== undefined &&
          y !== undefined &&
          fine(x.haircutYield) - fine(y.haircutYield) > bandFine
        );
      });
      return ok ? [{ a, days, last: theirs?.get(days[0] ?? today)?.haircutYield ?? 0 }] : [];
    });
    const pick = [...ahead].sort((x, y) => fine(y.last) - fine(x.last) || cmp(x.a.id, y.a.id))[0];
    if (!pick) continue;
    const to = pick.a;
    const from = c.assets.find((a) => a.id === heldId);
    const have = weights.get(heldId) ?? 0;
    // 1. The cap per asset, as placement reads it: by symbol, else the smallest of its leg types.
    const capBps =
      P.capPerAssetBps.bySymbol[to.symbol] ??
      Math.min(
        ...(legTypesOf(to.symbol)?.types ?? []).map((t) => P.capPerAssetBps.byLegType[t] ?? BPS),
      );
    const byCap = Math.floor((c.planCents * capBps) / BPS) - plannedOf(to.id);
    // 2. The exit ceiling (EXIT-SOURCE): measured where Bearing has it, the tier where not, said.
    const read = c.liquidity?.covers(to.id)
      ? c.liquidity.exitCapacity(to.id, P.tau, EXIT_WINDOW_DAYS)
      : null;
    const measured =
      read && read.samples > 0 ? floorCents(read.capacityUsd * P.shareOfDepth) : null;
    const ceilingCents = measured ?? toCents(P.tierCeilingUsd[to.tier] ?? 0);
    if (measured === null) c.flags.add(`ceiling_from_tier:${to.id}`);
    const byExit = toPlan(ceilingCents - c.heldCents(to.id));
    // 3. The room left with its issuer across the whole plan (dollar yield, gold and cash: SOLVER-CAPS).
    const sameIssuer = from?.issuer === to.issuer;
    const issuerHeld = sum(
      c.assets.filter((a) => a.issuer === to.issuer).map((a) => plannedOf(a.id)),
    );
    const byIssuer = sameIssuer
      ? Number.POSITIVE_INFINITY
      : Math.floor((c.planCents * P.issuerCapBps) / BPS) - issuerHeld;
    const limits = [
      { room: byCap, why: 'cap' as const },
      { room: byExit, why: measured === null ? ('tier' as const) : ('exit' as const) },
      { room: byIssuer, why: 'issuer' as const },
    ];
    const binding = [...limits].sort((x, y) => x.room - y.room)[0];
    const moved = Math.max(0, Math.min(have, binding?.room ?? 0));
    if (moved <= 0) {
      c.flags.add(`switch_capped:${to.id}`);
      continue;
    }
    weights.set(heldId, have - moved);
    add(weights, to.id, moved);
    const fromName = from?.symbol ?? heldId;
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
    if (moved < have && binding) {
      const kept = toUsd(have - moved);
      if (binding.why === 'cap')
        reasons.push(
          reason(
            'SAFE_YIELD_SWITCH_CAPPED',
            { usd: kept, from: fromName, to: to.symbol, capBps },
            lang,
          ),
        );
      else if (binding.why === 'issuer')
        reasons.push(
          reason(
            'SAFE_YIELD_SWITCH_ISSUER',
            { usd: kept, from: fromName, issuer: to.issuer, capBps: P.issuerCapBps },
            lang,
          ),
        );
      else
        reasons.push(
          reason(
            binding.why === 'exit' ? 'SAFE_YIELD_SWITCH_EXIT' : 'SAFE_YIELD_SWITCH_TIER',
            {
              usd: kept,
              from: fromName,
              to: to.symbol,
              ceilingUsd: toUsd(ceilingCents),
              tauBps: Math.round(P.tau * BPS),
            },
            lang,
          ),
        );
    }
    for (const d of pick.days)
      for (const id of [heldId, to.id]) {
        const o = daily.get(id)?.get(d);
        if (o) observations.push(o);
      }
  }
  if (reasons.length === 0) return null;
  const notLive = observations.filter((o) => o.provenance !== 'live');
  const provenance =
    notLive.length === 0
      ? undefined
      : notLive.every((o) => o.provenance === 'sandbox')
        ? ('sandbox' as const)
        : ('mock' as const);
  if (provenance) {
    c.flags.add(`switch_not_live:${provenance}`);
    reasons.push(reason(provenance === 'sandbox' ? 'SWITCH_SANDBOX' : 'SWITCH_MOCK', {}, lang));
  }
  return { weights, reasons, observations, ...(provenance ? { provenance } : {}) };
}

/** What the set-aside should hold now, in cents of dollars, or null when it cannot be counted. */
function setAsideOwed(
  obligations: Obligation[],
  ctx: z.output<typeof SleeveRebalanceContext>,
  P: PersonalParameters,
  flags: Set<string>,
): { owed: number; from: string; to: string; fx: FxObservation[] } | null {
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
  const aDay = dayOf(ctx.now) - dayOf(ctx.now, 1);
  let owed = 0;
  const used = new Map<string, FxObservation>();
  for (const o of byName(due, (x) => `${x.month} ${x.currency} ${x.amount}`)) {
    if (o.currency === 'USD') {
      owed += toCents(o.amount);
      continue;
    }
    const pair = `USD${o.currency}`;
    const rate = [...(ctx.fx ?? [])]
      .filter((f) => f.pair === pair && dayOf(f.fetchedAt) <= dayOf(ctx.now))
      .sort((a, b) =>
        a.fetchedAt === b.fetchedAt
          ? a.source < b.source
            ? -1
            : 1
          : a.fetchedAt < b.fetchedAt
            ? 1
            : -1,
      )[0];
    if (!rate) {
      // Never guessed: with no reading, the set-aside is not counted, and the answer says so.
      flags.add(`refill_no_fx:${o.currency}`);
      return null;
    }
    if ((dayOf(ctx.now) - dayOf(rate.fetchedAt)) / aDay > P.fxMaxAgeDays) {
      flags.add(`refill_fx_stale:${o.currency}`);
      return null;
    }
    used.set(pair, rate);
    owed += toCents(o.amount / rate.value);
  }
  return { owed, from, to, fx: [...used.values()] };
}

/**
 * The risk layer's likely breach, as `proposeRebalance` of the policy engine reads it: when the
 * assessment finds one and names orders, each sells its token to cash, no more than the sleeves
 * own. Each sleeve sells its part of a token in proportion to what it owns, and keeps the cash.
 */
function breachProposal(
  a: LiquidityAssessment | undefined,
  c: {
    rows: Map<string, Raw>;
    keys: string[];
    held: Raw;
    prices: Price[];
    byId: Map<string, BasketAsset>;
    cashId: string;
    P: PersonalParameters;
    lang: Language;
    cashRawFor: (id: string, raw: bigint) => bigint;
  },
): SleeveProposal | null {
  if (!a?.likelyBreach || a.orders.length === 0) return null;
  const amounts = new Map<string, number>();
  for (const o of a.orders)
    if (o.fromAssetId !== c.cashId) add(amounts, o.fromAssetId, o.amountUsd);
  const next = new Map([...c.rows].map(([k, r]) => [k, new Map(r)]));
  const trades = sortedKeys(amounts).flatMap((id) => {
    const owned = c.keys.map((k) => c.rows.get(k)?.get(id) ?? 0n);
    const have = owned.reduce((n, x) => n + x, 0n);
    const price = c.prices.find((p) => p.asset === id)?.usdPerToken;
    const asset = c.byId.get(id);
    const usd = amounts.get(id) ?? 0;
    if (have === 0n || !price || !asset || usd < c.P.minLineUsd) return [];
    const scaledPrice = parseDecimal(price);
    if (scaledPrice <= 0n) return [];
    // The order's dollars, to the cent below, in raw units at the price.
    const cents = BigInt(Math.floor(usd * 100));
    const want = (cents * parseDecimal('1') * 10n ** BigInt(asset.decimals)) / (100n * scaledPrice);
    const raw = minBig(want, have);
    if (raw <= 0n) return [];
    const parts = apportion(owned, raw);
    c.keys.forEach((k, i) => {
      const r = next.get(k);
      const p = parts[i] ?? 0n;
      if (!r || p === 0n) return;
      addRaw(r, id, -p);
      addRaw(r, c.cashId, c.cashRawFor(id, p));
    });
    return [{ sell: id, buy: c.cashId, amountInRaw: raw.toString() }];
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
    bookAfter: bookOf(next, c.keys),
  };
}
