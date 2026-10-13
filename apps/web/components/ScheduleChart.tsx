type Row = { month: string; withdrawalBrl: number; balanceBrl: number; liquidityOk: boolean };

/**
 * Plain SVG: the base-case BRL balance in honey (2px), the stress cases dashed in muted and madder, and
 * madder ticks where liquidity breaks. Colours are the tokens', so dark mode follows (IDENTITY-2).
 */
export function ScheduleChart({
  base,
  stresses,
}: {
  base: Row[];
  stresses: Array<{ id: string; name: string; rows: Row[] }>;
}) {
  if (base.length === 0) return null;
  const W = 720;
  const H = 220;
  const P = { l: 56, r: 12, t: 12, b: 28 };
  const all = [base, ...stresses.map((s) => s.rows)].flat();
  const maxBal = Math.max(...all.map((r) => r.balanceBrl), 1);
  const n = base.length;
  const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - v / maxBal) * (H - P.t - P.b);
  const path = (rows: Row[]) =>
    rows
      .map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.balanceBrl).toFixed(1)}`)
      .join(' ');
  const colors = ['var(--muted-foreground)', 'var(--destructive)'];
  const fmt = (v: number) =>
    v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="BRL balance by month, base case and stresses"
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={P.l}
            x2={W - P.r}
            y1={y(maxBal * f)}
            y2={y(maxBal * f)}
            stroke="var(--border)"
          />
          <text
            x={P.l - 6}
            y={y(maxBal * f) + 4}
            fontSize="10"
            textAnchor="end"
            fill="var(--muted-foreground)"
          >
            R${fmt(maxBal * f)}
          </text>
        </g>
      ))}
      {stresses.map((s, k) => (
        <path
          key={s.id}
          d={path(s.rows)}
          fill="none"
          stroke={colors[k % colors.length]}
          strokeWidth="1.2"
          strokeDasharray="4 3"
        />
      ))}
      <path d={path(base)} fill="none" stroke="var(--tf-honey)" strokeWidth="2" />
      {base.map((r, i) =>
        r.liquidityOk ? null : (
          <line
            key={r.month}
            x1={x(i)}
            x2={x(i)}
            y1={H - P.b}
            y2={H - P.b - 8}
            stroke="var(--destructive)"
            strokeWidth="2"
          />
        ),
      )}
      {base
        .filter((_, i) => i % Math.max(1, Math.floor(n / 6)) === 0)
        .map((r, i, arr) => (
          <text
            key={r.month}
            x={x(base.indexOf(r))}
            y={H - 8}
            fontSize="10"
            textAnchor={i === arr.length - 1 ? 'end' : 'middle'}
            fill="var(--muted-foreground)"
          >
            {r.month}
          </text>
        ))}
    </svg>
  );
}
