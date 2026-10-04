import { BasketTx, type ConsentKind } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { eachBites, type Negative, refusalOf } from '../../../test/bites';
import {
  anyone,
  BASKET_ID,
  CHAIN_ID,
  call,
  calls,
  EVM,
  type EvmCallOf,
  evmDeployment,
  evmTx,
  FACTORY,
  MAX,
  NEXT_INTERFACE,
  OWNER,
  ROUTER,
  STRANGER,
  SWAPS,
  swapOf,
  tokenOf,
  VAULT,
  WEIGHTS,
  weights,
  ZERO32,
} from '../../../test/evm';
import vectors from '../../../test/fixtures/evm-vectors.json';
import { withRules } from '../../../test/rules';
import { guardTransaction, isGuarded } from '../index';
import type { GuardCheck } from '../refusal';
import { runGuard } from '../run';
import type { ApprovedStep, GuardInput } from '../types';
import { evmVaultAddress } from './addresses';

vi.mock('../rules', () => import('../../../test/rules'));
vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));

// The guard on EVM call data. The honest calls pass; each negative differs from its step in one way and
// is refused by the one check that names it (see test/bites.ts).

const base = { legId: 'leg-1', chain: 'robinhood', owner: OWNER, basketId: BASKET_ID } as const;
const CASH = '1000000000';
const TARGETS = [
  { asset: 'robinhood:spy', weightBps: 6000 },
  { asset: 'robinhood:gold', weightBps: 3500 },
];
const SPY = { sell: 'robinhood:usdc', buy: 'robinhood:spy', inRaw: '600000000', minOutRaw: '594' };
const GOLD = { sell: 'robinhood:usdc', buy: 'robinhood:gold', inRaw: '350000000', minOutRaw: '17' };
const INDEX = `0x${'5a'.repeat(32)}`;
const USDC = tokenOf('robinhood:usdc');

type Step<K extends ApprovedStep['kind']> = Extract<ApprovedStep, { kind: K }>;
const approveStep: Step<'approve'> = { ...base, kind: 'approve', amountRaw: CASH };
const createStep: Step<'create_vault'> = {
  ...base,
  kind: 'create_vault',
  targets: TARGETS,
  follow: null,
  autoFollow: false,
  depositRaw: CASH,
  trades: [SPY, GOLD],
};
const followStep: Step<'create_vault'> = {
  ...createStep,
  targets: [],
  follow: { recipeOnchainId: INDEX, version: 3 },
};
const depositStep: Step<'deposit'> = { ...base, kind: 'deposit', amountRaw: CASH, trades: [SPY] };
const swapStep: Step<'swap'> = { ...base, kind: 'swap', trades: [SPY, GOLD] };
const targetsStep: Step<'set_targets'> = { ...base, kind: 'set_targets', targets: TARGETS };
const withdrawStep: Step<'withdraw'> = {
  ...base,
  kind: 'withdraw',
  withdrawals: [{ asset: 'robinhood:spy', amountRaw: '500' }],
};
const withdrawAllStep: Step<'withdraw'> = { ...base, kind: 'withdraw', withdrawals: 'all' };
const acceptStep: Step<'accept_version'> = {
  ...base,
  kind: 'accept_version',
  follow: { recipeOnchainId: INDEX, version: 4 },
};
const autoStep = (on: boolean): Step<'set_auto_follow'> => ({
  ...base,
  kind: 'set_auto_follow',
  on,
});

/** What a builder of each step would send. */
const honest = {
  approve: (): EvmCallOf => ({ to: USDC, data: calls.approve(VAULT, BigInt(CASH)) }),
  create: (
    step = createStep,
    change: Partial<Parameters<typeof calls.createVaultAndBuy>[0]> = {},
  ) => ({
    to: FACTORY,
    data: calls.createVaultAndBuy({
      targets: weights(step.targets),
      ...(step.follow
        ? { indexId: step.follow.recipeOnchainId, version: step.follow.version }
        : {}),
      autoFollow: step.autoFollow,
      cash: step.depositRaw,
      swaps: step.trades.map((t) => swapOf(t)),
      ...change,
    }),
  }),
  deposit: (inner = [calls.deposit(CASH), calls.ownerSwap([swapOf(SPY)])]): EvmCallOf => ({
    to: VAULT,
    data: calls.multicall(inner),
  }),
  swap: (swaps = [swapOf(SPY), swapOf(GOLD)]): EvmCallOf => ({
    to: VAULT,
    data: calls.ownerSwap(swaps),
  }),
  withdraw: (token = tokenOf('robinhood:spy'), amount = '500'): EvmCallOf => ({
    to: VAULT,
    data: calls.withdraw(token, amount),
  }),
};

