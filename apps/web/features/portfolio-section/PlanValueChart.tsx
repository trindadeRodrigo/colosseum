'use client';
import { CasePlot } from '../../components/ui/CaseChart';
import { axisLeft, nearestIndex, useChartCursor, useWidth } from '../../components/ui/chart';
import { nice, timeTicks } from '../../components/ui/chart-scale';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, utc } from '../portfolio/figures';
import { useWords } from './words';

// The figure of a plan's page: what its vault was worth at each reading kept in the window, as one
// solid line, since every point is measured (STYLE.md: dashed is projected, solid is measured), with
// each deposit of the person's marked at its time by a numbered tag, as the drawings of the system
// mark a part. Inline SVG drawn at the element's measured width, as the plan pane's chart is
// (features/order/PlanChart.tsx): no chart library.
//
// Readable without sight the way the system's charts are (components/ui/CaseChart.tsx): the plot is
// one tab stop with a name, the arrow keys step from reading to reading, and the line above it reads
// the point out, politely. That line is the figure's one pinned number: the newest reading until a
// point is pointed at, then that point, each with the stamp its answer carries. The axis only marks
// the scale. Nothing is worked out between two readings: the line joins them, and each reading is a
// square on it while there are few enough to tell apart.

export type ChartPoint = {
  /** When the reading was taken, as an ISO instant. */
  at: string;
  valueUsd: string;
  /** The reading's own stamp (pins.ts, `pointPin`). */
  obs: PinSource;
};

/** A deposit to mark: its number among the person's deposits into the vault, and its time. */
export type ChartDeposit = { n: number; at: string };

const W_DEFAULT = 640;
const H = 220;
/** Above the plot: the deposits' numbered tags. */
const TOP = 24;
/** Under it: the time axis. */
const BOTTOM = 24;
const RIGHT = 12;
const TAG = 14;
/** Up to this many readings, each is drawn as a square on the line. */
const DOTS_UP_TO = 40;

