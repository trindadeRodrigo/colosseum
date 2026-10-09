'use client';
import { LatticeGlyph } from './Lattice';
import { LatticeLoader } from './Skeleton';
import { useWaitPhase } from './wait';

/**
 * The mark of a wait, in a place that is kept for it: the still lattice for the first 400ms, then the
 * one that assembles (STYLE.md: the loader is only for waits over 400ms). Under reduced motion the
 * second is still too. It never stands alone: the words that say what is awaited are beside it.
 */
export function WaitMark({
  waiting = true,
  size = 24,
  tone = 'muted',
}: {
  /** False draws the still lattice: the place is kept, nothing is awaited. */
  waiting?: boolean;
  size?: number;
  /** `muted` on a surface; `current` takes the text colour, inside a filled button. */
  tone?: 'muted' | 'current';
}) {
  const moving = useWaitPhase(waiting) !== 'quiet';
  if (waiting && moving) return <LatticeLoader size={size} tone={tone} />;
  return (
    <LatticeGlyph
      size={size}
      tone="current"
      className={tone === 'muted' ? 'text-muted-foreground' : undefined}
    />
  );
}
