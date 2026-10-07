import type {
  KeeperContext,
  KeeperPosition,
  SolanaVaultAdapter,
} from '@colosseum/chain-solana/vault';
import { ChainError, type Price, type VaultState } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { newMemory, runRound } from '../../apps/keeper/src/round';

// What the keeper does to a vault its owner withdraws from (WITHDRAW, Oct 6), on a stand-in for the
// chain: it reads the vault afresh every round and for every leg, so it never moves a token back in,
// and it never trades a vault that is empty. What it does do is its job: a vault with auto-follow on
// that is left off its weights by a withdrawal is traded back toward them, which can buy again a
// token that was taken out. So a withdrawal's first step switches auto-follow off
// (apps/api/src/orders/withdraw.ts), and from then on the keeper does not visit the vault.

const VAULT = 'Vau1t11111111111111111111111111111111111111';
const CASH = 'solana:cash';
const SPYX = 'solana:spyx';
const holding = (asset: string, raw: string) => ({ asset, raw, multiplier: '1', display: '1' });
/** A vault of cash and spyx at $100 a token, with half its weight on spyx. */
const vault = (cashRaw: string, spyxRaw: string): VaultState =>
  ({
    chain: 'solana',
    address: VAULT,
    owner: VAULT,
    basketId: '1',
    recipeOnchainId: 'Rec1pe',
    acceptedVersion: 1,
    autoFollow: true,
    keeper: VAULT,
    cash: holding(CASH, cashRaw),
    positions: [{ ...holding(SPYX, spyxRaw), targetBps: 5_000, lastKeeperAt: null }],
    lossUsedBps: 0,
    observedAt: '2026-10-06T15:00:00.000Z',
    pending: null,
  }) as VaultState;
const context = (v: VaultState): KeeperContext =>
  ({
    vault: v,
    rules: { paused: false, lossCapBps: 100, bandBps: 50 },
    priceAccount: 'Pr1ce',
    positions: [
      { asset: SPYX, needsSync: false, keeperOn: true, reference: null, trade: null },
    ] as KeeperPosition[],
    blocked: null,
    clock: 0,
  }) as unknown as KeeperContext;
const price = (asset: string, usdPerToken: string): Price => ({
  asset,
  usdPerToken,
  ageSeconds: 1,
  maxAgeSeconds: 120,
  market: 'open',
  source: 'test',
  method: 'test',
  fetchedAt: '2026-10-06T15:00:00.000Z',
  provenance: 'sandbox',
});

/** A chain of one vault, read afresh each time it is asked; `build` stands in for the leg's builder. */
function chain(read: () => VaultState, build: () => Promise<unknown> = async () => LEG) {
  const sent: string[] = [];
  const adapter = {
    listAssets: async () => [
      { id: CASH, cls: 'cash', priceKind: 'scope', decimals: 6 },
      { id: SPYX, cls: 'stock', priceKind: 'scope', decimals: 8 },
    ],
    listAutoFollowVaults: async () => [VAULT],
    getKeeperContext: async () => context(read()),
    getPrices: async (ids: string[]) => ids.map((id) => price(id, id === CASH ? '1' : '100')),
    buildKeeperLeg: build,
    track: async () => ({ status: 'confirmed', explorerUrl: '', error: null }),
  } as unknown as SolanaVaultAdapter;
  const options = {
    adapter,
    sign: async () => ({ wire: 'w', txId: 'tx' }),
    send: async () => {
      sent.push('tx');
    },
    settleMs: 0,
  };
  return { options, sent };
}
const LEG = { signer: 'K', payload: '', lastValidBlockHeight: 1_000 };

describe('the keeper and a withdrawal', () => {
  it('does not visit a vault whose auto-follow a withdrawal switched off, however far off its weights', async () => {
    // The chain lists the vaults with auto-follow on: this one no longer is one of them.
    const { options, sent } = chain(() => ({ ...vault('100000000', '0'), autoFollow: false }));
    const off = {
      ...options,
      adapter: { ...options.adapter, listAutoFollowVaults: async () => [] },
    } as typeof options;
    expect(await runRound(off, newMemory())).toEqual([]);
    // And one it is still handed (a list read a moment too early) is refused by the program's own
    // check, which the round reads before it plans: skipped, nothing built or sent, no alert.
    const late = chain(() => ({ ...vault('100000000', '0'), autoFollow: false }));
    const adapter = {
      ...late.options.adapter,
      getKeeperContext: async () => ({
        ...(await late.options.adapter.getKeeperContext(VAULT)),
        blocked: 'AutoFollowOff',
      }),
    } as typeof late.options.adapter;
    const [line] = await runRound({ ...late.options, adapter }, newMemory());
    expect([line?.outcome, line?.alert, line?.reason]).toEqual([
      'skipped',
      false,
      'no leg would pass: AutoFollowOff',
    ]);
    expect([...sent, ...late.sent]).toEqual([]);
  });

  it('leaves a vault alone that a withdrawal emptied: nothing to weigh, nothing sent, no alert', async () => {
    const { options, sent } = chain(() => vault('0', '0'));
    const [line] = await runRound(options, newMemory());
    expect([line?.outcome, line?.alert]).toEqual(['skipped', false]);
    expect(sent).toEqual([]);
  });

  it('leaves alone a vault that withdrew the same share of every token: it is still on its weights', async () => {
    const { options, sent } = chain(() => vault('50000000', '50000000'));
    const [line] = await runRound(options, newMemory());
    expect(line?.reason).toBe('every position is inside the band');
    expect(sent).toEqual([]);
  });

  it('trades a vault back toward its weights after a withdrawal of one token: it sells for cash, it buys again', async () => {
    // All the cash taken out: the vault is all spyx, and the keeper sells some of it for cash.
    const noCash = chain(() => vault('0', '100000000'));
    const [sells] = await runRound({ ...noCash.options, dryRun: true }, newMemory());
    expect([sells?.outcome, sells?.reason]).toEqual([
      'would-act',
      expect.stringMatching(/^would sell \d+ raw solana:spyx for solana:cash$/),
    ]);
    // All the spyx taken out: the keeper buys spyx again with the cash that stayed.
    const noSpyx = chain(() => vault('100000000', '0'));
    const [buys] = await runRound({ ...noSpyx.options, dryRun: true }, newMemory());
    expect([buys?.outcome, buys?.reason]).toEqual([
      'would-act',
      expect.stringMatching(/^would sell \d+ raw solana:cash for solana:spyx$/),
    ]);
  });

  it('a withdrawal that lands between the plan and the leg: the builder refuses it, nothing is sent or remembered', async () => {
    // Planned on a vault off its weights; by the time the leg is built and simulated, the owner has
    // taken the cash the leg would spend, and the program would refuse it.
    const memory = newMemory();
    const { options, sent } = chain(
      () => vault('100000000', '0'),
      async () => {
        throw new ChainError('SpentTooMuch', 'the vault no longer holds the cash this leg spends');
      },
    );
    const [line] = await runRound(options, memory);
    expect([line?.outcome, line?.reason]).toEqual([
      'skipped',
      'the leg solana:cash -> solana:spyx would be refused: SpentTooMuch',
    ]);
    expect(sent).toEqual([]);
    expect(memory.inFlight.size).toBe(0);
    expect(memory.reverted.size).toBe(0);
    // The next round reads the vault as it is now, emptied, and plans nothing.
    const after = chain(() => vault('0', '0'));
    expect((await runRound(after.options, memory))[0]?.outcome).toBe('skipped');
  });
});
