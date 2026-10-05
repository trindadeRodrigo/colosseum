'use client';
import type { BasketCard } from '@colosseum/schemas';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';

// The chart of the plan pane, as his showcase case draws one (goal-showcase-case.md, part 5): what the
// plan's dollar yield projects over its term, from the range the engine gave (`card.expectedReturn`,
// a share of the amount a year, low to high), drawn as a band between two dashed lines because it is
// projected. Nothing else is worked out: the amount grows by that share of itself, month by month, and
// no price of a stock or of gold is projected. The two end figures sit under the chart with the pin of
// the plan's yield observation. With no yield observation, or yields the engine could not read, there
// is no chart: a range with no source is not drawn.

const W = 640;
const H = 200;
const TOP = 14;
const BOTTOM = 24;
const LEFT = 56;
const RIGHT = 70;

export function PlanChart({
  amountUsd,
  card,
  yieldObs,
}: {
  amountUsd: number;
  card: BasketCard;
  yieldObs: PinSource | null;
}) {
  const t = useT();
  const lang = useLang();
  const words = t.plan.chart;
  const months = card.termMonths;
  const { lowPct, highPct } = card.expectedReturn;
  const end = (pct: number) => amountUsd + (amountUsd * pct * months) / 1200;
  const low = end(lowPct);
  const high = end(highPct);
  const money = (usd: number) =>
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(usd);
  const percent = (pct: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      pct / 100,
    );

  const min = amountUsd * 0.98;
  const max = Math.max(high, amountUsd * 1.01) * 1.01;
  const x = (m: number) => LEFT + (m / months) * (W - LEFT - RIGHT);
  const y = (v: number) =>
    TOP + (H - TOP - BOTTOM) - ((v - min) / (max - min)) * (H - TOP - BOTTOM);
  const grid = [amountUsd, (amountUsd + high) / 2, high];

  return (
    <figure data-ui="plan-chart" className="m-0 flex flex-col gap-2">
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls on a phone must be reachable by keyboard
        tabIndex={0}
        aria-label={words.table}
        className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <svg
          role="img"
          aria-label={words.label(months, percent(lowPct), percent(highPct))}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[480px]"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
        >
          {grid.map((g) => (
            <g key={g}>
              <line x1={LEFT} x2={W - RIGHT} y1={y(g)} y2={y(g)} stroke="var(--border)" />
              <text x={LEFT - 6} y={y(g) + 3} textAnchor="end" fill="var(--muted-foreground)">
                {money(g)}
              </text>
            </g>
          ))}
          <path
            d={`M${x(0)} ${y(amountUsd)} L${x(months)} ${y(high)} L${x(months)} ${y(low)} Z`}
            fill="var(--chart-3)"
            fillOpacity={0.28}
          />
          <line
            x1={x(0)}
            y1={y(amountUsd)}
            x2={x(months)}
            y2={y(high)}
            stroke="var(--chart-1)"
            strokeWidth={2}
            strokeDasharray="5 3"
          />
          <line
            x1={x(0)}
            y1={y(amountUsd)}
            x2={x(months)}
            y2={y(low)}
            stroke="var(--chart-3)"
            strokeDasharray="3 3"
          />
          <text x={x(months) + 6} y={y(high) + 3} fill="var(--foreground)">
            {words.high}
          </text>
          <text x={x(months) + 6} y={y(low) + 12} fill="var(--muted-foreground)">
            {words.low}
          </text>
          <text x={LEFT} y={H - 6} fill="var(--muted-foreground)">
            0
          </text>
          <text x={x(months)} y={H - 6} textAnchor="end" fill="var(--muted-foreground)">
            {t.goal.card.months(months)}
          </text>
        </svg>
      </section>
      <figcaption className="flex flex-wrap items-baseline gap-x-2 text-body-sm">
        <span className="text-muted-foreground">{words.after(months)}:</span>
        <ProvenancePin value={`${money(low)} – ${money(high)}`} obs={yieldObs} labels={t.pin} />
        <span className="text-caption text-muted-foreground">{words.projected}</span>
      </figcaption>
      <p className="text-caption text-muted-foreground">{words.note}</p>
    </figure>
  );
}
