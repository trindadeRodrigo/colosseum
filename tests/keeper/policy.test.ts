import type { KeeperContext, KeeperPosition } from '@colosseum/chain-solana/vault';
import type { Trade } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { nextTrade } from '../../apps/keeper/src/policy';

// Which planned trade the keeper builds first, on a vault as `getKeeperContext` reads it.

const cash = 'solana:cash';
const position = (asset: string, more: Partial<KeeperPosition> = {}) =>
  ({ asset, keeperOn: true, reference: null, trade: null, ...more }) as KeeperPosition;
const context = (...positions: KeeperPosition[]) => ({ positions }) as unknown as KeeperContext;
const buy = (asset: string): Trade => ({ sell: cash, buy: asset, amountInRaw: '1000000' });
const always = () => true;

describe("the keeper's choice of trade", () => {
  it('passes over an asset switched off for the keeper, which the owner trades (gate UNIVERSE)', () => {
    const ctx = context(position('solana:gldx', { keeperOn: false }), position('solana:spyx'));
    const { trade, skipped } = nextTrade(
      [buy('solana:gldx'), buy('solana:spyx')],
      ctx,
      cash,
      always,
    );
    expect(trade?.buy).toBe('solana:spyx');
    expect(skipped).toEqual(['solana:gldx: off for the keeper, the owner trades it']);
  });

  it('passes over an asset the program would not value now, and one it would not trade now', () => {
    const ctx = context(
      position('solana:spyx', { reference: 'PriceStale' }),
      position('solana:qqqx', { trade: 'Cooldown' }),
    );
    const { trade, skipped } = nextTrade(
      [buy('solana:spyx'), buy('solana:qqqx')],
      ctx,
      cash,
      always,
    );
    expect(trade).toBeNull();
    expect(skipped).toEqual([
      'solana:spyx: no reference the program would take (PriceStale)',
      'solana:qqqx: Cooldown',
    ]);
  });
});
