// Small formatters the primitives share. They format what they are handed and decide nothing.

// The date-time format ECMAScript promises to read the same way everywhere: a date, `T`, a time, and
// a zone (`Z` or an offset). Without the zone a time is read as local, so it is not an instant; a bare
// year or a number is not one either, though `Date.parse` would take both.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO 8601 instant in UTC with no fraction: `2026-10-01T14:02:11Z`. Null when the input is not an
 * instant: not a date, a date with no time, or a time with no zone.
 */
export function isoUtc(value: string): string | null {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export type Age = {
  /** Beside the glyph: `3 h`. */
  short: string;
  /** In the accessible name: `3 hours old`. */
  long: string;
  /** How many of what: for an accessible name in another language (`AgeWords`). */
  count: number;
  unit: 'minute' | 'hour' | 'day';
};

/**
 * An age said in full, in the view's language: "3 hours old", "há 3 horas". Words only, so it can be
 * handed from a server component: `said` with `{n}` and `{unit}`, and each unit in the one and the many.
 */
export type AgeWords = { said: string } & Record<Age['unit'], readonly string[]>;

export const sayAge = (age: Age, words: AgeWords): string =>
  words.said
    .replace('{n}', String(age.count))
    .replace('{unit}', words[age.unit][age.count === 1 ? 0 : 1] ?? words[age.unit][0] ?? age.unit);

/**
 * An age in seconds as the stale tag shows it: minutes under an hour, hours under two days, then days.
 * The age comes from the API; nothing here reads the clock. Null when what was handed is not an age:
 * not a number, not finite, or below zero. The caller then says the age is not known.
 */
export function formatAge(seconds: number): Age | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const [count, unit, word]: readonly [number, string, Age['unit']] =
    seconds < 3600
      ? ([Math.max(1, Math.round(seconds / 60)), 'min', 'minute'] as const)
      : seconds < 172_800
        ? ([Math.round(seconds / 3600), 'h', 'hour'] as const)
        : ([Math.round(seconds / 86_400), 'd', 'day'] as const);
  return {
    short: `${count} ${unit}`,
    long: `${count} ${word}${count === 1 ? '' : 's'} old`,
    count,
    unit: word,
  };
}

/** A hash or address cut in the middle, never at the end: `4kZ9…mX2p`. */
export function shorten(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
