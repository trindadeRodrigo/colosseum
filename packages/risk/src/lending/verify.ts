import type { KaminoReserve } from './kamino';
import type { LendingEvent } from './tx';

// Step 10b item 6 — completeness checks over the lending history (pure functions; the script that feeds them
// is scripts/risk/lending-verify.ts). They decide whether the history can be trusted:
//   balanceChain     each transaction's pre-balance of a vault equals the previous transaction's post-balance
//   reserveDeltas    what one transaction's decoded events did to a Kamino reserve's state
//   replayReserve    undo events from a later reserve snapshot to an earlier one; available liquidity and cToken
//                    supply must match exactly, borrowed within the interest placed between events
//   obligationCollateral  per obligation and reserve, the cTokens its events moved into the collateral vault
//   apiResidual      an on-chain amount against an API amount read at another time, after interest accrual

/** Policy inputs of the checks, stored with every output. Changed here only, never in a test expectation. */
export type LendingVerifyParams = {
  /** Largest accepted error of a replayed Kamino borrowed amount, in basis points of the snapshot's value. */
  borrowReplayTolBps: number;
  /** Largest accepted relative difference between an on-chain row and the API row at the same time, after the
   *  interest accrued between the two reads. */
  apiMatchTolRel: number;
};
export const defaultLendingVerifyParams = (): LendingVerifyParams => ({
  borrowReplayTolBps: 1,
  apiMatchTolRel: 1e-6,
});

// ---------------------------------------------------------------------------------------------------------------
// Vault-balance chain

export type BalanceStep = { sig: string; slot: number; pre: string | null; post: string | null };
export type VaultChainBreak = {
  sig: string;
  slot: number;
  prevSig: string;
  prevSlot: number;
  expected: string;
  got: string;
};

/** Steps oldest first, in block order. A token account that does not exist yet (pre null) or was closed (post
 *  null) has balance 0. */
export function balanceChain(steps: readonly BalanceStep[]) {
  let checked = 0;
  const breaks: VaultChainBreak[] = [];
  let prev: BalanceStep | undefined;
  for (const s of steps) {
    if (prev) {
      checked++;
      const expected = prev.post ?? '0';
      const got = s.pre ?? '0';
      if (expected !== got)
        breaks.push({
          sig: s.sig,
          slot: s.slot,
          prevSig: prev.sig,
          prevSlot: prev.slot,
          expected,
          got,
        });
    }
    prev = s;
  }
  return { steps: steps.length, checked, breaks };
}

// ---------------------------------------------------------------------------------------------------------------
// Kamino reserve replay

export type ReserveKeys = { reserve: string; liquiditySupplyVault: string; collateralMint: string };

/** Raw-unit changes one transaction made to a reserve: available liquidity, borrowed (positive = more debt) and
 *  cToken supply. Available and cTokens come from the decoded flows and mint-supply changes; borrowed from the
 *  supply-vault flows of the instructions that borrow or repay on this reserve (a borrow's fee leaves the vault
 *  and is part of the debt; a repay settles at most the amount paid in). */
export function reserveDeltas(events: readonly LendingEvent[], k: ReserveKeys) {
  let available = 0n;
  let borrowed = 0n;
  let ctoken = 0n;
  let unsupported = 0;
  for (const e of events) {
    if (e.program !== 'klend') continue;
    const onVault = e.flows
      .filter((f) => f.account === k.liquiditySupplyVault)
      .reduce((s, f) => s + BigInt(f.delta), 0n);
    available += onVault;
    for (const s of e.supply ?? []) if (s.mint === k.collateralMint) ctoken += BigInt(s.delta);
    const debtReserve =
      e.accounts.borrowReserve ?? e.accounts.repayReserve ?? e.accounts.reserve ?? null;
    if (e.kind === 'borrow' && debtReserve === k.reserve) borrowed -= onVault;
    else if (e.kind === 'repay' && debtReserve === k.reserve) borrowed -= onVault;
    else if (
      (e.kind === 'liquidation' || e.kind === 'repay_and_withdraw') &&
      e.accounts.repayReserve === k.reserve
    ) {
      // the repay leg; when the same reserve is also the collateral side its redeem shares the vault
      if (e.accounts.withdrawReserve === k.reserve) {
        if (e.liquidation) borrowed -= BigInt(e.liquidation.debtRepaid);
        else unsupported++;
      } else borrowed -= onVault;
    } else if (e.kind === 'socialize_loss' && e.accounts.reserve === k.reserve) unsupported++;
  }
  return { available, borrowed, ctoken, unsupported };
}

