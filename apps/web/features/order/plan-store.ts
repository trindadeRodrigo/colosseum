import { BasketProposal, RiskRollUp } from '@colosseum/schemas';

// The plan a goal built, kept for the plan screen and the buy screen: what "Build my plan" answered,
// kept in the tab under its id, so the screens open at once. The tab is a cache. A tab that did not
// build the plan (a new one, another device, a sign-in again) reads it from the API, which answers a
// plan to the person who made it and a plan made from a link to anybody (`readStoredPlan`). It is one
// person's: it is read back only for the person who built it, and a plan that does not parse is not
// shown.

export type StoredPlan = {
  /** The stored plan's id, which a buy names (`proposalId`). */
  id: string;
  /** Who built it. */
  userId: string;
  proposal: BasketProposal;
  /** The risk roll-up, when the API sent one with the plan. Never worked out here. */
  rollUp: RiskRollUp | null;
  /**
   * The plan was made from a link (`POST /v1/baskets/propose`, an agent's), not built in this tab:
   * read back from the API by its id, and said so on the plan screen.
   */
  fromLink?: boolean;
  /**
   * Read back from the API in a tab that did not build it. The API keeps the plan and not its risk
   * roll-up, so there is none, and the plan screen says so.
   */
  readBack?: boolean;
};

const KEY = (id: string) => `tf-plan:${id}`;

export function rememberPlan(plan: StoredPlan): void {
  try {
    window.sessionStorage.setItem(KEY(plan.id), JSON.stringify(plan));
  } catch {
    // No storage in this browser: the plan screen then asks for the plan to be built again.
  }
}

/** The plan with this id, if this person built it in this tab and it still parses. */
export function recallPlan(id: string, userId: string | null): StoredPlan | null {
  if (!userId) return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY(id));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const read = JSON.parse(raw) as Partial<StoredPlan>;
    if (read.id !== id || read.userId !== userId) return null;
    const proposal = BasketProposal.safeParse(read.proposal);
    if (!proposal.success) return null;
    const rollUp = read.rollUp == null ? null : RiskRollUp.safeParse(read.rollUp);
    return {
      id,
      userId,
      proposal: proposal.data,
      rollUp: rollUp?.success ? rollUp.data : null,
      ...(read.fromLink === true ? { fromLink: true } : {}),
      ...(read.readBack === true ? { readBack: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A stored plan read from the API by its id (`GET /v1/baskets/{id}`): the signed-in person's own, or
 * one made from a link (what an agent proposed for a person it could not sign in as), which the
 * answer says (`fromLink`). An answer that does not say is from a server that served only plans from
 * a link, and is read as one. Null when the API has none by that id for this person, does not answer,
 * or answers something that is not a plan.
 */
export async function readStoredPlan(
  apiFetch: (path: string, init?: { freshSignIn?: boolean }) => Promise<Response>,
  id: string,
  /** Ask with fresh tokens: the second try, after an answer that may have been given to nobody. */
  freshSignIn = false,
): Promise<{ proposal: BasketProposal; fromLink: boolean } | null> {
  try {
    const res = await apiFetch(
      `/v1/baskets/${encodeURIComponent(id)}`,
      freshSignIn ? { freshSignIn } : undefined,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown; proposal?: unknown; fromLink?: unknown };
    if (body.id !== id) return null;
    const proposal = BasketProposal.safeParse(body.proposal);
    return proposal.success ? { proposal: proposal.data, fromLink: body.fromLink !== false } : null;
  } catch {
    return null;
  }
}
