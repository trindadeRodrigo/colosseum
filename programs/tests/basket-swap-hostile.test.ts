import {
  type AccountMeta,
  AccountRole,
  type Address,
  generateKeyPairSigner,
  type Instruction,
  isSome,
  type KeyPairSigner,
  lamports,
  some,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  AuthorityType,
  ExtensionType,
  getApproveInstruction,
  getCloseAccountInstruction,
  getInitializeAccount3Instruction,
  getReallocateInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptAdminInstruction,
  ERR,
  launchInstruction,
  ownerSwapInstruction,
  pauseKeeperInstruction,
  setRouterInstruction,
  setTargetsInstruction,
  trackedFor,
} from './src/basket';
import {
  BASKET_PROGRAM,
  discriminator,
  expectError,
  expectFailure,
  expectOk,
  programSigner,
  type SendResult,
  send,
} from './src/env';
import { loadPuppet, type Puppet, puppetIndex, puppetInstruction, puppetSaw } from './src/puppet';
import { CASH, createSwapWorld, type SwapWorld, tokenAccountFor } from './src/swap';
import {
  balance,
  createLooseTokenAccount,
  mintTo,
  mintToAccount,
  type TestMint,
  tokenAccount,
} from './src/tokens';

const SPEND = 10_000000n;
const PAY = 2_000000n;
const EVERYTHING = 18_446_744_073_709_551_615n;

