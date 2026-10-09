import { describe, expect, it } from 'vitest';
import { conversationTitle, TITLE_LENGTH } from './title';

const NEUTRAL = 'New conversation';
const count = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length;

describe('the name of a conversation: the first request, shortened', () => {
  it('keeps a short request whole, with no ellipsis', () => {
    expect(conversationTitle('Consider gold', NEUTRAL)).toBe('Consider gold');
    const exact = `${'a'.repeat(TITLE_LENGTH - 4)} end`;
    expect(conversationTitle(exact, NEUTRAL)).toBe(exact);
  });

  it('cuts a long request at a word, with one ellipsis', () => {
    expect(
      conversationTitle(
        "I want to explore technology stocks with low risk for my daughter's college fund",
        NEUTRAL,
      ),
    ).toBe('I want to explore technology stocks with low…');
    // a cut that lands exactly between two words keeps the whole of the last one
    const words = `${'a'.repeat(TITLE_LENGTH - 4)} end and more`;
    expect(conversationTitle(words, NEUTRAL)).toBe(`${'a'.repeat(TITLE_LENGTH - 4)} end…`);
  });

  it('leaves no comma or stop before the ellipsis', () => {
    expect(
      conversationTitle('Half in a broad fund, half in gold and silver, for five years', NEUTRAL),
    ).toBe('Half in a broad fund, half in gold and silver…');
  });

  it('puts the request on one line', () => {
    expect(conversationTitle('  Protect\n\nmy\tsavings \r\n please  ', NEUTRAL)).toBe(
      'Protect my savings please',
    );
  });

  it('is never empty: the neutral name before any words', () => {
    for (const nothing of [undefined, null, '', '   ', '\n\t\n'])
      expect(conversationTitle(nothing, NEUTRAL)).toBe(NEUTRAL);
  });

  it('cuts one long unbroken string where it stands', () => {
    const title = conversationTitle('x'.repeat(500), NEUTRAL);
    expect(title).toBe(`${'x'.repeat(TITLE_LENGTH)}…`);
    // a short first word before it is not all that is kept
    expect(conversationTitle(`Hi ${'x'.repeat(500)}`, NEUTRAL)).toBe(
      `Hi ${'x'.repeat(TITLE_LENGTH - 3)}…`,
    );
  });

  it('never cuts an emoji or an accented letter in half', () => {
    const family = '👨‍👩‍👧‍👦';
    const title = conversationTitle(family.repeat(80), NEUTRAL);
    expect(title).toBe(`${family.repeat(TITLE_LENGTH)}…`);
    const accented = 'é'.repeat(80);
    expect(conversationTitle(accented, NEUTRAL)).toBe(`${'é'.repeat(TITLE_LENGTH)}…`);
    expect(conversationTitle(`${'🙂 '.repeat(60)}`, NEUTRAL).endsWith('🙂…')).toBe(true);
  });

  it('is never longer than its length and the ellipsis, whatever it is given', () => {
    const given = [
      'Explore technology stocks with low risk and a long horizon, please',
      `${'word '.repeat(300)}`,
      '日本語のとても長い文章'.repeat(20),
      `<img src=x onerror=alert(1)> ${'markup '.repeat(30)}`,
    ];
    for (const words of given) {
      const title = conversationTitle(words, NEUTRAL);
      expect(count(title)).toBeLessThanOrEqual(TITLE_LENGTH + 1);
      expect(title).not.toMatch(/\s…$/);
      expect(title).not.toMatch(/\n/);
      expect(conversationTitle(words, NEUTRAL)).toBe(title);
    }
    // markup is kept as the words it is; it is the screen that shows it as text
    expect(conversationTitle('<b>Gold</b>', NEUTRAL)).toBe('<b>Gold</b>');
  });
});
