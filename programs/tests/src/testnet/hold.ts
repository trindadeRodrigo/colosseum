// What the price copier does with one entry in a round (TNET-5), with and without `--hold-last`.
// Nothing here touches a chain: tests/testnet-solana-hold.test.ts runs it without the Solana toolchain.

/** One entry as Scope holds it: `value / 10^exponent` dollars, true at `unixTimestamp`. */
export type Stamped = { value: bigint; exponent: bigint; unixTimestamp: bigint };

export type Decision = 'copy' | 'hold' | 'unchanged';

/** The program takes a price up to 120 s old: a held price is stamped again once it is older than this. */
export const HOLD_PRICE_AFTER_S = 60n;
/** The program takes an average up to 3,600 s old. */
export const HOLD_AVERAGE_AFTER_S = 1_800n;

/**
 * `source` is what mainnet says now, `held` what the test network holds, `now` its clock.
 *
 * Without holding (`holdAfterS` null) an entry is copied when the source's time is newer, and that is
 * all. With it, an entry is also copied when the source's value differs: a held entry is stamped with
 * the cluster's clock, which is ahead of the source's next stamp, so the time alone would hide the
 * next real price. What is left standing is then the source's own value, and it is stamped again
 * only when older than `holdAfterS`. A value the source does not hold is never held.
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
  return now - held.unixTimestamp > holdAfterS ? 'hold' : 'unchanged';
}
