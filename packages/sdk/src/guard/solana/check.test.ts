import { BasketTx, type ConsentKind } from '@colosseum/schemas';
import { AccountRole, address, getProgramDerivedAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { eachBites, type Negative, refusalOf } from '../../../test/bites';
import {
  ASSETS,
  ASSOCIATED,
  BASKET_ID,
  CONFIG,
  createVaultIx,
  depositIx,
  flag,
  handWritten,
  type Ix,
  join,
  keysOf,
  mintOf,
  OWNER,
  openAccountIx,
  ownerSwapIx,
  PROGRAM,
  ROUTER,
  raw,
  SOLANA,
  STRANGER,
  SYSTEM,
  solanaDeployment,
  solanaTx,
  someone,
  TOKEN,
  TOKEN_2022,
  targetsArg,
  tokenAccountOf,
  u32,
  u64,
  unitLimitIx,
  unitPriceIx,
  VAULT,
  vaultIx,
  vaultOf,
  type Wire,
  type Wrong,
  wire,
  withdrawIx,
} from '../../../test/solana';
import { BASKET_PROGRAM } from '../generated/basket-program';
import { guardTransaction, isGuarded } from '../index';
import type { GuardCheck } from '../refusal';
import { runGuard } from '../run';
import type { ApprovedStep, GuardInput } from '../types';
import type { ProgramTable } from './table';

// The guard on Solana bytes. Every transaction here is compiled by @solana/kit, with addresses kit
// derived. The honest ones pass; each negative differs from its step in one way and is refused by the
// one check that names it (see test/bites.ts).

const base = { legId: 'leg-1', chain: 'solana', owner: OWNER, basketId: BASKET_ID } as const;
const TARGETS = [
  { asset: 'solana:spy', weightBps: 6000 },
  { asset: 'solana:gold', weightBps: 4000 },
];
const TRADE = { sell: 'solana:usdc', buy: 'solana:spy', inRaw: '600000000', minOutRaw: '5940000' };
const CASH = '1000000000';
const RECIPE = someone('recipe');

type Step<K extends ApprovedStep['kind']> = Extract<ApprovedStep, { kind: K }>;
const createStep: Step<'create_vault'> = {
  ...base,
  kind: 'create_vault',
  targets: TARGETS,
  follow: null,
  autoFollow: false,
  depositRaw: CASH,
  trades: [],
};
const followStep: Step<'create_vault'> = {
  ...createStep,
  targets: [],
  follow: { recipeOnchainId: RECIPE, version: 3 },
};
const depositStep: Step<'deposit'> = { ...base, kind: 'deposit', amountRaw: CASH, trades: [] };
const swapStep: Step<'swap'> = { ...base, kind: 'swap', trades: [TRADE] };
const withdrawStep: Step<'withdraw'> = {
  ...base,
  kind: 'withdraw',
  withdrawals: [{ asset: 'solana:spy', amountRaw: '5000000' }],
};
const withdrawAllStep: Step<'withdraw'> = { ...base, kind: 'withdraw', withdrawals: 'all' };
const targetsStep: Step<'set_targets'> = { ...base, kind: 'set_targets', targets: TARGETS };
const acceptStep: Step<'accept_version'> = {
  ...base,
  kind: 'accept_version',
  follow: { recipeOnchainId: RECIPE, version: 4 },
};
const autoStep = (on: boolean): Step<'set_auto_follow'> => ({
  ...base,
  kind: 'set_auto_follow',
  on,
});

const BUDGET = [unitLimitIx(400_000), unitPriceIx(10_000n)];

/** What a builder of each step would send, with any one part of it replaceable. */
const honest = {
  create: async (
    table: ProgramTable,
    step = createStep,
    ix: Parameters<typeof createVaultIx>[1] = {},
  ) => [
    ...BUDGET,
    await createVaultIx(table, {
      targets: step.targets,
      autoFollow: step.autoFollow,
      ...(step.follow
        ? { recipe: step.follow.recipeOnchainId, expectedVersion: step.follow.version }
        : {}),
      ...ix,
    }),
    await openAccountIx(VAULT, 'solana:usdc'),
    await depositIx(table, step.depositRaw),
  ],
  deposit: async (table: ProgramTable, amount = CASH, wrong: Wrong = {}) => [
    ...BUDGET,
    await depositIx(table, amount, wrong),
  ],
  swap: async (trade = TRADE, wrong: Parameters<typeof ownerSwapIx>[2] = {}) => [
    ...BUDGET,
    await openAccountIx(VAULT, trade.buy),
    await ownerSwapIx(BASKET_PROGRAM, trade, wrong),
  ],
  withdraw: async (table: ProgramTable, amount = '5000000', wrong: Wrong = {}) => [
    await openAccountIx(OWNER, 'solana:spy'),
    await withdrawIx(table, 'solana:spy', amount, wrong),
  ],
};

const input = (
  step: ApprovedStep,
  bytes: Wire,
  over: Partial<BasketTx> = {},
  consents: ConsentKind[] = [],
): GuardInput => ({ step, tx: solanaTx(step, bytes, over), deployment: SOLANA, consents });

describe('the guard on Solana: an honest transaction passes', () => {
  it('with the interface as committed: every step the program has today, on both message versions', async () => {
    const withTrade = { ...depositStep, trades: [TRADE] };
    const allCash = { ...createStep, targets: [], depositRaw: '0' };
    const cases: [ApprovedStep, Ix[]][] = [
      [createStep, await honest.create(BASKET_PROGRAM)],
      [followStep, await honest.create(BASKET_PROGRAM, followStep)],
      // A plan that is all cash: no target, and here no deposit either.
      [allCash, [await createVaultIx(BASKET_PROGRAM)]],
      [depositStep, await honest.deposit(BASKET_PROGRAM)],
      [
        withTrade,
        [...(await honest.deposit(BASKET_PROGRAM)), await ownerSwapIx(BASKET_PROGRAM, TRADE)],
      ],
      [swapStep, await honest.swap()],
      [withdrawStep, await honest.withdraw(BASKET_PROGRAM)],
      [withdrawAllStep, await honest.withdraw(BASKET_PROGRAM, '123')],
      [
        targetsStep,
        [
          vaultIx(
            BASKET_PROGRAM,
            'set_targets',
            { owner: OWNER, vault: VAULT, config: CONFIG, assets: ASSETS },
            targetsArg(TARGETS),
          ),
        ],
      ],
    ];
    for (const [step, instructions] of cases)
      for (const version of [0, 'legacy'] as const) {
        const given = input(step, wire(instructions, { version }));
        // The fixture is a transaction the API could hand out.
        expect(BasketTx.safeParse(given.tx).success, step.kind).toBe(true);
        expect(refusalOf(() => guardTransaction(given))?.message ?? null, step.kind).toBeNull();
        const pass = guardTransaction(given);
        expect(isGuarded(pass), step.kind).toBe(true);
        expect(pass.tx).toEqual(given.tx);
        expect(Object.isFrozen(pass.tx) && Object.isFrozen(pass.tx.preview)).toBe(true);
      }
  });

  it('nothing but the guard makes a pass', () => {
    expect(isGuarded({ tx: {}, step: {} })).toBe(false);
    expect(isGuarded(null)).toBe(false);
  });

  it("the owner's two instructions of the keeper path: an accept, and the switch both ways", () => {
    const cases: [ApprovedStep, Ix[], ConsentKind[]][] = [
      [acceptStep, [acceptIx()], ['new_asset']],
      [autoStep(true), [autoIx(true)], ['auto_follow_on']],
      [autoStep(false), [autoIx(false)], []],
    ];
    for (const [step, instructions, consents] of cases)
      for (const version of [0, 'legacy'] as const) {
        const given = input(step, wire(instructions, { version }), {}, consents);
        expect(BasketTx.safeParse(given.tx).success, step.kind).toBe(true);
        expect(refusalOf(() => guardTransaction(given))?.message ?? null, step.kind).toBeNull();
      }
  });

  it("a swap whose route's accounts come from a lookup table", async () => {
    const pools = [someone('pool'), someone('pool tokens')];
    const bytes = wire(await honest.swap(), { tables: { [someone('table')]: pools } });
    expect(bytes.payload).not.toBe(wire(await honest.swap()).payload);
    expect(refusalOf(() => guardTransaction(input(swapStep, bytes)))).toBeNull();
  });

  it('a withdrawal of everything: the tokens the deployment lists, to the person, under either token program', async () => {
    const usdc = await withdrawIx(BASKET_PROGRAM, 'solana:usdc', '1');
    const spy = await withdrawIx(BASKET_PROGRAM, 'solana:spy', '2');
    const bytes = wire([await openAccountIx(OWNER, 'solana:usdc'), usdc, spy]);
    expect(refusalOf(() => guardTransaction(input(withdrawAllStep, bytes)))).toBeNull();
  });

  it('a withdrawal of everything takes a token outside the list only when the caller says the vault holds it', async () => {
    const extra = await strayWithdrawal('a token sent in from outside', '9');
    const bytes = wire([extra.open, extra.withdraw]);
    expect(refusalOf(() => guardTransaction(input(withdrawAllStep, bytes)))?.code).toBe('asset');
    const held = [{ address: extra.mint, tokenProgram: 'token' as const }];
    expect(
      refusalOf(() => guardTransaction(input({ ...withdrawAllStep, held }, bytes))),
    ).toBeNull();
    // Said to be held, with nothing to say which token program owns it: no account can be derived.
    const vague = { ...withdrawAllStep, held: [{ address: extra.mint }] };
    expect(refusalOf(() => guardTransaction(input(vague, bytes)))?.code).toBe('unsupported');
    // And held under the other token program: the accounts are not the ones derived.
    const other = {
      ...withdrawAllStep,
      held: [{ address: extra.mint, tokenProgram: 'token-2022' as const }],
    };
    expect(refusalOf(() => guardTransaction(input(other, bytes)))?.code).toBe('accounts');
  });

  it("refuses five withdrawals of tokens nobody listed, each with accounts opened at the person's cost", async () => {
    // What a withdrawal of everything once let through: 1,001 bytes of nothing, and ten new accounts.
    const instructions: Ix[] = [];
    for (let i = 0; i < 5; i += 1) {
      const stray = await strayWithdrawal(`junk ${i}`, '0');
      instructions.push(stray.openVault, stray.open, stray.withdraw);
    }
    const refusal = refusalOf(() => guardTransaction(input(withdrawAllStep, wire(instructions))));
    expect(refusal?.code).toBe('asset');
  });
});

const acceptIx = (o: { recipe?: string; version?: number } = {}) =>
  vaultIx(
    BASKET_PROGRAM,
    'accept_version',
    { owner: OWNER, vault: VAULT, recipe: o.recipe ?? RECIPE },
    u32(o.version ?? 4),
  );
const autoIx = (on: boolean) =>
  vaultIx(BASKET_PROGRAM, 'set_auto_follow', { owner: OWNER, vault: VAULT }, flag(on));

describe('the guard on Solana: what the interface it is given does not have', () => {
  it('refuses a step whose instruction is not in the table as unsupported, until the table is regenerated', () => {
    const { accept_version, set_auto_follow, ...rest } = BASKET_PROGRAM.instructions;
    expect(accept_version && set_auto_follow).toBeTruthy();
    const older: ProgramTable = { ...BASKET_PROGRAM, instructions: rest };
    const cases: [ApprovedStep, Ix[]][] = [
      [acceptStep, [acceptIx()]],
      [autoStep(true), [autoIx(true)]],
      [autoStep(false), [autoIx(false)]],
    ];
    for (const [step, instructions] of cases) {
      const given = input(step, wire(instructions), {}, ['new_asset', 'auto_follow_on']);
      expect(
        refusalOf(() => guardTransaction(given)),
        step.kind,
      ).toBeNull();
      const refusal = refusalOf(() => runGuard(given, { program: older }));
      expect(refusal?.code, step.kind).toBe('unsupported');
      expect(refusal?.message).toMatch(/regenerated/);
    }
  });

  it('refuses an approval: Solana has none', async () => {
    const step: ApprovedStep = { ...base, kind: 'approve', amountRaw: CASH };
    const bytes = wire(await honest.deposit(BASKET_PROGRAM));
    const refusal = refusalOf(() => guardTransaction(input(step, bytes)));
    expect(refusal?.code).toBe('unsupported');
  });

  it('refuses an interface that grew an account or an argument the guard has no rule for', async () => {
    const deposit = BASKET_PROGRAM.instructions.deposit as ProgramTable['instructions'][string];
    const grown = (change: Partial<typeof deposit>): ProgramTable => ({
      ...BASKET_PROGRAM,
      instructions: { ...BASKET_PROGRAM.instructions, deposit: { ...deposit, ...change } },
    });
    const withAccount = grown({
      accounts: [
        ...deposit.accounts,
        { name: 'referrer', signer: false, writable: true, optional: false },
      ],
    });
    const withArg = grown({ args: [...deposit.args, { name: 'tip', type: 'u64' }] });
    const without = grown({ accounts: deposit.accounts.filter((a) => a.name !== 'source') });
    const bytes = wire(await honest.deposit(BASKET_PROGRAM));
    for (const [table, says] of [
      [withAccount, /no rule for the account referrer/],
      [without, /has no account source/],
    ] as const) {
      const built = wire([
        vaultIx(
          table,
          'deposit',
          {
            owner: OWNER,
            vault: VAULT,
            config: CONFIG,
            mint: mintOf('solana:usdc'),
            vault_token_account: await tokenAccountOf(VAULT, 'solana:usdc'),
            source: await tokenAccountOf(OWNER, 'solana:usdc'),
            token_program: TOKEN,
            referrer: STRANGER,
          },
          u64(CASH),
        ),
      ]);
      const refusal = refusalOf(() => runGuard(input(depositStep, built), { program: table }));
      expect(refusal?.code).toBe('unsupported');
      expect(refusal?.message).toMatch(says);
    }
    // A create with no place for a shared portfolio cannot open a vault that follows one.
    const create = BASKET_PROGRAM.instructions.create_vault as ProgramTable['instructions'][string];
    const noRecipe: ProgramTable = {
      ...BASKET_PROGRAM,
      instructions: {
        ...BASKET_PROGRAM.instructions,
        create_vault: { ...create, accounts: create.accounts.filter((a) => a.name !== 'recipe') },
      },
    };
    const follows = refusalOf(() =>
      runGuard(input({ ...followStep, depositRaw: '0' }, wire([vaultIxOf(noRecipe)])), {
        program: noRecipe,
      }),
    );
    expect(follows?.code).toBe('unsupported');
    expect(follows?.message).toMatch(/no account recipe/);
    // The bytes of today's deposit end before the new argument: they cannot be read at all.
    expect(refusalOf(() => runGuard(input(depositStep, bytes), { program: withArg }))?.code).toBe(
      'malformed',
    );
  });
});

describe('the guard on Solana: bytes that cannot be read are refused as malformed', () => {
  it('cut short, padded, spelled another way, or not a transaction', async () => {
    const good = wire(await honest.deposit(BASKET_PROGRAM));
    const bytes = Buffer.from(good.payload, 'base64');
    const spare = Buffer.concat([bytes, Buffer.from([0])]).toString('base64');
    const cases: [string, string][] = [
      ['cut short', bytes.subarray(0, bytes.length - 3).toString('base64')],
      ['a byte left over', spare],
      ['not base64', `${good.payload.slice(0, -2)}!!`],
      ['nothing', ''],
      ['a version this guard does not read', versioned(bytes, 0x81)],
    ];
    for (const [name, payload] of cases) {
      const refusal = refusalOf(() => guardTransaction(input(depositStep, { ...good, payload })));
      expect(refusal?.code, name).toBe('malformed');
    }
  });

  it('arguments with a byte left over, or a flag that is neither 0 nor 1', async () => {
    const longer = await depositIx(BASKET_PROGRAM, CASH);
    const padded = { ...longer, data: join(longer.data as Uint8Array, Uint8Array.of(0)) };
    expect(refusalOf(() => guardTransaction(input(depositStep, wire([padded]))))?.code).toBe(
      'malformed',
    );
    const two = vaultIx(
      BASKET_PROGRAM,
      'set_auto_follow',
      { owner: OWNER, vault: VAULT },
      Uint8Array.of(2),
    );
    expect(
      refusalOf(() => guardTransaction(input(autoStep(true), wire([two]), {}, ['auto_follow_on'])))
        ?.code,
    ).toBe('malformed');
  });

  it('a transaction that carries a field the guard does not read, or an EVM call', async () => {
    const good = input(depositStep, wire(await honest.deposit(BASKET_PROGRAM)));
    for (const change of [
      { evm: { to: `0x${'11'.repeat(20)}`, value: '0', chainId: 1 } },
      { instructions: [] },
      { signatures: ['x'] },
      {
        preview: {
          ...good.tx.preview,
          changes: [{ holder: 'vault', asset: 'solana:usdc', deltaRaw: '5', to: STRANGER }],
        },
      },
    ])
      expect(
        refusalOf(() => guardTransaction({ ...good, tx: { ...good.tx, ...change } as BasketTx }))
          ?.code,
        Object.keys(change)[0],
      ).toBe('malformed');
    // What the preview says the balances will do is passed on as it came: the guard does not hold it
    // to the bytes, only to its shape.
    const changes = [{ holder: 'vault' as const, asset: 'solana:usdc', deltaRaw: '-5' }];
    const told = { ...good, tx: { ...good.tx, preview: { ...good.tx.preview, changes } } };
    expect(guardTransaction(told).tx.preview.changes).toEqual(changes);
  });

  it('a transaction or a step with a field missing or of another type', async () => {
    const good = input(depositStep, wire(await honest.deposit(BASKET_PROGRAM)));
    const broken = (change: object) => ({ ...good, tx: { ...good.tx, ...change } as BasketTx });
    for (const change of [
      { messageHash: 'ABC' },
      { payload: 7 },
      { preview: null },
      { preview: { ...good.tx.preview, minimums: 'none' } },
      { preview: { ...good.tx.preview, feeNativeRaw: '-1' } },
    ])
      expect(refusalOf(() => guardTransaction(broken(change)))?.code, JSON.stringify(change)).toBe(
        'malformed',
      );
    const steps: [object, string][] = [
      [{ basketId: '18446744073709551616' }, 'order'],
      [{ basketId: '-1' }, 'order'],
      [{ owner: '0x' }, 'order'],
      [{ amountRaw: '1.5' }, 'order'],
      [{ kind: 'publish' }, 'unsupported'],
      [{ kind: 'keeper_leg' }, 'unsupported'],
    ];
    for (const [change, code] of steps)
      expect(
        refusalOf(() => guardTransaction({ ...good, step: { ...depositStep, ...change } as never }))
          ?.code,
        JSON.stringify(change),
      ).toBe(code);
    expect(refusalOf(() => guardTransaction({ ...good, step: null as never }))?.code).toBe('order');
    expect(
      refusalOf(() => guardTransaction({ ...good, deployment: undefined as never }))?.code,
    ).toBe('unsupported');
  });
});

/** A create that follows, built against a table whose create has no account for what is followed. */
const vaultIxOf = (table: ProgramTable) =>
  vaultIx(
    table,
    'create_vault',
    { owner: OWNER, vault: VAULT, config: CONFIG, assets: ASSETS, system_program: SYSTEM },
    join(u64(BASKET_ID), targetsArg([]), flag(false), u32(3)),
  );

/** A withdrawal of a token the deployment does not list, with the accounts it would open. */
async function strayWithdrawal(label: string, amount: string) {
  const mint = someone(`mint ${label}`);
  const accountOf = async (holder: string) =>
    (
      await getProgramDerivedAddress({
        programAddress: address(ASSOCIATED),
        seeds: [raw(holder), raw(TOKEN), raw(mint)],
      })
    )[0] as string;
  const [ofVault, ofOwner] = [await accountOf(VAULT), await accountOf(OWNER)];
  const open = (holder: string, account: string): Ix => ({
    programAddress: address(ASSOCIATED),
    accounts: [
      { address: address(OWNER), role: AccountRole.WRITABLE_SIGNER },
      { address: address(account), role: AccountRole.WRITABLE },
      { address: address(holder), role: AccountRole.READONLY },
      { address: address(mint), role: AccountRole.READONLY },
      { address: address(SYSTEM), role: AccountRole.READONLY },
      { address: address(TOKEN), role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  });
  return {
    mint,
    open: open(OWNER, ofOwner),
    openVault: open(VAULT, ofVault),
    withdraw: vaultIx(
      BASKET_PROGRAM,
      'withdraw',
      {
        owner: OWNER,
        vault: VAULT,
        mint,
        vault_token_account: ofVault,
        destination: ofOwner,
        token_program: TOKEN,
      },
      u64(amount),
    ),
  };
}

/** The same transaction with another version byte at the head of its message. */
function versioned(bytes: Buffer, byte: number): string {
  const out = Buffer.from(bytes);
  out[1 + 64] = byte;
  return out.toString('base64');
}

const systemTransfer: Ix = {
  programAddress: address(SYSTEM),
  accounts: [
    { address: address(OWNER), role: AccountRole.WRITABLE_SIGNER },
    { address: address(STRANGER), role: AccountRole.WRITABLE },
  ],
  data: join(u32(2), u64(1_000_000_000n)),
};
/** A token-program instruction at the top level: Approve, with the stranger as delegate. */
const tokenApprove = async (): Promise<Ix> => ({
  programAddress: address(TOKEN),
  accounts: [
    { address: address(await tokenAccountOf(OWNER, 'solana:usdc')), role: AccountRole.WRITABLE },
    { address: address(STRANGER), role: AccountRole.READONLY },
    { address: address(OWNER), role: AccountRole.READONLY_SIGNER },
  ],
  data: join(Uint8Array.of(4), u64(CASH)),
});
/** The token program's SetAuthority on the person's own account. */
const tokenSetAuthority = async (): Promise<Ix> => ({
  programAddress: address(TOKEN),
  accounts: [
    { address: address(await tokenAccountOf(OWNER, 'solana:usdc')), role: AccountRole.WRITABLE },
    { address: address(OWNER), role: AccountRole.READONLY_SIGNER },
  ],
  data: join(Uint8Array.of(6, 2, 1), raw(STRANGER)),
});

const deposit = (
  name: string,
  check: GuardCheck,
  build: () => Promise<Ix[]> | Ix[],
  over: Partial<BasketTx> = {},
): Negative => ({
  name,
  check,
  input: async () => input(depositStep, wire(await build()), over),
});
const swap = (name: string, check: GuardCheck, build: () => Promise<Ix[]>): Negative => ({
  name,
  check,
  input: async () => input(swapStep, wire(await build())),
});
const good = () => honest.deposit(BASKET_PROGRAM);
/** A compute-budget instruction with a byte more, or naming an account. */
const longer = (ix: Ix): Ix => ({ ...ix, data: join(ix.data as Uint8Array, Uint8Array.of(0)) });
const naming = (ix: Ix): Ix => ({
  ...ix,
  accounts: [{ address: address(someone('spare')), role: AccountRole.READONLY }],
});

const negatives: Negative[] = [
  // ---- G-LINK: a hostile instruction in an allowed program
  deposit(
    'a second instruction of the vault program: a withdrawal after the deposit',
    'instruction',
    async () => [...(await good()), await withdrawIx(BASKET_PROGRAM, 'solana:usdc', CASH)],
  ),
  deposit('the deposit twice', 'instruction', async () => [
    ...(await good()),
    await depositIx(BASKET_PROGRAM, CASH),
  ]),
  deposit(
    'an instruction of the vault program that no interface names',
    'instruction',
    async () => [
      ...(await good()),
      {
        programAddress: address(PROGRAM),
        accounts: [],
        data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      },
    ],
  ),
  deposit('an admin instruction of the vault program', 'instruction', async () => [
    ...(await good()),
    vaultIx(BASKET_PROGRAM, 'set_router', { admin: OWNER, config: CONFIG }, raw(STRANGER)),
  ]),
  {
    name: 'the auto-follow switch beside the swap',
    check: 'instruction',
    input: async () => input(swapStep, wire([...(await honest.swap()), autoIx(true)])),
  },
  {
    name: 'a version accepted beside the swap',
    check: 'instruction',
    input: async () =>
      input(swapStep, wire([...(await honest.swap()), acceptIx()]), {}, ['new_asset']),
  },
  swap(
    "the vault's balances written down beside the swap, by the person",
    'instruction',
    async () => [
      ...(await honest.swap()),
      vaultIx(
        BASKET_PROGRAM,
        'sync_balances',
        { signer: OWNER, vault: VAULT, config: CONFIG },
        new Uint8Array(),
      ),
    ],
  ),
  swap('a change of targets beside the swap', 'instruction', async () => [
    ...(await honest.swap()),
    vaultIx(
      BASKET_PROGRAM,
      'set_targets',
      { owner: OWNER, vault: VAULT, config: CONFIG, assets: ASSETS },
      targetsArg([{ asset: 'solana:gold', weightBps: 10_000 }]),
    ),
  ]),
  deposit('the deposit left out: only the budget is there', 'instruction', () => BUDGET),
  deposit(
    'the token-account program asked for something other than "create if missing"',
    'token_account',
    async () => [...(await good()), await openAccountIx(VAULT, 'solana:usdc', { data: [2] })],
  ),
  deposit(
    "a token account opened for a stranger, at the person's cost",
    'token_account',
    async () => [...(await good()), await openAccountIx(STRANGER, 'solana:usdc')],
  ),
  deposit('a token account of a token this step does not move', 'token_account', async () => [
    ...(await good()),
    await openAccountIx(OWNER, 'solana:gold'),
  ]),
  deposit('the same token account opened twice', 'token_account', async () => [
    ...(await good()),
    await openAccountIx(VAULT, 'solana:usdc'),
    await openAccountIx(VAULT, 'solana:usdc'),
  ]),
  deposit('a token account at another address than the derived one', 'token_account', async () => [
    ...(await good()),
    await openAccountIx(VAULT, 'solana:usdc', { account: someone('elsewhere') }),
  ]),
  deposit(
    'a compute-budget instruction that is neither the limit nor the price',
    'budget',
    async () => [
      ...(await good()),
      {
        programAddress: address('ComputeBudget111111111111111111111111111111'),
        accounts: [],
        data: join(Uint8Array.of(1), u32(256_000)),
      },
    ],
  ),
  deposit('the unit price set twice', 'budget', async () => [...(await good()), unitPriceIx(1n)]),
  deposit('the unit limit set twice', 'budget', async () => [...(await good()), unitLimitIx(1)]),
  deposit('a unit limit with a byte left over', 'budget', async () => [
    longer(unitLimitIx(400_000)),
    unitPriceIx(10_000n),
    await depositIx(BASKET_PROGRAM, CASH),
  ]),
  deposit('a unit limit that names an account', 'budget', async () => [
    naming(unitLimitIx(400_000)),
    unitPriceIx(10_000n),
    await depositIx(BASKET_PROGRAM, CASH),
  ]),
  deposit('a unit price with a byte left over', 'budget', async () => [
    unitLimitIx(400_000),
    longer(unitPriceIx(10_000n)),
    await depositIx(BASKET_PROGRAM, CASH),
  ]),
  deposit('a unit price that names an account', 'budget', async () => [
    unitLimitIx(400_000),
    naming(unitPriceIx(10_000n)),
    await depositIx(BASKET_PROGRAM, CASH),
  ]),
  deposit(
    'a token account paid for by the vault, which signs nothing',
    'token_account',
    async () => {
      const open = await openAccountIx(VAULT, 'solana:usdc', { payer: VAULT });
      return [
        ...(await good()),
        {
          ...open,
          accounts: (open.accounts ?? []).map((a, i) =>
            i === 0 ? { ...a, role: AccountRole.WRITABLE } : a,
          ),
        },
      ];
    },
  ),
  deposit(
    'a token account opened through another program than System',
    'token_account',
    async () => [
      ...(await good()),
      await openAccountIx(VAULT, 'solana:usdc', { system: STRANGER }),
    ],
  ),
  deposit('a token account instruction with an account more', 'token_account', async () => {
    const open = await openAccountIx(VAULT, 'solana:usdc');
    return [
      ...(await good()),
      {
        ...open,
        accounts: [
          ...(open.accounts ?? []),
          { address: address(someone('spare')), role: AccountRole.READONLY },
        ],
      },
    ];
  }),
  deposit(
    "a token account opened under another token program than the token's",
    'token_account',
    async () => {
      const [account] = await getProgramDerivedAddress({
        programAddress: address(ASSOCIATED),
        seeds: [raw(VAULT), raw(TOKEN_2022), raw(mintOf('solana:usdc'))],
      });
      const open = await openAccountIx(VAULT, 'solana:usdc', { account });
      return [
        ...(await good()),
        {
          ...open,
          accounts: (open.accounts ?? []).map((a, i) =>
            i === 5 ? { ...a, address: address(TOKEN_2022) } : a,
          ),
        },
      ];
    },
  ),

  // ---- G-LINK: a withdraw built for a third party
  {
    name: "a withdrawal to a stranger's token account",
    check: 'recipient',
    input: async () =>
      input(
        withdrawStep,
        wire(
          await honest.withdraw(BASKET_PROGRAM, '5000000', {
            accounts: { destination: await tokenAccountOf(STRANGER, 'solana:spy') },
          }),
        ),
      ),
  },
  {
    name: "a withdrawal of everything to a stranger's token account",
    check: 'recipient',
    input: async () =>
      input(
        withdrawAllStep,
        wire([
          await withdrawIx(BASKET_PROGRAM, 'solana:gold', '9', {
            accounts: { destination: await tokenAccountOf(STRANGER, 'solana:gold') },
          }),
        ]),
      ),
  },
  deposit("a deposit taken from a stranger's token account", 'recipient', () =>
    honest.deposit(BASKET_PROGRAM, CASH, { accounts: { source: someone('their cash') } }),
  ),

  // ---- a withdrawal of everything takes only what is listed or known, and opens nothing for the vault
  {
    name: 'a withdrawal of everything that takes a token nobody listed',
    check: 'asset',
    input: async () =>
      input(withdrawAllStep, wire([(await strayWithdrawal('junk', '0')).withdraw])),
  },
  {
    name: 'a withdrawal of everything that takes one token twice',
    check: 'asset',
    input: async () =>
      input(
        withdrawAllStep,
        wire([
          await withdrawIx(BASKET_PROGRAM, 'solana:gold', '1'),
          await withdrawIx(BASKET_PROGRAM, 'solana:gold', '2'),
        ]),
      ),
  },
  {
    name: 'a withdrawal of everything under the wrong token program for a listed token',
    check: 'accounts',
    input: async () =>
      input(
        withdrawAllStep,
        wire([
          await withdrawIx(BASKET_PROGRAM, 'solana:spy', '5', {
            accounts: { token_program: TOKEN },
          }),
        ]),
      ),
  },
  {
    name: "a withdrawal that opens the vault's own account",
    check: 'token_account',
    input: async () =>
      input(
        withdrawStep,
        wire([
          await openAccountIx(VAULT, 'solana:spy'),
          ...(await honest.withdraw(BASKET_PROGRAM)),
        ]),
      ),
  },
  {
    name: "a withdrawal of everything that opens the vault's own account",
    check: 'token_account',
    input: async () =>
      input(
        withdrawAllStep,
        wire([
          await openAccountIx(VAULT, 'solana:gold'),
          await withdrawIx(BASKET_PROGRAM, 'solana:gold', '1'),
        ]),
      ),
  },
  deposit("a deposit that opens the person's own cash account", 'token_account', async () => [
    ...(await good()),
    await openAccountIx(OWNER, 'solana:usdc'),
  ]),
  swap("a trade that opens the person's account of the token bought", 'token_account', async () => [
    ...(await honest.swap()),
    await openAccountIx(OWNER, 'solana:spy'),
  ]),

  // ---- G-LINK: auto-follow without consent
  {
    name: 'a create that switches auto-follow on, with no consent handed over',
    check: 'consent',
    input: async () => {
      const step = { ...createStep, autoFollow: true };
      return input(step, wire(await honest.create(BASKET_PROGRAM, step)));
    },
  },
  {
    name: 'the auto-follow switch turned on, with no consent handed over',
    check: 'consent',
    input: () => input(autoStep(true), wire([autoIx(true)])),
  },
  {
    name: 'the auto-follow switch turned on, with the consent for something else',
    check: 'consent',
    input: () => input(autoStep(true), wire([autoIx(true)]), {}, ['new_asset']),
  },
  {
    name: 'a version accepted with no consent handed over',
    check: 'consent',
    input: () => input(acceptStep, wire([acceptIx()])),
  },
  {
    name: 'bytes that switch auto-follow on in a create the person approved with it off',
    check: 'auto_follow',
    input: async () =>
      input(
        createStep,
        wire(await honest.create(BASKET_PROGRAM, createStep, { autoFollow: true })),
      ),
  },
  {
    name: 'bytes that switch auto-follow on where the step switches it off',
    check: 'auto_follow',
    input: () => input(autoStep(false), wire([autoIx(true)])),
  },

  // ---- G-LINK: a swap whose minimum differs from the screen
  swap('a lower minimum', 'minimum', () => honest.swap({ ...TRADE, minOutRaw: '1' })),
  swap('a minimum of nothing', 'minimum', () => honest.swap({ ...TRADE, minOutRaw: '0' })),
  swap('a higher minimum', 'minimum', () => honest.swap({ ...TRADE, minOutRaw: '5940001' })),

  // ---- a larger amount
  deposit('a larger deposit', 'amount', () => honest.deposit(BASKET_PROGRAM, '1000000001')),
  deposit('a smaller deposit', 'amount', () => honest.deposit(BASKET_PROGRAM, '1')),
  swap('a trade that sells more', 'amount', () => honest.swap({ ...TRADE, inRaw: '600000001' })),
  {
    name: 'a larger withdrawal than the step names',
    check: 'amount',
    input: async () => input(withdrawStep, wire(await honest.withdraw(BASKET_PROGRAM, '5000001'))),
  },
  {
    name: 'a larger deposit inside a create',
    check: 'amount',
    input: async () =>
      input(
        createStep,
        wire(await honest.create(BASKET_PROGRAM, { ...createStep, depositRaw: '2000000000' })),
      ),
  },

  // ---- a different vault
  deposit("a deposit into another person's vault", 'vault', async () =>
    honest.deposit(BASKET_PROGRAM, CASH, { accounts: { vault: await vaultOf(STRANGER) } }),
  ),
  deposit("a deposit into the person's vault for another plan", 'vault', async () =>
    honest.deposit(BASKET_PROGRAM, CASH, { accounts: { vault: await vaultOf(OWNER, '1') } }),
  ),
  {
    name: 'a create for another plan number',
    check: 'vault',
    input: async () =>
      input(createStep, wire(await honest.create(BASKET_PROGRAM, createStep, { basketId: '1' }))),
  },

  // ---- a different chain, a different network
  deposit('a transaction that says it is for another chain', 'chain', good, {
    chainId: 'robinhood',
  }),
  deposit('a transaction of the other wallet family', 'chain', good, { chain: 'evm' }),
  deposit('a transaction labelled for mainnet on a test network', 'network', good, {
    provenance: 'live',
  }),
  deposit('a transaction labelled as a mock on a real network', 'network', good, {
    provenance: 'mock',
  }),

  // ---- a call to an unknown program
  deposit("a System transfer of the person's SOL to a stranger", 'program', async () => [
    ...(await good()),
    systemTransfer,
  ]),
  deposit('a token-program approval of a stranger', 'program', async () => [
    ...(await good()),
    await tokenApprove(),
  ]),
  deposit('a token-program change of authority', 'program', async () => [
    ...(await good()),
    await tokenSetAuthority(),
  ]),
  deposit('the router called at the top level', 'program', async () => [
    ...(await good()),
    { programAddress: address(ROUTER), accounts: [], data: Uint8Array.of(1) },
  ]),

  // ---- the rest of what a transaction can get wrong, one at a time
  deposit('a transaction for another kind of step', 'step', good, { legKind: 'swap' }),
  deposit('a transaction built for another leg', 'step', good, { legId: 'leg-2' }),
  deposit('a transaction that names a stranger as its signer', 'signer', good, {
    signer: STRANGER,
  }),
  deposit('a transaction that names a stranger as its fee payer', 'signer', good, {
    feePayer: STRANGER,
  }),
  {
    name: 'a second signer that no instruction uses',
    check: 'signer',
    input: async () => {
      const instructions = await good();
      return input(
        depositStep,
        handWritten({
          keys: keysOf([OWNER, STRANGER], instructions),
          instructions,
          header: [2, 0, 0],
        }),
      );
    },
  },
  {
    name: 'bytes a stranger pays for, with the person a plain account that signs nothing',
    check: 'signer',
    input: async () => {
      const instructions = await good();
      return input(
        depositStep,
        handWritten({ keys: keysOf([STRANGER, OWNER], instructions), instructions }),
      );
    },
  },
  {
    name: 'bytes a stranger pays for and signs first',
    check: 'signer',
    input: async () => input(depositStep, wire(await good(), { payer: STRANGER })),
  },
  deposit('a message hash that is not the hash of the bytes', 'hash', good, {
    messageHash: 'ab'.repeat(32),
  }),
  deposit('a preview that states a trade the step does not make', 'preview', good, {
    preview: { ...solanaTx(swapStep, { payload: '', messageHash: '' }).preview },
  }),
  {
    name: 'a preview that states another minimum than the step, over honest bytes',
    check: 'preview',
    input: async () => {
      const tx = solanaTx(swapStep, wire(await honest.swap()));
      const minimums = [{ ...TRADE, minOutRaw: '1' }];
      return {
        step: swapStep,
        tx: { ...tx, preview: { ...tx.preview, minimums } },
        deployment: SOLANA,
      };
    },
  },
  deposit('an owner that is not the person', 'owner', () =>
    honest.deposit(BASKET_PROGRAM, CASH, {
      accounts: { owner: STRANGER },
      flags: { owner: { signer: false, writable: false } },
    }),
  ),
  deposit("a config account that is not the program's", 'accounts', () =>
    honest.deposit(BASKET_PROGRAM, CASH, { accounts: { config: someone('their config') } }),
  ),
  deposit("a vault token account that is not the vault's own", 'accounts', () =>
    honest.deposit(BASKET_PROGRAM, CASH, { accounts: { vault_token_account: someone('theirs') } }),
  ),
  deposit('the wrong token program for the token', 'accounts', () =>
    honest.deposit(BASKET_PROGRAM, CASH, { accounts: { token_program: TOKEN_2022 } }),
  ),
  deposit('an account more than the instruction takes', 'accounts', () =>
    honest.deposit(BASKET_PROGRAM, CASH, { extra: [{ address: STRANGER, writable: true }] }),
  ),
  deposit('an account fewer than the instruction takes', 'accounts', async () => {
    const whole = await depositIx(BASKET_PROGRAM, CASH);
    return [{ ...whole, accounts: whole.accounts?.slice(0, -1) }];
  }),
  swap("the person's own key passed on to the router", 'accounts', () =>
    honest.swap(TRADE, { extra: [{ address: OWNER, writable: true }] }),
  ),
  {
    name: 'a named account loaded from a lookup table, where the bytes do not show its address',
    check: 'accounts',
    input: async () =>
      input(swapStep, wire(await honest.swap(), { tables: { [someone('table')]: [CONFIG] } })),
  },
  swap('a trade that buys another token', 'asset', () =>
    honest.swap(TRADE, { accounts: { output_mint: mintOf('solana:gold') } }),
  ),
  swap('a trade that sells another token', 'asset', () =>
    honest.swap(TRADE, { accounts: { input_mint: mintOf('solana:gold') } }),
  ),
  {
    name: 'a withdrawal of another token than the step names',
    check: 'asset',
    input: async () =>
      input(
        withdrawStep,
        wire(
          await honest.withdraw(BASKET_PROGRAM, '5000000', {
            accounts: { mint: mintOf('solana:gold') },
          }),
        ),
      ),
  },
  swap('a trade through another exchange', 'router', () =>
    honest.swap(TRADE, { accounts: { router_program: someone('their router') } }),
  ),
  {
    name: 'other weights than the plan',
    check: 'targets',
    input: async () =>
      input(
        createStep,
        wire(
          await honest.create(BASKET_PROGRAM, createStep, {
            targets: [
              { asset: 'solana:spy', weightBps: 4000 },
              { asset: 'solana:gold', weightBps: 6000 },
            ],
          }),
        ),
      ),
  },
  {
    name: 'a target the plan does not have',
    check: 'targets',
    input: async () =>
      input(
        createStep,
        wire(
          await honest.create(BASKET_PROGRAM, createStep, {
            targets: [...TARGETS, { asset: 'solana:usdc', weightBps: 1 }],
          }),
        ),
      ),
  },
  {
    name: 'a target left out',
    check: 'targets',
    input: async () =>
      input(
        createStep,
        wire(await honest.create(BASKET_PROGRAM, createStep, { targets: TARGETS.slice(1) })),
      ),
  },
  {
    name: 'targets of its own in a create that follows',
    check: 'targets',
    input: async () =>
      input(
        followStep,
        wire(await honest.create(BASKET_PROGRAM, followStep, { targets: TARGETS })),
      ),
  },
  {
    name: 'another shared portfolio than the one reviewed',
    check: 'version',
    input: async () =>
      input(
        followStep,
        wire(await honest.create(BASKET_PROGRAM, followStep, { recipe: someone('theirs') })),
      ),
  },
  {
    name: 'another version than the one reviewed',
    check: 'version',
    input: async () =>
      input(
        followStep,
        wire(await honest.create(BASKET_PROGRAM, followStep, { expectedVersion: 4 })),
      ),
  },
  {
    name: 'a shared portfolio in a create that follows none',
    check: 'version',
    input: async () =>
      input(createStep, wire(await honest.create(BASKET_PROGRAM, createStep, { recipe: RECIPE }))),
  },
  {
    name: 'an accept of another version',
    check: 'version',
    input: () => input(acceptStep, wire([acceptIx({ version: 5 })]), {}, ['new_asset']),
  },
  {
    name: 'an accept of another shared portfolio',
    check: 'version',
    input: () => input(acceptStep, wire([acceptIx({ recipe: STRANGER })]), {}, ['new_asset']),
  },
  {
    name: 'an accept where the step switches auto-follow',
    check: 'instruction',
    input: () => input(autoStep(false), wire([acceptIx()]), {}, ['new_asset']),
  },
  deposit('a unit price that burns the wallet as fees', 'fee', async () => [
    unitLimitIx(1_400_000),
    unitPriceIx(1_000_000_000_000n),
    await depositIx(BASKET_PROGRAM, CASH),
  ]),
  deposit(
    'a unit price with no limit, charged on the most a transaction may use',
    'fee',
    async () => [unitPriceIx(4_000_000n), await depositIx(BASKET_PROGRAM, CASH)],
  ),
];

describe('the guard on Solana: each negative is refused, and by the check that names it', () => {
  eachBites(negatives);

  it('covers every check that reads Solana bytes', () => {
    const covered = new Set(negatives.map((n) => n.check));
    for (const check of [
      'step',
      'chain',
      'network',
      'signer',
      'hash',
      'preview',
      'consent',
      'fee',
      'amount',
      'minimum',
      'asset',
      'targets',
      'auto_follow',
      'version',
      'vault',
      'router',
      'program',
      'instruction',
      'budget',
      'token_account',
      'owner',
      'accounts',
      'recipient',
    ] satisfies GuardCheck[])
      expect(covered.has(check), check).toBe(true);
  });
});

describe("the guard on Solana: the fee ceiling is the deployment's", () => {
  it('passes a price under a higher ceiling and refuses it under the default', async () => {
    const bytes = wire([
      unitLimitIx(1_000_000),
      unitPriceIx(6_000_000n),
      await depositIx(BASKET_PROGRAM, CASH),
    ]);
    expect(refusalOf(() => guardTransaction(input(depositStep, bytes)))?.code).toBe('fee');
    const roomy = solanaDeployment({ fee: { maxFeeNativeRaw: '10000000' } });
    expect(
      refusalOf(() => guardTransaction({ ...input(depositStep, bytes), deployment: roomy })),
    ).toBeNull();
  });
});
