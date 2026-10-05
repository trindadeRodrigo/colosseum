import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, address, getAddressDecoder, type TransactionSigner } from '@solana/kit';
import { decodeAssets } from '../basket';
import { REPO_ROOT } from '../env';
import { decodeRouter, routerAddress, writePriceInstruction } from '../mock-router';
import type { AccountView, Chain } from './chain';
import type { Deployment } from './setup';

// The job that copies real prices onto a test network (TNET-5). It reads mainnet read only and
// writes the test exchange's price account on Solana devnet. The reading half is chain-free: it
// answers, per asset id, a price entry and an average entry with the source's own value, exponent
// and unix time. The writing half is Solana's. An EVM test network (TNET-1) adds a writer that takes
// the same readings; nothing in the reading half changes.

/** One entry as Scope holds it: `value / 10^exponent` dollars for one whole token, true at `unixTimestamp`. */
export type Entry = { value: bigint; exponent: bigint; unixTimestamp: bigint };

/** What the source says of one asset, or why it says nothing. */
export type Reading =
  | { id: string; price: Entry; twap: Entry; method: string }
  | { id: string; none: string };

type SourceAsset =
  | { kind: 'scope'; price: number[]; twap: number[]; method: string; source?: string }
  | {
      kind: 'jupiter-lend';
      lending: string;
      price: number[];
      twap: number[];
      method: string;
      source?: string;
    }
  | {
      kind: 'pool-mid';
      /** A Raydium CLMM pool of the token against USDC: the price is its mid. */
      pool: string;
      /** An Orca Whirlpool of the same pair the mid must agree with, to `maxSpreadBps`. */
      check: string;
      maxSpreadBps: number;
      mint: string;
      decimals: number;
      method: string;
      source?: string;
    }
  | { kind: 'none'; why: string };

export type Sources = {
  scope: { account: string; owner: string };
  assets: Record<string, SourceAsset>;
};

export const SOURCES_FILE = join(REPO_ROOT, 'scripts', 'testnet', 'solana', 'price-sources.json');

export function loadSources(path = SOURCES_FILE): Sources {
  return JSON.parse(readFileSync(path, 'utf8')) as Sources;
}

/** What the reading half needs of mainnet: an account's bytes and owner, and nothing else. */
export type Source = { account(target: Address): Promise<AccountView | null> };

/** No test price is written with more decimal places than this (programs/README.md, step 5). */
export const MAX_EXPONENT = 18n;
const U64_MAX = 2n ** 64n - 1n;
const JL_PRECISION_DIGITS = 12n;
const JL_LENDING_PROGRAM = 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JLUSDC_MINT = '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D';

const u64At = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

/** Entry `index` of a Scope-layout account: value, exponent, then the unix time at +24. */
export function entryAt(data: Uint8Array, index: number): Entry {
  const at = 40 + 56 * index;
  return {
    value: u64At(data, at),
    exponent: u64At(data, at + 8),
    unixTimestamp: u64At(data, at + 24),
  };
}

/** A product of entries scaled back into a u64 with at most 18 decimal places, rounded down. */
function scaledEntry(value: bigint, exponent: bigint, unixTimestamp: bigint): Entry {
  let [v, e] = [value, exponent];
  while (e > MAX_EXPONENT || v > U64_MAX) {
    v /= 10n;
    e -= 1n;
  }
  return { value: v, exponent: e, unixTimestamp };
}

/** One entry copied as it is, or a chain of them multiplied, stamped with the oldest time. */
function chained(data: Uint8Array, indexes: number[]): Entry {
  const entries = indexes.map((index) => entryAt(data, index));
  const [only] = entries;
  if (entries.length === 1 && only) return only;
  return scaledEntry(
    entries.reduce((product, e) => product * e.value, 1n),
    entries.reduce((sum, e) => sum + e.exponent, 0n),
    entries.reduce((oldest, e) => (e.unixTimestamp < oldest ? e.unixTimestamp : oldest), U64_MAX),
  );
}

/** Jupiter Lend's lending account: mint, fToken mint, id u16, decimals u8, rewards model, then
 * the liquidity exchange price, the token exchange price and the last update's unix time (u64s). */
