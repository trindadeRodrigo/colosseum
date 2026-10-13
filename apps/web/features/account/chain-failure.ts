import type { Dictionary } from '../../i18n';
import { PersonError } from './person';

// Why a choice of chain was not stored, as the sentence /goal's chain choice says for it.

/** Why a switch to `name` was not stored, as a sentence. */
export function switchFailure(t: Dictionary, e: unknown, name: string): string {
  const kind = e instanceof PersonError ? e.kind : 'unreachable';
  if (kind === 'no_wallet') return t.chain.failure.noWallet(name);
  if (kind === 'not_offered') return t.chain.failure.notOffered;
  if (kind === 'signed_out') return t.chain.failure.signedOut;
  if (kind === 'no_identity') return t.chain.failure.noIdentity;
  if (kind === 'busy') return t.shell.slowDown;
  return t.chain.failure.unreachable;
}
