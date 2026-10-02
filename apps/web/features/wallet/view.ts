import type { Chain, WalletAccount, WalletError } from '@colosseum/schemas';
import type { WalletReason } from './errors';

// What the sign-in control shows, as plain functions so they are tested without a browser.

export const FAMILY_NAME: Record<Chain, string> = { solana: 'Solana', evm: 'EVM' };

/** `7xKX…gAsU`, `0x12ab…cdef`: enough to recognise an address, never enough to copy one. */
export function shortAddress(address: string): string {
  const head = address.startsWith('0x') ? 6 : 4;
  return address.length <= head + 5 ? address : `${address.slice(0, head)}…${address.slice(-4)}`;
}

/** One line per family, the active account of each: `Solana 7xKX…gAsU`. */
export function accountLines(
  accounts: WalletAccount[],
): Array<{ family: Chain; label: string; address: string }> {
  return (['solana', 'evm'] as const).flatMap((family) => {
    const account = accounts.find((a) => a.family === family);
    return account
      ? [
          {
            family,
            label: `${FAMILY_NAME[family]} ${shortAddress(account.address)}`,
            address: account.address,
          },
        ]
      : [];
  });
}

/** What a failed call of the port carries: a WalletError, read by shape so this file imports no code. */
export type Failure = {
  code?: WalletError['code'];
  reason?: WalletReason | null;
  message?: string;
};

/** A sentence for a failed call. A refusal by the person is not an error and says nothing. */
export function failureSentence(e: unknown): string | null {
  const { code, reason, message } = (typeof e === 'object' && e !== null ? e : {}) as Failure;
  const detail = message || 'no reason given';
  if (code === 'rejected') return null;
  if (reason === 'not_configured') return `Sign-in is off here: ${detail}.`;
  if (code === 'wrong_chain') return `The wallet is on another network: ${detail}.`;
  if (code === 'no_gas') return 'This account has no funds for the network fee.';
  if (code === 'expired') return 'That took too long and expired. Try again.';
  return `That did not work: ${detail}.`;
}
