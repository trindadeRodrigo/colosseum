import {
  apportion,
  EXIT_WINDOW_DAYS,
  formatDecimal,
  parseDecimal,
  rollUp,
} from '@colosseum/basket';
import { PERSONAL_PARAMS } from '@colosseum/engine/personal';
import type {
  BasketAsset,
  ChainExposure,
  ExposureExit,
  ExposureShare,
  PortfolioExposureResponse,
  Provenance,
  Shelf,
} from '@colosseum/schemas';
import { z } from 'zod';
import { isMeasured } from '../model-exits';
import type { OrderDeps } from '../orders/legs';
import { type PlanInputs, shelfVersionOf, withTiers } from '../orders/personalize';
import { loadFamilies } from '../orders/store';
import { frame, type ScopedChain } from './scope';
import { knownVaults, type SnapshotRow } from './snapshots';

// What a person holds across their vaults, added up (PORT-2, GET /v1/portfolio/exposure): by
// underlying and by issuer, with the risk roll-up of packages/basket over the same holdings, and what
// selling each holding would cost at its whole size (gate EXIT-SOURCE). It is read from the newest
// snapshot of each vault and from the figures a plan is made with (`PlanInputs`), never from a chain.
//
// Dollars are added as packages/basket counts money: whole numbers scaled by 1e18, read from the
// decimal strings the snapshots hold, never floats. A person reads these sums. A float comes in only
// where the roll-up and the liquidity provider take one: the size of a holding, as a figure to cost.

/** How a chain's sums were made: the `method` of its entry in the answer. */
export const EXPOSURE_METHOD =
  'sums over the newest snapshot of each vault: each position at the value its snapshot gave it, and the cash at one dollar each; a holding with no price, or one the asset list does not name, is in no sum; a share is its dollars in basis points of the total, by largest remainders';

/** What a chain's entry names as its source when no snapshot stands behind it. */
export const NO_SNAPSHOT_SOURCE =
  'vault_snapshots: no snapshot of a vault of yours was found for this answer';

/** One asset a person holds on a chain, as the asset list has it, and its dollars scaled by 1e18. */
export type Held = { asset: BasketAsset; usd: bigint };

type Liquidity = Awaited<ReturnType<PlanInputs>>['liquidity'];
type Unvalued = ChainExposure['unvalued'];

const IsoTime = z.string().datetime();
/** To a hundredth of a basis point, as the roll-up's exit numbers are. */
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Dollars as a figure to cost, to the millionth: the one place a sum becomes a float. */
const dollars = (usd: bigint) => Number(formatDecimal(usd));

/**
 * What the snapshots hold, added up by asset, and the holdings that are in no sum.
 *
 * A position counts at the value its snapshot gave it, and the cash at one dollar each, which is its
 * `display` amount: `view()` of packages/basket counts cash the same way. A holding with no price
 * (`valueUsd: null`), or one whose asset is not in `listed`, has no value to add or no underlying and
 * issuer to add it under. It is said in `unvalued` with its vault and the amount held, when anything
 * is held. A value of zero adds nothing, so its asset is not among the sums.
 */
export function holdingsOf(
  rows: SnapshotRow[],
  listed: ReadonlySet<string>,
): { sums: Map<string, bigint>; unvalued: Unvalued } {
  const sums = new Map<string, bigint>();
  const unvalued: Unvalued = [];
  const count = (
    vault: string,
    held: { asset: string; raw: string; display: string },
    value: string | null,
  ) => {
    if (value === null || !listed.has(held.asset)) {
      if (held.raw !== '0') unvalued.push({ asset: held.asset, vault, display: held.display });
      return;
    }
    const usd = parseDecimal(value);
    if (usd > 0n) sums.set(held.asset, (sums.get(held.asset) ?? 0n) + usd);
  };
  for (const row of rows) {
    count(row.address, row.cash, row.cash.display);
    for (const position of row.positions) count(row.address, position, position.valueUsd);
  }
  return { sums, unvalued };
}

/**
 * Dollars by key, as shares of their total: largest first, each in dollars and in basis points. The
 * basis points add up to exactly 10,000: each share is rounded down and the points left over go to
 * the largest remainders (`apportion`), over the keys in one order, so the answer never depends on
 * the order of the holdings. Of two equal shares the earlier key comes first.
 */
