import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@colosseum/db';
import type { BarRow, LendingMarketRow, ObservationRow, PoolBarRow } from '@colosseum/risk';
import type { BasketAsset, VaultAgentSource } from '@colosseum/schemas';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import {
  bearingAnswer,
  createAssetLookups,
  type LookupReads,
  lendingAnswer,
  readUniverse,
} from './asset-lookups';
import { lendsToken } from './lending-facts';
import type { LookupAnswer, LookupFact } from './orders/lookups';
import { MEASURED } from './orders/relaxed-figures';
import { figureResolver } from './orders/vault-figures';
import { AssetFactsResponse } from './routes/v1/assets';

// The asset lookups with their reads handed in: the rows are the fixtures the builders are tested on
// (fixtures/risk/assets/lookups/), so what is tested here is the reading, keeping, waiting, naming and
// labelling around them.
const DIR = join(__dirname, '../../../fixtures/risk/assets/lookups');
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as T;
const observations = load<{ observations: ObservationRow[] }>(
  'nvdax-observations.json',
).observations;
const bars = load<{ bars: BarRow[] }>('nvdax-bars.json').bars;
const pools = load<{ reading: ObservationRow; poolBars: PoolBarRow[] }>('nvdax-pools.json');
const lending = load<{ markets: LendingMarketRow[] }>('nvdax-lending.json').markets;
const MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';

const db = {} as Db;
const shelf = launchShelf().assets;
const stock = shelf.find((a) => a.chain === 'solana' && a.cls === 'stock') as BasketAsset;
const asset: BasketAsset = { ...stock, id: 'solana:nvdax', symbol: 'NVDAx', address: MINT };
const cash = shelf.find((a) => a.chain === 'solana' && a.cls === 'cash') as BasketAsset;
// The Jupiter Lend vault that takes NVDAx as collateral and lends USDC, as the lending markets of USDC read
// it (lending-facts.ts: found by its debt mint, so it lends the token read); the other lends JupUSD.
const usdcVault = lending.find((m) => m.market.endsWith('/USDC')) as LendingMarketRow;
const jupusdVault = lending.find((m) => m.market.endsWith('/JupUSD')) as LendingMarketRow;
const usdcRows: LendingMarketRow[] = [{ ...usdcVault, lends: true }];
// Bars that reach the present at this hour, and the lending report's hour.
const NOW = Date.parse('2026-10-06T06:30:00.000Z');

// The chain's collector ran every hour from the fixture's first bar to its last.
const HOUR = 3_600_000;
const chainHours = Array.from(
  {
    length:
      (Date.parse((bars.at(-1) as BarRow).hour) - Date.parse((bars[0] as BarRow).hour)) / HOUR + 1,
  },
  (_, at) => new Date(Date.parse((bars[0] as BarRow).hour) + at * HOUR).toISOString(),
);

const reads = (over: Partial<LookupReads> = {}): LookupReads => ({
  observations: vi.fn(async () => observations),
  bars: vi.fn(async () => ({ rows: bars, before: null, chainHours })),
  poolReading: vi.fn(async () => pools.reading),
  poolBars: vi.fn(async () => pools.poolBars),
  lending: vi.fn(async (_db: Db, _chain: string, address: string) =>
    address === MINT ? lending : usdcRows,
  ),
  sheet: vi.fn(async () => null),
  ...over,
});
const make = (r: LookupReads, over: Parameters<typeof createAssetLookups>[0] = {}) =>
  createAssetLookups({ reads: r, twins: async () => [], now: () => NOW, ...over });
const query = { db, chain: 'solana' as const, asset };

