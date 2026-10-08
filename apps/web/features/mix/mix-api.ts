import {
  type AcceptGoalMixRequest,
  AcceptGoalMixResponse,
  type ApplyVaultMixRequest,
  ApplyVaultMixResponse,
  type ChainId,
  chainFamily,
  type MixReview,
} from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';

// The two calls that make a mix something to buy or apply (gate ANY-COMPOSITION, #191): a new goal's
// mix becomes a plan (`POST /v1/conversations/{chain}/goal/accept`), and a vault's new targets become
// an order (`POST /v1/vaults/{chain}/{address}/targets`). Each is asked first with `confirm: false`,
// which answers the server's review and stores nothing; the confirm sends back the review's hash and
// the warnings the person ticked. Every figure on the screen comes from that review, never from here.

/** Why a call made nothing: what the screen says, and what the person can do about it. */
export type MixFailure =
  /** 422 `MIX_NOT_VALID`: the server's reasons, `CODE` or `CODE:assetId`. */
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'signed-out' }
  /** 403: no wallet for this chain in the sign-in. */
  | { kind: 'no-wallet' }
  /** 404: not a vault of this person's. */
  | { kind: 'not-yours' }
  /** 503: the chain only reads for now. */
  | { kind: 'read-only' }
  | { kind: 'busy' }
  /** The answer to a review did not read, or did not match what was asked. Nothing was stored. */
  | { kind: 'unreadable' }
  /**
   * The server took a confirm and its answer did not read or match: the plan or the order may be
   * stored by now, so the screen does not say that nothing was.
   */
  | { kind: 'unchecked' }
  | { kind: 'unreachable' }
  /** Any other refusal, in the server's words. */
  | { kind: 'said'; error: string };

export type MixCall<T> = { kind: 'ok'; value: T } | MixFailure;

async function post<T>(
  api: ApiFetch,
  path: string,
  body: { confirm: boolean },
  parse: (value: unknown) => T | null,
): Promise<MixCall<T>> {
  let res: Response;
  try {
    res = await api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  let answer: Record<string, unknown> = {};
  try {
    const read: unknown = await res.json();
    if (read && typeof read === 'object' && !Array.isArray(read))
      answer = read as Record<string, unknown>;
  } catch {
    if (res.ok) return { kind: body.confirm ? 'unchecked' : 'unreadable' };
  }
  if (!res.ok) {
    if (res.status === 429 || answer.code === 'RATE_LIMITED') return { kind: 'busy' };
    if (res.status === 401) return { kind: 'signed-out' };
    if (res.status === 403) return { kind: 'no-wallet' };
    if (res.status === 404) return { kind: 'not-yours' };
    if (res.status === 503) return { kind: 'read-only' };
    if (res.status === 422 && answer.code === 'MIX_NOT_VALID') {
      const details = (answer.details ?? {}) as { issues?: unknown };
      const issues = Array.isArray(details.issues)
        ? details.issues.filter((issue): issue is string => typeof issue === 'string')
        : [];
      return { kind: 'invalid', issues };
    }
    if (res.status >= 500) return { kind: 'unreachable' };
    return typeof answer.error === 'string'
      ? { kind: 'said', error: answer.error }
      : { kind: 'unreadable' };
  }
  const value = parse(answer);
  if (value === null) return { kind: body.confirm ? 'unchecked' : 'unreadable' };
  return { kind: 'ok', value };
}

/**
 * A review is for the chain asked about, its lines are the ones sent, in weight, and its targets and
 * cash are those same lines: the targets are what the guard holds a vault's first step to.
 */
function matches(
  review: MixReview,
  chain: ChainId,
  sent: readonly { assetId: string; weightBps: number }[],
) {
  if (review.chain !== chain) return false;
  const weights = new Map(sent.map((line) => [line.assetId, line.weightBps]));
  if (
    review.lines.length !== weights.size ||
    !review.lines.some((line) => line.cls !== 'cash') ||
    review.lines.some((line) => weights.get(line.assetId) !== line.weightBps)
  )
    return false;
  const held = review.lines.filter((line) => line.cls !== 'cash');
  const targets = new Map(review.targets.map((target) => [target.asset, target.weightBps]));
  return (
    targets.size === review.targets.length &&
    targets.size === held.length &&
    held.every((line) => targets.get(line.assetId) === line.weightBps) &&
    review.cashBps === 10_000 - held.reduce((sum, line) => sum + line.weightBps, 0)
  );
}

export function acceptGoalMix(
  api: ApiFetch,
  chain: ChainId,
  body: AcceptGoalMixRequest,
): Promise<MixCall<AcceptGoalMixResponse>> {
  return post(api, `/v1/conversations/${encodeURIComponent(chain)}/goal/accept`, body, (value) => {
    const read = AcceptGoalMixResponse.safeParse(value);
    return read.success && matches(read.data.review, chain, body.allocations) ? read.data : null;
  });
}

export function applyVaultMix(
  api: ApiFetch,
  chain: ChainId,
  address: string,
  owner: string,
  body: ApplyVaultMixRequest,
): Promise<MixCall<ApplyVaultMixResponse>> {
  const family = chainFamily(chain);
  return post(
    api,
    `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/targets`,
    body,
    (value) => {
      const read = ApplyVaultMixResponse.safeParse(value);
      if (!read.success || !matches(read.data.review, chain, body.allocations)) return null;
      if (read.data.status === 'ordered') {
        const { order } = read.data;
        // The order is this person's, on this chain, and starts by setting the targets.
        if (
          order.type !== 'rebalance' ||
          order.owner[family] !== owner ||
          order.legs.some((leg) => leg.chain !== chain) ||
          order.legs[0]?.kind !== 'set_targets'
        )
          return null;
      }
      return read.data;
    },
  );
}
