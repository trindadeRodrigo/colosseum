import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  generateKeyPairSigner,
  getProgramDerivedAddress,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import type { LiteSVM } from 'litesvm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_SIZE,
  configAddress,
  createVaultInstruction,
  DEFAULT_PARAMS,
  decodeAddressChange,
  ERR,
  FROZEN_ERRORS,
  forgeConfig,
  type InitConfigArgs,
  initAssetsInstruction,
  initConfigInstruction,
  type Params,
  readConfig,
  setCashMintInstruction,
  setPriceOwnerInstruction,
  setRouterInstruction,
  vaultAddress,
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
  idlCreateInstruction,
  loadProgram,
  MOCK_ROUTER_PROGRAM,
  programDataAddress,
  REPO_ROOT,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
  SYSTEM_PROGRAM,
  send,
} from './src/env';
import { createAta, createMint, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './src/tokens';

type Setter = (admin: TransactionSigner, value: Address, config?: Address) => Promise<Instruction>;

// The three addresses that differ per network. Each has a setter and an event.
const SETTERS: {
  field: 'routerProgram' | 'priceOwner' | 'cashMint';
  event: string;
  set: Setter;
  /** What the zero address, which is also the system program, is refused with. */
  zero: number;
}[] = [
  { field: 'routerProgram', event: 'RouterSet', set: setRouterInstruction, zero: ERR.ZeroAddress },
  {
    field: 'priceOwner',
    event: 'PriceOwnerSet',
    set: setPriceOwnerInstruction,
    zero: ERR.ZeroAddress,
  },
  // The cash mint comes in as an account and has to be a mint: the system program is not one.
  {
    field: 'cashMint',
    event: 'CashMintSet',
    set: setCashMintInstruction,
    zero: ANCHOR.AccountOwnedByWrongProgram,
  },
];

describe('basket config', () => {
  let svm: LiteSVM;
  let deployer: KeyPairSigner; // the program's upgrade authority
  let args: InitConfigArgs;

  beforeEach(async () => {
    ({ svm, deployer } = await createWorld());
    args = {
      guardian: (await generateKeyPairSigner()).address,
      defaultKeeper: (await generateKeyPairSigner()).address,
      // On devnet the test exchange, the owner of the test price account and the test
      // dollar token; on mainnet Jupiter, Kamino Scope and USDC. Either way, values in Config.
      routerProgram: MOCK_ROUTER_PROGRAM,
      priceOwner: (await generateKeyPairSigner()).address,
      cashMint: (await createMint(svm, deployer, { program: TOKEN_PROGRAM, decimals: 6 })).address,
      params: DEFAULT_PARAMS,
    };
  });

  const init = async (authority: KeyPairSigner, overrides: Partial<InitConfigArgs> = {}) =>
    send(svm, authority, [await initConfigInstruction(authority, { ...args, ...overrides })]);

  describe('initialise', () => {
    it('lets the upgrade authority initialise it, and makes that key the admin', async () => {
      expectOk(await init(deployer));

      const address = await configAddress();
      const account = svm.getAccount(address);
      expect(account.exists && account.data.length).toBe(CONFIG_SIZE);

      const config = await readConfig(svm);
      expect(config.admin).toBe(deployer.address);
      expect(config.pendingAdmin).toBe(SYSTEM_PROGRAM); // all zeros: none
      expect(config.guardian).toBe(args.guardian);
      expect(config.defaultKeeper).toBe(args.defaultKeeper);
      expect(config.routerProgram).toBe(MOCK_ROUTER_PROGRAM);
      expect(config.priceOwner).toBe(args.priceOwner);
      expect(config.cashMint).toBe(args.cashMint);
      expect(config.keeperPaused).toBe(false);
      expect(config.launched).toBe(false);
      expect(config).toMatchObject(DEFAULT_PARAMS);
      expect(config.closedUntil).toBe(0n);
      expect(config.closedDays).toEqual(new Array(32).fill(0));
      expect(config.reserved.every((b) => b === 0)).toBe(true);

      // The bump of its own address, kept so later reads can check the address cheaply.
      const [, bump] = await getProgramDerivedAddress({
        programAddress: BASKET_PROGRAM,
        seeds: ['config'],
      });
      expect(config.bump).toBe(bump);
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

    it('cannot be run at all once the program has no upgrade authority', async () => {
      // So Config is initialised before the program is ever made immutable.
      await loadProgram(svm, BASKET_PROGRAM, 'basket.so', null);
      expectError(await init(deployer), ERR.NotUpgradeAuthority);
    });

    // All zeros is the empty value and the system program: none of the five is ever that.
    it.each(['guardian', 'defaultKeeper', 'routerProgram', 'priceOwner'] as const)(
      'refuses the zero address as %s',
      async (field) => {
        expectError(await init(deployer, { [field]: SYSTEM_PROGRAM }), ERR.ZeroAddress);
        expect(svm.getAccount(await configAddress()).exists).toBe(false);
      },
    );

    it.each([
      ['the token program', TOKEN_PROGRAM],
      ['the Token-2022 program', TOKEN_2022_PROGRAM],
      ['the vault program itself', BASKET_PROGRAM],
    ])('refuses %s as the router', async (_, program) => {
      expectError(await init(deployer, { routerProgram: program }), ERR.RouterNotAllowed);
    });

    // A typo here, locked in by launch(), would mean no deposits until an upgrade.
    it('refuses a cash mint that is not a mint of a token program', async () => {
      const tokenAccount = await createAta(svm, deployer, deployer.address, {
        address: args.cashMint,
        program: TOKEN_PROGRAM,
        decimals: 6,
        issuer: deployer,
      });
      const notMints: [Address, number | string][] = [
        [SYSTEM_PROGRAM, ANCHOR.AccountOwnedByWrongProgram],
        [(await generateKeyPairSigner()).address, ANCHOR.AccountNotInitialized],
        [deployer.address, ANCHOR.AccountOwnedByWrongProgram],
        [tokenAccount, 'InvalidAccountData'],
      ];
      for (const [cashMint, refusal] of notMints) {
        const result = await init(deployer, { cashMint });
        if (typeof refusal === 'number') expectError(result, refusal);
        else expectFailure(result, refusal);
      }
      expect(svm.getAccount(await configAddress()).exists).toBe(false);
      // Either token program's mint is one.
      const mint2022 = await createMint(svm, deployer, {
        program: TOKEN_2022_PROGRAM,
        decimals: 6,
      });
      expectOk(await init(deployer, { cashMint: mint2022.address }));
      expect((await readConfig(svm)).cashMint).toBe(mint2022.address);
    });

    it('cannot be initialised twice', async () => {
      expectOk(await init(deployer));
      const other = (await generateKeyPairSigner()).address;
      expectError(await init(deployer, { routerProgram: other }), SYSTEM_ACCOUNT_ALREADY_IN_USE);
      expect((await readConfig(svm)).routerProgram).toBe(MOCK_ROUTER_PROGRAM);
    });
  });

  // DESIGN-VAULT.md section 3.7: the numbers the app shows cannot move past these without an upgrade.
  describe('hard bounds on the parameters', () => {
    const outOfBounds: [string, Partial<Params>][] = [
      ['a tolerance above 300 bps', { toleranceBps: 301 }],
      ['a weekly loss cap above 500 bps', { lossCapBps: 501 }],
      ['a band above 500 bps', { bandBps: 501 }],
      ['a price deviation allowance above 1,000 bps', { twapDevBps: 1_001 }],
      ['a price older than 600 s', { maxPriceAgeS: 601 }],
      ['a cooldown under 600 s', { assetCooldownS: 599 }],
      ['a cooldown over 7 days', { assetCooldownS: 604_801 }],
      ['a publish delay under 60 s', { publishDelayS: 59 }],
      ['a publish delay over 30 days', { publishDelayS: 2_592_001 }],
      ['a session that opens before 13:30 UTC', { sessionOpenUtcS: 48_599 }],
      ['a session that closes after 21:00 UTC', { sessionCloseUtcS: 75_601 }],
      [
        'a session that closes when it opens',
        { sessionOpenUtcS: 60_000, sessionCloseUtcS: 60_000 },
      ],
      [
        'a session that closes before it opens',
        { sessionOpenUtcS: 70_000, sessionCloseUtcS: 60_000 },
      ],
    ];

    it.each(outOfBounds)('refuses %s', async (_, change) => {
      expectError(
        await init(deployer, { params: { ...DEFAULT_PARAMS, ...change } }),
        ERR.ParamOutOfBounds,
      );
    });

    it('accepts each bound itself', async () => {
      const atTheBounds = {
        toleranceBps: 300,
        lossCapBps: 500,
        bandBps: 500,
        twapDevBps: 1_000,
        maxPriceAgeS: 600,
        assetCooldownS: 600,
        publishDelayS: 60,
        sessionOpenUtcS: 48_600,
        sessionCloseUtcS: 75_600,
      };
      expectOk(await init(deployer, { params: atTheBounds }));
      expect(await readConfig(svm)).toMatchObject(atTheBounds);
    });

    it('accepts the longest cooldown and the longest publish delay', async () => {
      const longest = { ...DEFAULT_PARAMS, assetCooldownS: 604_800, publishDelayS: 2_592_000 };
      expectOk(await init(deployer, { params: longest }));
      expect(await readConfig(svm)).toMatchObject(longest);
    });
  });

  describe('the router, the price source owner and the cash mint', () => {
    let guardian: KeyPairSigner;
    let keeper: KeyPairSigner;
    let replacement: Address;

    beforeEach(async () => {
      guardian = await fundedSigner(svm);
      keeper = await fundedSigner(svm);
      expectOk(await init(deployer, { guardian: guardian.address, defaultKeeper: keeper.address }));
      // A mint, so the same address will do for all three: the cash mint has to be one.
      replacement = (await createMint(svm, deployer, { program: TOKEN_2022_PROGRAM, decimals: 6 }))
        .address;
    });

    describe.each(SETTERS)('$field', ({ field, event, set, zero }) => {
      it('is changed by the admin, with an event that carries the old and the new value', async () => {
        const before = await readConfig(svm);
        const meta = expectOk(await send(svm, deployer, [await set(deployer, replacement)]));

        expect(await readConfig(svm)).toEqual({ ...before, [field]: replacement });
        expect(events(meta, event).map(decodeAddressChange)).toEqual([
          { old: before[field], new: replacement },
        ]);
      });

      it('cannot be changed by anyone else, the guardian and the keeper included', async () => {
        const stranger = await fundedSigner(svm);
        for (const who of [guardian, keeper, stranger]) {
          expectError(await send(svm, who, [await set(who, replacement)]), ANCHOR.ConstraintHasOne);
        }
        expect((await readConfig(svm))[field]).toBe(args[field]);
      });

      it('cannot be set to the zero address, which is also the system program', async () => {
        expectError(await send(svm, deployer, [await set(deployer, SYSTEM_PROGRAM)]), zero);
        expect((await readConfig(svm))[field]).toBe(args[field]);
      });
    });

    it('the cash mint cannot be set to what is not a mint of a token program', async () => {
      const tokenAccount = await createAta(svm, deployer, deployer.address, {
        address: args.cashMint,
        program: TOKEN_PROGRAM,
        decimals: 6,
        issuer: deployer,
      });
      expectError(
        await send(svm, deployer, [
          await setCashMintInstruction(deployer, (await generateKeyPairSigner()).address),
        ]),
        ANCHOR.AccountNotInitialized,
      );
      expectError(
        await send(svm, deployer, [await setCashMintInstruction(deployer, await configAddress())]),
        ANCHOR.AccountOwnedByWrongProgram,
      );
      expectFailure(
        await send(svm, deployer, [await setCashMintInstruction(deployer, tokenAccount)]),
        'InvalidAccountData',
      );
      expect((await readConfig(svm)).cashMint).toBe(args.cashMint);
    });

    // A token program would read the vault's signature as leave to move its tokens.
    it.each([
      ['the token program', TOKEN_PROGRAM],
      ['the Token-2022 program', TOKEN_2022_PROGRAM],
      ['the vault program itself', BASKET_PROGRAM],
    ])('the router cannot be set to %s', async (_, program) => {
      expectError(
        await send(svm, deployer, [await setRouterInstruction(deployer, program)]),
        ERR.RouterNotAllowed,
      );
      expect((await readConfig(svm)).routerProgram).toBe(MOCK_ROUTER_PROGRAM);
    });

    // Config is one account at one address. Anything else passed in its place is refused,
    // whatever it holds.
    describe('only the real Config is accepted', () => {
      let attacker: KeyPairSigner;

      beforeEach(async () => {
        attacker = await fundedSigner(svm);
      });

      it('refuses a forged Config at another address, though it names the signer as admin', async () => {
        const forged = await forgeConfig(svm, { admin: attacker.address });
        for (const { set } of SETTERS) {
          expectError(
            await send(svm, attacker, [await set(attacker, replacement, forged)]),
            ANCHOR.ConstraintSeeds,
          );
        }
      });

      it("refuses the attacker's own Vault, whose owner sits where the admin does", async () => {
        const theirVault = await vaultAddress(attacker.address, 1n);
        expectOk(await send(svm, deployer, [await initAssetsInstruction(deployer)]));
        expectOk(
          await send(svm, attacker, [
            await createVaultInstruction({ owner: attacker, basketId: 1n }),
          ]),
        );
        expectError(
          await send(svm, attacker, [
            await setRouterInstruction(attacker, replacement, theirVault),
          ]),
          ANCHOR.AccountDiscriminatorMismatch,
        );
      });

      it('refuses a blank account the attacker created and gave to the program', async () => {
        const blank = await generateKeyPairSigner();
        const space = BigInt(CONFIG_SIZE);
        expectOk(
          await send(svm, attacker, [
            getCreateAccountInstruction({
              payer: attacker,
              newAccount: blank,
              lamports: svm.minimumBalanceForRentExemption(space),
              space,
              programAddress: BASKET_PROGRAM,
            }),
          ]),
        );
        expectError(
          await send(svm, attacker, [
            await setRouterInstruction(attacker, replacement, blank.address),
          ]),
          ANCHOR.AccountDiscriminatorMismatch,
        );
        expect((await readConfig(svm)).routerProgram).toBe(MOCK_ROUTER_PROGRAM);
      });
    });
  });

  it("refuses Anchor's instruction that creates an on-chain IDL account", async () => {
    // Whoever creates that account becomes its authority, and anyone could: the program is
    // built without it. The interface files are in idl/ instead.
    const stranger = await fundedSigner(svm);
    const { instruction, idlAccount } = await idlCreateInstruction(BASKET_PROGRAM, stranger);
    expectError(await send(svm, stranger, [instruction]), ANCHOR.IdlInstructionStub);
    expect(svm.getAccount(idlAccount).exists).toBe(false);
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

    it('names no address but its own: the router, the price source and the cash mint live in Config', () => {
      const addresses = rustFiles(SRC).flatMap(
        (file) => readFileSync(file, 'utf8').match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? [],
      );
      expect(addresses).toEqual([`"${BASKET_PROGRAM}"`]);
    });

    it('keeps the error list in the frozen order, appending only', () => {
      const source = readFileSync(join(SRC, 'errors.rs'), 'utf8');
      const variants = [...source.matchAll(/^\s+([A-Z][A-Za-z]+),$/gm)].map((m) => m[1]);
      expect(variants.slice(0, FROZEN_ERRORS.length)).toEqual([...FROZEN_ERRORS]);
      for (const [name, code] of Object.entries(ERR)) {
        expect([name, 6000 + variants.indexOf(name)]).toEqual([name, code]);
      }
    });
  });
});
