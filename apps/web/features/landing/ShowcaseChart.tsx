import type { Lang } from '../../i18n';
import { GROWTH, TRIP } from './sample';

// The two charts of his showcase (goal-showcase-case.md, part 5), drawn as SVG from the sample series:
// the colours are the plan-leg tokens and the text colours of the view, so light and dark both hold.
// Solid is the base, dashed is projected (the payout, the weak case, the target). Labels sit at the
// lines; each chart has a sentence for a screen reader and the same figures as a hidden table.

const W = 640;
const H = 220;
const TOP = 14;
const BOTTOM = 26;
const MONO = { fontFamily: 'var(--font-mono)', fontSize: 10 } as const;

const monthName = (lang: Lang, ym: string) =>
  new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${ym}-01T00:00:00Z`));

const thousands = (lang: Lang, usd: number) =>
  lang === 'pt' ? `US$ ${usd / 1000} mil` : `$${usd / 1000}k`;

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

/** The trip: the balance month by month, stacked by part, then the three months it pays out. */
export function TripChart({
  lang,
  labels,
  payout,
  money,
}: {
  lang: Lang;
  labels: Labels;
  payout: string;
  money: (usd: number) => string;
}) {
  const left = 44;
  const right = 10;
  const width = W - left - right;
  const height = H - TOP - BOTTOM;
  const max = Math.ceil(Math.max(...TRIP.balances) / 500) * 500;
  const bar = width / TRIP.balances.length;
  const payoutX = left + TRIP.months * bar;
  const grid = Array.from({ length: Math.floor(max / 1000) + 1 }, (_, i) => i * 1000);
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls on a phone must be reachable by keyboard
      tabIndex={0}
      aria-label={labels.chart}
      className="m-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <svg
        role="img"
        aria-label={labels.chart}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full min-w-[520px]"
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
        {TRIP.balances.map((value, i) => {
          let base = TOP + height;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a month of the series is its place in it
            <g key={i}>
              {TRIP.legs.map((leg) => {
                const h = ((value * leg.weightBps) / 10_000 / max) * height;
                base -= h;
                return (
                  <rect
                    key={leg.chart}
                    x={left + i * bar + 1}
                    y={base}
                    width={Math.max(bar - 2, 1)}
                    height={h}
                    fill={`var(--chart-${leg.chart})`}
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
      </svg>
      <Table
        labels={labels}
        rows={TRIP.balances.map((value, i) => {
          const d = new Date(`${TRIP.start}-01T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + i);
          return [monthName(lang, d.toISOString().slice(0, 7)), money(value)];
        })}
      />
    </section>
  );
}

/** The growth goal: the base path, the range from a weak to a strong case, and the target. */
export function GrowthChart({
  lang,
  labels,
  goal,
  weak,
  money,
}: {
  lang: Lang;
  labels: Labels;
  goal: string;
  weak: string;
  money: (usd: number) => string;
}) {
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
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls on a phone must be reachable by keyboard
      tabIndex={0}
      aria-label={labels.chart}
      className="m-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <svg
        role="img"
        aria-label={labels.chart}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full min-w-[520px]"
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
        <path d={band} fill="var(--chart-3)" fillOpacity={0.28} />
        <path d={path(GROWTH.weak)} fill="none" stroke="var(--chart-3)" strokeDasharray="3 3" />
        <path d={path(GROWTH.base)} fill="none" stroke="var(--chart-1)" strokeWidth={2} />
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
      </svg>
      <Table
        labels={labels}
        rows={GROWTH.base.map((value, i) => {
          const d = new Date(`${GROWTH.start}-01T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + i * 3);
          return [monthName(lang, d.toISOString().slice(0, 7)), money(value)];
        })}
      />
    </section>
  );
}
