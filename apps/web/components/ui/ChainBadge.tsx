import type { ChainId } from '@colosseum/schemas';
import { ChainLogo } from './ChainLogo';
import { CHAIN_NAMES } from './chain-names';
import { cn } from './cn';

// Which chain a vault, a plan, an order or a holding is on, as a small label beside it: the chain's own
// mark where there is a file for it, then its name (Thom, 2026-10-09; the brand's own icons are
// monochrome wayfinding and have no mark for a chain, so this is open for Rodrigo). A chain's name is
// a name: the same in every language. Several chains, one label each, in the order given.

export { CHAIN_NAMES };

const BADGE =
  'inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-px font-sans text-caption font-medium whitespace-nowrap text-foreground';

export function ChainBadge({ chain, className }: { chain: ChainId; className?: string }) {
  return (
    <span data-ui="chain-badge" data-chain={chain} className={cn(BADGE, className)}>
      <ChainLogo chain={chain} size={12} decorative />
      {CHAIN_NAMES[chain]}
    </span>
  );
}

/** One label per chain, for what is on more than one (a shared portfolio with a recipe on each). */
export function ChainBadges({
  chains,
  className,
}: {
  chains: readonly ChainId[];
  className?: string;
}) {
  return (
    <span
      data-ui="chain-badges"
      className={cn('inline-flex flex-wrap items-center gap-1.5', className)}
    >
      {[...new Set(chains)].map((chain) => (
        <ChainBadge key={chain} chain={chain} />
      ))}
    </span>
  );
}
