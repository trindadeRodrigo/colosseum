'use client';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { DAY_MS, fullDate, HOUR_MS, nice, tagWidth, timeTicks } from './chart-scale';
import { cn } from './cn';

// The Bearing time chart (Rodrigo's assets/analytics-charts.js, `time`): a card head with the title,
// the headline figure (pinned by the caller), a note, range tabs and the caller's tools; then panes
// stacked on one time axis, the value axis on the right, a crosshair with date and value tags, and a
// readout line. Inline SVG drawn at the element's real width, so the 11px axis type stays 11px at
// every width. Hover and the arrow keys both move the crosshair.
//
// Wood only: two series at most (s1, s2), or covered and not covered (cv, un) with their words in the
// legend and the readout. Solid is measured; a dashed segment is a point with too few samples.

export type ChartSeriesClass = 's1' | 's2' | 'cv' | 'un';
export type TimePoint = { t: number; v: number | null; show?: string | null; dashed?: boolean };
export type TimeSeries = {
  type: 'area' | 'line';
  cls: ChartSeriesClass;
  label: string;
  /** No square on hover: the back of a 100% stack. */
  noDot?: boolean;
  data: readonly TimePoint[];
};
export type TimePane = {
  h: number;
  fmt: (v: number) => string;
  series: readonly TimeSeries[];
  /** The axis starts at zero unless this is false. */
  zero?: boolean;
  /** A share never draws past this. */
  max?: number;
  /** The series whose last value tags the axis. */
  tagSeries?: number;
  title?: string;
};
export type ChartRange = { label: string; ms: number | null };

export type TimeChartProps = {
  title: string;
  /** The headline figure, with its pin, from the caller. */
  value?: ReactNode;
  note?: ReactNode;
  /** Beside the head: a metric selector. */
  tools?: ReactNode;
  /** Beside the range tabs: the lending page's tolerance box. */
  rangeTools?: ReactNode;
  ranges?: readonly ChartRange[];
  range?: number;
  onRange?: (index: number) => void;
  /** The readout gives the hour, not only the day. */
  hourly?: boolean;
  panes: readonly TimePane[];
  legend?: ReadonlyArray<{ cls: ChartSeriesClass; label: string }>;
  /** The accessible name of the plot. */
  aria: string;
  /** The source line under the chart, with its pin. */
  src?: ReactNode;
  /** In place of the plot when there are no points. */
  empty?: ReactNode;
  className?: string;
};

/** The colour of a series, by its class. */
export const SERIES_VAR: Record<ChartSeriesClass, string> = {
  s1: 'var(--tf-bearing-s1)',
  s2: 'var(--tf-bearing-s2)',
  cv: 'var(--tf-bearing-cv)',
  un: 'var(--tf-bearing-un)',
};
const AREA_OPACITY: Record<ChartSeriesClass, number> = { s1: 0.5, s2: 0.5, cv: 1, un: 1 };

const AX = 64;
const XA = 22;

/** The width of an element, kept current. Zero until it is measured. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.clientWidth));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** An axis tag: a small solid plate with mono text (the crosshair and last-value labels). */
export function Tag({
  x,
  y,
  text,
  anchor = 'start',
  fill = 'var(--muted)',
  stroke = 'var(--input)',
  ink = 'var(--foreground)',
}: {
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle';
  fill?: string;
  stroke?: string;
  ink?: string;
}) {
  const w = tagWidth(text);
  const x0 = anchor === 'middle' ? x - w / 2 : x;
  return (
    <g data-ui="chart-tag">
      <rect x={x0} y={y - 9} width={w} height={18} fill={fill} stroke={stroke} strokeWidth={1} />
      <text x={x0 + 5} y={y + 4} fill={ink} className="font-mono text-[11px] font-medium">
        {text}
      </text>
    </g>
  );
}

