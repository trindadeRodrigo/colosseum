import {
  type Address,
  generateKeyPairSigner,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addClosedDayInstruction,
  assetsAddress,
  DEFAULT_PARAMS,
  decodeKeeperTrade,
  depositInstruction,
  ERR,
  extendClosedUntilInstruction,
  forgeConfig,
  keeperLegInstruction,
  type Params,
  PRICES_SIZE,
  patchVault,
  pauseKeeperInstruction,
  readVault,
  setAutoFollowInstruction,
  setClosedDayInstruction,
  setClosedUntilInstruction,
  setDefaultKeeperInstruction,
  setParamsInstruction,
  setPriceOwnerInstruction,
  setTargetsInstruction,
  syncBalancesInstruction,
  trackedFor,
  unpauseKeeperInstruction,
  upsertAssetInstruction,
  withdrawInstruction,
} from './src/basket';
import {
  ANCHOR,
  events,
  expectError,
  expectOk,
  fundedSigner,
  loadHook,
  MOCK_ROUTER_PROGRAM,
  now,
  send,
  setClock,
  unsigned,
} from './src/env';
import { setHook } from './src/hook';
import {
  createKeeperWorld,
  DAY,
  type KeeperWorld,
  keeperAsset,
  keeperLeg,
  OTHER_PRICE,
  PRICE,
  range,
  refreshPrices,
  SESSION,
  STOCK_PRICE,
} from './src/keeper';
import { setPriceInstruction } from './src/mock-router';
import { createPriceAccount, usd, writePrice } from './src/prices';
import { CASH, stockFor, swapThroughExchange, tokenAccountFor } from './src/swap';
import {
  ata,
  balance,
  createAta,
  createLooseTokenAccount,
  mintExtensionEntries,
  mintTo,
  mintToAccount,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';

const HOUR = 3_600n;
/** One dollar of the 6-decimal cash token. */
const USD = 1_000000n;
const SCALED_UI_AMOUNT_EXTENSION = 25;

// The keeper's one trade (DESIGN-VAULT.md section 5): cash for one of the vault's positions or the
// other way, through the router Config names, signed by the vault. The vault starts with 100 dollars
// of cash, a target of 50% on the stock and 30% on the other asset, and both trade at 500 dollars on
// the test exchange and in the price account. What a router that turns on the vault can do to a
// keeper leg is in basket-keeper-hostile.test.ts.
describe('keeper_leg', () => {
  let w: KeeperWorld;

  beforeEach(async () => {
    w = await createKeeperWorld();
  });

  const held = () => ({
    cash: balance(w.svm, w.vaultCash),
    stock: balance(w.svm, w.vaultStock),
    other: balance(w.svm, w.vaultOther),
  });
  const untouched = { cash: CASH, stock: 0n, other: 0n };
  const position = (mint: TestMint) => {
    const state = readVault(w.svm, w.vault);
    const found = state.positions.slice(0, state.count).find((p) => p.mint === mint.address);
    if (!found) throw new Error('the mint is not one of the positions');
    return found;
  };
  /** Buys the stock with this many dollars of cash. */
  const buy = (dollars: number, mint: TestMint = w.stock) =>
    keeperLeg(w, { amountIn: BigInt(Math.round(dollars * 1e6)), outputMint: mint });
  /** Sells this many dollars' worth of the stock at 500 dollars. */
  const sell = (dollars: number, mint: TestMint = w.stock) =>
    keeperLeg(w, {
      amountIn: stockFor(BigInt(Math.round(dollars * 1e6))),
      inputMint: mint,
      outputMint: w.cash,
    });
  /** The owner's own trade: it holds the vault to no target. */
  const ownerBuys = async (dollars: number, mint: TestMint = w.stock) =>
    expectOk(await swapThroughExchange(w, { amountIn: BigInt(dollars) * USD, outputMint: mint }));
  /** Moves the clock and has the feed write every price again, as its crank does. */
  const at = (time: bigint) => {
    setClock(w.svm, time);
    refreshPrices(w);
  };
  /** What the exchange pays for one raw unit of `mintIn`, as a fraction. */
  const exchangePays = async (mintIn: TestMint, mintOut: TestMint, num: bigint, den: bigint) =>
    expectOk(
      await send(w.svm, w.admin, [
        await setPriceInstruction(w.admin, mintIn.address, mintOut.address, num, den),
      ]),
    );
  const setParams = async (change: Partial<Params>) =>
    expectOk(
      await send(w.svm, w.admin, [
        await setParamsInstruction(w.admin, { ...DEFAULT_PARAMS, ...change }),
      ]),
    );
  const listed = async (mint: TestMint, change: object, base = STOCK_PRICE, session = 1) =>
    expectOk(
      await send(w.svm, w.admin, [
        await upsertAssetInstruction(w.admin, mint.address, {
          ...keeperAsset(base, session),
          ...change,
        }),
      ]),
    );

  describe('a trade toward the target', () => {
    it('buys an asset that is under its target with cash, into the vault itself', async () => {
      const meta = expectOk(await buy(40));
      expect(held()).toEqual({ cash: 60n * USD, stock: stockFor(40n * USD), other: 0n });
      expect(position(w.stock)).toMatchObject({
        tracked: stockFor(40n * USD),
        lastKeeperTs: SESSION,
      });
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)).toEqual([
        {
          vault: w.vault,
          mintIn: w.cash.address,
          mintOut: w.stock.address,
          spent: 40n * USD,
          received: stockFor(40n * USD),
          loss: 0n,
          lossUsedBps: 0,
        },
      ]);
      const state = readVault(w.svm, w.vault);
      expect([state.lossAccum, state.lossTs]).toEqual([0n, 0n]);
      expect(
        meta.logs().some((l) => l.includes('keeper leg: spent=40000000 received=8000000')),
      ).toBe(true);
    });

    it('sells an asset that is over its target for cash', async () => {
      await ownerBuys(80);
      const meta = expectOk(await sell(30));
      expect(held()).toEqual({ cash: 50n * USD, stock: stockFor(50n * USD), other: 0n });
      expect(position(w.stock)).toMatchObject({
        tracked: stockFor(50n * USD),
        lastKeeperTs: SESSION,
      });
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]).toMatchObject({
        mintIn: w.stock.address,
        mintOut: w.cash.address,
        spent: stockFor(30n * USD),
        received: 30n * USD,
        loss: 0n,
      });
    });

    it('counts what the vault holds of its other positions in the weight', async () => {
      // 30 dollars of the other asset and 70 of cash: the vault is still worth 100.
      await ownerBuys(30, w.other);
      expectError(await buy(50.6), ERR.PastTarget);
      expectOk(await buy(50.5));
    });

    // 10^17 raw units of cash, a hundred billion dollars: under it no product the checks form can
    // overflow, and past it the leg is refused before anything is multiplied.
    describe('a vault past the largest value the arithmetic holds', () => {
      const LARGEST = 10n ** 17n;
      /** The program has this much of the other asset recorded: 5 raw units of cash each. */
      const recorded = (amount: bigint) =>
        patchVault(w.svm, w.vault, { tracked: { mint: w.other.address, amount } });

      it('is refused before the trade, and one at exactly that value is traded', async () => {
        // The vault's 100 dollars of cash and the rest in the other asset, at 500 dollars a token.
        const atTheBound = (LARGEST - CASH) / 5n;
        // The exchange pays half a percent under the reference, so the trade itself would bring
        // the vault back under the bound: it is the value before the trade that is refused.
        await exchangePays(w.cash, w.stock, 199n, 1_000n);
        recorded(atTheBound + 1n);
        expectError(await buy(40), ERR.AssetNotPriced);
        recorded(10n ** 19n);
        expectError(await buy(40), ERR.AssetNotPriced);
        recorded(atTheBound);
        expectOk(await buy(40));
      });

      it('is refused after the trade, when what came in takes it past', async () => {
        recorded((LARGEST - CASH) / 5n);
        // The exchange pays a little more than the reference price says: the vault ends worth more.
        await exchangePays(w.cash, w.stock, 201n, 1_000n);
        expectError(await buy(40), ERR.AssetNotPriced);
        expect(held()).toEqual(untouched);
      });
    });

    it('reads a price with another number of decimal places the same way', async () => {
      const unixTimestamp = now(w.svm);
      writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, {
        value: 500_000000n,
        exponent: 6n,
        unixTimestamp,
      });
      writePrice(w.svm, w.prices, STOCK_PRICE.twapIndex, {
        value: 500n,
        exponent: 0n,
        unixTimestamp,
      });
      expectError(await buy(50.6), ERR.PastTarget);
      expectOk(await buy(50.5));
    });
  });

  // Check 1, hostile case A13.
  describe('who may call it', () => {
    it('is the keeper alone: not the owner, the guardian, the admin or anyone else', async () => {
      for (const who of [w.owner, w.guardian, w.admin, w.stranger])
        expectError(await keeperLeg(w, { amountIn: 40n * USD, signer: who }), ERR.NotKeeper);
      expect(held()).toEqual(untouched);
    });

    it('needs the keeper to sign', async () => {
      const leg = await keeperLegInstruction({
        keeper: w.keeper,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        amountIn: 1n,
        router: MOCK_ROUTER_PROGRAM,
        data: new Uint8Array(8),
        routerAccounts: [],
        priceAccount: w.prices,
      });
      expectError(await send(w.svm, w.stranger, [unsigned(leg)]), ANCHOR.AccountNotSigner);
    });

    it('is the keeper Config names now', async () => {
      const next = await fundedSigner(w.svm);
      expectOk(
        await send(w.svm, w.admin, [await setDefaultKeeperInstruction(w.admin, next.address)]),
      );
      expectError(await buy(40), ERR.NotKeeper);
      expectOk(await keeperLeg(w, { amountIn: 40n * USD, signer: next }));
    });

    it('is the keeper the vault names, when it names one', async () => {
      patchVault(w.svm, w.vault, { keeper: w.stranger.address });
      expectError(await buy(40), ERR.NotKeeper);
      expectOk(await keeperLeg(w, { amountIn: 40n * USD, signer: w.stranger }));
    });

    it('refuses a forged Config that names the signer as keeper', async () => {
      const forged = await forgeConfig(w.svm, { defaultKeeper: w.stranger.address });
      expectError(
        await keeperLeg(w, { amountIn: 40n * USD, signer: w.stranger, config: forged }),
        ANCHOR.ConstraintSeeds,
      );
    });

    it('refuses while auto-follow is off', async () => {
      const { owner, vault } = w;
      expectOk(
        await send(w.svm, owner, [await setAutoFollowInstruction({ owner, vault, on: false })]),
      );
      expectError(await buy(40), ERR.AutoFollowOff);
      expect(held()).toEqual(untouched);
    });
  });

  // Check 11, hostile case A8.
  describe('the pause', () => {
    it('stops the keeper and never the owner', async () => {
      const { svm, owner, vault, guardian, admin, cash } = w;
      expectOk(await send(svm, guardian, [await pauseKeeperInstruction(guardian)]));
      expectError(await buy(40), ERR.KeeperPaused);
      expect(held()).toEqual(untouched);

      const ownerCash = await ata(owner.address, cash);
      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: cash, amount: 10n * USD }),
        ]),
      );
      expect(balance(svm, ownerCash)).toBe(10n * USD);
      await ownerBuys(10);

      expectOk(await send(svm, admin, [await unpauseKeeperInstruction(admin)]));
      expectOk(await buy(30));
    });

    it('is read from the real Config only', async () => {
      const forged = await forgeConfig(w.svm, { keeperPaused: false });
      expectOk(await send(w.svm, w.guardian, [await pauseKeeperInstruction(w.guardian)]));
      expectError(
        await keeperLeg(w, { amountIn: 40n * USD, config: forged }),
        ANCHOR.ConstraintSeeds,
      );
    });
  });

  // Check 2, hostile case A4.
  describe('what it may trade', () => {
    it('trades cash for an asset or an asset for cash, never one asset for another', async () => {
      await ownerBuys(80);
      expectError(
        await keeperLeg(w, {
          amountIn: stockFor(30n * USD),
          inputMint: w.stock,
          outputMint: w.other,
        }),
        ERR.NotCashLeg,
      );
      // A mint for itself is cash on both sides, or on neither.
      for (const mint of [w.cash, w.stock])
        expectError(
          await keeperLeg(w, { amountIn: 1n, inputMint: mint, outputMint: mint }),
          ERR.NotCashLeg,
        );
    });

    it('refuses a token that is not one of the positions, listed or not', async () => {
      const { owner, vault } = w;
      expectOk(
        await send(w.svm, owner, [
          await setTargetsInstruction({
            owner,
            vault,
            targets: [{ mint: w.stock.address, targetBps: 5_000 }],
          }),
          await setAutoFollowInstruction({ owner, vault, on: true }),
        ]),
      );
      await createAta(w.svm, w.admin, vault, w.unlisted);
      for (const mint of [w.other, w.unlisted])
        expectError(await buy(20, mint), ERR.MintNotAccepted);
      expect(held()).toEqual(untouched);
    });

    it("spends only from, and pays only into, the vault's associated token accounts", async () => {
      // Two more token accounts that the vault owns, with tokens someone sent to them.
      const looseCash = await createLooseTokenAccount(w.svm, w.admin, w.cash, w.vault);
      await mintToAccount(w.svm, w.admin, w.cash, looseCash, 50n * USD);
      const looseOther = await createLooseTokenAccount(w.svm, w.admin, w.other, w.vault);
      expectError(
        await keeperLeg(w, { amountIn: 20n * USD, outputMint: w.other, vaultInput: looseCash }),
        ANCHOR.ConstraintAssociated,
      );
      expectError(
        await keeperLeg(w, { amountIn: 20n * USD, outputMint: w.other, vaultOutput: looseOther }),
        ANCHOR.ConstraintAssociated,
      );
      expect(balance(w.svm, looseCash)).toBe(50n * USD);
    });

    it('refuses a token program that is not the one the mint belongs to', async () => {
      expectError(
        await keeperLeg(w, {
          amountIn: 20n * USD,
          inputMint: { ...w.cash, program: TOKEN_2022_PROGRAM },
          vaultInput: w.vaultCash,
        }),
        ANCHOR.ConstraintMintTokenProgram,
      );
      expectError(
        await keeperLeg(w, {
          amountIn: 20n * USD,
          outputMint: { ...w.stock, program: TOKEN_PROGRAM },
          vaultOutput: w.vaultStock,
        }),
        ANCHOR.ConstraintMintTokenProgram,
      );
    });

    // No instruction takes a token off the asset list, so only a test can show a vault holding
    // one that is not on it: the entry's mint is overwritten in the account.
    const offTheList = async (mint: TestMint) => {
      const address = await assetsAddress();
      const account = w.svm.getAccount(address);
      if (!account.exists) throw new Error('no asset list');
      const data = new Uint8Array(account.data);
      const key = getAddressEncoder().encode(mint.address);
      for (let at = 137; at + 96 <= data.length; at += 96)
        if (key.every((byte, i) => data[at + i] === byte))
          data.set(getAddressEncoder().encode(w.stranger.address), at);
      w.svm.setAccount({ ...account, data });
    };

    it('refuses an asset that is not on the asset list, position or not', async () => {
      await offTheList(w.stock);
      expectError(await buy(40), ERR.MintNotAccepted);
      expect(held()).toEqual(untouched);
    });

    it('refuses a leg in a vault that holds an asset that is not on the asset list', async () => {
      await ownerBuys(10, w.other);
      await offTheList(w.other);
      expectError(await buy(40), ERR.AssetNotPriced);
      expect(balance(w.svm, w.vaultStock)).toBe(0n);
    });

    it('reads the asset list at its own address only', async () => {
      // A copy of the list at another address, as only a test can make.
      const real = w.svm.getAccount(await assetsAddress());
      if (!real.exists) throw new Error('no asset list');
      const copy = (await generateKeyPairSigner()).address;
      w.svm.setAccount({ ...real, address: copy });
      expectError(
        await keeperLeg(w, { amountIn: 20n * USD, assets: copy }),
        ANCHOR.ConstraintSeeds,
      );
    });
  });

  // The admin's switch on an asset: the feed has been seen to be live.
  describe("the keeper's switch on an asset", () => {
    it('refuses an asset the admin has not switched on', async () => {
      await listed(w.stock, { flags: 0 });
      expectError(await buy(40), ERR.KeeperAssetOff);
      expect(held()).toEqual(untouched);
    });

    it('never touches the owner: the same asset still trades and withdraws', async () => {
      await listed(w.stock, { flags: 0 });
      await ownerBuys(40);
      const { svm, owner, vault, stock } = w;
      await createAta(svm, owner, owner.address, stock);
      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: stock, amount: stockFor(40n * USD) }),
        ]),
      );
    });

    it('refuses a leg in a vault that holds an asset that is switched off', async () => {
      await ownerBuys(10, w.other);
      await listed(w.other, { flags: 0 }, OTHER_PRICE, 0);
      expectError(await buy(40), ERR.KeeperAssetOff);
    });

    it('does not mind an asset that is switched off when the vault holds nothing of it', async () => {
      await listed(w.other, { flags: 0 }, OTHER_PRICE, 0);
      expectOk(await buy(40));
    });
  });

  describe('the price account', () => {
    it('is the one the asset list names for the asset', async () => {
      const twin = await createPriceAccount(w.svm, w.priceOwner);
      refreshPrices({ svm: w.svm, prices: twin });
      expectError(
        await keeperLeg(w, { amountIn: 40n * USD, priceAccount: twin }),
        ERR.AssetNotPriced,
      );
    });

    it('is owned by the price program Config names', async () => {
      const forged = await createPriceAccount(w.svm, w.stranger.address);
      refreshPrices({ svm: w.svm, prices: forged });
      expectError(
        await keeperLeg(w, { amountIn: 40n * USD, priceAccount: forged }),
        ERR.AssetNotPriced,
      );
      // The account the asset list names stops counting when Config names another price program.
      expectOk(
        await send(w.svm, w.admin, [await setPriceOwnerInstruction(w.admin, w.stranger.address)]),
      );
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    it('is named for the slot the asset points at', async () => {
      await listed(w.stock, { priceSlot: 1 });
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    it('holds a price at the entry: one nobody wrote is refused', async () => {
      writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, { value: 0n, unixTimestamp: SESSION });
      expectError(await buy(40), ERR.AssetNotPriced);
      refreshPrices(w);
      writePrice(w.svm, w.prices, STOCK_PRICE.twapIndex, { value: PRICE, unixTimestamp: 0n });
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    it('refuses a time no clock can hold', async () => {
      writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, {
        value: PRICE,
        unixTimestamp: 1n << 63n,
      });
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    it('refuses an asset with no price entry', async () => {
      await listed(w.stock, { priceKind: 0, flags: 0 });
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    it('refuses a price account that is no longer the size of one', async () => {
      const account = w.svm.getAccount(w.prices);
      if (!account.exists) throw new Error('no price account');
      const data = new Uint8Array(account.data).slice(0, PRICES_SIZE - 56);
      w.svm.setAccount({ ...account, data, space: BigInt(data.length) });
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    it('refuses an exponent no price has', async () => {
      writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, {
        value: PRICE,
        exponent: 19n,
        unixTimestamp: SESSION,
      });
      expectError(await buy(40), ERR.AssetNotPriced);
    });

    // A5b, as far as it is built: the comparison with a pinned source is not, so an asset that
    // asks for it is not traded.
    it('refuses an asset that asks for a check of its source', async () => {
      await listed(w.stock, { sourceCheck: new Uint8Array(32).fill(7) });
      expectError(await buy(40), ERR.AssetNotPriced);
    });
  });

  // The range the admin gave the asset: 400 to 600 dollars, around the 500 it trades at. A price
  // and its average that are wrong together pass every other check.
  describe('the price range of an asset', () => {
    const priceIs = (dollars: number) => refreshPrices(w, { stock: usd(dollars) });

    it('refuses a price and its average that are both twice the pool price', async () => {
      // The feed says 1,000 dollars, price and average alike, fresh. The token trades at 500, and
      // the keeper's own pool sells it at the feed's price: 0.001 token for a dollar.
      priceIs(1_000);
      await exchangePays(w.cash, w.stock, 1n, 10n);
      expectError(await buy(50), ERR.PriceOutOfRange);
      expect(held()).toEqual(untouched);
    });

    it('refuses a placeholder: one dollar, on every refresh, with an average to match', async () => {
      priceIs(1);
      await exchangePays(w.cash, w.stock, 100n, 1n);
      expectError(await buy(1), ERR.PriceOutOfRange);
    });

    it('takes a price at the floor and at the ceiling, and none past either', async () => {
      // The exchange trades at the feed's price each time, so nothing else is wrong.
      const trades = async (dollars: number) => {
        priceIs(dollars);
        await exchangePays(w.cash, w.stock, 100_000_000n, BigInt(Math.round(dollars * 1e6)));
      };
      await trades(399.99);
      expectError(await buy(10), ERR.PriceOutOfRange);
      await trades(600.01);
      expectError(await buy(10), ERR.PriceOutOfRange);
      await trades(400);
      expectOk(await buy(10));
      at(SESSION + HOUR);
      await trades(600);
      expectOk(await buy(10));
    });

    it('reads the range against a price with another number of decimal places', async () => {
      const write = (value: bigint, exponent: bigint) =>
        writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, {
          value,
          exponent,
          unixTimestamp: SESSION,
        });
      // 600.000001 dollars with 6 decimal places is a millionth over the ceiling.
      write(600_000001n, 6n);
      expectError(await buy(10), ERR.PriceOutOfRange);
      // 399 dollars with none.
      write(399n, 0n);
      expectError(await buy(10), ERR.PriceOutOfRange);
      // Ten dollars with 18, the largest exponent an entry may have.
      write(10n ** 19n, 18n);
      expectError(await buy(10), ERR.PriceOutOfRange);
      // 500.000000 dollars with 6 is inside it.
      write(500_000000n, 6n);
      expectOk(await buy(10));
    });

    it('holds every asset the vault has something of to its range, not only the one traded', async () => {
      await ownerBuys(10, w.other);
      refreshPrices(w, { other: usd(1_000) });
      expectError(await buy(40), ERR.PriceOutOfRange);
    });

    it('never stands between the owner and a trade', async () => {
      priceIs(1_000);
      await ownerBuys(40);
    });
  });

  // Check 8, hostile case A5.
  describe('a fresh price', () => {
    it('refuses a price older than the allowed age', async () => {
      setClock(w.svm, SESSION + 121n);
      expectError(await buy(40), ERR.PriceStale);
      setClock(w.svm, SESSION + 120n);
      expectOk(await buy(40));
    });

    it('refuses a price stamped further ahead of the clock than that', async () => {
      const stamp = (ahead: bigint) =>
        writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, {
          value: PRICE,
          unixTimestamp: SESSION + ahead,
        });
      stamp(121n);
      expectError(await buy(40), ERR.PriceStale);
      stamp(120n);
      expectOk(await buy(40));
    });

    it('refuses an average more than an hour old', async () => {
      const stamp = (age: bigint) =>
        writePrice(w.svm, w.prices, STOCK_PRICE.twapIndex, {
          value: PRICE,
          unixTimestamp: SESSION - age,
        });
      stamp(HOUR + 1n);
      expectError(await buy(40), ERR.PriceStale);
      stamp(HOUR);
      expectOk(await buy(40));
    });

    it('holds every asset the vault has something of to it, not only the one traded', async () => {
      await ownerBuys(10, w.other);
      writePrice(w.svm, w.prices, OTHER_PRICE.priceIndex, {
        value: PRICE,
        unixTimestamp: SESSION - 121n,
      });
      expectError(await buy(40), ERR.PriceStale);
    });
  });

  // The price against its one-hour average: the allowance is 200 bps of the average.
  describe('the price and its average', () => {
    const average = (dollars: number) =>
      writePrice(w.svm, w.prices, STOCK_PRICE.twapIndex, {
        value: usd(dollars),
        unixTimestamp: SESSION,
      });

    it('refuses a price too far under its average', async () => {
      average(510.21);
      expectError(await buy(40), ERR.PriceDeviation);
      average(510.2);
      expectOk(await buy(40));
    });

    it('refuses a price too far over its average', async () => {
      average(490.19);
      expectError(await buy(40), ERR.PriceDeviation);
      average(490.2);
      expectOk(await buy(40));
    });

    it('refuses an average so far from the price that the two cannot be compared', async () => {
      // Ten dollars with 18 decimal places, against an average of 18 billion billion dollars with
      // none: brought to one exponent, their distance times 10,000 does not fit 128 bits.
      await listed(w.stock, range(8, 12));
      writePrice(w.svm, w.prices, STOCK_PRICE.priceIndex, {
        value: 10n ** 19n,
        exponent: 18n,
        unixTimestamp: SESSION,
      });
      writePrice(w.svm, w.prices, STOCK_PRICE.twapIndex, {
        value: 18n * 10n ** 18n,
        exponent: 0n,
        unixTimestamp: SESSION,
      });
      expectError(await buy(10), ERR.PriceDeviation);
    });

    it('refuses a leg when an asset it only holds is too far from its average', async () => {
      await ownerBuys(10, w.other);
      writePrice(w.svm, w.prices, OTHER_PRICE.twapIndex, {
        value: usd(400),
        unixTimestamp: SESSION,
      });
      expectError(await buy(40), ERR.PriceDeviation);
    });
  });

  // Check 9, hostile cases A6 and A6b. The session is 14:30 to 20:00 UTC, Monday to Friday.
  describe('market hours', () => {
    const midnight = SESSION - 15n * HOUR;

    it('refuses a stock on Saturday and on Sunday, with a feed that looks fresh', async () => {
      for (const days of [3n, 4n]) {
        at(SESSION + days * DAY);
        expectError(await buy(40), ERR.MarketClosed);
      }
      at(SESSION + 5n * DAY);
      expectOk(await buy(40));
    });

    it('refuses a stock one minute before the open, and takes it at the open', async () => {
      at(midnight + 14n * HOUR + 29n * 60n);
      expectError(await buy(40), ERR.MarketClosed);
      at(midnight + 14n * HOUR + 30n * 60n - 1n);
      expectError(await buy(40), ERR.MarketClosed);
      at(midnight + 14n * HOUR + 30n * 60n);
      expectOk(await buy(40));
    });

    it('takes a stock in the last second of the session and refuses it at the close', async () => {
      at(midnight + 20n * HOUR);
      expectError(await buy(40), ERR.MarketClosed);
      at(midnight + 20n * HOUR - 1n);
      expectOk(await buy(40));
    });

    it('refuses a stock on a closed day, with a feed that looks fresh', async () => {
      const day = Number(SESSION / DAY);
      expectOk(await send(w.svm, w.admin, [await setClosedDayInstruction(w.admin, day, true)]));
      expectError(await buy(40), ERR.MarketClosed);
      expectOk(await send(w.svm, w.admin, [await setClosedDayInstruction(w.admin, day, false)]));
      expectOk(await buy(40));
    });

    it('refuses a stock before the time the market is closed until', async () => {
      expectOk(
        await send(w.svm, w.admin, [await setClosedUntilInstruction(w.admin, SESSION + 60n)]),
      );
      expectError(await buy(40), ERR.MarketClosed);
      at(SESSION + 59n);
      expectError(await buy(40), ERR.MarketClosed);
      at(SESSION + 60n);
      expectOk(await buy(40));
    });

    it('can still be closed today when the guardian has used up the 32 closed days', async () => {
      const { svm, admin, guardian } = w;
      for (let day = 1; day <= 32; day += 8)
        expectOk(
          await send(
            svm,
            guardian,
            await Promise.all(
              Array.from({ length: 8 }, (_, i) => addClosedDayInstruction(guardian, day + i)),
            ),
          ),
        );
      const today = Number(SESSION / DAY);
      // No slot is left for today, for either key, and the stock still trades.
      expectError(
        await send(svm, admin, [await setClosedDayInstruction(admin, today, true)]),
        ERR.ParamOutOfBounds,
      );
      expectError(
        await send(svm, guardian, [await addClosedDayInstruction(guardian, today)]),
        ERR.ParamOutOfBounds,
      );
      expectOk(await buy(10));
      // What still closes the day: the time the market is closed until, which the guardian can
      // push later, or the admin opens a slot and closes today in it.
      const tomorrow = (BigInt(today) + 1n) * DAY;
      expectOk(await send(svm, guardian, [await extendClosedUntilInstruction(guardian, tomorrow)]));
      at(SESSION + HOUR);
      expectError(await buy(10), ERR.MarketClosed);
      expectOk(
        await send(svm, admin, [
          await setClosedDayInstruction(admin, 1, false),
          await setClosedDayInstruction(admin, today, true),
        ]),
      );
    });

    it('does not take an empty slot of the closed days for a day', async () => {
      // Day zero, a Thursday, at 15:00. Every empty slot of the list holds a zero.
      at(15n * HOUR);
      expectOk(await buy(40));
    });

    it('trades an asset that has no session at any hour', async () => {
      at(SESSION + 3n * DAY);
      expectOk(await buy(20, w.other));
    });
  });

  // Check 10, hostile case A12. The stock token's mint carries a multiplier and the next one.
  describe('a multiplier change', () => {
    const scaled = (change: (value: DataView) => void) => {
      const account = w.svm.getAccount(w.stock.address);
      if (!account.exists) throw new Error('no stock mint');
      const data = new Uint8Array(account.data);
      const entry = mintExtensionEntries(data).find((e) => e.type === SCALED_UI_AMOUNT_EXTENSION);
      if (!entry) throw new Error('the mint has no scaled UI amount');
      change(new DataView(data.buffer, entry.at - 4, entry.length + 4));
      w.svm.setAccount({ ...account, data });
    };
    // After the 4 bytes of the entry's own header: authority 32, multiplier f64, time i64, next f64.
    // The mint starts with its next multiplier equal to the one it has; a split doubles it.
    const changesAt = (time: bigint) =>
      scaled((value) => {
        value.setBigInt64(4 + 40, time, true);
        value.setFloat64(4 + 48, value.getFloat64(4 + 32, true) * 2, true);
      });

    it('refuses a stock within a day before its multiplier changes', async () => {
      changesAt(SESSION + DAY - 1n);
      expectError(await buy(40), ERR.MultiplierWindow);
      changesAt(SESSION + DAY);
      expectOk(await buy(40));
    });

    it('refuses a stock within a day after its multiplier changed', async () => {
      changesAt(SESSION - DAY + 1n);
      expectError(await buy(40), ERR.MultiplierWindow);
      changesAt(SESSION - DAY);
      expectOk(await buy(40));
    });

    it('takes a mint whose next multiplier is the one it has: nothing changes', async () => {
      scaled((value) => {
        value.setBigInt64(4 + 40, SESSION, true);
        value.setFloat64(4 + 48, value.getFloat64(4 + 32, true), true);
      });
      expectOk(await buy(40));
    });

    it('refuses a mint whose multiplier cannot be read', async () => {
      // The entry says it is 48 bytes long. The 8 bytes it gave up read as one more entry, of a
      // type nobody knows, so the list still runs to its end.
      scaled((value) => {
        value.setUint16(2, 48, true);
        value.setUint16(4 + 48, 0xffff, true);
        value.setUint16(4 + 50, 4, true);
      });
      expectError(await buy(40), ERR.MultiplierWindow);
    });

    it('never stands between the owner and a trade', async () => {
      changesAt(SESSION + HOUR);
      await ownerBuys(40);
    });
  });

  it("puts nothing in the owner's way, with every one of the keeper's rules against a trade", async () => {
    const { svm, admin, guardian, owner, vault } = w;
    // Paused, the stock switched off, every closed day taken, closed for good, the loss counter
    // full, and then a Saturday with every price ten days old.
    expectOk(await send(svm, guardian, [await pauseKeeperInstruction(guardian)]));
    await listed(w.stock, { flags: 0 });
    for (let day = 1; day <= 32; day += 8)
      expectOk(
        await send(
          svm,
          guardian,
          await Promise.all(
            Array.from({ length: 8 }, (_, i) => addClosedDayInstruction(guardian, day + i)),
          ),
        ),
      );
    const forever = 9_223_372_036_854_775_807n;
    expectOk(await send(svm, guardian, [await extendClosedUntilInstruction(guardian, forever)]));
    patchVault(svm, vault, { lossAccum: 18_446_744_073_709_551_615n, lossTs: SESSION });
    setClock(svm, SESSION + 10n * DAY);
    expectError(await buy(10), ERR.KeeperPaused);

    // The owner deposits, buys, sells, sets targets, switches auto-follow and takes it all out.
    await mintTo(svm, admin, w.cash, owner.address, 5n * USD);
    expectOk(
      await send(svm, owner, [
        await depositInstruction({ owner, vault, mint: w.cash, amount: 5n * USD }),
      ]),
    );
    await ownerBuys(20);
    expectOk(
      await swapThroughExchange(w, { amountIn: 1_000000n, inputMint: w.stock, outputMint: w.cash }),
    );
    expectOk(
      await send(svm, owner, [
        await setTargetsInstruction({
          owner,
          vault,
          targets: [{ mint: w.stock.address, targetBps: 2_000 }],
        }),
      ]),
    );
    expectOk(await send(svm, owner, [await setAutoFollowInstruction({ owner, vault, on: true })]));
    await createAta(svm, owner, owner.address, w.stock);
    const stock = balance(svm, w.vaultStock);
    const cash = balance(svm, w.vaultCash);
    expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint: w.stock, amount: stock }),
        await withdrawInstruction({ owner, vault, mint: w.cash, amount: cash }),
      ]),
    );
    expect(held()).toEqual({ cash: 0n, stock: 0n, other: 0n });
  });

  // Hostile case A9b, for the keeper: the issuer points the mint at a hook program after listing.
  it('refuses an asset whose issuer gave it a transfer hook program', async () => {
    const hook = await loadHook(w.svm);
    await setHook(w.svm, w.admin, w.stock, hook);
    expectError(await buy(40), ERR.HookNotAllowed);
    expect(held()).toEqual(untouched);
  });

  // Check 6, hostile case A3.
  describe('the cooldown', () => {
    it('allows one trade per asset per cooldown', async () => {
      expectOk(await buy(20));
      expectError(await buy(20), ERR.Cooldown);
      at(SESSION + HOUR - 1n);
      expectError(await buy(20), ERR.Cooldown);
      at(SESSION + HOUR);
      expectOk(await buy(20));
      expect(position(w.stock).lastKeeperTs).toBe(SESSION + HOUR);
    });

    it('stops a second trade in the asset within the hour, the same way or back', async () => {
      await ownerBuys(60);
      expectOk(await sell(5));
      // Over its target still, and it could be sold again: not within the hour.
      expectError(await sell(5), ERR.Cooldown);
      expectError(await buy(5), ERR.Cooldown);
    });

    it('is kept per asset', async () => {
      expectOk(await buy(20));
      expectOk(await buy(20, w.other));
      expect(position(w.other).lastKeeperTs).toBe(SESSION);
    });

    it('is not used up by a leg of nothing: a zero amount is refused', async () => {
      // The reviewer's case: a stolen key sends a leg that moves nothing each hour, and the real
      // leg is refused for the hour after it.
      expectError(await keeperLeg(w, { amountIn: 0n }), ERR.NothingTraded);
      expect(position(w.stock).lastKeeperTs).toBe(0n);
      at(SESSION + 1n);
      expectOk(await buy(40));
    });
  });

  // Check 5, hostile case A7.
  describe('toward the target, and not past it', () => {
    it('does not buy an asset that is at its target or over it', async () => {
      await ownerBuys(50);
      expectError(await buy(1), ERR.NotTowardTarget);
      await ownerBuys(5);
      expectError(await buy(1), ERR.NotTowardTarget);
    });

    it('does not sell an asset that is at its target or under it', async () => {
      await ownerBuys(50);
      expectError(await sell(1), ERR.NotTowardTarget);
      expectOk(
        await swapThroughExchange(w, {
          amountIn: stockFor(10n * USD),
          inputMint: w.stock,
          outputMint: w.cash,
        }),
      );
      expectError(await sell(1), ERR.NotTowardTarget);
    });

    it('does not buy an asset whose target is zero', async () => {
      const { owner, vault } = w;
      expectOk(
        await send(w.svm, owner, [
          await setTargetsInstruction({
            owner,
            vault,
            targets: [{ mint: w.stock.address, targetBps: 0 }],
          }),
          await setAutoFollowInstruction({ owner, vault, on: true }),
        ]),
      );
      expectError(await buy(1), ERR.NotTowardTarget);
    });

    it('sells an asset whose target is zero down to nothing', async () => {
      await ownerBuys(40);
      const { owner, vault } = w;
      expectOk(
        await send(w.svm, owner, [
          await setTargetsInstruction({
            owner,
            vault,
            targets: [{ mint: w.stock.address, targetBps: 0 }],
          }),
          await setAutoFollowInstruction({ owner, vault, on: true }),
        ]),
      );
      expectOk(await sell(40));
      expect(held()).toEqual(untouched);
    });

    it('may end a purchase anywhere inside the band above the target, and not past it', async () => {
      expectError(await buy(50.6), ERR.PastTarget);
      expect(held()).toEqual(untouched);
      // 50.5% of the vault: the far edge of a band of 50 bps.
      expectOk(await buy(50.5));
    });

    it('may end a sale anywhere inside the band under the target, and not past it', async () => {
      await ownerBuys(80);
      expectError(await sell(30.6), ERR.PastTarget);
      expectOk(await sell(30.5));
    });

    // Invariant I5: no leg leaves an asset further from its target than it found it.
    describe('and no further from the target than it began', () => {
      it('takes an asset from outside the band to inside it, on either side', async () => {
        await ownerBuys(40);
        // 40% of the vault, ten points under: to 50.3%, inside the band above the target.
        expectOk(await buy(10.3));
        expect(balance(w.svm, w.vaultStock)).toBe(stockFor(50_300_000n));
      });

      it('takes an asset from just over its target to just under it, when that is closer', async () => {
        await ownerBuys(50);
        await ownerBuys(1, w.other);
        // 50.4% of a vault of 100: 0.4 over. A sale of 0.7 leaves it 0.3 under.
        expectOk(
          await swapThroughExchange(w, {
            amountIn: 400_000n,
            inputMint: w.cash,
            outputMint: w.stock,
          }),
        );
        expectOk(await sell(0.7));
      });

      it('refuses a leg that crosses the target and ends further from it, inside the band', async () => {
        await ownerBuys(50);
        expectOk(
          await swapThroughExchange(w, {
            amountIn: 200_000n,
            inputMint: w.cash,
            outputMint: w.stock,
          }),
        );
        // 50.2%: 0.2 over. A sale of 0.5 would leave it 0.3 under, inside the band and further.
        expectError(await sell(0.5), ERR.PastTarget);
        // To exactly as far on the other side is not further.
        expectOk(await sell(0.4));
      });

      it('stops a stolen key bouncing an asset between the edges of its band (A3)', async () => {
        // The reviewer's sequence. The stock at its target, the other asset a point under its 30%,
        // and an exchange that pays the tolerance less than the reference both ways.
        await ownerBuys(50);
        await ownerBuys(29, w.other);
        await exchangePays(w.cash, w.other, 397n, 2_000n);
        await exchangePays(w.other, w.cash, 49_625n, 10_000n);
        const sellOther = (dollars: bigint) =>
          keeperLeg(w, { amountIn: stockFor(dollars), inputMint: w.other, outputMint: w.cash });
        // 29% to 30.48%: toward the target, inside the band, and closer than it was.
        expectOk(await keeperLeg(w, { amountIn: 1_490_000n, outputMint: w.other }));
        // A cooldown later, back down to 29.51%: toward the target and inside the band, and a
        // hair further from it. That was the leg that let the bounce go on; it is refused.
        at(SESSION + HOUR);
        expectError(await sellOther(970_000n), ERR.PastTarget);
        // What is left to a keeper is a leg that ends no further out: here, at most to 29.52%.
        // (Amounts the exchange's rate divides exactly, so the tolerance is not what refuses.)
        expectError(await sellOther(966_800n), ERR.PastTarget);
        expectOk(await sellOther(966_400n));
      });
    });
  });

  // Check 4, hostile cases A1 and A2: the least that must come back, at the reference price.
  describe('the value of the trade', () => {
    it('refuses a purchase at a price worse than the tolerance', async () => {
      // 99.2% of what the reference price says, where the tolerance is 75 bps.
      await exchangePays(w.cash, w.stock, 992n, 5_000n);
      expectError(await buy(40), ERR.ReceivedTooLittle);
      expect(held()).toEqual(untouched);
    });

    it('takes a purchase at exactly the tolerance, and counts what it lost', async () => {
      await exchangePays(w.cash, w.stock, 3_969n, 20_000n);
      expectError(await buy(40), ERR.ReceivedTooLittle);
      await exchangePays(w.cash, w.stock, 397n, 2_000n);
      const meta = expectOk(await buy(40));
      // 0.75% of 40 dollars is 30 cents, which is 30 bps of the 100 dollars the vault was worth.
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]).toMatchObject({
        spent: 40n * USD,
        loss: 300_000n,
        lossUsedBps: 30,
      });
      const state = readVault(w.svm, w.vault);
      expect([state.lossAccum, state.lossTs]).toEqual([300_000n, SESSION]);
    });

    it('refuses a sale at a price worse than the tolerance, and takes one at it', async () => {
      await ownerBuys(80);
      await exchangePays(w.stock, w.cash, 4_961n, 1_000n);
      expectError(await sell(30), ERR.ReceivedTooLittle);
      await exchangePays(w.stock, w.cash, 49_625n, 10_000n);
      const meta = expectOk(await sell(30));
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]).toMatchObject({
        received: 29_775_000n,
        loss: 225_000n,
      });
    });

    it('counts no loss for a trade better than the reference price', async () => {
      await exchangePays(w.cash, w.stock, 201n, 1_000n);
      const meta = expectOk(await buy(40));
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]).toMatchObject({ loss: 0n });
      expect(readVault(w.svm, w.vault).lossAccum).toBe(0n);
    });

    it('cannot send what it bought to the keeper (A1)', async () => {
      const keepers = await tokenAccountFor(w, w.keeper.address, w.stock);
      expectError(
        await keeperLeg(w, { amountIn: 40n * USD, destination: keepers }),
        ERR.ReceivedTooLittle,
      );
      expect(held()).toEqual(untouched);
      expect(balance(w.svm, keepers)).toBe(0n);
    });

    it('cannot spend more than the keeper said', async () => {
      expectError(
        await keeperLeg(w, { amountIn: 40n * USD, maxIn: 40n * USD - 1n }),
        ERR.SpentTooMuch,
      );
      expect(held()).toEqual(untouched);
    });
  });

  // Check 7: what the legs of a week may lose, at the reference price.
  describe('the weekly loss cap', () => {
    /** Half a percent worse than the reference price, both ways. */
    const halfPercentWorse = async () => {
      await exchangePays(w.cash, w.stock, 199n, 1_000n);
      await exchangePays(w.cash, w.other, 199n, 1_000n);
    };

    it('refuses a leg whose loss takes the week past the cap', async () => {
      await halfPercentWorse();
      // 40 dollars at half a percent is 20 cents: 20 bps of the vault's 100 dollars.
      await setParams({ lossCapBps: 19 });
      expectError(await buy(40), ERR.LossCapReached);
      expect(held()).toEqual(untouched);
      await setParams({ lossCapBps: 20 });
      expectOk(await buy(40));
      expect(readVault(w.svm, w.vault).lossAccum).toBe(200_000n);
    });

    it('adds the losses of the week up, across assets', async () => {
      await halfPercentWorse();
      await setParams({ lossCapBps: 30 });
      expectOk(await buy(40));
      // 20 cents are used. 30 bps of what the vault is worth now is a little under 30 cents.
      expectError(await buy(20, w.other), ERR.LossCapReached);
      const meta = expectOk(await buy(19, w.other));
      expect(readVault(w.svm, w.vault).lossAccum).toBe(295_000n);
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]?.lossUsedBps).toBe(29);
    });

    it('forgets a loss in a straight line over seven days', async () => {
      await halfPercentWorse();
      await setParams({ lossCapBps: 20 });
      expectOk(await buy(40));
      expectError(await buy(20, w.other), ERR.LossCapReached);
      // Half of the week on, half of the 20 cents is forgotten: 10 cents are free again.
      at(SESSION + (7n * DAY) / 2n);
      expectError(await buy(20, w.other), ERR.LossCapReached);
      const meta = expectOk(await buy(19, w.other));
      const state = readVault(w.svm, w.vault);
      expect([state.lossAccum, state.lossTs]).toEqual([195_000n, now(w.svm)]);
      expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]?.loss).toBe(95_000n);
    });

    it('has forgotten it all after seven days', async () => {
      patchVault(w.svm, w.vault, { lossAccum: 5_000_000n, lossTs: SESSION - 7n * DAY });
      await halfPercentWorse();
      await setParams({ lossCapBps: 20 });
      expectOk(await buy(40));
      expect(readVault(w.svm, w.vault).lossAccum).toBe(200_000n);
    });

    it('reads nothing of a counter last written a month ago', async () => {
      patchVault(w.svm, w.vault, { lossAccum: 5_000_000n, lossTs: SESSION - 30n * DAY });
      await halfPercentWorse();
      expectOk(await buy(40));
      expect(readVault(w.svm, w.vault).lossAccum).toBe(200_000n);
    });

    it('reads a counter stamped ahead of the clock in full, and no more', async () => {
      // No instruction writes a time that has not come; only a test can show the counter is not
      // read as more than it holds.
      patchVault(w.svm, w.vault, { lossAccum: 150_000n, lossTs: SESSION + DAY });
      await halfPercentWorse();
      expectOk(await buy(40));
      const state = readVault(w.svm, w.vault);
      expect([state.lossAccum, state.lossTs]).toEqual([350_000n, SESSION]);
    });

    it('starts the seven days again for all that is left when a later leg loses', async () => {
      await halfPercentWorse();
      expectOk(await buy(40));
      // Half a week on, 100,000 of the 200,000 are left, and a small purchase loses 15 more.
      at(SESSION + (7n * DAY) / 2n);
      expectOk(await keeperLeg(w, { amountIn: 3_000n, outputMint: w.other }));
      const state = readVault(w.svm, w.vault);
      expect([state.lossAccum, state.lossTs]).toEqual([100_015n, now(w.svm)]);
      // At the end of the first week a counter left alone would read nothing. This one has half
      // of its seven days to go: 50,007 are still held against the next loss of 100,000.
      at(SESSION + 7n * DAY);
      expectOk(await buy(20, w.other));
      expect(readVault(w.svm, w.vault).lossAccum).toBe(150_007n);
    });

    // What a person is told: no more than 2% of the vault in any seven days. The counter drains
    // as it fills, so seven days can hold just under twice the parameter, and it starts at 100.
    it('keeps a week under 2% of the vault at the starting cap, used in full twice', async () => {
      expect(DEFAULT_PARAMS.lossCapBps).toBe(100);
      await setParams({ toleranceBps: 300, bandBps: 500 });
      // The exchange pays 3% less than the reference when the keeper buys.
      await exchangePays(w.cash, w.stock, 97n, 500n);
      await exchangePays(w.cash, w.other, 97n, 500n);
      const lossOf = (meta: ReturnType<typeof expectOk>) =>
        events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]?.loss ?? 0n;
      // At once: 33.333 dollars at 3% loses 0.99999 of the 1.000000 that is 1% of the vault.
      const first = lossOf(expectOk(await keeperLeg(w, { amountIn: 33_333_000n })));
      expect(first).toBe(999_990n);
      const more = () => keeperLeg(w, { amountIn: 500n, outputMint: w.other });
      expectError(await more(), ERR.LossCapReached);
      // Seven days on, to the second, the counter reads nothing and the cap is there in full.
      // The owner sells the stock, so the keeper has it to buy again.
      at(SESSION + 7n * DAY);
      expectOk(
        await swapThroughExchange(w, {
          amountIn: balance(w.svm, w.vaultStock),
          inputMint: w.stock,
          outputMint: w.cash,
        }),
      );
      expect(balance(w.svm, w.vaultCash)).toBe(99_000_010n);
      const second = lossOf(expectOk(await keeperLeg(w, { amountIn: 33_000_000n })));
      expect(second).toBe(990_000n);
      expectError(await more(), ERR.LossCapReached);
      // Both inside one closed window of seven days: 1.98999 of the 100 the vault began with.
      expect(first + second).toBe(1_989_990n);
      expect(first + second).toBeLessThan((CASH * 2n) / 100n);
    });

    it('does not hold a leg that loses nothing to a cap that is used up', async () => {
      // Five dollars lost this second, of a vault worth 100: far past the cap.
      patchVault(w.svm, w.vault, { lossAccum: 5_000_000n, lossTs: SESSION });
      expectOk(await buy(20));
      await halfPercentWorse();
      expectError(await buy(20, w.other), ERR.LossCapReached);
    });

    it('leaves the counter alone when a leg loses nothing', async () => {
      patchVault(w.svm, w.vault, { lossAccum: 150_000n, lossTs: SESSION - DAY });
      expectOk(await buy(40));
      const state = readVault(w.svm, w.vault);
      expect([state.lossAccum, state.lossTs]).toEqual([150_000n, SESSION - DAY]);
    });
  });

  describe('sync_balances', () => {
    const sync = async (
      tokenAccounts: Address[],
      options: { vault?: Address; signer?: KeyPairSigner; config?: Address } = {},
    ) => {
      const signer = options.signer ?? w.keeper;
      const vault = options.vault ?? w.vault;
      return send(w.svm, signer, [
        await syncBalancesInstruction({ signer, vault, tokenAccounts, config: options.config }),
      ]);
    };

    it("records what the vault's own token accounts hold, for its owner or its keeper", async () => {
      await mintTo(w.svm, w.admin, w.stock, w.vault, 777n);
      await mintTo(w.svm, w.admin, w.other, w.vault, 5n);
      expect(trackedFor(w.svm, w.vault, w.stock.address)).toBe(0n);
      expectOk(await sync([w.vaultStock], { signer: w.owner }));
      expect(trackedFor(w.svm, w.vault, w.stock.address)).toBe(777n);
      expectOk(await sync([w.vaultStock, w.vaultOther]));
      expect(trackedFor(w.svm, w.vault, w.other.address)).toBe(5n);
    });

    it('is not for anyone else: not the guardian, the admin or a stranger', async () => {
      await mintTo(w.svm, w.admin, w.other, w.vault, 5n);
      for (const signer of [w.guardian, w.admin, w.stranger])
        expectError(await sync([w.vaultOther], { signer }), ERR.NotKeeper);
      expect(trackedFor(w.svm, w.vault, w.other.address)).toBe(0n);
    });

    it('needs that key to sign', async () => {
      const instruction = await syncBalancesInstruction({
        signer: w.keeper,
        vault: w.vault,
        tokenAccounts: [],
      });
      expectError(await send(w.svm, w.stranger, [unsigned(instruction)]), ANCHOR.AccountNotSigner);
    });

    it('is for the keeper the vault names, when it names one', async () => {
      patchVault(w.svm, w.vault, { keeper: w.stranger.address });
      expectError(await sync([]), ERR.NotKeeper);
      expectOk(await sync([], { signer: w.stranger }));
      expectOk(await sync([], { signer: w.owner }));
    });

    it('refuses a forged Config that names the signer as keeper', async () => {
      const forged = await forgeConfig(w.svm, { defaultKeeper: w.stranger.address });
      expectError(await sync([], { signer: w.stranger, config: forged }), ANCHOR.ConstraintSeeds);
    });

    // The reviewer's case: one raw unit of an asset the keeper may not trade, sent to the vault's
    // own account and recorded, stopped every leg of the vault. A stranger can still send it; it
    // can no longer have it recorded.
    it('does not let a stranger stop the keeper with one raw unit of an asset that is off', async () => {
      await listed(w.other, { flags: 0 }, OTHER_PRICE, 0);
      await mintToAccount(w.svm, w.stranger, w.other, w.vaultOther, 1n);
      expectError(await sync([w.vaultOther], { signer: w.stranger }), ERR.NotKeeper);
      expectOk(await buy(10));
      // Recorded by the keeper itself, the unit does stop it: every position the vault holds
      // something of needs its reference.
      expectOk(await sync([w.vaultOther]));
      at(SESSION + HOUR);
      expectError(await buy(10), ERR.KeeperAssetOff);
    });

    it('does not let a gift move the weights until the owner or the keeper records it', async () => {
      await ownerBuys(50);
      expectError(await buy(1), ERR.NotTowardTarget);
      // 20 dollars' worth of the other asset arrives. Not recorded, nothing changes.
      await mintToAccount(w.svm, w.stranger, w.other, w.vaultOther, stockFor(20n * USD));
      expectError(await sync([w.vaultOther], { signer: w.stranger }), ERR.NotKeeper);
      expectError(await buy(1), ERR.NotTowardTarget);
      // Recorded, the vault is worth 120 and the stock is 41.7% of it.
      expectOk(await sync([w.vaultOther], { signer: w.owner }));
      expectOk(await buy(10));
    });

    // Hostile case A10: a balance moved from outside.
    it('lets a leg see a token that came in from outside', async () => {
      // 30 dollars of the other asset arrive in the vault's account: it is worth 130, and half of
      // that is 65. Until the balance is recorded the vault counts as worth 100.
      await mintTo(w.svm, w.admin, w.other, w.vault, stockFor(30n * USD));
      expectError(await buy(51), ERR.PastTarget);
      expectOk(await sync([w.vaultOther]));
      expectOk(await buy(65));
    });

    it('reads only the one token account the vault uses for a mint', async () => {
      const loose = await createLooseTokenAccount(w.svm, w.admin, w.other, w.vault);
      await mintToAccount(w.svm, w.admin, w.other, loose, 4n);
      const strangers = await mintTo(w.svm, w.admin, w.other, w.stranger.address, 9n);
      for (const account of [loose, strangers, w.other.address, w.prices])
        expectError(await sync([account]), ERR.AccountTampered);
      expect(trackedFor(w.svm, w.vault, w.other.address)).toBe(0n);
    });

    it("records nothing from that account once it is no longer the vault's", async () => {
      // The account at the vault's own address for the mint, with another owner written into it:
      // no instruction of this program lets that happen, so only a test can show it.
      await mintTo(w.svm, w.admin, w.other, w.vault, 5n);
      const account = w.svm.getAccount(w.vaultOther);
      if (!account.exists) throw new Error('no token account');
      const data = new Uint8Array(account.data);
      data.set(getAddressEncoder().encode(w.stranger.address), 32);
      w.svm.setAccount({ ...account, data });
      expectError(await sync([w.vaultOther]), ERR.AccountTampered);
      expect(trackedFor(w.svm, w.vault, w.other.address)).toBe(0n);
    });

    it('records nothing for a mint that is not one of the positions', async () => {
      const unlisted = await mintTo(w.svm, w.admin, w.unlisted, w.vault, 9n);
      expectError(await sync([unlisted, w.vaultCash]), ERR.MintNotAccepted);
      expectError(await sync([w.vaultCash]), ERR.MintNotAccepted);
    });

    it('takes only a vault of this program', async () => {
      const forged = (await generateKeyPairSigner()).address;
      const real = w.svm.getAccount(w.vault);
      if (!real.exists) throw new Error('no vault');
      w.svm.setAccount({ ...real, address: forged, programAddress: w.stranger.address });
      expectError(await sync([], { vault: forged }), ANCHOR.AccountOwnedByWrongProgram);
    });
  });
});
