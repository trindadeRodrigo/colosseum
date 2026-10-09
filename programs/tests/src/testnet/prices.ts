import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, address, getAddressDecoder, type TransactionSigner } from '@solana/kit';
import { decodeAssets } from '../basket';
import { REPO_ROOT } from '../env';
import { decodeRouter, routerAddress, writePriceInstruction } from '../mock-router';
import type { AccountView, Chain } from './chain';
import { decide, HOLD_AVERAGE_AFTER_S, HOLD_PRICE_AFTER_S, written } from './hold';
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
  /** `--hold-last`: an entry whose source has stopped is written again with the cluster's time and
   * the value the source still holds, so a closed market does not leave the test network stale. */
  holdLast?: boolean;
  log: (line: string) => void;
};

export type RoundResult = {
  written: string[];
  /** Assets whose entries were only stamped again (`holdLast`). */
  held: string[];
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
  capped: `no gap allows more than ${MAX_GAP_JUMP_BPS} bps: if the source is right, a person writes the entry with the admin key (write_price)`,
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
 * With `holdLast`, what each entry gets is `decide` in hold.ts.
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

  const result: RoundResult = {
    written: [],
    held: [],
    unchanged: [],
    refused: [],
    signatures: [],
  };
  const writes: {
    id: string;
    symbol: string;
    args: { priceIndex: number; twapIndex: number; price: Entry; twap: Entry };
    /** A line per entry stamped again, and whether that is all this write does. */
    holds: string[];
    onlyHeld: boolean;
  }[] = [];
  const posted = (entry: Entry) => new Date(Number(entry.unixTimestamp) * 1000).toISOString();
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
    const price = decide(
      reading.price,
      heldPrice,
      now,
      options.holdLast ? HOLD_PRICE_AFTER_S : null,
    );
    const twap = decide(
      reading.twap,
      heldTwap,
      now,
      options.holdLast ? HOLD_AVERAGE_AFTER_S : null,
    );
    if (price === 'unchanged' && twap === 'unchanged') {
      result.unchanged.push(asset.symbol);
      continue;
    }
    const why =
      (price === 'copy' &&
        refusal('price', reading.price, range, heldPrice, now, options.maxJumpBps)) ||
      (twap === 'copy' &&
        refusal('average', reading.twap, range, heldTwap, now, options.maxJumpBps));
    if (why) {
      result.refused.push({ id: asset.symbol, why });
      continue;
    }
    // A held entry keeps its value and takes the cluster's time; one left alone is written back as
    // the account holds it (`written` in hold.ts).
    const nextPrice = written(
      price,
      reading.price,
      heldPrice,
      now,
      options.holdLast ? HOLD_PRICE_AFTER_S : null,
    );
    const nextTwap = written(
      twap,
      reading.twap,
      heldTwap,
      now,
      options.holdLast ? HOLD_AVERAGE_AFTER_S : null,
    );
    writes.push({
      id: asset.id,
      symbol: asset.symbol,
      args: {
        priceIndex: asset.priceIndex,
        twapIndex: asset.twapIndex,
        price: nextPrice.entry,
        twap: nextTwap.entry,
      },
      holds: [
        ...(nextPrice.held
          ? [
              `${asset.symbol} at ${dollars(nextPrice.entry)} (source last posted ${posted(reading.price)})`,
            ]
          : []),
        ...(nextTwap.held
          ? [
              `${asset.symbol} average at ${dollars(nextTwap.entry)} (source last posted ${posted(reading.twap)})`,
            ]
          : []),
      ],
      onlyHeld: price !== 'copy' && twap !== 'copy',
    });
  }

  for (let i = 0; i < writes.length; i += 6) {
    const batch = writes.slice(i, i + 6);
    const instructions = await Promise.all(
      batch.map((w) => writePriceInstruction(writer, prices, w.args)),
    );
    if (options.dryRun) {
      for (const w of batch.filter((w) => !w.onlyHeld))
        options.log(
          `    would write ${w.symbol}: entry ${w.args.priceIndex} ${dollars(w.args.price)} at ${w.args.price.unixTimestamp}, entry ${w.args.twapIndex} ${dollars(w.args.twap)} at ${w.args.twap.unixTimestamp}`,
        );
    } else {
      const sent = await chain.send(writer, instructions);
      result.signatures.push(sent.signature);
    }
    for (const w of batch) {
      (w.onlyHeld ? result.held : result.written).push(w.symbol);
      for (const line of w.holds)
        options.log(`${options.dryRun ? '    would hold' : 'held'} ${line}`);
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
    ...(result.held.length
      ? [`${dryRun ? 'would hold' : 'held'} ${result.held.length}${list(result.held)}`]
      : []),
    `unchanged ${result.unchanged.length}${list(result.unchanged)}`,
    `refused ${result.refused.length}${list(refused)}`,
    ...(result.signatures.length ? [`tx ${result.signatures.join(' ')}`] : []),
  ].join('; ')}`;
}
