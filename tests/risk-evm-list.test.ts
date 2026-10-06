import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AssetList } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { CHAINS, type ChainConfig } from '../scripts/risk-evm/config';
import { type AssetSnapshotRow, GRID_USD, type PoolQuotes } from '../scripts/risk-evm/curve';
import {
  type CutForCollector,
  type ListedPool,
  listCandidates,
  listRun,
  POOLS_METHOD_VERSION,
  type PoolSnapshotRow,
  poolRows,
} from '../scripts/risk-evm/listed';
import type { PoolCache, PoolRef } from '../scripts/risk-evm/pools';
import { replayRpc } from '../scripts/risk-evm/replay';
import type { RpcReply } from '../scripts/risk-evm/rpc';
import { collectOnce } from '../scripts/risk-evm/run';

// PLAN-UNIVERSE RU.6: the collector reads the asset list and keeps every reachable pool. The fixture is
// two real runs for NVDA and GME at one block (scripts/risk-evm/record-list-fixture.ts): every reachable
// pool of the cut, then the three deepest. No test calls the network; a replay throws on any request
// the recording was not asked.
type Fixture = {
  provenance: string;
  fetchedAt: string;
  block: number;
  names: { list: string; cut: string };
  list: Pick<AssetList, 'chain' | 'inputs' | 'assets'>;
  cut: CutForCollector;
  threePools: PoolCache;
  recorded: { all: { rows: number; rpcCalls: number }; three: { rows: number } };
  answers: Record<string, RpcReply>;
};
const fx = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk-evm/robinhood-list-run.json.gz')).toString(),
) as Fixture;
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const fresh = () => JSON.parse(JSON.stringify(fx)) as Fixture;
const plan = (f: Fixture = fx) => listRun(robinhood, f.list, f.cut, f.names);
const jsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

async function replay(
  mode: 'list' | 'three',
  o: { maxPools?: number; oldCut?: string; refuse?: boolean } = {},
) {
  const { tokens, listed } = plan();
  const dir = mkdtempSync(join(tmpdir(), `risk-evm-${mode}-`));
  if (mode === 'three')
    writeFileSync(join(dir, 'pools-robinhood.json'), JSON.stringify(fx.threePools));
  if (o.oldCut)
    writeFileSync(
      join(dir, 'pools-robinhood-list.json'),
      JSON.stringify({
        ...fx.threePools,
        maxPools: Number.MAX_SAFE_INTEGER,
        cut: o.oldCut,
        // two days old, so the run confirms it again
        discoveredAt: new Date(
          Date.parse(fx.threePools.discoveredAt) - 48 * 3_600_000,
        ).toISOString(),
      }),
    );
  // the confirmation is the only call at 'latest': the endpoint refuses it
  const rpc = replayRpc(fx.answers, (r) =>
    o.refuse && r.method === 'eth_call' && (r.params as unknown[])[1] === 'latest'
      ? { error: { message: 'rate limit exceeded' } }
      : undefined,
  );
  const events: Record<string, unknown>[] = [];
  const summary = await collectOnce(
    { ...robinhood, tokens },
    {
      dir,
      maxPools: o.maxPools ?? (mode === 'list' ? Number.MAX_SAFE_INTEGER : 3),
      minLiquidityUsd: 10_000,
      poolsMaxAgeHours: 24,
      rediscover: false,
      ...(mode === 'list' ? { listed } : {}),
      rpc,
      // a moment after the list was confirmed, so the three-pool list is fresh
      now: () => Date.parse(fx.threePools.discoveredAt) + 1_000,
      sleep: async () => {},
      log: (e) => events.push(e),
    },
  );
  const day = fx.fetchedAt.slice(0, 10);
  return {
    dir,
    summary,
    events,
    asked: rpc.asked.length,
    assets: jsonl<AssetSnapshotRow>(join(dir, 'assets', `${day}.jsonl`)),
    pools: jsonl<PoolSnapshotRow>(join(dir, 'pools', `${day}.jsonl`)),
  };
}

