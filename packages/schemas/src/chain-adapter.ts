import { z } from 'zod';
import type { BasketAsset } from './basket-asset';
import type { BuiltTx } from './basket-tx';
import { Address, AssetId, BasketId, Bps, type ChainId, RawAmount } from './chain';
import type { Provenance } from './enums';
import { Recipe, Target, Targets } from './recipe';
import {
  type Funding,
  type Holding,
  type Price,
  type Quote,
  Trade,
  type TxStatus,
  type VaultState,
} from './vault';

// DESIGN-VAULT 3.2. The interface every chain implements. packages/chain-mock holds the contract tests
// every adapter must pass.

export const Capabilities = z.object({
  trade: z.enum(['live', 'readonly', 'mock']),
  autoFollow: z.boolean(),
  /** 1 on Solana, 8 on EVM. */
  maxTradesPerTx: z.number().int().min(1),
  /** False on Solana, true on EVM. */
  tradesInCreate: z.boolean(),
  /** False on Solana, true on EVM. */
  needsApprove: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// The design writes each builder's argument inline. They are named here so a route can validate one.

export const FundingNeed = z.object({
  cashRaw: RawAmount,
  /** How many transactions the person signs. */
  legs: z.number().int().nonnegative(),
  newVault: z.boolean(),
  /**
   * How many token accounts those transactions open, where the caller knows: on Solana the vault's cash
   * account when the vault is new, and one for each asset bought for the first time. Each locks rent.
   * Left out, the adapter assumes the most, one per transaction. A chain with no rent ignores it.
   */
  newAccounts: z.number().int().nonnegative().optional(),
});
export type FundingNeed = z.infer<typeof FundingNeed>;

/**
 * EVM only, on every owner builder: the nonce to build on, in place of the signer's next one. It is for
 * the rebuild of a step whose earlier attempt is still open: the two share the nonce, so at most one of
 * them can land. A chain with no nonce refuses it with `NotSupported`.
 */
const RebuildNonce = z.number().int().nonnegative().optional();

/**
 * An approval of the chain's cash token, for one plan. The caller names the plan and the amount, never
 * who may take the cash: the adapter derives that (on EVM always the plan's vault, by its address,
 * which is known before the vault exists; never the factory). Strict, so a `spender` sent by a caller
 * is refused and not ignored.
 */
export const ApproveArgs = z.strictObject({
  owner: Address,
  basketId: BasketId,
  amountRaw: RawAmount,
  nonce: RebuildNonce,
});
export type ApproveArgs = z.infer<typeof ApproveArgs>;

export const CreateVaultArgs = z.object({
  owner: Address,
  basketId: BasketId,
  /** Empty when `recipeOnchainId` is given: the vault copies the active version. */
  targets: z.array(Target),
  recipeOnchainId: z.string().min(1).optional(),
  expectedVersion: z.number().int().min(1).optional(),
  autoFollow: z.boolean(),
  depositRaw: RawAmount.optional(),
  trades: z.array(Trade).optional(),
  slippageBps: Bps,
  nonce: RebuildNonce,
});
export type CreateVaultArgs = z.infer<typeof CreateVaultArgs>;

export const DepositArgs = z.object({
  vault: Address,
  amountRaw: RawAmount,
  trades: z.array(Trade).optional(),
  slippageBps: Bps,
  nonce: RebuildNonce,
});
export type DepositArgs = z.infer<typeof DepositArgs>;

export const OwnerSwapArgs = z.object({
  vault: Address,
  trades: z.array(Trade).min(1),
  slippageBps: Bps,
  nonce: RebuildNonce,
});
export type OwnerSwapArgs = z.infer<typeof OwnerSwapArgs>;

export const SetTargetsArgs = z.object({ vault: Address, targets: Targets, nonce: RebuildNonce });
export type SetTargetsArgs = z.infer<typeof SetTargetsArgs>;

export const AcceptVersionArgs = z.object({
  vault: Address,
  recipeOnchainId: z.string().min(1),
  expectedVersion: z.number().int().min(1),
  nonce: RebuildNonce,
});
export type AcceptVersionArgs = z.infer<typeof AcceptVersionArgs>;

export const SetAutoFollowArgs = z.object({
  vault: Address,
  on: z.boolean(),
  nonce: RebuildNonce,
});
export type SetAutoFollowArgs = z.infer<typeof SetAutoFollowArgs>;

export const WithdrawInKindArgs = z.object({
  vault: Address,
  assets: z.array(AssetId).optional(),
  nonce: RebuildNonce,
});
export type WithdrawInKindArgs = z.infer<typeof WithdrawInKindArgs>;

export const PublishRecipeArgs = z.object({
  creator: Address,
  recipe: Recipe,
  nonce: RebuildNonce,
});
export type PublishRecipeArgs = z.infer<typeof PublishRecipeArgs>;

export interface ChainReader {
  chain: ChainId;
  capabilities: Capabilities;
  /**
   * The label on everything this adapter returns: `mock` on packages/chain-mock, `sandbox` on a test
   * network or a local copy of mainnet, `live` on mainnet only (`chainProvenance`).
   */
  provenance: Provenance;
  listAssets(): Promise<BasketAsset[]>;
  getPrices(assets: AssetId[]): Promise<Price[]>;
  getVaults(owner: Address): Promise<VaultState[]>;
  getVault(vault: Address): Promise<VaultState | null>;
  listAutoFollowVaults(recipeOnchainId?: string): Promise<Address[]>;
  getRecipe(recipeOnchainId: string): Promise<{ active: Recipe; pending: Recipe | null }>;
  getWalletHoldings(owner: Address): Promise<Holding[]>;
  funding(owner: Address, need: FundingNeed): Promise<Funding>;
  quote(trade: Trade, taker: Address): Promise<Quote>;
  track(txId: string, validUntil?: string): Promise<TxStatus>;
}

/**
 * Each call returns ONE transaction; the planner splits by the capabilities. A builder that refuses
 * throws a ChainError, for bad arguments as much as for a simulated revert.
 */
export interface OwnerBuilder {
  buildApprove(a: ApproveArgs): Promise<BuiltTx>;
  buildCreateVault(a: CreateVaultArgs): Promise<BuiltTx>;
  buildDeposit(a: DepositArgs): Promise<BuiltTx>;
  buildOwnerSwap(a: OwnerSwapArgs): Promise<BuiltTx>;
  buildSetTargets(a: SetTargetsArgs): Promise<BuiltTx>;
  buildAcceptVersion(a: AcceptVersionArgs): Promise<BuiltTx>;
  buildSetAutoFollow(a: SetAutoFollowArgs): Promise<BuiltTx>;
  /** Always to the owner. */
  buildWithdrawInKind(a: WithdrawInKindArgs): Promise<BuiltTx[]>;
  buildPublishRecipe(a: PublishRecipeArgs): Promise<BuiltTx>;
}

export interface KeeperBuilder {
  buildAdoptVersion(vault: Address): Promise<BuiltTx>;
  buildKeeperLeg(vault: Address, trade: Trade): Promise<BuiltTx>;
}

/**
 * An attempt as a chain can look for it: the message that was built, who signs it, and how long it can
 * land. `signer` and `nonce` are what a real chain needs to find a transaction nobody reported: on
 * Solana the signer's recent signatures, on EVM the account's nonce.
 */
export const AttemptRef = z.object({
  messageHash: z.string().min(1),
  signer: Address,
  /**
   * As the build gave it: a block height on Solana; on EVM a trade's deadline in unix seconds, and null
   * for a call that does not trade.
   */
  validUntil: z.string().nullable(),
  /**
   * EVM: the nonce of record. It is the one the build stated (`evm.nonce`), or the one in the signed or
   * sent transaction where the wallet chose its own (`nonceOf`). Null on Solana.
   */
  nonce: z.number().int().nonnegative().nullable(),
});
export type AttemptRef = z.infer<typeof AttemptRef>;

/**
 * What became of an attempt whose transaction id nobody reported.
 * - `open`: its bytes can still land.
 * - `gone`: they no longer can.
 * - `landed`: the chain has the transaction, confirmed or reverted, with its id. `track` says which.
 *
 * Solana: an attempt is its message. It is `gone` once the chain is past `validUntil`.
 * EVM: an attempt is the pair (messageHash, nonce), since two builds of one call share a hash. It is
 * `landed` when the transaction at the signer's nonce is this call, `gone` when the signer's nonce has
 * passed the attempt's and another call used it, and `open` otherwise. Only a trade expires by time:
 * `ownerSwap` and `createVaultAndBuy` carry a deadline, and an attempt of one whose deadline the chain's
 * clock has passed, with no transaction on the chain, is `gone` (the adapter states the deadline as
 * `validUntil`). An attempt with no nonce cannot be looked for and is `open`.
 */
export const AttemptFate = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open') }),
  z.object({ state: z.literal('gone') }),
  z.object({ state: z.literal('landed'), txId: z.string().min(1) }),
]);
export type AttemptFate = z.infer<typeof AttemptFate>;