function jupiterLendRate(data: Uint8Array): { rate: bigint; unixTimestamp: bigint } {
  const decoder = getAddressDecoder();
  const mint = decoder.decode(data.slice(8, 40));
  const fToken = decoder.decode(data.slice(40, 72));
  if (mint !== USDC_MINT || fToken !== JLUSDC_MINT)
    throw new Error(`the lending account is for ${fToken} over ${mint}, not jlUSDC over USDC`);
  return { rate: u64At(data, 115), unixTimestamp: u64At(data, 123) };
}

const older = (a: bigint, b: bigint) => (a < b ? a : b);

const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
/** A pool's mid is written with this many decimal places. */
const POOL_EXPONENT = 8n;

const u128At = (data: Uint8Array, at: number) => u64At(data, at) + (u64At(data, at + 8) << 64n);

/** Dollars for one whole token at a pool's sqrt price, the token being mint 0 against USDC (6
 * decimals) at one dollar: (sqrt / 2^64)^2 · 10^(decimals − 6), scaled by 10^8, rounded down. */
const midOf = (sqrtX64: bigint, decimals: number) => {
  const shift = BigInt(decimals - 6) + POOL_EXPONENT;
  return (sqrtX64 * sqrtX64 * 10n ** shift) >> 128n;
};

/** A Raydium CLMM pool's two mints and sqrt price, and an Orca Whirlpool's (programs/risk decoders). */
function poolSide(data: Uint8Array, owner: string) {
  const decoder = getAddressDecoder();
  if (owner === RAYDIUM_CLMM && data.length === 1544)
    return {
      mint0: decoder.decode(data.slice(73, 105)),
      mint1: decoder.decode(data.slice(105, 137)),
      sqrtX64: u128At(data, 253),
    };
  if (owner === ORCA_WHIRLPOOL && data.length === 653)
    return {
      mint0: decoder.decode(data.slice(101, 133)),
      mint1: decoder.decode(data.slice(181, 213)),
      sqrtX64: u128At(data, 65),
    };
  throw new Error(
    `${owner} is neither a Raydium CLMM pool nor an Orca Whirlpool of the expected size`,
  );
}

/** The mid of a token's USDC pool, checked against a second pool, stamped with mainnet's clock at
 * the read. The pool keeps no average: the same mid stands as the average entry. */
async function poolMid(
  source: Source,
  asset: Extract<SourceAsset, { kind: 'pool-mid' }>,
): Promise<{ price: Entry; twap: Entry }> {
  const [pool, check, clock] = await Promise.all([
    source.account(address(asset.pool)),
    source.account(address(asset.check)),
    source.account(CLOCK),
  ]);
  if (!pool || !check || !clock) throw new Error('a pool or the clock is not there');
  const mids = [pool, check].map((account) => {
    const side = poolSide(account.data, account.owner);
    if (side.mint0 !== asset.mint || side.mint1 !== USDC_MINT)
      throw new Error(
        `a pool is ${side.mint0} against ${side.mint1}, not ${asset.mint} against USDC`,
      );
    return midOf(side.sqrtX64, asset.decimals);
  });
  const [mid = 0n, other = 0n] = mids;
  const apart = mid > other ? mid - other : other - mid;
  if (mid === 0n || apart * 10_000n > mid * BigInt(asset.maxSpreadBps))
    throw new Error(`the two pools' mids are more than ${asset.maxSpreadBps} bps apart`);
  const unixTimestamp = new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(
    32,
    true,
  );
  const entry = { value: mid, exponent: POOL_EXPONENT, unixTimestamp };
  return { price: entry, twap: entry };
}

