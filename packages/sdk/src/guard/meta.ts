import { hexEncode, utf8Encode } from '../bytes';
import { sha256 } from '../hash';

// The text hash of a shared portfolio: what ties the words a creator sees (its name, its copy) to the
// 32 bytes the registry stores. The guard works it out here from the text the review screen showed,
// so bytes that carry the hash of other text are refused. The encoding is the one of
// packages/basket/src/meta-hash.ts (DESIGN-VAULT 3.1), written again because this package imports
// nothing; meta.test.ts holds the two to fixtures/creator-limits/meta-hash.json byte for byte, and
// tests/meta-hash.test.ts to each other.
//
//   One JSON object of five strings, each normalised to NFC, in this order and no other member:
//   copy, familyId, kind, name, slug; no whitespace outside the strings; strings as JSON.stringify
//   writes them; UTF-8; SHA-256 as 64 lower-case hex characters.

/** The text a shared portfolio's hash covers. Not its chains: a portfolio published on one more chain keeps its hash. */
export type FamilyText = {
  /** 32 bytes as lower-case hex. */
  familyId: string;
  slug: string;
  name: string;
  copy: string;
  kind: 'index' | 'single';
};

const FIELDS = ['copy', 'familyId', 'kind', 'name', 'slug'] as const;

const loneSurrogate = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

/** The canonical JSON text of the five fields. Throws on a value that is not a string, or holds half a surrogate pair. */
export function canonicalFamilyText(text: FamilyText): string {
  const members = FIELDS.map((key) => {
    const value: unknown = text[key];
    if (typeof value !== 'string') throw new Error(`${key} is not text`);
    if (loneSurrogate(value)) throw new Error(`${key} holds half of a surrogate pair`);
    return `${JSON.stringify(key)}:${JSON.stringify(value.normalize('NFC'))}`;
  });
  return `{${members.join(',')}}`;
}

/** SHA-256 of the canonical text, as 64 lower-case hex characters: the registry's `meta_hash`. */
export const familyTextHash = (text: FamilyText): string =>
  hexEncode(sha256(utf8Encode(canonicalFamilyText(text))));
