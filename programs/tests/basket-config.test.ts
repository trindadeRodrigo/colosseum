import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_SIZE,
  configAddress,
  ERR,
  FROZEN_ERRORS,
  type InitConfigArgs,
  initConfigInstruction,
  type Params,
  readConfig,
  setPriceOwnerInstruction,
  setRouterInstruction,
} from './src/basket';
import {
  ANCHOR,
  BASKET_PROGRAM,
  createWorld,
  expectError,
  expectOk,
  failed,
  fundedSigner,
  loadProgram,
  MOCK_ROUTER_PROGRAM,
  programDataAddress,
  REPO_ROOT,
  SYSTEM_PROGRAM,
  send,
} from './src/env';

// The starting values of DESIGN-VAULT.md section 5. They are settings, not figures the app shows.
const PARAMS: Params = {
  toleranceBps: 75,
  lossCapBps: 200,
  bandBps: 50,
  twapDevBps: 200,
  maxPriceAgeS: 120,
  assetCooldownS: 3_600,
  publishDelayS: 60,
  sessionOpenUtcS: 14 * 3_600 + 30 * 60,
  sessionCloseUtcS: 20 * 3_600,
};

describe('basket config', () => {
  let svm: LiteSVM;
  let deployer: KeyPairSigner; // the program's upgrade authority
  let args: InitConfigArgs;

  beforeEach(async () => {
    ({ svm, deployer } = await createWorld());
    args = {
      guardian: (await generateKeyPairSigner()).address,
      defaultKeeper: (await generateKeyPairSigner()).address,
      // On devnet the test exchange and the owner of the test price account; on mainnet
      // Jupiter and Kamino Scope. Either way they are values in Config.
      routerProgram: MOCK_ROUTER_PROGRAM,
      priceOwner: (await generateKeyPairSigner()).address,
      params: PARAMS,
    };
  });

  const init = async (authority: KeyPairSigner, overrides: Partial<InitConfigArgs> = {}) =>
    send(svm, authority, [await initConfigInstruction(authority, { ...args, ...overrides })]);

  describe('initialise', () => {
    it('lets the upgrade authority initialise it, and makes that key the admin', async () => {
      expectOk(await init(deployer));

      const account = svm.getAccount(await configAddress());
      expect(account.exists && account.data.length).toBe(CONFIG_SIZE);

      const config = await readConfig(svm);
      expect(config.admin).toBe(deployer.address);
      expect(config.pendingAdmin).toBe(SYSTEM_PROGRAM); // all zeros: none
      expect(config.guardian).toBe(args.guardian);
      expect(config.defaultKeeper).toBe(args.defaultKeeper);
      expect(config.routerProgram).toBe(MOCK_ROUTER_PROGRAM);
      expect(config.priceOwner).toBe(args.priceOwner);
      expect(config.keeperPaused).toBe(false);
      expect(config.launched).toBe(false);
      expect(config).toMatchObject(PARAMS);
      expect(config.closedUntil).toBe(0n);
      expect(config.closedDays).toEqual(new Array(32).fill(0));
      expect(config.reserved.every((b) => b === 0)).toBe(true);
    });

    it('refuses a signer who is not the upgrade authority', async () => {
      const stranger = await fundedSigner(svm);
      expectError(await init(stranger), ERR.NotUpgradeAuthority);
      expect(svm.getAccount(await configAddress()).exists).toBe(false);
    });

    it("refuses another program's data account as proof of the upgrade authority", async () => {
      // The attacker really is the upgrade authority of some program, just not of this one.
      const attacker = await fundedSigner(svm);
      const otherProgram = (await generateKeyPairSigner()).address;
      await loadProgram(svm, otherProgram, 'mock_router.so', attacker.address);

      const result = await send(svm, attacker, [
        await initConfigInstruction(attacker, args, {
          programData: await programDataAddress(otherProgram),
        }),
      ]);
      expectError(result, ERR.NotUpgradeAuthority);
    });

    it('refuses another program passed in place of this one', async () => {
      const attacker = await fundedSigner(svm);
      const otherProgram = (await generateKeyPairSigner()).address;
      await loadProgram(svm, otherProgram, 'mock_router.so', attacker.address);

      const result = await send(svm, attacker, [
        await initConfigInstruction(attacker, args, {
          program: otherProgram,
          programData: await programDataAddress(otherProgram),
        }),
      ]);
      expectError(result, ANCHOR.InvalidProgramId);
    });

    it('cannot be initialised twice', async () => {
      expectOk(await init(deployer));
      const other = (await generateKeyPairSigner()).address;
      expect(failed(await init(deployer, { routerProgram: other }))).toBe(true);
      expect((await readConfig(svm)).routerProgram).toBe(MOCK_ROUTER_PROGRAM);
    });
  });

  // DESIGN-VAULT.md section 3.7: the numbers the app shows cannot move past these without an upgrade.
  describe('hard bounds on the parameters', () => {
    const outOfBounds: [string, Partial<Params>][] = [
      ['a tolerance above 300 bps', { toleranceBps: 301 }],
      ['a weekly loss cap above 500 bps', { lossCapBps: 501 }],
      ['a cooldown under 600 s', { assetCooldownS: 599 }],
      ['a publish delay under 60 s', { publishDelayS: 59 }],
    ];

    it.each(outOfBounds)('refuses %s', async (_, change) => {
      expectError(await init(deployer, { params: { ...PARAMS, ...change } }), ERR.ParamOutOfBounds);
    });

    it('accepts each bound itself', async () => {
      const atTheBounds = {
        ...PARAMS,
        toleranceBps: 300,
        lossCapBps: 500,
        assetCooldownS: 600,
        publishDelayS: 60,
      };
      expectOk(await init(deployer, { params: atTheBounds }));
      expect(await readConfig(svm)).toMatchObject(atTheBounds);
    });
  });

  describe('the router and the price source owner', () => {
    let guardian: KeyPairSigner;
    let keeper: KeyPairSigner;
    let newRouter: Address;
    let newPriceOwner: Address;

    beforeEach(async () => {
      guardian = await fundedSigner(svm);
      keeper = await fundedSigner(svm);
      expectOk(await init(deployer, { guardian: guardian.address, defaultKeeper: keeper.address }));
      newRouter = (await generateKeyPairSigner()).address;
      newPriceOwner = (await generateKeyPairSigner()).address;
    });

    it('are changed by the admin, and nothing else moves', async () => {
      const before = await readConfig(svm);
      expectOk(
        await send(svm, deployer, [
          await setRouterInstruction(deployer, newRouter),
          await setPriceOwnerInstruction(deployer, newPriceOwner),
        ]),
      );
      expect(await readConfig(svm)).toEqual({
        ...before,
        routerProgram: newRouter,
        priceOwner: newPriceOwner,
      });
    });

    it('cannot be changed by anyone else, the guardian and the keeper included', async () => {
      const stranger = await fundedSigner(svm);
      for (const who of [guardian, keeper, stranger]) {
        expectError(
          await send(svm, who, [await setRouterInstruction(who, newRouter)]),
          ANCHOR.ConstraintHasOne,
        );
        expectError(
          await send(svm, who, [await setPriceOwnerInstruction(who, newPriceOwner)]),
          ANCHOR.ConstraintHasOne,
        );
      }
      const config = await readConfig(svm);
      expect(config.routerProgram).toBe(MOCK_ROUTER_PROGRAM);
      expect(config.priceOwner).toBe(args.priceOwner);
    });
  });

  describe('the source', () => {
    const SRC = join(REPO_ROOT, 'programs', 'basket', 'src');
    const rustFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? rustFiles(join(dir, entry.name))
          : entry.name.endsWith('.rs')
            ? [join(dir, entry.name)]
            : [],
      );

    it('names no address but its own: the router and the price source live in Config', () => {
      const addresses = rustFiles(SRC).flatMap(
        (file) => readFileSync(file, 'utf8').match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? [],
      );
      expect(addresses).toEqual([`"${BASKET_PROGRAM}"`]);
    });

    it('keeps the error list in the frozen order, appending only', () => {
      const source = readFileSync(join(SRC, 'errors.rs'), 'utf8');
      const variants = [...source.matchAll(/^\s+([A-Z][A-Za-z]+),$/gm)].map((m) => m[1]);
      expect(variants.slice(0, FROZEN_ERRORS.length)).toEqual([...FROZEN_ERRORS]);
      expect(6000 + variants.indexOf('NotUpgradeAuthority')).toBe(ERR.NotUpgradeAuthority);
      expect(6000 + variants.indexOf('InvalidTargets')).toBe(ERR.InvalidTargets);
    });
  });
});
