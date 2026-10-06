import type { BuiltTx, ChainAdapter, ChainErrorCode, Trade, VaultState } from '@colosseum/schemas';

// What the keeper needs of a chain, whichever chain it is: the adapter of DESIGN-VAULT 3.2 and one
// read of a vault as the chain's keeper path would find it. Solana's reader and the EVM reader each
// answer it (`getKeeperContext`); only Solana records balances, so only it syncs.

/** One position as the keeper plans with it. */
export type KeeperPositionView = {
  asset: string;
  /** The account holds another amount than the program records (Solana); never on EVM. */
  needsSync: boolean;
  /** The admin's switch on the asset. */
  keeperOn: boolean;
  /** Why the vault would not value the asset now, by the vault's error; null when it would. */
  reference: string | null;
  /** Why the asset itself cannot be traded now; null when it can. */
  trade: string | null;
  /** EVM: false for an asset taken off the factory's list, which can be sold and never bought. */
  listed?: boolean;
};

/** A vault as the chain's keeper path would find it now, all of it read at one moment. */
export type KeeperView = {
  vault: VaultState;
  rules: { paused: boolean; lossCapBps: number; bandBps: number };
  positions: KeeperPositionView[];
  /** Why no leg at all would pass now; null when a leg in a tradable position could. */
  blocked: ChainErrorCode | null;
  /** The chain's clock at the read, in unix seconds. */
  clock: number;
  /**
   * Solana: the one price account a leg passes, null when the positions are not all priced in one.
   * Left out on a chain that prices each asset by its own feed.
   */
  priceAccount?: string | null;
};

export type KeeperAdapter = ChainAdapter & {
  getKeeperContext(vault: string): Promise<KeeperView | null>;
  /**
   * A keeper leg, on EVM pinned to `nonce` where it is given: the nonce of an earlier leg of the vault
   * that the node does not hold, so that of the two at most one can land. Solana takes no nonce.
   */
  buildKeeperLeg(vault: string, trade: Trade, options?: { nonce?: number }): Promise<BuiltTx>;
  /** Solana only: writes what a vault's accounts hold into what the program records. */
  buildSyncBalances?(vault: string): Promise<BuiltTx>;
};
