import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FamilyMeta, Hex32 } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalFamilyMeta, metaHash } from './meta-hash';
import { sha256Hex } from './sha256';

const nodeSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);

describe('sha256Hex', () => {
  it('gives the published digests (FIPS 180-4 examples)', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto on every length around a block, and on random bytes', () => {
    for (let n = 0; n < 200; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(bytes), `length ${n}`).toBe(nodeSha(bytes));
    }
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        expect(sha256Hex(bytes)).toBe(nodeSha(bytes));
      }),
      { numRuns: 500 },
    );
  });
});

type MetaCase = {
  case: string;
  meta: FamilyMeta;
  canonical: string;
  utf8Hex: string;
  sha256: string;
};
const file = fileURLToPath(
  new URL('../../../fixtures/creator-limits/meta-hash.json', import.meta.url),
);
const fixture: { count: number; cases: MetaCase[] } = JSON.parse(readFileSync(file, 'utf8'));

const SAMPLE: FamilyMeta = {
  familyId: 'ab'.repeat(32),
  slug: 'sand-to-server',
  name: 'From Sand to Server',
  copy: 'Chips, and what runs on them.',
  kind: 'index',
  chains: ['solana', 'robinhood'],
};

describe('metaHash', () => {
  it('writes the six fields in name order, the chains sorted, with no spaces', () => {
    expect(canonicalFamilyMeta(SAMPLE)).toBe(
      `{"chains":["robinhood","solana"],"copy":"Chips, and what runs on them.","familyId":"${'ab'.repeat(32)}","kind":"index","name":"From Sand to Server","slug":"sand-to-server"}`,
    );
    expect(metaHash(SAMPLE)).toBe(
      '49aac25a28f2716778638b0e7a9ef840913c779126f857378342365562df06be',
    );
    expect(Hex32.parse(metaHash(SAMPLE))).toBe(metaHash(SAMPLE));
  });

  it.each(fixture.cases.map((c) => [c.case, c] as const))('fixture: %s', (_name, c) => {
    expect(FamilyMeta.parse(c.meta)).toEqual(c.meta);
    expect(canonicalFamilyMeta(c.meta)).toBe(c.canonical);
    expect(Buffer.from(utf8(c.canonical)).toString('hex')).toBe(c.utf8Hex);
    expect(metaHash(c.meta)).toBe(c.sha256);
    // What a contract or a program checks: SHA-256 over the bytes given.
    expect(nodeSha(Buffer.from(c.utf8Hex, 'hex'))).toBe(c.sha256);
  });

  it('has the fixture it says it has', () => {
    expect(fixture.count).toBe(fixture.cases.length);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6);
  });

  it('ignores the order and repeats of the chains, and anything that is not one of the six fields', () => {
    const shuffled = {
      ...SAMPLE,
      chains: ['robinhood', 'solana', 'robinhood'] as FamilyMeta['chains'],
    };
    expect(metaHash(shuffled)).toBe(metaHash(SAMPLE));
    expect(metaHash({ ...SAMPLE, extra: 'x' } as FamilyMeta)).toBe(metaHash(SAMPLE));
  });

  const text = fc.string({ unit: 'grapheme', maxLength: 40 });
  const meta: fc.Arbitrary<FamilyMeta> = fc.record({
    familyId: fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((b) => Buffer.from(b).toString('hex')),
    slug: fc.constantFrom('a', 'the-500', 'sand-to-server'),
    name: text.filter((s) => s.length > 0),
    copy: text,
    kind: fc.constantFrom('index', 'single'),
    chains: fc.uniqueArray(fc.constantFrom('solana', 'base', 'robinhood'), { minLength: 1 }),
  });

  it('is the SHA-256 of JSON that parses back to the same six fields', () => {
    fc.assert(
      fc.property(meta, (m) => {
        const canonical = canonicalFamilyMeta(m);
        expect(JSON.parse(canonical)).toEqual({ ...m, chains: [...m.chains].sort() });
        expect(Object.keys(JSON.parse(canonical))).toEqual([
          'chains',
          'copy',
          'familyId',
          'kind',
          'name',
          'slug',
        ]);
        // No raw control character survives: each is written as an escape.
        expect([...canonical].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
        expect(metaHash(m)).toBe(nodeSha(Buffer.from(canonical, 'utf8')));
      }),
      { numRuns: 500 },
    );
  });

  it('changes when any one field changes', () => {
    fc.assert(
      fc.property(meta, meta, (a, b) => {
        for (const key of ['familyId', 'slug', 'name', 'copy', 'kind'] as const) {
          if (a[key] === b[key]) continue;
          expect(metaHash({ ...a, [key]: b[key] })).not.toBe(metaHash(a));
        }
        const sameChains = [...a.chains].sort().join() === [...b.chains].sort().join();
        if (!sameChains) expect(metaHash({ ...a, chains: b.chains })).not.toBe(metaHash(a));
      }),
      { numRuns: 300 },
    );
  });
});
