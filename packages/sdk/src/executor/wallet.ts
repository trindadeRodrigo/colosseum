import type { WalletErrorCode } from '@colosseum/schemas';

// What a wallet says when it fails, read without the shared class: the built package carries no
// workspace code, so a `WalletError` is known here by its shape.

/** The codes of `WalletErrorCode` in the shared types. tables.test.ts holds the two lists together. */
export const WALLET_CODES = [
  'rejected',
  'expired',
  'no_gas',
  'wrong_chain',
  'not_connected',
  'wrong_account',
  'unsupported',
  'changed',
  'unknown',
] as const satisfies readonly WalletErrorCode[];

/** The wallet's own code for a failure, or `unknown` for anything else a signer throws. */
export function walletFailure(e: unknown): { code: WalletErrorCode; message: string } {
  const loose =
    typeof e === 'object' && e !== null ? (e as { code?: unknown; message?: unknown }) : {};
  const code = WALLET_CODES.find((c) => c === loose.code) ?? 'unknown';
  const message = typeof loose.message === 'string' && loose.message ? loose.message : code;
  return { code, message };
}
