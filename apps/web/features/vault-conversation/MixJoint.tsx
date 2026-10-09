'use client';
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { AssetMark } from '../order/PlanView';

// A proposed mix drawn as one joint (plan-leg.md, "The mix joint"): a beam of pieces laid end to end,
// one per asset and as wide as its share, each seated in the one before it by a tenon. It is the plan
// pane's thick bar and its wood ramp, made into the brand's joint, and it lies flat because a mix has
// up to seventeen parts: the landing's standing post (PlanDrawing) is drawn for four, and at this
// width its layers and labels would run into each other.
//
// The pieces are where they belong from the first frame. What moves is paint (transform and opacity),
// so nothing below the beam shifts: a new mix assembles piece by piece, each sliding its tenon home,
// and a changed mix moves only what changed. Every share is read in the row under the beam, which
// shows its final figure at once; the beam never says a number.

/** The wood ramp, in the order the pieces come. A fifth piece takes the first again. */
const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;
/** The colour of the piece at a place in the mix: the row under the beam carries the same swatch. */
export const fillOf = (index: number) => FILL[index % FILL.length] as string;

/** The narrowest a piece is drawn, in percent of the beam: a sliver still shows and can be pointed at. */
const NARROWEST = 3;
/** The narrowest piece with room for its asset's mark (24px, on a phone's beam). */
const MARKED = 12;
/** The narrowest piece that carries a tenon, or takes one: in a sliver a tenon is all there would be. */
const TENONED = 7;
/** A piece slides in after it has faded in apart (STYLE.md, plan-lock): 160ms, then 320ms. */
export const SEAT_MS = 480;

export type JointShare = { key: string; bps: number };
export type JointSlot = JointShare & { index: number; left: number; width: number };
export type JointMotion =
  | { kind: 'still' }
  | { kind: 'arrive' }
  | { kind: 'change'; from: ReadonlyMap<string, JointSlot>; gone: readonly JointSlot[] };

/**
 * Where each piece lies, in percent of the beam. A piece is as wide as its share, except that a very
 * small one is drawn at the narrowest width and the others give up the room in proportion.
 */
export function jointLayout(shares: readonly JointShare[]): JointSlot[] {
  if (shares.length === 0) return [];
  const total = shares.reduce((sum, s) => sum + s.bps, 0);
  const floor = Math.min(NARROWEST, 60 / shares.length);
  const raw = shares.map((s) => (s.bps / total) * 100);
  const small = new Set<number>();
  for (;;) {
    const room = 100 - small.size * floor;
    const rest = raw.reduce((sum, w, i) => (small.has(i) ? sum : sum + w), 0);
    const before = small.size;
    raw.forEach((w, i) => {
      if (!small.has(i) && (w * room) / rest < floor) small.add(i);
    });
    if (small.size !== before) continue;
    let left = 0;
    return shares.map((s, index) => {
      const width = small.has(index) ? floor : ((raw[index] ?? 0) * room) / rest;
      const slot = { ...s, index, left, width };
      left += width;
      return slot;
    });
  }
}

/** The pause between one piece and the next, so that any number of pieces is seated within 0.9s. */
export const staggerMs = (pieces: number) => (pieces > 1 ? Math.min(60, 420 / (pieces - 1)) : 0);

/**
 * What moves when one mix follows another: nothing if the shares are the same, the difference if they
 * share a piece, and the whole assembly if they share none.
 */
export function jointMotion(
  before: readonly JointShare[],
  after: readonly JointShare[],
): JointMotion {
  if (
    before.length === after.length &&
    before.every((s, i) => s.key === after[i]?.key && s.bps === after[i]?.bps)
  )
    return { kind: 'still' };
  const kept = new Set(after.map((s) => s.key));
  const old = jointLayout(before);
  if (!old.some((slot) => kept.has(slot.key))) return { kind: 'arrive' };
  return {
    kind: 'change',
    from: new Map(old.map((slot) => [slot.key, slot])),
    gone: old.filter((slot) => !kept.has(slot.key)),
  };
}

const vars = (values: Record<string, string>) => values as CSSProperties;

export type JointPiece = JointShare & {
  /** The asset's name as its row says it. */
  name: string;
  /** The share as its row shows it: the piece is named with it, and never shows another figure. */
  share: string;
};

