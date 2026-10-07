import { BasketProposal, RiskRollUp } from '@colosseum/schemas';

// The plan a goal built, kept for the plan screen and the buy screen: what "Build my plan" answered,
// kept in the browser under its id, so the screens open at once and another tab finds it (the flow
// audit, finding 14). The browser is a cache, of the few newest: where it has no plan, the API is asked
// (use-plan.ts). It is one person's: it is read back only for the person who built it, and a plan that
// does not parse is not shown.

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
};

const PREFIX = 'tf-plan:';
const KEY = (id: string) => `${PREFIX}${id}`;
/** The ids of the plans kept, oldest first. */
const INDEX = 'tf-plans';
/** How many plans the browser keeps: a plan is a few kilobytes, and an old one is built again. */
export const PLANS_KEPT = 8;

export function rememberPlan(plan: StoredPlan): void {
  try {
    const store = window.localStorage;
    let ids: string[] = [];
    try {
      const read: unknown = JSON.parse(store.getItem(INDEX) ?? '[]');
      if (Array.isArray(read)) ids = read.filter((id): id is string => typeof id === 'string');
    } catch {
      // An index that does not parse is started again.
    }
    ids = [...ids.filter((id) => id !== plan.id), plan.id];
    for (const old of ids.splice(0, Math.max(0, ids.length - PLANS_KEPT)))
      store.removeItem(KEY(old));
    store.setItem(KEY(plan.id), JSON.stringify(plan));
    store.setItem(INDEX, JSON.stringify(ids));
  } catch {
    // No storage in this browser: the plan screen then asks for the plan to be built again.
  }
}

/** The plan with this id, if this person built it in this browser and it still parses. */
export function recallPlan(id: string, userId: string | null): StoredPlan | null {
  if (!userId) return null;
  let raw: string | null = null;
  try {
    // the tab's own copy first: a plan built before plans were kept in the browser
    raw = window.sessionStorage.getItem(KEY(id)) ?? window.localStorage.getItem(KEY(id));
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
    };
  } catch {
    return null;
  }
}

/**
 * A plan made from a link, read from the API by its id (`GET /v1/baskets/{id}`): what an agent proposed
 * for a person it could not sign in as. Null when the API has none by that id, does not answer, or
 * answers something that is not a plan.
 */
export async function readLinkedPlan(
  apiFetch: (path: string) => Promise<Response>,
  id: string,
): Promise<BasketProposal | null> {
  try {
    const res = await apiFetch(`/v1/baskets/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown; proposal?: unknown };
    if (body.id !== id) return null;
    const proposal = BasketProposal.safeParse(body.proposal);
    return proposal.success ? proposal.data : null;
  } catch {
    return null;
  }
}
