import { isStalePrice, type Price } from '@colosseum/schemas';
import type { PinSource } from './provenance';

// What a screen hands the pin for a price. A separate module from provenance.ts, which the pin's
// client component imports: this one brings the shared schemas with it, so only the screens that
// show a price load it.

/**
 * A price states its own staleness: its age on the chain's clock (`ageSeconds`) and the oldest the
 * chain's vault accepts (`maxAgeSeconds`), compared by `isStalePrice` (DESIGN-VAULT 3.1). So the age
 * the pin is handed is the price's own age when the price is stale, and nothing when it is fresh.
 * No clock is read here and nothing is worked out from `fetchedAt`.
 *
 * A yield, a quote or a preview carries no age yet (`Sourced` has no staleness field), so it is
 * handed to the pin as it is and is never drawn stale.
 */
export function pinSourceOfPrice(
  price: Pick<Price, keyof PinSource & keyof Price> & Pick<Price, 'ageSeconds' | 'maxAgeSeconds'>,
): PinSource {
  return {
    source: price.source,
    fetchedAt: price.fetchedAt,
    method: price.method,
    provenance: price.provenance,
    staleAgeSec: isStalePrice(price) ? price.ageSeconds : null,
  };
}
