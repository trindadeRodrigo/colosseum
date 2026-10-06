// The oracle recorded beside the pool price (PLAN-UNIVERSE RU.7): latestRoundData() of every tracked
// stock's Chainlink feed, in one Multicall3 call at the block the run holds. The answer is written as
// read and never compared with, corrected by or blended into a pool price (gate ORACLE-VS-DEX): RU.9
// measures the gap. No I/O here.
import type { riskPriceObservations } from '@colosseum/db';
import { type Call, SEL } from './abi';
import type { TokenConfig } from './config';
import { decodeRound, unitsToDecimal } from './feeds';
import type { Reply } from './multicall';

export const ORACLE_METHOD_VERSION = 'evmo-0.1';
export const ORACLE_METHOD = 'chainlink_latest_round_at_the_run_block';
/** The value of `price_source` for these rows in risk_price_observations. */
export const PRICE_SOURCE = 'chainlink';

/** The feed of one tracked stock, from the asset list: the proxy the oracle map confirmed, and its decimals. */
export type ListedFeed = { address: string; decimals: number };

export type OracleNoReadReason = 'no_answer_from_the_feed' | 'answer_not_positive';

/** One feed's latest round at one block. */
export type OracleRow = {
  chain: string;
  assetMint: string;
  asset: string;
  /** The feed's proxy: the address the vault would read. */
  feed: string;
  /** Time and number of the block the round was read at. */
  fetchedAt: string;
  slot: number;
  roundId: string | null;
  /** As the contract gave it, an integer in the feed's decimals; and with the point placed. Null with `reason`. */
  answer: string | null;
  price: string | null;
  decimals: number;
  /** The feed's own time for the answer, and the block's time less that. */
  updatedAt: string | null;
  ageSeconds: number | null;
  reason: OracleNoReadReason | null;
  methodVersion: typeof ORACLE_METHOD_VERSION;
  method: typeof ORACLE_METHOD;
  source: string;
  provenance: 'live';
};

/** One read per feed. */
export const oracleCalls = (feeds: ListedFeed[]): Call[] =>
  feeds.map((f) => ({ target: f.address, callData: `0x${SEL.latestRoundData}` }));

export type OracleRowsInput = {
  chain: string;
  /** The tokens with a feed, each with its feed; `replies` are the answers to oracleCalls of the feeds, in order. */
  tokens: Array<{ token: TokenConfig; feed: ListedFeed }>;
  replies: Reply[];
  blockTime: Date;
  blockNumber: number;
  source: string;
};

/** One row per feed asked: the round as read, or null with the reason. Never a zero in place of a missing answer. */
export function oracleRows(r: OracleRowsInput): OracleRow[] {
  if (r.replies.length !== r.tokens.length)
    throw new Error(`oracleRows: ${r.tokens.length} feeds, ${r.replies.length} answers`);
  const blockSeconds = Math.floor(r.blockTime.getTime() / 1000);
  return r.tokens.map(({ token, feed }, i): OracleRow => {
    const round = decodeRound(r.replies[i] as Reply);
    const reason: OracleNoReadReason | null = !round
      ? 'no_answer_from_the_feed'
      : BigInt(round.answer) <= 0n
        ? 'answer_not_positive'
        : null;
    const read = reason === null ? round : null;
    return {
      chain: r.chain,
      assetMint: token.address,
      asset: token.symbol,
      feed: feed.address,
      fetchedAt: r.blockTime.toISOString(),
      slot: r.blockNumber,
      roundId: round?.roundId ?? null,
      answer: read ? read.answer : null,
      price: read ? unitsToDecimal(read.answer, feed.decimals) : null,
      decimals: feed.decimals,
      updatedAt: round ? new Date(round.updatedAt * 1000).toISOString() : null,
      ageSeconds: round ? blockSeconds - round.updatedAt : null,
      reason,
      methodVersion: ORACLE_METHOD_VERSION,
      method: ORACLE_METHOD,
      source: r.source,
      provenance: 'live',
    };
  });
}

/** A parsed JSONL line that is a whole oracle row, or null. */
export function parseOracleRow(line: unknown): OracleRow | null {
  if (typeof line !== 'object' || line === null) return null;
  const r = line as Record<string, unknown>;
  const text = ['chain', 'assetMint', 'asset', 'feed', 'fetchedAt', 'source', 'method'];
  if (text.some((k) => typeof r[k] !== 'string' || r[k] === '')) return null;
  if (r.methodVersion !== ORACLE_METHOD_VERSION || r.provenance !== 'live') return null;
  if (Number.isNaN(Date.parse(r.fetchedAt as string))) return null;
  if (!Number.isInteger(r.slot) || !Number.isInteger(r.decimals)) return null;
  if (r.price === null) return typeof r.reason === 'string' ? (r as unknown as OracleRow) : null;
  if (typeof r.price !== 'string' || !(Number(r.price) > 0)) return null;
  if (typeof r.updatedAt !== 'string' || Number.isNaN(Date.parse(r.updatedAt))) return null;
  if (r.reason !== null) return null;
  return r as unknown as OracleRow;
}

/**
 * The row as risk_price_observations takes it, or null for a row with no price (the table holds prices;
 * a failed read stays in the file). `observed_at` and `slot` are the block's; `source_ts` is the feed's
 * own `updatedAt`, so the age of every observation can be had from the row.
 */
export function toObservation(r: OracleRow): typeof riskPriceObservations.$inferInsert | null {
  if (r.price === null || r.updatedAt === null) return null;
  return {
    chain: r.chain,
    mint: r.assetMint,
    priceSource: PRICE_SOURCE,
    observedAt: new Date(r.fetchedAt),
    slot: r.slot,
    price: Number(r.price),
    quote: 'usd',
    ref: r.feed,
    market: null,
    live: true,
    failedChecks: null,
    sourceTs: new Date(r.updatedAt),
    marketStatus: null,
    methodVersion: r.methodVersion,
    source: r.source,
    method: r.method,
    fetchedAt: new Date(r.fetchedAt),
    provenance: r.provenance,
  };
}