/** Reads every asset of `sources` from mainnet. An asset whose source cannot be read says why. */
export async function readPrices(source: Source, sources: Sources): Promise<Reading[]> {
  const scope = await source.account(address(sources.scope.account));
  const scopeError = !scope
    ? 'the Scope account is not there'
    : scope.owner !== sources.scope.owner
      ? `the Scope account is owned by ${scope.owner}`
      : scope.data.length !== 28_712
        ? `the Scope account is ${scope.data.length} bytes`
        : null;
  const readings: Reading[] = [];
  for (const [id, asset] of Object.entries(sources.assets)) {
    if (asset.kind === 'none') {
      readings.push({ id, none: asset.why });
      continue;
    }
    if (scopeError || !scope) {
      readings.push({ id, none: scopeError ?? 'no Scope account' });
      continue;
    }
    if (asset.kind === 'scope') {
      readings.push({
        id,
        price: chained(scope.data, asset.price),
        twap: chained(scope.data, asset.twap),
        method: asset.method,
      });
      continue;
    }
    if (asset.kind === 'pool-mid') {
      try {
        readings.push({ id, ...(await poolMid(source, asset)), method: asset.method });
      } catch (error) {
        readings.push({ id, none: (error as Error).message });
      }
      continue;
    }
    const lending = await source.account(address(asset.lending));
    if (!lending || lending.owner !== JL_LENDING_PROGRAM) {
      readings.push({ id, none: `the lending account ${asset.lending} is not Jupiter Lend's` });
      continue;
    }
    try {
      const { rate, unixTimestamp } = jupiterLendRate(lending.data);
      const times = (dollars: Entry): Entry =>
        scaledEntry(
          dollars.value * rate,
          dollars.exponent + JL_PRECISION_DIGITS,
          older(dollars.unixTimestamp, unixTimestamp),
        );
      readings.push({
        id,
        price: times(chained(scope.data, asset.price)),
        twap: times(chained(scope.data, asset.twap)),
        method: asset.method,
      });
    } catch (error) {
      readings.push({ id, none: (error as Error).message });
    }
  }
  return readings;
}

// ---- the Solana writer ----

export type CopyOptions = {
  dryRun: boolean;
  /** Refuse a value more than this far from the last value copied for the same entry. */
  maxJumpBps: number;
  /** The last value copied per entry, by `<id>:price` and `<id>:twap`; updated as values land. */
  last: Map<string, Entry>;
  log: (line: string) => void;
};

export type RoundResult = {
  written: string[];
  unchanged: string[];
  refused: { id: string; why: string }[];
  signatures: string[];
};

/** Millionths of a dollar, as the asset list's ranges hold them, rounded down. */
const micros = (entry: Entry) => (entry.value * 1_000_000n) / 10n ** entry.exponent;
const dollars = (entry: Entry) => (Number(entry.value) / 10 ** Number(entry.exponent)).toString();
const asDollars = (micro: bigint) => (Number(micro) / 1e6).toString();

/** Why an entry must not be written, or null. */
function refusal(
  what: string,
  entry: Entry,
  range: { min: bigint; max: bigint } | null,
  last: Entry | undefined,
  now: bigint,
  maxJumpBps: number,
): string | null {
  if (entry.value === 0n || entry.unixTimestamp === 0n) return `${what} holds no price`;
  if (entry.exponent > MAX_EXPONENT) return `${what} has exponent ${entry.exponent}`;
  if (entry.unixTimestamp > now + 60n)
    return `${what} is stamped ${entry.unixTimestamp - now} s ahead of the cluster's clock`;
  const price = micros(entry);
  if (range && (price < range.min || price > range.max))
    return `${what} ${dollars(entry)} is outside the keeper range ${asDollars(range.min)} to ${asDollars(range.max)}`;
  if (last) {
    const before = micros(last);
    const move = price > before ? price - before : before - price;
    if (before > 0n && move * 10_000n > before * BigInt(maxJumpBps))
      return `${what} ${dollars(entry)} is more than ${maxJumpBps} bps from the last copied ${dollars(last)}`;
  }
  return null;
}

/**
 * One round on Solana: reads what the price account holds, writes the entries whose source time is
 * newer, six assets a transaction, signed by the price writer the exchange names. The deploy key
 * (the exchange's admin) is refused: the copier holds the one key that can do nothing but this.
 */
