import { randomUUID } from 'node:crypto';
import { createMockAdapter, mockAddress } from '@colosseum/chain-mock';
import {
  baskets,
  createDb,
  legs,
  orders,
  seedChains,
  snapshotRuns,
  users,
  userWallets,
  vaultSnapshots,
  vaults,
} from '@colosseum/db';
import {
  ChainError,
  type ChainId,
  chainFamily,
  DISCLAIMER,
  type IntentRequest,
  type Provenance,
  parseChainConfigs,
  type VaultState,
} from '@colosseum/schemas';
import { and, asc, DrizzleQueryError, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newChainState } from './discover';
import { type PassContext, READS_AT_ONCE, snapshotChain } from './pass';
import { runSnapshots, STALE_RUN_MIN_MS } from './run';
import type { ChainSource } from './source';
import {
  closeOpenRuns,
  insertSnapshot,
  LEFT_OPEN,
  openRun,
  SNAPSHOT_METHOD,
  type SnapshotRow,
  snapshottedAddresses,
} from './store';

// The worker's passes on packages/chain-mock and a real Postgres (DATABASE_URL; `pnpm db:up`).
//
// EVERY test of the worker that touches the database is in this one file. `snapshot_runs` allows one
// open run per chain, and vitest runs files side by side: two files opening runs on one chain would
// trip each other, each seeing the other's run as another worker's. Inside a file the tests run one
// after another.
//
// Two runs of this file on one database would trip each other the same way: two worktrees, or a
// review beside a build, share the local database. So the file holds a Postgres advisory lock from
// its first query to its last, and a second run waits at its start until the first is done. The
// lock is the session's and goes with its connection, so a run that is killed leaves none behind.
// What a killed run can leave is an open run stamped in its made-up days. A worker already running
// on the same database never takes that one for left open, since its start is not in the past, and
// skips the chain: the next run of this file, or the next start of the worker, closes it.
//
// Other test files share this database. Their `vaults` rows and owners turn up in these passes as
// `skipped` lines (no such vault on this file's own mock), so every assertion here is on this
// file's own vaults: their owners are new at each run, and so are their addresses. The worker's
// clock is given four made-up days far from any real row, three hours of them to each test, which
// is how this file's runs are told apart and taken away at the end.

const { db, client } = createDb();

/** The advisory lock a run of this file holds: any number, as long as no other file takes it. */
const LOCK = 7_016_001;
let lock: Awaited<ReturnType<typeof client.reserve>> | undefined;

const RUN = randomUUID();
const HOUR = 3_600_000;
const SLOT = 3 * HOUR;
const SPAN = 96 * HOUR;
const T0 = Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 3_000) * SPAN;
const NODE = 'https://node.example/key-in-the-path';
const hide = (text: string) => text.split(NODE).join('<NODE>');
const STOP = new Error('the test has seen enough');

/** What this file wrote, to take away at the end. */
const mine = {
  addresses: [] as string[],
  orders: [] as string[],
  baskets: [] as string[],
  users: [] as string[],
};

type Said = Record<string, unknown>;

const who = (chain: ChainId, label: string) => mockAddress(chain, `snapshot-test:${RUN}:${label}`);

/** A chain in memory as a ChainSource, as chains.ts wraps one, and a record of what was asked of it. */
function world(chain: ChainId) {
  const adapter = createMockAdapter({ chain });
  const asked = { vaults: [] as string[], owners: [] as string[], prices: [] as string[][] };
  const source: ChainSource = {
    chain,
    name: `${chain} mock`,
    provenance: 'mock',
    source: 'chain-mock',
    listAssets: () => adapter.listAssets(),
    getPrices: (ids) => {
      asked.prices.push([...ids]);
      return adapter.getPrices(ids);
    },
    getVault: (vault) => {
      asked.vaults.push(vault);
      return adapter.getVault(vault);
    },
    getVaults: (owner) => {
      asked.owners.push(owner);
      return adapter.getVaults(owner);
    },
    rules: async () => ({ paused: null, lossCapBps: null, bandBps: adapter.mock.bandBps }),
    height: async () => BigInt(adapter.mock.now()),
  };
  return { chain, adapter, mock: adapter.mock, source, asked };
}
type World = ReturnType<typeof world>;

/**
 * Opens a vault on the mock as a buy does: 1,000 dollars in, spent on `buys` (dollars by asset slug),
 * whose shares are the targets. Answers the vault as the chain has it.
 */
async function openVault(
  w: World,
  owner: string,
  basketId: string,
  buys: Record<string, number> = { spy: 600, gold: 400 },
): Promise<VaultState> {
  const { adapter, mock, chain } = w;
  const depositRaw = '1000000000';
  mock.fund(owner, { gasRaw: '1000000000000000000', assets: { [mock.cash]: depositRaw } });
  const targets = Object.entries(buys).map(([slug, usd]) => ({
    asset: `${chain}:${slug}`,
    weightBps: usd * 10,
  }));
  const trades = Object.entries(buys).map(([slug, usd]) => ({
    sell: mock.cash,
    buy: `${chain}:${slug}`,
    amountInRaw: String(usd * 1_000_000),
  }));
  const create = { owner, basketId, targets, autoFollow: false, depositRaw, slippageBps: 50 };
  if (adapter.capabilities.needsApprove)
    await mock.send(await adapter.buildApprove({ owner, basketId, amountRaw: depositRaw }));
  if (adapter.capabilities.tradesInCreate)
    await mock.send(await adapter.buildCreateVault({ ...create, trades }));
  else {
    await mock.send(await adapter.buildCreateVault(create));
    const opened = (await adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    for (const trade of trades)
      await mock.send(
        await adapter.buildOwnerSwap({
          vault: opened?.address ?? '',
          trades: [trade],
          slippageBps: 50,
        }),
      );
  }
  const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === basketId);
  if (!vault) throw new Error('the mock did not open the vault');
  mine.addresses.push(vault.address);
  return vault;
}

/** A `vaults` row as the API's cache writes one after a read. */
async function cacheRow(
  v: Pick<VaultState, 'chain' | 'address' | 'owner' | 'basketId'> & Partial<VaultState>,
  over: { provenance?: Provenance; basketId?: string } = {},
): Promise<void> {
  const cash = v.cash ?? { asset: `${v.chain}:usdc`, raw: '0', multiplier: '1', display: '0' };
  const positions = v.positions ?? [];
  await db.insert(vaults).values({
    chainId: v.chain,
    address: v.address,
    owner: v.owner,
    basketId: over.basketId ?? null,
    onchainBasketId: v.basketId,
    acceptedVersion: v.acceptedVersion ?? 0,
    autoFollow: v.autoFollow ?? false,
    targets: positions
      .filter((p) => p.targetBps > 0)
      .map((p) => ({ asset: p.asset, weightBps: p.targetBps })),
    balances: { cash, positions },
    valueUsd: null,
    observedAt: new Date(v.observedAt ?? T0),
    provenance: over.provenance ?? 'mock',
  });
  if (!mine.addresses.includes(v.address)) mine.addresses.push(v.address);
}

async function person(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ privyId: `snapshot-test:${RUN}:${mine.users.length}` })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert');
  mine.users.push(row.id);
  return row.id;
}

/** A person's wallet, as `user_wallets` will hold one. */
async function wallet(chain: ChainId, address: string): Promise<void> {
  await db
    .insert(userWallets)
    .values({ userId: await person(), family: chainFamily(chain), address, kind: 'external' });
}

/** A plan's row, for a `vaults` row to be joined to. */
async function plan(): Promise<string> {
  const [row] = await db
    .insert(baskets)
    .values({ userId: await person(), kind: 'personal' })
    .returning({ id: baskets.id });
  if (!row) throw new Error('basket insert');
  mine.baskets.push(row.id);
  return row.id;
}

/** An order of `owner` with one confirmed step on `chain`, as a buy that went through leaves it. */
async function confirmedOrder(
  chain: ChainId,
  owner: string,
  provenance: Provenance = 'mock',
): Promise<void> {
  const solana = chainFamily(chain) === 'solana';
  const [order] = await db
    .insert(orders)
    .values({
      type: 'buy',
      ownerSolana: solana ? owner : null,
      ownerEvm: solana ? null : owner,
      summary: 'a buy, for the snapshot tests',
      request: { type: 'buy' } as unknown as IntentRequest,
      preparedBy: 'api',
      status: 'done',
      expiresAt: new Date(T0),
      disclaimer: DISCLAIMER.en,
    })
    .returning({ id: orders.id });
  if (!order) throw new Error('order insert');
  mine.orders.push(order.id);
  await db.insert(legs).values({
    orderId: order.id,
    chainId: chain,
    seq: 0,
    kind: 'create_vault',
    signer: 'owner',
    description: 'Open the vault for this plan',
    trades: [],
    status: 'confirmed',
    trigger: 'manual',
    provenance,
  });
}

