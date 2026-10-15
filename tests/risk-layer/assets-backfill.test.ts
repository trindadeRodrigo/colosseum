import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type AnchoredPage,
  addToManifest,
  blockAtTime,
  collapsedSpread,
  cutShelf,
  estimateSampled,
  estimateSignatures,
  extrapolate,
  fitsBudget,
  GB,
  type Manifest,
  mergeCovered,
  pageRate,
  quietWaitMs,
  requestSlot,
  SHELF_FLOOR_USD,
  shelfHash,
  strata,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  BudgetStop,
  budgetGuard,
  gateWholeSeries,
  newestCount,
  requireWindowInScope,
  scopeKey,
  scopeOptions,
  windowNeedsGate,
} from '../../scripts/risk/assets/backfill-gate';
import { dayPieces, fetchWindow } from '../../scripts/risk/assets/backfill-solana';
import {
  classifyPools,
  type Deps,
  fetchLogs,
  gzLines,
  LOG_TOPIC,
  logsOf,
  readFetched,
  seriesFilters,
} from '../../scripts/risk-evm/backfill-logs';
import { countRounds, fetchRounds, roundIdOf } from '../../scripts/risk-evm/backfill-rounds';
import { CHAINS, type ChainConfig } from '../../scripts/risk-evm/config';
import { replayRpc } from '../../scripts/risk-evm/replay';
import type { RpcReply } from '../../scripts/risk-evm/rpc';

// PLAN-ASSETS AS.8: the backfill walkers, counted and measured, not run in full. The pure parts are checked by
// hand; the walkers replay frozen real answers (fixtures/risk/assets/backfill/, recorded with --record by
// pnpm risk:assets-backfill on 2026-10-11). No test calls the network.
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const FX = 'fixtures/risk/assets/backfill';
const loadGz = <T>(f: string) => JSON.parse(gunzipSync(readFileSync(join(FX, f))).toString()) as T;

describe('the live loop’s minutes', () => {
  it('reads nothing from minute 1 to minute 14 of an hour, and waits until minute 15', () => {
    expect(quietWaitMs(new Date('2026-10-11T03:00:59Z'))).toBe(0);
    expect(quietWaitMs(new Date('2026-10-11T03:01:00Z'))).toBe(14 * 60_000);
    expect(quietWaitMs(new Date('2026-10-11T03:14:59Z'))).toBe(1_000);
    expect(quietWaitMs(new Date('2026-10-11T03:15:00Z'))).toBe(0);
    expect(quietWaitMs(new Date('2026-10-11T03:59:59Z'))).toBe(0);
  });
});

describe('sampled windows and the estimate of a total', () => {
  it('cuts a span into strata with one window at the middle of each', () => {
    const s = strata(0, 999, 4, 100);
    expect(s.map((x) => [x.from, x.to, ...x.sample])).toEqual([
      [0, 249, 75, 174],
      [250, 499, 325, 424],
      [500, 749, 575, 674],
      [750, 999, 825, 924],
    ]);
    // a stratum shorter than a window is sampled whole
    expect(strata(0, 9, 2, 100).map((x) => x.sample)).toEqual([
      [0, 4],
      [5, 9],
    ]);
  });
  it('scales each window’s count by its stratum’s length', () => {
    const s = strata(0, 999, 2, 100); // strata of 500 blocks, windows of 100: factor 5
    const e = extrapolate([
      { stratum: s[0] as never, counts: { swaps: 10 }, bytes: 1000 },
      { stratum: s[1] as never, counts: { swaps: 30, burns: 2 }, bytes: 3000 },
    ]);
    expect(e.totals).toEqual({ swaps: 200, burns: 10 });
    expect(e.bytes).toBe(20_000);
    expect(e.sampledShare).toBe(0.2);
  });
});

describe('an address’s signatures from anchored pages', () => {
  const page = (t: number, n: number, oldest: number | null, exhausted = false): AnchoredPage => ({
    t,
    n,
    newest: oldest === null ? null : t - 1,
    oldest,
    failed: Math.floor(n / 4),
    exhausted,
  });
  it('a page’s rate is its signatures over the time from its oldest to its anchor', () => {
    expect(pageRate(page(1000, 100, 900))).toBe(1);
    expect(pageRate(page(1000, 0, null))).toBe(0);
  });
  it('measures a page whose newest signature is later than its anchor to that signature', () => {
    // the "now" page of a busy pool: anchored at t=1000, its 1,000 signatures from 995 to 1,005 (10 s, 100/s);
    // to the anchor alone the span is 5 s, and with all of them newer it would clamp to 1 s
    expect(
      pageRate({ t: 1000, n: 1000, newest: 1005, oldest: 995, failed: 0, exhausted: false }),
    ).toBe(100);
    expect(
      pageRate({ t: 1000, n: 1000, newest: 1010, oldest: 1002, failed: 0, exhausted: false }),
    ).toBe(125);
  });
  it('integrates the rates between pages, flat beyond them, nothing before the first transaction', () => {
    // rates 1/s at t=950 (the middle of 900…1000) and 3/s at t=2950 (2900…3000)
    const ps = [page(1000, 100, 900), page(3000, 300, 2900)];
    // from 950 to 2950 the mean is 2/s: 4,000; before 950 1/s for 50 s; after 2950 3/s for 50 s
    expect(estimateSignatures(ps, 900, 3000).signatures).toBeCloseTo(50 + 4000 + 150, 9);
    // an exhausted page: nothing before its oldest signature (800)
    const withFirst = [page(1000, 100, 800, true), page(3000, 300, 2900)];
    const r = estimateSignatures(withFirst, 0, 900);
    expect(r.firstSeen).toBe(800);
    // rate at 900 (the middle of 800…1000) is 100/200 = 0.5/s, flat before it: 100 s from 800 to 900
    expect(r.signatures).toBeCloseTo(50, 9);
    expect(r.failedShare).toBeCloseTo(100 / 400, 12);
    // a page that found nothing at 2000: nothing before 2000; after it the rate rises from 0 (at 2000) to
    // 3/s (at 2950), so 2000…2500 holds half of 500 s × 3·500/950
    const none = [page(2000, 0, null), page(3000, 300, 2900)];
    expect(estimateSignatures(none, 0, 2000).signatures).toBe(0);
    expect(estimateSignatures(none, 0, 2500).signatures).toBeCloseTo(
      (500 * ((3 * 500) / 950)) / 2,
      9,
    );
  });
  it('the sampled walk keeps at most a number of transactions an hour', () => {
    // 1 signature a second, a quarter failed: 2,700 successful an hour, 30 kept, over two hours
    const ps = [page(0, 3600, -3600), page(7200, 3600, 3600)];
    const r = estimateSampled(ps, 0, 7200, 30);
    expect(r).toEqual({ fetched: 60, hours: 2 });
  });
});

