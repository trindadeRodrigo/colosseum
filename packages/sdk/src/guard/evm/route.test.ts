import type { BasketTx } from '@colosseum/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDeploymentFiles } from '../../../scripts/sources';
import { eachBites, type Negative, refusalOf } from '../../../test/bites';
import { withFile } from '../../../test/deployments';
import {
  BASKET_ID,
  calls,
  DEADLINE,
  EVM,
  type EvmCallOf,
  evmDeployment,
  evmTx,
  now,
  OWNER,
  POOL,
  ROUTER,
  type RouteOf,
  routeOf,
  swapOf,
  tokenOf,
  VAULT,
  ZERO_ADDRESS,
} from '../../../test/evm';
import vectors from '../../../test/fixtures/evm-route-vectors.json';
import { hexDecode, hexEncode } from '../../bytes';
import { type DeploymentFile, deploymentsOf } from '../deployment';
import { guardTransaction } from '../index';
import type { GuardCheck } from '../refusal';
import type { ApprovedStep, EvmDeployment, GuardInput, Loaded } from '../types';
import { evmVaultAddress } from './addresses';
import {
  readV4SingleSwap,
  UNIVERSAL_ROUTER_EXECUTE,
  UNIVERSAL_ROUTER_EXECUTE_SELECTOR,
} from './route';

vi.mock('../rules', () => import('../../../test/rules'));
vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));

// The call data a trade hands its exchange (security review, L1). The guard used to hold a trade to
// its router, tokens, amount and minimum and leave the route unread, so whoever built the bytes could
// trade through another pool of the same router and keep the gap between the quote and the minimum.
// Now the route is read and held to the one the builder writes. The vectors are that builder's own
// bytes (test/fixtures/evm-route-vectors.json says how they were made); every negative differs from
// them in one way.

const bytesOf = (data: string) => hexDecode(data);
const hexOf = (data: Uint8Array) => `0x${hexEncode(data)}`;
const WORD = 32;
const word = (n: number) => {
  const out = new Uint8Array(WORD);
  out[WORD - 1] = n;
  return out;
};

describe("the route's reader, on the builder's own bytes", () => {
  it('the function is execute(bytes,bytes[],uint256)', () => {
    expect(UNIVERSAL_ROUTER_EXECUTE).toBe('execute(bytes,bytes[],uint256)');
    expect(UNIVERSAL_ROUTER_EXECUTE_SELECTOR).toBe('0x3593564c');
  });

  it('reads every vector as what the builder was asked for', () => {
    expect(vectors.routes.length).toBeGreaterThanOrEqual(4);
    for (const v of vectors.routes) {
      const pools = vectors.pools[v.pools as keyof typeof vectors.pools];
      const [currency0, currency1] =
        BigInt(v.tokenIn) < BigInt(v.tokenOut) ? [v.tokenIn, v.tokenOut] : [v.tokenOut, v.tokenIn];
      expect(readV4SingleSwap(bytesOf(v.data)), v.name).toEqual({
        deadline: BigInt(v.deadline),
        currency0,
        currency1,
        fee: BigInt(pools.fee),
        tickSpacing: BigInt(pools.tickSpacing),
        hooks: ZERO_ADDRESS,
        zeroForOne: v.tokenIn === currency0,
        amountIn: BigInt(v.amountIn),
        amountOutMinimum: 0n,
        minHopPriceX36: 0n,
        hookData: new Uint8Array(),
        settle: { currency: v.tokenIn, maxAmount: BigInt(v.amountIn) },
        take: { currency: v.tokenOut, minAmount: 0n },
      });
    }
    // Both directions are among them: the cash above its token, and below it.
    expect(new Set(vectors.routes.map((v) => BigInt(v.tokenIn) < BigInt(v.tokenOut))).size).toBe(2);
  });

  it("the tests' own route is the builder's, byte for byte", () => {
    for (const v of vectors.routes) {
      const pools = vectors.pools[v.pools as keyof typeof vectors.pools];
      expect(
        hexOf(
          routeOf({
            tokenIn: v.tokenIn,
            tokenOut: v.tokenOut,
            amountIn: BigInt(v.amountIn),
            deadline: BigInt(v.deadline),
            fee: pools.fee,
            tickSpacing: pools.tickSpacing,
            hooks: pools.hooks,
          }),
        ),
        v.name,
      ).toBe(v.data);
    }
  });

  it('refuses bytes that say the same in another spelling, or more', () => {
    const good = bytesOf(vectors.routes[0]?.data ?? '0x');
    expect(() => readV4SingleSwap(good)).not.toThrow();
    const cases: [string, Uint8Array, RegExp][] = [
      ['a byte left over', Uint8Array.from([...good, 0]), /canonical/],
      ['a word left over', Uint8Array.from([...good, ...word(0)]), /canonical/],
      ['cut short', good.slice(0, good.length - 1), /ends early|runs? past|canonical/],
      ['nothing', new Uint8Array(), /not execute/],
      ['the selector alone', good.slice(0, 4), /ends early/],
      // The one command's 31 bytes of padding, with one of them set.
      [
        'padding that is not zero',
        good.map((b, i) => (i === 4 + 0x60 + WORD + 31 ? 1 : b)),
        /canonical/,
      ],
      // The same three values with a word of nothing before them, and every offset moved to suit.
      [
        'offsets that point past a gap',
        Uint8Array.from([
          ...good.slice(0, 4),
          ...word(0x80),
          ...word(0xc0),
          ...good.slice(4 + 2 * WORD, 4 + 3 * WORD),
          ...word(0),
          ...good.slice(4 + 3 * WORD),
        ]),
        /canonical/,
      ],
      // A deadline with a bit above 256 cannot be written; one offset pointed at itself can.
      [
        'an offset that points back into the head',
        good.map((b, i) => (i === 4 + WORD - 1 ? 0 : b)),
        /canonical|runs past|ends early/,
      ],
    ];
    for (const [name, data, message] of cases)
      expect(() => readV4SingleSwap(data), name).toThrow(message);
  });
});

