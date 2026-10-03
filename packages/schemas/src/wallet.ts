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

export const WalletErrorCode = z.enum([
  /** The person said no. Not a failure to show. */
  'rejected',
  /** The blockhash, the nonce or the sign-in went stale before the wallet signed. */
  'expired',
  'no_gas',
  /** The transaction is for another chain or another network than the wallet is on. */
  'wrong_chain',
  /** Nobody is signed in, or no wallet of that family is connected. */
  'not_connected',
  /** The transaction is for another account than the active one, or the signature is not this account's. */
  'wrong_account',
  /** The wallet cannot do what was asked: sign without sending, sign that many at once, export a key. */
  'unsupported',
  /**
   * The wallet handed back something other than the transaction it was given, signed: another
   * message, another call, another count or order. Nothing is returned as signed.
   */
  'changed',
  'unknown',
]);
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
  /**
   * Signs and hands the signed transactions back; nothing is sent. Solana with any wallet; EVM with
   * the embedded wallet (`caps(chain).signOnly`). The answer has the same length and the same order
   * as `txs`, and each entry is what `ReportLegRequest.signedTx` carries:
   * - Solana: base64 of the whole serialized transaction, signatures and message, as `payload` is,
   *   with this account's signature in its slot.
   * - EVM: the 0x-prefixed serialized signed transaction, as `eth_sendRawTransaction` takes it. The
   *   wallet set its nonce, gas and fee.
   * Throws `changed` when the wallet hands back anything but what it was given, signed.
   */
  sign(chain: ChainId, txs: BasketTx[]): Promise<string[]>;
  /**
   * For an outside EVM wallet, which cannot sign without sending (`caps(chain).signOnly` is false):
   * the wallet signs and broadcasts, and the answer is the transaction's hash, reported as
   * `ReportLegRequest.txId`. Not for Solana and not for the embedded wallet: both throw `unsupported`.
   */
  send(chain: ChainId, tx: BasketTx): Promise<{ txId: string }>;
  exportKey(family: Chain): Promise<void>;
  authHeaders(): Promise<Record<string, string>>;
}
