import { createHash } from 'node:crypto';
import { type BasketTx, evmCallPreimage } from '@colosseum/schemas';
import { selectorOf } from '../scripts/tables';
import { hexEncode } from '../src/bytes';
import { tradesOf } from '../src/guard/context';
import { type DeploymentFile, deploymentsOf, type EvmEntry } from '../src/guard/deployment';
import { type AbiValue, encodeArgs, parseSignature, parseType } from '../src/guard/evm/abi';
import type { InterfaceTable } from '../src/guard/evm/table';
import { EVM_INTERFACE } from '../src/guard/generated/evm-interface';
import type { ApprovedStep, ApprovedTrade, EvmDeployment, Loaded } from '../src/guard/types';
import { withFile } from './deployments';
import vectors from './fixtures/evm-vectors.json';

// EVM transactions for the guard's tests. The addresses of the factory, the beacon, the owner and the
// owner's vault are a case viem worked out (fixtures/evm-vectors.json), with the proxy's real creation
// code: the guard has to arrive at the same vault by itself. The message hash is made with the shared
// types' own rule and Node's SHA-256.

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** An address that belongs to nobody, the same every run. */
export const anyone = (label: string) => `0x${sha(`sdk test: ${label}`).slice(0, 40)}`;

export const {
  factory: FACTORY,
  beacon: BEACON,
  owner: OWNER,
  basketId: BASKET_ID,
} = vectors.deployed;
/** `vaultOf(OWNER, BASKET_ID)`, as viem derives it. */
export const VAULT = vectors.deployed.vault;
export const STRANGER = anyone('stranger');
export const ROUTER = anyone('router');
export const CHAIN_ID = 46630;
export const ZERO32 = `0x${'0'.repeat(64)}`;
export const PLAN_ID = `0x${BigInt(BASKET_ID).toString(16).padStart(64, '0')}`;
export const MAX = (1n << 256n) - 1n;
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** The pool shape of the test deployment's router: the test network's, as routes.ts has it. */
export const POOL = { fee: 500, tickSpacing: 10, hooks: ZERO_ADDRESS } as const;

/** A deployment file for the test network, as a deploy would write it, with `change` on top. */
export function evmDeployment(change: Partial<EvmEntry> = {}): Loaded<EvmDeployment> {
  const file: DeploymentFile = {
    format: 'guard-deployment/1',
    network: 'testnet',
    chains: {
      robinhood: {
        family: 'evm',
        evmChainId: CHAIN_ID,
        factory: FACTORY,
        beacon: BEACON,
        routers: [ROUTER],
        routes: { [ROUTER]: { kind: 'universal-router-v4', ...POOL } },
        cash: 'robinhood:usdc',
        assets: {
          'robinhood:usdc': { address: anyone('token usdc'), decimals: 6 },
          'robinhood:spy': { address: anyone('token spy'), decimals: 18 },
          'robinhood:gold': { address: anyone('token gold'), decimals: 18 },
        },
        ...change,
      },
    },
  };
  return withFile(file, () => deploymentsOf('testnet')).robinhood as Loaded<EvmDeployment>;
}
export const EVM = evmDeployment();
export const tokenOf = (asset: string) => EVM.assets[asset]?.token ?? anyone(`token ${asset}`);

/**
 * The committed ABIs without the two functions of the owner that the keeper path added to the vault:
 * how the guard behaves with a table that lacks a step's function.
 */
