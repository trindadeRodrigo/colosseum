import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainError } from '@colosseum/schemas';
import { type Address, decodeAbiParameters, decodeFunctionData, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { deploymentPools, EvmDeploymentRecord } from '../src/vault/deployment';
import {
  poolKeyOf,
  poolOf,
  quoteExactIn,
  ROBINHOOD_V4_QUOTER,
  swapCalldata,
  type V4Pools,
  v4Pools,
} from '../src/vault/routes';
import type { EvmRpc } from '../src/vault/rpc';

// Each asset trades in its own pool against the cash, and in no other. On mainnet the money of one
// stock sits at one fee and that of the next at another, so the shape is the asset's, never the
// chain's. No node here: the builder's bytes are read back, and the Quoter is a stand-in that keeps
// what it was asked.

const ZERO = '0x0000000000000000000000000000000000000000';
const CASH = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
// One token below the cash and one above it: both orders of a pool's two tokens.
const LOW = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c' as Address;
const HIGH = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as Address;
const UNLISTED = '0x92fd66527192e3e61d4ddd13322aa222de86f9b5' as Address;
const POOLS: V4Pools = v4Pools(CASH, [
  { address: LOW, pool: { fee: 3000, tickSpacing: 60 } },
  { address: HIGH, pool: { fee: 100, tickSpacing: 1 } },
]);

const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
/** The pool key inside the call data `swapCalldata` wrote, read back with viem. */
function keyIn(data: `0x${string}`) {
  const { args } = decodeFunctionData({ abi: ROUTER_ABI, data });
  const [input] = args[1];
  const [, params] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    input as `0x${string}`,
  );
  const [swap] = decodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple',
            components: [
              { type: 'address' },
              { type: 'address' },
              { type: 'uint24' },
              { type: 'int24' },
              { type: 'address' },
            ],
          },
          { type: 'bool' },
          { type: 'uint128' },
          { type: 'uint128' },
          { type: 'uint256' },
          { type: 'bytes' },
        ],
      },
    ],
    params[0] as `0x${string}`,
  );
  const [[currency0, currency1, fee, tickSpacing, hooks], zeroForOne] = swap;
  return {
    currency0: currency0.toLowerCase(),
    currency1: currency1.toLowerCase(),
    fee,
    tickSpacing,
    hooks,
    zeroForOne,
  };
}

/** A Quoter that keeps the pool key it was asked about and pays one unit. */
function quoter() {
  const asked: { fee: number; tickSpacing: number; currency0: string; currency1: string }[] = [];
  const rpc = {
    simulateContract: async (call: { args: readonly [{ poolKey: (typeof asked)[number] }] }) => {
      asked.push(call.args[0].poolKey);
      return { result: [1n, 0n] };
    },
  } as unknown as EvmRpc;
  return { rpc, asked };
}
const silent = {
  simulateContract: async () => {
    throw new Error('the node was asked');
  },
} as unknown as EvmRpc;

