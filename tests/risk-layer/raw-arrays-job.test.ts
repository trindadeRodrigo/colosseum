import { type ChildProcess, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRecorded } from '../../apps/api/src/pool-recorded';
import { captureBytes, loadCapture } from '../../scripts/risk/lib-split';

// PLAN-UNIVERSE RU.12 — the raw-arrays job itself (scripts/risk/raw-arrays/job.ts), run as the process launchd runs,
// against a folder that stands in for the collector's home and a server on this machine that stands in for the RPC:
// it answers getMultipleAccounts from the mainnet accounts frozen in fixtures/risk/raw-arrays. Nothing leaves the
// machine. What is proven here is what the functions of lib.ts cannot show: the files, the run's line, the exit code,
// and that the collector's home is only ever read.
const c = loadCapture('fixtures/risk/raw-arrays/hoodx-strcx-20261007T0431.json.gz');
const DZND = 'DznDQ6YVmgtZAvwZ4ui6k9MNun9uaozyVFFsiAeAs9f'; // HOODx/SOL, Raydium CLMM
const P48D = '48dhPm83sXfnRMxKRfv2YuE45DPqrhwPMvGrnTLufvFf'; // HOODx/USDC, Orca
// A pool that holds far more than the eleven together, so it alone is the collector's 80% set: it is left to the
// collector, and the eleven real pools are read. The chain has no such account.
const BIG = 'Co11ector1111111111111111111111111111111111';

const root = mkdtempSync(join(tmpdir(), 'raw-arrays-job-'));
const home = join(root, 'home');
const hourOf = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
};
let url = '';
let calls = 0;
// what the stand-in does differently: accounts it answers otherwise (null: not on the chain), keys whose batch it
// answers with an error (as many times as the number says), and a wait before it answers
let patch: Record<string, string | null> = {};
let errorsFor = new Map<string, number>();
let waitMs = 0;
let onRequest: (() => void) | null = null;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    const { id, method, params } = JSON.parse(body) as {
      id: number;
      method: string;
      params: [string[]];
    };
    calls++;
    onRequest?.();
    const answer = (o: object) =>
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...o }));
      }, waitMs);
    const hit = params[0].find((k) => (errorsFor.get(k) ?? 0) > 0);
    if (method !== 'getMultipleAccounts' || hit) {
      if (hit) errorsFor.set(hit, (errorsFor.get(hit) as number) - 1);
      answer({ error: { code: -32005, message: 'node is behind' } });
      return;
    }
    const value = params[0].map((k) => {
      const data = k in patch ? patch[k] : c.accounts[k];
      return data ? { owner: '11111111111111111111111111111111', data: [data, 'base64'] } : null;
    });
    answer({ result: { context: { slot: 1000 + calls }, value } });
  });
});

