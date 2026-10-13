// When a stock asset trades, by the rule the vault's keeper path holds to (`_marketOpen` in
// contracts/src/BasketVault.sol): Monday to Friday UTC, from `sessionOpen` to before `sessionClose`
// seconds after midnight, not on a closed day, and not before `closedUntil`. An asset whose session is
// 0 trades at all hours.

export const DAY_SECONDS = 86_400n;

/** Days since 1970, UTC: what `closedDay(uint32)` is asked with. */
export const dayOf = (unixSeconds: bigint): number => Number(unixSeconds / DAY_SECONDS);

export function marketAt(
  session: 'always' | 'us_equity',
  rules: { sessionOpen: number; sessionClose: number; closedUntil: bigint; closedToday: boolean },
  now: bigint,
): 'open' | 'closed' {
  if (session === 'always') return 'open';
  if (now < 0n) return 'closed';
  const day = now / DAY_SECONDS;
  const second = now % DAY_SECONDS;
  // Day 0 was a Thursday.
  const weekday = Number((day + 4n) % 7n);
  const inSession =
    weekday >= 1 &&
    weekday <= 5 &&
    second >= BigInt(rules.sessionOpen) &&
    second < BigInt(rules.sessionClose);
  return inSession && !rules.closedToday && now >= rules.closedUntil ? 'open' : 'closed';
}
