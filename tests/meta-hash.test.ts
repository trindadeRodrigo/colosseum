import { createHash, randomBytes } from 'node:crypto';
import { familyIdOf, metaHash } from '@colosseum/basket';
import { familyTextHash, familyIdOf as sdkFamilyIdOf } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';

// The guard (packages/sdk) works out a shared portfolio's text hash itself, from the text the creator
// saw, with its own copy of the encoding: the package imports nothing. This holds the copy to
// packages/basket's, which the server and the registry use, on text of every awkward kind.

const PIECES = [
  'a',
  'Z',
  ' ',
  '"',
  '\\',
  '/',
  '\n',
  '\t',
  '\u0001',
  '\u007f',
  ' ',
  'é',
  'é',
  '中',
  '🙂',
  'ﬁ',
];
const textOf = (n: number) =>
  Array.from({ length: n }, () => PIECES[(randomBytes(1)[0] ?? 0) % PIECES.length]).join('');

describe("the guard's text hash and packages/basket's", () => {
  it('agree on 2,000 texts made of the characters each rule is about', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const text = {
        familyId: randomBytes(32).toString('hex'),
        slug: `s${i}`,
        name: textOf(1 + (i % 9)),
        copy: textOf(i % 40),
        kind: i % 2 ? ('index' as const) : ('single' as const),
      };
      expect(familyTextHash(text), JSON.stringify(text)).toBe(metaHash(text));
    }
  });
});

describe("the id of a new shared portfolio, the form's and the server's", () => {
  it('is the same rule on both sides, and SHA-256 of family:<slug>', () => {
    for (const slug of ['a', 'gold-and-dollars', 'x9-y8', `s${'0'.repeat(60)}`]) {
      expect(sdkFamilyIdOf(slug)).toBe(familyIdOf(slug));
      expect(familyIdOf(slug)).toBe(createHash('sha256').update(`family:${slug}`).digest('hex'));
    }
    expect(familyIdOf('a')).not.toBe(familyIdOf('b'));
  });
});
