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
          'solana:paxg': {
            mint: 'GZ2F1ryu8SgCGKhScVQLXzG5Q5Hp4NYocKd2F7ueeKh1',
            tokenProgram: 'token-2022',
            decimals: 6,
          },
          'solana:gldx': {
            mint: '32BAoiuKWNj8yzeEarBF52pdLbY3umSmreMqNFPHieiE',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
        },
      },
      robinhood: {
        family: 'evm',
        evmChainId: 46630,
        factory: '0xa3309dc51b41e55fcd48b12377025cd2ba4d21a4',
        beacon: '0x4c6699623966be46a40844da3e79d7da3d8d3d96',
        routers: ['0xd290cfe0738e1ab9cea9dc138bbec024dc3bd127'],
        cash: 'robinhood:tusdg',
        assets: {
          'robinhood:tusdg': {
            address: '0xd3d6e7bf284d922651983468b75492be4f3f689a',
            decimals: 6,
          },
          'robinhood:tspy': {
            address: '0xb4e18cbb171bdd09e69255e69f94aaf081e943ad',
            decimals: 18,
          },
          'robinhood:tqqq': {
            address: '0xd2589158fde964d7a6fea7918568aaa1a6b6283f',
            decimals: 18,
          },
          'robinhood:tnvda': {
            address: '0x92c47af3a0878f360106db7b79b0ca9c32f0c4fd',
            decimals: 18,
          },
          'robinhood:taapl': {
            address: '0x8fdea72a9d0fb5c21364d6ac4cc8544beb84b9fc',
            decimals: 18,
          },
          'robinhood:tmsft': {
            address: '0x5d7f0011031cdb8fa954d451c3348a96e10a23f0',
            decimals: 18,
          },
          'robinhood:tgoogl': {
            address: '0xb4c3e6dd28c98c8c0f27b3db2f77cc4d257297d5',
            decimals: 18,
          },
          'robinhood:tamzn': {
            address: '0x837a0b2aacedef3ed3d4bec19be3c5bc0873185b',
            decimals: 18,
          },
          'robinhood:tmeta': {
            address: '0x872ba0c735b0c41c43d8881bce2ef1deccd6bc69',
            decimals: 18,
          },
          'robinhood:ttsla': {
            address: '0x9f8c39aff46ce9d06dd4b1c31107761f7f2d9796',
            decimals: 18,
          },
          'robinhood:tgld': {
            address: '0xb3fc39f47282ef0a9e2451ba406f04074d27c425',
            decimals: 18,
          },
          'robinhood:tsgov': {
            address: '0xb68427c11ecd92eaefa0f44ed87071f38e2ac216',
            decimals: 18,
          },
        },
        fee: {
          maxFeeNativeRaw: '1000000000000000',
          maxGas: 5000000,
        },
      },
    },
  },
});
