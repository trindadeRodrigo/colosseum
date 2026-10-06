'use client';
import { useState } from 'react';
import {
  CaseLegend,
  CasePlot,
  CaseReadout,
  type CaseSeries,
  ReadoutFigure,
} from '../../components/ui/CaseChart';
import {
  nearestIndex,
  SERIES_FADE,
  seriesOpacity,
  useChartCursor,
  useWidth,
} from '../../components/ui/chart';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { dictionary, type Lang, LOCALE } from '../../i18n';
import { GROWTH, SAMPLE, TRIP } from './sample';

// The two charts of his showcase (goal-showcase-case.md, part 5), drawn as SVG from the sample series:
// the colours are the plan-leg tokens and the text colours of the view, so light and dark both hold.
// Solid is the base, dashed is projected (the payout, the weak case, the target). Labels sit at the
// lines; each chart has a sentence for a screen reader and the same figures as a hidden table.
//
// Each is drawn at its own measured width (as the Bearing charts are), so its 10px type stays 10px on a
// phone and nothing scrolls sideways. A crosshair reads a month out (`useChartCursor`, shared with the
// Bearing charts): a mouse hovers, a finger taps and drags, the arrow keys step, Home and End jump. The
// readout under the chart is an aria-live line, every figure in it pinned MOCK like the rest of the
// case. Pointing at the legend lights a series and dims the others.

/** The width a chart is laid out for before it is measured: the server's drawing, scaled. */
const W_DEFAULT = 640;
const H = 220;
const TOP = 14;
const BOTTOM = 26;
const MONO = { fontFamily: 'var(--font-mono)', fontSize: 10 } as const;

