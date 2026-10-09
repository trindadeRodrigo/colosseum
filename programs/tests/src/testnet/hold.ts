// What the price copier does with one entry in a round (TNET-5), with and without `--hold-last`.
// Nothing here touches a chain: tests/testnet-solana-hold.test.ts runs it without the Solana toolchain.

/** One entry as Scope holds it: `value / 10^exponent` dollars, true at `unixTimestamp`. */
export type Stamped = { value: bigint; exponent: bigint; unixTimestamp: bigint };

export type Decision = 'copy' | 'hold' | 'unchanged';

/** The program takes a price up to 120 s old: a held price is stamped again once it is older than
 * this. With a round every 30 s that is every second round, so a held price is about 60 s old at
 * most, and one failed round still leaves it inside the limit. */
export const HOLD_PRICE_AFTER_S = 45n;
/** The program takes an average up to 3,600 s old. */
export const HOLD_AVERAGE_AFTER_S = 1_800n;
/** A source that has posted nothing for this long is not held any more: a long weekend is under
 * four days (Friday's close to Tuesday's open is 89.5 hours), and a feed that died, a halted stock
 * or an entry Scope retired has to go stale here as it does on mainnet. */
export const HOLD_SOURCE_MAX_AGE_S = 4n * 86_400n;

/**
 * `source` is what mainnet says now, `held` what the test network holds, `now` its clock.
 *
 * Without holding (`holdAfterS` null) an entry is copied when the source's time is newer, and that is
 * all. With it, an entry is also copied when the source's value differs: a held entry is stamped with
 * the cluster's clock, which is ahead of the source's next stamp, so the time alone would hide the
 * next real price. What is left standing is then the source's own value, and it is stamped again
 * only when older than `holdAfterS`. A value the source does not hold is never held, and nor is one
 * the source last posted more than `HOLD_SOURCE_MAX_AGE_S` ago.
 */
export function decide(
  source: Stamped,
  held: Stamped,
  now: bigint,
  holdAfterS: bigint | null,
): Decision {
  if (source.unixTimestamp > held.unixTimestamp) return 'copy';
  if (holdAfterS === null) return 'unchanged';
  if (source.value !== held.value || source.exponent !== held.exponent) return 'copy';
  if (now - source.unixTimestamp > HOLD_SOURCE_MAX_AGE_S) return 'unchanged';
  return now - held.unixTimestamp > holdAfterS ? 'hold' : 'unchanged';
}
