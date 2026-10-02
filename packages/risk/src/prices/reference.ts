import type { Regime } from '../time';
import type { PriceSourceId } from './observation';
import {
  type PriceContext,
  type PriceIndex,
  type PriceNullReason,
  type PriceQuality,
  resolvePrice,
} from './resolve';

/**
 * Step 11 item 5 — the reference price of an asset at a time: the resolver's valuation in the shape that is
 * stored (`risk_reference_prices`), with every other source's price at that time kept beside it.
 */
export type ReferencePriceOther = {
  priceSource: PriceSourceId;
  priceUsd: number | null;
  /** The price as quoted and its quote token, when the source does not quote in USD. */
  price?: number;
  quote?: string;
  ref: string;
  ageSec: number;
  openAgeSec: number | null;
  sessionOpen: boolean | null;
  stale: boolean;
  live: boolean;
  gapToAnswer: number | null;
};

export type ReferencePrice = {
  mint: string;
  t: number;
  priceUsd: number | null;
  priceSource: PriceSourceId | 'par' | null;
  ref: string | null;
  quality: PriceQuality | null;
  regime: Regime;
  ageSec: number | null;
  obsT: number | null;
  nullReason: PriceNullReason | null;
  others: ReferencePriceOther[];
};

export function referencePrice(
  ix: PriceIndex,
  ctx: PriceContext,
  mint: string,
  t: number,
): ReferencePrice {
  const r = resolvePrice(ix, { mint, t, purpose: 'valuation' }, ctx);
  return {
    mint,
    t,
    priceUsd: r.priceUsd,
    priceSource: r.priceSource,
    ref: r.ref,
    quality: r.quality,
    regime: r.regime,
    ageSec: r.ageSec,
    obsT: r.obsT,
    nullReason: r.nullReason,
    others: r.others.map((c) => ({
      priceSource: c.priceSource,
      priceUsd: c.priceUsd,
      ...(c.quote === 'usd' ? {} : { price: c.price, quote: c.quote }),
      ref: c.ref,
      ageSec: c.ageSec,
      openAgeSec: c.openAgeSec,
      sessionOpen: c.sessionOpen,
      stale: c.stale,
      live: c.live,
      gapToAnswer: c.gapToAnswer,
    })),
  };
}

/** The reference price at every whole hour from `from` to `to` (Unix seconds, both rounded inward). */
export function* hourlyReferencePrices(
  ix: PriceIndex,
  ctx: PriceContext,
  mint: string,
  from: number,
  to: number,
): Generator<ReferencePrice> {
  for (let h = Math.ceil(from / 3600) * 3600; h <= to; h += 3600)
    yield referencePrice(ix, ctx, mint, h);
}
