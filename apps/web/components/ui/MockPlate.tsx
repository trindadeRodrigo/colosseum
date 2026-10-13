import type { ReactNode } from 'react';
import { cn } from './cn';
import { formatAge } from './format';
import {
  HatchBand,
  MOCK_ANNOUNCE,
  MockWord,
  SAMPLE_FIGURE,
  SampleNote,
} from './internal/mock-parts';

// mock-plate.md, as MOCK-QUIET (Thom, Oct 6) changed it: sample is never shown as live, and never by
// a boxed word beside each figure. A sample thing beside a name or a figure is a small hatched glyph
// with a name for screen readers; a sample panel keeps its hatch and says so once, in a quiet line.
// Text never sits on the hatch. The `code` placement (an API docs example) is not built.

export type MockPlateLabels = {
  /** A panel's quiet line ("Sample figures"); a glyph's name is `figure`. */
  announce: string;
  /** A glyph's name for a screen reader: "sample figure". */
  figure: string;
  /** The word on a stale plate. */
  stale: string;
  /** In place of the age on a stale plate, when the age handed over is not one. */
  ageUnknown: string;
};
export const MOCK_PLATE_LABELS: MockPlateLabels = {
  announce: MOCK_ANNOUNCE,
  figure: SAMPLE_FIGURE,
  stale: 'stale',
  ageUnknown: 'age unknown',
};

export type MockPlateProps = {
  /** Gives the glyph its name for screen readers. Once per panel: false on a second one in it. */
  announce?: boolean;
  labels?: Partial<MockPlateLabels>;
  className?: string;
};

/**
 * The small hatched glyph that says what is beside it is sample, not live: for a pane header, a
 * source line, a chain's name. No word on the page; its name is read by a screen reader.
 */
export function MockPlate({ announce = true, labels, className }: MockPlateProps) {
  return (
    <span data-ui="mock-plate" className={cn('inline-flex items-center align-middle', className)}>
      <MockWord announce={announce} sentence={labels?.figure ?? MOCK_PLATE_LABELS.figure} />
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
 * that carries everything, with the quiet line in its header.
 */
export function MockFrame({ heading, children, labels, className }: MockFrameProps) {
  return (
    <div data-ui="mock-frame" className={cn('tf-hatch border border-border p-2', className)}>
      <div className="bg-card text-card-foreground">
        <div className="flex items-baseline justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0 text-h4 font-semibold">{heading}</div>
          <SampleNote line={labels?.announce} />
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
