import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildPoolSim, decodeClmmPool } from '@colosseum/risk';
import { afterAll, describe, expect, it } from 'vitest';
import { readRecorded } from '../../apps/api/src/pool-recorded';
import {
  type AccountReader,
  captureBytes,
  loadCapture,
  type RegPool,
  readSplitCapture,
  type SplitCapture,
} from '../../scripts/risk/lib-split';
import {
  batchedReader,
  COLLECTOR_RAW_TOP_SHARE,
  collectorRecorded,
  encodeRecording,
  failedRunPools,
  folderRefusal,
  hourFolder,
  LIQUIDITY_CHECK_LIMIT,
  MAX_SLOT_GAP,
  planOf,
  poolOutcomes,
  RAW_ARRAYS_METHOD_VERSION,
  type RawSelection,
  runSummary,
  scrubbed,
  selectRawArrayPools,
  withholdingUndecodable,
} from '../../scripts/risk/raw-arrays/lib';
import solanaList from '../../scripts/risk/universe/solana.json';

// PLAN-UNIVERSE RU.12 — the raw-arrays job's part with no I/O (scripts/risk/raw-arrays/lib.ts): which pools a run
// reads, what becomes of each, and the bytes of a recording. On the collector's registry of 2026-10-01 as frozen under
// fixtures/risk/universe, and on mainnet accounts frozen 2026-10-07T04:31:05Z by
// `pnpm risk:split-capture --raw-arrays --only HOODx,STRCx` (fixtures/risk/raw-arrays): eleven pools the collector
// does not record, seven on Raydium, two on Orca and one on Meteora, three against dollars, three against SOL, one
// against another stock and four against other tokens. No test calls the network.
const c = loadCapture('fixtures/risk/raw-arrays/hoodx-strcx-20261007T0431.json.gz');
const tracked = new Set(solanaList.assets.map((a) => a.address));

const DZND = 'DznDQ6YVmgtZAvwZ4ui6k9MNun9uaozyVFFsiAeAs9f'; // HOODx/SOL, Raydium CLMM, 5 arrays
const P48D = '48dhPm83sXfnRMxKRfv2YuE45DPqrhwPMvGrnTLufvFf'; // HOODx/USDC, Orca, 11 arrays
const DQ8F = 'DQ8fjmP2haYxyyJRU99aCaHznK1GSihYyBRZxfP9sfbU'; // HOODx/SOL, Meteora DLMM, 6 arrays
const WBSD = 'wBsDf1BtQYN9W12V3Q7tVqYu3zixr7N2Sj3EKcLqvzy'; // HOODx against another token, Raydium CLMM
const pool = (address: string) => c.direct.find((p) => p.address === address) as RegPool;

// The frozen registry is two files of the same 2026-10-01 read: every pool with its TVL, and the 992 pools of the
// collector's registry with their mint, venue and exit path. The tier is not frozen: the collector's registry holds
// tiers A and B only, so every row is given A.
const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(f)).toString());
const tvl = new Map<string, { asset: string; tvlUsd: number }>(
  (
    gz('fixtures/risk/universe/solana-registry-20261001T0139.json.gz').pools as Array<{
      address: string;
      asset: string;
      tvlUsd: number;
    }>
  ).map((p) => [p.address, p]),
);
const registry = (
  gz('fixtures/risk/universe/solana-registry-detail-20261001T0139.json.gz').pools as Array<{
    address: string;
    mint: string;
    quoteMint: string;
    venue: RegPool['venue'];
    exitPath: string;
  }>
).map((p) => ({
  address: p.address,
  venue: p.venue,
  assetMint: p.mint,
  assetSymbol: tvl.get(p.address)?.asset ?? '',
  quoteMint: p.quoteMint,
  exitPath: p.exitPath,
  tier: 'A',
  tvlUsd: tvl.get(p.address)?.tvlUsd as number,
  assetIsToken0: 1,
  decimals0: 0,
  decimals1: 0,
  vault0: '',
  vault1: '',
  transferFeeBps0: 0,
  transferFeeBps1: 0,
}));

const count = <T>(xs: readonly T[], key: (x: T) => string) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};

describe('raw arrays: the collector’s own rule', () => {
  // The collector cannot be imported (it runs on import) and is not edited before Oct 12, so its rule is written
  // again in lib.ts. These are the lines the rule is read from: if one changes, this test says to look again.
  const src = readFileSync('scripts/risk/collector/pools.ts', 'utf8').replace(/\s+/g, ' ');
  it('is still the lines it was copied from', () => {
    expect(src).toContain(`const RAW_TOP_SHARE = ${COLLECTOR_RAW_TOP_SHARE};`);
    expect(src).toContain(
      "const isCl = (p: RegPool) => p.venue === 'raydium_clmm' || p.venue === 'orca_whirlpool';",
    );
    expect(src).toContain('const totalTvl = reg.pools.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);');
    expect(src).toContain(
      'for (const p of [...reg.pools].sort((a, b) => b.tvlUsd - a.tvlUsd)) { if (cum >= RAW_TOP_SHARE * totalTvl) break; cum += p.tvlUsd; rawSet.add(p.address); }',
    );
    // a pool gets a raw file only where its arrays were just read again, which is asked for Raydium and Orca only
    expect(src).toContain('if (isCl(p)) refreshCl.add(p.address);');
    expect(src).toContain('if (refreshCl.has(p.address) && rawSet.has(p.address)) {');
    expect(src).toContain("const rawDir = join(HOME, 'raw', day, String(now.getUTCHours())");
  });

  it('names the 32 Raydium and Orca pools of the 34 that hold 80% of the registry', () => {
    const rec = collectorRecorded(registry);
    const rows = registry.filter((p) => rec.has(p.address));
    expect(count(rows, (p) => p.venue)).toEqual({ raydium_clmm: 28, orca_whirlpool: 4 });
    // the 80% set itself: two more pools, one constant-product and one on Meteora, neither ever written
    const total = registry.reduce((s, p) => s + p.tvlUsd, 0);
    const sorted = [...registry].sort((a, b) => b.tvlUsd - a.tvlUsd);
    let cum = 0;
    let n = 0;
    while (cum < COLLECTOR_RAW_TOP_SHARE * total) cum += (sorted[n++] as { tvlUsd: number }).tvlUsd;
    expect(n).toBe(34);
    expect(count(sorted.slice(0, n), (p) => p.venue)).toEqual({
      raydium_clmm: 28,
      orca_whirlpool: 4,
      raydium_cpmm: 1,
      meteora_dlmm: 1,
    });
    // every one of them is a pool of a tracked stock
    expect(rows.every((p) => tracked.has(p.assetMint))).toBe(true);
  });
});

