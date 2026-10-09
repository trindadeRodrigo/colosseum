import type { CSSProperties } from 'react';
import { cn } from './cn';

// Waiting for data, in the shape of what comes (card.md, "Loading"; STYLE.md, the loader). The boxes
// are the layout's own boxes, so nothing moves when the data arrives: a block for a figure, a bar for a
// line of text, a frame for a chart. A screen builds its wait from these in its own layout: a line in
// the text's own type (`SkeletonLine`), a figure under its label, a table in its columns, a row with
// its mark, the plan's bar, a page's head. A skeleton never shows a figure, real or made up. They are still: the spec has no shimmer and nothing ambient. What
// moves is the one loader the spec draws, "the lattice assembles", beside the words that say what is
// awaited, and only once the wait is over 400ms; under reduced motion it is the still lattice.
//
// The hosted API sleeps when idle and can take up to a minute to wake: after 4 seconds one calm line
// says so, and after a minute the wait gives up and offers to try again.

/** One still box where something will be: a figure, a line of text, a chart. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      data-ui="skeleton"
      style={style}
      className={cn('block rounded-sm bg-muted', className)}
    />
  );
}

/**
 * A line of text to come, set in the text's own type: pass the classes the text will carry
 * (`text-body-sm`, a heading's) and the line's box is the text's own, whatever its size or leading, so
 * the words land where the bar was. `width` is the bar's (`w-40`, `w-3/5`); `lines` repeats it, the
 * last shorter, for text that wraps.
 */
export function SkeletonLine({
  className,
  width = 'w-full',
  lines = 1,
}: {
  className?: string;
  width?: string;
  lines?: number;
}) {
  return (
    <span aria-hidden="true" data-ui="skeleton-line" className={cn('block', className)}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <span key={i} className="block">
          <span
            data-ui="skeleton"
            className={cn(
              'inline-block h-[0.7em] max-w-full rounded-sm bg-muted',
              lines > 1 && i === lines - 1 ? 'w-3/5' : width,
            )}
          />
        </span>
      ))}
    </span>
  );
}

/** A round or square mark to come, beside a name: a token's mark, a status glyph. */
export function SkeletonMark({ className }: { className?: string }) {
  return <Skeleton className={cn('size-6 shrink-0 rounded-full', className)} />;
}

/**
 * A figure with its label to come: the label's line, then the figure's, each in its own type, so a
 * stat cell of any size keeps its box. A skeleton never shows a figure, real or made up.
 */
export function SkeletonFigure({
  label = 'text-caption',
  figure = 'text-[1.125rem]/7',
  width = 'w-24',
  className,
}: {
  /** The label's type. */
  label?: string;
  /** The figure's type. */
  figure?: string;
  /** The figure's bar. */
  width?: string;
  className?: string;
}) {
  return (
    <span aria-hidden="true" data-ui="skeleton-figure" className={cn('block min-w-0', className)}>
      <SkeletonLine className={label} width="w-16" />
      <SkeletonLine className={figure} width={width} />
    </span>
  );
}

/** A row of a list to come: its mark, its name, and what stands at its end. */
export function SkeletonListRow({
  mark = true,
  type = 'text-body-sm',
  end = true,
  className,
}: {
  mark?: boolean;
  /** The row's type. */
  type?: string;
  /** A short bar at the row's end: a share, an amount. */
  end?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-ui="skeleton-list-row"
      className={cn('flex min-w-0 items-center gap-2', type, className)}
    >
      {mark && <SkeletonMark />}
      <SkeletonLine className="min-w-0 flex-1" width="w-24" />
      {end && <SkeletonLine className="shrink-0" width="w-9" />}
    </span>
  );
}

/** The bar of a plan's shares to come: one still band the bar's height, with its pill ends. */
export function SkeletonPlanBar({ className }: { className?: string }) {
  return <Skeleton className={cn('h-2 w-full rounded-full', className)} />;
}

/** The head of a page to come: its title, of however many lines, and its lede under it. */
export function SkeletonPageHead({
  title = 'text-h1 font-display',
  titleLines = 1,
  lede = 'text-body-lg',
  ledeLines = 2,
  className,
}: {
  /** The title's type. */
  title?: string;
  titleLines?: number;
  /** The lede's type; `null` for a page with none. */
  lede?: string | null;
  ledeLines?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-ui="skeleton-page-head"
      className={cn('flex flex-col gap-3', className)}
    >
      <SkeletonLine className={title} width="w-80" lines={titleLines} />
      {lede && (
        <SkeletonLine
          className={cn('max-w-(--tf-measure-body)', lede)}
          width="w-full"
          lines={ledeLines}
        />
      )}
    </div>
  );
}

/** One column of a table to come: its width as the table sets it, and which side its cells sit on. */
export type SkeletonColumn = {
  /** A CSS width for the column's track: `2fr`, `120px`, `minmax(0,1fr)`. */
  track?: string;
  align?: 'start' | 'end';
  /** The cell's bar. */
  width?: string;
};

/**
 * A table to come, in the table's own columns: a head band and `rows` rows of the table's row
 * height, the bars sitting where the cells will (numbers at the end of their column).
 */
