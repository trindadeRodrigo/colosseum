'use client';
import {
  createContext,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from './cn';
import { Icon } from './Icon';
import {
  kindWords,
  PIN_CLOSE_MS,
  PIN_LABELS,
  PIN_OPEN_MS,
  type PinLabels,
  type PinSource,
  type PinState,
  pinLabel,
  pinState,
  sourceLine,
  staleWords,
} from './provenance';

export type { PinLabels, PinSource, PinState } from './provenance';

// provenance-pin.md. The tenon end with its pin, after every yield, price and FX figure. It opens
// `source · fetched_at · method`. No pin, no number: a figure with no source is not shown at all.
//
// The glyph is the logo's tenon end in line mode (LOGO-2), as provenance-pin.md and working-brand.yml
// draw it: an 18 by 12 box, 0.75em tall, an outline with 2.5 corners, and a square pin, 4 by 4 with a
// corner of 1, set toward the end (x 11, y 4): honey on night, honey-l on day. Stale is the same square
// hollow; sample is no pin and a 3px hatch.

// The hatch of the MOCK glyph: 45°, 1px strokes at a 3px pitch, cut to the inside of the outline.
// Each line is x + y = k; the middle one passes through the centre of the box.
const HATCH = [-2, -1, 0, 1, 2]
  .map((n) => 15 + n * 3 * Math.SQRT2)
  .map((k) => {
    const x1 = Math.max(1.5, k - 10.5);
    const x2 = Math.min(16.5, k - 1.5);
    const r = (v: number) => Math.round(v * 100) / 100;
    return `M${r(x1)} ${r(k - x1)}L${r(x2)} ${r(k - x2)}`;
  })
  .join('');

export type PinGlyphProps = {
  state: Exclude<PinState, 'missing'>;
  /** The pin drops in: once, when a plan locks. No travel under reduced motion. */
  drop?: boolean;
  className?: string;
};

/** The drawing alone. It is never used as an icon, and never without its button and popover. */
export function PinGlyph({ state, drop = false, className }: PinGlyphProps) {
  return (
    <svg
      data-ui="pin-glyph"
      data-state={state}
      data-hatch={state === 'mock' ? '' : undefined}
      viewBox="0 0 18 12"
      aria-hidden="true"
      className={cn('inline-block h-[0.75em] w-[1.125em] overflow-visible', className)}
    >
      <rect
        x="0.75"
        y="0.75"
        width="16.5"
        height="10.5"
        rx="2.5"
        fill="none"
        stroke="var(--tf-pin-outline)"
        strokeWidth="1.5"
      />
      {state === 'live' && (
        <rect
          x="11"
          y="4"
          width="4"
          height="4"
          rx="1"
          fill="var(--tf-pin)"
          className={drop ? 'animate-pin-drop' : undefined}
        />
      )}
      {state === 'stale' && (
        <rect
          x="11.75"
          y="4.75"
          width="2.5"
          height="2.5"
          rx="0.5"
          fill="none"
          stroke="var(--tf-pin)"
          strokeWidth="1.5"
          className={drop ? 'animate-pin-drop' : undefined}
        />
      )}
      {state === 'mock' && <path d={HATCH} fill="none" stroke="var(--tf-hatch)" strokeWidth="1" />}
    </svg>
  );
}

// Quiet pins (gate PIN-QUIET, Rodrigo, Oct 8: the little square beside every number in the portfolio
// and in the analytics "adds nothing, just pollution"). Inside a section that says so, a figure keeps
// its source, still one press or one hover away, but the figure itself is the control: no glyph is
// drawn beside it. Two things still show: a stale figure keeps its word, and a sample figure keeps its
// hatched glyph, so nothing made up ever reads as live (MOCK-QUIET). A test-network figure relies on the
// section's own "Test network" plate.

const Quiet = createContext(false);

/** Marks a section's figures as quiet: the figure is the control, with no glyph beside it. */
export function QuietPins({ children }: { children: ReactNode }) {
  return <Quiet.Provider value>{children}</Quiet.Provider>;
}

export type ProvenancePinProps = {
  /** The figure as shown, already formatted: "6.40%". */
  value: string;
  /**
   * Where the figure came from. Required: there is no way to show a figure without it. Hand it null
   * when the source is not known yet, and a dash is shown in place of the figure.
   */
  obs: PinSource | null;
  /** The figure named in the accessible name, when `value` holds more than the figure itself. */
  labelValue?: string;
  /** A second line in the popover. For a yield: the quoted rate, the rate after haircut, and the rule. */
  detail?: string;
  /** Adds a "how we measure" link to the popover, which then becomes a dialog. */
  docs?: { href: string; label: string };
  /** Open at first render. */
  defaultOpen?: boolean;
  /** The pin drops in on first reveal. */
  drop?: boolean;
  labels?: Partial<PinLabels>;
  className?: string;
};

const GAP = 8;
const EDGE = 16;

/** A figure with its pin. The figure and the glyph never wrap apart. */
export function ProvenancePin({
  value,
  obs,
  labelValue,
  detail,
  docs,
  defaultOpen = false,
  drop = false,
  labels,
  className,
}: ProvenancePinProps) {
  const text: PinLabels = {
    ...PIN_LABELS,
    ...labels,
    kinds: { ...PIN_LABELS.kinds, ...labels?.kinds },
  };
  const state = pinState(obs);
  // In a quiet section the figure is the control and no glyph is drawn, unless it is a sample.
  const quiet = useContext(Quiet) && state !== 'mock';
  const [open, setOpen] = useState(defaultOpen);
  const [pinned, setPinned] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popover = useId();

  // The popover is placed against the viewport, so a scrolling table cannot cut it off: under the
  // pin, or above it when there is no room below, and never past the edge of the screen.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const at = button.current?.getBoundingClientRect();
      const size = panel.current?.getBoundingClientRect();
      if (!at || !size) return;
      const below = at.bottom + GAP;
      const top =
        below + size.height > window.innerHeight - EDGE && at.top - GAP - size.height > EDGE
          ? at.top - GAP - size.height
          : below;
      const left = Math.max(EDGE, Math.min(at.left, window.innerWidth - size.width - EDGE));
      setPlace({ top, left });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // A press anywhere else closes it, and so does focus that moves to something else on the page.
    // Focus that goes nowhere (a press on the popover's own text, another window) leaves it open.
    // Escape closes it and gives focus back to the pin.
    const outside = (event: globalThis.PointerEvent | globalThis.FocusEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = wrap.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      setPinned(false);
      if (inside) button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (hover.current) clearTimeout(hover.current);
      if (leave.current) clearTimeout(leave.current);
      if (reset.current) clearTimeout(reset.current);
    },
    [],
  );

  if (state === 'missing' || !obs)
    return (
      <span data-ui="figure" data-state="missing" className={cn('whitespace-nowrap', className)}>
        — <span className="text-caption text-muted-foreground">{text.missing}</span>
      </span>
    );

  const line = sourceLine(obs);
  const stale = state === 'stale' ? staleWords(obs, text) : null;
  const kind = state === 'mock' ? kindWords(obs.provenance, text) : null;
  const dialog = docs !== undefined;

  function toggle() {
    const next = !(open && pinned);
    setOpen(next);
    setPinned(next);
  }
  // A mouse that rests on the pin opens it, and the popover can be hovered in turn (WCAG 1.4.13):
  // the popover is inside this element, and leaving does not close at once, so the pointer has time
  // to cross the gap between the two.
  function onPointerEnter(event: PointerEvent<HTMLSpanElement>) {
    if (event.pointerType !== 'mouse') return;
    if (leave.current) clearTimeout(leave.current);
    leave.current = null;
    if (!open) hover.current = setTimeout(() => setOpen(true), PIN_OPEN_MS);
  }
  function onPointerLeave() {
    if (hover.current) clearTimeout(hover.current);
    if (!open || pinned) return;
    leave.current = setTimeout(() => setOpen(false), PIN_CLOSE_MS);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      return; // no clipboard here: say nothing rather than claim a copy
    }
    setCopied(true);
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span
      ref={wrap}
      data-ui="figure"
      data-state={state}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // Above a card's link overlay, and above every other figure while it is open: each figure is
      // its own layer, so a later one would otherwise be painted over this one's popover.
      className={cn('relative inline-block whitespace-nowrap', open ? 'z-30' : 'z-10', className)}
    >
      {!quiet && (
        <>
          <span className="tf-figure">{value}</span>
          {' '}
        </>
      )}
      <button
        ref={button}
        type="button"
        data-ui="pin"
        aria-label={pinLabel(labelValue ?? value, obs, text)}
        aria-expanded={open}
        aria-controls={dialog && open ? popover : undefined}
        aria-describedby={!dialog && open ? popover : undefined}
        onClick={toggle}
        data-quiet={quiet ? '' : undefined}
        className={
          quiet
            ? 'cursor-help decoration-muted-foreground decoration-dotted underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
            : "relative inline-flex cursor-pointer align-baseline before:absolute before:top-1/2 before:left-1/2 before:size-6 before:-translate-1/2 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        }
      >
        {quiet ? (
          <span className="tf-figure">{value}</span>
        ) : (
          <PinGlyph state={state} drop={drop} />
        )}
      </button>
      {stale && (
        <span
          data-ui="stale-tag"
          className="ml-1.5 font-sans text-caption font-medium text-muted-foreground"
        >
          {stale}
        </span>
      )}
      {open && (
        <Popover ref={panel} id={popover} name={dialog ? text.provenance : null} place={place}>
          <button
            type="button"
            data-ui="pin-source"
            onClick={copy}
            className="flex cursor-pointer items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="min-w-0 break-words">{line}</span>
            <Icon
              name={copied ? 'Check' : 'Copy'}
              size={16}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
            <span className="sr-only">{text.copy}</span>
          </button>
          <span role="status" className="sr-only">
            {copied ? text.copied : ''}
          </span>
          {detail && <span>{detail}</span>}
          {stale && <span className="text-muted-foreground">{stale}</span>}
          {kind && <span className="text-muted-foreground">{kind}</span>}
          {docs && (
            <a
              href={docs.href}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {docs.label}
              <Icon name="ArrowUpRight" size={16} />
            </a>
          )}
        </Popover>
      )}
    </span>
  );
}

