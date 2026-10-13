import type { BasketAsset, YieldObservation } from '@colosseum/schemas';

// A token on a test network stands in for a mainnet token it models: tjlUSDC for jlUSDC, tsyrupUSDC
// for syrupUSDC. The key is the asset's `underlying`: on Solana, `deploymentAssets` sets it from the
// deploy record's `modelOf` without a trailing x (SPYx models SPY). It earns nothing, and no reading is
// stored under its mint. So that a plan on the test network is shaped as the mainnet plan would be, it
// takes the reading of the token it models, relabelled `sandbox`, with its source saying whose reading
// it is and that it is applied to a test token. The method is the reading's own, so the engine ranks
// readings as it would the model's (`pickPrimaryYield`), and so is the time. A rate is never made up: a model with no reading leaves the token without one,
// and the engine leaves it out (NO_YIELD).
//
// Only readings here: a test token's exit depth is carried over by model-exits.ts.

/** A stored reading of a live token, with the symbol and the chain of the token it was read for. */
export type ModelReading = { symbol: string; chain: string; reading: YieldObservation };

/**
 * The test-network tokens that take a model's reading: not cash, labelled sandbox, with no reading of
 * their own, on a chain that itself runs as a test network (its provenance `sandbox`, as for the exit
 * figures in model-exits.ts): a mock or a live chain's tokens borrow nothing.
 */
export function modelledTokens(
  assets: BasketAsset[],
  own: YieldObservation[],
  chainProvenance: string | undefined,
): BasketAsset[] {
  if (chainProvenance !== 'sandbox') return [];
  const read = new Set(own.map((y) => y.assetId));
  return assets.filter(
    (a) => a.provenance === 'sandbox' && a.cls !== 'cash' && a.underlying && !read.has(a.id),
  );
}

/**
 * Each model's live readings, as readings of the test tokens that model it on the same chain (Base's
 * SGOV is not Robinhood Chain's). A reading that is not
 * itself live is not passed on: a mock or a test figure is not a model's reading.
 */
export function modelYields(tokens: BasketAsset[], readings: ModelReading[]): YieldObservation[] {
  return tokens.flatMap((token) =>
    readings
      .filter(
        (r) =>
          r.symbol === token.underlying &&
          r.chain === token.chain &&
          r.reading.provenance === 'live',
      )
      .map(({ symbol, reading }) => ({
        ...reading,
        assetId: token.id,
        source: `${reading.source} (${symbol}'s reading, applied to ${token.symbol} on a test network)`,
        provenance: 'sandbox' as const,
      })),
  );
}
