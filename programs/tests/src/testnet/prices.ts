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
      updatedAt: 0n,
    };
  if (owner === ORCA_WHIRLPOOL && data.length === 653)
    return {
      mint0: decoder.decode(data.slice(101, 133)),
      mint1: decoder.decode(data.slice(181, 213)),
      sqrtX64: u128At(data, 65),
      /** `reward_last_updated_timestamp`: moved by every swap and every change of liquidity. */
      updatedAt: u64At(data, 261),
    };
  throw new Error(
    `${owner} is neither a Raydium CLMM pool nor an Orca Whirlpool of the expected size`,
  );
}

/** The mid of a token's USDC pool, checked against an Orca Whirlpool of the pair and stamped with
 * that pool's own last update, so the price goes stale when the pool does. The pool keeps no
 * average: the same mid stands as the average entry. */
async function poolMid(
  source: Source,
  asset: Extract<SourceAsset, { kind: 'pool-mid' }>,
): Promise<{ price: Entry; twap: Entry }> {
  const [pool, check] = await Promise.all([
    source.account(address(asset.pool)),
    source.account(address(asset.check)),
  ]);
  if (!pool || !check) throw new Error('a pool is not there');
  if (pool.owner !== RAYDIUM_CLMM || check.owner !== ORCA_WHIRLPOOL)
    throw new Error('the pool is not a Raydium CLMM pool, or the check is not an Orca Whirlpool');
  const sides = [pool, check].map((account) => {
    const side = poolSide(account.data, account.owner);
    if (side.mint0 !== asset.mint || side.mint1 !== USDC_MINT)
      throw new Error(
        `a pool is ${side.mint0} against ${side.mint1}, not ${asset.mint} against USDC`,
      );
    return side;
  });
  const [mid = 0n, other = 0n] = sides.map((side) => midOf(side.sqrtX64, asset.decimals));
  const apart = mid > other ? mid - other : other - mid;
  if (mid === 0n || apart * 10_000n > mid * BigInt(asset.maxSpreadBps))
    throw new Error(`the two pools' mids are more than ${asset.maxSpreadBps} bps apart`);
  const unixTimestamp = sides[1]?.updatedAt ?? 0n;
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
    try {
      const lending = await source.account(address(asset.lending));
      if (!lending || lending.owner !== JL_LENDING_PROGRAM)
        throw new Error(`the lending account ${asset.lending} is not Jupiter Lend's`);
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
  /** Refuse a value further than this from what devnet holds, per hour since devnet's entry was
   * stamped (at least one hour's worth, at most `MAX_GAP_JUMP_BPS`), so a token that moved while
   * the copier was stopped is copied when it starts again. */
  maxJumpBps: number;
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

/** However long the gap, a move above this is refused: the keeper range bounds what is left. */
export const MAX_GAP_JUMP_BPS = 5_000;
/** What a person does about a refusal that keeps coming back. */
export const HINT = {
  range: 'if it persists, a person checks the source and moves the range (upsert_asset)',
  jump: `if it persists, a person checks the source and raises --max-jump-bps (no gap allows more than ${MAX_GAP_JUMP_BPS} bps) or moves the range`,
  capped: `no gap allows more than ${MAX_GAP_JUMP_BPS} bps: if the source is right, a person moves the range (upsert_asset) and writes the entry with the admin key`,
};

/** Why an entry must not be written, or null. `held` is what devnet holds for the same entry. */
function refusal(
  what: string,
  entry: Entry,
  range: { min: bigint; max: bigint } | null,
  held: Entry,
  now: bigint,
  maxJumpBps: number,
): string | null {
  if (entry.value === 0n || entry.unixTimestamp === 0n) return `${what} holds no price`;
  if (entry.exponent > MAX_EXPONENT) return `${what} has exponent ${entry.exponent}`;
  if (entry.unixTimestamp > now + 60n)
    return `${what} is stamped ${entry.unixTimestamp - now} s ahead of the cluster's clock`;
  const price = micros(entry);
  if (range && (price < range.min || price > range.max))
    return `${what} ${dollars(entry)} is outside the keeper range ${asDollars(range.min)} to ${asDollars(range.max)}; ${HINT.range}`;
  const before = held.value > 0n ? micros(held) : 0n;
  if (before > 0n) {
    const hours = Math.max(1, Number(now - held.unixTimestamp) / 3600);
    const allowed = Math.min(MAX_GAP_JUMP_BPS, Math.round(maxJumpBps * hours));
    const move = price > before ? price - before : before - price;
    if (move * 10_000n > before * BigInt(allowed))
      return `${what} ${dollars(entry)} is more than ${allowed} bps from the ${dollars(held)} devnet holds; ${allowed === MAX_GAP_JUMP_BPS ? HINT.capped : HINT.jump}`;
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
      result.unchanged.push(`${asset.symbol} (no source: ${reading.none})`);
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
      (newerPrice && refusal('price', reading.price, range, heldPrice, now, options.maxJumpBps)) ||
      (newerTwap && refusal('average', reading.twap, range, heldTwap, now, options.maxJumpBps));
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
    for (const w of batch) result.written.push(w.symbol);
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