type PopoverProps = {
  ref: Ref<HTMLSpanElement>;
  id: string;
  /** With a name it is a dialog (it holds a link); without, a tooltip that describes the pin. */
  name: string | null;
  place: { top: number; left: number } | null;
  children: ReactNode;
};

function Popover({ ref, id, name, place, children }: PopoverProps) {
  const shared = {
    ref,
    id,
    'data-ui': 'pin-popover',
    style: place ? ({ position: 'fixed', top: place.top, left: place.left } as const) : undefined,
    className: cn(
      'z-20 flex w-max max-w-[min(44ch,calc(100vw-2rem))] flex-col items-start gap-1 rounded-md border border-border bg-popover shadow-popover px-3 py-2 text-left font-mono text-source font-normal whitespace-normal text-popover-foreground',
      // The 8px between the pin and the popover belong to the popover, on whichever side the pin is.
      "before:absolute before:inset-x-0 before:-top-2 before:h-2 before:content-[''] after:absolute after:inset-x-0 after:-bottom-2 after:h-2 after:content-['']",
      !place && 'absolute top-full left-0 mt-2',
    ),
  };
  return name === null ? (
    <span {...shared} role="tooltip">
      {children}
    </span>
  ) : (
    <span {...shared} role="dialog" aria-label={name}>
      {children}
    </span>
  );
}
