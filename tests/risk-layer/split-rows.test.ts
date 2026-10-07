import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildPoolSim,
  decodeClmmPool,
  type RoutePool,
  routeTrade,
  usdCurves,
} from '@colosseum/risk';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSplit,
  loadCapture,
  nearestCollectorRows,
  notRoutedSummary,
  oneHopRows,
  oneHopView,
  type RegPool,
  readSplitCapture,
  type SplitCapture,
  type SplitRowOut,
  saveCapture,
  selectSplitPools,
  splitRows,
  type TwoHopRowOut,
  twoHopAssets,
  twoHopRowsOf,
} from '../../scripts/risk/lib-split';
import { selectRawArrayPools } from '../../scripts/risk/raw-arrays/lib';

// PLAN-UNIVERSE RU.11 — the split snapshot on top of pure functions. On the mainnet accounts frozen
// 2026-10-06T21:21:16Z by `pnpm risk:split-capture --two-hop --only QQQx` (fixtures/risk/route): the dollar and SOL
// pools of SPYx, QQQx and AMZNx and the six pools that pair two of them. The file is cut to QQQx and says so
// (`only`): SPYx and AMZNx are in it as QQQx's partners, with the pools that pair them with QQQx and no other. The
// reference for the `split-0.1` rows is the script as it stood before this item, copied below from
// scripts/risk/split-snapshot.ts and fed the same frozen accounts, and the hash of the rows it gave, pinned. The
// scripts themselves are run in a child process with `fetch` replaced, so no test calls the network.
const FIXTURE = 'fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz';
const cap = loadCapture(FIXTURE);
const DAY = cap.fetchedAt.slice(0, 10);

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const AMZNX = 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg';

// --- a collector home made of the capture: its registry rows, the child keys, and frozen answers to the reads ---
type Account = { data: Uint8Array } | null;
type Read = (keys: string[]) => Promise<{ slot: number; accounts: Map<string, Account> }>;
// the stock-to-stock rows sit between the others, with two rows no run may read (tier C, and a quote with no way out)
const registryPools: RegPool[] = [
  ...cap.direct.flatMap((p, i) =>
    i % 3 === 2 && cap.twoHopPools[(i - 2) / 3]
      ? [p, cap.twoHopPools[(i - 2) / 3] as RegPool]
      : [p],
  ),
  { ...(cap.direct[0] as RegPool), address: 'tier-c-row', tier: 'C' },
  { ...(cap.direct[1] as RegPool), address: 'other-quote-row', exitPath: 'other' },
];
const cacheChildren = cap.children;
const poolAddresses = new Set([...cap.direct, ...cap.twoHopPools].map((p) => p.address));
// a reader that answers from the capture and keeps the keys it was asked for, in order
const frozenReader = () => {
  const asked: string[][] = [];
  const read: Read = async (keys) => {
    asked.push(keys);
    return {
      slot: poolAddresses.has(keys[0] ?? '') ? cap.slotHeads : cap.slot,
      accounts: new Map(
        keys.map((k): [string, Account] => {
          const s = cap.accounts[k];
          return [k, s == null ? null : { data: new Uint8Array(Buffer.from(s, 'base64')) }];
        }),
      ),
    };
  };
  return { read, asked };
};

// --- scripts/risk/split-snapshot.ts as it stood at `split-0.1`, before RU.11. Only its inputs and its output are
// bound differently: the registry, the cache and the collector's file are passed in, `multipleAccounts` is the reader
// above, the clock and the SOL price are the capture's, and each line is kept instead of appended to a file. ---
const METHOD_VERSION = 'split-0.1';
const NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const USD_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const SOL = 'So11111111111111111111111111111111111111112';
async function scriptAtHead(multipleAccounts: Read, collectorText: string | null) {
  const registry = registryPools
    .filter(
      (p) =>
        (p.exitPath === 'direct_usd' || p.exitPath === 'via_sol') && ['A', 'B'].includes(p.tier),
    )
    .map((p) => ({ ...p, assetIsToken0: Boolean(p.assetIsToken0) })) as RegPool[];
  const cache = { children: cacheChildren };
  const b = (a: { data: Uint8Array } | null | undefined) => a?.data;

  const heads = await multipleAccounts(registry.map((p) => p.address));
  const cfgKeys = registry
    .filter((p) => p.venue === 'raydium_clmm')
    .map((p) => {
      const h = b(heads.accounts.get(p.address));
      return h ? decodeClmmPool(h).ammConfig : null;
    })
    .filter((k): k is string => !!k);
  const childKeys = registry.flatMap((p) => cache.children[p.address] ?? []);
  const rest = await multipleAccounts([...new Set([...cfgKeys, ...childKeys])]);
  const fetchedAt = cap.fetchedAt;
  const solUsd = cap.solUsd;

  const byAsset = new Map<string, RoutePool[]>();
  const meta = new Map<string, { symbol: string }>();
  const failures: string[] = [];
  for (const p of registry) {
    const head = b(heads.accounts.get(p.address));
    if (!head) {
      failures.push(`${p.address}: head missing`);
      continue;
    }
    const quoteUsd = USD_MINTS.has(p.quoteMint) ? 1 : p.quoteMint === SOL ? solUsd : null;
    if (!quoteUsd) {
      failures.push(`${p.address}: no USD for quote ${p.quoteMint}`);
      continue;
    }
    try {
      const cfg =
        p.venue === 'raydium_clmm'
          ? b(rest.accounts.get(decodeClmmPool(head).ammConfig))
          : undefined;
      const kids = (cache.children[p.address] ?? [])
        .map((k) => b(rest.accounts.get(k)))
        .filter((d): d is Uint8Array => !!d);
      const built = buildPoolSim(p, head, kids, cfg);
      const decAsset = p.assetIsToken0 ? p.decimals0 : p.decimals1;
      const decQuote = p.assetIsToken0 ? p.decimals1 : p.decimals0;
      const midUsd = usdCurves(built.sim, decAsset, decQuote, quoteUsd, [100]).midUsd;
      if (!(midUsd > 0)) continue;
      byAsset.set(p.assetMint, [
        ...(byAsset.get(p.assetMint) ?? []),
        {
          pool: p.address,
          sim: built.sim,
          decAsset,
          decQuote,
          quoteUsd,
          midUsd,
          tvlUsd: p.tvlUsd,
          feeRate: built.feeRate,
          transferFeeBps: {
            asset: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
            quote: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
          },
        },
      ]);
      meta.set(p.assetMint, { symbol: p.assetSymbol });
    } catch (e) {
      failures.push(`${p.address}: ${String(e).slice(0, 80)}`);
    }
  }

  // the collector's routed row nearest in time, per asset, for the drift comparison
  const collector = new Map<
    string,
    { fetchedAt: string; pools: number; sell: Array<{ notionalUsd: number; costPct: number }> }
  >();
  if (collectorText !== null)
    for (const l of collectorText.split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l) as {
        assetMint: string;
        fetchedAt: string;
        pools: number;
        sell: Array<{ notionalUsd: number; costPct: number }>;
      };
      const prev = collector.get(r.assetMint);
      if (
        !prev ||
        Math.abs(Date.parse(r.fetchedAt) - Date.parse(fetchedAt)) <
          Math.abs(Date.parse(prev.fetchedAt) - Date.parse(fetchedAt))
      )
        collector.set(r.assetMint, r);
    }

  const lines: string[] = [];
  const drift: number[] = [];
  let rows = 0;
  for (const [mint, pools] of byAsset) {
    const c = collector.get(mint);
    for (const side of ['sell', 'buy'] as const)
      for (const n of NOTIONALS) {
        const r = routeTrade(pools, n, side);
        const cc = side === 'sell' ? c?.sell.find((x) => x.notionalUsd === n) : undefined;
        if (cc && n <= 250_000) drift.push(Math.abs(r.costPct - cc.costPct));
        lines.push(
          `${JSON.stringify({
            assetMint: mint,
            asset: meta.get(mint)?.symbol,
            fetchedAt,
            slot: rest.slot,
            side,
            notionalUsd: n,
            outUsd: r.outUsd,
            costPct: r.costPct,
            poolsUsed: r.poolsUsed,
            pools: pools.length,
            refPool: r.refPool,
            refMidUsd: r.refMidUsd,
            split: r.split,
            legs: r.legs,
            solUsd,
            vsCollector:
              cc && c ? { fetchedAt: c.fetchedAt, pools: c.pools, costPct: cc.costPct } : null,
            source:
              'Solana RPC getMultipleAccounts (pool and child accounts from the collector cache); Jupiter price API (SOL)',
            method:
              'routed_greedy_32_chunks with per-pool split (packages/risk/src/pools/route.ts)',
            methodVersion: METHOD_VERSION,
            provenance: 'live',
          })}\n`,
        );
        rows++;
      }
  }
  drift.sort((a, b) => a - b);
  return {
    lines,
    drift,
    collector,
    // the summary's numbers, as the script printed them
    summary: {
      accounts: heads.accounts.size + rest.accounts.size,
      pools: [...byAsset.values()].reduce((s, p) => s + p.length, 0),
      assets: byAsset.size,
      rows,
      solUsd,
      failures: failures.length,
      failureSample: failures.slice(0, 3),
      vsCollectorSellUpTo250k: drift.length
        ? {
            n: drift.length,
            medianAbsPp: drift[Math.floor(drift.length / 2)],
            p90AbsPp: drift[Math.floor(drift.length * 0.9)],
          }
        : null,
    },
  };
}

