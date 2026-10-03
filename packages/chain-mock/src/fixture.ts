import type { ChainId, Recipe } from '@colosseum/schemas';
import { createMockAdapter, type MockAdapter } from './adapter';
import type { ContractFixture } from './contract';
import { mockAddress, mockRecipeId, sha256Hex } from './ids';

// A small world on the mock for the contract tests. One owner publishes two shared portfolios and opens
// three vaults:
//   vault          follows the first with auto-follow on; holds cash and one asset.
//   manualVault    its own targets, auto-follow off, follows nothing.
//   newAssetVault  follows the second with auto-follow on, one version behind: the active version adds
//                  an asset, and a further version is published and not yet in effect.

const FAMILY = 'ab'.repeat(32);
const NEW_ASSET_FAMILY = 'cd'.repeat(32);
const usd = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString();

export type MockFixture = ContractFixture & { adapter: MockAdapter };

export async function mockFixture(
  chain: ChainId,
  opts: { newVersion: boolean } = { newVersion: true },
): Promise<MockFixture> {
  const adapter = createMockAdapter({ chain });
  const { mock } = adapter;
  const notBefore = new Date(mock.now() * 1000).toISOString();
  const owner = mockAddress(chain, 'owner');
  const recipe = (familyId: string, weights: Record<string, number>): Recipe => ({
    schemaVersion: 1,
    familyId,
    chain,
    onchainId: null,
    creator: owner,
    kind: 'community',
    version: 1,
    effectiveAt: 0,
    components: Object.entries(weights).map(([slug, weightBps]) => ({
      kind: 'asset',
      asset: `${chain}:${slug}`,
      weightBps,
    })),
    metaHash: sha256Hex(`mock family ${familyId}`),
    maxFeeBps: 0,
    flags: 0,
  });
  const send = async (tx: Promise<Parameters<typeof mock.send>[0]>) => mock.send(await tx);
  // An approval names the plan: it goes to the factory before the plan's vault exists, to the vault after.
  const approve = async (basketId: string, dollars: number) => {
    if (!adapter.capabilities.needsApprove) return;
    await send(adapter.buildApprove({ owner, basketId, amountRaw: usd(dollars) }));
  };
  const publish = (familyId: string, weights: Record<string, number>) =>
    send(adapter.buildPublishRecipe({ creator: owner, recipe: recipe(familyId, weights) }));
  const open = async (basketId: string, dollars: number, follow?: string) => {
    await send(
      adapter.buildCreateVault({
        owner,
        basketId,
        targets: follow
          ? []
          : [
              { asset: `${chain}:spy`, weightBps: 6000 },
              { asset: `${chain}:gold`, weightBps: 4000 },
            ],
        ...(follow ? { recipeOnchainId: follow, expectedVersion: 1 } : {}),
        autoFollow: Boolean(follow),
        depositRaw: usd(dollars),
        slippageBps: 100,
      }),
    );
    const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    if (!vault) throw new Error('the mock did not open the vault');
    return vault.address;
  };

  mock.fund(owner, { gasRaw: '1000000000000000000', assets: { [mock.cash]: usd(10_000) } });
  await publish(FAMILY, { spy: 5000, nvda: 3000, gold: 2000 });
  await publish(NEW_ASSET_FAMILY, { spy: 5000, nvda: 3000, gold: 2000 });
  const recipeOnchainId = mockRecipeId(chain, owner, FAMILY);
  const newAssetRecipeId = mockRecipeId(chain, owner, NEW_ASSET_FAMILY);

  // The three vaults are opened through the factory, which takes the cash of each from one approval.
  await approve('1', 1600);
  const vault = await open('1', 1000, recipeOnchainId);
  const manualVault = await open('2', 500);
  const newAssetVault = await open('3', 100, newAssetRecipeId);
  const buySpy = { sell: mock.cash, buy: `${chain}:spy`, amountInRaw: usd(300) };
  await send(adapter.buildOwnerSwap({ vault, trades: [buySpy], slippageBps: 100 }));

  // An author publishes one version per publish delay (300 seconds on the mock), so the clock moves on
  // before each later version.
  mock.advance(300);
  if (opts.newVersion) await publish(FAMILY, { spy: 4000, nvda: 4000, gold: 2000 });
  await publish(NEW_ASSET_FAMILY, { spy: 4000, nvda: 3000, gold: 2000, tsla: 1000 });
  mock.advance(301);
  await publish(NEW_ASSET_FAMILY, { spy: 4000, nvda: 2500, gold: 2000, tsla: 1500 });
  // What the contract cases deposit: twice into the first vault, once into the second, once into a new one.
  await approve('1', 2000);
  await approve('2', 1000);
  await approve('7', 1000);

  // One hundredth of a token of SPY, which is under its target: selling it moves away.
  const spy = (await adapter.listAssets()).find((x) => x.id === `${chain}:spy`);
  const aLittleSpy = (10n ** BigInt((spy?.decimals ?? 2) - 2)).toString();

  return {
    adapter,
    send: (tx) => mock.send(tx),
    sign: async (tx) => mock.sign(tx),
    provenance: 'mock',
    notBefore,
    quoteSlippageBps: mock.quoteSlippageBps,
    owner,
    stranger: mockAddress(chain, 'stranger'),
    vault,
    recipeOnchainId,
    adoptable: opts.newVersion,
    manualVault,
    newAssetVault,
    newAssetRecipeId,
    freshBasketId: '7',
    depositRaw: usd(1000),
    ownerTrade: { sell: mock.cash, buy: `${chain}:spy`, amountInRaw: usd(50) },
    keeperTrade: { sell: mock.cash, buy: `${chain}:nvda`, amountInRaw: usd(100) },
    awayTrade: { sell: `${chain}:spy`, buy: mock.cash, amountInRaw: aLittleSpy },
    publishRecipe: recipe(FAMILY, { spy: 3000, nvda: 5000, gold: 2000 }),
    unknownTxId: mockAddress(chain, 'never sent'),
  };
}