beforeAll(async () => {
  // the collector's own file of its pool, three hours before these tests run
  const then = hourOf(Date.now() - 3 * 3_600_000);
  mkdirSync(join(home, 'raw', then.day, then.hour), { recursive: true });
  const big = { ...c.direct[0], address: BIG, venue: 'raydium_clmm', tvlUsd: 1e9 };
  writeFileSync(
    join(home, 'registry.json'),
    JSON.stringify({
      fetchedAt: c.registry.fetchedAt,
      methodVersion: 'registry-0.1',
      pools: [big, ...c.direct],
    }),
  );
  writeFileSync(
    join(home, 'cache.json'),
    JSON.stringify({
      children: c.children,
      childrenAt: Object.fromEntries(c.direct.map((p) => [p.address, '2026-10-07T04:00:00.000Z'])),
    }),
  );
  writeFileSync(
    join(home, 'raw', then.day, then.hour, `${BIG}.json.gz`),
    'the collector’s own file',
  );
  writeFileSync(join(home, 'runs.jsonl'), '{"kind":"run","methodVersion":"pools-0.1"}\n');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

type Row = Record<string, unknown> & {
  kind: string;
  error?: string;
  stage?: string;
  folder: string;
  pools: Record<string, number> | null;
  notWritten: Array<{ pool: string; reason: string; detail: string | null }>;
  leftOutBySetting: Array<{ pool: string }>;
  everyPoolNotWritten?: { reason: string; stage: string; pools: number };
  collector: {
    pools: number;
    readHereToo: boolean;
    perPool: Array<{ pool: string; hoursSinceNewest: number | null; filesInNewest24: number }>;
  };
  rpc: { calls: number; batches: number; batchRetries: number; batchesFailed: number };
  bytes: { written: number };
  accounted: boolean;
};
// The script as one node process (the loader in the same process), so a signal sent to it reaches the job.
const node = (
  script: string,
  args: string[],
  env: Record<string, string | undefined>,
  started?: (child: ChildProcess) => void,
) =>
  new Promise<{ code: number; rows: Row[]; out: string }>((done) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(base))
      if (k.startsWith('RISK_') || k === 'SOLANA_RPC_URL') delete base[k];
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', script, ...args],
      // no .env of a checkout is read: the settings are the ones given here
      { env: { ...base, RISK_HOME: home, DOTENV_CONFIG_PATH: join(root, 'no.env'), ...env } },
      (err, stdout) => {
        const rows = stdout
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as Row);
        const code = (err as { code?: number | string } | null)?.code;
        done({ code: err ? (typeof code === 'number' ? code : 1) : 0, rows, out: stdout });
      },
    );
    started?.(child);
  });
const job = (env: Record<string, string | undefined>, args: string[] = []) =>
  node('scripts/risk/raw-arrays/job.ts', args, env);
const check = (dir: string, capture: string) =>
  node('scripts/risk/raw-arrays/check.ts', [dir, capture], {});