describe('a run on the asset list, replayed', async () => {
  const all = await replay('list');
  const three = await replay('three');

  it('the fixture says what it is', () => {
    expect(fx.provenance).toBe('fixture');
    expect(fx.names.cut).toBe('cut-robinhood-20261005T1947.json');
    expect(fx.list.assets.map((a) => a.symbol).sort()).toEqual(['GME', 'NVDA']);
  });

  it('writes one evmq-0.1 asset row per tracked stock, at one block, as the recording did', () => {
    expect(all.summary.rows).toBe(fx.recorded.all.rows);
    expect(all.assets.map((r) => r.asset).sort()).toEqual(['GME', 'NVDA']);
    for (const r of all.assets) {
      expect(r.methodVersion).toBe('evmq-0.1');
      expect(r.slot).toBe(fx.block);
      expect(r.provenance).toBe('live');
      expect(r.source).toContain(`pool list from ${fx.names.cut} through ${fx.names.list}`);
    }
    expect(all.asked).toBe(fx.recorded.all.rpcCalls);
    expect(all.summary.poolsRediscovered).toBe(true);
  });

  it('writes the token address as the cut spells it, which is the hand list`s spelling', () => {
    const nvda = robinhood.tokens.find((t) => t.symbol === 'NVDA');
    expect(all.assets.find((r) => r.asset === 'NVDA')?.assetMint).toBe(nvda?.address);
    const gme = all.assets.find((r) => r.asset === 'GME')?.assetMint as string;
    expect(gme).not.toBe(gme.toLowerCase());
    expect(gme.toLowerCase()).toBe(fx.list.assets.find((a) => a.symbol === 'GME')?.address);
  });

  it('writes one pool row per reachable pool, quoted or with the reason it is not', () => {
    const reachable = fx.list.assets.reduce((n, a) => n + (a.pools.reachable ?? 0), 0);
    expect(all.pools).toHaveLength(reachable);
    expect(all.summary.list).toMatchObject({
      poolRows: reachable,
      list: fx.names.list,
      cut: fx.names.cut,
    });
    expect(new Set(all.pools.map((p) => p.pool)).size).toBe(reachable);
    const listed = new Set(fx.cut.pools.filter((p) => p.reachable).map((p) => p.address));
    const reasons: Record<string, number> = {};
    for (const p of all.pools) {
      expect(listed.has(p.pool)).toBe(true);
      expect(p.methodVersion).toBe(POOLS_METHOD_VERSION);
      expect(p.slot).toBe(fx.block);
      expect(p.source.length).toBeGreaterThan(0);
      expect(p.quoted).toBe(p.reason === null);
      if (p.reason) reasons[p.reason] = (reasons[p.reason] ?? 0) + 1;
      if (p.quoted) {
        expect(p.sell).toHaveLength(GRID_USD.length);
        expect(p.buy).toHaveLength(GRID_USD.length);
        expect(p.midUsd).toBeGreaterThan(0);
        expect(p.fee).not.toBeNull();
        expect([...(p.sell ?? []), ...(p.buy ?? [])].some((x) => x.outUsd !== null)).toBe(true);
      } else {
        // a missing quote is null, never a zero
        expect(p.sell).toBeNull();
        expect(p.buy).toBeNull();
      }
    }
    expect(reasons).toEqual(all.summary.list?.poolRowsByReason);
    expect(reasons.not_against_the_dollar_token).toBe(
      fx.cut.pools.filter((p) => p.reachable && p.otherSymbol !== 'USDG').length,
    );
    // an unreachable pool (DU3) has no row and was never asked
    const unreachable = fx.cut.pools.filter((p) => !p.reachable);
    expect(unreachable.length).toBeGreaterThan(0);
    for (const u of unreachable) expect(all.pools.some((p) => p.pool === u.address)).toBe(false);
  });

  it('the asset row is the best of the pool rows at each size', () => {
    for (const row of all.assets) {
      const mine = all.pools.filter((p) => p.asset === row.asset && p.quoted);
      expect(row.pools).toBe(mine.length);
      for (const side of ['sell', 'buy'] as const)
        for (const [i, point] of row[side].entries()) {
          const outs = mine.flatMap((p) => p[side]?.[i]?.outUsd ?? []);
          expect(point.quoted).toBe(outs.length);
          expect(point.outUsd).toBe(outs.length ? Math.max(...outs) : null);
        }
    }
  });

  it('with every pool the cost at each size is equal to or lower than with three pools, at the same block', () => {
    expect(three.summary.block).toBe(all.summary.block);
    expect(three.summary.rows).toBe(fx.recorded.three.rows);
    expect(three.summary.poolsRediscovered).toBe(false);
    for (const t of three.assets) {
      const a = all.assets.find((r) => r.asset === t.asset) as AssetSnapshotRow;
      expect(t.pools).toBeLessThanOrEqual(3);
      expect(a.pools).toBeGreaterThanOrEqual(t.pools);
      for (const side of ['sell', 'buy'] as const)
        for (const [i, point] of t[side].entries()) {
          const wide = a[side][i]?.costPct ?? null;
          if (point.costPct === null) continue;
          expect(wide).not.toBeNull();
          expect(wide as number).toBeLessThanOrEqual(point.costPct);
        }
    }
    // Equal at every size in this recording: the best single pool was already among the three deepest.
    // On the full run of Oct 6 a pool beyond the three was the best at 4 of 480 points (PLAN-UNIVERSE
    // section 6, RU.6). What the wider run adds is the pool rows, not a cheaper asset row.
  });

  it('with a pool limit, a confirmed pool left out says so and is not asked', async () => {
    const limited = await replay('list', { maxPools: 3 });
    const reasons = limited.summary.list?.poolRowsByReason ?? {};
    expect(reasons.not_confirmed_on_chain).toBeUndefined();
    expect(reasons.beyond_the_pool_limit).toBe(
      fx.cut.pools.filter((p) => p.reachable && p.otherSymbol === 'USDG').length - 6,
    );
    // the same three pools a token as the three-pool run, so the same asset rows but for their source
    const strip = (r: AssetSnapshotRow) => ({ ...r, source: '' });
    expect(limited.assets.map(strip)).toEqual(three.assets.map(strip));
  });

  it('never falls back to pools confirmed from another cut', async () => {
    await expect(
      replay('list', { oldCut: 'cut-robinhood-OLD.json', refuse: true }),
    ).rejects.toThrow(/rate limit/);
    // the same refusal with this cut's own list on file, grown old: the run goes on with it, as the plain run does
    const own = await replay('list', { oldCut: fx.names.cut, refuse: true });
    expect(own.summary.rows).toBe(2);
    expect(own.events.some((e) => e.event === 'discover_failed_using_old_list')).toBe(true);
  });

  it('a run without the list is as it was: no pool file, no list in its summary', () => {
    expect(three.summary.list).toBeUndefined();
    expect(three.pools).toEqual([]);
    expect(existsSync(join(three.dir, 'pools'))).toBe(false);
    expect(existsSync(join(three.dir, 'pools-robinhood-list.json'))).toBe(false);
    for (const r of three.assets) expect(r.source).toContain('pool list from DexScreener');
    // and a list run leaves the hand list's pool file alone
    expect(existsSync(join(all.dir, 'pools-robinhood.json'))).toBe(false);
    expect(existsSync(join(all.dir, 'pools-robinhood-list.json'))).toBe(true);
  });
});

