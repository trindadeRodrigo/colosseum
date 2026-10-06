'use client';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { cn } from './cn';
import {
  HEAT_LABELS,
  type HeatCell,
  type HeatLabels,
  HOURS,
  heatLevels,
  heatName,
  heatWhen,
  hh,
} from './heatmap';
import { MockPlate, StalePlate } from './MockPlate';

export type { HeatCell } from './heatmap';

// bearing-heatmap-tile.md. The hour-of-week depth heatmap as a lattice of 7 days by 24 hours, inside a
// Bearing tile: the b-head label, the b-kpi figure with its pin, a b-emph line, the grid, the scale
// with its two pinned ends and "– no sample", and the b-meta line. More depth is lighter on warm
// black and darker on paper (the --tf-heat ramp). Bins are quintiles of the hours shown.
//
// A cell with no sample is the ground colour with an en dash, never hatched: the hatch means MOCK or
// stale only. A stale tile gets the hatch band on its left edge and the "stale · 9 h" plate; a MOCK
// tile the band and the MOCK plate. The grid is one tab stop: the arrow keys, Home and End move
// through the hours, and the hour in focus or under the pointer is read out under the grid with its
// pinned figure. "View as table" shows the same hours as a table of days, which can be ordered by
// depth.

export type HeatmapState = { kind: 'live' } | { kind: 'stale'; ageSec: number } | { kind: 'mock' };

export type HeatmapTileProps = {
  /** b-head: "xAAPL · sellable at ≤ 2% impact". */
  head: string;
  /** b-kpi: the headline figure, with its pin, from the caller. */
  kpi: ReactNode;
  /** b-emph: "thinnest: Sun 03:00 UTC". */
  emph?: ReactNode;
  note?: ReactNode;
  /** The hours with a sample. Every other hour of the week is drawn as "no sample". */
  cells: readonly HeatCell[];
  /** Which end of `value` is more depth: a dollar depth is deeper when high, a cost when low. */
  deeper: 'high' | 'low';
  fmt: (v: number) => string;
  /** After the value in a cell's name: "at ≤ 2%", "to sell $100,000". */
  what: string;
  /** The zone the hours are in: "UTC", "ET". */
  zone: string;
  /** The scale's ends, each a pinned figure: the least depth and the most. */
  least: ReactNode;
  most: ReactNode;
  /** b-meta: "USD · n=412 · method v1.3 · as of 2026-10-01 14:00 UTC". */
  meta: string;
  /** The pinned figure for an hour, in the readout. Without it the value is printed alone. */
  cellFigure?: (cell: HeatCell) => ReactNode;
  state?: HeatmapState;
  /** The grid's accessible name. */
  aria: string;
  /** The tile's own words: the toggles, the scale, the days. */
  labels?: Partial<HeatLabels>;
  className?: string;
};

