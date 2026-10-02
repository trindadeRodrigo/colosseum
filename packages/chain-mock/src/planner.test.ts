import { batchTrades, planRebalance, view } from '@colosseum/basket';
import type { Target, VaultState } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { mockFixture } from './fixture';

// The planner in packages/basket and the mock vault agree: what the one plans, the other accepts.

const POLICY = { bandBps: 50, minTradeUsd: 1 };
const targetsOf = (v: VaultState): Target[] =>
  v.positions
    .filter((p) => p.targetBps > 0)
    .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));

describe('chain-mock with the planner', () => {
  it('lets the keeper rebalance a vault leg by leg, planning again after each', async () => {
    const f = await mockFixture('solana');
    const { adapter } = f;
    const assets = await adapter.listAssets();
    const prices = await adapter.getPrices(assets.map((a) => a.id));
    const read = async () => {
      const v = await adapter.getVault(f.vault);
      if (!v) throw new Error('the fixture vault is gone');
      return v;
    };
    // $700 of cash and $300 of SPY against 50% SPY, 30% NVDA, 20% gold: far outside the band.
    const before = view(await read(), prices, assets);
    expect(before.positions.some((p) => Math.abs(p.driftBps) > POLICY.bandBps)).toBe(true);

    let legs = 0;
    for (; legs < 10; legs += 1) {
      const v = await read();
      const [next] = planRebalance(v, targetsOf(v), prices, POLICY, assets);
      if (!next) break;
      // The mock vault checks each leg: toward the target, and not past it.
      const { txId } = await adapter.mock.send(await adapter.buildKeeperLeg(f.vault, next));
      expect((await adapter.track(txId)).status).toBe('confirmed');
    }
    expect(legs).toBe(3);
    const after = view(await read(), prices, assets);
    for (const p of after.positions)
      expect(Math.abs(p.driftBps)).toBeLessThanOrEqual(POLICY.bandBps);
    // Every trade cost the mock's 10 bps, so the vault is worth a little under its $1,000.
    expect(Number(after.valueUsd)).toBeLessThan(1000);
    expect(Number(after.valueUsd)).toBeGreaterThan(999);
  });

  it('lets an owner rebalance in one transaction, sales and purchases together', async () => {
    const f = await mockFixture('robinhood');
    const { adapter } = f;
    const assets = await adapter.listAssets();
    const prices = await adapter.getPrices(assets.map((a) => a.id));
    const max = adapter.capabilities.maxTradesPerTx;
    const read = async () => {
      const v = await adapter.getVault(f.manualVault);
      if (!v) throw new Error('the fixture vault is gone');
      return v;
    };
    const rebalance = async () => {
      const v = await read();
      // 10 bps is what a trade costs on the mock: the purchases count on that much less cash.
      const plan = planRebalance(v, targetsOf(v), prices, { ...POLICY, costBps: 10 }, assets);
      for (const trades of batchTrades(plan, max)) {
        const tx = await adapter.buildOwnerSwap({ vault: f.manualVault, trades, slippageBps: 50 });
        expect((await adapter.track((await adapter.mock.send(tx)).txId)).status).toBe('confirmed');
      }
      return plan;
    };

    // $500 of cash against 60% SPY and 40% gold: two purchases.
    expect((await rebalance()).map((t) => t.buy)).toEqual(['robinhood:spy', 'robinhood:gold']);
    const invested = view(await read(), prices, assets);
    for (const p of invested.positions)
      expect(Math.abs(p.driftBps)).toBeLessThanOrEqual(POLICY.bandBps);

    // New targets: SPY and gold are now over, NVDA is new. Sales pay for the purchase, in one go.
    const targets = [
      { asset: 'robinhood:spy', weightBps: 2000 },
      { asset: 'robinhood:gold', weightBps: 3000 },
      { asset: 'robinhood:nvda', weightBps: 5000 },
    ];
    await adapter.mock.send(await adapter.buildSetTargets({ vault: f.manualVault, targets }));
    const plan = await rebalance();
    expect(plan.map((t) => [t.sell, t.buy])).toEqual([
      ['robinhood:spy', 'robinhood:usdc'],
      ['robinhood:gold', 'robinhood:usdc'],
      ['robinhood:usdc', 'robinhood:nvda'],
    ]);
    const after = view(await read(), prices, assets);
    for (const p of after.positions)
      expect(Math.abs(p.driftBps)).toBeLessThanOrEqual(POLICY.bandBps);
    // Planning again finds nothing to do.
    const settled = await read();
    expect(planRebalance(settled, targetsOf(settled), prices, POLICY, assets)).toEqual([]);
  });
});