describe('the list and its cut', () => {
  it('gives the tokens of the list and every ranked pool of each, deepest first', () => {
    const { tokens, listed } = plan();
    expect(tokens.map((t) => t.symbol)).toEqual(fx.list.assets.map((a) => a.symbol));
    for (const a of fx.list.assets) {
      const pools = listed.pools[a.symbol] as ListedPool[];
      expect(pools).toHaveLength(a.pools.ranked);
      const tvl = pools.map((p) => p.tvlUsd ?? 0);
      expect(tvl).toEqual([...tvl].sort((x, y) => y - x));
    }
    // TSM is in the hand list and not tracked: named, not read
    expect(listed.handListNotTracked).toContain('TSM');
    expect(listed.handListNotTracked).not.toContain('NVDA');
  });

  it('sends only reachable pools against the dollar token to be confirmed', () => {
    const { listed } = plan();
    const nvda = listed.pools.NVDA as ListedPool[];
    const cands = listCandidates(robinhood, nvda);
    const want = nvda.filter((p) => p.reachable && p.otherSymbol === 'USDG');
    expect(cands.map((c) => c.id)).toEqual(want.map((p) => p.id));
    expect(cands.length).toBeLessThan(nvda.filter((p) => p.reachable).length);
  });

  it('refuses a list written from another cut', () => {
    const other = fresh();
    other.names.cut = 'cut-robinhood-20261006T1947.json';
    expect(() => plan(other)).toThrow(
      /was written from cut-robinhood-20261005T1947.json, not from/,
    );
  });

  it('refuses a cut whose pools are not the ones the list counts, or that tracks other stocks', () => {
    const short = fresh();
    short.cut.pools.pop();
    expect(() => plan(short)).toThrow(/are not the \d+ the list counts/);
    const more = fresh();
    more.cut.tracked.push({ address: `0x${'12'.repeat(20)}`, symbol: 'XYZ' });
    expect(() => plan(more)).toThrow(/tracks 3 stocks and the list has 2 rows/);
    const gone = fresh();
    gone.cut.tracked = gone.cut.tracked.filter((t) => t.symbol !== 'GME');
    expect(() => plan(gone)).toThrow(/GME of the list is not tracked/);
    const renamed = fresh();
    (renamed.cut.tracked.find((t) => t.symbol === 'GME') as { symbol: string }).symbol = 'GMEX';
    expect(() => plan(renamed)).toThrow(/is GME in the list and GMEX in the cut/);
  });
});