describe('the budget (DA14, amended)', () => {
  it('fits 35 GB of new data and keeps 25 GB free, and says which it breaks', () => {
    expect(fitsBudget({ estimateBytes: 10 * GB, usedBytes: 1 * GB, freeBytes: 60 * GB }).fits).toBe(
      true,
    );
    // 6 + 30 = 36 GB of new data; 50 − 30 = 20 GB left free
    const over = fitsBudget({ estimateBytes: 30 * GB, usedBytes: 6 * GB, freeBytes: 50 * GB });
    expect(over.fits).toBe(false);
    expect(over.reasons).toHaveLength(2);
    expect(over.reasons[0]).toMatch(/36\.00 GB would pass the 35 GB budget/);
    expect(over.reasons[1]).toMatch(/fall to 20\.00 GB, under the 25 GB floor/);
    // 60 − 30 = 30 GB stays above the floor: only the budget is broken
    expect(
      fitsBudget({ estimateBytes: 30 * GB, usedBytes: 6 * GB, freeBytes: 60 * GB }).reasons,
    ).toHaveLength(1);
    expect(fitsBudget({ estimateBytes: 1 * GB, usedBytes: 0, freeBytes: 25.5 * GB }).fits).toBe(
      false,
    );
  });
});

describe('manifests', () => {
  it('merges the windows covered where they touch, by unit', () => {
    expect(
      mergeCovered(
        [
          { from: 10, to: 19, unit: 'block' },
          { from: 40, to: 49, unit: 'block' },
        ],
        { from: 20, to: 39, unit: 'block' },
      ),
    ).toEqual([{ from: 10, to: 49, unit: 'block' }]);
  });
  it('adds a window’s days and replaces a check of the same name', () => {
    const m: Manifest = {
      series: 'robinhood-logs',
      chain: 'robinhood',
      subject: 'x',
      methodVersion: 'backfill-0.1',
      source: 's',
      provenance: 'live',
      covered: [],
      days: { '2026-10-01': { rows: 5, bytes: 50 } },
      rows: 5,
      bytes: 50,
      checks: [{ name: 'a', passed: false, detail: 'old' }],
      updatedAt: 't0',
    };
    const n = addToManifest(
      m,
      { from: 1, to: 2, unit: 'block' },
      { '2026-10-02': { rows: 3, bytes: 30 } },
      [{ name: 'a', passed: true, detail: 'new' }],
      't1',
    );
    expect([n.rows, n.bytes, n.checks, n.updatedAt]).toEqual([
      8,
      80,
      [{ name: 'a', passed: true, detail: 'new' }],
      't1',
    ]);
  });
});

describe('Robinhood Chain logs: the filters and the pools of the list', () => {
  it('six filters, one subject narrows them to its kind', () => {
    const all = seriesFilters(robinhood, ['0x117cc2133c37b721f49de2a7a74833232b3b4c0c']);
    expect(all.map((f) => f.name)).toEqual([
      'v3_swap',
      'v4_swap',
      'mint',
      'burn',
      'v3_liquidity',
      'v4_liquidity',
    ]);
    expect(all.find((f) => f.name === 'v4_swap')?.address).toBe(robinhood.v4?.poolManager);
    expect(all.find((f) => f.name === 'v4_swap')?.topics).toEqual([LOG_TOPIC.v4Swap]);
    const id = `0x${'ab'.repeat(32)}`;
    const one = seriesFilters(robinhood, [], { subject: id, subjectKind: 'v4', kind: 'swaps' });
    expect(one.map((f) => [f.name, f.topics])).toEqual([['v4_swap', [LOG_TOPIC.v4Swap, id]]]);
  });
  it('a pool is of the list when either token is a row of it', () => {
    const c = classifyPools(
      [
        { kind: 'cl', id: '0xA', token0: '0x1', token1: '0x2', block: 50 },
        { kind: 'v4', id: '0xB', token0: '0x3', token1: '0x4', block: 10 },
      ],
      new Set(['0x2']),
    );
    expect([
      c.classOf('0xa'),
      c.classOf('0xb'),
      c.classOf('0xc'),
      c.listPools,
      c.firstBlock,
    ]).toEqual(['list_pool', 'other_pool', 'unknown_pool', 1, 50]);
  });
  it('halves a window the endpoint refuses for its size', async () => {
    const asked: Array<[number, number]> = [];
    const rpc = replayRpc({}, (r) => {
      const p = (r.params[0] as { fromBlock: string; toBlock: string }) ?? {};
      const a = Number(p.fromBlock);
      const b = Number(p.toBlock);
      asked.push([a, b]);
      // the endpoint's own words (fixtures/risk-evm/rpc-errors.json style): more than 2 blocks is too many
      return (
        b - a > 1
          ? { error: { code: -32005, message: 'query exceeds limit of 10000 results' } }
          : {
              result: [
                {
                  address: '0x1',
                  topics: [],
                  data: '0x',
                  blockNumber: `0x${a.toString(16)}`,
                  transactionHash: '0x',
                  logIndex: '0x0',
                },
              ],
            }
      ) as RpcReply;
    });
    const deps: Deps = {
      rpc,
      sleep: async () => {},
      now: () => new Date('2026-10-11T03:30:00Z'),
      log: () => {},
    };
    const f = seriesFilters(robinhood, [])[0] as never;
    const got = await logsOf(deps, f, 0, 7);
    expect(got.logs.map((l) => Number(l.blockNumber))).toEqual([0, 2, 4, 6]);
    expect(got.halvings).toBe(3);
    expect(asked[0]).toEqual([0, 7]);
  });
});

