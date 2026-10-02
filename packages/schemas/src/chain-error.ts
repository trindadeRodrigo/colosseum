import { z } from 'zod';

// One refusal type for every chain adapter, the mock included, and one list of codes. The first block is
// the vault's own error list (DESIGN-VAULT 3.7; the EVM contracts use the same names where the rule is
// the same). The second is what an adapter refuses before the chain is asked.

export const ChainErrorCode = z.enum([
  // The vault, the registry and the asset list.
  'NotKeeper',
  'AutoFollowOff',
  'KeeperPaused',
  'MintNotAccepted',
  'RouterNotAllowed',
  'SpentTooMuch',
  'ReceivedTooLittle',
  'OtherAccountDebited',
  'AccountTampered',
  'PriceStale',
  'PriceDeviation',
  'MarketClosed',
  'MultiplierWindow',
  'NotTowardTarget',
  'PastTarget',
  'Cooldown',
  'LossCapReached',
  'AssetNotPriced',
  'NewAssetNeedsOwner',
  'VersionNotEffective',
  'CreatorLimit',
  'VersionMismatch',
  'WrongDestination',
  'ParamOutOfBounds',
  // The adapter.
  /** The arguments do not match their schema: a malformed amount, targets that do not add up. */
  'BadInput',
  /** The chain has no such step: an approval on Solana, trades inside a create on Solana. */
  'NotSupported',
  'TooManyTrades',
  'BadTrade',
  'VaultNotFound',
  /** The owner already used that plan id. */
  'VaultExists',
  'RecipeNotFound',
  'NotFollowing',
  'NotFunded',
  'NoGas',
  'AllowanceTooLow',
  /** Built too long ago to be sent. */
  'Expired',
  /** Bytes this server did not build are never relayed. */
  'NotBuiltHere',
  /** The RPC or the quote source did not answer. */
  'Unavailable',
  'Unknown',
]);
export type ChainErrorCode = z.infer<typeof ChainErrorCode>;

/** Building again, later or at a fresh price, can succeed with nothing changed by the person. */
const RETRYABLE: ReadonlySet<ChainErrorCode> = new Set([
  'KeeperPaused',
  'ReceivedTooLittle',
  'PriceStale',
  'PriceDeviation',
  'MarketClosed',
  'MultiplierWindow',
  'Cooldown',
  'Expired',
  'Unavailable',
]);

/** The same three fields as data, as a leg stores them. */
export const ChainErrorInfo = z.object({
  code: ChainErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type ChainErrorInfo = z.infer<typeof ChainErrorInfo>;

/** What every adapter throws when it refuses: at build, at simulate, or when the chain reverts. */
export class ChainError extends Error {
  readonly code: ChainErrorCode;
  readonly retryable: boolean;
  constructor(code: ChainErrorCode, message: string, retryable: boolean = RETRYABLE.has(code)) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.retryable = retryable;
  }
  toJSON(): ChainErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
