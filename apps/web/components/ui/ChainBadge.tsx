import type { ChainId } from '@colosseum/schemas';
import { cn } from './cn';

// Which chain a vault, a plan, an order or a holding is on, as a small label beside it. Text only:
// the brand's icons are monochrome wayfinding (iconography.md), and it has no mark for a chain, so
// none is drawn. A chain's name is a name: the same in every language. Several chains, one label
// each, in the order given.

export const CHAIN_NAMES: Record<ChainId, string> = {
  solana: 'Solana',
  robinhood: 'Robinhood Chain',
  base: 'Base',
};

const BADGE =
  'inline-flex items-center rounded-md border border-border px-1.5 py-px font-sans text-caption font-medium whitespace-nowrap text-foreground';

export function ChainBadge({ chain, className }: { chain: ChainId; className?: string }) {
  return (
    <span data-ui="chain-badge" data-chain={chain} className={cn(BADGE, className)}>
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