export function MixJoint({
  pieces,
  label,
  hint,
  lit,
  onLit,
  motion,
  run,
}: {
  pieces: readonly JointPiece[];
  /** What the drawing is, for a reader who cannot see it. */
  label: string;
  /** Under the beam while no piece is pointed at: how to read it. */
  hint: string;
  /** The key of the piece that is pointed at, here or in its row. */
  lit: string | null;
  onLit: (key: string | null) => void;
  motion: JointMotion;
  /** Counts the mixes shown: a new one starts its motion afresh. */
  run: number;
}) {
  const beam = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // the piece the arrow keys stand on: the beam is one tab stop
  const [at, setAt] = useState(0);
  const slots = jointLayout(pieces);
  const stagger = staggerMs(pieces.length);
  const stand = Math.min(at, pieces.length - 1);
  // a tap anywhere but on a piece or a row lets the lit piece go
  useEffect(() => {
    if (lit === null) return;
    const away = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-part="piece"], [data-row]')) return;
      onLit(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [lit, onLit]);
  const go = (i: number) => {
    const next = Math.max(0, Math.min(pieces.length - 1, i));
    setAt(next);
    buttons.current[next]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = (
      { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>
    )[e.key];
    if (step !== undefined) {
      e.preventDefault();
      go(i + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(pieces.length - 1);
    } else if (e.key === 'Escape') onLit(null);
  };
  const shown = pieces.find((p) => p.key === lit);
  const shownAt = pieces.findIndex((p) => p.key === lit);
  return (
    <div data-ui="mix-joint" data-motion={motion.kind} className="flex min-w-0 flex-col gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a drawing's pieces are a group, not a form's fieldset */}
      <div ref={beam} role="group" aria-label={label} className="@container relative h-11">
        {motion.kind === 'change' &&
          motion.gone.map((slot) => (
            // a piece the new mix dropped: it fades where it lay while the others close over it
            <span
              key={`${run}:${slot.key}`}
              aria-hidden="true"
              data-part="ghost"
              style={{ left: `${slot.left}%`, width: `${slot.width}%` }}
              className={cn(
                'tf-joint-leave pointer-events-none absolute inset-y-0',
                fillOf(slot.index),
              )}
            />
          ))}
        {pieces.map((piece, i) => {
          const slot = slots[i];
          if (!slot) return null;
          const on = lit === piece.key;
          const from = motion.kind === 'change' ? motion.from.get(piece.key) : undefined;
          // a piece that was not there comes in as on arrival; one that was slides and resizes
          const enters = motion.kind === 'arrive' || (motion.kind === 'change' && !from);
          const dx = from ? from.left - slot.left : 0;
          const sx = from ? from.width / slot.width : 1;
          return (
            <button
              key={piece.key}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              data-part="piece"
              data-asset={piece.key}
              data-lit={on}
              aria-pressed={on}
              aria-label={`${piece.name}, ${piece.share}`}
              tabIndex={i === stand ? 0 : -1}
              onFocus={() => {
                setAt(i);
                onLit(piece.key);
              }}
              onBlur={(e) => {
                if (!beam.current?.contains(e.relatedTarget as Node | null)) onLit(null);
              }}
              onKeyDown={(e) => onKey(e, i)}
              onClick={(e) => {
                // the keyboard's press: a pointer has already said what it points at
                if (e.detail === 0) onLit(on ? null : piece.key);
              }}
              onPointerEnter={(e) => e.pointerType === 'mouse' && onLit(piece.key)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && onLit(null)}
              onPointerUp={(e) => {
                // a finger or a pen: a tap picks the piece, a second tap lets it go
                if (e.pointerType !== 'mouse') onLit(on ? null : piece.key);
              }}
              style={{ left: `${slot.left}%`, width: `${slot.width}%` }}
              className={cn(
                'absolute inset-y-0 cursor-pointer motion-safe:transition-[translate,opacity] motion-safe:duration-(--tf-dur-fade) motion-safe:ease-seat',
                on && '-translate-y-1 motion-reduce:translate-y-0',
                lit !== null && !on && 'opacity-45',
              )}
            >
              <span
                // a new mix starts this piece's motion afresh; the button, and its focus, stay
                key={run}
                data-part="body"
                style={vars(
                  enters
                    ? {
                        '--tf-joint-delay': `${motion.kind === 'arrive' ? Math.round(i * stagger) : 160}ms`,
                      }
                    : { '--tf-joint-x': `${dx}cqw` },
                )}
                className={cn(
                  'absolute inset-0 flex items-center justify-center',
                  enters && 'tf-joint-arrive',
                  from && Math.abs(dx) > 0.01 && 'tf-joint-move',
                )}
              >
                <span
                  data-part="fill"
                  style={vars({ '--tf-joint-sx': String(sx) })}
                  className={cn(
                    'absolute inset-y-0 right-0 origin-left',
                    i > 0 ? 'left-0.5' : 'left-0',
                    fillOf(i),
                    from && Math.abs(sx - 1) > 0.001 && 'tf-joint-size',
                  )}
                />
                {slot.width >= TENONED && (slots[i - 1]?.width ?? 0) >= TENONED && (
                  // its tenon, seated in the piece before it: the joint line runs round it
                  <span
                    data-part="tenon"
                    className={cn(
                      'absolute top-[30%] -left-2 h-[40%] w-2.5 border-y-2 border-l-2 border-card',
                      fillOf(i),
                    )}
                  />
                )}
                {slot.width >= MARKED && (
                  <span
                    style={vars({
                      '--tf-joint-x': `${from ? (from.width - slot.width) / 2 : 0}cqw`,
                    })}
                    className={cn('relative flex', from && 'tf-joint-move')}
                  >
                    <AssetMark asset={piece.key} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {/* The piece pointed at, said beside the beam: its row may be a long way down a phone. It keeps
          its one line whether a piece is lit or not, and a reader hears each piece by its own name. */}
      <p
        aria-hidden="true"
        data-ui="mix-joint-readout"
        className="flex h-5 min-w-0 items-center gap-2 text-caption text-muted-foreground"
      >
        {shown ? (
          <>
            <span className={cn('size-2.5 shrink-0', fillOf(shownAt))} />
            <span className="min-w-0 truncate font-medium text-foreground">{shown.name}</span>
            <span className="shrink-0 tabular-nums">{shown.share}</span>
          </>
        ) : (
          <span className="min-w-0 truncate">{hint}</span>
        )}
      </p>
    </div>
  );
}
