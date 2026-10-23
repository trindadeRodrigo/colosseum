// The hourly hosted bars job of Robinhood Chain (gate HOURLY-BARS): its own walk of the last hours
// (scripts/risk-evm/recent-walk.ts), the complete-hour cut, and the bars it builds from the walk read as current by
// the lookups' coverage rule. A chain in memory answers the requests; no test calls the network.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barCoverage } from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { readRobinhood } from '../scripts/risk/assets/bars-read';
import { barRows } from '../scripts/risk/assets/bars-rows';
import { newestTokenHour, rowsInHours } from '../scripts/risk/assets/lookup-rows';
import {
  HOSTED_WRITE_WINDOW,
  outsideWriteWindow,
  parseWriteWindow,
} from '../scripts/risk/assets/write-window';
import { TOPIC } from '../scripts/risk-evm/abi';
import { CHAINS, type ChainConfig } from '../scripts/risk-evm/config';
import type { CutRow } from '../scripts/risk-evm/cut';
import { type HistoryPool, historyPools, type SwapRow } from '../scripts/risk-evm/history';
import type { Cursor } from '../scripts/risk-evm/history-run';
import {
  daysToDelete,
  dropPartialLastLine,
  headerBlocks,
  hoursToWrite,
  RECENT_CONTEXT_HOURS,
  RECENT_KEEP_HOURS,
  readWrittenThrough,
  runRecentWalk,
  writableHours,
  writeWrittenThrough,
} from '../scripts/risk-evm/recent-walk';
import type { Rpc, RpcReply, RpcRequest } from '../scripts/risk-evm/rpc';

const rh = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const H = 3_600;
/** The chain in memory: a block every ten seconds from T0, a swap of the one pool every 60 blocks (ten minutes). */
const T0 = Date.parse('2026-10-19T00:00:00Z') / 1000;
const BLOCK_S = 10;
const SWAP_EVERY = 60;
const STOCK = '0x0000000000000000000000000000000000000a11';
const POOL = '0x00000000000000000000000000000000000000b1';
const DOLLAR = rh.dollar.address.toLowerCase();
const timeOf = (block: number) => T0 + BLOCK_S * block;
const blockAt = (t: number) => Math.floor((t - T0) / BLOCK_S);
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0');
const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
// $100 a share: token 1 (USDG, 6 decimals) per token 0 (the stock, 18 decimals) = 100 × 10^(6-18)
const SQRT = BigInt(Math.round(Math.sqrt(100 * 1e-12) * 2 ** 96));

/** The Swap log of block b: a sale of one share for 100 USDG. */
const swapLog = (b: number) => ({
  address: POOL,
  topics: [
    TOPIC.v3Swap,
    pad('0x00000000000000000000000000000000000000c1'),
    pad('0x00000000000000000000000000000000000000c2'),
  ],
  data: `0x${[10n ** 18n, -100n * 10n ** 6n, SQRT, 10n ** 20n, 0n].map(word).join('')}`,
  blockNumber: hex(b),
  transactionHash: pad(hex(b)),
  logIndex: '0x0',
});

function chainRpc(state: { head: number; failLogs?: boolean }) {
  let httpRequests = 0;
  let rpcCalls = 0;
  const answer = (r: RpcRequest): RpcReply => {
    rpcCalls++;
    if (r.method === 'eth_blockNumber') return { result: hex(state.head) };
    if (r.method === 'eth_getBlockByNumber') {
      const b = Number(BigInt(r.params[0] as string));
      return b > state.head ? { result: null } : { result: { timestamp: hex(timeOf(b)) } };
    }
    if (r.method === 'eth_getLogs') {
      if (state.failLogs) return { error: { code: -32000, message: 'execution reverted' } };
      const q = r.params[0] as { address: string[]; fromBlock: string; toBlock: string };
      const a = Number(BigInt(q.fromBlock));
      const z = Math.min(Number(BigInt(q.toBlock)), state.head);
      const logs = [];
      for (let b = Math.ceil(a / SWAP_EVERY) * SWAP_EVERY; b <= z; b += SWAP_EVERY)
        if (q.address.includes(POOL)) logs.push(swapLog(b));
      return { result: logs };
    }
    return { error: { message: `unexpected ${r.method}` } };
  };
  const rpc: Rpc = {
    batch: async (rs) => {
      httpRequests++;
      return rs.map(answer);
    },
    call: async <T>(method: string, params: unknown[]) => {
      httpRequests++;
      const r = answer({ method, params });
      if (r.error) throw new Error(r.error.message);
      return r.result as T;
    },
    stats: () => ({ httpRequests, rpcCalls }),
  };
  return rpc;
}

