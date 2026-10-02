import { Reader } from '../pools/bytes';

/**
 * Kamino Lend (klend) and Kamino curated vaults (kvault): hand-written readers for the fields the risk layer
 * uses, at fixed offsets taken from the klend 1.25.0 / kvault 2.2.2 IDLs shipped in klend-sdk 12.0.1.
 * Every reader is checked against the SDK's own decode on live accounts by
 * `scripts/risk/lending-measure.ts vl2` and on frozen bytes in `tests/risk-layer/lending.test.ts`.
 * Amounts are raw token units (bigint). `Sf` values are scaled fractions (value × 2^60).
 */
export const KLEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
export const KVAULT_PROGRAM = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd';
export const KAMINO_RESERVE_SIZE = 8624;
export const KAMINO_OBLIGATION_SIZE = 3344;
export const KVAULT_STATE_SIZE = 62552;
/** Offset of `liquidity.mintPubkey` in a Reserve (memcmp target for discovery by mint). */
export const KAMINO_RESERVE_MINT_OFFSET = 128;
/** Offset of `lendingMarket` in a Reserve and an Obligation. */
export const KAMINO_MARKET_OFFSET = 32;
/** Offset of the first `VaultAllocation.reserve` in a kvault VaultState; allocations are 2160 bytes apart. */
export const KVAULT_ALLOCATION_OFFSET = 312;
export const KVAULT_ALLOCATION_SIZE = 2160;
export const KVAULT_MAX_ALLOCATIONS = 25;
/** klend compounds per slot; the SDK uses 2 slots a second. */
export const KAMINO_SLOTS_PER_YEAR = 63_072_000;

const SF = 2n ** 60n;
const NULL_KEY = '11111111111111111111111111111111';
/** Scaled fraction to a float (loses precision past 2^53; use the bigint for exact work). */
export const sfToNumber = (sf: bigint) => Number(sf / SF) + Number(sf % SF) / 2 ** 60;

export type KaminoCurvePoint = { utilizationBps: number; borrowRateBps: number };

export type KaminoReserve = {
  lendingMarket: string;
  farmCollateral: string;
  farmDebt: string;
  lastUpdateSlot: bigint;
  /** Unix seconds of the last refresh (`LastUpdate.timestamp`, u32); the accrual anchor of a TrueApr reserve. */
  lastUpdateTimestamp: number;
  liquidityMint: string;
  liquiditySupplyVault: string;
  liquidityFeeVault: string;
  tokenProgram: string;
  mintDecimals: number;
  /** Liquidity sitting in the supply vault and free to withdraw or borrow (raw units). */
  availableAmount: bigint;
  borrowedAmountSf: bigint;
  marketPriceSf: bigint;
  marketPriceLastUpdatedTs: bigint;
  /** 256-bit cumulative borrow index, scaled by 2^60. */
  cumulativeBorrowRateBsf: bigint;
  accumulatedProtocolFeesSf: bigint;
  accumulatedReferrerFeesSf: bigint;
  pendingReferrerFeesSf: bigint;
  collateralMint: string;
  collateralMintTotalSupply: bigint;
  collateralSupplyVault: string;
  config: {
    status: number;
    /** 0 = Legacy (curve rates are per slot at a nominal 2 slots/s), 1 = TrueApr (per second). */
    interestRateBasis: number;
    hostFixedInterestRateBps: number;
    protocolTakeRatePct: number;
    protocolLiquidationFeePct: number;
    loanToValuePct: number;
    liquidationThresholdPct: number;
    minLiquidationBonusBps: number;
    maxLiquidationBonusBps: number;
    badDebtLiquidationBonusBps: number;
    borrowRateCurve: KaminoCurvePoint[];
    borrowFactorPct: bigint;
    depositLimit: bigint;
    borrowLimit: bigint;
    name: string;
    heuristic: { lower: bigint; upper: bigint; exp: bigint };
    maxTwapDivergenceBps: bigint;
    maxAgePriceSeconds: bigint;
    maxAgeTwapSeconds: bigint;
    scopePriceFeed: string;
    scopePriceChain: number[];
    scopeTwapChain: number[];
    switchboardPriceAggregator: string;
    switchboardTwapAggregator: string;
    pythPrice: string;
    depositWithdrawalCap: {
      capacity: bigint;
      current: bigint;
      intervalStart: bigint;
      intervalSeconds: bigint;
    };
    debtWithdrawalCap: {
      capacity: bigint;
      current: bigint;
      intervalStart: bigint;
      intervalSeconds: bigint;
    };
    utilizationLimitBlockBorrowingAbovePct: number;
    borrowLimitOutsideElevationGroup: bigint;
  };
  /** cTokens queued for withdrawal (lenders waiting for liquidity). */
  withdrawQueueCollateral: bigint;
};

