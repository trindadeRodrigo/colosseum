import { mockAssets } from '@colosseum/chain-mock';
import { vaultSnapshots } from '@colosseum/db';
import {
  type ChainId,
  DISCLAIMER,
  type LiquidityProvider,
  PortfolioExposureResponse,
  type Provenance,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { EXPOSURE_METHOD, leastLive, NO_SNAPSHOT_SOURCE } from '../../portfolio/exposure';
import {
  type Person,
  type PersonKind,
  person,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import {
  type SnapshotSeed,
  seedSnapshot,
  seedVault,
  snapshotRowOf,
  vaultAddress,
} from '../../testing/portfolio-world';

// GET /v1/portfolio/exposure (PORT-2), through HTTP on the mock chains and the real database: what a
// person holds across their vaults, added up by underlying and by issuer, with the risk roll-up and
// what selling each holding would cost. The snapshot worker is another app, so each test writes the
// rows a pass would have written (testing/portfolio-world.ts). Every test makes its own people and
// reads only their rows: other sessions write to this database at the same time.
//
// The mock's prices are round (SPY 100, NVDA 50, gold 200, the yield token 1), so every sum below is
// worked out by hand from the dollars a vault holds and the weights of its parts.

vi.setConfig({ testTimeout: 60_000 });

const PATH = '/v1/portfolio/exposure';
/** The server's clock in these tests: a vault the worker alone found is looked for a week back from it. */
const NOW = new Date('2026-10-05T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
type Home = 'solana' | 'robinhood';

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
/** The server with nothing handed in: its reader of the stored figures, which holds none for the mock. */
let app: FastifyInstance;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('exposure');
  data = await testDb();
  undo.push(() => data.cleanUp());
  ({ app } = await testApp({ issuer: issuer.issuer, db: data.db, now: () => NOW }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));

/** A server of the test's own: other figures, other chains or another clock. Closed at the end. */
async function serverWith(a: Omit<Parameters<typeof testApp>[0], 'issuer' | 'db'>) {
  const own = await testApp({ issuer: issuer.issuer, db: data.db, now: () => NOW, ...a });
  undo.push(() => own.app.close());
  return own.app;
}

/** The route's answer for this person, held to the contract. */
async function read(who: Pick<Person, 'headers'>, query = '', on: FastifyInstance = app) {
  const res = await on.inject({ method: 'GET', url: `${PATH}${query}`, headers: who.headers });
  expect(res.statusCode, res.body).toBe(200);
  const answer = PortfolioExposureResponse.parse(res.json());
  expect(answer.disclaimer).toBe(DISCLAIMER.en);
  return answer;
}

/** The answer's one chain, for a person read on one. */
async function readOne(who: Pick<Person, 'headers'>, query = '', on: FastifyInstance = app) {
  const answer = await read(who, query, on);
  const [chain, ...rest] = answer.chains;
  if (!chain || rest.length) throw new Error(`expected one chain, got ${answer.chains.length}`);
  return { ...answer, chain };
}

const ownerOn = (who: Person, chain: Home) => (chain === 'solana' ? who.solana : who.evm);

/** A vault of this person's with one snapshot, ten minutes old unless the seed says. Answers its address. */
async function vault(who: Person, chain: Home, seed: Partial<SnapshotSeed> = {}) {
  const address = seed.address ?? vaultAddress(chain);
  await seedSnapshot(data.db, {
    chain,
    address,
    owner: ownerOn(who, chain),
    observedAt: ago(10),
    ...seed,
  });
  return address;
}

/** A chain's entry when nothing of the person's was found on it. */
const nothingOn = (chain: Home, provenance: Provenance = 'mock') => ({
  chain,
  name: chain === 'solana' ? 'Solana' : 'Robinhood Chain',
  provenance,
  vaults: 0,
  valueUsd: '0',
  observedAt: null,
  byUnderlying: [],
  byIssuer: [],
  rollUp: null,
  exit: [],
  unvalued: [],
  source: NO_SNAPSHOT_SOURCE,
  method: EXPOSURE_METHOD,
});

const sumOf = (shares: { bps: number }[]) => shares.reduce((n, s) => n + s.bps, 0);

/** The tier fallback of an asset nothing measures: no cost, and no source, time, method or label. */
const fallback = (asset: string, usd: string, tier = 'A') => ({
  asset,
  usd,
  measured: false,
  costBps: null,
  fallbackTier: tier,
});

const DATA_TO = '2026-10-04T00:00:00.000Z';
const BEARING = 'Bearing test curves';
type Measure = {
  /** The largest sale measured, in dollars: a larger one has no cost. */
  gridUsd: number;
  /** How many samples the capacity was read from. Default 120; zero is a curve too thin to read. */
  samples?: number;
  /** The end of the data. Default `DATA_TO`; null is a measurement that says no time. */
  dataTo?: string | null;
};

/**
 * A provider made by hand, as routes/v1/personalize.test.ts makes one: it measures the assets named,
 * each up to its grid, and selling `usd` dollars of one costs `usd / 4,000,000` of it, so $500 costs
 * 1.25 basis points and $1,000.125 costs 2.5003125. Labelled `fixture`, which it is.
 */
function handMade(
  measures: Record<string, Measure>,
  provenance: LiquidityProvider['provenance'] = 'fixture',
) {
  const exitCost = vi.fn<LiquidityProvider['exitCost']>((id, usd) => {
    const m = measures[id];
    return m && usd <= m.gridUsd ? usd / 4_000_000 : null;
  });
  const provider: LiquidityProvider = {
    methodVersion: 'test-depth-1',
    provenance,
    covers: (id) => measures[id] !== undefined,
    exitCapacity: (id) => {
      const m = measures[id];
      return m
        ? {
            capacityUsd: m.gridUsd,
            lowerBound: false,
            regime: 'weekend',
            samples: m.samples ?? 120,
            dataFrom: '2026-10-01T00:00:00.000Z',
            dataTo: m.dataTo === undefined ? DATA_TO : m.dataTo,
          }
        : null;
    },
    exitCost,
    weekendRatio: () => null,
    entry: () => null,
    assess: () => {
      throw new Error('not asked of an exposure');
    },
  };
  return { provider, exitCost };
}

/** Plan inputs that hand a chain this provider, under this source. */
const measuredOn =
  (chain: ChainId, provider: LiquidityProvider, source = BEARING): PlanInputs =>
  async (q) =>
    q.chain === chain ? { liquidity: { provider, source } } : {};

/** The stamp of a cost the hand-made provider measured. */
const stamp = (provenance: Provenance = 'fixture') => ({
  source: BEARING,
  method: 'test-depth-1',
  fetchedAt: DATA_TO,
  provenance,
});

/** The same chains under other labels: a server that runs one of them on a test network. */
const relabelled =
  (labels: Partial<Record<ChainId, Provenance>>) =>
  (inner: ChainRegistry): ChainRegistry => {
    const dress = (e: ChainEntry): ChainEntry => ({
      ...e,
      provenance: labels[e.chain] ?? e.provenance,
    });
    return { ...inner, get: (c) => dress(inner.get(c)), active: () => inner.active().map(dress) };
  };

/** Chains that answer their asset list and nothing else: any other call on an adapter throws. */
const listOnly = (inner: ChainRegistry): ChainRegistry => {
  const dress = (e: ChainEntry): ChainEntry => ({
    ...e,
    adapter: new Proxy(e.adapter, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key === 'listAssets') return value.bind(target);
        return () => {
          throw new Error(`the exposure route asked a chain for ${String(key)}`);
        };
      },
    }),
  });
  return { ...inner, get: (c) => dress(inner.get(c)), active: () => inner.active().map(dress) };
};