describe('raw arrays: the pools one run reads', () => {
  const sel = selectRawArrayPools(registry, { tracked });
  // the one pool that pairs two stock tokens and is filed under the one that is not tracked: TQQQx/SPYx, Orca
  const BZTQ = 'Bztq1RwZmU4L7cCnkh5pVz4LnRZ2YUMBzQ5VC2ETg789';

  it('the 260 concentrated-liquidity pools of the 18: 32 the collector writes, 228 read', () => {
    expect(sel.all).toHaveLength(260);
    expect(count(sel.all, (p) => p.venue)).toEqual({
      raydium_clmm: 163,
      orca_whirlpool: 61,
      meteora_dlmm: 36,
    });
    expect(count(sel.all, (p) => p.exitPath)).toEqual({
      direct_usd: 71,
      via_sol: 58,
      via_xstock: 23,
      other: 108,
    });
    expect(sel.collector).toHaveLength(32);
    expect(sel.leftToCollector).toEqual(sel.collector);
    expect(sel.leftOutBySetting).toHaveLength(0);
    expect(sel.notUnderstood).toEqual([]);
    expect(sel.read).toHaveLength(228);
    expect(count(sel.read, (p) => p.exitPath)).toEqual({
      direct_usd: 45,
      via_sol: 54,
      via_xstock: 23,
      other: 106,
    });
    expect(count(sel.read, (p) => p.venue)).toEqual({
      raydium_clmm: 135,
      orca_whirlpool: 57,
      meteora_dlmm: 36,
    });
    // the Meteora pool of the 80% set is read here, because the collector never writes one
    expect(sel.read.some((p) => p.address === 'FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1')).toBe(
      true,
    );
    expect(Math.round(sel.read.reduce((s, p) => s + p.tvlUsd, 0))).toBe(4_774_738);
    expect(Math.round(sel.leftToCollector.reduce((s, p) => s + p.tvlUsd, 0))).toBe(32_405_046);
  });

  it('259 are filed under a tracked stock; one pairs two stocks and has the tracked one on the other side', () => {
    const filed = sel.all.filter((p) => tracked.has(p.assetMint));
    expect(filed).toHaveLength(259);
    const other = sel.all.filter((p) => !tracked.has(p.assetMint));
    expect(other.map((p) => [p.address, p.exitPath, tracked.has(p.quoteMint)])).toEqual([
      [BZTQ, 'via_xstock', true],
    ]);
    expect(sel.read.some((p) => p.address === BZTQ)).toBe(true);
    // a pool against another token whose quote happened to be tracked would not be taken: the rule is for stock pairs
    const row = registry.find((p) => p.address === BZTQ) as (typeof registry)[0];
    const asOther = registry.map((p) => (p === row ? { ...p, exitPath: 'other' } : p));
    expect(selectRawArrayPools(asOther, { tracked }).all).toHaveLength(259);
  });

  it('set to read every pool, the collector’s 32 are read too and still named as the collector’s', () => {
    const every = selectRawArrayPools(registry, { tracked, everyPool: true });
    expect(every.read).toHaveLength(260);
    expect(every.leftToCollector).toEqual([]);
    expect(every.collector.map((p) => p.address)).toEqual(sel.collector.map((p) => p.address));
    expect(count(every.read, (p) => p.exitPath)).toEqual({
      direct_usd: 71,
      via_sol: 58,
      via_xstock: 23,
      other: 108,
    });
  });

  it('every pool is in exactly one of the three lists, whatever the settings', () => {
    for (const everyPool of [false, true])
      for (const skip of [[], ['other'], ['other', 'via_xstock'], ['direct_usd', 'via_sol']]) {
        const s = selectRawArrayPools(registry, {
          tracked,
          skipExitPaths: new Set(skip),
          everyPool,
        });
        const seen = [...s.read, ...s.leftToCollector, ...s.leftOutBySetting].map((p) => p.address);
        expect(seen).toHaveLength(260);
        expect(new Set(seen).size).toBe(260);
        expect(s.read.some((p) => skip.includes(p.exitPath))).toBe(false);
        expect(s.collector).toHaveLength(32);
      }
    const s = selectRawArrayPools(registry, { tracked, skipExitPaths: new Set(['other']) });
    // the setting takes nothing from the pools left to the collector: its two pools against other tokens stay its own
    expect(s.leftToCollector).toHaveLength(32);
    expect(s.leftOutBySetting).toHaveLength(106);
    expect(s.read).toHaveLength(122);
  });

  it('a pool of a stock that is not tracked and a constant-product pool are no part of it', () => {
    expect(sel.all.some((p) => p.venue === 'raydium_cpmm')).toBe(false);
    const untracked = registry.filter(
      (p) => !tracked.has(p.assetMint) && !tracked.has(p.quoteMint) && p.venue !== 'raydium_cpmm',
    );
    expect(untracked.length).toBeGreaterThan(0);
    expect(untracked.some((p) => sel.all.some((a) => a.address === p.address))).toBe(false);
  });

  it('a pool of a tracked stock on a venue or in a tier the selection does not know is named, not dropped', () => {
    const one = registry.find((p) => p.address === sel.read[0]?.address) as (typeof registry)[0];
    const others = registry.filter((p) => p !== one);
    for (const odd of [
      { ...one, tier: 'X' },
      { ...one, venue: 'some_new_venue' as never },
    ]) {
      const x = selectRawArrayPools([...others, odd], { tracked });
      expect(x.all).toHaveLength(259);
      expect(x.notUnderstood.map((p) => p.address)).toEqual([one.address]);
    }
  });

  it('the plan counts the accounts and the calls of a run from the cache alone', () => {
    const s = selectRawArrayPools(c.direct, { tracked });
    // the eleven pools alone: the largest of them hold 80% of their own total, so the rule leaves them to the collector
    expect(s.read.length + s.leftToCollector.length).toBe(11);
    const all = selectRawArrayPools(c.direct, { tracked, everyPool: true });
    const plan = planOf(all, c.children);
    expect(plan.read).toMatchObject({ pools: 11, arrays: 68 });
    expect(plan.accounts).toBe(79);
    expect(plan.rpcCalls).toBe(2);
    expect(plan.noArraysInCache).toEqual([]);
    expect(plan.notUnderstood).toEqual([]);
    expect(Object.keys(plan.readByStock)).toEqual(['HOODx', 'STRCx']);
    expect(planOf(all, {}).noArraysInCache).toHaveLength(11);
  });
});

