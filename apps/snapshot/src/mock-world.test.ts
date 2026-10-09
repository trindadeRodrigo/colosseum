import { view } from '@colosseum/basket';
import { createMockAdapter, type MockAdapter, mockAddress } from '@colosseum/chain-mock';
import type { ChainId, Target } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import {
  BUCKET_MS,
  createMockWorld,
  levelBps,
  MAX_LEVEL_BPS,
  MAX_MOVE_BPS,
  mockVaultAddress,
  sampleOwner,
  sampleVault,
} from './mock-world';
import type { KnownVault } from './source';

// The sample world of a chain on the mock: the vaults the database names are made again on the worker's
// own chain in memory, at the same addresses; with nothing named there is one sample vault; and the
// prices move a little every ten minutes. All on packages/chain-mock, with no database.

const T0 = new Date('2026-10-06T15:00:00.000Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function world(chain: ChainId = 'solana') {
  const adapter = createMockAdapter({ chain, now: T0.toISOString() });
  const warned: string[] = [];
  return { adapter, warned, world: createMockWorld(adapter, { warn: (l) => warned.push(l) }) };
}

/** A row as the `vaults` cache holds one: the owner, the plan's number, the targets and the value. */
function row(chain: ChainId, over: Partial<KnownVault> & { targets: Target[] }): KnownVault {
  const owner = over.owner ?? mockAddress(chain, 'a person');
  const onchainBasketId = over.onchainBasketId ?? '7';
  return {
    address: mockVaultAddress(chain, owner, onchainBasketId),
    owner,
    onchainBasketId,
    basketId: null,
    valueUsd: '2500.00',
    ...over,
  };
}

/** The vault at an address as the worker's pass would value it. */
async function seen(adapter: MockAdapter, address: string) {
  const state = await adapter.getVault(address);
  if (!state) throw new Error(`no vault at ${address}`);
  const assets = await adapter.listAssets();
  const prices = await adapter.getPrices(state.positions.map((p) => p.asset));
  return view(state, prices, assets);
}

/** The price of every asset but cash, by id. */
async function pricesOf(adapter: MockAdapter): Promise<Map<string, number>> {
  const ids = (await adapter.listAssets()).filter((a) => a.cls !== 'cash').map((a) => a.id);
  return new Map((await adapter.getPrices(ids)).map((p) => [p.asset, Number(p.usdPerToken)]));
}

