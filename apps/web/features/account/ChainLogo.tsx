import type { ChainId } from '@colosseum/schemas';

// Where a chain's own mark goes, beside its name: the account menu's wallet rows take it through
// this one component. It stands in for `components/ui/ChainLogo.tsx` of the token-logos work, with
// the same props, and draws nothing: when that file is on staging the rows import it instead and
// this one is deleted.

export function ChainLogo(_: { chain: ChainId; size?: number; decorative?: boolean }) {
  return null;
}