const input = (
  step: ApprovedStep,
  c: EvmCallOf,
  over: Partial<BasketTx> = {},
  consents: ConsentKind[] = [],
): GuardInput => ({ step, tx: evmTx(step, c, over), deployment: EVM, consents });
const NEXT = { evmInterface: NEXT_INTERFACE };

describe('the guard on EVM: an honest call passes', () => {
  it("the vault it derives is the factory's, as viem worked it out", () => {
    expect(evmVaultAddress(EVM, OWNER, BASKET_ID)).toBe(VAULT);
    expect(evmVaultAddress(EVM, STRANGER, BASKET_ID)).not.toBe(VAULT);
  });

  it('with the ABIs as committed: every step the contracts have today', () => {
    const allCash = { ...createStep, targets: [], trades: [] };
    const cases: [ApprovedStep, EvmCallOf][] = [
      [approveStep, honest.approve()],
      [createStep, honest.create()],
      [followStep, honest.create(followStep)],
      // A plan that is all cash: a create that buys nothing.
      [allCash, honest.create(allCash)],
      [
        { ...allCash, depositRaw: '0' },
        { to: FACTORY, data: calls.createVault({ targets: [] }) },
      ],
      [depositStep, honest.deposit()],
      [
        { ...depositStep, trades: [] },
        { to: VAULT, data: calls.deposit(CASH) },
      ],
      [swapStep, honest.swap()],
      // The same trades as two calls inside one.
      [
        swapStep,
        {
          to: VAULT,
          data: calls.multicall([calls.ownerSwap([swapOf(SPY)]), calls.ownerSwap([swapOf(GOLD)])]),
        },
      ],
      [targetsStep, { to: VAULT, data: calls.setTargets(weights(TARGETS)) }],
      [withdrawStep, honest.withdraw()],
      [withdrawAllStep, { to: VAULT, data: calls.withdrawAll() }],
      // Everything, token by token: one the deployment lists, and one the caller knows the vault holds.
      [
        { ...withdrawAllStep, held: [{ address: STRANGER }] },
        {
          to: VAULT,
          data: calls.multicall([calls.withdraw(USDC, 1n), calls.withdraw(STRANGER, 2n)]),
        },
      ],
    ];
    for (const [step, c] of cases) {
      const given = input(step, c);
      expect(BasketTx.safeParse(given.tx).success, step.kind).toBe(true);
      expect(refusalOf(() => guardTransaction(given))?.message ?? null, step.kind).toBeNull();
      expect(isGuarded(guardTransaction(given))).toBe(true);
    }
  });

  it('a target in upper case, and a deployment file written with checksums', () => {
    const upper = (address: string) => `0x${address.slice(2).toUpperCase()}`;
    const given = input(approveStep, { ...honest.approve(), to: upper(USDC) });
    // The factory and the beacon as viem writes them, in mixed case (EIP-55).
    const [factory, beacon] = [FACTORY, EVM.beacon].map(
      (lower) => vectors.checksums.find((c) => c.lower === lower)?.checksummed as string,
    );
    expect(factory).not.toBe(FACTORY);
    const deployment = evmDeployment({ factory, beacon });
    expect(deployment.factory).toBe(FACTORY);
    expect(refusalOf(() => guardTransaction({ ...given, deployment }))).toBeNull();
  });

  it("with the keeper path's two owner functions: an accept, and the switch both ways", () => {
    const cases: [ApprovedStep, Uint8Array, ConsentKind[]][] = [
      [acceptStep, calls.acceptVersion(INDEX, 4), ['new_asset']],
      [autoStep(true), calls.setAutoFollow(true), ['auto_follow_on']],
      [autoStep(false), calls.setAutoFollow(false), []],
    ];
    for (const [step, data, consents] of cases)
      expect(
        refusalOf(() =>
          withRules(NEXT, () => runGuard(input(step, { to: VAULT, data }, {}, consents))),
        )?.message ?? null,
        step.kind,
      ).toBeNull();
  });
});

