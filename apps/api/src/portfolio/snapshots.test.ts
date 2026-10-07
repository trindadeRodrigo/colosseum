import { snapshotRuns } from '@colosseum/db';
import { type Principal, parseChainConfigs, parseFlags, TrackSnapshot } from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChainEntry, createChainRegistry } from '../orders/chains';
import { type Person, person, type TestIssuer, testDb, testIssuer } from '../testing/harness';
import {
  dropRuns,
  seedRun,
  seedSnapshot,
  seedVault,
  vaultAddress,
} from '../testing/portfolio-world';
import { personScope, type ScopedChain } from './scope';
import { chainAnsweredAt, knownVaults, newestSnapshot, trackSnapshotOf } from './snapshots';

// The reads of the worker's tables the portfolio routes share (snapshots.ts), on the real database.
// Other sessions write to it at the same time: every test reads the rows of the people it made, and
// the runs it seeds are on a chain and under a label no other test writes (Base, `live`).

const NOW = new Date('2026-10-05T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
const runs: string[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
});
afterAll(async () => {
  await dropRuns(data.db, runs);
  await data.cleanUp();
});

function scopeOf(p: Person): ScopedChain {
  const principal: Principal = {
    kind: 'user',
    userId: p.sub,
    ip: '127.0.0.1',
    wallets: [{ family: 'solana', address: p.solana, kind: 'external' }],
  };
  const registry = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'test' });
  const [scoped] = personScope(registry, principal).chains;
  if (!scoped) throw new Error('no chain');
  return scoped;
}

describe('the vaults of a person on a chain', () => {
  it('are the ones the cache names and the ones snapshotted lately, each with its newest snapshot', async () => {
    const ann = data.track(await person(issuer, 'solana'));
    const scoped = scopeOf(ann);
    // In the cache and read twice: the newer snapshot is its newest.
    const read = await seedVault(data.db, { chain: 'solana', owner: ann.solana });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: read,
      owner: ann.solana,
      observedAt: ago(30),
      valueUsd: 900,
    });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: read,
      owner: ann.solana,
      observedAt: ago(10),
      valueUsd: 950,
    });
    // In the cache, never read by the worker.
    const unread = await seedVault(data.db, { chain: 'solana', owner: ann.solana });
    // Found by the worker alone, yesterday: not in the cache.
    const found = vaultAddress('solana');
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: found,
      owner: ann.solana,
      observedAt: ago(24 * 60),
    });
    // Found by the worker alone, too long ago to be looked for.
    const old = vaultAddress('solana');
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: old,
      owner: ann.solana,
      observedAt: ago(8 * 24 * 60),
    });

    const known = await knownVaults(data.db, scoped, { now: NOW });
    expect(known.map((v) => v.address)).toEqual([read, unread, found].sort());
    const byAddress = new Map(known.map((v) => [v.address, v]));
    expect(byAddress.get(read)?.newest?.valueUsd).toBe('950.00');
    expect(byAddress.get(read)?.cached?.address).toBe(read);
    expect(byAddress.get(unread)).toMatchObject({ newest: null, cached: { address: unread } });
    expect(byAddress.get(found)).toMatchObject({ cached: null, newest: { address: found } });

    // One vault, by its address.
    const one = await knownVaults(data.db, scoped, { now: NOW, address: read });
    expect(one.map((v) => v.address)).toEqual([read]);
  });

  it('never include another person’s vault, whether asked for all or by its address', async () => {
    const ann = data.track(await person(issuer, 'solana'));
    const bob = data.track(await person(issuer, 'solana'));
    const hers = await seedVault(data.db, { chain: 'solana', owner: ann.solana });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: hers,
      owner: ann.solana,
      observedAt: ago(5),
    });
    const his = scopeOf(bob);
    expect(await knownVaults(data.db, his, { now: NOW })).toEqual([]);
    expect(await knownVaults(data.db, his, { now: NOW, address: hers })).toEqual([]);
    expect(await newestSnapshot(data.db, his, hers)).toBeNull();
    expect((await newestSnapshot(data.db, scopeOf(ann), hers))?.address).toBe(hers);
  });

  it('hands a snapshot to the status rule as the rule reads it', async () => {
    const ann = data.track(await person(issuer, 'solana'));
    const address = vaultAddress('solana');
    const row = await seedSnapshot(data.db, {
      chain: 'solana',
      address,
      owner: ann.solana,
      observedAt: ago(5),
      parts: {
        spy: { weightBps: 6000, targetBps: 5000 },
        nvda: { weightBps: 3000, priced: false },
      },
      lossUsedBps: 12,
      bandBps: 50,
      lossCapBps: 100,
    });
    const read = trackSnapshotOf(row);
    expect(TrackSnapshot.parse(read)).toEqual(read);
    expect(read).toMatchObject({
      observedAt: ago(5).toISOString(),
      lossUsedBps: 12,
      bandBps: 50,
      lossCapBps: 100,
      positions: [
        { asset: 'solana:spy', targetBps: 5000, driftBps: 1000 },
        { asset: 'solana:nvda', targetBps: 3000, valueUsd: null, driftBps: -3000 },
      ],
    });
    // What the priced positions leave of the whole is cash: 4,000 bps of a thousand dollars.
    expect(BigInt(read.cash.raw)).toBe(400_000_000n);
  });
});

describe('when a chain last answered', () => {
  // A chain and a label of this test's own: no other test writes runs there.
  const entry = { chain: 'base', provenance: 'live' } as ChainEntry;

  it('is the end of the newest pass that went through, under the chain’s own label', async () => {
    // Rows an earlier run of this test may have left behind, and no others: this chain and label are
    // this test's alone.
    await data.db
      .delete(snapshotRuns)
      .where(and(eq(snapshotRuns.chainId, 'base'), eq(snapshotRuns.provenance, 'live')));
    expect(await chainAnsweredAt(data.db, entry)).toBeNull();
    const seed = async (minutes: number, extra: { error?: string; provenance?: 'mock' } = {}) =>
      runs.push(
        await seedRun(data.db, {
          chain: 'base',
          finishedAt: ago(minutes),
          provenance: extra.provenance ?? 'live',
          error: extra.error ?? null,
        }),
      );
    await seed(120);
    await seed(60);
    expect(await chainAnsweredAt(data.db, entry)).toEqual(ago(60));
    // A newer pass that failed, and a newer one under another label, change nothing.
    await seed(30, { error: 'no vault was read: 2 failed' });
    await seed(20, { provenance: 'mock' });
    expect(await chainAnsweredAt(data.db, entry)).toEqual(ago(60));
    await seed(10);
    expect(await chainAnsweredAt(data.db, entry)).toEqual(ago(10));
  });
});