// a capture with some accounts changed: null for one the chain did not return
const withAccounts = (patch: Record<string, string | null>): SplitCapture => ({
  ...c,
  accounts: { ...c.accounts, ...patch },
});
const simOf = (cap: SplitCapture, p: RegPool) => {
  const head = captureBytes(cap, p.address) as Uint8Array;
  return buildPoolSim(
    p,
    head,
    (cap.children[p.address] ?? [])
      .map((k) => captureBytes(cap, k))
      .filter((d): d is Uint8Array => !!d),
    p.venue === 'raydium_clmm' ? captureBytes(cap, decodeClmmPool(head).ammConfig) : undefined,
  );
};
// the accounts of a Raydium list that are tick arrays (10,240 bytes); the other is the pool's bitmap extension
const tickArrays = (a: string) =>
  (c.children[a] as string[]).filter((k) => (captureBytes(c, k) as Uint8Array).length === 10_240);

describe('raw arrays: what becomes of each pool', () => {
  const outcomes = poolOutcomes(c, c.direct, {
    childrenAt: { [DZND]: '2026-10-07T03:40:00.000Z' },
  });

  it('every pool of the fixture is written, in the order given, with nothing flagged', () => {
    expect(outcomes.map((o) => o.pool.address)).toEqual(c.direct.map((p) => p.address));
    expect(outcomes.every((o) => o.written)).toBe(true);
    for (const o of outcomes) if (o.written) expect(o.flags).toEqual({});
  });

  it('a recording is the collector’s seven keys in its order, then this job’s own', () => {
    for (const o of outcomes) {
      if (!o.written) throw new Error('not written');
      const r = o.recording;
      expect(Object.keys(r)).toEqual([
        'pool',
        'venue',
        'slot',
        'fetchedAt',
        'head',
        'children',
        'config',
        'slotHead',
        'childrenListedAt',
        'invariantRelErr',
        'source',
        'method',
        'methodVersion',
        'provenance',
      ]);
      expect(r.pool).toBe(o.pool.address);
      expect(r.venue).toBe(o.pool.venue);
      // with no slot per account given, the two slots are the run's
      expect(r.slot).toBe(c.slot);
      expect(r.slotHead).toBe(c.slotHeads);
      expect(r.fetchedAt).toBe(c.fetchedAt);
      expect(r.methodVersion).toBe(RAW_ARRAYS_METHOD_VERSION);
      expect(r.provenance).toBe('live');
      // every address the cache lists, in its order, each with the bytes the chain returned
      expect(Object.keys(r.children)).toEqual(c.children[o.pool.address]);
      for (const [k, v] of Object.entries(r.children)) expect(v).toBe(c.accounts[k]);
      expect(r.head).toBe(c.accounts[o.pool.address]);
      // the fee config is Raydium's alone
      if (o.pool.venue === 'raydium_clmm') {
        const cfgKey = decodeClmmPool(captureBytes(c, o.pool.address) as Uint8Array).ammConfig;
        expect(r.config).toBe(c.accounts[cfgKey]);
      } else expect(r.config).toBeNull();
      const listed = Object.keys(r.children).length;
      // a Raydium list holds one account that is no tick array: the pool's bitmap extension
      expect(o.arrays).toEqual({
        listed,
        returned: listed,
        decoded: o.pool.venue === 'raydium_clmm' ? listed - 1 : listed,
      });
    }
    const dznd = outcomes.find((o) => o.pool.address === DZND);
    expect(dznd?.written && dznd.recording.childrenListedAt).toBe('2026-10-07T03:40:00.000Z');
    const p48d = outcomes.find((o) => o.pool.address === P48D);
    expect(p48d?.written && p48d.recording.childrenListedAt).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), 'raw-arrays-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a file read back by the API’s reader builds the same simulator as the capture it was written from', () => {
    for (const o of outcomes) {
      if (!o.written) throw new Error('not written');
      const p = o.pool;
      const file = join(dir, `${p.address}.json.gz`);
      writeFileSync(file, encodeRecording(o.recording));
      const rec = readRecorded(file);
      if (!rec) throw new Error(`the reader does not read ${file}`);
      expect(rec.pool).toBe(p.address);
      expect(rec.venue).toBe(p.venue);
      expect(rec.slot).toBe(c.slot);
      expect(rec.fetchedAt).toBe(c.fetchedAt);
      const cfg = o.recording.config
        ? new Uint8Array(Buffer.from(o.recording.config, 'base64'))
        : undefined;
      const fromFile = buildPoolSim(p, rec.head, rec.kids, cfg);
      const fromCapture = simOf(c, p);
      expect(fromFile.sim.midRaw).toBe(fromCapture.sim.midRaw);
      expect(fromFile.sim.midRaw).toBeGreaterThan(0);
      expect(fromFile.feeRate).toBe(fromCapture.feeRate);
      expect(fromFile.invariantRelErr).toBe(fromCapture.invariantRelErr);
      expect(o.recording.invariantRelErr).toBe(fromCapture.invariantRelErr);
      expect(fromFile.sim.depthWithin(0.02)).toEqual(fromCapture.sim.depthWithin(0.02));
      for (const x of [1, 1e3, 1e5, 1e7, 1e9, 1e11, 1e13]) {
        expect(fromFile.sim.sellAsset(x)).toEqual(fromCapture.sim.sellAsset(x));
        expect(fromFile.sim.buyAsset(x)).toEqual(fromCapture.sim.buyAsset(x));
      }
    }
    // Raydium and Orca pools pass the collector's liquidity check on what was read; Meteora has none
    for (const o of outcomes) {
      if (!o.written) continue;
      if (o.pool.venue === 'meteora_dlmm') expect(o.recording.invariantRelErr).toBeNull();
      else expect(o.recording.invariantRelErr).toBeLessThanOrEqual(LIQUIDITY_CHECK_LIMIT);
    }
  });

  it('no pool account, or one with no data: head_missing, and no recording', () => {
    for (const head of [null, '']) {
      const [o] = poolOutcomes(withAccounts({ [DZND]: head }), [pool(DZND)]);
      expect(o).toEqual({ pool: pool(DZND), written: false, reason: 'head_missing', detail: null });
    }
  });

  it('no account in the cache’s list: no_arrays_in_cache', () => {
    const [none] = poolOutcomes({ ...c, children: { ...c.children, [P48D]: [] } }, [pool(P48D)]);
    expect(none).toMatchObject({ written: false, reason: 'no_arrays_in_cache' });
    const { [P48D]: _gone, ...rest } = c.children;
    expect(poolOutcomes({ ...c, children: rest }, [pool(P48D)])[0]).toMatchObject({
      written: false,
      reason: 'no_arrays_in_cache',
    });
  });

  it('none of the listed arrays returned: no_array_read on every venue, also when Raydium’s bitmap extension came back', () => {
    for (const a of [DQ8F, P48D]) {
      const kids = c.children[a] as string[];
      const [o] = poolOutcomes(withAccounts(Object.fromEntries(kids.map((k) => [k, null]))), [
        pool(a),
      ]);
      expect(o).toMatchObject({
        written: false,
        reason: 'no_array_read',
        detail: `${kids.length} listed, 0 returned`,
      });
    }
    // Raydium: the four tick arrays gone, the bitmap extension still there. It is no tick array.
    const gone = Object.fromEntries(tickArrays(DZND).map((k) => [k, null]));
    expect(Object.keys(gone)).toHaveLength(4);
    expect(poolOutcomes(withAccounts(gone), [pool(DZND)])[0]).toMatchObject({
      written: false,
      reason: 'no_array_read',
      detail: '5 listed, 1 returned',
    });
  });

  it('bytes that do not decode: decode_failed with what the decoder said, on every venue', () => {
    const cut = (key: string, to: number) =>
      Buffer.from((captureBytes(c, key) as Uint8Array).subarray(0, to)).toString('base64');
    for (const a of [DZND, P48D, DQ8F]) {
      const [o] = poolOutcomes(withAccounts({ [a]: cut(a, 40) }), [pool(a)]);
      expect(o).toMatchObject({ written: false, reason: 'decode_failed' });
      expect(o?.written === false && o.detail).toBeTruthy();
    }
    // a bin array cut short is not a bin array
    const bin = (c.children[DQ8F] as string[])[0] as string;
    expect(poolOutcomes(withAccounts({ [bin]: cut(bin, 100) }), [pool(DQ8F)])[0]).toMatchObject({
      written: false,
      reason: 'decode_failed',
    });
  });

  it('one listed array not returned, or returned with no data: written, the address kept with no bytes, counted, skipped by the reader', () => {
    const kids = c.children[DZND] as string[];
    for (const venue of [DZND, P48D, DQ8F])
      for (const empty of [null, '']) {
        const list = c.children[venue] as string[];
        // the last array of each of these pools holds nothing the pool's price or liquidity check needs
        const gone = list[list.length - 1] as string;
        const [o] = poolOutcomes(withAccounts({ [gone]: empty }), [pool(venue)]);
        if (!o?.written) throw new Error(`${venue} not written`);
        expect(o.flags.arraysMissing).toBe(1);
        expect(o.arrays.listed).toBe(list.length);
        expect(o.arrays.returned).toBe(list.length - 1);
        expect(Object.keys(o.recording.children)).toEqual(list);
        expect(o.recording.children[gone]).toBe('');
      }
    const gone = kids[4] as string;
    const [o] = poolOutcomes(withAccounts({ [gone]: null }), [pool(DZND)]);
    if (!o?.written) throw new Error('not written');
    expect(o.flags).toEqual({ arraysMissing: 1 });
    const file = join(dir, 'missing-one.json.gz');
    writeFileSync(file, encodeRecording(o.recording));
    expect(readRecorded(file)?.kids).toHaveLength(4);
  });

  it('arrays that do not add up to the pool’s liquidity: written as read, and flagged with how far off', () => {
    const kids = c.children[DZND] as string[];
    // the first array of this pool holds initialized ticks below the price
    const [o] = poolOutcomes(withAccounts({ [kids[0] as string]: null }), [pool(DZND)]);
    if (!o?.written) throw new Error('not written');
    expect(o.flags.arraysMissing).toBe(1);
    expect(o.flags.liquidityCheckFailed).toBeGreaterThan(LIQUIDITY_CHECK_LIMIT);
    expect(o.recording.invariantRelErr).toBe(o.flags.liquidityCheckFailed);
    // the same when the cache simply does not list the array: nothing is missing, and the check still says so
    const stale = { ...c, children: { ...c.children, [DZND]: kids.slice(1) } };
    const [s] = poolOutcomes(stale, [pool(DZND)]);
    if (!s?.written) throw new Error('not written');
    expect(s.flags.arraysMissing).toBeUndefined();
    expect(s.flags.liquidityCheckFailed).toBeGreaterThan(LIQUIDITY_CHECK_LIMIT);
  });

  it('the liquidity check does not see an array above the price: such a recording is written with no flag', () => {
    // what the check proves is that the arrays read add up to the pool account, not that none is missing
    const kids = c.children[DZND] as string[];
    const unseen = kids.filter((k) => {
      const without = { ...c, children: { ...c.children, [DZND]: kids.filter((x) => x !== k) } };
      const [o] = poolOutcomes(without, [pool(DZND)]);
      return o?.written && o.flags.liquidityCheckFailed === undefined;
    });
    // two tick arrays of this pool can be left out without the check moving (and the bitmap extension)
    expect(unseen.filter((k) => tickArrays(DZND).includes(k))).toHaveLength(2);
  });

  it('a Raydium pool whose fee config was not returned, or returned empty: written with config null, and flagged', () => {
    const cfgKey = decodeClmmPool(captureBytes(c, WBSD) as Uint8Array).ammConfig;
    for (const empty of [null, '']) {
      const [o] = poolOutcomes(withAccounts({ [cfgKey]: empty }), [pool(WBSD)]);
      if (!o?.written) throw new Error('not written');
      expect(o.recording.config).toBeNull();
      expect(o.flags).toEqual({ configMissing: true });
    }
  });

  it('a Meteora pool whose bins hold nothing has no mid: written, and flagged', () => {
    // two of the six arrays of this pool hold no bin with anything in it; alone they are an emptied pool
    const kids = c.children[DQ8F] as string[];
    const empty = kids.filter(
      (k) =>
        !(simOf({ ...c, children: { ...c.children, [DQ8F]: [k] } }, pool(DQ8F)).sim.midRaw > 0),
    );
    expect(empty).toHaveLength(2);
    const [o] = poolOutcomes({ ...c, children: { ...c.children, [DQ8F]: empty } }, [pool(DQ8F)]);
    if (!o?.written) throw new Error('not written');
    expect(o.flags).toEqual({ noMid: true });
    expect(o.arrays).toEqual({ listed: 2, returned: 2, decoded: 2 });
  });

  it('an account in a batch the RPC did not answer: read_failed, never a recording with a hole', () => {
    const kids = c.children[DZND] as string[];
    const why = 'rpc getMultipleAccounts: {"code":-32005}';
    // the pool account, one of its arrays, or its fee config: each alone is enough
    const cfgKey = decodeClmmPool(captureBytes(c, DZND) as Uint8Array).ammConfig;
    for (const [key, detail] of [
      [DZND, `the pool account: ${why}`],
      [kids[4] as string, `1 of 5 listed accounts: ${why}`],
      [cfgKey, `the fee config: ${why}`],
    ] as const) {
      const [o] = poolOutcomes(withAccounts({ [key]: null }), [pool(DZND)], {
        failed: new Map([[key, why]]),
      });
      expect(o).toEqual({ pool: pool(DZND), written: false, reason: 'read_failed', detail });
    }
    // the same account simply not there on the chain is another thing: written, and counted as missing
    const [o] = poolOutcomes(withAccounts({ [kids[4] as string]: null }), [pool(DZND)]);
    expect(o?.written).toBe(true);
    // a failed batch that holds none of this pool's accounts does not touch it
    const [fine] = poolOutcomes(c, [pool(DZND)], { failed: new Map([[P48D, why]]) });
    expect(fine?.written).toBe(true);
  });

  it('each recording carries its own two slots, and accounts read too far apart are not one recording', () => {
    const kids = c.children[DZND] as string[];
    const slots = new Map<string, number>([
      [DZND, 1_000],
      ...kids.map((k, i) => [k, 1_002 + i] as const),
    ]);
    const [o] = poolOutcomes(c, [pool(DZND)], { slots });
    if (!o?.written) throw new Error('not written');
    expect(o.recording.slotHead).toBe(1_000);
    expect(o.recording.slot).toBe(1_006);
    // at the limit it is still one recording; one slot past it is not
    slots.set(kids[4] as string, 1_000 + MAX_SLOT_GAP);
    expect(poolOutcomes(c, [pool(DZND)], { slots })[0]?.written).toBe(true);
    slots.set(kids[4] as string, 1_001 + MAX_SLOT_GAP);
    expect(poolOutcomes(c, [pool(DZND)], { slots })[0]).toEqual({
      pool: pool(DZND),
      written: false,
      reason: 'read_torn',
      detail: `${MAX_SLOT_GAP + 1} slots between the first and the last of the pool's accounts`,
    });
    // arrays far apart from each other are torn as well, whichever way: a node behind another can answer an
    // earlier slot later
    slots.set(kids[4] as string, 1_000 - MAX_SLOT_GAP);
    expect(poolOutcomes(c, [pool(DZND)], { slots })[0]).toMatchObject({ reason: 'read_torn' });
    // a Meteora pool has no other check: this is the only thing that stops a torn one
    const bins = c.children[DQ8F] as string[];
    const far = new Map<string, number>([[DQ8F, 5], ...bins.map((k) => [k, 5_000] as const)]);
    expect(poolOutcomes(c, [pool(DQ8F)], { slots: far })[0]).toMatchObject({ reason: 'read_torn' });
  });
});