// ---- the guard

const base = { legId: 'leg-1', chain: 'robinhood', owner: OWNER, basketId: BASKET_ID } as const;
const SPY = { sell: 'robinhood:usdc', buy: 'robinhood:spy', inRaw: '600000000', minOutRaw: '594' };
const GOLD = { sell: 'robinhood:usdc', buy: 'robinhood:gold', inRaw: '350000000', minOutRaw: '17' };
const CASH = '1000000000';
const USDC = tokenOf('robinhood:usdc');
const SPY_TOKEN = tokenOf('robinhood:spy');
const GOLD_TOKEN = tokenOf('robinhood:gold');
const AMOUNT = BigInt(SPY.inRaw);
const sorted = (a: string, b: string): [string, string] =>
  BigInt(a) < BigInt(b) ? [a, b] : [b, a];

type Step<K extends ApprovedStep['kind']> = Extract<ApprovedStep, { kind: K }>;
const swapStep: Step<'swap'> = { ...base, kind: 'swap', trades: [SPY, GOLD] };
const depositStep: Step<'deposit'> = { ...base, kind: 'deposit', amountRaw: CASH, trades: [SPY] };
const createStep: Step<'create_vault'> = {
  ...base,
  kind: 'create_vault',
  targets: [],
  follow: null,
  autoFollow: false,
  depositRaw: CASH,
  trades: [SPY],
};
const input = (
  step: ApprovedStep,
  c: EvmCallOf,
  deployment: GuardInput['deployment'] = EVM,
  over: Partial<BasketTx> = {},
): GuardInput => ({ step, tx: evmTx(step, c, over), deployment, consents: [] });

/** The owner's swap of the step, with the first trade's route changed. */
const swapWith = (route: Uint8Array | Partial<RouteOf>): EvmCallOf => ({
  to: VAULT,
  data: calls.ownerSwap([swapOf(SPY, { route }), swapOf(GOLD)]),
});
/** The route the builder writes for the first trade, as bytes, for a test to change by hand. */
const honestRoute = () => routeOf({ tokenIn: USDC, tokenOut: SPY_TOKEN, amountIn: AMOUNT });
const on = (
  name: string,
  check: GuardCheck,
  route: () => Uint8Array | Partial<RouteOf>,
): Negative => ({
  name,
  check,
  input: () => input(swapStep, swapWith(route())),
});

