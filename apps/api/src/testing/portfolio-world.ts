import { randomUUID } from 'node:crypto';
import { mockAddress, mockAssets, mockCashId, mockPrices } from '@colosseum/chain-mock';
import { type Db, snapshotRuns, vaultSnapshots, vaults } from '@colosseum/db';
import type { ChainId, Price, Provenance, VaultView } from '@colosseum/schemas';
import { inArray } from 'drizzle-orm';

// For tests only: made-up rows of the snapshot worker's tables, for the routes that read them
// (PORT-2). The worker is another app and no app imports another, so a test of the API writes the
// rows a pass would have written. Every row hangs off an owner: track the person in `testDb()` and its
// `cleanUp` takes the vaults and the snapshots away. A run belongs to a chain, not to a person, so a
// test that seeds runs drops them itself (`dropRuns`).

/** One position of a made-up snapshot, by its weight. */
export type PartSeed = {
  weightBps: number;
  /** Default: the weight, so the position sits on its target. */
  targetBps?: number;
  /**
   * False for a holding the chain has no price for: it has no value and weighs nothing, and its
   * `weightBps` only sizes the amount held. Default true.
   */
  priced?: boolean;
  /** Unix seconds of the keeper's last trade on the asset. Default null. */
  lastKeeperAt?: number | null;
};

export type SnapshotSeed = {
  chain: ChainId;
  address: string;
  owner: string;
  observedAt: Date;
  /** Dollars the vault holds in all. Default 1000. */
  valueUsd?: number;
  /**
   * The positions by asset slug (`spy`, `nvda`, `gold`, `yield`), each a weight in bps or a `PartSeed`.
   * What the weights of the priced ones leave of 10,000 is cash. Default: spy 5000, nvda 3000, gold
   * 2000.
   */
  parts?: Record<string, number | PartSeed>;
  lossUsedBps?: number;
  /** The chain's settings at the read. Defaults: band 100, and no loss budget and no pause, as the mock. */
  bandBps?: number | null;
  lossCapBps?: number | null;
  paused?: boolean | null;
  provenance?: Provenance;
  /** The plan's row the vault was joined to at the read. */
  basketId?: string | null;
  onchainBasketId?: string;
  recipeOnchainId?: string | null;
  acceptedVersion?: number;
  autoFollow?: boolean;
  source?: string;
  method?: string;
  blockOrSlot?: string | null;
};

const SIX = 1_000_000;
const cut6 = (n: number) => (Math.floor(n * SIX + 1e-6) / SIX).toFixed(6).replace(/\.?0+$/, '');

/** The row a pass of the worker would have written for a vault that holds `valueUsd` in these parts. */
export function snapshotRowOf(seed: SnapshotSeed): typeof vaultSnapshots.$inferInsert {
  const { chain, observedAt } = seed;
  const provenance = seed.provenance ?? 'mock';
  const total = seed.valueUsd ?? 1000;
  const listed = new Map(mockAssets(chain).map((a) => [a.id, a]));
  const usdPerToken = mockPrices(chain);
  const parts = Object.entries(seed.parts ?? { spy: 5000, nvda: 3000, gold: 2000 }).map(
    ([slug, part]) => ({
      asset: `${chain}:${slug}`,
      ...(typeof part === 'number' ? { weightBps: part } : part),
    }),
  );
  const prices: Price[] = [];
  let invested = 0;
  const positions: VaultView['positions'] = parts.map((part) => {
    const asset = listed.get(part.asset);
    const price = Number(usdPerToken[part.asset]);
    if (!asset || !price) throw new Error(`${part.asset} is not on the mock's list`);
    const priced = part.priced ?? true;
    const usd = (total * part.weightBps) / 10_000;
    const tokens = usd / price;
    if (priced) {
      invested += part.weightBps;
      prices.push({
        asset: part.asset,
        usdPerToken: String(price),
        ageSeconds: 0,
        maxAgeSeconds: 3600,
        market: 'open',
        source: 'chain-mock',
        method: 'the mock shelf price, as a test wrote it',
        fetchedAt: observedAt.toISOString(),
        provenance,
      });
    }
    const targetBps = part.targetBps ?? part.weightBps;
    const weightBps = priced ? part.weightBps : 0;
    return {
      asset: part.asset,
      raw: BigInt(Math.round(tokens * 10 ** asset.decimals)).toString(),
      multiplier: '1',
      display: cut6(tokens),
      targetBps,
      lastKeeperAt: part.lastKeeperAt ?? null,
      valueUsd: priced ? cut6(usd) : null,
      weightBps,
      driftBps: weightBps - targetBps,
    };
  });
  if (invested > 10_000) throw new Error('the weights add up to more than 10,000');
  const cashUsd = (total * (10_000 - invested)) / 10_000;
  return {
    chainId: chain,
    address: seed.address,
    observedAt,
    blockOrSlot: seed.blockOrSlot === undefined ? '1' : seed.blockOrSlot,
    owner: seed.owner,
    basketId: seed.basketId ?? null,
    onchainBasketId: seed.onchainBasketId ?? '1',
    recipeOnchainId: seed.recipeOnchainId ?? null,
    acceptedVersion: seed.acceptedVersion ?? 0,
    autoFollow: seed.autoFollow ?? false,
    valueUsd: total.toFixed(2),
    cash: {
      asset: mockCashId(chain),
      raw: BigInt(Math.round(cashUsd * SIX)).toString(),
      multiplier: '1',
      display: cut6(cashUsd),
    },
    positions,
    pending: null,
    lossUsedBps: seed.lossUsedBps ?? 0,
    bandBps: seed.bandBps === undefined ? 100 : seed.bandBps,
    lossCapBps: seed.lossCapBps ?? null,
    paused: seed.paused ?? null,
    prices,
    provenance,
    source: seed.source ?? 'chain-mock',
    method: seed.method ?? 'a snapshot a test made up',
  };
}