type Recording = { recordedAt: string; args: string[]; answers: Record<string, RpcReply> };
const fetchFx = join(FX, 'robinhood-logs-fetch.json.gz');
const roundsFx = join(FX, 'chainlink-rounds.json.gz');
const quiet = (d: Date) => () => d;

describe.skipIf(!existsSync(fetchFx))('Robinhood Chain logs: a recorded fetch, replayed', () => {
  it('files a pool’s swaps by day with a manifest, and a second run asks nothing', async () => {
    const rec = loadGz<Recording>('robinhood-logs-fetch.json.gz');
    const window = rec.args[rec.args.indexOf('--window') + 1] as string;
    const pool = rec.args[rec.args.indexOf('--pool') + 1] as string;
    const [from, to] = window.split('-').map(Number) as [number, number];
    const out = mkdtempSync(join(tmpdir(), 'backfill-'));
    const rpc = replayRpc(rec.answers);
    const deps: Deps = {
      rpc,
      sleep: async () => {},
      now: quiet(new Date(rec.recordedAt)),
      log: () => {},
    };
    const filters = seriesFilters(robinhood, [], {
      subject: pool,
      subjectKind: 'v4',
      kind: 'swaps',
    });
    const inp = {
      out,
      filters,
      scope: pool,
      from,
      to,
      window: 100_000,
      keep: (r: { subject: string }) => r.subject === pool,
      source: 'replay',
    };
    const res = await fetchLogs(deps, inp);
    expect(res.rows).toBeGreaterThan(0);
    const dir = join(out, 'swaps', pool);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    expect(m.covered).toEqual([{ from, to, unit: 'block' }]);
    expect(m.rows).toBe(res.rows);
    expect(m.checks.every((c) => c.passed)).toBe(true);
    const lines = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl.gz'))
      .flatMap((f) =>
        gunzipSync(readFileSync(join(dir, f)))
          .toString()
          .trim()
          .split('\n'),
      );
    expect(lines).toHaveLength(res.rows);
    const rows = lines.map((l) => JSON.parse(l) as { block: number; t: number; topics: string[] });
    expect(rows.every((r) => r.block >= from && r.block <= to && r.topics[1] === pool)).toBe(true);
    expect(rows.every((r) => r.t > 1.7e9)).toBe(true);
    const asked = rpc.asked.length;
    const again = await fetchLogs(deps, inp);
    expect([again.pieces, again.skipped, rpc.asked.length]).toEqual([0, res.pieces, asked]);
  });

  /** The recording as a small chain: its logs by block, and headers between its two by their line. */
  const chainOf = (rec: Recording) => {
    const logs: Array<{ blockNumber: string }> = [];
    const heads: Array<{ block: number; t: number }> = [];
    for (const a of Object.values(rec.answers)) {
      if (Array.isArray(a.result)) logs.push(...(a.result as Array<{ blockNumber: string }>));
      const h = a.result as { number?: string; timestamp?: string } | null;
      if (h && !Array.isArray(h) && h.number && h.timestamp)
        heads.push({ block: Number(h.number), t: Number(h.timestamp) });
    }
    heads.sort((x, y) => x.block - y.block);
    const [h0, h1] = heads as [{ block: number; t: number }, { block: number; t: number }];
    return replayRpc({}, (r) => {
      if (r.method === 'eth_getLogs') {
        const q = r.params[0] as { fromBlock: string; toBlock: string };
        const [a, b] = [Number(q.fromBlock), Number(q.toBlock)];
        return {
          result: logs.filter((l) => Number(l.blockNumber) >= a && Number(l.blockNumber) <= b),
        };
      }
      const b = Number(r.params[0]);
      const t = Math.round(h0.t + ((h1.t - h0.t) * (b - h0.block)) / (h1.block - h0.block));
      return { result: { number: `0x${b.toString(16)}`, timestamp: `0x${t.toString(16)}` } };
    });
  };

  it('a wider fetch over the same blocks writes nothing twice, and the day keeps its count', async () => {
    const rec = loadGz<Recording>('robinhood-logs-fetch.json.gz');
    const window = rec.args[rec.args.indexOf('--window') + 1] as string;
    const pool = rec.args[rec.args.indexOf('--pool') + 1] as string;
    const [from, to] = window.split('-').map(Number) as [number, number];
    const out = mkdtempSync(join(tmpdir(), 'backfill-'));
    const deps: Deps = {
      rpc: chainOf(rec),
      sleep: async () => {},
      now: quiet(new Date(rec.recordedAt)),
      log: () => {},
    };
    const one = seriesFilters(robinhood, [], { subject: pool, subjectKind: 'v4', kind: 'swaps' });
    const keep = (r: { subject: string }) => r.subject === pool;
    // the sample: the pool's own v4 swaps, pieces of 1,000 blocks
    const first = await fetchLogs(deps, {
      out,
      filters: one,
      scope: pool,
      from,
      to,
      window: 1000,
      keep,
      source: 'replay',
    });
    // then the list-wide filter (`*`), pieces of 100,000 aligned elsewhere: it asks, finds the same logs, drops them
    const wide = seriesFilters(robinhood, [], { kind: 'swaps' }).filter(
      (f) => f.name === 'v4_swap',
    );
    const second = await fetchLogs(deps, {
      out,
      filters: wide,
      scope: '*',
      from: from - 500,
      to,
      window: 100_000,
      keep,
      source: 'replay',
    });
    expect(second.rows).toBe(0);
    expect(second.duplicatesDropped).toBe(first.rows);
    const m = JSON.parse(
      readFileSync(join(out, 'swaps', pool, 'manifest.json'), 'utf8'),
    ) as Manifest;
    expect(Object.values(m.days).reduce((a, d) => a + d.rows, 0)).toBe(first.rows);
    // and now the list-wide record covers the sample's blocks: a third, narrower run asks nothing
    const third = await fetchLogs(deps, {
      out,
      filters: one,
      scope: pool,
      from,
      to,
      window: 1000,
      keep,
      source: 'replay',
    });
    expect([third.pieces, third.queries]).toEqual([0, 0]);
  });

  it('stops between pieces when the budget would be crossed, with what it wrote recorded', async () => {
    const rec = loadGz<Recording>('robinhood-logs-fetch.json.gz');
    const window = rec.args[rec.args.indexOf('--window') + 1] as string;
    const pool = rec.args[rec.args.indexOf('--pool') + 1] as string;
    const [from, to] = window.split('-').map(Number) as [number, number];
    const out = mkdtempSync(join(tmpdir(), 'backfill-'));
    const deps: Deps = {
      rpc: chainOf(rec),
      sleep: async () => {},
      now: quiet(new Date(rec.recordedAt)),
      log: () => {},
    };
    const filters = seriesFilters(robinhood, [], {
      subject: pool,
      subjectKind: 'v4',
      kind: 'swaps',
    });
    // 30 GB used and 26 GB free at the start: one more piece of any size breaks the 25 GB floor
    const guard = budgetGuard(30 * GB, () => 25 * GB + 512);
    let error: unknown = null;
    try {
      await fetchLogs(deps, {
        out,
        filters,
        scope: pool,
        from,
        to,
        window: 1000,
        keep: () => true,
        guard,
        source: 'replay',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BudgetStop);
    const fetched = readFetched(join(out, 'fetched.json'));
    // newest first: the last block alone (no swap, nothing written) passed, then the piece before it wrote
    // rows; after it the next piece could break the floor, so the oldest piece was never asked
    const covered = fetched.covered[`v4_swap:${pool}`] ?? [];
    expect(covered).toEqual([{ from: to - (to % 1000) - 1000, to }]);
    expect(covered.some((c) => c.from <= from)).toBe(false);
  });
});

describe('a day file read back line by line', () => {
  it('yields every line of gzip members appended one after another, empty lines skipped', () => {
    const a = gzipSync('{"block":1,"logIndex":0}\n{"block":1,"logIndex":1}\n');
    const b = gzipSync('{"block":2,"logIndex":0}\n\n{"block":2,"logIndex":3}');
    expect([...gzLines(Buffer.concat([a, b]))]).toEqual([
      '{"block":1,"logIndex":0}',
      '{"block":1,"logIndex":1}',
      '{"block":2,"logIndex":0}',
      '{"block":2,"logIndex":3}',
    ]);
  });
  it('reads a day that unpacks past the longest string V8 makes', () => {
    const line = `{"block":7,"logIndex":0,"pad":"${'x'.repeat(1_000_000)}"}\n`;
    const day = gzipSync(Buffer.concat(Array.from({ length: 560 }, () => Buffer.from(line))));
    let n = 0;
    for (const l of gzLines(day)) n += l.length > 0 ? 1 : 0;
    expect(n).toBe(560);
  }, 60_000);
});

describe('the gates of a whole series', () => {
  const dir = mkdtempSync(join(tmpdir(), 'counts-'));
  const write = (name: string, body: Record<string, unknown>) =>
    writeFileSync(join(dir, name), JSON.stringify(body));
  write('count-a.json', {
    scope: 'mint',
    countedAt: '2026-10-11T03:21:00Z',
    estimate: { gzBytes: 48 * GB },
  });
  write('count-b.json', {
    via: 'authority',
    countedAt: '2026-10-11T03:23:00Z',
    estimate: { gzBytes: 5.6 * GB },
  });
  it('takes the newest count of the same scope, not the newest count', () => {
    expect(newestCount(dir, 'mint')?.file).toMatch(/count-a/);
    expect(newestCount(dir, 'authority')?.file).toMatch(/count-b/);
    expect(newestCount(dir, 'pools-exact')).toBeNull();
  });
  it('refuses a series whose count breaks the budget, and one with no count', () => {
    const free = 63.7 * GB;
    expect(gateWholeSeries({ dir, scope: 'mint', usedBytes: 0, freeBytes: free }).ok).toBe(false);
    expect(gateWholeSeries({ dir, scope: 'authority', usedBytes: 0, freeBytes: free }).ok).toBe(
      true,
    );
    expect(
      gateWholeSeries({ dir, scope: 'pools-exact', usedBytes: 0, freeBytes: free }).reasons[0],
    ).toMatch(/no count/);
  });
  it('a window wider than a sample needs the gate', () => {
    expect(windowNeedsGate('robinhood-logs', 79_494_000, 80_345_980)).toBe(false);
    expect(windowNeedsGate('robinhood-logs', 0, 85_526_375)).toBe(true);
    expect(windowNeedsGate('solana-swaps', 0, 2 * 86_400 - 1)).toBe(false);
    expect(windowNeedsGate('solana-swaps', 0, 2 * 86_400)).toBe(true);
  });
});

describe('a request’s slot before the loop’s minutes', () => {
  it('times out before minute 1, and sits the minutes out when too little is left', () => {
    expect(requestSlot(new Date('2026-10-11T03:15:00Z'), 120_000)).toEqual({
      waitMs: 0,
      timeoutMs: 120_000,
    });
    expect(requestSlot(new Date('2026-10-11T04:00:30Z'), 120_000)).toEqual({
      waitMs: 0,
      timeoutMs: 30_000,
    });
    // 1 s left: wait it and the 14 minutes, then 46 minutes are free
    expect(requestSlot(new Date('2026-10-11T03:00:59Z'), 120_000)).toEqual({
      waitMs: 1_000 + 14 * 60_000,
      timeoutMs: 120_000,
    });
    expect(requestSlot(new Date('2026-10-11T03:05:00Z'), 120_000)).toEqual({
      waitMs: 10 * 60_000,
      timeoutMs: 120_000,
    });
  });
});

describe('the spread of a stratified total', () => {
  it('pairs neighbouring strata, the last three together when odd', () => {
    // (1, 3) and (5, 7): 2·((1−2)² + (3−2)²) + 2·((5−6)² + (7−6)²) = 8
    expect(collapsedSpread([1, 3, 5, 7])).toEqual({ se: Math.sqrt(8), largestShare: 7 / 16 });
    // one group of three: 3/2·((1−3)² + 0 + (5−3)²) = 12
    expect(collapsedSpread([1, 3, 5]).se).toBeCloseTo(Math.sqrt(12), 12);
  });
});

describe('a Solana window: one row per signature, covered only when every transaction was served', () => {
  const sig = (n: number) => `sig${n}`;
  const t0 = 1_791_000_000;
  const fake = (fail: Set<string>) =>
    (async (method: string, params: unknown[]) => {
      if (method === 'getSignaturesForAddress')
        return [1, 2, 3].map((n) => ({
          signature: sig(n),
          slot: 100 - n,
          blockTime: t0 - n * 60,
          err: null,
        }));
      const s = params[0] as string;
      if (fail.has(s)) throw new Error('not served');
      return {
        slot: 1,
        blockTime: t0 - Number(s.slice(3)) * 60,
        meta: { logMessages: [], preTokenBalances: [], postTokenBalances: [] },
        transaction: { signatures: [s], message: { accountKeys: [] } },
      };
    }) as never;
  it('a failed window keeps its rows uncovered; the next run adds only what was missing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sol-'));
    const base = {
      out,
      kind: 'mints' as const,
      address: 'Mint111',
      from: t0 - 3600,
      to: t0,
      parallel: 2,
      source: 'fake',
      now: () => new Date(),
    };
    const a = await fetchWindow({ ...base, rpc: fake(new Set([sig(2)])) });
    expect([a.fetched, a.errors, a.covered]).toEqual([2, 1, false]);
    const mp = join(out, 'mints', 'Mint111', 'manifest.json');
    expect((JSON.parse(readFileSync(mp, 'utf8')) as Manifest).covered).toEqual([]);
    const b = await fetchWindow({ ...base, rpc: fake(new Set()) });
    expect([b.fetched, b.duplicatesDropped, b.covered]).toEqual([3, 2, true]);
    const m = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
    expect(m.rows).toBe(3);
    expect(m.covered).toEqual([{ from: t0 - 3600, to: t0, unit: 'second' }]);
  });
  it('takes no window as whole when its walk ends on an empty page below a cursor, nor a sampled one', async () => {
    // an endpoint that does not hold the cursor answers an empty page, not an error (found 2026-10-13)
    const empty = (async (method: string, params: unknown[]) =>
      method === 'getSignaturesForAddress'
        ? []
        : (fake(new Set()) as never as (m: string, p: unknown[]) => unknown)(
            method,
            params,
          )) as never;
    const out = mkdtempSync(join(tmpdir(), 'sol-'));
    const base = {
      out,
      kind: 'mints' as const,
      address: 'Mint222',
      from: t0 - 3600,
      to: t0,
      parallel: 2,
      source: 'fake',
      now: () => new Date(),
    };
    const a = await fetchWindow({ ...base, rpc: empty, startBefore: 'cursorSig' });
    expect([a.fetched, a.covered]).toEqual([0, false]);
    const b = await fetchWindow({ ...base, address: 'Mint333', rpc: fake(new Set()), perHour: 1 });
    expect(b.covered).toBe(false);
  });
  it('cuts a long window into UTC days, newest first', () => {
    expect(dayPieces(86_400 + 100, 3 * 86_400 + 5)).toEqual([
      { from: 3 * 86_400, to: 3 * 86_400 + 5 },
      { from: 2 * 86_400, to: 3 * 86_400 - 1 },
      { from: 86_400 + 100, to: 2 * 86_400 - 1 },
    ]);
  });
});

