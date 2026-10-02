/**
 * Round trip and net return (PLAN-ANALYTICS §5, method facts-0.1). Pure arithmetic over costs the curves give;
 * nothing here is a forecast. Costs are fractions of the traded notional and already hold the pool fee, the
 * token's transfer fee and the price impact (PLAN-RISK §4 "Cost"). The network fee and any platform fee are
 * passed in, because the curves do not hold them.
 */

/** Dollars lost on one trade of `notionalUsd` at `cost`, plus the fees charged outside the pools. */
export function lossUsd(
  notionalUsd: number,
  cost: number,
  fees: { networkFeeUsd?: number; platformFeeBps?: number } = {},
): number {
  return (
    notionalUsd * cost +
    (fees.networkFeeUsd ?? 0) +
    (notionalUsd * (fees.platformFeeBps ?? 0)) / 10_000
  );
}

/** Share of the money lost entering at `entryCost` and exiting at `exitCost` with no price change. */
export const roundTripCost = (entryCost: number, exitCost: number): number =>
  1 - (1 - entryCost) * (1 - exitCost);

/**
 * Return kept after entering and exiting, for a gross return `gross` of the asset over the holding period.
 * `fixedFeesShare` is every fixed dollar fee (network, platform) over the entry notional.
 */
export const netReturn = (
  gross: number,
  entryCost: number,
  exitCost: number,
  fixedFeesShare = 0,
): number => (1 - entryCost) * (1 + gross) * (1 - exitCost) - 1 - fixedFeesShare;

/** Gross return that leaves the holder exactly where they started. */
export const breakEvenReturn = (entryCost: number, exitCost: number, fixedFeesShare = 0): number =>
  (1 + fixedFeesShare) / ((1 - entryCost) * (1 - exitCost)) - 1;

/** The round-trip cost as a yearly rate, for a position held `holdingDays` and rolled at the same cost. */
export function annualCostDrag(entryCost: number, exitCost: number, holdingDays: number): number {
  if (!(holdingDays > 0)) return Number.NaN;
  return 1 - (1 - roundTripCost(entryCost, exitCost)) ** (365 / holdingDays);
}

export type CostAt = (notionalUsd: number) => number | null;

/**
 * Net return when the exit is priced at the size the position has grown (or shrunk) to: enter `notionalUsd`
 * at `entryCostAt`, hold through `gross`, exit what is then held at `exitCostAt`. Null when either curve
 * does not measure its size; the caller reports which (`missing`).
 */
export function netReturnAtSize(inp: {
  notionalUsd: number;
  gross: number;
  entryCostAt: CostAt;
  exitCostAt: CostAt;
  networkFeeUsd?: number;
  platformFeeBps?: number;
}): {
  net: number | null;
  breakEven: number | null;
  entryCost: number | null;
  exitCost: number | null;
  exitNotionalUsd: number | null;
  lossUsd: number | null;
  missing: 'entry' | 'exit' | null;
} {
  const none = { net: null, breakEven: null, exitCost: null, exitNotionalUsd: null, lossUsd: null };
  const cIn = inp.entryCostAt(inp.notionalUsd);
  if (cIn === null) return { ...none, entryCost: null, missing: 'entry' };
  const exitNotionalUsd = inp.notionalUsd * (1 - cIn) * (1 + inp.gross);
  const cOut = inp.exitCostAt(exitNotionalUsd);
  if (cOut === null) return { ...none, entryCost: cIn, exitNotionalUsd, missing: 'exit' };
  const fees = { networkFeeUsd: inp.networkFeeUsd, platformFeeBps: inp.platformFeeBps };
  // fixed fees: charged once on the way in and once on the way out
  const fixedUsd = lossUsd(inp.notionalUsd, 0, fees) + lossUsd(exitNotionalUsd, 0, fees);
  const fixedShare = fixedUsd / inp.notionalUsd;
  return {
    net: netReturn(inp.gross, cIn, cOut, fixedShare),
    breakEven: breakEvenReturn(cIn, cOut, fixedShare),
    entryCost: cIn,
    exitCost: cOut,
    exitNotionalUsd,
    lossUsd: inp.notionalUsd * cIn + exitNotionalUsd * cOut + fixedUsd,
    missing: null,
  };
}
