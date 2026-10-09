'use client';
import { useState } from 'react';
import { MockPlate } from '../../components/ui/MockPlate';
import { type Lang, LOCALE } from '../../i18n';
import { useT } from '../../i18n/I18nProvider';
import type { StrategyProjection } from './agent';

// The month-by-month balance the server projected from the plan's sourced yield readings (the relaxed
// intake, RELAXED-INTAKE). One series in honey (IDENTITY-2: the base series), the baseline a chalk
// guide, bars from zero with a 2px gap and at most a 2px radius. The figures are said in words above
// the bars for the month under the pointer or the focus, and in a table for a screen reader; the bars
// are a picture only. Figures projected from a reading that is not live (a test network's or a
// sample's) carry the sample glyph beside them (MOCK-QUIET); the card around the chart says so once.

export function ProjectionChart({
  projection,
  lang,
  sample = false,
}: {
  projection: StrategyProjection;
  lang: Lang;
  /** A reading behind the projection is not live: its figures are sample figures. */
  sample?: boolean;
}) {
  const t = useT();
  const w = t.shared.vault.conversation.projection;
  const plate = sample ? <MockPlate labels={{ figure: t.shell.sampleFigure }} /> : null;
  const money = (n: number) =>
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'currency',
      currency: /^[A-Z]{3}$/.test(projection.currency) ? projection.currency : 'USD',
      maximumFractionDigits: 0,
    }).format(n);
  const yearly = projection.step === 12;
  const monthName = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE[lang], {
      ...(yearly ? {} : { month: 'short' as const }),
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${iso}T00:00:00.000Z`));
  const points = projection.months;
  const [active, setActive] = useState<number | null>(null);
  if (!points.length)
    return (
      <div data-ui="projection-chart" className="flex flex-col gap-2">
        <p className="text-body-sm text-muted-foreground">{w.needsAmount}</p>
        <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {plate} {projection.basis}
        </p>
      </div>
    );
  // The scale holds the balance before a withdrawal: what stayed plus what was taken out.
  const max = Math.max(...points.map((p) => p.balance + p.withdrawn), 1);
  const anyWithdrawal = points.some((p) => p.withdrawn > 0);
  const shown = points[active ?? points.length - 1] ?? points[0];
  const line = (p: (typeof points)[number]) =>
    `${monthName(p.month)} · ${w.balance} ${money(p.balance)} · ${w.earned} ${money(p.earned)}${p.withdrawn > 0 ? ` · ${w.withdrawn} ${money(p.withdrawn)}` : ''}`;
  const label = (i: number) =>
    i === 0 || i === points.length - 1 || i === Math.floor((points.length - 1) / 2);
  return (
    <div data-ui="projection-chart" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="text-caption font-medium">{yearly ? w.yearly : w.title}</p>
        {anyWithdrawal && (
          <ul
            data-ui="projection-legend"
            className="flex items-center gap-3 text-caption text-muted-foreground"
          >
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-3 bg-primary" />
              {w.balance}
            </li>
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-3 border border-dashed border-foreground/60"
              />
              {w.withdrawn}
            </li>
          </ul>
        )}
      </div>
      <p aria-live="polite" className="min-h-5 text-body-sm tabular-nums [overflow-wrap:anywhere]">
        {shown ? line(shown) : ''} {shown && plate}
      </p>
      <div className="flex min-w-0 items-stretch gap-2">
        <div
          aria-hidden="true"
          className="flex w-14 shrink-0 flex-col justify-between text-right text-caption text-muted-foreground tabular-nums"
        >
          <span>{money(max)}</span>
          <span>{money(0)}</span>
        </div>
        <fieldset
          aria-label={w.hint}
          className="relative m-0 flex h-36 min-w-0 flex-1 items-end gap-0.5 border-0 border-b border-info p-0"
          onMouseLeave={() => setActive(null)}
        >
          {points.map((p, i) => (
            <button
              key={p.month}
              type="button"
              aria-label={line(p)}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="group flex h-full min-w-0 flex-1 items-end focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex h-full w-full flex-col justify-end gap-0.5">
                {/* What was taken out this period: an empty dashed outline on top of what stayed. */}
                {p.withdrawn > 0 && (
                  <span
                    data-ui="withdrawn-mark"
                    className={`block w-full shrink-0 border border-dashed ${active === i ? 'border-foreground' : 'border-foreground/60'}`}
                    style={{ height: `${(p.withdrawn / max) * 100}%` }}
                  />
                )}
                {p.balance > 0 && (
                  <span
                    className={`block w-full shrink-0 ${active === i ? 'bg-honey-deep' : 'bg-primary'}`}
                    style={{ height: `${Math.max(1, (p.balance / max) * 100)}%` }}
                  />
                )}
              </span>
            </button>
          ))}
        </fieldset>
      </div>
      <div
        aria-hidden="true"
        className="flex min-w-0 gap-0.5 pl-16 text-caption text-muted-foreground"
      >
        {points.map((p, i) => (
          <span key={p.month} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {label(i) ? monthName(p.month) : ''}
          </span>
        ))}
      </div>
      <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
        {projection.basis}
      </p>
      <table className="sr-only">
        <caption>{w.title}</caption>
        <thead>
          <tr>
            <th>{w.month}</th>
            <th>{w.balance}</th>
            <th>{w.earned}</th>
            <th>{w.withdrawn}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.month}>
              <td>{monthName(p.month)}</td>
              <td>{money(p.balance)}</td>
              <td>{money(p.earned)}</td>
              <td>{money(p.withdrawn)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