describe('the guard on EVM: what the committed ABIs cannot check yet', () => {
  it('refuses an accept and the auto-follow switch as unsupported, until the table has them', () => {
    const cases: [ApprovedStep, Uint8Array][] = [
      [acceptStep, calls.acceptVersion(INDEX, 4)],
      [autoStep(false), calls.setAutoFollow(false)],
    ];
    for (const [step, data] of cases) {
      const refusal = refusalOf(() =>
        guardTransaction(input(step, { to: VAULT, data }, {}, ['new_asset', 'auto_follow_on'])),
      );
      expect(refusal?.code, step.kind).toBe('unsupported');
      expect(refusal?.message).toMatch(/regenerated/);
    }
  });

  it('refuses a step that names a token the deployment does not list', () => {
    const step = { ...targetsStep, targets: [{ asset: 'robinhood:tsla', weightBps: 100 }] };
    const refusal = refusalOf(() =>
      guardTransaction(input(step, { to: VAULT, data: calls.setTargets([]) })),
    );
    expect(refusal?.code).toBe('unsupported');
    expect(refusal?.message).toMatch(/robinhood:tsla/);
  });
});

describe('the guard on EVM: call data that cannot be read is refused as malformed', () => {
  it('cut short, with a byte left over, spelled another way, or nested too deep', () => {
    const good = honest.swap().data;
    let nested = calls.deposit(CASH);
    for (let i = 0; i < 4; i += 1) nested = calls.multicall([nested]);
    const cases: [string, ApprovedStep, Partial<BasketTx> | EvmCallOf][] = [
      ['cut short', swapStep, { to: VAULT, data: good.slice(0, good.length - 1) }],
      ['a byte left over', swapStep, { to: VAULT, data: Uint8Array.from([...good, 0]) }],
      ['no selector', swapStep, { to: VAULT, data: Uint8Array.of(1, 2, 3) }],
      [
        'nested deeper than the guard opens',
        { ...depositStep, trades: [] },
        { to: VAULT, data: nested },
      ],
    ];
    for (const [name, step, c] of cases)
      expect(refusalOf(() => guardTransaction(input(step, c as EvmCallOf)))?.code, name).toBe(
        'malformed',
      );
    const tx = evmTx(swapStep, honest.swap());
    for (const [name, change] of [
      ['half a byte of hex', { payload: `${tx.payload}0` }],
      ['no 0x', { payload: tx.payload.slice(2) }],
      ['no EVM call', { evm: undefined }],
      ['a target that is no address', { evm: { ...tx.evm, to: '0x1234' } }],
      ['a value that is not raw units', { evm: { ...tx.evm, value: '0x0' } }],
    ] as const)
      expect(
        refusalOf(() =>
          guardTransaction({
            step: swapStep,
            tx: { ...tx, ...change } as BasketTx,
            deployment: EVM,
          }),
        )?.code,
        name,
      ).toBe('malformed');
  });

  it('a multicall three deep is still opened', () => {
    let nested = calls.deposit(CASH);
    for (let i = 0; i < 3; i += 1) nested = calls.multicall([nested]);
    expect(
      refusalOf(() =>
        guardTransaction(input({ ...depositStep, trades: [] }, { to: VAULT, data: nested })),
      ),
    ).toBeNull();
  });
});

const on = (
  step: ApprovedStep,
  name: string,
  check: GuardCheck,
  c: () => EvmCallOf,
  over: Partial<BasketTx> = {},
): Negative => ({ name, check, input: () => input(step, c(), over) });
const next = (
  step: ApprovedStep,
  name: string,
  check: GuardCheck,
  data: () => Uint8Array,
  consents: ConsentKind[] = [],
): Negative => ({
  name,
  check,
  rules: NEXT,
  input: () => input(step, { to: VAULT, data: data() }, {}, consents),
});
const strangersVault = () => evmVaultAddress(EVM, STRANGER, BASKET_ID);
const transfer = (to: string, amount: bigint) => call('transfer(address,uint256)', [to, amount]);

