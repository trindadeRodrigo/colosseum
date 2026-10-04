// Generated from packages/sdk/deployments/*.json by packages/sdk/scripts/gen-guard-tables.ts.
// Do not edit: run `pnpm --filter @colosseum/sdk tables`. tables.test.ts fails when this file and its source disagree.

/** One file per network, as committed. `deploymentsOf` reads and checks them. */
export const DEPLOYMENT_FILES: Readonly<Record<string, unknown>> = {
  mock: {
    format: 'guard-deployment/1',
    network: 'mock',
    chains: {
      solana: {
        family: 'mock',
        cash: 'solana:usdc',
      },
      robinhood: {
        family: 'mock',
        cash: 'robinhood:usdc',
      },
      base: {
        family: 'mock',
        cash: 'base:usdc',
      },
    },
  },
};
