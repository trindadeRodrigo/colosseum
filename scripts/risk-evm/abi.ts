// The handful of ABI encodings the collector needs, written out by hand so it adds no dependency.
// Selectors are `cast sig` of the signature beside them. tests/risk-evm.test.ts checks the encoders
// against calldata built by `cast calldata` and the decoders against a recorded response.

export const SEL = {
  aggregate3: '82ad56cb', // aggregate3((address,bool,bytes)[])  Multicall3
  slot0: '3850c7bd', // slot0()  v3-style pool
  token0: '0dfe1681', // token0()
  token1: 'd21220a7', // token1()
  fee: 'ddca3f43', // fee()
  tickSpacing: 'd0c93a7c', // tickSpacing()
  getPoolByFee: '1698ee82', // getPool(address,address,uint24)  Uniswap v3 factory
  getPoolByTickSpacing: '28af8d0b', // getPool(address,address,int24)  Aerodrome Slipstream factory
  getSlot0: 'c815641c', // getSlot0(bytes32)  v4 StateView
  poolKeys: '86b6be7d', // poolKeys(bytes25)  v4 PositionManager
  quoteExactInputSingle: 'aa9d21cb', // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))  v4 Quoter
  clQuote: '186ccfa5', // quote(address,bool,uint256[],uint256)  ClQuoter.sol
  decimals: '313ce567', // decimals()  ERC-20
  symbol: '95d89b41', // symbol()  ERC-20
  balanceOf: '70a08231', // balanceOf(address)  ERC-20
  liquidity: '1a686502', // liquidity()  v3-style pool
  factory: 'c45a0155', // factory()  v3-style pool
  getLiquidity: 'fa6793d5', // getLiquidity(bytes32)  v4 StateView
  tickBitmap: '5339c296', // tickBitmap(int16)  v3 pool
  ticks: 'f30dba93', // ticks(int24)  v3 pool
  getTickBitmap: '1c7ccb4c', // getTickBitmap(bytes32,int16)  v4 StateView
  getTickLiquidity: 'caedab54', // getTickLiquidity(bytes32,int24)  v4 StateView
  weth9: '4aa4a4fc', // WETH9()  v4 PositionManager: the wrapped native coin it unwraps
  description: '7284e416', // description()  Chainlink feed
  latestRoundData: 'feaf968c', // latestRoundData()  Chainlink feed
  aggregator: '245a7bfc', // aggregator()  Chainlink feed proxy
} as const;

/** Event topics: the keccak-256 of the signature beside them. Each is checked against a recorded log. */
export const TOPIC = {
  // Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee,
  // int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)  v4 PoolManager
  v4Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing,
  // address pool)  Uniswap v3 factory
  v3PoolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
} as const;

export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

const strip = (hex: string) => (hex.startsWith('0x') ? hex.slice(2) : hex);

/** One 32-byte word for an unsigned integer or a boolean. */
export function word(v: bigint | number | boolean): string {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error(`not a uint256: ${v}`);
  return n.toString(16).padStart(64, '0');
}