const negatives: Negative[] = [
  // ---- another pool of the same two tokens: the gap between the quote and the minimum
  on('a pool of another fee', 'route', () => ({ fee: 3000 })),
  on("a pool of mainnet's fee and tick spacing, on the test network", 'route', () => ({
    fee: vectors.pools.mainnet.fee,
    tickSpacing: vectors.pools.mainnet.tickSpacing,
  })),
  on('a pool of another tick spacing', 'route', () => ({ tickSpacing: 60 })),
  on('a pool with hooks', 'route', () => ({ hooks: tokenOf('a hook') })),
  on('data handed to a hook', 'route', () => ({ hookData: Uint8Array.of(1) })),
  on('the pool swapped the other way', 'route', () => ({
    zeroForOne: USDC !== sorted(USDC, SPY_TOKEN)[0],
  })),

  // ---- another token
  on('a pool with another token in it', 'asset', () => ({ currencies: sorted(USDC, GOLD_TOKEN) })),
  on("the pool's lower token replaced by another", 'asset', () => ({
    currencies: [`0x${'0'.repeat(39)}1`, sorted(USDC, SPY_TOKEN)[1]],
    zeroForOne: USDC === sorted(USDC, SPY_TOKEN)[0],
  })),
  on("the pool's higher token replaced by another", 'asset', () => ({
    currencies: [sorted(USDC, SPY_TOKEN)[0], `0x${'f'.repeat(40)}`],
    zeroForOne: USDC === sorted(USDC, SPY_TOKEN)[0],
  })),
  on("the pool's two tokens in the wrong order", 'asset', () => {
    const [low, high] = sorted(USDC, SPY_TOKEN);
    return { currencies: [high, low], zeroForOne: USDC === low };
  }),
  on('a route that pays in another token', 'asset', () => ({ settle: [GOLD_TOKEN, AMOUNT] })),
  on('a route that takes another token out', 'asset', () => ({ take: [GOLD_TOKEN, 0n] })),
  on('a route that takes out the token it sold', 'asset', () => ({ take: [USDC, 0n] })),

  // ---- another amount
  on('a route that sells more than the trade', 'amount', () => ({ swapAmountIn: AMOUNT + 1n })),
  on('a route that sells less than the trade', 'amount', () => ({ swapAmountIn: AMOUNT - 1n })),
  on('a route that may pay in more than the trade', 'amount', () => ({
    settle: [USDC, AMOUNT + 1n],
  })),

  // ---- the exchange's own minimums, which a built trade leaves at zero
  on("a minimum of the exchange's own, under the trade's", 'minimum', () => ({
    amountOutMinimum: BigInt(SPY.minOutRaw) - 1n,
  })),
  on("a minimum of the exchange's own, at the trade's", 'minimum', () => ({
    amountOutMinimum: BigInt(SPY.minOutRaw),
  })),
  on('a least price for the hop', 'minimum', () => ({ minHopPriceX36: 1n })),
  on('a least amount on the take', 'minimum', () => ({ take: [SPY_TOKEN, 1n] })),

  // ---- another deadline than the trade's
  on('a route good for longer than a signed trade may be', 'deadline', () => ({
    deadline: BigInt(now() + 3_600),
  })),
  on('a route good for ever', 'deadline', () => ({ deadline: (1n << 256n) - 1n })),
  on('a route good a second longer than its trade', 'deadline', () => ({
    deadline: DEADLINE + 1n,
  })),
  on('a route that lapses before its trade', 'deadline', () => ({ deadline: DEADLINE - 1n })),

  // ---- more than the one swap, or something else
  on('a second command', 'route', () => ({
    commands: [0x10, 0x10],
    inputs: (plan) => [plan, plan],
  })),
  on('a second command with no input of its own', 'route', () => ({ commands: [0x10, 0x04] })),
  on('a second input for the one command', 'route', () => ({ inputs: (plan) => [plan, plan] })),
  on('a sweep to a stranger after the swap', 'route', () => ({
    commands: [0x10, 0x04],
    inputs: (plan) => [plan, new Uint8Array(96)],
  })),
  on('a v3 swap in place of the v4 one', 'route', () => ({ commands: [0x00] })),
  on('a v2 swap in place of the v4 one', 'route', () => ({ commands: [0x08] })),
  on('the v4 swap, allowed to fail', 'route', () => ({ commands: [0x90] })),
  on('no command', 'route', () => ({ commands: [], inputs: () => [] })),
  on('a fourth action', 'route', () => ({
    actions: [0x06, 0x0c, 0x0f, 0x0f],
    params: (own) => [...own, own[2] as Uint8Array],
  })),
  on('a fourth action with no parameters of its own', 'route', () => ({
    actions: [0x06, 0x0c, 0x0f, 0x0e],
  })),
  on('a fourth parameter for three actions', 'route', () => ({
    params: (own) => [...own, own[2] as Uint8Array],
  })),
  on('a take to a named recipient in place of the take to the caller', 'route', () => ({
    actions: [0x06, 0x0c, 0x0e],
  })),
  on('an exact-output swap in place of the exact-input one', 'route', () => ({
    actions: [0x08, 0x0c, 0x0f],
  })),
  on('a swap across several pools in place of the one', 'route', () => ({
    actions: [0x07, 0x0c, 0x0f],
  })),
  on('the actions in another order', 'route', () => ({
    actions: [0x0c, 0x06, 0x0f],
    params: (own) => [own[1] as Uint8Array, own[0] as Uint8Array, own[2] as Uint8Array],
  })),
  on('another function, with the same arguments', 'route', () => ({
    signature: 'run(bytes,bytes[],uint256)',
  })),
  on('no call data at all', 'route', () => new Uint8Array()),
  on('three bytes that are no call', 'route', () => Uint8Array.of(7, 7, 7)),

  // ---- the right values in bytes that are not their one encoding
  on('a byte after the route', 'route', () => Uint8Array.from([...honestRoute(), 0])),
  on('a word after the route', 'route', () => Uint8Array.from([...honestRoute(), ...word(0)])),
  on('a route cut short', 'route', () => honestRoute().slice(0, -1)),
  on('padding that is not zero', 'route', () =>
    honestRoute().map((b, i) => (i === 4 + 0x60 + WORD + 31 ? 1 : b)),
  ),
  on('offsets that point past a gap', 'route', () => {
    const good = honestRoute();
    return Uint8Array.from([
      ...good.slice(0, 4),
      ...word(0x80),
      ...word(0xc0),
      ...good.slice(4 + 2 * WORD, 4 + 3 * WORD),
      ...word(0),
      ...good.slice(4 + 3 * WORD),
    ]);
  }),
  on('a tick spacing below zero', 'route', () => {
    // An int24 of -10, sign-extended over its word as the ABI writes it: no pool has one.
    const good = honestRoute();
    // The first word that is the tick spacing: no length, offset, fee or amount here is 10.
    const isSpacing = (i: number) =>
      good.slice(i, i + WORD).every((b, j) => b === (j === WORD - 1 ? POOL.tickSpacing : 0));
    const at = good.findIndex((_, i) => i % WORD === 4 && isSpacing(i));
    if (at < 0) throw new Error('the route holds no tick spacing');
    const minusTen = new Uint8Array(WORD).fill(0xff);
    minusTen[WORD - 1] = 0xf6;
    return Uint8Array.from([...good.slice(0, at), ...minusTen, ...good.slice(at + WORD)]);
  }),

  // ---- the same in a trade beside a deposit, and in a create that buys
  {
    name: 'a pool of another fee, in the trade beside a deposit',
    check: 'route',
    input: () =>
      input(depositStep, {
        to: VAULT,
        data: calls.multicall([
          calls.deposit(CASH),
          calls.ownerSwap([swapOf(SPY, { route: { fee: 3000 } })]),
        ]),
      }),
  },
  {
    name: 'a second command, in the trade beside a deposit',
    check: 'route',
    input: () =>
      input(depositStep, {
        to: VAULT,
        data: calls.multicall([
          calls.deposit(CASH),
          calls.ownerSwap([swapOf(SPY, { route: { commands: [0x10, 0x04] } })]),
        ]),
      }),
  },
  {
    name: 'a pool of another fee, in a create that buys',
    check: 'route',
    input: () =>
      input(createStep, {
        to: EVM.factory,
        data: calls.createVaultAndBuy({
          targets: [],
          cash: CASH,
          swaps: [swapOf(SPY, { route: { fee: 3000 } })],
        }),
      }),
  },
  {
    name: 'a route good longer than the create that carries it',
    check: 'deadline',
    input: () =>
      input(createStep, {
        to: EVM.factory,
        data: calls.createVaultAndBuy({
          targets: [],
          cash: CASH,
          swaps: [swapOf(SPY, { route: { deadline: DEADLINE + 60n } })],
        }),
      }),
  },
  {
    name: 'a pool of another fee, in the second trade of two',
    check: 'route',
    input: () =>
      input(swapStep, {
        to: VAULT,
        data: calls.ownerSwap([swapOf(SPY), swapOf(GOLD, { route: { fee: 100 } })]),
      }),
  },
  {
    name: 'a pool of another fee, in the second swap call of two',
    check: 'route',
    input: () =>
      input(swapStep, {
        to: VAULT,
        data: calls.multicall([
          calls.ownerSwap([swapOf(SPY)]),
          calls.ownerSwap([swapOf(GOLD, { route: { tickSpacing: 1 } })]),
        ]),
      }),
  },
];