// --- helpers ---
const text = (rs: readonly object[]) => rs.map((r) => `${JSON.stringify(r)}\n`);
const parse = <T>(lines: readonly string[]) => lines.map((l) => JSON.parse(l) as T);
const at = (ms: number) => new Date(Date.parse(cap.fetchedAt) + ms).toISOString();
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
// The 48 `split-0.1` rows of the fixture, as the script before RU.11 wrote them, frozen in a file. The copy of that
// script in this file calls the router of the working tree, so a change to the direct path would move the copy and
// the new rows together: the frozen rows do not move. When they were taken, the copy gave the same lines with the
// router of commit d58086c3 (before two hops) in the working tree's place. They change only with the fixture.
// They are compared figure by figure, not by a hash of the bytes: a platform's own `pow` decides the last digit of a
// price, so the lines written on macOS and on Linux differ in that digit (the first run on the Linux runner showed
// it). Within one run the old copy and the new rows are still compared byte for byte, in the tests around this one.
const FROZEN_ROWS = (
  JSON.parse(readFileSync('fixtures/risk/route/split-0.1-rows-20261006T2121.json', 'utf8')) as {
    rows: unknown[];
  }
).rows;
// the same keys in the same order, the same strings, whole numbers and nulls, and every other number to nine digits
const sameFigures = (got: unknown, want: unknown, path: string): void => {
  if (typeof want === 'number' && typeof got === 'number' && !Number.isInteger(want)) {
    const tol = Math.max(1e-12, 1e-9 * Math.abs(want));
    expect(Math.abs(got - want), path).toBeLessThanOrEqual(tol);
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got), path).toBe(true);
    expect((got as unknown[]).length, path).toBe(want.length);
    for (const [i, w] of want.entries()) sameFigures((got as unknown[])[i], w, `${path}[${i}]`);
  } else if (want !== null && typeof want === 'object') {
    expect(Object.keys(got as object), path).toEqual(Object.keys(want));
    for (const [k, w] of Object.entries(want))
      sameFigures((got as Record<string, unknown>)[k], w, `${path}.${k}`);
  } else expect(got, path).toBe(want);
};
// two sums of the same numbers taken in a different order: equal to the last few bits, not bit for bit
const sameSum = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));

const oldReader = frozenReader();
const old = await scriptAtHead(oldReader.read, null);
const oldRows = parse<SplitRowOut>(old.lines);
// the collector's file of the day, made from the rows above so that no cost is written here: for SPYx the row
// 77 s earlier is the nearest; for QQQx two rows are equally near (the earlier line keeps it) and the kept one has
// no $2,500 point; AMZNx has no row. Each row's cost is the snapshot's own, moved by a whole number of points.
const collectorLine = (mint: string, ms: number, pools: number, shift: number, skip?: number) =>
  JSON.stringify({
    assetMint: mint,
    fetchedAt: at(ms),
    pools,
    sell: oldRows
      .filter((r) => r.assetMint === mint && r.side === 'sell' && r.notionalUsd !== skip)
      .map((r) => ({ notionalUsd: r.notionalUsd, costPct: r.costPct + shift })),
    regime: 'not read by the snapshot',
  });
const collectorText = `${[
  collectorLine(SPYX, -20 * 60_000, 9, 1),
  collectorLine(SPYX, -77_000, 10, 2),
  collectorLine(SPYX, 4 * 60_000, 11, 3),
  '',
  collectorLine(QQQX, -60_000, 20, 4, 2_500),
  collectorLine(QQQX, 60_000, 21, 5),
  collectorLine(QQQX, 5 * 60_000, 22, 6),
].join('\n')}\n`;
const oldWithCollector = await scriptAtHead(frozenReader().read, collectorText);
const collector = nearestCollectorRows(collectorText, cap.fetchedAt);
// the collector's file as the script finds it under RISK_HOME. Here SPYx's costs are moved further than QQQx's, so
// the drift in row order (SPYx first) is not sorted, and the summary's p90 shows whether the script sorted it.
const collectorOnDisk = `${[
  collectorLine(SPYX, -20 * 60_000, 9, 9),
  collectorLine(SPYX, -77_000, 10, 7),
  collectorLine(QQQX, 60_000, 21, 3, 2_500),
  collectorLine(QQQX, -5 * 60_000, 22, 5),
].join('\n')}\n`;
const oldOnDisk = await scriptAtHead(frozenReader().read, collectorOnDisk);

// the capture as a run with two hops off, and as it was taken
const one = oneHopView(cap);
const builtOne = buildSplit(one);
const off = splitRows(builtOne, one);
const built = buildSplit(cap);
const on = splitRows(built, cap);
// the same accounts seen as a whole run: what the fixture gave before the cut to QQQx was recorded in it
const whole: SplitCapture = { ...cap, only: null };
const builtWhole = buildSplit(whole);
const onWhole = splitRows(builtWhole, whole);
const key = (r: { assetMint: string; side: string; notionalUsd: number }) =>
  `${r.assetMint}|${r.side}|${r.notionalUsd}`;
const offByKey = new Map(off.rows.map((r) => [key(r), r]));

