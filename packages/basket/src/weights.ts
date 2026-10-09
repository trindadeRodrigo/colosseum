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
 * The weights of `count` picks under the person's stated shares. With none, an equal split.
 *
 * When the person gave exact shares, two or more, that cover every pick once ("70% Tesla, 30% Nvidia"),
 * those shares are scaled to the whole whatever they add up to, and `scaled` says so. One exact share on
 * every pick ("70% Tesla" with Tesla alone) is not scaled: it is unmet.
 *
 * Otherwise the result does not depend on the order the shares were stated. Exact shares are applied
 * first, then minimums, then maximums, each kind in one fixed order (by its picks, then its bounds). An
 * exact share fixes its free picks at its total; a bound that the current weights break moves its free
 * picks to the nearest total it allows. The picks no share fixed share what is left equally. The bounds
 * are passed over again until none moves, since lowering one share raises the others.
 * `unmet` lists the stated shares, by their index in `stated`, that the picks cannot meet.
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
  const isExact = (share: StatedShare) => share.min === share.max;
  const exact = stated.filter((share) => isExact(share) && share.members.length > 0);
  const covered = new Set(exact.flatMap((share) => share.members));
  const disjoint = covered.size === exact.reduce((n, share) => n + share.members.length, 0);
  if (exact.length >= 2 && exact.length === stated.length && disjoint && covered.size === count) {
    // Every pick has the share the person gave it: those shares, scaled to the whole, in pick order.
    const byPick = [...exact].sort((a, b) => Math.min(...a.members) - Math.min(...b.members));
    const groups = scaleToWholeBps(byPick.map((share) => share.min));
    const weights = Array<number>(count).fill(0);
    byPick.forEach((share, i) => {
      const members = [...share.members].sort((a, b) => a - b);
      splitBps(members.length, groups[i]).forEach((weight, j) => {
        weights[members[j] as number] = weight;
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
  /** Fix the share's free picks at the total it needs; false when it needs nothing or cannot. */
  const apply = (share: StatedShare, always: boolean): boolean => {
    const weights = current();
    const now = total(weights, share.members);
    const target = Math.min(share.max, Math.max(share.min, now));
    if (target === now && !always) return false;
    const free = share.members.filter((i) => !locked.has(i));
    const budget =
      target -
      total(
        weights,
        share.members.filter((i) => locked.has(i)),
      );
    const left = WHOLE - [...locked.values()].reduce((n, w) => n + w, 0);
    const others = count - locked.size - free.length;
    // Nothing free to move, more than is left, or a remainder with no other pick to hold it: unmet.
    if (free.length === 0 || budget < 0 || budget > left || (others === 0 && budget !== left))
      return false;
    splitBps(free.length, budget).forEach((weight, j) => {
      locked.set(free[j] as number, weight);
    });
    return true;
  };
  const kind = (share: StatedShare) => (isExact(share) ? 0 : share.min > 0 ? 1 : 2);
  const key = (share: StatedShare) =>
    [
      kind(share),
      [...share.members].sort((a, b) => a - b).join(','),
      String(share.min).padStart(5, '0'),
      String(share.max).padStart(5, '0'),
    ].join('|');
  const ordered = [...stated].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  for (const share of ordered) if (kind(share) === 0) apply(share, true);
  const bounds = ordered.filter((share) => kind(share) !== 0);
  for (let pass = 0; pass <= bounds.length; pass += 1)
    if (!bounds.map((share) => apply(share, false)).some(Boolean)) break;
  const weights = current();
  const unmet = stated.flatMap((share, i) => {
    const sum = total(weights, share.members);
    return sum < share.min || sum > share.max ? [i] : [];
  });
  return { weights, unmet, scaled: false };
}
