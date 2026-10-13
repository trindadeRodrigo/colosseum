import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountMeta,
  type Address,
  generateKeyPairSigner,
  type KeyPairSigner,
  lamports,
} from '@solana/kit';
import type { ExtensionArgs } from '@solana-program/token-2022';
import {
  ASSET_KEEPER,
  type AssetArgs,
  forwarded,
  keeperLegInstruction,
  setAutoFollowInstruction,
  setPriceAccountInstruction,
  setTargetsInstruction,
  type Target,
  upsertAssetInstruction,
} from './basket';
import {
  expectOk,
  MOCK_ROUTER_PROGRAM,
  now,
  programSigner,
  REPO_ROOT,
  type SendResult,
  send,
  setClock,
} from './env';
import {
  createPricesInstructions,
  initPairInstruction,
  PRICES_BYTES,
  routeInstruction,
  writePriceInstruction,
} from './mock-router';
import { writePrice } from './prices';
import { createSwapWorld, STOCK_PER_CASH, type SwapWorld } from './swap';
import { ata, createAtaInstruction, type TestMint } from './tokens';

// What the keeper tests start from: the swap world, with the test exchange's price account (Scope's
// layout, made and written through the exchange's own instructions, as on a test network), both
// listed assets priced and switched on for the keeper, and the vault on auto-follow.

/** Wednesday Oct 7, 2026, 15:00 UTC: inside the session. */
export const SESSION = BigInt(Date.UTC(2026, 9, 7, 15) / 1000);
export const DAY = 86_400n;
/** The price both assets trade at on the test exchange: 500 dollars a token, 8 decimal places. */
export const PRICE = 500_00000000n;
/** Where a stock token's price and its one-hour average sit in Scope's price account on mainnet. */
function scopeEntries(symbol: string): { priceIndex: number; twapIndex: number } {
  const table: { assets: { symbol: string; priceIndex: number; twapIndex: number }[] } = JSON.parse(
    readFileSync(join(REPO_ROOT, 'fixtures', 'solana-vault', 'scope-indexes.json'), 'utf8'),
  );
  const row = table.assets.find((a) => a.symbol === symbol);
  if (!row) throw new Error(`fixtures/solana-vault/scope-indexes.json has no ${symbol}`);
  return { priceIndex: row.priceIndex, twapIndex: row.twapIndex };
}
/** The two assets sit where real ones do: the stock at SPYx's entries, the other at QQQx's. */
export const STOCK_PRICE = scopeEntries('SPYx');
export const OTHER_PRICE = scopeEntries('QQQx');

export type KeeperWorld = SwapWorld & {
  keeper: KeyPairSigner;
  /** The program that owns the price account, as Config has it: the test exchange. */
  priceOwner: Address;
  prices: Address;
  vaultOther: Address;
};

type FourPrices = { stock?: bigint; stockTwap?: bigint; other?: bigint; otherTwap?: bigint };

/** Writes the four entries again, stamped with the chain's clock, through the exchange's
 * `write_price`: what the job that copies prices onto a test network does. */
export async function refreshPrices(
  w: Pick<KeeperWorld, 'svm' | 'admin' | 'prices'>,
  values: FourPrices = {},
): Promise<void> {
  const unixTimestamp = now(w.svm);
  const entry = (value: bigint) => ({ value, unixTimestamp });
  expectOk(
    await send(w.svm, w.admin, [
      await writePriceInstruction(w.admin, w.prices, {
        ...STOCK_PRICE,
        price: entry(values.stock ?? PRICE),
        twap: entry(values.stockTwap ?? values.stock ?? PRICE),
      }),
      await writePriceInstruction(w.admin, w.prices, {
        ...OTHER_PRICE,
        price: entry(values.other ?? PRICE),
        twap: entry(values.otherTwap ?? values.other ?? PRICE),
      }),
    ]),
  );
}

/** The same four entries written straight into an account's bytes: for an account the exchange
 * does not own, or one that is not its price account, which no instruction can write. */
export function stampPrices(
  svm: KeeperWorld['svm'],
  prices: Address,
  values: FourPrices = {},
): void {
  const unixTimestamp = now(svm);
  const write = (index: number, value: bigint) =>
    writePrice(svm, prices, index, { value, unixTimestamp });
  write(STOCK_PRICE.priceIndex, values.stock ?? PRICE);
  write(STOCK_PRICE.twapIndex, values.stockTwap ?? values.stock ?? PRICE);
  write(OTHER_PRICE.priceIndex, values.other ?? PRICE);
  write(OTHER_PRICE.twapIndex, values.otherTwap ?? values.other ?? PRICE);
}

