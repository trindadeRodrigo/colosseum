import { etParts, type RegimeParams, regimeAt } from '../time';
import type { PriceObservation } from './observation';

/**
 * Step 11 — is a stock oracle pricing the stock? A lending venue can list a reserve before its feed is live: klend
 * logged `Price: 1.0000` for METAx and CRCLx on every refresh from 2025-07-29 to 2026-02-11 (Step 11 item 2).
 * Such a price is what the venue acts on, so it stays an observation, but it is not a valuation.
 *
 * The rule looks only at the prices themselves, one US trading day at a time (ET dates, in order):
 *   live      the price took at least two values during US market hours
 *   frozen    at least `minFrozenObs` observations during US market hours, all at one price
 *   unknown   anything else (weekends, holidays, days with few observations): the previous day's state holds
 * A series starts as not live. On the day it turns live, observations count from the first change of price.
 * Use it on one asset, source and quote at a time, and only for assets tied to the US session.
 */
export type LivenessParams = { minFrozenObs: number };
export const defaultLivenessParams = (): LivenessParams => ({ minFrozenObs: 6 });

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
  let i = 0;
  while (i < obs.length) {
    const date = etParts(new Date((obs[i] as PriceObservation).t * 1000)).date;
    let j = i;
    const open: number[] = [];
    while (
      j < obs.length &&
      etParts(new Date((obs[j] as PriceObservation).t * 1000)).date === date
    ) {
      const o = obs[j] as PriceObservation;
      if (regimeAt(new Date(o.t * 1000), rp) === 'us_market_hours') open.push(o.price);
      j++;
    }
    if (new Set(open).size >= 2) {
      let from = i;
      if (!state) {
        // not live until the price first moves that day
        from = j;
        for (let k = i; k < j; k++)
          if (
            k > 0 &&
            (obs[k] as PriceObservation).price !== (obs[k - 1] as PriceObservation).price
          ) {
            from = k;
            break;
          }
      }
      for (let k = from; k < j; k++) live[k] = true;
      state = true;
    } else if (open.length >= p.minFrozenObs) {
      frozenDays.push(date);
      state = false;
    } else if (state) {
      for (let k = i; k < j; k++) live[k] = true;
    }
    i = j;
  }
  const first = live.indexOf(true);
  return { live, frozenDays, liveFrom: first < 0 ? null : (obs[first] as PriceObservation).t };
}