describe('the asset lookups', () => {
  it('answers each part with ids of its family and labels that hold no digit', async () => {
    const lookups = make(reads());
    const answers: LookupAnswer[] = [
      await lookups.profile(query),
      await lookups.priceHistory({ ...query, window: '7d' }),
      await lookups.pools(query),
      await lookups.lending(query),
    ];
    const ids = answers.flatMap((a) => [...a.facts, ...a.missing].map((f) => f.id));
    expect(ids).toContain('profile:solana:nvdax:supply_total');
    expect(ids).toContain('bars:solana:nvdax:7d:close');
    expect(ids).toContain('bars:solana:nvdax:7d:change');
    expect(ids).toContain('pool:solana:nvdax:1:tvl');
    expect(ids).toContain('pool:solana:nvdax:5:share');
    expect(ids).not.toContain('pool:solana:nvdax:6:tvl');
    // NVDAx is only collateral in both of its lending markets: a note each, never a rate
    expect(ids).toContain(`lend:solana:nvdax:${lending[0]?.account}:collateral`);
    expect(ids.filter((id) => /^lend:.+:(?:supply|borrow|util|withdrawable)$/u.test(id))).toEqual(
      [],
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const answer of answers) {
      expect(answer.modelledOn).toBeNull();
      expect(answer.unread).toBeUndefined();
      for (const item of [...answer.facts, ...answer.missing]) {
        expect([item.id, /\p{N}/u.test(item.label)]).toEqual([item.id, false]);
        expect(item.assetId).toBe('solana:nvdax');
        // the relaxed intake hands the model every family as a measured figure of an asset
        expect(MEASURED.test(item.id)).toBe(true);
      }
    }
    const close = answers[1]?.facts.find((f) => f.id === 'bars:solana:nvdax:7d:close');
    expect(close).toMatchObject({ unit: 'USD', provenance: 'live' });
    // the stale pool reading says its age on every pool figure it gave
    expect(answers[2]?.facts.every((f) => f.id.endsWith(':volume') || f.staleAgeSec)).toBe(true);
  });

  it('a week with hours not collected (up to 5%) answers its figures with the count, as the route serves them', async () => {
    // the chain's collector down five hours on Oct 2: no bar of any asset then
    const down = new Set(
      chainHours.filter((h) => h >= '2026-10-02T10:00' && h < '2026-10-02T15:00'),
    );
    expect(down.size).toBe(5);
    const lookups = make(
      reads({
        bars: vi.fn(async () => ({
          rows: bars.filter((bar) => !down.has(bar.hour)),
          before: null,
          chainHours: chainHours.filter((h) => !down.has(h)),
        })),
      }),
    );
    const answer = await lookups.priceHistory({ ...query, window: '7d' });
    const close = answer.facts.find((f) => f.id === 'bars:solana:nvdax:7d:close');
    expect(close).toMatchObject({ missingHours: 5, windowHours: 168 });
    expect(close?.method).toMatch(/no more than 5% of its hours were not collected/u);
    const body = AssetFactsResponse.parse({
      assetId: asset.id,
      chain: 'solana',
      symbol: asset.symbol,
      provenance: 'live',
      window: '7d',
      parts: { price_history: answer },
      disclaimer: 'not advice',
    });
    expect(
      body.parts.price_history?.facts.every((f) => f.missingHours === 5 && f.windowHours === 168),
    ).toBe(true);
    // a complete week says nothing of missing hours
    const whole = await make(reads()).priceHistory({ ...query, window: '7d' });
    expect(whole.facts.some((f) => 'missingHours' in f || 'windowHours' in f)).toBe(false);
  });

  it('keeps a read, and reads it once however many ask', async () => {
    const r = reads();
    const lookups = make(r);
    await Promise.all([lookups.profile(query), lookups.profile(query)]);
    await lookups.profile(query);
    expect(r.observations).toHaveBeenCalledTimes(1);
    // another window is another read
    await lookups.priceHistory({ ...query, window: '24h' });
    await lookups.priceHistory({ ...query, window: '7d' });
    await lookups.priceHistory({ ...query, window: '7d' });
    expect(r.bars).toHaveBeenCalledTimes(2);
  });

  it('answers "reading" past its wait, and the read fills the cache for the next ask', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = reads({
      observations: vi.fn(async () => {
        await gate;
        return observations;
      }),
    });
    const lookups = make(r, { waitMs: 20 });
    expect(await lookups.profile(query)).toEqual({
      facts: [],
      missing: [],
      modelledOn: null,
      unread: 'reading',
    });
    release();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await lookups.profile({ ...query, waitMs: 20 });
    expect(after.unread).toBeUndefined();
    expect(after.facts.length).toBeGreaterThan(0);
    expect(r.observations).toHaveBeenCalledTimes(1);
  });

  it('answers "failed" when a read fails, and never throws', async () => {
    const lookups = make(
      reads({
        observations: async () => {
          throw new Error('connection reset');
        },
        bars: async () => {
          throw new Error('no answer');
        },
      }),
    );
    await expect(lookups.profile(query)).resolves.toMatchObject({ unread: 'failed', facts: [] });
    await expect(lookups.priceHistory({ ...query, window: '7d' })).resolves.toMatchObject({
      unread: 'failed',
    });
    const broken = make(reads(), {
      twins: async () => {
        throw new Error('twins');
      },
    });
    await expect(broken.lending(query)).resolves.toMatchObject({ unread: 'failed' });
    // a read with no answer is given up after its time limit
    const hung = make(reads({ lending: () => new Promise(() => {}) }), { readMs: 10, waitMs: 100 });
    await expect(hung.lending(query)).resolves.toMatchObject({ unread: 'failed' });
  });

  it("reads a test-network token's mainnet model, labelled sandbox with the model named", async () => {
    const r = reads();
    const devnet: BasketAsset = {
      ...asset,
      id: 'solana:nvdax-dev',
      symbol: 'NVDAd',
      address: 'DevNvdaMint1111111111111111111111111111111',
      provenance: 'sandbox',
    };
    const lookups = make(r, {
      twins: async (_db, assets, provenance) =>
        provenance === 'sandbox'
          ? assets.map((a) => ({ id: a.id, symbol: a.symbol, twinSymbol: 'NVDAx', twinMint: MINT }))
          : [],
    });
    const answer = await lookups.priceHistory({
      db,
      chain: 'solana',
      asset: devnet,
      provenance: 'sandbox',
      window: '24h',
    });
    expect(r.bars).toHaveBeenCalledWith(db, 'solana', MINT, expect.any(Date));
    expect(answer.modelledOn).toBe('NVDAx');
    expect(answer.facts.length).toBeGreaterThan(0);
    for (const fact of answer.facts) {
      expect(fact.id.startsWith('bars:solana:nvdax-dev:24h:')).toBe(true);
      expect(fact.provenance).toBe('sandbox');
      expect(fact.source).toContain(
        'mainnet NVDAx figures applied to the test-network token NVDAd',
      );
    }
  });

  it('labels every fact of a chain on the mock as mock', async () => {
    const answer = await make(reads()).profile({ ...query, provenance: 'mock' });
    expect(answer.facts.length).toBeGreaterThan(0);
    expect(answer.facts.every((f) => f.provenance === 'mock')).toBe(true);
  });

  it('F1: a market that only takes the asset as collateral gives no figure under it, but a note of what it lends', async () => {
    const answer = await make(reads()).lending(query);
    expect(answer.facts).toEqual([]);
    expect(answer.missing).toEqual(
      [jupusdVault, usdcVault]
        .sort((a, b) => a.account.localeCompare(b.account))
        .map((market) => {
          const lent = market === usdcVault ? 'USDC' : 'JupUSD';
          return {
            id: `lend:solana:nvdax:${market.account}:collateral`,
            assetId: 'solana:nvdax',
            label: `NVDAx is accepted as collateral in the Jupiter Lend vault that lends ${lent}: its rates are ${lent}'s, never NVDAx's; ask for ${lent}'s lending markets for them`,
            reason: 'not_applicable',
          };
        }),
    );
  });

  it("F1: a lending figure is the lent token's, under its id; the cash token's markets are read", async () => {
    const r = reads();
    const answer = await make(r).lending({ ...query, asset: cash });
    expect(r.lending).toHaveBeenCalledWith(db, 'solana', cash.address);
    expect(answer.missing).toEqual([]);
    expect(answer.facts.map((f) => f.id)).toEqual(
      ['supply', 'borrow', 'util', 'withdrawable'].map(
        (key) => `lend:${cash.id}:${usdcVault.account}:${key}`,
      ),
    );
    expect(answer.facts.every((f) => f.assetId === cash.id)).toBe(true);
    expect(answer.facts[0]?.value).toBe(usdcVault.sheet.rates.supplyApy.value);
    expect(answer.facts[0]?.label).toBe(
      'Supply rate of USDC a year in the Jupiter Lend vault that takes NVDAx as collateral, at the last report; a past figure',
    );
  });

  it("F1: the cash token's five largest markets by what can be withdrawn, one pool served once", () => {
    const available = usdcVault.sheet.withdrawal.availableUsd;
    const withdrawable = available.value as number;
    // seven markets that lend USDC, each a different size; a copy of the largest under another account (one
    // venue lending from one pool: served once); and one market that only takes USDC as collateral
    const sized = (account: string, times: number): LendingMarketRow => ({
      ...usdcVault,
      account,
      lends: true,
      sheet: {
        ...usdcVault.sheet,
        withdrawal: {
          ...usdcVault.sheet.withdrawal,
          availableUsd: { ...available, value: withdrawable * times } as typeof available,
        },
      },
    });
    const rows = [1, 2, 3, 4, 5, 6, 7].map((times) => sized(`Acct${times}`, times));
    rows.push(sized('Acct0copy', 7), { ...jupusdVault, lends: false });
    const built = lendingAnswer(cash.id, rows, new Date(NOW), 'USDC');
    const accounts = [...new Set(built.facts.map((f) => f.id.split(':')[3]))];
    expect(accounts).toEqual(['Acct0copy', 'Acct6', 'Acct5', 'Acct4', 'Acct3']);
    expect(built.missing.map((m) => m.id)).toEqual([
      `lend:${cash.id}:${jupusdVault.account}:collateral`,
    ]);
  });

  it('F1: a pool lends the token it was read for by its debt mint, else by its own mint and role', () => {
    const vault = { role: 'vault', mint: MINT, debtMint: cash.address };
    expect(lendsToken(vault, cash.address)).toBe(true);
    expect(lendsToken(vault, MINT)).toBe(false);
    expect(lendsToken({ role: 'debt', mint: cash.address, debtMint: null }, cash.address)).toBe(
      true,
    );
    expect(
      lendsToken({ role: 'curated_vault', mint: cash.address, debtMint: null }, cash.address),
    ).toBe(true);
    expect(lendsToken({ role: 'collateral', mint: MINT, debtMint: null }, MINT)).toBe(false);
    // found by the DEX asset its stock maps to: collateral
    expect(lendsToken({ role: 'debt', mint: 'other', debtMint: null }, MINT)).toBe(false);
  });

  it('a cash token answers no facts and reads nothing', async () => {
    const r = reads();
    const lookups = make(r);
    for (const answer of [
      await lookups.profile({ ...query, asset: cash }),
      await lookups.pools({ ...query, asset: cash }),
      await lookups.bearing({ ...query, asset: cash }),
    ])
      expect(answer).toEqual({ facts: [], missing: [], modelledOn: null });
    expect(r.observations).not.toHaveBeenCalled();
    expect(r.poolReading).not.toHaveBeenCalled();
  });

  it('reads an EVM token by its address in lower case', async () => {
    const r = reads();
    const evm = shelf.find((a) => a.chain === 'robinhood' && a.cls === 'stock') as BasketAsset;
    const checksummed = { ...evm, address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' };
    await make(r).profile({ db, chain: 'robinhood', asset: checksummed });
    expect(r.observations).toHaveBeenCalledWith(
      db,
      'robinhood',
      '0xabcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it("Bearing's figures keep their ids; no sheet says so", async () => {
    const answer = await make(reads()).bearing(query);
    expect(answer.facts).toEqual([]);
    expect(answer.missing).toEqual([
      expect.objectContaining({ id: 'exit:solana:nvdax:worst', reason: 'not_collected' }),
    ]);
  });
});

// A chain's asset universe list as the repo keeps it (scripts/risk/assets/<chain>.json), cut to the rows the
// fallback reads: two USDC rows besides the listed one (a held-out mint and a candidate, both before it, so
// order does not pick it), and jlUSDC's mainnet row.
const USDC_LISTED = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_HELD_OUT = 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM';
const USDC_CANDIDATE = 'UsdcCandidate1111111111111111111111111111111';
const JLUSDC = '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D';
const UNIVERSE = mkdtempSync(join(tmpdir(), 'lookups-universe-'));
mkdirSync(join(UNIVERSE, 'scripts', 'risk', 'assets'), { recursive: true });
writeFileSync(
  join(UNIVERSE, 'scripts', 'risk', 'assets', 'solana.json'),
  JSON.stringify({
    chain: 'solana',
    assets: [
      { id: 'solana:usdc-a9muu4', symbol: 'USDC', address: USDC_HELD_OUT, status: 'held_out' },
      { id: 'solana:usdc-cand', symbol: 'USDC', address: USDC_CANDIDATE, status: 'candidate' },
      { id: 'solana:usdc', symbol: 'USDC', address: USDC_LISTED, status: 'listed' },
      { id: 'solana:jlusdc', symbol: 'jlUSDC', address: JLUSDC, status: 'listed' },
    ],
  }),
);
afterAll(() => rmSync(UNIVERSE, { recursive: true, force: true }));

describe("a test-network token with no Bearing twin reads its model from the chain's universe list", () => {
  // the test network's tokens as deployments/solana-devnet.json makes them (chain-solana deployment.ts)
  const tUSDC: BasketAsset = {
    ...cash,
    id: 'solana:usdc',
    symbol: 'tUSDC',
    address: 'AEtFZt8Fq4PYzBs4d8VoMypDDhjp9XTv6qvhJZhd8BUn',
    underlying: 'USDC',
    provenance: 'sandbox',
  };
  const dollarYield = shelf.find((a) => a.chain === 'solana' && a.cls === 'dollar_yield');
  const tjlUSDC: BasketAsset = {
    ...(dollarYield ?? asset),
    id: 'solana:jlusdc',
    symbol: 'tjlUSDC',
    address: 'DevJlUsdcMint111111111111111111111111111111',
    underlying: 'jlUSDC',
    provenance: 'sandbox',
  };
  const devnet = { db, chain: 'solana' as const, provenance: 'sandbox' as const };
  const withUniverse = (r: LookupReads, over: Parameters<typeof createAssetLookups>[0] = {}) =>
    make(r, { universeRoot: UNIVERSE, ...over });

  it('the cash token reads the lending markets of the listed USDC, labelled sandbox with the model named', async () => {
    const r = reads();
    const answer = await withUniverse(r).lending({ ...devnet, asset: tUSDC });
    expect(r.lending).toHaveBeenCalledWith(db, 'solana', USDC_LISTED);
    expect(r.lending).not.toHaveBeenCalledWith(db, 'solana', USDC_HELD_OUT);
    expect(r.lending).not.toHaveBeenCalledWith(db, 'solana', USDC_CANDIDATE);
    expect(answer.modelledOn).toBe('USDC');
    expect(answer.facts.length).toBeGreaterThan(0);
    for (const fact of answer.facts) {
      expect(fact.id.startsWith('lend:solana:usdc:')).toBe(true);
      expect(fact.provenance).toBe('sandbox');
      expect(fact.source).toContain('mainnet USDC figures applied to the test-network token tUSDC');
    }
  });

  it('the cash token as the deploy record makes it (underlying USD) is found by its mainnet id; its other parts answer nothing', async () => {
    const r = reads();
    const lookups = withUniverse(r);
    const asUsd = { ...tUSDC, underlying: 'USD' };
    const answer = await lookups.lending({ ...devnet, asset: asUsd });
    expect(r.lending).toHaveBeenCalledWith(db, 'solana', USDC_LISTED);
    expect(answer.modelledOn).toBe('USDC');
    for (const part of [
      await lookups.profile({ ...devnet, asset: asUsd }),
      await lookups.pools({ ...devnet, asset: asUsd }),
      await lookups.bearing({ ...devnet, asset: asUsd }),
    ])
      expect(part).toEqual({ facts: [], missing: [], modelledOn: null });
    expect(r.observations).not.toHaveBeenCalled();
  });

  it('a dollar-yield stand-in reads its profile under its model’s mainnet address', async () => {
    const r = reads();
    const answer = await withUniverse(r).profile({ ...devnet, asset: tjlUSDC });
    expect(r.observations).toHaveBeenCalledWith(db, 'solana', JLUSDC);
    expect(answer.modelledOn).toBe('jlUSDC');
    expect(answer.facts.length).toBeGreaterThan(0);
    expect(answer.facts.every((f) => f.provenance === 'sandbox')).toBe(true);
  });

  it('a token with a Bearing twin keeps it', async () => {
    const r = reads();
    const lookups = withUniverse(r, {
      twins: async (_db, assets) =>
        assets.map((a) => ({ id: a.id, symbol: a.symbol, twinSymbol: 'NVDAx', twinMint: MINT })),
    });
    const answer = await lookups.profile({ ...devnet, asset: tjlUSDC });
    expect(r.observations).toHaveBeenCalledWith(db, 'solana', MINT);
    expect(answer.modelledOn).toBe('NVDAx');
  });

  it('a live chain reads each token under its own address', async () => {
    for (const provenance of ['live', undefined] as const) {
      const r = reads();
      const lookups = withUniverse(r);
      const answer = await lookups.profile({ ...devnet, provenance, asset: tjlUSDC });
      expect(r.observations).toHaveBeenCalledWith(db, 'solana', tjlUSDC.address);
      expect(answer.modelledOn).toBeNull();
      await lookups.lending({ ...devnet, provenance, asset: tUSDC });
      expect(r.lending).toHaveBeenCalledWith(db, 'solana', tUSDC.address);
    }
  });

  it('with no universe file there is no fallback, and nothing throws', async () => {
    const missing = join(UNIVERSE, 'nowhere');
    expect(readUniverse(missing, 'solana')).toEqual([]);
    const r = reads();
    const lookups = withUniverse(r, { universeRoot: missing });
    const answer = await lookups.lending({ ...devnet, asset: tUSDC });
    expect(r.lending).toHaveBeenCalledWith(db, 'solana', tUSDC.address);
    expect(answer.modelledOn).toBeNull();
    expect(answer.unread).toBeUndefined();
    const profile = await lookups.profile({ ...devnet, asset: tjlUSDC });
    expect(r.observations).toHaveBeenCalledWith(db, 'solana', tjlUSDC.address);
    expect(profile.modelledOn).toBeNull();
  });
});

describe('a looked-up figure is stated by reference under the resolver’s rules', () => {
  // The assets a text names, by symbol: NVDAx, USDC and TSLAx are listed; JupUSD is not.
  const LISTED: Array<[RegExp, string]> = [
    [/\bNVDAx\b/u, 'solana:nvdax'],
    [/\bUSDC\b/u, 'solana:usdc'],
    [/\bTSLAx\b/u, 'solana:tslax'],
  ];
  const named = (text: string) => ({
    own: LISTED.filter(([name]) => name.test(text)).map(([, id]) => id),
    classes: [],
  });
  /** The relaxed intake's resolver (`kindRequired`), or the vault conversation's (neither rule). */
  const resolverOf = async (vault = false) => {
    const lookups = make(reads());
    const nvdaxLending = await lookups.lending(query);
    const facts: LookupFact[] = [
      ...(await lookups.priceHistory({ ...query, window: '7d' })).facts,
      ...(await lookups.pools(query)).facts,
      ...nvdaxLending.facts,
      // the cash token's lending markets: USDC's rates, under USDC
      ...(await lookups.lending({ ...query, asset: cash })).facts,
    ];
    const sources = new Map<string, VaultAgentSource>([
      ...facts.map((f) => [f.id, f] as [string, VaultAgentSource]),
      // a figure of the vault's own, which the lookups' rules never read
      [
        'holding:solana:nvdax:value',
        {
          id: 'holding:solana:nvdax:value',
          assetId: 'solana:nvdax',
          label: 'Value of this holding at its reference price',
          value: 1_800,
          unit: 'USD',
          source: 'test',
          method: 'test',
          fetchedAt: '2026-10-06T06:00:00.000Z',
          provenance: 'live',
        },
      ],
    ]);
    return figureResolver({
      enabled: true,
      sources,
      references: {
        missing: Object.fromEntries(nvdaxLending.missing.map((m) => [m.id, m])),
        staleAgeSec: {},
      },
      lowerBound: new Set(),
      language: 'en',
      sentences: (text) => text.match(/[^.!?]+[.!?]*\s*/gu) ?? [text],
      named,
      namesOf: (assetId) => (assetId === 'solana:nvdax' ? ['NVDAx', 'Nvidia'] : []),
      kindRequired: !vault,
      noComparison: !vault,
    });
  };
  const id = (part: string) => `{{fact:${part}}}`;

  // USDC's figures in the vault that lends it against NVDAx; and the ids NVDAx's own lending part gave them
  // before the second review (now naming nothing: a market that only takes NVDAx as collateral gives none)
  const usdc = usdcVault.account;
  const lend = (key: string) => id(`lend:solana:usdc:${usdc}:${key}`);
  const before = (key: string) => id(`lend:solana:nvdax:${usdc}:${key}`);
  const share = id('pool:solana:nvdax:1:share');
  const change = id('bars:solana:nvdax:7d:change');
  const close = id('bars:solana:nvdax:7d:close');
  const both = async (sentence: string) => [
    (await resolverOf()).unbacked(sentence),
    (await resolverOf(true)).unbacked(sentence),
  ];
  const cut = async (sentences: string[]) => {
    for (const sentence of sentences)
      for (const why of await both(sentence)) expect([sentence, why]).not.toEqual([sentence, []]);
  };
  const served = async (sentences: string[]) => {
    for (const sentence of sentences)
      for (const why of await both(sentence)) expect([sentence, why]).toEqual([sentence, []]);
  };
  // the honest phrasings every rule keeps
  const HONEST = [
    `The supply rate of USDC in that vault is ${lend('supply')} a year.`,
    `Lenders can withdraw ${lend('withdrawable')} of USDC from that vault now.`,
    `NVDAx's largest pool holds ${share} of the dollars in its pools.`,
    `NVDAx moved ${change} over the last week.`,
    `The last closing price of NVDAx was ${close}.`,
  ];

  it('serves each family called what it is', async () => {
    const resolver = await resolverOf();
    for (const sentence of [
      `The latest closing price was ${id('bars:solana:nvdax:7d:close')} this week.`,
      `The price change over the last week was ${id('bars:solana:nvdax:7d:change')}, first close to last.`,
      `There were ${id('bars:solana:nvdax:7d:swaps')} swaps on its pools.`,
      `Its largest pool holds ${id('pool:solana:nvdax:1:tvl')} in TVL.`,
      `In the vault that lends USDC, ${lend('withdrawable')} is available to withdraw now.`,
      `USDC's supply rate there is ${lend('supply')} a year.`,
      ...HONEST,
    ])
      expect([sentence, resolver.unbacked(sentence)]).toEqual([sentence, []]);
  });

  it('cuts a change called a return or a gain, and a figure without its kind', async () => {
    const resolver = await resolverOf();
    expect(
      resolver.unbacked(`The return over the last week was ${id('bars:solana:nvdax:7d:change')}.`),
    ).not.toEqual([]);
    expect(
      resolver.unbacked(`NVDAx gained ${id('bars:solana:nvdax:7d:change')} over the week.`),
    ).not.toEqual([]);
    expect(resolver.unbacked(`It stood at ${id('pool:solana:nvdax:1:share')}.`)).not.toEqual([]);
    expect(
      resolver.unbacked(
        `The change was ${id('bars:solana:nvdax:7d:change')}, more than ${id('bars:solana:nvdax:7d:volume')} in volume.`,
      ),
    ).not.toEqual([]);
  });

  // The reviewers' probes (the review and the re-review of API-AGENT-LOOKUPS-1): each served before its fix.
  it("B1: a lending rate is the lent token's rate, never the asset's yield", async () => {
    await cut([
      `NVDAx currently yields ${lend('borrow')} a year.`,
      `Its quoted yield is ${lend('borrow')} a year.`,
      `USDC currently yields ${lend('supply')} a year.`,
      `The supply rate is ${lend('supply')} a year, what lenders earn.`,
      `Its borrow rate is ${lend('borrow')} a year, a return for lenders.`,
      // a rate not called a supply or a borrow rate
      `Its rate is ${lend('borrow')} a year.`,
      // a promise beside it, in its sentence or the next
      `Its supply rate is ${lend('supply')} a year. It will stay there.`,
      `Its supply rate is ${lend('supply')} a year, always.`,
      // another asset than the lent token
      `The borrow rate of TSLAx is ${lend('borrow')} a year.`,
      `The borrow rate of USDC against TSLAx is ${lend('borrow')} a year.`,
    ]);
    await served([
      `Its borrow rate is ${lend('borrow')} a year.`,
      `The supply rate in the vault is ${lend('supply')} a year, at the last report.`,
      `The borrow rate of USDC in that vault is ${lend('borrow')} a year.`,
      `USDC lent in that vault has a supply rate of ${lend('supply')} a year.`,
    ]);
  });

  it("F1: a rate of a market that takes the asset as collateral is never said to be the asset's own", async () => {
    const probes = (rate: (key: string) => string) => [
      `NVDAx's supply rate is ${rate('supply')} a year.`,
      `The supply rate of NVDAx is ${rate('supply')} a year.`,
      `NVDAx has a supply rate of ${rate('supply')} a year.`,
      `Lending NVDAx on Jupiter Lend has a supply rate of ${rate('supply')} a year.`,
      `If you lend NVDAx, the supply rate is ${rate('supply')} a year.`,
      `The supply rate for NVDAx holders is ${rate('supply')} a year.`,
      `A taxa de fornecimento do NVDAx é ${rate('supply')} ao ano.`,
      `NVDAx's borrow rate is ${rate('borrow')} a year.`,
      `NVDAx's USDC supply rate is ${rate('supply')} a year.`,
    ];
    // under USDC's ids, the sentences name another asset; under NVDAx's, there is no such figure
    await cut([...probes(lend), ...probes(before)]);
    // a token named as what the market takes as collateral is where the rate was read, not whose it is
    await served([
      `On Jupiter Lend, the supply rate of USDC in the vault that takes NVDAx as collateral is ${lend('supply')} a year.`,
      `A taxa de fornecimento de USDC no cofre que aceita NVDAx como colateral é ${lend('supply')} ao ano.`,
    ]);
  });

  it("B3 and F2: a market's figure is never read back as the person's or the vault's own", async () => {
    await cut([
      `Your share of NVDAx is ${share}.`,
      `Your NVDAx share is ${share}.`,
      `You can withdraw ${lend('withdrawable')} of USDC now.`,
      `NVDAx's share is ${share}.`,
      `The share of NVDAx in its largest pool is ${share}.`,
      `Your stake in NVDAx changed by ${change} over the last week.`,
      `I see the price change over the last week was ${change}.`,
      `A sua parcela de NVDAx é ${share}.`,
      // the re-review's probes
      `You are able to withdraw ${lend('withdrawable')} of USDC from that vault now.`,
      `If you want, ${lend('withdrawable')} of USDC is available to withdraw now.`,
      `Withdraw ${lend('withdrawable')} of USDC now.`,
      `Pode sacar ${lend('withdrawable')} de USDC agora.`,
      `Dá pra sacar ${lend('withdrawable')} de USDC agora.`,
      `Vc pode sacar ${lend('withdrawable')} de USDC agora.`,
      `We can withdraw ${lend('withdrawable')} of USDC from that vault now.`,
      `The vault can withdraw ${lend('withdrawable')} of USDC now.`,
      `The vault holds ${share} of the dollars in NVDAx's pools.`,
      `This vault holds ${share} of the dollars in NVDAx's pools.`,
      `O cofre tem ${share} da liquidez dos pools do NVDAx.`,
      `Our holding is ${share} of the dollars in NVDAx's pools.`,
      `We hold ${share} of the dollars in NVDAx's pools.`,
      `Ur share is ${share} of the dollars in NVDAx's pools.`,
      `A person holding NVDAx owns ${share} of the dollars in its pools.`,
      `The vault's NVDAx changed by ${change} over the last week.`,
      `Our NVDAx price change over the last week was ${change}.`,
      `Sell NVDAx: its largest pool holds ${share} of the dollars in its pools.`,
      `Se quiser, pode sacar ${lend('withdrawable')} de USDC agora.`,
      `The share held by us is ${share} of the dollars in NVDAx's pools.`,
      `NVDAx's pools give u ${share} of the dollars in its pools.`,
      // the last re-review's variant
      `${lend('withdrawable')} of USDC can be withdrawn by you now.`,
    ]);
    await served([
      ...HONEST,
      `Its largest pool holds ${share} of the dollars in its pools.`,
      `NVDAx's largest pool has ${share} of its pool liquidity.`,
      `The price change of NVDAx over the last week was ${change}.`,
      `Os credores podem sacar ${lend('withdrawable')} de USDC desse cofre agora.`,
      `${lend('withdrawable')} of USDC is available to withdraw from that vault now.`,
      `The utilisation of that vault is ${lend('util')}.`,
      // a noun at the head of a sentence is no order (the last re-review)
      `Sell volume of NVDAx over the last week was ${id('bars:solana:nvdax:7d:sellvol')}.`,
      `Buy volume of NVDAx over the last week was ${id('bars:solana:nvdax:7d:buyvol')}.`,
      `Supply rate of USDC in that vault: ${lend('supply')} a year.`,
      // "US" is not "us"
      `NVDAx, a token of a US stock, moved ${change} over the last week.`,
    ]);
  });

  it('F3: a sentence beside a looked-up figure that refers to it carries the misreading', async () => {
    await cut([
      `The supply rate of USDC in that vault is ${lend('supply')} a year. That is NVDAx's yield.`,
      `The supply rate of USDC in that vault is ${lend('supply')} a year. That is what NVDAx pays.`,
      `The supply rate of USDC in that vault is ${lend('supply')} a year. You'd earn that on NVDAx.`,
      `NVDAx's largest pool holds ${share} of the dollars in its pools. That's your share.`,
      `NVDAx's largest pool holds ${share} of the dollars in its pools. You own that much.`,
      `Holders made money. The price change of NVDAx over the last week was ${change}.`,
      `The price change of NVDAx over the last week was ${change}. Holders made money.`,
      `NVDAx performed well this week. The price change of NVDAx over the last week was ${change}.`,
      `NVDAx did well this week. The price change of NVDAx over the last week was ${change}.`,
      `This is what you earn: the supply rate of USDC in that vault is ${lend('supply')} a year.`,
      `Lenders can withdraw ${lend('withdrawable')} of USDC from that vault now. You can take it out today.`,
      `O preço de fechamento mais recente do NVDAx foi ${close}. Isso é o seu lucro.`,
    ]);
    await served([
      `The supply rate of USDC in that vault is ${lend('supply')} a year. It can change at any time.`,
      `The supply rate of USDC in that vault is ${lend('supply')} a year. It is not guaranteed.`,
      `The supply rate of USDC in that vault is ${lend('supply')} a year. Rates in lending markets move with demand.`,
      `This is what I found. NVDAx moved ${change} over the last week.`,
      `Yes, you can lend USDC on Jupiter Lend. The supply rate of USDC in that vault is ${lend('supply')} a year.`,
    ]);
    // the figures that were before the lookups are judged as they were: the rule reads only a lookup's
    const vault = await resolverOf(true);
    const sentence = `Your NVDAx is worth ${id('holding:solana:nvdax:value')}. That is what you hold.`;
    expect(vault.unbacked(sentence)).toEqual([]);
  });

  it('S3 and F4: a change is never called a performance or a result', async () => {
    await cut([
      `NVDAx's performance over the last week was a change of ${change}.`,
      `NVDAx performed a change of ${change} over the last week.`,
      `NVDAx made a change of ${change} over the last week.`,
      `O desempenho do NVDAx foi uma variação de ${change} na semana.`,
      // the re-review's
      `NVDAx's result over the last week was a change of ${change}.`,
      `NVDAx delivered a change of ${change} over the last week.`,
      `NVDAx was a winner, with a change of ${change} over the last week.`,
      `NVDAx was the loser, with a change of ${change} over the last week.`,
      `The price change of NVDAx over the last week was ${change}, a good week.`,
      `The price change of NVDAx over the last week was ${change}, a weak month.`,
      `O resultado do NVDAx na semana foi uma variação de ${change}.`,
      `O NVDAx entregou uma variação de ${change} na semana.`,
      `O NVDAx foi o vencedor, com uma variação de ${change} na semana.`,
    ]);
    await served(HONEST);
  });
});

describe("Bearing's figures in the lookups", () => {
  it('O2: a unit the answer cannot carry is a missing figure, never a fact without a unit', () => {
    const built = bearingAnswer('solana:nvdax', [
      {
        metric: 'exit_worst',
        regime: 'us_market_hours',
        value: 120,
        unit: 'seconds',
        source: 'test',
        method: 'test',
        fetchedAt: '2026-10-14T00:00:00.000Z',
        provenance: 'live',
      },
    ]);
    expect(built.facts).toEqual([]);
    expect(built.missing).toEqual([
      expect.objectContaining({ id: 'exit:solana:nvdax:worst', reason: 'not_a_number' }),
    ]);
  });
});
