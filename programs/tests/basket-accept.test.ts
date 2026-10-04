import { type Address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptVersionInstruction,
  adoptVersionInstruction,
  type Component,
  cancelPendingInstruction,
  configAddress,
  createVaultInstruction,
  DEFAULT_PARAMS,
  decodeVersionEvent,
  ERR,
  familyId,
  forgeConfig,
  initPlatform,
  patchVault,
  pauseKeeperInstruction,
  publishRecipeInstruction,
  readVault,
  recipeAddress,
  setAutoFollowInstruction,
  setTargetsInstruction,
  updateRecipeInstruction,
  vaultAddress,
} from './src/basket';
import {
  ANCHOR,
  createWorld,
  events,
  expectError,
  expectOk,
  fundedSigner,
  send,
  setClock,
  unsigned,
} from './src/env';
import { createMint, type TestMint, TOKEN_PROGRAM } from './src/tokens';

const START = 1_791_212_400n; // Mon 2026-10-05 15:00 UTC
const DELAY = BigInt(DEFAULT_PARAMS.publishDelayS);
const PLAN = 4n;

// How a vault comes to hold a new version of the portfolio it follows (DESIGN-VAULT.md section 5,
// "New versions"): the owner accepts it by its number, or anyone moves an auto-follow vault to it
// when it brings in nothing the owner has not accepted.
describe('accepting and adopting a version', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let guardian: KeyPairSigner;
  let creator: KeyPairSigner;
  let owner: KeyPairSigner;
  let stranger: KeyPairSigner;
  let cash: TestMint;
  let mints: Address[];
  let a: Address;
  let b: Address;
  let c: Address;
  let d: Address;
  let recipe: Address;
  let vault: Address;
  let first: Component[];
  let withD: Component[];
  let reweighted: Component[];
  /** When the portfolio's last version was published. */
  let published = START;

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    setClock(svm, START);
    published = START;
    guardian = await fundedSigner(svm);
    creator = await fundedSigner(svm);
    owner = await fundedSigner(svm);
    stranger = await fundedSigner(svm);
    cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
    mints = [];
    for (let i = 0; i < 17; i++)
      mints.push((await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 })).address);
    [a, b, c, d] = mints as [Address, Address, Address, Address];
    await initPlatform(svm, admin, { cashMint: cash.address, guardian: guardian.address }, mints);
    recipe = await recipeAddress(creator.address, familyId('high-ground'));
    vault = await vaultAddress(owner.address, PLAN);
    first = [
      { mint: a, weightBps: 5_000 },
      { mint: b, weightBps: 3_000 },
      { mint: c, weightBps: 2_000 },
    ];
    withD = [
      { mint: a, weightBps: 4_000 },
      { mint: b, weightBps: 3_000 },
      { mint: c, weightBps: 2_000 },
      { mint: d, weightBps: 1_000 },
    ];
    reweighted = [
      { mint: a, weightBps: 4_000 },
      { mint: b, weightBps: 4_000 },
      { mint: c, weightBps: 2_000 },
    ];
    expectOk(await publish(creator, 'high-ground', first));
  });

  const publish = async (who: KeyPairSigner, family: string, components: Component[]) =>
    send(svm, who, [
      await publishRecipeInstruction({ creator: who, familyId: familyId(family), components }),
    ]);
  /** A vault of the owner that follows the portfolio at its first version. */
  const follow = async (autoFollow = true) =>
    expectOk(
      await send(svm, owner, [
        await createVaultInstruction({
          owner,
          basketId: PLAN,
          recipe,
          expectedVersion: 1,
          autoFollow,
        }),
      ]),
    );
  /** Publishes a version one delay after the last and returns the second it takes effect. */
  const update = async (components: Component[], target = recipe, who = creator) => {
    published += DELAY;
    setClock(svm, published);
    expectOk(
      await send(svm, who, [
        await updateRecipeInstruction({ creator: who, recipe: target, components }),
      ]),
    );
    return published + DELAY;
  };
  const accept = async (expectedVersion: number, who = owner, target = recipe) =>
    send(svm, who, [
      await acceptVersionInstruction({ owner: who, vault, recipe: target, expectedVersion }),
    ]);
  const adopt = async (overrides: { recipe?: Address; config?: Address } = {}) =>
    send(svm, stranger, [await adoptVersionInstruction({ vault, recipe, ...overrides })]);
  const targets = () => {
    const state = readVault(svm, vault);
    return state.positions
      .slice(0, state.count)
      .map((p) => ({ mint: p.mint, weightBps: p.targetBps }));
  };
  const version = () => readVault(svm, vault).acceptedVersion;

  describe('accept_version', () => {
    it('lets a vault with targets of its own start following a shared portfolio', async () => {
      expectOk(
        await send(svm, owner, [
          await createVaultInstruction({
            owner,
            basketId: PLAN,
            targets: [{ mint: d, targetBps: 10_000 }],
          }),
        ]),
      );
      const meta = expectOk(await accept(1));
      const state = readVault(svm, vault);
      expect([state.recipe, state.acceptedVersion, state.autoFollow]).toEqual([recipe, 1, false]);
      expect(targets()).toEqual(first);
      expect(events(meta, 'Followed').map(decodeVersionEvent)).toEqual([
        { vault, recipe, version: 1 },
      ]);
      expect(events(meta, 'Unfollowed')).toHaveLength(0);
    });

    it('takes a new version, new asset included, once it is in effect', async () => {
      await follow();
      setClock(svm, await update(withD));
      const meta = expectOk(await accept(2));
      expect(version()).toBe(2);
      expect(targets()).toEqual(withD);
      expect(events(meta, 'Followed').map(decodeVersionEvent)).toEqual([
        { vault, recipe, version: 2 },
      ]);
    });

    it('refuses the version that waits: it is not in effect yet', async () => {
      await follow();
      const effectiveAt = await update(withD);
      expectError(await accept(2), ERR.VersionNotEffective);
      setClock(svm, effectiveAt - 1n);
      expectError(await accept(2), ERR.VersionNotEffective);
      expect([version(), targets()]).toEqual([1, first]);
      setClock(svm, effectiveAt);
      expectOk(await accept(2));
    });

    // A18: an accept signed against version N that lands after N+1 took effect.
    it('refuses any number but that of the version in effect', async () => {
      await follow();
      setClock(svm, await update(withD));
      for (const stale of [1, 3, 0]) expectError(await accept(stale), ERR.VersionMismatch);
      expect([version(), targets()]).toEqual([1, first]);
    });

    it('never hands over other weights under a number that was cancelled', async () => {
      await follow();
      await update(withD);
      expectOk(
        await send(svm, creator, [await cancelPendingInstruction({ signer: creator, recipe })]),
      );
      expectError(await accept(2), ERR.VersionMismatch);
      // What is published next is version 3, and "2" names nothing for good.
      setClock(svm, await update(reweighted));
      expectError(await accept(2), ERR.VersionMismatch);
      expectOk(await accept(3));
      expect(targets()).toEqual(reweighted);
    });

    it('is the owner alone', async () => {
      await follow();
      setClock(svm, await update(withD));
      expectError(await accept(2, stranger), ANCHOR.ConstraintHasOne);
      expectError(
        await send(svm, stranger, [
          unsigned(await acceptVersionInstruction({ owner, vault, recipe, expectedVersion: 2 })),
        ]),
        ANCHOR.AccountNotSigner,
      );
      expect(version()).toBe(1);
    });

    it('takes only a shared portfolio of this program', async () => {
      await follow();
      expectError(
        await accept(1, owner, await configAddress()),
        ANCHOR.AccountDiscriminatorMismatch,
      );
      const real = svm.getAccount(recipe);
      if (!real.exists) throw new Error('no recipe');
      const copy = (await generateKeyPairSigner()).address;
      svm.setAccount({ ...real, address: copy, programAddress: stranger.address });
      expectError(await accept(1, owner, copy), ANCHOR.AccountOwnedByWrongProgram);
    });

    it('says which portfolio the vault left when it takes up another', async () => {
      await follow();
      const rival = await fundedSigner(svm);
      expectOk(await publish(rival, 'low-ground', withD));
      const other = await recipeAddress(rival.address, familyId('low-ground'));
      const meta = expectOk(await accept(1, owner, other));
      expect(readVault(svm, vault).recipe).toBe(other);
      expect(targets()).toEqual(withD);
      expect(events(meta, 'Unfollowed')).toHaveLength(1);
      expect(events(meta, 'Followed').map(decodeVersionEvent)).toEqual([
        { vault, recipe: other, version: 1 },
      ]);
    });

    describe('a version that drops an asset', () => {
      let withoutC: Component[];

      beforeEach(async () => {
        withoutC = [
          { mint: a, weightBps: 5_000 },
          { mint: b, weightBps: 3_000 },
          { mint: d, weightBps: 2_000 },
        ];
        await follow();
      });

      it('keeps the asset as a position with no target while the vault still holds it', async () => {
        patchVault(svm, vault, { tracked: { mint: c, amount: 7n } });
        patchVault(svm, vault, { tracked: { mint: a, amount: 5n } });
        setClock(svm, await update(withoutC));
        expectOk(await accept(2));
        expect(targets()).toEqual([...withoutC, { mint: c, weightBps: 0 }]);
        // What was recorded for a mint that stays, stays.
        const state = readVault(svm, vault);
        expect(state.positions.slice(0, state.count).map((p) => p.tracked)).toEqual([
          5n,
          0n,
          0n,
          7n,
        ]);
      });

      it('lets the asset go when the vault holds nothing of it', async () => {
        setClock(svm, await update(withoutC));
        expectOk(await accept(2));
        expect(targets()).toEqual(withoutC);
      });
    });

    const even = (list: Address[]) =>
      list.map((mint, i) => ({ mint, weightBps: [5_000, 3_000][i] ?? 200 }));
    /** A vault that holds all twelve assets of a portfolio whose next version swaps five of them
     * for five others. Answers the portfolio and the assets of that version. */
    const wideVault = async () => {
      const rival = await fundedSigner(svm);
      const wide = await recipeAddress(rival.address, familyId('wide'));
      const twelve = mints.slice(0, 12);
      const swapped = [...mints.slice(0, 7), ...mints.slice(12, 17)];
      expectOk(await publish(rival, 'wide', even(twelve)));
      expectOk(
        await send(svm, owner, [
          await createVaultInstruction({ owner, basketId: PLAN, recipe: wide, expectedVersion: 1 }),
        ]),
      );
      for (const mint of twelve) patchVault(svm, vault, { tracked: { mint, amount: 1n } });
      setClock(svm, await update(even(swapped), wide, rival));
      return { wide, swapped };
    };

    it('refuses when the version and what is left over do not fit 16 lines', async () => {
      const { wide, swapped } = await wideVault();
      // 12 in the version and 5 left over: one too many.
      expectError(await accept(2, owner, wide), ERR.InvalidTargets);
      expect(version()).toBe(1);
      // Once the owner has sold one of the five, it fits.
      patchVault(svm, vault, { tracked: { mint: mints[11] as Address, amount: 0n } });
      expectOk(await accept(2, owner, wide));
      expect(targets()).toEqual([
        ...even(swapped),
        ...mints.slice(7, 11).map((mint) => ({ mint, weightBps: 0 })),
      ]);
    });

    it('lets the owner clear every line and take such a version in one transaction', async () => {
      const { wide, swapped } = await wideVault();
      expectError(await accept(2, owner, wide), ERR.InvalidTargets);
      expectOk(
        await send(svm, owner, [
          await setTargetsInstruction({ owner, vault, targets: [] }),
          await acceptVersionInstruction({ owner, vault, recipe: wide, expectedVersion: 2 }),
          await setAutoFollowInstruction({ owner, vault, on: true }),
        ]),
      );
      const state = readVault(svm, vault);
      expect([state.acceptedVersion, state.autoFollow]).toEqual([2, true]);
      // The leftovers have no line now, and nothing is recorded for the lines that stayed until
      // the balances are read again.
      expect(targets()).toEqual(even(swapped));
      expect(state.positions.slice(0, state.count).every((p) => p.tracked === 0n)).toBe(true);
    });
  });

  describe('adopt_version', () => {
    it('moves an auto-follow vault to a version that only changes weights, with no signature of the owner', async () => {
      await follow();
      patchVault(svm, vault, { tracked: { mint: b, amount: 9n } });
      setClock(svm, await update(reweighted));
      const meta = expectOk(await adopt());
      expect([version(), targets()]).toEqual([2, reweighted]);
      expect(readVault(svm, vault).positions[1]?.tracked).toBe(9n);
      expect(events(meta, 'VersionAdopted').map(decodeVersionEvent)).toEqual([
        { vault, recipe, version: 2 },
      ]);
    });

    // A13 for this path: the owner has not handed the vault over.
    it('refuses while auto-follow is off', async () => {
      await follow(false);
      setClock(svm, await update(reweighted));
      expectError(await adopt(), ERR.AutoFollowOff);
      expect(version()).toBe(1);
    });

    // A8 for this path.
    it('refuses while the keeper is paused, and the owner can still accept', async () => {
      await follow();
      setClock(svm, await update(reweighted));
      expectOk(await send(svm, guardian, [await pauseKeeperInstruction(guardian)]));
      expectError(await adopt(), ERR.KeeperPaused);
      expect(version()).toBe(1);
      expectOk(await accept(2));
    });

    it('reads the pause from the real Config only', async () => {
      await follow();
      setClock(svm, await update(reweighted));
      const forged = await forgeConfig(svm, {});
      expectOk(await send(svm, guardian, [await pauseKeeperInstruction(guardian)]));
      expectError(await adopt({ config: forged }), ANCHOR.ConstraintSeeds);
    });

    it('refuses when nothing newer is in effect', async () => {
      await follow();
      expectError(await adopt(), ERR.VersionNotEffective);
      // A version that waits is not in effect.
      const effectiveAt = await update(reweighted);
      setClock(svm, effectiveAt - 1n);
      expectError(await adopt(), ERR.VersionNotEffective);
      setClock(svm, effectiveAt);
      expectOk(await adopt());
      // And once taken, there is nothing left to take.
      expectError(await adopt(), ERR.VersionNotEffective);
    });

    // A14.
    it('leaves a version with a new asset to the owner', async () => {
      await follow();
      setClock(svm, await update(withD));
      expectError(await adopt(), ERR.NewAssetNeedsOwner);
      expect([version(), targets()]).toEqual([1, first]);
      expectOk(await accept(2));
      expect(targets()).toEqual(withD);
    });

    it('counts an asset the vault only holds leftovers of as new', async () => {
      // The owner's own targets left `d` out; the vault follows again and `d` is a leftover.
      await follow();
      setClock(svm, await update(withD));
      expectOk(await accept(2));
      patchVault(svm, vault, { tracked: { mint: d, amount: 3n } });
      setClock(svm, await update(first));
      expectOk(await adopt());
      expect(targets()).toEqual([...first, { mint: d, weightBps: 0 }]);
      // The version after brings `d` back: holding it was not accepting it.
      setClock(svm, await update(withD));
      expectError(await adopt(), ERR.NewAssetNeedsOwner);
    });

    it('takes only the portfolio the vault follows', async () => {
      await follow();
      const rival = await fundedSigner(svm);
      expectOk(await publish(rival, 'low-ground', first));
      const other = await recipeAddress(rival.address, familyId('low-ground'));
      setClock(svm, await update(reweighted, other, rival));
      expectError(await adopt({ recipe: other }), ANCHOR.ConstraintAddress);
      expect(version()).toBe(1);
    });

    it('does nothing for a vault that follows no portfolio', async () => {
      await follow();
      expectOk(
        await send(svm, owner, [
          await setTargetsInstruction({ owner, vault, targets: [{ mint: a, targetBps: 10_000 }] }),
          await setAutoFollowInstruction({ owner, vault, on: true }),
        ]),
      );
      setClock(svm, await update(reweighted));
      expectError(await adopt(), ANCHOR.ConstraintAddress);
      expect(targets()).toEqual([{ mint: a, weightBps: 10_000 }]);
    });
  });

  describe('set_auto_follow', () => {
    it('lets the owner switch it on and off, and says so', async () => {
      await follow(false);
      const on = expectOk(
        await send(svm, owner, [await setAutoFollowInstruction({ owner, vault, on: true })]),
      );
      expect(readVault(svm, vault).autoFollow).toBe(true);
      expect(events(on, 'AutoFollowSet')).toHaveLength(1);
      expectOk(
        await send(svm, owner, [await setAutoFollowInstruction({ owner, vault, on: false })]),
      );
      expect(readVault(svm, vault).autoFollow).toBe(false);
    });

    it('is the owner alone', async () => {
      await follow(false);
      expectError(
        await send(svm, stranger, [
          await setAutoFollowInstruction({ owner: stranger, vault, on: true }),
        ]),
        ANCHOR.ConstraintHasOne,
      );
      expectError(
        await send(svm, stranger, [
          unsigned(await setAutoFollowInstruction({ owner, vault, on: true })),
        ]),
        ANCHOR.AccountNotSigner,
      );
      expect(readVault(svm, vault).autoFollow).toBe(false);
    });
  });
});