const fakeReader =
  (patch: Record<string, string | null> = {}, slot = () => 1): AccountReader =>
  async (keys) => ({
    slot: slot(),
    accounts: new Map(
      keys.map((k) => {
        const s = k in patch ? patch[k] : c.accounts[k];
        return [
          k,
          s === null || s === undefined ? null : { data: new Uint8Array(Buffer.from(s, 'base64')) },
        ];
      }),
    ),
  });
const deps = (read: AccountReader) => ({
  read,
  solUsd: async () => null,
  now: () => new Date('2026-10-07T04:31:05.530Z'),
  rpcCalls: () => 0,
});
const meta = { twoHop: false, tracked: [], trackedSource: null, registry: c.registry };
const sel = { direct: c.direct, twoHop: [], listed: null };

describe('raw arrays: one bad Raydium account does not stop the read', () => {
  const cutHead = Buffer.from((captureBytes(c, DZND) as Uint8Array).subarray(0, 40)).toString(
    'base64',
  );

  it('the shared reader throws on it; wrapped, the pool is listed as decode_failed and the ten others are written', async () => {
    await expect(
      readSplitCapture(sel, c.children, meta, deps(fakeReader({ [DZND]: cutHead }))),
    ).rejects.toThrow();
    const w = withholdingUndecodable(fakeReader({ [DZND]: cutHead }), c.direct);
    const cap = await readSplitCapture(sel, c.children, meta, deps(w.read));
    expect([...w.undecodable.keys()]).toEqual([DZND]);
    const outcomes = poolOutcomes(cap, c.direct, { undecodable: w.undecodable });
    expect(outcomes.filter((o) => o.written)).toHaveLength(10);
    expect(outcomes.find((o) => o.pool.address === DZND)).toMatchObject({
      written: false,
      reason: 'decode_failed',
      detail: w.undecodable.get(DZND),
    });
  });

  it('with nothing wrong the wrapped reader reads what the plain one reads', async () => {
    const plain = await readSplitCapture(sel, c.children, meta, deps(fakeReader()));
    const w = withholdingUndecodable(fakeReader(), c.direct);
    const wrapped = await readSplitCapture(sel, c.children, meta, deps(w.read));
    expect(w.undecodable.size).toBe(0);
    expect(wrapped.accounts).toEqual(plain.accounts);
    expect(wrapped.accounts).toEqual(c.accounts);
    // an Orca or a Meteora pool account is never tried against Raydium's layout
    expect(poolOutcomes(wrapped, c.direct).every((o) => o.written)).toBe(true);
  });
});

