import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

// What the keeper remembers between rounds and between runs, per network: every leg it sent whose fate
// it has not settled, and every leg that reverted. A leg is sent at most once until its fate is known,
// and a leg that reverted is never sent again. Kept in a small JSON file outside the repository; the
// `keeper_runs` and `keeper_legs` tables are not written yet.

/** A leg that was handed to the node and whose fate is not known yet. */
export const InFlight = z.object({
  vault: z.string(),
  /** `vault sell->buy`, the key a reverted leg is remembered by. */
  key: z.string(),
  txId: z.string(),
  /** The last block height the transaction can land in. */
  validUntil: z.string().regex(/^\d+$/),
  sentAt: z.string(),
});
export type InFlight = z.infer<typeof InFlight>;

export type KeeperMemory = {
  /** `vault sell->buy` of a leg that reverted: not sent again. */
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
  const stored = Stored.parse(JSON.parse(readFileSync(file, 'utf8')));
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
  const next = `${file}.next`;
  writeFileSync(next, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, file);
}