const negatives: Negative[] = [
  // ---- G-LINK: a wrong spender
  on(approveStep, 'an approval of the factory', 'spender', () => ({
    to: USDC,
    data: calls.approve(FACTORY, BigInt(CASH)),
  })),
  on(approveStep, 'an approval of a stranger', 'spender', () => ({
    to: USDC,
    data: calls.approve(STRANGER, BigInt(CASH)),
  })),
  on(approveStep, "an approval of another person's vault", 'spender', () => ({
    to: USDC,
    data: calls.approve(strangersVault(), BigInt(CASH)),
  })),
  on(approveStep, "an approval of the person's vault for another plan", 'spender', () => ({
    to: USDC,
    data: calls.approve(evmVaultAddress(EVM, OWNER, '1'), BigInt(CASH)),
  })),

  // ---- G-LINK: setOperator
  on(depositStep, 'setOperator beside the deposit, inside one call', 'function', () =>
    honest.deposit([
      calls.deposit(CASH),
      calls.ownerSwap([swapOf(SPY)]),
      calls.setOperator(STRANGER),
    ]),
  ),

  // ---- G-LINK: auto-follow without consent
  on(
    { ...createStep, autoFollow: true },
    'a create that switches auto-follow on, with no consent handed over',
    'consent',
    () => honest.create({ ...createStep, autoFollow: true }),
  ),
  next(
    autoStep(true),
    'the auto-follow switch turned on, with no consent handed over',
    'consent',
    () => calls.setAutoFollow(true),
  ),
  next(acceptStep, 'a version accepted with no consent handed over', 'consent', () =>
    calls.acceptVersion(INDEX, 4),
  ),
  on(
    createStep,
    'bytes that switch auto-follow on in a create the person approved with it off',
    'auto_follow',
    () => honest.create(createStep, { autoFollow: true }),
  ),
  next(
    autoStep(false),
    'bytes that switch auto-follow on where the step switches it off',
    'auto_follow',
    () => calls.setAutoFollow(true),
  ),

  // ---- G-LINK: a swap whose minimum differs from the screen
  on(swapStep, 'a lower minimum', 'minimum', () =>
    honest.swap([swapOf({ ...SPY, minOutRaw: '1' }), swapOf(GOLD)]),
  ),
  on(swapStep, 'a minimum of nothing on the second trade', 'minimum', () =>
    honest.swap([swapOf(SPY), swapOf({ ...GOLD, minOutRaw: '0' })]),
  ),
  on(swapStep, 'a higher minimum', 'minimum', () =>
    honest.swap([swapOf({ ...SPY, minOutRaw: '595' }), swapOf(GOLD)]),
  ),
  on(createStep, 'a lower minimum on a trade inside the create', 'minimum', () =>
    honest.create(createStep, { swaps: [swapOf({ ...SPY, minOutRaw: '1' }), swapOf(GOLD)] }),
  ),
  on(depositStep, 'a lower minimum on a trade beside the deposit', 'minimum', () =>
    honest.deposit([calls.deposit(CASH), calls.ownerSwap([swapOf({ ...SPY, minOutRaw: '1' })])]),
  ),

  // ---- G-LINK: a withdraw built for a third party. A vault pays only its owner, so the bytes have to
  // go around it: another vault, the token itself, or a function that is not a withdrawal.
  on(withdrawStep, "a withdrawal from another person's vault", 'target', () => ({
    ...honest.withdraw(),
    to: strangersVault(),
  })),
  on(withdrawStep, 'a token transfer to a stranger in place of the withdrawal', 'target', () => ({
    to: tokenOf('robinhood:spy'),
    data: calls.withdraw(tokenOf('robinhood:spy'), '500'),
  })),
  on(
    withdrawStep,
    'a transfer to a stranger asked of the vault, beside the withdrawal',
    'function',
    () => ({
      to: VAULT,
      data: calls.multicall([honest.withdraw().data, transfer(STRANGER, 500n)]),
    }),
  ),

  // ---- a larger amount, and an approval of everything
  on(approveStep, 'a larger approval', 'amount', () => ({
    to: USDC,
    data: calls.approve(VAULT, BigInt(CASH) + 1n),
  })),
  on(
    { ...approveStep, amountRaw: MAX.toString() },
    'an approval of everything, as the order itself asks',
    'unlimited',
    () => ({
      to: USDC,
      data: calls.approve(VAULT, MAX),
    }),
  ),
  on(
    { ...approveStep, amountRaw: (1n << 255n).toString() },
    'an approval of half of everything',
    'unlimited',
    () => ({
      to: USDC,
      data: calls.approve(VAULT, 1n << 255n),
    }),
  ),
  on(depositStep, 'a larger deposit', 'amount', () =>
    honest.deposit([calls.deposit('1000000001'), calls.ownerSwap([swapOf(SPY)])]),
  ),
  on(createStep, 'a larger deposit inside the create', 'amount', () =>
    honest.create(createStep, { cash: '2000000000' }),
  ),
  on(swapStep, 'a trade that sells more', 'amount', () =>
    honest.swap([swapOf({ ...SPY, inRaw: '600000001' }), swapOf(GOLD)]),
  ),
  on(withdrawStep, 'a larger withdrawal than the step names', 'amount', () =>
    honest.withdraw(tokenOf('robinhood:spy'), '501'),
  ),

  // ---- an extra call
  on(depositStep, 'a withdrawal after the deposit', 'calls', () =>
    honest.deposit([
      calls.deposit(CASH),
      calls.ownerSwap([swapOf(SPY)]),
      calls.withdraw(USDC, '1'),
    ]),
  ),
  on(depositStep, 'the deposit twice', 'calls', () =>
    honest.deposit([calls.deposit(CASH), calls.deposit(CASH), calls.ownerSwap([swapOf(SPY)])]),
  ),
  on(depositStep, 'the trade left out', 'calls', () => honest.deposit([calls.deposit(CASH)])),
  on(swapStep, 'a third trade', 'calls', () =>
    honest.swap([swapOf(SPY), swapOf(GOLD), swapOf(SPY)]),
  ),
  on(swapStep, 'a swap call that makes no trade, beside the real one', 'calls', () => ({
    to: VAULT,
    data: calls.multicall([calls.ownerSwap([swapOf(SPY), swapOf(GOLD)]), calls.ownerSwap([])]),
  })),
  on(createStep, 'a create with one trade more', 'calls', () =>
    honest.create(createStep, { swaps: [swapOf(SPY), swapOf(GOLD), swapOf(SPY)] }),
  ),
  on(createStep, 'a create that leaves the trades out', 'calls', () => ({
    to: FACTORY,
    data: calls.createVaultAndBuy({ targets: weights(TARGETS), cash: CASH, swaps: [] }),
  })),
  on(withdrawAllStep, 'a deposit among the withdrawals of everything', 'calls', () => ({
    to: VAULT,
    data: calls.multicall([calls.withdraw(USDC, 1n), calls.deposit(1n)]),
  })),

  // ---- a different vault
  on(depositStep, "a deposit into another person's vault", 'target', () => ({
    ...honest.deposit(),
    to: strangersVault(),
  })),
  on(depositStep, "a deposit into the person's vault for another plan", 'target', () => ({
    ...honest.deposit(),
    to: evmVaultAddress(EVM, OWNER, '1'),
  })),
  on(createStep, 'a create for another plan number', 'vault', () =>
    honest.create(createStep, { planId: `0x${'0'.repeat(63)}1` }),
  ),

  // ---- a different chain, a different network
  on(depositStep, 'a call for another chain id', 'network', () => ({
    ...honest.deposit(),
    chainId: 4663,
  })),
  on(
    depositStep,
    'a transaction labelled for mainnet on a test network',
    'network',
    honest.deposit,
    {
      provenance: 'live',
    },
  ),
  on(depositStep, 'a transaction that says it is for another chain', 'chain', honest.deposit, {
    chainId: 'base',
  }),
  on(depositStep, 'a transaction of the other wallet family', 'chain', honest.deposit, {
    chain: 'solana',
  }),

  // ---- a call to an unknown contract
  on(approveStep, 'an approval sent to another token', 'target', () => ({
    ...honest.approve(),
    to: tokenOf('robinhood:spy'),
  })),
  on(approveStep, 'an approval sent to a contract nobody knows', 'target', () => ({
    ...honest.approve(),
    to: anyone('a contract'),
  })),
  on(createStep, 'a create through a helper contract, which would own the vault', 'target', () => ({
    ...honest.create(),
    to: anyone('a helper'),
  })),
  on(swapStep, 'a trade sent straight to the router', 'target', () => ({
    ...honest.swap(),
    to: ROUTER,
  })),

  // ---- the rest of what a call can get wrong, one at a time
  on(depositStep, 'a call that sends native value', 'value', () => ({
    ...honest.deposit(),
    value: '1',
  })),
  on(swapStep, 'a function no interface names, beside the trades', 'function', () => ({
    to: VAULT,
    data: calls.multicall([honest.swap().data, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)]),
  })),
  on(swapStep, "the factory's own call into a new vault, beside the trades", 'function', () => ({
    to: VAULT,
    data: calls.multicall([
      honest.swap().data,
      call('initialize(address,bytes32)', [STRANGER, ZERO32]),
    ]),
  })),
  on(
    approveStep,
    'a transfer of the cash to a stranger in place of the approval',
    'function',
    () => ({
      to: USDC,
      data: transfer(STRANGER, BigInt(CASH)),
    }),
  ),
  on(createStep, 'a setting of the factory in place of the create', 'function', () => ({
    to: FACTORY,
    data: call('setRouter(address,uint8)', [STRANGER, 1n]),
  })),
  on(swapStep, 'a trade that buys another token', 'asset', () =>
    honest.swap([swapOf(SPY, { tokenOut: tokenOf('robinhood:gold') }), swapOf(GOLD)]),
  ),
  on(swapStep, 'a trade that sells another token', 'asset', () =>
    honest.swap([swapOf(SPY, { tokenIn: tokenOf('robinhood:gold') }), swapOf(GOLD)]),
  ),
  on(
    withdrawAllStep,
    'a withdrawal of everything that names a token nobody listed',
    'asset',
    () => ({
      to: VAULT,
      data: calls.multicall([calls.withdraw(USDC, 1n), calls.withdraw(STRANGER, 2n)]),
    }),
  ),
  on(withdrawAllStep, 'a withdrawal of everything that takes one token twice', 'asset', () => ({
    to: VAULT,
    data: calls.multicall([calls.withdraw(USDC, 1n), calls.withdraw(USDC, 2n)]),
  })),
  on(withdrawStep, 'a withdrawal of another token than the step names', 'asset', () =>
    honest.withdraw(USDC, '500'),
  ),
  on(swapStep, 'a trade through an exchange the deployment does not name', 'router', () =>
    honest.swap([swapOf(SPY, { router: STRANGER }), swapOf(GOLD)]),
  ),
  on(createStep, 'other weights than the plan', 'targets', () =>
    honest.create(createStep, {
      targets: weights([
        { asset: 'robinhood:spy', weightBps: 3500 },
        { asset: 'robinhood:gold', weightBps: 6000 },
      ]),
    }),
  ),
  on(createStep, 'a target the plan does not have', 'targets', () =>
    honest.create(createStep, {
      targets: weights([...TARGETS, { asset: 'robinhood:usdc', weightBps: 1 }]),
    }),
  ),
  on(targetsStep, 'a target left out', 'targets', () => ({
    to: VAULT,
    data: calls.setTargets(weights(TARGETS.slice(1))),
  })),
  on(followStep, 'targets of its own in a create that follows', 'targets', () =>
    honest.create(followStep, { targets: weights(TARGETS) }),
  ),
  on(followStep, 'another shared portfolio than the one reviewed', 'version', () =>
    honest.create(followStep, { indexId: `0x${'6b'.repeat(32)}` }),
  ),
  on(followStep, 'another version than the one reviewed', 'version', () =>
    honest.create(followStep, { version: 4 }),
  ),
  on(createStep, 'a shared portfolio in a create that follows none', 'version', () =>
    honest.create(createStep, { indexId: INDEX }),
  ),
  next(acceptStep, 'an accept of another version', 'version', () => calls.acceptVersion(INDEX, 5), [
    'new_asset',
  ]),
  on(depositStep, 'a gas limit the wallet would pay for', 'fee', () => ({
    ...honest.deposit(),
    gas: 30_000_000,
  })),
  on(depositStep, 'a stated fee the wallet would take as its guide', 'fee', honest.deposit, {
    preview: {
      ...evmTx(depositStep, honest.deposit()).preview,
      feeNativeRaw: '5000000000000000000',
    },
  }),
  on(depositStep, 'a transaction for another kind of step', 'step', honest.deposit, {
    legKind: 'swap',
  }),
  on(depositStep, 'a transaction built for another leg', 'step', honest.deposit, {
    legId: 'leg-2',
  }),
  on(depositStep, 'a transaction that names a stranger as its signer', 'signer', honest.deposit, {
    signer: STRANGER,
  }),
  on(depositStep, 'a message hash that is not the hash of the call', 'hash', honest.deposit, {
    messageHash: 'ab'.repeat(32),
  }),
  on(
    depositStep,
    'a preview that states another minimum than the step, over honest bytes',
    'preview',
    honest.deposit,
    {
      preview: {
        ...evmTx(depositStep, honest.deposit()).preview,
        minimums: [{ ...SPY, minOutRaw: '1' }],
      },
    },
  ),
];

