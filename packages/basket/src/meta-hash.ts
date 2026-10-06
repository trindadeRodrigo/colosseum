import type { FamilyMeta } from '@colosseum/schemas';
import { BasketInputError } from './amounts';
import { sha256Hex } from './sha256';

// The meta hash ties a shared portfolio's off-chain text to what the registry stores onchain
// (DESIGN-VAULT 3.1). It is content, not identity: anyone can copy the text and get the same hash.
//
// It covers five fields of FamilyMeta: familyId, slug, name, copy and kind. Not `chains`: a shared
// portfolio that is later published on one more chain keeps its hash.
//
// The encoding, exactly, so any language can reproduce it:
//
//   1. Each of the five values is a string, normalised to Unicode NFC.
//   2. One JSON object with these five members, in this order (ascending by name), and no others:
//        copy, familyId, kind, name, slug
//   3. No whitespace anywhere outside the strings: `{"copy":"...","familyId":"...",...}`.
//   4. Strings are written as ECMAScript `JSON.stringify` writes them (RFC 8785, section 3.2.2.2):
//      `"` and `\` are escaped with a backslash; U+0008, U+0009, U+000A, U+000C and U+000D are
//      `\b`, `\t`, `\n`, `\f` and `\r`; any other character under U+0020 is `\u00xx` in lower-case
//      hex; every other character, `/`, U+007F, U+2028 and non-ASCII included, is written as itself.
//   5. The text is encoded as UTF-8, with no byte-order mark.
//   6. The hash is SHA-256 of those bytes, as 64 lower-case hex characters with no prefix. Onchain it
//      is the same 32 bytes, in that order (`bytes32` on EVM, `[u8; 32]` on Solana).
//
// A value that is missing or is not a string, or holds half of a surrogate pair (which UTF-8 cannot
// carry), is refused. fixtures/creator-limits/meta-hash.json holds worked cases: the fields, the
// canonical text, its bytes in hex and the hash.

/** The fields the hash covers, in the order they are written. */
export const META_HASH_FIELDS = ['copy', 'familyId', 'kind', 'name', 'slug'] as const;

/** A high surrogate with no low one after it, or a low one with no high one before it. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** What the hash is taken of: the five fields. A whole `FamilyMeta` fits; its chains are not read. */
export type HashedMeta = Pick<FamilyMeta, (typeof META_HASH_FIELDS)[number]> & Partial<FamilyMeta>;

/** The canonical JSON text of a family's off-chain fields. See the encoding above. */
export function canonicalFamilyMeta(family: HashedMeta): string {
  const members = META_HASH_FIELDS.map((key) => {
    const value: unknown = family[key];
    if (typeof value !== 'string')
      throw new BasketInputError('BadField', `${key} must be a string to be hashed`);
    if (hasLoneSurrogate(value))
      throw new BasketInputError('BadField', `${key} holds half of a surrogate pair`);
    return `${JSON.stringify(key)}:${JSON.stringify(value.normalize('NFC'))}`;
  });
  return `{${members.join(',')}}`;
}

/** SHA-256 of the canonical JSON of five fields of `family`, as 64 lower-case hex characters. */
export function metaHash(family: HashedMeta): string {
  return sha256Hex(new TextEncoder().encode(canonicalFamilyMeta(family)));
}

/**
 * The id of a new shared portfolio, from its slug: SHA-256 of `family:<slug>` as 64 lower-case hex
 * characters. A rule rather than a number the server hands out, so the publish form works out the id it
 * shows itself, and the guard holds the bytes to it (packages/sdk `familyIdOf` repeats it, and
 * tests/meta-hash.test.ts holds the two together). The registry's account is per creator and family,
 * so two creators with the same slug never share a portfolio onchain; the server keeps one family per
 * slug.
 */
export function familyIdOf(slug: string): string {
  return sha256Hex(new TextEncoder().encode(`family:${slug}`));
}
