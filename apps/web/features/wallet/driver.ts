import type { Chain } from '@colosseum/schemas';
import type { SolanaCluster } from './chains';

// What a wallet provider has to do, and nothing about our types. The port (port.ts) is the same code
// over every driver: Privy in the app, throwaway keys in tests and in mock mode.

/** An account as the provider reports it. The port puts the address in its family's form. */
export type DriverAccount = { family: Chain; address: string; kind: 'embedded' | 'external' };

/** The call an EVM transaction makes. The wallet adds the nonce, the gas and the fee: nothing else. */
export type EvmRequest = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  chainId: number;
};

/** A wallet found in this browser that a person can sign in with: an extension, or the wallet's own browser. */
export type FoundWallet = {
  /** Names it to `signIn('wallet', { wallet })`. Stable while the page is open. */
  id: string;
  /** Its own name, as the wallet announces it: "Phantom". */
  name: string;
  family: Chain;
};

/**
 * How to sign in, beyond the method. A passkey is used, or created: they are two calls, and a person
 * with none yet must be able to make one. A wallet is one of those found in the browser.
 */
export type SignInChoice = { create?: boolean; wallet?: string };

export interface WalletDriver {
  /** True only for the throwaway wallet: it alone may be handed a mock transaction. */
  readonly test: boolean;
  status: 'loading' | 'signed-out' | 'ready';
  userId: string | null;
  /** The first account of a family is the active one. */
  accounts: DriverAccount[];
  /** The outside wallets a person can sign in with here. Left out, there are none. */
  found?: FoundWallet[];
  signIn(method: 'passkey' | 'wallet', choice?: SignInChoice): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Makes the wallet of each family that a passkey sign-in owes the person and that is not there yet.
   * A driver whose wallets come with the sign-in leaves it out.
   */
  ensureWallets?(): Promise<void>;
  /** Signs each serialized transaction as it is and returns it with the signature in place. */
  signSolana(
    address: string,
    transactions: Uint8Array[],
    cluster: SolanaCluster,
  ): Promise<Uint8Array[]>;
  /** Returns the 64-byte signature. */
  signSolanaMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
  /** Signs and returns the serialized signed transaction. An external EVM wallet cannot. */
  signEvm(address: string, request: EvmRequest): Promise<`0x${string}`>;
  /** Signs and sends, and returns the transaction hash. */
  sendEvm(address: string, request: EvmRequest): Promise<`0x${string}`>;
  signEvmMessage(address: string, message: string): Promise<`0x${string}`>;
  exportKey(family: Chain, address: string): Promise<void>;
  /** The API's sign-in tokens, or null for a driver that has none. */
  tokens(): Promise<{ access: string | null; identity: string | null } | null>;
}
