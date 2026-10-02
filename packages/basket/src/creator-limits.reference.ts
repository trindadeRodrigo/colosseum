import type { Target } from '@colosseum/schemas';
import type { CreatorLimitContext, RecipeHeader } from './creator-limits';

// A second, slow statement of the author limits, used only by the tests. It is written from the rule
// table in fixtures/creator-limits/README.md and shares nothing with creator-limits.ts: its own
// numbers, sorted lists in place of maps, and every rule tried, not only the first that fails. The
// tests hold the real check to it.

const ORDER = [
  'FeeNotZero',
  'FlagsNotZero',
  'TooFewAssets',
  'TooManyAssets',
  'AssetNotListed',
  'DuplicateAsset',
  'WeightBelowMin',
  'WeightOffStep',
  'WeightAboveCeiling',
  'WeightSum',
  'VersionPending',
  'VersionTooSoon',
  'TurnoverTooHigh',
];

/** Twice the turnover: the sum of the absolute changes, by walking two sorted lists side by side. */
export function referenceMovedBps(prev: readonly Target[], next: readonly Target[]): number {
  const total = (list: readonly Target[]) => {
    const names = [...new Set(list.map((t) => t.asset))].sort();
    return names.map((name) => ({
      name,
      weight: list.filter((t) => t.asset === name).reduce((n, t) => n + t.weightBps, 0),
    }));
  };
  const a = total(prev);
  const b = total(next);
  let i = 0;
  let j = 0;
  let moved = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && y && x.name === y.name) {
      moved += x.weight > y.weight ? x.weight - y.weight : y.weight - x.weight;
      i += 1;
      j += 1;
    } else if (x && (!y || x.name < y.name)) {
      moved += x.weight;
      i += 1;
    } else if (y) {
      moved += y.weight;
      j += 1;
    }
  }
  return moved;
}

/** Every rule `next` breaks, lowest-numbered first. Empty means it may be published. */
export function referenceBreaks(
  prev: readonly Target[] | null,
  next: readonly Target[],
  ctx: CreatorLimitContext,
  header: RecipeHeader,
): string[] {
  const broken = new Set<string>();
  if (header.maxFeeBps > 0 || header.maxFeeBps < 0) broken.add('FeeNotZero');
  if (header.flags > 0 || header.flags < 0) broken.add('FlagsNotZero');

  if (next.length <= 2) broken.add('TooFewAssets');
  if (next.length >= 13) broken.add('TooManyAssets');

  let sum = 0;
  const names = next.map((t) => t.asset).sort();
  for (let k = 1; k < names.length; k += 1)
    if (names[k] === names[k - 1]) broken.add('DuplicateAsset');
  for (const t of next) {
    sum += t.weightBps;
    const onList = ctx.assets.filter((a) => a.id === t.asset);
    if (onList.length === 0) broken.add('AssetNotListed');
    if (t.weightBps < 200) broken.add('WeightBelowMin');
    if (t.weightBps % 50 !== 0) broken.add('WeightOffStep');
    for (const a of onList)
      if (t.weightBps > 5000 || t.weightBps > a.maxWeightBps) broken.add('WeightAboveCeiling');
  }
  if (sum !== 10_000) broken.add('WeightSum');

  if (ctx.hasPending) broken.add('VersionPending');
  if (ctx.lastPublishAt !== null && ctx.now - ctx.lastPublishAt < ctx.publishDelay)
    broken.add('VersionTooSoon');
  // Over 20% moved is over 40% of absolute change.
  if (prev !== null && referenceMovedBps(prev, next) > 4000) broken.add('TurnoverTooHigh');

  return ORDER.filter((rule) => broken.has(rule));
}
