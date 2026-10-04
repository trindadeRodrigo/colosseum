import type { ContractFixture } from '@colosseum/chain-mock/contract';
import {
  createSolanaVaultAdapter,
  exchangeAddress,
  recipeAddress,
  type SolanaVaultAdapter,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type VaultWriteRpc,
  vaultAddress,
} from '@colosseum/chain-solana/vault';
import {
  type AssetId,
  type BasketAsset,
  type BuiltTx,
  type ChainConfig,
  parseChainConfigs,
  type Recipe,
  type Trade,
} from '@colosseum/schemas';
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type IInstruction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from '@solana/kit';
import {
  createAccount,
  initAssets,
  initConfig,
  initMint,
  initPair,
  initRouter,
  MINT_BYTES,
  mintTo,
  type Params,
  type PriceEntry,
  setPairPrice,
  setPriceAccount,
  transferSol,
  upsertAsset,
} from './admin';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM } from './svm-node';

// The world the adapter contract asks for (packages/chain-mock/src/contract.ts, `ContractFixture`),
// made on a real copy of the program: the admin's set-up by hand, and everything an owner does through
// the adapter's own builders, signed here with keys made for the run. The same steps run in LiteSVM
// and on a local validator; only the clock differs: LiteSVM moves it at will, a validator is waited on.

export type Key = { pair: CryptoKeyPair; address: Address };
export const newKey = async (): Promise<Key> => {
  const pair = await generateKeyPair();
  return { pair, address: await getAddressFromPublicKey(pair.publicKey) };
};

/** What runs the transactions of the set-up and of the contract's sends. */
export type Ledger = {
  rpc: VaultWriteRpc;
  /**
   * Lands signed bytes as a wallet that sends with no preflight: a transaction that fails lands too.
   * Resolves once the chain has it.
   */
  land(tx: Transaction): Promise<{ signature: string; failed: boolean; logs: string[] }>;
  /** Moves the cluster's clock on by this many seconds: at once in LiteSVM, by waiting on a validator. */
  advance(seconds: number): Promise<void>;
  /** The cluster's clock. */
  now(): Promise<bigint>;
  /** Writes the price account again, stamped at `at`. Where the chain cannot, it was stamped ahead at start. */
  refreshPrices?(at: bigint): void;
};

export const PARAMS: Params = {
  toleranceBps: 75,
  lossCapBps: 100,
  bandBps: 50,
  twapDevBps: 200,
  // The most the program allows: a validator's prices are stamped once, at start.
  maxPriceAgeS: 600,
  assetCooldownS: 600,
  publishDelayS: 60,
  sessionOpenUtcS: 14 * 3_600 + 30 * 60,
  sessionCloseUtcS: 20 * 3_600,
};

export type MintName = 'cash' | 'alpha' | 'beta' | 'gamma' | 'delta';
type Shelf = {
  decimals: number;
  token2022: boolean;
  /** Dollars for one whole token, and where its entry and its one-hour average sit. */
  usd: number;
  index: number;
};
/** Round numbers, so nobody reads one as a market price. Beta is on Token-2022. */
export const SHELF: Record<MintName, Shelf> = {
  cash: { decimals: 6, token2022: false, usd: 1, index: 0 },
  alpha: { decimals: 8, token2022: false, usd: 50, index: 10 },
  beta: { decimals: 8, token2022: true, usd: 20, index: 20 },
  gamma: { decimals: 6, token2022: false, usd: 2, index: 30 },
  delta: { decimals: 8, token2022: false, usd: 10, index: 40 },
};
const ASSETS: Exclude<MintName, 'cash'>[] = ['alpha', 'beta', 'gamma', 'delta'];
export const id = (name: MintName): AssetId => `solana:${name}`;
const usdc = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

/** The price account's entries: each asset's price and its average, at exponent 8. */
export const PRICE_ENTRIES: PriceEntry[] = ASSETS.map((name) => ({
  index: SHELF[name].index,
  twapIndex: SHELF[name].index + 1,
  value: BigInt(SHELF[name].usd) * 100_000_000n,
  exponent: 8n,
}));

/** Raw units out for raw units in, at the shelf prices: `in × num / den`. */
function pairPrice(from: MintName, to: MintName): { num: bigint; den: bigint } {
  // out = in × 10^(dOut − dIn) × usdIn / usdOut
  const a = SHELF[from];
  const b = SHELF[to];
  let num = BigInt(a.usd);
  let den = BigInt(b.usd);
  const shift = b.decimals - a.decimals;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  return { num, den };
}