describe('the split-0.1 rows', () => {
  it('are the rows the script wrote before two hops, byte for byte: 3 assets, 2 sides, 8 sizes', () => {
    expect(old.lines.length).toBe(48);
    expect(text(off.rows)).toEqual(old.lines);
    expect(off.drift).toEqual([]);
    expect(old.drift).toEqual([]);
    expect(off.twoHopRows).toEqual([]);
    expect(off.rows.map((r) => r.asset).filter((a, i, all) => all.indexOf(a) === i)).toEqual([
      'SPYx',
      'QQQx',
      'AMZNx',
    ]);
    for (const r of off.rows) {
      expect(r.fetchedAt).toBe(cap.fetchedAt);
      expect(r.slot).toBe(cap.slot);
      expect(r.solUsd).toBe(cap.solUsd);
    }
  });

  it('are the rows frozen from the script before two hops: the copy, the new rows, and with two hops on', () => {
    expect(FROZEN_ROWS.length).toBe(48);
    for (const [name, lines] of [
      ['the copy of the old script', old.lines],
      ['two hops off', text(off.rows)],
      ['two hops on', text(on.rows)],
      ['two hops on, the capture seen whole', text(onWhole.rows)],
    ] as const) {
      const rows = parse<unknown>(lines);
      expect(rows.length, name).toBe(48);
      for (const [i, r] of rows.entries()) sameFigures(r, FROZEN_ROWS[i], `${name}, row ${i}`);
    }
    // the comparison is not blind: a figure moved in the ninth digit is caught, and so is a key out of place
    const first = FROZEN_ROWS[0] as { outUsd: number; costPct: number };
    expect(() =>
      sameFigures({ ...first, outUsd: first.outUsd * (1 + 1e-8) }, first, 'moved'),
    ).toThrow();
    const { costPct: _c, ...rest } = first;
    expect(() => sameFigures({ ...rest, costPct: first.costPct }, first, 'reordered')).toThrow();
  });

  it('and with the collector beside them: the same lines and the same drift', () => {
    const withCollector = splitRows(builtOne, one, { collector });
    expect(text(withCollector.rows)).toEqual(oldWithCollector.lines);
    expect([...withCollector.drift].sort((a, b) => a - b)).toEqual(oldWithCollector.drift);
    // SPYx: 6 sales up to $250k; QQQx: 5, its kept row has no $2,500 point; AMZNx: none
    expect(withCollector.drift.length).toBe(11);
    const vs = (mint: string, side: string) =>
      withCollector.rows
        .filter((r) => r.assetMint === mint && r.side === side)
        .map((r) => r.vsCollector);
    expect(vs(SPYX, 'sell').map((v) => [v?.fetchedAt, v?.pools])).toEqual(
      NOTIONALS.map(() => [at(-77_000), 10]),
    );
    expect(vs(QQQX, 'sell').map((v) => v?.pools ?? null)).toEqual(
      NOTIONALS.map((n) => (n === 2_500 ? null : 20)),
    );
    for (const v of [...vs(SPYX, 'buy'), ...vs(QQQX, 'buy'), ...vs(AMZNX, 'sell')])
      expect(v).toBeNull();
    // the rows themselves do not move when the collector is read: only vsCollector does
    expect(text(withCollector.rows.map((r) => ({ ...r, vsCollector: null })))).toEqual(old.lines);
  });

  it('the collector row kept per asset is the nearest in time, the earlier line on a tie', () => {
    expect(JSON.stringify([...collector])).toBe(JSON.stringify([...oldWithCollector.collector]));
    expect([...collector].map(([mint, r]) => [mint, r.fetchedAt, r.pools])).toEqual([
      [SPYX, at(-77_000), 10],
      [QQQX, at(-60_000), 20],
    ]);
    expect(nearestCollectorRows('', cap.fetchedAt).size).toBe(0);
  });

  it('do not move when two hops are on', () => {
    expect(cap.twoHop).toBe(true);
    expect(text(on.rows)).toEqual(old.lines);
    expect(text(splitRows(built, cap, { collector }).rows)).toEqual(oldWithCollector.lines);
    expect(text(oneHopRows(built, cap).rows)).toEqual(old.lines);
    // nor with the capture seen as a whole run: the cut decides who gets two-hop rows, nothing else
    expect(text(onWhole.rows)).toEqual(old.lines);
  });

  it('come from the same selection, the same reads in the same order, and the same summary', async () => {
    const mine = frozenReader();
    const sel = selectSplitPools(registryPools, { twoHop: false, tracked: new Set() });
    const live = await readSplitCapture(
      sel,
      cacheChildren,
      { twoHop: false, tracked: [], trackedSource: null, registry: cap.registry },
      {
        read: mine.read,
        solUsd: async () => cap.solUsd,
        now: () => new Date(cap.fetchedAt),
        rpcCalls: () => mine.asked.length,
      },
    );
    expect(mine.asked).toEqual(oldReader.asked);
    expect(mine.asked.flat()).not.toContain('tier-c-row');
    expect(mine.asked.flat()).not.toContain('other-quote-row');
    for (const p of cap.twoHopPools) expect(mine.asked.flat()).not.toContain(p.address);
    const b = buildSplit(live);
    const r = oneHopRows(b, live);
    expect(text(r.rows)).toEqual(old.lines);
    expect({
      accounts: Object.keys(live.accounts).length,
      pools: [...b.byAsset.values()].reduce((s, a) => s + a.pools.length, 0),
      assets: b.byAsset.size,
      rows: r.rows.length,
      solUsd: live.solUsd,
      failures: b.failures.length,
      failureSample: b.failures.slice(0, 3),
      vsCollectorSellUpTo250k: null,
    }).toEqual(old.summary);
    // what was read is the capture seen as a one-hop run
    expect(live.accounts).toEqual(one.accounts);
    expect(live.children).toEqual(one.children);
    expect(live.direct).toEqual(one.direct);
  });
});

describe('what one run reads', () => {
  it('with two hops on: the stock-to-stock pools with a tracked stock on either side, and the others listed', () => {
    const T1 = 'tracked-stock-1';
    const T2 = 'tracked-stock-2';
    const U1 = 'untracked-stock-1';
    const U2 = 'untracked-stock-2';
    const direct = cap.direct[0] as RegPool;
    const pair = (address: string, assetMint: string, quoteMint: string, tvlUsd: number) => ({
      ...(cap.twoHopPools[0] as RegPool),
      address,
      assetMint,
      quoteMint,
      tvlUsd,
      tier: 'A',
    });
    const other = (address: string, tvlUsd: number, tier: string) => ({
      ...direct,
      address,
      tvlUsd,
      tier,
      exitPath: 'other',
    });
    // in registry order, the kinds mixed; the sums of the money are exact
    const rows = [
      { ...direct, address: 'direct-a', tier: 'A' },
      pair('both-tracked', T1, T2, 1),
      pair('neither-tracked', U1, U2, 2),
      other('other-a', 4, 'A'),
      // as the registry file may hold it: 1 for true
      { ...pair('tracked-is-the-asset', T1, U1, 8), tier: 'B', assetIsToken0: 1 },
      { ...direct, address: 'direct-b', tier: 'B', exitPath: 'via_sol' },
      pair('tracked-is-the-quote', U2, T2, 16),
      pair('neither-tracked-2', U2, U1, 32),
      // tier C is not read and not listed, whatever its kind
      { ...pair('both-tracked-tier-c', T1, T2, 64), tier: 'C' },
      other('other-c', 128, 'C'),
      other('other-b', 256, 'B'),
      { ...direct, address: 'direct-c', tier: 'C' },
    ];
    const sel = selectSplitPools(rows, { twoHop: true, tracked: new Set([T1, T2]) });
    expect(sel.direct.map((p) => p.address)).toEqual(['direct-a', 'direct-b']);
    expect(sel.twoHop.map((p) => p.address)).toEqual([
      'both-tracked',
      'tracked-is-the-asset',
      'tracked-is-the-quote',
    ]);
    expect(sel.twoHop.map((p) => p.assetIsToken0)).toEqual([
      (cap.twoHopPools[0] as RegPool).assetIsToken0,
      true,
      (cap.twoHopPools[0] as RegPool).assetIsToken0,
    ]);
    expect(sel.listed).toEqual([
      { reason: 'quote_token_has_no_measured_way_to_dollars', pools: 2, tvlUsd: 4 + 256 },
      { reason: 'neither_stock_is_tracked', pools: 2, tvlUsd: 2 + 32 },
    ]);
    // nothing tracked: every stock-to-stock pool of tiers A and B is listed, none is read
    const none = selectSplitPools(rows, { twoHop: true, tracked: new Set() });
    expect(none.twoHop).toEqual([]);
    expect(none.listed?.[1]).toEqual({
      reason: 'neither_stock_is_tracked',
      pools: 5,
      tvlUsd: 1 + 2 + 8 + 16 + 32,
    });
    // off: the split-0.1 rule and nothing else, whatever is tracked
    expect(selectSplitPools(rows, { twoHop: false, tracked: new Set([T1, T2]) })).toEqual({
      direct: sel.direct,
      twoHop: [],
      listed: null,
    });
  });

  it('the time of a run is taken after the accounts and before the SOL price is asked for', async () => {
    // a clock that moves one second each time it is read, and a record of how often it had been read at each step
    const t = Date.parse(cap.startedAt);
    let readings = 0;
    const now = () => new Date(t + 1000 * readings++);
    const seen: Array<[string, number]> = [];
    const frozen = frozenReader();
    const live = await readSplitCapture(
      selectSplitPools(registryPools, { twoHop: true, tracked: new Set(cap.tracked) }),
      cacheChildren,
      { twoHop: true, tracked: cap.tracked, trackedSource: null, registry: cap.registry },
      {
        read: (keys) => {
          seen.push(['accounts', readings]);
          return frozen.read(keys);
        },
        solUsd: async () => {
          seen.push(['price', readings]);
          return cap.solUsd;
        },
        now,
        rpcCalls: () => frozen.asked.length,
      },
    );
    // the first reading before any request, the second after both batches of accounts and before the price
    expect(seen).toEqual([
      ['accounts', 1],
      ['accounts', 1],
      ['price', 2],
    ]);
    expect(live.startedAt).toBe(new Date(t).toISOString());
    expect(live.fetchedAt).toBe(new Date(t + 1000).toISOString());
    // and it is not read again: the price request does not move the time of the run
    expect(readings).toBe(2);
    expect(live.rpc).toEqual({ calls: 2, seconds: 1 });
    // a whole run records no cut
    expect(live.only).toBeNull();
    expect(live.accounts).toEqual(cap.accounts);
  });
});

