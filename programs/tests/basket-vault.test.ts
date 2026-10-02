import {
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getU64Decoder,
  isSome,
  type KeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
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
  forgeConfig,
  initConfig,
  MAX_POSITIONS,
  readVault,
  setCashMintInstruction,
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
  events,
  expectError,
  expectFailure,
  expectOk,
  fundedSigner,
  MOCK_ROUTER_PROGRAM,
  readonly,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  SYSTEM_PROGRAM,
  send,
  writable,
  writableSigner,
} from './src/env';
import {
  ata,
  balance,
  createAta,
  createAtaInstruction,
  createLooseTokenAccount,
  createMint,
  mintTo,
  onePercentFee,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_ERR,
  TOKEN_PROGRAM,
  tokenAccount,
} from './src/tokens';

const PLAN = 7n;

describe('basket vault', () => {
  let svm: LiteSVM;
  let deployer: KeyPairSigner;
  let owner: KeyPairSigner;
  let stranger: KeyPairSigner;

  beforeEach(async () => {
    ({ svm, deployer } = await createWorld());
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
      const vault = await vaultAddress(owner.address, PLAN);
      const targets = [
        { mint: a, targetBps: 6_000 },
        { mint: b, targetBps: 3_000 },
      ];
      const meta = expectOk(
        await send(svm, owner, [await createVaultInstruction({ owner, basketId: PLAN, targets })]),
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
      const empty = { tracked: 0n, lastKeeperTs: 0n };
      expect(state.positions[0]).toEqual({ mint: a, targetBps: 6_000, ...empty });
      expect(state.positions[1]).toEqual({ mint: b, targetBps: 3_000, ...empty });
      for (const unused of state.positions.slice(2)) {
        expect(unused).toEqual({ mint: SYSTEM_PROGRAM, targetBps: 0, ...empty });
      }
      expect(state.lossAccum).toBe(0n);
      expect(state.lossTs).toBe(0n);
      expect(state.reserved.every((byte) => byte === 0)).toBe(true); // byte 0: vault type, standard

      // VaultCreated { vault, owner, basket_id }
      const [created] = events(meta, 'VaultCreated');
      if (!created) throw new Error('no VaultCreated event');
      expect(getAddressDecoder().decode(created.slice(0, 32))).toBe(vault);
      expect(getAddressDecoder().decode(created.slice(32, 64))).toBe(owner.address);
      expect(getU64Decoder().decode(created.slice(64, 72))).toBe(PLAN);
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
      expectError(again, SYSTEM_ACCOUNT_ALREADY_IN_USE);

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

    it('refuses the zero address as a target: it is what an empty slot holds', async () => {
      const targets = [
        { mint: await randomAddress(), targetBps: 5_000 },
        { mint: SYSTEM_PROGRAM, targetBps: 0 },
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

  // Money comes in as the chain's dollar token only (gate DEPOSIT). Which mint that is,
  // Config says; the program handles either token program and any decimals.
  describe.each(KINDS)('$name', (kind) => {
    it('as the cash mint: the owner deposits it, then withdraws it to their own token account', async () => {
      const unit = 10n ** BigInt(kind.decimals);
      const mint = await createMint(svm, owner, kind);
      expectOk(await initConfig(svm, deployer, { cashMint: mint.address }));
      const ownerTokens = await mintTo(svm, owner, mint, owner.address, 10n * unit);
      const vault = await createVault([{ mint: await randomAddress(), targetBps: 10_000 }], [mint]);
      const vaultTokens = await ata(vault, mint);
      const before = readVault(svm, vault);

      expectOk(
        await send(svm, owner, [
          await depositInstruction({ owner, vault, mint, amount: 5n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(5n * unit);
      expect(balance(svm, ownerTokens)).toBe(5n * unit);

      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint, amount: 2n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(3n * unit);
      expect(balance(svm, ownerTokens)).toBe(7n * unit);

      // The rest, down to the last raw unit.
      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint, amount: 3n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(0n);
      expect(balance(svm, ownerTokens)).toBe(10n * unit);

      // Cash is not a position: the vault account records nothing for it. What the vault
      // holds in cash is the balance of its token account, read when it is needed.
      expect(readVault(svm, vault)).toEqual(before);
    });

    it('as any other token: a deposit is refused, and what arrives from outside withdraws to the owner', async () => {
      const unit = 10n ** BigInt(kind.decimals);
      const cash = await createMint(svm, owner, { program: TOKEN_PROGRAM, decimals: 6 });
      expectOk(await initConfig(svm, deployer, { cashMint: cash.address }));
      const mint = await createMint(svm, owner, kind);
      const ownerTokens = await mintTo(svm, owner, mint, owner.address, 4n * unit);
      const vault = await createVault([{ mint: mint.address, targetBps: 10_000 }], [mint]);
      const vaultTokens = await ata(vault, mint);

      expectError(
        await send(svm, owner, [await depositInstruction({ owner, vault, mint, amount: unit })]),
        ERR.NotCashMint,
      );
      expect(balance(svm, vaultTokens)).toBe(0n);
      expect(balance(svm, ownerTokens)).toBe(4n * unit);

      // Nothing can stop a token being sent to the vault's address. It counts for nothing
      // until the vault next looks, and the owner can always take it out.
      await mintTo(svm, owner, mint, vault, 5n * unit);
      expect(trackedFor(svm, vault, mint.address)).toBe(0n);

      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint, amount: 2n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(3n * unit);
      expect(balance(svm, ownerTokens)).toBe(6n * unit);
      expect(trackedFor(svm, vault, mint.address)).toBe(3n * unit);

      expectOk(
        await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint, amount: 3n * unit }),
        ]),
      );
      expect(balance(svm, vaultTokens)).toBe(0n);
      expect(balance(svm, ownerTokens)).toBe(9n * unit);
      expect(trackedFor(svm, vault, mint.address)).toBe(0n);
    });
  });

  it('withdraws with no Config account at all', async () => {
    // DESIGN-VAULT.md section 5: withdrawal calls no router, feed or registry, and reads no config.
    const mint = await createMint(svm, owner, {
      program: TOKEN_2022_PROGRAM,
      decimals: 8,
      stock: true,
    });
    const vault = await createVault([{ mint: mint.address, targetBps: 10_000 }], [mint]);
    await mintTo(svm, owner, mint, vault, 3_00000000n);
    expect(svm.getAccount(await configAddress()).exists).toBe(false);

    const ownerTokens = await createAta(svm, owner, owner.address, mint);
    expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint, amount: 3_00000000n }),
      ]),
    );
    expect(balance(svm, ownerTokens)).toBe(3_00000000n);
  });

  it('a mint with a transfer fee: the balances are what the token program says, not what was asked', async () => {
    const fee = await createMint(svm, owner, {
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      extensions: onePercentFee,
    });
    expectOk(await initConfig(svm, deployer, { cashMint: fee.address }));
    const ownerTokens = await mintTo(svm, owner, fee, owner.address, 1_000_000n);
    // Listed as a target too, so the vault records what it sees on a withdrawal.
    const vault = await createVault([{ mint: fee.address, targetBps: 10_000 }], [fee]);
    const vaultTokens = await ata(vault, fee);

    expectOk(
      await send(svm, owner, [
        await depositInstruction({ owner, vault, mint: fee, amount: 1_000_000n }),
      ]),
    );
    expect(balance(svm, ownerTokens)).toBe(0n);
    expect(balance(svm, vaultTokens)).toBe(990_000n); // 1% stayed with the issuer

    expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint: fee, amount: 400_000n }),
      ]),
    );
    expect(balance(svm, vaultTokens)).toBe(590_000n);
    expect(balance(svm, ownerTokens)).toBe(396_000n);
    expect(trackedFor(svm, vault, fee.address)).toBe(590_000n);
  });

  describe('with a funded vault', () => {
    let cash: TestMint; // Token program, 6 decimals: Config's cash mint
    let stock: TestMint; // Token-2022 with the stock token's extensions, 8 decimals: the one target
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
      expectOk(await initConfig(svm, deployer, { cashMint: cash.address }));
      ownerCash = await mintTo(svm, owner, cash, owner.address, CASH);
      ownerStock = await createAta(svm, owner, owner.address, stock);
      vault = await createVault([{ mint: stock.address, targetBps: 10_000 }], [cash, stock]);
      vaultCash = await ata(vault, cash);
      vaultStock = await ata(vault, stock);
      expectOk(
        await send(svm, owner, [
          await depositInstruction({ owner, vault, mint: cash, amount: CASH }),
        ]),
      );
      // The stock arrives the way a swap will deliver it: into the vault's own token account.
      await mintTo(svm, owner, stock, vault, STOCK);
    });

    const expectVaultUntouched = () => {
      expect(balance(svm, vaultCash)).toBe(CASH);
      expect(balance(svm, vaultStock)).toBe(STOCK);
    };

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

      it("the destination cannot be the vault's own token account", async () => {
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: cash,
              amount: 1_000000n,
              destination: vaultCash,
            }),
          ]),
          ERR.WrongDestination,
        );
        expectVaultUntouched();
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

      it('a blank account the attacker gave to the program does not pass as a vault', async () => {
        const blank = await generateKeyPairSigner();
        const space = BigInt(VAULT_SIZE);
        expectOk(
          await send(svm, stranger, [
            getCreateAccountInstruction({
              payer: stranger,
              newAccount: blank,
              lamports: svm.minimumBalanceForRentExemption(space),
              space,
              programAddress: BASKET_PROGRAM,
            }),
          ]),
        );
        const result = await send(svm, stranger, [
          await withdrawInstruction({
            owner: stranger,
            vault: blank.address,
            mint: cash,
            amount: 1_000000n,
            vaultTokenAccount: vaultCash,
            destination: await createAta(svm, stranger, stranger.address, cash),
          }),
        ]);
        expectError(result, ANCHOR.AccountDiscriminatorMismatch);
        expectVaultUntouched();
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
          expectError(result, TOKEN_ERR.OwnerMismatch);
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
        expectError(result, TOKEN_ERR.InsufficientFunds);
        expectVaultUntouched();
      });

      it('hostile extra accounts move nothing but the amount named', async () => {
        // The vault itself, the owner as a signer, the vault's other token accounts, programs.
        const extraAccounts = [
          writable(vault),
          writableSigner(owner),
          writable(vaultCash),
          readonly(TOKEN_PROGRAM),
          readonly(BASKET_PROGRAM),
        ];
        const lamportsBefore = svm.getBalance(owner.address) ?? 0n;
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: stock, amount: 5n, extraAccounts }),
          ]),
        );
        expect(balance(svm, vaultStock)).toBe(STOCK - 5n);
        expect(balance(svm, ownerStock)).toBe(5n);
        expect(balance(svm, vaultCash)).toBe(CASH);
        expect(lamportsBefore - (svm.getBalance(owner.address) ?? 0n)).toBe(5_000n); // the fee

        // The same with the classic token program.
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: cash,
              amount: 5n,
              extraAccounts: [writable(vault), writable(vaultStock), writableSigner(owner)],
            }),
          ]),
        );
        expect(balance(svm, vaultCash)).toBe(CASH - 5n);
        expect(balance(svm, ownerCash)).toBe(5n);
        expect(balance(svm, vaultStock)).toBe(STOCK - 5n);
      });
    });

    describe('accounts that are not what they are passed as', () => {
      it('refuses a token program that is not the one the mint belongs to', async () => {
        // A Token-2022 mint with the classic program: with the vault's real token account,
        // and with the one derived for the wrong program, which does not exist.
        const stockAsClassic: TestMint = { ...stock, program: TOKEN_PROGRAM };
        const wrongProgram = { owner, vault, mint: stockAsClassic, amount: 1n };
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({
              ...wrongProgram,
              vaultTokenAccount: vaultStock,
              destination: ownerStock,
            }),
          ]),
          ANCHOR.ConstraintMintTokenProgram,
        );
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({ ...wrongProgram, destination: ownerStock }),
          ]),
          ANCHOR.AccountNotInitialized,
        );
        // A classic mint with Token-2022, on withdraw and on deposit.
        const cashAs2022: TestMint = { ...cash, program: TOKEN_2022_PROGRAM };
        const accounts = { vaultTokenAccount: vaultCash, destination: ownerCash };
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: cashAs2022, amount: 1n, ...accounts }),
          ]),
          ANCHOR.ConstraintMintTokenProgram,
        );
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: cash, amount: 9n }),
          ]),
        );
        expectError(
          await send(svm, owner, [
            await depositInstruction({
              owner,
              vault,
              mint: cashAs2022,
              amount: 9n,
              vaultTokenAccount: vaultCash,
              source: ownerCash,
            }),
          ]),
          ANCHOR.ConstraintMintTokenProgram,
        );
        expect(balance(svm, vaultCash)).toBe(CASH - 9n);
        expect(balance(svm, vaultStock)).toBe(STOCK);
      });

      it('refuses a program that is not a token program', async () => {
        const fake: TestMint = { ...cash, program: MOCK_ROUTER_PROGRAM };
        const result = await send(svm, owner, [
          await withdrawInstruction({
            owner,
            vault,
            mint: fake,
            amount: 1n,
            vaultTokenAccount: vaultCash,
            destination: ownerCash,
          }),
        ]);
        expectError(result, ANCHOR.InvalidProgramId);
        expectVaultUntouched();
      });

      it('refuses a destination of another mint', async () => {
        const other = await createMint(svm, owner, { program: TOKEN_PROGRAM, decimals: 6 });
        const destination = await createAta(svm, owner, owner.address, other);
        const result = await send(svm, owner, [
          await withdrawInstruction({ owner, vault, mint: cash, amount: 1n, destination }),
        ]);
        expectError(result, TOKEN_ERR.MintMismatch);
        expectVaultUntouched();
      });

      it('refuses an account that is not a mint where the mint goes', async () => {
        const accounts = { vaultTokenAccount: vaultCash, destination: ownerCash };
        // The vault account itself: not a token program's account at all.
        expectError(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: { ...cash, address: vault },
              amount: 1n,
              ...accounts,
            }),
          ]),
          ANCHOR.AccountOwnedByWrongProgram,
        );
        // A token account: the token program's, but not a mint.
        expectFailure(
          await send(svm, owner, [
            await withdrawInstruction({
              owner,
              vault,
              mint: { ...cash, address: ownerCash },
              amount: 1n,
              ...accounts,
            }),
          ]),
          'InvalidAccountData',
        );
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

      it('takes the cash mint from the real Config only', async () => {
        await mintTo(svm, owner, stock, owner.address, STOCK);
        const stockDeposit = { owner, vault, mint: stock, amount: STOCK };

        // A copy of Config at another address that names the stock as cash.
        const forged = await forgeConfig(svm, { cashMint: stock.address });
        expectError(
          await send(svm, owner, [await depositInstruction({ ...stockDeposit, config: forged })]),
          ANCHOR.ConstraintSeeds,
        );
        // The vault itself, and an account of another program, in Config's place.
        expectError(
          await send(svm, owner, [await depositInstruction({ ...stockDeposit, config: vault })]),
          ANCHOR.AccountDiscriminatorMismatch,
        );
        expectError(
          await send(svm, owner, [
            await depositInstruction({ ...stockDeposit, config: stock.address }),
          ]),
          ANCHOR.AccountOwnedByWrongProgram,
        );
        expectVaultUntouched();
        expect(balance(svm, ownerStock)).toBe(STOCK);
      });

      it('follows the cash mint when the admin changes it', async () => {
        const newCash = await createMint(svm, owner, { program: TOKEN_2022_PROGRAM, decimals: 6 });
        expectOk(
          await send(svm, deployer, [await setCashMintInstruction(deployer, newCash.address)]),
        );
        await mintTo(svm, owner, cash, owner.address, 1_000000n);
        await mintTo(svm, owner, newCash, owner.address, 1_000000n);
        expectOk(await send(svm, owner, [await createAtaInstruction(owner, vault, newCash)]));

        expectError(
          await send(svm, owner, [
            await depositInstruction({ owner, vault, mint: cash, amount: 1_000000n }),
          ]),
          ERR.NotCashMint,
        );
        expectOk(
          await send(svm, owner, [
            await depositInstruction({ owner, vault, mint: newCash, amount: 1_000000n }),
          ]),
        );
        expect(balance(svm, await ata(vault, newCash))).toBe(1_000000n);
        // The old cash is still the owner's to take out.
        expectOk(
          await send(svm, owner, [
            await withdrawInstruction({ owner, vault, mint: cash, amount: CASH }),
          ]),
        );
        expect(balance(svm, ownerCash)).toBe(CASH + 1_000000n);
      });
    });

    describe('the owner path stands alone', () => {
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
        expectError(stuck, TOKEN_ERR.MintPaused);
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
