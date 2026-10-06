import { cn } from '../../components/ui/cn';
import { COINS, PACKED, TONE } from './coins';

// The closing's coins as one plan, drawn flat in ink (gate CLOSING-COINS): what stands in for the 3D
// scene where it does not run (no WebGL, a software GPU, saved data, a small device, reduced motion)
// and before its first frame. Each coin a circle with its rim line and its ticker, in the cream, wood
// or stone of the scene, filled with the page's ground; the same packing as the scene's.

const R = 200;
const PAD = 8;
const TONES = { member: 'text-foreground', wood: 'text-primary', stone: 'text-muted-foreground' };

export function CoinsStill({ label, className }: { label: string; className?: string }) {
  const size = 2 * (R + PAD);
  return (
    <svg
      viewBox={`${-R - PAD} ${-R - PAD} ${size} ${size}`}
      role="img"
      aria-label={label}
      data-ui="coins-still"
      className={cn('block', className)}
    >
      {COINS.map((coin, i) => {
        const d = PACKED[i];
        if (!d) return null;
        const r = d.r * R;
        // as large as fits across the coin, in the mono face, as the scene sets it
        const fit = Math.min(r * 0.62, (r * 1.48) / Math.max(coin.ticker.length * 0.6, 1));
        return (
          <g
            key={coin.ticker}
            data-part="coin"
            data-ticker={coin.ticker}
            className={TONES[TONE[coin.kind]]}
          >
            <circle
              cx={d.x * R}
              cy={d.y * R}
              r={r}
              fill="var(--background)"
              stroke="currentColor"
              strokeWidth={1.5}
            />
            <circle
              cx={d.x * R}
              cy={d.y * R}
              r={r * 0.86}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.85}
            />
            <text
              x={d.x * R}
              y={d.y * R - r * 0.12}
              textAnchor="middle"
              dominantBaseline="central"
              fill="currentColor"
              fontFamily="var(--font-mono)"
              fontWeight={500}
              fontSize={fit}
            >
              {coin.ticker}
            </text>
            <text
              data-part="share"
              x={d.x * R}
              y={d.y * R + r * 0.4}
              textAnchor="middle"
              dominantBaseline="central"
              fill="currentColor"
              fontFamily="var(--font-mono)"
              fontSize={Math.max(fit * 0.62, 8)}
            >
              {coin.weightBps / 100}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}
