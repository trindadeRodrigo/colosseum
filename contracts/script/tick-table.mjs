#!/usr/bin/env node
// Prints the table `src/price/TickPrice.sol` carries: for i from 0 to 18, the whole part of
// 2^128 * 1.0001^(-2^i), worked in exact integers (10000^(2^i) * 2^128 / 10001^(2^i)).
//
//   node contracts/script/tick-table.mjs
//   node contracts/script/tick-table.mjs --vectors
//
// `test/TickPrice.t.sol` holds the first entry to 2^128 * 10000 / 10001 and each next one to the square
// of the one before, so the table in the contract cannot drift from what this prints. With `--vectors`
// it prints the prices that test compares the library with: the whole part of 1.0001^tick * 10^scale,
// again in exact integers.

const Q128 = 1n << 128n;

/** The whole part of 1.0001^tick * 10^scale. */
function exact(tick, scale) {
  const n = BigInt(Math.abs(tick));
  const [num, den] = tick >= 0 ? [10001n ** n, 10000n ** n] : [10000n ** n, 10001n ** n];
  return scale >= 0 ? (num * 10n ** BigInt(scale)) / den : num / (den * 10n ** BigInt(-scale));
}

if (process.argv.includes('--vectors')) {
  const VECTORS = [
    [0, 20],
    [1, 20],
    [-1, 20],
    [10, 8],
    [-10, 8],
    [100, 20],
    [-101, 20],
    [-221937, 20],
    [221937, -4],
    [-209730, 20],
    [-230270, 20],
    [443636, 0],
    [443636, 36],
    [443636, -18],
    [-443636, 36],
    [-443636, 0],
  ];
  for (const [tick, scale] of VECTORS) console.log(`${tick} ${scale} ${exact(tick, scale)}`);
} else {
  for (let i = 0n; i <= 18n; i++) {
    const n = 1n << i;
    const value = (10000n ** n * Q128) / 10001n ** n;
    console.log(`i=${String(i).padStart(2)}  0x${value.toString(16)}`);
  }
}
