import { Reader } from './bytes';
import type { ClState, InitTick } from './cl-math';
import {
  type ClmmPool,
  clmmState,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmTickArray,
} from './raydium-clmm';

/**
 * Byreal CLMM (PLAN-UNIVERSE RU.15). The pool account and the fee config are Raydium's (`decodeClmmPool`,
 * `decodeClmmAmmConfig`); two things are Byreal's own and are read here:
 * - a second kind of tick array beside Raydium's fixed one: a 216-byte header (the pool, the first tick, a table of
 *   60 one-byte slots, two counts) and then one 168-byte tick for each slot allocated, in the order they were
 *   allocated. A slot holds the tick's place among those ticks plus one, and 0 when the tick is not allocated;
 * - the fee: a rate on the pool itself that replaces the config's when it is not zero, a fee that decays with time,
 *   and a dynamic fee computed from two Pyth feeds. A pool with either of the last two switched on is not priced
 *   here: `byrealFee` says so and `byrealClState` refuses it. No oracle account is read.
 *
 * Offsets checked against the 19 Byreal pools of the tracked stocks on 2026-10-07 (the liquidity check on each, and
 * Jupiter's own quote through the same pool: scripts/risk/byreal/validate.ts). The layout is the one Byreal publishes
 * (github.com/byreal-git/byreal-clmm), which is not a verified build of the program: the chain is what was checked.
 */
export const BYREAL_FIXED_TICK_ARRAY_DISC = 'c09b55cd31f9812a';
export const BYREAL_DYN_TICK_ARRAY_DISC = '6a8b98247599b838';
const TICKS_PER_ARRAY = 60;
const TICK_SIZE = 168;
const DYN_HEADER_SIZE = 216;
const DYN_TABLE_OFFSET = 48;
const DYN_ALLOCATED_OFFSET = DYN_TABLE_OFFSET + TICKS_PER_ARRAY;
const FIXED_ARRAY_SIZE = 10_240;
// the pool's own bitmap of its tick arrays: 1,024 bits, one an array position, 512 on each side of tick 0
const POOL_BITMAP_OFFSET = 904;
const POOL_BITMAP_HALF = 512;

export type ByrealTickArray = {
  pool: string;
  startTickIndex: number;
  ticks: InitTick[];
  kind: 'fixed' | 'dynamic';
};

/**
 * The second kind of tick array. Every allocated tick is checked against the header before it is read: its slot
 * points inside the ticks the account holds, no two slots point at one tick, and the tick's own index is the one its
 * place in the table says. Anything else throws: an account with this kind's first 8 bytes that does not have this
 * layout is a changed program, not an empty array.
 */
export function decodeByrealDynTickArray(data: Uint8Array, tickSpacing: number): ByrealTickArray {
  const r = new Reader(data);
  if (r.disc() !== BYREAL_DYN_TICK_ARRAY_DISC)
    throw new Error('byreal dynamic tick array: not its first 8 bytes');
  if (data.length < DYN_HEADER_SIZE)
    throw new Error(`byreal dynamic tick array: size ${data.length}`);
  const allocated = r.u8(DYN_ALLOCATED_OFFSET);
  if (data.length !== DYN_HEADER_SIZE + allocated * TICK_SIZE)
    throw new Error(
      `byreal dynamic tick array: size ${data.length} with ${allocated} ticks allocated`,
    );
  const startTickIndex = r.i32(40);
  const seen = new Set<number>();
  const ticks: InitTick[] = [];
  for (let k = 0; k < TICKS_PER_ARRAY; k++) {
    const slot = r.u8(DYN_TABLE_OFFSET + k);
    if (slot === 0) continue;
    if (slot > allocated || seen.has(slot))
      throw new Error(`byreal dynamic tick array: slot ${k} points at tick ${slot}`);
    seen.add(slot);
    const o = DYN_HEADER_SIZE + (slot - 1) * TICK_SIZE;
    const gross = r.u128(o + 20);
    if (gross === 0n) continue;
    const tick = r.i32(o);
    if (tick !== startTickIndex + k * tickSpacing)
      throw new Error(`byreal dynamic tick array: slot ${k} holds tick ${tick}`);
    const net = r.i128(o + 4);
    ticks.push({ tick, liquidityNet: Number(net), net, gross });
  }
  if (seen.size !== allocated)
    throw new Error(
      `byreal dynamic tick array: ${allocated} ticks allocated, ${seen.size} in the table`,
    );
  // the header's own count of the ticks that carry liquidity
  if (r.u8(DYN_ALLOCATED_OFFSET + 1) !== ticks.length)
    throw new Error(
      `byreal dynamic tick array: ${ticks.length} ticks with liquidity, its header says ${r.u8(DYN_ALLOCATED_OFFSET + 1)}`,
    );
  return { pool: r.pubkey(8), startTickIndex, ticks, kind: 'dynamic' };
}

