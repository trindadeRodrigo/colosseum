import { hexEncode, utf8Encode } from './bytes';
import { sha256 } from './hash';

/**
 * A plan's number onchain, from the plan's id: the first 8 bytes of the SHA-256 of `plan:<id>`, as a
 * decimal string. It is the API's own rule (`basketIdOf` in apps/api/src/orders/prepare.ts), repeated
 * here because an order does not carry the number yet; tests/sdk-executor.test.ts holds the two
 * together. The same person buying the same plan again reaches the same vault.
 *
 * Nothing rests on this number being right: whatever it is, the vault the guard derives from it is the
 * person's own.
 */
export function basketIdOfPlan(proposalId: string): string {
  const hash = sha256(utf8Encode(`plan:${proposalId.toLowerCase()}`));
  return BigInt(`0x${hexEncode(hash.slice(0, 8))}`).toString();
}

/**
 * The number of a vault bought from a plan made from a link (gate `AGENT-LINK`): from the plan's id and
 * the buyer's user id (their Privy id, the API's `principal.userId`), the first 8 bytes of the SHA-256
 * of `linked-plan:<id>:<user id>`. A link is shared, and the number is a seed of the vault's address:
 * from the link alone nobody finds the vaults its buyers opened. It is the API's own rule
 * (`basketIdOfLinked` in apps/api/src/orders/prepare.ts); tests/sdk-executor.test.ts holds the two
 * together.
 */
export function basketIdOfLinkedPlan(proposalId: string, userId: string): string {
  const hash = sha256(utf8Encode(`linked-plan:${proposalId.toLowerCase()}:${userId}`));
  return BigInt(`0x${hexEncode(hash.slice(0, 8))}`).toString();
}

/**
 * The id of a new shared portfolio, from its slug: the first publish of a family uses it. It is the
 * API's own rule (`familyIdOf` in packages/basket), repeated here so the publish form works out the id
 * it shows instead of taking the server's word; tests/meta-hash.test.ts holds the two together.
 */
export function familyIdOf(slug: string): string {
  return hexEncode(sha256(utf8Encode(`family:${slug}`)));
}
