import { expect, it } from 'vitest';
import { type GuardCheck, GuardRefusal } from '../src/guard/refusal';
import { type GuardOverrides, runGuard } from '../src/guard/run';
import type { GuardInput } from '../src/guard/types';

// A negative: a transaction that differs from the approved step in one way, and the check that must
// refuse it. Each is run twice. With the whole guard it must be refused, by that check. With that one
// check taken out and every other in place it must pass: so the check is what stops it, and a guard
// that lost the check would sign it.

export type Negative = {
  name: string;
  check: GuardCheck;
  input: () => Promise<GuardInput> | GuardInput;
  overrides?: GuardOverrides;
};

export function refusalOf(run: () => unknown): GuardRefusal | null {
  try {
    run();
    return null;
  } catch (e) {
    if (e instanceof GuardRefusal) return e;
    throw e;
  }
}

export function eachBites(negatives: Negative[]): void {
  for (const n of negatives)
    it(`${n.check}: ${n.name}`, async () => {
      const input = await n.input();
      const refusal = refusalOf(() => runGuard(input, n.overrides));
      expect(refusal?.code, refusal?.message ?? 'the guard passed it').toBe(n.check);
      expect(refusal?.legId).toBe(input.step.legId);
      const without = refusalOf(() => runGuard(input, { ...n.overrides, without: [n.check] }));
      expect(without?.message ?? null, `refused by another check (${without?.code})`).toBeNull();
    });
}