const cut: { chain: string; pools: CutRow[] } = {
  chain: 'robinhood',
  pools: [
    {
      address: POOL,
      asset: STOCK,
      tvlUsd: 1_000_000,
      symbol: 'TEST',
      other: DOLLAR,
      otherSymbol: 'USDG',
      otherIsStock: false,
      kind: 'cl',
      venue: 'uniswap-v3',
      reachable: true,
      tokenUsd: null,
      tvlMethod: null,
      tvlReason: null,
    } as unknown as CutRow,
  ],
};
const pools: HistoryPool[] = historyPools(cut, rh);
const OPTS = { window: 2_000, headerStep: 500, pauseMs: 0 };

async function walk(root: string, state: { head: number; failLogs?: boolean }, at: number) {
  const rpc = chainRpc(state);
  const events: Record<string, unknown>[] = [];
  const summary = await runRecentWalk(
    { rpc, sleep: async () => {}, log: (e) => events.push(e), now: () => new Date(at * 1000) },
    rh,
    pools,
    root,
    OPTS,
  );
  return { summary, events };
}
const cursorOf = (root: string) =>
  JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as Cursor;
const swapsIn = (root: string): SwapRow[] => {
  const d = join(root, 'swaps', POOL);
  return existsSync(d)
    ? readdirSync(d)
        .sort()
        .flatMap((f) =>
          readFileSync(join(d, f), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as SwapRow),
        )
        // the walk goes newest window first, as the loop's does: a day file is not in block order
        .sort((a, b) => a.block - b.block)
    : [];
};

