import { ChainError } from '@colosseum/schemas';
import {
  type Address,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  parseAbi,
  parseAbiParameters,
  type StateOverride,
} from 'viem';
import { ask, type EvmRpc, isRevert } from './rpc';

// The one route an EVM vault trades through here: an exact-input swap in one hookless Uniswap v4 pool,
// through Universal Router 2.1.x (pull 2, through Permit2), priced by Uniswap's v4 Quoter. The call
// data is the shape `contracts/test/fork/UniV4Calldata.sol` builds, which the fork test of the vault ran
// against the real router on Robinhood Chain: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`, so
// the output goes to the caller, the vault, and nowhere else.

/** Which pools a chain trades in, and who prices them. */
export type V4Pools = {
  /** Uniswap's v4 Quoter. */
  quoter: Address;
  fee: number;
  tickSpacing: number;
  /** The zero address: the vault trades in hookless pools only. */
  hooks: Address;
};

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Robinhood Chain's test network (46630), as TNET-2 made it (`contracts/script/testnet/deployed/
 * 46630.json`): one pool per test token against tUSDG at fee 500 and tick spacing 10, no hooks. The
 * Quoter is Uniswap's, at the address it has on mainnet, with the same code (docs/vault/research/
 * test-networks.md).
 */
export const ROBINHOOD_TESTNET_POOLS: V4Pools = {
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  fee: 500,
  tickSpacing: 10,
  hooks: ZERO,
};

const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);

const CMD_V4_SWAP = '0x10';
const SWAP_EXACT_IN_SINGLE = '0x06';
const SETTLE_ALL = '0x0c';
const TAKE_ALL = '0x0f';
const MAX_UINT128 = (1n << 128n) - 1n;

/** The pool of two tokens: the lower address is `currency0`. */
export function poolKeyOf(pools: V4Pools, a: Address, b: Address) {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {
    currency0,
    currency1,
    fee: pools.fee,
    tickSpacing: pools.tickSpacing,
    hooks: pools.hooks,
  };
}

/**
 * What the pool pays for `amountIn` of `tokenIn`, now (or at `block`). A pool that does not exist, or
 * cannot fill the amount, makes the Quoter revert: `BadTrade`.
 */
export async function quoteExactIn(
  rpc: EvmRpc,
  pools: V4Pools,
  t: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
  at: { blockNumber?: bigint; stateOverride?: StateOverride } = {},
): Promise<bigint> {
  if (t.amountIn <= 0n || t.amountIn > MAX_UINT128)
    throw new ChainError('BadInput', 'amountInRaw: above zero and at most 2^128 - 1');
  const poolKey = poolKeyOf(pools, t.tokenIn, t.tokenOut);
  try {
    const { result } = await ask('quoteExactInputSingle of the Quoter', () =>
      rpc.simulateContract({
        address: pools.quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            poolKey,
            zeroForOne: t.tokenIn === poolKey.currency0,
            exactAmount: t.amountIn,
            hookData: '0x',
          },
        ],
        ...(at.blockNumber !== undefined ? { blockNumber: at.blockNumber } : {}),
        ...(at.stateOverride ? { stateOverride: at.stateOverride } : {}),
      }),
    );
    const [amountOut] = result as readonly [bigint, bigint];
    if (amountOut === 0n) throw new ChainError('BadTrade', 'the pool pays nothing for that amount');
    return amountOut;
  } catch (e) {
    if (isRevert(e))
      throw new ChainError(
        'BadTrade',
        `no pool of ${t.tokenIn} and ${t.tokenOut} at fee ${pools.fee} and tick spacing ${pools.tickSpacing} can fill that amount`,
      );
    throw e;
  }
}

/**
 * Universal Router call data for one exact-input swap, the output to the caller (`TAKE_ALL`). The
 * router's own minimum is left at zero: the vault holds the swap to `minOut` by its own balances, so a
 * price that moved is refused by the vault's rule (`ReceivedTooLittle`), not wrapped in the router's
 * (`RouterFailed`). The router's deadline is the one given.
 */
export function swapCalldata(
  pools: V4Pools,
  t: { tokenIn: Address; tokenOut: Address; amountIn: bigint; deadline: bigint },
): Hex {
  const key = poolKeyOf(pools, t.tokenIn, t.tokenOut);
  const zeroForOne = t.tokenIn === key.currency0;
  const swap = encodeAbiParameters(
    parseAbiParameters(
      '((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)',
    ),
    [
      [
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
        zeroForOne,
        t.amountIn,
        0n,
        0n,
        '0x',
      ],
    ],
  );
  const settle = encodeAbiParameters(parseAbiParameters('address, uint256'), [
    t.tokenIn,
    t.amountIn,
  ]);
  const take = encodeAbiParameters(parseAbiParameters('address, uint256'), [t.tokenOut, 0n]);
  const actions = concatHex([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions,
    [swap, settle, take],
  ]);
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'execute',
    args: [CMD_V4_SWAP, [input], t.deadline],
  });
}
