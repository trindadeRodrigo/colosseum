import { apportion } from '@colosseum/basket';

// Money in the engine is whole cents and shares are whole basis points, so sums are exact and the
// same inputs give the same plan on any machine.

/** Basis points in a whole. */
export const BPS = 10_000;
const CENTS_IN_A_DOLLAR = 100;

export const toCents = (usd: number): number => Math.round(usd * CENTS_IN_A_DOLLAR);
export const toUsd = (cents: number): number => cents / CENTS_IN_A_DOLLAR;
/** Whole cents at or under a dollar figure: a ceiling is never rounded up. */
export const floorCents = (usd: number): number => Math.floor(usd * CENTS_IN_A_DOLLAR);

/** `bps` of `cents`, rounded down. */
export const shareOf = (cents: number, bps: number): number => Math.floor((cents * bps) / BPS);

/** `bps` of `cents`, rounded up: a loss is never written smaller than it is. */
export const shareOfUp = (cents: number, bps: number): number => Math.ceil((cents * bps) / BPS);

/** What share of `whole` a part is, in basis points, rounded up. */
export const bpsOf = (part: number, whole: number): number => Math.ceil((part * BPS) / whole);

/**
 * Splits `total` by weights, exactly: each part rounded down, and what is left handed out one unit at
 * a time to the largest remainders, the earlier part first on a tie. All zero weights give all zeros.
 */
export function split(total: number, weights: readonly number[]): number[] {
  return apportion(
    weights.map((w) => BigInt(Math.max(0, Math.round(w)))),
    BigInt(total),
  ).map(Number);
}

export const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

/** By a number, largest first; ties by name, so the order of a list never decides anything. */
export function largestFirst<T>(
  items: readonly T[],
  size: (item: T) => number,
  name: (item: T) => string,
): T[] {
  return [...items].sort(
    (a, b) => size(b) - size(a) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0),
  );
}

export const byName = <T>(items: readonly T[], name: (item: T) => string): T[] =>
  [...items].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