describe('what a person holds on a chain, added up', () => {
  // Vault A holds $1,000: SPY 500, NVDA 300, cash 200. Vault B holds $2,000.50: SPY 500.125, gold
  // 500.125, the yield token 200.05, cash 800.20. Together $3,000.50.
  const A = { valueUsd: 1000, parts: { spy: 5000, nvda: 3000 } };
  const B = { valueUsd: 2000.5, parts: { spy: 2500, gold: 2500, yield: 1000 } };
  /** The issuers and one tier a test network's tokens take from their models, as plan inputs hand them. */
  const fromModels: PlanInputs = async ({ chain }) => ({
    issuers: [
      { assetId: `${chain}:spy`, issuer: 'Alder', of: 'its model' },
      { assetId: `${chain}:nvda`, issuer: 'Alder', of: 'its model' },
      { assetId: `${chain}:gold`, issuer: 'Birch', of: 'its model' },
      { assetId: `${chain}:yield`, issuer: 'Cedar', of: 'its model' },
    ],
    tiers: [
      {
        assetId: `${chain}:nvda`,
        tier: 'B',
        source: 'a test',
        method: 'a test',
        fetchedAt: NOW.toISOString(),
        provenance: 'mock',
      },
    ],
  });

  it('adds two vaults up by underlying and by issuer, to the cent, largest first, in basis points that add up to 10,000', async () => {
    const own = await serverWith({ planInputs: fromModels });
    const ann = await someone();
    await vault(ann, 'solana', { ...A, observedAt: ago(30) });
    await vault(ann, 'solana', { ...B, observedAt: ago(10) });
    const { chain, total, unavailable } = await readOne(ann, '', own);

    expect(chain).toMatchObject({ chain: 'solana', name: 'Solana', provenance: 'mock', vaults: 2 });
    // Both snapshots came from one reader, which is named once.
    expect(chain.source).toBe('chain-mock');
    expect(chain.valueUsd).toBe('3000.5');
    // By what each asset stands for. The cash and the yield token are both dollars: 1,000.20 + 200.05.
    // Of 3,000.50: 4000.17, 3333.19, 1666.81 and 999.83 basis points; rounded down they leave two,
    // which go to the largest remainders, NVDA's and gold's.
    expect(chain.byUnderlying).toEqual([
      { key: 'USD', usd: '1200.25', bps: 4000 },
      { key: 'SPY', usd: '1000.125', bps: 3333 },
      { key: 'PAXG', usd: '500.125', bps: 1667 },
      { key: 'NVDA', usd: '300', bps: 1000 },
    ]);
    // By who issued it, with the issuers the plan inputs name in place of the list's one name: SPY
    // and NVDA under Alder (1,000.125 + 300), the cash under the list's own. 4333.03, 3333.44,
    // 1666.81 and 666.72; the two left over go to Birch and Cedar.
    expect(chain.byIssuer).toEqual([
      { key: 'Alder', usd: '1300.125', bps: 4333 },
      { key: 'mock', usd: '1000.2', bps: 3333 },
      { key: 'Birch', usd: '500.125', bps: 1667 },
      { key: 'Cedar', usd: '200.05', bps: 667 },
    ]);
    expect(sumOf(chain.byUnderlying)).toBe(10_000);
    expect(sumOf(chain.byIssuer)).toBe(10_000);
    expect(chain.unvalued).toEqual([]);

    // One entry for each asset that is not cash, at the holding of both vaults together, largest
    // first. Nothing is measured: each names its tier, and NVDA the tier the plan inputs gave it.
    expect(chain.exit).toEqual([
      fallback('solana:spy', '1000.125'),
      fallback('solana:gold', '500.125'),
      fallback('solana:nvda', '300', 'B'),
      fallback('solana:yield', '200.05'),
    ]);

    // The roll-up of packages/basket over the same holdings, on the same shelf: its issuers are the
    // ones above, and its classes add up the same dollars (cash 1,000.20, the index fund 1,000.125,
    // gold 500.125, the stock 300, the yield token 200.05).
    expect(chain.rollUp).toEqual({
      byIssuer: chain.byIssuer.map(({ key, bps }) => ({ key, bps })),
      byChain: [{ key: 'solana', bps: 10_000 }],
      byClass: [
        { key: 'cash', bps: 3333 },
        { key: 'etf', bps: 3333 },
        { key: 'gold', bps: 1667 },
        { key: 'stock', bps: 1000 },
        { key: 'dollar_yield', bps: 667 },
      ],
      flags: ['exit_not_measured', 'exit_quote_missing'],
      exit: { quotedBps: null, quotedAt: null, measuredWorstBps: null, measuredShareBps: 0 },
    });

    // One chain holds something, so the total is that chain.
    expect(total).toEqual({
      valueUsd: '3000.5',
      provenance: 'mock',
      byUnderlying: chain.byUnderlying,
      byIssuer: chain.byIssuer,
      source: chain.source,
      method: expect.stringContaining(chain.method),
      observedAt: chain.observedAt,
    });
    expect(unavailable).toEqual([]);
  });

  it('lists holdings of one size in one order, whatever order the vault holds them in', async () => {
    const ann = await someone();
    // $250 of each, held in this order, and no cash.
    await vault(ann, 'solana', { parts: { spy: 2500, nvda: 2500, yield: 2500, gold: 2500 } });
    const { chain } = await readOne(ann);
    expect(chain.byUnderlying).toEqual([
      { key: 'NVDA', usd: '250', bps: 2500 },
      { key: 'PAXG', usd: '250', bps: 2500 },
      { key: 'SPY', usd: '250', bps: 2500 },
      { key: 'USD', usd: '250', bps: 2500 },
    ]);
    expect(chain.exit.map((e) => e.asset)).toEqual([
      'solana:gold',
      'solana:nvda',
      'solana:spy',
      'solana:yield',
    ]);
  });

  it('counts only the newest snapshot of a vault', async () => {
    const ann = await someone();
    const address = vaultAddress('solana');
    // An hour ago the vault held $5,000 of NVDA; ten minutes ago, $500 of SPY and $500 of cash.
    await vault(ann, 'solana', {
      address,
      observedAt: ago(60),
      valueUsd: 5000,
      parts: { nvda: 10_000 },
    });
    await vault(ann, 'solana', { address, observedAt: ago(10), parts: { spy: 5000 } });
    const { chain } = await readOne(ann);
    expect(chain).toMatchObject({
      vaults: 1,
      valueUsd: '1000',
      observedAt: ago(10).toISOString(),
      byUnderlying: [
        { key: 'SPY', usd: '500', bps: 5000 },
        { key: 'USD', usd: '500', bps: 5000 },
      ],
      exit: [fallback('solana:spy', '500')],
    });
  });

  it('says how many vaults were counted, the oldest snapshot used, and where the snapshots came from', async () => {
    const ann = await someone();
    // In the cache and never read by the worker: it adds nothing, and is not counted.
    await seedVault(data.db, { chain: 'solana', owner: ann.solana });
    await vault(ann, 'solana', { observedAt: ago(50), source: 'a second reader' });
    await vault(ann, 'solana', { observedAt: ago(5) });
    const { chain } = await readOne(ann);
    expect(chain).toMatchObject({
      vaults: 2,
      valueUsd: '2000',
      // No sum is fresher than the oldest snapshot it stands on.
      observedAt: ago(50).toISOString(),
      source: 'a second reader; chain-mock',
      method: EXPOSURE_METHOD,
    });
    expect(chain.method).toMatch(/newest snapshot of each vault/);
    expect(chain.method).toMatch(/the value its snapshot gave it/);
    expect(chain.method).toMatch(/cash at one dollar each/);
  });

  it('puts a held position with no price in `unvalued`, in no sum and in no share', async () => {
    const ann = await someone();
    // $500 of SPY and $500 of cash; six NVDA that the chain had no price for.
    const address = await vault(ann, 'solana', {
      parts: { spy: 5000, nvda: { weightBps: 3000, priced: false } },
    });
    const { chain, total } = await readOne(ann);
    expect(chain.unvalued).toEqual([{ asset: 'solana:nvda', vault: address, display: '6' }]);
    expect(chain.valueUsd).toBe('1000');
    expect(chain.byUnderlying).toEqual([
      { key: 'SPY', usd: '500', bps: 5000 },
      { key: 'USD', usd: '500', bps: 5000 },
    ]);
    expect(chain.byIssuer).toEqual([{ key: 'mock', usd: '1000', bps: 10_000 }]);
    // Nothing to cost a sale of, and the roll-up classes no stock.
    expect(chain.exit).toEqual([fallback('solana:spy', '500')]);
    expect(chain.rollUp?.byClass).toEqual([
      { key: 'cash', bps: 5000 },
      { key: 'etf', bps: 5000 },
    ]);
    expect(total?.valueUsd).toBe('1000');
    expect(total?.byUnderlying.map((s) => s.key)).toEqual(['SPY', 'USD']);
  });

  it('keeps a holding the asset list does not name out of every sum, and lists no target that is not held', async () => {
    const ann = await someone();
    const address = vaultAddress('solana');
    const unlisted = `solana:mint-${'ab'.repeat(32)}`;
    const row = snapshotRowOf({
      chain: 'solana',
      address,
      owner: ann.solana,
      observedAt: ago(10),
      parts: { spy: 5000 },
    });
    const extra = { multiplier: '1', lastKeeperAt: null, weightBps: 0 };
    await data.db.insert(vaultSnapshots).values({
      ...row,
      positions: [
        ...row.positions,
        // On no list, though the snapshot gave it a value: there is no underlying to add it under.
        {
          ...extra,
          asset: unlisted,
          raw: '700',
          display: '7',
          targetBps: 0,
          valueUsd: '70',
          driftBps: 0,
        },
        // A target with no price that is not held yet: nothing is held, so nothing is unvalued.
        {
          ...extra,
          asset: 'solana:tsla',
          raw: '0',
          display: '0',
          targetBps: 1000,
          valueUsd: null,
          driftBps: -1000,
        },
        // A target with a price that is not held yet: it is worth nothing and adds no share.
        {
          ...extra,
          asset: 'solana:nvda',
          raw: '0',
          display: '0',
          targetBps: 1000,
          valueUsd: '0',
          driftBps: -1000,
        },
      ],
    });
    const { chain, total } = await readOne(ann);
    expect(chain.unvalued).toEqual([{ asset: unlisted, vault: address, display: '7' }]);
    expect(chain.valueUsd).toBe('1000');
    expect(chain.byUnderlying).toEqual([
      { key: 'SPY', usd: '500', bps: 5000 },
      { key: 'USD', usd: '500', bps: 5000 },
    ]);
    expect(chain.exit).toEqual([fallback('solana:spy', '500')]);
    expect(chain.rollUp?.flags).not.toContain('asset_not_on_shelf');
    expect(total?.valueUsd).toBe('1000');
  });

  it('adds dollars exactly, at a size no float holds', async () => {
    const ann = await someone();
    // Two vaults that hold only cash: 2^52 + 1 dollars and a millionth, and 2^52 and a millionth.
    for (const cash of ['4503599627370497.000001', '4503599627370496.000001']) {
      const row = snapshotRowOf({
        chain: 'solana',
        address: vaultAddress('solana'),
        owner: ann.solana,
        observedAt: ago(10),
        parts: {},
      });
      await data.db.insert(vaultSnapshots).values({
        ...row,
        cash: { ...row.cash, raw: cash.replace('.', ''), display: cash },
      });
    }
    const { chain, total } = await readOne(ann);
    expect(chain.valueUsd).toBe('9007199254740993.000002');
    expect(chain.byUnderlying).toEqual([
      { key: 'USD', usd: '9007199254740993.000002', bps: 10_000 },
    ]);
    // Cash is a holding like any other in the sums, and nothing that would have to be sold.
    expect(chain.exit).toEqual([]);
    expect(total?.valueUsd).toBe('9007199254740993.000002');
  });

  it('answers a chain with zero value and no roll-up for a person with no vault, and for one whose vaults were never read', async () => {
    const none = await someone();
    expect(await read(none)).toEqual({
      total: null,
      chains: [nothingOn('solana')],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    });
    const unread = await someone();
    await seedVault(data.db, { chain: 'solana', owner: unread.solana, valueUsd: '1000.00' });
    await seedVault(data.db, { chain: 'solana', owner: unread.solana });
    expect(await read(unread)).toEqual({
      total: null,
      chains: [nothingOn('solana')],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    });
  });
});

