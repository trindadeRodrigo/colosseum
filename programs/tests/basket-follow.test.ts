import {
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
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
  ERR,
  familyId,
  forgeConfig,
  initPlatform,
  MAX_POSITIONS,
  pauseKeeperInstruction,
  publishRecipeInstruction,
  readVault,
  recipeAddress,
  setTargetsInstruction,
  type Target,
  trackedFor,
  updateRecipeInstruction,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import {
  ANCHOR,
  createWorld,
  events,
  expectError,
  expectOk,
  fundedSigner,
  readonly,
  SYSTEM_PROGRAM,
  send,
  setClock,
} from './src/env';
import { createAta, createMint, mintTo, type TestMint, TOKEN_PROGRAM } from './src/tokens';

const START = 1_791_212_400n; // Mon 2026-10-05 15:00 UTC
const DELAY = BigInt(DEFAULT_PARAMS.publishDelayS);
const PLAN = 3n;

// A vault and the shared portfolio it follows (DESIGN-VAULT.md section 5, "New versions"), and
// the owner's own targets. Accept, adopt and auto-follow are later instructions.
describe('a vault and its targets', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let guardian: KeyPairSigner;
  let creator: KeyPairSigner;
  let owner: KeyPairSigner;
  let stranger: KeyPairSigner;
  let cash: TestMint;
  let mints: TestMint[];
  let a: Address;
  let b: Address;
  let c: Address;
  let d: Address;
  let recipe: Address;
  let vault: Address;
  let first: Component[];
  let second: Component[];

  beforeEach(async () => {
    ({ svm, deployer: admin } = await createWorld());
    setClock(svm, START);
    guardian = await fundedSigner(svm);
    creator = await fundedSigner(svm);
    owner = await fundedSigner(svm);
    stranger = await fundedSigner(svm);
    cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
    mints = [];
    for (let i = 0; i < 4; i++)
      mints.push(await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 }));
    [a, b, c, d] = mints.map((m) => m.address) as [Address, Address, Address, Address];
    await initPlatform(svm, admin, { cashMint: cash.address, guardian: guardian.address }, [
      a,
      b,
      c,
      d,
    ]);
    recipe = await recipeAddress(creator.address, familyId('high-ground'));
    vault = await vaultAddress(owner.address, PLAN);
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
    expectOk(
      await send(svm, creator, [
        await publishRecipeInstruction({
          creator,
          familyId: familyId('high-ground'),
          components: first,
        }),
      ]),
    );
  });

  const follow = async (expectedVersion: number, extra: { targets?: Target[] } = {}) =>
    send(svm, owner, [
      await createVaultInstruction({
        owner,
        basketId: PLAN,
        recipe,
        expectedVersion,
        autoFollow: true,
        ...extra,
      }),
    ]);
  const publishSecond = async () => {
    setClock(svm, START + DELAY);
    expectOk(
      await send(svm, creator, [
        await updateRecipeInstruction({ creator, recipe, components: second }),
      ]),
    );
  };
  const targetsOf = (address: Address) => {
    const state = readVault(svm, address);
    return state.positions
      .slice(0, state.count)
      .map((p) => ({ mint: p.mint, weightBps: p.targetBps }));
  };

  describe('created to follow a shared portfolio', () => {
    it('takes the weights of the version in effect and records what it follows', async () => {
      const meta = expectOk(await follow(1));
      const state = readVault(svm, vault);
      expect(state.recipe).toBe(recipe);
      expect(state.acceptedVersion).toBe(1);
      expect(state.autoFollow).toBe(true);
      expect(state.count).toBe(3);
      expect(targetsOf(vault)).toEqual(first);
      for (const unused of state.positions.slice(3))
        expect(unused).toEqual({
          mint: SYSTEM_PROGRAM,
          targetBps: 0,
          tracked: 0n,
          lastKeeperTs: 0n,
        });

      // The fields other code filters on: recipe at byte 40, the accepted version at 72.
      const account = svm.getAccount(vault);
      if (!account.exists) throw new Error('vault missing');
      expect([...account.data.slice(40, 72)]).toEqual([...getAddressEncoder().encode(recipe)]);
      expect(new DataView(account.data.buffer, account.data.byteOffset).getUint32(72, true)).toBe(
        1,
      );

      // Followed { vault, recipe, version }, then VaultCreated.
      const [followed] = events(meta, 'Followed');
      if (!followed) throw new Error('no Followed event');
      expect(getAddressDecoder().decode(followed.slice(0, 32))).toBe(vault);
      expect(getAddressDecoder().decode(followed.slice(32, 64))).toBe(recipe);
      expect(new DataView(followed.buffer, followed.byteOffset).getUint32(64, true)).toBe(1);
      expect(events(meta, 'VaultCreated')).toHaveLength(1);
    });

    it('takes no targets of its own', async () => {
      expectError(
        await follow(1, { targets: [{ mint: a, targetBps: 10_000 }] }),
        ERR.InvalidTargets,
      );
    });

    it('refuses any version but the one in effect', async () => {
      for (const version of [0, 2, 7]) expectError(await follow(version), ERR.VersionMismatch);
      expect(svm.getAccount(vault).exists).toBe(false);
    });

    // Hostile case A18.
    it('a create signed against version N fails once N+1 is in effect (A18)', async () => {
      await publishSecond();
      const effectiveAt = START + DELAY + DELAY;

      // While the second version waits, the first is still the one in effect.
      setClock(svm, effectiveAt - 1n);
      expectError(await follow(2), ERR.VersionMismatch);

      // The person reviewed version 1 and signed. The transaction lands a second later, when
      // version 2 took effect with no transaction at all.
      const signedAgainstOne = await createVaultInstruction({
        owner,
        basketId: PLAN,
        recipe,
        expectedVersion: 1,
      });
      setClock(svm, effectiveAt);
      expectError(await send(svm, owner, [signedAgainstOne]), ERR.VersionMismatch);
      expect(svm.getAccount(vault).exists).toBe(false);

      expectOk(await follow(2));
      expect(readVault(svm, vault).acceptedVersion).toBe(2);
      expect(targetsOf(vault)).toEqual(second);
    });

    it('a cancelled version never takes effect', async () => {
      await publishSecond();
      expectOk(
        await send(svm, guardian, [await cancelPendingInstruction({ signer: guardian, recipe })]),
      );
      setClock(svm, START + DELAY + DELAY + 1n);
      expectError(await follow(2), ERR.VersionMismatch);
      expectOk(await follow(1));
      expect(targetsOf(vault)).toEqual(first);
    });

    it('takes only a shared portfolio where the portfolio goes', async () => {
      const others = await vaultAddress(stranger.address, 1n);
      expectOk(
        await send(svm, stranger, [
          await createVaultInstruction({ owner: stranger, basketId: 1n }),
        ]),
      );
      const create = async (address: Address) =>
        send(svm, owner, [
          await createVaultInstruction({
            owner,
            basketId: PLAN,
            recipe: address,
            expectedVersion: 1,
          }),
        ]);
      expectError(await create(others), ANCHOR.AccountDiscriminatorMismatch);
      expectError(await create(await configAddress()), ANCHOR.AccountDiscriminatorMismatch);
      expectError(await create(a), ANCHOR.AccountOwnedByWrongProgram);
      expect(svm.getAccount(vault).exists).toBe(false);
    });
  });

  describe('set_targets', () => {
    const own = (): Target[] => [
      { mint: b, targetBps: 5_000 },
      { mint: d, targetBps: 2_000 },
    ];
    const setTargets = async (targets: Target[], who: KeyPairSigner = owner) =>
      send(svm, who, [await setTargetsInstruction({ owner: who, vault, targets })]);

    it("stops following: the weights are the owner's from here on", async () => {
      expectOk(await follow(1));
      const meta = expectOk(await setTargets(own()));

      const state = readVault(svm, vault);
      expect(state.recipe).toBe(SYSTEM_PROGRAM);
      expect(state.acceptedVersion).toBe(0);
      expect(state.autoFollow).toBe(false);
      expect(state.count).toBe(2);
      expect(targetsOf(vault)).toEqual([
        { mint: b, weightBps: 5_000 },
        { mint: d, weightBps: 2_000 },
      ]);
      // The third slot was in use and is empty again.
      expect(state.positions[2]).toEqual({
        mint: SYSTEM_PROGRAM,
        targetBps: 0,
        tracked: 0n,
        lastKeeperTs: 0n,
      });

      // Unfollowed { vault, recipe }, then TargetsSet { vault, count }.
      const [unfollowed] = events(meta, 'Unfollowed');
      if (!unfollowed) throw new Error('no Unfollowed event');
      expect(getAddressDecoder().decode(unfollowed.slice(0, 32))).toBe(vault);
      expect(getAddressDecoder().decode(unfollowed.slice(32, 64))).toBe(recipe);
      const [set] = events(meta, 'TargetsSet');
      expect(set?.[32]).toBe(2);
    });

    it('on a vault that follows nothing: new targets, and no Unfollowed', async () => {
      expectOk(
        await send(svm, owner, [
          await createVaultInstruction({
            owner,
            basketId: PLAN,
            targets: [{ mint: a, targetBps: 10_000 }],
            autoFollow: true,
          }),
        ]),
      );
      const meta = expectOk(await setTargets(own()));
      expect(events(meta, 'Unfollowed')).toHaveLength(0);
      expect(events(meta, 'TargetsSet')).toHaveLength(1);
      expect(targetsOf(vault)).toEqual([
        { mint: b, weightBps: 5_000 },
        { mint: d, weightBps: 2_000 },
      ]);
      // Setting targets by hand also switches auto-follow off.
      expect(readVault(svm, vault).autoFollow).toBe(false);
    });

    it('a mint that stays keeps what the vault recorded for it', async () => {
      expectOk(await follow(1));
      // Mint b arrives from outside and some leaves by a withdrawal: the vault records the rest.
      const mintB = mints[1] as TestMint;
      await mintTo(svm, admin, mintB, vault, 500n);
      await createAta(svm, owner, owner.address, mintB);
      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: mintB, amount: 100n }),
        ]),
      );
      expect(trackedFor(svm, vault, b)).toBe(400n);

      expectOk(await setTargets(own()));
      expect(trackedFor(svm, vault, b)).toBe(400n);
      expect(trackedFor(svm, vault, d)).toBe(0n);
      expect(trackedFor(svm, vault, a)).toBeNull();
    });

    describe('holds the rules of create', () => {
      beforeEach(async () => {
        expectOk(await follow(1));
      });

      it('refuses more targets than the vault has room for', async () => {
        const targets = await Promise.all(
          Array.from({ length: MAX_POSITIONS + 1 }, async () => ({
            mint: (await generateKeyPairSigner()).address,
            targetBps: 100,
          })),
        );
        expectError(await setTargets(targets), ERR.InvalidTargets);
      });

      it.each([
        [
          'the same mint twice',
          () => [
            { mint: a, targetBps: 100 },
            { mint: a, targetBps: 100 },
          ],
        ],
        ['the zero address', () => [{ mint: SYSTEM_PROGRAM, targetBps: 100 }]],
        [
          'more than the whole',
          () => [
            { mint: a, targetBps: 6_000 },
            { mint: b, targetBps: 4_001 },
          ],
        ],
      ])('refuses %s', async (_, targets) => {
        expectError(await setTargets(targets()), ERR.InvalidTargets);
        expect(targetsOf(vault)).toEqual(first);
      });

      it('refuses a mint that is not on the platform list', async () => {
        const unlisted = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
        expectError(
          await setTargets([{ mint: unlisted.address, targetBps: 10_000 }]),
          ERR.MintNotAccepted,
        );
        expect(targetsOf(vault)).toEqual(first);
      });

      it('refuses the cash mint', async () => {
        expectError(
          await setTargets([{ mint: cash.address, targetBps: 10_000 }]),
          ERR.MintNotAccepted,
        );
        expect(readVault(svm, vault).recipe).toBe(recipe);
      });

      it('accepts none at all, and a zero weight', async () => {
        expectOk(await setTargets([{ mint: a, targetBps: 0 }]));
        expect(targetsOf(vault)).toEqual([{ mint: a, weightBps: 0 }]);
        expectOk(await setTargets([]));
        expect(readVault(svm, vault).count).toBe(0);
      });
    });

    it('is the owner alone, and the owner must sign', async () => {
      expectOk(await follow(1));
      expectError(await setTargets(own(), stranger), ANCHOR.ConstraintHasOne);
      const instruction = await setTargetsInstruction({ owner, vault, targets: own() });
      const unsigned = {
        ...instruction,
        accounts: [readonly(owner.address), ...(instruction.accounts ?? []).slice(1)],
      };
      expectError(await send(svm, stranger, [unsigned]), ANCHOR.AccountNotSigner);
      expect(targetsOf(vault)).toEqual(first);
    });

    it('reads the cash mint and the list from the real Config and the real asset list only', async () => {
      expectOk(await follow(1));
      const forged = await forgeConfig(svm, { cashMint: a });
      expectError(
        await send(svm, owner, [
          await setTargetsInstruction({
            owner,
            vault,
            targets: [{ mint: cash.address, targetBps: 10_000 }],
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
        await send(svm, owner, [
          await setTargetsInstruction({ owner, vault, targets: own(), assets: copy }),
        ]),
        ANCHOR.ConstraintSeeds,
      );
      expect(targetsOf(vault)).toEqual(first);
    });

    it("works while the keeper is paused: a pause never stands in the owner's way", async () => {
      expectOk(await send(svm, guardian, [await pauseKeeperInstruction(guardian)]));
      expectOk(await follow(1));
      expectOk(await setTargets(own()));
      expect(readVault(svm, vault).count).toBe(2);
    });
  });
});
