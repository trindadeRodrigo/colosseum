import { ChainError } from '@colosseum/schemas';
import type { Address, Commitment } from '@solana/kit';
import type { ConfigAccount } from './accounts';
import { getAccounts, type RawAccount, type VaultRpc } from './rpc';
import { decodeScopeEntry, isScopeEntrySet, SCOPE_PRICES_BYTES, scopePrice } from './scope';

/** The clock sysvar: what the cluster, and so the vault program, takes the time to be. */
export const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111' as Address;

export type ClusterClock = { slot: bigint; unixTimestamp: bigint };

/** slot u64 | epoch start i64 | epoch u64 | leader schedule epoch u64 | unix time i64 */
export function decodeClock(account: RawAccount | null): ClusterClock {
  if (!account || account.data.length < 40)
    throw new ChainError('Unavailable', 'the RPC returned no clock sysvar');
  const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  return { slot: view.getBigUint64(0, true), unixTimestamp: view.getBigInt64(32, true) };
}

export type ScopeReading = {
  index: number;
  /** USD for one whole token, as an exact decimal. */
  usdPerToken: string;
  /** The cluster's clock minus the entry's time; zero when the entry is a little ahead of the clock. */
  ageSeconds: number;
  /** Unix seconds of the entry. */
  updatedAt: number;
};

/** One entry to read, and the asset it prices, for the message of a refusal. */
export type ScopeQuery = { index: number; asset?: string };

export type ScopeChecks = {
  /**
   * How far ahead of the cluster's clock an entry's time may be and still count as fresh. Clocks differ
   * by seconds; anything further ahead was not stamped in unix seconds (milliseconds, say) and would
   * otherwise read as zero seconds old for ever. The reader passes `Config.max_price_age_s`.
   */
  maxAheadSeconds: number;
  /** When given, the account must start with these eight bytes. */
  discriminator?: Uint8Array;
};

/** The skew allowed where no Config is at hand: the starting value of `max_price_age_s`. */
export const DEFAULT_MAX_AHEAD_SECONDS = 120;

/**
 * Reads entries out of a price account that has already been fetched, with the clock of the same
 * moment. Refuses with `AssetNotPriced` when the account is missing, is not owned by `owner`, is not
 * the size of Scope's price account, or an entry holds no price or is stamped in the future. Nothing
 * is filled in.
 */
export function readScopeAccount(
  account: RawAccount | null,
  owner: Address,
  entries: ScopeQuery[],
  clock: ClusterClock,
  checks: ScopeChecks = { maxAheadSeconds: DEFAULT_MAX_AHEAD_SECONDS },
): ScopeReading[] {
  const refuse = (why: string): never => {
    throw new ChainError('AssetNotPriced', why);
  };
  if (!account) return refuse('the price account does not exist on this network');
  if (account.owner !== owner)
    return refuse(`the price account is owned by ${account.owner}, not by the price program`);
  if (account.data.length !== SCOPE_PRICES_BYTES)
    return refuse(`the price account is ${account.data.length} bytes, not Scope's layout`);
  const tag = checks.discriminator;
  if (tag && !tag.every((byte, i) => account.data[i] === byte))
    return refuse("the price account does not start with the discriminator of Scope's prices");
  return entries.map(({ index, asset }) => {
    const what = `entry ${index} of the price account${asset ? ` (${asset})` : ''}`;
    const entry = decodeScopeEntry(account.data, index);
    if (!isScopeEntrySet(entry)) return refuse(`${what} holds no price`);
    const age = clock.unixTimestamp - entry.unixTimestamp;
    if (age < -BigInt(checks.maxAheadSeconds))
      return refuse(`${what} is stamped ${-age} s ahead of the cluster's clock`);
    return {
      index,
      usdPerToken: scopePrice(entry),
      ageSeconds: age > 0n ? Number(age) : 0,
      updatedAt: Number(entry.unixTimestamp),
    };
  });
}

/**
 * Fetches a Scope-layout price account and the clock in one call and reads `entries` out of it.
 * `owner` is the program that must own the account: `Config.price_owner` on a network where the vault
 * program runs.
 */
export async function readScopePrices(
  rpc: VaultRpc,
  query: { account: Address; owner: Address; entries: ScopeQuery[] } & Partial<ScopeChecks>,
  commitment: Commitment = 'confirmed',
): Promise<{ clock: ClusterClock; readings: ScopeReading[] }> {
  const [account, clockAccount] = await getAccounts(rpc, [query.account, SYSVAR_CLOCK], commitment);
  const clock = decodeClock(clockAccount ?? null);
  const checks = {
    maxAheadSeconds: query.maxAheadSeconds ?? DEFAULT_MAX_AHEAD_SECONDS,
    discriminator: query.discriminator,
  };
  return {
    clock,
    readings: readScopeAccount(account ?? null, query.owner, query.entries, clock, checks),
  };
}

const DAY = 86_400n;

/**
 * Whether the vault program would take a keeper trade in a stock token at this clock: DESIGN-VAULT
 * section 5, check 9, from the program's own Config. Monday to Friday, from the session's open up to
 * but not at its close, not a closed day, and from `closed_until` on. A session whose close is not
 * after its open is never open. An asset that trades at all hours is always open. The keeper leg
 * (SOL-3) has to hold to the same rule, or this changes with it.
 */
export function marketAt(
  session: 'always' | 'us_equity',
  config: Pick<
    ConfigAccount,
    'sessionOpenUtcS' | 'sessionCloseUtcS' | 'closedUntil' | 'closedDays'
  >,
  clock: ClusterClock,
): 'open' | 'closed' {
  if (session === 'always') return 'open';
  const now = clock.unixTimestamp;
  if (now < 0n) return 'closed';
  const day = now / DAY;
  const second = now % DAY;
  // Day 0 was a Thursday.
  const weekday = Number((day + 4n) % 7n);
  const inSession =
    weekday >= 1 &&
    weekday <= 5 &&
    second >= BigInt(config.sessionOpenUtcS) &&
    second < BigInt(config.sessionCloseUtcS);
  // A zero in `closed_days` is an empty slot, not Jan 1, 1970.
  const closedDay = day > 0n && config.closedDays.some((d) => BigInt(d) === day);
  return inSession && !closedDay && now >= config.closedUntil ? 'open' : 'closed';
}
