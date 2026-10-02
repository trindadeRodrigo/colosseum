import type { Recipe, Shelf, Target } from '@colosseum/schemas';
import { apportion } from './amounts';

// A plan may point at a shared portfolio ("30% in this one"). A vault stores assets only, so before a
// vault sees a plan each such line becomes the shared portfolio's own assets, weighted through.

export class FlattenError extends Error {
  readonly code:
    | 'UnknownFamily'
    | 'NotOnChain'
    | 'AmbiguousRecipe'
    | 'BadFamilyRecipe'
    | 'NothingLeft';
  constructor(code: FlattenError['code'], message: string) {
    super(message);
    this.name = 'FlattenError';
    this.code = code;
  }
}

/** A weight is carried in ten-thousandths of a basis point until the last step, so nothing is lost. */
const FINE = 10_000;

/**
 * The assets a recipe comes to, as targets.
 *
 * - One level deep: a shared portfolio lists assets only, and one that does not is refused.
 * - Same chain: a line that points at a shared portfolio takes that portfolio's recipe on the plan's
 *   own chain. The shelf holds one recipe per chain for a family (the version in effect).
 * - An asset reached twice (directly and through a shared portfolio, or through two) is one target.
 * - Lines under `minLineBps` are dropped, then the smallest are dropped until `maxLines` are left.
 *   What they held is shared out over the lines kept, in proportion.
 * - The targets add up to exactly what the recipe's components add up to (10,000 for a valid one).
 *
 * The order is largest first, ties by asset id.
 */
export function flatten(
  recipe: Recipe,
  shelf: Shelf,
  p: { minLineBps: number; maxLines: number },
): Target[] {
  const fine = new Map<string, number>();
  const add = (asset: string, amount: number) => fine.set(asset, (fine.get(asset) ?? 0) + amount);

  for (const c of recipe.components) {
    if (c.kind === 'asset') {
      add(c.asset, c.weightBps * FINE);
      continue;
    }
    const family = shelf.families.find((f) => f.meta.slug === c.family);
    if (!family)
      throw new FlattenError('UnknownFamily', `no shared portfolio "${c.family}" on the shelf`);
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
  const kept = [...fine]
    .filter(([, amount]) => amount >= floor)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, Math.max(0, p.maxLines));
  if (kept.length === 0)
    throw new FlattenError('NothingLeft', 'no line of this plan reaches the minimum weight');

  const weights = apportion(
    kept.map(([, amount]) => BigInt(amount)),
    BigInt(total),
  );
  return kept
    .map(([asset], i) => ({ asset, weightBps: Number(weights[i] ?? 0n) }))
    .sort((a, b) => b.weightBps - a.weightBps || (a.asset < b.asset ? -1 : 1));
}
