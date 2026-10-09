'use client';
import { CasePlot } from '../../components/ui/CaseChart';
import { axisLeft, nearestIndex, useChartCursor, useWidth } from '../../components/ui/chart';
import { nice, timeTicks } from '../../components/ui/chart-scale';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { utc } from '../portfolio/figures';
import { type Stack, signRuns, type TotalPoint } from './overview-series';
import { useWords } from './words';

// The overview's figure (/portfolio): what the person's vaults were worth over the chosen period, as a
// solid line (every point was measured: STYLE.md, solid is measured), green where the value is at or
// above what had been put in by then and red where it is below, over a faint fill of the same colour;
// or the same value as stacked bars, one a day (an hour over 1D), cut by vault or by asset. Inline SVG
// drawn at the element's measured width, as the plan's chart is (PlanValueChart.tsx): no chart
// library.
//
// The line spans the readings there are, not the whole period asked: a vault read for an hour of a
// thirty-day window is drawn across the plot, not squeezed into its last pixel. A single reading is a
// flat line at its value with its point marked. Nothing is written over the chart until it is pointed
// at: then a tooltip beside the crosshair says the time and the figures, each with its pin, and a
// screen reader hears the same line. One tab stop, and the arrow keys step from point to point.

const W_DEFAULT = 720;
const H = 380;
const TOP = 16;
const BOTTOM = 24;
const RIGHT = 12;
/**
 * The parts of a stack take four chart colours in turn (the fifth, washi, is too near the first on a
 * dark ground to tell apart), then the same again lighter, and again lighter still. A hairline of the
 * card's colour parts two segments, so neighbours are told apart whatever their colours.
 */
const FILLS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-4)'];
const TIERS = [1, 0.55, 0.3];
export const fillOf = (i: number) => FILLS[i % FILLS.length] as string;
export const fillOpacity = (i: number) =>
  TIERS[Math.floor(i / FILLS.length) % TIERS.length] as number;

type Props = {
  from: string;
  to: string;
  /** The stamp of the figures read at a time: the snapshots kept, added up. */
  obs: (at: number) => PinSource;
} & (
  | { kind: 'line'; line: readonly TotalPoint[] }
  | { kind: 'bars'; stacks: readonly Stack[]; nameOf: (key: string) => string }
);

