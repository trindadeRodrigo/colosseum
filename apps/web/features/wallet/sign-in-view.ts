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
 * A wallet as the sign-in screen offers it: one entry per wallet, whatever families it signs on. A
 * wallet that announces itself to both standards (Phantom, Backpack) is one entry with two ways in;
 * its families are told apart by its name, which is all the two standards share.
 */
export type WalletChoice = {
  key: string;
  name: string;
  icon?: string;
  /** The id `signIn('wallet', { wallet })` takes, for each family it signs on. */
  ids: Partial<Record<FoundWallet['family'], string>>;
};

export function walletChoices(found: readonly FoundWallet[]): WalletChoice[] {
  const byKey = new Map<string, WalletChoice>();
  for (const wallet of found) {
    const key = wallet.name.trim().toLowerCase();
    const choice = byKey.get(key) ?? { key, name: wallet.name, ids: {} };
    choice.ids[wallet.family] ??= wallet.id;
    choice.icon ??= wallet.icon;
    byKey.set(key, choice);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a failed attempt to use a passkey means "make one instead": the passkey the device offered
 * is unknown here, or not registered. A closed prompt is not one of these: it may be a person who
 * changed their mind, so nothing is made unless they ask ("Create a new passkey", SIGN-IN-FLOW). Any
 * other failure (passkeys off, too many tries, no network) is said as it is.
 */
export function makeOneInstead(error: unknown): boolean {
  const { reason } = (typeof error === 'object' && error !== null ? error : {}) as Failure;
  return reason === 'passkey_unknown' || reason === 'passkey_not_registered';
}
