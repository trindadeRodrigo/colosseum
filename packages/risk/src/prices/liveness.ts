import { etParts, type RegimeParams, regimeAt } from '../time';
import type { PriceObservation } from './observation';

/**
 * Step 11 — is a stock oracle pricing the stock? A lending venue can list a reserve before its feed is live: klend
 * logged `Price: 1.0000` for METAx and CRCLx on every refresh from 2025-07-29 to 2026-02-11 (Step 11 item 2).
 * Such a price is what the venue acts on, so it stays an observation, but it is not a valuation.
 *
 * The rule looks only at the prices themselves, one US trading day at a time (ET dates, in order), and only at
 * the observations made during US market hours:
 *   live      the price took at least two values that day, or its one value differs from the last market-hours
 *             price of an earlier day (a series with one observation a day still moves from day to day)
 *   frozen    at least `minFrozenObs` observations spanning at least `minFrozenSpanSec`, all at one price that
 *             has not moved since the day before. A day is only judged frozen once enough of it has passed, so
 *             the first half hour of a session cannot freeze it.
 *   unknown   anything else (weekends, holidays, days with few observations): the previous day's state holds
 * A series starts as not live. On the day it turns live, observations count from the first change of price.
 * Use it on one asset, source and quote at a time, and only for assets tied to the US session.
 */
export type LivenessParams = { minFrozenObs: number; minFrozenSpanSec: number };
export const defaultLivenessParams = (): LivenessParams => ({
  minFrozenObs: 6,
  minFrozenSpanSec: 3 * 3600,
});

export type Liveness = {
  /** One flag per observation, in the order given. */
  live: boolean[];
  /** ET dates judged frozen. */
  frozenDays: string[];
  /** Time of the first live observation, or null. */
  liveFrom: number | null;
};

/** `obs` must be sorted by time. */
export function markLiveness(
  obs: readonly PriceObservation[],
  rp: RegimeParams,
  p: LivenessParams,
): Liveness {
  const live = new Array<boolean>(obs.length).fill(false);
  const frozenDays: string[] = [];
  let state = false;
  /** The last market-hours price of an earlier day. */
  let lastOpen: number | null = null;
  let i = 0;
  while (i < obs.length) {
    const date = etParts(new Date((obs[i] as PriceObservation).t * 1000)).date;
    let j = i;
    const open: PriceObservation[] = [];
    while (
      j < obs.length &&
      etParts(new Date((obs[j] as PriceObservation).t * 1000)).date === date
    ) {
      const o = obs[j] as PriceObservation;
      if (regimeAt(new Date(o.t * 1000), rp) === 'us_market_hours') open.push(o);
      j++;
    }
    const prices = new Set(open.map((o) => o.price));
    const moved =
      prices.size >= 2 || (prices.size === 1 && lastOpen !== null && !prices.has(lastOpen));
    const span = open.length
      ? (open.at(-1) as PriceObservation).t - (open[0] as PriceObservation).t
      : 0;
    if (moved) {
      let from = i;
      if (!state) {
        // not live until the price first moves that day
        from = j;
        for (let k = Math.max(i, 1); k < j; k++)
          if ((obs[k] as PriceObservation).price !== (obs[k - 1] as PriceObservation).price) {
            from = k;
            break;
          }
      }
      for (let k = from; k < j; k++) live[k] = true;
      state = true;
    } else if (open.length >= p.minFrozenObs && span >= p.minFrozenSpanSec) {
      frozenDays.push(date);
      state = false;
    } else if (state) {
      for (let k = i; k < j; k++) live[k] = true;
    }
    if (open.length) lastOpen = (open.at(-1) as PriceObservation).price;
    i = j;
  }
  const first = live.indexOf(true);
  return { live, frozenDays, liveFrom: first < 0 ? null : (obs[first] as PriceObservation).t };
}
