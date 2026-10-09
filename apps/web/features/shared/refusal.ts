import type { Dictionary } from '../../i18n';
import { displayName } from '../order/plain';
import type { Placed } from './shared-api';

// What a shared portfolio's screens say when our server refuses a buy of it or a follow, from the one
// place: the buy page, the portfolio's own page and the invest card. Our server always sends a
// sentence of its own with the code, in English and written for a plan; where the code is one this
// app knows, the screen says it in its own words, in the page's language, and for a portfolio.

export type SharedRefusal = {
  sentence: string;
  /** The portfolio is no longer what the page showed: it is read again, and the person is led to it. */
  changed: boolean;
};

/** The asset our server names at the start of "<asset> cannot be bought on <chain>", or none. */
const namedAsset = (error: string): string | null =>
  /^([a-z0-9-]+:[A-Za-z0-9._-]+) cannot be bought\b/.exec(error)?.[1] ?? null;

/**
 * The refusal in this app's words, or null where it has none and the server's sentence stands (a
 * creator's limit, a name taken). Only a refusal with a code is read here.
 */
export function sharedRefusal(
  placed: Extract<Placed, { kind: 'said' | 'code' }>,
  t: Dictionary,
): SharedRefusal | null {
  const code = placed.code;
  if (!code) return null;
  const words = t.shared.refusal;
  if (code === 'VERSION_CHANGED') return { sentence: words.versionChanged, changed: true };
  if (code === 'ASSET_NOT_ELIGIBLE') {
    const asset = placed.kind === 'said' ? namedAsset(placed.error) : null;
    return {
      sentence: asset ? words.assetNamed(displayName(asset, t.plan)) : words.asset,
      changed: false,
    };
  }
  // The rest are said the same for any buy: the wallet is short, the order ran out, the chain is off.
  const same = t.buy.failure[code as keyof typeof t.buy.failure];
  return typeof same === 'string' ? { sentence: same, changed: false } : null;
}
