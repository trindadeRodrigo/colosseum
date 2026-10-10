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
  // Appended with the owner swap and the registries.
  /** The router, the price owner and the cash mint are fixed once the config is launched. */
  'LockedAtLaunch',
  /** The mint runs a transfer hook program, or its extension list cannot be read. */
  'HookNotAllowed',
  /** The asset list already holds its 64 entries. */
  'AssetListFull',
  /** A swap from a mint to itself. */
  'SameMint',
  /** There is no waiting version to cancel. */
  'NoPendingVersion',
  /** Only the portfolio's creator or the guardian cancels a waiting version. */
  'NotCreatorOrGuardian',
  // Appended with the keeper leg.
  /** A keeper leg trades cash for one asset or one asset for cash, never two assets. */
  'NotCashLeg',
  /** The admin has not switched the keeper on for the asset: its price entry is not confirmed live. */
  'KeeperAssetOff',
  /** The asset's price entry is outside the range the admin set for it: the keeper values nothing at it. */
  'PriceOutOfRange',
  /** A keeper leg that names no amount, or whose route spends nothing. */
  'NothingTraded',
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
  /** The guardian stopped new money on the chain: no deposit until the admin lifts it. Withdrawing works. */
  'DepositsPaused',
  /** The deposit would pass the most one vault, or all vaults together, may take in before an audit. */
  'DepositCapReached',
  /** Creating a vault is limited to a list the admin keeps, and this wallet is not on it. */
  'CreationNotOpen',
  /** The caller is not the admin, or not the admin-to-be, that the call is for. */
  'NotAdmin',
  /** An address given as a token or a router holds no code. */
  'NoCode',
  /** A token that is an allowed router cannot be listed as an asset. */
  'AssetIsRouter',
  /** A listed asset cannot be allowed as a router. */
  'RouterIsAsset',
  // Appended with the factory, the registry and the owner swap (EVM-2).
  /** `start` on a vault from anyone but its factory, or in any transaction after the one that made it. */
  'NotCreating',
  /** The router's own call reverted: its minimum, its deadline, its pool. The reason is in the message. */
  'RouterFailed',
  /** The vault's balance of a token it is trading cannot be read: the token is frozen or broken. */
  'BalanceUnreadable',
  /** The chain's cash token cannot be taken off the asset list while it is the cash token. */
  'CashTokenNotRemovable',
  /** `launch` while the admin or the beacon is still being handed from the deployer to the admin key. */
  'HandoverNotDone',
  /** A setting that is made once is already made: the registry is set, or the platform is launched. */
  'AlreadySet',
  /** That creator already has a shared portfolio under that family id. */
  'RecipeExists',
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
  /** A trade would now give less than the least its order stated: the terms are not changed for it. */
  'PriceMoved',
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
  NotCreating: 'NotCreating',
  RouterNotAllowed: 'RouterNotAllowed',
  /**
   * A swap's input was never a listed asset, or its output is not listed now. The contract raises it
   * too for a swap from a token to itself, which the program calls SameMint.
   */
  TokenNotAccepted: 'MintNotAccepted',
  RouterFailed: 'RouterFailed',
  SpentTooMuch: 'SpentTooMuch',
  ReceivedTooLittle: 'ReceivedTooLittle',
  /** Another token of the vault went down during the swap: the program's other account debited. */
  OtherTokenDebited: 'OtherAccountDebited',
  BalanceUnreadable: 'BalanceUnreadable',
  /** An allowance from the vault outlived the swap: what a delegate left on an account is on Solana. */
  AllowanceLeft: 'AccountTampered',
  InvalidTargets: 'InvalidTargets',
  IndexNotFound: 'RecipeNotFound',
  VersionMismatch: 'VersionMismatch',
  /** The chain's config names no registry, so nothing can be followed there yet. */
  RegistryNotSet: 'NotSupported',
  /** An owner's trade sent after the deadline it was signed with: built too long ago to be sent. */
  DeadlinePassed: 'Expired',
  // IBasketVault, the keeper's path (EVM-3): the program's names where the rule is the same.
  NotKeeper: 'NotKeeper',
  AutoFollowOff: 'AutoFollowOff',
  KeeperPaused: 'KeeperPaused',
  NotCashLeg: 'NotCashLeg',
  NotTowardTarget: 'NotTowardTarget',
  PastTarget: 'PastTarget',
  Cooldown: 'Cooldown',
  LossCapReached: 'LossCapReached',
  AssetNotPriced: 'AssetNotPriced',
  KeeperAssetOff: 'KeeperAssetOff',
  PriceOutOfRange: 'PriceOutOfRange',
  PriceStale: 'PriceStale',
  PriceDeviation: 'PriceDeviation',
  /** The chain's sequencer is down or came back less than an hour ago: its prices wait, as a stale one does. */
  SequencerDown: 'PriceStale',
  MarketClosed: 'MarketClosed',
  /** The guardian halted keeper trades in the asset: the market is closed to the keeper for it. */
  AssetHalted: 'MarketClosed',
  /** The issuer paused the token: closed to the keeper until the issuer lifts it. */
  AssetPaused: 'MarketClosed',
  MultiplierWindow: 'MultiplierWindow',
  /** What came in is worth less than what went out, less the tolerance: the program's ReceivedTooLittle. */
  ValueTooLow: 'ReceivedTooLittle',
  NothingTraded: 'NothingTraded',
  /** The vault is worth more than the keeper's checks measure: the program refuses it as AssetNotPriced. */
  ValueTooLarge: 'AssetNotPriced',
  NewAssetNeedsOwner: 'NewAssetNeedsOwner',
  VersionNotEffective: 'VersionNotEffective',
  // IVaultConfig
  DepositsArePaused: 'DepositsPaused',
  NotAllowedToCreate: 'CreationNotOpen',
  VaultCapReached: 'DepositCapReached',
  TotalCapReached: 'DepositCapReached',
  /** Decimals stated for a token or a feed that are not its own: a setting outside what it may be. */
  DecimalsMismatch: 'ParamOutOfBounds',
  /** `noteDeposit` from a caller that is not a vault of the factory, as an admin's call from another is. */
  NotAVault: 'NotAdmin',
  NotAdmin: 'NotAdmin',
  NotPendingAdmin: 'NotAdmin',
  /** A guardian's call from a caller who holds neither that role nor the admin's. */
  NotGuardian: 'NotAdmin',
  NoCode: 'NoCode',
  /** The token is not on the chain's asset list: what every adapter already refuses as MintNotAccepted. */
  AssetNotListed: 'MintNotAccepted',
  AssetIsRouter: 'AssetIsRouter',
  RouterIsAsset: 'RouterIsAsset',
  /** The address answers as a token does: the rule of RouterIsAsset, for a token that was never listed. */
  RouterIsToken: 'RouterIsAsset',
  /** Permit2, the factory, the registry, the beacon or a vault: none may be allowed as a router. */
  RouterReserved: 'RouterNotAllowed',
  CashTokenNotRemovable: 'CashTokenNotRemovable',
  /** An asset listed with a price source and no feed has no price reference. */
  FeedRequired: 'AssetNotPriced',
  /** `pull` is a parameter with a hard bound like the others. */
  InvalidPull: 'ParamOutOfBounds',
  /** A guardian's call takes only a later time than the one stored: an earlier one is out of its bounds. */
  OnlyTighten: 'ParamOutOfBounds',
  AlreadyLaunched: 'AlreadySet',
  AdminHandoverPending: 'HandoverNotDone',
  RegistryAlreadySet: 'AlreadySet',
  ParamOutOfBounds: 'ParamOutOfBounds',
  // IVaultFactory
  VaultExists: 'VaultExists',
  BeaconNotTheAdmins: 'HandoverNotDone',
  // IIndexRegistry
  CreatorLimit: 'CreatorLimit',
  /** The list is not in ascending order of token: malformed input, not one of the fourteen limits. */
  NotSorted: 'BadInput',
  IndexExists: 'RecipeExists',
  /** Publishing is the creator's alone; cancelling is the creator's, the guardian's or the admin's. */
  NotCreator: 'NotCreatorOrGuardian',
  NothingPending: 'NoPendingVersion',
  // VaultBeacon
  /** The beacon's key cannot be given up: there is no such step. */
  RenounceDisabled: 'NotSupported',
  // PoolAverageFeed and TickPrice (contracts/src/price): an asset's one-hour average from its pool
  /** The feed gives no answer, with its reason; the vault reads that as its own AssetNotPriced. */
  NotPriced: 'AssetNotPriced',
  /** The pool's average tick is past the ticks the maths takes: no price can be stated. */
  TickOutOfRange: 'AssetNotPriced',
  /** A feed deployed with a window, a floor, a band, tokens or decimals it cannot work with. */
  InvalidSetup: 'ParamOutOfBounds',
} as const satisfies Record<string, ChainErrorCode>;

