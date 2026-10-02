import {
  type Address,
  generateKeyPairSigner,
  getAddressEncoder,
  isSome,
  type KeyPairSigner,
} from '@solana/kit';
import {
  decodeMint,
  getPauseInstruction,
  getResumeInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  configAddress,
  createVaultInstruction,
  depositInstruction,
  ERR,
  MAX_POSITIONS,
  readVault,
  type Target,
  trackedFor,
  VAULT_SIZE,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import {
  ANCHOR,
  BASKET_PROGRAM,
  createWorld,
  expectError,
  expectOk,
  failed,
  fundedSigner,
  readonly,
  SYSTEM_PROGRAM,
  send,
} from './src/env';
import {
  ata,
  balance,
  createAta,
  createAtaInstruction,
  createLooseTokenAccount,
  createMint,
  mintTo,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccount,
} from './src/tokens';

const PLAN = 7n;

describe('basket vault', () => {
  let svm: LiteSVM;
  let owner: KeyPairSigner;
  let stranger: KeyPairSigner;

  beforeEach(async () => {
    ({ svm } = await createWorld());
    owner = await fundedSigner(svm);
    stranger = await fundedSigner(svm);
  });

  const randomAddress = async () => (await generateKeyPairSigner()).address;

  /** Creates the owner's vault for PLAN and its token accounts for the given mints. */
  async function createVault(targets: Target[], mints: TestMint[]): Promise<Address> {
    const vault = await vaultAddress(owner.address, PLAN);
    expectOk(
      await send(svm, owner, [
        await createVaultInstruction({ owner, basketId: PLAN, targets }),
        ...(await Promise.all(mints.map((mint) => createAtaInstruction(owner, vault, mint)))),
      ]),
    );
    return vault;
  }

  describe('create', () => {
    it('creates the vault at the address derived from the owner and the plan id', async () => {
      const [a, b] = [await randomAddress(), await randomAddress()];
      const vault = await createVault(
        [
          { mint: a, targetBps: 6_000 },
          { mint: b, targetBps: 3_000 },
        ],
        [],
      );

      const account = svm.getAccount(vault);
      expect(account.exists && account.programAddress).toBe(BASKET_PROGRAM);
      expect(account.exists && account.data.length).toBe(VAULT_SIZE);

      const state = readVault(svm, vault);
      expect(state.owner).toBe(owner.address);
      expect(state.basketId).toBe(PLAN);
      expect(state.recipe).toBe(SYSTEM_PROGRAM); // all zeros: follows no shared portfolio
      expect(state.acceptedVersion).toBe(0);
      expect(state.autoFollow).toBe(false);
      expect(state.keeper).toBe(SYSTEM_PROGRAM); // all zeros: Config's default keeper
      expect(state.count).toBe(2);
      expect(state.positions[0]).toEqual({
        mint: a,
        targetBps: 6_000,
        tracked: 0n,
        lastKeeperTs: 0n,
      });
      expect(state.positions[1]).toEqual({
        mint: b,
        targetBps: 3_000,
        tracked: 0n,
        lastKeeperTs: 0n,
      });
      for (const unused of state.positions.slice(2)) {
        expect(unused).toEqual({
          mint: SYSTEM_PROGRAM,
          targetBps: 0,
          tracked: 0n,
          lastKeeperTs: 0n,
        });
      }
      expect(state.lossAccum).toBe(0n);
      expect(state.lossTs).toBe(0n);
      expect(state.reserved.every((byte) => byte === 0)).toBe(true); // byte 0: vault type, standard
    });

    it('keeps the fields other code filters on at their frozen offsets', async () => {
      // DESIGN-VAULT.md section 3.7: owner at 8, recipe at 40, accepted version at 72, auto-follow at 76.
      const vault = await vaultAddress(owner.address, PLAN);
      expectOk(
        await send(svm, owner, [
          await createVaultInstruction({ owner, basketId: PLAN, autoFollow: true }),
        ]),
      );
      const account = svm.getAccount(vault);
      if (!account.exists) throw new Error('vault missing');
      const data = account.data;
      expect([...data.slice(8, 40)]).toEqual([...getAddressEncoder().encode(owner.address)]);
      expect(data.slice(40, 72).every((byte) => byte === 0)).toBe(true);
      expect(data.slice(72, 76).every((byte) => byte === 0)).toBe(true);
      expect(data[76]).toBe(1);
      expect(readVault(svm, vault).autoFollow).toBe(true);
    });

    it('refuses a second vault for the same owner and plan id', async () => {
      const first = await randomAddress();
      const vault = await createVault([{ mint: first, targetBps: 10_000 }], []);

      const again = await send(svm, owner, [
        await createVaultInstruction({
          owner,
          basketId: PLAN,
          targets: [{ mint: await randomAddress(), targetBps: 5_000 }],
        }),
      ]);
      expect(failed(again)).toBe(true);

      const state = readVault(svm, vault);
      expect(state.count).toBe(1);
      expect(state.positions[0]?.mint).toBe(first);
    });

    it('gives each plan id and each owner a vault of its own', async () => {
      expectOk(
        await send(svm, owner, [
          await createVaultInstruction({ owner, basketId: 1n }),
          await createVaultInstruction({ owner, basketId: 2n }),
        ]),
      );
      expectOk(
        await send(svm, stranger, [
          await createVaultInstruction({ owner: stranger, basketId: 1n }),
        ]),
      );

      const mine = await vaultAddress(owner.address, 1n);
      const mineToo = await vaultAddress(owner.address, 2n);
      const theirs = await vaultAddress(stranger.address, 1n);
      expect(new Set([mine, mineToo, theirs]).size).toBe(3);
      expect(readVault(svm, mine).owner).toBe(owner.address);
      expect(readVault(svm, mineToo).basketId).toBe(2n);
      expect(readVault(svm, theirs).owner).toBe(stranger.address);
    });

    it('refuses to create a vault at an address derived for another owner', async () => {
      const result = await send(svm, stranger, [
        await createVaultInstruction({
          owner: stranger,
          basketId: PLAN,
          vault: await vaultAddress(owner.address, PLAN),
        }),
      ]);
      expectError(result, ANCHOR.ConstraintSeeds);
    });

    it('refuses more targets than the vault has room for', async () => {
      const targets = await Promise.all(
        Array.from({ length: MAX_POSITIONS + 1 }, async () => ({
          mint: await randomAddress(),
          targetBps: 100,
        })),
      );
      expectError(
        await send(svm, owner, [await createVaultInstruction({ owner, basketId: PLAN, targets })]),
        ERR.InvalidTargets,
      );
    });

    it('refuses the same mint twice in the targets', async () => {
      const mint = await randomAddress();
      const targets = [
        { mint, targetBps: 4_000 },
        { mint: await randomAddress(), targetBps: 2_000 },
        { mint, targetBps: 4_000 },
      ];
      expectError(
        await send(svm, owner, [await createVaultInstruction({ owner, basketId: PLAN, targets })]),
        ERR.InvalidTargets,
      );
    });

    it('refuses targets that add up to more than the whole', async () => {
      const targets = [
        { mint: await randomAddress(), targetBps: 6_000 },
        { mint: await randomAddress(), targetBps: 4_001 },
      ];
      expectError(
        await send(svm, owner, [await createVaultInstruction({ owner, basketId: PLAN, targets })]),
        ERR.InvalidTargets,
      );
    });

    it('accepts a full vault: sixteen targets that add up to the whole', async () => {
      const targets = await Promise.all(
        Array.from({ length: MAX_POSITIONS }, async () => ({
          mint: await randomAddress(),
          targetBps: 10_000 / MAX_POSITIONS,
        })),
      );
      const vault = await createVault(targets, []);
      const state = readVault(svm, vault);
      expect(state.count).toBe(MAX_POSITIONS);
      expect(state.positions.map((p) => p.mint)).toEqual(targets.map((t) => t.mint));
    });

    it('refuses an expected version when no shared portfolio is passed', async () => {
      // The version a person reviewed must be the one the vault takes. With no shared
      // portfolio there is no version, so anything but zero is a mismatch.
      expectError(
        await send(svm, owner, [
          await createVaultInstruction({ owner, basketId: PLAN, expectedVersion: 1 }),
        ]),
        ERR.VersionMismatch,
      );
    });
  });

  const KINDS = [
    { name: 'a Token mint with 6 decimals', program: TOKEN_PROGRAM, decimals: 6, stock: false },
    { name: 'a Token mint with 8 decimals', program: TOKEN_PROGRAM, decimals: 8, stock: false },
    {
      name: 'a Token-2022 mint with 6 decimals',
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      stock: false,
    },
    {
      name: "a Token-2022 mint with the stock token's extensions and 8 decimals",
      program: TOKEN_2022_PROGRAM,
      decimals: 8,
      stock: true,
    },
  ];

  describe.each(KINDS)('deposit and withdraw: $name', (kind) => {
    it('the owner deposits, then withdraws in kind to their own token account', async () => {
      const unit = 10n ** BigInt(kind.decimals);
      const mint = await createMint(svm, owner, kind);
      const ownerTokens = await mintTo(svm, owner, mint, owner.address, 10n * unit);
      const vault = await createVault([{ mint: mint.address, targetBps: 10_000 }], [mint]);
      const vaultTokens = await ata(vault, mint);

      expectOk(
        await send(svm, owner, [
          await depositInstruction({ owner, vault, mint, amount: 5n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(5n * unit);
      expect(balance(svm, ownerTokens)).toBe(5n * unit);
      expect(trackedFor(svm, vault, mint.address)).toBe(5n * unit);

      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint, amount: 2n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(3n * unit);
      expect(balance(svm, ownerTokens)).toBe(7n * unit);
      expect(trackedFor(svm, vault, mint.address)).toBe(3n * unit);

      // The rest, down to the last raw unit.
      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint, amount: 3n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(0n);
      expect(balance(svm, ownerTokens)).toBe(10n * unit);
      expect(trackedFor(svm, vault, mint.address)).toBe(0n);
    });
  });

  describe('with a funded vault', () => {
    let cash: TestMint; // Token program, 6 decimals; not one of the vault's targets
    let stock: TestMint; // Token-2022 with the stock token's extensions, 8 decimals
    let vault: Address;
    let vaultCash: Address;
    let vaultStock: Address;
    let ownerCash: Address;
    let ownerStock: Address;

    const CASH = 50_000000n;
    const STOCK = 3_00000000n;

    beforeEach(async () => {
      cash = await createMint(svm, owner, { program: TOKEN_PROGRAM, decimals: 6 });
      stock = await createMint(svm, owner, {
        program: TOKEN_2022_PROGRAM,
        decimals: 8,
        stock: true,
      });
      ownerCash = await mintTo(svm, owner, cash, owner.address, CASH);
      ownerStock = await mintTo(svm, owner, stock, owner.address, STOCK);
      vault = await createVault([{ mint: stock.address, targetBps: 10_000 }], [cash, stock]);
      vaultCash = await ata(vault, cash);
      vaultStock = await ata(vault, stock);
      expectOk(
        await send(svm, owner, [
          await depositInstruction({ owner, vault, mint: cash, amount: CASH }),
          await depositInstruction({ owner, vault, mint: stock, amount: STOCK }),
        ]),
      );
    });

    const expectVaultUntouched = () => {
      expect(balance(svm, vaultCash)).toBe(CASH);
      expect(balance(svm, vaultStock)).toBe(STOCK);
    };

    it('holds a mint outside its targets without recording a position for it', async () => {
      expectVaultUntouched();
      expect(trackedFor(svm, vault, cash.address)).toBeNull();
      expect(trackedFor(svm, vault, stock.address)).toBe(STOCK);
      expect(readVault(svm, vault).count).toBe(1);

      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: cash, amount: CASH }),
        ]),
      );
      expect(balance(svm, ownerCash)).toBe(CASH);
      expect(trackedFor(svm, vault, stock.address)).toBe(STOCK);
    });

    // Invariant I1: tokens leave a vault only by the owner's call, and only to a token
    // account the owner owns.
    describe('I1', () => {
      it("another signer cannot withdraw, not even to the owner's own token account", async () => {
        const strangerCash = await createAta(svm, stranger, stranger.address, cash);
        for (const destination of [strangerCash, ownerCash]) {
          const result = await send(svm, stranger, [
            await withdrawInstruction({
              owner: stranger,
              vault,
              mint: cash,
              amount: 1_000000n,
              destination,
            }),
          ]);
          expectError(result, ANCHOR.ConstraintHasOne);
        }
        expectVaultUntouched();
        expect(balance(svm, strangerCash)).toBe(0n);
      });

      it('the owner must sign: naming the owner is not enough', async () => {
        const instruction = await withdrawInstruction({
          owner,
          vault,
          mint: cash,
          amount: 1_000000n,
        });
        const unsigned = {
          ...instruction,
          accounts: [readonly(owner.address), ...(instruction.accounts ?? []).slice(1)],
        };
        expectError(await send(svm, stranger, [unsigned]), ANCHOR.AccountNotSigner);
        expectVaultUntouched();
      });

      it("the owner cannot withdraw to a third party's token account", async () => {
        const strangerCash = await createAta(svm, stranger, stranger.address, cash);
        const strangerStock = await createAta(svm, stranger, stranger.address, stock);
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: cash,
              amount: 1_000000n,
              destination: strangerCash,
            }),
          ]),
          ERR.WrongDestination,
        );
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: stock,
              amount: 1_00000000n,
              destination: strangerStock,
            }),
          ]),
          ERR.WrongDestination,
        );
        expectVaultUntouched();
        expect(balance(svm, strangerCash)).toBe(0n);
        expect(balance(svm, strangerStock)).toBe(0n);
      });

      it('the owner can withdraw to any token account they own, associated or not', async () => {
        const second = await createLooseTokenAccount(svm, owner, cash, owner.address);
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: cash,
              amount: 1_000000n,
              destination: second,
            }),
          ]),
        );
        expect(balance(svm, second)).toBe(1_000000n);
        expect(balance(svm, vaultCash)).toBe(CASH - 1_000000n);
      });

      it("an owner cannot reach another vault's tokens through a vault of their own", async () => {
        const theirVault = await vaultAddress(stranger.address, PLAN);
        const strangerCash = await createAta(svm, stranger, stranger.address, cash);
        expectOk(
          await send(svm, stranger, [
            await createVaultInstruction({ owner: stranger, basketId: PLAN }),
            await createAtaInstruction(stranger, theirVault, cash),
          ]),
        );
        const result = await send(svm, stranger, [
          await withdrawInstruction({
            owner: stranger,
            vault: theirVault,
            mint: cash,
            amount: 1_000000n,
            vaultTokenAccount: vaultCash,
            destination: strangerCash,
          }),
        ]);
        expectError(result, ANCHOR.ConstraintTokenOwner);
        expectVaultUntouched();
      });

      it("withdraws only from the vault's associated token account", async () => {
        // A second token account that the vault owns, with tokens someone sent to it.
        const loose = await createLooseTokenAccount(svm, owner, cash, vault);
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: cash, amount: 2_000000n }),
            getTransferCheckedInstruction(
              {
                source: ownerCash,
                mint: cash.address,
                destination: loose,
                authority: owner,
                amount: 2_000000n,
                decimals: cash.decimals,
              },
              { programAddress: cash.program },
            ),
          ]),
        );
        const result = await send(svm, owner, [
          await withdrawInstruction({
            owner,
            vault,
            mint: cash,
            amount: 2_000000n,
            vaultTokenAccount: loose,
          }),
        ]);
        expectError(result, ANCHOR.ConstraintAssociated);
        expect(balance(svm, loose)).toBe(2_000000n);
      });

      it('nobody moves the vault tokens by calling the token program directly', async () => {
        for (const who of [owner, stranger]) {
          const destination = await createAta(svm, who, who.address, cash);
          const result = await send(svm, who, [
            getTransferCheckedInstruction(
              {
                source: vaultCash,
                mint: cash.address,
                destination,
                authority: who,
                amount: 1_000000n,
                decimals: cash.decimals,
              },
              { programAddress: cash.program },
            ),
          ]);
          expect(failed(result)).toBe(true);
        }
        expectVaultUntouched();
        // The vault's token accounts answer to the vault alone.
        for (const account of [vaultCash, vaultStock]) {
          const state = tokenAccount(svm, account);
          expect(state.owner).toBe(vault);
          expect(isSome(state.delegate)).toBe(false);
          expect(isSome(state.closeAuthority)).toBe(false);
        }
      });

      it('cannot withdraw more than the vault holds', async () => {
        const result = await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: cash, amount: CASH + 1n }),
        ]);
        expect(failed(result)).toBe(true);
        expectVaultUntouched();
      });
    });

    describe('deposit', () => {
      it('another signer cannot deposit into the vault', async () => {
        await mintTo(svm, stranger, cash, stranger.address, 1_000000n);
        const result = await send(svm, stranger, [
          await depositInstruction({ owner: stranger, vault, mint: cash, amount: 1_000000n }),
        ]);
        expectError(result, ANCHOR.ConstraintHasOne);
        expectVaultUntouched();
      });

      it("deposits only into the vault's associated token account", async () => {
        const loose = await createLooseTokenAccount(svm, owner, cash, vault);
        await mintTo(svm, owner, cash, owner.address, 1_000000n);
        const result = await send(svm, owner, [
          await depositInstruction({
            owner,
            vault,
            mint: cash,
            amount: 1_000000n,
            vaultTokenAccount: loose,
          }),
        ]);
        expectError(result, ANCHOR.ConstraintAssociated);
        expect(balance(svm, loose)).toBe(0n);
      });
    });

    // DESIGN-VAULT.md section 5: withdrawal is per token and calls no router, feed or registry.
    describe('the owner path stands alone', () => {
      it('works with no Config account at all', async () => {
        expect(svm.getAccount(await configAddress()).exists).toBe(false);
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK }),
          ]),
        );
        expect(balance(svm, ownerStock)).toBe(STOCK);
      });

      it('passes extra accounts on to the token program, for a transfer hook', async () => {
        const extraAccounts = [readonly(await randomAddress()), readonly(await randomAddress())];
        const meta = expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK, extraAccounts }),
          ]),
        );
        expect(balance(svm, ownerStock)).toBe(STOCK);
        // The one call the program makes is the transfer: source, mint, destination,
        // authority, and then the two extra accounts.
        const calls = meta.innerInstructions()[0] ?? [];
        expect(calls.map((call) => call.instruction().accounts().length)).toEqual([6]);
      });

      it('a mint its issuer has paused blocks only that mint', async () => {
        const pause = getPauseInstruction({ mint: stock.address, authority: stock.issuer });
        expectOk(await send(svm, owner, [pause]));

        const stuck = await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK }),
        ]);
        expect(failed(stuck)).toBe(true);
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: cash, amount: CASH }),
          ]),
        );
        expect(balance(svm, ownerCash)).toBe(CASH);

        const resume = getResumeInstruction({ mint: stock.address, authority: stock.issuer });
        expectOk(await send(svm, owner, [resume]));
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK }),
          ]),
        );
        expect(balance(svm, ownerStock)).toBe(STOCK);
      });

      it('the test stock mint carries the extensions the real one has', () => {
        const account = svm.getAccount(stock.address);
        if (!account.exists) throw new Error('mint missing');
        const mint = decodeMint(account).data;
        const kinds = isSome(mint.extensions) ? mint.extensions.value.map((e) => e.__kind) : [];
        expect(kinds.sort()).toEqual([
          'ConfidentialTransferMint',
          'DefaultAccountState',
          'MetadataPointer',
          'PausableConfig',
          'PermanentDelegate',
          'ScaledUiAmountConfig',
          'TransferHook',
        ]);
        expect(mint.decimals).toBe(8);
      });
    });
  });
});
