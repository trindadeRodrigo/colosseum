'use client';
import type { BasketCard } from '@colosseum/schemas';
import { useState } from 'react';
import {
  CaseLegend,
  CasePlot,
  CaseReadout,
  type CaseSeries,
  ReadoutFigure,
} from '../../components/ui/CaseChart';
import {
  axisLeft,
  nearestIndex,
  SERIES_FADE,
  seriesOpacity,
  useChartCursor,
  useWidth,
} from '../../components/ui/chart';
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
//
// The chart is drawn at its measured width and reads out a month under a crosshair, as the landing's
// cases do (components/ui/CaseChart.tsx, `useChartCursor`): the month, the high end and the low end,
// each on the plan's yield pin. Pointing at the legend lights a line and dims the other.

const W_DEFAULT = 640;
const H = 200;
const PAID_H = 150;
const TOP = 14;
const BOTTOM = 24;
const RIGHT = 70;

type PlanChartProps = {
  amountUsd: number;
  card: BasketCard;
  yieldObs: PinSource | null;
};

/** A goal with no date has no term to project over: no chart is drawn (gate GLIDE-OPT-IN). */
export function PlanChart(props: PlanChartProps) {
  const months = props.card.termMonths;
  return months === null ? null : <DatedPlanChart {...props} months={months} />;
}

