'use client';
import { cn } from '../../components/ui/cn';
import { Skeleton, SkeletonChart, SkeletonLine } from '../../components/ui/Skeleton';
import { DEFAULT_PERIOD } from './overview-series';
import { useWords } from './words';

// The section's pages while their answer is on its way, each in its own layout so nothing moves when
// it lands: the board with its figures and its chart and the table of vaults (overview), a vault's
// card of steps (rebalancing), a chain's block of bars (exposure). The words that are the page's own
// (a label, a column's head) are already there; where a figure or a name will be there is a still
// bar. No figure is drawn, real or made up.

const BOX = 'overflow-hidden rounded-xl border border-border bg-card text-card-foreground';
const CARD = 'rounded-lg border border-border bg-card text-card-foreground';

/** A label of the board over the bar of its figure, in the board's own cell. */
function BoardFigure({ label, width = 'w-20' }: { label: string; width?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="m-0">
        <SkeletonLine className="text-body" width={width} />
      </dd>
    </div>
  );
}

/** The board's result over the window, while the history it stands on is read. */
export function PnlWait() {
  const w = useWords();
  const words = w.overview.board;
  return (
    <div aria-hidden="true" data-ui="board-pnl-wait" className="flex flex-col gap-4">
      <SkeletonLine className="font-display text-[1.75rem]/9" width="w-40" />
      <dl className="m-0 grid grid-cols-2 gap-4">
        <BoardFigure label={words.gaining} width="w-10" />
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-caption text-muted-foreground">{words.best}</dt>
          <dd className="m-0">
            <SkeletonLine className="text-body-sm" width="w-28" />
            <SkeletonLine className="text-body" width="w-20" />
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The frame the board's chart draws in: as tall as the chart, which sets its own height. */
export function BoardChartWait() {
  return <SkeletonChart title={false} frame="h-[380px]" />;
}

/** The overview: the board (its figures beside its chart) and the table of vaults under it. */
export function OverviewWait({ rows = 4 }: { rows?: number }) {
  const w = useWords();
  const board = w.overview.board;
  const table = w.overview.table;
  const head = 'px-5 py-3 font-medium';
  const cell = 'px-5 py-4';
  const columns = [
    { head: table.vault, width: 'w-56' },
    { head: table.chain, width: 'w-14' },
    { head: table.value, width: 'w-20', end: true },
    { head: table.netIn, width: 'w-20', end: true },
    { head: table.allTime, width: 'w-16', end: true },
    { head: table.period(board.chart.periods[DEFAULT_PERIOD]), width: 'w-16', end: true },
    { head: table.status, width: 'w-16' },
  ];
  return (
    <div aria-hidden="true" data-ui="overview-wait" className="flex flex-col gap-6">
      <div data-wait="board" className={BOX}>
        <div className="grid min-w-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,9fr)]">
          <div className="flex min-w-0 flex-col">
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1">
                <p className="text-body-sm text-muted-foreground">{board.total}</p>
                <SkeletonLine className="font-display text-[2rem]/10" width="w-48" />
              </div>
              <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4">
                <BoardFigure label={board.vaults} width="w-6" />
                <BoardFigure label={board.netIn} />
                <BoardFigure label={board.allTime} />
              </dl>
            </div>
            <div className="flex flex-col gap-4 border-t border-border p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-body-sm text-muted-foreground">{board.pnl}</p>
                <Skeleton className="h-[22px] w-12 rounded-full" />
              </div>
              <PnlWait />
            </div>
          </div>
          <div
            data-wait="board-chart"
            className="flex min-w-0 flex-col gap-4 border-t border-border p-5 lg:border-t-0 lg:border-l"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-9 w-[84px] rounded-full" />
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="size-9 rounded-full" />
              </div>
              <Skeleton className="h-9 w-[130px] rounded-full" />
            </div>
            <BoardChartWait />
          </div>
        </div>
      </div>
      <div data-wait="vaults" className={BOX}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-5 py-4">
          <p className="flex items-center gap-2.5 text-body-lg font-semibold whitespace-nowrap">
            <Skeleton className="size-8 rounded-lg" />
            {table.heading}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-9 w-24 rounded-full" />
            <Skeleton className="h-9 w-24 rounded-full" />
          </div>
        </div>
        <div className="overflow-x-hidden">
          <table className="w-full min-w-[760px] border-collapse text-body-sm">
            <thead className="text-left text-caption text-muted-foreground">
              <tr>
                {columns.map((c) => (
                  <th key={c.head} scope="col" className={cn(head, c.end && 'text-right')}>
                    {c.head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: still rows with no identity of their own
                <tr key={r} className="border-t border-border">
                  {columns.map((c) => (
                    <td key={c.head} className={cn(cell, c.end && 'text-right')}>
                      <SkeletonLine width={c.width} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** A vault's card of steps: its sentence, its chain and count, the way to its plan, then its steps. */
export function StepsWait({ cards = 2 }: { cards?: number }) {
  return (
    <div aria-hidden="true" data-ui="steps-wait" className="flex flex-col gap-6">
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <div key={i} data-wait="vault-steps" className={CARD}>
          <div className="flex flex-col items-start gap-2 border-b border-border p-6">
            <SkeletonLine className="w-full text-h4" width="w-80" />
            <SkeletonLine className="w-full text-caption" width="w-32" />
            <SkeletonLine className="w-full text-body-sm" width="w-36" />
          </div>
          {[0, 1].map((step) => (
            <div
              key={step}
              className="flex flex-col gap-3 border-b border-border p-6 last:border-b-0"
            >
              <SkeletonLine className="text-body-sm" width="w-64" />
              <div className="flex items-center gap-3">
                <Skeleton className="h-[22px] w-28 rounded-full" />
                <Skeleton className="h-[22px] w-24 rounded-full" />
              </div>
              <SkeletonLine className="text-body-sm" width="w-48" />
              <SkeletonLine className="text-body" width="w-72" />
              <SkeletonLine className="text-body-sm" width="w-96" lines={2} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A list of shares: each a name, its dollars and its percentage over one bar. */
function SharesWait({ heading, rows }: { heading: string; rows: number }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-h4 font-semibold">{heading}</p>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <div key={i} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-x-4 text-body-sm">
              <SkeletonLine width="w-20" />
              <SkeletonLine width="w-32" />
            </div>
            <Skeleton className="h-2 w-full rounded-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Exposure: what the sums are, then a chain's block: its total, its shares, what selling costs. */
export function ExposureWait() {
  const w = useWords();
  const words = w.exposure;
  return (
    <div aria-hidden="true" data-ui="exposure-wait" className="flex flex-col gap-6">
      <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1.5 pl-5 text-body-sm">
        {[words.notes.chains, words.notes.vaults, words.notes.exit, words.notes.bps].map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <div data-wait="chain-exposure" className={CARD}>
        <div className="flex flex-col gap-1 border-b border-border p-6">
          <SkeletonLine className="text-h3" width="w-32" />
          <SkeletonLine className="text-body" width="w-72" />
          <SkeletonLine className="text-caption" width="w-96" />
        </div>
        <div className="flex flex-col gap-8 p-6">
          <SharesWait heading={words.shares.byUnderlying} rows={4} />
          <SharesWait heading={words.shares.byIssuer} rows={4} />
          <div className="flex flex-col gap-3">
            <p className="text-h4 font-semibold">{words.exit.heading}</p>
            <div className="divide-y divide-border border-y border-border">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-1 py-3">
                  <div className="flex items-baseline justify-between gap-x-4 text-body-sm">
                    <SkeletonLine width="w-28" />
                    <SkeletonLine width="w-36" />
                  </div>
                  <SkeletonLine className="text-body-sm" width="w-80" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
