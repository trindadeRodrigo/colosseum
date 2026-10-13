import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hexEncode, utf8Encode } from '../bytes';
import { canonicalFamilyText, type FamilyText, familyTextHash } from './meta';

// The text hash as this package works it out, held byte for byte to the worked cases of
// fixtures/creator-limits/meta-hash.json, which packages/basket's own test holds its encoding to.

type Case = { case: string; meta: FamilyText; canonical: string; utf8Hex: string; sha256: string };
const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'fixtures',
      'creator-limits',
      'meta-hash.json',
    ),
    'utf8',
  ),
) as { cases: Case[] };

describe("a shared portfolio's text hash, worked out by the guard", () => {
  it.each(fixture.cases.map((c) => [c.case, c] as const))('%s', (_name, c) => {
    const canonical = canonicalFamilyText(c.meta);
    expect(canonical).toBe(c.canonical);
    expect(hexEncode(utf8Encode(canonical))).toBe(c.utf8Hex);
    expect(familyTextHash(c.meta)).toBe(c.sha256);
  });

  it('covers the five fields and no other, and refuses what cannot be hashed', () => {
    const [first] = fixture.cases;
    if (!first) throw new Error('no case');
    const withChains = { ...first.meta, chains: ['solana'] } as FamilyText;
    expect(familyTextHash(withChains)).toBe(first.sha256);
    for (const key of ['copy', 'familyId', 'kind', 'name', 'slug'] as const) {
      expect(() => canonicalFamilyText({ ...first.meta, [key]: 7 } as never), key).toThrow(
        /not text/,
      );
      expect(
        familyTextHash({ ...first.meta, [key]: `${first.meta[key]}x` } as FamilyText),
        key,
      ).not.toBe(first.sha256);
    }
    expect(() => canonicalFamilyText({ ...first.meta, name: 'a \ud800 b' })).toThrow(/surrogate/);
    expect(() => canonicalFamilyText({ ...first.meta, name: 'a \udc00 b' })).toThrow(/surrogate/);
  });
});