describe('the hourly walk of Robinhood Chain (HOURLY-BARS)', () => {
  it('starts a fresh folder RECENT_KEEP_HOURS back from the head and holds every swap from there on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recent-walk-'));
    const headT = T0 + 3 * 24 * H + 18 * 60; // Oct 22, 00:18
    const state = { head: blockAt(headT) };
    const { summary } = await walk(root, state, headT);
    const c = cursorOf(root);
    expect(summary.mode).toBe('fresh');
    expect(c.headT).toBe(headT);
    expect(c.complete).toBe(true);
    // the span starts at the newest header at or before 30 hours back
    expect(c.fromT).toBeLessThanOrEqual(headT - RECENT_KEEP_HOURS * H);
    expect(c.fromT).toBeGreaterThan(headT - RECENT_KEEP_HOURS * H - 500 * BLOCK_S);
    const swaps = swapsIn(root);
    const expected = [];
    for (let b = Math.ceil(c.from / SWAP_EVERY) * SWAP_EVERY; b <= state.head; b += SWAP_EVERY)
      expected.push(b);
    expect(swaps.map((s) => s.block)).toEqual(expected);
    // each swap's time from the headers, exact here (the chain is linear)
    expect(swaps.every((s) => s.t === timeOf(s.block))).toBe(true);
    expect(summary.rpcCalls).toBeGreaterThan(0);
    expect(existsSync(join(root, 'pending'))).toBe(false);
  });

  it('an hour later adds only the blocks after its head, and deletes the days that ended 30 hours before', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recent-walk-'));
    const first = T0 + 3 * 24 * H + 18 * 60;
    const state = { head: blockAt(first) };
    await walk(root, state, first);
    const before = cursorOf(root);
    const n0 = swapsIn(root).length;
    // ten hours on: Oct 20 ended more than 30 hours before 10:18 on Oct 22? No: it ends at Oct 21 00:00, 34 h before
    const next = first + 10 * H;
    state.head = blockAt(next);
    const { summary } = await walk(root, state, next);
    const c = cursorOf(root);
    expect(summary.mode).toBe('added');
    expect(summary.fromBlock).toBe(before.head + 1);
    expect(summary.toBlock).toBe(state.head);
    expect(summary.daysDeleted).toBe(1);
    expect(readdirSync(join(root, 'swaps', POOL)).sort()).toEqual([
      '2026-10-21.jsonl',
      '2026-10-22.jsonl',
    ]);
    // the span now starts at the oldest day kept, and every swap from it on is there once
    expect(c.fromT).toBe(Date.parse('2026-10-21T00:00:00Z') / 1000);
    const blocks = swapsIn(root).map((s) => s.block);
    expect(new Set(blocks).size).toBe(blocks.length);
    expect(blocks[0]).toBe(Math.ceil(blockAt(c.fromT) / SWAP_EVERY) * SWAP_EVERY);
    expect(blocks.at(-1)).toBe(Math.floor(state.head / SWAP_EVERY) * SWAP_EVERY);
    expect(blocks.length).toBeGreaterThan(n0 - 200);
    // one hour of blocks is 360 at ten seconds: an hourly run asks a handful of requests
    const hourly = { head: state.head + 360 };
    const r = await walk(root, hourly, next + H);
    expect(r.summary.mode).toBe('added');
    expect(r.summary.blocks).toBe(360);
    expect(r.summary.rpcCalls).toBeLessThanOrEqual(6);
  });

  it('a walk that stops leaves the files and the cursor as they were; the next run walks the same blocks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recent-walk-'));
    const first = T0 + 3 * 24 * H;
    const state: { head: number; failLogs?: boolean } = { head: blockAt(first) };
    await walk(root, state, first);
    const cursor = readFileSync(join(root, 'cursor.json'), 'utf8');
    const files = swapsIn(root);
    state.head += 720;
    state.failLogs = true;
    await expect(walk(root, state, first + 2 * H)).rejects.toThrow(/refused/);
    expect(readFileSync(join(root, 'cursor.json'), 'utf8')).toBe(cursor);
    expect(swapsIn(root)).toEqual(files);
    state.failLogs = false;
    const { summary } = await walk(root, state, first + 2 * H);
    expect(summary.fromBlock).toBe(JSON.parse(cursor).head + 1);
    expect(swapsIn(root).length).toBe(files.length + 720 / SWAP_EVERY);
  });

  it('a folder whose head is older than RECENT_KEEP_HOURS is started again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recent-walk-'));
    const first = T0 + 2 * 24 * H;
    const state = { head: blockAt(first) };
    await walk(root, state, first);
    state.head = blockAt(first + (RECENT_KEEP_HOURS + 1) * H);
    const { summary } = await walk(root, state, first + (RECENT_KEEP_HOURS + 1) * H);
    expect(summary.mode).toBe('fresh');
    expect(swapsIn(root)[0]?.t).toBeGreaterThanOrEqual(cursorOf(root).fromT);
  });

  it('the header blocks and the days to delete', () => {
    expect(headerBlocks(1000, 2600, 500)).toEqual([1500, 2000, 2500]);
    expect(headerBlocks(1000, 1400, 500)).toEqual([]);
    const head = Date.parse('2026-10-22T10:00:00Z') / 1000;
    expect(daysToDelete(['2026-10-20', '2026-10-21', '2026-10-22'], 0, head, 30)).toEqual({
      deleted: ['2026-10-20'],
      fromT: Date.parse('2026-10-21T00:00:00Z') / 1000,
    });
    // Oct 21 ends at Oct 22 00:00: 30 hours before Oct 23 06:00 exactly, so deleted then and not a second before
    const at = Date.parse('2026-10-23T06:00:00Z') / 1000;
    expect(daysToDelete(['2026-10-21'], 0, at - 1, 30).deleted).toEqual([]);
    expect(daysToDelete(['2026-10-21'], 0, at, 30).deleted).toEqual(['2026-10-21']);
  });
});