describe('raw arrays: the reader in batches', () => {
  const quiet = { sleep: async () => {}, pauseMs: 0 };

  it('reads a batch at a time and remembers the slot each account came at', async () => {
    let n = 0;
    const calls: number[] = [];
    const read: AccountReader = (keys) => {
      calls.push(keys.length);
      return fakeReader({}, () => 100 + ++n)(keys);
    };
    const b = batchedReader(read, { size: 20, ...quiet });
    const w = withholdingUndecodable(b.read, c.direct);
    const cap = await readSplitCapture(sel, c.children, meta, deps(w.read));
    // eleven pool accounts in one call; four fee configs and 68 arrays in four
    expect(calls).toEqual([11, 20, 20, 20, 12]);
    expect(b.stats).toEqual({ batches: 5, batchRetries: 0, batchesFailed: 0 });
    expect(b.failed.size).toBe(0);
    expect(cap.accounts).toEqual(c.accounts);
    expect(b.slots.size).toBe(Object.keys(c.accounts).length);
    const outcomes = poolOutcomes(cap, c.direct, { slots: b.slots, failed: b.failed });
    expect(outcomes.every((o) => o.written)).toBe(true);
    for (const o of outcomes) {
      if (!o.written) continue;
      // every pool account came in the first call; each pool's arrays in one or two of the next four
      expect(o.recording.slotHead).toBe(101);
      expect(o.recording.slot).toBeGreaterThanOrEqual(102);
      expect(o.recording.slot).toBeLessThanOrEqual(105);
      const own = (c.children[o.pool.address] as string[]).map((k) => b.slots.get(k) as number);
      expect(o.recording.slot).toBe(Math.max(...own));
    }
    expect(new Set(outcomes.flatMap((o) => (o.written ? [o.recording.slot] : []))).size).toBe(4);
  });

  it('a batch that throws is read again, and what was already read is kept', async () => {
    let n = 0;
    const read: AccountReader = async (keys) => {
      if (++n === 3)
        throw new Error('rpc getMultipleAccounts: {"code":-32005,"message":"node is behind"}');
      return fakeReader()(keys);
    };
    const b = batchedReader(read, { size: 20, ...quiet });
    const cap = await readSplitCapture(sel, c.children, meta, deps(b.read));
    expect(b.stats).toEqual({ batches: 5, batchRetries: 1, batchesFailed: 0 });
    expect(b.failed.size).toBe(0);
    expect(cap.accounts).toEqual(c.accounts);
  });

  it('a batch that keeps throwing is given up: its accounts are not read, their pools read_failed, the others written', async () => {
    let n = 0;
    const read: AccountReader = async (keys) => {
      n++;
      // the third batch of the run, at each of its three tries
      if (n >= 3 && n <= 5) throw new Error('rpc getMultipleAccounts: {"code":-32005}');
      return fakeReader()(keys);
    };
    const b = batchedReader(read, { size: 20, ...quiet });
    const w = withholdingUndecodable(b.read, c.direct);
    const cap = await readSplitCapture(sel, c.children, meta, deps(w.read));
    expect(b.stats).toEqual({ batches: 5, batchRetries: 2, batchesFailed: 1 });
    expect(b.failed.size).toBe(20);
    expect([...new Set(b.failed.values())]).toEqual(['rpc getMultipleAccounts: {"code":-32005}']);
    const outcomes = poolOutcomes(cap, c.direct, { slots: b.slots, failed: b.failed });
    const lost = outcomes.filter((o) => !o.written);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.length).toBeLessThan(11);
    for (const o of lost) expect(o).toMatchObject({ reason: 'read_failed' });
    // exactly the pools that list one of the twenty accounts
    expect(lost.map((o) => o.pool.address).sort()).toEqual(
      c.direct
        .filter((p) => (c.children[p.address] as string[]).some((k) => b.failed.has(k)))
        .map((p) => p.address)
        .sort(),
    );
  });

  it('past its time the run makes no further call, and says so for what it did not read', async () => {
    let n = 0;
    const read: AccountReader = (keys) => {
      n++;
      return fakeReader()(keys);
    };
    const b = batchedReader(read, { size: 20, ...quiet, pastDeadline: () => n >= 2 });
    const cap = await readSplitCapture(sel, c.children, meta, deps(b.read));
    expect(n).toBe(2);
    expect(b.stats).toEqual({ batches: 5, batchRetries: 0, batchesFailed: 3 });
    expect([...new Set(b.failed.values())]).toEqual([
      'the run was past its time before this batch was read',
    ]);
    const outcomes = poolOutcomes(cap, c.direct, { slots: b.slots, failed: b.failed });
    expect(outcomes.some((o) => o.written)).toBe(true);
    expect(
      outcomes.filter((o) => !o.written).every((o) => !o.written && o.reason === 'read_failed'),
    ).toBe(true);
  });
});

