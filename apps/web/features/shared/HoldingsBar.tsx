const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;

/**
 * One bar of what a portfolio holds, on its card: a segment per holding by its share, the four leg
 * colours in turn. It is a picture only: each share is said in words beside it, never by the bar alone.
 */
export function HoldingsBar({ shares }: { shares: readonly { key: string; shareBps: number }[] }) {
  return (
    <div aria-hidden="true" data-ui="holdings-bar" className="flex h-3 gap-0.5">
      {shares.map((s, i) => (
        <span
          key={s.key}
          className={`min-w-0.5 ${FILL[i % FILL.length]}`}
          style={{ width: `${s.shareBps / 100}%` }}
        />
      ))}
    </div>
  );
}
