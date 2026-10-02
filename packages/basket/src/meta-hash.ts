import type { FamilyMeta } from '@colosseum/schemas';
import { sha256Hex } from './sha256';

// The meta hash ties a shared portfolio's off-chain text to what the registry stores onchain
// (DESIGN-VAULT 3.1): metaHash = SHA-256 of the canonical JSON of its FamilyMeta. It is content, not
// identity: anyone can copy the text and get the same hash.
//
// The encoding, exactly, so any language can reproduce it:
//
//   1. One JSON object with these six members, in this order (ascending by name), and no others:
//        chains, copy, familyId, kind, name, slug
//   2. `chains` is an array of the chain ids, each once, in ascending byte order.
//   3. No whitespace anywhere outside the strings: `{"chains":["robinhood","solana"],"copy":...}`.
//   4. Strings are written as ECMAScript `JSON.stringify` writes them (RFC 8785, section 3.2.2.2):
//      `"` and `\` are escaped with a backslash; U+0008, U+0009, U+000A, U+000C and U+000D are
//      `\b`, `\t`, `\n`, `\f` and `\r`; any other character under U+0020 is `\u00xx` in lower-case
//      hex; every other character, `/` and non-ASCII included, is written as itself.
//   5. The text is encoded as UTF-8, with no byte-order mark and no Unicode normalisation.
//   6. The hash is SHA-256 of those bytes, as 64 lower-case hex characters with no prefix. Onchain it
//      is the same 32 bytes, in that order (`bytes32` on EVM, `[u8; 32]` on Solana).
//
// fixtures/creator-limits/meta-hash.json holds worked cases: the fields, the canonical text, its bytes
// in hex and the hash.

/** The canonical JSON text of a family's off-chain fields. See the encoding above. */
export function canonicalFamilyMeta(family: FamilyMeta): string {
  const chains = [...new Set<string>(family.chains)].sort();
  const members: [string, string | string[]][] = [
    ['chains', chains],
    ['copy', family.copy],
    ['familyId', family.familyId],
    ['kind', family.kind],
    ['name', family.name],
    ['slug', family.slug],
  ];
  return `{${members.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`;
}

/** SHA-256 of the canonical JSON of `family`, as 64 lower-case hex characters. */
export function metaHash(family: FamilyMeta): string {
  return sha256Hex(new TextEncoder().encode(canonicalFamilyMeta(family)));
}