describe("the guard on EVM: a trade's route is the one the builder writes", () => {
  it('passes the honest route in every step that trades', () => {
    const cases: [ApprovedStep, EvmCallOf][] = [
      [swapStep, { to: VAULT, data: calls.ownerSwap([swapOf(SPY), swapOf(GOLD)]) }],
      [
        depositStep,
        { to: VAULT, data: calls.multicall([calls.deposit(CASH), calls.ownerSwap([swapOf(SPY)])]) },
      ],
      [
        createStep,
        {
          to: EVM.factory,
          data: calls.createVaultAndBuy({ targets: [], cash: CASH, swaps: [swapOf(SPY)] }),
        },
      ],
      // A sale: the token for the cash, the pool swapped the other way.
      [
        { ...swapStep, trades: [{ ...SPY, sell: SPY.buy, buy: SPY.sell }] },
        { to: VAULT, data: calls.ownerSwap([swapOf({ ...SPY, sell: SPY.buy, buy: SPY.sell })]) },
      ],
    ];
    for (const [step, c] of cases)
      expect(
        refusalOf(() => guardTransaction(input(step, c)))?.message ?? null,
        step.kind,
      ).toBeNull();
  });

  eachBites(negatives);

  it('covers every way a route is held: its shape, its tokens, its amount, its minimums, its deadline', () => {
    const covered = new Set(negatives.map((n) => n.check));
    expect([...covered].sort()).toEqual(['amount', 'asset', 'deadline', 'minimum', 'route']);
  });

  it('says what was wrong with the route', () => {
    const message = (route: Uint8Array | Partial<RouteOf>) =>
      refusalOf(() => guardTransaction(input(swapStep, swapWith(route))))?.message;
    expect(message({ fee: 3000 })).toMatch(
      /fee 3000 and tick spacing 10.*deployment's is 500 and 10/,
    );
    expect(message({ commands: [0x00] })).toMatch(/commands are 0x00, not the one v4 swap/);
    expect(message({ actions: [0x06, 0x0c, 0x0e] })).toMatch(/actions are 0x060c0e/);
    expect(message({ signature: 'run(bytes,bytes[],uint256)' })).toMatch(
      /not execute\(bytes,bytes\[\],uint256\)/,
    );
    expect(message(Uint8Array.from([...honestRoute(), 0]))).toMatch(/canonical/);
    expect(message({ deadline: DEADLINE + 1n })).toMatch(/route is good until/);
  });
});

