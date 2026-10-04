import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountMeta,
  type Address,
  generateKeyPairSigner,
  type KeyPairSigner,
  lamports,
} from '@solana/kit';
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
import { expectOk, now, programSigner, REPO_ROOT, type SendResult, send, setClock } from './env';
import { initPairInstruction, routeInstruction } from './mock-router';
import { createPriceAccount, writePrice } from './prices';
import { createSwapWorld, STOCK_PER_CASH, type SwapWorld } from './swap';
import { ata, createAtaInstruction, type TestMint } from './tokens';

// What the keeper tests start from: the swap world, with a price account in Scope's layout, both
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
  /** The program that owns the price account, as Config has it. No code sits there. */
  priceOwner: Address;
  prices: Address;
  vaultOther: Address;
};

/** Writes the four entries again, stamped with the chain's clock: what the feed's crank does. */
export function refreshPrices(
  w: Pick<KeeperWorld, 'svm' | 'prices'>,
  values: { stock?: bigint; stockTwap?: bigint; other?: bigint; otherTwap?: bigint } = {},
): void {
  const unixTimestamp = now(w.svm);
  const write = (index: number, value: bigint) =>
    writePrice(w.svm, w.prices, index, { value, unixTimestamp });
  write(STOCK_PRICE.priceIndex, values.stock ?? PRICE);
  write(STOCK_PRICE.twapIndex, values.stockTwap ?? values.stock ?? PRICE);
  write(OTHER_PRICE.priceIndex, values.other ?? PRICE);
  write(OTHER_PRICE.twapIndex, values.otherTwap ?? values.other ?? PRICE);
}

/** The entry of an asset the keeper may trade. */
export const keeperAsset = (
  price: { priceIndex: number; twapIndex: number },
  session: number,
): Partial<AssetArgs> => ({ ...price, priceKind: 1, session, flags: ASSET_KEEPER });

export async function createKeeperWorld(
  targets?: (w: SwapWorld) => Target[],
): Promise<KeeperWorld> {
  const keeper = await generateKeyPairSigner();
  const priceOwner = (await generateKeyPairSigner()).address;
  const w = await createSwapWorld({ priceOwner, defaultKeeper: keeper.address });
  const { svm, admin, owner, vault } = w;
  svm.airdrop(keeper.address, lamports(10_000_000_000n));
  setClock(svm, SESSION);

  const prices = await createPriceAccount(svm, priceOwner);
  refreshPrices({ svm, prices });
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
