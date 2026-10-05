import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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

/**
 * Takes the state file for this process: `<file>.lock`, created only if it does not exist, holding the
 * process id. Refuses while a live process holds it. A lock whose process is gone is taken over, and
 * `log` says so. The answer releases it; it is also released when the process exits.
 */
export function lockState(file: string, log: (line: string) => void = () => {}): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
      const holder = Number(readFileSync(lock, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder))
        throw new Error(`another keeper (process ${holder}) holds ${lock}`);
      // Removed only if it still names the dead holder, so a keeper that took it meanwhile keeps it.
      if (readFileSync(lock, 'utf8').trim() !== String(holder || ''))
        throw new Error(`another keeper took ${lock} meanwhile`);
      log(`taking over ${lock}: its process ${holder || '(none)'} is gone`);
      unlinkSync(lock);
    }
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock);
    } catch {
      // Already gone.
    }
  };
  process.once('exit', release);
  return release;
}
