import { Reader } from '../pools/bytes';

/**
 * Jupiter Lend: borrow vaults (one collateral, one debt token each) that borrow from a shared liquidity layer
 * per token. Hand-written readers for the vaults and liquidity programs' accounts, at fixed offsets taken from
 * the IDLs shipped in `@jup-ag/lend-read` 0.0.14 (all accounts are packed). Checked against the SDK on every
 * live vault by `scripts/risk/lending-measure.ts vl5`.
 * Exchange prices use 1e12 precision; rates and ratios are in basis points (1e4 = 100%).
 */
export const JL_VAULTS_PROGRAM = 'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi';
export const JL_LIQUIDITY_PROGRAM = 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC';
export const JL_LENDING_PROGRAM = 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9';
export const JL_ORACLE_PROGRAM = 'jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc';
export const JL_VAULT_CONFIG_SIZE = 219;
export const JL_EXCHANGE_PRICE_PRECISION = 10n ** 12n;
const SECONDS_PER_YEAR = 31_536_000n;

export type JlVaultConfig = {
  vaultId: number;
  supplyRateMagnifier: number;
  borrowRateMagnifier: number;
  /** Basis points of 1e3 (permille × 10): 650 = 65%. */
  collateralFactor: number;
  liquidationThreshold: number;
  liquidationMaxLimit: number;
  withdrawGap: number;
  liquidationPenalty: number;
  borrowFee: number;
  vaultType: number;
  oracle: string;
  rebalancer: string;
  liquidityProgram: string;
  oracleProgram: string;
  supplyToken: string;
  borrowToken: string;
};