export function SkeletonTable({
  columns,
  rows = 4,
  head = 'h-9',
  row = 'h-11',
  type = 'text-body-sm',
  framed = true,
  className,
}: {
  columns: SkeletonColumn[];
  rows?: number;
  /** The head band's height; `null` for a table with no head. */
  head?: string | null;
  /** A row's height: 44px, or `h-9` for a dense table. */
  row?: string;
  /** The cells' type. */
  type?: string;
  /** The table's own hairline frame. */
  framed?: boolean;
  className?: string;
}) {
  const grid = { gridTemplateColumns: columns.map((c) => c.track ?? 'minmax(0,1fr)').join(' ') };
  const line = (r: number, heading: boolean) => (
    <div
      key={r}
      style={grid}
      className={cn(
        'grid items-center gap-4 border-b border-border px-3 last:border-b-0',
        heading ? cn(head, 'bg-muted') : row,
      )}
    >
      {columns.map((c, i) => (
        <SkeletonLine
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          key={i}
          className={cn(
            heading ? 'text-b-head [&_[data-ui=skeleton]]:bg-border' : type,
            c.align === 'end' && 'text-end',
          )}
          width={heading ? 'w-12' : (c.width ?? (i === 0 ? 'w-32' : 'w-16'))}
        />
      ))}
    </div>
  );
  return (
    <div
      aria-hidden="true"
      data-ui="skeleton-table"
      className={cn(framed && 'overflow-hidden rounded-lg border border-border', className)}
    >
      {head && line(-1, true)}
      {Array.from({ length: rows }, (_, r) => line(r, false))}
    </div>
  );
}

/** Lines of text to come: the last one shorter, as a paragraph ends. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          key={i}
          className={cn('h-3.5', i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full')}
        />
      ))}
    </span>
  );
}

/** Stat cells to come, in the stat row's own grid (`StatRow`): a label and a figure each. */
export function SkeletonStats({ count = 3 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      data-ui="skeleton-stats"
      className="grid grid-cols-2 divide-x divide-border border border-border min-[620px]:grid-flow-col min-[620px]:auto-cols-fr min-[620px]:grid-cols-none"
    >
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <div key={i} className="min-w-0 px-4 py-3">
          <Skeleton className="my-1 h-3 w-16" />
          <Skeleton className="mt-1 h-5 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Table rows to come: a header band and rows of the table's own height. */
export function SkeletonRows({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden="true" data-ui="skeleton-rows" className="border border-border">
      <div className="flex gap-4 border-b border-border bg-muted px-3 py-2">
        {Array.from({ length: columns }, (_, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <Skeleton key={c} className="h-3 flex-1 bg-border" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          key={r}
          className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-b-0"
        >
          {Array.from({ length: columns }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
            <Skeleton key={c} className={cn('h-3.5 flex-1', c === 0 && 'max-w-32')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A chart to come: its title and the frame it draws in. */
export function SkeletonChart({
  className,
  title = true,
  frame = 'h-56',
}: {
  className?: string;
  /** A line for the chart's title above its frame. */
  title?: boolean;
  /** The frame's height, as the chart sets its own. */
  frame?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-ui="skeleton-chart"
      className={cn('flex flex-col gap-3', className)}
    >
      {title && <Skeleton className="h-3 w-40" />}
      <Skeleton className={cn('w-full', frame)} />
    </div>
  );
}

/** A plan to come, as the plan pane draws one: its title, the limits as chips, the figures, the legs. */
export function SkeletonPlan({ legs = 4 }: { legs?: number }) {
  return (
    <div aria-hidden="true" data-ui="skeleton-plan" className="flex flex-col gap-5">
      <Skeleton className="h-6 w-2/3" />
      <div className="flex flex-wrap gap-2">
        {[24, 28, 20, 24].map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <Skeleton key={i} className="h-6" style={{ width: `${w * 4}px` }} />
        ))}
      </div>
      <SkeletonStats count={3} />
      <div className="flex flex-col gap-3">
        {Array.from({ length: legs }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A summary to come: a row of figures and the rows of a table under it (an order, a vault). */
export function SkeletonSummary({ stats = 3, rows = 4 }: { stats?: number; rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-5">
      <SkeletonStats count={stats} />
      <SkeletonRows rows={rows} columns={4} />
    </div>
  );
}

/** Cards to come in a list, each the height of one. */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true" data-ui="skeleton-cards" className="flex flex-col gap-4">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <div key={i} className="flex flex-col gap-3 border border-border p-6">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** The lattice that assembles: horizontals slide in, then the verticals drop, then a hold. */
export function LatticeLoader({
  size = 24,
  tone = 'muted',
}: {
  size?: number;
  /** `muted` on a surface; `current` takes the text colour, inside a filled button. */
  tone?: 'muted' | 'current';
}) {
  const at = [0.5, 16.5, 32.5, 47.5];
  return (
    <svg
      data-ui="lattice-loader"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={48 / size}
      className={cn(
        'tf-lattice-assemble shrink-0 overflow-hidden',
        tone === 'muted' && 'text-muted-foreground',
      )}
    >
      {at.map((p, i) => (
        <path
          key={`h${p}`}
          d={`M0 ${p}H48`}
          className="tf-lattice-h"
          style={{ '--i': i } as never}
        />
      ))}
      {at.map((p, i) => (
        <path
          key={`v${p}`}
          d={`M${p} 0V48`}
          className="tf-lattice-v"
          style={{ '--i': i } as never}
        />
      ))}
    </svg>
  );
}
