import { cn } from '../cn';

// The parts of the sample mark, for the primitives only (gate MOCK-QUIET, Thom, Oct 6, in place of
// the boxed word MOCK beside every figure). A sample card keeps its hatched edge and says so once, in
// a quiet line; a sample figure keeps a small hatched glyph with a name for screen readers. A screen
// never imports this file: it uses a whole thing (`MockPlate`, `MockFrame`, a mocked card, row, leg
// or figure), each of which draws both halves itself. hatch.test.ts fails on an import of this file
// from outside components/ui, and on a hatch with nothing that says it is sample.

/** The card's line, when a screen hands none. */
export const SAMPLE_LINE = 'Sample figures';
/** A sample glyph's name for a screen reader, when a screen hands none. */
export const SAMPLE_FIGURE = 'sample figure';
/** Kept for the screens that still hand it: the card's line. */
export const MOCK_ANNOUNCE = SAMPLE_LINE;

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
  /** Gives the glyph its name for screen readers. Once per panel: false on a second glyph in it. */
  announce?: boolean;
  /** That name, when it is not the default ("sample figure"). */
  sentence?: string;
  className?: string;
};

/**
 * The small hatched square that marks a sample figure, row or leg: no word on the page, a name for a
 * screen reader. It replaces the boxed word MOCK (MOCK-QUIET).
 */
export function MockWord({ announce = true, sentence, className }: MockWordProps) {
  return (
    <span
      data-ui="sample-glyph"
      {...(announce
        ? { role: 'img', 'aria-label': sentence ?? SAMPLE_FIGURE }
        : { 'aria-hidden': true })}
      className={cn(
        'tf-hatch inline-block size-2.5 shrink-0 border border-border align-middle',
        className,
      )}
    />
  );
}

/** A sample card's one quiet line: "Sample figures · test network", muted, with no box. */
export function SampleNote({
  line,
  note,
  className,
}: {
  line?: string;
  /** After the line: "test network". */
  note?: string;
  className?: string;
}) {
  return (
    <p data-ui="sample-note" className={cn('text-caption text-muted-foreground', className)}>
      {line ?? SAMPLE_LINE}
      {note ? ` · ${note}` : ''}
    </p>
  );
}
