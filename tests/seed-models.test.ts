import { isEligible, isExecutable, REGISTRY_BY_ID } from '@colosseum/engine';
import { Asset, Profile } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { MODEL_ASSETS } from '../scripts/seed-models';

// `pnpm db:seed` writes an `assets` row for each mainnet token a test network's stand-in models and the
// registry does not hold (gate ENG-DEVNET-EXIT-TWIN), so its yield has an asset to be read under. The
// row offers nothing to a plan. No network, no database.

describe('the model rows of the seed', () => {
  it('are jlUSDC, a valid asset the registry does not hold', () => {
    expect(MODEL_ASSETS.map((a) => [a.id, a.symbol, a.chain])).toEqual([
      ['jlusdc', 'jlUSDC', 'solana'],
    ]);
    for (const a of MODEL_ASSETS) {
      expect(() => Asset.parse(a)).not.toThrow();
      expect(REGISTRY_BY_ID.has(a.id)).toBe(false);
      expect(a.provenance).toBe('live');
    }
  });

  it('offer nothing to a plan: no profile, no cap, no way to buy', () => {
    for (const a of MODEL_ASSETS) {
      for (const p of Profile.options) expect(isEligible(a, p), `${a.id} ${p}`).toBe(false);
      expect(isExecutable(a)).toBe(false);
      expect(a.capWeight).toBe(0);
    }
  });
});
