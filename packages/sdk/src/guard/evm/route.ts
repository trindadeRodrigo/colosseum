import { hexEncode, utf8Encode } from '../../bytes';
import { keccak256 } from '../../hash';
import { type AbiType, type AbiValue, decodeArgs, parseSignature, parseType } from './abi';

// The call data a vault hands Uniswap's Universal Router for one trade, read as the one shape the
// builders make (packages/chain-evm/src/vault/routes.ts, `swapCalldata`):
//
//   execute(bytes commands, bytes[] inputs, uint256 deadline)
//     commands  one byte: V4_SWAP
//     inputs    one: abi.encode(bytes actions, bytes[] params)
//       actions SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
//       params  the swap, (currency, maxAmount) to settle, (currency, minAmount) to take
//
// Every level is read with the codec of abi.ts, which takes only the canonical encoding of what it
// reads: an offset somewhere odd, padding that is not zero and a byte left over are refused at the
// level they are at. Anything that is not this shape throws, and the check refuses the trade. What the
// values must be is the check's to say (check.ts); this file only reads them.

export const UNIVERSAL_ROUTER_EXECUTE = 'execute(bytes,bytes[],uint256)';
/** The selector of `execute`, as 0x hex. */
export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = `0x${hexEncode(
  keccak256(utf8Encode(UNIVERSAL_ROUTER_EXECUTE)).slice(0, 4),
)}`;

/** Universal Router's command, with no flag set: a flag that lets a command fail is another byte. */
const V4_SWAP = 0x10;
/** The v4 router's actions (`Actions.sol`). */
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const EXECUTE = parseSignature(UNIVERSAL_ROUTER_EXECUTE).inputs;
const PLAN: AbiType[] = [parseType('bytes'), parseType('bytes[]')];
// `IV4Router.ExactInputSingleParams` of Universal Router 2.1: the pool key, the direction, the amount
// in, the least out, the least price of the hop, the hook's data. The tick spacing is an int24: a
// spacing above zero is the same word as a uint24, and one below zero has bits set above it and is
// refused as out of range, which is right, since no pool has one.
const SWAP: AbiType[] = [
  parseType('((address,address,uint24,uint24,address),bool,uint128,uint128,uint256,bytes)'),
];
const CURRENCY_AMOUNT: AbiType[] = [parseType('address'), parseType('uint256')];

/** One exact-input swap in one pool, as the call data states it. Addresses in lower case. */
export type V4SingleSwap = {
  /** The router's own deadline, in unix seconds. */
  deadline: bigint;
  currency0: string;
  currency1: string;
  fee: bigint;
  tickSpacing: bigint;
  hooks: string;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  minHopPriceX36: bigint;
  hookData: Uint8Array;
  settle: { currency: string; maxAmount: bigint };
  take: { currency: string; minAmount: bigint };
};

const sameList = (bytes: Uint8Array, wanted: number[]) =>
  bytes.length === wanted.length && wanted.every((b, i) => bytes[i] === b);
const hex = (bytes: Uint8Array) => `0x${hexEncode(bytes)}`;

/**
 * Reads `data` as that one call. Throws an `Error` that says what is not the shape: another function,
 * another command or one more, another action or one more, or bytes that are not the canonical
 * encoding of what they say.
 */
export function readV4SingleSwap(data: Uint8Array): V4SingleSwap {
  const selector = hex(data.slice(0, 4));
  if (data.length < 4 || selector !== UNIVERSAL_ROUTER_EXECUTE_SELECTOR)
    throw new Error(`it calls ${selector}, not ${UNIVERSAL_ROUTER_EXECUTE}`);
  const [commands, inputs, deadline] = decodeArgs(EXECUTE, data.slice(4)) as [
    Uint8Array,
    Uint8Array[],
    bigint,
  ];
  if (!sameList(commands, [V4_SWAP]))
    throw new Error(`its commands are ${hex(commands)}, not the one v4 swap`);
  const [input] = inputs;
  if (inputs.length !== 1 || !input)
    throw new Error(`it carries ${inputs.length} inputs for one command`);
  const [actions, params] = decodeArgs(PLAN, input) as [Uint8Array, Uint8Array[]];
  if (!sameList(actions, [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]))
    throw new Error(
      `its actions are ${hex(actions)}, not one exact-input swap, its settle and its take`,
    );
  const [swapBytes, settleBytes, takeBytes] = params;
  if (params.length !== 3 || !swapBytes || !settleBytes || !takeBytes)
    throw new Error(`it carries ${params.length} parameters for three actions`);

  const [swap] = decodeArgs(SWAP, swapBytes) as [AbiValue[]];
  const [key, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData] = swap as [
    [string, string, bigint, bigint, string],
    boolean,
    bigint,
    bigint,
    bigint,
    Uint8Array,
  ];
  const [currency0, currency1, fee, tickSpacing, hooks] = key;
  const [settleCurrency, maxAmount] = decodeArgs(CURRENCY_AMOUNT, settleBytes) as [string, bigint];
  const [takeCurrency, minAmount] = decodeArgs(CURRENCY_AMOUNT, takeBytes) as [string, bigint];
  return {
    deadline,
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
    zeroForOne,
    amountIn,
    amountOutMinimum,
    minHopPriceX36,
    hookData,
    settle: { currency: settleCurrency, maxAmount },
    take: { currency: takeCurrency, minAmount },
  };
}
