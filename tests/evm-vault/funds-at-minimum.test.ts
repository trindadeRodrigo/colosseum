import { mockAddress } from '@colosseum/chain-mock';
import { type Address, parseChainConfigs, parseFlags } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createChainRegistry } from '../../apps/api/src/orders/chains';
import { checkMix, mixContext, planRetarget } from '../../apps/api/src/orders/mix';
import { firstShort } from '../../packages/chain-evm/src/vault/funds';
import { fixtureLiquidity } from '../../packages/engine/src/personal/testing';

// Why `firstShort` counts a sale's cash at its quote and not at its stated minimum (the review of
// #232 asked for the minimum). The order layer sizes a purchase from the reference prices less the
// order's slippage (`rebalancePlan`'s `costBps`), and states the sale's minimum as the pool's quote
// less the same slippage. A pool pays under the reference by its fee, so wherever the purchases take
// all the sales bring in, the purchase is above the sale's minimum by that fee: held to the minimum,
// every such order would be refused before signing, though it lands at any price down to about the
// quote. The fix is in how the order is sized (purchases from the sales' stated minimums), not in
// this check; until then the check is at the quote, and the simulation and the chain hold the rest.

const NOW = '2026-10-08T12:00:00.000Z';
const CASH = 'robinhood:usdc';

async function retarget(allocations: { assetId: string; weightBps: number }[]) {
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), {
    seed: `funds-at-minimum:${allocations.map((a) => a.assetId).join()}`,
  });
  const entry = chains.get('robinhood');
  const mock = entry.mock;
  if (!mock) throw new Error('the test chain is the mock');
  const ctx = await mixContext(
    entry,
    async () => ({ liquidity: { provider: fixtureLiquidity({}), source: 'fixture exit table' } }),
    NOW,
  );
  const owner = mockAddress('robinhood', 'funds-at-minimum') as Address;
  mock.fund(owner, { gasRaw: '1000000000000000000', assets: { [CASH]: '1000000000' } });
  await mock.send(
    await entry.adapter.buildApprove({ owner, basketId: '21', amountRaw: '1000000000' }),
  );
  await mock.send(
    await entry.adapter.buildCreateVault({
      owner,
      basketId: '21',
      targets: [{ asset: 'robinhood:spy', weightBps: 10_000 }],
      autoFollow: false,
      depositRaw: '1000000000',
      trades: [{ sell: CASH, buy: 'robinhood:spy', amountInRaw: '1000000000' }],
      slippageBps: 100,
    }),
  );
  const [vault] = await entry.adapter.getVaults(owner);
  if (!vault) throw new Error('no vault');
  const checked = await checkMix(ctx, allocations, vault);
  const { order } = await planRetarget(ctx, vault, checked, { slippageBps: 100, now: NOW, owner });
  const swap = order.legs.find((l) => l.kind === 'swap');
  if (!swap) throw new Error('no swap step');
  const held = new Map([[vault.cash.asset, BigInt(vault.cash.raw)]]);
  for (const p of vault.positions) held.set(p.asset, BigInt(p.raw));
  return {
    swap,
    atQuote: firstShort(
      swap.trades,
      held,
      swap.expected.map((e) => BigInt(e.outRaw)),
    ),
    atMinimum: firstShort(
      swap.trades,
      held,
      swap.expected.map((e) => BigInt(e.minOutRaw)),
    ),
  };
}

describe('what a later trade of a step may spend of an earlier one', () => {
  it('a change that spends all its sale brings in is covered at the quote, and would be refused at the minimum', async () => {
    // Half of the one stock into another: the purchase takes everything the sale is planned to bring.
    const { swap, atQuote, atMinimum } = await retarget([
      { assetId: 'robinhood:spy', weightBps: 5000 },
      { assetId: 'robinhood:nvda', weightBps: 5000 },
    ]);
    expect(swap.trades.map((t) => [t.sell, t.buy])).toEqual([
      ['robinhood:spy', CASH],
      [CASH, 'robinhood:nvda'],
    ]);
    expect(atQuote).toBeNull();
    const purchase = BigInt(swap.trades[1]?.amountInRaw ?? '0');
    const saleMinimum = BigInt(swap.expected[0]?.minOutRaw ?? '0');
    const saleQuote = BigInt(swap.expected[0]?.outRaw ?? '0');
    // Sized from the reference less the slippage, above the quote less the slippage, under the quote.
    expect(purchase).toBeGreaterThan(saleMinimum);
    expect(purchase).toBeLessThanOrEqual(saleQuote);
    expect(atMinimum).toEqual({ index: 1, asset: CASH, held: saleMinimum });
  });

  it('a change that leaves a margin (all of one stock into all of another) is covered at either', async () => {
    const { atQuote, atMinimum } = await retarget([
      { assetId: 'robinhood:nvda', weightBps: 10_000 },
    ]);
    expect(atQuote).toBeNull();
    expect(atMinimum).toBeNull();
  });
});