describe('raw arrays: where the job may write', () => {
  const home = '/Users/x/.colosseum/risk';
  const raw = [`${home}/raw`];
  it('a folder of its own, anywhere but the collector’s home; inside the home only raw-arrays', () => {
    expect(folderRefusal('/tmp/somewhere/raw-arrays', home, raw)).toBeNull();
    expect(folderRefusal(`${home}/raw-arrays`, home, raw)).toBeNull();
    expect(folderRefusal('', home, raw)).toBe('no folder is named');
    expect(folderRefusal(home, home, raw)).toContain('the collector’s home'.replace('’', "'"));
    for (const dir of [
      `${home}/raw`,
      `${home}/raw/2026-10-07`,
      `${home}/pools`,
      `${home}/raw-markets`,
      `${home}/raw-arrays-2`,
      `${home}/data/split`,
    ])
      expect(folderRefusal(dir, home, raw)).not.toBeNull();
    // a folder that holds the home would take the home's files for its own
    expect(folderRefusal('/Users/x/.colosseum', home, raw)).toContain('holds');
    expect(folderRefusal('/', home, raw)).not.toBeNull();
    // the API's variable can name another raw folder: refused as well
    expect(folderRefusal('/data/raw/sub', home, [...raw, '/data/raw'])).toContain('raw folder');
    expect(folderRefusal('/data/raw-arrays', home, [...raw, '/data/raw', ''])).toBeNull();
  });
});

