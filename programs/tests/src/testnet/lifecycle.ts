import {
  type Address,
  getAddressDecoder,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
} from '@solana-program/token-2022';
import {
  acceptVersionInstruction,
  createVaultInstruction,
  decodeVault,
  depositInstruction,
  familyId,
  forwarded,
  keeperLegInstruction,
  ownerSwapInstruction,
  publishRecipeInstruction,
  recipeAddress,
  vaultAddress,
} from '../basket';
import { programSigner } from '../env';
import { routeInstruction, writePriceInstruction } from '../mock-router';
import { ata, type TestMint, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../tokens';
import type { Chain } from './chain';
import type { DeployedAsset, DeployedToken, Deployment } from './setup';

// One vault's life on a network the set-up made: create, deposit, a swap by the owner, a keeper
// leg, and the owner accepting a shared portfolio. The test suite runs it in LiteSVM and the
// rehearsal on a local validator; on devnet it is the first check after a deploy.

export type LifecycleKeys = {
  /** The key that ran the set-up: it mints the test dollars and writes prices. */
  admin: TransactionSigner;
  owner: TransactionSigner;
  /** Config's default keeper. */
  keeper: TransactionSigner;
  creator: TransactionSigner;
};

export type LifecycleStep = { what: string; signature: string; bytes: number };

export type LifecycleResult = {
  vault: Address;
  recipe: Address;
  steps: LifecycleStep[];
  /** What the vault holds at the end, in raw units, by asset id. */
  holds: Record<string, bigint>;
  acceptedVersion: number;
  lossAccum: bigint;
};

const u64At = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

/** The addresses a lookup table holds: 32 bytes each after a 56-byte header. */
async function tableOf(chain: Chain, table: Address | null): Promise<Record<Address, Address[]>> {
  if (!table) return {};
  const account = await chain.account(table);
  if (!account) return {};
  const decoder = getAddressDecoder();
  const addresses: Address[] = [];
  for (let at = 56; at + 32 <= account.data.length; at += 32)
    addresses.push(decoder.decode(account.data.slice(at, at + 32)));
  return { [table]: addresses };
}

export async function lifecycle(
  chain: Chain,
  deployment: Deployment,
  keys: LifecycleKeys,
  log: (line: string) => void,
): Promise<LifecycleResult> {
  const { admin, owner, keeper, creator } = keys;
  const mintOf = (token: DeployedToken): TestMint => ({
    address: token.mint,
    program: token.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    decimals: token.decimals,
    // Nothing below asks the issuer to sign: the admin's mint authority is used by name.
    issuer: admin as KeyPairSigner,
  });
  const cash = mintOf(deployment.cash);
  const stocks = deployment.assets.filter((asset) => asset.session === 1 && asset.keeperOn);
  const steady = deployment.assets.find((asset) => asset.session === 0 && asset.keeperOn);
  const [stock, second] = stocks;
  if (!stock || !second || !steady)
    throw new Error(
      'the deployment needs two stock tokens and one token with no session, switched on',
    );
  const prices = deployment.accounts.priceAccount;
  const steps: LifecycleStep[] = [];
  const step = async (
    what: string,
    payer: TransactionSigner,
    instructions: Parameters<Chain['send']>[1],
    tables?: Record<Address, Address[]>,
  ) => {
    const sent = await chain.send(payer, instructions, tables);
    steps.push({ what, ...sent });
    log(`${what}: ${sent.signature} (${sent.bytes} bytes)`);
  };
  const usd = (dollars: bigint) => dollars * 10n ** BigInt(cash.decimals);
  const held = async (holder: Address, mint: TestMint) => {
    const account = await chain.account(await ata(holder, mint));
    return account ? u64At(account.data, 64) : 0n;
  };
  const tokenAccount = async (payer: TransactionSigner, holder: Address, mint: TestMint) =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: await ata(holder, mint),
      owner: holder,
      mint: mint.address,
      tokenProgram: mint.program,
    });
  /** A route through the exchange's pair for these two mints, at the price account's price. */
  const route = async (vault: Address, mintIn: TestMint, mintOut: TestMint, amountIn: bigint) =>
    forwarded(
      await routeInstruction({
        trader: programSigner(vault),
        mintIn,
        mintOut,
        traderIn: await ata(vault, mintIn),
        destination: await ata(vault, mintOut),
        amountIn,
        minOut: 1n,
        prices,
      }),
    );

  // The plan's number is the cluster's clock, so a second run makes a second vault.
  const basketId = await chain.now();
  const vault = await vaultAddress(owner.address, basketId);

  await step('the admin hands the owner 1,000 test dollars', admin, [
    await tokenAccount(admin, owner.address, cash),
    getMintToInstruction(
      {
        mint: cash.address,
        token: await ata(owner.address, cash),
        mintAuthority: admin,
        amount: usd(1_000n),
      },
      { programAddress: cash.program },
    ),
  ]);

  await step(
    `create: a vault with 40% ${stock.symbol} and 30% ${steady.symbol}, auto-follow on`,
    owner,
    [
      await createVaultInstruction({
        owner,
        basketId,
        targets: [
          { mint: stock.mint, targetBps: 4_000 },
          { mint: steady.mint, targetBps: 3_000 },
        ],
        autoFollow: true,
      }),
    ],
  );

  await step('deposit: 1,000 test dollars', owner, [
    await tokenAccount(owner, vault, cash),
    await depositInstruction({ owner, vault, mint: cash, amount: usd(1_000n) }),
  ]);

  const stockMint = mintOf(stock);
  await step(`swap: the owner buys ${stock.symbol} with 400 test dollars`, owner, [
    await tokenAccount(owner, vault, stockMint),
    await ownerSwapInstruction({
      owner,
      vault,
      inputMint: cash,
      outputMint: stockMint,
      maxIn: usd(400n),
      minOut: 1n,
      ...(await route(vault, cash, stockMint, usd(400n))),
    }),
  ]);

  // What the job that copies prices does: the same values, stamped now. A leg takes no price
  // older than `max_price_age_s`, for the asset it trades and for every position the vault holds.
  const account = await chain.account(prices);
  if (!account) throw new Error('the price account is not there');
  const now = await chain.now();
  const stamped = (asset: DeployedAsset) => {
    const entry = (index: number) => ({
      value: u64At(account.data, 40 + 56 * index),
      exponent: u64At(account.data, 48 + 56 * index),
      unixTimestamp: now,
    });
    return writePriceInstruction(admin, prices, {
      priceIndex: asset.priceIndex,
      twapIndex: asset.twapIndex,
      price: entry(asset.priceIndex),
      twap: entry(asset.twapIndex),
    });
  };
  await step(`prices written again, stamped now: ${stock.symbol}, ${steady.symbol}`, admin, [
    await stamped(stock),
    await stamped(steady),
  ]);

  const steadyMint = mintOf(steady);
  await step(
    `keeper leg: 250 test dollars into ${steady.symbol}, toward its 30%, with the lookup table`,
    keeper,
    [
      await tokenAccount(keeper, vault, steadyMint),
      await keeperLegInstruction({
        keeper,
        vault,
        inputMint: cash,
        outputMint: steadyMint,
        amountIn: usd(250n),
        priceAccount: prices,
        ...(await route(vault, cash, steadyMint, usd(250n))),
      }),
    ],
    await tableOf(chain, deployment.accounts.lookupTable),
  );

  const family = familyId(`rehearsal-${basketId}`);
  const recipe = await recipeAddress(creator.address, family);
  await step(
    `publish: a shared portfolio of ${stock.symbol} 50%, ${second.symbol} 30%, ${steady.symbol} 20%`,
    creator,
    [
      await publishRecipeInstruction({
        creator,
        familyId: family,
        components: [
          { mint: stock.mint, weightBps: 5_000 },
          { mint: second.mint, weightBps: 3_000 },
          { mint: steady.mint, weightBps: 2_000 },
        ],
      }),
    ],
  );
  await step('accept: the owner takes version 1 of it', owner, [
    await acceptVersionInstruction({ owner, vault, recipe, expectedVersion: 1 }),
  ]);

  const stored = await chain.account(vault);
  if (!stored) throw new Error('the vault is not there');
  const state = decodeVault(stored.data);
  const holds: Record<string, bigint> = {
    [deployment.cash.id]: await held(vault, cash),
    [stock.id]: await held(vault, stockMint),
    [steady.id]: await held(vault, steadyMint),
  };
  log(
    `the vault ${vault} follows ${state.recipe} at version ${state.acceptedVersion}; it holds ${Object.entries(
      holds,
    )
      .map(([id, raw]) => `${raw} raw ${id}`)
      .join(', ')}; loss counter ${state.lossAccum}`,
  );
  return {
    vault,
    recipe,
    steps,
    holds,
    acceptedVersion: state.acceptedVersion,
    lossAccum: state.lossAccum,
  };
}
