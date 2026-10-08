import { apportion } from './amounts';

// The weights of a person's picks (Rodrigo's rule 2 of the relaxed intake, kept by gate ANY-COMPOSITION):
// they come from this function after the model, never from the model. An equal split, unless the person
// stated shares in their own words; a share the server parsed from those words is the only thing that
// makes a weight differ from its neighbours'.

const WHOLE = 10_000;

/**
 * `total` basis points over `n` lines, as equal as whole basis points allow. The remainder goes one
 * basis point each to the first lines, in the order given: 3 lines are 3334, 3333, 3333.
 */
export function splitBps(n: number, total = WHOLE): number[] {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError('n must be a whole number, 0 or more');
  if (n === 0) return [];
  return apportion(Array<bigint>(n).fill(1n), BigInt(total)).map(Number);
}

/**
 * Shares as given, in any unit (0.7 and 0.3, or 70 and 30, or 2 and 1), scaled to the whole in basis
 * points. Rounding is by largest remainder, ties to the earlier share, so the result adds up to exactly
 * 10,000. All zero, or none: an equal split.
 */
export function scaleToWholeBps(shares: readonly number[]): number[] {
  if (shares.some((share) => !Number.isFinite(share) || share < 0))
    throw new RangeError('a share is a finite number, 0 or more');
  const units = shares.map((share) => BigInt(Math.round(share * 1_000_000)));
  if (units.every((unit) => unit === 0n)) return splitBps(shares.length);
  return apportion(units, BigInt(WHOLE)).map(Number);
}

/**
 * A limit the person stated over some of the picks, by their index: "70% Tesla" is min = max = 7000 on
 * Tesla's line, "at least 40% stocks" is min 4000, max 10000 on every stock line.
 */
export type StatedShare = { members: readonly number[]; min: number; max: number };

/**
 * The weights of `count` picks under the person's stated shares. With none, an equal split. Otherwise,
 * in the order the person stated them, each share that the current weights do not already meet fixes its
 * lines at the nearest total it allows, split equally among its lines still free, and the free lines
 * share what is left equally. When the person gave exact shares, two or more, that cover every pick
 * once ("70% Tesla, 30% Nvidia"), those shares are scaled to the whole whatever they add up to, and
 * `scaled` says so; one exact share on every pick ("70% Tesla" with Tesla alone) is not scaled, it is
 * unmet.
 * `unmet` lists the stated shares, by index, that the picks cannot meet: the caller asks the person.
 */
export function personWeights(
  count: number,
  stated: readonly StatedShare[],
): { weights: number[]; unmet: number[]; scaled: boolean } {
  for (const share of stated)
    if (
      !Number.isInteger(share.min) ||
      !Number.isInteger(share.max) ||
      share.min < 0 ||
      share.max > WHOLE ||
      share.min > share.max ||
      share.members.some((index) => !Number.isInteger(index) || index < 0 || index >= count)
    )
      throw new RangeError('a stated share is whole basis points over picks that exist');
  const exact = stated.filter((share) => share.min === share.max && share.members.length > 0);
  const covered = new Set(exact.flatMap((share) => share.members));
  const disjoint = covered.size === exact.reduce((n, share) => n + share.members.length, 0);
  if (exact.length >= 2 && exact.length === stated.length && disjoint && covered.size === count) {
    // Every pick has the share the person gave it: those shares, scaled to the whole.
    const groups = scaleToWholeBps(exact.map((share) => share.min));
    const weights = Array<number>(count).fill(0);
    exact.forEach((share, i) => {
      splitBps(share.members.length, groups[i]).forEach((weight, j) => {
        weights[share.members[j] as number] = weight;
      });
    });
    const sum = exact.reduce((n, share) => n + share.min, 0);
    return { weights, unmet: [], scaled: sum !== WHOLE };
  }
  const locked = new Map<number, number>();
  const current = (): number[] => {
    const free = Array.from({ length: count }, (_, i) => i).filter((i) => !locked.has(i));
    const left = WHOLE - [...locked.values()].reduce((n, w) => n + w, 0);
    const shares = splitBps(free.length, Math.max(0, left));
    const weights = Array<number>(count).fill(0);
    for (const [i, w] of locked) weights[i] = w;
    free.forEach((i, j) => {
      weights[i] = shares[j] ?? 0;
    });
    return weights;
  };
  const total = (weights: readonly number[], members: readonly number[]) =>
    members.reduce((n, i) => n + (weights[i] ?? 0), 0);
  for (const share of stated) {
    const now = total(current(), share.members);
    const target = Math.min(share.max, Math.max(share.min, now));
    if (target === now && share.min !== share.max) continue;
    const free = share.members.filter((i) => !locked.has(i));
    const fixed = total(
      current(),
      share.members.filter((i) => locked.has(i)),
    );
    const budget = target - fixed;
    const left = WHOLE - [...locked.values()].reduce((n, w) => n + w, 0);
    const others = count - locked.size - free.length;
    // Nothing free to move, more than is left, or a remainder with no other line to hold it: unmet.
    if (free.length === 0 || budget < 0 || budget > left || (others === 0 && budget !== left))
      continue;
    splitBps(free.length, budget).forEach((weight, j) => {
      locked.set(free[j] as number, weight);
    });
  }
  const weights = current();
  const unmet = stated.flatMap((share, i) => {
    const sum = total(weights, share.members);
    return sum < share.min || sum > share.max ? [i] : [];
  });
  return { weights, unmet, scaled: false };
}