export function sharesOf(lines: { key: string; usd: bigint }[]): ExposureShare[] {
  const sums = new Map<string, bigint>();
  for (const line of lines) sums.set(line.key, (sums.get(line.key) ?? 0n) + line.usd);
  const keys = [...sums.keys()].sort();
  const usd = keys.map((key) => sums.get(key) ?? 0n);
  const bps = apportion(usd, 10_000n);
  return keys
    .map((key, i) => ({ key, usd: usd[i] ?? 0n, bps: Number(bps[i] ?? 0n) }))
    .sort((a, b) => (a.usd === b.usd ? (a.key < b.key ? -1 : 1) : a.usd > b.usd ? -1 : 1))
    .map((share) => ({ key: share.key, usd: formatDecimal(share.usd), bps: share.bps }));
}

/**
 * The label of a sum over figures that carry these labels: the least live of them. Any `mock` makes
 * the sum `mock`; else anything that is not `live` makes it `sandbox`. A sum is `live` only when
 * everything in it is. A chain's label is one of those three (`chainProvenance`).
 */
export function leastLive(labels: Provenance[]): Provenance {
  if (labels.includes('mock')) return 'mock';
  return labels.every((label) => label === 'live') ? 'live' : 'sandbox';
}

/**
 * What selling each holding that is not cash would cost at its whole size (gate EXIT-SOURCE), the
 * largest holding first.
 *
 * A holding is measured as the engine and the plan inputs mean it (`isMeasured` of model-exits.ts, at
 * the engine's cost level and window): the provider covers the asset and reads its capacity from
 * samples. Its cost is then the provider's `exitCost` at the holding's dollars, in basis points to
 * two places, and null where that size is beyond what was measured. The figure says where it came
 * from as the engine's exit observation does (`ceiling` in packages/engine/src/personal/world.ts):
 * the source the plan inputs name, the provider's method version, the end of the data the capacity was
 * read from, and the provider's own label. A source or a time that is missing is left out, never
 * made up.
 *
 * A holding that is not measured names its asset's tier as the fallback and states no cost. A tier is
 * a ceiling on what a plan may hold of the asset, never a cost of selling it, so no number is made
 * from one.
 */
export function exitsOf(held: Held[], liquidity: Liquidity): ExposureExit[] {
  const tau = PERSONAL_PARAMS.tau;
  return [...held]
    .filter(({ asset }) => asset.cls !== 'cash')
    .sort((a, b) => (a.usd === b.usd ? (a.asset.id < b.asset.id ? -1 : 1) : a.usd > b.usd ? -1 : 1))
    .map(({ asset, usd }): ExposureExit => {
      const size = { asset: asset.id, usd: formatDecimal(usd) };
      if (!liquidity || !isMeasured(liquidity.provider, asset.id, tau, EXIT_WINDOW_DAYS))
        return { ...size, measured: false, costBps: null, fallbackTier: asset.tier };
      const { provider } = liquidity;
      const cost = provider.exitCost(asset.id, dollars(usd), EXIT_WINDOW_DAYS);
      const at = IsoTime.safeParse(provider.exitCapacity(asset.id, tau, EXIT_WINDOW_DAYS)?.dataTo);
      const source = liquidity.source.trim();
      return {
        ...size,
        measured: true,
        costBps: cost === null ? null : round2(cost * 10_000),
        ...(source ? { source } : {}),
        method: provider.methodVersion,
        ...(at.success ? { fetchedAt: at.data } : {}),
        provenance: provider.provenance,
      };
    });
}

/** One chain of the person's in the answer, and the holdings it adds to the total. */
export type ChainRead = { answer: ChainExposure; held: Held[] };

/**
 * A person's holdings on one chain, from the newest snapshot of each of their vaults there, or of the
 * one vault `address` names. A vault the worker has not read yet has no snapshot and adds nothing.
 *
 * What each asset is (its underlying, issuer, tier and class) comes from the chain's asset list, with
 * the tiers and issuers the plan inputs stand in for a test network's placeholders (`withTiers`), as a
 * plan is made: so the roll-up here and the roll-up of a plan class a token the same way. The plan
 * inputs and the shelf are read only for a chain that holds something with a value.
 */
