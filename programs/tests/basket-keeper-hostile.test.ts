import {
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
  getApproveInstruction,
  getInitializeAccount3Instruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adoptVersionInstruction,
  decodeKeeperTrade,
  ERR,
  keeperLegInstruction,
  patchConfig,
  pauseKeeperInstruction,
  setRouterInstruction,
  syncBalancesInstruction,
  trackedFor,
} from './src/basket';
import {
  BASKET_PROGRAM,
  concat,
  discriminator,
  events,
  expectError,
  expectFailure,
  expectOk,
  programSigner,
  type SendResult,
  send,
} from './src/env';
import { createKeeperWorld, type KeeperWorld } from './src/keeper';
import { loadPuppet, type Puppet, puppetIndex, puppetInstruction, puppetSaw } from './src/puppet';
import { CASH, stockFor, tokenAccountFor } from './src/swap';
import {
  balance,
  createLooseTokenAccount,
  mintTo,
  mintToAccount,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccount,
} from './src/tokens';

/** 40 dollars of cash, and the stock that buys at the reference price of 500 dollars. */
const SPEND = 40_000000n;
const PAY = stockFor(SPEND);
const EVERYTHING = 18_446_744_073_709_551_615n;

// The router has turned on the vault, or the keeper's key is in the wrong hands and names its own
// route. Config names the puppet (programs/puppet-router), which runs whatever calls a test scripts
// with what the vault program handed it. The keeper's leg goes through the same checks around the
// router's call as the owner's swap; these are the hostile cases of DESIGN-VAULT.md section 13 on
// the keeper's path.
describe('keeper_leg through a hostile router', () => {
  let w: KeeperWorld;
  let puppet: Puppet;
  let attacker: KeyPairSigner;
  let puppetCash: Address;
  let puppetStock: Address;
  let attackerCash: Address;
  let attackerStock: Address;

  beforeEach(async () => {
    w = await createKeeperWorld();
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

  /** A keeper leg of cash for stock whose router runs `calls`. */
  async function leg(
    calls: Instruction[],
    options: { maxIn?: bigint; extra?: { address: Address; role: AccountRole }[] } = {},
  ): Promise<SendResult> {
    const route = puppetInstruction(puppet, calls, options);
    return send(w.svm, w.keeper, [
      await keeperLegInstruction({
        keeper: w.keeper,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        amountIn: options.maxIn ?? SPEND,
        router: puppet.program,
        data: new Uint8Array(route.data ?? []),
        routerAccounts: [...(route.accounts ?? [])],
        priceAccount: w.prices,
      }),
    ]);
  }

  const clean = (account: Address) => {
    const state = tokenAccount(w.svm, account);
    return {
      owner: state.owner,
      delegate: isSome(state.delegate),
      closeAuthority: isSome(state.closeAuthority),
    };
  };
  const expectVaultUntouched = () => {
    expect([balance(w.svm, w.vaultCash), balance(w.svm, w.vaultStock)]).toEqual([CASH, 0n]);
    for (const account of [w.vaultCash, w.vaultStock])
      expect(clean(account)).toEqual({ owner: w.vault, delegate: false, closeAuthority: false });
    expect(balance(w.svm, attackerCash)).toBe(0n);
    expect(balance(w.svm, attackerStock)).toBe(0n);
  };

  it('an honest trade through it works: what follows fails for the one thing each adds', async () => {
    const meta = expectOk(await leg([take(), pay()]));
    expect([balance(w.svm, w.vaultCash), balance(w.svm, w.vaultStock)]).toEqual([
      CASH - SPEND,
      PAY,
    ]);
    expect(trackedFor(w.svm, w.vault, w.stock.address)).toBe(PAY);
    expect(events(meta, 'KeeperTrade').map(decodeKeeperTrade)[0]).toMatchObject({
      spent: SPEND,
      received: PAY,
      loss: 0n,
    });
  });

  it('takes only a swap: any other instruction of the router is refused', async () => {
    const route = puppetInstruction(puppet, [take(), pay()], {
      selector: discriminator('claim'),
    });
    const result = await send(w.svm, w.keeper, [
      await keeperLegInstruction({
        keeper: w.keeper,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        amountIn: SPEND,
        router: puppet.program,
        data: new Uint8Array(route.data ?? []),
        routerAccounts: [...(route.accounts ?? [])],
        priceAccount: w.prices,
      }),
    ]);
    expectError(result, ERR.RouterNotAllowed);
    expectVaultUntouched();
  });

  it.each([
    ['the token program', TOKEN_PROGRAM],
    ['the Token-2022 program', TOKEN_2022_PROGRAM],
  ])('never calls %s, even if Config named it', async (_, program) => {
    await patchConfig(w.svm, { routerProgram: program });
    const result = await send(w.svm, w.keeper, [
      await keeperLegInstruction({
        keeper: w.keeper,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        amountIn: SPEND,
        router: program,
        data: concat(discriminator('route_v2'), new Uint8Array(16)),
        routerAccounts: [],
        priceAccount: w.prices,
      }),
    ]);
    expectError(result, ERR.RouterNotAllowed);
    expectVaultUntouched();
  });

  it('takes only the router Config names', async () => {
    const other = await loadPuppet(w.svm);
    const route = puppetInstruction(other, [take(), pay()]);
    const result = await send(w.svm, w.keeper, [
      await keeperLegInstruction({
        keeper: w.keeper,
        vault: w.vault,
        inputMint: w.cash,
        outputMint: w.stock,
        amountIn: SPEND,
        router: other.program,
        data: new Uint8Array(route.data ?? []),
        routerAccounts: [...(route.accounts ?? [])],
        priceAccount: w.prices,
      }),
    ]);
    expectError(result, ERR.RouterNotAllowed);
    expectVaultUntouched();
  });

  describe('the balances', () => {
    // A1: the router sends what it bought somewhere else, to the keeper or to anyone.
    it('cannot keep the cash and pay the vault nothing, or pay someone else', async () => {
      expectError(await leg([take()]), ERR.ReceivedTooLittle);
      const elsewhere = move(w.stock, puppetStock, attackerStock, puppet.authority, PAY);
      expectError(await leg([take(), elsewhere]), ERR.ReceivedTooLittle);
      expectVaultUntouched();
    });

    // A2: the least that must come back is worked out from the reference price.
    it('cannot pay less than the reference price allows', async () => {
      const floor = (PAY * 9_925n) / 10_000n;
      expectError(await leg([take(), pay(floor - 1n)]), ERR.ReceivedTooLittle);
      expectVaultUntouched();
      expectOk(await leg([take(), pay(floor)]));
    });

    it('cannot take more than the keeper said', async () => {
      expectError(await leg([take(SPEND + 1n), pay()]), ERR.SpentTooMuch);
      expectError(
        await leg([take(), move(w.cash, w.vaultCash, attackerCash, w.vault, 1n), pay()]),
        ERR.SpentTooMuch,
      );
      expectVaultUntouched();
    });

    it('cannot pass off a route that spends nothing as a trade', async () => {
      // No call at all, and a route that only pays in: the vault spent nothing either time.
      expectError(await leg([]), ERR.NothingTraded);
      expectError(await leg([pay()]), ERR.NothingTraded);
      expectVaultUntouched();
      // Neither used the asset's one trade of the hour.
      expectOk(await leg([take(), pay()]));
    });

    it('cannot take from the account it should pay into', async () => {
      await mintTo(w.svm, w.admin, w.stock, w.vault, 500n);
      const steal = move(w.stock, w.vaultStock, attackerStock, w.vault, 500n);
      expectError(await leg([steal], { maxIn: 0n }), ERR.ReceivedTooLittle);
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
        expectError(await leg([take(), pay(), approve]), ERR.AccountTampered);
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
        expectError(await leg([take(), pay(), setCloser]), ERR.AccountTampered);
        expectVaultUntouched();
      }
    });
  });

  // A10: a second token account the vault owns, which no check on the two it trades would see.
  describe('any other token account of the vault', () => {
    let loose: Address;

    beforeEach(async () => {
      loose = await createLooseTokenAccount(w.svm, w.admin, w.other, w.vault);
      await mintToAccount(w.svm, w.admin, w.other, loose, 700n);
    });

    it('cannot be drained', async () => {
      const theirs = await tokenAccountFor(w, attacker.address, w.other);
      const drain = move(w.other, loose, theirs, w.vault, 700n);
      expectError(await leg([take(), pay(), drain]), ERR.AccountTampered);
      expectVaultUntouched();
      expect(balance(w.svm, loose)).toBe(700n);
    });

    it('cannot be given away, tokens and all', async () => {
      // After the call the account is the attacker's, so only a look before the call sees it.
      const giveAway = getSetAuthorityInstruction(
        {
          owned: loose,
          owner: programSigner(w.vault),
          authorityType: AuthorityType.AccountOwner,
          newAuthority: some(attacker.address),
        },
        { programAddress: w.other.program },
      );
      expectError(await leg([take(), pay(), giveAway]), ERR.AccountTampered);
      expectVaultUntouched();
      expect(tokenAccount(w.svm, loose).owner).toBe(w.vault);
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
      expectError(await leg([take(), pay(), make, approve]), ERR.AccountTampered);
      expectVaultUntouched();
    });

    it('cannot be in the list at all, even untouched', async () => {
      const extra = [{ address: loose, role: AccountRole.WRITABLE }];
      expectError(await leg([take(), pay()], { extra }), ERR.AccountTampered);
      // Nor the vault's own account for its other position.
      expectError(
        await leg([take(), pay()], {
          extra: [{ address: w.vaultOther, role: AccountRole.WRITABLE }],
        }),
        ERR.AccountTampered,
      );
      expectVaultUntouched();
    });
  });

  describe('the signatures it is handed', () => {
    it("gets the vault's signature and nobody else's: not the keeper's, who signed the transaction", async () => {
      const rob = getTransferSolInstruction({
        source: programSigner(w.keeper.address),
        destination: attacker.address,
        amount: lamports(1_000_000_000n),
      });
      const before = w.svm.getBalance(attacker.address);
      expectFailure(await leg([take(), pay(), rob]), 'PrivilegeEscalation');
      expectVaultUntouched();
      expect(w.svm.getBalance(attacker.address)).toBe(before);
    });

    it('sees the vault as a read-only signer, and the keeper with no signature', async () => {
      const extra = [
        { address: w.vault, role: AccountRole.WRITABLE },
        { address: w.keeper.address, role: AccountRole.WRITABLE },
      ];
      const route = puppetInstruction(puppet, [take(), pay()], { extra });
      const meta = expectOk(await leg([take(), pay()], { extra }));
      expect(puppetSaw(meta.logs(), puppetIndex(route, w.vault))).toEqual({
        signer: true,
        writable: false,
      });
      expect(puppetSaw(meta.logs(), puppetIndex(route, w.keeper.address))).toEqual({
        signer: false,
        writable: true,
      });
    });

    // A17: a router that calls back into the vault program in the middle of the trade.
    it('cannot call back into the vault program', async () => {
      const pause = await pauseKeeperInstruction(programSigner(w.vault));
      expect(pause.programAddress).toBe(BASKET_PROGRAM);
      expectFailure(await leg([take(), pay(), pause]), 'ReentrancyNotAllowed');
      expectVaultUntouched();
    });

    it('cannot adopt, sync or trade again from inside: the vault is not handed over writable', async () => {
      const again = puppetInstruction(puppet, []);
      const calls = [
        await adoptVersionInstruction({ vault: w.vault, recipe: w.vault }),
        await syncBalancesInstruction({
          signer: programSigner(w.vault),
          vault: w.vault,
          tokenAccounts: [],
        }),
        await keeperLegInstruction({
          keeper: programSigner(w.vault),
          vault: w.vault,
          inputMint: w.cash,
          outputMint: w.stock,
          amountIn: CASH,
          router: puppet.program,
          data: new Uint8Array(again.data ?? []),
          routerAccounts: [],
          priceAccount: w.prices,
        }),
      ];
      for (const call of calls) {
        expectFailure(await leg([take(), pay(), call]), 'PrivilegeEscalation');
        expectVaultUntouched();
      }
    });
  });
});
