import { describe, expect, it } from 'vitest';
import { basketOfPlan } from '../order/readiness';
import { orderOn, PLAN_ID, recordOf, USER } from '../order/test/fixtures';
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

  it('take the number the approved order states, when it states one', () => {
    const order = { ...orderOn(), basketId: '12345' };
    const approved = recordOf('solana', {
      userId: USER,
      approved: { order, consents: [], at: '2026-10-06T00:00:00Z' },
    });
    expect(ordersOfVault(vault({ chain: 'solana', basketId: '12345' }), [approved])).toEqual([
      approved,
    ]);
  });
});