const u256 = (r: Reader, o: number) =>
  r.u64(o) + (r.u64(o + 8) << 64n) + (r.u64(o + 16) << 128n) + (r.u64(o + 24) << 192n);
const cap = (r: Reader, o: number) => ({
  capacity: r.i64(o),
  current: r.i64(o + 8),
  intervalStart: r.u64(o + 16),
  intervalSeconds: r.u64(o + 24),
});
const chain = (r: Reader, o: number) =>
  [0, 1, 2, 3].map((i) => r.u16(o + 2 * i)).filter((x) => x !== 0xffff);

export function decodeKaminoReserve(data: Uint8Array): KaminoReserve {
  if (data.length !== KAMINO_RESERVE_SIZE) throw new Error(`reserve size ${data.length}`);
  const r = new Reader(data);
  const curve: KaminoCurvePoint[] = [];
  for (let i = 0; i < 11; i++)
    curve.push({ utilizationBps: r.u32(4920 + 8 * i), borrowRateBps: r.u32(4924 + 8 * i) });
  return {
    lendingMarket: r.pubkey(32),
    farmCollateral: r.pubkey(64),
    farmDebt: r.pubkey(96),
    lastUpdateSlot: r.u64(16),
    lastUpdateTimestamp: r.u32(28),
    liquidityMint: r.pubkey(128),
    liquiditySupplyVault: r.pubkey(160),
    liquidityFeeVault: r.pubkey(192),
    availableAmount: r.u64(224),
    borrowedAmountSf: r.u128(232),
    marketPriceSf: r.u128(248),
    marketPriceLastUpdatedTs: r.u64(264),
    mintDecimals: Number(r.u64(272)),
    cumulativeBorrowRateBsf: u256(r, 296),
    accumulatedProtocolFeesSf: r.u128(344),
    accumulatedReferrerFeesSf: r.u128(360),
    pendingReferrerFeesSf: r.u128(376),
    tokenProgram: r.pubkey(408),
    collateralMint: r.pubkey(2560),
    collateralMintTotalSupply: r.u64(2592),
    collateralSupplyVault: r.pubkey(2600),
    config: {
      status: r.u8(4856),
      interestRateBasis: r.u8(4865),
      hostFixedInterestRateBps: r.u16(4858),
      protocolTakeRatePct: r.u8(4870),
      protocolLiquidationFeePct: r.u8(4871),
      loanToValuePct: r.u8(4872),
      liquidationThresholdPct: r.u8(4873),
      minLiquidationBonusBps: r.u16(4874),
      maxLiquidationBonusBps: r.u16(4876),
      badDebtLiquidationBonusBps: r.u16(4878),
      borrowRateCurve: curve,
      borrowFactorPct: r.u64(5008),
      depositLimit: r.u64(5016),
      borrowLimit: r.u64(5024),
      name: Buffer.from(data.subarray(5032, 5064)).toString('utf8').replace(/\0+$/, ''),
      heuristic: { lower: r.u64(5064), upper: r.u64(5072), exp: r.u64(5080) },
      maxTwapDivergenceBps: r.u64(5088),
      maxAgePriceSeconds: r.u64(5096),
      maxAgeTwapSeconds: r.u64(5104),
      scopePriceFeed: r.pubkey(5112),
      scopePriceChain: chain(r, 5144),
      scopeTwapChain: chain(r, 5152),
      switchboardPriceAggregator: r.pubkey(5160),
      switchboardTwapAggregator: r.pubkey(5192),
      pythPrice: r.pubkey(5224),
      depositWithdrawalCap: cap(r, 5416),
      debtWithdrawalCap: cap(r, 5448),
      utilizationLimitBlockBorrowingAbovePct: r.u8(5501),
      borrowLimitOutsideElevationGroup: r.u64(5504),
    },
    withdrawQueueCollateral: r.u64(6968),
  };
}

/** Borrow APR (fraction) at utilization `u` (fraction) from the reserve's piecewise-linear curve. */
export function kaminoCurveRate(curve: readonly KaminoCurvePoint[], u: number): number {
  const ubps = Math.max(0, Math.min(10_000, u * 10_000));
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1] as KaminoCurvePoint;
    const b = curve[i] as KaminoCurvePoint;
    if (ubps <= b.utilizationBps) {
      if (b.utilizationBps === a.utilizationBps) return b.borrowRateBps / 10_000;
      const t = (ubps - a.utilizationBps) / (b.utilizationBps - a.utilizationBps);
      return (a.borrowRateBps + t * (b.borrowRateBps - a.borrowRateBps)) / 10_000;
    }
  }
  return (curve.at(-1)?.borrowRateBps ?? 0) / 10_000;
}