describe("an asset's pool", () => {
  it('is its own: two assets against the same cash, two shapes', () => {
    expect(poolOf(POOLS, CASH, LOW)).toEqual({ fee: 3000, tickSpacing: 60 });
    expect(poolOf(POOLS, CASH, HIGH)).toEqual({ fee: 100, tickSpacing: 1 });
    // A sale goes through the same pool as a deposit's trade: the asset's, whichever side it is on.
    expect(poolOf(POOLS, LOW, CASH)).toEqual(poolOf(POOLS, CASH, LOW));
    expect(poolOf(POOLS, HIGH, CASH)).toEqual(poolOf(POOLS, CASH, HIGH));
  });

  it('is found whatever the case an address is written in', () => {
    const mixed = v4Pools('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', [
      { address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', pool: { fee: 100, tickSpacing: 1 } },
    ]);
    expect(poolOf(mixed, CASH, HIGH)).toEqual({ fee: 100, tickSpacing: 1 });
    expect(
      poolOf(
        mixed,
        '0xD0601CE157DB5BDC3162BBAC2A2C8AF5320D9EEC'.replace('0X', '0x') as Address,
        CASH,
      ),
    ).toEqual({ fee: 100, tickSpacing: 1 });
  });

  it('keys the pool with the lower token first and no hooks', () => {
    expect(poolKeyOf(POOLS, CASH, LOW)).toEqual({
      currency0: LOW,
      currency1: CASH,
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO,
    });
    expect(poolKeyOf(POOLS, HIGH, CASH)).toEqual({
      currency0: CASH,
      currency1: HIGH,
      fee: 100,
      tickSpacing: 1,
      hooks: ZERO,
    });
  });

  it('is refused as BadTrade where none is recorded, before the node is asked anything', async () => {
    const refusals = [
      // Two assets: each has a pool against the cash, and there is none between them.
      () => poolOf(POOLS, LOW, HIGH),
      () => poolOf(POOLS, CASH, CASH),
      // An asset nobody recorded a pool for, either way round.
      () => poolOf(POOLS, CASH, UNLISTED),
      () => poolOf(POOLS, UNLISTED, CASH),
      () => swapCalldata(POOLS, { tokenIn: LOW, tokenOut: HIGH, amountIn: 1n, deadline: 1n }),
      () => swapCalldata(POOLS, { tokenIn: CASH, tokenOut: UNLISTED, amountIn: 1n, deadline: 1n }),
    ];
    for (const refused of refusals) {
      let thrown: unknown;
      try {
        refused();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ChainError);
      expect((thrown as ChainError).code).toBe('BadTrade');
    }
    await expect(
      quoteExactIn(silent, POOLS, { tokenIn: LOW, tokenOut: HIGH, amountIn: 1n }),
    ).rejects.toMatchObject({ code: 'BadTrade' });
    await expect(
      quoteExactIn(silent, POOLS, { tokenIn: CASH, tokenOut: UNLISTED, amountIn: 1n }),
    ).rejects.toMatchObject({ code: 'BadTrade' });
    // A name on the prototype is not a token with a pool.
    expect(() => poolOf(POOLS, CASH, 'constructor' as Address)).toThrow(ChainError);
  });
});

describe('the builder', () => {
  it("writes each trade's call data for its own asset's pool", () => {
    const cases: [Address, Address, { fee: number; tickSpacing: number }][] = [
      [CASH, LOW, { fee: 3000, tickSpacing: 60 }],
      [LOW, CASH, { fee: 3000, tickSpacing: 60 }],
      [CASH, HIGH, { fee: 100, tickSpacing: 1 }],
      [HIGH, CASH, { fee: 100, tickSpacing: 1 }],
    ];
    for (const [tokenIn, tokenOut, shape] of cases) {
      const key = keyIn(swapCalldata(POOLS, { tokenIn, tokenOut, amountIn: 7n, deadline: 99n }));
      const [currency0, currency1] =
        BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
      expect(key).toEqual({
        currency0,
        currency1,
        ...shape,
        hooks: ZERO,
        zeroForOne: tokenIn === currency0,
      });
    }
  });

  it("asks the Quoter about the asset's pool and no other", async () => {
    const { rpc, asked } = quoter();
    await quoteExactIn(rpc, POOLS, { tokenIn: CASH, tokenOut: LOW, amountIn: 5n });
    await quoteExactIn(rpc, POOLS, { tokenIn: HIGH, tokenOut: CASH, amountIn: 5n });
    expect(asked.map((k) => [k.fee, k.tickSpacing])).toEqual([
      [3000, 60],
      [100, 1],
    ]);
  });

  it("says which pool could not fill a trade: the asset's", async () => {
    const reverting = {
      simulateContract: async () => {
        const { ContractFunctionRevertedError, ContractFunctionExecutionError } = await import(
          'viem'
        );
        throw new ContractFunctionExecutionError(
          new ContractFunctionRevertedError({ abi: [], functionName: 'quoteExactInputSingle' }),
          { abi: [], functionName: 'quoteExactInputSingle' },
        );
      },
    } as unknown as EvmRpc;
    await expect(
      quoteExactIn(reverting, POOLS, { tokenIn: CASH, tokenOut: LOW, amountIn: 5n }),
    ).rejects.toThrow(/fee 3000 and tick spacing 60/);
    await expect(
      quoteExactIn(reverting, POOLS, { tokenIn: CASH, tokenOut: HIGH, amountIn: 5n }),
    ).rejects.toThrow(/fee 100 and tick spacing 1/);
  });
});

describe("a network's pools, from its record", () => {
  const record = EvmDeploymentRecord.parse(
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'deployments', 'robinhood-testnet.json'),
        'utf8',
      ),
    ),
  );

  it('the test network: every asset states its pool, all of the one shape its kit opened', () => {
    const pools = deploymentPools(record);
    expect(pools.quoter).toBe(ROBINHOOD_V4_QUOTER);
    expect(pools.hooks).toBe(ZERO);
    expect(pools.cash).toBe(record.cash.address);
    expect(Object.keys(pools.byToken).sort()).toEqual(record.assets.map((a) => a.address).sort());
    expect(record.assets.length).toBe(11);
    for (const asset of record.assets) {
      expect(asset.pool, asset.symbol).toEqual({ fee: 500, tickSpacing: 10 });
      expect(poolOf(pools, pools.cash, asset.address as Address), asset.symbol).toEqual(asset.pool);
    }
    expect(() => poolOf(pools, pools.cash, pools.cash)).toThrow(ChainError);
  });

  it("a record whose asset states no pool, or one outside Uniswap's bounds, is refused", () => {
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'deployments', 'robinhood-testnet.json'),
        'utf8',
      ),
    );
    const withPool = (pool: unknown) => {
      const copy = structuredClone(raw);
      if (pool === undefined) delete copy.assets[0].pool;
      else copy.assets[0].pool = pool;
      return EvmDeploymentRecord.safeParse(copy).success;
    };
    expect(withPool({ fee: 3000, tickSpacing: 60 })).toBe(true);
    expect(withPool(undefined)).toBe(false);
    expect(withPool({ fee: 3000 })).toBe(false);
    expect(withPool({ fee: 1_000_001, tickSpacing: 60 })).toBe(false);
    expect(withPool({ fee: 3000, tickSpacing: 0 })).toBe(false);
    expect(withPool({ fee: 3000, tickSpacing: 60, hooks: ZERO })).toBe(false);
  });
});
