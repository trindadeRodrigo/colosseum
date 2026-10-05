type Curve = {
  regime: string;
  points: Array<{ notionalUsd: number; cost: number; samples: number }>;
  insufficientFrom: number | null;
};

const COLORS: Record<string, string> = {
  us_market_hours: '#10b981',
  us_offhours_weekday: '#f59e0b',
  weekend: '#ef4444',
  us_holiday: '#8b5cf6',
  lp_exit: '#6b7280',
};

/** Plain SVG: sell cost (%) vs notional (log scale) per regime; dashed where samples are insufficient. */
export function CostCurveChart({ curves, tau }: { curves: Curve[]; tau: number }) {
  const all = curves.flatMap((c) => c.points);
  if (all.length === 0) return <p className="text-sm text-gray-500">No curve yet.</p>;
  const W = 720;
  const H = 240;
  const P = { l: 56, r: 12, t: 12, b: 32 };
  const minN = Math.min(...all.map((p) => p.notionalUsd));
  const maxN = Math.max(...all.map((p) => p.notionalUsd));
  const maxC = Math.min(0.2, Math.max(tau * 3, ...all.map((p) => p.cost)));
  const x = (n: number) =>
    P.l +
    ((Math.log(n) - Math.log(minN)) / (Math.log(maxN) - Math.log(minN) || 1)) * (W - P.l - P.r);
  const y = (c: number) => P.t + (1 - Math.min(c, maxC) / maxC) * (H - P.t - P.b);
  const fmt = (v: number) => (v >= 1e6 ? `$${v / 1e6}M` : v >= 1e3 ? `$${v / 1e3}k` : `$${v}`);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Sell cost by notional and regime"
    >
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={P.l} x2={W - P.r} y1={y(maxC * f)} y2={y(maxC * f)} stroke="#e5e7eb" />
          <text x={P.l - 6} y={y(maxC * f) + 4} fontSize="10" textAnchor="end" fill="#6b7280">
            {(maxC * f * 100).toFixed(1)}%
          </text>
        </g>
      ))}
      <line x1={P.l} x2={W - P.r} y1={y(tau)} y2={y(tau)} stroke="#111827" strokeDasharray="2 3" />
      <text x={W - P.r} y={y(tau) - 4} fontSize="10" textAnchor="end">
        τ = {(tau * 100).toFixed(1)}%
      </text>
      {[...new Set(all.map((p) => p.notionalUsd))].map((n) => (
        <text key={n} x={x(n)} y={H - 10} fontSize="10" textAnchor="middle" fill="#6b7280">
          {fmt(n)}
        </text>
      ))}
      {curves.map((c) => {
        const ok =
          c.insufficientFrom === null ? c.points : c.points.slice(0, c.insufficientFrom + 1);
        const thin = c.insufficientFrom === null ? [] : c.points.slice(c.insufficientFrom);
        const path = (pts: Curve['points']) =>
          pts
            .map((p, i) => `${i ? 'L' : 'M'}${x(p.notionalUsd).toFixed(1)},${y(p.cost).toFixed(1)}`)
            .join(' ');
        const color = COLORS[c.regime] ?? '#374151';
        return (
          <g key={c.regime}>
            {c.insufficientFrom !== 0 && (
              <path d={path(ok)} fill="none" stroke={color} strokeWidth={2} />
            )}
            {thin.length > 0 && (
              <path
                d={path(thin)}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            )}
          </g>
        );
      })}
      <g>
        {curves.map((c, i) => (
          <g key={c.regime} transform={`translate(${P.l + 8 + i * 150}, ${P.t + 6})`}>
            <rect width="10" height="3" y="3" fill={COLORS[c.regime] ?? '#374151'} />
            <text x="14" y="9" fontSize="10">
              {c.regime.replaceAll('_', ' ')}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
