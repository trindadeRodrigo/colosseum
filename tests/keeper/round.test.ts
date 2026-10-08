import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KeeperContext,
  KeeperPosition,
  SolanaVaultAdapter,
} from '@colosseum/chain-solana/vault';
import { ChainError, type Price, type TxStatus, type VaultState } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { loadMemory, saveMemory } from '../../apps/keeper/src/memory';
import { type KeeperMemory, newMemory, runRound } from '../../apps/keeper/src/round';

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

  /** All cash and a target of all spyx: every round plans one purchase, settled as `fate` says. */
  function buying(fate: (txId: string) => TxStatus['status'], version: () => number) {
    const sent: string[] = [];
    let n = 0;
    const ctx = () =>
      context(
        vault({
          acceptedVersion: version(),
          cash: holding(CASH, '100000000'),
          positions: [{ ...holding(SPYX, '0'), targetBps: 10_000, lastKeeperAt: null }],
        }),
        0,
      );
    const adapter = {
      ...chain(ctx()).adapter,
      getKeeperContext: async () => ctx(),
      buildKeeperLeg: async () => ({ signer: 'K', payload: '', lastValidBlockHeight: 1_000 }),
      track: async (txId: string) => ({
        status: fate(txId),
        explorerUrl: '',
        error: { code: 'ReceivedTooLittle', message: '' },
      }),
    } as unknown as SolanaVaultAdapter;
    const options = {
      adapter,
      sign: async () => ({ wire: 'w', txId: `tx${++n}` }),
      send: async () => {
        sent.push(`tx${n}`);
      },
      settleMs: 0,
    };
    return { options, sent };
  }

  it('passes over a reverted leg with an alert in every round on that version, and sends it again on the next', async () => {
    let version = 1;
    const { options, sent } = buying(
      (tx) => (tx === 'tx1' ? 'reverted' : 'confirmed'),
      () => version,
    );
    const memory = newMemory();
    const [first] = await runRound(options, memory);
    expect([first?.alert, first?.reason]).toEqual([
      true,
      'the leg solana:cash -> solana:spyx reverted: ReceivedTooLittle; it is not sent again',
    ]);
    for (const _ of [1, 2]) {
      const [later] = await runRound(options, memory);
      expect([later?.outcome, later?.alert, later?.reason]).toEqual([
        'skipped',
        true,
        'no trade can go now: solana:spyx: not sent again after it reverted on this version',
      ]);
    }
    expect(sent).toEqual(['tx1']);
    // The vault takes another version: the reverted legs of the one before are forgotten.
    version = 2;
    const [next] = await runRound(options, memory);
    expect(next?.outcome).toBe('acted');
    expect(sent).toEqual(['tx1', 'tx2']);
    expect([...memory.reverted]).toEqual([]);
  });

  it('does not call a vault adopted for settling a leg sent in an earlier round', async () => {
    let round = 1;
    const { options } = buying(
      () => (round === 1 ? 'pending' : 'reverted'),
      () => 1,
    );
    const memory = newMemory();
    await runRound(options, memory);
    round = 2;
    const [line] = await runRound(options, memory);
    expect(line?.outcome).toBe('skipped');
    expect(line?.reason).toMatch(/^leg tx1 reverted: ReceivedTooLittle; it is not sent again; /);
  });
});

