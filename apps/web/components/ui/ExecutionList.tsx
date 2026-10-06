import type { ExecutionStatus, Provenance } from '@colosseum/schemas';
import { CopyButton } from './CopyButton';
import { cn } from './cn';
import { ExplorerLink, type ExplorerLinkLabels } from './ExplorerLink';
import { isoUtc } from './format';
import { HatchBand, MockWord } from './internal/mock-parts';
import { StatusMark } from './StatusMark';

// data-table.md, "Execution list". One line per execution, shared by the plan view and the monitor.
// A failed line says so in words and is never retried: there is no retry button here, because a new
// attempt is a new action the person signs. A row is never dropped for lack of a link, and a status
// this build does not know is said in words, not left blank.

export type Execution = {
  id: string;
  /** What was done: "Swap". */
  verb: string;
  /** The amounts and the route: "5.00 USDC → USDY". */
  detail: string;
  status: ExecutionStatus;
  /** For a failed execution, what went wrong, in words: "slippage exceeded". */
  error?: string | null;
  /** When, as an ISO 8601 instant. Shown in UTC. */
  at: string;
  signature: string | null;
  explorerUrl: string | null;
  /** The explorer's name: "Solana Explorer". */
  explorer: string;
  /**
   * Anything but `live` carries the hatch and the sample glyph. A transaction on a test network
   * (`sandbox`) also says "test network" after the glyph: a row has no popover to say it in.
   */
  provenance: Provenance;
};

export type ExecutionListLabels = {
  status: Record<ExecutionStatus, string>;
  /** For a status this build does not know. It is said, never left blank. */
  unknownStatus: string;
  /** After the glyph of a transaction on a test network (CLAUDE.md: the same mark, with these words). */
  testNetwork: string;
  notRetried: string;
  signature: string;
  link?: Partial<ExplorerLinkLabels>;
};
export const EXECUTION_LIST_LABELS: ExecutionListLabels = {
  status: {
    built: 'built',
    signed: 'signed',
    sent: 'sent',
    confirmed: 'confirmed',
    failed: 'failed',
  },
  unknownStatus: 'status unknown',
  testNetwork: 'test network',
  notRetried: '(not retried)',
  signature: 'signature',
};

/**
 * `2026-09-30 14:02 UTC` for an instant. A time with no zone is not an instant: it is shown as it was
 * given, with no "UTC" after it, because nothing says which hour it was.
 */
export function utcMinute(at: string): string {
  const iso = isoUtc(at);
  return iso === null ? at : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export type ExecutionListProps = {
  executions: readonly Execution[];
  labels?: Partial<ExecutionListLabels>;
  className?: string;
};

export function ExecutionList({ executions, labels, className }: ExecutionListProps) {
  const text = {
    ...EXECUTION_LIST_LABELS,
    ...labels,
    status: { ...EXECUTION_LIST_LABELS.status, ...labels?.status },
  };
  return (
    <ul data-ui="execution-list" className={cn('divide-y divide-border', className)}>
      {executions.map((e) => {
        const mock = e.provenance !== 'live';
        return (
          <li
            key={e.id}
            data-status={e.status}
            data-mock={mock || undefined}
            className={cn(
              'relative flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-body-sm',
              mock && 'pl-4.5',
            )}
          >
            {mock && <HatchBand className="absolute inset-y-0 left-0" />}
            <span className="font-medium">{e.verb}</span>
            <span className="tabular-nums">{e.detail}</span>
            <span aria-hidden="true">·</span>
            {e.status === 'failed' ? (
              <span className="inline-flex items-center gap-1.5 text-status-off">
                <StatusMark status="off-track" />
                <span>
                  {text.status.failed}
                  {e.error ? `: ${e.error}` : ''} {text.notRetried}
                </span>
              </span>
            ) : (
              <span>
                {Object.hasOwn(text.status, e.status) ? text.status[e.status] : text.unknownStatus}
              </span>
            )}
            <span aria-hidden="true">·</span>
            <time
              dateTime={isoUtc(e.at) ?? undefined}
              className="tabular-nums text-muted-foreground"
            >
              {utcMinute(e.at)}
            </time>
            {mock && <MockWord />}
            {e.provenance === 'sandbox' && (
              <span data-ui="execution-network" className="text-caption text-muted-foreground">
                {text.testNetwork}
              </span>
            )}
            {e.signature && (
              <span className="ml-auto inline-flex items-center gap-2">
                <ExplorerLink
                  signature={e.signature}
                  href={e.explorerUrl}
                  explorer={e.explorer}
                  labels={text.link}
                />
                <CopyButton value={e.signature} what={text.signature} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