const rowsOf = (chain: ChainId, address: string) =>
  db
    .select()
    .from(vaultSnapshots)
    .where(and(eq(vaultSnapshots.chainId, chain), eq(vaultSnapshots.address, address)))
    .orderBy(asc(vaultSnapshots.observedAt));

/**
 * One test's worker: a clock inside the test's own three hours of the made-up days, the lines it
 * said, and the runs it opened.
 */
function stage(slot: number) {
  const from = T0 + slot * SLOT;
  let ms = from;
  const lines: Said[] = [];
  const clock = {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
  };
  const out = (line: string) => {
    lines.push(JSON.parse(line) as Said);
  };
  const ctx = (over: Partial<PassContext> = {}): PassContext => ({
    db,
    dryRun: false,
    hide,
    out,
    now: clock.now,
    // What run.ts gives a worker on the ten-minute interval, and one started with --once.
    staleRunMs: STALE_RUN_MIN_MS,
    ...over,
  });
  const runs = (chain: ChainId) =>
    db
      .select()
      .from(snapshotRuns)
      .where(
        and(
          eq(snapshotRuns.chainId, chain),
          gte(snapshotRuns.startedAt, new Date(from)),
          lt(snapshotRuns.startedAt, new Date(from + SLOT)),
        ),
      )
      .orderBy(asc(snapshotRuns.startedAt));
  /** The lines about one vault, or one owner. */
  const about = (address: string) =>
    lines.filter((l) => l.vault === address || l.owner === address);
  /** Ten minutes later, on the worker's clock and on the chain's. */
  const tick = (worlds: World[], seconds = 600) => {
    clock.advance(seconds * 1_000);
    for (const w of worlds) w.mock.advance(seconds);
  };
  return { clock, lines, out, ctx, runs, about, tick };
}

/**
 * A sleep for `loops` loops side by side. A round is over when every loop waits; `between` then runs,
 * and after `total` rounds every loop is ended with STOP. Whatever `between` throws ends them too, so
 * an assertion that fails in it fails the test.
 */
function rounds(
  loops: number,
  total: number,
  between: (round: number) => Promise<void> | void = () => {},
) {
  const waiting: { ms: number; go: () => void; stop: (e: unknown) => void }[] = [];
  const waited: number[][] = [];
  const sleep = (ms: number) =>
    new Promise<void>((go, stop) => {
      waiting.push({ ms, go, stop });
      if (waiting.length < loops) return;
      const round = waiting.splice(0);
      waited.push(round.map((w) => w.ms).sort((a, b) => a - b));
      Promise.resolve()
        .then(() => between(waited.length))
        .then(
          () => {
            for (const w of round) waited.length >= total ? w.stop(STOP) : w.go();
          },
          (e: unknown) => {
            for (const w of round) w.stop(e);
          },
        );
    });
  return { sleep, waited };
}

const count = <T>(items: T[], item: T) => items.filter((i) => i === item).length;

// The hook's limit is two minutes, not the usual ten seconds: a second run of this file waits here
// for the first to end.
beforeAll(async () => {
  // Before anything else: the queries below would already cross another run's.
  lock = await client.reserve();
  await lock`select pg_advisory_lock(${LOCK})`;
  await seedChains(db, parseChainConfigs({}));
  // A run a killed test left open would make every pass here another worker's.
  await closeOpenRuns(db, ['solana', 'robinhood', 'base'], new Date());
}, 120_000);

// A run a test leaves open, by design or by failing half way, is not the next test's to trip on.
afterEach(async () => {
  await closeOpenRuns(db, ['solana', 'robinhood', 'base'], new Date());
});

afterAll(async () => {
  try {
    if (mine.addresses.length) {
      await db.delete(vaultSnapshots).where(inArray(vaultSnapshots.address, mine.addresses));
      await db.delete(vaults).where(inArray(vaults.address, mine.addresses));
    }
    if (mine.orders.length) {
      await db.delete(legs).where(inArray(legs.orderId, mine.orders));
      await db.delete(orders).where(inArray(orders.id, mine.orders));
    }
    if (mine.baskets.length) await db.delete(baskets).where(inArray(baskets.id, mine.baskets));
    if (mine.users.length) {
      await db.delete(userWallets).where(inArray(userWallets.userId, mine.users));
      await db.delete(users).where(inArray(users.id, mine.users));
    }
    // This file's runs: started inside its made-up days, or ended inside them. The second is for
    // the day a change makes the worker stamp a run's start with another clock, so its rows still
    // go.
    const inSpan = (at: typeof snapshotRuns.startedAt | typeof snapshotRuns.finishedAt) =>
      and(gte(at, new Date(T0)), lt(at, new Date(T0 + SPAN)));
    await db
      .delete(snapshotRuns)
      .where(or(inSpan(snapshotRuns.startedAt), inSpan(snapshotRuns.finishedAt)));
  } finally {
    // The next run may start only once this one's rows are gone.
    if (lock) {
      await lock`select pg_advisory_unlock(${LOCK})`;
      lock.release();
    }
    await client.end();
  }
});