describe('the hours the hourly job writes', () => {
  it('complete hours only, after the first RECENT_CONTEXT_HOURS whole hours of the span', () => {
    const fromT = Date.parse('2026-10-21T04:47:00Z') / 1000;
    const headT = Date.parse('2026-10-22T10:18:00Z') / 1000;
    const w = writableHours({ fromT, headT });
    expect(new Date(w.from * 1000).toISOString()).toBe(
      `2026-10-21T${String(5 + RECENT_CONTEXT_HOURS).padStart(2, '0')}:00:00.000Z`,
    );
    // the hour of the head (10:00 to 11:00) is not complete: the last hour written is 09:00
    expect(new Date(w.to * 1000).toISOString()).toBe('2026-10-22T10:00:00.000Z');
    // a head exactly on the hour completes the hour before it, never its own
    expect(writableHours({ fromT, headT: Date.parse('2026-10-22T10:00:00Z') / 1000 }).to).toBe(
      Date.parse('2026-10-22T10:00:00Z') / 1000,
    );
    // the fill from the loop's rewalk keeps every whole hour (no context)
    expect(writableHours({ fromT, headT }, 0).from).toBe(Date.parse('2026-10-21T05:00:00Z') / 1000);
  });

  it('the bars built from the walk, cut to complete hours, read as current at HH:18 (barCoverage)', async () => {
    const evm = mkdtempSync(join(tmpdir(), 'recent-bars-'));
    const root = join(evm, 'walk');
    mkdirSync(root);
    writeFileSync(join(evm, 'cut-test.json'), JSON.stringify(cut));
    writeFileSync(
      join(evm, 'universe-robinhood-20261021T0000.json'),
      JSON.stringify({ tokens: [{ address: STOCK, decimals: 18 }] }),
    );
    const listDir = join(evm, 'lists');
    mkdirSync(listDir);
    writeFileSync(
      join(listDir, 'robinhood.json'),
      JSON.stringify({ inputs: { cut: 'cut-test.json' } }),
    );
    const headT = Date.parse('2026-10-22T10:18:00Z') / 1000;
    await walk(root, { head: blockAt(headT) }, headT);
    const read = await readRobinhood(evm, listDir, { historyRoot: root });
    expect(read.span.headT).toBe(headT);
    const { rows } = barRows(read, 'robinhood', false);
    const w = writableHours(read.span);
    // what the job writes: bars.ts's own functions, on a folder no run has written from
    const written = rowsInHours(rows, hoursToWrite(read.span, null, RECENT_CONTEXT_HOURS)).filter(
      (r) => r.pool === 'asset',
    );
    expect(newestTokenHour(written)).toBe(Date.parse('2026-10-22T09:00:00Z'));
    // the newest bar is hour HH-1, priced from the swaps at $100, and its source names the job's own folder
    const newest = written.at(-1) as (typeof written)[number];
    expect((newest.hour as Date).toISOString()).toBe('2026-10-22T09:00:00.000Z');
    expect(newest?.closeUsd).toBeCloseTo(100, 6);
    expect(newest?.quoteUsdMethod).toBe('usdg_at_par');
    expect(rows.find((r) => r.pool === POOL)?.source).toContain(`${root}/swaps/${POOL}`);
    // the head's own hour was built but is not written
    expect(rows.some((r) => (r.hour as Date).toISOString() === '2026-10-22T10:00:00.000Z')).toBe(
      true,
    );
    expect(written.some((r) => (r.hour as Date).toISOString() === '2026-10-22T10:00:00.000Z')).toBe(
      false,
    );
    // what the lookups read at 10:18: the hourly bars and an older one before the window (the copied backfill)
    const now = new Date(headT * 1000);
    const bars = written.map((r) => ({ hour: (r.hour as Date).toISOString() }));
    const hours = bars.map((b) => b.hour);
    const before = '2026-10-01T00:00:00.000Z';
    // the walk's writable hours reach back past the 24-hour window's first hour (11:00 yesterday)
    expect(w.from).toBeLessThanOrEqual(Date.parse('2026-10-21T11:00:00Z') / 1000);
    expect(barCoverage(bars, before, '24h', now, hours)).toEqual({
      covered: true,
      collectedHours: 23,
      missingHours: 0,
    });
    // one more hour short (the bars stop at HH-3, as a daily job's would by evening): not covered
    const short = bars.filter((b) => b.hour < '2026-10-22T08:00:00.000Z');
    const late = new Date((headT + 0) * 1000);
    expect(
      barCoverage(
        short,
        before,
        '24h',
        new Date(late.getTime() + 30 * 60_000),
        hours.filter((h) => h < '2026-10-22T08:00:00.000Z'),
      ),
    ).toMatchObject({ covered: false });
  });
});

