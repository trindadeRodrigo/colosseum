/**
 * The tracked universe of one chain (gate UNIVERSE, PLAN-UNIVERSE RU.1). Pure: no I/O, no clock.
 * Rank the pools by the money they hold; the shortest prefix that reaches `share` of the total is the cut.
 * The assets the cut names are the tracked assets, and every pool of a tracked asset is tracked, not only
 * the pools inside the cut. `share` and `minPoolUsd` are policy inputs and are returned with the result.
 */
export type UniversePool = {
  address: string;
  /** The stock the pool is filed under. A pool of two stocks is one row, under one of them. */
  asset: string;
  /** null when the pool's money was not measured. Such a pool is never ranked and never counted as zero. */
  tvlUsd: number | null;
};

export type TrackedSetParams = {
  /** Share of the ranked pools' TVL the cut must reach, in (0, 1]. */
  share: number;
  /** Pools below this TVL are dust: left out of the ranking, the total and the tracked pools. */
  minPoolUsd: number;
};

export type TrackedSet<P extends UniversePool = UniversePool> = {
  share: number;
  minPoolUsd: number;
  /** TVL of the ranked pools: measured, at or above `minPoolUsd`. The base the share is taken of. */
  rankedUsd: number;
  rankedPools: number;
  /** The pools of the cut, largest first. */
  cut: P[];
  cutUsd: number;
  /** The assets the cut names, sorted. */
  assets: string[];
  /** Every ranked pool of a tracked asset, largest first. Contains the cut. */
  pools: P[];
  poolsUsd: number;
  /** Pools of tracked assets left out of `pools`, by reason. */
  dustPools: number;
  unmeasuredPools: number;
};

/** Largest first; equal TVL falls back to the address so the cut does not depend on input order. */
const byTvlDesc = (a: UniversePool, b: UniversePool) =>
  (b.tvlUsd as number) - (a.tvlUsd as number) ||
  (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

export function trackedSet<P extends UniversePool>(
  pools: readonly P[],
  params: TrackedSetParams,
): TrackedSet<P> {
  const { share, minPoolUsd } = params;
  if (!(share > 0 && share <= 1))
    throw new Error(`trackedSet: share must be in (0, 1], got ${share}`);
  if (!(minPoolUsd >= 0))
    throw new Error(`trackedSet: minPoolUsd must be 0 or more, got ${minPoolUsd}`);
  const seen = new Set<string>();
  for (const p of pools) {
    if (seen.has(p.address)) throw new Error(`trackedSet: pool ${p.address} appears twice`);
    seen.add(p.address);
    if (typeof p.asset !== 'string' || p.asset === '')
      throw new Error(`trackedSet: pool ${p.address} names no asset`);
    // typeof, not only a comparison: rows cast from JSON may carry a string, and a string would be concatenated.
    if (
      p.tvlUsd !== null &&
      !(typeof p.tvlUsd === 'number' && Number.isFinite(p.tvlUsd) && p.tvlUsd >= 0)
    )
      throw new Error(`trackedSet: pool ${p.address} has tvlUsd ${p.tvlUsd}`);
  }
  // A pool with no money names nothing, whatever the floor is.
  const ranked = pools
    .filter((p) => p.tvlUsd !== null && p.tvlUsd > 0 && p.tvlUsd >= minPoolUsd)
    .sort(byTvlDesc);
  const rankedUsd = ranked.reduce((s, p) => s + (p.tvlUsd as number), 0);
  const cut: P[] = [];
  let cutUsd = 0;
  for (const p of ranked) {
    if (cutUsd >= share * rankedUsd) break;
    cut.push(p);
    cutUsd += p.tvlUsd as number;
  }
  const tracked = new Set(cut.map((p) => p.asset));
  const rankedAddresses = new Set(ranked.map((p) => p.address));
  const tracks = ranked.filter((p) => tracked.has(p.asset));
  const rest = pools.filter((p) => tracked.has(p.asset) && !rankedAddresses.has(p.address));
  const unmeasuredPools = rest.filter((p) => p.tvlUsd === null).length;
  return {
    share,
    minPoolUsd,
    rankedUsd,
    rankedPools: ranked.length,
    cut,
    cutUsd,
    assets: [...tracked].sort(),
    pools: tracks,
    poolsUsd: tracks.reduce((s, p) => s + (p.tvlUsd as number), 0),
    dustPools: rest.length - unmeasuredPools,
    unmeasuredPools,
  };
}
