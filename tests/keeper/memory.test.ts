import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { lockState, newMemory, saveMemory, UNREADABLE_LOCK_MS } from '../../apps/keeper/src/memory';

// The state file belongs to one keeper at a time: two that each wrote back their own memory would
// send a leg twice and drop each other's in-flight and reverted legs.

const run = promisify(execFile);
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'keeper-lock-')), 'solana-local.json');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

/** What a lock taken by this process holds: its id, its start time, a nonce. */
const mine = new RegExp(`^${process.pid} \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z [0-9a-f]{16}\\n$`);

/** Another process asking for the same state file, as a second `keeper --once` would at start. */
async function secondKeeper(file: string): Promise<string> {
  const script = `import { lockState } from ${JSON.stringify(join(process.cwd(), 'apps/keeper/src/memory.ts'))};
try { lockState(${JSON.stringify(file)}); console.log('took it'); } catch (e) { console.log(e.message); }`;
  const { stdout } = await run('pnpm', ['exec', 'tsx', '--eval', script], { cwd: process.cwd() });
  return stdout.trim();
}

describe("the keeper's state file", () => {
  it('refuses a second process while the first holds it, and lets one in once it is released', async () => {
    const file = stateFile();
    const release = lockState(file);
    expect(readFileSync(`${file}.lock`, 'utf8')).toMatch(mine);
    expect(await secondKeeper(file)).toBe(
      `another keeper (process ${process.pid}) holds ${file}.lock`,
    );
    expect(() => lockState(file)).toThrow(`another keeper (process ${process.pid})`);
    release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(await secondKeeper(file)).toBe('took it');
  }, 60_000);

  it('takes over a lock whose process is gone, and says so', async () => {
    const file = stateFile();
    // A process that is alive holds it: refused.
    const other = spawn('sleep', ['30']);
    children.push(other);
    writeFileSync(`${file}.lock`, String(other.pid));
    expect(() => lockState(file)).toThrow(`another keeper (process ${other.pid})`);
    // It is gone: taken over, with a line.
    other.kill();
    await new Promise((resolve) => other.once('exit', resolve));
    const said: string[] = [];
    const release = lockState(file, (line) => said.push(line));
    expect(said).toEqual([`taking over ${file}.lock: its process ${other.pid} is gone`]);
    expect(readFileSync(`${file}.lock`, 'utf8')).toMatch(mine);
    release();
  });

  it('holds a lock with no process id in it until it is old, then takes it over', () => {
    const file = stateFile();
    writeFileSync(`${file}.lock`, '');
    expect(() => lockState(file)).toThrow(`another keeper holds ${file}.lock`);
    const old = (Date.now() - UNREADABLE_LOCK_MS - 1_000) / 1_000;
    utimesSync(`${file}.lock`, old, old);
    const said: string[] = [];
    const release = lockState(file, (line) => said.push(line));
    expect(said).toEqual([`taking over ${file}.lock: its process (none) is gone`]);
    release();
  });

  it("takes over a lock that names this process's own id, which a restart can reuse", () => {
    const file = stateFile();
    writeFileSync(`${file}.lock`, `${process.pid} 2026-10-01T00:00:00.000Z 0000\n`);
    const said: string[] = [];
    const release = lockState(file, (line) => said.push(line));
    expect(said).toEqual([`taking over ${file}.lock: its process ${process.pid} is gone`]);
    expect(readFileSync(`${file}.lock`, 'utf8')).toMatch(mine);
    release();
  });

  it('lets exactly one of six keepers started at once hold the file, in every trial', async () => {
    // The review's race: starters asking at the same moment, with no lock, a lock whose process is
    // gone, or a lock left empty long ago. Before the lock was linked into place whole, a starter could
    // read it empty, take it for stale and take it too.
    const dir = mkdtempSync(join(tmpdir(), 'keeper-race-'));
    const dead = spawn('true');
    await new Promise((resolve) => dead.once('exit', resolve));
    const trials = 30;
    const old = (Date.now() - UNREADABLE_LOCK_MS - 60_000) / 1_000;
    for (let t = 0; t < trials; t++) {
      mkdirSync(join(dir, `t${t}`));
      const lock = join(dir, `t${t}`, 'state.json.lock');
      if (t % 3 === 1) writeFileSync(lock, String(dead.pid));
      if (t % 3 === 2) {
        writeFileSync(lock, '');
        utimesSync(lock, old, old);
      }
    }
    const slotMs = 300;
    const starter = join(process.cwd(), 'tests/keeper/lock-starter.ts');
    const starters = Array.from({ length: 6 }, () => {
      const child = spawn('pnpm', ['exec', 'tsx', starter, dir, String(slotMs), String(trials)]);
      children.push(child);
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      const ready = new Promise<void>((resolve) => {
        const check = () =>
          out.startsWith('ready') ? resolve() : child.stdout.once('data', check);
        check();
      });
      const done = new Promise<string[]>((resolve) =>
        child.once('close', () => resolve(out.trim().split('\n').slice(1))),
      );
      return { child, ready, done };
    });
    // Every starter is up before the first trial: they all ask together, however slow the start.
    await Promise.all(starters.map((s) => s.ready));
    const startAt = Date.now() + 500;
    for (const s of starters) s.child.stdin.end(String(startAt));
    const lines = (await Promise.all(starters.map((s) => s.done))).flat();
    const holders = Array.from(
      { length: trials },
      (_, t) => lines.filter((l) => l === `${t} took`).length,
    );
    expect(lines).toHaveLength(trials * 6);
    expect(holders).toEqual(Array(trials).fill(1));
  }, 120_000);

  it('writes the memory whole, and leaves no file beside it', () => {
    const file = stateFile();
    const memory = newMemory();
    memory.reverted.add('V v1 a->b');
    saveMemory(file, memory);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      reverted: ['V v1 a->b'],
      inFlight: [],
    });
    expect(existsSync(`${file}.next`)).toBe(false);
  });
});