// The router has turned on the vault. Config names the puppet (programs/puppet-router), which
// runs whatever calls a test scripts with every privilege the vault program handed it: the
// vault's signature and the account list. Each test is one thing such a router could try, and
// in each the trade itself is otherwise honest, so only that one thing is wrong.
describe('owner_swap through a hostile router', () => {
  let w: SwapWorld;
  let puppet: Puppet;
  let attacker: KeyPairSigner;
  let puppetCash: Address;
  let puppetStock: Address;
  let attackerCash: Address;
  let attackerStock: Address;

  beforeEach(async () => {
    w = await createSwapWorld();
    puppet = await loadPuppet(w.svm);
    attacker = w.stranger;
    expectOk(await send(w.svm, w.admin, [await setRouterInstruction(w.admin, puppet.program)]));
    puppetCash = await tokenAccountFor(w, puppet.authority, w.cash);
    puppetStock = await mintTo(w.svm, w.admin, w.stock, puppet.authority, 1_000_00000000n);
    attackerCash = await tokenAccountFor(w, attacker.address, w.cash);
    attackerStock = await tokenAccountFor(w, attacker.address, w.stock);
  });

  const move = (
    mint: TestMint,
    source: Address,
    destination: Address,
    authority: Address,
    amount: bigint,
  ): Instruction =>
    getTransferCheckedInstruction(
      {
        source,
        mint: mint.address,
        destination,
        authority: programSigner(authority),
        amount,
        decimals: mint.decimals,
      },
      { programAddress: mint.program },
    );
  /** The trade an honest router would make: cash out of the vault, stock into it. */
  const take = (amount = SPEND) => move(w.cash, w.vaultCash, puppetCash, w.vault, amount);
  const pay = (amount = PAY) => move(w.stock, puppetStock, w.vaultStock, puppet.authority, amount);

  /** An owner swap of cash for stock whose router runs `calls`. */
  async function swap(
    calls: Instruction[],
    options: {
      maxIn?: bigint;
      minOut?: bigint;
      selector?: Uint8Array;
      extra?: AccountMeta[];
    } = {},
  ): Promise<SendResult> {
    const route = puppetInstruction(puppet, calls, options);
    return send(w.svm, w.owner, [
      await ownerSwapInstruction({
        owner: w.owner,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        maxIn: options.maxIn ?? SPEND,
        minOut: options.minOut ?? PAY,
        router: puppet.program,
        data: new Uint8Array(route.data ?? []),
        routerAccounts: [...(route.accounts ?? [])],
      }),
    ]);
  }

  const held = () => ({
    cash: balance(w.svm, w.vaultCash),
    stock: balance(w.svm, w.vaultStock),
  });
  const untouched = { cash: CASH, stock: 0n };
  const clean = (account: Address) => {
    const state = tokenAccount(w.svm, account);
    return {
      owner: state.owner,
      delegate: isSome(state.delegate),
      closeAuthority: isSome(state.closeAuthority),
    };
  };
  const expectVaultUntouched = () => {
    expect(held()).toEqual(untouched);
    for (const account of [w.vaultCash, w.vaultStock])
      expect(clean(account)).toEqual({ owner: w.vault, delegate: false, closeAuthority: false });
    expect(balance(w.svm, attackerCash)).toBe(0n);
    expect(balance(w.svm, attackerStock)).toBe(0n);
  };

  it('an honest trade through it works: what follows fails for the one thing each adds', async () => {
    expectOk(await swap([take(), pay()]));
    expect(held()).toEqual({ cash: CASH - SPEND, stock: PAY });
    expect(trackedFor(w.svm, w.vault, w.stock.address)).toBe(PAY);
  });

  it.each(['route', 'shared_accounts_route', 'route_v2', 'shared_accounts_route_v2'])(
    'takes the router instruction %s',
    async (name) => {
      expectOk(await swap([take(), pay()], { selector: discriminator(name) }));
      expect(held()).toEqual({ cash: CASH - SPEND, stock: PAY });
    },
  );

  describe('the balances', () => {
    it('cannot take more than max_in', async () => {
      expectError(await swap([take(SPEND + 1n), pay()]), ERR.SpentTooMuch);
      expectVaultUntouched();
      // In two bites, and through the attacker's own account: it is the vault's count that holds.
      expectError(
        await swap([take(), move(w.cash, w.vaultCash, attackerCash, w.vault, 1n), pay()]),
        ERR.SpentTooMuch,
      );
      expectVaultUntouched();
    });

    it('cannot pay less than min_out', async () => {
      expectError(await swap([take(), pay(PAY - 1n)]), ERR.ReceivedTooLittle);
      expectError(await swap([take()]), ERR.ReceivedTooLittle);
      expectVaultUntouched();
    });

    it('cannot take from the account it should pay into, even when min_out is zero', async () => {
      await mintTo(w.svm, w.admin, w.stock, w.vault, 500n);
      const steal = move(w.stock, w.vaultStock, attackerStock, w.vault, 500n);
      expectError(await swap([steal], { maxIn: 0n, minOut: 0n }), ERR.ReceivedTooLittle);
      expect(balance(w.svm, w.vaultStock)).toBe(500n);
      expect(balance(w.svm, attackerStock)).toBe(0n);
    });
  });

  describe("the vault's two token accounts after the call", () => {
    it('cannot leave a delegate on either (A11)', async () => {
      for (const [mint, account] of [
        [w.cash, w.vaultCash],
        [w.stock, w.vaultStock],
      ] as const) {
        const approve = getApproveInstruction(
          {
            source: account,
            delegate: attacker.address,
            owner: programSigner(w.vault),
            amount: EVERYTHING,
          },
          { programAddress: mint.program },
        );
        expectError(await swap([take(), pay(), approve]), ERR.AccountTampered);
        expectVaultUntouched();
      }
    });

    it('cannot leave a close authority on either (A11)', async () => {
      for (const [mint, account] of [
        [w.cash, w.vaultCash],
        [w.stock, w.vaultStock],
      ] as const) {
        const setCloser = getSetAuthorityInstruction(
          {
            owned: account,
            owner: programSigner(w.vault),
            authorityType: AuthorityType.CloseAccount,
            newAuthority: some(attacker.address),
          },
          { programAddress: mint.program },
        );
        expectError(await swap([take(), pay(), setCloser]), ERR.AccountTampered);
        expectVaultUntouched();
      }
    });

    it('cannot hand the account it spends from to someone else', async () => {
      // The classic token program lets an owner give an associated token account away.
      const giveAway = getSetAuthorityInstruction(
        {
          owned: w.vaultCash,
          owner: programSigner(w.vault),
          authorityType: AuthorityType.AccountOwner,
          newAuthority: some(attacker.address),
        },
        { programAddress: w.cash.program },
      );
      expectError(await swap([take(), pay(), giveAway]), ERR.AccountTampered);
      expectVaultUntouched();
    });

    it('cannot close the account it emptied and keep its rent', async () => {
      const close = getCloseAccountInstruction(
        { account: w.vaultCash, destination: attacker.address, owner: programSigner(w.vault) },
        { programAddress: w.cash.program },
      );
      const before = w.svm.getBalance(attacker.address);
      expectError(await swap([take(CASH), pay(), close], { maxIn: CASH }), ERR.AccountTampered);
      expectVaultUntouched();
      expect(w.svm.getBalance(attacker.address)).toBe(before);
    });

    it('cannot change the size of either, which is how an account gains a setting', async () => {
      // Token-2022: with the owner's signature an account can be given room for, say, a rule
      // that every transfer into it must carry a memo. The vault has no way to switch that off.
      const grow = getReallocateInstruction({
        token: w.vaultStock,
        payer: programSigner(puppet.authority),
        owner: programSigner(w.vault),
        newExtensionTypes: [ExtensionType.MemoTransfer],
      });
      const account = w.svm.getAccount(w.vaultStock);
      const size = account.exists ? account.data.length : 0;
      expectError(await swap([take(), pay(), grow]), ERR.AccountTampered);
      expectVaultUntouched();
      const after = w.svm.getAccount(w.vaultStock);
      expect(after.exists && after.data.length).toBe(size);
    });
  });

  describe('any other token account of the vault', () => {
    let loose: Address; // a second token account the vault owns, holding 700 of a listed token

    beforeEach(async () => {
      loose = await createLooseTokenAccount(w.svm, w.admin, w.other, w.vault);
      await mintToAccount(w.svm, w.admin, w.other, loose, 700n);
    });

    it('cannot be drained', async () => {
      const theirs = await tokenAccountFor(w, attacker.address, w.other);
      const drain = move(w.other, loose, theirs, w.vault, 700n);
      expectError(await swap([take(), pay(), drain]), ERR.AccountTampered);
      expectVaultUntouched();
      expect(balance(w.svm, loose)).toBe(700n);
      expect(balance(w.svm, theirs)).toBe(0n);
    });

    it('cannot be given away, tokens and all', async () => {
      const giveAway = getSetAuthorityInstruction(
        {
          owned: loose,
          owner: programSigner(w.vault),
          authorityType: AuthorityType.AccountOwner,
          newAuthority: some(attacker.address),
        },
        { programAddress: w.other.program },
      );
      expectError(await swap([take(), pay(), giveAway]), ERR.AccountTampered);
      expectVaultUntouched();
      expect(tokenAccount(w.svm, loose).owner).toBe(w.vault);
    });

    it('cannot be lent out', async () => {
      const approve = getApproveInstruction(
        { source: loose, delegate: attacker.address, owner: programSigner(w.vault), amount: 700n },
        { programAddress: w.other.program },
      );
      expectError(await swap([take(), pay(), approve]), ERR.AccountTampered);
      expect(clean(loose)).toEqual({ owner: w.vault, delegate: false, closeAuthority: false });
    });

    it('cannot be made during the call and left with a delegate on it', async () => {
      // Space the attacker prepared, which becomes a token account of the vault only inside the
      // router's call: before it, nothing marks it as the vault's.
      const blank = await generateKeyPairSigner();
      expectOk(
        await send(w.svm, attacker, [
          getCreateAccountInstruction({
            payer: attacker,
            newAccount: blank,
            lamports: w.svm.minimumBalanceForRentExemption(165n),
            space: 165n,
            programAddress: w.other.program,
          }),
        ]),
      );
      const make = getInitializeAccount3Instruction(
        { account: blank.address, mint: w.other.address, owner: w.vault },
        { programAddress: w.other.program },
      );
      const approve = getApproveInstruction(
        {
          source: blank.address,
          delegate: attacker.address,
          owner: programSigner(w.vault),
          amount: EVERYTHING,
        },
        { programAddress: w.other.program },
      );
      expectError(await swap([take(), pay(), make, approve]), ERR.AccountTampered);
      expectVaultUntouched();
      expect(
        w.svm.getAccount(blank.address).exists && tokenAccount(w.svm, blank.address).state,
      ).toBe(0);
    });
  });

  describe('the signatures it is handed', () => {
    it("gets the vault's signature and nobody else's: not the owner's, who signed the transaction", async () => {
      // The owner's wallet is in the router's account list, writable, as the fee payer always is.
      const rob = getTransferSolInstruction({
        source: programSigner(w.owner.address),
        destination: attacker.address,
        amount: lamports(1_000_000_000n),
      });
      const before = w.svm.getBalance(attacker.address);
      expectFailure(await swap([take(), pay(), rob]), 'PrivilegeEscalation');
      expectVaultUntouched();
      expect(w.svm.getBalance(attacker.address)).toBe(before);
    });

    it('sees the vault as a read-only signer, and the owner with no signature', async () => {
      const extra = [
        { address: w.vault, role: AccountRole.WRITABLE },
        { address: w.owner.address, role: AccountRole.WRITABLE },
      ];
      const route = puppetInstruction(puppet, [take(), pay()], { extra });
      const meta = expectOk(await swap([take(), pay()], { extra }));
      expect(puppetSaw(meta.logs(), puppetIndex(route, w.vault))).toEqual({
        signer: true,
        writable: false,
      });
      expect(puppetSaw(meta.logs(), puppetIndex(route, w.owner.address))).toEqual({
        signer: false,
        writable: true,
      });
    });

    it('cannot call back into the vault program', async () => {
      // Whatever it asks for with the vault's signature: the pause, the launch latch, the admin.
      // The chain itself refuses a program that is already running further up the call.
      const calls = [
        await pauseKeeperInstruction(programSigner(w.vault)),
        await launchInstruction(programSigner(w.vault)),
        await acceptAdminInstruction(programSigner(w.vault)),
      ];
      for (const call of calls) {
        expect(call.programAddress).toBe(BASKET_PROGRAM);
        expectFailure(await swap([take(), pay(), call]), 'ReentrancyNotAllowed');
        expectVaultUntouched();
      }
    });

    it('cannot write to the vault account: an instruction that needs it writable does not even start', async () => {
      const calls = [
        await setTargetsInstruction({ owner: programSigner(w.vault), vault: w.vault, targets: [] }),
        await ownerSwapInstruction({
          owner: programSigner(w.vault),
          vault: w.vault,
          inputMint: w.cash,
          outputMint: w.stock,
          maxIn: CASH,
          minOut: 0n,
          router: puppet.program,
          data: discriminator('route_v2'),
          routerAccounts: [],
        }),
      ];
      for (const call of calls) {
        expectFailure(await swap([take(), pay(), call]), 'PrivilegeEscalation');
        expectVaultUntouched();
      }
    });
  });
});
