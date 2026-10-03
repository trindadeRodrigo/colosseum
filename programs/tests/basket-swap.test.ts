import { type Address, generateKeyPairSigner, isSome } from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assetsAddress,
  createVaultInstruction,
  depositInstruction,
  ERR,
  forgeConfig,
  forwarded,
  ownerSwapInstruction,
  patchConfig,
  pauseKeeperInstruction,
  readConfig,
  readVault,
  setTargetsInstruction,
  trackedFor,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import {
  ANCHOR,
  BASKET_PROGRAM,
  concat,
  discriminator,
  expectError,
  expectOk,
  MOCK_ROUTER_PROGRAM,
  readonly,
  SYSTEM_PROGRAM,
  send,
  unsigned,
  writable,
} from './src/env';
import { setPriceInstruction } from './src/mock-router';
import { loadPuppet } from './src/puppet';
import {
  CASH,
  createSwapWorld,
  type SwapWorld,
  stockFor,
  swapThroughExchange,
  tokenAccountFor,
} from './src/swap';
import {
  ata,
  balance,
  createAtaInstruction,
  createLooseTokenAccount,
  mintTo,
  mintToAccount,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccount,
} from './src/tokens';

// The owner's swap (DESIGN-VAULT.md sections 3.7 and 5): one trade through the router Config
// names, signed by the vault. Here the router is the test exchange, which does what it is told.
// What a router that turns on the vault can do is in basket-swap-hostile.test.ts.
describe('owner_swap through the allowed router', () => {
  let w: SwapWorld;

  beforeEach(async () => {
    w = await createSwapWorld();
  });

  const held = () => ({
    cash: balance(w.svm, w.vaultCash),
    stock: balance(w.svm, w.vaultStock),
  });
  const untouched = { cash: CASH, stock: 0n };

  it('buys a listed token with cash, into the vault itself', async () => {
    const spend = 10_000000n;
    const meta = expectOk(
      await swapThroughExchange(w, { amountIn: spend, minOut: stockFor(spend) }),
    );
    expect(held()).toEqual({ cash: CASH - spend, stock: stockFor(spend) });
    expect(meta.logs().some((l) => l.includes(`owner swap: spent=${spend} received=2000000`))).toBe(
      true,
    );
    // The stock is a position: the vault records what it now holds. Cash is never recorded.
    expect(trackedFor(w.svm, w.vault, w.stock.address)).toBe(stockFor(spend));
    expect(trackedFor(w.svm, w.vault, w.cash.address)).toBeNull();
  });

  it('sells back to cash: cash is always an allowed output, though it is not on the list', async () => {
    expect((await readConfig(w.svm)).cashMint).toBe(w.cash.address);
    expectOk(await swapThroughExchange(w, { amountIn: 10_000000n }));
    const sell = 1_500000n;
    expectOk(
      await swapThroughExchange(w, {
        inputMint: w.stock,
        outputMint: w.cash,
        amountIn: sell,
        minOut: sell * 5n,
      }),
    );
    expect(held()).toEqual({ cash: CASH - 10_000000n + sell * 5n, stock: 2_000000n - sell });
    expect(trackedFor(w.svm, w.vault, w.stock.address)).toBe(2_000000n - sell);
  });

  it('buys a listed token the vault has no target on', async () => {
    const vaultOther = await tokenAccountFor(w, w.vault, w.other);
    expectOk(await swapThroughExchange(w, { outputMint: w.other, amountIn: 5_000000n }));
    expect(balance(w.svm, vaultOther)).toBe(1_000000n);
    // Not a position, so nothing is recorded for it.
    expect(readVault(w.svm, w.vault).count).toBe(1);
  });

  // Hostile case A11: nothing is left behind on the vault's token accounts.
  it('leaves no delegate and no close authority behind, and the vault still owns both accounts (A11)', async () => {
    expectOk(await swapThroughExchange(w, { amountIn: 10_000000n }));
    for (const account of [w.vaultCash, w.vaultStock]) {
      const state = tokenAccount(w.svm, account);
      expect(state.owner).toBe(w.vault);
      expect(isSome(state.delegate)).toBe(false);
      expect(isSome(state.closeAuthority)).toBe(false);
    }
  });

  describe('the vault counts for itself', () => {
    it('refuses a trade that spends more than max_in', async () => {
      expectError(
        await swapThroughExchange(w, { amountIn: 10_000000n, maxIn: 9_999999n }),
        ERR.SpentTooMuch,
      );
      expect(held()).toEqual(untouched);
    });

    it('refuses a trade that brings in less than min_out, whatever the router accepted', async () => {
      // The exchange's own minimum is zero, so the exchange itself is satisfied.
      expectError(
        await swapThroughExchange(w, { amountIn: 10_000000n, minOut: 2_000001n }),
        ERR.ReceivedTooLittle,
      );
      expect(held()).toEqual(untouched);
      // The price moves against the owner between the quote and the trade.
      expectOk(
        await send(w.svm, w.admin, [
          await setPriceInstruction(w.admin, w.cash.address, w.stock.address, 1n, 6n),
        ]),
      );
      expectError(
        await swapThroughExchange(w, { amountIn: 10_000000n, minOut: 2_000000n }),
        ERR.ReceivedTooLittle,
      );
      expect(held()).toEqual(untouched);
    });

    // Hostile case A1, on the owner's path: the output goes somewhere else.
    it("refuses a trade whose output is paid to someone else's account (A1)", async () => {
      const theirs = await tokenAccountFor(w, w.stranger.address, w.stock);
      expectError(
        await swapThroughExchange(w, { amountIn: 10_000000n, minOut: 1n, destination: theirs }),
        ERR.ReceivedTooLittle,
      );
      expect(held()).toEqual(untouched);
      expect(balance(w.svm, theirs)).toBe(0n);
    });
  });

  describe('what may be bought', () => {
    it('refuses a token that is not on the platform list', async () => {
      const vaultUnlisted = await tokenAccountFor(w, w.vault, w.unlisted);
      expectError(
        await swapThroughExchange(w, { outputMint: w.unlisted, amountIn: 5_000000n }),
        ERR.MintNotAccepted,
      );
      expect(held()).toEqual(untouched);
      expect(balance(w.svm, vaultUnlisted)).toBe(0n);
    });

    it('refuses a trade of a token for itself', async () => {
      expectError(
        await swapThroughExchange(w, { outputMint: w.cash, amountIn: 5_000000n }),
        ERR.SameMint,
      );
    });

    it('reads the list and the cash mint from the real asset list and the real Config only', async () => {
      await tokenAccountFor(w, w.vault, w.unlisted);
      // A copy of Config that names the unlisted token as cash, which is always an allowed output.
      const forged = await forgeConfig(w.svm, { cashMint: w.unlisted.address });
      expectError(
        await swapThroughExchange(w, {
          outputMint: w.unlisted,
          amountIn: 5_000000n,
          config: forged,
        }),
        ANCHOR.ConstraintSeeds,
      );
      const real = w.svm.getAccount(await assetsAddress());
      if (!real.exists) throw new Error('no asset list');
      const copy = (await generateKeyPairSigner()).address;
      w.svm.setAccount({ ...real, address: copy });
      expectError(
        await swapThroughExchange(w, { amountIn: 5_000000n, assets: copy }),
        ANCHOR.ConstraintSeeds,
      );
      expect(held()).toEqual(untouched);
    });
  });

  describe('who may trade, and from which accounts', () => {
    it('another signer cannot, and the owner must sign', async () => {
      expectError(
        await swapThroughExchange(w, { amountIn: 10_000000n, signer: w.stranger }),
        ANCHOR.ConstraintHasOne,
      );
      const named = await ownerSwapInstruction({
        owner: w.owner,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        maxIn: 1n,
        minOut: 0n,
        router: (await readConfig(w.svm)).routerProgram,
        data: discriminator('route_v2'),
        routerAccounts: [],
      });
      const result = await send(w.svm, w.stranger, [unsigned(named)]);
      expectError(result, ANCHOR.AccountNotSigner);
      expect(held()).toEqual(untouched);
    });

    it("spends only from, and pays only into, the vault's associated token accounts", async () => {
      // Two more token accounts that the vault owns, with tokens someone sent to them.
      const looseCash = await createLooseTokenAccount(w.svm, w.admin, w.cash, w.vault);
      await mintToAccount(w.svm, w.admin, w.cash, looseCash, 50_000000n);
      const looseOther = await createLooseTokenAccount(w.svm, w.admin, w.other, w.vault);
      await tokenAccountFor(w, w.vault, w.other);

      expectError(
        await swapThroughExchange(w, { amountIn: 10_000000n, vaultInput: looseCash }),
        ANCHOR.ConstraintAssociated,
      );
      expectError(
        await swapThroughExchange(w, {
          outputMint: w.other,
          amountIn: 10_000000n,
          vaultOutput: looseOther,
        }),
        ANCHOR.ConstraintAssociated,
      );
      expect(held()).toEqual(untouched);
      expect(balance(w.svm, looseCash)).toBe(50_000000n);
    });

    it('an account of another program that only looks like a token account of the vault is not one', async () => {
      // The bytes of the vault's cash account, under a program that is not a token program: no
      // token program will move anything on its word, so it is no business of the vault's.
      const real = w.svm.getAccount(w.vaultCash);
      if (!real.exists) throw new Error('no cash account');
      const lookalike = (await generateKeyPairSigner()).address;
      w.svm.setAccount({ ...real, address: lookalike, programAddress: MOCK_ROUTER_PROGRAM });
      expectOk(
        await swapThroughExchange(w, { amountIn: 10_000000n, extra: [writable(lookalike)] }),
      );
      expect(held()).toEqual({ cash: CASH - 10_000000n, stock: 2_000000n });
    });

    it('refuses a token program that is not the one the mint belongs to', async () => {
      expectError(
        await swapThroughExchange(w, {
          amountIn: 10_000000n,
          inputMint: { ...w.cash, program: TOKEN_2022_PROGRAM },
          vaultInput: w.vaultCash,
        }),
        ANCHOR.ConstraintMintTokenProgram,
      );
      expectError(
        await swapThroughExchange(w, {
          amountIn: 10_000000n,
          outputMint: { ...w.stock, program: TOKEN_PROGRAM },
          vaultOutput: w.vaultStock,
        }),
        ANCHOR.ConstraintMintTokenProgram,
      );
    });

    it("refuses a third token account of the vault anywhere in the router's account list", async () => {
      const loose = await createLooseTokenAccount(w.svm, w.admin, w.other, w.vault);
      await mintToAccount(w.svm, w.admin, w.other, loose, 700n);
      const config = await readConfig(w.svm);
      for (const extra of [writable(loose), readonly(loose)]) {
        const result = await send(w.svm, w.owner, [
          await ownerSwapInstruction({
            owner: w.owner,
            vault: w.vault,
            inputMint: w.cash,
            outputMint: w.stock,
            maxIn: 1n,
            minOut: 0n,
            router: config.routerProgram,
            data: discriminator('route_v2'),
            routerAccounts: [extra],
          }),
        ]);
        expectError(result, ERR.AccountTampered);
      }
      expect(balance(w.svm, loose)).toBe(700n);
    });
  });

  describe('which program is called, and for what', () => {
    const swapWith = async (router: Address, data: Uint8Array) =>
      send(w.svm, w.owner, [
        await ownerSwapInstruction({
          owner: w.owner,
          vault: w.vault,
          inputMint: w.cash,
          outputMint: w.stock,
          maxIn: CASH,
          minOut: 0n,
          router,
          data,
          routerAccounts: [],
        }),
      ]);

    it('refuses any program but the router in Config', async () => {
      const puppet = await loadPuppet(w.svm);
      expectError(await swapWith(puppet.program, discriminator('route_v2')), ERR.RouterNotAllowed);
    });

    it('refuses an instruction of the router that is not a route', async () => {
      const config = await readConfig(w.svm);
      // The test exchange's own `set_price`, which the vault's signature has no business with.
      const setPrice = forwarded(
        await setPriceInstruction(w.admin, w.cash.address, w.stock.address, 1_000n, 1n),
      );
      const result = await send(w.svm, w.owner, [
        await ownerSwapInstruction({
          owner: w.owner,
          vault: w.vault,
          inputMint: w.cash,
          outputMint: w.stock,
          maxIn: CASH,
          minOut: 0n,
          ...setPrice,
        }),
      ]);
      expectError(result, ERR.RouterNotAllowed);
      // Too short to name any instruction, and the selector of a route Jupiter has but the vault does not take.
      for (const data of [new Uint8Array(0), new Uint8Array(7), discriminator('exact_out_route')])
        expectError(await swapWith(config.routerProgram, data), ERR.RouterNotAllowed);
    });

    // No transaction can put these in Config: set_router and init_config refuse them. The swap
    // refuses them again, so the vault never signs for a program that reads its signature as
    // leave to move tokens.
    it.each([
      ['the token program', TOKEN_PROGRAM],
      ['the Token-2022 program', TOKEN_2022_PROGRAM],
      ['the system program', SYSTEM_PROGRAM],
      ['the vault program itself', BASKET_PROGRAM],
    ])('never calls %s, even if Config named it', async (_, program) => {
      await patchConfig(w.svm, { routerProgram: program });
      expect((await readConfig(w.svm)).routerProgram).toBe(program);
      const data = concat(discriminator('route_v2'), new Uint8Array(16));
      expectError(await swapWith(program, data), ERR.RouterNotAllowed);
      expect(held()).toEqual(untouched);
    });
  });

  it('the whole owner path works while the keeper is paused, and reads no price', async () => {
    // No price account exists anywhere in this world, and the pause is on: the owner still
    // creates, deposits, trades, sets targets and withdraws.
    expectOk(await send(w.svm, w.guardian, [await pauseKeeperInstruction(w.guardian)]));
    expect((await readConfig(w.svm)).keeperPaused).toBe(true);

    expectOk(await swapThroughExchange(w, { amountIn: 10_000000n }));
    expect(held()).toEqual({ cash: CASH - 10_000000n, stock: 2_000000n });

    await mintTo(w.svm, w.admin, w.cash, w.owner.address, 5_000000n);
    const second = await vaultAddress(w.owner.address, 99n);
    expectOk(
      await send(w.svm, w.owner, [
        await createVaultInstruction({
          owner: w.owner,
          basketId: 99n,
          targets: [{ mint: w.stock.address, targetBps: 10_000 }],
        }),
        await createAtaInstruction(w.owner, second, w.cash),
        await depositInstruction({
          owner: w.owner,
          vault: second,
          mint: w.cash,
          amount: 5_000000n,
        }),
        await setTargetsInstruction({
          owner: w.owner,
          vault: second,
          targets: [{ mint: w.other.address, targetBps: 5_000 }],
        }),
        await withdrawInstruction({
          owner: w.owner,
          vault: second,
          mint: w.cash,
          amount: 5_000000n,
        }),
      ]),
    );
    expect(balance(w.svm, await ata(second, w.cash))).toBe(0n);
    expect(balance(w.svm, await ata(w.owner.address, w.cash))).toBe(5_000000n);
  });
});
