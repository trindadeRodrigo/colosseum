import { createHash } from 'node:crypto';
import { type BasketTx, evmCallPreimage } from '@colosseum/schemas';
import { selectorOf } from '../scripts/tables';
import { hexEncode } from '../src/bytes';
import { tradesOf } from '../src/guard/context';
import { type DeploymentFile, deploymentsOf, type EvmEntry } from '../src/guard/deployment';
import { type AbiValue, encodeArgs, parseSignature } from '../src/guard/evm/abi';
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
 * The committed ABIs plus the two functions of the owner that the keeper path adds to the vault
 * (DESIGN-VAULT 3.8): `acceptVersion` and `setAutoFollow`. The guard refuses both steps until the ABI
 * has them and the table is generated again; this table is how the tests reach the rules that wait.
 */
export const NEXT_INTERFACE: InterfaceTable = {
  ...EVM_INTERFACE,
  BasketVault: {
    ...EVM_INTERFACE.BasketVault,
    'acceptVersion(bytes32,uint32)': selectorOf('acceptVersion(bytes32,uint32)'),
    'setAutoFollow(bool)': selectorOf('setAutoFollow(bool)'),
  },
};

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
export const swapOf = (
  trade: ApprovedTrade,
  o: { router?: string; tokenIn?: string; tokenOut?: string; route?: Uint8Array } = {},
): AbiValue[] => [
  o.router ?? ROUTER,
  o.tokenIn ?? tokenOf(trade.sell),
  o.tokenOut ?? tokenOf(trade.buy),
  BigInt(trade.inRaw),
  BigInt(trade.minOutRaw),
  o.route ?? Uint8Array.of(7, 7, 7),
];

export const calls = {
  approve: (spender: string, amount: bigint) => call('approve(address,uint256)', [spender, amount]),
  deposit: (amount: bigint | string) => call('deposit(uint256)', [BigInt(amount)]),
  ownerSwap: (swaps: AbiValue[][]) => call(`ownerSwap(${SWAPS})`, [swaps]),
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
  }) =>
    call(`createVaultAndBuy(bytes32,${WEIGHTS},bytes32,uint32,bool,uint256,${SWAPS})`, [
      a.planId ?? PLAN_ID,
      a.targets,
      a.indexId ?? ZERO32,
      BigInt(a.version ?? 0),
      a.autoFollow ?? false,
      BigInt(a.cash),
      a.swaps,
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
