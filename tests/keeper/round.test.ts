import type {
  KeeperContext,
  KeeperPosition,
  SolanaVaultAdapter,
} from '@colosseum/chain-solana/vault';
import { ChainError, type Price, type VaultState } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { runRound } from '../../apps/keeper/src/round';

// The round's decisions on a vault read from a stand-in for the chain: the loss budget, the cluster's
// clock against a version's effective time, and the prices it asks for. The sending side runs against
// the real program in keeper.test.ts.

const VAULT = 'Vau1t11111111111111111111111111111111111111';
const CASH = 'solana:cash';
const SPYX = 'solana:spyx';
// One whole spyx, $100, all of the vault: on its target.
const holding = (asset: string, raw: string) => ({ asset, raw, multiplier: '1', display: '1' });
const vault = (more: Partial<VaultState> = {}): VaultState =>
  ({
    chain: 'solana',
    address: VAULT,
    owner: VAULT,
    basketId: '1',
    recipeOnchainId: 'Rec1pe',
    acceptedVersion: 1,
    autoFollow: true,
    keeper: VAULT,
    cash: holding(CASH, '0'),
    positions: [{ ...holding(SPYX, '100000000'), targetBps: 10_000, lastKeeperAt: null }],
    lossUsedBps: 0,
    observedAt: '2026-10-05T15:00:00.000Z',
    pending: null,
    ...more,
  }) as VaultState;
const context = (v: VaultState, clock: number): KeeperContext =>
  ({
    vault: v,
    rules: { paused: false, lossCapBps: 100, bandBps: 50 },
    priceAccount: 'Pr1ce',
    positions: [
      { asset: SPYX, needsSync: false, keeperOn: true, reference: null, trade: null },
    ] as KeeperPosition[],
    blocked: null,
    clock,
  }) as unknown as KeeperContext;
const price = (asset: string, usdPerToken: string): Price => ({
  asset,
  usdPerToken,
  ageSeconds: 1,
  maxAgeSeconds: 120,
  market: 'open',
  source: 'test',
  method: 'test',
  fetchedAt: '2026-10-05T15:00:00.000Z',
  provenance: 'sandbox',
});

/** A chain that holds one vault; it records what the round asks of it. */
function chain(ctx: KeeperContext) {
  const asked = { prices: [] as string[][], adoptions: 0 };
  const adapter = {
    listAssets: async () => [
      { id: CASH, cls: 'cash', priceKind: 'scope', decimals: 6 },
      { id: SPYX, cls: 'stock', priceKind: 'scope', decimals: 8 },
      // Listed, and no price can be read for it: no vault that does not hold it may care.
      { id: 'solana:gldx', cls: 'gold', priceKind: 'scope', decimals: 8 },
    ],
    listAutoFollowVaults: async () => [VAULT],
    getKeeperContext: async () => ctx,
    getPrices: async (ids: string[]) => {
      asked.prices.push(ids);
      if (ids.includes('solana:gldx')) throw new ChainError('AssetNotPriced', 'no price for gldx');
      return ids.map((id) => price(id, id === CASH ? '1' : '100'));
    },
    buildAdoptVersion: async () => {
      asked.adoptions++;
      throw new ChainError('Unavailable', 'not in this stand-in');
    },
  } as unknown as SolanaVaultAdapter;
  return { adapter, asked };
}
const sign = async () => ({ wire: '', txId: '' });

describe("the keeper's round, on a vault read from the chain", () => {
  it('skips a vault at its loss cap, with an alert, and alerts on every line past half the budget', async () => {
    const atCap = chain(context(vault({ lossUsedBps: 100 }), 0));
    const [capped] = await runRound({ adapter: atCap.adapter, sign });
    expect([capped?.outcome, capped?.alert, capped?.txIds]).toEqual(['skipped', true, []]);
    expect(capped?.reason).toBe(
      'the weekly loss cap is used (100 of 100 bps) (loss budget: 100 of 100 bps used)',
    );

    const half = chain(context(vault({ lossUsedBps: 50 }), 0));
    const [line] = await runRound({ adapter: half.adapter, sign });
    expect([line?.outcome, line?.alert]).toEqual(['skipped', true]);
    expect(line?.reason).toBe(
      'every position is inside the band (loss budget: 50 of 100 bps used)',
    );

    const fresh = chain(context(vault({ lossUsedBps: 49 }), 0));
    expect((await runRound({ adapter: fresh.adapter, sign }))[0]?.alert).toBe(false);
  });

  it("asks prices for the vault's own holdings only, so an asset it does not hold cannot stop it", async () => {
    const { adapter, asked } = chain(context(vault(), 0));
    const [line] = await runRound({ adapter, sign });
    expect(asked.prices).toEqual([[CASH, SPYX]]);
    expect(line?.reason).toBe('every position is inside the band');
  });

  it("holds a pending version to the cluster's clock, not the machine's", async () => {
    const effectiveAt = 1_000;
    const pending = { version: 2, effectiveAt, newAssets: [] };
    // The machine's clock is decades past it; the cluster's is a second short.
    const early = chain(context(vault({ pending }), effectiveAt - 1));
    await runRound({ adapter: early.adapter, sign });
    expect(early.asked.adoptions).toBe(0);

    const due = chain(context(vault({ pending }), effectiveAt));
    const [line] = await runRound({ adapter: due.adapter, sign });
    expect(due.asked.adoptions).toBe(1);
    expect(line?.reason).toBe('failed: Unavailable');
  });

  it('leaves a version that adds an asset to the owner', async () => {
    const pending = { version: 2, effectiveAt: 0, newAssets: ['solana:gldx'] };
    const { adapter, asked } = chain(context(vault({ pending }), 10));
    const [line] = await runRound({ adapter, sign });
    expect(asked.adoptions).toBe(0);
    expect([line?.outcome, line?.reason]).toEqual([
      'skipped',
      'version 2 adds solana:gldx: the owner accepts it',
    ]);
  });
});