describe.skipIf(!existsSync(roundsFx))(
  'Chainlink rounds: a recorded count and fetch, replayed',
  () => {
    it('counts the phases and rounds and fetches one feed with its checks', async () => {
      const rec = loadGz<
        Recording & { feeds: Array<{ feed: string; symbol: string }>; feed: string }
      >('chainlink-rounds.json.gz');
      const deps: Deps = {
        rpc: replayRpc(rec.answers),
        sleep: async () => {},
        now: quiet(new Date(rec.recordedAt)),
        log: () => {},
      };
      const c = await countRounds(deps, robinhood, rec.feeds);
      const f = c.feeds.find((x) => x.feed === rec.feed);
      if (!f) throw new Error('feed');
      expect(f.rounds).toBe(f.phases.reduce((a, p) => a + (p.rounds ?? 0), 0));
      expect(f.phase).toBe(f.phases.length);
      const out = mkdtempSync(join(tmpdir(), 'rounds-'));
      const r = await fetchRounds(deps, robinhood, f, out, 'replay');
      expect(r.rounds).toBe(f.rounds);
      expect(r.checks.find((x) => x.name === 'every_round_answered')?.passed).toBe(true);
      expect(roundIdOf(1, 1n).toString()).toBe('18446744073709551617');
      // the rounds SGOV's feed gave on 2026-10-06 (fixtures/risk/sgov-feed-rounds.json, read one by one by
      // scripts/feeds/refresh-models.ts) are the first rounds of this walk, unchanged
      const old = JSON.parse(readFileSync('fixtures/risk/sgov-feed-rounds.json', 'utf8')) as {
        feed: string;
        rounds: Array<{ id: string; answer: string; updatedAt: number }>;
      };
      if (old.feed === rec.feed) {
        const dir = join(out, rec.feed);
        const rows = readdirSync(dir)
          .filter((x) => x.endsWith('.jsonl.gz'))
          .sort()
          .flatMap((x) =>
            gunzipSync(readFileSync(join(dir, x)))
              .toString()
              .trim()
              .split('\n'),
          )
          .map((l) => JSON.parse(l) as { roundId: string; answer: string; updatedAt: number });
        const byId = new Map(rows.map((r) => [r.roundId, r]));
        for (const o of old.rounds) {
          expect(byId.get(o.id)?.answer).toBe(o.answer);
          expect(byId.get(o.id)?.updatedAt).toBe(o.updatedAt);
        }
      }
    });
  },
);