/** Writes one made-up snapshot and answers the row as it was written. */
export async function seedSnapshot(db: Db, seed: SnapshotSeed) {
  const [row] = await db.insert(vaultSnapshots).values(snapshotRowOf(seed)).returning();
  if (!row) throw new Error('snapshot insert');
  return row;
}

/** An address for a made-up vault that no other test has. */
export const vaultAddress = (chain: ChainId) => mockAddress(chain, `test-vault:${randomUUID()}`);

/**
 * Writes the cache row of a made-up vault, as the goal join or a portfolio read would have, and
 * answers its address.
 */
export async function seedVault(
  db: Db,
  a: {
    chain: ChainId;
    owner: string;
    address?: string;
    onchainBasketId?: string;
    provenance?: Provenance;
    name?: string | null;
    valueUsd?: string | null;
    basketId?: string | null;
    observedAt?: Date;
  },
): Promise<string> {
  const address = a.address ?? vaultAddress(a.chain);
  await db.insert(vaults).values({
    chainId: a.chain,
    address,
    owner: a.owner,
    basketId: a.basketId ?? null,
    onchainBasketId: a.onchainBasketId ?? '1',
    targets: [],
    balances: {
      cash: { asset: mockCashId(a.chain), raw: '0', multiplier: '1', display: '0' },
      positions: [],
    },
    valueUsd: a.valueUsd ?? null,
    observedAt: a.observedAt ?? new Date(),
    provenance: a.provenance ?? 'mock',
    name: a.name ?? null,
  });
  return address;
}

/**
 * Writes one finished pass of the worker over a chain and answers its id. A pass that went through
 * has no `error`. Runs are the chain's, shared by every test on the database: drop them with
 * `dropRuns`, and expect other tests' runs on the same chain beside them.
 */
export async function seedRun(
  db: Db,
  a: {
    chain: ChainId;
    finishedAt: Date;
    startedAt?: Date;
    error?: string | null;
    vaultsRead?: number;
    vaultsFailed?: number;
    provenance?: Provenance;
  },
): Promise<string> {
  const [row] = await db
    .insert(snapshotRuns)
    .values({
      chainId: a.chain,
      startedAt: a.startedAt ?? new Date(a.finishedAt.getTime() - 1000),
      finishedAt: a.finishedAt,
      vaultsRead: a.vaultsRead ?? 0,
      vaultsFailed: a.vaultsFailed ?? 0,
      error: a.error ?? null,
      provenance: a.provenance ?? 'mock',
    })
    .returning({ id: snapshotRuns.id });
  if (!row) throw new Error('run insert');
  return row.id;
}

export async function dropRuns(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await db.delete(snapshotRuns).where(inArray(snapshotRuns.id, ids));
}