describe('what selling a holding would cost (gate EXIT-SOURCE)', () => {
  it('names the tier and states no cost where nothing is measured, and the roll-up says so', async () => {
    // The server's own plan inputs: Bearing measures nothing under a mock address.
    const ann = await someone();
    await vault(ann, 'solana');
    const { chain } = await readOne(ann);
    expect(chain.exit).toEqual([
      fallback('solana:spy', '500'),
      fallback('solana:nvda', '300'),
      fallback('solana:gold', '200'),
    ]);
    expect(chain.rollUp?.flags).toEqual([
      'exit_not_measured',
      'exit_quote_missing',
      'issuer_concentration',
    ]);
    expect(chain.rollUp?.exit).toEqual({
      quotedBps: null,
      quotedAt: null,
      measuredWorstBps: null,
      measuredShareBps: 0,
    });
    // The vault holds no cash, so no share of dollars is made of nothing.
    expect(chain.byUnderlying).toEqual([
      { key: 'SPY', usd: '500', bps: 5000 },
      { key: 'NVDA', usd: '300', bps: 3000 },
      { key: 'PAXG', usd: '200', bps: 2000 },
    ]);
    expect(chain.byIssuer).toEqual([{ key: 'mock', usd: '1000', bps: 10_000 }]);
  });

  it('gives a measured holding its cost and where the cost came from, and an unmeasured one its tier and no stamp', async () => {
    const { provider, exitCost } = handMade({ 'solana:spy': { gridUsd: 1500 } });
    const own = await serverWith({ planInputs: measuredOn('solana', provider) });
    const ann = await someone();
    // $500 of SPY, $300 of NVDA, $200 of cash.
    await vault(ann, 'solana', { parts: { spy: 5000, nvda: 3000 } });
    const { chain } = await readOne(ann, '', own);
    expect(chain.exit).toEqual([
      // 500 / 4,000,000 of the sale: 1.25 basis points.
      { asset: 'solana:spy', usd: '500', measured: true, costBps: 1.25, ...stamp() },
      fallback('solana:nvda', '300'),
    ]);
    // Asked at the holding's dollars, over the window the roll-up reads: by this answer and by the
    // roll-up alike.
    expect(exitCost).toHaveBeenCalled();
    for (const asked of exitCost.mock.calls) expect(asked).toEqual(['solana:spy', 500, 7]);
    // The roll-up reads the same measurement: $500 of SPY costs 1.25 bps, over the $700 of SPY and
    // cash it covers, 0.89 bps on 70% of the holdings.
    expect(chain.rollUp?.exit).toEqual({
      quotedBps: null,
      quotedAt: null,
      measuredWorstBps: 0.89,
      measuredShareBps: 7000,
    });
    expect(chain.rollUp?.flags).toEqual([
      'exit_partly_measured',
      'exit_quote_missing',
      'issuer_concentration',
      'measured_provenance:fixture',
    ]);
  });

  it('costs the holding of every vault together, to a hundredth of a basis point', async () => {
    const { provider, exitCost } = handMade({ 'solana:spy': { gridUsd: 1500 } });
    const own = await serverWith({ planInputs: measuredOn('solana', provider) });
    const ann = await someone();
    await vault(ann, 'solana', { valueUsd: 1000, parts: { spy: 5000 } });
    await vault(ann, 'solana', { valueUsd: 2000.5, parts: { spy: 2500 } });
    const { chain } = await readOne(ann, '', own);
    // 500 + 500.125 dollars: 1000.125 / 4,000,000 is 2.5003125 basis points.
    expect(chain.exit).toEqual([
      { asset: 'solana:spy', usd: '1000.125', measured: true, costBps: 2.5, ...stamp() },
    ]);
    expect(exitCost).toHaveBeenCalled();
    for (const asked of exitCost.mock.calls) expect(asked).toEqual(['solana:spy', 1000.125, 7]);
  });

  it('says a size beyond what was measured as measured, with no cost', async () => {
    const { provider } = handMade({ 'solana:spy': { gridUsd: 1500 } });
    const own = await serverWith({ planInputs: measuredOn('solana', provider) });
    const ann = await someone();
    // $2,000 of SPY, and the largest sale measured is $1,500.
    await vault(ann, 'solana', { valueUsd: 4000, parts: { spy: 5000 } });
    const { chain } = await readOne(ann, '', own);
    expect(chain.exit).toEqual([
      { asset: 'solana:spy', usd: '2000', measured: true, costBps: null, ...stamp() },
    ]);
    expect(chain.rollUp?.flags).toContain('exit_beyond_measured_size');
    expect(chain.rollUp?.exit.measuredWorstBps).toBeNull();
  });

  it('does not call a curve too thin to read a measurement', async () => {
    // The provider has curves for NVDA and read its capacity from no sample: the engine takes the
    // tier for it, and so does this answer, whatever cost the provider would give.
    const { provider } = handMade({
      'solana:spy': { gridUsd: 1500 },
      'solana:nvda': { gridUsd: 1500, samples: 0 },
    });
    const own = await serverWith({ planInputs: measuredOn('solana', provider) });
    const ann = await someone();
    await vault(ann, 'solana', { parts: { spy: 5000, nvda: 3000 } });
    const { chain } = await readOne(ann, '', own);
    expect(chain.exit).toEqual([
      { asset: 'solana:spy', usd: '500', measured: true, costBps: 1.25, ...stamp() },
      fallback('solana:nvda', '300'),
    ]);
  });

  it('leaves out a time or a source the measurement does not have, makes none up, and states no cost without them', async () => {
    const undated = handMade({ 'solana:spy': { gridUsd: 1500, dataTo: null } });
    const ann = await someone();
    await vault(ann, 'solana', { parts: { spy: 5000 } });
    const noTime = await readOne(
      ann,
      '',
      await serverWith({ planInputs: measuredOn('solana', undated.provider) }),
    );
    expect(noTime.chain.exit).toEqual([
      {
        asset: 'solana:spy',
        usd: '500',
        measured: true,
        costBps: null,
        source: BEARING,
        method: 'test-depth-1',
        provenance: 'fixture',
      },
    ]);
    // A time that does not read as one is no time either.
    const misdated = handMade({ 'solana:spy': { gridUsd: 1500, dataTo: 'the fourth of October' } });
    const badTime = await readOne(
      ann,
      '',
      await serverWith({ planInputs: measuredOn('solana', misdated.provider) }),
    );
    expect(badTime.chain.exit).toEqual(noTime.chain.exit);
    const dated = handMade({ 'solana:spy': { gridUsd: 1500 } });
    const noSource = await readOne(
      ann,
      '',
      await serverWith({ planInputs: measuredOn('solana', dated.provider, '  ') }),
    );
    expect(noSource.chain.exit).toEqual([
      {
        asset: 'solana:spy',
        usd: '500',
        measured: true,
        costBps: null,
        method: 'test-depth-1',
        fetchedAt: DATA_TO,
        provenance: 'fixture',
      },
    ]);
  });
});