describe('the guard on EVM: a router whose call data is not read says so in the deployment', () => {
  const unread = evmDeployment({ routes: { [ROUTER]: { kind: 'unread' } } });
  const junk = swapWith(Uint8Array.of(7, 7, 7));

  it('an unread router on a test network passes what the vault itself holds the trade to', () => {
    expect(unread.provenance).toBe('sandbox');
    expect(refusalOf(() => guardTransaction(input(swapStep, junk, unread)))).toBeNull();
    // The same bytes through a router whose route is read are refused.
    expect(refusalOf(() => guardTransaction(input(swapStep, junk)))?.code).toBe('route');
    // And the trade itself is still held: another amount is refused whatever the route.
    const more = { ...SPY, inRaw: '600000001' };
    expect(
      refusalOf(() =>
        guardTransaction(
          input(
            swapStep,
            { to: VAULT, data: calls.ownerSwap([swapOf(more), swapOf(GOLD)]) },
            unread,
          ),
        ),
      )?.code,
    ).toBe('amount');
  });

  it('no deployment of a live network carries one, and none carries a router with no route', () => {
    const file = (network: 'mainnet' | 'testnet', routes: unknown): DeploymentFile =>
      ({
        format: 'guard-deployment/1',
        network,
        chains: {
          robinhood: {
            family: 'evm',
            evmChainId: network === 'mainnet' ? 4663 : 46630,
            factory: EVM.factory,
            beacon: EVM.beacon,
            routers: [ROUTER],
            ...(routes === undefined ? {} : { routes }),
            cash: 'robinhood:usdc',
            assets: { 'robinhood:usdc': { address: USDC, decimals: 6 } },
          },
        },
      }) as DeploymentFile;
    const loading = (f: DeploymentFile) =>
      refusalOf(() => withFile(f, () => deploymentsOf(f.network)));
    expect(loading(file('mainnet', { [ROUTER]: { kind: 'unread' } }))?.message).toMatch(
      /unread, and on mainnet/,
    );
    for (const network of ['mainnet', 'testnet'] as const) {
      expect(loading(file(network, undefined))?.message, network).toMatch(/states no route/);
      expect(loading(file(network, {}))?.message, network).toMatch(/states no route/);
      expect(loading(file(network, { [ROUTER]: { kind: 'mock' } }))?.message, network).toMatch(
        /no kind the guard reads/,
      );
    }
    expect(
      loading(file('mainnet', { [ROUTER]: { kind: 'universal-router-v4', ...POOL } })),
    ).toBeNull();
  });
});

