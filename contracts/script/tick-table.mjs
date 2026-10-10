#!/usr/bin/env node
// Prints the table `src/price/TickPrice.sol` carries: for i from 0 to 18, the whole part of
// 2^128 * 1.0001^(-2^i), worked in exact integers (10000^(2^i) * 2^128 / 10001^(2^i)).
//
//   node contracts/script/tick-table.mjs
//   node contracts/script/tick-table.mjs --vectors
//   node contracts/script/tick-table.mjs --fixture     writes test/fixtures/tick-price-vectors.json
//
// `test/TickPrice.t.sol` holds the first entry to 2^128 * 10000 / 10001 and each next one to the square
// of the one before, so the table in the contract cannot drift from what this prints. With `--vectors`
// it prints the prices that test compares the library with: the whole part of 1.0001^tick * 10^scale,
// again in exact integers.
//
// `--fixture` writes four thousand vectors, the same every run: the ends of the range, and ticks and
// scales drawn across all of it. The Foundry test and packages/chain-evm/test/pool-average.test.ts both
// read that one file, so the contract's maths and its off-chain copy are held to the same exact values.
// So many exact powers of 10001 would take an hour, so each value is first worked in 700-bit fixed
// point with a bound on its error; where the bound leaves the whole part in no doubt (every time, so
// far) that is the answer, and where it does not, the exact integers decide.

import { writeFileSync } from 'node:fs';

const Q128 = 1n << 128n;

/** The whole part of 1.0001^tick * 10^scale. */
function exact(tick, scale) {
  const n = BigInt(Math.abs(tick));
  const [num, den] = tick >= 0 ? [10001n ** n, 10000n ** n] : [10000n ** n, 10001n ** n];
  return scale >= 0 ? (num * 10n ** BigInt(scale)) / den : num / (den * 10n ** BigInt(-scale));
}

const BITS = 700n;
const ONE = 1n << BITS;
/** 1.0001^(2^i) in 700-bit fixed point, rounded down: each within a part in 2^680 of the true value. */
const POWERS = (() => {
  const out = [(10001n * ONE) / 10000n];
  for (let i = 1; i <= 18; i++) out.push((out[i - 1] * out[i - 1]) >> BITS);
  return out;
})();

/** The whole part of 1.0001^tick * 10^scale: by bounds where they agree, by exact integers where not. */
function whole(tick, scale) {
  let low = ONE;
  const n = Math.abs(tick);
  for (let i = 0; i <= 18; i++) if ((n >> i) & 1) low = (low * POWERS[i]) >> BITS;
  // Nineteen factors, each a part in 2^680 under: the product is under by less than a part in 2^660.
  const high = low + (low >> 660n) + 1n;
  const up = scale >= 0 ? 10n ** BigInt(scale) : 1n;
  const down = scale >= 0 ? 1n : 10n ** BigInt(-scale);
  const [least, most] =
    tick >= 0
      ? [(low * up) / (ONE * down), (high * up) / (ONE * down)]
      : [(ONE * up) / (high * down), (ONE * up) / (low * down)];
  return least === most ? least : exact(tick, scale);
}

/** A small generator with a fixed seed (mulberry32), so the file is the same every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (process.argv.includes('--fixture')) {
  const MAX = 443636;
  const random = seeded(20261009);
  const pairs = [];
  for (const tick of [0, 1, -1, MAX, -MAX, MAX - 1, 1 - MAX, 221937, -221937, 209730, -209730])
    for (const scale of [-18, -4, 0, 8, 20, 36]) pairs.push([tick, scale]);
  // The bound checked against the exact integers where the powers are small enough to be quick.
  for (const [tick, scale] of pairs.filter(([t]) => Math.abs(t) <= 1))
    if (whole(tick, scale) !== exact(tick, scale))
      throw new Error('the bound disagrees with exact');
  while (pairs.length < 4000)
    pairs.push([Math.floor(random() * (2 * MAX + 1)) - MAX, Math.floor(random() * 55) - 18]);
  const file = {
    about:
      'Written by contracts/script/tick-table.mjs --fixture; do not edit. Each vector is "tick scale whole": whole is the whole part of 1.0001^tick * 10^scale, in exact arithmetic. TickPrice.priceAt and its off-chain copy must never be above it, and under it by at most one unit and a part in 2^58.',
    vectors: pairs.map(([t, s]) => `${t} ${s} ${whole(t, s)}`),
  };
  const path = new URL('../test/fixtures/tick-price-vectors.json', import.meta.url);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${pairs.length} vectors written`);
} else if (process.argv.includes('--vectors')) {
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
