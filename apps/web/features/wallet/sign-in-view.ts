import type { Dictionary } from '../../i18n';
import type { FoundWallet } from './driver';
import type { Failure } from './view';

// Which sentence a failed sign-in gets. A person never reads what a wallet or a provider threw: every
// failure is one of the sentences of the dictionary, and each says what to do next.

/** What was tried: a passkey being made, a passkey being used, or a wallet. */
export type SignInAttempt = 'passkey-create' | 'passkey-use' | 'wallet';

export type SignInFailure = keyof Dictionary['signIn']['failure'];

export function signInFailure(error: unknown, attempt: SignInAttempt): SignInFailure {
  const { code, reason } = (typeof error === 'object' && error !== null ? error : {}) as Failure;
  const passkey = attempt !== 'wallet';
  const cancelled = attempt === 'passkey-create' ? 'passkeyNotCreated' : 'passkeyNotUsed';
  switch (reason) {
    case 'method_off':
      return passkey ? 'passkeyOff' : 'walletOff';
    case 'passkey_cancelled':
      return passkey ? cancelled : 'walletRefused';
    case 'passkey_unknown':
      return 'passkeyUnknown';
    case 'passkey_not_registered':
      return 'passkeyNotRegistered';
    case 'accounts_full':
      return 'accountsFull';
    case 'not_invited':
      return 'notInvited';
    case 'no_storage':
      return 'noStorage';
    case 'passkey_unsupported':
      return 'passkeyUnsupported';
    case 'wallet_gone':
      return 'walletGone';
    case 'wallet_silent':
      return 'walletSilent';
    case 'too_many':
      return 'tooMany';
    case 'offline':
      return 'offline';
    case 'wallet_not_made':
      return 'walletNotMade';
    default:
  }
  if (code === 'rejected') return passkey ? cancelled : 'walletRefused';
  if (code === 'expired') return 'expired';
  if (code === 'not_connected' && !passkey) return 'walletSilent';
  return 'other';
}

/**
 * A wallet as the sign-in screen offers it: one entry per wallet, whatever families it signs on. Only
 * the wallets known to sign on both (`BOTH_FAMILIES`) are one entry with two ways in, joined by their
 * EIP-6963 id (rdns) and their wallet-standard name. Anything else is an entry of its own, by its id:
 * a name is the announcer's to choose, so an EVM wallet that calls itself "Phantom" is not Phantom, is
 * not joined to it and does not take its icon. An entry's icon is its own, never another's.
 */
export type WalletChoice = {
  key: string;
  name: string;
  icon?: string;
  /** The id `signIn('wallet', { wallet })` takes, for each family it signs on. */
  ids: Partial<Record<FoundWallet['family'], string>>;
};

/**
 * The wallets that sign on both families, as each standard names them: the EVM side by its rdns
 * (`evm:<rdns>`), the Solana side by its wallet-standard name (`solana:<name>`).
 */
export const BOTH_FAMILIES: ReadonlyArray<{ key: string; solana: string; evm: string }> = [
  { key: 'phantom', solana: 'solana:Phantom', evm: 'evm:app.phantom' },
  { key: 'backpack', solana: 'solana:Backpack', evm: 'evm:app.backpack' },
  // The throwaway wallet of development signs on both too (test/test-driver.ts); its ids are its own.
  { key: 'throwaway', solana: 'test:solana', evm: 'test:evm' },
];

export function walletChoices(found: readonly FoundWallet[]): WalletChoice[] {
  const byKey = new Map<string, WalletChoice>();
  for (const wallet of found) {
    const pair = BOTH_FAMILIES.find((p) => p[wallet.family] === wallet.id);
    const key = pair ? pair.key : wallet.id;
    const choice = byKey.get(key) ?? { key, name: wallet.name, ids: {} };
    if (choice.ids[wallet.family]) continue;
    choice.ids[wallet.family] = wallet.id;
    // Both sides of a known pair are the same wallet: the first icon found is its own.
    choice.icon ??= wallet.icon;
    byKey.set(key, choice);
  }
  return [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
  );
}

/**
 * Whether "Create a new passkey" is offered after a failed attempt with a passkey. A passkey is never
 * made because using one failed (SIGN-IN-FLOW): Privy 3.46 reports every WebAuthn refusal (a closed
 * prompt, a timeout, no passkey on this device, an abandoned "use a phone") as one error, so the screen
 * cannot tell "none here" from "changed my mind". It offers the button instead, and only its press
 * makes one, in a gesture of its own. Not offered where making one cannot work either: passkeys are
 * off for the app, or the browser has none.
 */
export function offersNewPasskey(failure: SignInFailure): boolean {
  return failure !== 'passkeyOff' && failure !== 'passkeyUnsupported';
}