describe('the sample world: a vault the database names', () => {
  it('is made at the address another process gave it, with weights near its targets', async () => {
    // The API's mock, in another process: a person opens a vault there.
    const api = createMockAdapter({ chain: 'solana' });
    const owner = mockAddress('solana', 'a person');
    api.mock.fund(owner, { gasRaw: '1000000000', assets: { [api.mock.cash]: '2500000000' } });
    await api.mock.send(
      await api.buildCreateVault({
        owner,
        basketId: '7',
        targets: [],
        autoFollow: false,
        depositRaw: '2500000000',
        slippageBps: 50,
      }),
    );
    const [theirs] = await api.getVaults(owner);
    if (!theirs) throw new Error('the API mock made no vault');

    // The worker's mock holds nothing of it until the row is replayed.
    const w = world();
    expect(await w.adapter.getVault(theirs.address)).toBeNull();
    const targets = [
      { asset: 'solana:spy', weightBps: 5_000 },
      { asset: 'solana:gold', weightBps: 2_500 },
    ];
    const extra = await w.world.prepare(
      [
        {
          address: theirs.address,
          owner,
          onchainBasketId: theirs.basketId,
          basketId: null,
          targets,
          valueUsd: '2500.00',
        },
      ],
      T0,
    );
    expect(extra).toEqual([]);
    expect(w.warned).toEqual([]);

    const v = await seen(w.adapter, theirs.address);
    expect(v.address).toBe(theirs.address);
    expect(v.owner).toBe(owner);
    expect(v.basketId).toBe('7');
    expect(v.autoFollow).toBe(false);
    // What the row was worth, less what the purchases cost.
    expect(Number(v.valueUsd)).toBeGreaterThan(2_495);
    expect(Number(v.valueUsd)).toBeLessThanOrEqual(2_500);
    expect(v.positions.map((p) => [p.asset, p.targetBps]).sort()).toEqual([
      ['solana:gold', 2_500],
      ['solana:spy', 5_000],
    ]);
    for (const p of v.positions) expect(Math.abs(p.driftBps), p.asset).toBeLessThanOrEqual(10);
    // A quarter stays in cash.
    expect(Number(v.cash.display)).toBeGreaterThan(620);
    expect(Number(v.cash.display)).toBeLessThan(630);
  });

  it('is made once: a second pass adds no vault and trades nothing', async () => {
    const w = world();
    const r = row('solana', { targets: [{ asset: 'solana:nvda', weightBps: 4_000 }] });
    await w.world.prepare([r], T0);
    const first = await w.adapter.getVault(r.address);
    await w.world.prepare([r], later(10));
    await w.world.prepare([r, r], later(20));
    expect(await w.adapter.getVaults(r.owner)).toHaveLength(1);
    const again = await w.adapter.getVault(r.address);
    expect(again?.cash.raw).toBe(first?.cash.raw);
    expect(again?.positions.map((p) => p.raw)).toEqual(first?.positions.map((p) => p.raw));
    // Something is known, so there is no sample vault.
    expect(await w.adapter.getVault(sampleVault('solana'))).toBeNull();
    expect(w.warned).toEqual([]);
  });

  it('needs the approval on an EVM chain, and buys at the targets there too', async () => {
    const w = world('robinhood');
    expect(w.adapter.capabilities.needsApprove).toBe(true);
    const r = row('robinhood', {
      targets: [
        { asset: 'robinhood:spy', weightBps: 3_000 },
        { asset: 'robinhood:tsla', weightBps: 3_000 },
        { asset: 'robinhood:yield', weightBps: 3_000 },
      ],
      valueUsd: '900',
    });
    expect(r.address).toMatch(/^0x[0-9a-f]{40}$/);
    await w.world.prepare([r], T0);
    expect(w.warned).toEqual([]);
    const v = await seen(w.adapter, r.address);
    expect(v.positions).toHaveLength(3);
    for (const p of v.positions) expect(Math.abs(p.driftBps), p.asset).toBeLessThanOrEqual(10);
    expect(Number(v.valueUsd)).toBeGreaterThan(898);
  });

  it('drops a target the mock does not list, and still makes a row with none, in cash', async () => {
    const w = world();
    const mixed = row('solana', {
      onchainBasketId: '1',
      targets: [
        { asset: 'solana:spy', weightBps: 6_000 },
        { asset: 'solana:spyx', weightBps: 3_000 },
      ],
      valueUsd: '1000',
    });
    const none = row('solana', {
      onchainBasketId: '2',
      targets: [{ asset: 'solana:qqqx', weightBps: 10_000 }],
      valueUsd: '400',
    });
    await w.world.prepare([mixed, none], T0);
    expect(w.warned).toEqual([]);
    const a = await seen(w.adapter, mixed.address);
    expect(a.positions.map((p) => p.asset)).toEqual(['solana:spy']);
    expect(Math.abs(a.positions[0]?.driftBps ?? 99)).toBeLessThanOrEqual(10);
    const b = await seen(w.adapter, none.address);
    expect(b.positions).toEqual([]);
    expect(b.cash.display).toBe('400');
  });

  it('opens with a hundred dollars when the row has no value, a value of nothing, or no figure', async () => {
    const w = world();
    const rows = [null, '0', '0.00', 'n/a'].map((valueUsd, i) =>
      row('solana', { onchainBasketId: String(i + 1), targets: [], valueUsd }),
    );
    await w.world.prepare(rows, T0);
    for (const r of rows)
      expect((await w.adapter.getVault(r.address))?.cash.display, String(r.valueUsd)).toBe('100');
    expect(w.warned).toEqual([]);
  });

  it('skips a row it cannot make, says so once, and makes the rest', async () => {
    const w = world();
    const good = row('solana', { targets: [{ asset: 'solana:gold', weightBps: 5_000 }] });
    // An address the mock would never give this owner and plan number.
    const moved = {
      ...good,
      address: mockAddress('solana', 'somewhere else'),
      onchainBasketId: '9',
    };
    // Targets no vault takes: over the whole.
    const over = row('solana', {
      onchainBasketId: '3',
      targets: [
        { asset: 'solana:spy', weightBps: 6_000 },
        { asset: 'solana:gold', weightBps: 6_000 },
      ],
    });
    await expect(w.world.prepare([moved, over, good], T0)).resolves.toEqual([]);
    expect(await w.adapter.getVault(good.address)).not.toBeNull();
    expect(await w.adapter.getVault(moved.address)).toBeNull();
    expect(await w.adapter.getVault(over.address)).toBeNull();
    // Nothing was opened for the row that was skipped, at its address or at any other.
    expect((await w.adapter.getVaults(good.owner)).map((v) => v.address)).toEqual([good.address]);
    expect(w.warned).toHaveLength(2);
    expect(w.warned[0]).toContain(`could not make the vault ${moved.address}`);
    expect(w.warned[0]).toContain('another address');
    expect(w.warned[1]).toContain(`could not make the vault ${over.address}`);
    // Not tried and not said again.
    await w.world.prepare([moved, over, good], later(10));
    expect(w.warned).toHaveLength(2);
  });
  it('takes a transaction the mock landed and reverted as a row it could not make', async () => {
    const w = world('robinhood');
    const r = row('robinhood', { targets: [{ asset: 'robinhood:gold', weightBps: 5_000 }] });
    // The mock records a revert and throws nothing: the approval lands and fails.
    w.adapter.mock.revertNext({ code: 'Unknown', message: 'reverted for the test' });
    await expect(w.world.prepare([r], T0)).resolves.toEqual([]);
    expect(w.warned).toHaveLength(1);
    expect(w.warned[0]).toContain(`could not make the vault ${r.address}: reverted for the test`);
    expect(await w.adapter.getVault(r.address)).toBeNull();
  });
});