export function OverviewChart(props: Props) {
  const t = useT();
  const lang = useLang();
  const words = useWords().overview.board.chart;
  const [box, measured] = useWidth<HTMLDivElement>();
  const W = measured || W_DEFAULT;
  const money = (usd: number, digits = 2) =>
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(usd);

  const times = props.kind === 'line' ? props.line.map((p) => p.at) : props.stacks.map((s) => s.at);
  const totals =
    props.kind === 'line'
      ? props.line.map((p) => p.valueUsd)
      : props.stacks.map((s) => s.parts.reduce((sum, part) => sum + part.usd, 0));
  // The line's scale holds what was put in too, so the colour of a point can be read off the axis.
  const lows =
    props.kind === 'line' ? props.line.flatMap((p) => [p.valueUsd, p.netUsd]) : [0, ...totals];
  const highs = props.kind === 'line' ? lows : totals;
  const low = Math.min(...lows);
  const high = Math.max(...highs);
  const pad = (high - low) * 0.15 || Math.max(Math.abs(high) * 0.01, 0.01);
  const scale = nice(props.kind === 'bars' ? 0 : Math.max(0, low - pad), high + pad, 4);
  const step = (scale.ticks[1] ?? scale.hi) - (scale.ticks[0] ?? scale.lo);
  const digits = step >= 1 ? 0 : 2;
  const grid = [...new Map(scale.ticks.map((v) => [money(v, digits), v])).values()];
  const left = axisLeft(
    grid.map((v) => money(v, digits)),
    48,
  );
  const plotW = W - left - RIGHT;
  const plotH = H - TOP - BOTTOM;

  // The line spans its readings; one reading alone spans the plot. Bars sit in slots.
  const first = times[0] ?? Date.parse(props.from);
  const last = times[times.length - 1] ?? Date.parse(props.to);
  const single = props.kind === 'line' && times.length === 1;
  const t0 = single ? Date.parse(props.from) : first;
  const t1 = single ? Date.parse(props.to) : last;
  const slot = props.kind === 'bars' ? plotW / Math.max(1, times.length) : 0;
  const x =
    props.kind === 'bars'
      ? (i: number) => left + slot * (i + 0.5)
      : (time: number) => left + ((time - t0) / (t1 - t0 || 1)) * plotW;
  const xs =
    props.kind === 'bars'
      ? times.map((_, i) => x(i))
      : single
        ? [left + plotW]
        : times.map((time) => x(time));
  const y = (usd: number) => TOP + plotH * (1 - (usd - scale.lo) / (scale.hi - scale.lo || 1));
  const ticks = timeTicks(
    t0,
    t1 > t0 ? t1 : t0 + 1,
    Math.max(2, Math.floor(plotW / 90)),
    LOCALE[lang],
  );
  const tickX = (time: number) =>
    props.kind === 'bars'
      ? times.length > 1
        ? x(0) + ((time - first) / (last - first || 1)) * (x(times.length - 1) - x(0))
        : x(0)
      : x(time);

  const cursor = useChartCursor(times.length, (px, width) =>
    nearestIndex((px / (width || 1)) * W, xs),
  );
  const i = cursor.at?.i;
  const at = i === undefined ? undefined : times[i];
  const point = props.kind === 'line' && i !== undefined ? props.line[i] : undefined;
  const parts =
    props.kind === 'bars' && i !== undefined
      ? (props.stacks[i]?.parts.filter((part) => part.usd > 0) ?? [])
      : [];
  // The tooltip sits beside the crosshair, on the side with room.
  const cx = i === undefined ? 0 : (xs[i] ?? 0);
  const onLeft = cx > W * 0.6;

  return (
    <figure data-ui="overview-chart" data-kind={props.kind} className="m-0 flex flex-col gap-3">
      <div ref={box} className="relative">
        <CasePlot
          label={(props.kind === 'line' ? words.plot : words.bars)(
            utc(lang, props.from),
            utc(lang, props.to),
          )}
          cursor={cursor}
        >
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
          >
            {grid.map((v) => (
              <g key={v}>
                <line
                  x1={left}
                  x2={W - RIGHT}
                  y1={y(v)}
                  y2={y(v)}
                  stroke="var(--border)"
                  strokeDasharray="2 4"
                />
                <text x={left - 6} y={y(v) + 3} textAnchor="end" fill="var(--muted-foreground)">
                  {money(v, digits)}
                </text>
              </g>
            ))}
            {ticks.ticks.map((time) => {
              const px = tickX(time);
              if (px < left + 18 || px > W - RIGHT - 18) return null;
              return (
                <text
                  key={time}
                  x={px}
                  y={H - 6}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                >
                  {ticks.fmt(time)}
                </text>
              );
            })}
            {props.kind === 'line' ? (
              single && props.line[0] ? (
                <Flat
                  point={props.line[0]}
                  y={y}
                  from={left}
                  to={left + plotW}
                  floor={y(scale.lo)}
                />
              ) : (
                <Line line={props.line} x={x} y={y} floor={y(scale.lo)} />
              )
            ) : (
              props.stacks.map((stack, n) => {
                let base = 0;
                const width = Math.max(1, Math.min(28, slot * 0.7));
                return (
                  <g key={stack.at} data-ui="overview-bar">
                    {stack.parts.map((part, k) => {
                      if (part.usd <= 0) return null;
                      const top = y(base + part.usd);
                      const bottom = y(base);
                      base += part.usd;
                      return (
                        <rect
                          key={part.key}
                          data-key={part.key}
                          x={x(n) - width / 2}
                          y={top}
                          width={width}
                          height={Math.max(0.5, bottom - top)}
                          fill={fillOf(k)}
                          fillOpacity={fillOpacity(k)}
                          stroke="var(--card)"
                          strokeWidth={1}
                        />
                      );
                    })}
                  </g>
                );
              })
            )}
            {i !== undefined && (
              <line
                data-ui="chart-cross"
                x1={cx}
                x2={cx}
                y1={TOP}
                y2={H - BOTTOM}
                stroke="var(--muted-foreground)"
                strokeDasharray="2 3"
                pointerEvents="none"
              />
            )}
          </svg>
        </CasePlot>
        {at !== undefined && i !== undefined && (
          <div
            data-ui="chart-tooltip"
            aria-live="polite"
            className="pointer-events-none absolute top-2 z-10 flex min-w-40 flex-col gap-1 rounded-lg border border-border bg-popover px-3 py-2 font-mono text-[12px]/5 text-popover-foreground"
            style={
              onLeft
                ? { right: `${((W - cx + 12) / W) * 100}%` }
                : { left: `${((cx + 12) / W) * 100}%` }
            }
          >
            <time dateTime={new Date(at).toISOString()} className="text-muted-foreground">
              {utc(lang, new Date(at).toISOString())}
            </time>
            <ProvenancePin
              value={money(totals[i] ?? 0)}
              obs={props.obs(at)}
              labels={t.pin}
              className="font-medium"
            />
            {point && (
              <ProvenancePin
                value={`${point.pnlUsd >= 0 ? '+' : '−'}${money(Math.abs(point.pnlUsd))}`}
                obs={props.obs(at)}
                labels={t.pin}
                className={point.pnlUsd >= 0 ? 'text-success' : 'text-destructive'}
              />
            )}
            {parts.map((part) => (
              <span key={part.key} className="flex items-center justify-between gap-3">
                <span className="truncate text-muted-foreground">
                  {props.kind === 'bars' ? props.nameOf(part.key) : null}
                </span>
                <ProvenancePin value={money(part.usd)} obs={props.obs(at)} labels={t.pin} />
              </span>
            ))}
          </div>
        )}
      </div>
      {props.kind === 'bars' && (
        <ul
          data-ui="chart-legend"
          className="flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-caption text-muted-foreground"
        >
          {(props.stacks[0]?.parts ?? []).map((part, k) => (
            <li key={part.key} className="inline-flex items-center gap-1.5">
              <i
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ background: fillOf(k), opacity: fillOpacity(k) }}
              />
              {props.nameOf(part.key)}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** The value line, green above what was put in and red below, each run over a faint fill. */
function Line({
  line,
  x,
  y,
  floor,
}: {
  line: readonly TotalPoint[];
  x: (time: number) => number;
  y: (usd: number) => number;
  floor: number;
}) {
  return (
    <>
      {signRuns(line).map((run) => {
        const colour = run.up ? 'var(--success)' : 'var(--destructive)';
        const path = run.points.map((p) => `${x(p.at).toFixed(1)},${y(p.valueUsd).toFixed(1)}`);
        const first = run.points[0];
        const last = run.points[run.points.length - 1];
        if (!first || !last) return null;
        return (
          <g key={`${run.up}:${first.at}`} data-ui={run.up ? 'line-up' : 'line-down'}>
            <polygon
              points={[
                `${x(first.at).toFixed(1)},${floor.toFixed(1)}`,
                ...path,
                `${x(last.at).toFixed(1)},${floor.toFixed(1)}`,
              ].join(' ')}
              fill={colour}
              fillOpacity={0.08}
            />
            <polyline
              points={path.join(' ')}
              fill="none"
              stroke={colour}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </>
  );
}

/** One reading: a flat line at its value across the plot, its point marked at the right end. */
function Flat({
  point,
  y,
  from,
  to,
  floor,
}: {
  point: TotalPoint;
  y: (usd: number) => number;
  from: number;
  to: number;
  floor: number;
}) {
  const colour = point.pnlUsd >= 0 ? 'var(--success)' : 'var(--destructive)';
  const at = y(point.valueUsd);
  return (
    <g data-ui={point.pnlUsd >= 0 ? 'line-up' : 'line-down'}>
      <rect
        x={from}
        y={at}
        width={to - from}
        height={Math.max(0, floor - at)}
        fill={colour}
        fillOpacity={0.08}
      />
      <line x1={from} x2={to} y1={at} y2={at} stroke={colour} strokeWidth={2} />
      <circle cx={to} cy={at} r={3.5} fill={colour} />
    </g>
  );
}
