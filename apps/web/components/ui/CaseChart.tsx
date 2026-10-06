'use client';
import type { ReactNode } from 'react';
import { type ChartCursorAt, SERIES_FADE, type useChartCursor } from './chart';
import { cn } from './cn';

// The parts the charts of a case share (goal-showcase-case.md, part 5): the landing's two sample cases
// and the plan pane. The crosshair itself is `useChartCursor` (chart.ts), the same one the Bearing
// charts move: a mouse hovers, a finger taps and drags, the keyboard steps. Here are the plot that
// takes it (one tab stop), the line under the chart that reads the point out (an aria-live region),
// and the legend whose items light their series and dim the rest. No animation: the crosshair jumps,
// and the dimming fades only for a reader who has not asked for reduced motion.

export type CaseSeries = {
  id: string;
  label: string;
  /** A CSS colour: a plan-leg token or a text colour of the view. */
  color: string;
  /** Drawn dashed: projected, or a target. */
  dashed?: boolean;
};

/**
 * The plot of a case chart: one tab stop that takes the crosshair. `label` is its name for a screen
 * reader; the figures are read out in the readout line, as the crosshair moves.
 */
export function CasePlot({
  label,
  cursor,
  children,
  className,
}: {
  label: string;
  cursor: ReturnType<typeof useChartCursor>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys move the crosshair, as a pointer does
      tabIndex={0}
      role="img"
      aria-label={label}
      data-ui="case-plot"
      data-cursor={cursor.at?.i ?? ''}
      {...cursor.keys}
      {...cursor.pointer}
      className={cn(
        'relative cursor-crosshair select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The line that reads out the point under the crosshair. While there is none it shows `idle` (the
 * legend: the same series, in the same places) and says how to point.
 */
export function CaseReadout({
  at,
  hint,
  idle,
  children,
}: {
  at: ChartCursorAt;
  hint: string;
  idle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      aria-live="polite"
      data-ui="chart-readout"
      className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]/5 text-muted-foreground"
    >
      {at === null ? (
        <>
          {idle}
          <span className={idle ? 'sr-only' : undefined}>{hint}</span>
        </>
      ) : (
        children
      )}
    </div>
  );
}

/** One figure of a readout: the series' swatch, its name and its value (with its pin). */
export function ReadoutFigure({
  series,
  value,
}: {
  series: Pick<CaseSeries, 'label' | 'color' | 'dashed'>;
  value: ReactNode;
}) {
  return (
    <span data-ui="readout-figure" className="inline-flex flex-wrap items-center gap-x-1.5">
      <Swatch color={series.color} dashed={series.dashed} />
      <span>{series.label}</span>
      <b className="font-medium text-foreground">{value}</b>
    </span>
  );
}

function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return dashed ? (
    <i
      aria-hidden="true"
      className="inline-block w-3 border-t-2 border-dashed"
      style={{ borderColor: color }}
    />
  ) : (
    <i aria-hidden="true" className="inline-block size-2.5" style={{ background: color }} />
  );
}

/** The legend: pointing at an item lights its series and dims the others. */
export function CaseLegend({
  series,
  focus,
  onFocus,
  label,
}: {
  series: readonly CaseSeries[];
  focus: string | null;
  onFocus: (id: string | null) => void;
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      data-ui="case-legend"
      className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px]/5 text-muted-foreground"
    >
      {series.map((s) => (
        <li
          key={s.id}
          data-series={s.id}
          data-lit={focus === s.id}
          onPointerEnter={() => onFocus(s.id)}
          onPointerLeave={() => onFocus(null)}
          className={cn(
            'inline-flex items-center gap-1.5',
            SERIES_FADE,
            focus !== null && focus !== s.id && 'opacity-60',
            focus === s.id && 'text-foreground',
          )}
        >
          <Swatch color={s.color} dashed={s.dashed} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
