import { cn } from './cn';
import { shorten } from './format';
import { Hint } from './Hint';
import { Icon } from './Icon';

// data-table.md. Every mainnet transaction is shown with its explorer link: "Tx ↗" and the signature
// cut in the middle, in the mono face, then the explorer's name ("Solscan"), so where the link goes
// is said before it is followed.

export type ExplorerLinkLabels = {
  /** Before the signature. */
  tx: string;
  /** The accessible name. `{signature}` is the shortened signature, `{explorer}` the explorer's name. */
  view: string;
  /** Shown in place of a link when there is no explorer URL. The signature is still shown. */
  unavailable: string;
};
export const EXPLORER_LINK_LABELS: ExplorerLinkLabels = {
  tx: 'Tx',
  view: 'View transaction {signature} on {explorer}',
  unavailable: 'link unavailable',
};

export type ExplorerLinkProps = {
  signature: string;
  /** Null when no explorer serves this transaction: the signature is shown without a link. */
  href: string | null;
  /** The explorer's name, shown after the signature and in the accessible name: "Solscan". */
  explorer: string;
  labels?: Partial<ExplorerLinkLabels>;
  className?: string;
};

export function ExplorerLink({ signature, href, explorer, labels, className }: ExplorerLinkProps) {
  const text = { ...EXPLORER_LINK_LABELS, ...labels };
  const short = shorten(signature);
  // The whole signature, one hover, focus or tap away: the tooltip, never a native title.
  const whole = <span className="font-mono text-source break-all">{signature}</span>;
  if (href === null)
    return (
      <span data-ui="explorer-link" className={cn('font-mono text-source', className)}>
        <Hint tip={whole}>{short}</Hint>{' '}
        <span className="text-muted-foreground">{text.unavailable}</span>
      </span>
    );
  return (
    <Hint tip={whole}>
      <a
        data-ui="explorer-link"
        href={href}
        target="_blank"
        rel="noopener"
        aria-label={text.view.replace('{signature}', short).replace('{explorer}', explorer)}
        className={cn(
          'inline-flex items-center gap-1 font-mono text-source whitespace-nowrap text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          className,
        )}
      >
        {text.tx}
        <Icon name="ArrowUpRight" size={16} />
        {short}
        <span data-ui="explorer-name" className="font-sans text-caption text-muted-foreground">
          {explorer}
        </span>
      </a>
    </Hint>
  );
}