const apy = (apr: number, periods: number) => (1 + apr / periods) ** periods - 1;

/**
 * Reserve-level state in raw units and fractions, at the reserve's last refresh (no accrual added).
 * A Legacy-basis reserve accrues its curve rate per slot at a nominal 500 ms, so its real rate scales by
 * 500 / `slotMs` (the measured slot duration; the SDK's `slotAdjustmentFactor`). TrueApr reserves accrue per second.
 */
export function kaminoReserveState(r: KaminoReserve, opts: { slotMs?: number } = {}) {
  const fees = r.accumulatedProtocolFeesSf + r.accumulatedReferrerFeesSf + r.pendingReferrerFeesSf;
  // total supply = available + borrowed − fees owed, as klend's `total_supply()` (in Sf, then floored)
  const supplySf = (r.availableAmount << 60n) + r.borrowedAmountSf - fees;
  const supplied = supplySf > 0n ? supplySf / SF : 0n;
  const borrowed = r.borrowedAmountSf / SF;
  const utilization = supplySf > 0n ? sfToNumber(r.borrowedAmountSf) / sfToNumber(supplySf) : 0;
  const legacy = r.config.interestRateBasis === 0;
  const factor = legacy ? 500 / (opts.slotMs ?? 500) : 1;
  const borrowApr =
    (kaminoCurveRate(r.config.borrowRateCurve, utilization) +
      r.config.hostFixedInterestRateBps / 10_000) *
    factor;
  const supplyApr = borrowApr * utilization * (1 - r.config.protocolTakeRatePct / 100);
  const periods = legacy ? KAMINO_SLOTS_PER_YEAR * factor : 31_536_000;
  const scale = 10 ** r.mintDecimals;
  return {
    supplied,
    borrowed,
    available: r.availableAmount,
    utilization,
    borrowApr,
    supplyApr,
    borrowApy: apy(borrowApr, periods),
    supplyApy: apy(supplyApr, periods),
    /** Liquidity units per cToken. */
    exchangeRate:
      r.collateralMintTotalSupply > 0n
        ? sfToNumber(supplySf) / Number(r.collateralMintTotalSupply)
        : 1,
    priceUsd: sfToNumber(r.marketPriceSf),
    priceTs: Number(r.marketPriceLastUpdatedTs),
    cumulativeBorrowRate: Number((r.cumulativeBorrowRateBsf * 10n ** 12n) / SF) / 1e12,
    depositHeadroom: r.config.depositLimit > supplied ? r.config.depositLimit - supplied : 0n,
    borrowHeadroom: r.config.borrowLimit > borrowed ? r.config.borrowLimit - borrowed : 0n,
    scale,
  };
}

export type KaminoObligation = {
  lendingMarket: string;
  owner: string;
  lastUpdateSlot: bigint;
  deposits: Array<{ reserve: string; depositedAmount: bigint; marketValueSf: bigint }>;
  borrows: Array<{
    reserve: string;
    cumulativeBorrowRateBsf: bigint;
    borrowedAmountSf: bigint;
    marketValueSf: bigint;
  }>;
  depositedValueSf: bigint;
  borrowFactorAdjustedDebtValueSf: bigint;
  borrowedAssetsMarketValueSf: bigint;
  allowedBorrowValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  elevationGroup: number;
  hasDebt: number;
};

export function decodeKaminoObligation(data: Uint8Array): KaminoObligation {
  if (data.length !== KAMINO_OBLIGATION_SIZE) throw new Error(`obligation size ${data.length}`);
  const r = new Reader(data);
  const deposits: KaminoObligation['deposits'] = [];
  for (let i = 0; i < 8; i++) {
    const o = 96 + 136 * i;
    const reserve = r.pubkey(o);
    if (reserve === NULL_KEY) continue;
    deposits.push({ reserve, depositedAmount: r.u64(o + 32), marketValueSf: r.u128(o + 40) });
  }
  const borrows: KaminoObligation['borrows'] = [];
  for (let i = 0; i < 5; i++) {
    const o = 1208 + 200 * i;
    const reserve = r.pubkey(o);
    if (reserve === NULL_KEY) continue;
    borrows.push({
      reserve,
      cumulativeBorrowRateBsf: u256(r, o + 32),
      borrowedAmountSf: r.u128(o + 88),
      marketValueSf: r.u128(o + 104),
    });
  }
  return {
    lendingMarket: r.pubkey(32),
    owner: r.pubkey(64),
    lastUpdateSlot: r.u64(16),
    deposits,
    borrows,
    depositedValueSf: r.u128(1192),
    borrowFactorAdjustedDebtValueSf: r.u128(2208),
    borrowedAssetsMarketValueSf: r.u128(2224),
    allowedBorrowValueSf: r.u128(2240),
    unhealthyBorrowValueSf: r.u128(2256),
    elevationGroup: r.u8(2285),
    hasDebt: r.u8(2287),
  };
}