/**
 * One account a Byreal pool owns, read as the kind its own first 8 bytes say: Raydium's fixed array through
 * `decodeClmmTickArray`, the second kind through `decodeByrealDynTickArray`. Null for an account that is neither (the
 * bitmap extension, the reward config, or a kind that does not exist yet): it holds no tick this reads, and
 * `byrealArraysCheck` is what tells whether an array was missed. A fixed array that is not Raydium's size, or whose
 * ticks are not on the pool's grid inside its own 60, throws, as a dynamic one does.
 */
export function decodeByrealTickArray(
  data: Uint8Array,
  tickSpacing: number,
): ByrealTickArray | null {
  if (data.length < 8) return null;
  const disc = new Reader(data).disc();
  if (disc === BYREAL_DYN_TICK_ARRAY_DISC) return decodeByrealDynTickArray(data, tickSpacing);
  if (disc !== BYREAL_FIXED_TICK_ARRAY_DISC) return null;
  const fixed = data.length === FIXED_ARRAY_SIZE ? decodeClmmTickArray(data) : null;
  if (!fixed) throw new Error(`byreal fixed tick array: size ${data.length}`);
  for (const t of fixed.ticks) {
    const k = (t.tick - fixed.startTickIndex) / tickSpacing;
    if (!Number.isInteger(k) || k < 0 || k >= TICKS_PER_ARRAY)
      throw new Error(`byreal fixed tick array: tick ${t.tick} is not one of its 60`);
  }
  return { ...fixed, kind: 'fixed' };
}

/** What a Byreal pool account says of its own fee, beside Raydium's fields. Rates are in millionths. */
export type ByrealPoolFee = {
  /** The pool's own rate; 0 means it has none and the config's applies. */
  tradeFeeRate: number;
  /** Swaps are switched off on the pool (bit 4 of its status). */
  swapDisabled: boolean;
  /** When swaps opened, in seconds; the decaying fee counts from it. */
  openTime: number;
  decay: {
    on: boolean;
    onSalesOfToken0: boolean;
    onSalesOfToken1: boolean;
    /** Percent at opening, percent taken off at each interval, and the interval in seconds. */
    initPct: number;
    decreasePct: number;
    intervalSeconds: number;
  };
  dynamic: {
    on: boolean;
    token1IsQuote: boolean;
    /** Both feed ids are set. They are not read as accounts, here or anywhere. */
    feedsSet: boolean;
  };
};

export function decodeByrealPoolFee(data: Uint8Array): ByrealPoolFee {
  decodeClmmPool(data);
  const r = new Reader(data);
  const flag = r.u8(1096);
  const set = (o: number) => data.subarray(o, o + 32).some((x) => x !== 0);
  return {
    tradeFeeRate: r.u32(393),
    swapDisabled: (r.u8(389) & 16) !== 0,
    openTime: Number(r.u64(1080)),
    decay: {
      on: (flag & 1) !== 0,
      onSalesOfToken0: (flag & 2) !== 0,
      onSalesOfToken1: (flag & 4) !== 0,
      initPct: r.u8(1097),
      decreasePct: r.u8(1098),
      intervalSeconds: r.u8(1099),
    },
    dynamic: {
      on: (flag & 16) !== 0,
      token1IsQuote: (flag & 8) !== 0,
      feedsSet: set(1112) && set(1144),
    },
  };
}

export type ByrealFee =
  | { priced: true; tradeFeeRate: number; from: 'pool' | 'config' }
  | { priced: false; reason: 'dynamic_fee_on' | 'decaying_fee_on' | 'swaps_switched_off' };

/**
 * The rate a swap pays, as the program computes it for a pool with no dynamic fee and no decaying fee: the pool's
 * own rate when it is not zero, the config's otherwise, the same in both directions. It is not computed for a pool
 * with the dynamic fee on (the rate comes from two Pyth feeds, which nothing here reads), for one with the decaying
 * fee on (the rate changes with the clock and the direction, and no pool of a tracked stock had it on to validate
 * against), or for one with swaps switched off.
 */
export function byrealFee(pool: Uint8Array, config: Uint8Array): ByrealFee {
  const own = decodeByrealPoolFee(pool);
  if (own.swapDisabled) return { priced: false, reason: 'swaps_switched_off' };
  if (own.dynamic.on) return { priced: false, reason: 'dynamic_fee_on' };
  if (own.decay.on) return { priced: false, reason: 'decaying_fee_on' };
  return own.tradeFeeRate !== 0
    ? { priced: true, tradeFeeRate: own.tradeFeeRate, from: 'pool' }
    : { priced: true, tradeFeeRate: decodeClmmAmmConfig(config).tradeFeeRate, from: 'config' };
}

