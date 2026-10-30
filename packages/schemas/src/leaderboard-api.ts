import { z } from 'zod';
import { BasketSheet } from './basket-sheet';
import { Address, AssetId, ChainId, DecimalString, Sourced } from './chain';
import { Provenance } from './enums';

// GET /v1/leaderboard: every open vault the server knows on a chain, ranked by what it made or lost.
// Anybody may read it, so a row holds only what is public on chain or measured by the server: no user
// id, no email, no name the owner typed and no number among their vaults (only the owner is answered
// that, gate VAULT-NUMBER). The owner is the short form of its wallet; the full one is on chain. The
// goal the vault was opened for is answered by its five structured fields only (gate LEADERBOARD,
// amended by Thom, Oct 30), never any text from the plan or its conversation.

/** The chains a leaderboard is answered for. Solana's test network today; more join this list. */
export const LeaderboardChain = z.enum(['solana']);
export type LeaderboardChain = z.infer<typeof LeaderboardChain>;

export const LeaderboardQuery = z.object({ chain: LeaderboardChain.default('solana') });
export type LeaderboardQuery = z.infer<typeof LeaderboardQuery>;

/** A decimal that may be below zero: what a vault made or lost. */
export const SignedDecimal = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, 'expected a decimal, with a sign where it is negative');
export type SignedDecimal = z.infer<typeof SignedDecimal>;

/** One thing a vault holds and its share of the vault's value, cash included. */
export const LeaderboardHolding = z.object({
  asset: AssetId,
  weightBps: z.number().int().min(0).max(10_000),
});
export type LeaderboardHolding = z.infer<typeof LeaderboardHolding>;

/**
 * What a vault made or lost: its value now less what went in, deposits less withdrawals, as the
 * portfolio's overview counts it. `pct` is `usd` over the deposits, a fraction (0.05 is 5%), whatever
 * was taken out since; null only where nothing was deposited.
 */
export const LeaderboardPnl = Sourced.extend({
  usd: SignedDecimal,
  pct: z.number().nullable(),
  netInUsd: SignedDecimal,
  depositsUsd: DecimalString,
  withdrawalsUsd: DecimalString,
  /** Tokens taken out that had no price when the withdrawal was made: they are in no sum. */
  unvaluedWithdrawals: z.number().int().nonnegative(),
});
export type LeaderboardPnl = z.infer<typeof LeaderboardPnl>;

/**
 * The goal a vault was opened for, as the board names the vault ("Grow $5,000"):
 * the five structured fields of its plan's sheet and nothing else, where the plan is its owner's own.
 */
export const LeaderboardGoal = BasketSheet.pick({
  goal: true,
  amountUsd: true,
  horizonMonths: true,
  horizonOpen: true,
  incomeTargetUsdMonthly: true,
}).strict();
export type LeaderboardGoal = z.infer<typeof LeaderboardGoal>;

/** Why a row has no figure for what it made: no deposit the server holds, or never read. */
export const LeaderboardNoPnl = z.enum(['no_deposit_record', 'never_read']);
export type LeaderboardNoPnl = z.infer<typeof LeaderboardNoPnl>;

export const LeaderboardRow = z.object({
  rank: z.number().int().positive(),
  chain: ChainId,
  address: Address,
  /** The wallet that owns it, shortened: the first four characters and the last four. */
  owner: z.string(),
  /** What it holds at its newest snapshot, the largest share first, cash included. */
  holdings: z.array(LeaderboardHolding),
  /** Its value at its newest snapshot, `fetchedAt` being when that snapshot was read. Null: never read. */
  value: Sourced.extend({ usd: DecimalString }).nullable(),
  pnl: LeaderboardPnl.nullable(),
  /** Set exactly where `pnl` is null. */
  noPnl: LeaderboardNoPnl.nullable(),
  /** The shared portfolio its newest snapshot shows it following, where the server names it. */
  follows: z.object({ name: z.string(), slug: z.string() }).nullable(),
  /**
   * The goal it was opened for, where the server holds the plan and the plan is the owner's own (or
   * made from a link). Null otherwise: a vault that follows a shared portfolio, one made outside this
   * app, one whose plan no longer reads.
   */
  goal: LeaderboardGoal.nullable().default(null),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

export const LeaderboardResponse = z.object({
  chain: ChainId,
  /** The chain's name as a person reads it. */
  name: z.string(),
  /** The label every figure here carries: `sandbox` on a test network. */
  provenance: Provenance,
  /** When this answer was read from the database. */
  readAt: z.string().datetime(),
  /** How the rows are ordered. */
  rule: z.string(),
  /**
   * The event window's start, where the server runs one: only vaults whose first confirmed deposit made
   * in this app is at or after it are listed. Null: every open vault.
   */
  since: z.string().datetime().nullable().default(null),
  vaults: z.array(LeaderboardRow),
  disclaimer: z.string(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponse>;