const HEAT = ['', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4', 'bg-heat-5'];

export function HeatmapTile({
  head,
  kpi,
  emph,
  note,
  cells,
  deeper,
  fmt,
  what,
  zone,
  least,
  most,
  meta,
  cellFigure,
  state = { kind: 'live' },
  aria,
  labels,
  className,
}: HeatmapTileProps) {
  const text = { ...HEAT_LABELS, ...labels };
  const by = new Map(cells.map((c) => [c.day * 24 + c.hour, c]));
  const level = heatLevels(
    cells.map((c) => c.value),
    deeper,
  );
  const [at, setAt] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [deepFirst, setDeepFirst] = useState(false);
  const grid = useRef<HTMLTableElement>(null);
  const readId = useId();
  const marked = state.kind !== 'live';

  const move = (to: number) => {
    const next = Math.max(0, Math.min(167, to));
    setAt(next);
    setShown(next);
    grid.current?.querySelector<HTMLElement>(`[data-how="${next}"]`)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const step = (
      {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: 24,
        ArrowUp: -24,
        Home: -(at % 24),
        End: 23 - (at % 24),
      } as Record<string, number>
    )[e.key];
    if (step == null) return;
    e.preventDefault();
    move(at + step);
  };
  const read = shown == null ? null : shown;
  const readCell = read == null ? undefined : by.get(read);

  return (
    <div
      data-ui="heatmap-tile"
      data-state={state.kind}
      className={cn(
        'relative min-w-0 border border-border bg-card p-4',
        marked && 'pl-6',
        className,
      )}
    >
      {marked && <span aria-hidden="true" className="tf-hatch absolute inset-y-0 left-0 w-1.5" />}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="font-condensed text-b-head font-medium text-muted-foreground">{head}</div>
        {state.kind === 'stale' && <StalePlate ageSec={state.ageSec} />}
        {state.kind === 'mock' && <MockPlate />}
      </div>
      <div className="my-1 font-mono text-b-kpi font-medium">{kpi}</div>
      {emph != null && <div className="text-b-emph font-medium">{emph}</div>}
      {note != null && (
        <div className="mt-1 max-w-[88ch] text-caption text-muted-foreground">{note}</div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={table}
          onClick={() => setTable(!table)}
          className="min-h-7 cursor-pointer rounded-md border border-input px-2.5 py-1 text-caption font-medium hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {text.table}
        </button>
        {table && (
          <button
            type="button"
            aria-pressed={deepFirst}
            onClick={() => setDeepFirst(!deepFirst)}
            className="min-h-7 cursor-pointer rounded-md border border-input px-2.5 py-1 text-caption font-medium hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {text.deepFirst}
          </button>
        )}
      </div>

      {table ? (
        <HeatTable
          by={by}
          fmt={fmt}
          zone={zone}
          deeper={deeper}
          deepFirst={deepFirst}
          caption={aria}
          cellFigure={cellFigure}
          text={text}
        />
      ) : (
        // the grid scrolls sideways on a phone; its cells take focus, so the keyboard reaches every hour.
        // Relative, so the hidden hour labels stay inside it and the page does not scroll sideways
        <div className="relative mt-2 max-w-[760px] overflow-x-auto">
          {/* A table drawn as a CSS grid: the rows and the body take no box of their own. */}
          <table
            ref={grid}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: bearing-heatmap-tile.md asks for role grid: one tab stop, arrow keys
            role="grid"
            aria-label={aria}
            aria-describedby={readId}
            onKeyDown={onKey}
            onMouseLeave={() => setShown(null)}
            className="grid min-w-[636px] grid-cols-[36px_repeat(24,minmax(24px,1fr))] gap-px border border-border bg-border"
          >
            <thead className="contents">
              <tr className="contents">
                <td aria-hidden="true" className="bg-card" />
                {HOURS.map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="flex items-end bg-card px-0.5 font-mono text-b-meta font-normal text-muted-foreground"
                  >
                    {h % 3 === 0 ? hh(h) : <span className="sr-only">{hh(h)}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="contents">
              {text.days.map((name, d) => (
                <tr key={name} className="contents">
                  <th
                    scope="row"
                    className="flex items-center bg-card px-1 font-condensed text-b-head font-medium text-muted-foreground"
                  >
                    {name}
                  </th>
                  {HOURS.map((h) => {
                    const how = d * 24 + h;
                    const c = by.get(how);
                    return (
                      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a cell of a grid (role grid on the table) is a gridcell, which may be selected
                      <td
                        key={h}
                        data-how={how}
                        data-level={c ? level(c.value) : undefined}
                        tabIndex={how === at ? 0 : -1}
                        aria-label={heatName(d, h, zone, c, fmt, what, text)}
                        aria-selected={how === read}
                        onFocus={() => {
                          setAt(how);
                          setShown(how);
                        }}
                        onMouseEnter={() => setShown(how)}
                        className={cn(
                          'flex aspect-square min-h-6 items-center justify-center font-mono text-b-meta text-muted-foreground outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring aria-selected:outline-2 aria-selected:outline-ring',
                          c ? HEAT[level(c.value)] : 'bg-background',
                        )}
                      >
                        {c ? null : '–'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
        <span className="whitespace-nowrap">
          {text.least} {least}
        </span>
        <span aria-hidden="true" className="inline-flex gap-px border border-border bg-border">
          {[1, 2, 3, 4, 5].map((i) => (
            <i key={i} className={cn('block h-3 w-5', HEAT[i])} />
          ))}
        </span>
        <span className="whitespace-nowrap">
          {text.most} {most}
        </span>
        <span className="text-muted-foreground">{text.legend(cells.length)}</span>
      </div>
      <p
        id={readId}
        aria-live="polite"
        className="mt-2 min-h-5 font-mono text-b-meta text-muted-foreground"
      >
        {read == null ? (
          text.move
        ) : readCell && cellFigure ? (
          <>
            {heatWhen(read, zone, text)} · {cellFigure(readCell)} {what} · n={readCell.samples}
          </>
        ) : (
          heatName(Math.floor(read / 24), read % 24, zone, readCell, fmt, what, text)
        )}
      </p>
      <p className="font-mono text-b-meta text-muted-foreground">{meta}</p>
    </div>
  );
}

function HeatTable({
  by,
  fmt,
  zone,
  deeper,
  deepFirst,
  caption,
  cellFigure,
  text,
}: {
  by: Map<number, HeatCell>;
  fmt: (v: number) => string;
  zone: string;
  deeper: 'high' | 'low';
  deepFirst: boolean;
  caption: string;
  cellFigure?: (cell: HeatCell) => ReactNode;
  text: HeatLabels;
}) {
  const days = text.days.map((name, d) => {
    const vals = HOURS.map((h) => by.get(d * 24 + h)?.value).filter((v): v is number => v != null);
    const mean = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    return { name, d, mean };
  });
  const depth = (m: number | null) =>
    m == null ? Number.NEGATIVE_INFINITY : deeper === 'high' ? m : -m;
  const order = deepFirst ? days.slice().sort((a, b) => depth(b.mean) - depth(a.mean)) : days;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a table that scrolls sideways is reached by keyboard
    <section tabIndex={0} aria-label={caption} className="mt-2 overflow-x-auto">
      <table data-ui="heatmap-table" className="w-full border-collapse font-mono text-b-meta">
        <caption className="sr-only">{`${caption}, hours in ${zone}`}</caption>
        <thead>
          <tr className="bg-muted">
            <th
              scope="col"
              className="px-1.5 py-1 text-left font-sans font-medium text-muted-foreground"
            >
              {text.day}
            </th>
            {HOURS.map((h) => (
              <th
                key={h}
                scope="col"
                className="px-1.5 py-1 text-right font-medium text-muted-foreground"
              >
                {hh(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map(({ name, d }) => (
            <tr key={name} className="border-t border-border">
              <th scope="row" className="px-1.5 py-1 text-left font-sans font-medium">
                {name}
              </th>
              {HOURS.map((h) => {
                const c = by.get(d * 24 + h);
                return (
                  <td key={h} className="px-1.5 py-1 text-right whitespace-nowrap">
                    {c ? (
                      (cellFigure?.(c) ?? fmt(c.value))
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
