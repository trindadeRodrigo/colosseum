import { describe, expect, it } from 'vitest';
import { basketOfPlan } from '../order/readiness';
import { PLAN_ID, recordOf, USER } from '../order/test/fixtures';
import { vault } from './test/portfolio';
import { ordersOfVault } from './vault-goal';

// A vault is joined to the orders of its plan by the plan's number on chain. A plan made from a link
// numbers each buyer's vault from the plan and the person (gate AGENT-LINK), so the join does too.

describe('the orders of a vault', () => {
  it('are joined by the plan’s number, the buyer’s own for a plan made from a link', () => {
    const app = recordOf('solana', { userId: USER });
    const linked = recordOf('solana', { userId: USER, linked: true });
    const mine = vault({ chain: 'solana', basketId: basketOfPlan(PLAN_ID, USER) });
    expect(ordersOfVault(mine, [app, linked])).toEqual([linked]);
    const theirs = vault({ chain: 'solana', basketId: basketOfPlan(PLAN_ID) });
    expect(ordersOfVault(theirs, [app, linked])).toEqual([app]);
  });
});