// every file under the stand-in home with its hash: what must be the same after any run
const homeState = () => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(home);
  return out;
};
const lines = (dir: string) =>
  readFileSync(join(dir, 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);

describe('raw arrays: one run of the job', { timeout: 60_000 }, () => {
  it('writes one file per pool into its own folder, leaves one line, and only reads the collector’s home', async () => {
    const dir = join(root, 'run-whole');
    const capture = join(root, 'whole.json.gz');
    const before = homeState();
    calls = 0;
    const r = await job({
      SOLANA_RPC_URL: url,
      RISK_RAW_ARRAYS_DIR: dir,
      RISK_RAW_ARRAYS_CAPTURE: capture,
    });
    expect(r.code).toBe(0);
    expect(homeState()).toEqual(before);
    const row = r.rows[0] as Row;
    expect(r.rows).toHaveLength(1);
    expect(row.kind).toBe('raw-arrays-run');
    expect(row.pools).toEqual({
      ofTracked: 12,
      leftToCollector: 1,
      leftOutBySetting: 0,
      read: 11,
      written: 11,
      notWritten: 0,
    });
    expect(row.accounted).toBe(true);
    expect(row.notWritten).toEqual([]);
    // pool accounts in one call, the fee configs and the arrays in another
    expect(row.rpc).toMatchObject({ calls: 2, batches: 2, batchRetries: 0, batchesFailed: 0 });
    expect(calls).toBe(2);
    expect(row.settings).toEqual({ everyPool: false, skipExitPaths: [] });
    expect(row.capture).toEqual({ file: capture });
    // the collector's pool: not read here; its newest file is three hours old, one in its newest 24 hour folders
    expect(row.collector).toMatchObject({ pools: 1, readHereToo: false, hourFoldersLooked: 1 });
    expect(row.collector.perPool).toHaveLength(1);
    expect(row.collector.perPool[0]).toMatchObject({ pool: BIG, filesInNewest24: 1 });
    expect([3, 4]).toContain(row.collector.perPool[0]?.hoursSinceNewest);
    expect(row.provenance).toBe('live');
    expect(row.methodVersion).toBe('raw-arrays-0.1');
    // the folder is <dir>/<day>/<hour>, and holds the eleven files and nothing else
    expect(row.folder.startsWith(dir) || row.folder.startsWith(`/private${dir}`)).toBe(true);
    const files = readdirSync(row.folder);
    expect(files.sort()).toEqual(c.direct.map((p) => `${p.address}.json.gz`).sort());
    expect(files.reduce((s, f) => s + statSync(join(row.folder, f)).size, 0)).toBe(
      row.bytes.written,
    );
    // each is read by the API's reader and holds the bytes the chain returned, with its own two slots
    for (const p of c.direct) {
      const rec = readRecorded(join(row.folder, `${p.address}.json.gz`));
      expect(rec?.pool).toBe(p.address);
      expect(Buffer.from(rec?.head as Uint8Array)).toEqual(
        Buffer.from(captureBytes(c, p.address) as Uint8Array),
      );
      expect(rec?.kids).toHaveLength((c.children[p.address] as string[]).length);
      expect(rec?.slot).toBe(1002);
    }
    // the run's line is the one printed, and the only one
    expect(readdirSync(dir).sort()).toEqual([row.folder.slice(-13, -3), 'runs.jsonl']);
    expect(lines(dir)).toEqual([row]);
    // the capture it saved gives the same bytes and the same simulators as its files
    const ok = await check(dir, capture);
    expect(ok.code).toBe(0);
    expect(ok.rows[0]).toMatchObject({
      pools: 11,
      files: 11,
      compared: 11,
      different: [],
      same: true,
    });
  });

  it('the check sees a file that is not what the chain returned, even when it decodes the same', async () => {
    const dir = join(root, 'run-tamper');
    const capture = join(root, 'tamper.json.gz');
    const r = await job({
      SOLANA_RPC_URL: url,
      RISK_RAW_ARRAYS_DIR: dir,
      RISK_RAW_ARRAYS_CAPTURE: capture,
    });
    const folder = (r.rows[0] as Row).folder;
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const file = join(folder, `${DZND}.json.gz`);
    const original = readFileSync(file);
    const rec = JSON.parse(gunzipSync(original).toString()) as Record<string, unknown> & {
      children: Record<string, string>;
    };
    const tampered = async (change: (r: typeof rec) => unknown) => {
      const copy = structuredClone(rec);
      const out = change(copy) ?? copy;
      writeFileSync(file, gzipSync(JSON.stringify(out)));
      const res = await check(dir, capture);
      writeFileSync(file, original);
      return res;
    };
    // the arrays in another order: the decoders sort the ticks, so the simulator is the same
    const reversed = await tampered((x) => {
      x.children = Object.fromEntries(Object.entries(x.children).reverse());
    });
    expect(reversed.code).toBe(1);
    expect(reversed.rows[0]?.different).toEqual([
      { pool: DZND, what: 'children: the addresses, their order or their bytes' },
    ]);
    // a key of the job's own changed
    const mock = await tampered((x) => {
      x.provenance = 'mock';
    });
    expect(mock.rows[0]?.different).toEqual([
      { pool: DZND, what: 'source, method, methodVersion or provenance' },
    ]);
    // the collector's keys out of order
    const keys = await tampered((x) => {
      const { venue, pool, ...rest } = x;
      return { venue, pool, ...rest };
    });
    expect(keys.code).toBe(1);
    // a file that is not the run's
    writeFileSync(join(folder, `${BIG}.json.gz`), 'x');
    const extra = await check(dir, capture);
    expect(extra.code).toBe(1);
    expect(extra.rows[0]).toMatchObject({ unexpectedFiles: [BIG], same: false });
    rmSync(join(folder, `${BIG}.json.gz`));
    expect((await check(dir, capture)).rows[0]).toMatchObject({ same: true });
  });

  it('a pool with no account, one that does not decode and the ones a setting leaves out are each listed, and the rest written', async () => {
    const dir = join(root, 'run-partial');
    const capture = join(root, 'partial.json.gz');
    patch = {
      [P48D]: null,
      [DZND]: Buffer.from((captureBytes(c, DZND) as Uint8Array).subarray(0, 40)).toString('base64'),
    };
    const r = await job({
      SOLANA_RPC_URL: url,
      RISK_RAW_ARRAYS_DIR: dir,
      RISK_RAW_ARRAYS_CAPTURE: capture,
      RISK_RAW_ARRAYS_SKIP: 'other',
    });
    patch = {};
    // neither is a failure of the run: the chain does not have the one, and the other is not a pool account
    expect(r.code).toBe(0);
    const row = r.rows[0] as Row;
    expect(row.pools).toEqual({
      ofTracked: 12,
      leftToCollector: 1,
      leftOutBySetting: 4,
      read: 7,
      written: 5,
      notWritten: 2,
    });
    expect(row.accounted).toBe(true);
    expect(row.notWritten.map((n) => [n.pool, n.reason]).sort()).toEqual([
      [P48D, 'head_missing'],
      [DZND, 'decode_failed'],
    ]);
    expect(row.notWritten.find((n) => n.pool === DZND)?.detail).toBeTruthy();
    const others = c.direct.filter((p) => p.exitPath === 'other').map((p) => p.address);
    expect(row.leftOutBySetting.map((p) => p.pool).sort()).toEqual(others.sort());
    const files = readdirSync(row.folder).map((f) => f.slice(0, -'.json.gz'.length));
    expect(files).toHaveLength(5);
    for (const a of [P48D, DZND, ...others]) expect(files).not.toContain(a);
    expect((await check(dir, capture)).rows[0]).toMatchObject({
      pools: 7,
      files: 5,
      compared: 5,
      same: true,
    });
  });

  it('set to read every pool, the collector’s pool is read too, and still reported as the collector’s', async () => {
    const dir = join(root, 'run-every');
    const r = await job({
      SOLANA_RPC_URL: url,
      RISK_RAW_ARRAYS_DIR: dir,
      RISK_RAW_ARRAYS_ALL: '1',
    });
    const row = r.rows[0] as Row;
    expect(row.settings).toEqual({ everyPool: true, skipExitPaths: [] });
    // the made-up pool has no account on the stand-in chain, so it is listed; the eleven are written
    expect(row.pools).toEqual({
      ofTracked: 12,
      leftToCollector: 0,
      leftOutBySetting: 0,
      read: 12,
      written: 11,
      notWritten: 1,
    });
    expect(row.notWritten).toMatchObject([{ pool: BIG, reason: 'head_missing' }]);
    expect(row.collector).toMatchObject({ pools: 1, readHereToo: true });
    expect(row.accounted).toBe(true);
  });

  it('a batch the RPC answers with an error is read again; one it keeps refusing costs only the pools in it', async () => {
    // twenty accounts a call: the pool accounts, then the fee configs and the arrays in four calls
    const second = Object.keys(c.accounts).filter((k) => !c.direct.some((p) => p.address === k));
    const key = second[25] as string;
    // refused once: read again, nothing lost
    const once = join(root, 'run-retry');
    errorsFor = new Map([[key, 1]]);
    const a = await job({
      SOLANA_RPC_URL: url,
      RISK_RAW_ARRAYS_DIR: once,
      RISK_RAW_ARRAYS_BATCH: '20',
    });
    expect(a.code).toBe(0);
    expect((a.rows[0] as Row).pools).toMatchObject({ read: 11, written: 11 });
    expect((a.rows[0] as Row).rpc).toMatchObject({ batches: 5, batchRetries: 1, batchesFailed: 0 });
    // refused every time: its pools are read_failed, the others written, and the run says it failed
    const never = join(root, 'run-refused');
    errorsFor = new Map([[key, 99]]);
    const b = await job({
      SOLANA_RPC_URL: url,
      RISK_RAW_ARRAYS_DIR: never,
      RISK_RAW_ARRAYS_BATCH: '20',
    });
    errorsFor = new Map();
    expect(b.code).toBe(1);
    const row = b.rows[0] as Row;
    expect(row.rpc).toMatchObject({ batches: 5, batchRetries: 2, batchesFailed: 1 });
    expect(row.accounted).toBe(true);
    expect(row.notWritten.length).toBeGreaterThan(0);
    expect(row.pools?.written).toBe(11 - row.notWritten.length);
    expect(row.pools?.written).toBeGreaterThan(0);
    for (const n of row.notWritten) {
      expect(n.reason).toBe('read_failed');
      expect(n.detail).toContain('node is behind');
    }
    // no file for a pool that was not read whole
    const files = readdirSync(row.folder).map((f) => f.slice(0, -'.json.gz'.length));
    for (const n of row.notWritten) expect(files).not.toContain(n.pool);
    expect(files).toHaveLength(row.pools?.written as number);
    expect(b.out).not.toContain('127.0.0.1');
  });

  it('an RPC that refuses everything: no file, every pool read_failed, and a line that carries no address', async () => {
    const dir = join(root, 'run-rpc-error');
    errorsFor = new Map(c.direct.map((p) => [p.address, 99]));
    const r = await job({ SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: dir });
    errorsFor = new Map();
    expect(r.code).toBe(1);
    const row = r.rows[0] as Row;
    expect(row.pools).toMatchObject({ read: 11, written: 0, notWritten: 11 });
    expect(row.notWritten.every((n) => n.reason === 'read_failed')).toBe(true);
    expect(row.notWritten[0]?.detail).toContain('getMultipleAccounts');
    expect(r.out).not.toContain('127.0.0.1');
    expect(lines(dir)).toEqual([row]);
    expect(readdirSync(row.folder)).toEqual([]);
  });

  it('half-written files a killed run left are cleared once they are old, and a run still going is left alone', async () => {
    const dir = join(root, 'run-leftovers');
    // the hour folder is named by the run's own clock: both this hour's and the next's get the leftovers
    const old = `${DZND}.json.gz.4242.tmp`;
    const fresh = `${P48D}.json.gz.4343.tmp`;
    for (const at of [Date.now(), Date.now() + 3_600_000]) {
      const h = hourOf(at);
      const folder = join(dir, h.day, h.hour);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, old), 'half');
      utimesSync(
        join(folder, old),
        new Date(Date.now() - 3_600_000),
        new Date(Date.now() - 3_600_000),
      );
      writeFileSync(join(folder, fresh), 'half');
    }
    const r = await job({ SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: dir });
    expect(r.code).toBe(0);
    const files = readdirSync((r.rows[0] as Row).folder);
    expect(files).not.toContain(old);
    expect(files).toContain(fresh);
    expect(files.filter((f) => f.endsWith('.json.gz'))).toHaveLength(11);
    // the run's own temporary files are gone: each was renamed
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([fresh]);
  });

  it('refuses the collector’s folders under any name, and leaves nothing there', async () => {
    const before = homeState();
    for (const dir of [
      join(home, 'raw'),
      join(home, 'raw', 'mine'),
      home,
      join(home, 'pools'),
      join(home, 'RAW'),
      root,
    ]) {
      const r = await job({ SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: dir });
      expect(r.code).toBe(1);
      expect(r.rows[0]?.error).toContain('a folder of its own');
    }
    // the API's variable names another raw folder: the collector's real one is refused all the same, and so is that one
    const elsewhere = join(root, 'elsewhere-raw');
    mkdirSync(elsewhere);
    for (const dir of [join(home, 'raw'), join(elsewhere, 'sub')]) {
      const r = await job({
        SOLANA_RPC_URL: url,
        RISK_RAW_ARRAYS_DIR: dir,
        RISK_RAW_DIR: elsewhere,
      });
      expect(r.code).toBe(1);
      expect(r.rows[0]?.error).toContain('a folder of its own');
    }
    expect(homeState()).toEqual(before);
    for (const d of [join(home, 'raw', 'mine'), join(home, 'pools'), join(elsewhere, 'sub')])
      expect(existsSync(d)).toBe(false);
    // a folder that holds another job's run log is not this job's either
    const taken = join(root, 'taken');
    mkdirSync(taken);
    writeFileSync(join(taken, 'runs.jsonl'), '{"kind":"run","methodVersion":"pools-0.1"}\n');
    const r = await job({ SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: taken });
    expect(r.code).toBe(1);
    expect(r.rows[0]?.error).toContain('not a folder of its own');
    expect(readFileSync(join(taken, 'runs.jsonl'), 'utf8')).toBe(
      '{"kind":"run","methodVersion":"pools-0.1"}\n',
    );
    // the one folder inside the home that is its own
    const own = join(home, 'raw-arrays');
    const ok = await job({ SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: own });
    expect(ok.code).toBe(0);
    rmSync(own, { recursive: true });
    expect(homeState()).toEqual(before);
  });

  it('with no folder named it stops before anything is created: the source has no default', async () => {
    const before = homeState();
    const here = readdirSync(root).sort();
    calls = 0;
    for (const dir of [undefined, '']) {
      const r = await job({ SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: dir });
      expect(r.code).toBe(1);
      expect(r.rows[0]?.error).toContain('RISK_RAW_ARRAYS_DIR is not set');
      expect(r.rows[0]?.stage).toBe('inputs');
    }
    expect(calls).toBe(0);
    expect(homeState()).toEqual(before);
    expect(existsSync(join(home, 'raw-arrays'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(here);
  });

  it('stops without an RPC address: its line, in its own folder, names every pool it did not read', async () => {
    const dir = join(root, 'run-no-rpc');
    calls = 0;
    const r = await job({ RISK_RAW_ARRAYS_DIR: dir });
    expect(r.code).toBe(1);
    const row = r.rows[0] as Row;
    expect(row.error).toContain('SOLANA_RPC_URL is not set');
    expect(row.stage).toBe('inputs');
    expect(row.pools).toEqual({
      ofTracked: 12,
      leftToCollector: 1,
      leftOutBySetting: 0,
      read: 11,
      written: 0,
      notWritten: 11,
    });
    expect(row.everyPoolNotWritten).toMatchObject({
      reason: 'run_failed',
      stage: 'inputs',
      pools: 11,
    });
    expect(row.registry).toEqual({
      fetchedAt: c.registry.fetchedAt,
      methodVersion: 'registry-0.1',
    });
    expect(calls).toBe(0);
    expect(readdirSync(dir)).toEqual(['runs.jsonl']);
    expect(lines(dir)).toEqual([row]);
  });

  it('ended by a signal while it reads, it leaves a line that says so', async () => {
    const dir = join(root, 'run-terminated');
    waitMs = 5_000;
    let child: ChildProcess | null = null;
    // the stand-in has the first call in hand: the run is in its read
    onRequest = () => child?.kill('SIGTERM');
    const done = await node(
      'scripts/risk/raw-arrays/job.ts',
      [],
      { SOLANA_RPC_URL: url, RISK_RAW_ARRAYS_DIR: dir },
      (ch) => {
        child = ch;
      },
    );
    waitMs = 0;
    onRequest = null;
    expect(done.code).not.toBe(0);
    const row = lines(dir).at(-1) as Row;
    expect(row.error).toBe('terminated (SIGTERM)');
    expect(row.stage).toBe('read');
    expect(row.everyPoolNotWritten).toMatchObject({
      reason: 'run_failed',
      stage: 'read',
      pools: 11,
    });
    expect(readdirSync(dir)).toEqual(['runs.jsonl']);
  });

  it('--plan reads the registry and the cache, prints what a run would read, and touches nothing', async () => {
    const dir = join(root, 'run-plan');
    calls = 0;
    for (const env of [{ RISK_RAW_ARRAYS_DIR: dir }, {}]) {
      const r = await job(env, ['--plan']);
      expect(r.code).toBe(0);
      expect(r.rows[0]).toMatchObject({
        kind: 'raw-arrays-plan',
        ofTracked: { pools: 12 },
        read: { pools: 11, arrays: 68 },
        collector: { pools: 1 },
        leftToCollector: { pools: 1 },
        notUnderstood: [],
        accounts: 79,
        rpcCalls: 2,
      });
    }
    expect(calls).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });
});
