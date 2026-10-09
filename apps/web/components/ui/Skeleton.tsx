import type { CSSProperties } from 'react';
import { cn } from './cn';

// Waiting for data, in the shape of what comes (card.md, "Loading"; STYLE.md, the loader). The boxes
// are the layout's own boxes, so nothing moves when the data arrives: a block for a figure, a bar for a
// line of text, a frame for a chart. They are still: the spec has no shimmer and nothing ambient. What
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
export function SkeletonChart({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-ui="skeleton-chart"
      className={cn('flex flex-col gap-3', className)}
    >
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-56 w-full" />
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
