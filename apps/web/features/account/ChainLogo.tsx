import type { ChainId } from '@colosseum/schemas';

// Where a chain's own mark goes, beside its name: the account menu's wallet rows take it through
// this one component. The two official marks are being added as files with a component of their own
// (the token-logos work); until they are here this draws nothing, and the name beside it says the
// chain. When they land, this is the one place to draw them.

export function ChainLogo(_: { chain: ChainId; size?: number }) {
  return null;
}
