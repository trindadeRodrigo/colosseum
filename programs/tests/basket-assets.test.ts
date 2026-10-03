import {
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';
import { extension } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSETS_SIZE,
  assetsAddress,
  configAddress,
  ERR,
  forgeConfig,
  initAssetsInstruction,
  initConfig,
  listAssets,
  MAX_ASSETS,
  readAssets,
  upsertAssetInstruction,
} from './src/basket';
import {
  ANCHOR,
  BASKET_PROGRAM,
  createWorld,
  events,
  expectError,
  expectFailure,
  expectOk,
  fundedSigner,
  loadHook,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  SYSTEM_PROGRAM,
  send,
} from './src/env';
import { setHook } from './src/hook';
import {
  createAta,
  createMint,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';

// The platform's list of tokens a vault may hold (DESIGN-VAULT.md section 3.7), written by the admin.
describe('the asset list', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let stranger: KeyPairSigner;
  let cash: TestMint;
  let stock: TestMint; // Token-2022 with the stock token's extensions: a hook authority and no hook program

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    stranger = await fundedSigner(svm);
    cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
    stock = await createMint(svm, admin, { program: TOKEN_2022_PROGRAM, decimals: 8, stock: true });
    expectOk(await initConfig(svm, admin, { cashMint: cash.address }));
  });

  const initAssets = async (who: KeyPairSigner = admin) =>
    send(svm, who, [await initAssetsInstruction(who)]);

  describe('init_assets', () => {
    it('lets the admin create it, empty', async () => {
      expectOk(await initAssets());
      const account = svm.getAccount(await assetsAddress());
      expect(account.exists && account.programAddress).toBe(BASKET_PROGRAM);
      expect(account.exists && account.data.length).toBe(ASSETS_SIZE);
      const registry = await readAssets(svm);
      expect(registry.count).toBe(0);
      expect(registry.priceAccounts).toEqual(new Array(4).fill(SYSTEM_PROGRAM));
      // Nothing but the eight bytes that say what the account is.
      expect(account.exists && account.data.slice(8).every((byte) => byte === 0)).toBe(true);
    });

    it('is the admin alone, and only once', async () => {
      expectError(await initAssets(stranger), ANCHOR.ConstraintHasOne);
      expect(svm.getAccount(await assetsAddress()).exists).toBe(false);
      expectOk(await initAssets());
      expectError(await initAssets(), SYSTEM_ACCOUNT_ALREADY_IN_USE);
    });

    it('refuses a forged Config that names the signer as admin', async () => {
      const forged = await forgeConfig(svm, { admin: stranger.address });
      expectError(
        await send(svm, stranger, [await initAssetsInstruction(stranger, { config: forged })]),
        ANCHOR.ConstraintSeeds,
      );
    });
  });

  describe('upsert_asset', () => {
    beforeEach(async () => {
      expectOk(await initAssets());
    });

    const entry = {
      priceSlot: 2,
      priceIndex: 344,
      twapIndex: 345,
      priceKind: 1,
      session: 1,
      maxWeightBps: 2_500,
      flags: 0,
      sourceCheck: new Uint8Array(32).fill(7),
    };

    it('lists a token with what the admin chose, and its decimals read from the mint', async () => {
      const meta = expectOk(
        await send(svm, admin, [
          await upsertAssetInstruction(admin, stock.address, entry),
          await upsertAssetInstruction(admin, cash.address),
        ]),
      );
      const registry = await readAssets(svm);
      expect(registry.count).toBe(2);
      expect(registry.assets[0]).toEqual({
        mint: stock.address,
        ...entry,
        decimals: 8,
        reserved: new Uint8Array(21),
      });
      expect(registry.assets[1]).toMatchObject({
        mint: cash.address,
        decimals: 6,
        priceKind: 0,
        maxWeightBps: 5_000,
      });

      // AssetSet { mint, index, max_weight_bps }, one per entry written.
      const set = events(meta, 'AssetSet').map((e) => ({
        mint: getAddressDecoder().decode(e.slice(0, 32)),
        index: e[32],
        maxWeightBps: new DataView(e.buffer, e.byteOffset).getUint16(33, true),
      }));
      expect(set).toEqual([
        { mint: stock.address, index: 0, maxWeightBps: 2_500 },
        { mint: cash.address, index: 1, maxWeightBps: 5_000 },
      ]);
    });

    it('keeps each field where the design puts it: no padding between them', async () => {
      // Section 3.7: `count` at byte 136, entry i at 137 + 96·i, and inside an entry the mint at 0,
      // price_slot 32, price_index 33, twap_index 35, decimals 37, price_kind 38, session 39,
      // max_weight_bps 40, flags 42, source_check 43.
      await listAssets(svm, admin, [cash.address]);
      expectOk(await send(svm, admin, [await upsertAssetInstruction(admin, stock.address, entry)]));
      const account = svm.getAccount(await assetsAddress());
      if (!account.exists) throw new Error('no asset list');
      const data = account.data;
      const view = new DataView(data.buffer, data.byteOffset);
      expect(data[136]).toBe(2);
      const at = 137 + 96;
      expect([...data.slice(at, at + 32)]).toEqual([...getAddressEncoder().encode(stock.address)]);
      expect([
        data[at + 32],
        view.getUint16(at + 33, true),
        view.getUint16(at + 35, true),
        data[at + 37],
        data[at + 38],
        data[at + 39],
        view.getUint16(at + 40, true),
        data[at + 42],
      ]).toEqual([2, 344, 345, 8, 1, 1, 2_500, 0]);
      expect(data.slice(at + 43, at + 75).every((byte) => byte === 7)).toBe(true);
      expect(data.slice(at + 75, at + 96).every((byte) => byte === 0)).toBe(true);
    });

    it('rewrites the entry of a token that is listed, in its place', async () => {
      await listAssets(svm, admin, [cash.address, stock.address]);
      expectOk(
        await send(svm, admin, [
          await upsertAssetInstruction(admin, cash.address, { maxWeightBps: 1_000, session: 1 }),
        ]),
      );
      const registry = await readAssets(svm);
      expect(registry.count).toBe(2);
      expect(registry.assets.map((a) => [a.mint, a.maxWeightBps, a.session])).toEqual([
        [cash.address, 1_000, 1],
        [stock.address, 5_000, 0],
      ]);
    });

    it('is the admin alone', async () => {
      expectError(
        await send(svm, stranger, [await upsertAssetInstruction(stranger, stock.address)]),
        ANCHOR.ConstraintHasOne,
      );
      expect((await readAssets(svm)).count).toBe(0);
    });

    it('writes only the real list, on the word of the real Config only', async () => {
      const forged = await forgeConfig(svm, { admin: stranger.address });
      expectError(
        await send(svm, stranger, [
          await upsertAssetInstruction(stranger, stock.address, {}, { config: forged }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      const real = svm.getAccount(await assetsAddress());
      if (!real.exists) throw new Error('no asset list');
      const copy = (await generateKeyPairSigner()).address;
      svm.setAccount({ ...real, address: copy });
      expectError(
        await send(svm, admin, [
          await upsertAssetInstruction(admin, stock.address, {}, { assets: copy }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      expect((await readAssets(svm)).count).toBe(0);
    });

    it('refuses what is not a mint', async () => {
      const tokenAccount = await createAta(svm, admin, admin.address, cash);
      expectFailure(
        await send(svm, admin, [await upsertAssetInstruction(admin, tokenAccount)]),
        'InvalidAccountData',
      );
      expectError(
        await send(svm, admin, [await upsertAssetInstruction(admin, await configAddress())]),
        ANCHOR.AccountOwnedByWrongProgram,
      );
      expect((await readAssets(svm)).count).toBe(0);
    });

    it('refuses a mint with a transfer hook program, and takes one with only a hook authority', async () => {
      // The stock tokens carry the extension with an authority and no program: no hook runs.
      expectOk(await send(svm, admin, [await upsertAssetInstruction(admin, stock.address)]));

      // One whose issuer has pointed it at a program is not listed, and is not updated either.
      const hook = await loadHook(svm);
      const hooked = await createMint(svm, admin, {
        program: TOKEN_2022_PROGRAM,
        decimals: 8,
        extensions: (issuer) => [extension('TransferHook', { authority: issuer, programId: hook })],
      });
      expectError(
        await send(svm, admin, [await upsertAssetInstruction(admin, hooked.address)]),
        ERR.HookNotAllowed,
      );
      await setHook(svm, admin, stock, hook);
      expectError(
        await send(svm, admin, [
          await upsertAssetInstruction(admin, stock.address, { maxWeightBps: 100 }),
        ]),
        ERR.HookNotAllowed,
      );
      const registry = await readAssets(svm);
      expect(registry.assets.map((a) => [a.mint, a.maxWeightBps])).toEqual([
        [stock.address, 5_000],
      ]);
    });

    it.each([
      ['a price slot past the four price accounts', { priceSlot: 4 }],
      ['a price kind that is not none or Scope', { priceKind: 2 }],
      ['a price index past the 512 entries', { priceIndex: 512 }],
      ['an average index past the 512 entries', { twapIndex: 512 }],
      ['a session that is not always or US hours', { session: 2 }],
      ['a ceiling above the whole', { maxWeightBps: 10_001 }],
      ['a flag, while no flag has a meaning', { flags: 1 }],
    ])('refuses %s', async (_, change) => {
      expectError(
        await send(svm, admin, [await upsertAssetInstruction(admin, stock.address, change)]),
        ERR.ParamOutOfBounds,
      );
      expect((await readAssets(svm)).count).toBe(0);
    });

    it('accepts each bound itself', async () => {
      const atTheBounds = {
        priceSlot: 3,
        priceKind: 1,
        priceIndex: 511,
        twapIndex: 511,
        session: 1,
        maxWeightBps: 10_000,
      };
      expectOk(
        await send(svm, admin, [await upsertAssetInstruction(admin, stock.address, atTheBounds)]),
      );
      expect((await readAssets(svm)).assets[0]).toMatchObject(atTheBounds);
    });

    it('holds sixty-four tokens and no more; a listed one can still be rewritten', async () => {
      const mints: Address[] = [];
      for (let i = 0; i < MAX_ASSETS; i++)
        mints.push((await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 })).address);
      await listAssets(svm, admin, mints);
      expect((await readAssets(svm)).count).toBe(MAX_ASSETS);

      expectError(
        await send(svm, admin, [await upsertAssetInstruction(admin, stock.address)]),
        ERR.AssetListFull,
      );
      const last = mints[MAX_ASSETS - 1] as Address;
      expectOk(
        await send(svm, admin, [await upsertAssetInstruction(admin, last, { maxWeightBps: 50 })]),
      );
      const registry = await readAssets(svm);
      expect(registry.count).toBe(MAX_ASSETS);
      expect(registry.assets.map((a) => a.mint)).toEqual(mints);
      expect(registry.assets[MAX_ASSETS - 1]?.maxWeightBps).toBe(50);
    });
  });
});
