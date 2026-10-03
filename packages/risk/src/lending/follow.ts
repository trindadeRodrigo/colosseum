// PLAN-ANALYTICS item 13 — where the seized collateral went when the liquidation transaction did not sell it in a
// registry pool. Pure functions over transactions (RpcTx); scripts/risk/lending-follow.ts fetches and feeds them.
//
//   Receipt    in the liquidation transaction, the liquidator's own token accounts of the collateral mint and their
//              net change. Most of the seized units still there: the liquidator kept them past the transaction, and
//              those accounts are followed. Most of them gone: they left in the same transaction, into a registry
//              pool vault (`sold_registry_pool`), through a DEX or an aggregator (`sold_outside_registry`), or
//              elsewhere (`transferred`).
//   Outflow    a later transaction in which a followed account's balance falls: classified the same way, with the
//              units that left and, for a sale into dollars, the realised dollar price per unit.
//   Held       no outflow within `followHours`.
// Wallets never leave this module's caller: the report publishes counts and medians by asset (DA4).

import { quantileOf } from '../curves';
import { type RpcTx, txAccountKeys } from '../events/tx';

export type TokenDelta = {
  account: string;
  owner: string | null;
  mint: string;
  decimals: number;
  delta: bigint;
};

type Bal = {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals?: number };
};

/** Every token account whose balance the transaction changed (pre and post token balances), with its owner. */
export function tokenDeltas(tx: RpcTx): TokenDelta[] {
  const keys = txAccountKeys(tx);
  const byIdx = new Map<
    number,
    { pre: bigint; post: bigint; mint: string; owner: string | null; decimals: number }
  >();
  const put = (b: Bal, which: 'pre' | 'post') => {
    if (!b.mint) return;
    const e = byIdx.get(b.accountIndex) ?? {
      pre: 0n,
      post: 0n,
      mint: b.mint,
      owner: b.owner ?? null,
      decimals: b.uiTokenAmount.decimals ?? 0,
    };
    e[which] = BigInt(b.uiTokenAmount.amount);
    if (!e.owner && b.owner) e.owner = b.owner;
    byIdx.set(b.accountIndex, e);
  };
  for (const b of (tx.meta?.preTokenBalances ?? []) as Bal[]) put(b, 'pre');
  for (const b of (tx.meta?.postTokenBalances ?? []) as Bal[]) put(b, 'post');
  return [...byIdx]
    .map(([i, e]) => ({
      account: keys[i] as string,
      owner: e.owner,
      mint: e.mint,
      decimals: e.decimals,
      delta: e.post - e.pre,
    }))
    .filter((d) => d.delta !== 0n);
}

/** Every program the transaction invoked, outer and inner. */
export function txPrograms(tx: RpcTx): Set<string> {
  const keys = txAccountKeys(tx);
  const out = new Set<string>();
  for (const ix of tx.transaction.message.instructions) out.add(keys[ix.programIdIndex] as string);
  for (const g of tx.meta?.innerInstructions ?? [])
    for (const ix of g.instructions) out.add(keys[ix.programIdIndex] as string);
  return out;
}

/** DEX programs and aggregators outside the pool registry whose swaps count as sales (program ids, not prices). */
export const KNOWN_SWAP_PROGRAMS: readonly string[] = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe', // SolFi
  'swapNyd8XiQwJ6ianp9snpu4brUqFxadzvHebnAXjJZ', // Stabble
  'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms', // Manifest
];

export type FollowContext = {
  /** Registry pool vaults → pool address. */
  registryVaults: ReadonlyMap<string, string>;
  /** DEX programs and aggregators: a transaction that invokes one and moves the stock out is a sale. */
  swapPrograms: ReadonlySet<string>;
  dollarMints: ReadonlySet<string>;
};

export type MoveOut = {
  outcome: 'sold_registry_pool' | 'sold_outside_registry' | 'transferred';
  units: bigint;
  pool: string | null;
  /** Dollars per unit sold, when the owner received a dollar stablecoin in the same transaction; null for a sale
   *  inside the liquidation transaction, where the debt repayment nets against the proceeds. */
  realisedUsd: number | null;
};

/** Where units of `mint` that left `from` (accounts of one owner) went in `tx`. */
function classify(
  tx: RpcTx,
  deltas: TokenDelta[],
  from: ReadonlySet<string>,
  owner: string | null,
  mint: string,
  units: bigint,
  ctx: FollowContext,
  priced = true,
): MoveOut {
  const into = deltas.filter((d) => d.mint === mint && d.delta > 0n && !from.has(d.account));
  const pool = into.map((d) => ctx.registryVaults.get(d.account)).find((p) => !!p) ?? null;
  const programs = txPrograms(tx);
  // a sale through a listed DEX or aggregator; after the liquidation also any transaction in which the owner got
  // another token back for the stock (an unlisted venue or an OTC fill). In the liquidation transaction itself the
  // owner always gets something back (the debt is repaid with it), so only the program list counts there.
  const gotBack =
    priced && !!owner && deltas.some((d) => d.owner === owner && d.mint !== mint && d.delta > 0n);
  const swapped = [...programs].some((p) => ctx.swapPrograms.has(p)) || gotBack;
  const outcome = pool ? 'sold_registry_pool' : swapped ? 'sold_outside_registry' : 'transferred';
  let realisedUsd: number | null = null;
  if (priced && outcome !== 'transferred' && owner) {
    const usd = deltas
      .filter((d) => d.owner === owner && ctx.dollarMints.has(d.mint) && d.delta > 0n)
      .reduce((s, d) => s + Number(d.delta) / 10 ** d.decimals, 0);
    const dec = deltas.find((d) => d.mint === mint)?.decimals ?? 0;
    const u = Number(units) / 10 ** dec;
    if (usd > 0 && u > 0) realisedUsd = usd / u;
  }
  return { outcome, units, pool, realisedUsd };
}