describe('the anchored estimate on frozen real pages (Step 5b’s 34 pools)', () => {
  type P = [number, number, number | null, number | null, number, number];
  const fx = JSON.parse(readFileSync(join(FX, 'solana-anchored-pages.json'), 'utf8')) as {
    window: { now: string; day90: string };
    pools: Array<{
      address: string;
      exact: { signatures: number; failed: number; from: number; to: number };
      sigs90: number;
      pages: P[];
    }>;
  };
  const pagesOf = (ps: P[]): AnchoredPage[] =>
    ps.map(([t, n, newest, oldest, failed, exhausted]) => ({
      t,
      n,
      newest,
      oldest,
      failed,
      exhausted: exhausted === 1,
    }));
  it('gives again the count file’s 90-day figure of each pool its anchors held, and less where they did not', () => {
    // the count of 2026-10-11 measured a page to its anchor even when its newest signature was later, which
    // inflated those pools' rates (fixed 2026-10-13); every other pool's figure is unchanged
    const now = Date.parse(fx.window.now) / 1000;
    const d90 = Date.parse(fx.window.day90) / 1000;
    let unchanged = 0;
    for (const p of fx.pools) {
      const pages = pagesOf(p.pages);
      const sigs = Math.round(estimateSignatures(pages, d90, now).signatures);
      if (pages.some((pg) => pg.newest !== null && pg.newest > pg.t))
        expect(sigs).toBeLessThan(p.sigs90);
      else {
        expect(sigs).toBe(p.sigs90);
        unchanged++;
      }
    }
    expect(unchanged).toBeGreaterThan(0);
  });
  it('sizes the total of the exact walk to within a few percent, and no single pool', () => {
    let est = 0;
    let exact = 0;
    const ratios: number[] = [];
    for (const p of fx.pools) {
      const e = estimateSignatures(pagesOf(p.pages), p.exact.from, p.exact.to).signatures;
      est += e;
      exact += p.exact.signatures;
      ratios.push(e / p.exact.signatures);
    }
    // measured 2026-10-11: 52.5M estimated against 50.6M walked, while single pools run from 0.01× to 14.5×
    expect(est / exact).toBeGreaterThan(0.95);
    expect(est / exact).toBeLessThan(1.1);
    expect(Math.min(...ratios)).toBeLessThan(0.1);
    expect(Math.max(...ratios)).toBeGreaterThan(10);
  });
});