export async function copyRound(
  chain: Chain,
  writer: TransactionSigner,
  deployment: Deployment,
  readings: Reading[],
  options: CopyOptions,
): Promise<RoundResult> {
  const router = await chain.account(await routerAddress());
  if (!router) throw new Error('the test exchange is not on this network');
  const exchange = decodeRouter(router.data);
  if (writer.address === exchange.admin)
    throw new Error(
      "the deploy key is the exchange's admin: the copier signs with the price writer",
    );
  if (writer.address !== exchange.priceWriter)
    throw new Error(
      `the exchange's price writer is ${exchange.priceWriter}, not ${writer.address}`,
    );
  const prices = deployment.accounts.priceAccount;
  if (exchange.prices !== prices)
    throw new Error(
      `the exchange's price account is ${exchange.prices}, not the record's ${prices}`,
    );
  const held = await chain.account(prices);
  if (!held) throw new Error(`the price account ${prices} is not on this network`);
  const listed = await chain.account(deployment.accounts.assets);
  const entries = listed ? decodeAssets(listed.data).assets : [];
  const now = await chain.now();

  const result: RoundResult = { written: [], unchanged: [], refused: [], signatures: [] };
  const writes: {
    id: string;
    symbol: string;
    args: { priceIndex: number; twapIndex: number; price: Entry; twap: Entry };
  }[] = [];
  for (const reading of readings) {
    const asset = deployment.assets.find((a) => a.id === reading.id);
    if (!asset) {
      result.refused.push({ id: reading.id, why: 'not an asset of this network' });
      continue;
    }
    if ('none' in reading) {
      result.unchanged.push(`${asset.symbol} (no source)`);
      continue;
    }
    const onChain = entries.find((e) => e.mint === asset.mint);
    const range =
      onChain && (onChain.minPrice > 0n || onChain.maxPrice > 0n)
        ? { min: onChain.minPrice, max: onChain.maxPrice }
        : null;
    if ([reading.price, reading.twap].some((e) => e.value === 0n || e.unixTimestamp === 0n)) {
      result.refused.push({ id: asset.symbol, why: 'the source holds no price' });
      continue;
    }
    const heldPrice = entryAt(held.data, asset.priceIndex);
    const heldTwap = entryAt(held.data, asset.twapIndex);
    const newerPrice = reading.price.unixTimestamp > heldPrice.unixTimestamp;
    const newerTwap = reading.twap.unixTimestamp > heldTwap.unixTimestamp;
    if (!newerPrice && !newerTwap) {
      result.unchanged.push(asset.symbol);
      continue;
    }
    const why =
      (newerPrice &&
        refusal(
          'price',
          reading.price,
          range,
          options.last.get(`${asset.id}:price`),
          now,
          options.maxJumpBps,
        )) ||
      (newerTwap &&
        refusal(
          'average',
          reading.twap,
          range,
          options.last.get(`${asset.id}:twap`),
          now,
          options.maxJumpBps,
        ));
    if (why) {
      result.refused.push({ id: asset.symbol, why });
      continue;
    }
    // An entry whose source is not newer is written back as the account holds it.
    writes.push({
      id: asset.id,
      symbol: asset.symbol,
      args: {
        priceIndex: asset.priceIndex,
        twapIndex: asset.twapIndex,
        price: newerPrice ? reading.price : heldPrice,
        twap: newerTwap ? reading.twap : heldTwap,
      },
    });
  }

  for (let i = 0; i < writes.length; i += 6) {
    const batch = writes.slice(i, i + 6);
    const instructions = await Promise.all(
      batch.map((w) => writePriceInstruction(writer, prices, w.args)),
    );
    if (options.dryRun) {
      for (const w of batch)
        options.log(
          `    would write ${w.symbol}: entry ${w.args.priceIndex} ${dollars(w.args.price)} at ${w.args.price.unixTimestamp}, entry ${w.args.twapIndex} ${dollars(w.args.twap)} at ${w.args.twap.unixTimestamp}`,
        );
    } else {
      const sent = await chain.send(writer, instructions);
      result.signatures.push(sent.signature);
    }
    for (const w of batch) {
      result.written.push(w.symbol);
      options.last.set(`${w.id}:price`, w.args.price);
      options.last.set(`${w.id}:twap`, w.args.twap);
    }
  }
  return result;
}

/** The round's one line: what was written, what was unchanged, what was refused and why. */
export function roundLine(at: Date, round: number, result: RoundResult, dryRun: boolean): string {
  const list = (items: string[]) => (items.length ? ` (${items.join(', ')})` : '');
  const refused = result.refused.map((r) => `${r.id}: ${r.why}`);
  return `${at.toISOString()} round ${round}${dryRun ? ' (dry run)' : ''}: ${[
    `${dryRun ? 'would write' : 'wrote'} ${result.written.length}${list(result.written)}`,
    `unchanged ${result.unchanged.length}${list(result.unchanged)}`,
    `refused ${result.refused.length}${list(refused)}`,
    ...(result.signatures.length ? [`tx ${result.signatures.join(' ')}`] : []),
  ].join('; ')}`;
}
