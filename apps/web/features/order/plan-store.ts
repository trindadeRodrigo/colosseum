import { BasketProposal, RiskRollUp } from '@colosseum/schemas';

// The plan a goal built, kept for the plan screen and the buy screen: what "Build my plan" answered,
// kept in the browser under its id, so the screens open at once and another tab finds it (the flow
// audit, finding 14). The browser is a cache, of the few newest, and never the last word: the API is
// asked for the plan each time (`readStoredPlan`, use-plan.ts), which answers a plan to the person who
// made it and a plan made from a link to anybody, and a plan the API says is gone, or another
// person's, is dropped from the cache and not shown. It is cleared when the person signs out. A plan
// that does not parse is not shown.

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

/** Drops one plan from the cache: the server said it is gone, or not this person's. */
export function forgetPlan(id: string): void {
  try {
    window.sessionStorage.removeItem(KEY(id));
    const store = window.localStorage;
    store.removeItem(KEY(id));
    const read: unknown = JSON.parse(store.getItem(INDEX) ?? '[]');
    if (Array.isArray(read)) store.setItem(INDEX, JSON.stringify(read.filter((x) => x !== id)));
  } catch {
    // Nothing kept, nothing to drop.
  }
}

/** Empties the cache: the person signed out, or another signed in. The plans stay on the server. */
export function forgetPlans(): void {
  try {
    for (const store of [window.localStorage, window.sessionStorage]) {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key?.startsWith(PREFIX)) keys.push(key);
      }
      for (const key of keys) store.removeItem(key);
    }
    window.localStorage.removeItem(INDEX);
  } catch {
    // As above.
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
 * a link, and is read as one. `gone` when the API says it has none by that id for this person (404,
 * or 403); null when it does not answer, or answers something that is not a plan.
 */
export async function readStoredPlan(
  apiFetch: (path: string, init?: { freshSignIn?: boolean }) => Promise<Response>,
  id: string,
  /** Ask with fresh tokens: the second try, after an answer that may have been given to nobody. */
  freshSignIn = false,
): Promise<{ proposal: BasketProposal; fromLink: boolean } | 'gone' | null> {
  try {
    const res = await apiFetch(
      `/v1/baskets/${encodeURIComponent(id)}`,
      freshSignIn ? { freshSignIn } : undefined,
    );
    // The server's word that there is no such plan for this person: a copy kept here is dropped.
    if (res.status === 404 || res.status === 403) return 'gone';
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown; proposal?: unknown; fromLink?: unknown };
    if (body.id !== id) return null;
    const proposal = BasketProposal.safeParse(body.proposal);
    return proposal.success ? { proposal: proposal.data, fromLink: body.fromLink !== false } : null;
  } catch {
    return null;
  }
}