export function decodeJlVaultConfig(data: Uint8Array): JlVaultConfig {
  const r = new Reader(data);
  const i16 = (o: number) => {
    const v = r.u16(o);
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  return {
    vaultId: r.u16(8),
    supplyRateMagnifier: i16(10),
    borrowRateMagnifier: i16(12),
    collateralFactor: r.u16(14),
    liquidationThreshold: r.u16(16),
    liquidationMaxLimit: r.u16(18),
    withdrawGap: r.u16(20),
    liquidationPenalty: r.u16(22),
    borrowFee: r.u8(24),
    vaultType: r.u8(25),
    oracle: r.pubkey(26),
    rebalancer: r.pubkey(58),
    liquidityProgram: r.pubkey(90),
    oracleProgram: r.pubkey(122),
    supplyToken: r.pubkey(154),
    borrowToken: r.pubkey(186),
  };
}

export type JlVaultState = {
  vaultId: number;
  branchLiquidated: number;
  topmostTick: number;
  currentBranchId: number;
  totalBranchId: number;
  /** Raw vault units; × vaultSupplyExchangePrice / 1e12 gives collateral tokens. */
  totalSupply: bigint;
  /** Raw vault units; × vaultBorrowExchangePrice / 1e12 gives debt tokens. */
  totalBorrow: bigint;
  totalPositions: number;
  absorbedDebtAmount: bigint;
  absorbedColAmount: bigint;
  absorbedDustDebt: bigint;
  liquiditySupplyExchangePrice: bigint;
  liquidityBorrowExchangePrice: bigint;
  vaultSupplyExchangePrice: bigint;
  vaultBorrowExchangePrice: bigint;
  nextPositionId: number;
  lastUpdateTimestamp: bigint;
};

export function decodeJlVaultState(data: Uint8Array): JlVaultState {
  const r = new Reader(data);
  return {
    vaultId: r.u16(8),
    branchLiquidated: r.u8(10),
    topmostTick: r.i32(11),
    currentBranchId: r.u32(15),
    totalBranchId: r.u32(19),
    totalSupply: r.u64(23),
    totalBorrow: r.u64(31),
    totalPositions: r.u32(39),
    absorbedDebtAmount: r.u128(43),
    absorbedColAmount: r.u128(59),
    absorbedDustDebt: r.u64(75),
    liquiditySupplyExchangePrice: r.u64(83),
    liquidityBorrowExchangePrice: r.u64(91),
    vaultSupplyExchangePrice: r.u64(99),
    vaultBorrowExchangePrice: r.u64(107),
    nextPositionId: r.u32(115),
    lastUpdateTimestamp: r.u64(119),
  };
}

export type JlTokenReserve = {
  mint: string;
  vault: string;
  borrowRate: number;
  feeOnInterest: number;
  lastUtilization: number;
  lastUpdateTimestamp: bigint;
  supplyExchangePrice: bigint;
  borrowExchangePrice: bigint;
  maxUtilization: number;
  totalSupplyWithInterest: bigint;
  totalSupplyInterestFree: bigint;
  totalBorrowWithInterest: bigint;
  totalBorrowInterestFree: bigint;
  totalClaimAmount: bigint;
};

/** Liquidity-layer `TokenReserve` (one per token; PDA ["reserve", mint] of the liquidity program). */
export function decodeJlTokenReserve(data: Uint8Array): JlTokenReserve {
  const r = new Reader(data);
  return {
    mint: r.pubkey(8),
    vault: r.pubkey(40),
    borrowRate: r.u16(72),
    feeOnInterest: r.u16(74),
    lastUtilization: r.u16(76),
    lastUpdateTimestamp: r.u64(78),
    supplyExchangePrice: r.u64(86),
    borrowExchangePrice: r.u64(94),
    maxUtilization: r.u16(102),
    totalSupplyWithInterest: r.u64(104),
    totalSupplyInterestFree: r.u64(112),
    totalBorrowWithInterest: r.u64(120),
    totalBorrowInterestFree: r.u64(128),
    totalClaimAmount: r.u64(136),
  };
}

export type JlUserSupplyPosition = {
  protocol: string;
  mint: string;
  withInterest: number;
  /** Raw: × supply exchange price / 1e12 when `withInterest`. */
  amount: bigint;
  withdrawalLimit: bigint;
  decayAmount: bigint;
  lastUpdate: bigint;
  expandPct: number;
  expandDuration: number;
  decayDuration: number;
  baseWithdrawalLimit: bigint;
  status: number;
};

export function decodeJlUserSupplyPosition(data: Uint8Array): JlUserSupplyPosition {
  const r = new Reader(data);
  return {
    protocol: r.pubkey(8),
    mint: r.pubkey(40),
    withInterest: r.u8(72),
    amount: r.u64(73),
    withdrawalLimit: r.u64(81),
    decayAmount: r.u64(89),
    lastUpdate: r.u64(97),
    expandPct: r.u16(105),
    expandDuration: r.u32(107),
    decayDuration: r.u32(111),
    baseWithdrawalLimit: r.u64(115),
    status: r.u8(123),
  };
}

export type JlUserBorrowPosition = {
  protocol: string;
  mint: string;
  withInterest: number;
  amount: bigint;
  debtCeiling: bigint;
  lastUpdate: bigint;
  expandPct: number;
  expandDuration: number;
  baseDebtCeiling: bigint;
  maxDebtCeiling: bigint;
  status: number;
};

export function decodeJlUserBorrowPosition(data: Uint8Array): JlUserBorrowPosition {
  const r = new Reader(data);
  return {
    protocol: r.pubkey(8),
    mint: r.pubkey(40),
    withInterest: r.u8(72),
    amount: r.u64(73),
    debtCeiling: r.u64(81),
    lastUpdate: r.u64(89),
    expandPct: r.u16(97),
    expandDuration: r.u32(99),
    baseDebtCeiling: r.u64(103),
    maxDebtCeiling: r.u64(111),
    status: r.u8(119),
  };
}

export type JlRateModel = {
  mint: string;
  version: number;
  rateAtZero: number;
  kink1Utilization: number;
  rateAtKink1: number;
  rateAtMax: number;
  kink2Utilization: number;
  rateAtKink2: number;
};

export function decodeJlRateModel(data: Uint8Array): JlRateModel {
  const r = new Reader(data);
  return {
    mint: r.pubkey(8),
    version: r.u8(40),
    rateAtZero: r.u16(41),
    kink1Utilization: r.u16(43),
    rateAtKink1: r.u16(45),
    rateAtMax: r.u16(47),
    kink2Utilization: r.u16(49),
    rateAtKink2: r.u16(51),
  };
}

/** Vault position (PDA ["position", vaultId u16, positionId u32]): tick-based; collateral in raw vault units. */
export type JlPosition = {
  vaultId: number;
  nftId: number;
  positionMint: string;
  isSupplyOnly: number;
  tick: number;
  tickId: number;
  supplyAmount: bigint;
  dustDebtAmount: bigint;
};

export const JL_POSITION_SIZE = 71;
export function decodeJlPosition(data: Uint8Array): JlPosition {
  const r = new Reader(data);
  return {
    vaultId: r.u16(8),
    nftId: r.u32(10),
    positionMint: r.pubkey(14),
    isSupplyOnly: r.u8(46),
    tick: r.i32(47),
    tickId: r.u32(51),
    supplyAmount: r.u64(55),
    dustDebtAmount: r.u64(63),
  };
}

/**
 * Liquidity-layer token totals at time `now` (unix s), following the read SDK's `processOverallTokenData`:
 * borrow exchange price accrues at the stored borrow rate; the supply rate is the borrow rate times the
 * share of with-interest supply that is borrowed, net of the protocol fee.
 */
export function jlTokenTotals(t: JlTokenReserve, now: number) {
  const elapsed = BigInt(Math.max(0, now - Number(t.lastUpdateTimestamp)));
  const rate = BigInt(t.borrowRate);
  const borrowEx =
    t.borrowExchangePrice + (t.borrowExchangePrice * rate * elapsed) / (SECONDS_PER_YEAR * 10_000n);
  const supplyWi =
    (t.totalSupplyWithInterest * t.supplyExchangePrice) / JL_EXCHANGE_PRICE_PRECISION;
  const borrowWiStored =
    (t.totalBorrowWithInterest * t.borrowExchangePrice) / JL_EXCHANGE_PRICE_PRECISION;
  const supplyRateBps =
    supplyWi > 0n
      ? (rate * (10_000n - BigInt(t.feeOnInterest)) * borrowWiStored) / (supplyWi * 10_000n)
      : 0n;
  const supplyEx =
    t.supplyExchangePrice +
    (t.supplyExchangePrice * supplyRateBps * elapsed) / (SECONDS_PER_YEAR * 10_000n);
  const supplied =
    (t.totalSupplyWithInterest * supplyEx) / JL_EXCHANGE_PRICE_PRECISION +
    t.totalSupplyInterestFree;
  const borrowed =
    (t.totalBorrowWithInterest * borrowEx) / JL_EXCHANGE_PRICE_PRECISION +
    t.totalBorrowInterestFree;
  return {
    supplyExchangePrice: supplyEx,
    borrowExchangePrice: borrowEx,
    supplied,
    borrowed,
    available: supplied > borrowed ? supplied - borrowed : 0n,
    utilization: supplied > 0n ? Number((borrowed * 1_000_000n) / supplied) / 1e6 : 0,
    borrowApr: t.borrowRate / 10_000,
    supplyApr: Number(supplyRateBps) / 10_000,
  };
}

/** A protocol's (vault's) position on the liquidity layer in tokens, at the given exchange price. */
export const jlPositionTokens = (
  p: { withInterest: number; amount: bigint },
  exchangePrice: bigint,
) => (p.withInterest ? (p.amount * exchangePrice) / JL_EXCHANGE_PRICE_PRECISION : p.amount);

/**
 * Jupiter Lend oracle program's `ChainlinkDataStreamsCache` (the source account of the xStock vault oracles):
 * nonce, a vec of 34-byte feed entries, then the cached price and its timestamps, then generic data with the
 * xStocks market status and the token's scaled-UI multiplier as last reported.
 */
export function decodeJlChainlinkCache(data: Uint8Array) {
  const r = new Reader(data);
  const n = r.u32(10);
  const o = 14 + 34 * n;
  return {
    nonce: r.u16(8),
    feeds: n,
    price: r.u128(o),
    lastUpdateTimestampPrice: r.u64(o + 16),
    lastUpdateTimestampMultiplier: r.u64(o + 24),
    lastObservationsTimestamp: r.u64(o + 32),
    xstocksActivation: r.u64(o + 40),
    xstocksSuspended: r.u8(o + 48),
    marketStatus: r.u32(o + 49),
    v11TransitionTimestamp: r.u64(o + 53),
    lastMultiplier: r.u128(o + 61),
  };
}

/** Vault `Oracle` account: nonce, then a vec of sources (pubkey, invert, multiplier u128, divisor u128, type). */
export function decodeJlOracle(data: Uint8Array) {
  const r = new Reader(data);
  const n = r.u32(10);
  const sources: Array<{
    source: string;
    invert: number;
    multiplier: bigint;
    divisor: bigint;
    sourceType: number;
  }> = [];
  for (let i = 0; i < n; i++) {
    const o = 14 + 66 * i;
    sources.push({
      source: r.pubkey(o),
      invert: r.u8(o + 32),
      multiplier: r.u128(o + 33),
      divisor: r.u128(o + 49),
      sourceType: r.u8(o + 65),
    });
  }
  return { nonce: r.u16(8), sources };
}

const TICK_FACTORS = [
  18419115400608638658n,
  18391528108445969703n,
  18336477419114433396n,
  18226869890870665593n,
  18009616477100071088n,
  17582847377087825313n,
  16759408633341240198n,
  15226414841393184936n,
  12568272644527235157n,
  8563108841104354677n,
  3975055583337633975n,
  856577552520149366n,
  39775317560084773n,
  85764505686420n,
  398745188n,
];
export const JL_MIN_TICK = -16383;
export const JL_INIT_TICK = -2147483648;

/** Debt/collateral ratio at a vault tick, × 2^48 (port of the read SDK's `TickMath.getRatioAtTick`). */
export function jlRatioAtTick(tick: number): bigint {
  if (tick < JL_MIN_TICK || tick > -JL_MIN_TICK) throw new Error(`tick ${tick} out of range`);
  const abs = Math.abs(tick);
  let f = abs & 1 ? (TICK_FACTORS[0] as bigint) : 1n << 64n;
  for (let b = 1; b < 15; b++) if (abs & (1 << b)) f = (f * (TICK_FACTORS[b] as bigint)) >> 64n;
  let precision = 0n;
  if (tick > 0) {
    f = ((1n << 128n) - 1n) / f;
    if (f % 65536n !== 0n) precision = 1n;
  }
  return (f >> 16n) + precision;
}

/**
 * A position's collateral and debt in raw vault units, as the read SDK's `getCurrentPositionState` computes them
 * for a position whose tick has not been liquidated. A position above the vault's topmost tick sits in a
 * liquidated branch: its amounts need the branch data, so it is returned with `liquidatedBranch: true` and the
 * pre-liquidation amounts.
 */
export function jlPositionAmounts(p: JlPosition, topmostTick: number) {
  if (p.isSupplyOnly || p.tick === JL_INIT_TICK || p.tick <= JL_MIN_TICK)
    return {
      colRaw: p.supplyAmount,
      debtRaw: 0n,
      dustDebtRaw: p.dustDebtAmount,
      liquidatedBranch: false,
    };
  const debtRaw = ((jlRatioAtTick(p.tick) * (p.supplyAmount + 1n)) >> 48n) + 1n;
  return {
    colRaw: p.supplyAmount,
    debtRaw,
    dustDebtRaw: p.dustDebtAmount,
    liquidatedBranch: p.tick > topmostTick,
  };
}

/** Vault amounts (state totals and positions) are kept in 9-decimal internal units, whatever the token's decimals. */
export const JL_VAULT_INTERNAL_DECIMALS = 9;
const SCALE18 = 10n ** 18n;

/**
 * Vault exchange prices accrued to now from the liquidity layer's current exchange prices (port of the read
 * SDK's `updateExchangePrices`): the vault's prices grow by the same factor as the layer's since the vault's last
 * update, plus the vault's rate magnifiers. Stored prices go stale on vaults that see few transactions.
 */
export function jlVaultExchangePrices(
  st: JlVaultState,
  cfg: Pick<JlVaultConfig, 'supplyRateMagnifier' | 'borrowRateMagnifier'>,
  liquiditySupplyExchangePrice: bigint,
  liquidityBorrowExchangePrice: bigint,
  now: number,
) {
  const dt = BigInt(Math.max(0, now - Number(st.lastUpdateTimestamp)));
  const supInc = (liquiditySupplyExchangePrice * SCALE18) / st.liquiditySupplyExchangePrice;
  let supply = (st.vaultSupplyExchangePrice * supInc) / SCALE18;
  if (cfg.supplyRateMagnifier !== 0) {
    const ch =
      (st.vaultSupplyExchangePrice * dt * BigInt(Math.abs(cfg.supplyRateMagnifier))) /
      10_000n /
      SECONDS_PER_YEAR;
    supply = cfg.supplyRateMagnifier > 0 ? supply + ch : supply - ch;
  }
  const borInc = (liquidityBorrowExchangePrice * SCALE18) / st.liquidityBorrowExchangePrice;
  let borrow = (st.vaultBorrowExchangePrice * borInc + SCALE18 - 1n) / SCALE18;
  if (cfg.borrowRateMagnifier !== 0) {
    const ch =
      (st.vaultBorrowExchangePrice * dt * BigInt(Math.abs(cfg.borrowRateMagnifier))) /
      10_000n /
      SECONDS_PER_YEAR;
    borrow = cfg.borrowRateMagnifier > 0 ? borrow + ch : borrow - ch;
  }
  return { vaultSupplyExchangePrice: supply, vaultBorrowExchangePrice: borrow };
}
