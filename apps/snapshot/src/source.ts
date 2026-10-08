import type {
  Address,
  AssetId,
  BasketAsset,
  ChainId,
  Price,
  Provenance,
  Target,
  VaultState,
} from '@colosseum/schemas';

// What the worker needs of a chain, whichever chain it is: the read side of DESIGN-VAULT 3.2 and two
// reads of the chain itself. There is no builder, no probe and no signer here, so a pass cannot build
// or send anything. chains.ts makes one of these per chain from the environment: the Solana reader, the
// EVM reader, or the chain in memory.

/**
 * The settings every vault on the chain is held to, read once a pass: the keeper's pause, the loss
 * budget and the band. Null where the chain has none (the mock has only a band).
 */
export type ChainRules = {
  paused: boolean | null;
  lossCapBps: number | null;
  bandBps: number | null;
};

/** A vault the database already names on a chain: its address, and what the API cached of it. */
export type KnownVault = {
  address: string;
  owner: string;
  /** The plan's number on the chain, as a decimal string. */
  onchainBasketId: string;
  /** The plan's row (`baskets.id`) the API joined the vault to, or null. */
  basketId: string | null;
  targets: Target[];
  /** Dollars as the cache last had them, or null when the API never valued the vault. */
  valueUsd: string | null;
};

export type ChainSource = {
  chain: ChainId;
  /** The chain with its network, for a line: "Solana devnet". */
  name: string;
  /**
   * The label on every row this source gives: `mock` on packages/chain-mock, `sandbox` on a test
   * network. Never `live`: mainnet is refused before a source is made.
   */
  provenance: Provenance;
  /** Where a row's figures came from, in words: the row's `source`. */
  source: string;
  listAssets(): Promise<BasketAsset[]>;
  getPrices(assets: AssetId[]): Promise<Price[]>;
  /** Null when there is no vault at the address. */
  getVault(vault: Address): Promise<VaultState | null>;
  getVaults(owner: Address): Promise<VaultState[]>;
  rules(): Promise<ChainRules>;
  /**
   * The chain's height now: a slot on Solana, a block on EVM, the mock's own second. Read at the start
   * of a pass, so every vault of the pass is read at or after it. Null when the chain cannot say.
   */
  height(): Promise<bigint | null>;
  /**
   * The mock only: brings the sample world up to `now` before a pass, from the vaults the database
   * names, and answers the addresses of the vaults it holds that the database does not name (its one
   * sample vault, when nothing is named). The pass reads those too. A real chain has none.
   */
  prepare?(known: KnownVault[], now: Date): Promise<string[]>;
};