describe('pool rows, by hand', () => {
  const dollar = robinhood.dollar.address.toLowerCase();
  const pool = (id: string, over: Partial<ListedPool> = {}): ListedPool => ({
    id,
    kind: 'cl',
    venue: 'uniswap-v3',
    other: dollar,
    otherSymbol: 'USDG',
    otherIsStock: false,
    reachable: true,
    tvlUsd: 1_000,
    ...over,
  });
  const ref = (id: string): PoolRef => ({
    kind: 'cl',
    id,
    dex: 'uniswap-v3',
    tokenIs0: true,
    fee: 3000,
    tickSpacing: 60,
    liquidityUsd: 1_000,
  });
  const grid = [100, 1_000];
  // 100 dollars sold for 99; 1,000 dollars sold with half the amount taken
  const quotes = (id: string, empty = false): PoolQuotes => ({
    pool: id,
    midUsd: 10,
    sellIn: [10n * 10n ** 18n, 100n * 10n ** 18n],
    buyIn: [100_000_000n, 1_000_000_000n],
    sell: empty
      ? [null, null]
      : [
          { out: 99_000_000n, filledIn: 10n * 10n ** 18n },
          { out: 450_000_000n, filledIn: 50n * 10n ** 18n },
        ],
    buy: empty ? [null, null] : [{ out: 99n * 10n ** 17n, filledIn: 100_000_000n }, null],
  });
  const rows = poolRows({
    chain: robinhood,
    token: { symbol: 'XYZ', address: `0x${'ab'.repeat(20)}`, decimals: 18 },
    listed: {
      list: 'list.json',
      cut: 'cut.json',
      cutFetchedAt: '2026-10-05T20:11:13.000Z',
      handListNotTracked: [],
      feeds: {},
      pools: {
        XYZ: [
          pool('0xa1'),
          pool('0xa2', { other: `0x${'ee'.repeat(20)}`, otherSymbol: 'native' }),
          pool('0xa3'),
          pool('0xa4'),
          pool('0xa5'),
          pool('0xa6'),
          pool('0xa7', { reachable: false }),
          pool('0xa8'),
        ],
      },
    },
    blockTime: new Date('2026-10-06T00:00:00.000Z'),
    blockNumber: 7,
    confirmed: ['0xa1', '0xa4', '0xa5', '0xa6', '0xa8'].map(ref),
    asked: ['0xa1', '0xa4', '0xa5', '0xa6'].map(ref),
    priced: [
      { ref: ref('0xa1'), midUsd: 10 },
      { ref: ref('0xa5'), midUsd: 14 },
      { ref: ref('0xa6'), midUsd: 10 },
    ],
    quotes: [quotes('0xa1'), quotes('0xa6', true)],
    source: 'by hand',
    grid,
  });
  const by = (id: string) => rows.find((r) => r.pool === id) as PoolSnapshotRow;

  it('gives a row to every reachable pool and none to an unreachable one', () => {
    expect(rows.map((r) => r.pool)).toEqual([
      '0xa1',
      '0xa2',
      '0xa3',
      '0xa4',
      '0xa5',
      '0xa6',
      '0xa8',
    ]);
  });

  it('computes a quoted pool`s cost against its own mid, the unfilled part counted as lost', () => {
    const r = by('0xa1');
    expect(r).toMatchObject({ quoted: true, reason: null, midUsd: 10, fee: 3000, slot: 7 });
    expect(r.sell?.[0]).toMatchObject({ notionalUsd: 100, outUsd: 99, unfilledShare: 0 });
    expect(r.sell?.[0]?.costPct).toBeCloseTo(1, 9);
    expect(r.sell?.[1]?.outUsd).toBe(450);
    expect(r.sell?.[1]?.costPct).toBeCloseTo(55, 9);
    expect(r.sell?.[1]?.unfilledShare).toBe(0.5);
    // 9.9 tokens at the pool's mid of 10
    expect(r.buy?.[0]?.outUsd).toBeCloseTo(99, 9);
    expect(r.buy?.[1]).toEqual({
      notionalUsd: 1_000,
      outUsd: null,
      costPct: null,
      unfilledShare: null,
    });
    expect(r.listTvlAt).toBe('2026-10-05T20:11:13.000Z');
  });

  it('names why a pool has no quote, and leaves its figures null', () => {
    expect(by('0xa2')).toMatchObject({ reason: 'not_against_the_dollar_token', fee: null });
    expect(by('0xa3')).toMatchObject({ reason: 'not_confirmed_on_chain', midUsd: null });
    expect(by('0xa4')).toMatchObject({ reason: 'no_price_at_the_block', fee: 3000 });
    expect(by('0xa5')).toMatchObject({ reason: 'mid_far_from_the_median', midUsd: 14 });
    expect(by('0xa6')).toMatchObject({ reason: 'no_quote_at_any_size', quoted: false });
    // asked and silent: a point per size, each null
    expect(by('0xa6').sell?.every((x) => x.outUsd === null && x.costPct === null)).toBe(true);
    expect(by('0xa8')).toMatchObject({ reason: 'beyond_the_pool_limit', fee: 3000, sell: null });
    for (const id of ['0xa2', '0xa3', '0xa4', '0xa5']) {
      expect(by(id).sell).toBeNull();
      expect(by(id).buy).toBeNull();
      expect(by(id).quoted).toBe(false);
    }
  });
});