describe('the chains of a person, and their total', () => {
  it('answers both chains of a person with a vault on each, and a total that is their sum, labelled mock', async () => {
    const both = await someone('passkey');
    // Solana: SPY 500, NVDA 300, gold 200. Robinhood Chain: SPY 200, gold 100, cash 200.
    await vault(both, 'solana');
    await vault(both, 'robinhood', { valueUsd: 500, parts: { spy: 4000, gold: 2000 } });
    const { total, chains, unavailable } = await read(both);
    expect(chains.map((c) => [c.chain, c.provenance, c.vaults, c.valueUsd])).toEqual([
      ['solana', 'mock', 1, '1000'],
      ['robinhood', 'mock', 1, '500'],
    ]);
    expect(chains[1]?.byUnderlying).toEqual([
      { key: 'SPY', usd: '200', bps: 4000 },
      { key: 'USD', usd: '200', bps: 4000 },
      { key: 'GLD', usd: '100', bps: 2000 },
    ]);
    // Of 1,500: SPY 700 on the two chains together is 4666.67 basis points, NVDA 2000, the gold of
    // each chain under its own underlying, 1333.33 and 666.67, and the cash 1333.33. Rounded down
    // they leave two, which go to the largest remainders: the two thirds of the gold on Robinhood
    // Chain and of SPY.
    expect(total).toEqual({
      valueUsd: '1500',
      provenance: 'mock',
      byUnderlying: [
        { key: 'SPY', usd: '700', bps: 4667 },
        { key: 'NVDA', usd: '300', bps: 2000 },
        { key: 'PAXG', usd: '200', bps: 1333 },
        { key: 'USD', usd: '200', bps: 1333 },
        { key: 'GLD', usd: '100', bps: 667 },
      ],
      byIssuer: [{ key: 'mock', usd: '1500', bps: 10_000 }],
      // where the sum comes from: the sources of the chains it adds, no fresher than the oldest
      source: [...new Set(chains.map((c) => c.source))].sort().join('; '),
      method: expect.stringContaining('added together'),
      observedAt: chains.map((c) => c.observedAt).sort()[0],
    });
    expect(sumOf(total?.byUnderlying ?? [])).toBe(10_000);
    expect(unavailable).toEqual([]);

    // `chain` narrows the answer to one chain, and the total with it.
    const solana = await read(both, '?chain=solana');
    expect(solana.chains.map((c) => c.chain)).toEqual(['solana']);
    expect(solana.total).toMatchObject({ valueUsd: '1000', provenance: 'mock' });
    const robinhood = await read(both, '?chain=robinhood');
    expect(robinhood.chains.map((c) => c.chain)).toEqual(['robinhood']);
    expect(robinhood.total?.byUnderlying).toEqual(chains[1]?.byUnderlying);
  });

  it('has an entry for a chain of the person that holds nothing, and none for a chain that is not theirs', async () => {
    const both = await someone('passkey');
    await vault(both, 'solana');
    const { total, chains } = await read(both);
    expect(chains.map((c) => c.chain)).toEqual(['solana', 'robinhood']);
    expect(chains[1]).toEqual(nothingOn('robinhood'));
    expect(total?.valueUsd).toBe('1000');
    // A chain the person holds no wallet for narrows the answer to nothing.
    const solanaOnly = await someone('solana');
    await vault(solanaOnly, 'solana');
    expect(await read(solanaOnly, '?chain=robinhood')).toEqual({
      total: null,
      chains: [],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    });
  });

  it('says a chain of the person that is switched off, and never shows it as zero', async () => {
    const own = await serverWith({ env: { CHAIN_MODE_ROBINHOOD: 'off' } });
    const both = await someone('passkey');
    await vault(both, 'solana');
    await vault(both, 'robinhood', { valueUsd: 500 });
    const { total, chains, unavailable } = await read(both, '', own);
    expect(chains.map((c) => c.chain)).toEqual(['solana']);
    expect(unavailable).toEqual([
      {
        chain: 'robinhood',
        name: 'Robinhood Chain',
        code: 'CHAIN_UNAVAILABLE',
        error: 'Robinhood Chain is switched off on this server',
        retryable: false,
      },
    ]);
    // The total adds up what could be read, and the answer says what could not.
    expect(total?.valueUsd).toBe('1000');
    // Asked for alone, the chain that is off is still said, and there is no sum to state.
    const off = await read(both, '?chain=robinhood', own);
    expect(off).toMatchObject({ total: null, chains: [], unavailable });
    expect((await read(both, '?chain=solana', own)).unavailable).toEqual([]);
  });

  it('labels a total by the least live of the chains that add to it', async () => {
    // A server that runs Solana on a test network and Robinhood Chain on the mock.
    const { provider } = handMade({ 'solana:spy': { gridUsd: 1500 } }, 'sandbox');
    const own = await serverWith({
      wrap: relabelled({ solana: 'sandbox' }),
      planInputs: measuredOn('solana', provider),
    });
    const both = await someone('passkey');
    await vault(both, 'solana', { provenance: 'sandbox', parts: { spy: 5000 } });
    const first = await read(both, '', own);
    expect(first.chains.map((c) => [c.chain, c.provenance, c.valueUsd])).toEqual([
      ['solana', 'sandbox', '1000'],
      ['robinhood', 'mock', '0'],
    ]);
    // The mock chain holds nothing: it puts no figure into the sum, and no label on it.
    expect(first.total).toMatchObject({ valueUsd: '1000', provenance: 'sandbox' });
    // A cost measured for a test network's token carries the label its provider gives it.
    expect(first.chains[0]?.exit).toEqual([
      { asset: 'solana:spy', usd: '500', measured: true, costBps: 1.25, ...stamp('sandbox') },
    ]);
    expect(first.chains[0]?.rollUp?.flags).toContain('measured_provenance:sandbox');

    // With a mock dollar in it, the sum is mock.
    await vault(both, 'robinhood', { valueUsd: 500 });
    const second = await read(both, '', own);
    expect(second.total).toMatchObject({ valueUsd: '1500', provenance: 'mock' });
    expect((await read(both, '?chain=solana', own)).total?.provenance).toBe('sandbox');
  });

  it('calls a sum live only when everything in it is', () => {
    expect(leastLive(['live'])).toBe('live');
    expect(leastLive(['live', 'live'])).toBe('live');
    expect(leastLive(['live', 'sandbox'])).toBe('sandbox');
    expect(leastLive(['sandbox', 'live', 'mock'])).toBe('mock');
    // A chain carries one of those three. Any other label is not live either.
    expect(leastLive(['live', 'fixture'])).toBe('sandbox');
  });
});

