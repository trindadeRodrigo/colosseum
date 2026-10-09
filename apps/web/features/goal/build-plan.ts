import type { BasketProposal } from '@colosseum/schemas';

/**
 * How a built plan is labelled. Live only when every figure it stands on is live. A plan that names
 * no figure says nothing about being live, so it is not drawn as live. `sandbox` when what is not
 * live comes from a test network and nothing from a mock: the plate, and the words "test network".
 */
export function planProvenance(proposal: BasketProposal): 'live' | 'sandbox' | 'mock' {
  const labels = proposal.observations.map((o) => o.provenance);
  if (labels.length === 0) return 'mock';
  if (labels.every((label) => label === 'live')) return 'live';
  return labels.every((label) => label === 'live' || label === 'sandbox') ? 'sandbox' : 'mock';
}
