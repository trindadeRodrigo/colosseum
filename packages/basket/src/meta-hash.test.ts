import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FamilyMeta, Hex32 } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BasketInputError } from './amounts';
import { canonicalFamilyMeta, META_HASH_FIELDS, metaHash } from './meta-hash';
import { sha256Hex } from './sha256';

const nodeSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);

// Generated cases take a second or two alone and several when the machine is busy.
describe('sha256Hex', { timeout: 60_000 }, () => {
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

type Hashed = Pick<FamilyMeta, 'copy' | 'familyId' | 'kind' | 'name' | 'slug'>;
type MetaCase = { case: string; meta: Hashed; canonical: string; utf8Hex: string; sha256: string };
const file = fileURLToPath(
  new URL('../../../fixtures/creator-limits/meta-hash.json', import.meta.url),
);
const raw = readFileSync(file);
const fixture: { count: number; fields: string[]; cases: MetaCase[] } = JSON.parse(
  raw.toString('utf8'),
);

const SAMPLE: FamilyMeta = {
  familyId: 'ab'.repeat(32),
  slug: 'sand-to-server',
  name: 'From Sand to Server',
  copy: 'Chips, and what runs on them.',
  kind: 'index',
  chains: ['solana', 'robinhood'],
};

describe('metaHash', () => {
  it('writes five fields in name order, with no spaces, and leaves the chains out', () => {
    expect(canonicalFamilyMeta(SAMPLE)).toBe(
      `{"copy":"Chips, and what runs on them.","familyId":"${'ab'.repeat(32)}","kind":"index","name":"From Sand to Server","slug":"sand-to-server"}`,
    );
    expect(metaHash(SAMPLE)).toBe(
      '617603a7ce81d16c5007683771e93eddff25c4e814206de147d64c36a2c348c3',
    );
    expect(Hex32.parse(metaHash(SAMPLE))).toBe(metaHash(SAMPLE));
    expect([...META_HASH_FIELDS]).toEqual(fixture.fields);
    // Publishing on one more chain later does not change the hash.
    for (const chains of [['solana'], ['base', 'solana', 'robinhood']] as FamilyMeta['chains'][])
      expect(metaHash({ ...SAMPLE, chains })).toBe(metaHash(SAMPLE));
    // Nor does the order the object was built in, or a field that is not one of the five.
    const { slug, kind, ...rest } = SAMPLE;
    expect(metaHash({ kind, slug, ...rest, extra: 'x' } as FamilyMeta)).toBe(metaHash(SAMPLE));
  });

  it.each(fixture.cases.map((c) => [c.case, c] as const))('fixture: %s', (_name, c) => {
    expect(FamilyMeta.parse({ ...c.meta, chains: ['solana'] })).toMatchObject(c.meta);
    expect(canonicalFamilyMeta(c.meta)).toBe(c.canonical);
    expect(Buffer.from(utf8(c.canonical)).toString('hex')).toBe(c.utf8Hex);
    expect(metaHash(c.meta)).toBe(c.sha256);
    // What a contract or a program checks: SHA-256 over the bytes given.
    expect(nodeSha(Buffer.from(c.utf8Hex, 'hex'))).toBe(c.sha256);
  });

  it('has the fixture it says it has, with nothing in it an editor would hide', () => {
    expect(fixture.count).toBe(fixture.cases.length);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6);
    // No raw control byte, DEL, combining mark or line separator in the file: they are escapes.
    const text = raw.toString('utf8');
    const hidden = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const control = code < 0x20 && code !== 0x0a;
      return control || code === 0x7f || (code >= 0x300 && code <= 0x36f) || code === 0x2028;
    });
    expect(hidden).toEqual([]);
    expect(text).toContain('\\u007f');
    expect(text).toContain('\\u0327');
  });

  it('hashes text in its composed form, so two spellings of one word give one hash', () => {
    const composed = { ...SAMPLE, name: 'A\u00e7\u00f5es' };
    const decomposed = { ...SAMPLE, name: 'Ac\u0327o\u0303es' };
    expect(composed.name).not.toBe(decomposed.name);
    expect(metaHash(decomposed)).toBe(metaHash(composed));
    expect(canonicalFamilyMeta(decomposed)).toBe(canonicalFamilyMeta(composed));
    // The fixture has the pair: same hash, different input.
    const [a, b] = fixture.cases.filter((c) => c.meta.slug === 'acoes');
    expect(a?.sha256).toBe(b?.sha256);
    expect(a?.meta.name).not.toBe(b?.meta.name);
  });

  it('refuses a field that is missing or is not text, where it used to hash the word "undefined"', () => {
    const reason = (work: () => unknown) => {
      try {
        work();
      } catch (e) {
        return e instanceof BasketInputError ? e.code : `not a BasketInputError: ${e}`;
      }
      return 'did not throw';
    };
    for (const key of META_HASH_FIELDS) {
      expect(
        reason(() => metaHash({ ...SAMPLE, [key]: undefined })),
        key,
      ).toBe('BadField');
      expect(
        reason(() => metaHash({ ...SAMPLE, [key]: null })),
        key,
      ).toBe('BadField');
      expect(
        reason(() => metaHash({ ...SAMPLE, [key]: 7 })),
        key,
      ).toBe('BadField');
    }
    // Half of a surrogate pair cannot be written in UTF-8.
    expect(reason(() => metaHash({ ...SAMPLE, copy: 'a\ud800b' }))).toBe('BadField');
    expect(reason(() => metaHash({ ...SAMPLE, copy: 'a\udc00b' }))).toBe('BadField');
    expect(reason(() => metaHash({ ...SAMPLE, copy: 'a\ud800\udf48b' }))).toBe('did not throw');
    // Text cannot break out of its field.
    expect(canonicalFamilyMeta({ ...SAMPLE, copy: '","familyId":"x' })).toContain(
      '"copy":"\\",\\"familyId\\":\\"x"',
    );
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

  it('is the SHA-256 of JSON that parses back to the same five fields, composed', () => {
    fc.assert(
      fc.property(meta, (m) => {
        const canonical = canonicalFamilyMeta(m);
        const { chains: _chains, ...five } = m;
        expect(JSON.parse(canonical)).toEqual({
          ...five,
          name: m.name.normalize('NFC'),
          copy: m.copy.normalize('NFC'),
        });
        expect(Object.keys(JSON.parse(canonical))).toEqual([...META_HASH_FIELDS]);
        // No raw control character survives: each is written as an escape.
        expect([...canonical].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
        expect(metaHash(m)).toBe(nodeSha(Buffer.from(canonical, 'utf8')));
        // Either spelling of the same text, one hash.
        expect(
          metaHash({ ...m, name: m.name.normalize('NFD'), copy: m.copy.normalize('NFD') }),
        ).toBe(metaHash(m));
      }),
      { numRuns: 500 },
    );
  });

  it('changes when any one of the five fields changes', () => {
    fc.assert(
      fc.property(meta, meta, (a, b) => {
        for (const key of ['familyId', 'slug', 'kind'] as const) {
          if (a[key] === b[key]) continue;
          expect(metaHash({ ...a, [key]: b[key] })).not.toBe(metaHash(a));
        }
        for (const key of ['name', 'copy'] as const) {
          if (a[key].normalize('NFC') === b[key].normalize('NFC')) continue;
          expect(metaHash({ ...a, [key]: b[key] })).not.toBe(metaHash(a));
        }
        expect(metaHash({ ...a, chains: b.chains })).toBe(metaHash(a));
      }),
      { numRuns: 300 },
    );
  });
});