/** Debt of one obligation borrow accrued to the reserve's current index (raw units, Sf). */
export const kaminoAccruedDebtSf = (
  b: KaminoObligation['borrows'][number],
  reserveCumulativeBsf: bigint,
) =>
  b.cumulativeBorrowRateBsf > 0n
    ? (b.borrowedAmountSf * reserveCumulativeBsf) / b.cumulativeBorrowRateBsf
    : b.borrowedAmountSf;

export type KvaultState = {
  adminAuthority: string;
  baseVaultAuthority: string;
  tokenMint: string;
  tokenMintDecimals: number;
  tokenVault: string;
  sharesMint: string;
  sharesMintDecimals: number;
  /** Liquidity held idle by the vault (raw units). */
  tokenAvailable: bigint;
  sharesIssued: bigint;
  prevAumSf: bigint;
  pendingFeesSf: bigint;
  allocations: Array<{
    reserve: string;
    ctokenVault: string;
    targetAllocationWeight: bigint;
    tokenAllocationCap: bigint;
    ctokenAllocation: bigint;
    lastInvestSlot: bigint;
  }>;
  name: string;
  allocationAdmin: string;
  creationTimestamp: bigint;
};

export function decodeKvaultState(data: Uint8Array): KvaultState {
  if (data.length !== KVAULT_STATE_SIZE) throw new Error(`kvault size ${data.length}`);
  const r = new Reader(data);
  const allocations: KvaultState['allocations'] = [];
  for (let i = 0; i < KVAULT_MAX_ALLOCATIONS; i++) {
    const o = KVAULT_ALLOCATION_OFFSET + KVAULT_ALLOCATION_SIZE * i;
    const reserve = r.pubkey(o);
    if (reserve === NULL_KEY) continue;
    allocations.push({
      reserve,
      ctokenVault: r.pubkey(o + 32),
      targetAllocationWeight: r.u64(o + 64),
      tokenAllocationCap: r.u64(o + 72),
      ctokenAllocation: r.u64(o + 1104),
      lastInvestSlot: r.u64(o + 1112),
    });
  }
  return {
    adminAuthority: r.pubkey(8),
    baseVaultAuthority: r.pubkey(40),
    tokenMint: r.pubkey(80),
    tokenMintDecimals: Number(r.u64(112)),
    tokenVault: r.pubkey(120),
    sharesMint: r.pubkey(184),
    sharesMintDecimals: Number(r.u64(216)),
    tokenAvailable: r.u64(224),
    sharesIssued: r.u64(232),
    prevAumSf: r.u128(280),
    pendingFeesSf: r.u128(296),
    allocations,
    name: Buffer.from(data.subarray(58528, 58568)).toString('utf8').replace(/\0+$/, ''),
    allocationAdmin: r.pubkey(58648),
    creationTimestamp: r.u64(58632),
  };
}

/** Scope `OraclePrices`: 8-byte discriminator, mappings key, then 512 × DatedPrice (56 bytes each). */
export const SCOPE_PRICES_OFFSET = 40;
export function scopePrice(data: Uint8Array, chain: readonly number[]) {
  const r = new Reader(data);
  let price = 1;
  let oldestTs = Number.POSITIVE_INFINITY;
  let oldestSlot = Number.POSITIVE_INFINITY;
  for (const i of chain) {
    const o = SCOPE_PRICES_OFFSET + 56 * i;
    if (o + 56 > data.length) throw new Error(`scope index ${i} out of range`);
    price *= Number(r.u64(o)) / 10 ** Number(r.u64(o + 8));
    oldestSlot = Math.min(oldestSlot, Number(r.u64(o + 16)));
    oldestTs = Math.min(oldestTs, Number(r.u64(o + 24)));
  }
  return { price, ts: oldestTs, slot: oldestSlot };
}
