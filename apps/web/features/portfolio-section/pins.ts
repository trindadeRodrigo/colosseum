import type {
  ExposureExit,
  HistoryPoint,
  HistorySeries,
  PlanNewest,
  Price,
  Provenance,
  RebalanceEntry,
  Sourced,
} from '@colosseum/schemas';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import type { PinSource } from '../../components/ui/provenance';
import { addDecimals, sumSource, worst } from '../portfolio/portfolio';
import type { ExposureChain } from './api';

// What a page of the section hands the pin of a figure: the stamp the answer carries for that figure
// (its source, its time, its method and its label), as it came. One function for each kind of stamp
// in the four answers. Nothing is invented: a figure whose stamp lacks a part gets no pin, and so is
// not shown as a figure. Nothing is worked out from a clock: a snapshot is stale when the answer says
// so, with the age the answer gives.

export { addDecimals, worst };

/** The least live of the labels a figure stands on. One of them at least: a figure always has its own. */
export const leastLive = (label: Provenance, ...others: readonly Provenance[]): Provenance =>
  others.reduce(worst, label);

/** A stamp as the answer wrote it (`Sourced`), under the labels of what it sits in. */
export function sourcedPin(stamp: Sourced, ...under: readonly Provenance[]): PinSource {
  return {
    source: stamp.source,
    fetchedAt: stamp.fetchedAt,
    method: stamp.method,
    provenance: leastLive(stamp.provenance, ...under),
  };
}

/**
 * The value of a vault in its newest snapshot: where the read came from, when it was taken and how
 * the value was made, as the snapshot says. Its label is the least live of the snapshot's, of those
 * it sits under (its chain's, its plan's) and of the prices its priced positions stood on. Stale when
 * the answer says the snapshot is, with the age the answer gives (`newest.stale`, `ageSeconds`).
 */
export function snapshotPin(newest: PlanNewest, ...under: readonly Provenance[]): PinSource {
  const priced = new Set(
    newest.positions.filter((position) => position.valueUsd !== null).map((p) => p.asset),
  );
  const prices = newest.prices.filter((price) => priced.has(price.asset));
  return {
    source: newest.source,
    fetchedAt: newest.observedAt,
    method: newest.method,
    provenance: leastLive(newest.provenance, ...under, ...prices.map((price) => price.provenance)),
    staleAgeSec: newest.stale ? newest.ageSeconds : null,
  };
}

/** What the person put into a vault: `putIn`'s own stamp. */
export const putInPin = sourcedPin;

/** A price as its answer gave it, stale when the price says it is (`components/ui/price-source.ts`). */
export function pricePin(price: Price, ...under: readonly Provenance[]): PinSource {
  return pinSourceOfPrice({ ...price, provenance: leastLive(price.provenance, ...under) });
}

/**
 * A sum of figures: the sources of every part, the oldest of their times, the least live of their
 * labels, the age of the stalest part, and the sum's own method, which says what was added.
 */
export const sumPin: (parts: readonly PinSource[], method: string) => PinSource = sumSource;

/**
 * A point of a vault's history: the series says where its reads came from and how once, and a point
 * only where it differs. The label is the chain's, which is on every figure under it.
 */
export function pointPin(
  series: Pick<HistorySeries, 'source' | 'method'>,
  point: Pick<HistoryPoint, 'observedAt' | 'source' | 'method'>,
  chain: Provenance,
): PinSource {
  return {
    source: point.source ?? series.source,
    fetchedAt: point.observedAt,
    method: point.method ?? series.method,
    provenance: chain,
  };
}

/**
 * A rebalance entry's own stamp: the quote of a step of the owner's, or what an entry worked out from
 * snapshots stands on. A trade's reference price has its own (`pricePin`).
 */
export const entryPin = (entry: RebalanceEntry, chain: Provenance): PinSource =>
  sourcedPin(entry, chain);

/**
 * A chain's sums of holdings. Null where no snapshot stands behind them: the answer then gives no
 * time, and there is no figure to pin.
 */
export function exposurePin(
  chain: Pick<ExposureChain, 'source' | 'method' | 'observedAt' | 'provenance'>,
): PinSource | null {
  if (chain.observedAt === null) return null;
  return {
    source: chain.source,
    fetchedAt: chain.observedAt,
    method: chain.method,
    provenance: chain.provenance,
  };
}

/**
 * What selling a holding would cost, as Bearing measured it. Null where the measurement lacks its
 * source, its time, its method or its label, which the answer leaves out and never makes up: the cost
 * then has no pin, and is not shown as a figure. The label is never more live than the chain the
 * holding is on.
 */
export function exitPin(exit: ExposureExit, chain: Provenance): PinSource | null {
  const { source, method, fetchedAt, provenance } = exit;
  if (
    source === undefined ||
    method === undefined ||
    fetchedAt === undefined ||
    provenance === undefined
  )
    return null;
  return { source, fetchedAt, method, provenance: leastLive(provenance, chain) };
}
