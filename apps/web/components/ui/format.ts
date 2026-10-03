// Small formatters the primitives share. They format what they are handed and decide nothing.

/** An ISO 8601 instant in UTC with no fraction: `2026-10-01T14:02:11Z`. Null when the input is not a date. */
export function isoUtc(value: string): string | null {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export type Age = {
  /** Beside the glyph: `3 h`. */
  short: string;
  /** In the accessible name: `3 hours old`. */
  long: string;
};

/**
 * An age in seconds as the stale tag shows it: minutes under an hour, hours under two days, then days.
 * The age comes from the API; nothing here reads the clock.
 */
export function formatAge(seconds: number): Age {
  const s = Math.max(0, seconds);
  const [count, unit, word] =
    s < 3600
      ? ([Math.max(1, Math.round(s / 60)), 'min', 'minute'] as const)
      : s < 172_800
        ? ([Math.round(s / 3600), 'h', 'hour'] as const)
        : ([Math.round(s / 86_400), 'd', 'day'] as const);
  return { short: `${count} ${unit}`, long: `${count} ${word}${count === 1 ? '' : 's'} old` };
}

/** A hash or address cut in the middle, never at the end: `4kZ9…mX2p`. */
export function shorten(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
