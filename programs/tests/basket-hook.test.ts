import type { Address, KeyPairSigner } from '@solana/kit';
import { generateKeyPairSigner, lamports } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createVaultInstruction,
  depositInstruction,
  initPlatform,
  setCashMintInstruction,
  trackedFor,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import {
  createWorld,
  expectFailure,
  expectOk,
  fundedSigner,
  loadHook,
  readonly,
  SYSTEM_PROGRAM,
  send,
  writable,
  writableSigner,
} from './src/env';
import { hookExtras, hookSaw, setHook, setHookAccounts } from './src/hook';
import {
  ata,
  balance,
  createAta,
  createAtaInstruction,
  createMint,
  mintTo,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';

// Hostile case A9b. The stock token's mint has a transfer-hook authority and no hook
// program. Its issuer can set one at any time, after the vault already holds the token.
// The hook here (programs/test-hook) is hostile: it uses any signature it is handed.
describe('a transfer hook set after the vault holds the token (A9b)', () => {
  let svm: LiteSVM;
  let deployer: KeyPairSigner;
  let owner: KeyPairSigner;
  let thief: Address;
  let hook: Address;
  let cash: TestMint;
  let stock: TestMint;
  let vault: Address;
  let vaultStock: Address;
  let ownerStock: Address;

  const CASH = 5_000000n;
  const STOCK = 3_00000000n;
  const THIEF_STARTS_WITH = 1_000_000_000n;

  beforeEach(async () => {
    ({ svm, deployer } = await createWorld());
    owner = await fundedSigner(svm);
    thief = (await generateKeyPairSigner()).address;
    svm.airdrop(thief, lamports(THIEF_STARTS_WITH));
    hook = await loadHook(svm);

    cash = await createMint(svm, owner, { program: TOKEN_PROGRAM, decimals: 6 });
    stock = await createMint(svm, owner, { program: TOKEN_2022_PROGRAM, decimals: 8, stock: true });
    await initPlatform(svm, deployer, { cashMint: cash.address }, [stock.address]);
    vault = await vaultAddress(owner.address, 1n);
    await mintTo(svm, owner, cash, owner.address, CASH);
    expectOk(
      await send(svm, owner, [
        await createVaultInstruction({
          owner,
          basketId: 1n,
          targets: [{ mint: stock.address, targetBps: 10_000 }],
        }),
        await createAtaInstruction(owner, vault, cash),
        await depositInstruction({ owner, vault, mint: cash, amount: CASH }),
      ]),
    );
    vaultStock = await mintTo(svm, owner, stock, vault, STOCK);
    ownerStock = await createAta(svm, owner, owner.address, stock);

    // Only now does the issuer point the mint at the hook program.
    await setHook(svm, owner, stock, hook);
  });

  const stolen = () => (svm.getBalance(thief) ?? 0n) - THIEF_STARTS_WITH;

  it('that mint withdraws only with the hook accounts; the other tokens are not affected', async () => {
    await setHookAccounts(svm, hook, stock.address, []);

    const without = await send(svm, owner, [
      await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK }),
    ]);
    expectFailure(without, 'MissingAccount'); // the hook's accounts were not passed
    expect(balance(svm, vaultStock)).toBe(STOCK);

    expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint: cash, amount: CASH }),
      ]),
    );
    expect(balance(svm, await ata(owner.address, cash))).toBe(CASH);

    const extraAccounts = await hookExtras(hook, stock.address);
    expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK, extraAccounts }),
      ]),
    );
    expect(balance(svm, ownerStock)).toBe(STOCK);
    expect(trackedFor(svm, vault, stock.address)).toBe(0n);
  });

  it('a hook that asks for the vault as a writable signer is handed neither', async () => {
    await setHookAccounts(svm, hook, stock.address, [
      { address: vault, signer: true, writable: true },
      { address: thief, signer: false, writable: true },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ]);
    const extraAccounts = await hookExtras(hook, stock.address, [
      writable(vault),
      writable(thief),
      readonly(SYSTEM_PROGRAM),
    ]);
    const meta = expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK, extraAccounts }),
      ]),
    );
    // Account 5 of the hook's call is the vault. It signed the transfer, and the hook
    // still sees it as a plain read-only account.
    expect(hookSaw(meta.logs(), 5)).toEqual({ signer: false, writable: false });
    expect(balance(svm, ownerStock)).toBe(STOCK);
    expect(stolen()).toBe(0n);
  });

  it("a hook that asks for the owner's wallet as a signer gets no signature from a withdrawal", async () => {
    await setHookAccounts(svm, hook, stock.address, [
      { address: owner.address, signer: true, writable: true },
      { address: thief, signer: false, writable: true },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ]);
    // The owner's wallet is passed exactly as the hook wants it: writable, and signing.
    const extraAccounts = await hookExtras(hook, stock.address, [
      writableSigner(owner),
      writable(thief),
      readonly(SYSTEM_PROGRAM),
    ]);
    const before = svm.getBalance(owner.address) ?? 0n;
    const meta = expectOk(
      await send(svm, owner, [
        await withdrawInstruction({ owner, vault, mint: stock, amount: STOCK, extraAccounts }),
      ]),
    );
    // Account 5 of the hook's call is the owner's wallet, which signed the transaction.
    // The hook sees it without the signature, and takes nothing. Writable alone lets a
    // program add lamports to an account, never take them.
    expect(hookSaw(meta.logs(), 5)).toEqual({ signer: false, writable: true });
    expect(stolen()).toBe(0n);
    expect(before - (svm.getBalance(owner.address) ?? 0n)).toBe(5_000n); // the fee
    expect(balance(svm, ownerStock)).toBe(STOCK);
  });

  it('a cash mint that gains a hook: a deposit needs the hook accounts, and gives it no signature', async () => {
    // A dollar token on Token-2022 with a hook authority and no program, as PYUSD has.
    const cash2 = await createMint(svm, owner, {
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      stock: true,
    });
    expectOk(await send(svm, deployer, [await setCashMintInstruction(deployer, cash2.address)]));
    await mintTo(svm, owner, cash2, owner.address, CASH);
    expectOk(await send(svm, owner, [await createAtaInstruction(owner, vault, cash2)]));
    await setHook(svm, owner, cash2, hook);
    await setHookAccounts(svm, hook, cash2.address, [
      { address: owner.address, signer: true, writable: true },
      { address: thief, signer: false, writable: true },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ]);

    const deposit = { owner, vault, mint: cash2, amount: CASH };
    expectFailure(await send(svm, owner, [await depositInstruction(deposit)]), 'MissingAccount');

    const extraAccounts = await hookExtras(hook, cash2.address, [
      writableSigner(owner),
      writable(thief),
      readonly(SYSTEM_PROGRAM),
    ]);
    const meta = expectOk(
      await send(svm, owner, [await depositInstruction({ ...deposit, extraAccounts })]),
    );
    // Here the owner's signature is in the transfer itself (the owner moves their own
    // tokens), and the hook still sees the wallet without it.
    expect(hookSaw(meta.logs(), 5)).toEqual({ signer: false, writable: false });
    expect(balance(svm, await ata(vault, cash2))).toBe(CASH);
    expect(stolen()).toBe(0n);
  });
});