describe('the command refuses a whole series, or a wide window, without a count that fits', () => {
  const run = (args: string[], out: string) =>
    spawnSync('npx', ['tsx', 'scripts/risk/assets/backfill.ts', ...args], {
      env: { ...process.env, ASSETS_DATA_DIR: out, DOTENV_CONFIG_PATH: '/nonexistent' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  it('no count: refused; an over-budget count of its scope: refused; nothing asked of the network', () => {
    const out = mkdtempSync(join(tmpdir(), 'gate-'));
    // the scope of 2026-10-10 (every pool of the list, whole life): its keys are the ones counted then
    const none = run(['robinhood-logs', '--fetch', '--all', '--scope', 'list'], out);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/--all refused: no count of scope logs/);
    const dir = join(out, 'robinhood', 'robinhood-logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'count-x.json'),
      JSON.stringify({
        scope: 'logs',
        countedAt: '2026-10-11T04:29:00Z',
        estimate: { gzBytes: 38.6 * GB },
      }),
    );
    const over = run(
      ['robinhood-logs', '--fetch', '--window', '0-85526375', '--scope', 'list'],
      out,
    );
    expect(over.status).toBe(1);
    expect(over.stderr).toMatch(
      /a window of 85526376 blocks .* refused: new data 38\.6\d GB would pass the 35 GB budget/,
    );
    // the run is logged, refused
    const runs = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n');
    // (the second may also name the free-disk floor, by this machine's disk)
    expect(
      runs.map((l) => ((JSON.parse(l) as { refused?: string[] }).refused?.length ?? 0) > 0),
    ).toEqual([true, true]);
  }, 120_000);
});

// Gate ASSET-HISTORY-2: the trading series take, by default, the pools of the shelf's tokens (ASSET-SHELF) over
// the last 30 days; the list's scope of 2026-10-10 stays reachable with --scope list, and a count of one scope
// never gates a fetch of another.
describe('the shelf: list rows at or above the floor by their newest volume reading', () => {
  const rows = [
    { address: '0xAAaa', symbol: 'NVDA', status: 'listed' },
    { address: '0xbbbb', symbol: 'USDG', status: 'candidate' },
    { address: '0xcccc', symbol: 'THIN', status: 'candidate' },
    { address: '0xdddd', symbol: 'FUND', status: 'held_out' },
    { address: '0xeeee', symbol: 'COPY', status: 'excluded' },
    { address: '0xffff', symbol: 'GONE', status: 'candidate' },
    { address: '0x1111', symbol: 'NONE', status: 'candidate' },
  ];
  const readings = [
    { address: '0xaaaa', value: 2_500_000, observedAt: '2026-10-12T18:34:21Z' },
    // the newest reading decides: an older one below the floor does not
    { address: '0xaaaa', value: 50, observedAt: '2026-10-11T03:57:08Z' },
    { address: '0xbbbb', value: 100_000, observedAt: '2026-10-12T18:35:38Z' },
    { address: '0xcccc', value: 99_999.99, observedAt: '2026-10-12T18:34:30Z' },
    // a held-out or excluded row never joins, whatever it trades
    { address: '0xdddd', value: 9e9, observedAt: '2026-10-12T18:34:40Z' },
    { address: '0xeeee', value: 9e9, observedAt: '2026-10-12T18:34:41Z' },
    // a passing reading followed by a null one: off the shelf
    { address: '0xffff', value: 5e6, observedAt: '2026-10-11T03:57:08Z' },
    { address: '0xffff', value: null, observedAt: '2026-10-12T18:34:50Z' },
  ];
  const lower = (a: string) => a.toLowerCase();
  it('takes listed and candidate rows at or above $100,000, the newest reading deciding', () => {
    const s = cutShelf(rows, readings, SHELF_FLOOR_USD, lower);
    expect(SHELF_FLOOR_USD).toBe(100_000);
    expect(s.tokens.map((t) => [t.symbol, t.volume24hUsd])).toEqual([
      ['NVDA', 2_500_000],
      ['USDG', 100_000],
    ]);
    // the list's own spelling of the address is kept
    expect(s.tokens[0]?.address).toBe('0xAAaa');
    expect(s.counts).toEqual({
      considered: 5,
      onShelf: 2,
      belowFloor: 1,
      nullReading: 1,
      noReading: 1,
    });
    // the reading the shelf names: the newest readings of the rows considered, oldest to newest
    expect(s.reading).toEqual({ from: '2026-10-12T18:34:21Z', to: '2026-10-12T18:35:38Z' });
    // without the EVM key, 0xAAaa has no reading
    expect(cutShelf(rows, readings).tokens.map((t) => t.symbol)).toEqual(['USDG']);
    expect(cutShelf(rows, readings, 1e9, lower).tokens).toEqual([]);
  });
  it('names a token set the same way whatever its order or case, and differently when a token moves', () => {
    const a = shelfHash(['0xAAaa', '0xbbbb'], lower);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(shelfHash(['0xbbbb', '0xaaaa', '0xaaaa'], lower)).toBe(a);
    expect(shelfHash(['0xaaaa'], lower)).not.toBe(a);
    expect(shelfHash(['0xaaaa', '0xbbbb', '0xcccc'], lower)).not.toBe(a);
    expect(shelfHash(['ab', 'c'])).not.toBe(shelfHash(['a', 'bc']));
  });
});

describe('the trading scope: the shelf’s 30 days by default, the list’s by flag', () => {
  it('defaults to the shelf, 30 days, $100,000; the list keeps its whole life and its 90 days', () => {
    expect(scopeOptions('robinhood-logs', {})).toEqual({
      kind: 'shelf',
      days: 30,
      floorUsd: 100_000,
    });
    expect(scopeOptions('solana-swaps', { floor: '250000' })).toEqual({
      kind: 'shelf',
      days: 30,
      floorUsd: 250_000,
    });
    expect(scopeOptions('robinhood-logs', { scope: 'list' })).toEqual({
      kind: 'list',
      days: null,
      floorUsd: null,
    });
    expect(scopeOptions('solana-swaps', { scope: 'list' })).toEqual({
      kind: 'list',
      days: 90,
      floorUsd: null,
    });
    expect(scopeOptions('solana-swaps', { scope: 'list', days: '30' }).days).toBe(30);
    expect(() => scopeOptions('solana-swaps', { scope: 'all' })).toThrow(/shelf or list/);
    expect(() => scopeOptions('solana-swaps', { days: '0' })).toThrow(/at least 1/);
    expect(() => scopeOptions('solana-swaps', { days: '2.5' })).toThrow(/whole number/);
    expect(() => scopeOptions('robinhood-logs', { scope: 'list', floor: '1' })).toThrow(/--floor/);
  });
  it('keys the list’s scopes as counted on 2026-10-11, and every other scope by its kind, days, floor and tokens', () => {
    const list = { kind: 'list' as const, days: null };
    expect(scopeKey('robinhood-logs', list)).toBe('logs');
    expect(scopeKey('robinhood-logs', { kind: 'list', days: 30 })).toBe('logs-d30');
    expect(scopeKey('solana-swaps', { kind: 'list', days: 90 })).toBe('pools');
    expect(scopeKey('solana-swaps', { kind: 'list', days: 90 }, true)).toBe('pools-exact');
    expect(scopeKey('solana-swaps', { kind: 'list', days: 30 }, true)).toBe('pools-d30-exact');
    const shelf = { kind: 'shelf' as const, days: 30, floorUsd: 100_000, tokensHash: '277c1bfd' };
    expect(scopeKey('robinhood-logs', shelf)).toBe('shelf-d30-f100000-277c1bfd');
    expect(scopeKey('solana-swaps', shelf, true)).toBe('shelf-d30-f100000-277c1bfd-exact');
    expect(scopeKey('solana-swaps', { ...shelf, days: 90 })).toBe('shelf-d90-f100000-277c1bfd');
    expect(() => scopeKey('robinhood-logs', shelf, true)).toThrow(/no exact pass/);
  });
  it('a count of one scope never gates a fetch of another', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoped-counts-'));
    const shelfA = scopeKey('robinhood-logs', {
      kind: 'shelf',
      days: 30,
      floorUsd: 100_000,
      tokensHash: shelfHash(['0xaaaa', '0xbbbb']),
    });
    const shelfB = scopeKey('robinhood-logs', {
      kind: 'shelf',
      days: 30,
      floorUsd: 100_000,
      tokensHash: shelfHash(['0xaaaa', '0xbbbb', '0xcccc']),
    });
    // a small count of the shelf A and an over-budget count of the list's whole life
    writeFileSync(
      join(dir, 'count-shelf.json'),
      JSON.stringify({
        scope: shelfA,
        countedAt: '2026-10-12T19:00:00Z',
        estimate: { gzBytes: 2 * GB },
      }),
    );
    writeFileSync(
      join(dir, 'count-logs.json'),
      JSON.stringify({
        scope: 'logs',
        countedAt: '2026-10-11T04:29:00Z',
        estimate: { gzBytes: 38.3 * GB },
      }),
    );
    const g = (scope: string) =>
      gateWholeSeries({ dir, scope, usedBytes: 0, freeBytes: 63.7 * GB });
    expect(g(shelfA).ok).toBe(true);
    expect(g('logs').ok).toBe(false);
    // another shelf (one token more), the shelf at 90 days, the list at 30 days: no count of theirs
    expect(g(shelfB).reasons[0]).toMatch(/no count of scope shelf-d30-f100000-/);
    expect(g(shelfA.replace('-d30-', '-d90-')).reasons[0]).toMatch(/no count/);
    expect(g('logs-d30').reasons[0]).toMatch(/no count/);
  });
});

describe('a wide window stays inside the scope its count covers', () => {
  it('refuses a window that starts before the scope, and holds one inside it or any under a whole-life scope', () => {
    const key = 'shelf-d30-f100000-3d63aab8';
    expect(() => requireWindowInScope(1_000, 5_000, 'a window', key)).toThrow(
      /before the scope shelf-d30-f100000-3d63aab8 begins \(5000\)/,
    );
    expect(() => requireWindowInScope(5_000, 5_000, 'a window', key)).not.toThrow();
    expect(() => requireWindowInScope(0, null, 'a window', 'logs')).not.toThrow();
  });
});

describe('the start of a 30-day window: the block nearest a time', () => {
  it('finds it by the secant on block times within a minute, in a few reads', async () => {
    // a chain whose blocks come every 0.1 s, then every 0.08 s after block 60M; head 85M
    const timeOf = async (b: number) =>
      1_750_000_000 + Math.min(b, 60_000_000) * 0.1 + Math.max(0, b - 60_000_000) * 0.08;
    const head = 85_000_000;
    const headT = await timeOf(head);
    const t = headT - 30 * 86_400;
    const at = await blockAtTime(timeOf, head, t, { blocksPerDay: 855_000 });
    expect(Math.abs(at.time - t)).toBeLessThanOrEqual(60);
    expect(at.reads).toBeLessThanOrEqual(6);
    // a time at or after the head is the head; a time before block 0 is block 0
    expect((await blockAtTime(timeOf, head, headT + 5, { blocksPerDay: 855_000 })).block).toBe(
      head,
    );
    expect((await blockAtTime(timeOf, head, 0, { blocksPerDay: 855_000 })).block).toBe(0);
  });
});

describe('the command’s default scope is the shelf’s, and its gate is the shelf’s count', () => {
  const run = (args: string[], out: string) =>
    spawnSync('npx', ['tsx', 'scripts/risk/assets/backfill.ts', ...args], {
      env: { ...process.env, ASSETS_DATA_DIR: out, DOTENV_CONFIG_PATH: '/nonexistent' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  it('cuts the shelf from the list and the readings, and refuses without a count of that shelf', () => {
    const out = mkdtempSync(join(tmpdir(), 'shelf-gate-'));
    const list = join(out, 'list.json');
    writeFileSync(
      list,
      JSON.stringify({
        assets: [
          { address: '0xAAaa', symbol: 'NVDA', status: 'listed' },
          { address: '0xbbbb', symbol: 'THIN', status: 'candidate' },
        ],
      }),
    );
    const readings = join(out, 'readings.json');
    writeFileSync(
      readings,
      JSON.stringify([
        { chain: 'robinhood', address: '0xaaaa', value: 2e6, observedAt: '2026-10-12T18:34:21Z' },
        { chain: 'robinhood', address: '0xbbbb', value: 5e4, observedAt: '2026-10-12T18:35:38Z' },
        // another chain's reading is not this chain's
        { chain: 'solana', address: '0xbbbb', value: 5e9, observedAt: '2026-10-12T18:35:00Z' },
      ]),
    );
    const key = `shelf-d30-f100000-${shelfHash(['0xaaaa'])}`;
    const base = ['robinhood-logs', '--list', list, '--readings', readings];
    const none = run([...base, '--fetch', '--all'], out);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain(`--all refused: no count of scope ${key}`);
    // a count of the list's scope that fits does not open the shelf's gate
    const dir = join(out, 'robinhood', 'robinhood-logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'count-list.json'),
      JSON.stringify({
        scope: 'logs',
        countedAt: '2026-10-12T19:00:00Z',
        estimate: { gzBytes: 1 },
      }),
    );
    const other = run([...base, '--fetch', '--window', '0-85526375'], out);
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(
      new RegExp(`a window of 85526376 blocks .* refused: no count of scope ${key}`),
    );
    // a higher floor is another shelf: here an empty one, refused before anything is asked
    const empty = run([...base, '--fetch', '--all', '--floor', '1e9'], out);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toMatch(/the shelf of robinhood is empty/);
  }, 180_000);
});
