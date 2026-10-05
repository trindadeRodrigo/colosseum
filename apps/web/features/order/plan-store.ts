import { BasketProposal, RiskRollUp } from '@colosseum/schemas';

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
    };
  } catch {
    return null;
  }
}
