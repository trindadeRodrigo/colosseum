// Thom, Oct 9: a conversation is named by the person's first request, shortened. The name is made
// here, in the browser, from the first message as it is kept; nothing is asked of a model or a server,
// and nothing is stored for it. It is the person's own words: shown as text, never as markup.

/** The longest name, in characters as a person counts them, before the ellipsis. */
export const TITLE_LENGTH = 48;
/** A cut falls back to the last whole word only when that keeps at least this much. */
const SHORTEST_CUT = 16;
/** As much of a message as is read for its name: a long one costs no more than a short one. */
const READ = 1000;

/** Characters as a person counts them, so an emoji or an accented letter is never cut in half. */
function characters(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl)
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).map(
      (part) => part.segment,
    );
  return Array.from(text);
}

/**
 * The name of a conversation: the person's first message on one line, cut at a word to
 * `TITLE_LENGTH` with an ellipsis only when it was cut. Before any message it is `neutral`.
 */
export function conversationTitle(first: string | null | undefined, neutral: string): string {
  const whole = (first ?? '').trimStart();
  const long = whole.length > READ;
  // read to a fixed length, never ending on half of a character
  const line = (long ? whole.slice(0, READ).replace(/[\uD800-\uDBFF]$/, '') : whole)
    .replace(/\s+/gu, ' ')
    .trim();
  // Nothing to read in it (only punctuation, only characters with no width): the neutral name.
  if (!/[\p{L}\p{N}\p{S}]/u.test(line)) return neutral;
  const all = characters(line);
  if (all.length <= TITLE_LENGTH) return long ? `${line}…` : line;
  let head = all.slice(0, TITLE_LENGTH);
  // The cut fell inside a word: back to the last whole one, unless that leaves next to nothing (one
  // long unbroken string is cut where it stands).
  if (all[TITLE_LENGTH] !== ' ') {
    const space = head.lastIndexOf(' ');
    if (space >= SHORTEST_CUT) head = head.slice(0, space);
  }
  const kept = head.join('').replace(/[\s.,;:!?–—-]+$/u, '');
  return kept ? `${kept}…` : neutral;
}
