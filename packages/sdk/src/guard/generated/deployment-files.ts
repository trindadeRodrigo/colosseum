// Generated from packages/sdk/deployments/*.json by packages/sdk/scripts/gen-guard-tables.ts.
// Do not edit: run `pnpm --filter @colosseum/sdk tables`. tables.test.ts fails when this file and its source disagree.
import { deepFreeze } from '../strict';

/** One file per network, as committed, and frozen. `deploymentsOf` reads and checks them, and nothing else. */
export const DEPLOYMENT_FILES: Readonly<Record<string, unknown>> = deepFreeze({
  mock: {
    format: 'guard-deployment/1',
    network: 'mock',
    chains: {
      solana: {
        family: 'mock',
        cash: 'solana:usdc',
        cashDecimals: 6,
      },
      robinhood: {
        family: 'mock',
        cash: 'robinhood:usdc',
        cashDecimals: 6,
      },
      base: {
        family: 'mock',
        cash: 'base:usdc',
        cashDecimals: 6,
      },
    },
  },
  testnet: {
    format: 'guard-deployment/1',
    network: 'testnet',
    chains: {
      solana: {
        family: 'solana',
        program: '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        router: '2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f',
        cash: 'solana:usdc',
        assets: {
          'solana:usdc': {
            mint: 'AEtFZt8Fq4PYzBs4d8VoMypDDhjp9XTv6qvhJZhd8BUn',
            tokenProgram: 'token',
            decimals: 6,
          },
          'solana:spyx': {
            mint: 'J5d882iVcofnjkud99LzTcVryPdS8d9BUpH7eBcypeyk',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:qqqx': {
            mint: 'HLnfGWv3cxjT3s5816Ri1Z1eB7o21Z9P5UmJatLUQUoa',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:nvdax': {
            mint: '6sgytf7j8TMxhsiW7sxuSSTp8xzusV1egyHFV5BABYVr',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:tslax': {
            mint: 'CNJDWe13sZdiF3JeN7URGf95hEndAnMNtXL55hU66uHH',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:aaplx': {
            mint: '92KZfnfaXowGwMiFdsMBkL3uunussnDRo36T3XGyF34w',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:googlx': {
            mint: '7a5idDoB2FXwbfcVRPxQDFpWdndmX75h8ZDkos2i4yfW',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:metax': {
            mint: '6KakiyUtqejgFjJp4mAmadpMmaoVho62uSgVVtMdiph6',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:mstrx': {
            mint: 'Fap4HtxGsMPKsc5aK3RmChvpkx5D2nUgkhryBr69TXxV',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:crclx': {
            mint: '3yitbppTKKnVoCpmLnwC3S6M3mTBxEs1H8AJJaqgA9fv',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:hoodx': {
            mint: '5rbr2wh5BZBUYsJCkTFRiNznu7DQDh1NPRWJW7REUHnb',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:gldx': {
            mint: '32BAoiuKWNj8yzeEarBF52pdLbY3umSmreMqNFPHieiE',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:jlusdc': {
            mint: 'GV49vP3U5XVbHJxT8vpDNTDZZWAKUtbFm8jHjzd6LUuc',
            tokenProgram: 'token',
            decimals: 6,
          },
          'solana:syrupusdc': {
            mint: 'GWFDMf5L2mCy6Z6v7fwPaavigDKeg8nkrg9xRCha4gAe',
            tokenProgram: 'token',
            decimals: 6,
          },
        },
      },
    },
  },
});
