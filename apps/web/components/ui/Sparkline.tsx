import { type ChartSeriesClass, SERIES_VAR } from './TimeChart';

// A sparkline for a table cell (analytics-charts.js, `spark`): 88 by 22, one line, no axis. It is a
// picture of a trend beside figures that carry their own pins, so it is hidden from assistive tech.
// Fewer than two values draw nothing: the caller shows the reason instead.

export function Sparkline({
  values,
  cls = 's1',
}: {
  values: ReadonlyArray<number | null>;
  cls?: ChartSeriesClass;
}) {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const w = 88;
  const h = 22;
  const pts = values
    .map((x, i) =>
      x == null
        ? null
        : `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((x - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`,
    )
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      data-ui="sparkline"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      className="block"
    >
      <polyline points={pts} fill="none" stroke={SERIES_VAR[cls]} strokeWidth={1.75} />
    </svg>
  );
}

/** Whether a sparkline would draw: two values or more. */
export const sparkable = (values: ReadonlyArray<number | null>) =>
  values.filter((x) => x != null).length >= 2;
