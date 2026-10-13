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
// the one recorded for the asset traded,
// through Universal Router 2.1.x (pull 2, through Permit2), priced by Uniswap's v4 Quoter. The call
// data is the shape `contracts/test/fork/UniV4Calldata.sol` builds, which the fork test of the vault ran
// against the real router on Robinhood Chain: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`, so
// the output goes to the caller, the vault, and nowhere else.

/** One Uniswap v4 pool's shape: its fee in hundredths of a basis point, and its tick spacing. */
export type V4Pool = { fee: number; tickSpacing: number };

/**
 * Which pools a chain trades in, and who prices them. Every asset has one pool, against the cash
 * token, and its shape is the asset's own: on mainnet the money of one stock sits at one fee and that
 * of the next at another. A trade goes through the pool recorded for its asset and no other.
 */
export type V4Pools = {
  /** Uniswap's v4 Quoter. */
  quoter: Address;
  /** The zero address: the vault trades in hookless pools only. */
  hooks: Address;
  /** The cash token every pool here is against. */
  cash: Address;
  /** Each asset's pool against the cash token, by the asset's token address in lower case. */
  byToken: Readonly<Record<string, V4Pool>>;
};

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Uniswap's v4 Quoter on Robinhood Chain: the same address, with the same code, on mainnet (4663)
 * and on the test network (46630) (docs/vault/research/test-networks.md).
 */
export const ROBINHOOD_V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address;

/** The pools of a network from its assets: the cash token, and each other token with its pool. */
export function v4Pools(
  cash: string,
  assets: readonly { address: string; pool: V4Pool }[],
  quoter: Address = ROBINHOOD_V4_QUOTER,
): V4Pools {
  return {
    quoter,
    hooks: ZERO,
    cash: cash.toLowerCase() as Address,
    byToken: Object.fromEntries(
      assets.map((a) => [
        a.address.toLowerCase(),
        { fee: a.pool.fee, tickSpacing: a.pool.tickSpacing },
      ]),
    ),
  };
}

/**
 * The pool two tokens trade in: the pool recorded for the one that is not cash. Two assets have no
 * pool of their own, and an asset with none recorded is not traded: `BadTrade`, before anything is
 * asked of the chain.
 */
export function poolOf(pools: V4Pools, a: Address, b: Address): V4Pool {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const cash = pools.cash.toLowerCase();
  if ((x === cash) === (y === cash))
    throw new ChainError(
      'BadTrade',
      `no pool is recorded for ${a} and ${b}: a trade is between the cash token and one asset`,
    );
  const asset = x === cash ? y : x;
  const pool = Object.hasOwn(pools.byToken, asset) ? pools.byToken[asset] : undefined;
  if (!pool) throw new ChainError('BadTrade', `no pool is recorded for ${asset}`);
  return pool;
}

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

/** The key of the pool two tokens trade in: the lower address is `currency0`, the shape the asset's. */
export function poolKeyOf(pools: V4Pools, a: Address, b: Address) {
  const { fee, tickSpacing } = poolOf(pools, a, b);
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks: pools.hooks };
}

/**
 * What the asset's pool pays for `amountIn` of `tokenIn`, now (or at `block`). A pool that does not
 * exist, or cannot fill the amount, makes the Quoter revert: `BadTrade`.
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
        `no pool of ${t.tokenIn} and ${t.tokenOut} at fee ${poolKey.fee} and tick spacing ${poolKey.tickSpacing} can fill that amount`,
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
