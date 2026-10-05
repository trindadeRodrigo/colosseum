import { Reader } from './bytes';

/**
 * Raydium CPMM (constant product). Swappable reserves are the vault balances minus fees owed to the
 * protocol, fund and creator, which sit in the same vaults. Offsets checked against live pools.
 */
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

export type CpmmPool = {
  ammConfig: string;
  vault0: string;
  vault1: string;
  mint0: string;
  mint1: string;
  decimals0: number;
  decimals1: number;
  /** Fees owed (protocol + fund + creator) held inside each vault, raw units. */
  owed0: bigint;
  owed1: bigint;
  creatorFeeOn: number;
  enableCreatorFee: boolean;
};

export function decodeCpmmPool(data: Uint8Array): CpmmPool {
  const r = new Reader(data);
  const creator0 = data.length >= 413 ? r.u64(397) : 0n;
  const creator1 = data.length >= 413 ? r.u64(405) : 0n;
  return {
    ammConfig: r.pubkey(8),
    vault0: r.pubkey(72),
    vault1: r.pubkey(104),
    mint0: r.pubkey(168),
    mint1: r.pubkey(200),
    decimals0: r.u8(331),
    decimals1: r.u8(332),
    owed0: r.u64(341) + r.u64(357) + creator0,
    owed1: r.u64(349) + r.u64(365) + creator1,
    creatorFeeOn: data.length >= 413 ? r.u8(389) : 0,
    enableCreatorFee: data.length >= 413 ? r.u8(390) === 1 : false,
  };
}

/** CPMM AmmConfig: trade and creator fee rates in millionths. */
export function decodeCpmmAmmConfig(data: Uint8Array): {
  tradeFeeRate: number;
  creatorFeeRate: number;
} {
  const r = new Reader(data);
  return {
    tradeFeeRate: Number(r.u64(12)),
    creatorFeeRate: data.length >= 116 ? Number(r.u64(108)) : 0,
  };
}

export type CpState = { reserveIn: number; reserveOut: number; feeRate: number };

/** Constant-product exact-input swap, fee taken from input. */
export function cpSwapExactIn(s: CpState, amountIn: number): number {
  const net = amountIn * (1 - s.feeRate);
  return (s.reserveOut * net) / (s.reserveIn + net);
}

/** Token-2022 transfer fee (basis points, capped per transfer). Applies to any pool leg in that mint. */
export type TransferFee = { bps: number; maximumFee: number };
export function afterTransferFee(amount: number, fee: TransferFee | undefined): number {
  if (!fee || fee.bps === 0) return amount;
  return amount - Math.min(Math.ceil((amount * fee.bps) / 10_000), fee.maximumFee);
}
