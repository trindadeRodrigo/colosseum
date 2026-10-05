import type { Dictionary } from '../../i18n';
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