describe('a stock-to-stock pool that does not decode', () => {
  it('does not stop the read: its fee config is not asked for, and the pool is listed when the pools are built', async () => {
    const pair = cap.twoHopPools.find((p) => p.venue === 'raydium_clmm');
    if (!pair) throw new Error('the fixture has no Raydium stock-to-stock pool');
    const frozen = frozenReader();
    const cut = (keys: string[]) =>
      frozen.read(keys).then((r) => {
        const a = r.accounts.get(pair.address);
        // the account comes back cut short: its decoder throws
        if (a) r.accounts.set(pair.address, { ...a, data: a.data.slice(0, 40) });
        return r;
      });
    const sel = selectSplitPools(registryPools, { twoHop: true, tracked: new Set(cap.tracked) });
    const live = await readSplitCapture(
      sel,
      cacheChildren,
      { twoHop: true, tracked: cap.tracked, trackedSource: null, registry: cap.registry },
      {
        read: cut,
        solUsd: async () => cap.solUsd,
        now: () => new Date(cap.fetchedAt),
        rpcCalls: () => frozen.asked.length,
      },
    );
    // every other account is there, and the unchanged rows are the ones the run always wrote
    const b = buildSplit(live);
    expect(b.failures.length).toBe(1);
    expect(b.failures[0]).toMatch(new RegExp(`^${pair.address}: `));
    expect(b.notRouted.filter((n) => n.pool === pair.address).map((n) => n.reason)).toEqual([
      'pool_not_built',
      'pool_not_built',
    ]);
    expect(oneHopRows(b, live).rows.map((r) => `${JSON.stringify(r)}\n`)).toEqual(old.lines);
    // a dollar pool that does not decode still stops the read, as it always has
    const direct = cap.direct.find((p) => p.venue === 'raydium_clmm');
    if (!direct) throw new Error('the fixture has no Raydium dollar pool');
    const frozen2 = frozenReader();
    await expect(
      readSplitCapture(
        sel,
        cacheChildren,
        { twoHop: true, tracked: cap.tracked, trackedSource: null, registry: cap.registry },
        {
          read: (keys) =>
            frozen2.read(keys).then((r) => {
              const a = r.accounts.get(direct.address);
              if (a) r.accounts.set(direct.address, { ...a, data: a.data.slice(0, 40) });
              return r;
            }),
          solUsd: async () => cap.solUsd,
          now: () => new Date(cap.fetchedAt),
          rpcCalls: () => frozen2.asked.length,
        },
      ),
    ).rejects.toThrow();
  });
});

describe('a capture seen as a one-hop run', () => {
  it('holds nothing of the stock-to-stock pools, and keeps the read as it was made', () => {
    expect(one.twoHop).toBe(false);
    expect(one.twoHopPools).toEqual([]);
    expect(one.tracked).toEqual([]);
    expect(one.listed).toBeNull();
    expect(one.direct).toBe(cap.direct);
    expect(Object.keys(one.children)).toEqual(cap.direct.map((p) => p.address));
    for (const p of cap.twoHopPools) {
      expect(p.address in one.accounts).toBe(false);
      for (const k of cap.children[p.address] ?? []) expect(k in one.accounts).toBe(false);
    }
    // 21 pools, their tick and bin arrays, and the Raydium fee configs: 30 accounts fewer than the wider read
    expect(Object.keys(one.accounts).length).toBe(old.summary.accounts);
    expect(Object.keys(cap.accounts).length - Object.keys(one.accounts).length).toBe(30);
    expect([one.fetchedAt, one.slot, one.slotHeads, one.solUsd, one.rpc]).toEqual([
      cap.fetchedAt,
      cap.slot,
      cap.slotHeads,
      cap.solUsd,
      cap.rpc,
    ]);
    expect(oneHopView(one)).toEqual(one);
  });

  it('gives no two-hop rows, whichever of the two is one-hop: the capture or what was built', () => {
    expect(builtOne.via.size).toBe(0);
    for (const a of builtOne.byAsset.values()) expect(a.twoHop).toEqual([]);
    expect(twoHopRowsOf(builtOne, one, off.rows)).toEqual([]);
    expect(twoHopRowsOf(built, one, off.rows)).toEqual([]);
    expect(twoHopRowsOf(builtOne, cap, off.rows)).toEqual([]);
  });
});

describe('the two-hop rows (split-0.2)', () => {
  it('a capture cut to some stocks gives rows for those stocks only: 16 for QQQx, 48 when seen as a whole run', () => {
    expect(cap.only).toEqual(['QQQx']);
    expect(on.twoHopRows.length).toBe(16);
    expect(on.twoHopRows.map((t) => [t.assetMint, t.asset])).toEqual(
      Array.from({ length: 16 }, () => [QQQX, 'QQQx']),
    );
    expect(onWhole.twoHopRows.length).toBe(48);
    // QQQx's rows are the same either way: every pool of QQQx is in the file
    expect(text(on.twoHopRows)).toEqual(
      text(onWhole.twoHopRows.filter((t) => t.assetMint === QQQX)),
    );
    // SPYx and AMZNx came in as partners. They are built with the pools that pair them with QQQx, and QQQx is routed
    // through them, but a row of their own would be measured on a part of their stock-to-stock pools
    expect(built.byAsset.get(SPYX)?.twoHop.length).toBe(5);
    expect(built.byAsset.get(AMZNX)?.twoHop.length).toBe(1);
    expect(twoHopAssets(built, cap).map(([mint]) => mint)).toEqual([QQQX]);
    expect(twoHopAssets(builtWhole, whole).map(([mint]) => mint)).toEqual([SPYX, QQQX, AMZNX]);
    expect(twoHopAssets(built, one)).toEqual([]);
    // a file with no `only` (frozen before the cut was recorded) is a whole run; the names are symbols
    const { only: _, ...unmarked } = cap;
    expect(text(twoHopRowsOf(built, unmarked, on.rows))).toEqual(text(onWhole.twoHopRows));
    expect(twoHopRowsOf(built, { ...cap, only: ['SPYx', 'AMZNx'] }, on.rows).map(key)).toEqual(
      onWhole.twoHopRows.filter((t) => t.assetMint !== QQQX).map(key),
    );
    // the cut does not reach what is built, nor the split-0.1 rows
    expect(text(on.rows)).toEqual(text(onWhole.rows));
    expect([...builtWhole.byAsset].map(([m, a]) => [m, a.twoHop.length])).toEqual(
      [...built.byAsset].map(([m, a]) => [m, a.twoHop.length]),
    );
  });

  it('one per side and size for each asset with a stock-to-stock pool, in the order of the others', () => {
    expect(onWhole.twoHopRows.length).toBe(48);
    expect(onWhole.twoHopRows.map(key)).toEqual(onWhole.rows.map(key));
    const per = (mint: string) => {
      const r = onWhole.twoHopRows.find((x) => x.assetMint === mint) as TwoHopRowOut;
      return [r.asset, r.pools, r.twoHopPools];
    };
    expect([per(SPYX), per(QQQX), per(AMZNX)]).toEqual([
      ['SPYx', 10, 5],
      ['QQQx', 7, 6],
      ['AMZNx', 4, 1],
    ]);
    for (const r of onWhole.twoHopRows)
      expect(Object.keys(r)).toEqual([
        'assetMint',
        'asset',
        'fetchedAt',
        'slot',
        'side',
        'notionalUsd',
        'outUsd',
        'costPct',
        'poolsUsed',
        'pools',
        'twoHopPools',
        'twoHopUsed',
        'refPool',
        'refMidUsd',
        'split',
        'legs',
        'viaTrades',
        'oneHop',
        'gainBp',
        'solUsd',
        'source',
        'method',
        'methodVersion',
        'provenance',
      ]);
  });

  it('each carries the one-hop answer of the same trade at the same snapshot, and the gain against it', () => {
    for (const t of onWhole.twoHopRows) {
      const r = offByKey.get(key(t)) as SplitRowOut;
      expect(t.oneHop).toEqual({ outUsd: r.outUsd, costPct: r.costPct, poolsUsed: r.poolsUsed });
      expect(t.gainBp).toBe((t.oneHop.costPct - t.costPct) * 100);
      expect([t.refPool, t.refMidUsd, t.fetchedAt, t.slot]).toEqual([
        r.refPool,
        r.refMidUsd,
        r.fetchedAt,
        r.slot,
      ]);
    }
  });

  it('two hops never cost more than one on these pools, and are cheaper somewhere', () => {
    const worse = onWhole.twoHopRows.filter((t) => !(t.gainBp >= -1e-6));
    expect(worse.map((t) => [t.asset, t.side, t.notionalUsd, t.gainBp])).toEqual([]);
    expect(onWhole.twoHopRows.filter((t) => t.gainBp > 0).length).toBeGreaterThan(0);
  });

  it('a row that used two hops has its via trades, and its legs add up to it', () => {
    const used = onWhole.twoHopRows.filter((t) => t.twoHopUsed > 0);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used.map((t) => t.asset))).toEqual(new Set(['SPYx', 'QQQx', 'AMZNx']));
    expect(new Set(used.map((t) => t.side))).toEqual(new Set(['sell', 'buy']));
    for (const t of used) {
      const viaLegs = t.legs.filter((l) => l.via);
      expect(viaLegs.length).toBe(t.twoHopUsed);
      expect(t.legs.length).toBe(t.poolsUsed);
      expect(t.viaTrades).not.toBeNull();
      const trades = t.viaTrades ?? [];
      expect(trades.map((v) => v.via).sort()).toEqual(
        [...new Set(viaLegs.map((l) => l.via?.mint as string))].sort(),
      );
      sameSum(sum(t.legs.map((l) => l.outUsd)), t.outUsd);
      for (const v of trades) {
        const mine = viaLegs.filter((l) => l.via?.mint === v.via);
        // the via tokens of every pool of a group are added and traded once
        sameSum(sum(mine.map((l) => l.via?.amount as number)), v.amount);
        sameSum(sum(mine.map((l) => (t.side === 'sell' ? l.outUsd : l.amountIn))), v.usd);
        sameSum(sum(v.legs.map((l) => l.amountIn)), t.side === 'sell' ? v.amount : v.usd);
      }
      const s = t.split;
      expect(Math.abs(s.poolFee + s.transferFee + s.basis + s.impact - s.total)).toBeLessThan(
        1e-12,
      );
      expect(s.total).toBe(1 - t.outUsd / t.notionalUsd);
    }
  });

  it('a row that used none is the one-hop row, number for number', () => {
    const unused = onWhole.twoHopRows.filter((t) => t.twoHopUsed === 0);
    expect(unused.length).toBeGreaterThan(0);
    for (const t of unused) {
      const r = offByKey.get(key(t)) as SplitRowOut;
      expect(t.viaTrades).toBeNull();
      expect(t.gainBp).toBe(0);
      expect(
        JSON.stringify([t.outUsd, t.costPct, t.poolsUsed, t.refPool, t.refMidUsd, t.split, t.legs]),
      ).toBe(
        JSON.stringify([r.outUsd, r.costPct, r.poolsUsed, r.refPool, r.refMidUsd, r.split, r.legs]),
      );
    }
  });

  it('each says where it comes from, how it was made and when', () => {
    for (const t of onWhole.twoHopRows) {
      expect(t.source).toBe(off.rows[0]?.source);
      expect(t.source.length).toBeGreaterThan(0);
      expect(t.method).toBe(
        'routed_greedy_32_chunks with two hops through a tracked stock (packages/risk/src/pools/route.ts)',
      );
      expect(t.methodVersion).toBe('split-0.2');
      expect(t.provenance).toBe('live');
      expect(t.fetchedAt).toBe(cap.fetchedAt);
      expect(t.solUsd).toBe(cap.solUsd);
    }
    for (const r of onWhole.rows) expect(r.methodVersion).toBe('split-0.1');
  });
});

