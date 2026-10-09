import type { Quote, Trade } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import type { ChainEntry } from './chains';
import { Refusal } from './errors';
import { expectedOf } from './prepare';

// What an order states for each trade (`expectedOf`): the quote, and the least the trade accepts. An
// order never states a minimum of nothing, which would accept any price: a trade that quotes nothing,
// or whose minimum rounds down to nothing, makes no order.

const trade: Trade = { sell: 'solana:usdc', buy: 'solana:spy', amountInRaw: '1000' };
/** A chain whose quote pays out `outRaw` for whatever is asked. */
const paying = (outRaw: string) =>
  ({
    adapter: { quote: async (): Promise<Partial<Quote>> => ({ outRaw, costBps: 10 }) },
  }) as unknown as ChainEntry;

describe('what an order states for a trade', () => {
  it('is the quote and a minimum under it by the slippage', async () => {
    expect(await expectedOf(paying('50000'), [trade], 'owner', 100)).toEqual([
      { inRaw: '1000', outRaw: '50000', minOutRaw: '49500', costBps: 10 },
    ]);
  });

  it.each([
    ['a quote of nothing', '0', 100],
    // 1 unit less 1%: the minimum rounds down to nothing
    ['a minimum that rounds to nothing', '1', 100],
  ])('is not stated for %s: the order is refused', async (_, outRaw, slippageBps) => {
    const refused = await expectedOf(paying(outRaw), [trade], 'owner', slippageBps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(Refusal);
    expect((refused as Refusal).status).toBe(422);
    expect((refused as Refusal).message).toMatch(
      /swaps into no solana:spy that can be held to a minimum/,
    );
  });
});