describe('a pass over a chain', () => {
  it('keeps one row per vault per pass, valued on the prices of that pass, each price with where it came from', async () => {
    const s = stage(0);
    const w = world('solana');
    // One vault the API's cache names, joined to its plan; one that only its owner's wallet leads to.
    const cached = await openVault(w, who('solana', 't1-cached'), '1');
    const found = await openVault(w, who('solana', 't1-found'), '2');
    const basketId = await plan();
    await cacheRow(cached, { basketId });
    await wallet('solana', found.owner);
    // And one that holds spy alone: its row keeps the prices of what it holds, not of the pass.
    const narrow = await openVault(w, who('solana', 't1-narrow'), '1', { spy: 1_000 });
    await cacheRow(narrow);

    const state = newChainState();
    const heights: string[] = [];
    for (const spy of ['100', '110', '90']) {
      w.mock.setPrice('solana:spy', spy);
      heights.push(String(w.mock.now()));
      await snapshotChain(s.ctx(), w.source, state);
      s.tick([w]);
    }

    for (const vault of [cached, found]) {
      const rows = await rowsOf('solana', vault.address);
      // 5.994 spy and 1.998 gold at 200: the value moves as the price of spy did.
      expect(rows.map((r) => r.valueUsd)).toEqual(['999.00', '1058.94', '939.06']);
      expect(rows.map((r) => r.blockOrSlot)).toEqual(heights);
      for (const row of rows) {
        expect(row).toMatchObject({
          owner: vault.owner,
          onchainBasketId: vault.basketId,
          basketId: vault === cached ? basketId : null,
          recipeOnchainId: null,
          acceptedVersion: 0,
          autoFollow: false,
          lossUsedBps: 0,
          bandBps: 50,
          lossCapBps: null,
          paused: null,
          pending: null,
          provenance: 'mock',
          source: 'chain-mock',
          method: SNAPSHOT_METHOD,
        });
        expect(row.cash).toMatchObject({ asset: 'solana:usdc', raw: '0' });
        // The prices of what this vault holds, and nothing else, exactly as the chain gave them.
        expect(row.prices.map((p) => p.asset).sort()).toEqual([
          'solana:gold',
          'solana:spy',
          'solana:usdc',
        ]);
        for (const price of row.prices) {
          expect(price.source).toBe('chain-mock');
          expect(price.method.length).toBeGreaterThan(0);
          expect(price.fetchedAt).toBe(row.observedAt.toISOString());
          expect(price.provenance).toBe('mock');
        }
      }
      expect(rows.map((r) => r.prices.find((p) => p.asset === 'solana:spy')?.usdPerToken)).toEqual([
        '100',
        '110',
        '90',
      ]);
      // Weight, target and drift as view() gave them: on target at the price it was bought at.
      expect(
        rows[0]?.positions.map((p) => [p.asset, p.weightBps, p.targetBps, p.driftBps, p.valueUsd]),
      ).toEqual([
        ['solana:spy', 6000, 6000, 0, '599.4'],
        ['solana:gold', 4000, 4000, 0, '399.6'],
      ]);
      expect(rows[1]?.positions.map((p) => [p.weightBps, p.driftBps])).toEqual([
        [6226, 226],
        [3774, -226],
      ]);
      expect(s.about(vault.address)).toEqual(
        rows.map((row, i) => ({
          at: expect.any(String),
          chain: 'solana',
          name: 'solana mock',
          vault: vault.address,
          outcome: 'read',
          reason: '2 of 2 positions priced',
          observedAt: row.observedAt.toISOString(),
          valueUsd: row.valueUsd,
          blockOrSlot: heights[i],
          provenance: 'mock',
        })),
      );
    }

    const narrowRows = await rowsOf('solana', narrow.address);
    expect(narrowRows.map((r) => r.valueUsd)).toEqual(['999.00', '1098.90', '899.10']);
    for (const row of narrowRows)
      expect(row.prices.map((p) => p.asset).sort()).toEqual(['solana:spy', 'solana:usdc']);

    // Each owner was asked once, at the first pass; after it both vaults are read by their address.
    expect(count(w.asked.owners, cached.owner)).toBe(1);
    expect(count(w.asked.owners, found.owner)).toBe(1);
    expect(count(w.asked.vaults, cached.address)).toBe(2);
    expect(count(w.asked.vaults, found.address)).toBe(2);
    // One read of prices a pass, for everything held.
    expect(w.asked.prices.map((ids) => [...ids].sort())).toEqual(
      Array(3).fill(['solana:gold', 'solana:spy', 'solana:usdc']),
    );

    const runs = await s.runs('solana');
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run).toMatchObject({ vaultsRead: 3, error: null, provenance: 'mock' });
      expect(run.finishedAt).not.toBeNull();
    }
    const passes = s.lines.filter((l) => l.pass);
    expect(passes).toHaveLength(3);
    for (const p of passes) expect(p).toMatchObject({ pass: 'done', read: 3, dryRun: false });
  });

  it('writes the same read once: a second pass at the same time adds no row', async () => {
    const s = stage(1);
    const w = world('solana');
    const vault = await openVault(w, who('solana', 't7'), '1');
    await cacheRow(vault);
    const state = newChainState();
    await snapshotChain(s.ctx(), w.source, state);
    // The chain's clock has not moved, so the vault is observed at the same time again.
    s.clock.advance(600_000);
    await snapshotChain(s.ctx(), w.source, state);
    expect(await rowsOf('solana', vault.address)).toHaveLength(1);
    expect(s.about(vault.address).map((l) => l.outcome)).toEqual(['read', 'read']);
    w.mock.advance(1);
    await snapshotChain(s.ctx(), w.source, state);
    expect(await rowsOf('solana', vault.address)).toHaveLength(2);
  });

  it('finds a vault its owner opened by asking the owner again, once the hour has passed, and a new owner at once', async () => {
    const s = stage(2);
    const w = world('solana');
    const owner = who('solana', 't3-owner');
    const first = await openVault(w, owner, '1');
    await wallet('solana', owner);
    const state = newChainState();
    const pass = () => snapshotChain(s.ctx(), w.source, state);

    await pass();
    expect(await rowsOf('solana', first.address)).toHaveLength(1);

    // The owner opens a second vault, outside the app: no `vaults` row names it.
    const second = await openVault(w, owner, '2');
    s.tick([w]);
    await pass();
    expect(await rowsOf('solana', second.address)).toHaveLength(0);
    expect(s.about(second.address)).toEqual([]);
    expect(count(w.asked.owners, owner)).toBe(1);

    // Fifty minutes more: an hour since every owner was asked.
    s.tick([w], 3_000);
    await pass();
    expect(count(w.asked.owners, owner)).toBe(2);
    expect(await rowsOf('solana', second.address)).toHaveLength(1);
    expect(count(w.asked.vaults, second.address)).toBe(0);

    // From then on it is read by its address, and the owner is left alone.
    s.tick([w]);
    await pass();
    expect(count(w.asked.owners, owner)).toBe(2);
    expect(count(w.asked.vaults, second.address)).toBe(1);
    expect(await rowsOf('solana', second.address)).toHaveLength(2);

    // A new owner, known by an order whose step was confirmed: asked at the next pass, inside the hour.
    const buyer = who('solana', 't3-buyer');
    const bought = await openVault(w, buyer, '1');
    s.tick([w]);
    await pass();
    expect(count(w.asked.owners, buyer)).toBe(0);
    await confirmedOrder('solana', buyer);
    s.tick([w]);
    await pass();
    expect(count(w.asked.owners, buyer)).toBe(1);
    expect(await rowsOf('solana', bought.address)).toHaveLength(1);

    // And one known by a `vaults` row: the vault of the row is read, and so is their other one.
    const holder = who('solana', 't3-holder');
    const named = await openVault(w, holder, '1');
    const other = await openVault(w, holder, '2');
    await cacheRow(named);
    s.tick([w]);
    await pass();
    expect(count(w.asked.owners, holder)).toBe(1);
    expect(await rowsOf('solana', named.address)).toHaveLength(1);
    expect(await rowsOf('solana', other.address)).toHaveLength(1);
    // Nobody else was asked again for it.
    expect(count(w.asked.owners, owner)).toBe(2);
    expect(count(w.asked.owners, buyer)).toBe(1);
  });

  it('skips an address with no vault once, and does not ask it again until the hour', async () => {
    const s = stage(3);
    const w = world('solana');
    const ghost = who('solana', 't6-ghost');
    await cacheRow({
      chain: 'solana',
      address: ghost,
      owner: who('solana', 't6-ghost-owner'),
      basketId: '1',
    });
    const state = newChainState();
    const pass = () => snapshotChain(s.ctx(), w.source, state);

    await pass();
    const skipped = {
      at: expect.any(String),
      chain: 'solana',
      name: 'solana mock',
      vault: ghost,
      outcome: 'skipped',
      reason: 'no vault at this address on solana mock',
    };
    expect(s.about(ghost)).toEqual([skipped]);
    expect(count(w.asked.vaults, ghost)).toBe(1);
    expect(s.lines.at(-1)).toMatchObject({ pass: 'done', read: 0 });
    expect(Number(s.lines.at(-1)?.skipped)).toBeGreaterThanOrEqual(1);

    s.tick([w]);
    await pass();
    expect(s.about(ghost)).toEqual([skipped]);
    expect(count(w.asked.vaults, ghost)).toBe(1);

    s.tick([w], 3_000);
    await pass();
    expect(s.about(ghost)).toEqual([skipped, skipped]);
    expect(count(w.asked.vaults, ghost)).toBe(2);
    expect(await rowsOf('solana', ghost)).toEqual([]);
  });

  it('reads by address a vault its owner led to, where the address had none before', async () => {
    const s = stage(21);
    const w = world('solana');
    const owner = who('solana', 't-late');
    // The cache names a vault the chain does not have yet: where this owner's plan 7 will be.
    const address = mockAddress('solana', `vault:${owner}:7`);
    await cacheRow({ chain: 'solana', address, owner, basketId: '7' });
    let refusals = 1;
    const flaky: ChainSource = {
      ...w.source,
      getVaults: async (o) => {
        if (o === owner && refusals-- > 0) throw new ChainError('Unknown', 'could not be decoded');
        return w.source.getVaults(o);
      },
    };
    const state = newChainState();
    await snapshotChain(s.ctx(), flaky, state);
    expect(s.about(address).map((l) => l.outcome)).toEqual(['skipped']);

    // The owner opens it. Asked again, since the first read failed, the owner leads to it.
    expect((await openVault(w, owner, '7')).address).toBe(address);
    s.tick([w]);
    await snapshotChain(s.ctx(), flaky, state);
    expect(await rowsOf('solana', address)).toHaveLength(1);
    expect(count(w.asked.vaults, address)).toBe(1);
    // And from then on its address is read, inside the hour.
    s.tick([w]);
    await snapshotChain(s.ctx(), flaky, state);
    expect(count(w.asked.vaults, address)).toBe(2);
    expect(await rowsOf('solana', address)).toHaveLength(2);
  });

  it("says a vault whose read throws as failed, writes the others, and keeps the node's address out", async () => {
    const s = stage(4);
    const w = world('solana');
    const good = await openVault(w, who('solana', 't6-good'), '1');
    const bad = await openVault(w, who('solana', 't6-bad'), '1');
    await cacheRow(good);
    await cacheRow(bad);
    const state = newChainState();
    await snapshotChain(s.ctx(), w.source, state);

    // The error is what a reader throws: the node's address in its message, and more of it in its cause.
    const secret = 'https://other.example/another-key';
    const flaky: ChainSource = {
      ...w.source,
      getVault: async (vault) => {
        if (vault !== bad.address) return w.source.getVault(vault);
        throw Object.assign(
          new ChainError('Unavailable', `request to ${NODE} failed, reason: socket hang up`),
          { cause: new Error(`HTTP request failed.\n\nURL: ${secret}`) },
        );
      },
    };
    s.tick([w]);
    await snapshotChain(s.ctx(), flaky, state);

    expect(s.about(bad.address).at(-1)).toEqual({
      at: expect.any(String),
      chain: 'solana',
      name: 'solana mock',
      vault: bad.address,
      outcome: 'failed',
      reason: 'Unavailable: request to <NODE> failed, reason: socket hang up',
    });
    expect(await rowsOf('solana', good.address)).toHaveLength(2);
    expect(await rowsOf('solana', bad.address)).toHaveLength(1);
    const said = JSON.stringify(s.lines);
    expect(said).not.toContain(NODE);
    expect(said).not.toContain(secret);
    expect(said).not.toContain('socket hang up"},"stack');
    // The pass went through: its run says one vault read, and counts the one that failed.
    const run = (await s.runs('solana')).at(-1);
    expect(run).toMatchObject({ vaultsRead: 1, error: null });
    expect(run?.vaultsFailed).toBeGreaterThanOrEqual(1);
    expect(s.lines.at(-1)).toMatchObject({ pass: 'done', read: 1 });
    expect(Number(s.lines.at(-1)?.failed)).toBeGreaterThanOrEqual(1);
  });

  it('says an owner whose read fails, goes on, and asks that owner again at the next pass', async () => {
    const s = stage(5);
    const w = world('solana');
    const vault = await openVault(w, who('solana', 't6-owner'), '1');
    await cacheRow(vault);
    let refusals = 1;
    const flaky: ChainSource = {
      ...w.source,
      getVaults: async (owner) => {
        if (owner === vault.owner && refusals-- > 0) {
          w.asked.owners.push(owner);
          throw new ChainError('Unknown', `the answer of ${NODE} could not be decoded`);
        }
        return w.source.getVaults(owner);
      },
    };
    const state = newChainState();
    await snapshotChain(s.ctx(), flaky, state);
    expect(s.about(vault.owner)).toEqual([
      {
        at: expect.any(String),
        chain: 'solana',
        name: 'solana mock',
        owner: vault.owner,
        outcome: 'failed',
        reason: 'Unknown: the answer of <NODE> could not be decoded',
      },
    ]);
    // The vault is known by its address, and is read all the same.
    expect(await rowsOf('solana', vault.address)).toHaveLength(1);
    expect(s.lines.at(-1)).toMatchObject({ pass: 'done', read: 1 });

    s.tick([w]);
    await snapshotChain(s.ctx(), flaky, state);
    expect(count(w.asked.owners, vault.owner)).toBe(2);
    s.tick([w]);
    await snapshotChain(s.ctx(), flaky, state);
    expect(count(w.asked.owners, vault.owner)).toBe(2);

    // The same when it is the hourly read that fails: the owner is not left for the next hour.
    refusals = 1;
    s.tick([w], 3_600);
    await snapshotChain(s.ctx(), flaky, state);
    expect(count(w.asked.owners, vault.owner)).toBe(3);
    s.tick([w]);
    await snapshotChain(s.ctx(), flaky, state);
    expect(count(w.asked.owners, vault.owner)).toBe(4);
  });

  it('fails the pass when no vault at all could be read and the chain did not answer', async () => {
    const s = stage(6);
    const w = world('solana');
    const vault = await openVault(w, who('solana', 't-down'), '1');
    await cacheRow(vault);
    const refuse = async (): Promise<never> => {
      throw new ChainError('Unavailable', `request to ${NODE} failed`);
    };
    const down: ChainSource = { ...w.source, getVault: refuse, getVaults: refuse };
    await expect(snapshotChain(s.ctx(), down, newChainState())).rejects.toThrow(
      'no vault could be read: Unavailable: request to <NODE> failed',
    );
    const [run] = await s.runs('solana');
    expect(run).toMatchObject({
      vaultsRead: 0,
      error: 'no vault could be read: Unavailable: request to <NODE> failed',
    });
    expect(run?.finishedAt).not.toBeNull();
    expect(s.about(vault.address).map((l) => l.outcome)).toEqual(['failed']);
    expect(s.lines.some((l) => l.pass)).toBe(false);
    expect(await rowsOf('solana', vault.address)).toEqual([]);
  });

  it('fails the pass when no vault was read and one failed, whatever the reason; one read beside one failed is a good pass', async () => {
    const s = stage(26);
    const w = world('solana');
    const one = await openVault(w, who('solana', 't-none-1'), '1');
    const two = await openVault(w, who('solana', 't-none-2'), '1');
    await cacheRow(one);
    await cacheRow(two);
    const broken = new Set<string>();
    let gold: ChainError | null = null;
    // What a reader says of an account it cannot decode. The chain answered: it is not
    // `Unavailable`.
    const undecoded = () => new ChainError('Unknown', 'the vault account could not be decoded');
    const odd: ChainSource = {
      ...w.source,
      getVaults: async (owner) => {
        if (broken.has(owner)) throw undecoded();
        return w.source.getVaults(owner);
      },
      getVault: async (vault) => {
        if (broken.has(vault)) throw undecoded();
        return w.source.getVault(vault);
      },
      getPrices: async (ids) => {
        if (gold && ids.includes('solana:gold')) throw gold;
        return w.source.getPrices(ids);
      },
    };
    const failedPass = /^no vault was read: 2 failed$/;
    const pass = () => snapshotChain(s.ctx(), odd, newChainState());

    // One vault cannot be read and the other is: the pass is a good one, as before.
    broken.add(one.owner).add(one.address);
    await expect(pass()).resolves.toEqual({
      outcome: 'done',
      read: 1,
      failed: 1,
      skipped: expect.any(Number),
    });
    expect((await s.runs('solana')).at(-1)).toMatchObject({
      vaultsRead: 1,
      vaultsFailed: 1,
      error: null,
    });

    // Neither can be read. Nothing was kept of the chain: the pass failed, and its run says so.
    broken.add(two.owner).add(two.address);
    s.tick([w]);
    await expect(pass()).rejects.toThrow(failedPass);
    const run = (await s.runs('solana')).at(-1);
    expect(run).toMatchObject({
      vaultsRead: 0,
      vaultsFailed: 2,
      error: 'no vault was read: 2 failed',
    });
    expect(run?.finishedAt).not.toBeNull();
    for (const vault of [one, two])
      expect(s.about(vault.address).at(-1)).toMatchObject({
        outcome: 'failed',
        reason: 'Unknown: the vault account could not be decoded',
      });
    expect(s.lines.filter((l) => l.pass)).toHaveLength(1);
    expect(await rowsOf('solana', one.address)).toEqual([]);
    expect(await rowsOf('solana', two.address)).toHaveLength(1);

    // Both are read, and neither can be valued: the price of what both hold was refused, while the
    // other prices answered. That is no row either, and a failed pass.
    broken.clear();
    gold = new ChainError('Unavailable', `request to ${NODE} failed`);
    s.tick([w]);
    await expect(pass()).rejects.toThrow(failedPass);
    expect((await s.runs('solana')).at(-1)).toMatchObject({
      vaultsRead: 0,
      vaultsFailed: 2,
      error: 'no vault was read: 2 failed',
    });
    expect(s.about(two.address).at(-1)).toMatchObject({
      outcome: 'failed',
      reason:
        'the price of solana:gold could not be read (Unavailable: request to <NODE> failed), so the vault was not valued',
    });
    expect(await rowsOf('solana', two.address)).toHaveLength(1);

    // The chain is well again, and so is the pass.
    gold = null;
    s.tick([w]);
    await expect(pass()).resolves.toMatchObject({ outcome: 'done', read: 2, failed: 0 });
  });

  it('fails the pass when the database takes no row of any vault, and still closes its run', async () => {
    const s = stage(27);
    const w = world('robinhood');
    const one = await openVault(w, who('robinhood', 't-unwritten-1'), '1');
    const two = await openVault(w, who('robinhood', 't-unwritten-2'), '1');
    await cacheRow(one);
    await cacheRow(two);
    // A database that takes the run and refuses every snapshot, as Drizzle says a query that
    // failed: a role with no grant on `vault_snapshots` would be refused so.
    const refusing = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'insert') return Reflect.get(target, key, receiver);
        return (table: Parameters<typeof db.insert>[0]) => {
          if (table !== vaultSnapshots) return target.insert(table);
          throw new DrizzleQueryError(
            'insert into "vault_snapshots" ("chain_id", "address") values ($1, $2)',
            [],
            Object.assign(new Error('permission denied for table vault_snapshots'), {
              code: '42501',
            }),
          );
        };
      },
    });

    // A dry run writes nothing, so nothing is refused: a vault read and valued counts as read.
    await expect(
      snapshotChain(s.ctx({ db: refusing, dryRun: true }), w.source, newChainState()),
    ).resolves.toMatchObject({ outcome: 'done', read: 2, failed: 0 });
    expect(await s.runs('robinhood')).toEqual([]);

    await expect(snapshotChain(s.ctx({ db: refusing }), w.source, newChainState())).rejects.toThrow(
      /^no vault was read: 2 failed$/,
    );
    for (const vault of [one, two]) {
      expect(s.about(vault.address).map((l) => [l.outcome, l.reason])).toEqual([
        ['read', '2 of 2 positions priced'],
        ['failed', 'the database did not take a query (42501)'],
      ]);
      expect(await rowsOf('robinhood', vault.address)).toEqual([]);
    }
    // The run was opened and is closed, with what failed and why the pass did.
    const runs = await s.runs('robinhood');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      vaultsRead: 0,
      vaultsFailed: 2,
      error: 'no vault was read: 2 failed',
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
    // One pass line, the dry run's: the pass that failed said none.
    expect(s.lines.filter((l) => l.pass)).toHaveLength(1);
  });

  it('backs off and pings the failure for a chain none of whose vaults was read, and with the loop off the worker fails', async () => {
    const s = stage(28);
    const w = world('base');
    const vault = await openVault(w, who('base', 't-none-loop'), '1');
    await cacheRow(vault);
    let broken = true;
    const refuse = () => new ChainError('Unknown', 'the vault could not be decoded');
    const odd: ChainSource = {
      ...w.source,
      getVaults: async (owner) => {
        if (broken && owner === vault.owner) throw refuse();
        return w.source.getVaults(owner);
      },
      getVault: async (address) => {
        if (broken && address === vault.address) throw refuse();
        return w.source.getVault(address);
      },
    };
    const reason = 'no vault was read: 1 failed';
    const pings: boolean[] = [];
    const worker = (loop: boolean, sleep?: (ms: number) => Promise<void>) =>
      runSnapshots({
        sources: [odd],
        db,
        loop,
        dryRun: false,
        intervalMs: 600_000,
        out: s.out,
        now: s.clock.now,
        sleep,
        ping: async (ok) => {
          pings.push(ok);
        },
      });

    // In the loop: the pass that read nothing is followed by another after 15 s, which reads.
    const r = rounds(1, 2, () => {
      broken = false;
      s.tick([w], 15);
    });
    await expect(worker(true, r.sleep)).rejects.toBe(STOP);
    expect(r.waited).toEqual([[15_000], [600_000]]);
    expect(pings).toEqual([false, true]);
    expect(s.lines.filter((l) => l.outcome === 'round-failed')).toEqual([
      expect.objectContaining({ chain: 'base', reason, alert: true, failures: 1, retryInS: 15 }),
    ]);
    const [failed, read] = await s.runs('base');
    expect(failed).toMatchObject({ vaultsRead: 0, vaultsFailed: 1, error: reason });
    expect(read).toMatchObject({ vaultsRead: 1, vaultsFailed: 0, error: null });
    expect(await rowsOf('base', vault.address)).toHaveLength(1);

    // With the loop off, which is --once: the worker ends on it, and main.ts exits with 1.
    broken = true;
    s.tick([w]);
    await expect(worker(false)).rejects.toThrow(
      `1 of 1 chains failed their pass: base mock: ${reason}`,
    );
    expect(pings).toEqual([false, true, false]);
  });

  it('asks for prices asset by asset when the one read is refused, and never values a vault on a price the chain did not answer for', async () => {
    const s = stage(7);
    const w = world('solana');
    const mixed = await openVault(w, who('solana', 't-prices-mixed'), '1');
    const spyOnly = await openVault(w, who('solana', 't-prices-spy'), '1', { spy: 1_000 });
    await cacheRow(mixed);
    await cacheRow(spyOnly);
    let gold: ChainError = new ChainError('AssetNotPriced', 'solana:gold has no price');
    const patchy: ChainSource = {
      ...w.source,
      getPrices: async (ids) => {
        if (ids.includes('solana:gold')) throw gold;
        return w.source.getPrices(ids);
      },
    };
    const state = newChainState();

    // The chain has no price for gold: that is an answer, and gold is kept with no value.
    await snapshotChain(s.ctx(), patchy, state);
    const [unpriced] = await rowsOf('solana', mixed.address);
    expect(unpriced?.valueUsd).toBe('599.40');
    expect(unpriced?.positions.map((p) => [p.asset, p.valueUsd, p.weightBps])).toEqual([
      ['solana:spy', '599.4', 10_000],
      ['solana:gold', null, 0],
    ]);
    expect(unpriced?.prices.map((p) => p.asset).sort()).toEqual(['solana:spy', 'solana:usdc']);
    expect(s.about(mixed.address).at(-1)).toMatchObject({
      outcome: 'read',
      reason: '1 of 2 positions priced',
    });
    expect(await rowsOf('solana', spyOnly.address)).toHaveLength(1);

    // The chain did not answer for gold: the vault that holds it is not valued, the other is.
    gold = new ChainError('Unavailable', `request to ${NODE} failed`);
    s.tick([w]);
    await snapshotChain(s.ctx(), patchy, state);
    expect(s.about(mixed.address).at(-1)).toMatchObject({
      outcome: 'failed',
      reason:
        'the price of solana:gold could not be read (Unavailable: request to <NODE> failed), so the vault was not valued',
    });
    expect(await rowsOf('solana', mixed.address)).toHaveLength(1);
    expect(await rowsOf('solana', spyOnly.address)).toHaveLength(2);
    expect(s.lines.at(-1)).toMatchObject({ pass: 'done', read: 1 });

    // No price at all, and the chain did not answer: the pass fails.
    const dark: ChainSource = {
      ...w.source,
      getPrices: async () => {
        throw new ChainError('Unavailable', `request to ${NODE} failed`);
      },
    };
    s.tick([w]);
    await expect(snapshotChain(s.ctx(), dark, state)).rejects.toThrow(
      'no price could be read: Unavailable: request to <NODE> failed',
    );
    expect((await s.runs('solana')).at(-1)).toMatchObject({
      vaultsRead: 0,
      error: 'no price could be read: Unavailable: request to <NODE> failed',
    });
    expect(await rowsOf('solana', spyOnly.address)).toHaveLength(2);
  });

  it('never asks a test network for a vault the mock made', async () => {
    const s = stage(8);
    const w = world('solana');
    const mocked = await openVault(w, who('solana', 't8-mock'), '1');
    const tested = await openVault(w, who('solana', 't8-sandbox'), '1');
    const buyer = who('solana', 't8-mock-buyer');
    const bought = await openVault(w, buyer, '1');
    await cacheRow(mocked);
    await cacheRow(tested, { provenance: 'sandbox' });
    await confirmedOrder('solana', buyer, 'mock');
    // The same database, read by a worker on a test network. Nothing is written: a dry run.
    const sandbox: ChainSource = { ...w.source, name: 'Solana devnet', provenance: 'sandbox' };
    await snapshotChain(s.ctx({ dryRun: true }), sandbox, newChainState());

    expect(count(w.asked.vaults, mocked.address)).toBe(0);
    expect(count(w.asked.owners, mocked.owner)).toBe(0);
    expect(count(w.asked.owners, buyer)).toBe(0);
    expect(s.about(mocked.address)).toEqual([]);
    expect(s.about(bought.address)).toEqual([]);
    expect(s.about(tested.address)).toEqual([
      expect.objectContaining({ outcome: 'read', provenance: 'sandbox', name: 'Solana devnet' }),
    ]);
  });

  it('asks a chain only for our people on it: wallets of its family, and orders confirmed on it', async () => {
    const s = stage(16);
    const sol = world('solana');
    const rh = world('robinhood');
    const base = world('base');
    // A wallet is asked on every chain of its family, and on no chain of the other.
    const evmWallet = who('robinhood', 't-owners-wallet');
    const solWallet = who('solana', 't-owners-wallet');
    await wallet('robinhood', evmWallet);
    await wallet('solana', solWallet);
    // A buyer is asked on the chain the step was confirmed on, and only once it was.
    const onBase = who('base', 't-owners-base');
    const notYet = who('base', 't-owners-built');
    await confirmedOrder('base', onBase);
    await confirmedOrder('base', notYet);
    await db
      .update(legs)
      .set({ status: 'built' })
      .where(eq(legs.orderId, mine.orders.at(-1) ?? ''));

    for (const w of [sol, rh, base])
      await snapshotChain(s.ctx({ dryRun: true }), w.source, newChainState());
    const askedOn = (address: string) =>
      [sol, rh, base].filter((w) => w.asked.owners.includes(address)).map((w) => w.chain);
    expect(askedOn(evmWallet)).toEqual(['robinhood', 'base']);
    expect(askedOn(solWallet)).toEqual(['solana']);
    expect(askedOn(onBase)).toEqual(['base']);
    expect(askedOn(notYet)).toEqual([]);
    // Nobody was a failed line for being asked on the wrong chain.
    expect(s.lines.filter((l) => l.owner !== undefined)).toEqual([]);
  });

  it('reads again, after a restart, what it had written before: by address, under the same label', async () => {
    const s = stage(17);
    const w = world('solana');
    const vault = await openVault(w, who('solana', 't-restart'), '1');
    await cacheRow(vault);
    await snapshotChain(s.ctx(), w.source, newChainState());
    expect(await rowsOf('solana', vault.address)).toHaveLength(1);

    // The cache forgets the vault, and with it the owner. Only the snapshot rows name it now.
    await db.delete(vaults).where(eq(vaults.address, vault.address));
    s.tick([w]);
    // A worker on a test network starts on the same database: the row is the mock's, not its own.
    const sandbox: ChainSource = { ...w.source, name: 'Solana devnet', provenance: 'sandbox' };
    await snapshotChain(s.ctx({ dryRun: true }), sandbox, newChainState());
    expect(count(w.asked.vaults, vault.address)).toBe(0);
    // The mock's worker starts again, with nothing in memory.
    await snapshotChain(s.ctx(), w.source, newChainState());
    expect(count(w.asked.vaults, vault.address)).toBe(1);
    expect(count(w.asked.owners, vault.owner)).toBe(1);
    expect(await rowsOf('solana', vault.address)).toHaveLength(2);
  });

  it('lists the addresses it has snapshotted on a chain under a label, each once, by stepping through them', async () => {
    // The list is read one address at a time off the unique key, not as a DISTINCT over every row
    // (store.ts says why). So this gives each address several rows, which a step that went row by
    // row would answer several times, and sets the two labels among each other in the key's order,
    // so a step has to pass over a whole address of the other label and still find the next of its
    // own.
    const addresses = Array.from({ length: 8 }, (_, i) => who('solana', `t-addresses-${i}`)).sort();
    const labelOf = (i: number): Provenance => (i % 3 === 1 ? 'sandbox' : 'mock');
    const row = (address: string, provenance: Provenance, at: number): SnapshotRow => ({
      chainId: 'solana',
      address,
      observedAt: new Date(at),
      blockOrSlot: null,
      owner: who('solana', 't-addresses-owner'),
      basketId: null,
      onchainBasketId: '1',
      recipeOnchainId: null,
      acceptedVersion: 0,
      autoFollow: false,
      valueUsd: '0.00',
      cash: { asset: 'solana:usdc', raw: '0', multiplier: '1', display: '0' },
      positions: [],
      pending: null,
      lossUsedBps: 0,
      prices: [],
      provenance,
      source: 'a row made by pipeline.test.ts for the list of addresses',
      method: SNAPSHOT_METHOD,
    });
    mine.addresses.push(...addresses);
    for (const [i, address] of addresses.entries())
      for (let pass = 0; pass < 3; pass++)
        await insertSnapshot(db, row(address, labelOf(i), T0 + 29 * SLOT + pass * 600_000));

    for (const label of ['mock', 'sandbox'] as const) {
      const listed = await snapshottedAddresses(db, 'solana', label);
      expect(new Set(listed).size, label).toBe(listed.length);
      expect(listed.filter((a) => addresses.includes(a)).sort(), label).toEqual(
        addresses.filter((_, i) => labelOf(i) === label),
      );
    }
    // Another chain's list has none of them.
    const elsewhere = await snapshottedAddresses(db, 'robinhood', 'mock');
    expect(elsewhere.filter((a) => addresses.includes(a))).toEqual([]);

    // And the read is the one stepping query: nothing asks for a DISTINCT over the rows.
    const asked: (string | symbol)[] = [];
    const watched = new Proxy(db, {
      get(target, key, receiver) {
        asked.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    await snapshottedAddresses(watched, 'solana', 'mock');
    expect(asked).toContain('execute');
    expect(asked.filter((key) => String(key).startsWith('select'))).toEqual([]);
  });

  it('keeps a token the chain shows and the list does not have, with no value, and asks no price for it', async () => {
    const s = stage(18);
    const w = world('solana');
    const vault = await openVault(w, who('solana', 't-unlisted'), '1');
    await cacheRow(vault);
    // The list this worker runs with has no gold. Asking a price for it refuses the whole read.
    const short: ChainSource = {
      ...w.source,
      listAssets: async () => (await w.source.listAssets()).filter((a) => a.id !== 'solana:gold'),
      getPrices: async (ids) => {
        if (ids.includes('solana:gold'))
          throw new ChainError('MintNotAccepted', 'solana:gold is not listed on Solana');
        return w.source.getPrices(ids);
      },
    };
    await snapshotChain(s.ctx(), short, newChainState());
    expect(w.asked.prices.map((ids) => [...ids].sort())).toEqual([['solana:spy', 'solana:usdc']]);
    const [row] = await rowsOf('solana', vault.address);
    expect(row?.valueUsd).toBe('599.40');
    expect(row?.positions.map((p) => [p.asset, p.valueUsd])).toEqual([
      ['solana:spy', '599.4'],
      ['solana:gold', null],
    ]);
    expect(s.about(vault.address)).toEqual([
      expect.objectContaining({ outcome: 'read', reason: '1 of 2 positions priced' }),
    ]);
  });

  it('reads a few vaults at a time, and never more', async () => {
    const s = stage(19);
    const w = world('base');
    const owner = who('base', 't-many-owner');
    for (let i = 0; i < 10; i++)
      await cacheRow({
        chain: 'base',
        address: who('base', `t-many-${i}`),
        owner,
        basketId: String(i),
      });
    let inFlight = 0;
    let most = 0;
    const slow: ChainSource = {
      ...w.source,
      getVault: async (vault) => {
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return w.source.getVault(vault);
      },
    };
    await snapshotChain(s.ctx({ dryRun: true }), slow, newChainState());
    expect(most).toBe(READS_AT_ONCE);
    expect(READS_AT_ONCE).toBe(4);
    expect(s.lines.filter((l) => l.outcome === 'skipped').length).toBeGreaterThanOrEqual(10);
  });

  it('brings the sample world up to the pass before anything is read from the chain', async () => {
    const s = stage(9);
    const w = world('solana');
    const vault = await openVault(w, who('solana', 't-prepare'), '1');
    await cacheRow(vault);
    const order: string[] = [];
    const told: { addresses: string[]; now: Date }[] = [];
    const sample: ChainSource = {
      ...w.source,
      prepare: async (known, now) => {
        order.push('prepare');
        told.push({ addresses: known.map((k) => k.address), now });
        return [];
      },
      height: () => {
        order.push('height');
        return w.source.height();
      },
      listAssets: () => {
        order.push('listAssets');
        return w.source.listAssets();
      },
      getVaults: (owner) => {
        order.push('getVaults');
        return w.source.getVaults(owner);
      },
    };
    await snapshotChain(s.ctx({ dryRun: true }), sample, newChainState());
    expect(order.slice(0, 3)).toEqual(['prepare', 'height', 'listAssets']);
    expect(told).toHaveLength(1);
    expect(told[0]?.addresses).toContain(vault.address);
    expect(told[0]?.now).toEqual(s.clock.now());
  });

  it('reads a vault the sample world answers that nothing in the database names, at that pass and after', async () => {
    const s = stage(22);
    const w = world('solana');
    // On the chain, and in no row: no `vaults` row, no order, no wallet of its owner.
    const sample = await openVault(w, who('solana', 't-sample'), '1');
    const silent: ChainSource = { ...w.source, prepare: async () => [] };
    await snapshotChain(s.ctx(), silent, newChainState());
    expect(s.about(sample.address)).toEqual([]);

    const answering: ChainSource = { ...w.source, prepare: async () => [sample.address] };
    const state = newChainState();
    s.tick([w]);
    await snapshotChain(s.ctx(), answering, state);
    expect(s.about(sample.address).map((l) => l.outcome)).toEqual(['read']);
    expect(await rowsOf('solana', sample.address)).toHaveLength(1);

    // Read by address from then on, as any vault the worker has found.
    s.tick([w]);
    await snapshotChain(s.ctx(), silent, state);
    expect(await rowsOf('solana', sample.address)).toHaveLength(2);
  });
});

describe('a run of this worker and of another', () => {
  it('skips the pass, with one line, while another worker holds the open run; a start closes what was left open', async () => {
    const s = stage(10);
    const w = world('robinhood');
    const vault = await openVault(w, who('robinhood', 't5'), '1');
    await cacheRow(vault);
    const theirs = await openRun(db, 'robinhood', 'mock', s.clock.now());
    expect(theirs).not.toBeNull();
    s.clock.advance(1_000);

    await expect(snapshotChain(s.ctx(), w.source, newChainState())).resolves.toEqual({
      outcome: 'skipped',
    });
    expect(s.lines).toEqual([
      {
        at: expect.any(String),
        chain: 'robinhood',
        name: 'robinhood mock',
        pass: 'skipped',
        reason: 'another worker holds the open run on robinhood mock; nothing was read',
        alert: true,
      },
    ]);
    expect(await rowsOf('robinhood', vault.address)).toEqual([]);
    expect(w.asked).toEqual({ vaults: [], owners: [], prices: [] });
    expect((await s.runs('robinhood')).map((r) => r.finishedAt)).toEqual([null]);

    // The worker starts again: the run left open is closed, and the pass goes through.
    const pings: boolean[] = [];
    await runSnapshots({
      sources: [w.source],
      db,
      loop: false,
      dryRun: false,
      intervalMs: 600_000,
      out: s.out,
      now: s.clock.now,
      ping: async (ok) => {
        pings.push(ok);
        // A ping that fails stops nothing.
        throw new Error('the ping did not answer');
      },
    });
    const [left, own] = await s.runs('robinhood');
    expect(left).toMatchObject({ id: theirs, error: LEFT_OPEN, vaultsRead: 0 });
    expect(left?.finishedAt).not.toBeNull();
    expect(own).toMatchObject({ error: null, vaultsRead: 1 });
    expect(own?.finishedAt).not.toBeNull();
    expect(await rowsOf('robinhood', vault.address)).toHaveLength(1);
    expect(pings).toEqual([true]);
  });

  it('writes the end of its own run before the next one, when the database did not take it then', async () => {
    const s = stage(11);
    const w = world('robinhood');
    const vault = await openVault(w, who('robinhood', 't-unclosed'), '1');
    await cacheRow(vault);
    // A database that refuses one update, as Drizzle says a query that failed: the end of the run.
    let refusals = 1;
    const patchy = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'update' || refusals-- <= 0) return Reflect.get(target, key, receiver);
        return () => {
          throw new DrizzleQueryError(
            'update "snapshot_runs" set "finished_at" = $1',
            [],
            Object.assign(new Error(`connect ECONNREFUSED ${NODE}`), { code: 'ECONNREFUSED' }),
          );
        };
      },
    });
    const state = newChainState();
    await expect(snapshotChain(s.ctx({ db: patchy }), w.source, state)).rejects.toThrow(
      /^the database did not take a query \(ECONNREFUSED\)$/,
    );
    // The pass itself went through: the row is there, and the run is still open.
    expect(await rowsOf('robinhood', vault.address)).toHaveLength(1);
    expect((await s.runs('robinhood')).map((r) => r.finishedAt)).toEqual([null]);
    expect(state.unclosed).toMatchObject({ end: { vaultsRead: 1, error: null } });

    // The next pass is not kept out by its own run: it writes that end, then opens another.
    s.tick([w]);
    await expect(snapshotChain(s.ctx({ db: patchy }), w.source, state)).resolves.toMatchObject({
      outcome: 'done',
      read: 1,
    });
    expect(state.unclosed).toBeNull();
    const [before, own] = await s.runs('robinhood');
    expect(before).toMatchObject({ vaultsRead: 1, error: null });
    expect(before?.finishedAt).toEqual(new Date(s.clock.now().getTime() - 600_000));
    expect(own).toMatchObject({ vaultsRead: 1, error: null });
    expect(own?.finishedAt).not.toBeNull();
    expect(await rowsOf('robinhood', vault.address)).toHaveLength(2);
  });

  it('neither backs off nor pings for a pass another worker kept from starting', async () => {
    const s = stage(20);
    const w = world('base');
    const vault = await openVault(w, who('base', 't-kept-out'), '1');
    await cacheRow(vault);
    const pings: boolean[] = [];
    const r = rounds(1, 2, async (round) => {
      s.tick([w]);
      // After the first pass another worker opens the chain's run, and holds it.
      if (round === 1) expect(await openRun(db, 'base', 'mock', s.clock.now())).not.toBeNull();
    });
    await expect(
      runSnapshots({
        sources: [w.source],
        db,
        loop: true,
        dryRun: false,
        intervalMs: 600_000,
        out: s.out,
        now: s.clock.now,
        sleep: r.sleep,
        ping: async (ok) => {
          pings.push(ok);
        },
      }),
    ).rejects.toBe(STOP);
    expect(s.lines.filter((l) => l.pass).map((l) => l.pass)).toEqual(['done', 'skipped']);
    expect(r.waited).toEqual([[600_000], [600_000]]);
    expect(pings).toEqual([true]);
    expect(await rowsOf('base', vault.address)).toHaveLength(1);
    await closeOpenRuns(db, ['base'], s.clock.now());
  });

  it('closes a run left open for longer than any pass can take, says so in its row, and reads', async () => {
    const s = stage(23);
    const w = world('robinhood');
    const vault = await openVault(w, who('robinhood', 't-left-open'), '1');
    await cacheRow(vault);
    // Another process opened the chain's run and is gone. No start will come to close it: the
    // worker that finds it is already running.
    const theirs = await openRun(db, 'robinhood', 'mock', s.clock.now());
    expect(theirs).not.toBeNull();
    s.clock.advance(STALE_RUN_MIN_MS + 1);

    await expect(snapshotChain(s.ctx(), w.source, newChainState())).resolves.toMatchObject({
      outcome: 'done',
      read: 1,
    });
    const [left, own] = await s.runs('robinhood');
    expect(left).toMatchObject({ id: theirs, error: LEFT_OPEN, vaultsRead: 0, vaultsFailed: 0 });
    expect(left?.finishedAt).toEqual(s.clock.now());
    expect(own).toMatchObject({ error: null, vaultsRead: 1 });
    expect(own?.finishedAt).not.toBeNull();
    expect(await rowsOf('robinhood', vault.address)).toHaveLength(1);
    expect(s.lines.filter((l) => l.pass).map((l) => l.pass)).toEqual(['done']);
  });

  it('leaves an open run that a pass may still be in, and is skipped', async () => {
    const s = stage(24);
    const w = world('robinhood');
    const vault = await openVault(w, who('robinhood', 't-still-open'), '1');
    await cacheRow(vault);
    const theirs = await openRun(db, 'robinhood', 'mock', s.clock.now());
    expect(theirs).not.toBeNull();
    // As old as a run can be and still be another worker's: one millisecond short of left open.
    s.clock.advance(STALE_RUN_MIN_MS);
    await expect(snapshotChain(s.ctx(), w.source, newChainState())).resolves.toEqual({
      outcome: 'skipped',
    });
    expect((await s.runs('robinhood')).map((r) => [r.id, r.finishedAt, r.error])).toEqual([
      [theirs, null, null],
    ]);
    expect(s.lines.map((l) => l.pass)).toEqual(['skipped']);
    expect(w.asked).toEqual({ vaults: [], owners: [], prices: [] });
    expect(await rowsOf('robinhood', vault.address)).toEqual([]);
  });

  it('in a dry run writes no row, opens and closes no run, and says the same lines', async () => {
    const s = stage(12);
    const w = world('base');
    const vault = await openVault(w, who('base', 't4'), '1');
    await cacheRow(vault);
    // A run another worker holds: a dry run neither waits for it nor closes it.
    const theirs = await openRun(db, 'base', 'mock', s.clock.now());
    s.clock.advance(1_000);

    await runSnapshots({
      sources: [w.source],
      db,
      loop: false,
      dryRun: true,
      intervalMs: 600_000,
      out: s.out,
      now: s.clock.now,
    });
    expect(await rowsOf('base', vault.address)).toEqual([]);
    expect((await s.runs('base')).map((r) => [r.id, r.finishedAt])).toEqual([[theirs, null]]);
    const dry = s.about(vault.address);
    expect(dry).toHaveLength(1);
    expect(s.lines.at(-1)).toMatchObject({ pass: 'done', read: 1, dryRun: true });

    // The same pass for real, at the same time on both clocks.
    await closeOpenRuns(db, ['base'], s.clock.now());
    await snapshotChain(s.ctx(), w.source, newChainState());
    expect(s.about(vault.address)).toEqual([dry[0], dry[0]]);
    expect(dry[0]).toMatchObject({ outcome: 'read', valueUsd: '999.00', provenance: 'mock' });
    expect(s.lines.at(-1)).toMatchObject({ pass: 'done', read: 1, dryRun: false });
    expect(await rowsOf('base', vault.address)).toHaveLength(1);
    expect(await s.runs('base')).toHaveLength(2);
  });
});

