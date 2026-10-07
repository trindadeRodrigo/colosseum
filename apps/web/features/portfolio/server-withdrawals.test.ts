import { describe, expect, it } from 'vitest';
import { MAX_PAGES, readPersonWithdrawals } from './server-withdrawals';

// The server's list of withdrawals is read page after page, as the plans are, and whatever fails or
// does not read leaves what was read standing.

const one = (n: number) => ({
  orderId: `00000000-0000-4000-8000-00000000000${n}`,
  createdAt: `2026-10-0${n}T10:00:00.000Z`,
  chain: 'solana',
  vault: 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw',
  status: 'done',
  steps: [],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the person’s withdrawals, from the server', () => {
  it('follows `next` to the last page, and leaves out one that does not read', async () => {
    const asked: string[] = [];
    const read = await readPersonWithdrawals(async (path) => {
      asked.push(path);
      return path.includes('before=')
        ? json({ withdrawals: [one(1), { orderId: 'no' }], next: null })
        : json({ withdrawals: [one(2)], next: '2026-10-02T10:00:00.000Z' });
    });
    expect(asked).toEqual([
      '/v1/me/withdrawals',
      '/v1/me/withdrawals?before=2026-10-02T10%3A00%3A00.000Z',
    ]);
    expect(read.map((w) => w.createdAt.slice(8, 10))).toEqual(['02', '01']);
  });

  it('stops at its bound, and at a page that names itself again', async () => {
    let calls = 0;
    await readPersonWithdrawals(async () => {
      calls += 1;
      return json({ withdrawals: [], next: `2026-10-0${calls}T00:00:00.000Z` });
    });
    expect(calls).toBe(MAX_PAGES);
    calls = 0;
    await readPersonWithdrawals(async () => {
      calls += 1;
      return json({ withdrawals: [], next: 'same' });
    });
    expect(calls).toBe(2);
  });

  it('reads as none when the server has no list, fails, or answers something else', async () => {
    for (const answer of [json({ error: 'x' }, 404), json({ withdrawals: 'no' }), json({})])
      expect(await readPersonWithdrawals(async () => answer.clone())).toEqual([]);
    expect(
      await readPersonWithdrawals(async () => {
        throw new Error('offline');
      }),
    ).toEqual([]);
  });
});
