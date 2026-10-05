import type { ReactNode } from 'react';
import { cn } from './cn';
import { formatAge } from './format';
import { HatchBand, MOCK_ANNOUNCE, MockWord } from './internal/mock-parts';

// mock-plate.md. MOCK is the hatch and the word, together, every time: a band of 45° hatch beside a
// solid plate that says MOCK. Text never sits on the hatch. The plate is not interactive and has no
// states. Everything exported here is whole: there is no plate without its hatch and no hatch without
// its word. The `code` placement (an API docs example) is not built: the API serves its own docs.

export type MockPlateLabels = {
  /** Read once per panel by a screen reader, after the word MOCK. */
  announce: string;
  /** The word on a stale plate. */
  stale: string;
  /** In place of the age on a stale plate, when the age handed over is not one. */
  ageUnknown: string;
};
export const MOCK_PLATE_LABELS: MockPlateLabels = {
  announce: MOCK_ANNOUNCE,
  stale: 'stale',
  ageUnknown: 'age unknown',
};

export type MockPlateProps = {
  /** The hidden sentence for screen readers. Once per panel: pass false on a second plate in it. */
  announce?: boolean;
  labels?: Partial<MockPlateLabels>;
  className?: string;
};

/**
 * The 6px hatch band and, beside it, the word MOCK on its solid plate: for a pane header, a source
 * line, anywhere a screen has to say that what is beside it is not live. There is no way to make it
 * say anything else, and no way to have the plate without the band.
 */
export function MockPlate({ announce = true, labels, className }: MockPlateProps) {
  return (
    <span
      data-ui="mock-plate"
      className={cn('inline-flex h-5 items-stretch gap-1.5 align-middle', className)}
    >
      <HatchBand />
      <span className="tf-mock-plate">
        MOCK
        {announce && (
          <span className="sr-only">{labels?.announce ?? MOCK_PLATE_LABELS.announce}</span>
        )}
      </span>
    </span>
  );
}

export type MockFrameProps = {
  /** What the panel is, at the left of its header. The plate sits at the right. */
  heading?: ReactNode;
  children: ReactNode;
  labels?: Partial<MockPlateLabels>;
  className?: string;
};

/**
 * A whole mocked panel: a hairline frame, 8px of hatch as its margin, and a solid surface inside
 * that carries everything, with the plate in its header.
 */
export function MockFrame({ heading, children, labels, className }: MockFrameProps) {
  return (
    <div data-ui="mock-frame" className={cn('tf-hatch border border-border p-2', className)}>
      <div className="bg-card text-card-foreground">
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0 text-h4 font-semibold">{heading}</div>
          <MockWord announce sentence={labels?.announce} />
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export type StalePlateProps = {
  /** How old the data is, in seconds, as the API states it. */
  ageSec: number;
  labels?: Partial<MockPlateLabels>;
  className?: string;
};

/** A stale panel or tile: the same band, with a plate that says how stale. A figure uses the hollow pin instead. */
export function StalePlate({ ageSec, labels, className }: StalePlateProps) {
  return (
    <span
      data-ui="stale-plate"
      className={cn('inline-flex h-5 items-stretch gap-1.5 align-middle', className)}
    >
      <HatchBand />
      <span className="tf-stale-plate">
        {labels?.stale ?? MOCK_PLATE_LABELS.stale} ·{' '}
        {formatAge(ageSec)?.short ?? labels?.ageUnknown ?? MOCK_PLATE_LABELS.ageUnknown}
      </span>
    </span>
  );
}
