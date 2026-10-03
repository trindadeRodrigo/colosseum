import { z } from 'zod';

// One refusal type for every chain adapter, the mock included, and one list of codes, in three blocks:
// the Solana program's errors, the EVM contracts' errors that no program error stands for, and what an
// adapter refuses before the chain is asked. DESIGN-VAULT section 3 has the table that maps a program
// error and a contract error onto its code.

/**
 * `BasketError` of programs/basket, in the program's own order: Anchor numbers them from 6000, so a
 * code's position here is its number less 6000. The first 24 are frozen (DESIGN-VAULT 3.7); the list
 * only grows at the end. The EVM contracts use the same name where the rule is the same.
 */
export const PROGRAM_ERRORS = [
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
  // Appended after the frozen list.
  /** The signer of `init_config` or `init_assets` is not the program's upgrade authority. */
  'NotUpgradeAuthority',
  /** More than 16 targets, a mint twice, the zero address, or weights above 10,000. */
  'InvalidTargets',
  /** A deposit in any mint but the chain's cash mint. */
  'NotCashMint',
  /** The zero address where an address is needed. On EVM the vault and the config raise it too. */
  'ZeroAddress',
] as const;

/** The errors of the EVM contracts (contracts/src/interfaces) that mean something no program error does. */
const CONTRACT_ONLY_ERRORS = [
  /** The caller is not the vault's owner. On Solana this is an Anchor account constraint, not a `BasketError`. */
  'NotOwner',
  /** The chain's config names no cash token yet, so nothing can be deposited. */
  'CashTokenNotSet',
  /** The vault received less cash than was deposited: a token that takes a cut on transfer is refused. */
  'DepositShortfall',
  /** `withdrawAll` was sent with too little gas to try every token. */
  'GasTooLow',
  /** The caller is not the admin, or not the admin-to-be, that the call is for. */
  'NotAdmin',
  /** An address given as a token or a router holds no code. */
  'NoCode',
  /** A token that is an allowed router cannot be listed as an asset. */
  'AssetIsRouter',
  /** A listed asset cannot be allowed as a router. */
  'RouterIsAsset',
] as const;

/** What an adapter refuses before the chain is asked, or cannot say more about. */
const ADAPTER_ERRORS = [
  /** The arguments do not match their schema: a malformed amount, targets that add up to over 10,000. */
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
] as const;

export const ChainErrorCode = z.enum([
  ...PROGRAM_ERRORS,
  ...CONTRACT_ONLY_ERRORS,
  ...ADAPTER_ERRORS,
]);
export type ChainErrorCode = z.infer<typeof ChainErrorCode>;

/**
 * Every custom error the EVM contracts declare, as the code an adapter reports for it. The same name
 * where the program has the same rule; an existing code where the meaning is the same under another
 * name; a new code only where neither holds. A root test reads contracts/src and fails on an error
 * with no row here.
 */
export const CONTRACT_ERROR_CODE = {
  // IBasketVault
  NotOwner: 'NotOwner',
  ZeroAddress: 'ZeroAddress',
  CashTokenNotSet: 'CashTokenNotSet',
  DepositShortfall: 'DepositShortfall',
  GasTooLow: 'GasTooLow',
  // IVaultConfig
  NotAdmin: 'NotAdmin',
  NotPendingAdmin: 'NotAdmin',
  NoCode: 'NoCode',
  /** The token is not on the chain's asset list: what every adapter already refuses as MintNotAccepted. */
  AssetNotListed: 'MintNotAccepted',
  AssetIsRouter: 'AssetIsRouter',
  RouterIsAsset: 'RouterIsAsset',
  /** An asset listed with a price source and no feed has no price reference. */
  FeedRequired: 'AssetNotPriced',
  /** `pull` is a parameter with a hard bound like the others. */
  InvalidPull: 'ParamOutOfBounds',
  ParamOutOfBounds: 'ParamOutOfBounds',
} as const satisfies Record<string, ChainErrorCode>;

/**
 * Whether building again, later or at a fresh price, can succeed with nothing changed by the person.
 * Every code says: a code added without a line here does not compile.
 */
export const CHAIN_ERROR_RETRYABLE: Record<ChainErrorCode, boolean> = {
  NotKeeper: false,
  AutoFollowOff: false,
  /** The guardian paused the keeper; the admin lifts it. */
  KeeperPaused: true,
  MintNotAccepted: false,
  RouterNotAllowed: false,
  SpentTooMuch: false,
  /** The price moved past the slippage: a new build takes a fresh quote. */
  ReceivedTooLittle: true,
  OtherAccountDebited: false,
  AccountTampered: false,
  PriceStale: true,
  PriceDeviation: true,
  MarketClosed: true,
  MultiplierWindow: true,
  NotTowardTarget: false,
  PastTarget: false,
  Cooldown: true,
  LossCapReached: false,
  AssetNotPriced: false,
  NewAssetNeedsOwner: false,
  VersionNotEffective: false,
  CreatorLimit: false,
  VersionMismatch: false,
  WrongDestination: false,
  ParamOutOfBounds: false,
  NotUpgradeAuthority: false,
  InvalidTargets: false,
  NotCashMint: false,
  ZeroAddress: false,
  NotOwner: false,
  CashTokenNotSet: false,
  DepositShortfall: false,
  /** A new build sets a higher gas limit. */
  GasTooLow: true,
  NotAdmin: false,
  NoCode: false,
  AssetIsRouter: false,
  RouterIsAsset: false,
  BadInput: false,
  NotSupported: false,
  TooManyTrades: false,
  BadTrade: false,
  VaultNotFound: false,
  VaultExists: false,
  RecipeNotFound: false,
  NotFollowing: false,
  NotFunded: false,
  NoGas: false,
  AllowanceTooLow: false,
  Expired: true,
  NotBuiltHere: false,
  Unavailable: true,
  Unknown: false,
};

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
  constructor(
    code: ChainErrorCode,
    message: string,
    retryable: boolean = CHAIN_ERROR_RETRYABLE[code],
  ) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.retryable = retryable;
  }
  toJSON(): ChainErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
