import { type Address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSET_KEEPER,
  type AssetArgs,
  addClosedDayInstruction,
  assetsAddress,
  DEFAULT_PARAMS,
  decodeAddressChange,
  ERR,
  extendClosedUntilInstruction,
  forgeConfig,
  initAssetsInstruction,
  initConfigInstruction,
  launchInstruction,
  PRICES_SIZE,
  pauseKeeperInstruction,
  readAssets,
  readConfig,
  setClosedDayInstruction,
  setClosedUntilInstruction,
  setDefaultKeeperInstruction,
  setGuardianInstruction,
  setPriceAccountInstruction,
  setPriceOwnerInstruction,
  upsertAssetInstruction,
} from './src/basket';
import {
  ANCHOR,
  createWorld,
  events,
  expectError,
  expectOk,
  fundedSigner,
  MOCK_ROUTER_PROGRAM,
  SYSTEM_PROGRAM,
  send,
  unsigned,
} from './src/env';
import { createPriceAccount } from './src/prices';
import { createMint, type TestMint, TOKEN_PROGRAM } from './src/tokens';

// What the keeper slot adds to the admin's and the guardian's hands (DESIGN-VAULT.md sections 3.7
// and 13): the two keys nothing could change, the days and the time the market is closed, the price
// account of the asset list, and the switch that lets the keeper trade an asset.
describe('the keeper slot: admin and guardian', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let guardian: KeyPairSigner;
  let keeper: KeyPairSigner;
  let stranger: KeyPairSigner;
  let priceOwner: Address;
  let cash: TestMint;
  let stock: TestMint;

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    guardian = await fundedSigner(svm);
    keeper = await fundedSigner(svm);
    stranger = await fundedSigner(svm);
    priceOwner = (await generateKeyPairSigner()).address;
    cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
    stock = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
    expectOk(
      await send(svm, admin, [
        await initConfigInstruction(admin, {
          guardian: guardian.address,
          defaultKeeper: keeper.address,
          routerProgram: MOCK_ROUTER_PROGRAM,
          priceOwner,
          cashMint: cash.address,
          params: DEFAULT_PARAMS,
        }),
        await initAssetsInstruction(admin),
      ]),
    );
  });

  const notTheAdmin = () => [guardian, keeper, stranger];

  describe('set_guardian', () => {
    it('lets the admin name a new guardian, and says who it was and who it is', async () => {
      const next = await fundedSigner(svm);
      const meta = expectOk(
        await send(svm, admin, [await setGuardianInstruction(admin, next.address)]),
      );
      expect((await readConfig(svm)).guardian).toBe(next.address);
      const [event] = events(meta, 'GuardianSet');
      expect(event && decodeAddressChange(event)).toEqual({
        old: guardian.address,
        new: next.address,
      });
      // The new key pauses, and the old one no longer can.
      expectError(
        await send(svm, guardian, [await pauseKeeperInstruction(guardian)]),
        ANCHOR.ConstraintHasOne,
      );
      expectOk(await send(svm, next, [await pauseKeeperInstruction(next)]));
    });

    it('still works after launch: a key has to be replaceable without an upgrade', async () => {
      expectOk(await send(svm, admin, [await launchInstruction(admin)]));
      expectOk(await send(svm, admin, [await setGuardianInstruction(admin, stranger.address)]));
      expect((await readConfig(svm)).guardian).toBe(stranger.address);
    });

    it('is the admin alone: the guardian cannot hand its own role on', async () => {
      for (const who of notTheAdmin())
        expectError(
          await send(svm, who, [await setGuardianInstruction(who, stranger.address)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).guardian).toBe(guardian.address);
    });

    it('needs the admin to sign', async () => {
      expectError(
        await send(svm, stranger, [
          unsigned(await setGuardianInstruction(admin, stranger.address)),
        ]),
        ANCHOR.AccountNotSigner,
      );
    });

    it('refuses the zero address', async () => {
      expectError(
        await send(svm, admin, [await setGuardianInstruction(admin, SYSTEM_PROGRAM)]),
        ERR.ZeroAddress,
      );
    });

    it('refuses a forged Config that names the signer as admin', async () => {
      const forged = await forgeConfig(svm, { admin: stranger.address });
      expectError(
        await send(svm, stranger, [
          await setGuardianInstruction(stranger, stranger.address, forged),
        ]),
        ANCHOR.ConstraintSeeds,
      );
    });
  });

  describe('set_default_keeper', () => {
    it('lets the admin name a new keeper, and says who it was and who it is', async () => {
      const next = (await generateKeyPairSigner()).address;
      const meta = expectOk(
        await send(svm, admin, [await setDefaultKeeperInstruction(admin, next)]),
      );
      expect((await readConfig(svm)).defaultKeeper).toBe(next);
      const [event] = events(meta, 'KeeperSet');
      expect(event && decodeAddressChange(event)).toEqual({ old: keeper.address, new: next });
    });

    it('is the admin alone: the keeper cannot name its successor', async () => {
      for (const who of notTheAdmin())
        expectError(
          await send(svm, who, [await setDefaultKeeperInstruction(who, stranger.address)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).defaultKeeper).toBe(keeper.address);
    });

    it('refuses the zero address', async () => {
      expectError(
        await send(svm, admin, [await setDefaultKeeperInstruction(admin, SYSTEM_PROGRAM)]),
        ERR.ZeroAddress,
      );
    });
  });

  describe('closed_until', () => {
    it('lets the admin set it later and earlier', async () => {
      const meta = expectOk(await send(svm, admin, [await setClosedUntilInstruction(admin, 500n)]));
      expect((await readConfig(svm)).closedUntil).toBe(500n);
      expect(events(meta, 'ClosedUntilSet')).toHaveLength(1);
      expectOk(await send(svm, admin, [await setClosedUntilInstruction(admin, 100n)]));
      expect((await readConfig(svm)).closedUntil).toBe(100n);
    });

    it('lets the guardian push it later', async () => {
      expectOk(await send(svm, admin, [await setClosedUntilInstruction(admin, 500n)]));
      const meta = expectOk(
        await send(svm, guardian, [await extendClosedUntilInstruction(guardian, 501n)]),
      );
      expect((await readConfig(svm)).closedUntil).toBe(501n);
      expect(events(meta, 'ClosedUntilSet')).toHaveLength(1);
    });

    it('does not let the guardian bring it earlier, or leave it where it is', async () => {
      expectOk(await send(svm, admin, [await setClosedUntilInstruction(admin, 500n)]));
      for (const time of [499n, 500n, 0n, -1n])
        expectError(
          await send(svm, guardian, [await extendClosedUntilInstruction(guardian, time)]),
          ERR.ParamOutOfBounds,
        );
      expect((await readConfig(svm)).closedUntil).toBe(500n);
    });

    it('keeps the admin call to the admin and the guardian call to the guardian', async () => {
      for (const who of notTheAdmin())
        expectError(
          await send(svm, who, [await setClosedUntilInstruction(who, 9n)]),
          ANCHOR.ConstraintHasOne,
        );
      for (const who of [admin, keeper, stranger])
        expectError(
          await send(svm, who, [await extendClosedUntilInstruction(who, 9n)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).closedUntil).toBe(0n);
    });

    it('needs the guardian to sign', async () => {
      expectError(
        await send(svm, stranger, [unsigned(await extendClosedUntilInstruction(guardian, 9n))]),
        ANCHOR.AccountNotSigner,
      );
    });
  });

  describe('closed days', () => {
    const closed = async () => (await readConfig(svm)).closedDays.filter((day) => day !== 0);

    it('lets the admin close a day and open it again', async () => {
      const meta = expectOk(
        await send(svm, admin, [await setClosedDayInstruction(admin, 20_733, true)]),
      );
      expect(await closed()).toEqual([20_733]);
      expect(events(meta, 'ClosedDaySet')).toHaveLength(1);
      expectOk(await send(svm, admin, [await setClosedDayInstruction(admin, 20_733, false)]));
      expect(await closed()).toEqual([]);
    });

    it('lets the guardian close a day', async () => {
      const meta = expectOk(
        await send(svm, guardian, [await addClosedDayInstruction(guardian, 20_733)]),
      );
      expect(await closed()).toEqual([20_733]);
      expect(events(meta, 'ClosedDaySet')).toHaveLength(1);
    });

    it('gives the guardian no way to open a day', async () => {
      expectOk(await send(svm, guardian, [await addClosedDayInstruction(guardian, 20_733)]));
      expectError(
        await send(svm, guardian, [await setClosedDayInstruction(guardian, 20_733, false)]),
        ANCHOR.ConstraintHasOne,
      );
      expect(await closed()).toEqual([20_733]);
    });

    it('keeps a day once: closing it twice takes one slot', async () => {
      expectOk(await send(svm, admin, [await setClosedDayInstruction(admin, 20_733, true)]));
      expectOk(await send(svm, guardian, [await addClosedDayInstruction(guardian, 20_733)]));
      expect(await closed()).toEqual([20_733]);
    });

    it('refuses day zero, which marks an empty slot', async () => {
      expectError(
        await send(svm, admin, [await setClosedDayInstruction(admin, 0, true)]),
        ERR.ParamOutOfBounds,
      );
      expectError(
        await send(svm, admin, [await setClosedDayInstruction(admin, 0, false)]),
        ERR.ParamOutOfBounds,
      );
      expectError(
        await send(svm, guardian, [await addClosedDayInstruction(guardian, 0)]),
        ERR.ParamOutOfBounds,
      );
    });

    it('holds 32 days and refuses a 33rd, until one is opened', async () => {
      for (let batch = 0; batch < 4; batch++)
        expectOk(
          await send(
            svm,
            admin,
            await Promise.all(
              Array.from({ length: 8 }, (_, i) =>
                setClosedDayInstruction(admin, 20_000 + batch * 8 + i, true),
              ),
            ),
          ),
        );
      expect(await closed()).toHaveLength(32);
      expectError(
        await send(svm, guardian, [await addClosedDayInstruction(guardian, 21_000)]),
        ERR.ParamOutOfBounds,
      );
      expectOk(await send(svm, admin, [await setClosedDayInstruction(admin, 20_005, false)]));
      expectOk(await send(svm, guardian, [await addClosedDayInstruction(guardian, 21_000)]));
      expect(await closed()).toContain(21_000);
      expect(await closed()).not.toContain(20_005);
    });

    it('is not for anyone else', async () => {
      for (const who of notTheAdmin())
        expectError(
          await send(svm, who, [await setClosedDayInstruction(who, 20_733, true)]),
          ANCHOR.ConstraintHasOne,
        );
      for (const who of [admin, keeper, stranger])
        expectError(
          await send(svm, who, [await addClosedDayInstruction(who, 20_733)]),
          ANCHOR.ConstraintHasOne,
        );
      expect(await closed()).toEqual([]);
    });
  });

  describe('set_price_account', () => {
    it('lets the admin name the price account of a slot, and says what it was and what it is', async () => {
      const prices = await createPriceAccount(svm, priceOwner);
      const meta = expectOk(
        await send(svm, admin, [await setPriceAccountInstruction(admin, 2, prices)]),
      );
      expect((await readAssets(svm)).priceAccounts).toEqual([
        SYSTEM_PROGRAM,
        SYSTEM_PROGRAM,
        prices,
        SYSTEM_PROGRAM,
      ]);
      const [event] = events(meta, 'PriceAccountSet');
      expect(event?.[0]).toBe(2);
      expect(event && decodeAddressChange(event.slice(1))).toEqual({
        old: SYSTEM_PROGRAM,
        new: prices,
      });
    });

    it('is the admin alone', async () => {
      const prices = await createPriceAccount(svm, priceOwner);
      for (const who of notTheAdmin())
        expectError(
          await send(svm, who, [await setPriceAccountInstruction(who, 0, prices)]),
          ANCHOR.ConstraintHasOne,
        );
      expectError(
        await send(svm, stranger, [unsigned(await setPriceAccountInstruction(admin, 0, prices))]),
        ANCHOR.AccountNotSigner,
      );
    });

    it('refuses an account the price program does not own', async () => {
      const prices = await createPriceAccount(svm, stranger.address);
      expectError(
        await send(svm, admin, [await setPriceAccountInstruction(admin, 0, prices)]),
        ERR.AssetNotPriced,
      );
    });

    it('refuses an account that is not the size of a price account', async () => {
      for (const size of [PRICES_SIZE - 1, PRICES_SIZE + 1, 0]) {
        const prices = await createPriceAccount(svm, priceOwner, { size });
        expectError(
          await send(svm, admin, [await setPriceAccountInstruction(admin, 0, prices)]),
          ERR.AssetNotPriced,
        );
      }
    });

    it('refuses a slot past the four', async () => {
      const prices = await createPriceAccount(svm, priceOwner);
      expectError(
        await send(svm, admin, [await setPriceAccountInstruction(admin, 4, prices)]),
        ERR.ParamOutOfBounds,
      );
    });

    it('is locked at launch, like the price program', async () => {
      const prices = await createPriceAccount(svm, priceOwner);
      expectOk(await send(svm, admin, [await launchInstruction(admin)]));
      expectError(
        await send(svm, admin, [await setPriceAccountInstruction(admin, 0, prices)]),
        ERR.LockedAtLaunch,
      );
    });

    it('goes by the price program Config names now', async () => {
      const prices = await createPriceAccount(svm, priceOwner);
      expectOk(await send(svm, admin, [await setPriceOwnerInstruction(admin, stranger.address)]));
      expectError(
        await send(svm, admin, [await setPriceAccountInstruction(admin, 0, prices)]),
        ERR.AssetNotPriced,
      );
    });

    it('writes only the real list, on the word of the real Config only', async () => {
      const prices = await createPriceAccount(svm, priceOwner);
      const forged = await forgeConfig(svm, { admin: stranger.address });
      expectError(
        await send(svm, stranger, [
          await setPriceAccountInstruction(stranger, 0, prices, { config: forged }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      const real = svm.getAccount(await assetsAddress());
      const copy = (await generateKeyPairSigner()).address;
      if (!real.exists) throw new Error('the asset list is missing');
      svm.setAccount({ ...real, address: copy });
      expectError(
        await send(svm, admin, [
          await setPriceAccountInstruction(admin, 0, prices, { assets: copy }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
    });
  });

  describe("the keeper's switch on an asset", () => {
    const priced = { priceKind: 1, priceIndex: 344, twapIndex: 279 };
    const list = async (change: Partial<AssetArgs>) =>
      send(svm, admin, [await upsertAssetInstruction(admin, stock.address, change)]);

    it('goes on for an asset with a price entry and an average of its own', async () => {
      expectOk(await list({ ...priced, flags: ASSET_KEEPER }));
      expect((await readAssets(svm)).assets[0]?.flags).toBe(ASSET_KEEPER);
    });

    it('goes off again when the admin rewrites the entry', async () => {
      expectOk(await list({ ...priced, flags: ASSET_KEEPER }));
      expectOk(await list({ ...priced, flags: 0 }));
      expect((await readAssets(svm)).assets[0]?.flags).toBe(0);
    });

    it('stays off for an asset with no price entry', async () => {
      expectError(await list({ priceKind: 0, flags: ASSET_KEEPER }), ERR.AssetNotPriced);
      expect((await readAssets(svm)).count).toBe(0);
    });

    it('stays off when the average is the price entry itself', async () => {
      expectError(
        await list({ priceKind: 1, priceIndex: 344, twapIndex: 344, flags: ASSET_KEEPER }),
        ERR.AssetNotPriced,
      );
      expect((await readAssets(svm)).count).toBe(0);
    });

    it('is the only flag: any other bit is refused, with it or without', async () => {
      for (const flags of [2, 3, 128, 255])
        expectError(await list({ ...priced, flags }), ERR.ParamOutOfBounds);
    });
  });
});