describe("the guard on EVM: the builder's own bytes, against the committed deployments", () => {
  afterEach(() => vi.useRealTimers());
  /** The guard's clock ten minutes before the vectors' deadline. */
  const at = (deadline: string) => vi.useFakeTimers({ now: (Number(deadline) - 600) * 1000 });
  const assetOf = (deployment: EvmDeployment, address: string) => {
    const found = Object.entries(deployment.assets).find(([, a]) => a.token === address);
    if (!found) throw new Error(`the deployment lists no ${address}`);
    return found[0];
  };

  it('passes every test network vector with the test network file as committed', () => {
    const rh = deploymentsOf('testnet').robinhood as Loaded<EvmDeployment>;
    const [router] = rh.routers;
    expect(rh.routes[router ?? '']).toEqual({
      kind: 'universal-router-v4',
      ...vectors.pools.testnet,
    });
    const mine = vectors.routes.filter((v) => v.pools === 'testnet');
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const v of mine) {
      at(v.deadline);
      const trade = {
        sell: assetOf(rh, v.tokenIn),
        buy: assetOf(rh, v.tokenOut),
        inRaw: v.amountIn,
        minOutRaw: '1',
      };
      const step: ApprovedStep = { ...base, kind: 'swap', trades: [trade] };
      const swap = [router ?? '', v.tokenIn, v.tokenOut, BigInt(v.amountIn), 1n, bytesOf(v.data)];
      const data = calls.ownerSwap([swap], BigInt(v.deadline));
      const to = evmVaultAddress(rh, OWNER, BASKET_ID);
      expect(
        refusalOf(() => guardTransaction(input(step, { to, data }, rh)))?.message ?? null,
        v.name,
      ).toBeNull();
      // The same bytes beside a trade of one unit less are not that trade's route.
      const less = BigInt(v.amountIn) - 1n;
      const smaller = { ...step, trades: [{ ...trade, inRaw: less.toString() }] };
      const other = calls.ownerSwap(
        [[...swap.slice(0, 3), less, ...swap.slice(4)]],
        BigInt(v.deadline),
      );
      expect(
        refusalOf(() => guardTransaction(input(smaller, { to, data: other }, rh)))?.code,
        v.name,
      ).toBe('amount');
      vi.useRealTimers();
    }
  });

  it("refuses a route through mainnet's pool shape on the test network, and passes it on mainnet's file once filled in", () => {
    const v = vectors.routes.find((r) => r.pools === 'mainnet');
    if (!v) throw new Error('no vector for mainnet pools');
    const committed = readDeploymentFiles().mainnet as DeploymentFile;
    const { placeholder: _mark, todo: _note, ...file } = structuredClone(committed);
    const entry = file.chains.robinhood;
    if (entry?.family !== 'evm') throw new Error('the placeholder has no Robinhood Chain');
    Object.assign(entry, {
      factory: EVM.factory,
      beacon: EVM.beacon,
      registry: tokenOf('registry'),
    });
    entry.assets['robinhood:nvda'] = { address: v.tokenOut, decimals: 18 };
    const live = withFile(file, () => deploymentsOf('mainnet')).robinhood as Loaded<EvmDeployment>;
    expect(live.provenance).toBe('live');
    const [router] = live.routers;
    at(v.deadline);
    const trade = {
      sell: 'robinhood:usdg',
      buy: 'robinhood:nvda',
      inRaw: v.amountIn,
      minOutRaw: '1',
    };
    const step: ApprovedStep = { ...base, kind: 'swap', trades: [trade] };
    const swap = [router ?? '', v.tokenIn, v.tokenOut, BigInt(v.amountIn), 1n, bytesOf(v.data)];
    const c = {
      to: evmVaultAddress(live, OWNER, BASKET_ID),
      data: calls.ownerSwap([swap], BigInt(v.deadline)),
      chainId: 4663,
    };
    const tx = evmTx(step, c);
    const given: GuardInput = {
      step,
      tx: { ...tx, provenance: 'live', preview: { ...tx.preview, provenance: 'live' } },
      deployment: live,
      consents: [],
    };
    expect(refusalOf(() => guardTransaction(given))?.message ?? null).toBeNull();

    // The test network's file names another pool shape: the same route is not its route.
    const rh = deploymentsOf('testnet').robinhood as Loaded<EvmDeployment>;
    const [tusdg, tspy] = ['robinhood:tusdg', 'robinhood:tspy'].map(
      (id) => rh.assets[id]?.token ?? '',
    );
    const there = {
      sell: 'robinhood:tusdg',
      buy: 'robinhood:tspy',
      inRaw: v.amountIn,
      minOutRaw: '1',
    };
    const route = routeOf({
      tokenIn: tusdg as string,
      tokenOut: tspy as string,
      amountIn: BigInt(v.amountIn),
      deadline: BigInt(v.deadline),
      fee: vectors.pools.mainnet.fee,
      tickSpacing: vectors.pools.mainnet.tickSpacing,
    });
    const refusal = refusalOf(() =>
      guardTransaction(
        input(
          { ...base, kind: 'swap', trades: [there] },
          {
            to: evmVaultAddress(rh, OWNER, BASKET_ID),
            data: calls.ownerSwap(
              [
                [
                  rh.routers[0] ?? '',
                  tusdg as string,
                  tspy as string,
                  BigInt(v.amountIn),
                  1n,
                  route,
                ],
              ],
              BigInt(v.deadline),
            ),
          },
          rh,
        ),
      ),
    );
    expect(refusal?.code).toBe('route');
  });
});
