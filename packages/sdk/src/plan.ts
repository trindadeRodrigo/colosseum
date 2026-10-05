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