export type ContractWorld = {
  fixture: ContractFixture;
  adapter: SolanaVaultAdapter;
  config: ChainConfig;
  assets: BasketAsset[];
  keys: { deployer: Key; owner: Key; keeper: Key; guardian: Key };
  mints: Record<MintName, { address: Address; tokenProgram: Address }>;
  priceAccount: Address;
  /** Signs a built transaction with the key it names and hands back the bytes, as a wallet does. */
  sign(tx: BuiltTx): Promise<string>;
  /** Signs and lands a built transaction; throws if it failed. */
  must(tx: BuiltTx): Promise<string>;
  /** Signs instructions with keys and lands them; throws if they failed. */
  run(payer: Key, instructions: IInstruction[], others?: Key[]): Promise<string>;
};

const decoder = getTransactionDecoder();
const base58 = getBase58Decoder();

export async function buildContractWorld(
  ledger: Ledger,
  options: {
    deployer: Key;
    priceAccount: Address;
    /** Publish a version of the second portfolio that waits: only where the clock can be moved on. */
    pendingVersion: boolean;
    network: 'testnet' | 'local';
    notBefore: string;
  },
): Promise<ContractWorld> {
  const { rpc } = ledger;
  const { deployer, priceAccount } = options;
  const [owner, keeper, guardian, strangerKey] = await Promise.all([
    newKey(),
    newKey(),
    newKey(),
    newKey(),
  ]);
  const keys = new Map<string, Key>([owner, keeper, guardian, deployer].map((k) => [k.address, k]));

  const signed = async (tx: Transaction, signers: Key[]) =>
    partiallySignTransaction(
      signers.map((k) => k.pair),
      tx,
    );
  const run = async (payer: Key, instructions: IInstruction[], others: Key[] = []) => {
    const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const landed = await ledger.land(await signed(compileTransaction(message), [payer, ...others]));
    if (landed.failed) throw new Error(`a set-up transaction failed:\n${landed.logs.join('\n')}`);
    return landed.signature;
  };
  const signBuilt = async (tx: BuiltTx) => {
    const key = keys.get(tx.signer);
    if (!key) throw new Error(`the world holds no key for ${tx.signer}`);
    return signed(decoder.decode(new Uint8Array(Buffer.from(tx.payload, 'base64'))), [key]);
  };
  const must = async (tx: BuiltTx) => {
    const landed = await ledger.land(await signBuilt(tx));
    if (landed.failed) throw new Error(`${tx.description} failed:\n${landed.logs.join('\n')}`);
    return landed.signature;
  };

  // SOL for everyone who pays.
  await run(deployer, [
    transferSol(deployer.address, owner.address, 20_000_000_000n),
    transferSol(deployer.address, keeper.address, 2_000_000_000n),
  ]);

  // The mints, the deployer their issuer.
  const mints = {} as ContractWorld['mints'];
  for (const name of Object.keys(SHELF) as MintName[]) {
    const mint = await newKey();
    const tokenProgram = SHELF[name].token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const lamports = await rpc.getMinimumBalanceForRentExemption(MINT_BYTES).send();
    await run(
      deployer,
      [
        createAccount({
          payer: deployer.address,
          account: mint.address,
          lamports,
          space: MINT_BYTES,
          owner: tokenProgram,
        }),
        initMint({
          mint: mint.address,
          tokenProgram,
          decimals: SHELF[name].decimals,
          authority: deployer.address,
        }),
      ],
      [mint],
    );
    mints[name] = { address: mint.address, tokenProgram };
  }

  // The platform: Config, the asset list, every asset priced, switched on for the keeper, with a range a
  // fifth either side of its price, and always open (none of them is a stock).
  await run(deployer, [
    await initConfig({
      authority: deployer.address,
      guardian: guardian.address,
      keeper: keeper.address,
      router: MOCK_ROUTER_PROGRAM,
      priceOwner: MOCK_ROUTER_PROGRAM,
      cashMint: mints.cash.address,
      params: PARAMS,
    }),
    await initAssets(deployer.address),
    await setPriceAccount(deployer.address, 0, priceAccount),
  ]);
  for (const name of ASSETS)
    await run(deployer, [
      await upsertAsset(deployer.address, mints[name].address, {
        priceIndex: SHELF[name].index,
        twapIndex: SHELF[name].index + 1,
        keeperOn: true,
        minPrice: BigInt(SHELF[name].usd * 800_000),
        maxPrice: BigInt(SHELF[name].usd * 1_200_000),
      }),
    ]);

  // The test exchange: both directions of cash and each asset, at the shelf prices, and full reserves.
  await run(deployer, [await initRouter(deployer.address)]);
  for (const name of ASSETS) {
    const there = pairPrice('cash', name);
    const back = pairPrice(name, 'cash');
    await run(deployer, [
      await initPair(
        deployer.address,
        mints.cash.address,
        mints[name].address,
        there.num,
        there.den,
      ),
      await initPair(deployer.address, mints[name].address, mints.cash.address, back.num, back.den),
    ]);
  }
  const reserve = await exchangeAddress(MOCK_ROUTER_PROGRAM);
  for (const name of Object.keys(SHELF) as MintName[])
    await run(
      deployer,
      await mintTo({
        mint: mints[name].address,
        tokenProgram: mints[name].tokenProgram,
        holder: reserve,
        authority: deployer.address,
        amount: 10n ** BigInt(SHELF[name].decimals + 9),
      }),
    );
  await run(
    deployer,
    await mintTo({
      mint: mints.cash.address,
      tokenProgram: mints.cash.tokenProgram,
      holder: owner.address,
      authority: deployer.address,
      amount: usdc(10_000),
    }),
  );

  const config = parseChainConfigs(
    {
      CHAIN_NETWORK_SOLANA: options.network,
      CHAIN_ROUTER_SOLANA: MOCK_ROUTER_PROGRAM,
      CHAIN_PRICE_SOURCE_SOLANA: priceAccount,
    },
    { solana: { program: BASKET_PROGRAM } },
  ).solana;
  const assets: BasketAsset[] = (Object.keys(SHELF) as MintName[]).map((name) => ({
    id: id(name),
    chain: 'solana',
    address: mints[name].address,
    symbol: `t${name.toUpperCase()}`,
    decimals: SHELF[name].decimals,
    cls: name === 'cash' ? 'cash' : 'etf',
    underlying: name.toUpperCase(),
    issuer: 'test',
    tier: 'A',
    // Cash is a dollar and is never priced, as the vault counts it.
    priceKind: name === 'cash' ? 'none' : 'scope',
    priceRef: name === 'cash' ? '' : String(SHELF[name].index),
    session: 'always',
    autoFollowEligible: true,
    maxWeightBps: name === 'cash' ? 0 : 5_000,
    blockedCountries: [],
    sheet: 'test',
    provenance: 'sandbox',
  }));
  const adapter = createSolanaVaultAdapter({ config, rpc, assets, autoFollow: true });

  const recipe = (familyHex: string, version: number, weights: [MintName, number][]): Recipe => ({
    schemaVersion: 1,
    familyId: familyHex,
    chain: 'solana',
    onchainId: null,
    creator: owner.address,
    kind: 'community',
    version,
    effectiveAt: 0,
    components: weights.map(([name, weightBps]) => ({ kind: 'asset', asset: id(name), weightBps })),
    metaHash: `${version.toString(16).padStart(2, '0')}`.repeat(32),
    maxFeeBps: 0,
    flags: 0,
  });
  const core = '11'.repeat(32);
  const growth = '22'.repeat(32);
  const publish = (r: Recipe) => adapter.buildPublishRecipe({ creator: owner.address, recipe: r });

  // Two shared portfolios, both the owner's. The first stays at its first version; the second adds an
  // asset in its second, and, where the clock can be moved, has a third that waits.
  await must(
    await publish(
      recipe(core, 1, [
        ['alpha', 4_000],
        ['beta', 3_000],
        ['gamma', 3_000],
      ]),
    ),
  );
  await must(
    await publish(
      recipe(growth, 1, [
        ['alpha', 4_000],
        ['beta', 3_000],
        ['gamma', 3_000],
      ]),
    ),
  );
  const familyBytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
  const coreAt = await recipeAddress(BASKET_PROGRAM, owner.address, familyBytes(core));
  const growthAt = await recipeAddress(BASKET_PROGRAM, owner.address, familyBytes(growth));

  // Three vaults of the owner, each opened and funded through the adapter.
  const open = async (
    basketId: string,
    a: { recipe?: Address; targets?: [MintName, number][]; autoFollow: boolean; deposit: number },
  ) => {
    await must(
      await adapter.buildCreateVault({
        owner: owner.address,
        basketId,
        targets: (a.targets ?? []).map(([name, weightBps]) => ({ asset: id(name), weightBps })),
        ...(a.recipe ? { recipeOnchainId: a.recipe } : {}),
        autoFollow: a.autoFollow,
        depositRaw: usdc(a.deposit).toString(),
        slippageBps: 100,
      }),
    );
    return vaultAddress(BASKET_PROGRAM, owner.address, BigInt(basketId));
  };
  const vault = await open('1', { recipe: coreAt, autoFollow: true, deposit: 1_000 });
  // The first vault buys short of every target: 20% alpha, 25% beta, 25% gamma, 30% cash.
  for (const [name, dollars] of [
    ['alpha', 200],
    ['beta', 250],
    ['gamma', 250],
  ] as const)
    await must(
      await adapter.buildOwnerSwap({
        vault,
        trades: [{ sell: id('cash'), buy: id(name), amountInRaw: usdc(dollars).toString() }],
        slippageBps: 100,
      }),
    );
  const manualVault = await open('2', {
    targets: [
      ['alpha', 6_000],
      ['gamma', 4_000],
    ],
    autoFollow: false,
    deposit: 500,
  });
  const newAssetVault = await open('3', { recipe: growthAt, autoFollow: true, deposit: 300 });

  // The second version of the second portfolio: published a delay after the first, in effect a delay
  // after that. Then, where the clock moves at will, a third that waits.
  await ledger.advance(PARAMS.publishDelayS + 1);
  ledger.refreshPrices?.(await ledger.now());
  await must(
    await publish(
      recipe(growth, 2, [
        ['alpha', 3_000],
        ['beta', 3_000],
        ['gamma', 3_000],
        ['delta', 1_000],
      ]),
    ),
  );
  await ledger.advance(PARAMS.publishDelayS + 1);
  ledger.refreshPrices?.(await ledger.now());
  if (options.pendingVersion)
    await must(
      await publish(
        recipe(growth, 3, [
          ['alpha', 3_000],
          ['beta', 2_500],
          ['gamma', 3_500],
          ['delta', 1_000],
        ]),
      ),
    );

  const withPriceMoved = async (asset: AssetId, bps: number, work: () => Promise<void>) => {
    const name = asset.slice('solana:'.length) as MintName;
    const set = async (
      scale: (p: { num: bigint; den: bigint }, buying: boolean) => { num: bigint; den: bigint },
    ) => {
      const there = scale(pairPrice('cash', name), true);
      const back = scale(pairPrice(name, 'cash'), false);
      await run(deployer, [
        await setPairPrice(
          deployer.address,
          mints.cash.address,
          mints[name].address,
          there.num,
          there.den,
        ),
        await setPairPrice(
          deployer.address,
          mints[name].address,
          mints.cash.address,
          back.num,
          back.den,
        ),
      ]);
    };
    // Up by `bps`: a dollar buys less of the asset, and the asset sells for more.
    const up = BigInt(10_000 + bps);
    await set((p, buying) =>
      buying
        ? { num: p.num * 10_000n, den: p.den * up }
        : { num: p.num * up, den: p.den * 10_000n },
    );
    try {
      await work();
    } finally {
      await set((p) => p);
    }
  };

  const fixture: ContractFixture = {
    adapter,
    provenance: 'sandbox',
    notBefore: options.notBefore,
    owner: owner.address,
    stranger: strangerKey.address,
    vault,
    manualVault,
    newAssetVault,
    depositRaw: usdc(100).toString(),
    unknownTxId: base58.decode(new Uint8Array(64).fill(1)),
    send: async (tx) => {
      const landed = await ledger.land(await signBuilt(tx));
      return { txId: landed.signature, validUntil: String(tx.lastValidBlockHeight) };
    },
    sign: async (tx) => getBase64EncodedWireTransaction(await signBuilt(tx)),
    withPriceMoved,
    relayWaitMs: 30_000,
    quoteSlippageBps: 100,
    recipeOnchainId: coreAt,
    adoptable: false,
    newAssetRecipeId: growthAt,
    freshBasketId: '99',
    ownerTrade: { sell: id('cash'), buy: id('beta'), amountInRaw: usdc(20).toString() },
    keeperTrade: { sell: id('cash'), buy: id('alpha'), amountInRaw: usdc(50).toString() },
    bandBps: PARAMS.bandBps,
    // Alpha is under its target: selling it moves it further away.
    awayTrade: {
      sell: id('alpha'),
      buy: id('cash'),
      amountInRaw: (20_000_000).toString(),
    } satisfies Trade,
    publishRecipe: recipe(core, 2, [
      ['alpha', 3_500],
      ['beta', 3_000],
      ['gamma', 3_500],
    ]),
  };
  return {
    fixture,
    adapter,
    config,
    assets,
    keys: { deployer, owner, keeper, guardian },
    mints,
    priceAccount,
    sign: async (tx) => getBase64EncodedWireTransaction(await signBuilt(tx)),
    must,
    run,
  };
}
