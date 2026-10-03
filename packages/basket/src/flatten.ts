import type { AssetId, Recipe, Shelf, Target } from '@colosseum/schemas';
import { apportion } from './amounts';

// A plan may point at a shared portfolio ("30% in this one"). A vault stores assets only, so before a
// vault sees a plan each such line becomes the shared portfolio's own assets, weighted through.

export class FlattenError extends Error {
  readonly code:
    | 'UnknownFamily'
    | 'AmbiguousFamily'
    | 'NotOnChain'
    | 'AmbiguousRecipe'
    | 'BadFamilyRecipe'
    | 'NothingLeft'
    | 'OverCeiling';
  constructor(code: FlattenError['code'], message: string) {
    super(message);
    this.name = 'FlattenError';
    this.code = code;
  }
}

/** What flattening did beside adding up: what it dropped, and what that pushed over a ceiling. */
export type FlattenReport = {
  targets: Target[];
  /**
   * Lines the plan gave a weight that the targets do not carry, largest first. `weightBps` is what
   * the line came to, and can be a fraction of a basis point: a figure to show, not a target.
   */
  dropped: { asset: AssetId; weightBps: number; why: 'under_minimum' | 'over_max_lines' }[];
  /**
   * Lines that were at or under their asset's ceiling on the shelf (`maxWeightBps`) and are over it
   * once the dropped weight was shared out.
   */
  overCeiling: { asset: AssetId; weightBps: number; ceilingBps: number }[];
};

/** A weight is carried in ten-thousandths of a basis point until the last step, so nothing is lost. */
const FINE = 10_000;

/**
 * The assets a recipe comes to, as targets, with what was dropped on the way.
 *
 * - One level deep: a shared portfolio lists assets only, and one that does not is refused.
 * - Same chain: a line that points at a shared portfolio takes that portfolio's recipe on the plan's
 *   own chain. The shelf holds one recipe per chain for a family (the version in effect), and one
 *   family per slug.
 * - An asset reached twice (directly and through a shared portfolio, or through two) is one target.
 * - Lines under `minLineBps` are dropped, then the smallest are dropped until `maxLines` are left.
 *   What they held is shared out over the lines kept, in proportion. Each dropped line is in
 *   `dropped`; a kept line that this pushed over its ceiling on the shelf is in `overCeiling`.
 * - The targets add up to exactly what the recipe's components add up to (10,000 for a valid one).
 *
 * The order is largest first, ties by asset id.
 */
export function flattenReport(
  recipe: Recipe,
  shelf: Shelf,
  p: { minLineBps: number; maxLines: number },
): FlattenReport {
  const fine = new Map<string, number>();
  const add = (asset: string, amount: number) => fine.set(asset, (fine.get(asset) ?? 0) + amount);

  for (const c of recipe.components) {
    if (c.kind === 'asset') {
      add(c.asset, c.weightBps * FINE);
      continue;
    }
    const families = shelf.families.filter((f) => f.meta.slug === c.family);
    const [family] = families;
    if (!family)
      throw new FlattenError('UnknownFamily', `no shared portfolio "${c.family}" on the shelf`);
    if (families.length > 1)
      throw new FlattenError(
        'AmbiguousFamily',
        `the shelf holds ${families.length} shared portfolios called "${c.family}"; it takes one`,
      );
    const onChain = family.recipes.filter((r) => r.chain === recipe.chain);
    const [inner] = onChain;
    if (!inner)
      throw new FlattenError(
        'NotOnChain',
        `the shared portfolio "${c.family}" is not on ${recipe.chain}`,
      );
    if (onChain.length > 1)
      throw new FlattenError(
        'AmbiguousRecipe',
        `the shelf holds ${onChain.length} recipes for "${c.family}" on ${recipe.chain}; it takes one`,
      );
    const innerSum = inner.components.reduce((n, x) => n + x.weightBps, 0);
    if (innerSum !== FINE)
      throw new FlattenError(
        'BadFamilyRecipe',
        `the shared portfolio "${c.family}" does not add up to 100%`,
      );
    for (const x of inner.components) {
      if (x.kind !== 'asset')
        throw new FlattenError(
          'BadFamilyRecipe',
          `the shared portfolio "${c.family}" points at another one; only one level is flattened`,
        );
      add(x.asset, c.weightBps * x.weightBps);
    }
  }

  const total = recipe.components.reduce((n, c) => n + c.weightBps, 0);
  // A target is at least 1 bp, so a line under that cannot stay whatever the minimum says.
  const floor = Math.max(1, p.minLineBps) * FINE;
  const bySize = [...fine].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const enough = bySize.filter(([, amount]) => amount >= floor);
  const kept = enough.slice(0, Math.max(0, p.maxLines));
  if (kept.length === 0)
    throw new FlattenError('NothingLeft', 'no line of this plan reaches the minimum weight');
  const dropped: FlattenReport['dropped'] = bySize
    .filter((line) => !kept.includes(line))
    .map(([asset, amount]) => ({
      asset,
      weightBps: amount / FINE,
      why: amount >= floor ? ('over_max_lines' as const) : ('under_minimum' as const),
    }));

  const weights = apportion(
    kept.map(([, amount]) => BigInt(amount)),
    BigInt(total),
  );
  const ceilingOf = new Map(shelf.assets.map((a) => [a.id, a.maxWeightBps]));
  const overCeiling: FlattenReport['overCeiling'] = [];
  const targets = kept.map(([asset, amount], i) => {
    const weightBps = Number(weights[i] ?? 0n);
    const ceilingBps = ceilingOf.get(asset);
    if (ceilingBps !== undefined && amount <= ceilingBps * FINE && weightBps > ceilingBps)
      overCeiling.push({ asset, weightBps, ceilingBps });
    return { asset, weightBps };
  });
  const largestFirst = <T extends Target>(a: T, b: T) =>
    b.weightBps - a.weightBps || (a.asset < b.asset ? -1 : 1);
  return {
    targets: targets.sort(largestFirst),
    dropped,
    overCeiling: overCeiling.sort(largestFirst),
  };
}

/**
 * The targets of `flattenReport`, as DESIGN-VAULT 3.6 names the function. With nowhere to report it,
 * a line pushed over its ceiling is refused here (`OverCeiling`): a caller that wants the targets
 * anyway, and the list of what was dropped, calls `flattenReport`.
 */
export function flatten(
  recipe: Recipe,
  shelf: Shelf,
  p: { minLineBps: number; maxLines: number },
): Target[] {
  const { targets, overCeiling } = flattenReport(recipe, shelf, p);
  const [worst] = overCeiling;
  if (worst)
    throw new FlattenError(
      'OverCeiling',
      `dropping lines raised ${worst.asset} to ${worst.weightBps / 100}%, over its ceiling of ${worst.ceilingBps / 100}%`,
    );
  return targets;
}
