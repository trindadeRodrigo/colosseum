import type { BasketTx, ChainId, ConsentKind } from '@colosseum/schemas';
import { type GuardCheck, GuardRefusal } from './refusal';
import type { ApprovedStep, ApprovedTrade } from './types';

// What every check is handed, and the small things all three wire formats share.

export type Context = {
  readonly step: ApprovedStep;
  readonly tx: BasketTx;
  readonly consents: readonly ConsentKind[];
  /**
   * Refuses with `check` unless `ok`. Every comparison the guard makes goes through here, so each one
   * has a name and a test can show what its absence lets through.
   */
  need(check: GuardCheck, ok: boolean, message: string): void;
};

/** The wallet family of a chain: the rule of `chainFamily` in the shared types. */
export const familyOf = (chain: ChainId): 'solana' | 'evm' =>
  chain === 'solana' ? 'solana' : 'evm';

/** Raw units as the shared types write them: a decimal string with no sign and no leading zero. */
export const isRawAmount = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 78 && /^(?:0|[1-9]\d*)$/.test(v);

/** The trades a step makes, in order. Empty for a step that trades nothing. */
export function tradesOf(step: ApprovedStep): ApprovedTrade[] {
  return step.kind === 'create_vault' || step.kind === 'deposit' || step.kind === 'swap'
    ? step.trades
    : [];
}

/** The largest value 256 bits hold: what an approval of everything asks for. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * An approval this large is an approval of everything, whatever number it is: no order moves 2^255
 * units of a token.
 */
export const isUnlimited = (amount: bigint) => amount >= 1n << 255n;

/** Runs `read` and turns anything it throws into a `malformed` refusal that says what could not be read. */
export function reading<T>(what: string, legId: string, read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof GuardRefusal) throw e;
    const why = e instanceof Error ? e.message : 'it cannot be read';
    throw new GuardRefusal('malformed', `${what}: ${why}`, legId);
  }
}

/** Two lists of targets say the same thing: the same assets, each once, with the same weights. */
export function sameWeights(
  a: readonly { key: string; bps: number }[],
  b: readonly { key: string; bps: number }[],
): boolean {
  if (a.length !== b.length) return false;
  const want = new Map(a.map((t) => [t.key, t.bps]));
  if (want.size !== a.length) return false;
  const seen = new Set<string>();
  for (const t of b) {
    if (seen.has(t.key) || want.get(t.key) !== t.bps) return false;
    seen.add(t.key);
  }
  return true;
}
