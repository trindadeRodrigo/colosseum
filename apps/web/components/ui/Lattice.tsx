import { cn } from './cn';

// The square lattice, 3 by 3, as the loading and empty-state mark (STYLE.md: P1 medium, "loading and
// empty states only"). It is drawn still. The assembling animation of the full loader is not built
// here: the specs of the primitives that wait (card, composer, goal card, constraint sheet) all ask
// for the static lattice with a label.

export type LatticeGlyphProps = {
  /** The side in px. 48 beside a label; 20 inside the composer's send button. */
  size?: number;
  /** `hairline` on a surface; `current` takes the text colour, inside a filled button. */
  tone?: 'hairline' | 'current';
  className?: string;
};

/** Four hairlines each way. */
export function LatticeGlyph({ size = 48, tone = 'hairline', className }: LatticeGlyphProps) {
  const at = [0.5, 16.5, 32.5, 47.5];
  return (
    <svg
      data-ui="lattice"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={48 / size}
      className={cn('shrink-0', tone === 'hairline' && 'text-border', className)}
    >
      {at.map((p) => (
        <path key={`h${p}`} d={`M0 ${p}H48`} />
      ))}
      {at.map((p) => (
        <path key={`v${p}`} d={`M${p} 0V48`} />
      ))}
    </svg>
  );
}

export type LatticeStatusProps = {
  /** What is happening, in words: "Loading your goal". The lattice never appears without it. */
  label: string;
  className?: string;
};

/** A wait, said in words beside the still lattice. Announced once, politely. */
export function LatticeStatus({ label, className }: LatticeStatusProps) {
  return (
    <div
      role="status"
      data-ui="lattice-status"
      className={cn('inline-flex items-center gap-3 text-body-sm text-muted-foreground', className)}
    >
      <LatticeGlyph />
      <span>{label}</span>
    </div>
  );
}