describe('an EVM leg the chain has not settled, found by its nonce', () => {
  type Fate = { state: 'open' } | { state: 'gone' } | { state: 'landed'; txId: string };
  /**
   * The buying vault on an EVM stand-in: each leg is signed on a nonce, `track` never settles one on
   * its own (no receipt, no deadline), and `fate` and `carries` say what the round is to find.
   */
  function evm(o: {
    fate: (attempt: { messageHash: string }) => Fate;
    carries?: () => 'this' | 'unseen';
    landed?: TxStatus['status'];
    send?: () => Promise<void>;
    /** A version due for adoption while this says so; adopting it lands. */
    due?: () => boolean;
  }) {
    const sent: string[] = [];
    const pinned: (number | undefined)[] = [];
    let n = 0;
    let adopted = false;
    const ctx = () =>
      context(
        vault({
          acceptedVersion: adopted ? 2 : 1,
          pending: !adopted && o.due?.() ? { version: 2, effectiveAt: 0, newAssets: [] } : null,
          cash: holding(CASH, '100000000'),
          positions: [{ ...holding(SPYX, '0'), targetBps: 10_000, lastKeeperAt: null }],
        }),
        0,
      );
    const adapter = {
      ...chain(ctx()).adapter,
      getKeeperContext: async () => ctx(),
      buildKeeperLeg: async (_v: string, _t: unknown, options?: { nonce?: number }) => {
        pinned.push(options?.nonce);
        return {
          signer: '0xkeeper',
          payload: '0x',
          messageHash: `mh${n + 1}`,
          evm: { nonce: options?.nonce ?? 7 + n },
        };
      },
      buildAdoptVersion: async () => ({ signer: '0xkeeper', payload: 'adopt' }),
      track: async (txId: string) =>
        txId === 'adopt'
          ? { status: 'confirmed', explorerUrl: '' }
          : txId === 'landed'
            ? {
                status: o.landed ?? 'confirmed',
                explorerUrl: '',
                error: { code: 'ReceivedTooLittle', message: '' },
              }
            : { status: 'pending', explorerUrl: '' },
      fate: async (a: { messageHash: string }) => o.fate(a),
      carries: async () => (o.carries ?? (() => 'this'))(),
    } as unknown as SolanaVaultAdapter;
    const options = {
      adapter,
      sign: async (tx: { payload: string }) => {
        if (tx.payload !== 'adopt') return { wire: 'w', txId: `tx${++n}` };
        adopted = true;
        return { wire: 'adopt', txId: 'adopt' };
      },
      send: async (wire: string) => {
        if (wire === 'adopt') return;
        await o.send?.();
        sent.push(`tx${n}`);
      },
      settleMs: 0,
    };
    return { options, sent, pinned, adopted: () => adopted };
  }
  /** The memory as the keeper finds it after a restart: written to a state file and read back. */
  const reload = (memory: KeeperMemory): KeeperMemory => {
    const file = join(mkdtempSync(join(tmpdir(), 'keeper-evm-')), 'state.json');
    saveMemory(file, memory);
    return loadMemory(file);
  };

  it('holds the vault while the leg is open and the node holds it, across a reload', async () => {
    const { options, sent } = evm({ fate: () => ({ state: 'open' }) });
    let memory = newMemory();
    await runRound(options, memory);
    expect(sent).toEqual(['tx1']);
    expect(memory.inFlight.get(VAULT)).toMatchObject({ txId: 'tx1', nonce: 7, messageHash: 'mh1' });
    for (const _ of [1, 2]) {
      memory = reload(memory);
      const [line] = await runRound(options, memory);
      expect([line?.outcome, line?.reason]).toEqual(['skipped', 'leg tx1 is not settled yet']);
    }
    // never a second leg on the next nonce while the first can still land
    expect(sent).toEqual(['tx1']);
  });

  it('frees the vault once the nonce is taken by another call, across a reload', async () => {
    let fate: Fate = { state: 'open' };
    const { options, sent, pinned } = evm({ fate: () => fate });
    let memory = newMemory();
    await runRound(options, memory);
    fate = { state: 'gone' };
    memory = reload(memory);
    const [line] = await runRound(options, memory);
    expect(line?.reason).toMatch(/^leg tx1 expired; /);
    expect(sent).toEqual(['tx1', 'tx2']);
    expect(pinned).toEqual([undefined, undefined]);
  });

  it('reads a leg that landed under the id the chain has: confirmed frees, reverted joins the reverted set', async () => {
    for (const landed of ['confirmed', 'reverted'] as const) {
      let fate: Fate = { state: 'open' };
      const { options, sent } = evm({ fate: () => fate, landed });
      let memory = newMemory();
      await runRound(options, memory);
      fate = { state: 'landed', txId: 'landed' };
      memory = reload(memory);
      const [line] = await runRound(options, memory);
      expect(memory.inFlight.has(VAULT) && memory.inFlight.get(VAULT)?.txId === 'tx1').toBe(false);
      if (landed === 'reverted') {
        expect(line?.reason).toMatch(/^leg tx1 reverted: ReceivedTooLittle; it is not sent again/);
        expect([...memory.reverted]).toHaveLength(1);
        expect(sent).toEqual(['tx1']);
      } else {
        expect(line?.reason).toMatch(/^leg tx1 confirmed/);
        expect(sent).toEqual(['tx1', 'tx2']);
      }
    }
  });

  it('frees a vault whose open leg the node never saw, and pins the next leg to its nonce', async () => {
    const { options, sent, pinned } = evm({
      fate: () => ({ state: 'open' }),
      carries: () => 'unseen',
    });
    let memory = newMemory();
    await runRound(options, memory);
    memory = reload(memory);
    const [line] = await runRound(options, memory);
    expect(line?.reason).toMatch(
      /^leg tx1 is not held by the node; the next leg takes its nonce 7/,
    );
    // the second leg is on the first one's nonce: of the two, at most one can land
    expect(pinned).toEqual([undefined, 7]);
    expect(sent).toEqual(['tx1', 'tx2']);
    expect(memory.inFlight.get(VAULT)).toMatchObject({ txId: 'tx2', nonce: 7 });
  });

  it('keeps the leg a pinned leg replaced, and records its revert when it takes the nonce first', async () => {
    let carried: 'this' | 'unseen' = 'this';
    let taken = false;
    const { options, sent, pinned } = evm({
      // Once the nonce is taken, it is the first leg's call that took it.
      fate: (a) =>
        !taken
          ? { state: 'open' }
          : a.messageHash === 'mh1'
            ? { state: 'landed', txId: 'landed' }
            : { state: 'gone' },
      carries: () => carried,
      landed: 'reverted',
    });
    let memory = newMemory();
    await runRound(options, memory);
    carried = 'unseen';
    memory = reload(memory);
    await runRound(options, memory);
    expect(pinned).toEqual([undefined, 7]);
    expect(memory.inFlight.get(VAULT)).toMatchObject({
      txId: 'tx2',
      nonce: 7,
      replaced: [{ txId: 'tx1', messageHash: 'mh1' }],
    });
    taken = true;
    memory = reload(memory);
    const [line] = await runRound(options, memory);
    expect(line?.reason).toMatch(/^leg tx1 reverted: ReceivedTooLittle; it is not sent again; /);
    expect(line?.alert).toBe(true);
    // the reverted leg is not sent a third time
    expect(sent).toEqual(['tx1', 'tx2']);
  });

  it('drops the pin once an adoption lands in the same round, and settles the held leg', async () => {
    let carried: 'this' | 'unseen' = 'this';
    let due = false;
    const h = evm({
      // The adoption takes the free nonce: the held leg can no longer land.
      fate: () => (h?.adopted() ? { state: 'gone' } : { state: 'open' }),
      carries: () => carried,
      due: () => due,
    });
    const { options, sent, pinned } = h;
    let memory = newMemory();
    await runRound(options, memory);
    carried = 'unseen';
    due = true;
    memory = reload(memory);
    const [line] = await runRound(options, memory);
    expect(line?.reason).toMatch(
      /^leg tx1 is not held by the node; the next leg takes its nonce 7; adopted version 2; leg tx1 expired; /,
    );
    // the leg after the adoption is on the signer's next nonce, not the one the adoption took
    expect(pinned).toEqual([undefined, undefined]);
    expect(sent).toEqual(['tx1', 'tx2']);
    expect(memory.inFlight.get(VAULT)?.replaced).toBeUndefined();
  });

  it('forgets a leg the preflight refused: nothing left the keeper, and the next round plans again', async () => {
    let refuse = true;
    const { options, sent } = evm({
      fate: () => ({ state: 'open' }),
      send: async () => {
        if (refuse)
          throw new ChainError('ReceivedTooLittle', 'the preflight reverted', false, {
            unsent: true,
          });
      },
    });
    let memory = newMemory();
    const [first] = await runRound(options, memory);
    expect(first?.reason).toBe(
      'the leg solana:cash -> solana:spyx was refused before it was sent: ReceivedTooLittle; nothing left the keeper',
    );
    expect(memory.inFlight.size).toBe(0);
    refuse = false;
    memory = reload(memory);
    const [second] = await runRound(options, memory);
    expect(second?.reason).not.toMatch(/not settled/);
    expect(sent).toEqual(['tx2']);
  });
});