export const WITHOUT_FOLLOWING: InterfaceTable = {
  ...EVM_INTERFACE,
  BasketVault: Object.fromEntries(
    Object.entries(EVM_INTERFACE.BasketVault ?? {}).filter(
      ([signature]) => !/^(acceptVersion|setAutoFollow)\(/.test(signature),
    ),
  ),
};

/** Now, by the clock the guard reads, and a deadline ten minutes on: what an honest trade carries. */
export const now = () => Math.floor(Date.now() / 1000);
export const DEADLINE = BigInt(now() + 600);

/** One call: the selector of `signature`, then its arguments. */
export function call(signature: string, values: AbiValue[]): Uint8Array {
  const selector = Buffer.from(selectorOf(signature).slice(2), 'hex');
  return new Uint8Array(
    Buffer.concat([selector, encodeArgs(parseSignature(signature).inputs, values)]),
  );
}

export const WEIGHTS = '(address,uint16)[]';
export const SWAPS = '(address,address,address,uint256,uint256,bytes)[]';
/** Targets as a contract takes them: by token address, ascending. */
export const weights = (targets: { asset: string; weightBps: number }[]): AbiValue[] =>
  targets
    .map((t) => [tokenOf(t.asset), BigInt(t.weightBps)] as [string, bigint])
    .sort(([a], [b]) => (a < b ? -1 : 1));

/** What a route says, field by field, for a test to change one of. Left out: what the builder writes. */
export type RouteOf = {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  deadline?: bigint;
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
  hookData?: Uint8Array;
  /** The pool's two tokens, in the order written. Left out: the trade's two, the lower first. */
  currencies?: [string, string];
  zeroForOne?: boolean;
  swapAmountIn?: bigint;
  amountOutMinimum?: bigint;
  minHopPriceX36?: bigint;
  settle?: [string, bigint];
  take?: [string, bigint];
  commands?: number[];
  /** One input per command. Left out: the one plan below. */
  inputs?: (plan: Uint8Array) => Uint8Array[];
  actions?: number[];
  /** The actions' parameters. Left out: the swap, the settle, the take. */
  params?: (own: Uint8Array[]) => Uint8Array[];
  signature?: string;
};
const types = (...list: string[]) => list.map(parseType);
/**
 * Universal Router call data for one exact-input swap in one v4 pool, as `swapCalldata` of
 * packages/chain-evm builds it (route.test.ts holds this to that builder's own bytes), with `o` on top.
 */
export function routeOf(o: RouteOf): Uint8Array {
  const [currency0, currency1] =
    o.currencies ??
    (BigInt(o.tokenIn) < BigInt(o.tokenOut) ? [o.tokenIn, o.tokenOut] : [o.tokenOut, o.tokenIn]);
  const swap = encodeArgs(
    types('((address,address,uint24,uint24,address),bool,uint128,uint128,uint256,bytes)'),
    [
      [
        [
          currency0,
          currency1,
          BigInt(o.fee ?? POOL.fee),
          BigInt(o.tickSpacing ?? POOL.tickSpacing),
          o.hooks ?? POOL.hooks,
        ],
        o.zeroForOne ?? o.tokenIn === currency0,
        o.swapAmountIn ?? o.amountIn,
        o.amountOutMinimum ?? 0n,
        o.minHopPriceX36 ?? 0n,
        o.hookData ?? new Uint8Array(),
      ],
    ],
  );
  const pair = types('address', 'uint256');
  const own = [
    swap,
    encodeArgs(pair, o.settle ?? [o.tokenIn, o.amountIn]),
    encodeArgs(pair, o.take ?? [o.tokenOut, 0n]),
  ];
  const plan = encodeArgs(types('bytes', 'bytes[]'), [
    Uint8Array.from(o.actions ?? [0x06, 0x0c, 0x0f]),
    o.params ? o.params(own) : own,
  ]);
  return call(o.signature ?? 'execute(bytes,bytes[],uint256)', [
    Uint8Array.from(o.commands ?? [0x10]),
    o.inputs ? o.inputs(plan) : [plan],
    o.deadline ?? DEADLINE,
  ]);
}

/**
 * A trade as the vault takes it, with the route the builder writes for it: through the test
 * deployment's router, in its pool, good until `DEADLINE`. `route` changes fields of the route, or is
 * the bytes themselves.
 */
export const swapOf = (
  trade: ApprovedTrade,
  o: {
    router?: string;
    tokenIn?: string;
    tokenOut?: string;
    route?: Uint8Array | Partial<RouteOf>;
  } = {},
): AbiValue[] => {
  const tokenIn = o.tokenIn ?? tokenOf(trade.sell);
  const tokenOut = o.tokenOut ?? tokenOf(trade.buy);
  const amountIn = BigInt(trade.inRaw);
  return [
    o.router ?? ROUTER,
    tokenIn,
    tokenOut,
    amountIn,
    BigInt(trade.minOutRaw),
    o.route instanceof Uint8Array ? o.route : routeOf({ tokenIn, tokenOut, amountIn, ...o.route }),
  ];
};

export const calls = {
  approve: (spender: string, amount: bigint) => call('approve(address,uint256)', [spender, amount]),
  deposit: (amount: bigint | string) => call('deposit(uint256)', [BigInt(amount)]),
  ownerSwap: (swaps: AbiValue[][], deadline: bigint = DEADLINE) =>
    call(`ownerSwap(${SWAPS},uint64)`, [swaps, deadline]),
  withdraw: (token: string, amount: bigint | string) =>
    call('withdraw(address,uint256)', [token, BigInt(amount)]),
  withdrawAll: () => call('withdrawAll()', []),
  setTargets: (targets: AbiValue[]) => call(`setTargets(${WEIGHTS})`, [targets]),
  acceptVersion: (indexId: string, version: number) =>
    call('acceptVersion(bytes32,uint32)', [indexId, BigInt(version)]),
  setAutoFollow: (on: boolean) => call('setAutoFollow(bool)', [on]),
  setOperator: (operator: string) => call('setOperator(address)', [operator]),
  multicall: (inner: Uint8Array[]) => call('multicall(bytes[])', [inner]),
  createVault: (a: {
    planId?: string;
    targets: AbiValue[];
    indexId?: string;
    version?: number;
    autoFollow?: boolean;
  }) =>
    call(`createVault(bytes32,${WEIGHTS},bytes32,uint32,bool)`, [
      a.planId ?? PLAN_ID,
      a.targets,
      a.indexId ?? ZERO32,
      BigInt(a.version ?? 0),
      a.autoFollow ?? false,
    ]),
  createVaultAndBuy: (a: {
    planId?: string;
    targets: AbiValue[];
    indexId?: string;
    version?: number;
    autoFollow?: boolean;
    cash: bigint | string;
    swaps: AbiValue[][];
    deadline?: bigint;
  }) =>
    call(`createVaultAndBuy(bytes32,${WEIGHTS},bytes32,uint32,bool,uint256,${SWAPS},uint64)`, [
      a.planId ?? PLAN_ID,
      a.targets,
      a.indexId ?? ZERO32,
      BigInt(a.version ?? 0),
      a.autoFollow ?? false,
      BigInt(a.cash),
      a.swaps,
      a.deadline ?? DEADLINE,
    ]),
};

export type EvmCallOf = {
  to: string;
  data: Uint8Array;
  value?: string;
  chainId?: number;
  gas?: number;
};

/** A transaction as the API hands it out, for a step, around one call. */
export function evmTx(step: ApprovedStep, c: EvmCallOf, over: Partial<BasketTx> = {}): BasketTx {
  const payload = `0x${hexEncode(c.data)}`;
  const evm = {
    to: c.to,
    value: c.value ?? '0',
    chainId: c.chainId ?? CHAIN_ID,
    nonce: 4,
    gas: c.gas ?? 400_000,
  };
  const signer = over.signer ?? step.owner;
  return {
    chain: 'evm',
    payload,
    evm,
    description: 'a test transaction',
    provenance: 'sandbox',
    legKind: step.kind,
    chainId: step.chain,
    signer: step.owner,
    messageHash: sha(evmCallPreimage({ ...evm, signer, data: payload })),
    preview: {
      source: 'test',
      method: 'test',
      fetchedAt: '2026-10-03T12:00:00.000Z',
      provenance: 'sandbox',
      summary: 'a test transaction',
      simulated: true,
      feeNativeRaw: '20000000000000',
      changes: [],
      minimums: tradesOf(step).map((t) => ({ ...t })),
    },
    legId: step.legId,
    attemptId: 'attempt-1',
    ...over,
  };
}
