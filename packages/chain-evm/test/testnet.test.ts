import { adapterContract, type ContractFixture } from '@colosseum/chain-mock/contract';
import { isStalePrice } from '@colosseum/schemas';
import { afterAll, describe, vi } from 'vitest';
import {
  ACCOUNTS,
  buildTestnetWorld,
  DEPOSIT_RAW,
  id,
  STRANGER,
  type TestnetWorld,
} from './testnet-world';

// The EVM adapter whole (ADE-2) on a local copy of Robinhood Chain's test network (46630): the
// adapter contract of packages/chain-mock, all seven groups, against the factory, the registry, the
// Universal Router, the Uniswap v4 pools and the test tokens TNET-1 and TNET-2 deployed. Every vault
// and portfolio of the world is built by the adapter itself. Nothing is sent to the test network.
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run packages/chain-evm/test/testnet.test.ts
//
// The network's RPC keeps state for about a quarter of an hour, which is enough: the copy is made at
// its latest block. RH_TESTNET_FORK_PORT moves anvil off 28745. The keeper's cases need a weekday by
// UTC: the copy opens the session to the whole day, not the week.

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_FORK_PORT ?? 28_745);

let world: Promise<TestnetWorld> | undefined;
export const startTestnet = () => {
  world ??= buildTestnetWorld(FORK_URL ?? '', PORT);
  return world;
};

describe.skipIf(!FORK_URL)('on a copy of Robinhood Chain test network', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 180_000 });
  const notBefore = new Date().toISOString();
  afterAll(async () => (await world)?.stop());

  adapterContract(
    'robinhood adapter, copy of the test network',
    async (): Promise<ContractFixture> => {
      const w = await startTestnet();
      // The test network's prices are copied in by its price writer; one it has not copied for longer
      // than the vault accepts is stale on the copy too, and the reads are held to saying so.
      const ids = (await w.adapter.listAssets()).map((a) => a.id);
      const stale = (await w.adapter.getPrices(ids)).find((p) => isStalePrice(p));
      return {
        ...(stale ? { stalePriced: stale.asset } : {}),
        adapter: w.adapter,
        provenance: 'sandbox',
        notBefore,
        owner: ACCOUNTS.owner,
        stranger: STRANGER,
        vault: w.vault,
        manualVault: w.manualVault,
        newAssetVault: w.newAssetVault,
        depositRaw: DEPOSIT_RAW.toString(),
        unknownTxId: `0x${'11'.repeat(32)}`,
        send: w.send,
        sign: w.sign,
        withPriceMoved: w.withPriceMoved,
        quoteSlippageBps: 100,
        recipeOnchainId: w.recipeA,
        adoptable: false,
        newAssetRecipeId: w.recipeB,
        freshBasketId: '77',
        ownerTrade: { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '5000000' },
        keeperTrade: { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '2000000' },
        bandBps: 50,
        awayTrade: { sell: id('tqqq'), buy: id('tusdg'), amountInRaw: '1000000000000000' },
        publishRecipe: {
          schemaVersion: 1,
          familyId: w.familyA,
          chain: 'robinhood',
          onchainId: w.recipeA,
          creator: ACCOUNTS.owner,
          kind: 'community',
          version: 2,
          effectiveAt: 0,
          // In the order the registry keeps them, by token address: tNVDA, tSPY, tQQQ.
          components: [
            { kind: 'asset', asset: id('tnvda'), weightBps: 3500 },
            { kind: 'asset', asset: id('tspy'), weightBps: 3500 },
            { kind: 'asset', asset: id('tqqq'), weightBps: 3000 },
          ],
          metaHash: 'ab'.repeat(32),
          maxFeeBps: 0,
          flags: 0,
        },
      };
    },
  );
});