describe('one vault of the person, by its address', () => {
  it('narrows the sums, the roll-up and the exit sizes to that vault alone', async () => {
    const { provider } = handMade({ 'solana:spy': { gridUsd: 1500 } });
    const own = await serverWith({ planInputs: measuredOn('solana', provider) });
    const both = await someone('passkey');
    // The first holds SPY 500, NVDA 300, cash 200; the second SPY 500.125 and cash 1,500.375.
    const first = await vault(both, 'solana', { parts: { spy: 5000, nvda: 3000 } });
    const second = await vault(both, 'solana', { valueUsd: 2000.5, parts: { spy: 2500 } });
    await vault(both, 'robinhood', { valueUsd: 500 });

    const all = await read(both, '', own);
    expect(all.chains[0]).toMatchObject({ vaults: 2, valueUsd: '3000.5' });
    expect(all.total?.valueUsd).toBe('3500.5');
    // Both vaults together: $1,000.125 of SPY costs 2.5 basis points to sell.
    expect(all.chains[0]?.exit[0]).toMatchObject({ usd: '1000.125', costBps: 2.5 });

    const one = await read(both, `?address=${first}`, own);
    expect(one.chains[0]).toMatchObject({
      chain: 'solana',
      vaults: 1,
      valueUsd: '1000',
      byUnderlying: [
        { key: 'SPY', usd: '500', bps: 5000 },
        { key: 'NVDA', usd: '300', bps: 3000 },
        { key: 'USD', usd: '200', bps: 2000 },
      ],
      // The vault's own $500 of SPY: 1.25 basis points.
      exit: [
        { asset: 'solana:spy', usd: '500', measured: true, costBps: 1.25, ...stamp() },
        fallback('solana:nvda', '300'),
      ],
    });
    expect(one.chains[0]?.rollUp?.exit).toMatchObject({
      measuredWorstBps: 0.89,
      measuredShareBps: 7000,
    });
    // The address is no vault on the person's other chain: that chain is there, and holds nothing.
    expect(one.chains[1]).toEqual(nothingOn('robinhood'));
    expect(one.total).toMatchObject({ valueUsd: '1000', provenance: 'mock' });

    const other = await read(both, `?address=${second}`, own);
    expect(other.chains[0]).toMatchObject({
      vaults: 1,
      valueUsd: '2000.5',
      byUnderlying: [
        { key: 'USD', usd: '1500.375', bps: 7500 },
        { key: 'SPY', usd: '500.125', bps: 2500 },
      ],
    });
    // With the chain named too.
    const narrowed = await read(both, `?chain=solana&address=${first}`, own);
    expect(narrowed.chains.map((c) => [c.chain, c.vaults, c.valueUsd])).toEqual([
      ['solana', 1, '1000'],
    ]);
  });

  it('answers nothing for an address that is not a vault of the person’s, and never an error', async () => {
    const ann = await someone();
    const bob = await someone();
    const hers = await vault(ann, 'solana');
    await vault(bob, 'solana', { valueUsd: 300 });
    const nothing = {
      total: null,
      chains: [nothingOn('solana')],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    };
    // Another person's vault reads like an address no vault has.
    expect(await read(bob, `?address=${hers}`)).toEqual(nothing);
    expect(await read(bob, `?address=${vaultAddress('solana')}`)).toEqual(nothing);
    expect((await read(ann, `?address=${hers}`)).total?.valueUsd).toBe('1000');
  });
});

