import {
  BasketProposal,
  PlanCandidateId,
  PlanCandidateNotShown,
  PlanScorecard,
  PlanStatus,
  RiskRollUp,
} from '@colosseum/schemas';

// The plan a goal built, kept for the plan screen and the buy screen. The API has no route that reads
// a stored plan back by its id, so the plan is what "Build my plan" answered, kept in the tab under its
// id. It is one person's: it is read back only for the person who built it, and a plan that does not
// parse is not shown.

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
  /** The plan is one of the candidates of a goal (gate THREE-PLANS): which, and what it is compared on. */
  candidate?: { name: PlanCandidateId; scorecard: PlanScorecard; status?: PlanStatus };
};

/**
 * The candidates one "Build my plan" answered, kept under a key of this tab's making: the plan screen
 * shows them side by side and the person picks one. Each candidate is kept as a plan under its own id,
 * which is what a buy names.
 */
export type StoredChoice = {
  key: string;
  userId: string;
  /** The candidates' ids, in the fixed order Cover, Spread, Carry. */
  ids: string[];
  notShown: PlanCandidateNotShown[];
};

const KEY = (id: string) => `tf-plan:${id}`;
const CHOICE = (key: string) => `tf-choice:${key}`;

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
      ...(read.candidate ? candidateOf(read.candidate) : {}),
    };
  } catch {
    return null;
  }
}

/** A kept candidate's name and figures, when they still parse; nothing otherwise. */
function candidateOf(read: NonNullable<StoredPlan['candidate']>): Pick<StoredPlan, 'candidate'> {
  const name = PlanCandidateId.safeParse(read.name);
  const scorecard = PlanScorecard.safeParse(read.scorecard);
  const status = read.status === undefined ? null : PlanStatus.safeParse(read.status);
  if (!name.success || !scorecard.success || (status && !status.success)) return {};
  return {
    candidate: {
      name: name.data,
      scorecard: scorecard.data,
      ...(status?.success ? { status: status.data } : {}),
    },
  };
}

export function rememberChoice(choice: StoredChoice): void {
  try {
    window.sessionStorage.setItem(CHOICE(choice.key), JSON.stringify(choice));
  } catch {
    // No storage: the plan screen then asks for the plans to be built again.
  }
}

/**
 * The candidates kept under this key, each as its plan, if this person built them in this tab and
 * every one still parses. Null otherwise: a choice is shown whole or not at all.
 */
export function recallChoice(
  key: string,
  userId: string | null,
): { plans: StoredPlan[]; notShown: PlanCandidateNotShown[] } | null {
  if (!userId) return null;
  try {
    const raw = window.sessionStorage.getItem(CHOICE(key));
    if (!raw) return null;
    const read = JSON.parse(raw) as Partial<StoredChoice>;
    if (read.key !== key || read.userId !== userId || !Array.isArray(read.ids)) return null;
    const plans = read.ids.map((id) => recallPlan(String(id), userId));
    if (plans.length === 0 || plans.some((p) => !p?.candidate)) return null;
    const notShown = PlanCandidateNotShown.array().safeParse(read.notShown ?? []);
    return { plans: plans as StoredPlan[], notShown: notShown.success ? notShown.data : [] };
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
