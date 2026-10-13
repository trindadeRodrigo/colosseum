import { Asset } from '@colosseum/schemas';

// The `assets` rows of the mainnet tokens a test network's stand-ins model and the registry does not
// hold (gate ENG-DEVNET-EXIT-TWIN). No I/O: seed-assets.ts writes them. A row is there so the model's
// yield has an asset to be read under (`pnpm feeds:refresh-models`) and a stand-in can borrow it. It
// offers nothing to a plan, as the EVM stock rows do (gate EVM-ROWS): no eligible profile, cap 0, and
// no mint path, so no solver picks it and `feeds:refresh` reads it only as its own script says.

export const MODEL_ASSETS: Asset[] = [
  Asset.parse({
    id: 'jlusdc',
    symbol: 'jlUSDC',
    name: 'Jupiter Lend USDC (the model of the test-network tjlUSDC; offered to no plan here)',
    kind: 'usd_yield',
    chain: 'solana',
    mint: '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D',
    tokenProgram: 'token',
    decimals: 6,
    eligibleProfiles: [],
    capWeight: 0,
    mintPath: 'unavailable',
    metadata: {
      issuer: 'Jupiter Lend',
      creditExposure: 'a deposit in the Jupiter Lend liquidity layer, lent to its borrowers',
      oracle: 'the token accrues by its exchange price',
      redemptionPath: 'withdraw from Jupiter Lend while the layer has liquidity',
      redemptionTime: 'instant while the layer has liquidity; utilisation-gated',
      gates: [],
      docsUrl: 'https://jup.ag/lend',
    },
    provenance: 'live',
  }),
];
