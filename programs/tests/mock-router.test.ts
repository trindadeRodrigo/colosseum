import type { Address, KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANCHOR,
  createWorld,
  discriminator,
  expectError,
  expectOk,
  fundedSigner,
  idlCreateInstruction,
  MOCK_ROUTER_PROGRAM,
  send,
} from './src/env';
import {
  initPairInstruction,
  initRouterInstruction,
  MOCK_ROUTER_ERR,
  routeInstruction,
  routerAddress,
  setPriceInstruction,
} from './src/mock-router';
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

// The test exchange: it takes the input token from the signer's account and pays the output
// token from its own reserve, at the price in its own config.
describe('mock-router', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let trader: KeyPairSigner;
  let cash: TestMint; // Token program, 6 decimals
  let stock: TestMint; // Token-2022 with the stock token's extensions, 8 decimals
  let traderCash: Address;
  let traderStock: Address;
  let reserveCash: Address;
  let reserveStock: Address;

  // 1 unit of cash (10^6 raw) buys 0.002 of the stock (200,000 raw): a price of 500.
  const PRICE_NUM = 1n;
  const PRICE_DEN = 5n;

  beforeEach(async () => {
    ({ svm } = await createWorld());
    admin = await fundedSigner(svm);
    trader = await fundedSigner(svm);
    cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
    stock = await createMint(svm, admin, { program: TOKEN_2022_PROGRAM, decimals: 8, stock: true });

    const router = await routerAddress();
    expectOk(
      await send(svm, admin, [
        await initRouterInstruction(admin),
        await initPairInstruction(admin, cash.address, stock.address, PRICE_NUM, PRICE_DEN),
      ]),
    );
    reserveCash = await createAta(svm, admin, router, cash);
    reserveStock = await mintTo(svm, admin, stock, router, 1_000_00000000n);
    traderCash = await mintTo(svm, admin, cash, trader.address, 100_000000n);
    traderStock = await createAta(svm, admin, trader.address, stock);
  });

  const route = (amountIn: bigint, minOut: bigint) =>
    routeInstruction({
      trader,
      mintIn: cash,
      mintOut: stock,
      traderIn: traderCash,
      destination: traderStock,
      amountIn,
      minOut,
    });

  it('takes the input from the signer and pays the output from its reserve at the set price', async () => {
    expectOk(await send(svm, trader, [await route(10_000000n, 2_000000n)]));

    expect(balance(svm, traderCash)).toBe(90_000000n);
    expect(balance(svm, traderStock)).toBe(2_000000n);
    expect(balance(svm, reserveCash)).toBe(10_000000n);
    expect(balance(svm, reserveStock)).toBe(1_000_00000000n - 2_000000n);
  });

  it('refuses a trade that would pay less than min_out, and moves nothing', async () => {
    expectError(
      await send(svm, trader, [await route(10_000000n, 2_000001n)]),
      MOCK_ROUTER_ERR.BelowMinOut,
    );
    expect(balance(svm, traderCash)).toBe(100_000000n);
    expect(balance(svm, traderStock)).toBe(0n);
  });

  it('lets only its admin change the price', async () => {
    const stranger = await fundedSigner(svm);
    expectError(
      await send(svm, stranger, [
        await setPriceInstruction(stranger, cash.address, stock.address, 1n, 1n),
      ]),
      ANCHOR.ConstraintHasOne,
    );

    // Admin halves the price of the stock: the same cash now buys twice as much.
    expectOk(
      await send(svm, admin, [
        await setPriceInstruction(admin, cash.address, stock.address, 2n, 5n),
      ]),
    );
    expectOk(await send(svm, trader, [await route(10_000000n, 0n)]));
    expect(balance(svm, traderStock)).toBe(4_000000n);
  });

  it('pays whatever destination it is told to, like a real router', async () => {
    const other = await fundedSigner(svm);
    const otherStock = await createAta(svm, admin, other.address, stock);
    expectOk(
      await send(svm, trader, [
        await routeInstruction({
          trader,
          mintIn: cash,
          mintOut: stock,
          traderIn: traderCash,
          destination: otherStock,
          amountIn: 10_000000n,
          minOut: 0n,
        }),
      ]),
    );
    expect(balance(svm, otherStock)).toBe(2_000000n);
    expect(balance(svm, await ata(trader.address, stock))).toBe(0n);
  });

  it("refuses Anchor's instruction that creates an on-chain IDL account", async () => {
    const stranger = await fundedSigner(svm);
    const { instruction, idlAccount } = await idlCreateInstruction(MOCK_ROUTER_PROGRAM, stranger);
    expectError(await send(svm, stranger, [instruction]), ANCHOR.IdlInstructionStub);
    expect(svm.getAccount(idlAccount).exists).toBe(false);
  });

  it("answers to the same first eight bytes as Jupiter's route_v2", () => {
    expect(Buffer.from(discriminator('route_v2')).toString('hex')).toBe('bb64facc31c4af14');
  });
});