/**
 * `retryable` means one thing: the same call may succeed later with no change by the person. It says
 * nothing about how soon: a cooldown passes in an hour, a weekly loss counter decays over days.
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
  /** The price moved past the least the step accepts; it can come back, and a new build tries again. */
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
  /** The weekly counter decays: the same leg passes once enough of it has. */
  LossCapReached: true,
  AssetNotPriced: false,
  NewAssetNeedsOwner: false,
  /** The version takes effect at its time, with no transaction. */
  VersionNotEffective: true,
  CreatorLimit: false,
  VersionMismatch: false,
  WrongDestination: false,
  ParamOutOfBounds: false,
  NotUpgradeAuthority: false,
  InvalidTargets: false,
  NotCashMint: false,
  ZeroAddress: false,
  LockedAtLaunch: false,
  HookNotAllowed: false,
  AssetListFull: false,
  SameMint: false,
  NoPendingVersion: false,
  NotCreatorOrGuardian: false,
  NotCashLeg: false,
  KeeperAssetOff: false,
  /** A feed that is off, or a range the admin has to move: neither passes by waiting. */
  PriceOutOfRange: false,
  NothingTraded: false,
  NotOwner: false,
  CashTokenNotSet: false,
  DepositShortfall: false,
  /** A new build states a higher `evm.gas`. */
  GasTooLow: true,
  /** Neither passes by sending again: the admin lifts the pause or raises the cap, or the person deposits less. */
  DepositsPaused: false,
  DepositCapReached: false,
  CreationNotOpen: false,
  NotAdmin: false,
  NoCode: false,
  AssetIsRouter: false,
  RouterIsAsset: false,
  NotCreating: false,
  /** Most often the price moved past the route's own minimum or its deadline passed: a new build quotes again. */
  RouterFailed: true,
  BalanceUnreadable: false,
  CashTokenNotRemovable: false,
  HandoverNotDone: false,
  AlreadySet: false,
  RecipeExists: false,
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
  /** The order is made again, at the price now: nothing about this one changes. */
  PriceMoved: false,
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
  /**
   * The transaction was refused before it left this process (a relay's preflight): it can never land,
   * so a caller that remembered it as sent may forget it.
   */
  readonly unsent: boolean;
  constructor(
    code: ChainErrorCode,
    message: string,
    retryable: boolean = CHAIN_ERROR_RETRYABLE[code],
    options: { unsent?: boolean } = {},
  ) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.retryable = retryable;
    this.unsent = options.unsent ?? false;
  }
  toJSON(): ChainErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
