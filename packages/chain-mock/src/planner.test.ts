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

  // ---- what the review of BAS-1 found ----

  /** The same numbers every run. */
  function dice(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  it.each(['robinhood', 'base'] as const)(
    'has the cash for an owner batch at prices that do not divide evenly, on %s',
    async (chain) => {
      // With round prices a sale pays out a round number of cash units and nothing shows. These have
      // eight places.
      const roll = dice(99);
      const messy = (base: number) => (base * (0.8 + 0.4 * roll())).toFixed(8);
      const id = (slug: string) => `${chain}:${slug}`;
      let batches = 0;
      for (let round = 0; round < 40; round += 1) {
        const f = await mockFixture(chain);
        const { adapter } = f;
        const assets = await adapter.listAssets();
        const rebalance = async () => {
          const prices = await adapter.getPrices(assets.map((a) => a.id));
          const v = await adapter.getVault(f.manualVault);
          if (!v) throw new Error('the fixture vault is gone');
          const plan = planRebalance(v, targetsOf(v), prices, { ...POLICY, costBps: 10 }, assets);
          for (const trades of batchTrades(plan, adapter.capabilities.maxTradesPerTx)) {
            const tx = await adapter.buildOwnerSwap({
              vault: f.manualVault,
              trades,
              slippageBps: 50,
            });
            const landed = await adapter.track((await adapter.mock.send(tx)).txId);
            expect(landed.status, `round ${round}: ${JSON.stringify(plan)}`).toBe('confirmed');
            batches += 1;
          }
        };
        adapter.mock.setPrice(id('spy'), messy(100));
        adapter.mock.setPrice(id('gold'), messy(200));
        adapter.mock.setPrice(id('nvda'), messy(50));
        await rebalance();
        const first = 1000 + 50 * Math.floor(roll() * 60);
        const second = 1000 + 50 * Math.floor(roll() * 60);
        const targets = [
          { asset: id('spy'), weightBps: first },
          { asset: id('gold'), weightBps: second },
          { asset: id('nvda'), weightBps: 10_000 - first - second },
        ];
        await adapter.mock.send(await adapter.buildSetTargets({ vault: f.manualVault, targets }));
        await rebalance();
      }
      expect(batches).toBeGreaterThanOrEqual(80);
    },
  );

  it('rebalances a vault of a million dollars leg by leg, sales first, down to an empty plan', async () => {
    const f = await mockFixture('solana');
    const { adapter } = f;
    const { mock } = adapter;
    mock.fund(f.owner, { assets: { [mock.cash]: '2000000000000' } });
    await mock.send(
      await adapter.buildDeposit({ vault: f.vault, amountRaw: '1000000000000', slippageBps: 50 }),
    );
    const assets = await adapter.listAssets();
    const read = async () => {
      const v = await adapter.getVault(f.vault);
      if (!v) throw new Error('the fixture vault is gone');
      return v;
    };
    /** One keeper leg per plan, then plan again, until there is nothing left to do. */
    const settle = async () => {
      const prices = await adapter.getPrices(assets.map((a) => a.id));
      const legs: string[] = [];
      for (let k = 0; k < 20; k += 1) {
        const v = await read();
        const [next] = planRebalance(v, targetsOf(v), prices, POLICY, assets);
        if (!next) break;
        legs.push(next.sell === mock.cash ? `buy ${next.buy}` : `sell ${next.sell}`);
        // A leg the vault refuses throws here: NotTowardTarget was what the review met.
        const { txId } = await mock.send(await adapter.buildKeeperLeg(f.vault, next));
        expect((await adapter.track(txId)).status).toBe('confirmed');
      }
      const after = view(await read(), prices, assets);
      const invested = after.positions.reduce((n, p) => n + p.weightBps, 0);
      return { legs, after, cashBps: 10_000 - invested };
    };

    const invested = await settle();
    expect(invested.legs).toEqual(['buy solana:spy', 'buy solana:nvda', 'buy solana:gold']);

    // SPY and NVDA rise 12%, gold falls 15%: two assets over, one under.
    mock.setPrice('solana:spy', '112');
    mock.setPrice('solana:nvda', '56');
    mock.setPrice('solana:gold', '170');
    const moved = await settle();
    // Each asset is traded once: no second sale of what a sale just brought to its target.
    expect(moved.legs).toEqual(['sell solana:spy', 'sell solana:nvda', 'buy solana:gold']);
    for (const p of moved.after.positions)
      expect(Math.abs(p.driftBps), p.asset).toBeLessThanOrEqual(POLICY.bandBps);
    // And the cash the sales brought is spent, not left idle.
    expect(moved.cashBps).toBeLessThanOrEqual(5);
    expect(Number(moved.after.valueUsd)).toBeGreaterThan(1_000_000);
  });
});