function DatedPlanChart({
  amountUsd,
  card,
  yieldObs,
  months,
}: PlanChartProps & { months: number }) {
  const t = useT();
  const lang = useLang();
  const words = t.plan.chart;
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
  // a short plan's ends can round to the same dollars: then they are told to the cent
  const cents = (usd: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency: 'USD' }).format(usd);
  const percent = (pct: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      pct / 100,
    );

  const [box, measured] = useWidth<HTMLDivElement>();
  const W = measured || W_DEFAULT;
  // the value axis is as wide as its widest label in the reader's language ("US$ 40.000")
  const left = axisLeft([amountUsd, (amountUsd + high) / 2, high].map(money), 56);
  const x = (month: number) => left + (month / months) * (W - left - RIGHT);
  const [focus, setFocus] = useState<string | null>(null);
  const series: CaseSeries[] = [
    { id: 'high', label: words.high, color: 'var(--chart-1)', dashed: true },
    { id: 'low', label: words.low, color: 'var(--chart-3)', dashed: true },
  ];
  const at = (pct: number, m: number) => amountUsd + (amountUsd * pct * m) / 1200;
  const cursor = useChartCursor(months + 1, (px, w) =>
    nearestIndex(
      (px / (w || 1)) * W,
      Array.from({ length: months + 1 }, (_, m) => x(m)),
    ),
  );
  const m = cursor.at?.i ?? null;
  const [highS, lowS] = series as [CaseSeries, CaseSeries];

  const min = amountUsd * 0.98;
  const max = Math.max(high, amountUsd * 1.01) * 1.01;
  const y = (v: number) =>
    TOP + (H - TOP - BOTTOM) - ((v - min) / (max - min)) * (H - TOP - BOTTOM);
  // a tick per label: two values that round to the same dollars are one tick, not two stacked labels
  const grid = [
    ...new Map([amountUsd, (amountUsd + high) / 2, high].map((v) => [money(v), v])).values(),
  ];

  // A plan this short, or whose projection moves less than 1% of what goes in, would draw a flat line:
  // one sentence says what it comes to instead, on the same pin.
  if (card.cashFlow !== 'monthly' && (months < 6 || high - amountUsd < amountUsd * 0.01))
    return (
      <figure data-ui="plan-chart" data-kind="short" className="m-0 flex flex-col gap-2">
        <figcaption className="flex flex-wrap items-baseline gap-x-2 text-body">
          <span>{t.plan.short(t.goal.card.months(months))}</span>
          <ProvenancePin
            value={
              money(low) === money(high)
                ? t.plan.shortRange(cents(low), cents(high))
                : t.plan.shortRange(money(low), money(high))
            }
            obs={yieldObs}
            labels={t.pin}
          />
          <span className="text-caption text-muted-foreground">{words.projected}</span>
        </figcaption>
        <p className="text-caption text-muted-foreground">{words.note}</p>
      </figure>
    );

  const paidY = (v: number) =>
    TOP + (PAID_H - TOP - BOTTOM) * (1 - (high > amountUsd ? v / (high - amountUsd) : 0));
  // An income plan pays its yield out each month, so its balance does not grow: there is no balance
  // to draw. What it pays over the term is said instead, on the same pin.
  if (card.cashFlow === 'monthly')
    return (
      <figure data-ui="plan-chart" data-kind="paid" className="m-0 flex flex-col gap-2">
        {/* What is paid out, added up month by month: a band from the low end to the high end of
            the range, dashed because it is projected. */}
        <div ref={box}>
          <svg
            role="img"
            aria-label={words.paidLabel(months, percent(lowPct), percent(highPct))}
            viewBox={`0 0 ${W} ${PAID_H}`}
            className="block h-auto w-full"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
          >
            {[0, high - amountUsd].map((v) => (
              <g key={v}>
                <line x1={left} x2={W - RIGHT} y1={paidY(v)} y2={paidY(v)} stroke="var(--border)" />
                <text x={left - 6} y={paidY(v) + 3} textAnchor="end" fill="var(--muted-foreground)">
                  {money(v)}
                </text>
              </g>
            ))}
            <path
              className="motion-safe:animate-crossfade"
              d={`M${x(0)} ${paidY(0)} L${x(months)} ${paidY(high - amountUsd)} L${x(months)} ${paidY(low - amountUsd)} Z`}
              fill="var(--tf-honey)"
              fillOpacity={0.2}
            />
            <line
              x1={x(0)}
              y1={paidY(0)}
              x2={x(months)}
              y2={paidY(high - amountUsd)}
              stroke="var(--chart-1)"
              strokeWidth={2}
              strokeDasharray="5 3"
            />
            <line
              x1={x(0)}
              y1={paidY(0)}
              x2={x(months)}
              y2={paidY(low - amountUsd)}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
            />
            <text x={x(months) + 6} y={paidY(high - amountUsd) + 3} fill="var(--foreground)">
              {words.high}
            </text>
            <text x={x(months) + 6} y={paidY(low - amountUsd) + 12} fill="var(--muted-foreground)">
              {words.low}
            </text>
            <text x={left} y={PAID_H - 6} fill="var(--muted-foreground)">
              0
            </text>
            <text x={x(months)} y={PAID_H - 6} textAnchor="end" fill="var(--muted-foreground)">
              {t.goal.card.months(months)}
            </text>
          </svg>
        </div>
        <figcaption className="flex flex-wrap items-baseline gap-x-2 text-body-sm">
          <span className="text-muted-foreground">{words.paid(months)}:</span>
          <ProvenancePin
            value={`${money(low - amountUsd)} – ${money(high - amountUsd)}`}
            obs={yieldObs}
            labels={t.pin}
          />
          <span className="text-caption text-muted-foreground">{words.projected}</span>
        </figcaption>
        <p className="text-caption text-muted-foreground">{words.note}</p>
      </figure>
    );

  return (
    <figure data-ui="plan-chart" className="m-0 flex flex-col gap-2">
      <div ref={box}>
        <CasePlot label={words.label(months, percent(lowPct), percent(highPct))} cursor={cursor}>
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
          >
            {grid.map((g) => (
              <g key={g}>
                <line x1={left} x2={W - RIGHT} y1={y(g)} y2={y(g)} stroke="var(--border)" />
                <text x={left - 6} y={y(g) + 3} textAnchor="end" fill="var(--muted-foreground)">
                  {money(g)}
                </text>
              </g>
            ))}
            <path
              d={`M${x(0)} ${y(amountUsd)} L${x(months)} ${y(high)} L${x(months)} ${y(low)} Z`}
              fill="var(--tf-honey)"
              fillOpacity={0.2}
            />
            <g data-series="high" opacity={seriesOpacity(focus, 'high')} className={SERIES_FADE}>
              <line
                x1={x(0)}
                y1={y(amountUsd)}
                x2={x(months)}
                y2={y(high)}
                stroke="var(--chart-1)"
                strokeWidth={2}
                strokeDasharray="5 3"
              />
              <text x={x(months) + 6} y={y(high) + 3} fill="var(--foreground)">
                {words.high}
              </text>
            </g>
            <g data-series="low" opacity={seriesOpacity(focus, 'low')} className={SERIES_FADE}>
              <line
                x1={x(0)}
                y1={y(amountUsd)}
                x2={x(months)}
                y2={y(low)}
                stroke="var(--muted-foreground)"
                strokeDasharray="3 3"
              />
              <text x={x(months) + 6} y={y(low) + 12} fill="var(--muted-foreground)">
                {words.low}
              </text>
            </g>
            <text x={left} y={H - 6} fill="var(--muted-foreground)">
              0
            </text>
            <text x={x(months)} y={H - 6} textAnchor="end" fill="var(--muted-foreground)">
              {t.goal.card.months(months)}
            </text>
            {m !== null && (
              <g pointerEvents="none">
                <line
                  data-ui="chart-cross"
                  x1={x(m)}
                  x2={x(m)}
                  y1={TOP}
                  y2={H - BOTTOM}
                  stroke="var(--tf-chalk)"
                  strokeDasharray="2 3"
                />
                {(
                  [
                    ['high', highPct, 'var(--chart-1)'],
                    ['low', lowPct, 'var(--chart-3)'],
                  ] as const
                ).map(([key, pct, color]) => (
                  <rect
                    key={key}
                    x={x(m) - 3.5}
                    y={y(at(pct, m)) - 3.5}
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
        {m !== null && (
          <>
            <span className="text-foreground">{words.month(m)}</span>
            <ReadoutFigure
              series={highS}
              value={<ProvenancePin value={money(at(highPct, m))} obs={yieldObs} labels={t.pin} />}
            />
            <ReadoutFigure
              series={lowS}
              value={<ProvenancePin value={money(at(lowPct, m))} obs={yieldObs} labels={t.pin} />}
            />
          </>
        )}
      </CaseReadout>
      <CaseLegend series={series} focus={focus} onFocus={setFocus} label={words.series} />
      <figcaption className="flex flex-wrap items-baseline gap-x-2 text-body-sm">
        <span className="text-muted-foreground">{words.after(months)}:</span>
        <ProvenancePin value={`${money(low)} – ${money(high)}`} obs={yieldObs} labels={t.pin} />
        <span className="text-caption text-muted-foreground">{words.projected}</span>
      </figcaption>
      <p className="text-caption text-muted-foreground">{words.note}</p>
    </figure>
  );
}
