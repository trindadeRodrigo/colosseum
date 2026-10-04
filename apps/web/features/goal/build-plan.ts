import { BasketProposal, type BasketSheet } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';

// "Build my plan": one call, with the shapes of DESIGN-VAULT section 3.6. The route is not in the API
// yet (it comes with the engine, in the next API slot), so this is written to the shape it needs and
// tested against a double:
//
//   POST /v1/baskets/personalize
//   body    { sheet: BasketSheet }
//   200     { id: string, proposal: BasketProposal }   the stored plan's id, and the plan
//   401/403 the server does not know who is asking, or does not let them: sign in again
//   409     the server has no chain for this person yet: the chain is chosen first
//   429     it asked for fewer requests
//   4xx     { error, code? }   the server refused the sheet; with code 'GOAL_NOT_ACHIEVABLE' (the
//                              order codes of 3.3) the sheet is fine and no plan fits it
//
// Until the route exists the API answers 404, and the screen says so: nothing is shown in its place.
// The argument is a `BasketSheet`, the type a validator returns, so a draft that did not validate
// cannot be sent.

export const PERSONALIZE_PATH = '/v1/baskets/personalize';

export type BuildOutcome =
  | { kind: 'built'; id: string; proposal: BasketProposal }
  /** The route is not there: the API has nothing that builds a plan yet. */
  | { kind: 'unavailable' }
  /** The server does not know this sign-in any more (401), or does not let it build (403). */
  | { kind: 'signed-out' }
  /** The server has no chain for this person yet (409): it is chosen before a plan is built. */
  | { kind: 'no-chain' }
  /** The server is the final gate and refused the sheet. */
  | { kind: 'refused' }
  /** A valid sheet, and no plan fits it. */
  | { kind: 'no-plan' }
  | { kind: 'busy' }
  | { kind: 'unreachable' }
  /** An answer that is not a plan in the frozen shape. It is not shown. */
  | { kind: 'unreadable' };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * How a built plan is labelled. Live only when every figure it stands on is live. A plan that names
 * no figure says nothing about being live, so it is not drawn as live. `sandbox` when what is not
 * live comes from a test network and nothing from a mock: the plate, and the words "test network".
 */
export function planProvenance(proposal: BasketProposal): 'live' | 'sandbox' | 'mock' {
  const labels = proposal.observations.map((o) => o.provenance);
  if (labels.length === 0) return 'mock';
  if (labels.every((label) => label === 'live')) return 'live';
  return labels.every((label) => label === 'live' || label === 'sandbox') ? 'sandbox' : 'mock';
}

/** The plan is the plan of the sheet that was sent: the same goal, amount and chain. */
const answers = (asked: BasketSheet, got: BasketSheet) =>
  got.goal === asked.goal &&
  got.amountUsd === asked.amountUsd &&
  got.chains.length === asked.chains.length &&
  got.chains.every((chain, i) => chain === asked.chains[i]);

export async function buildPlan(apiFetch: ApiFetch, sheet: BasketSheet): Promise<BuildOutcome> {
  let res: Response;
  try {
    res = await apiFetch(PERSONALIZE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheet }),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501)
    return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'busy' };
  const body: unknown = await res.json().catch(() => null);
  const answer = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  // What the server says in a refusal is written for a developer: the screen has its own sentence,
  // and a different one for each thing the person can do about it.
  if (res.status >= 400 && res.status < 500) {
    if (answer.code === 'GOAL_NOT_ACHIEVABLE') return { kind: 'no-plan' };
    if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
    if (res.status === 409) return { kind: 'no-chain' };
    return { kind: 'refused' };
  }
  if (!res.ok) return { kind: 'unreachable' };
  const proposal = BasketProposal.safeParse(answer.proposal);
  const id = text(answer.id);
  if (!proposal.success || !id) return { kind: 'unreadable' };
  // A plan for another goal, amount or chain is not the answer to what was asked: it is not shown.
  if (!answers(sheet, proposal.data.sheet)) return { kind: 'unreadable' };
  return { kind: 'built', id, proposal: proposal.data };
}