export type Receipt =
  | { kept: true; accounts: string[]; units: bigint }
  | { kept: false; out: MoveOut }
  | { kept: null; reason: 'no_liquidator_account' };

/**
 * The seized units in the liquidation transaction: kept by the liquidator (the accounts to follow), or gone in the
 * same transaction and where. Kept means the liquidator's net receipt is at least half the seized units.
 */
export function seizedReceipt(
  tx: RpcTx,
  liq: { liquidator: string; collateralMint: string; collateralSeized: string },
  ctx: FollowContext,
): Receipt {
  const deltas = tokenDeltas(tx);
  const keys = txAccountKeys(tx);
  const owned = deltas.filter((d) => d.mint === liq.collateralMint && d.owner === liq.liquidator);
  const seized = BigInt(liq.collateralSeized);
  const net = owned.reduce((s, d) => s + d.delta, 0n);
  if (net * 2n >= seized && net > 0n)
    return {
      kept: true,
      accounts: owned.filter((d) => d.delta > 0n).map((d) => d.account),
      units: net,
    };
  // the liquidator's accounts of the mint that the transaction touched, even with no net change
  const touched = new Set(
    ((tx.meta?.postTokenBalances ?? []) as Bal[])
      .filter((b) => b.mint === liq.collateralMint && b.owner === liq.liquidator)
      .map((b) => keys[b.accountIndex] as string),
  );
  if (!touched.size && !owned.length) return { kept: null, reason: 'no_liquidator_account' };
  return {
    kept: false,
    // no realised price: the debt is repaid in the same transaction, so the owner's dollar change nets it out
    out: classify(
      tx,
      deltas,
      touched,
      liq.liquidator,
      liq.collateralMint,
      seized - (net > 0n ? net : 0n),
      ctx,
      false,
    ),
  };
}

/** The first movement out of the followed accounts in `tx`, or null when their balance did not fall. */
export function outflow(
  tx: RpcTx,
  accounts: readonly string[],
  mint: string,
  ctx: FollowContext,
): MoveOut | null {
  const deltas = tokenDeltas(tx);
  const set = new Set(accounts);
  const mine = deltas.filter((d) => d.mint === mint && set.has(d.account));
  const out = -mine.reduce((s, d) => s + d.delta, 0n);
  if (out <= 0n) return null;
  return classify(tx, deltas, set, mine[0]?.owner ?? null, mint, out, ctx);
}

export type FollowRow = {
  asset: string;
  venue: string;
  seizedUsd: number | null;
  oraclePrice: number | null;
  outcome:
    | 'sold_same_tx_registry_pool'
    | 'sold_same_tx_outside_registry'
    | 'transferred_same_tx'
    | 'sold_registry_pool'
    | 'sold_outside_registry'
    | 'transferred'
    | 'held'
    | 'not_traced';
  /** Hours from the liquidation to the first outflow (0 in the same transaction). */
  hours: number | null;
  /** Share of the seized units that left in that outflow. */
  share: number | null;
  realisedUsd: number | null;
};

/** By asset and outcome: count, seized USD, median hours to the outflow, median realised price against the oracle. */
export function followSummary(rows: FollowRow[]) {
  const groups = new Map<string, FollowRow[]>();
  for (const r of rows) {
    const k = `${r.asset}|${r.outcome}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const med = (xs: number[]) => (xs.length ? quantileOf(xs, 0.5) : null);
  return [...groups]
    .map(([k, rs]) => {
      const [asset, outcome] = k.split('|') as [string, FollowRow['outcome']];
      const vs = rs
        .filter((r) => r.realisedUsd !== null && r.oraclePrice)
        .map((r) => (r.realisedUsd as number) / (r.oraclePrice as number) - 1);
      return {
        asset,
        outcome,
        liquidations: rs.length,
        // summed over the liquidations whose seizure has a dollar value; null when none has one, never 0
        seizedUsd: rs.some((r) => r.seizedUsd !== null)
          ? rs.reduce((s, r) => s + (r.seizedUsd ?? 0), 0)
          : null,
        seizedUsdKnown: rs.filter((r) => r.seizedUsd !== null).length,
        medianHours: med(rs.filter((r) => r.hours !== null).map((r) => r.hours as number)),
        medianShare: med(rs.filter((r) => r.share !== null).map((r) => r.share as number)),
        realisedVsOracle: { median: med(vs), samples: vs.length },
      };
    })
    .sort((a, b) => a.asset.localeCompare(b.asset) || b.liquidations - a.liquidations);
}