export type ReserveSnapshot = {
  at: string;
  slot: number;
  reserve: Pick<
    KaminoReserve,
    | 'lastUpdateSlot'
    | 'availableAmount'
    | 'borrowedAmountSf'
    | 'cumulativeBorrowRateBsf'
    | 'collateralMintTotalSupply'
  >;
};
export type ReserveStep = {
  slot: number;
  sig: string;
  available: bigint;
  borrowed: bigint;
  ctoken: bigint;
};

const SF = 2n ** 60n;
const ratio = (a: bigint, b: bigint) => Number((a * 10n ** 18n) / b) / 1e18;

/**
 * Undo the steps with `target.slot < slot ≤ anchor.slot` from the anchor snapshot and compare with the target.
 * Available liquidity and cToken supply are exact. Borrowed grows with the reserve's cumulative borrow index; the
 * index is known exactly at both snapshots (their `lastUpdateSlot`), and each event's amount is moved to the
 * target's index by the index growth placed log-linearly in slots between the two (the reserve's rate is
 * constant between refreshes, so the only error is where inside the interval the rate changed).
 */
export function replayReserve(
  anchor: ReserveSnapshot,
  target: ReserveSnapshot,
  steps: readonly ReserveStep[],
  p: LendingVerifyParams,
) {
  const inside = steps.filter((s) => s.slot > target.slot && s.slot <= anchor.slot);
  let available = anchor.reserve.availableAmount;
  let ctoken = anchor.reserve.collateralMintTotalSupply;
  const a = anchor.reserve;
  const t = target.reserve;
  const growth = ratio(a.cumulativeBorrowRateBsf, t.cumulativeBorrowRateBsf);
  const span = Number(a.lastUpdateSlot - t.lastUpdateSlot);
  const tIndexOver = (slot: number) =>
    span > 0 ? growth ** -Math.min(1, Math.max(0, (slot - Number(t.lastUpdateSlot)) / span)) : 1;
  let borrowed = Number(a.borrowedAmountSf) / Number(SF) / growth;
  for (const s of inside) {
    available -= s.available;
    ctoken -= s.ctoken;
    borrowed -= Number(s.borrowed) * tIndexOver(s.slot);
  }
  const expectedBorrowed = Number(t.borrowedAmountSf) / Number(SF);
  const errBps =
    expectedBorrowed > 0
      ? (10_000 * (borrowed - expectedBorrowed)) / expectedBorrowed
      : borrowed === 0
        ? 0
        : Number.POSITIVE_INFINITY;
  return {
    from: anchor.at,
    to: target.at,
    steps: inside.length,
    indexGrowth: growth,
    available: {
      expected: t.availableAmount.toString(),
      got: available.toString(),
      ok: available === t.availableAmount,
    },
    ctoken: {
      expected: t.collateralMintTotalSupply.toString(),
      got: ctoken.toString(),
      ok: ctoken === t.collateralMintTotalSupply,
    },
    borrowed: {
      expected: expectedBorrowed,
      got: borrowed,
      errBps,
      ok: Math.abs(errBps) <= p.borrowReplayTolBps,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Obligations

/** Per obligation and collateral vault: the signed cTokens its klend instructions moved into the vault since the
 *  obligation was last initialised (an emptied obligation account can be closed and initialised again at the same
 *  address, so `initObligation` starts the sum afresh). Events in execution order, transactions in slot order. */
export function obligationCollateral(
  events: readonly LendingEvent[],
  collateralVaults: ReadonlySet<string>,
  into: Map<string, Map<string, bigint>> = new Map(),
) {
  for (const e of events) {
    const ob = e.program === 'klend' ? e.accounts.obligation : undefined;
    if (!ob) continue;
    if (e.ix === 'initObligation') into.set(ob, new Map());
    for (const f of e.flows) {
      if (!collateralVaults.has(f.account)) continue;
      const m = into.get(ob) ?? new Map<string, bigint>();
      m.set(f.account, (m.get(f.account) ?? 0n) + BigInt(f.delta));
      into.set(ob, m);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------------------------------------------
// On-chain rows against API rows

/** Relative difference of an on-chain amount from an API amount, after growing the API amount by `apr` for
 *  `seconds` (simple interest; seconds are minutes here, so compounding is far below the tolerance). */
export function apiResidual(onchain: number, api: number, apr: number, seconds: number) {
  const expected = api * (1 + (apr * seconds) / 31_536_000);
  if (expected === 0) return onchain === 0 ? 0 : Number.POSITIVE_INFINITY;
  return onchain / expected - 1;
}
