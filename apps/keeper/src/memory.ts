import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

// What the keeper remembers between rounds and between runs, per network: every leg it sent whose fate
// it has not settled, and every leg that reverted. A leg is sent at most once until its fate is known,
// and a leg that reverted is never sent again. Kept in a small JSON file outside the repository; the
// `keeper_runs` and `keeper_legs` tables are not written yet. One process at a time holds the file,
// by a lock beside it: two keepers that each wrote back their own memory would send a leg twice.

/**
 * `vault vN sell->buy`: the key a reverted leg is remembered by. Kept for the vault's accepted version
 * only; a vault that takes another version is planned afresh.
 */
export const legKey = (vault: string, version: number, sell: string, buy: string) =>
  `${versionPrefix(vault, version)}${sell}->${buy}`;
/** What every `legKey` of the vault on that version starts with. */
export const versionPrefix = (vault: string, version: number) => `${vault} v${version} `;

/** A leg that was handed to the node and whose fate is not known yet. */
export const InFlight = z.object({
  vault: z.string(),
  /** `legKey`: what joins the reverted set if it reverts. */
  key: z.string(),
  txId: z.string(),
  /** The last block height the transaction can land in. */
  validUntil: z.string().regex(/^\d+$/),
  sentAt: z.string(),
});
export type InFlight = z.infer<typeof InFlight>;

export type KeeperMemory = {
  /** `legKey` of a leg that reverted: not sent again while its vault is on that version. */
  reverted: Set<string>;
  /** By vault: the leg sent and not settled. Nothing more is planned for the vault until it is. */
  inFlight: Map<string, InFlight>;
};

export const newMemory = (): KeeperMemory => ({ reverted: new Set(), inFlight: new Map() });

const Stored = z
  .object({ version: z.literal(1), reverted: z.array(z.string()), inFlight: z.array(InFlight) })
  .strict();

/** The memory in `file`, or an empty one when there is no file yet. A file that does not parse stops the keeper. */
export function loadMemory(file: string): KeeperMemory {
  if (!existsSync(file)) return newMemory();
  let stored: z.infer<typeof Stored>;
  try {
    stored = Stored.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(
      `the keeper's state file ${file} does not read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {
    reverted: new Set(stored.reverted),
    inFlight: new Map(stored.inFlight.map((f) => [f.vault, f])),
  };
}

/** Writes the memory whole, through a file beside it renamed into place, so a crash leaves one or the other. */
export function saveMemory(file: string, memory: KeeperMemory): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const stored: z.infer<typeof Stored> = {
    version: 1,
    reverted: [...memory.reverted].sort(),
    inFlight: [...memory.inFlight.values()],
  };
  // Written, flushed to disk, renamed into place, and the rename flushed: a crash leaves the old file or
  // the new one, whole.
  const next = `${file}.next`;
  const fd = openSync(next, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(stored, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, file);
  const dir = openSync(dirname(file), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process is there, another user's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A lock with no process id in it (cut short by a crash) counts as held until it is this old. */
export const UNREADABLE_LOCK_MS = 30_000;

type Token = { raw: string; pid: number; ageMs: number };

/** What a lock file says, or null when there is none. */
function readToken(path: string): Token | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const pid = Number(raw.trim().split(/\s+/)[0]);
    return { raw, pid, ageMs: Date.now() - statSync(path).mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Gone: its process is not running, or is this one (a reused pid, as pid 1 after a restart). */
function stale(t: Token): boolean {
  if (Number.isInteger(t.pid) && t.pid > 0) return t.pid === process.pid || !alive(t.pid);
  return t.ageMs > UNREADABLE_LOCK_MS;
}

/** The locks this process holds: asked for again, they are refused, not taken for a reused pid's. */
const heldHere = new Set<string>();

const unique = (path: string, tag: string) =>
  `${path}.${process.pid}.${randomBytes(6).toString('hex')}.${tag}`;

/**
 * Creates `path` holding `token`, whole, or answers false if it exists: the token is written to a file
 * of its own, flushed, and hard-linked into place, so `path` is never seen empty.
 */
function claim(path: string, token: string): boolean {
  const tmp = unique(path, 'new');
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, token);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Moves aside the stale `path` that was read as `seen` and removes it. If what was moved is not what was
 * read (another process replaced it meanwhile), it is put back and the answer is false.
 */
function removeStale(path: string, seen: Token): boolean {
  const aside = unique(path, 'stale');
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw e;
  }
  const moved = readToken(aside);
  if (moved?.raw === seen.raw) {
    unlinkSync(aside);
    return true;
  }
  try {
    linkSync(aside, path);
  } catch {
    // Something else holds `path` now; it is refused below either way.
  }
  unlinkSync(aside);
  return false;
}

/** Releases `path` if it still holds `token`. */
function drop(path: string, token: string) {
  try {
    if (readFileSync(path, 'utf8') === token) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Takes the state file for this process: `<file>.lock`, holding the process id, its start time and a
 * nonce, created whole by a hard link and only if it does not exist. Refuses while a live process holds
 * it, or while one is taking over a stale lock. A lock whose process is gone (or is this pid, reused) is
 * taken over, and `log` says so: under a second lock, `<file>.lock.takeover`, taken the same way, the
 * stale lock is moved aside and checked to be the one that was read before it is removed. Only the
 * process holding the takeover removes a lock that is not its own. The answer releases it; it is also
 * released when the process exits.
 */
export function lockState(file: string, log: (line: string) => void = () => {}): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const takeover = `${lock}.takeover`;
  const token = `${process.pid} ${new Date().toISOString()} ${randomBytes(8).toString('hex')}\n`;
  const refuse = (t: Token | null) =>
    new Error(
      t && Number.isInteger(t.pid) && t.pid > 0
        ? `another keeper (process ${t.pid}) holds ${lock}`
        : `another keeper holds ${lock}`,
    );

  if (heldHere.has(lock)) throw refuse({ raw: '', pid: process.pid, ageMs: 0 });
  if (!claim(lock, token)) {
    const holder = readToken(lock);
    if (holder && !stale(holder)) throw refuse(holder);
    if (!claim(takeover, token)) {
      const other = readToken(takeover);
      if (other && !stale(other)) throw new Error(`another keeper is taking over ${lock}`);
      // Its process died during a takeover: that lock is moved aside the same way, and taken once.
      if (other && !removeStale(takeover, other))
        throw new Error(`another keeper is taking over ${lock}`);
      if (!claim(takeover, token)) throw new Error(`another keeper is taking over ${lock}`);
    }
    try {
      // Read again under the takeover: the lock may have been released or taken meanwhile.
      const seen = readToken(lock);
      if (seen && !stale(seen)) throw refuse(seen);
      if (seen && !removeStale(lock, seen)) throw refuse(readToken(lock));
      if (seen) log(`taking over ${lock}: its process ${seen.pid || '(none)'} is gone`);
      if (!claim(lock, token)) throw refuse(readToken(lock));
    } finally {
      drop(takeover, token);
    }
  }
  heldHere.add(lock);
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    heldHere.delete(lock);
    drop(lock, token);
  };
  process.once('exit', release);
  return release;
}
