import type { ReactNode } from 'react';
import { cn } from './cn';
import { formatAge } from './format';

// mock-plate.md. MOCK is the hatch and the word, together, every time: a band of 45° hatch beside a
// solid plate that says MOCK. Text never sits on the hatch. The plate is not interactive and has no
// states. The `code` placement (an API docs example) is not built: the API serves its own docs.

export type MockPlateLabels = {
  /** Read once per panel by a screen reader, after the word MOCK. */
  announce: string;
  /** The word on a stale plate. */
  stale: string;
};
export const MOCK_PLATE_LABELS: MockPlateLabels = {
  announce: ': sample data, not live',
  stale: 'stale',
};

/** The 6px band of hatch: the left edge of a mocked card, row or leg label. Never without a plate. */
export function HatchBand({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-ui="hatch-band"
      className={cn('tf-hatch block w-1.5 shrink-0 self-stretch', className)}
    />
  );
}

export type MockPlateProps = {
  /**
   * `inline`: the plate alone, after a figure and its hatched pin.
   * `badge`: the hatch band, then the plate: a card or pane header.
   */
  placement?: 'inline' | 'badge';
  /** Adds the hidden sentence for screen readers. Once per panel; a `badge` has it unless told not to. */
  announce?: boolean;
  labels?: Partial<MockPlateLabels>;
  className?: string;
};

/** The word MOCK on its solid plate. There is no way to make it say anything else. */
export function MockPlate({ placement = 'inline', announce, labels, className }: MockPlateProps) {
  const say = announce ?? placement === 'badge';
  const hidden = say && (
    <span className="sr-only">{labels?.announce ?? MOCK_PLATE_LABELS.announce}</span>
  );
  if (placement === 'inline')
    return (
      <span data-ui="mock-plate" className={cn('tf-mock-plate align-middle', className)}>
        MOCK{hidden}
      </span>
    );
  return (
    <span
      data-ui="mock-plate"
      className={cn('inline-flex h-5 items-stretch gap-1.5 align-middle', className)}
    >
      <HatchBand />
      <span className="tf-mock-plate">MOCK{hidden}</span>
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
          <MockPlate announce labels={labels} />
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
        {labels?.stale ?? MOCK_PLATE_LABELS.stale} · {formatAge(ageSec).short}
      </span>
    </span>
  );
}