export async function chainExposure(a: {
  deps: OrderDeps;
  scoped: ScopedChain;
  inputs: PlanInputs;
  now: Date;
  address?: string;
}): Promise<ChainRead> {
  const { deps, scoped, now } = a;
  const { entry } = scoped;
  const known = await knownVaults(deps.db, scoped, { now, address: a.address });
  const rows = known.flatMap((vault) => (vault.newest ? [vault.newest] : []));
  const oldest = rows.reduce<Date | null>(
    (at, row) => (at === null || row.observedAt < at ? row.observedAt : at),
    null,
  );
  const read = {
    ...frame(entry),
    vaults: rows.length,
    // The sums are no fresher than the oldest snapshot they stand on.
    observedAt: oldest?.toISOString() ?? null,
    source:
      rows.length === 0
        ? NO_SNAPSHOT_SOURCE
        : [...new Set(rows.map((row) => row.source))].sort().join('; '),
    method: EXPOSURE_METHOD,
  };
  const nothing = (unvalued: Unvalued): ChainRead => ({
    answer: {
      ...read,
      valueUsd: '0',
      byUnderlying: [],
      byIssuer: [],
      rollUp: null,
      exit: [],
      unvalued,
    },
    held: [],
  });
  // A static list held in memory: no node is asked.
  const listed = await entry.adapter.listAssets();
  const { sums, unvalued } = holdingsOf(rows, new Set(listed.map((asset) => asset.id)));
  if (sums.size === 0) return nothing(unvalued);

  // The shelf as `personalize()` makes it, so a token is classed here as in a plan. The roll-up reads
  // what each token is from it; the shared portfolios make the shelf whole and class nothing here.
  const figures = await a.inputs({
    db: deps.db,
    chain: entry.chain,
    assets: listed,
    provenance: entry.provenance,
  });
  const assets = withTiers(listed, figures.tiers, figures.issuers);
  const families = await loadFamilies(deps.db, entry.chain);
  const shelf: Shelf = { version: shelfVersionOf(entry.chain, assets, families), assets, families };
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const held = [...sums].flatMap(([id, usd]): Held[] => {
    const asset = byId.get(id);
    return asset ? [{ asset, usd }] : [];
  });
  return {
    answer: {
      ...read,
      valueUsd: formatDecimal(held.reduce((sum, h) => sum + h.usd, 0n)),
      byUnderlying: sharesOf(held.map((h) => ({ key: h.asset.underlying, usd: h.usd }))),
      byIssuer: sharesOf(held.map((h) => ({ key: h.asset.issuer, usd: h.usd }))),
      // No stored quote is read, so the roll-up's quoted exit is null and it says so.
      rollUp: rollUp(
        held.map((h) => ({ asset: h.asset.id, amountUsd: dollars(h.usd) })),
        {
          shelf,
          ...(figures.liquidity ? { liquidity: figures.liquidity.provider } : {}),
          quotes: [],
          now: now.toISOString(),
        },
      ),
      exit: exitsOf(held, figures.liquidity),
      unvalued,
    },
    held,
  };
}

/**
 * The chains added up, by underlying and by issuer over the grand total. Null when no chain holds
 * anything with a value. Its label is the least live of the labels of the chains that add to it: a
 * chain that holds nothing puts no figure into the sum, and so no label on it.
 */
export function totalOf(chains: ChainRead[]): PortfolioExposureResponse['total'] {
  const held = chains.flatMap((chain) => chain.held);
  if (held.length === 0) return null;
  return {
    valueUsd: formatDecimal(held.reduce((sum, h) => sum + h.usd, 0n)),
    provenance: leastLive(
      chains.filter((chain) => chain.held.length > 0).map((chain) => chain.answer.provenance),
    ),
    byUnderlying: sharesOf(held.map((h) => ({ key: h.asset.underlying, usd: h.usd }))),
    byIssuer: sharesOf(held.map((h) => ({ key: h.asset.issuer, usd: h.usd }))),
  };
}