describe('what each hourly run writes, and when (HOURLY-BARS)', () => {
  const span = {
    fromT: Date.parse('2026-10-21T04:47:00Z') / 1000,
    headT: Date.parse('2026-10-22T10:18:00Z') / 1000,
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  it('hoursToWrite: the complete hours after the context, none at or before the newest written', () => {
    const first = hoursToWrite(span, null, RECENT_CONTEXT_HOURS);
    expect([iso(first.from), iso(first.to)]).toEqual([
      '2026-10-21T11:00:00.000Z',
      '2026-10-22T10:00:00.000Z',
    ]);
    // the run an hour before wrote up to 08:00: this one writes 09:00 alone
    const next = hoursToWrite(span, Date.parse('2026-10-22T08:00:00Z'), RECENT_CONTEXT_HOURS);
    expect([iso(next.from), iso(next.to)]).toEqual([
      '2026-10-22T09:00:00.000Z',
      '2026-10-22T10:00:00.000Z',
    ]);
    // nothing new: an empty span
    const none = hoursToWrite(span, Date.parse('2026-10-22T09:00:00Z'), RECENT_CONTEXT_HOURS);
    expect(none.from).toBe(none.to);
    // a written mark older than the context (a fresh folder after a long sleep) does not reach back past it
    expect(hoursToWrite(span, Date.parse('2026-10-01T00:00:00Z'), RECENT_CONTEXT_HOURS).from).toBe(
      first.from,
    );
    // the fill from the loop's rewalk: no context
    expect(iso(hoursToWrite(span, null, 0).from)).toBe('2026-10-21T05:00:00.000Z');
  });

  it('the written mark: read back as written, whole (no temporary file left)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recent-written-'));
    expect(readWrittenThrough(root)).toBeNull();
    writeWrittenThrough(root, Date.parse('2026-10-22T09:00:00Z'));
    expect(readWrittenThrough(root)).toBe(Date.parse('2026-10-22T09:00:00Z'));
    expect(readdirSync(root)).toEqual(['written.json']);
    const rows = [
      { pool: 'asset', hour: new Date('2026-10-22T08:00:00Z') },
      { pool: '0xpool', hour: new Date('2026-10-22T09:00:00Z') },
    ] as never[];
    // a pool row of a later hour is not the mark: the token rows are what the lookups read
    expect(newestTokenHour(rows)).toBe(Date.parse('2026-10-22T08:00:00Z'));
    expect(newestTokenHour([])).toBeNull();
  });

  it('a scheduled run touches the database only inside :10 to :25 UTC of the hour it started in', () => {
    const at = (hm: string) => Date.parse(`2026-10-22T${hm}:00Z`);
    const w = parseWriteWindow('10-25');
    expect(w).toEqual(HOSTED_WRITE_WINDOW);
    const out = (start: string, now: string) =>
      outsideWriteWindow(at(start), at(now), HOSTED_WRITE_WINDOW);
    // both edges: :10 is in, a second before it is not; :25 is out, a second before it is in
    expect(outsideWriteWindow(at('10:09'), at('10:09') + 59_000, HOSTED_WRITE_WINDOW)).toBe(true);
    expect(out('10:09', '10:10')).toBe(false);
    expect(out('10:18', '10:24')).toBe(false);
    expect(outsideWriteWindow(at('10:18'), at('10:25') - 1_000, HOSTED_WRITE_WINDOW)).toBe(false);
    expect(out('10:18', '10:25')).toBe(true);
    // a run started late (a Mac waking at 10:40), or one that ran into the next hour's window, touches nothing
    expect(out('10:40', '10:41')).toBe(true);
    expect(out('10:18', '11:12')).toBe(true);
    expect(out('10:02', '10:05')).toBe(true);
    for (const bad of ['25-10', '10-61', '10', 'a-b', undefined])
      expect(parseWriteWindow(bad)).toBeNull();
  });

  it('a day file cut short by a crash loses its half line, and the next walk reads every swap once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recent-walk-'));
    const first = T0 + 3 * 24 * H;
    const state = { head: blockAt(first) };
    await walk(root, state, first);
    const before = swapsIn(root).length;
    const day = join(
      root,
      'swaps',
      POOL,
      readdirSync(join(root, 'swaps', POOL))
        .sort()
        .at(-1) as string,
    );
    appendFileSync(day, '{"pool":"0x00000000000000000000000000000000000000b1","kind":"cl","blo');
    state.head += 360;
    const { summary } = await walk(root, state, first + H);
    expect(summary.repaired).toBe(1);
    const swaps = swapsIn(root);
    expect(swaps.length).toBe(before + 360 / SWAP_EVERY);
    expect(new Set(swaps.map((s) => s.block)).size).toBe(swaps.length);
    expect(readdirSync(root).filter((f) => f.includes('.tmp'))).toEqual([]);
    // the repair itself: a file ending in a newline is left alone
    expect(dropPartialLastLine(day)).toBe(0);
  });
});