describe('what was not routed, counted', () => {
  it('nothing on the fixture: all six pools are routed both ways', () => {
    expect(notRoutedSummary(built)).toEqual({
      byReason: [],
      poolsWithNoRoute: 0,
      tvlUsdWithNoRoute: 0,
    });
  });

  it('a pool counts once per reason, and the pools no route reaches are counted apart', () => {
    // SPYx neither tracked nor with a pool of its own: the five pools that pair it with QQQx serve neither way
    const noSpyx: SplitCapture = {
      ...cap,
      tracked: cap.tracked.filter((m) => m !== SPYX),
      direct: cap.direct.filter((p) => p.assetMint !== SPYX),
    };
    const pairs = cap.twoHopPools.filter((p) => [p.assetMint, p.quoteMint].includes(SPYX));
    const tvl = sum(pairs.map((p) => p.tvlUsd));
    expect(pairs.length).toBe(5);
    const s = notRoutedSummary(buildSplit(noSpyx));
    expect(s.poolsWithNoRoute).toBe(5);
    sameSum(s.tvlUsdWithNoRoute, tvl);
    expect(s.byReason.map((g) => [g.reason, g.directions, g.pools]).sort()).toEqual([
      ['asset_has_no_pool_in_this_run', 5, 5],
      ['via_not_tracked', 5, 5],
    ]);
    for (const g of s.byReason) sameSum(g.tvlUsd, tvl);

    // SPYx only untracked: it may not be a via, but it is still sold through QQQx, so every pool keeps one way
    const untracked: SplitCapture = { ...cap, tracked: cap.tracked.filter((m) => m !== SPYX) };
    const u = notRoutedSummary(buildSplit(untracked));
    expect(u.byReason.map((g) => [g.reason, g.directions, g.pools])).toEqual([
      ['via_not_tracked', 5, 5],
    ]);
    sameSum(u.byReason[0]?.tvlUsd as number, tvl);
    expect([u.poolsWithNoRoute, u.tvlUsdWithNoRoute]).toEqual([0, 0]);

    // a pool the chain did not return: two directions, one reason, and its money counted once
    const gone = cap.twoHopPools[0] as RegPool;
    const g = notRoutedSummary(
      buildSplit({ ...cap, accounts: { ...cap.accounts, [gone.address]: null } }),
    );
    expect(g).toEqual({
      byReason: [{ reason: 'pool_not_built', directions: 2, pools: 1, tvlUsd: gone.tvlUsd }],
      poolsWithNoRoute: 1,
      tvlUsdWithNoRoute: gone.tvlUsd,
    });
  });
});

// --- the scripts themselves, in a child process. `fetch` is replaced before the script loads: in a replay any call
// ends the process with code 97; for the live path the calls are answered from the capture, logged, and the clock
// stands at the capture's fetchedAt. Nothing is read under the real collector home and nothing is written outside
// `tmp`: every run names its data folder, and the one that must not is run from an empty folder inside `tmp`. ---
const tmp = mkdtempSync(join(tmpdir(), 'split-rows-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const emptyHome = join(tmp, 'home-empty');
mkdirSync(emptyHome);
// the loader by its file, so that a run from another working folder finds it
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const NO_NETWORK =
  'data:text/javascript,globalThis.fetch=()=>{console.error("network call in a replay");process.exit(97)}';
const FROZEN_RPC = join(tmp, 'frozen-rpc.mjs');
writeFileSync(
  FROZEN_RPC,
  `import { appendFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const cap = JSON.parse(gunzipSync(readFileSync(process.env.FROZEN_CAPTURE)).toString());
const pools = new Set([...cap.direct, ...cap.twoHopPools].map((p) => p.address));
const frozen = Date.parse(cap.fetchedAt);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(frozen);
  }
  static now() {
    return frozen;
  }
};
const stop = (why) => {
  console.error(why);
  process.exit(98);
};
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://lite-api.jup.ag/price/v3?ids=')) {
    appendFileSync(process.env.FROZEN_LOG, JSON.stringify({ get: u }) + '\\n');
    const mint = u.split('ids=')[1];
    return new Response(JSON.stringify({ [mint]: { usdPrice: cap.solUsd } }));
  }
  if (u !== process.env.SOLANA_RPC_URL) stop('unexpected request to ' + u);
  const body = JSON.parse(init.body);
  if (body.method !== 'getMultipleAccounts') stop('unexpected method ' + body.method);
  const keys = body.params[0];
  appendFileSync(process.env.FROZEN_LOG, JSON.stringify({ keys, config: body.params[1] }) + '\\n');
  const value = keys.map((k) =>
    cap.accounts[k] == null ? null : { owner: 'frozen', data: [cap.accounts[k], 'base64'] },
  );
  const slot = pools.has(keys[0]) ? cap.slotHeads : cap.slot;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value } }));
};
`,
);
// a collector home: the registry and the cache for the live path, the collector's file of the day for the drift
const home = (name: string, files: { registry?: boolean; collector?: string }) => {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  if (files.registry) {
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ pools: registryPools }));
    writeFileSync(join(dir, 'cache.json'), JSON.stringify({ children: cacheChildren }));
  }
  if (files.collector) writeFileSync(join(dir, 'assets', `${DAY}.jsonl`), files.collector);
  return dir;
};
const liveHome = home('home-live', { registry: true });

