import { WalletError, type WalletErrorCode } from '@colosseum/schemas';

/**
 * Why a call failed, where the five codes of WalletError cannot say it. `code` stays one of the five,
 * so a caller that reads only `code` still gets a value it knows.
 */
export type WalletReason =
  | 'not_configured'
  | 'not_connected'
  | 'unsupported'
  | 'wrong_account'
  | 'bad_transaction'
  | 'changed';

/**
 * The reasons that are a WalletErrorCode of their own. None is yet: `not_connected`, `wrong_account`,
 * `unsupported` and `changed` go in this list in the change that adds them to packages/schemas, and
 * from then on each is carried as `code` too.
 */
const CODES_OF_THEIR_OWN: readonly string[] = [];

export class WalletPortError extends WalletError {
  readonly reason: WalletReason | null;
  constructor(code: WalletErrorCode, message: string, reason: WalletReason | null = null) {
    super(code, message);
    this.reason = reason;
  }
}

export const fail = (reason: WalletReason, message: string) =>
  new WalletPortError(
    CODES_OF_THEIR_OWN.includes(reason) ? (reason as WalletErrorCode) : 'unknown',
    message,
    reason,
  );

type Loose = {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  privyErrorCode?: unknown;
  cause?: unknown;
};

/** The same failure as a wallet, a provider and a browser each report it. */
function classify(e: Loose, text: string): [WalletErrorCode, WalletReason | null] | null {
  const privy = typeof e.privyErrorCode === 'string' ? e.privyErrorCode : '';
  // EIP-1193 4001; a wallet-standard wallet says it in words; a dismissed passkey prompt is
  // NotAllowedError; Privy reports a closed modal as an exited flow.
  if (
    e.code === 4001 ||
    e.code === 'ACTION_REJECTED' ||
    e.name === 'NotAllowedError' ||
    e.name === 'UserRejectedRequestError' ||
    /^exited_|user_exited|oauth_user_denied/.test(privy) ||
    /user (rejected|denied|cancel+ed|closed|exited)|reject(ed)? (the|by) (request|user)|request rejected|declined/i.test(
      text,
    )
  )
    return ['rejected', null];
  // 4902: the wallet does not know the chain. 4901: it is not connected to it.
  if (
    e.code === 4902 ||
    e.code === 4901 ||
    privy === 'unsupported_chain_id' ||
    /chain.{0,40}(mismatch|not (supported|configured|match)|unsupported|unrecognized)|unsupported chain|wrong (chain|network)/i.test(
      text,
    )
  )
    return ['wrong_chain', null];
  if (
    privy === 'insufficient_balance' ||
    /insufficient (funds|balance|lamports)|not enough (funds|sol|eth)|gas required exceeds/i.test(
      text,
    )
  )
    return ['no_gas', null];
  if (
    privy === 'missing_or_invalid_token' ||
    /blockhash not found|block height exceeded|has expired|session expired|nonce too low/i.test(
      text,
    )
  )
    return ['expired', null];
  if (e.code === 4900 || privy === 'must_be_authenticated' || /disconnected/i.test(text))
    return ['unknown', 'not_connected'];
  if (
    e.code === 4200 ||
    privy === 'not_supported' ||
    privy === 'unsupported_wallet_type' ||
    /not (supported|implemented)|does not support/i.test(text)
  )
    return ['unknown', 'unsupported'];
  return null;
}

/** Anything a wallet, a provider or the browser throws, as the WalletError the port promises. */
export function toWalletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const at = (v: unknown): Loose => (typeof v === 'object' && v !== null ? (v as Loose) : {});
  const message = (v: Loose) => (typeof v.message === 'string' ? v.message : '');
  const top = typeof e === 'string' ? { message: e } : at(e);
  const text = message(top) || 'the wallet failed without saying why';
  // A provider often wraps the wallet's own error: the cause is read when the wrapper says nothing.
  const found = classify(top, text) ?? classify(at(top.cause), message(at(top.cause)));
  const [code, reason] = found ?? ['unknown', null];
  return new WalletPortError(code, text, reason);
}