export function PlanValueChart({
  points,
  deposits,
  from,
  to,
}: {
  /** Two readings at least, oldest first. */
  points: readonly ChartPoint[];
  deposits: readonly ChartDeposit[];
  /** The window the answer covers, as it said. */
  from: string;
  to: string;
}) {
  const t = useT();
  const lang = useLang();
  const words = useWords().plan.history;
  const [box, measured] = useWidth<HTMLDivElement>();
  const W = measured || W_DEFAULT;

  const times = points.map((p) => Date.parse(p.at));
  const values = points.map((p) => Number(p.valueUsd));
  // The window, widened to any reading the answer gave outside it: no point is left off the plot.
  const t0 = Math.min(Date.parse(from), ...times);
  const t1 = Math.max(Date.parse(to), ...times);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = (high - low) * 0.08 || Math.max(Math.abs(high) * 0.01, 0.01);
  // A value is never under zero, so the axis is not drawn under it.
  const scale = nice(Math.max(0, low - pad), high + pad, 4);
  const step = (scale.ticks[1] ?? scale.hi) - (scale.ticks[0] ?? scale.lo);
  const digits = step >= 1 ? 0 : 2;
  const money = (usd: number) =>
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(usd);
  // a tick per label: two that read the same are one
  const grid = [...new Map(scale.ticks.map((v) => [money(v), v])).values()];

  const left = axisLeft(grid.map(money), 48);
  const plotW = W - left - RIGHT;
  const plotH = H - TOP - BOTTOM;
  const x = (time: number) => left + ((time - t0) / (t1 - t0 || 1)) * plotW;
  const y = (usd: number) => TOP + plotH * (1 - (usd - scale.lo) / (scale.hi - scale.lo || 1));
  const xs = times.map(x);
  const ticks = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 90)), LOCALE[lang]);

  const cursor = useChartCursor(points.length, (px, width) =>
    nearestIndex((px / (width || 1)) * W, xs),
  );
  const pointed = cursor.at ? points[cursor.at.i] : undefined;
  const newest = points[points.length - 1];
  const read = pointed ?? newest;

  /** Where the line is at a time between two readings, or null where there is no line. */
  const onLine = (time: number): number | null => {
    for (let i = 0; i + 1 < times.length; i += 1) {
      const a = times[i] as number;
      const b = times[i + 1] as number;
      if (time < a || time > b) continue;
      const va = values[i] as number;
      const vb = values[i + 1] as number;
      return y(b === a ? vb : va + ((vb - va) * (time - a)) / (b - a));
    }
    return null;
  };

  // The tags sit above the plot at their deposit's time; one that would cover the tag before it moves
  // to its right, and none leaves the figure.
  let free = Number.NEGATIVE_INFINITY;
  const marks = deposits
    .map((deposit) => ({ ...deposit, time: Date.parse(deposit.at) }))
    .filter((deposit) => deposit.time >= t0 && deposit.time <= t1)
    .sort((a, b) => a.time - b.time)
    .map((deposit) => {
      const at = x(deposit.time);
      const tag = Math.min(Math.max(at - TAG / 2, free, 0), W - TAG - 1);
      free = tag + TAG + 2;
      return { ...deposit, x: at, y: onLine(deposit.time), tag };
    });

  return (
    <figure data-ui="plan-value-chart" className="m-0 flex flex-col gap-2">
      <p
        aria-live="polite"
        data-ui="chart-readout"
        className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]/5 text-muted-foreground"
      >
        {read && (
          <>
            <span>
              {pointed ? '' : `${words.newest} · `}
              <time dateTime={read.at} className="text-foreground">
                {utc(lang, read.at)}
              </time>
            </span>
            <ProvenancePin
              value={dollars(lang, read.valueUsd)}
              obs={read.obs}
              labels={t.pin}
              className="font-medium text-foreground"
            />
          </>
        )}
      </p>
      <div ref={box}>
        <CasePlot label={words.plot(utc(lang, from), utc(lang, to))} cursor={cursor}>
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
          >
            {grid.map((v) => (
              <g key={v}>
                <line x1={left} x2={W - RIGHT} y1={y(v)} y2={y(v)} stroke="var(--border)" />
                <text x={left - 6} y={y(v) + 3} textAnchor="end" fill="var(--muted-foreground)">
                  {money(v)}
                </text>
              </g>
            ))}
            {ticks.ticks.map((time) => {
              const px = x(time);
              // a label that would run off either end is left out
              if (px < left + 18 || px > W - RIGHT - 18) return null;
              return (
                <g key={time}>
                  <line
                    x1={px}
                    x2={px}
                    y1={H - BOTTOM}
                    y2={H - BOTTOM + 4}
                    stroke="var(--muted-foreground)"
                  />
                  <text x={px} y={H - 6} textAnchor="middle" fill="var(--muted-foreground)">
                    {ticks.fmt(time)}
                  </text>
                </g>
              );
            })}
            <line
              x1={left}
              x2={W - RIGHT}
              y1={H - BOTTOM}
              y2={H - BOTTOM}
              stroke="var(--muted-foreground)"
            />
            {marks.map((mark) => (
              <g key={mark.n} data-ui="deposit-mark" data-n={mark.n} data-at={mark.at}>
                <line
                  x1={mark.x}
                  x2={mark.x}
                  y1={TOP - 4}
                  y2={H - BOTTOM}
                  stroke="var(--muted-foreground)"
                />
                <rect
                  x={mark.tag}
                  y={TOP - 4 - TAG}
                  width={TAG}
                  height={TAG}
                  fill="var(--card)"
                  stroke="var(--muted-foreground)"
                />
                <text
                  x={mark.tag + TAG / 2}
                  y={TOP - 4 - TAG + 10.5}
                  textAnchor="middle"
                  fill="var(--foreground)"
                >
                  {mark.n}
                </text>
              </g>
            ))}
            {/* solid: every point of it was measured */}
            <polyline
              data-ui="value-line"
              points={points
                .map((_, i) => `${xs[i]?.toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`)
                .join(' ')}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {points.length <= DOTS_UP_TO &&
              points.map((point, i) => (
                <rect
                  key={point.at}
                  data-ui="value-point"
                  x={(xs[i] ?? 0) - 2.5}
                  y={y(values[i] ?? 0) - 2.5}
                  width={5}
                  height={5}
                  fill="var(--chart-1)"
                />
              ))}
            {/* a deposit that falls where the line is drawn is marked on it too */}
            {marks.map(
              (mark) =>
                mark.y !== null && (
                  <rect
                    key={mark.n}
                    data-ui="deposit-on-line"
                    data-n={mark.n}
                    x={mark.x - 3.5}
                    y={mark.y - 3.5}
                    width={7}
                    height={7}
                    fill="var(--card)"
                    stroke="var(--foreground)"
                    strokeWidth={1.5}
                  />
                ),
            )}
            {cursor.at && pointed && (
              <g pointerEvents="none">
                <line
                  data-ui="chart-cross"
                  x1={xs[cursor.at.i]}
                  x2={xs[cursor.at.i]}
                  y1={TOP}
                  y2={H - BOTTOM}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 3"
                />
                <rect
                  x={(xs[cursor.at.i] ?? 0) - 3.5}
                  y={y(Number(pointed.valueUsd)) - 3.5}
                  width={7}
                  height={7}
                  fill="var(--chart-1)"
                  stroke="var(--card)"
                  strokeWidth={1.5}
                />
              </g>
            )}
          </svg>
        </CasePlot>
      </div>
      <figcaption className="flex flex-col gap-1 text-caption text-muted-foreground">
        <ul
          aria-label={words.legend.label}
          className="flex list-none flex-wrap gap-x-4 gap-y-1 p-0"
        >
          <li className="inline-flex items-center gap-1.5">
            <i
              aria-hidden="true"
              className="inline-block w-4 border-t-2"
              style={{ borderColor: 'var(--chart-1)' }}
            />
            {words.legend.value}
          </li>
          {marks.length > 0 && (
            <li className="inline-flex items-center gap-1.5">
              <DepositTag n={marks[0]?.n ?? 1} />
              {words.legend.deposit}
            </li>
          )}
        </ul>
        <span>{words.hint}</span>
      </figcaption>
    </figure>
  );
}

/** A deposit's number in its square, as the figure tags it. For the eye: the words beside it say it. */
export function DepositTag({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center border border-muted-foreground bg-card font-mono text-[10px]/none text-foreground"
    >
      {n}
    </span>
  );
}