describe('the sample world: nothing named', () => {
  for (const chain of ['solana', 'robinhood'] as const) {
    it(`makes one sample vault on ${chain}, and no second one at the next pass`, async () => {
      const w = world(chain);
      const address = sampleVault(chain);
      expect(await w.world.prepare([], T0)).toEqual([address]);
      expect(await w.world.prepare([], later(10))).toEqual([address]);
      const vaults = await w.adapter.getVaults(sampleOwner(chain));
      expect(vaults.map((v) => v.address)).toEqual([address]);
      const v = await seen(w.adapter, address);
      expect(v.positions.map((p) => [p.asset, p.targetBps]).sort()).toEqual([
        [`${chain}:gold`, 2_000],
        [`${chain}:spy`, 4_000],
        [`${chain}:yield`, 3_000],
      ]);
      expect(Number(v.valueUsd)).toBeGreaterThan(990);
      expect(Number(v.valueUsd)).toBeLessThan(1_010);
      expect(w.warned).toEqual([]);
    });
  }

  it('keeps the mock on the clock of the pass, so every read is stamped with it', async () => {
    const w = world();
    await w.world.prepare([], later(25));
    expect(w.adapter.mock.now()).toBe(Math.floor(later(25).getTime() / 1000));
    expect((await w.adapter.getVault(sampleVault('solana')))?.observedAt).toBe(
      later(25).toISOString(),
    );
    // A clock is never turned back.
    await w.world.prepare([], later(5));
    expect(w.adapter.mock.now()).toBe(Math.floor(later(25).getTime() / 1000));
  });
});

describe('the sample world: prices', () => {
  it('moves each price a little from one ten minutes to the next, and never the cash', async () => {
    const w = world();
    const start = await pricesOf(w.adapter);
    let moved = 0;
    let before = start;
    for (let step = 0; step < 60; step++) {
      await w.world.prepare([], later(step * 10));
      const now = await pricesOf(w.adapter);
      for (const [asset, price] of now) {
        const from = start.get(asset) as number;
        const move = (Math.abs(price - (before.get(asset) as number)) / from) * 10_000;
        if (step > 0) {
          expect(move, `${asset} at step ${step}`).toBeLessThanOrEqual(MAX_MOVE_BPS + 0.02);
          if (move > 0) moved++;
        }
        const level = ((price - from) / from) * 10_000;
        expect(Math.abs(level), `${asset} at step ${step}`).toBeLessThanOrEqual(
          MAX_LEVEL_BPS + 0.02,
        );
      }
      before = now;
    }
    // Five assets over 59 steps: nearly every step moves a price.
    expect(moved).toBeGreaterThan(250);
    const [cash] = await w.adapter.getPrices([w.adapter.mock.cash]);
    expect(cash?.usdPerToken).toBe('1');
  });

  it('gives the same prices for the same time on any worker, and moves nothing twice in one bucket', async () => {
    const a = world();
    const b = world();
    // One worker walked there over an hour, the other started just now.
    for (let step = 0; step <= 6; step++) await a.world.prepare([], later(step * 10));
    await b.world.prepare([], later(60));
    expect(await pricesOf(b.adapter)).toEqual(await pricesOf(a.adapter));
    await a.world.prepare([], later(64));
    expect(await pricesOf(a.adapter)).toEqual(await pricesOf(b.adapter));
    await a.world.prepare([], later(70));
    expect(await pricesOf(a.adapter)).not.toEqual(await pricesOf(b.adapter));
  });

  it('keeps every level inside its bound over a month of buckets', () => {
    expect(MAX_LEVEL_BPS).toBeLessThan(5_000);
    const first = Math.floor(T0.getTime() / BUCKET_MS);
    let widest = 0;
    let last = levelBps('solana:spy', first);
    for (let b = first + 1; b < first + 4_320; b++) {
      const level = levelBps('solana:spy', b);
      expect(Number.isInteger(level)).toBe(true);
      expect(Math.abs(level - last)).toBeLessThanOrEqual(MAX_MOVE_BPS);
      widest = Math.max(widest, Math.abs(level));
      last = level;
    }
    expect(widest).toBeLessThanOrEqual(MAX_LEVEL_BPS);
    // It does move: a flat line is not a history.
    expect(widest).toBeGreaterThan(100);
  });
});
