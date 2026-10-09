// Thom, Oct 9: a conversation is named by the person's first request, shortened. The name is made
// here, in the browser, from the first message as it is kept; nothing is asked of a model or a server,
// and nothing is stored for it. It is the person's own words: shown as text, never as markup.

/** The longest name, in characters as a person counts them, before the ellipsis. */
export const TITLE_LENGTH = 48;
/** A cut falls back to the last whole word only when that keeps at least this much. */
const SHORTEST_CUT = 16;

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
  const line = (first ?? '').replace(/\s+/gu, ' ').trim();
  if (!line) return neutral;
  const all = characters(line);
  if (all.length <= TITLE_LENGTH) return line;
  let head = all.slice(0, TITLE_LENGTH);
  // The cut fell inside a word: back to the last whole one, unless that leaves next to nothing (one
  // long unbroken string is cut where it stands).
  if (all[TITLE_LENGTH] !== ' ') {
    const space = head.lastIndexOf(' ');
    if (space >= SHORTEST_CUT) head = head.slice(0, space);
  }
  return `${head.join('').replace(/[\s.,;:!?–—-]+$/u, '')}…`;
}
