import { z } from 'zod';
import type { BasketAsset } from './basket-asset';
import type { BuiltTx } from './basket-tx';
import { Address, AssetId, BasketId, Bps, type ChainId, RawAmount } from './chain';
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
  legs: z.number().int().nonnegative(),
  newVault: z.boolean(),
});
export type FundingNeed = z.infer<typeof FundingNeed>;

export const ApproveArgs = z.object({ owner: Address, spender: Address, amountRaw: RawAmount });
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
});
export type CreateVaultArgs = z.infer<typeof CreateVaultArgs>;

export const DepositArgs = z.object({
  vault: Address,
  amountRaw: RawAmount,
  trades: z.array(Trade).optional(),
  slippageBps: Bps,
});
export type DepositArgs = z.infer<typeof DepositArgs>;

export const OwnerSwapArgs = z.object({
  vault: Address,
  trades: z.array(Trade).min(1),
  slippageBps: Bps,
});
export type OwnerSwapArgs = z.infer<typeof OwnerSwapArgs>;

export const SetTargetsArgs = z.object({ vault: Address, targets: Targets });
export type SetTargetsArgs = z.infer<typeof SetTargetsArgs>;

export const AcceptVersionArgs = z.object({
  vault: Address,
  recipeOnchainId: z.string().min(1),
  expectedVersion: z.number().int().min(1),
});
export type AcceptVersionArgs = z.infer<typeof AcceptVersionArgs>;

export const SetAutoFollowArgs = z.object({ vault: Address, on: z.boolean() });
export type SetAutoFollowArgs = z.infer<typeof SetAutoFollowArgs>;

export const WithdrawInKindArgs = z.object({ vault: Address, assets: z.array(AssetId).optional() });
export type WithdrawInKindArgs = z.infer<typeof WithdrawInKindArgs>;

export const PublishRecipeArgs = z.object({ creator: Address, recipe: Recipe });
export type PublishRecipeArgs = z.infer<typeof PublishRecipeArgs>;

export interface ChainReader {
  chain: ChainId;
  capabilities: Capabilities;
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

/** No builder sets a vault's keeper or operator. */
export type ChainAdapter = ChainReader & OwnerBuilder & KeeperBuilder;
