import type { MixLine, MixReview } from '@colosseum/schemas';

// The arithmetic of a mix the person edits or takes from a conversation, before the server checks it
// again (gate ANY-COMPOSITION, #191). A vault holds at most 16 assets besides cash; the cash token is
// never a line of its own here: it is what the other lines leave, as the vault holds it. Weights are
// whole basis points; the person may type whole percents or basis points.

export const WHOLE_BPS = 10_000;
export const MAX_LINES = 16;

export type EditorLine = { assetId: string; weightBps: number };
export type WeightUnit = 'percent' | 'bps';

/** Why the edited mix cannot be reviewed yet. Each says what to change, never what is wrong. */
export type EditorIssue =
  /** More than 16 assets besides cash. */
  | 'too-many'
  /** The same asset twice. */
  | 'duplicate'
  /** The chain's cash token as a line: cash is what the others leave. */
  | 'cash-line'
  /** A weight that is not a whole number of basis points from 0 to 10,000. */
  | 'not-whole'
  /** The lines add up to more than the whole. */
  | 'over-whole'
  /** Nothing but cash: an open vault keeps at least one asset of its own. */
  | 'all-cash';

/**
 * A typed weight in basis points, or null when it does not read as one. Percents may carry up to two
 * decimals ("12.5" is 1250); basis points are whole. A comma reads as the decimal mark.
 */
export function bpsOf(text: string, unit: WeightUnit): number | null {
  const typed = text.trim().replace(',', '.');
  if (typed === '') return 0;
  if (unit === 'bps') {
    if (!/^\d+$/.test(typed)) return null;
    const bps = Number(typed);
    return bps <= WHOLE_BPS ? bps : null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return null;
  const bps = Math.round(Number(typed) * 100);
  return bps <= WHOLE_BPS ? bps : null;
}

/** A weight as the person types it back: "12.5" for 1250 bps in percents, "1250" in basis points. */
export function textOf(bps: number, unit: WeightUnit): string {
  return unit === 'bps' ? String(bps) : String(bps / 100);
}

/** What the lines leave in cash, in basis points. Below zero when they add up to more than the whole. */
export function cashLeft(lines: readonly EditorLine[]): number {
  return WHOLE_BPS - lines.reduce((sum, line) => sum + line.weightBps, 0);
}

/** Everything that keeps the edited mix from review, in the order a person would fix it. */
export function editorIssues(lines: readonly EditorLine[], cash: string): EditorIssue[] {
  const issues: EditorIssue[] = [];
  const held = lines.filter((line) => line.weightBps > 0);
  if (held.length > MAX_LINES) issues.push('too-many');
  if (new Set(lines.map((line) => line.assetId)).size !== lines.length) issues.push('duplicate');
  if (lines.some((line) => line.assetId === cash)) issues.push('cash-line');
  if (
    lines.some(
      (line) =>
        !Number.isInteger(line.weightBps) || line.weightBps < 0 || line.weightBps > WHOLE_BPS,
    )
  )
    issues.push('not-whole');
  if (cashLeft(lines) < 0) issues.push('over-whole');
  if (held.length === 0) issues.push('all-cash');
  return issues;
}

/**
 * The lines the server is sent: each asset with a weight, then the cash it leaves as the chain's
 * cash token, so they add up to exactly 10,000. A line at zero is left out: it is not held.
 */
export function mixOf(lines: readonly EditorLine[], cash: string): MixLine[] {
  const held = lines.filter((line) => line.weightBps > 0);
  const left = cashLeft(held);
  return [
    ...held.map(({ assetId, weightBps }) => ({ assetId, weightBps })),
    ...(left > 0 ? [{ assetId: cash, weightBps: left }] : []),
  ];
}

/** The same assets at the same weights, whatever their order; a line at zero is not held. */
export function sameMix(a: readonly EditorLine[], b: readonly EditorLine[]): boolean {
  const text = (lines: readonly EditorLine[]) =>
    lines
      .filter((line) => line.weightBps > 0)
      .map((line) => `${line.assetId}=${line.weightBps}`)
      .sort()
      .join(' ');
  return text(a) === text(b);
}

/** The warnings of a review the person has not ticked yet. */
export function unticked(review: MixReview, ticked: ReadonlySet<string>): string[] {
  return review.warnings.map((warning) => warning.id).filter((id) => !ticked.has(id));
}

/**
 * The ticks a confirm sends: only ids of this review's warnings, each once. A tick kept from an
 * earlier review that no longer has that warning is not sent.
 */
export function acceptedOf(review: MixReview, ticked: ReadonlySet<string>): string[] {
  return review.warnings.map((warning) => warning.id).filter((id) => ticked.has(id));
}

/** The review can be confirmed: every warning ticked, and a hash to send back. */
export function confirmable(review: MixReview, ticked: ReadonlySet<string>): boolean {
  return unticked(review, ticked).length === 0 && /^[0-9a-f]{64}$/.test(review.reviewHash);
}