describe('the worker over two chains', () => {
  it('lets a chain that does not answer back off alone, while the other is written in the same round', async () => {
    const s = stage(13);
    const sol = world('solana');
    const rh = world('robinhood');
    const onSolana = await openVault(sol, who('solana', 't2'), '1');
    const onRobinhood = await openVault(rh, who('robinhood', 't2'), '1');
    await cacheRow(onSolana);
    await cacheRow(onRobinhood);
    let heights = 0;
    const flaky: ChainSource = {
      ...rh.source,
      height: async () => {
        if (heights++ === 0)
          throw new ChainError('Unavailable', `request to ${NODE} failed, reason: socket hang up`);
        return rh.source.height();
      },
    };
    const pings: boolean[] = [];
    const reason = 'Unavailable: request to <NODE> failed, reason: socket hang up';
    const r = rounds(2, 2, async (round) => {
      if (round === 1) {
        // The round the node did not answer in: the other chain's row is there already.
        expect(await rowsOf('solana', onSolana.address)).toHaveLength(1);
        expect(await rowsOf('robinhood', onRobinhood.address)).toHaveLength(0);
        const failed = await s.runs('robinhood');
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ error: reason, vaultsRead: 0, vaultsFailed: 0 });
        expect(failed[0]?.finishedAt).not.toBeNull();
      }
      s.tick([sol, rh]);
    });
    await expect(
      runSnapshots({
        sources: [sol.source, flaky],
        db,
        loop: true,
        dryRun: false,
        intervalMs: 600_000,
        hide,
        out: s.out,
        now: s.clock.now,
        sleep: r.sleep,
        ping: async (ok) => {
          pings.push(ok);
        },
      }),
    ).rejects.toBe(STOP);

    // The chain that failed waited 15 s; the other kept its ten minutes. Then both went through.
    expect(r.waited).toEqual([
      [15_000, 600_000],
      [600_000, 600_000],
    ]);
    expect(await rowsOf('solana', onSolana.address)).toHaveLength(2);
    expect(await rowsOf('robinhood', onRobinhood.address)).toHaveLength(1);
    const [, next] = await s.runs('robinhood');
    expect(next).toMatchObject({ error: null, vaultsRead: 1 });
    expect(s.lines.filter((l) => l.outcome === 'round-failed')).toEqual([
      {
        at: expect.any(String),
        chain: 'robinhood',
        name: 'robinhood mock',
        outcome: 'round-failed',
        reason,
        alert: true,
        failures: 1,
        retryInS: 15,
      },
    ]);
    expect(JSON.stringify(s.lines)).not.toContain(NODE);
    expect(pings.filter((ok) => !ok)).toHaveLength(1);
    expect(pings.at(-1)).toBe(true);
  });

  it('pings no success while the newest pass of one chain is a failed one', async () => {
    const s = stage(14);
    const sol = world('solana');
    const rh = world('robinhood');
    await cacheRow(await openVault(sol, who('solana', 't-ping'), '1'));
    await cacheRow(await openVault(rh, who('robinhood', 't-ping'), '1'));
    let heights = 0;
    const flaky: ChainSource = {
      ...rh.source,
      height: async () => {
        if (heights++ < 2) throw new ChainError('Unavailable', 'the node did not answer');
        return rh.source.height();
      },
    };
    const pings: boolean[] = [];
    const byRound: boolean[][] = [];
    const r = rounds(2, 3, () => {
      byRound.push(pings.splice(0));
      s.tick([sol, rh]);
    });
    await expect(
      runSnapshots({
        sources: [sol.source, flaky],
        db,
        loop: true,
        dryRun: true,
        intervalMs: 600_000,
        out: s.out,
        now: s.clock.now,
        sleep: r.sleep,
        ping: async (ok) => {
          pings.push(ok);
        },
      }),
    ).rejects.toBe(STOP);
    expect(r.waited).toEqual([
      [15_000, 600_000],
      [30_000, 600_000],
      [600_000, 600_000],
    ]);
    // The second round: Solana's pass went through and Robinhood's newest had failed, so the one
    // ping is the failure. Only when both newest passes went through is a success pinged.
    expect(byRound[0]).toContain(false);
    expect(byRound[1]).toEqual([false]);
    expect(byRound[2]?.every((ok) => ok)).toBe(true);
    expect(byRound[2]?.length).toBeGreaterThanOrEqual(1);
  });

  it('pings no success while an open run keeps one chain from starting, and pings again once that chain reads', async () => {
    const s = stage(25);
    const sol = world('solana');
    const base = world('base');
    const onSolana = await openVault(sol, who('solana', 't-held-back'), '1');
    const onBase = await openVault(base, who('base', 't-held-back'), '1');
    await cacheRow(onSolana);
    await cacheRow(onBase);
    // Solana's pass waits for Base's of the same round to have said how it ended, so that which of
    // the two ends first is not left to the machine.
    let ended = 0;
    let heights = 0;
    const waiting: (() => void)[] = [];
    const out = (line: string) => {
      s.out(line);
      const said = JSON.parse(line) as Said;
      if (said.chain !== 'base' || !(said.pass || said.outcome === 'round-failed')) return;
      ended++;
      for (const go of waiting.splice(0)) go();
    };
    const after: ChainSource = {
      ...sol.source,
      height: async () => {
        const round = ++heights;
        while (ended < round) await new Promise<void>((go) => waiting.push(go));
        return sol.source.height();
      },
    };
    const pings: boolean[] = [];
    const byRound: boolean[][] = [];
    let theirs: string | null = null;
    const r = rounds(2, 4, async (round) => {
      byRound.push(pings.splice(0));
      // After the first round, and a second after its run, another process opens Base's run and is
      // gone.
      if (round === 1) {
        s.clock.advance(1_000);
        theirs = await openRun(db, 'base', 'mock', s.clock.now());
      }
      // Twelve minutes a round: the run is 12 and 24 minutes old at the next two passes, and 36 at
      // the fourth. On a ten-minute interval the worker takes one for left open after 30.
      s.tick([sol, base], 720);
    });
    await expect(
      runSnapshots({
        sources: [after, base.source],
        db,
        loop: true,
        dryRun: false,
        intervalMs: 600_000,
        out,
        now: s.clock.now,
        sleep: r.sleep,
        ping: async (ok) => {
          pings.push(ok);
        },
      }),
    ).rejects.toBe(STOP);

    const passes = (chain: ChainId) =>
      s.lines.filter((l) => l.chain === chain && l.pass).map((l) => l.pass);
    expect(passes('base')).toEqual(['done', 'skipped', 'skipped', 'done']);
    expect(passes('solana')).toEqual(['done', 'done', 'done', 'done']);
    // A skipped pass is no failure: no back-off, and no ping of its own.
    expect(r.waited).toEqual(Array(4).fill([600_000, 600_000]));
    expect(s.lines.filter((l) => l.outcome === 'round-failed')).toEqual([]);
    // But while Base wrote no row, Solana's good passes pinged no success. Both do once Base reads.
    expect(byRound).toEqual([[true, true], [], [], [true, true]]);
    expect(await rowsOf('solana', onSolana.address)).toHaveLength(4);
    expect(await rowsOf('base', onBase.address)).toHaveLength(2);
    // What let Base read again: the run left open was closed by the pass that found it old enough.
    const runs = await s.runs('base');
    expect(runs.map((run) => run.error)).toEqual([null, LEFT_OPEN, null]);
    expect(runs[1]?.id).toBe(theirs);
    expect(runs.every((run) => run.finishedAt !== null)).toBe(true);
  });

  it('with the loop off, gives every chain its pass and then fails if one did', async () => {
    const s = stage(15);
    const sol = world('solana');
    const rh = world('robinhood');
    const onSolana = await openVault(sol, who('solana', 't-once'), '1');
    await cacheRow(onSolana);
    const down: ChainSource = {
      ...rh.source,
      name: 'Robinhood Chain testnet',
      rules: async () => {
        throw new ChainError('Unavailable', `request to ${NODE} failed`);
      },
    };
    // Solana is still reading when Robinhood's pass has failed and been said.
    let failureSaid = () => {};
    const held = new Promise<void>((resolve) => {
      failureSaid = resolve;
    });
    const slow: ChainSource = {
      ...sol.source,
      height: async () => {
        await held;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return sol.source.height();
      },
    };
    const waited: number[] = [];
    const pings: boolean[] = [];
    await expect(
      runSnapshots({
        sources: [down, slow],
        db,
        loop: false,
        dryRun: false,
        intervalMs: 600_000,
        hide,
        out: s.out,
        now: s.clock.now,
        sleep: async (ms) => {
          waited.push(ms);
        },
        ping: async (ok) => {
          pings.push(ok);
          if (!ok) failureSaid();
        },
      }),
    ).rejects.toThrow(
      '1 of 2 chains failed their pass: Robinhood Chain testnet: Unavailable: request to <NODE> failed',
    );
    expect(waited).toEqual([]);
    // It was given the time to finish, and its row is written before the worker ends.
    expect(await rowsOf('solana', onSolana.address)).toHaveLength(1);
    expect(s.lines.filter((l) => l.outcome === 'round-failed')).toEqual([
      expect.objectContaining({ chain: 'robinhood', failures: 1, alert: true }),
    ]);
    expect(s.lines.find((l) => l.outcome === 'round-failed')).not.toHaveProperty('retryInS');
    // No success is pinged for Solana's pass: Robinhood's newest pass failed.
    expect(pings).toEqual([false]);
  });

  it('refuses to start with no chain', async () => {
    await expect(
      runSnapshots({ sources: [], db, loop: true, dryRun: true, intervalMs: 600_000 }),
    ).rejects.toThrow('no chain to read');
  });
});
