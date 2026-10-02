import type { ChainId, Recipe } from '@colosseum/schemas';
import { createMockAdapter, type MockAdapter } from './adapter';
import type { ContractFixture } from './contract';
import { mockAddress, mockRecipeId, sha256Hex } from './ids';

// A small world on the mock for the contract tests: a funded owner who published a shared portfolio,
// opened a vault that follows it with auto-follow on, and bought one asset.

const FAMILY_ID = 'ab'.repeat(32);
const CASH_1000 = '1000000000';

export type MockFixture = ContractFixture & { adapter: MockAdapter };

export async function mockFixture(
  chain: ChainId,
  opts: { newVersion: boolean } = { newVersion: true },
): Promise<MockFixture> {
  const adapter = createMockAdapter({ chain });
  const { mock } = adapter;
  const owner = mockAddress(chain, 'owner');
  const recipe = (spy: number, nvda: number, gold: number): Recipe => ({
    schemaVersion: 1,
    familyId: FAMILY_ID,
    chain,
    onchainId: null,
    creator: owner,
    kind: 'community',
    version: 1,
    effectiveAt: 0,
    components: [
      { kind: 'asset', asset: `${chain}:spy`, weightBps: spy },
      { kind: 'asset', asset: `${chain}:nvda`, weightBps: nvda },
      { kind: 'asset', asset: `${chain}:gold`, weightBps: gold },
    ],
    metaHash: sha256Hex('mock family'),
    maxFeeBps: 0,
    flags: 0,
  });
  const approve = async () => {
    if (!adapter.capabilities.needsApprove) return;
    const spender = mock.addresses.factory;
    await mock.send(await adapter.buildApprove({ owner, spender, amountRaw: CASH_1000 }));
  };

  mock.fund(owner, { gasRaw: '1000000000000000000', assets: { [mock.cash]: '10000000000' } });
  await mock.send(
    await adapter.buildPublishRecipe({ creator: owner, recipe: recipe(5000, 3000, 2000) }),
  );
  const recipeOnchainId = mockRecipeId(chain, owner, FAMILY_ID);
  await approve();
  await mock.send(
    await adapter.buildCreateVault({
      owner,
      basketId: '1',
      targets: [],
      recipeOnchainId,
      expectedVersion: 1,
      autoFollow: true,
      depositRaw: CASH_1000,
      slippageBps: 100,
    }),
  );
  const vault = (await adapter.getVaults(owner))[0]?.address;
  if (!vault) throw new Error('the mock did not open the vault');
  const buySpy = { sell: mock.cash, buy: `${chain}:spy`, amountInRaw: '300000000' };
  await mock.send(await adapter.buildOwnerSwap({ vault, trades: [buySpy], slippageBps: 100 }));
  if (opts.newVersion) {
    await mock.send(
      await adapter.buildPublishRecipe({ creator: owner, recipe: recipe(4000, 4000, 2000) }),
    );
    mock.advance(301);
  }
  await approve();

  return {
    adapter,
    provenance: 'mock',
    owner,
    stranger: mockAddress(chain, 'stranger'),
    vault,
    recipeOnchainId,
    adoptable: opts.newVersion,
    freshBasketId: '7',
    spender: mock.addresses.factory,
    depositRaw: CASH_1000,
    ownerTrade: { sell: mock.cash, buy: `${chain}:spy`, amountInRaw: '50000000' },
    keeperTrade: { sell: mock.cash, buy: `${chain}:nvda`, amountInRaw: '100000000' },
    publishRecipe: recipe(3000, 5000, 2000),
    unknownTxId: mockAddress(chain, 'never sent'),
  };
}