export type ByrealLiquidityCheck = {
  /** The pool's stored liquidity, and the sum of `liquidityNet` over the ticks at or below its current tick. */
  stored: bigint;
  atPrice: bigint;
  /** The sum over every tick read: zero when every array was read, since each position adds and removes the same. */
  total: bigint;
  holds: boolean;
};

/**
 * The liquidity check, in whole numbers: the ticks at or below the price add up to the pool's stored liquidity, and
 * all the ticks add up to nothing. Exact: no tolerance. It fails when an array is missing or misread, with one
 * exception it cannot see: an array whose own ticks add up to nothing and all lie on one side of the price (positions
 * with both ends inside it). `byrealArraysCheck` is the check that sees that one.
 */
export function byrealLiquidityCheck(
  pool: ClmmPool,
  arrays: readonly ByrealTickArray[],
): ByrealLiquidityCheck {
  let atPrice = 0n;
  let total = 0n;
  for (const a of arrays)
    for (const t of a.ticks) {
      const net = t.net as bigint;
      total += net;
      if (t.tick <= pool.tickCurrent) atPrice += net;
    }
  return {
    stored: pool.liquidity,
    atPrice,
    total,
    holds: atPrice === pool.liquidity && total === 0n,
  };
}

export type ByrealArraysCheck = {
  /** First ticks of the arrays the pool's own bitmap names and that were not read with a tick in them. */
  missing: number[];
  /** First ticks of the arrays read with a tick that carries liquidity and that the bitmap does not name. */
  unnamed: number[];
  holds: boolean;
};

/**
 * Whether every array was read: the pool account keeps a bitmap of the arrays that hold a tick with liquidity (1,024
 * positions, 512 on each side of tick 0), and the arrays read must be exactly those. It is what catches an array
 * that was not read, or an account of a kind this does not read, when its ticks happen to add up to nothing. An
 * array further out than the bitmap reaches is named by the pool's bitmap extension, which is not read: such an array
 * is not checked here (at a spacing of 10 the bitmap covers every tick from -307,200 to 307,199).
 */
export function byrealArraysCheck(
  head: Uint8Array,
  arrays: readonly ByrealTickArray[],
): ByrealArraysCheck {
  const r = new Reader(head);
  const width = TICKS_PER_ARRAY * r.u16(235);
  const named = new Set<number>();
  for (let i = 0; i < 2 * POOL_BITMAP_HALF; i++)
    if ((r.u64(POOL_BITMAP_OFFSET + 8 * Math.floor(i / 64)) >> BigInt(i % 64)) & 1n)
      named.add((i - POOL_BITMAP_HALF) * width);
  const read = new Set<number>();
  for (const a of arrays) {
    const at = a.startTickIndex / width;
    if (a.ticks.length && at >= -POOL_BITMAP_HALF && at < POOL_BITMAP_HALF)
      read.add(a.startTickIndex);
  }
  const missing = [...named].filter((s) => !read.has(s)).sort((x, y) => x - y);
  const unnamed = [...read].filter((s) => !named.has(s)).sort((x, y) => x - y);
  return { missing, unnamed, holds: missing.length === 0 && unnamed.length === 0 };
}

/**
 * A Byreal pool as the concentrated-liquidity simulator takes it, from its account, its fee config and the accounts
 * that name it. It throws, and the pool is not built, when the fee is not priced from the pool's own accounts
 * (`byrealFee`), when an array does not have its kind's layout, when the arrays read are not the ones the pool's
 * bitmap names (`byrealArraysCheck`), or when the liquidity check does not hold exactly. Both checks run here on
 * every build, so a change in Byreal's program or an array that was not read stops the pool instead of pricing it
 * wrong.
 */
export function byrealClState(
  address: string,
  head: Uint8Array,
  config: Uint8Array,
  children: readonly Uint8Array[],
): {
  pool: ClmmPool;
  fee: ByrealFee & { priced: true };
  arrays: ByrealTickArray[];
  state: ClState;
} {
  const pool = decodeClmmPool(head);
  const fee = byrealFee(head, config);
  if (!fee.priced) throw new Error(`byreal pool not priced from its own accounts: ${fee.reason}`);
  const arrays = children
    .map((c) => decodeByrealTickArray(c, pool.tickSpacing))
    .filter((a): a is ByrealTickArray => a !== null && a.pool === address);
  const named = byrealArraysCheck(head, arrays);
  if (!named.holds)
    throw new Error(
      `byreal arrays check: ${named.missing.length} array(s) the pool names were not read (first ticks ${named.missing.slice(0, 4).join(', ')}), ${named.unnamed.length} read that it does not name`,
    );
  const check = byrealLiquidityCheck(pool, arrays);
  if (!check.holds)
    throw new Error(
      `byreal liquidity check: ticks at the price add up to ${check.atPrice}, the pool stores ${check.stored}; all ticks add up to ${check.total}`,
    );
  return { pool, fee, arrays, state: clmmState(pool, fee.tradeFeeRate, arrays) };
}
