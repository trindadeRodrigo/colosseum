import { z } from 'zod';
import type { BasketTx } from './basket-tx';
import { Address, type ChainId, isAddressOf } from './chain';
import { Chain } from './enums';

// DESIGN-VAULT 3.5. No Privy types here: the web app implements WalletPort over whatever provider it uses.

export const WalletAccountBase = z.object({
  family: Chain,
  address: Address,
  kind: z.enum(['embedded', 'external']),
});

/** The address is in its family's form: run normalizeAddress() on what a wallet provider returns. */
export const WalletAccount = WalletAccountBase.refine((w) => isAddressOf(w.family, w.address), {
  message: "the address is in the form of the wallet's family",
  path: ['address'],
});
export type WalletAccount = z.infer<typeof WalletAccount>;

export const WalletCaps = z.object({
  /** Signs with no prompt (a passkey wallet). */
  silent: z.boolean(),
  /** How many transactions one prompt can sign. */
  batchSign: z.number().int().min(1),
  /** The wallet signs and hands the bytes back; false means it sends them itself. */
  signOnly: z.boolean(),
});
export type WalletCaps = z.infer<typeof WalletCaps>;

export const WalletErrorCode = z.enum(['rejected', 'expired', 'no_gas', 'wrong_chain', 'unknown']);
export type WalletErrorCode = z.infer<typeof WalletErrorCode>;

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** Every method that fails throws a WalletError. */
export interface WalletPort {
  status: 'loading' | 'signed-out' | 'ready';
  userId: string | null;
  accounts: WalletAccount[];
  active(family: Chain): WalletAccount | null;
  caps(chain: ChainId): WalletCaps;
  signIn(method: 'passkey' | 'wallet'): Promise<void>;
  signOut(): Promise<void>;
  /** Solana with any wallet; EVM with the embedded wallet. */
  sign(chain: ChainId, txs: BasketTx[]): Promise<string[]>;
  /** EVM with an external wallet. */
  send(chain: ChainId, tx: BasketTx): Promise<{ txId: string }>;
  exportKey(family: Chain): Promise<void>;
  authHeaders(): Promise<Record<string, string>>;
}