describe('raw arrays: an error as it is logged', () => {
  it('carries no address and no secret, and says why a fetch failed', () => {
    const secret = 'rpc.example.com/v1/key-123';
    expect(scrubbed(new Error(`Failed to parse URL from ${secret}`), [secret])).toBe(
      'Failed to parse URL from <secret>',
    );
    expect(scrubbed(new Error('request to https://rpc.example.com/v1/key-123 failed'))).toBe(
      'request to <url> failed',
    );
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(scrubbed(e, [undefined])).toBe('fetch failed (ENOTFOUND)');
    expect(scrubbed('x'.repeat(500))).toHaveLength(300);
  });
});

describe('raw arrays: the run’s row', () => {
  const selOf = (
    read: RegPool[],
    leftToCollector: RegPool[] = [],
    leftOutBySetting: RegPool[] = [],
    notUnderstood: RegPool[] = [],
  ): RawSelection => ({
    all: [...read, ...leftToCollector, ...leftOutBySetting],
    read,
    collector: leftToCollector,
    leftToCollector,
    leftOutBySetting,
    notUnderstood,
  });

  it('every pool is written or listed with its reason, and the numbers add up', () => {
    const cfgKey = decodeClmmPool(captureBytes(c, WBSD) as Uint8Array).ammConfig;
    const cap = withAccounts({ [P48D]: null, [cfgKey]: null });
    const s = selOf(c.direct.slice(0, 9), [c.direct[9] as RegPool], [c.direct[10] as RegPool]);
    const slots = new Map<string, number>(
      s.read.flatMap((p, i) => [
        [p.address, 500] as const,
        ...(c.children[p.address] as string[]).map((k) => [k, 500 + 2 * i] as const),
      ]),
    );
    const outcomes = poolOutcomes(cap, s.read, {
      slots,
      childrenAt: Object.fromEntries(
        s.read.map((p, i) => [
          p.address,
          new Date(Date.parse(c.fetchedAt) - i * 600_000).toISOString(),
        ]),
      ),
    });
    const bytes = new Map(
      outcomes.flatMap((o) =>
        o.written ? [[o.pool.address, encodeRecording(o.recording).length] as const] : [],
      ),
    );
    const row = runSummary(s, outcomes, cap, bytes);
    expect(row.pools).toEqual({
      ofTracked: 11,
      leftToCollector: 1,
      leftOutBySetting: 1,
      read: 9,
      written: 8,
      notWritten: 1,
    });
    expect(row.accounted).toBe(true);
    expect(row.notWritten).toEqual([
      {
        pool: P48D,
        asset: 'HOODx',
        quote: 'USDC',
        venue: 'orca_whirlpool',
        exitPath: 'direct_usd',
        tvlUsd: pool(P48D).tvlUsd,
        reason: 'head_missing',
        detail: null,
      },
    ]);
    expect(row.leftOutBySetting.map((p) => p.pool)).toEqual([c.direct[10]?.address]);
    expect(row.notUnderstood).toEqual([]);
    // every Raydium pool of the fixture shares the fee config that was not returned
    expect(row.flags.configMissing.length).toBeGreaterThan(0);
    expect(row.flags.configMissing.every((f) => pool(f.pool).venue === 'raydium_clmm')).toBe(true);
    expect(row.flags.liquidityCheckFailed).toEqual([]);
    expect(row.tvlUsd.notWritten).toBe(pool(P48D).tvlUsd);
    const sum = (
      g: Record<string, { pools: number; written: number; bytes: number }>,
      k: 'pools' | 'written' | 'bytes',
    ) => Object.values(g).reduce((t, v) => t + v[k], 0);
    for (const g of [row.byExitPath, row.byVenue]) {
      expect(sum(g, 'pools')).toBe(9);
      expect(sum(g, 'written')).toBe(8);
      expect(sum(g, 'bytes')).toBe(row.bytes.written);
    }
    expect(row.bytes.written).toBe([...bytes.values()].reduce((t, v) => t + v, 0));
    expect(row.bytes.accounts).toBeGreaterThan(row.bytes.written);
    expect(row.arrays.returned).toBe(row.arrays.listed);
    // one account of each Raydium list is no tick array
    const raydium = outcomes.filter((o) => o.written && o.pool.venue === 'raydium_clmm').length;
    expect(row.arrays.decoded).toBe(row.arrays.listed - raydium);
    // the lists are 0, 10, 20 … minutes old; the pool not written is the second
    expect(row.listAgeMinutes).toEqual({ median: 50, max: 80, unknown: 0 });
    // the arrays of the i-th pool came 2·i slots after its account; the second pool is the one not written
    expect(row.slotGap).toEqual({ median: 10, max: 16 });
  });

  it('a pool in none of the lists, or one the selection does not understand, shows as not accounted', () => {
    const s = selOf(c.direct);
    expect(runSummary(s, poolOutcomes(c, c.direct), c, new Map()).accounted).toBe(true);
    expect(runSummary(s, poolOutcomes(c, c.direct.slice(0, 10)), c, new Map()).accounted).toBe(
      false,
    );
    expect(
      runSummary({ ...s, all: [...s.all, pool(DZND)] }, poolOutcomes(c, c.direct), c, new Map())
        .accounted,
    ).toBe(false);
    const odd = selOf(c.direct, [], [], [{ ...pool(DZND), tier: 'X' }]);
    const row = runSummary(odd, poolOutcomes(c, c.direct), c, new Map());
    expect(row.accounted).toBe(false);
    expect(row.notUnderstood).toMatchObject([{ pool: DZND, tier: 'X' }]);
  });

  it('a run that stops before its pools have an outcome says so for every one of them', () => {
    const s = selOf(c.direct.slice(0, 9), [c.direct[9] as RegPool], [c.direct[10] as RegPool]);
    expect(failedRunPools(s, 'read')).toEqual({
      pools: {
        ofTracked: 11,
        leftToCollector: 1,
        leftOutBySetting: 1,
        read: 9,
        written: 0,
        notWritten: 9,
      },
      everyPoolNotWritten: {
        reason: 'run_failed',
        stage: 'read',
        pools: 9,
        tvlUsd: c.direct.slice(0, 9).reduce((t, p) => t + p.tvlUsd, 0),
      },
    });
  });

  it('the hour folder is the UTC day and hour of the read', () => {
    expect(hourFolder('2026-10-07T04:31:05.530Z')).toEqual({ day: '2026-10-07', hour: '04' });
    expect(hourFolder('2026-12-31T23:59:59.999Z')).toEqual({ day: '2026-12-31', hour: '23' });
  });
});
