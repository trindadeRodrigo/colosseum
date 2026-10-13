import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '../order/order-record';
import { planOn } from '../order/test/fixtures';
import { json } from '../wallet/test/fake-port';
import { MAX_PAGES, mergeRecords, readPersonPlans, recordsOfPlans } from './server-plans';

// The server's list of a person's plans, as the portfolio reads it: tolerant of a server that has
// none, and joined with what this browser kept without losing what the person approved here.

const plan = planOn().proposal;
const listed = (over: object = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-09-30T00:00:00.000Z',
  fromLink: false,
  chain: 'solana',
  sheet: plan.sheet,
  card: plan.card,
  verdict: null,
  bought: true,
  orders: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-10-01T00:00:00.000Z',
      amountUsd: 40,
      status: 'done',
      deposited: true,
    },
  ],
  vault: { chain: 'solana', basketId: '77' },
  ...over,
});

describe('the server’s list of plans', () => {
  it('reads each plan that is one, and leaves out one that is not', async () => {
    const answer = async () =>
      json({
        plans: [
          listed(),
          { id: 'half a plan' },
          listed({ id: '22222222-2222-4222-8222-222222222222', orders: [] }),
        ],
      });
    expect((await readPersonPlans(answer)).map((p) => p.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('follows the pages the server names, to a bound, and keeps what it read when one fails', async () => {
    const asked: string[] = [];
    const paged = (pages: number) => async (path: string) => {
      asked.push(path);
      const n = asked.length;
      const id = `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
      return json({
        plans: [listed({ id })],
        next: n < pages ? `2026-10-0${n}T00:00:00.000Z` : null,
      });
    };
    expect(await readPersonPlans(paged(3))).toHaveLength(3);
    expect(asked).toEqual([
      '/v1/me/plans',
      '/v1/me/plans?before=2026-10-01T00%3A00%3A00.000Z',
      '/v1/me/plans?before=2026-10-02T00%3A00%3A00.000Z',
    ]);
    // a server that always names another page is read to the bound and no further
    asked.length = 0;
    expect(await readPersonPlans(paged(99))).toHaveLength(MAX_PAGES);
    // a second page that fails leaves the first
    asked.length = 0;
    const once = paged(2);
    const failing = async (path: string) =>
      asked.length === 1 ? json({ error: 'no' }, 500) : once(path);
    expect(await readPersonPlans(failing)).toHaveLength(1);
  });

  it('is empty for a server with no such route, a failed call, or another answer', async () => {
    for (const answer of [
      async () => json({ error: 'not found' }, 404),
      async () => json({ plans: {} }),
      async () => new Response('not json'),
      async () => {
        throw new TypeError('fetch failed');
      },
    ])
      expect(await readPersonPlans(answer)).toEqual([]);
  });

  it('makes one record a buy, with the goal, the amount and the vault’s number, and none for a plan not bought', async () => {
    const plans = await readPersonPlans(async () =>
      json({
        plans: [
          listed(),
          listed({ id: '22222222-2222-4222-8222-222222222222', orders: [], vault: null }),
        ],
      }),
    );
    expect(recordsOfPlans(plans, 'me')).toEqual([
      {
        orderId: '33333333-3333-4333-8333-333333333333',
        userId: 'me',
        proposalId: '11111111-1111-4111-8111-111111111111',
        chain: 'solana',
        amountUsd: 40,
        lines: [],
        approved: null,
        goal: {
          sheet: plan.sheet,
          card: plan.card,
          verdict: null,
          placedAt: '2026-10-01T00:00:00.000Z',
        },
        basketId: '77',
      },
    ]);
    const linked = await readPersonPlans(async () => json({ plans: [listed({ fromLink: true })] }));
    expect(recordsOfPlans(linked, 'me')[0]?.linked).toBe(true);
  });
});

describe('what this browser kept, with what the server lists', () => {
  const record = (over: Partial<OrderRecord>): OrderRecord => ({
    orderId: '33333333-3333-4333-8333-333333333333',
    userId: 'me',
    proposalId: '11111111-1111-4111-8111-111111111111',
    chain: 'solana',
    amountUsd: 40,
    lines: [],
    approved: null,
    ...over,
  });
  const goal = (placedAt: string) => ({
    sheet: plan.sheet,
    card: plan.card,
    verdict: null,
    placedAt,
  });

  it('keeps this browser’s record of an order, and adds the orders only the server has, newest first', () => {
    const kept = record({ goal: goal('2026-10-01T00:00:00Z'), amountUsd: 41 });
    const merged = mergeRecords(
      [kept],
      [
        record({ goal: goal('2026-10-01T00:00:00Z') }),
        record({
          orderId: '44444444-4444-4444-8444-444444444444',
          goal: goal('2026-10-03T00:00:00Z'),
        }),
      ],
    );
    expect(merged.map((r) => r.orderId)).toEqual([
      '44444444-4444-4444-8444-444444444444',
      '33333333-3333-4333-8333-333333333333',
    ]);
    expect(merged[1]).toBe(kept);
  });

  it('gives a record kept with no goal the server’s, and changes nothing else of it', () => {
    const kept = record({ amountUsd: 41 });
    const [merged] = mergeRecords([kept], [record({ goal: goal('2026-10-01T00:00:00Z') })]);
    expect(merged).toEqual({ ...kept, goal: goal('2026-10-01T00:00:00Z') });
  });
});