export function addressWord(address: string): string {
  const a = strip(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${address}`);
  return a.padStart(64, '0');
}

/** A dynamic `bytes` value: its length, then the bytes padded to whole words. */
function bytesTail(hex: string): string {
  const b = strip(hex);
  return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
}

/** The 32-byte words of a response, as integers. */
export function words(hex: string): bigint[] {
  const h = strip(hex);
  if (h.length % 64 !== 0) throw new Error(`response is not whole words (${h.length / 2} bytes)`);
  const out: bigint[] = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt(`0x${h.slice(i, i + 64)}`));
  return out;
}

const at = (ws: bigint[], i: number): bigint => {
  const w = ws[i];
  if (w === undefined) throw new Error(`response too short: no word ${i}`);
  return w;
};

export const wordToAddress = (w: bigint) => `0x${w.toString(16).padStart(64, '0').slice(24)}`;

/** A word holding a signed integer of `bits` bits (int24 ticks). */
export function wordToInt(w: bigint, bits: number): number {
  const v = BigInt.asIntN(bits, w);
  return Number(v);
}

export type Call = { target: string; callData: string };

/** Multicall3.aggregate3 with allowFailure on for every call. */
export function encodeAggregate3(calls: Call[]): string {
  const items = calls.map(
    (c) => addressWord(c.target) + word(true) + word(0x60) + bytesTail(c.callData),
  );
  let offset = calls.length * 32;
  const heads = items.map((item) => {
    const head = word(offset);
    offset += item.length / 2;
    return head;
  });
  return `0x${SEL.aggregate3}${word(0x20)}${word(calls.length)}${heads.join('')}${items.join('')}`;
}

/** The (success, returnData) pairs of an aggregate3 response. */
export function decodeAggregate3(hex: string): Array<{ success: boolean; data: string }> {
  const h = strip(hex);
  const ws = words(hex);
  const base = Number(at(ws, 0)) / 32 + 1; // first word after the array length
  const n = Number(at(ws, base - 1));
  const out: Array<{ success: boolean; data: string }> = [];
  for (let i = 0; i < n; i++) {
    const item = base + Number(at(ws, base + i)) / 32;
    const bytesAt = item + Number(at(ws, item + 1)) / 32;
    const len = Number(at(ws, bytesAt));
    const start = (bytesAt + 1) * 64;
    if (start + len * 2 > h.length) throw new Error('aggregate3 response is cut short');
    out.push({ success: at(ws, item) === 1n, data: `0x${h.slice(start, start + len * 2)}` });
  }
  return out;
}

/** v4 Quoter.quoteExactInputSingle with empty hook data. */
export function encodeV4Quote(key: PoolKey, zeroForOne: boolean, amountIn: bigint): string {
  if (key.tickSpacing <= 0) throw new Error('tick spacing must be positive');
  return `0x${SEL.quoteExactInputSingle}${word(0x20)}${addressWord(key.currency0)}${addressWord(
    key.currency1,
  )}${word(key.fee)}${word(key.tickSpacing)}${addressWord(key.hooks)}${word(zeroForOne)}${word(
    amountIn,
  )}${word(0x100)}${word(0)}`;
}

/** amountOut of a v4 quote; the second word is the Quoter's gas estimate. */
export function decodeV4Quote(hex: string): bigint {
  const ws = words(hex);
  if (ws.length !== 2) throw new Error(`v4 quote: expected 2 words, got ${ws.length}`);
  return at(ws, 0);
}

/** ClQuoter.quote(pool, zeroForOne, amountsIn, gasPerSwap). */
export function encodeClQuote(
  pool: string,
  zeroForOne: boolean,
  amountsIn: bigint[],
  gasPerSwap: bigint,
): string {
  return `0x${SEL.clQuote}${addressWord(pool)}${word(zeroForOne)}${word(0x80)}${word(gasPerSwap)}${word(
    amountsIn.length,
  )}${amountsIn.map(word).join('')}`;
}

/** (ins, outs) of ClQuoter.quote: two uint256 arrays of the same length. */
export function decodeClQuote(hex: string): { ins: bigint[]; outs: bigint[] } {
  const ws = words(hex);
  const list = (offsetWord: number) => {
    const start = Number(at(ws, offsetWord)) / 32;
    const n = Number(at(ws, start));
    return Array.from({ length: n }, (_, i) => at(ws, start + 1 + i));
  };
  const ins = list(0);
  const outs = list(1);
  if (ins.length !== outs.length) throw new Error('ClQuoter: ins and outs differ in length');
  return { ins, outs };
}

export const encodeGetSlot0 = (poolId: string) => {
  const id = strip(poolId).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`not a pool id: ${poolId}`);
  return `0x${SEL.getSlot0}${id}`;
};

/** PositionManager.poolKeys takes the first 25 bytes of the pool id. */
export const encodePoolKeys = (poolId: string) => {
  const id = strip(poolId).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`not a pool id: ${poolId}`);
  return `0x${SEL.poolKeys}${id.slice(0, 50).padEnd(64, '0')}`;
};

export function decodePoolKey(hex: string): PoolKey {
  const ws = words(hex);
  if (ws.length !== 5) throw new Error(`poolKeys: expected 5 words, got ${ws.length}`);
  return {
    currency0: wordToAddress(at(ws, 0)),
    currency1: wordToAddress(at(ws, 1)),
    fee: Number(at(ws, 2)),
    tickSpacing: wordToInt(at(ws, 3), 24),
    hooks: wordToAddress(at(ws, 4)),
  };
}

/** sqrtPriceX96: the first word of slot0() on a v3-style pool and of StateView.getSlot0(). */
export const decodeSqrtPrice = (hex: string): bigint => at(words(hex), 0);

/** balanceOf(holder) on an ERC-20. */
export const encodeBalanceOf = (holder: string) => `0x${SEL.balanceOf}${addressWord(holder)}`;

/** StateView.getLiquidity(poolId): the liquidity in range at the pool's price. */
export const encodeGetLiquidity = (poolId: string) => {
  const id = strip(poolId).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`not a pool id: ${poolId}`);
  return `0x${SEL.getLiquidity}${id}`;
};

/** A single unsigned integer answer (decimals(), balanceOf(), liquidity()). */
export const decodeUint = (hex: string): bigint => {
  const ws = words(hex);
  if (ws.length !== 1) throw new Error(`expected 1 word, got ${ws.length}`);
  return at(ws, 0);
};

/**
 * The answer of symbol(): a dynamic string, or on older tokens one bytes32 word padded with zeros.
 * Null when it is neither, or not printable text.
 */
export function decodeSymbol(hex: string): string | null {
  const h = strip(hex);
  if (h.length === 0 || h.length % 64 !== 0) return null;
  let bytes: string;
  if (h.length === 64) bytes = h.replace(/(00)+$/, '');
  else {
    const ws = words(hex);
    if (at(ws, 0) !== 32n) return null;
    const len = Number(at(ws, 1));
    if (len > (ws.length - 2) * 32) return null;
    bytes = h.slice(128, 128 + len * 2);
  }
  const text = Buffer.from(bytes, 'hex').toString('utf8');
  // printable ASCII only: a token's symbol is shown and compared, never trusted to be harmless
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

/** One 32-byte word for a signed integer (a tick, a bitmap word position), in two's complement. */
export const intWord = (v: number): string => {
  if (!Number.isInteger(v)) throw new Error(`not an integer: ${v}`);
  return BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
};

/** The tick in a slot0() or getSlot0() answer: its second word, an int24. */
export const decodeTick = (hex: string): number => wordToInt(at(words(hex), 1), 24);

/** liquidityNet of a tick: the second word of ticks(int24) and of getTickLiquidity(), an int128. */
export const decodeLiquidityNet = (hex: string): bigint => BigInt.asIntN(128, at(words(hex), 1));
