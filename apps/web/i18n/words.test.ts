import { describe, expect, it } from 'vitest';
import { bearingEn as bearing } from './bearing/en';
import { en } from './en';
import { portfolioEn as portfolio } from './portfolio/en';

// Gate WORDS-VAULT-DEPOSIT (Thom, Oct 9): nothing a person reads says "mix" or "buy". What a proposal
// holds is the vault, and putting money in is a deposit. Every sentence of the English dictionaries is
// read here, the ones made by a function too (called with plain stand-ins), and held to the rule.
// One kept on purpose would be listed by where it is, with why.

const FORBIDDEN =
  /\b(mix|mixes|mixed|buy|buys|buying|buyer|bought|purchase|purchases|purchased)\b/i;

/** Kept on purpose, by the path it is at and why. Empty: Bearing's market terms were reworded too. */
const KEPT: Record<string, string> = {};

/** Every sentence under a value, with the path it is at. A function is called with stand-ins. */
function sentences(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value))
    for (const [i, item] of value.entries()) sentences(item, `${path}[${i}]`, out);
  else if (typeof value === 'function') {
    // by what a parameter may be: a word, a count, a yes or no, nothing; each that answers is read
    for (const stand of ['Name', 2, true, null]) {
      try {
        const said: unknown = (value as (...args: unknown[]) => unknown)(
          ...Array.from({ length: Math.max(value.length, 4) }, () => stand),
        );
        sentences(said, `${path}()`, out);
      } catch {
        // not a value this sentence takes
      }
    }
  } else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) sentences(inner, `${path}.${key}`, out);
  return out;
}

const all = [
  ...sentences(en, 'en'),
  ...sentences(portfolio, 'portfolio'),
  ...sentences(bearing, 'bearing'),
];
const kept = (path: string) => Object.keys(KEPT).some((prefix) => path.startsWith(prefix));

describe('the words of the product: vault and deposit, never mix or buy', () => {
  it('reads the dictionaries: thousands of sentences, the made ones among them', () => {
    expect(all.length).toBeGreaterThan(2000);
    expect(all.some(([path]) => path.endsWith('()'))).toBe(true);
    expect(all.map(([, said]) => said)).toContain(en.mix.goal.confirm);
    expect(all.map(([, said]) => said)).toContain(en.invest.press('Name'));
  });

  it('finds none outside the short list kept on purpose', () => {
    const found = all
      .filter(([path, said]) => !kept(path) && FORBIDDEN.test(said))
      .map(([path, said]) => `${path}: ${said}`);
    expect(found).toEqual([]);
  });

  it('keeps the list honest: an entry that no longer holds such a word fails', () => {
    for (const prefix of Object.keys(KEPT))
      expect(
        all.some(([path, said]) => path.startsWith(prefix) && FORBIDDEN.test(said)),
        prefix,
      ).toBe(true);
  });

  it('bites: a sentence that says it is found, and a longer word that holds one is not', () => {
    expect(FORBIDDEN.test('Confirm and go to buy')).toBe(true);
    expect(FORBIDDEN.test('Check this mix')).toBe(true);
    expect(FORBIDDEN.test('Nothing is bought yet')).toBe(true);
    expect(FORBIDDEN.test('A mixture of fixtures, bought-in')).toBe(true);
    expect(FORBIDDEN.test('Fix the admixture')).toBe(false);
    expect(FORBIDDEN.test('Deposit into your vault')).toBe(false);
  });
});