describe('the guard on EVM: each negative is refused, and by the check that names it', () => {
  eachBites(negatives);

  it('covers every check that reads EVM call data', () => {
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
      'value',
      'target',
      'function',
      'calls',
      'spender',
      'unlimited',
    ] satisfies GuardCheck[])
      expect(covered.has(check), check).toBe(true);
  });
});

describe('the guard on EVM: it passes a call, and only the fields it read', () => {
  // On EVM the guard passes a call: a target, a value, a chain id and call data. A field beside those
  // is one it never read, so it refuses the transaction rather than hand the field on to a signer.
  const stowaways: [string, object, object][] = [
    [
      'an authorization list',
      {},
      { authorizationList: [{ chainId: 0, address: STRANGER, nonce: 0 }] },
    ],
    ['an access list', {}, { accessList: [{ address: STRANGER, storageKeys: [] }] }],
    ['a fee per gas', {}, { maxFeePerGas: '1000000000000000000' }],
    ['a priority fee', {}, { maxPriorityFeePerGas: '1000000000000000000' }],
    ['a gas price', {}, { gasPrice: '1000000000000000000' }],
    ['a transaction type', {}, { type: 'eip7702' }],
    ['a sender', {}, { from: STRANGER }],
    ['a second data', {}, { data: '0xdeadbeef' }],
    ['an input', {}, { input: '0xdeadbeef' }],
    ['an access list beside the call', { accessList: [] }, {}],
    ['raw bytes beside the call', { rawTransaction: '0x02ff' }, {}],
    [
      'a field of the preview nobody reads',
      { preview: { ...evmTx(approveStep, honest.approve()).preview, note: 'x' } },
      {},
    ],
    [
      'a field of a minimum nobody reads',
      {
        preview: {
          ...evmTx(swapStep, honest.swap()).preview,
          minimums: [{ ...SPY, router: STRANGER }, GOLD],
        },
      },
      {},
    ],
  ];
  for (const [name, top, inEvm] of stowaways)
    it(`refuses ${name}`, () => {
      const step = name.includes('minimum') ? swapStep : approveStep;
      const tx = evmTx(step, step === swapStep ? honest.swap() : honest.approve());
      const given = { ...tx, ...top, evm: { ...tx.evm, ...inEvm } } as BasketTx;
      const refusal = refusalOf(() => guardTransaction({ step, tx: given, deployment: EVM }));
      expect(refusal?.code).toBe('malformed');
      expect(refusal?.message).toMatch(/does not read/);
    });

  it('the pass carries exactly the fields of the transaction that were read, and a copy of them', () => {
    const tx = evmTx(approveStep, honest.approve());
    const pass = guardTransaction({ step: approveStep, tx, deployment: EVM });
    expect(pass.tx).toEqual(tx);
    expect(pass.tx).not.toBe(tx);
    expect(Object.keys(pass.tx.evm ?? {}).sort()).toEqual([
      'chainId',
      'gas',
      'nonce',
      'to',
      'value',
    ]);
    expect(Object.isFrozen(pass.tx.evm) && Object.isFrozen(pass.tx.preview.minimums)).toBe(true);
    // A field that is there and undefined is as good as absent.
    const sparse = { ...tx, feePayer: undefined, lastValidBlockHeight: undefined } as BasketTx;
    expect(
      Object.keys(guardTransaction({ step: approveStep, tx: sparse, deployment: EVM }).tx),
    ).not.toContain('feePayer');
  });

  it('refuses fields of the wrong type: a gas limit, a nonce and a change that cannot be read', () => {
    const tx = evmTx(approveStep, honest.approve());
    for (const change of [
      { evm: { ...tx.evm, gas: '400000' } },
      { evm: { ...tx.evm, nonce: -1 } },
      { evm: { ...tx.evm, chainId: 1.5 } },
      { attemptId: '' },
      { description: 7 },
      { lastValidBlockHeight: '1000' },
      { preview: { ...tx.preview, simulated: 'yes' } },
      {
        preview: {
          ...tx.preview,
          changes: [{ holder: 'stranger', asset: 'robinhood:usdc', deltaRaw: '1' }],
        },
      },
      {
        preview: {
          ...tx.preview,
          changes: [{ holder: 'wallet', asset: 'robinhood:usdc', deltaRaw: '1.5' }],
        },
      },
    ])
      expect(
        refusalOf(() =>
          guardTransaction({
            step: approveStep,
            tx: { ...tx, ...change } as never,
            deployment: EVM,
          }),
        )?.code,
        JSON.stringify(change).slice(0, 60),
      ).toBe('malformed');
  });
});