describe('whose rows the answer is made of', () => {
  it('never answers a second person the first one’s holdings, by any query', async () => {
    const ann = await someone('passkey');
    const bob = await someone('passkey');
    const hers = await vault(ann, 'solana');
    const hersToo = await vault(ann, 'robinhood', { valueUsd: 500 });
    const empty = { total: null, chains: [nothingOn('solana'), nothingOn('robinhood')] };
    expect(await read(bob)).toMatchObject(empty);
    expect(await read(bob, `?address=${hers}`)).toMatchObject(empty);
    expect(await read(bob, `?address=${hersToo}`)).toMatchObject(empty);
    for (const [chain, address] of [
      ['solana', hers],
      ['robinhood', hersToo],
    ] as const) {
      const alone = { total: null, chains: [nothingOn(chain)] };
      expect(await read(bob, `?chain=${chain}`)).toMatchObject(alone);
      expect(await read(bob, `?chain=${chain}&address=${address}`)).toMatchObject(alone);
    }
    // With holdings of his own, his answer is his own and nothing of hers is in it.
    await vault(bob, 'solana', { valueUsd: 300, parts: { gold: 10_000 } });
    const his = await read(bob);
    expect(his.total).toMatchObject({
      valueUsd: '300',
      byUnderlying: [{ key: 'PAXG', usd: '300', bps: 10_000 }],
    });
    expect((await read(ann)).total?.valueUsd).toBe('1500');
  });

  it('refuses a call with no sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: PATH });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('chains');
  });

  it('refuses a query the contract does not take', async () => {
    const ann = await someone();
    for (const query of ['?chain=mars', `?address=${'a'.repeat(65)}`, '?address=']) {
      const res = await app.inject({ method: 'GET', url: `${PATH}${query}`, headers: ann.headers });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('does not answer a row of the same wallet read under another label', async () => {
    const ann = await someone();
    // Her own wallet, read on a test network: the same owner, in the same database, labelled sandbox.
    const onTestNetwork = vaultAddress('solana');
    await seedVault(data.db, {
      chain: 'solana',
      owner: ann.solana,
      address: onTestNetwork,
      provenance: 'sandbox',
    });
    await vault(ann, 'solana', { address: onTestNetwork, valueUsd: 7000, provenance: 'sandbox' });
    // This server runs Solana on the mock: nothing of the test network's is hers here.
    expect((await read(ann)).chains).toEqual([nothingOn('solana')]);
    expect((await read(ann, `?address=${onTestNetwork}`)).chains).toEqual([nothingOn('solana')]);
    await vault(ann, 'solana');
    const { chain, total } = await readOne(ann);
    expect(chain).toMatchObject({ vaults: 1, valueUsd: '1000', provenance: 'mock' });
    expect(total).toMatchObject({ valueUsd: '1000', provenance: 'mock' });
  });
});

describe('what the route reads', () => {
  it('asks no chain for anything but its asset list', async () => {
    const own = await serverWith({ wrap: listOnly });
    const both = await someone('passkey');
    await vault(both, 'solana');
    await vault(both, 'robinhood', { valueUsd: 500 });
    const { total, chains } = await read(both, '', own);
    expect(chains.map((c) => c.valueUsd)).toEqual(['1000', '500']);
    expect(total?.valueUsd).toBe('1500');
  });

  it('reads the plan inputs once for a chain that holds something, as a plan is made, and not at all for one that holds nothing', async () => {
    const inputs = vi.fn<PlanInputs>(async () => ({}));
    const own = await serverWith({ planInputs: inputs });
    const none = await someone('passkey');
    await seedVault(data.db, { chain: 'solana', owner: none.solana });
    // A vault whose one holding has no price, and no cash: nothing in it has a value, so there is
    // nothing to class or to cost.
    const unpriced = vaultAddress('robinhood');
    const row = snapshotRowOf({
      chain: 'robinhood',
      address: unpriced,
      owner: none.evm,
      observedAt: ago(10),
      parts: { nvda: { weightBps: 3000, priced: false } },
    });
    await data.db
      .insert(vaultSnapshots)
      .values({ ...row, cash: { ...row.cash, raw: '0', display: '0' } });
    const empty = await read(none, '', own);
    expect(empty.total).toBeNull();
    expect(empty.chains).toEqual([
      nothingOn('solana'),
      {
        ...nothingOn('robinhood'),
        vaults: 1,
        observedAt: ago(10).toISOString(),
        source: 'chain-mock',
        unvalued: [{ asset: 'robinhood:nvda', vault: unpriced, display: '6' }],
      },
    ]);
    expect(inputs).not.toHaveBeenCalled();

    const both = await someone('passkey');
    await vault(both, 'solana');
    await read(both, '', own);
    expect(inputs).toHaveBeenCalledTimes(1);
    const [asked] = inputs.mock.calls[0] ?? [];
    expect(asked).toMatchObject({ chain: 'solana', provenance: 'mock' });
    // Every token of the chain's list, as `personalize()` hands them: the figures are the plan's.
    expect(asked?.assets.map((a) => a.id)).toEqual(mockAssets('solana').map((a) => a.id));
  });

  it('takes the time from the server’s clock', async () => {
    const ann = await someone();
    // A vault the worker alone found, in the first hour of 2020: it is in no cache, so it is looked
    // for among the snapshots of the week before the server's time.
    const then = new Date('2020-01-01T00:00:00.000Z');
    await vault(ann, 'solana', { observedAt: then });
    const anHourLater = await serverWith({ now: () => new Date('2020-01-01T01:00:00.000Z') });
    expect((await readOne(ann, '', anHourLater)).chain).toMatchObject({
      vaults: 1,
      valueUsd: '1000',
      observedAt: then.toISOString(),
    });
    const eightDaysLater = await serverWith({ now: () => new Date('2020-01-09T00:00:00.000Z') });
    expect((await read(ann, '', eightDaysLater)).chains).toEqual([nothingOn('solana')]);
  });
});
