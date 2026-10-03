import {
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  type KeyPairSigner,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assetsAddress,
  type Component,
  cancelPendingInstruction,
  configAddress,
  createVaultInstruction,
  DEFAULT_PARAMS,
  decodeRecipePublished,
  ERR,
  familyId,
  forgeConfig,
  initPlatform,
  limitReason,
  publishRecipeInstruction,
  RECIPE_SIZE,
  readRecipe,
  recipeAddress,
  updateRecipeInstruction,
  vaultAddress,
} from './src/basket';
import {
  ANCHOR,
  BASKET_PROGRAM,
  createWorld,
  events,
  expectError,
  expectOk,
  failed,
  fundedSigner,
  now,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  send,
  setClock,
  unsigned,
} from './src/env';
import { createMint, TOKEN_PROGRAM } from './src/tokens';

const START = 1_791_212_400n; // Mon 2026-10-05 15:00 UTC
const DELAY = BigInt(DEFAULT_PARAMS.publishDelayS);
const FAMILY = familyId('storm-cellar');
const META = new Uint8Array(32).fill(9);

// The shared-portfolio registry (DESIGN-VAULT.md section 6): who may write a portfolio, and when
// each version is in effect. What a version may hold is in creator-limits.vectors.test.ts.
describe('the shared-portfolio registry', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let guardian: KeyPairSigner;
  let creator: KeyPairSigner;
  let stranger: KeyPairSigner;
  let cash: Address;
  let a: Address;
  let b: Address;
  let c: Address;
  let d: Address;
  let recipe: Address;
  let first: Component[];
  let second: Component[];

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    setClock(svm, START);
    guardian = await fundedSigner(svm);
    creator = await fundedSigner(svm);
    stranger = await fundedSigner(svm);
    const mint = async () =>
      (await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 })).address;
    [cash, a, b, c, d] = [await mint(), await mint(), await mint(), await mint(), await mint()];
    await initPlatform(svm, admin, { cashMint: cash, guardian: guardian.address }, [a, b, c, d]);
    recipe = await recipeAddress(creator.address, FAMILY);
    first = [
      { mint: a, weightBps: 5_000 },
      { mint: b, weightBps: 3_000 },
      { mint: c, weightBps: 2_000 },
    ];
    second = [
      { mint: a, weightBps: 4_000 },
      { mint: b, weightBps: 3_000 },
      { mint: c, weightBps: 2_000 },
      { mint: d, weightBps: 1_000 },
    ];
  });

  const publish = async (who: KeyPairSigner = creator, family = FAMILY) =>
    send(svm, who, [
      await publishRecipeInstruction({
        creator: who,
        familyId: family,
        components: first,
        metaHash: META,
      }),
    ]);
  const update = async (components = second, who: KeyPairSigner = creator) =>
    send(svm, who, [await updateRecipeInstruction({ creator: who, recipe, components })]);
  const cancel = async (who: KeyPairSigner) =>
    send(svm, who, [await cancelPendingInstruction({ signer: who, recipe })]);
  const empty = {
    version: 0,
    effectiveAt: 0n,
    metaHash: new Uint8Array(32),
    count: 0,
    components: [],
  };

  describe('the first version', () => {
    it('creates the portfolio at the address of its creator and family, in effect at once', async () => {
      const meta = expectOk(await publish());

      const account = svm.getAccount(recipe);
      expect(account.exists && account.programAddress).toBe(BASKET_PROGRAM);
      expect(account.exists && account.data.length).toBe(RECIPE_SIZE);
      const state = readRecipe(svm, recipe);
      expect(state.creator).toBe(creator.address);
      expect(state.familyId).toEqual(FAMILY);
      expect(state.current).toEqual({
        version: 1,
        effectiveAt: START,
        metaHash: META,
        count: 3,
        components: first,
      });
      expect(state.pending).toEqual(empty);
      expect(state.lastPublishTs).toBe(START);
      expect([state.maxFeeBps, state.flags, state.vetoed]).toEqual([0, 0, false]);
      expect(state.reserved.every((byte) => byte === 0)).toBe(true);

      expect(events(meta, 'RecipePublished').map(decodeRecipePublished)).toEqual([
        {
          recipe,
          version: 1,
          creator: creator.address,
          components: first,
          effectiveAt: START,
          turnoverBps: 0,
          metaHash: META,
        },
      ]);
    });

    it('is one per creator per family', async () => {
      expectOk(await publish());
      expectError(await publish(), SYSTEM_ACCOUNT_ALREADY_IN_USE);
      // Another family of the same creator, and the same family of another creator, are others.
      expectOk(await publish(creator, familyId('high-ground')));
      expectOk(await publish(stranger));
      const theirs = await recipeAddress(stranger.address, FAMILY);
      expect(
        new Set([recipe, theirs, await recipeAddress(creator.address, familyId('high-ground'))])
          .size,
      ).toBe(3);
      expect(readRecipe(svm, theirs).creator).toBe(stranger.address);
    });

    it('cannot be published at the address of another creator', async () => {
      const result = await send(svm, stranger, [
        await publishRecipeInstruction({
          creator: stranger,
          familyId: FAMILY,
          components: first,
          recipe,
        }),
      ]);
      expectError(result, ANCHOR.ConstraintSeeds);
      expect(svm.getAccount(recipe).exists).toBe(false);
    });

    it('is checked against the real Config and the real asset list only', async () => {
      // A copy of Config that names another cash mint: the real cash mint would pass as an asset.
      const forged = await forgeConfig(svm, { cashMint: d });
      expectError(
        await send(svm, creator, [
          await publishRecipeInstruction({
            creator,
            familyId: FAMILY,
            components: first,
            config: forged,
          }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      const real = svm.getAccount(await assetsAddress());
      if (!real.exists) throw new Error('no asset list');
      const copy = (await generateKeyPairSigner()).address;
      svm.setAccount({ ...real, address: copy });
      expectError(
        await send(svm, creator, [
          await publishRecipeInstruction({
            creator,
            familyId: FAMILY,
            components: first,
            assets: copy,
          }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      expect(svm.getAccount(recipe).exists).toBe(false);
    });
  });

  describe('a later version', () => {
    beforeEach(async () => {
      expectOk(await publish());
      setClock(svm, START + DELAY);
    });

    it('waits one publish delay, and is in effect from then on with no transaction', async () => {
      const meta = expectOk(await update());
      const state = readRecipe(svm, recipe);
      expect(state.current.version).toBe(1);
      expect(state.pending).toEqual({
        version: 2,
        effectiveAt: START + DELAY + DELAY,
        metaHash: new Uint8Array(32),
        count: 4,
        components: second,
      });
      expect(state.lastPublishTs).toBe(START + DELAY);
      const [event] = events(meta, 'RecipePublished').map(decodeRecipePublished);
      expect(event).toMatchObject({
        recipe,
        version: 2,
        components: second,
        effectiveAt: START + DELAY + DELAY,
        turnoverBps: 1_000,
      });

      // One second before its time a third version is refused as pending; at its time the
      // second is the one in effect, and the third is measured against it.
      const third = [
        { mint: a, weightBps: 3_000 },
        { mint: b, weightBps: 3_000 },
        { mint: c, weightBps: 2_000 },
        { mint: d, weightBps: 2_000 },
      ];
      setClock(svm, START + DELAY + DELAY - 1n);
      const early = await update(third);
      expectError(early, ERR.CreatorLimit);
      expect(failed(early) && limitReason(early.meta().logs())).toBe(11);

      setClock(svm, START + DELAY + DELAY);
      expectOk(await update(third));
      const after = readRecipe(svm, recipe);
      expect(after.current).toEqual(state.pending);
      expect(after.pending.version).toBe(3);
      expect(after.pending.components).toEqual(third);
    });

    it('is the creator alone', async () => {
      for (const who of [stranger, guardian, admin])
        expectError(await update(second, who), ANCHOR.ConstraintHasOne);
      // Naming the creator is not enough: the creator signs.
      const named = await updateRecipeInstruction({ creator, recipe, components: second });
      expectError(await send(svm, stranger, [unsigned(named)]), ANCHOR.AccountNotSigner);
      expect(readRecipe(svm, recipe).pending).toEqual(empty);
    });

    it('is checked against the real Config and the real asset list only', async () => {
      // A copy of Config with no delay to wait: a version too soon would pass.
      setClock(svm, START + 1n);
      const forged = await forgeConfig(svm, { publishDelayS: 0 });
      expectError(
        await send(svm, creator, [
          await updateRecipeInstruction({ creator, recipe, components: second, config: forged }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      expectError(
        await send(svm, creator, [
          await updateRecipeInstruction({
            creator,
            recipe,
            components: second,
            assets: await configAddress(),
          }),
        ]),
        ANCHOR.AccountDiscriminatorMismatch,
      );
      expect(readRecipe(svm, recipe).pending).toEqual(empty);
    });

    it('does not take a vault where the portfolio goes', async () => {
      const vault = await vaultAddress(creator.address, 1n);
      expectOk(
        await send(svm, creator, [await createVaultInstruction({ owner: creator, basketId: 1n })]),
      );
      expectError(
        await send(svm, creator, [
          await updateRecipeInstruction({ creator, recipe: vault, components: second }),
        ]),
        ANCHOR.AccountDiscriminatorMismatch,
      );
    });
  });

  describe('cancelling a version that waits', () => {
    beforeEach(async () => {
      expectOk(await publish());
      setClock(svm, START + DELAY);
      expectOk(await update());
    });

    it.each(['creator', 'guardian'] as const)('the %s can', async (role) => {
      const who = role === 'creator' ? creator : guardian;
      const meta = expectOk(await cancel(who));
      const state = readRecipe(svm, recipe);
      expect(state.pending).toEqual(empty);
      expect(state.current.version).toBe(1);
      // The time of the cancelled publish stays: a cancel does not give the slot back.
      expect(state.lastPublishTs).toBe(START + DELAY);

      // VersionCancelled { recipe, version, by }
      const [event] = events(meta, 'VersionCancelled');
      if (!event) throw new Error('no VersionCancelled event');
      expect(getAddressDecoder().decode(event.slice(0, 32))).toBe(recipe);
      expect(new DataView(event.buffer, event.byteOffset).getUint32(32, true)).toBe(2);
      expect(getAddressDecoder().decode(event.slice(36, 68))).toBe(who.address);
    });

    it('nobody else can, the admin included', async () => {
      for (const who of [stranger, admin]) expectError(await cancel(who), ERR.NotCreatorOrGuardian);
      // Naming the creator or the guardian is not enough: they sign.
      for (const who of [creator, guardian]) {
        const named = await cancelPendingInstruction({ signer: who, recipe });
        expectError(await send(svm, stranger, [unsigned(named)]), ANCHOR.AccountNotSigner);
      }
      expect(readRecipe(svm, recipe).pending.version).toBe(2);
    });

    it('refuses a forged Config that names the signer as guardian', async () => {
      const forged = await forgeConfig(svm, { guardian: stranger.address });
      expectError(
        await send(svm, stranger, [
          await cancelPendingInstruction({ signer: stranger, recipe, config: forged }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      expect(readRecipe(svm, recipe).pending.version).toBe(2);
    });

    it('there is nothing to cancel once nothing waits', async () => {
      expectOk(await cancel(creator));
      expectError(await cancel(creator), ERR.NoPendingVersion);
      expectError(await cancel(guardian), ERR.NoPendingVersion);
    });

    it('a version whose time has come is in effect and cannot be cancelled', async () => {
      setClock(svm, now(svm) + DELAY - 1n);
      const state = readRecipe(svm, recipe);
      expect(state.pending.effectiveAt).toBe(now(svm) + 1n);
      setClock(svm, state.pending.effectiveAt);
      for (const who of [creator, guardian]) expectError(await cancel(who), ERR.NoPendingVersion);
      expect(readRecipe(svm, recipe).pending.version).toBe(2);
    });
  });
});