describe('the guard on EVM: a call replaced outright is refused too', () => {
  // These differ from the step in two ways at once (the step's own call is gone and another is in its
  // place), so two checks would each refuse them. The first to speak is the one named.
  const replaced: [string, GuardCheck, ApprovedStep, EvmCallOf][] = [
    [
      'setOperator in place of the step',
      'function',
      targetsStep,
      { to: VAULT, data: calls.setOperator(STRANGER) },
    ],
    [
      'a transfer to a stranger asked of the vault',
      'function',
      withdrawStep,
      { to: VAULT, data: transfer(STRANGER, 500n) },
    ],
    [
      'a function no interface names',
      'function',
      swapStep,
      { to: VAULT, data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) },
    ],
    [
      "the factory's own call into a new vault",
      'function',
      swapStep,
      { to: VAULT, data: call('initialize(address,bytes32)', [STRANGER, ZERO32]) },
    ],
    [
      "the factory's start, asked of the vault",
      'function',
      depositStep,
      {
        to: VAULT,
        data: call(`start(bytes32,uint32,${WEIGHTS},uint256,${SWAPS})`, [ZERO32, 0n, [], 1n, []]),
      },
    ],
    [
      'an approval of everything where the step names an amount',
      'amount',
      approveStep,
      { to: USDC, data: calls.approve(VAULT, MAX) },
    ],
    [
      'a withdrawal of everything where the step is a deposit',
      'calls',
      depositStep,
      { to: VAULT, data: calls.withdrawAll() },
    ],
  ];
  for (const [name, check, step, c] of replaced)
    it(`${check}: ${name}`, () => {
      expect(refusalOf(() => guardTransaction(input(step, c)))?.code).toBe(check);
    });
});

describe("the guard on EVM: the ceilings are the deployment's", () => {
  it('passes a gas limit and a stated fee under higher ceilings', () => {
    const given = input(depositStep, { ...honest.deposit(), gas: 6_000_000 });
    expect(refusalOf(() => guardTransaction(given))?.code).toBe('fee');
    const roomy = evmDeployment({
      fee: { maxFeeNativeRaw: '1000000000000000', maxGas: 8_000_000 },
    });
    expect(refusalOf(() => guardTransaction({ ...given, deployment: roomy }))).toBeNull();
    expect(CHAIN_ID).toBe(EVM.evmChainId);
  });
});
