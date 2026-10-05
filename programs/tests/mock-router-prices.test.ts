import {
  type Address,
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  type KeyPairSigner,
  lamports,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANCHOR,
  createWorld,
  expectError,
  expectOk,
  fundedSigner,
  MOCK_ROUTER_PROGRAM,
  now,
  send,
  setClock,
  unsigned,
} from './src/env';
import {
  createPricesInstructions,
  initPairInstruction,
  initPricedPairInstruction,
  initPricesInstruction,
  initRouterInstruction,
  MOCK_ROUTER_ERR,
  PRICES_BYTES,
  type PricedPair,
  routeInstruction,
  routerAddress,
  setPricedPairInstruction,
  setPriceInstruction,
  setPriceWriterInstruction,
  writePriceInstruction,
} from './src/mock-router';
import { createPriceAccount, writePrice } from './src/prices';
import {
  ata,
  balance,
  createAta,
  createMint,
  mintTo,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';

/** Where SPYx's price and its one-hour average sit in Scope's price account on mainnet. */
const PRICE_INDEX = 344;
const TWAP_INDEX = 279;
/** 500 dollars, as a Scope value with 8 decimal places. */
const PRICE = 500_00000000n;
const T0 = 1_791_385_200n;

// The test network's stand-in for Kamino Scope: a price account in Scope's layout that the test
// exchange owns and its admin writes, and pairs that pay its price less a spread.
describe("the test exchange's price account", () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let stranger: KeyPairSigner;
  let prices: Address;
  let router: Address;

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    stranger = await fundedSigner(svm);
    router = await routerAddress();
    setClock(svm, T0);
    expectOk(await send(svm, admin, [await initRouterInstruction(admin)]));
    prices = await made();
  });

  const rent = () => svm.minimumBalanceForRentExemption(PRICES_BYTES);
  /** A price account made the way the set-up script makes it: created and taken in one go. */
  async function made(): Promise<Address> {
    const key = await generateKeyPairSigner();
    expectOk(await send(svm, admin, await createPricesInstructions(admin, key, rent())));
    return key.address;
  }
  const data = (account: Address) => {
    const found = svm.getAccount(account);
    if (!found.exists) throw new Error(`no account at ${account}`);
    return new Uint8Array(found.data);
  };
  const entry = (account: Address, index: number) =>
    data(account).slice(40 + 56 * index, 40 + 56 * (index + 1));
  const write = (who: KeyPairSigner, value = PRICE, account = prices) =>
    writePriceInstruction(who, account, {
      priceIndex: PRICE_INDEX,
      twapIndex: TWAP_INDEX,
      price: { value, unixTimestamp: now(svm) },
      twap: { value, unixTimestamp: now(svm) - 60n },
    });
  /** An account of the exchange's, the size of a price account, that no instruction made. */
  const planted = (bytes?: Uint8Array, owner: Address = MOCK_ROUTER_PROGRAM) =>
    createPriceAccount(svm, owner).then((account) => {
      const found = svm.getAccount(account);
      if (!found.exists) throw new Error('no account');
      svm.setAccount({ ...found, data: bytes ?? new Uint8Array(Number(PRICES_BYTES)) });
      return account;
    });

  describe('taking an account as the price account', () => {
    let fresh: LiteSVM;
    let deployer: KeyPairSigner;

    beforeEach(async () => {
      ({ svm: fresh, deployer } = await createWorld());
      expectOk(await send(fresh, deployer, [await initRouterInstruction(deployer)]));
    });

    const blank = async (size = Number(PRICES_BYTES), owner: Address = MOCK_ROUTER_PROGRAM) => {
      const account = (await generateKeyPairSigner()).address;
      fresh.setAccount({
        address: account,
        data: new Uint8Array(size),
        executable: false,
        lamports: lamports(fresh.minimumBalanceForRentExemption(BigInt(size))),
        programAddress: owner,
        space: BigInt(size),
      });
      return account;
    };
    const take = async (account: Address, who = deployer) =>
      send(fresh, who, [await initPricesInstruction(who, account)]);

    it("stamps Scope's header on it and keeps its address", async () => {
      const account = await blank();
      expectOk(await take(account));
      const found = fresh.getAccount(account);
      if (!found.exists) throw new Error('no account');
      // sha256("account:OraclePrices")[0..8], then where Scope keeps its mappings account.
      expect([...found.data.slice(0, 8)]).toEqual([89, 128, 118, 221, 6, 72, 180, 146]);
      expect(getAddressDecoder().decode(found.data.slice(8, 40))).toBe(await routerAddress());
      expect(found.data.length).toBe(28_712);
      const stored = fresh.getAccount(await routerAddress());
      if (!stored.exists) throw new Error('no router');
      // Router { admin, bump, prices, price_writer } behind the eight bytes that say what it is.
      expect(getAddressDecoder().decode(stored.data.slice(41, 73))).toBe(account);
    });

    it('is the admin alone, and the admin signs', async () => {
      const account = await blank();
      const other = await fundedSigner(fresh);
      expectError(await take(account, other), ANCHOR.ConstraintHasOne);
      expectError(
        await send(fresh, other, [unsigned(await initPricesInstruction(deployer, account))]),
        ANCHOR.AccountNotSigner,
      );
    });

    it('takes one, once', async () => {
      expectOk(await take(await blank()));
      expectError(await take(await blank()), MOCK_ROUTER_ERR.PricesAlreadySet);
    });

    it('refuses an account that is not the size of a Scope price account', async () => {
      for (const size of [28_711, 28_713, 0])
        expectError(await take(await blank(size)), MOCK_ROUTER_ERR.NotPriceAccount);
    });

    it('refuses an account another program owns', async () => {
      const other = await fundedSigner(fresh);
      expectError(await take(await blank(28_712, other.address)), MOCK_ROUTER_ERR.NotPriceAccount);
    });

    it('refuses an account that already holds something', async () => {
      const account = await blank();
      const found = fresh.getAccount(account);
      if (!found.exists) throw new Error('no account');
      const written = new Uint8Array(found.data);
      written[39] = 1;
      fresh.setAccount({ ...found, data: written });
      expectError(await take(account), MOCK_ROUTER_ERR.NotPriceAccount);
    });
  });

  describe('writing a price', () => {
    it("puts an asset's price and its average where Scope has them, byte for byte", async () => {
      svm.warpToSlot(77n);
      expectOk(await send(svm, admin, [await write(admin)]));
      // The same two entries written by hand, the way every earlier test wrote a Scope account.
      const byHand = await createPriceAccount(svm, MOCK_ROUTER_PROGRAM);
      writePrice(svm, byHand, PRICE_INDEX, { value: PRICE, unixTimestamp: T0 });
      writePrice(svm, byHand, TWAP_INDEX, { value: PRICE, unixTimestamp: T0 - 60n });
      expect(entry(prices, PRICE_INDEX)).toEqual(entry(byHand, PRICE_INDEX));
      expect(entry(prices, TWAP_INDEX)).toEqual(entry(byHand, TWAP_INDEX));
      const view = new DataView(entry(prices, PRICE_INDEX).buffer);
      expect([0, 8, 16, 24].map((at) => view.getBigUint64(at, true))).toEqual([PRICE, 8n, 77n, T0]);
      // Nothing else in the account moved.
      const rest = data(prices);
      rest.fill(0, 40 + 56 * PRICE_INDEX, 40 + 56 * (PRICE_INDEX + 1));
      rest.fill(0, 40 + 56 * TWAP_INDEX, 40 + 56 * (TWAP_INDEX + 1));
      expect(rest.slice(40).every((byte) => byte === 0)).toBe(true);
    });

    it('keeps the exponent and the time it is given, for each entry', async () => {
      expectOk(
        await send(svm, admin, [
          await writePriceInstruction(admin, prices, {
            priceIndex: 0,
            twapIndex: 511,
            price: { value: 7n, exponent: 2n, unixTimestamp: 5n },
            twap: { value: 9n, exponent: 18n, unixTimestamp: 6n },
          }),
        ]),
      );
      const read = (index: number) => {
        const view = new DataView(entry(prices, index).buffer);
        return [0, 8, 24].map((at) => view.getBigUint64(at, true));
      };
      expect(read(0)).toEqual([7n, 2n, 5n]);
      expect(read(511)).toEqual([9n, 18n, 6n]);
    });

    it('is the admin, or the one key the admin names, and nobody else', async () => {
      const writer = await fundedSigner(svm);
      expectError(
        await send(svm, stranger, [await write(stranger)]),
        MOCK_ROUTER_ERR.NotPriceWriter,
      );
      expectError(await send(svm, writer, [await write(writer)]), MOCK_ROUTER_ERR.NotPriceWriter);
      expectOk(await send(svm, admin, [await setPriceWriterInstruction(admin, writer.address)]));
      expectOk(await send(svm, writer, [await write(writer, 2n * PRICE)]));
      expectOk(await send(svm, admin, [await write(admin)]));
      expectError(
        await send(svm, stranger, [await write(stranger)]),
        MOCK_ROUTER_ERR.NotPriceWriter,
      );
      // The role is taken away by naming nobody.
      const nobody = address('11111111111111111111111111111111');
      expectOk(await send(svm, admin, [await setPriceWriterInstruction(admin, nobody)]));
      expectError(await send(svm, writer, [await write(writer)]), MOCK_ROUTER_ERR.NotPriceWriter);
    });

    it('does not take the zero address, which names no writer, for a writer', async () => {
      // A router with no price writer holds all zeros there. No key signs for that address, so
      // only a test can show the comparison is not made against it.
      const zero = await generateKeyPairSigner();
      const stored = svm.getAccount(router);
      if (!stored.exists) throw new Error('no router');
      expect(stored.data.slice(73, 105).every((byte) => byte === 0)).toBe(true);
      expectError(await send(svm, stranger, [await write(zero)]), MOCK_ROUTER_ERR.NotPriceWriter);
    });

    it('needs the writer to sign', async () => {
      expectError(
        await send(svm, stranger, [unsigned(await write(admin))]),
        ANCHOR.AccountNotSigner,
      );
    });

    it('lets only the admin name the writer', async () => {
      expectError(
        await send(svm, stranger, [await setPriceWriterInstruction(stranger, stranger.address)]),
        ANCHOR.ConstraintHasOne,
      );
    });

    it("writes the exchange's own price account and no other", async () => {
      const twin = await planted();
      expectError(
        await send(svm, admin, [await write(admin, PRICE, twin)]),
        MOCK_ROUTER_ERR.NotPriceAccount,
      );
      expect(data(twin).every((byte) => byte === 0)).toBe(true);
    });

    it("refuses an index past the last entry, and an average at the price's own entry", async () => {
      const at = (priceIndex: number, twapIndex: number) =>
        writePriceInstruction(admin, prices, {
          priceIndex,
          twapIndex,
          price: { value: PRICE, unixTimestamp: T0 },
          twap: { value: PRICE, unixTimestamp: T0 },
        });
      for (const [priceIndex, twapIndex] of [
        [512, 0],
        [0, 512],
        [7, 7],
      ] as const)
        expectError(
          await send(svm, admin, [await at(priceIndex, twapIndex)]),
          MOCK_ROUTER_ERR.BadPriceIndex,
        );
      expectOk(await send(svm, admin, [await at(511, 0)]));
    });
  });

  describe('a pair that pays its price', () => {
    let trader: KeyPairSigner;
    let cash: TestMint; // Token program, 6 decimals
    let stock: TestMint; // Token-2022 with the stock token's extensions, 8 decimals
    let traderCash: Address;
    let traderStock: Address;
    const SPREAD = 25;
    const buying: PricedPair = { assetIsInput: false, priceIndex: PRICE_INDEX, spreadBps: SPREAD };
    const selling: PricedPair = { assetIsInput: true, priceIndex: PRICE_INDEX, spreadBps: SPREAD };

    beforeEach(async () => {
      trader = await fundedSigner(svm);
      cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
      stock = await createMint(svm, admin, {
        program: TOKEN_2022_PROGRAM,
        decimals: 8,
        stock: true,
      });
      expectOk(
        await send(svm, admin, [
          await initPricedPairInstruction(admin, cash.address, stock.address, buying),
          await initPricedPairInstruction(admin, stock.address, cash.address, selling),
          await write(admin),
        ]),
      );
      await mintTo(svm, admin, cash, router, 1_000_000_000000n);
      await mintTo(svm, admin, stock, router, 1_000_00000000n);
      traderCash = await mintTo(svm, admin, cash, trader.address, 1_000_000000n);
      traderStock = await mintTo(svm, admin, stock, trader.address, 1_00000000n);
    });

    const buy = (amountIn: bigint, options: { prices?: Address | null; minOut?: bigint } = {}) =>
      routeInstruction({
        trader,
        mintIn: cash,
        mintOut: stock,
        traderIn: traderCash,
        destination: traderStock,
        amountIn,
        minOut: options.minOut ?? 0n,
        ...(options.prices === null ? {} : { prices: options.prices ?? prices }),
      });
    const sell = (amountIn: bigint) =>
      routeInstruction({
        trader,
        mintIn: stock,
        mintOut: cash,
        traderIn: traderStock,
        destination: traderCash,
        amountIn,
        minOut: 0n,
        prices,
      });
    const held = () => [balance(svm, traderCash), balance(svm, traderStock)];

    it('pays the price less the spread, buying and selling', async () => {
      // 100 dollars at 500 is 0.2 of a token; the exchange keeps 25 bps of it.
      expectOk(await send(svm, trader, [await buy(100_000000n)]));
      expect(held()).toEqual([900_000000n, 1_00000000n + 19_950_000n]);
      // 0.1 of a token at 500 is 50 dollars; the exchange keeps 25 bps of that.
      expectOk(await send(svm, trader, [await sell(10_000000n)]));
      expect(held()).toEqual([900_000000n + 49_875_000n, 1_00000000n + 9_950_000n]);
      // What the trader lost stayed in the reserves.
      expect(balance(svm, await ata(router, cash))).toBe(1_000_000_000000n + 50_125_000n);
      expect(balance(svm, await ata(router, stock))).toBe(1_000_00000000n - 9_950_000n);
    });

    it('rounds what it pays down', async () => {
      // 33 raw units of cash at 500 dollars are 6.6 raw units of the token: 6, and 5.985 of
      // those after the spread.
      expectOk(await send(svm, trader, [await buy(33n)]));
      expect(held()[1]).toBe(1_00000000n + 5n);
    });

    it('pays the price the account holds now', async () => {
      expectOk(await send(svm, admin, [await write(admin, PRICE / 2n)]));
      expectOk(await send(svm, trader, [await buy(100_000000n)]));
      expect(held()[1]).toBe(1_00000000n + 39_900_000n);
    });

    it('reads a price with another number of decimal places the same way', async () => {
      const at = (value: bigint, exponent: bigint) =>
        writePriceInstruction(admin, prices, {
          priceIndex: PRICE_INDEX,
          twapIndex: TWAP_INDEX,
          price: { value, exponent, unixTimestamp: T0 },
          twap: { value, exponent, unixTimestamp: T0 },
        });
      for (const [value, exponent] of [
        [500n, 0n],
        [500_000000n, 6n],
        [500n * 10n ** 16n, 16n],
      ] as const) {
        const before = held();
        expectOk(await send(svm, admin, [await at(value, exponent)]));
        expectOk(await send(svm, trader, [await buy(100_000000n), await sell(10_000000n)]));
        expect(held()).toEqual([
          (before[0] ?? 0n) - 100_000000n + 49_875_000n,
          (before[1] ?? 0n) + 19_950_000n - 10_000000n,
        ]);
      }
    });

    it('holds a trade to min_out, after the spread', async () => {
      expectError(
        await send(svm, trader, [await buy(100_000000n, { minOut: 19_950_001n })]),
        MOCK_ROUTER_ERR.BelowMinOut,
      );
      expectOk(await send(svm, trader, [await buy(100_000000n, { minOut: 19_950_000n })]));
    });

    it("needs the exchange's own price account after its accounts", async () => {
      expectError(
        await send(svm, trader, [await buy(100_000000n, { prices: null })]),
        MOCK_ROUTER_ERR.NotPriceAccount,
      );
      // An account that looks the same, with a price ten times kinder to the trader.
      const twin = await planted(data(prices));
      writePrice(svm, twin, PRICE_INDEX, { value: PRICE / 10n, unixTimestamp: T0 });
      expectError(
        await send(svm, trader, [await buy(100_000000n, { prices: twin })]),
        MOCK_ROUTER_ERR.NotPriceAccount,
      );
      expect(held()).toEqual([1_000_000000n, 1_00000000n]);
    });

    it('trades nothing at an entry nobody wrote', async () => {
      const unwritten: PricedPair = { ...buying, priceIndex: 100 };
      expectOk(
        await send(svm, admin, [
          await setPricedPairInstruction(admin, cash.address, stock.address, unwritten),
        ]),
      );
      expectError(await send(svm, trader, [await buy(100_000000n)]), MOCK_ROUTER_ERR.NoPrice);
    });

    it('refuses what it cannot work out, and moves nothing', async () => {
      // An exponent no price has: ten to that power does not fit.
      writePrice(svm, prices, PRICE_INDEX, { value: PRICE, exponent: 60n, unixTimestamp: T0 });
      expectError(await send(svm, trader, [await buy(100_000000n)]), MOCK_ROUTER_ERR.Overflow);
      expectError(await send(svm, trader, [await sell(10_000000n)]), MOCK_ROUTER_ERR.Overflow);
      expect(held()).toEqual([1_000_000000n, 1_00000000n]);
    });

    it('takes a spread of at most 1,000 bps, and an index that exists', async () => {
      const set = (pair: PricedPair) =>
        setPricedPairInstruction(admin, cash.address, stock.address, pair);
      expectError(
        await send(svm, admin, [await set({ ...buying, spreadBps: 1_001 })]),
        MOCK_ROUTER_ERR.SpreadTooWide,
      );
      expectError(
        await send(svm, admin, [await set({ ...buying, priceIndex: 512 })]),
        MOCK_ROUTER_ERR.BadPriceIndex,
      );
      expectOk(await send(svm, admin, [await set({ ...buying, spreadBps: 1_000 })]));
      expectOk(await send(svm, trader, [await buy(100_000000n)]));
      expect(held()[1]).toBe(1_00000000n + 18_000_000n);
      // The same bounds when a pair is listed.
      const other = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
      const list = (pair: PricedPair) =>
        initPricedPairInstruction(admin, cash.address, other.address, pair);
      expectError(
        await send(svm, admin, [await list({ ...buying, spreadBps: 1_001 })]),
        MOCK_ROUTER_ERR.SpreadTooWide,
      );
      expectError(
        await send(svm, admin, [await list({ ...buying, priceIndex: 512 })]),
        MOCK_ROUTER_ERR.BadPriceIndex,
      );
    });

    it('is listed and changed by the admin alone', async () => {
      const other = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
      expectError(
        await send(svm, stranger, [
          await initPricedPairInstruction(stranger, cash.address, other.address, buying),
        ]),
        ANCHOR.ConstraintHasOne,
      );
      expectError(
        await send(svm, stranger, [
          await setPricedPairInstruction(stranger, cash.address, stock.address, {
            ...buying,
            spreadBps: 0,
          }),
        ]),
        ANCHOR.ConstraintHasOne,
      );
    });

    it('can be given a fixed price, and a fixed pair the price account’s', async () => {
      // The admin fixes the pair at 250 dollars: 1 raw unit of cash buys 0.4 raw units.
      expectOk(
        await send(svm, admin, [
          await setPriceInstruction(admin, cash.address, stock.address, 2n, 5n),
        ]),
      );
      expectOk(await send(svm, trader, [await buy(100_000000n, { prices: null })]));
      expect(held()[1]).toBe(1_00000000n + 40_000_000n);
      // And a pair listed at a fixed price is moved onto the price account.
      const other = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
      await mintTo(svm, admin, other, router, 1_000_00000000n);
      const traderOther = await createAta(svm, admin, trader.address, other);
      expectOk(
        await send(svm, admin, [
          await initPairInstruction(admin, cash.address, other.address, 1n, 1n),
          await setPricedPairInstruction(admin, cash.address, other.address, {
            ...buying,
            spreadBps: 0,
          }),
        ]),
      );
      expectOk(
        await send(svm, trader, [
          await routeInstruction({
            trader,
            mintIn: cash,
            mintOut: other,
            traderIn: traderCash,
            destination: traderOther,
            amountIn: 100_000000n,
            minOut: 0n,
            prices,
          }),
        ]),
      );
      expect(balance(svm, traderOther)).toBe(20_000_000n);
    });
  });
});
