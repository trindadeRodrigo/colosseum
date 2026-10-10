import type { Trade, TradeExpected } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n';
import { formatBps, formatRaw, shortfallBps, tokenName } from './amounts';
import type { ChainUnits } from './units';

// One trade of a step as a person reads it before signing. A trade has two sides and either may be
// the chain's cash: a purchase spends cash on an asset, a sale turns an asset into cash, and a change
// of targets does both in one step. Each side is written with its own token's decimals and name, from
// the units this repository committed, and the figures are the ones the guard holds the bytes to:
// `amountInRaw` of `sell` going in, and at least `minOutRaw` of `buy` coming out.

/** A price each that means something: above zero, finite, and not a dust amount's. */
function priceEach(
  cashRaw: string,
  cashDecimals: number,
  tokenRaw: string,
  tokenDecimals: number,
): number | null {
  const cash = Number(cashRaw) / 10 ** cashDecimals;
  const tokens = Number(tokenRaw) / 10 ** tokenDecimals;
  if (!(cash > 0) || !(tokens > 0)) return null;
  const price = cash / tokens;
  return Number.isFinite(price) && price > 0 && price < 1e9 ? price : null;
}

export function tradeLine({
  trade,
  expected,
  units,
  t,
  locale,
  money,
}: {
  trade: Trade;
  /** The quote the step was shown with, where it has one. */
  expected: TradeExpected | undefined;
  units: ChainUnits | null;
  t: Dictionary;
  locale: string;
  /** A dollar figure in the language of the page. */
  money: (value: number) => string;
}): string {
  const r = t.order.review;
  const unitsOf = (asset: string) => units?.tokens[asset];
  /** A raw amount of a token in whole units with its symbol, or null when its units are not known. */
  const whole = (raw: string, asset: string) => {
    const u = unitsOf(asset);
    const figure = u ? formatRaw(raw, u.decimals, locale) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : null;
  };
  const symbol = (asset: string) => unitsOf(asset)?.symbol ?? tokenName(asset);
  const spendsCash = units === null || trade.sell === units.cash;
  const cash = units ? unitsOf(units.cash) : undefined;

  // What goes in. A purchase is said as before: cash spent on an asset. Anything else is a sale of
  // what the vault holds, in that token's own units.
  const head = spendsCash
    ? r.spend(
        (units ? whole(trade.amountInRaw, units.cash) : null) ?? trade.amountInRaw,
        symbol(trade.buy),
      )
    : whole(trade.amountInRaw, trade.sell) !== null
      ? r.sell(whole(trade.amountInRaw, trade.sell) as string)
      : // no raw count of a token this app has no units for: it would read as billions
        r.sellUnnamed(symbol(trade.sell));
  if (!expected) return head;

  const under = shortfallBps(expected.outRaw, expected.minOutRaw);
  const least = whole(expected.minOutRaw, trade.buy);
  // Where this app has no units for what comes out, how far under the quote it may land and no
  // figure it cannot name (the flow audit, finding 23).
  if (least === null)
    return under === null ? head : `${head} · ${r.atMostUnder(formatBps(under, locale))}`;

  const sold = unitsOf(trade.sell);
  const bought = unitsOf(trade.buy);
  let each = '';
  if (cash && units && trade.sell === units.cash && bought) {
    // the most one token costs when the least is received
    const price = priceEach(trade.amountInRaw, cash.decimals, expected.minOutRaw, bought.decimals);
    if (price !== null) each = ` (${r.atMostEach(money(price))})`;
  } else if (cash && units && trade.buy === units.cash && sold) {
    // the least one token sold brings in
    const price = priceEach(expected.minOutRaw, cash.decimals, trade.amountInRaw, sold.decimals);
    if (price !== null) each = ` (${r.atLeastEach(money(price))})`;
  }
  return `${head} · ${r.atLeastWhole(least)}${each}${
    under === null ? '' : ` · ${r.under(formatBps(under, locale))}`
  }`;
}
