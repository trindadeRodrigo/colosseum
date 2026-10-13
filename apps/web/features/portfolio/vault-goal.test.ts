import { describe, expect, it } from 'vitest';
import { basketOfPlan } from '../order/readiness';
import { orderOn, PLAN_ID, recordOf, USER } from '../order/test/fixtures';
import type { ServerWithdrawal } from './server-withdrawals';
import { SECOND_VAULT, VAULT, vault } from './test/portfolio';
import { goalOfVault, ordersOfVault, takenOut } from './vault-goal';

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

describe('the goal of a vault, and the day its date counts from', () => {
  const goalAt = (placedAt: string) => ({
    sheet: {} as never,
    card: {} as never,
    verdict: null,
    placedAt,
  });
  const mine = vault({ chain: 'solana', basketId: basketOfPlan(PLAN_ID) });
  // looked at on the 1st and left unsigned (the invest card makes an order to show its prices),
  // bought on the 5th, and more added on the 9th
  const looked = recordOf('solana', {
    orderId: '00000000-0000-4000-8000-0000000000d1',
    goal: goalAt('2026-10-01T00:00:00.000Z'),
  });
  const bought = recordOf('solana', {
    orderId: '00000000-0000-4000-8000-0000000000d5',
    goal: goalAt('2026-10-05T00:00:00.000Z'),
  });
  const added = recordOf('solana', {
    orderId: '00000000-0000-4000-8000-0000000000d9',
    goal: goalAt('2026-10-09T00:00:00.000Z'),
  });

  it('counts from the first buy that deposited, never from an order nobody signed', () => {
    const deposited = new Set([bought.orderId, added.orderId]);
    expect(goalOfVault(mine, [added, bought, looked], deposited)?.record).toBe(bought);
  });

  it('counts from the first order of the vault while none is known to have deposited', () => {
    expect(goalOfVault(mine, [added, bought, looked], new Set())?.record).toBe(looked);
    expect(goalOfVault(mine, [added, bought, looked])?.record).toBe(looked);
  });
});

// What was taken out of a vault is the server's list of withdrawals, joined by the vault's address:
// only steps confirmed on chain count, each at the value the server gave it when it was ordered.

const valued = (usd: string, over: object = {}) => ({
  usd,
  source: 'Pyth Hermes',
  method: 'the amount at the reference price when the withdrawal was ordered',
  fetchedAt: '2026-10-06T10:00:00.000Z',
  provenance: 'sandbox' as const,
  ...over,
});
const step = (
  status: ServerWithdrawal['steps'][number]['status'],
  withdrawals: ServerWithdrawal['steps'][number]['withdrawals'],
  n = 1,
): ServerWithdrawal['steps'][number] => ({
  legId: `00000000-0000-4000-8000-00000000000${n}`,
  status,
  txId: status === 'confirmed' ? `tx${n}` : null,
  explorerUrl: null,
  at: '2026-10-06T10:05:00.000Z',
  provenance: 'sandbox',
  withdrawals,
});
const withdrawal = (
  steps: ServerWithdrawal['steps'],
  over: Partial<ServerWithdrawal> = {},
): ServerWithdrawal => ({
  orderId: '00000000-0000-4000-8000-0000000000aa',
  createdAt: '2026-10-06T10:00:00.000Z',
  chain: 'solana',
  vault: VAULT,
  status: 'done',
  steps,
  ...over,
});
const method = (n: number) => `sum of ${n}`;

describe('what was taken out of a vault', () => {
  const cash = { asset: 'solana:usdc', amountRaw: '250000000', heldRaw: '600000000' };
  const token = { asset: 'solana:usdy', amountRaw: null, heldRaw: '100000000' };

  it('adds the confirmed steps exactly, with the oldest price’s time and every source', () => {
    const taken = takenOut(
      vault(),
      [
        withdrawal([
          step('confirmed', [{ ...cash, valued: valued('250.10') }], 1),
          step(
            'confirmed',
            [
              {
                ...token,
                valued: valued('110.25', {
                  source: 'Jupiter',
                  fetchedAt: '2026-10-05T09:00:00.000Z',
                }),
              },
            ],
            2,
          ),
        ]),
        withdrawal([step('confirmed', [{ ...cash, valued: valued('0.20') }], 3)]),
      ],
      method,
    );
    expect(taken).toEqual({
      usd: '360.55',
      obs: {
        source: 'Pyth Hermes + Jupiter',
        fetchedAt: '2026-10-05T09:00:00.000Z',
        method: 'sum of 3',
        provenance: 'sandbox',
      },
      unvalued: 0,
    });
  });

  it('counts nothing that did not land, was skipped, or left another vault or chain', () => {
    const one = [{ ...cash, valued: valued('250.00') }];
    for (const status of ['planned', 'built', 'sent', 'failed', 'skipped', 'expired'] as const)
      expect(takenOut(vault(), [withdrawal([step(status, one)])], method), status).toBeNull();
    expect(
      takenOut(vault(), [withdrawal([step('confirmed', one)], { vault: SECOND_VAULT })], method),
    ).toBeNull();
    expect(
      takenOut(vault(), [withdrawal([step('confirmed', one)], { chain: 'robinhood' })], method),
    ).toBeNull();
    expect(takenOut(vault(), [], method)).toBeNull();
  });

  it('never makes up a figure for a token that had no price: it is counted apart, and alone it gives no sum', () => {
    expect(takenOut(vault(), [withdrawal([step('confirmed', [token])])], method)).toEqual({
      usd: null,
      obs: null,
      unvalued: 1,
    });
    const mixed = takenOut(
      vault(),
      [withdrawal([step('confirmed', [token, { ...cash, valued: valued('250.00') }])])],
      method,
    );
    expect([mixed?.usd, mixed?.unvalued, mixed?.obs?.method]).toEqual(['250', 1, 'sum of 1']);
  });

  it('is never said as live when the vault or a price is not', () => {
    const live = valued('5.00', { provenance: 'live' });
    const taken = takenOut(
      vault({ provenance: 'live' }),
      [
        withdrawal([
          step('confirmed', [
            { ...cash, valued: live },
            { ...token, valued: valued('1.00', { provenance: 'mock' }) },
          ]),
        ]),
      ],
      method,
    );
    expect(taken?.obs?.provenance).toBe('mock');
  });
});
