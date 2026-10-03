import { type Address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptAdminInstruction,
  DEFAULT_PARAMS,
  ERR,
  forgeConfig,
  type InitConfigArgs,
  initConfigInstruction,
  launchInstruction,
  type Params,
  pauseKeeperInstruction,
  proposeAdminInstruction,
  readConfig,
  setCashMintInstruction,
  setParamsInstruction,
  setPriceOwnerInstruction,
  setRouterInstruction,
  unpauseKeeperInstruction,
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
} from './src/env';

const TWO_DAYS = 172_800;

// What the admin and the guardian can and cannot do to Config after it exists.
describe('basket admin', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner; // the upgrade authority, which init_config makes the admin
  let guardian: KeyPairSigner;
  let keeper: KeyPairSigner;
  let stranger: KeyPairSigner;
  let args: InitConfigArgs;

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    guardian = await fundedSigner(svm);
    keeper = await fundedSigner(svm);
    stranger = await fundedSigner(svm);
    args = {
      guardian: guardian.address,
      defaultKeeper: keeper.address,
      routerProgram: MOCK_ROUTER_PROGRAM,
      priceOwner: (await generateKeyPairSigner()).address,
      cashMint: (await generateKeyPairSigner()).address,
      params: DEFAULT_PARAMS,
    };
    expectOk(await send(svm, admin, [await initConfigInstruction(admin, args)]));
  });

  const others = () => [guardian, keeper, stranger];

  describe('set_params', () => {
    const changed: Params = {
      toleranceBps: 100,
      lossCapBps: 300,
      bandBps: 80,
      twapDevBps: 150,
      maxPriceAgeS: 90,
      assetCooldownS: 7_200,
      publishDelayS: 300,
      sessionOpenUtcS: 50_000,
      sessionCloseUtcS: 70_000,
    };

    it('lets the admin change every parameter, and says what they are now', async () => {
      const before = await readConfig(svm);
      const meta = expectOk(await send(svm, admin, [await setParamsInstruction(admin, changed)]));
      expect(await readConfig(svm)).toEqual({ ...before, ...changed });
      expect(events(meta, 'ParamsSet')).toHaveLength(1);
    });

    it('is the admin alone: not the guardian, the keeper or anyone else', async () => {
      for (const who of others())
        expectError(
          await send(svm, who, [await setParamsInstruction(who, changed)]),
          ANCHOR.ConstraintHasOne,
        );
      expect(await readConfig(svm)).toMatchObject(DEFAULT_PARAMS);
    });

    it('refuses a forged Config that names the signer as admin', async () => {
      const forged = await forgeConfig(svm, { admin: stranger.address });
      expectError(
        await send(svm, stranger, [await setParamsInstruction(stranger, changed, forged)]),
        ANCHOR.ConstraintSeeds,
      );
    });

    const outOfBounds: [string, Partial<Params>][] = [
      ['a tolerance above 300 bps', { toleranceBps: 301 }],
      ['a weekly loss cap above 500 bps', { lossCapBps: 501 }],
      ['a band above 500 bps', { bandBps: 501 }],
      ['a price deviation allowance above 1,000 bps', { twapDevBps: 1_001 }],
      ['a price older than 600 s', { maxPriceAgeS: 601 }],
      ['a cooldown under 600 s', { assetCooldownS: 599 }],
      ['a publish delay under 60 s', { publishDelayS: 59 }],
      ['a session that opens before 13:30 UTC', { sessionOpenUtcS: 48_599 }],
      ['a session that closes after 21:00 UTC', { sessionCloseUtcS: 75_601 }],
      [
        'a session that closes when it opens',
        { sessionOpenUtcS: 60_000, sessionCloseUtcS: 60_000 },
      ],
    ];

    it.each(outOfBounds)('holds the hard bounds: refuses %s', async (_, change) => {
      expectError(
        await send(svm, admin, [
          await setParamsInstruction(admin, { ...DEFAULT_PARAMS, ...change }),
        ]),
        ERR.ParamOutOfBounds,
      );
      expect(await readConfig(svm)).toMatchObject(DEFAULT_PARAMS);
    });
  });

  describe('launch', () => {
    it('is one way: it sets the latch and raises the publish delay to two days', async () => {
      expect((await readConfig(svm)).publishDelayS).toBe(60);
      const meta = expectOk(await send(svm, admin, [await launchInstruction(admin)]));
      const config = await readConfig(svm);
      expect(config.launched).toBe(true);
      expect(config.publishDelayS).toBe(TWO_DAYS);
      expect(events(meta, 'Launched')).toHaveLength(1);

      // A second launch changes nothing and says so.
      expectError(await send(svm, admin, [await launchInstruction(admin)]), ERR.LockedAtLaunch);
      expect((await readConfig(svm)).launched).toBe(true);
    });

    it('leaves a publish delay that is already longer than two days', async () => {
      const longer = { ...DEFAULT_PARAMS, publishDelayS: TWO_DAYS + 3_600 };
      expectOk(await send(svm, admin, [await setParamsInstruction(admin, longer)]));
      expectOk(await send(svm, admin, [await launchInstruction(admin)]));
      expect((await readConfig(svm)).publishDelayS).toBe(TWO_DAYS + 3_600);
    });

    it('is the admin alone', async () => {
      for (const who of others())
        expectError(await send(svm, who, [await launchInstruction(who)]), ANCHOR.ConstraintHasOne);
      expect((await readConfig(svm)).launched).toBe(false);
    });

    it('after it the publish delay cannot go under two days, and can still go up', async () => {
      expectOk(await send(svm, admin, [await launchInstruction(admin)]));
      const params = { ...DEFAULT_PARAMS, publishDelayS: TWO_DAYS - 1 };
      expectError(
        await send(svm, admin, [await setParamsInstruction(admin, params)]),
        ERR.ParamOutOfBounds,
      );
      expect((await readConfig(svm)).publishDelayS).toBe(TWO_DAYS);

      const up = { ...DEFAULT_PARAMS, toleranceBps: 50, publishDelayS: TWO_DAYS + 60 };
      expectOk(await send(svm, admin, [await setParamsInstruction(admin, up)]));
      expect(await readConfig(svm)).toMatchObject(up);
    });

    // After launch a change to what a vault trusts needs a program upgrade, which anyone can see.
    it.each([
      ['the router', 'routerProgram', setRouterInstruction],
      ['the price owner', 'priceOwner', setPriceOwnerInstruction],
      ['the cash mint', 'cashMint', setCashMintInstruction],
    ] as const)('locks %s', async (_, field, set) => {
      const replacement = (await generateKeyPairSigner()).address;
      expectOk(await send(svm, admin, [await launchInstruction(admin)]));
      expectError(await send(svm, admin, [await set(admin, replacement)]), ERR.LockedAtLaunch);
      expect((await readConfig(svm))[field]).toBe(args[field]);
    });
  });

  describe('handing the admin over', () => {
    let next: KeyPairSigner;

    beforeEach(async () => {
      next = await fundedSigner(svm);
    });

    it('takes two steps: the admin proposes, the proposed key accepts', async () => {
      const proposed = expectOk(
        await send(svm, admin, [await proposeAdminInstruction(admin, next.address)]),
      );
      let config = await readConfig(svm);
      expect([config.admin, config.pendingAdmin]).toEqual([admin.address, next.address]);
      expect(events(proposed, 'AdminProposed')).toHaveLength(1);
      // Until the second step, the admin is who it was.
      expectError(
        await send(svm, next, [await setParamsInstruction(next, DEFAULT_PARAMS)]),
        ANCHOR.ConstraintHasOne,
      );

      const accepted = expectOk(await send(svm, next, [await acceptAdminInstruction(next)]));
      config = await readConfig(svm);
      expect([config.admin, config.pendingAdmin]).toEqual([next.address, SYSTEM_PROGRAM]);
      expect(events(accepted, 'AdminChanged')).toHaveLength(1);

      // The old admin is nobody now, and the new one is the admin.
      expectError(
        await send(svm, admin, [await setParamsInstruction(admin, DEFAULT_PARAMS)]),
        ANCHOR.ConstraintHasOne,
      );
      expectOk(await send(svm, next, [await setParamsInstruction(next, DEFAULT_PARAMS)]));
    });

    it('only the admin proposes', async () => {
      for (const who of [...others(), next])
        expectError(
          await send(svm, who, [await proposeAdminInstruction(who, who.address)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).pendingAdmin).toBe(SYSTEM_PROGRAM);
    });

    it('only the proposed key accepts, and nobody can while none is proposed', async () => {
      for (const who of [...others(), next, admin])
        expectError(
          await send(svm, who, [await acceptAdminInstruction(who)]),
          ANCHOR.ConstraintHasOne,
        );
      expectOk(await send(svm, admin, [await proposeAdminInstruction(admin, next.address)]));
      for (const who of [...others(), admin])
        expectError(
          await send(svm, who, [await acceptAdminInstruction(who)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).admin).toBe(admin.address);
    });

    it('the admin can take a proposal back', async () => {
      expectOk(await send(svm, admin, [await proposeAdminInstruction(admin, next.address)]));
      expectOk(await send(svm, admin, [await proposeAdminInstruction(admin, SYSTEM_PROGRAM)]));
      expectError(
        await send(svm, next, [await acceptAdminInstruction(next)]),
        ANCHOR.ConstraintHasOne,
      );
      expect((await readConfig(svm)).admin).toBe(admin.address);
    });

    it('refuses a forged Config that names the signer as the proposed admin', async () => {
      expectOk(await send(svm, admin, [await proposeAdminInstruction(admin, next.address)]));
      const real = svm.getAccount((await forgeConfig(svm, {})) as Address);
      if (!real.exists) throw new Error('no forged config');
      expectError(
        await send(svm, next, [await acceptAdminInstruction(next, real.address)]),
        ANCHOR.ConstraintSeeds,
      );
    });
  });

  describe('the keeper pause', () => {
    it('the guardian pauses and only the admin starts the keeper again', async () => {
      const paused = expectOk(await send(svm, guardian, [await pauseKeeperInstruction(guardian)]));
      expect((await readConfig(svm)).keeperPaused).toBe(true);
      expect(events(paused, 'KeeperPauseSet')).toHaveLength(1);

      // The guardian can only tighten.
      for (const who of others())
        expectError(
          await send(svm, who, [await unpauseKeeperInstruction(who)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).keeperPaused).toBe(true);

      expectOk(await send(svm, admin, [await unpauseKeeperInstruction(admin)]));
      expect((await readConfig(svm)).keeperPaused).toBe(false);
    });

    it('nobody but the guardian pauses, the admin included', async () => {
      for (const who of [admin, keeper, stranger])
        expectError(
          await send(svm, who, [await pauseKeeperInstruction(who)]),
          ANCHOR.ConstraintHasOne,
        );
      expect((await readConfig(svm)).keeperPaused).toBe(false);
    });

    it('refuses a forged Config that names the signer as guardian', async () => {
      const forged = await forgeConfig(svm, { guardian: stranger.address });
      expectError(
        await send(svm, stranger, [await pauseKeeperInstruction(stranger, forged)]),
        ANCHOR.ConstraintSeeds,
      );
      expect((await readConfig(svm)).keeperPaused).toBe(false);
    });
  });
});