const runScript = (
  name: string,
  preload: string,
  env: Record<string, string>,
  opts: { script?: string; args?: string[]; cwd?: string; noDataDir?: boolean } = {},
) => {
  const data = join(tmp, name);
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      '--import',
      TSX,
      resolve(opts.script ?? 'scripts/risk/split-snapshot.ts'),
      ...(opts.args ?? []),
    ],
    {
      encoding: 'utf8',
      timeout: 25_000,
      cwd: opts.cwd,
      // nothing of the caller's environment but what a process needs to start; no .env file is loaded
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        DOTENV_CONFIG_PATH: join(tmp, 'no.env'),
        SOLANA_RPC_URL: 'http://frozen.invalid',
        RISK_HOME: emptyHome,
        ...(opts.noDataDir ? {} : { RISK_DATA_DIR: data }),
        ...env,
      },
    },
  );
  const split = join(data, 'split');
  const lines = (f: string) =>
    existsSync(f)
      ? readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => `${l}\n`)
      : null;
  return {
    status: r.status,
    stderr: r.stderr,
    summary: r.stdout.trim() ? (JSON.parse(r.stdout) as Record<string, unknown>) : null,
    split,
    files: existsSync(split) ? readdirSync(split).sort() : [],
    rows: lines(join(split, `${DAY}.jsonl`)),
    twoHopRows: lines(join(split, 'two-hop', `${DAY}.jsonl`)),
  };
};
const SUMMARY_KEYS = [
  'file',
  'fetchedAt',
  'seconds',
  'accounts',
  'pools',
  'assets',
  'rows',
  'solUsd',
  'failures',
  'failureSample',
  'vsCollectorSellUpTo250k',
];
const TIMEOUT = 30_000;

