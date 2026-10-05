import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { lockState, newMemory, saveMemory } from '../../apps/keeper/src/memory';

// The state file belongs to one keeper at a time: two that each wrote back their own memory would
// send a leg twice and drop each other's in-flight and reverted legs.

const run = promisify(execFile);
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'keeper-lock-')), 'solana-local.json');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

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
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
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
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
    release();
  });

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
