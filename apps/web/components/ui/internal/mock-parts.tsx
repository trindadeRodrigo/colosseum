import { cn } from '../cn';

// The two halves of the MOCK mark, for the primitives only. mock-plate.md: the hatch and the word,
// together, every time; three parts, never fewer. A screen never imports this file. It uses a whole
// thing: `MockPlate` (the band and the plate), `MockFrame`, `StalePlate`, or a mocked card, row, leg
// or figure, each of which draws both halves itself. hatch.test.ts fails on an import of this file
// from outside components/ui, on a hatch with no word and on a MOCK plate with no hatch.

export const MOCK_ANNOUNCE = ': sample data, not live';

/** The 6px band of hatch: the left edge of a mocked card, row or leg label. */
export function HatchBand({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-ui="hatch-band"
      className={cn('tf-hatch block w-1.5 shrink-0 self-stretch', className)}
    />
  );
}

export type MockWordProps = {
  /** Adds the hidden sentence for screen readers. Once per panel. */
  announce?: boolean;
  /** That sentence, when it is not the default. */
  sentence?: string;
  className?: string;
};

/** The word MOCK on its solid plate, alone: only beside a hatch the same primitive draws. */
export function MockWord({ announce = false, sentence, className }: MockWordProps) {
  return (
    <span data-ui="mock-plate" className={cn('tf-mock-plate align-middle', className)}>
      MOCK{announce && <span className="sr-only">{sentence ?? MOCK_ANNOUNCE}</span>}
    </span>
  );
}