/** The legend under a chart: a square of the series' colour and its words. */
export function ChartLegend({
  items,
}: {
  items: ReadonlyArray<{ cls: ChartSeriesClass; label: string }>;
}) {
  return (
    <div data-ui="chart-legend" className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-caption">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center">
          <i
            aria-hidden="true"
            className="mr-1.5 inline-block size-2.5"
            style={{ background: SERIES_VAR[item.cls] }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** The head of a chart card: title, figure and note on the left, ranges and tools on the right. */
export function ChartHead({
  title,
  value,
  note,
  tools,
  rangeTools,
  ranges,
  range = 0,
  onRange,
}: Pick<
  TimeChartProps,
  'title' | 'value' | 'note' | 'tools' | 'rangeTools' | 'ranges' | 'range' | 'onRange'
>) {
  return (
    <div
      data-ui="chart-head"
      className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2"
    >
      <div className="min-w-0">
        <div className="font-condensed text-caption font-medium text-muted-foreground">{title}</div>
        {value != null && <div className="mt-0.5 font-mono text-b-kpi font-medium">{value}</div>}
        {note != null && (
          <div className="max-w-[72ch] text-caption text-muted-foreground">{note}</div>
        )}
      </div>
      {(ranges && ranges.length > 1) || rangeTools ? (
        <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
          {ranges && ranges.length > 1 && (
            <Segmented
              label="Range"
              options={ranges.map((r, i) => ({ id: String(i), label: r.label }))}
              value={String(range)}
              onChange={(id) => onRange?.(Number(id))}
              small
            />
          )}
          {rangeTools}
        </div>
      ) : null}
      {tools}
    </div>
  );
}

/** A row of pressed-or-not buttons: the metric selector and the range tabs. */
export function Segmented({
  label,
  options,
  value,
  onChange,
  small = false,
}: {
  label: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
  small?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the prototype names it
    <div
      role="group"
      aria-label={label}
      data-ui="segmented"
      className="inline-flex rounded-md border border-input"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn(
            'cursor-pointer border-r border-input font-medium text-foreground last:border-r-0 aria-pressed:bg-primary aria-pressed:text-primary-foreground hover:not-aria-pressed:bg-muted',
            small ? 'min-h-6 px-2 py-0.5 text-caption' : 'min-h-7 px-2.5 py-1 text-caption',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Geo = {
  top: number;
  h: number;
  Y: (v: number) => number;
  lo: number;
  hi: number;
  pane: TimePane;
};

export function TimeChart(props: TimeChartProps) {
  const { panes, ranges, hourly = false, legend, aria, src, empty } = props;
  const [own, setOwn] = useState(props.range ?? 0);
  const range = props.onRange ? (props.range ?? 0) : own;
  const onRange = (i: number) => {
    setOwn(i);
    props.onRange?.(i);
  };
  const [box, W0] = useWidth<HTMLDivElement>();
  const W = Math.max(280, W0);
  const clip = useId().replace(/:/g, '');
  const [hover, setHover] = useState<{ i: number; py: number | null } | null>(null);

  const all = panes.flatMap((p) => p.series.flatMap((s) => s.data.map((d) => d.t)));
  const geo = (() => {
    if (!all.length) return null;
    const r = ranges?.[range];
    const tMax = Math.max(...all);
    const tMin = Math.min(...all);
    const t0 = r?.ms ? Math.max(tMin, tMax - r.ms) : tMin;
    const vis = (d: TimePoint) => d.t >= t0 && d.t <= tMax;
    const plotW = W - AX - 8;
    const X = (t: number) => 8 + ((t - t0) / (tMax - t0 || 1)) * plotW;
    let y = 8;
    const out: Geo[] = [];
    for (const p of panes) {
      let vals: number[] = [];
      for (const s of p.series) for (const d of s.data) if (vis(d) && d.v != null) vals.push(d.v);
      if (!vals.length) vals = [0, 1];
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (p.zero !== false) lo = Math.min(0, lo);
      if (p.max != null) hi = Math.min(hi, p.max);
      const n = nice(lo, hi + (hi - lo) * 0.06, Math.max(2, Math.round(p.h / 48)));
      if (p.zero === false) n.lo = Math.max(n.lo, lo - (hi - lo) * 0.08);
      if (p.max != null && n.hi > p.max) n.hi = p.max;
      const top = y;
      const Y = (v: number) => top + p.h - ((v - n.lo) / (n.hi - n.lo || 1)) * p.h;
      out.push({ top, h: p.h, Y, lo: n.lo, hi: n.hi, pane: p });
      (out[out.length - 1] as Geo & { ticks?: number[] }).ticks = n.ticks;
      y += p.h + 12;
    }
    const plotH = y - 12;
    const ts = [
      ...new Set(panes.flatMap((p) => p.series.flatMap((s) => s.data.filter(vis).map((d) => d.t)))),
    ].sort((a, b) => a - b);
    return {
      t0,
      tMax,
      vis,
      plotW,
      X,
      panes: out as Array<Geo & { ticks: number[] }>,
      plotH,
      H: plotH + XA,
      ts,
    };
  })();

  const head = <ChartHead {...props} range={range} onRange={onRange} />;
  if (!geo)
    return (
      <div data-ui="time-chart" className={props.className}>
        {head}
        <div className="py-6 text-muted-foreground">{empty ?? 'No data'}</div>
        {src}
      </div>
    );

  const { X, plotW, plotH, H, ts, vis } = geo;
  const at = hover ? ts[Math.max(0, Math.min(ts.length - 1, hover.i))] : undefined;
  const readT = at ?? ts[ts.length - 1];

  const move = (clientX: number, clientY: number, rect: DOMRect) => {
    const x = clientX - rect.left;
    const yy = clientY - rect.top;
    let best = 0;
    let bd = Number.POSITIVE_INFINITY;
    ts.forEach((t, i) => {
      const d = Math.abs(X(t) - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover({ i: best, py: yy });
  };
  const onKey = (e: KeyboardEvent) => {
    const d = ({ ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 } as Record<string, number>)[
      e.key
    ];
    if (d == null) return;
    e.preventDefault();
    const i = hover ? hover.i : ts.length - 1;
    setHover({ i: Math.max(0, Math.min(ts.length - 1, i + d)), py: null });
  };

  return (
    <div data-ui="time-chart" className={props.className}>
      {head}
      <div
        aria-live="polite"
        data-ui="chart-readout"
        className="flex min-h-5 flex-wrap gap-x-4 gap-y-0.5 font-mono text-b-meta/5 text-muted-foreground"
      >
        {readT != null && <Readout t={readT} panes={panes} hourly={hourly} />}
      </div>
      <div
        ref={box}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys move the crosshair, as the mouse does
        tabIndex={0}
        role="img"
        aria-label={aria}
        data-ui="chart-plot"
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="relative"
      >
        {W0 > 0 && (
          <svg
            aria-hidden="true"
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="block overflow-visible"
            onMouseMove={(e) => move(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => setHover(null)}
          >
            {geo.panes.map((g, pi) => (
              <PaneDraw
                key={g.top}
                g={g}
                index={pi}
                W={W}
                plotW={plotW}
                X={X}
                vis={vis}
                clip={`${clip}p${pi}`}
              />
            ))}
            {(() => {
              const tt = timeTicks(geo.t0, geo.tMax, Math.max(2, Math.floor(plotW / 90)));
              return tt.ticks.map((t) => {
                const px = X(t);
                if (px < 20 || px > 8 + plotW - 10) return null;
                return (
                  <g key={t}>
                    <line x1={px} x2={px} y1={plotH} y2={plotH + 4} stroke="var(--input)" />
                    <text
                      x={px}
                      y={plotH + 16}
                      textAnchor="middle"
                      className="fill-foreground/80 font-mono text-[11px]"
                    >
                      {tt.fmt(t)}
                    </text>
                  </g>
                );
              });
            })()}
            <line x1={8} x2={8 + plotW} y1={plotH} y2={plotH} stroke="var(--input)" />
            {at != null && hover && <Cross t={at} py={hover.py} geo={geo} W={W} hourly={hourly} />}
          </svg>
        )}
      </div>
      {legend && <ChartLegend items={legend} />}
      {src}
    </div>
  );
}

function PaneDraw({
  g,
  index,
  W,
  plotW,
  X,
  vis,
  clip,
}: {
  g: Geo & { ticks: number[] };
  index: number;
  W: number;
  plotW: number;
  X: (t: number) => number;
  vis: (d: TimePoint) => boolean;
  clip: string;
}) {
  const p = g.pane;
  const s0 = p.series[p.tagSeries ?? 0];
  const last = s0?.data
    .filter(vis)
    .filter((q) => q.v != null)
    .pop();
  const base = g.Y(Math.max(g.lo, 0));
  return (
    <g>
      {g.ticks
        .filter((t) => t >= g.lo - 1e-12 && t <= g.hi + 1e-12)
        .map((t) => (
          <g key={t}>
            <line x1={8} x2={8 + plotW} y1={g.Y(t)} y2={g.Y(t)} stroke="var(--tf-bearing-grid)" />
            <text
              x={W - AX + 6}
              y={g.Y(t) + 4}
              className="fill-foreground/80 font-mono text-[11px]"
            >
              {p.fmt(t)}
            </text>
          </g>
        ))}
      <clipPath id={clip}>
        <rect x={8} y={g.top} width={plotW} height={p.h} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {p.series.map((s) => {
          type Seg = { dash: boolean; pts: Array<[number, number]> };
          const segs: Seg[] = [];
          let cur = null as Seg | null;
          for (const q of s.data.filter(vis)) {
            if (q.v == null) {
              cur = null;
              continue;
            }
            const dash = !!q.dashed;
            if (!cur || cur.dash !== dash) {
              const prev: [number, number] | undefined = cur?.pts[cur.pts.length - 1];
              cur = { dash, pts: prev ? [prev] : [] };
              segs.push(cur);
            }
            cur.pts.push([X(q.t), g.Y(q.v)]);
          }
          const color = SERIES_VAR[s.cls];
          return (
            <g key={s.label} data-series={s.cls}>
              {segs.map((sg) => {
                const pts = sg.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
                const first = sg.pts[0] as [number, number];
                const lastP = sg.pts[sg.pts.length - 1] as [number, number];
                return (
                  <g key={`${first[0]}-${sg.dash}`}>
                    {s.type === 'area' && !sg.dash && sg.pts.length > 1 && (
                      <polygon
                        points={`${first[0].toFixed(1)},${base.toFixed(1)} ${pts} ${lastP[0].toFixed(1)},${base.toFixed(1)}`}
                        fill={color}
                        fillOpacity={AREA_OPACITY[s.cls]}
                      />
                    )}
                    <polyline
                      points={pts}
                      fill="none"
                      stroke={color}
                      strokeWidth={2.25}
                      strokeLinejoin="round"
                      strokeDasharray={sg.dash ? '4 4' : undefined}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </g>
      {last && s0 && last.v != null && (
        <>
          <line
            x1={8}
            x2={8 + plotW}
            y1={g.Y(last.v)}
            y2={g.Y(last.v)}
            stroke="var(--muted-foreground)"
            strokeDasharray="1 3"
            opacity={0.8}
          />
          <Tag
            x={W - AX + 2}
            y={g.Y(last.v)}
            text={p.fmt(last.v)}
            fill={SERIES_VAR[s0.cls]}
            stroke="none"
            ink={s0.cls === 'un' ? 'var(--foreground)' : 'var(--background)'}
          />
        </>
      )}
      {index > 0 && <line x1={0} x2={W} y1={g.top - 4} y2={g.top - 4} stroke="var(--border)" />}
      {p.title && (
        <text x={12} y={g.top + 13} className="fill-muted-foreground font-condensed text-[11.5px]">
          {p.title}
        </text>
      )}
    </g>
  );
}

function Cross({
  t,
  py,
  geo,
  W,
  hourly,
}: {
  t: number;
  py: number | null;
  geo: { X: (t: number) => number; plotW: number; plotH: number; panes: Geo[] };
  W: number;
  hourly: boolean;
}) {
  const px = geo.X(t);
  const pane = py == null ? undefined : geo.panes.find((g) => py >= g.top && py <= g.top + g.h);
  return (
    <g data-ui="chart-cross">
      <line
        x1={px}
        x2={px}
        y1={0}
        y2={geo.plotH}
        stroke="var(--muted-foreground)"
        strokeDasharray="2 3"
      />
      <Tag
        x={px}
        y={geo.plotH + 11}
        text={fullDate(t, hourly).replace(' UTC', '')}
        anchor="middle"
      />
      {pane && py != null && (
        <>
          <line
            x1={8}
            x2={8 + geo.plotW}
            y1={py}
            y2={py}
            stroke="var(--muted-foreground)"
            strokeDasharray="2 3"
          />
          <Tag
            x={W - AX + 2}
            y={py}
            text={pane.pane.fmt(
              pane.lo + ((pane.top + pane.h - py) / pane.h) * (pane.hi - pane.lo),
            )}
          />
        </>
      )}
      {geo.panes.flatMap((g) =>
        g.pane.series.map((s) => {
          const q = s.data.find((d) => d.t === t);
          if (!q || s.noDot || q.v == null) return null;
          return (
            <rect
              key={`${s.label}`}
              x={px - 3.5}
              y={g.Y(q.v) - 3.5}
              width={7}
              height={7}
              fill={SERIES_VAR[s.cls]}
              stroke="var(--card)"
              strokeWidth={1.5}
            />
          );
        }),
      )}
    </g>
  );
}

function Readout({ t, panes, hourly }: { t: number; panes: readonly TimePane[]; hourly: boolean }) {
  return (
    <>
      <span className="text-foreground">{fullDate(t, hourly)}</span>
      {panes.flatMap((p) =>
        p.series.map((s) => {
          const q = s.data.find((d) => d.t === t);
          if (!q) return null;
          return (
            <span key={s.label}>
              <i
                aria-hidden="true"
                className="mr-1.5 inline-block size-2"
                style={{ background: SERIES_VAR[s.cls] }}
              />
              {s.label}{' '}
              <b className="font-medium text-foreground">
                {q.v == null ? 'no value' : (q.show ?? p.fmt(q.v))}
              </b>
              {q.dashed ? ' too few samples' : ''}
            </span>
          );
        }),
      )}
    </>
  );
}

export { DAY_MS, HOUR_MS };