const monthName = (lang: Lang, ym: string) =>
  new Intl.DateTimeFormat(LOCALE[lang], {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${ym}-01T00:00:00Z`));

/** The month `n` months after `ym`, as `YYYY-MM`. */
const plusMonths = (ym: string, n: number) => {
  const d = new Date(`${ym}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

/** Months from `a` to `b`, both `YYYY-MM`. */
const monthsBetween = (a: string, b: string) => {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
};

/** The month of a point of the growth series: every third month, and the last at its end. */
const growthMonth = (i: number) =>
  i === GROWTH.base.length - 1
    ? GROWTH.end
    : plusMonths(GROWTH.start, Math.min(i * 3, monthsBetween(GROWTH.start, GROWTH.end)));

const thousands = (lang: Lang, usd: number) =>
  lang === 'pt' ? `US$ ${usd / 1000} mil` : `$${usd / 1000}k`;

const whole = (lang: Lang, usd: number) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(usd);

type Labels = { chart: string; table: string; month: string; balance: string };

/** The figures behind a chart, for a screen reader. */
function Table({ labels, rows }: { labels: Labels; rows: [string, string][] }) {
  return (
    <table className="sr-only">
      <caption>{labels.table}</caption>
      <thead>
        <tr>
          <th scope="col">{labels.month}</th>
          <th scope="col">{labels.balance}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([month, balance]) => (
          <tr key={month}>
            <th scope="row">{month}</th>
            <td>{balance}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A sample figure in the readout: the amount and the MOCK pin, as every figure of a case has. */
function Sample({ lang, usd }: { lang: Lang; usd: number }) {
  return <ProvenancePin value={whole(lang, usd)} obs={SAMPLE} labels={dictionary(lang).pin} />;
}

/** The crosshair: a thin line across the plot at the month it is on. */
function Cross({ x, top, bottom }: { x: number; top: number; bottom: number }) {
  return (
    <line
      data-ui="chart-cross"
      x1={x}
      x2={x}
      y1={top}
      y2={bottom}
      stroke="var(--muted-foreground)"
      strokeDasharray="2 3"
      pointerEvents="none"
    />
  );
}

/** The trip: the balance month by month, stacked by part, then the three months it pays out. */
export function TripChart({
  lang,
  labels,
  payout,
  parts,
}: {
  lang: Lang;
  labels: Labels;
  payout: string;
  /** The name of each part, in the order of `TRIP.legs`. */
  parts: readonly string[];
}) {
  const words = dictionary(lang).landing.show.readout;
  const [box, measured] = useWidth<HTMLDivElement>();
  const W = measured || W_DEFAULT;
  const left = 44;
  const right = 10;
  const width = W - left - right;
  const height = H - TOP - BOTTOM;
  const max = Math.ceil(Math.max(...TRIP.balances) / 500) * 500;
  const bar = width / TRIP.balances.length;
  const centre = (i: number) => left + i * bar + bar / 2;
  const payoutX = left + TRIP.months * bar;
  const grid = Array.from({ length: Math.floor(max / 1000) + 1 }, (_, i) => i * 1000);
  const series: CaseSeries[] = TRIP.legs.map((leg, i) => ({
    id: `part-${leg.chart}`,
    label: parts[i] ?? '',
    color: `var(--chart-${leg.chart})`,
  }));
  const [focus, setFocus] = useState<string | null>(null);
  const cursor = useChartCursor(TRIP.balances.length, (x, w) =>
    nearestIndex(
      (x / (w || 1)) * W,
      TRIP.balances.map((_, i) => centre(i)),
    ),
  );
  const i = cursor.at?.i ?? null;
  const balance = i === null ? 0 : (TRIP.balances[i] ?? 0);
  const paying = i !== null && i >= TRIP.months;
  return (
    <div data-ui="showcase-chart" data-chart="trip" className="flex flex-col gap-2">
      <div ref={box}>
        <CasePlot label={labels.chart} cursor={cursor}>
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full"
            style={MONO}
          >
            {grid.map((g) => {
              const y = TOP + height - (g / max) * height;
              return (
                <g key={g}>
                  <line x1={left} x2={W - right} y1={y} y2={y} stroke="var(--border)" />
                  <text x={left - 6} y={y + 3} textAnchor="end" fill="var(--muted-foreground)">
                    {thousands(lang, g)}
                  </text>
                </g>
              );
            })}
            {TRIP.balances.map((value, m) => {
              let base = TOP + height;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a month of the series is its place in it
                <g key={m} data-month={m} opacity={i === null || i === m ? 1 : 0.85}>
                  {TRIP.legs.map((leg) => {
                    const h = ((value * leg.weightBps) / 10_000 / max) * height;
                    base -= h;
                    return (
                      <rect
                        key={leg.chart}
                        data-series={`part-${leg.chart}`}
                        x={left + m * bar + 1}
                        y={base}
                        width={Math.max(bar - 2, 1)}
                        height={h}
                        fill={`var(--chart-${leg.chart})`}
                        opacity={seriesOpacity(focus, `part-${leg.chart}`)}
                        className={SERIES_FADE}
                      />
                    );
                  })}
                </g>
              );
            })}
            <line
              x1={payoutX}
              x2={payoutX}
              y1={TOP}
              y2={TOP + height}
              stroke="var(--foreground)"
              strokeDasharray="3 3"
            />
            <text x={payoutX - 6} y={TOP + 10} textAnchor="end" fill="var(--foreground)">
              {payout}
            </text>
            <text x={left} y={H - 8} fill="var(--muted-foreground)">
              {monthName(lang, TRIP.start)}
            </text>
            <text x={payoutX - 2} y={H - 8} textAnchor="end" fill="var(--muted-foreground)">
              {monthName(lang, TRIP.payoutFrom)}
            </text>
            <text x={W - right} y={H - 8} textAnchor="end" fill="var(--muted-foreground)">
              {monthName(lang, TRIP.end)}
            </text>
            {i !== null && <Cross x={centre(i)} top={TOP} bottom={TOP + height} />}
          </svg>
        </CasePlot>
      </div>
      <CaseReadout at={cursor.at} hint={words.hint}>
        {i !== null && (
          <>
            <span className="text-foreground">{monthName(lang, plusMonths(TRIP.start, i))}</span>
            {TRIP.legs.map((leg, k) => (
              <ReadoutFigure
                key={leg.chart}
                series={series[k] as CaseSeries}
                value={<Sample lang={lang} usd={Math.round((balance * leg.weightBps) / 10_000)} />}
              />
            ))}
            <span className="inline-flex items-center gap-x-1.5">
              {paying ? words.paidOut : words.putIn}{' '}
              <b className="font-medium text-foreground">
                <Sample lang={lang} usd={paying ? TRIP.payoutUsd : TRIP.saveUsd} />
              </b>
            </span>
          </>
        )}
      </CaseReadout>
      <CaseLegend series={series} focus={focus} onFocus={setFocus} label={words.series} />
      <Table
        labels={labels}
        rows={TRIP.balances.map((value, m) => [
          monthName(lang, plusMonths(TRIP.start, m)),
          whole(lang, value),
        ])}
      />
    </div>
  );
}

/** The growth goal: the base path, the range from a weak to a strong case, and the target. */
export function GrowthChart({
  lang,
  labels,
  goal,
  weak,
}: {
  lang: Lang;
  labels: Labels;
  goal: string;
  weak: string;
}) {
  const words = dictionary(lang).landing.show.readout;
  const [box, measured] = useWidth<HTMLDivElement>();
  const W = measured || W_DEFAULT;
  const left = 48;
  const right = 10;
  const width = W - left - right;
  const height = H - TOP - BOTTOM;
  const min = 10_000;
  const max = Math.ceil(Math.max(...GROWTH.strong) / 5000) * 5000;
  const last = GROWTH.base.length - 1;
  const x = (i: number) => left + (i / last) * width;
  const y = (v: number) => TOP + height - ((v - min) / (max - min)) * height;
  const path = (series: readonly number[]) =>
    series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const band = `${path(GROWTH.strong)} ${[...GROWTH.weak]
    .map((v, i) => [i, v] as const)
    .reverse()
    .map(([i, v]) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ')} Z`;
  const grid = Array.from({ length: (max - min) / 5000 + 1 }, (_, i) => min + i * 5000);
  const series: CaseSeries[] = [
    { id: 'base', label: words.base, color: 'var(--chart-1)' },
    { id: 'range', label: words.range, color: 'var(--chart-3)' },
    { id: 'goal', label: words.goal, color: 'var(--foreground)', dashed: true },
  ];
  const [focus, setFocus] = useState<string | null>(null);
  const op = (id: string) => seriesOpacity(focus, id);
  // A point every third month: the crosshair snaps to the nearest of them.
  const cursor = useChartCursor(GROWTH.base.length, (px, w) =>
    nearestIndex(
      (px / (w || 1)) * W,
      GROWTH.base.map((_, i) => x(i)),
    ),
  );
  const i = cursor.at?.i ?? null;
  const at = (s: readonly number[]) => (i === null ? 0 : (s[i] ?? 0));
  const [baseS, rangeS, goalS] = series as [CaseSeries, CaseSeries, CaseSeries];
  return (
    <div data-ui="showcase-chart" data-chart="growth" className="flex flex-col gap-2">
      <div ref={box}>
        <CasePlot label={labels.chart} cursor={cursor}>
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full"
            style={MONO}
          >
            {grid.map((g) => (
              <g key={g}>
                <line x1={left} x2={W - right} y1={y(g)} y2={y(g)} stroke="var(--border)" />
                <text x={left - 6} y={y(g) + 3} textAnchor="end" fill="var(--muted-foreground)">
                  {thousands(lang, g)}
                </text>
              </g>
            ))}
            <g data-series="range" opacity={op('range')} className={SERIES_FADE}>
              <path d={band} fill="var(--chart-3)" fillOpacity={0.28} />
              <path
                d={path(GROWTH.weak)}
                fill="none"
                stroke="var(--chart-3)"
                strokeDasharray="3 3"
              />
            </g>
            <path
              data-series="base"
              d={path(GROWTH.base)}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth={2}
              opacity={op('base')}
              className={SERIES_FADE}
            />
            <g data-series="goal" opacity={op('goal')} className={SERIES_FADE}>
              <line
                x1={left}
                x2={W - right}
                y1={y(GROWTH.targetUsd)}
                y2={y(GROWTH.targetUsd)}
                stroke="var(--foreground)"
                strokeDasharray="6 4"
              />
              <text x={left + 6} y={y(GROWTH.targetUsd) - 6} fill="var(--foreground)">
                {goal}
              </text>
            </g>
            <text
              x={x(last) - 4}
              y={y(GROWTH.weak[last] ?? min) + 14}
              textAnchor="end"
              fill="var(--muted-foreground)"
            >
              {weak}
            </text>
            <text x={left} y={H - 8} fill="var(--muted-foreground)">
              {monthName(lang, GROWTH.start)}
            </text>
            <text x={W - right} y={H - 8} textAnchor="end" fill="var(--muted-foreground)">
              {monthName(lang, GROWTH.end)}
            </text>
            {i !== null && (
              <g pointerEvents="none">
                <Cross x={x(i)} top={TOP} bottom={TOP + height} />
                {(
                  [
                    ['strong', GROWTH.strong, 'var(--chart-3)'],
                    ['base', GROWTH.base, 'var(--chart-1)'],
                    ['weak', GROWTH.weak, 'var(--chart-3)'],
                  ] as const
                ).map(([key, s, color]) => (
                  <rect
                    key={key}
                    x={x(i) - 3.5}
                    y={y(at(s)) - 3.5}
                    width={7}
                    height={7}
                    fill={color}
                    stroke="var(--card)"
                    strokeWidth={1.5}
                  />
                ))}
              </g>
            )}
          </svg>
        </CasePlot>
      </div>
      <CaseReadout at={cursor.at} hint={words.hint}>
        {i !== null && (
          <>
            <span className="text-foreground">{monthName(lang, growthMonth(i))}</span>
            <ReadoutFigure series={baseS} value={<Sample lang={lang} usd={at(GROWTH.base)} />} />
            <ReadoutFigure
              series={{ ...rangeS, label: words.weak }}
              value={<Sample lang={lang} usd={at(GROWTH.weak)} />}
            />
            <ReadoutFigure
              series={{ ...rangeS, label: words.strong }}
              value={<Sample lang={lang} usd={at(GROWTH.strong)} />}
            />
            <ReadoutFigure series={goalS} value={<Sample lang={lang} usd={GROWTH.targetUsd} />} />
          </>
        )}
      </CaseReadout>
      <CaseLegend series={series} focus={focus} onFocus={setFocus} label={words.series} />
      <Table
        labels={labels}
        rows={GROWTH.base.map((value, m) => [monthName(lang, growthMonth(m)), whole(lang, value)])}
      />
    </div>
  );
}