describe('pnpm risk:split-snapshot from a capture (RISK_SPLIT_REPLAY)', () => {
  it(
    'with the setting off, a capture taken with two hops is replayed as a one-hop run: the 48 rows and one file',
    () => {
      const r = runScript('replay-off', NO_NETWORK, { RISK_SPLIT_REPLAY: FIXTURE });
      expect(r.status, r.stderr).toBe(0);
      expect(r.files).toEqual([`${DAY}.jsonl`]);
      expect(r.rows).toEqual(old.lines);
      expect(Object.keys(r.summary ?? {})).toEqual(SUMMARY_KEYS);
      expect(r.summary).toEqual({
        file: join(r.split, `${DAY}.jsonl`),
        fetchedAt: cap.fetchedAt,
        seconds: Math.round(cap.rpc.seconds),
        ...old.summary,
      });
    },
    TIMEOUT,
  );

  it(
    'with RISK_SPLIT_TWO_HOP=1, the same file byte for byte, and the two-hop rows in a folder beside it',
    () => {
      const r = runScript('replay-on', NO_NETWORK, {
        RISK_SPLIT_REPLAY: FIXTURE,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.rows).toEqual(old.lines);
      expect(r.twoHopRows).toEqual(text(on.twoHopRows));
      // what the readers of the split rows list: the cost breakdown and the fixture freezer take *.jsonl, the API
      // route takes <day>.jsonl; the folder is neither
      expect(r.files).toEqual([`${DAY}.jsonl`, 'two-hop']);
      expect(r.files.filter((f) => f.endsWith('.jsonl'))).toEqual([`${DAY}.jsonl`]);
      expect(Object.keys(r.summary ?? {})).toEqual([...SUMMARY_KEYS, 'twoHop']);
      const { twoHop, ...rest } = r.summary as { twoHop: Record<string, unknown> };
      expect(rest).toEqual({
        file: join(r.split, `${DAY}.jsonl`),
        fetchedAt: cap.fetchedAt,
        seconds: Math.round(cap.rpc.seconds),
        ...old.summary,
        accounts: Object.keys(cap.accounts).length,
      });
      expect(Object.keys(twoHop)).toEqual([
        'file',
        'poolsRead',
        'only',
        'assetsWithTwoHop',
        'rows',
        'usedRows',
        'notRouted',
        'listed',
        'rpcCalls',
        'seconds',
        'accountsAdded',
        'routeSeconds',
      ]);
      // the fixture is cut to QQQx: the six pools are read and routed, and QQQx alone gets rows
      expect(r.twoHopRows?.length).toBe(16);
      expect(twoHop).toMatchObject({
        file: join(r.split, 'two-hop', `${DAY}.jsonl`),
        poolsRead: 6,
        only: ['QQQx'],
        assetsWithTwoHop: 1,
        rows: 16,
        usedRows: on.twoHopRows.filter((t) => t.twoHopUsed > 0).length,
        notRouted: { byReason: [], poolsWithNoRoute: 0, tvlUsdWithNoRoute: 0 },
        listed: cap.listed,
        rpcCalls: cap.rpc.calls,
        seconds: cap.rpc.seconds,
        accountsAdded: 30,
      });
    },
    TIMEOUT,
  );

  it(
    'a capture that records no cut gives two-hop rows for every asset with a stock-to-stock pool: 48',
    () => {
      const wholeFile = join(tmp, 'whole.json.gz');
      saveCapture(wholeFile, whole);
      const r = runScript('replay-whole', NO_NETWORK, {
        RISK_SPLIT_REPLAY: wholeFile,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.rows).toEqual(old.lines);
      expect(r.twoHopRows).toEqual(text(onWhole.twoHopRows));
      const twoHop = (r.summary as { twoHop: Record<string, unknown> }).twoHop;
      expect(twoHop).toMatchObject({
        only: null,
        assetsWithTwoHop: 3,
        rows: 48,
        usedRows: onWhole.twoHopRows.filter((t) => t.twoHopUsed > 0).length,
      });
    },
    TIMEOUT,
  );

  it(
    "reads the collector's file of the capture's day under RISK_HOME: vsCollector on the rows, the drift sorted",
    () => {
      const r = runScript('replay-collector', NO_NETWORK, {
        RISK_SPLIT_REPLAY: FIXTURE,
        RISK_HOME: home('home-collector', { collector: collectorOnDisk }),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.rows).toEqual(oldOnDisk.lines);
      expect(r.rows).not.toEqual(old.lines);
      expect(r.summary).toEqual({
        file: join(r.split, `${DAY}.jsonl`),
        fetchedAt: cap.fetchedAt,
        seconds: Math.round(cap.rpc.seconds),
        ...oldOnDisk.summary,
      });
      // what those are: SPYx against its row 77 s earlier, QQQx against the one 60 s later, which has no $2,500 point
      const vs = parse<SplitRowOut>(r.rows ?? []).filter((x) => x.vsCollector);
      expect(
        vs.map((x) => [x.asset, x.side, x.vsCollector?.fetchedAt, x.vsCollector?.pools]),
      ).toEqual([
        ...NOTIONALS.map(() => ['SPYx', 'sell', at(-77_000), 10]),
        ...NOTIONALS.filter((n) => n !== 2_500).map(() => ['QQQx', 'sell', at(60_000), 21]),
      ]);
      // and the summary is of the sorted drift: in row order the p90 would be one of QQQx's, the smaller ones
      const inRowOrder = oneHopRows(builtOne, one, {
        collector: nearestCollectorRows(collectorOnDisk, cap.fetchedAt),
      }).drift;
      const p90 = (xs: number[]) => xs[Math.floor(xs.length * 0.9)] as number;
      expect(inRowOrder.length).toBe(11);
      expect(oldOnDisk.summary.vsCollectorSellUpTo250k?.n).toBe(11);
      expect(oldOnDisk.summary.vsCollectorSellUpTo250k?.p90AbsPp).toBe(
        p90([...inRowOrder].sort((a, b) => a - b)),
      );
      expect(p90(inRowOrder)).toBeLessThan(p90([...inRowOrder].sort((a, b) => a - b)) - 1);
    },
    TIMEOUT,
  );

  it(
    'with no RISK_DATA_DIR a replay stops before it writes: its rows would land in the folder of the hourly job',
    () => {
      // run from an empty folder: the default folder, data/risk/split, would be made inside it
      const cwd = join(tmp, 'cwd-no-data-dir');
      mkdirSync(cwd);
      const settings: Array<Record<string, string>> = [
        {},
        { RISK_SPLIT_TWO_HOP: '1' },
        { RISK_DATA_DIR: '' },
      ];
      for (const env of settings) {
        const r = runScript(
          'replay-no-data-dir',
          NO_NETWORK,
          { RISK_SPLIT_REPLAY: resolve(FIXTURE), ...env },
          { cwd, noDataDir: true },
        );
        expect(r.status).not.toBe(0);
        expect(r.status).not.toBe(97);
        expect(r.stderr).toContain(
          "a replay writes rows: name a folder with RISK_DATA_DIR, and not the hourly job's",
        );
        expect(r.summary).toBeNull();
        expect(readdirSync(cwd)).toEqual([]);
        expect(r.files).toEqual([]);
      }
      // the same run with a folder named is an ordinary replay, and still writes nothing where it was run
      const ok = runScript(
        'replay-data-dir-named',
        NO_NETWORK,
        { RISK_SPLIT_REPLAY: resolve(FIXTURE) },
        { cwd },
      );
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.rows).toEqual(old.lines);
      expect(readdirSync(cwd)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'a replay never appends: a day file that exists stops it, whatever named the folder',
    () => {
      const first = runScript('replay-twice', NO_NETWORK, { RISK_SPLIT_REPLAY: FIXTURE });
      expect(first.status, first.stderr).toBe(0);
      expect(first.rows).toEqual(old.lines);
      // the same capture again, into the same folder: nothing is added, with the setting off or on
      for (const env of [{}, { RISK_SPLIT_TWO_HOP: '1' }] as Array<Record<string, string>>) {
        const again = runScript('replay-twice', NO_NETWORK, { RISK_SPLIT_REPLAY: FIXTURE, ...env });
        expect(again.status).not.toBe(0);
        expect(again.stderr).toContain('a replay never appends');
        expect(again.summary).toBeNull();
        expect(again.files).toEqual([`${DAY}.jsonl`]);
        expect(again.rows).toEqual(old.lines);
      }
      // two-hop rows of an earlier replay stop a later one too, before the unchanged rows are written again
      const on = runScript('replay-twice-on', NO_NETWORK, {
        RISK_SPLIT_REPLAY: FIXTURE,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(on.status, on.stderr).toBe(0);
      const rowsBefore = on.rows;
      const twoHopBefore = on.twoHopRows;
      rmSync(join(on.split, `${DAY}.jsonl`));
      const onAgain = runScript('replay-twice-on', NO_NETWORK, {
        RISK_SPLIT_REPLAY: FIXTURE,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(onAgain.status).not.toBe(0);
      expect(onAgain.stderr).toContain('a replay never appends');
      expect(onAgain.rows).toBeNull();
      expect(onAgain.twoHopRows).toEqual(twoHopBefore);
      expect(rowsBefore).toEqual(old.lines);
    },
    TIMEOUT,
  );

  it(
    'the setting is on only at exactly 1',
    () => {
      const r = runScript('replay-true', NO_NETWORK, {
        RISK_SPLIT_REPLAY: FIXTURE,
        RISK_SPLIT_TWO_HOP: 'true',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.files).toEqual([`${DAY}.jsonl`]);
      expect(r.rows).toEqual(old.lines);
      expect(Object.keys(r.summary ?? {})).toEqual(SUMMARY_KEYS);
    },
    TIMEOUT,
  );

  it(
    'the setting on a capture taken without two hops stops with an error and writes nothing',
    () => {
      const oneHopFile = join(tmp, 'one-hop.json.gz');
      saveCapture(oneHopFile, one);
      const bad = runScript('replay-mismatch', NO_NETWORK, {
        RISK_SPLIT_REPLAY: oneHopFile,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(bad.status).not.toBe(0);
      expect(bad.status).not.toBe(97);
      expect(bad.stderr).toContain('was captured without two hops');
      expect(bad.files).toEqual([]);
      // the same file with the setting off is an ordinary run
      const ok = runScript('replay-one-hop', NO_NETWORK, { RISK_SPLIT_REPLAY: oneHopFile });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.rows).toEqual(old.lines);
    },
    TIMEOUT,
  );

  it(
    'if the two-hop rows cannot be written, the 48 rows are already on disk, and the run says so and exits 1',
    () => {
      // a file where the folder of the two-hop rows goes
      mkdirSync(join(tmp, 'replay-blocked', 'split'), { recursive: true });
      writeFileSync(join(tmp, 'replay-blocked', 'split', 'two-hop'), '');
      const r = runScript('replay-blocked', NO_NETWORK, {
        RISK_SPLIT_REPLAY: FIXTURE,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(r.status, r.stderr).toBe(1);
      expect(r.rows).toEqual(old.lines);
      expect(r.twoHopRows).toBeNull();
      const twoHop = (r.summary as { twoHop: Record<string, unknown> }).twoHop;
      expect(twoHop).toMatchObject({ poolsRead: 6, assetsWithTwoHop: 1, rows: 0, usedRows: 0 });
      expect(typeof twoHop.error).toBe('string');
      expect((twoHop.error as string).length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

// the requests a run under the frozen RPC made, in order
const requests = (log: string) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { keys?: string[]; config?: unknown; get?: string });

describe('pnpm risk:split-snapshot reading (answers frozen, no network)', () => {
  const batches = (keys: string[]) =>
    Array.from({ length: Math.ceil(keys.length / 100) }, (_, i) => ({
      keys: keys.slice(i * 100, i * 100 + 100),
      config: { encoding: 'base64' },
    }));
  const price = { get: `https://lite-api.jup.ag/price/v3?ids=${SOL}` };
  const live = (name: string, env: Record<string, string>) => {
    const log = join(tmp, `${name}.log`);
    writeFileSync(log, '');
    const r = runScript(name, pathToFileURL(FROZEN_RPC).href, {
      RISK_HOME: liveHome,
      FROZEN_CAPTURE: FIXTURE,
      FROZEN_LOG: log,
      ...env,
    });
    return { ...r, requests: requests(log) };
  };

  it(
    'with the setting off: the requests the script sent before, in their order, and the same file and summary',
    () => {
      const r = live('live-off', {});
      expect(r.status, r.stderr).toBe(0);
      // the pools in batches of 100, then the fee configs and the tick and bin arrays, then the SOL price
      expect(r.requests).toEqual([...oldReader.asked.flatMap(batches), price]);
      expect(r.files).toEqual([`${DAY}.jsonl`]);
      expect(r.rows).toEqual(old.lines);
      expect(r.summary).toEqual({
        file: join(r.split, `${DAY}.jsonl`),
        fetchedAt: cap.fetchedAt,
        seconds: 0,
        ...old.summary,
      });
    },
    TIMEOUT,
  );

  it(
    'with RISK_SPLIT_TWO_HOP=1: the stock-to-stock pools join the same batches, and every asset gets its two-hop rows',
    () => {
      // the tracked stocks are those of scripts/risk/universe/solana.json, which the script imports
      const r = live('live-on', { RISK_SPLIT_TWO_HOP: '1' });
      expect(r.status, r.stderr).toBe(0);
      const heads = [...cap.direct, ...cap.twoHopPools].map((p) => p.address);
      expect(r.requests[0]).toEqual({ keys: heads, config: { encoding: 'base64' } });
      expect(r.requests.at(-1)).toEqual(price);
      const asked = r.requests.flatMap((q) => q.keys ?? []);
      expect(new Set(asked).size).toBe(asked.length);
      expect([...asked].sort()).toEqual(Object.keys(cap.accounts).sort());
      expect(r.requests.length).toBe(
        Math.ceil(heads.length / 100) + Math.ceil((asked.length - heads.length) / 100) + 1,
      );
      expect(r.rows).toEqual(old.lines);
      // a run of the script is a whole run: no cut, and rows for every asset with a stock-to-stock pool
      expect(r.twoHopRows).toEqual(text(onWhole.twoHopRows));
      const twoHop = (r.summary as { twoHop: Record<string, unknown> }).twoHop;
      expect(twoHop).toMatchObject({
        poolsRead: 6,
        only: null,
        assetsWithTwoHop: 3,
        rows: 48,
        accountsAdded: 30,
      });
      // of the registry's rows: one whose quote token has no measured way to dollars is listed, with its money
      expect(twoHop.listed).toEqual([
        {
          reason: 'quote_token_has_no_measured_way_to_dollars',
          pools: 1,
          tvlUsd: (cap.direct[1] as RegPool).tvlUsd,
        },
        { reason: 'neither_stock_is_tracked', pools: 0, tvlUsd: 0 },
      ]);
    },
    TIMEOUT,
  );

  it(
    "with the collector's file of the day under RISK_HOME: the rows and the drift the script gave before",
    () => {
      const r = live('live-collector', {
        RISK_HOME: home('home-live-collector', { registry: true, collector: collectorOnDisk }),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.requests).toEqual([...oldReader.asked.flatMap(batches), price]);
      expect(r.rows).toEqual(oldOnDisk.lines);
      expect(r.summary).toEqual({
        file: join(r.split, `${DAY}.jsonl`),
        fetchedAt: cap.fetchedAt,
        seconds: 0,
        ...oldOnDisk.summary,
      });
      expect(oldOnDisk.summary.vsCollectorSellUpTo250k).not.toBeNull();
    },
    TIMEOUT,
  );
});

describe('pnpm risk:split-capture (answers frozen, no network)', () => {
  // run from an empty folder, so that an argument taken for the output file by mistake would be written there
  const cwd = join(tmp, 'cwd-capture');
  mkdirSync(cwd);
  const capture = (name: string, args: string[], env: Record<string, string> = {}) => {
    const log = join(tmp, `${name}.log`);
    writeFileSync(log, '');
    const r = runScript(
      name,
      pathToFileURL(FROZEN_RPC).href,
      { RISK_HOME: liveHome, FROZEN_CAPTURE: resolve(FIXTURE), FROZEN_LOG: log, ...env },
      { script: 'scripts/risk/split-capture.ts', args, cwd },
    );
    return { ...r, requests: requests(log) };
  };
  const addresses = (ps: readonly RegPool[]) => ps.map((p) => p.address);

  it(
    '--two-hop --only AMZNx <file>: the file named is written, cut to AMZNx and its partner, and says so',
    () => {
      const out = join(tmp, 'cut-amznx.json.gz');
      // the value of --only comes before the file: it is not taken for it
      const r = capture('capture-only', ['--two-hop', '--only', 'AMZNx', out]);
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(cwd)).toEqual([]);
      expect(r.summary).toMatchObject({ file: out, twoHop: true, only: ['AMZNx'] });
      const cut = loadCapture(out);
      expect(cut.only).toEqual(['AMZNx']);
      expect(cut.twoHop).toBe(true);
      // the one pool that pairs AMZNx with another stock, QQQx, and the dollar and SOL pools of both
      const pairs = cap.twoHopPools.filter((p) => [p.assetMint, p.quoteMint].includes(AMZNX));
      expect(pairs.map((p) => [p.assetMint, p.quoteMint])).toEqual([[QQQX, AMZNX]]);
      expect(addresses(cut.twoHopPools)).toEqual(addresses(pairs));
      expect(addresses(cut.direct)).toEqual(
        addresses(cap.direct.filter((p) => [QQQX, AMZNX].includes(p.assetMint))),
      );
      expect(r.requests[0]?.keys).toEqual(addresses([...cut.direct, ...cut.twoHopPools]));
      // routed from that file: QQQx is built with its one pool, but the rows are AMZNx's, the stock it was cut to.
      // They are the rows AMZNx has in the wider file: all of AMZNx's pools are in both
      const b = buildSplit(cut);
      expect([...b.byAsset].map(([mint, a]) => [mint, a.twoHop.length])).toEqual([
        [QQQX, 1],
        [AMZNX, 1],
      ]);
      const rows = splitRows(b, cut);
      expect(rows.twoHopRows.length).toBe(16);
      expect(text(rows.twoHopRows)).toEqual(
        text(onWhole.twoHopRows.filter((t) => t.assetMint === AMZNX)),
      );
      // and the snapshot replayed from it says the same
      const replayed = runScript('replay-cut-amznx', NO_NETWORK, {
        RISK_SPLIT_REPLAY: out,
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(replayed.status, replayed.stderr).toBe(0);
      expect(replayed.twoHopRows).toEqual(text(rows.twoHopRows));
      expect((replayed.summary as { twoHop: Record<string, unknown> }).twoHop).toMatchObject({
        poolsRead: 1,
        only: ['AMZNx'],
        assetsWithTwoHop: 1,
        rows: 16,
      });
    },
    TIMEOUT,
  );

  it(
    'RISK_SPLIT_TWO_HOP=1 stands for --two-hop, and a run with no --only records no cut',
    () => {
      const out = join(tmp, 'whole-by-setting.json.gz');
      const r = capture('capture-setting', [out], { RISK_SPLIT_TWO_HOP: '1' });
      expect(r.status, r.stderr).toBe(0);
      const got = loadCapture(out);
      expect([got.twoHop, got.only]).toEqual([true, null]);
      expect(addresses(got.direct)).toEqual(addresses(cap.direct));
      expect(addresses(got.twoHopPools)).toEqual(addresses(cap.twoHopPools));
      expect(got.accounts).toEqual(cap.accounts);
      // without either, a one-hop capture
      const plain = join(tmp, 'plain.json.gz');
      expect(capture('capture-plain', [plain]).status).toBe(0);
      expect([loadCapture(plain).twoHop, loadCapture(plain).only]).toEqual([false, null]);
      expect(loadCapture(plain).accounts).toEqual(one.accounts);
    },
    TIMEOUT,
  );

  it(
    '--raw-arrays --only AMZNx <file>: the pools the raw-arrays job reads for that stock, with no two hops',
    () => {
      const out = join(tmp, 'raw-arrays-amznx.json.gz');
      const r = capture('capture-raw-arrays', ['--raw-arrays', '--only', 'AMZNx', out]);
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(cwd)).toEqual([]);
      expect(r.summary).toMatchObject({
        file: out,
        twoHop: false,
        rawArrays: true,
        only: ['AMZNx'],
      });
      const got = loadCapture(out);
      // the job's own selection on the same registry (PLAN-UNIVERSE RU.12), kept to the stock named
      const want = selectRawArrayPools(registryPools, {
        tracked: new Set(cap.tracked),
      }).read.filter((p) => p.assetSymbol === 'AMZNx');
      expect(want.length).toBeGreaterThan(0);
      expect(addresses(got.direct)).toEqual(addresses(want));
      expect([got.twoHop, got.twoHopPools, got.only]).toEqual([false, [], ['AMZNx']]);
      expect(r.requests[0]?.keys).toEqual(addresses(want));
      // the setting that stands for --two-hop cannot be combined with it either
      const both = capture('capture-raw-arrays-two-hop', ['--raw-arrays', out], {
        RISK_SPLIT_TWO_HOP: '1',
      });
      expect(both.status).not.toBe(0);
      expect(both.requests).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    '--only with no value, or no file beside it, stops with the usage line before anything is read or written',
    () => {
      const out = join(tmp, 'never-written.json.gz');
      for (const args of [
        [out, '--two-hop', '--only'],
        ['--only', '--two-hop', out],
        [out, '--only', ','],
        // the value of --only is not the file
        ['--two-hop', '--only', 'QQQx'],
        // --only twice, and an option it does not know, are mistakes in the command
        [out, '--only', 'QQQx', '--only', 'SPYx'],
        [out, '--two-hops'],
        // the raw-arrays pools are not a two-hop run
        [out, '--raw-arrays', '--two-hop'],
        [],
      ]) {
        const r = capture('capture-usage', args);
        expect(r.status).not.toBe(0);
        expect(r.status).not.toBe(98);
        expect(r.stderr).toContain(
          'usage: split-capture.ts <out.json.gz> [--two-hop | --raw-arrays] [--only SYMBOL,…] (RISK_SPLIT_TWO_HOP=1 in place of --two-hop)',
        );
        expect(r.requests).toEqual([]);
        expect(existsSync(out)).toBe(false);
        expect(readdirSync(cwd)).toEqual([]);
      }
    },
    TIMEOUT,
  );
});