/** A price range in dollars, as an entry holds it: millionths of a dollar for one whole token. */
export const range = (minUsd: number, maxUsd: number) => ({
  minPrice: BigInt(Math.round(minUsd * 1e6)),
  maxPrice: BigInt(Math.round(maxUsd * 1e6)),
});
/** The range both assets are listed with: 400 to 600 dollars, around the 500 they trade at. */
export const RANGE = range(400, 600);

/** The entry of an asset the keeper may trade. */
export const keeperAsset = (
  price: { priceIndex: number; twapIndex: number },
  session: number,
): Partial<AssetArgs> => ({ ...price, priceKind: 1, session, flags: ASSET_KEEPER, ...RANGE });

export async function createKeeperWorld(
  targets?: (w: SwapWorld) => Target[],
  stockExtensions?: (issuer: Address, mint: Address) => ExtensionArgs[],
): Promise<KeeperWorld> {
  const keeper = await generateKeyPairSigner();
  // As on a test network: the exchange is the price program, and its price account is the one
  // the asset list names.
  const priceOwner = MOCK_ROUTER_PROGRAM;
  const w = await createSwapWorld({
    priceOwner,
    defaultKeeper: keeper.address,
    ...(stockExtensions ? { stockExtensions } : {}),
  });
  const { svm, admin, owner, vault } = w;
  svm.airdrop(keeper.address, lamports(10_000_000_000n));
  setClock(svm, SESSION);

  const pricesKey = await generateKeyPairSigner();
  const rent = svm.minimumBalanceForRentExemption(PRICES_BYTES);
  expectOk(await send(svm, admin, await createPricesInstructions(admin, pricesKey, rent)));
  const prices = pricesKey.address;
  await refreshPrices({ svm, admin, prices });
  const { num, den } = STOCK_PER_CASH;
  expectOk(
    await send(svm, admin, [
      await setPriceAccountInstruction(admin, 0, prices),
      await upsertAssetInstruction(admin, w.stock.address, keeperAsset(STOCK_PRICE, 1)),
      await upsertAssetInstruction(admin, w.other.address, keeperAsset(OTHER_PRICE, 0)),
      await initPairInstruction(admin, w.other.address, w.cash.address, den, num),
    ]),
  );
  expectOk(
    await send(svm, owner, [
      await setTargetsInstruction({
        owner,
        vault,
        targets: targets?.(w) ?? [
          { mint: w.stock.address, targetBps: 5_000 },
          { mint: w.other.address, targetBps: 3_000 },
        ],
      }),
      await setAutoFollowInstruction({ owner, vault, on: true }),
      await createAtaInstruction(owner, vault, w.other),
    ]),
  );
  return { ...w, keeper, priceOwner, prices, vaultOther: await ata(vault, w.other) };
}

export type LegOptions = {
  /** What the exchange is told to take. */
  amountIn: bigint;
  /** What the keeper lets the vault spend; `amountIn` unless a test says otherwise. */
  maxIn?: bigint;
  inputMint?: TestMint;
  outputMint?: TestMint;
  /** Where the exchange is told to pay. The vault's own account unless a test says otherwise. */
  destination?: Address;
  signer?: KeyPairSigner;
  priceAccount?: Address;
  vaultInput?: Address;
  vaultOutput?: Address;
  config?: Address;
  assets?: Address;
  /** More accounts after the exchange's own, which it ignores. */
  extra?: AccountMeta[];
  /** The pair pays the price account's price: the exchange takes that account too. */
  priced?: boolean;
};

/** A keeper leg through the test exchange: cash for the stock unless the mints say otherwise. */
export async function keeperLeg(w: KeeperWorld, o: LegOptions): Promise<SendResult> {
  const inputMint = o.inputMint ?? w.cash;
  const outputMint = o.outputMint ?? w.stock;
  const route = forwarded(
    await routeInstruction({
      trader: programSigner(w.vault),
      mintIn: inputMint,
      mintOut: outputMint,
      traderIn: await ata(w.vault, inputMint),
      destination: o.destination ?? (await ata(w.vault, outputMint)),
      amountIn: o.amountIn,
      minOut: 0n,
      ...(o.priced ? { prices: w.prices } : {}),
    }),
  );
  const who = o.signer ?? w.keeper;
  return send(w.svm, who, [
    await keeperLegInstruction({
      keeper: who,
      vault: w.vault,
      inputMint,
      outputMint,
      amountIn: o.maxIn ?? o.amountIn,
      priceAccount: o.priceAccount ?? w.prices,
      vaultInput: o.vaultInput,
      vaultOutput: o.vaultOutput,
      config: o.config,
      assets: o.assets,
      ...route,
      routerAccounts: [...route.routerAccounts, ...(o.extra ?? [])],
    }),
  ]);
}