/**
 * What a node says of a reported transaction against a message that was built.
 * - `this`: the transaction carries this message and no other: the same signer, target and call data
 *   (on Solana, the same message).
 * - `another`: the node has the transaction, and it is another call or another signer's.
 * - `unseen`: the node does not have the transaction. A wallet that sent it a moment ago may be ahead
 *   of the node, so this is not a refusal of the transaction: the caller reports again later.
 */
export const Carried = z.enum(['this', 'another', 'unseen']);
export type Carried = z.infer<typeof Carried>;

/**
 * What the order layer needs to tie signed bytes and a landed transaction back to what was built. A
 * leg may only settle on the transaction that was built for it, and signed bytes are only relayed when
 * they are bytes this server built. It holds no key and signs nothing.
 */
export interface TxProbe {
  /**
   * The `messageHash` of signed bytes (what `WalletPort.sign()` returns), computed as the adapter that
   * built them does (basket-tx.ts): on Solana the hash of the message, whatever the signatures; on EVM
   * the hash of the call, with the signer recovered from the signature. Refuses with `BadInput` bytes
   * that are not a transaction of this chain. The caller compares the answer with the attempts it
   * stored: an adapter keeps no record of what it built.
   */
  messageHashOf(signedTx: string): Promise<string>;
  /**
   * Broadcasts signed bytes and answers the transaction's id, without waiting for it to land. Called
   * only after `messageHashOf` matched an attempt this server built. Refuses with a `ChainError` bytes
   * the chain will not take; an adapter that can tell they are not its own says `NotBuiltHere`.
   * Sending the same bytes twice lands them once.
   */
  relay(signedTx: string): Promise<{ txId: string; validUntil?: string }>;
  /**
   * Whether the transaction with this id carries the message with this hash (`Carried`). The caller
   * settles a step on `this` only, refuses `another`, and asks again later on `unseen`.
   */
  carries(txId: string, messageHash: string): Promise<Carried>;
  /** What became of an attempt whose transaction id nobody reported (`AttemptFate`). */
  fate(attempt: AttemptRef): Promise<AttemptFate>;
  /**
   * EVM: the nonce a transaction was signed with, read from signed bytes or from a transaction the
   * node has. An outside wallet may sign with another nonce than the build stated; this is the nonce of
   * record. Null on Solana, and for an id the node does not have.
   */
  nonceOf(seen: { signedTx: string } | { txId: string }): Promise<number | null>;
}

/** No builder sets a vault's keeper or operator. */
export type ChainAdapter = ChainReader & OwnerBuilder & KeeperBuilder & TxProbe;
