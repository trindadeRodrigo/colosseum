'use client';
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from './cn';
import { isoUtc, shorten } from './format';
import { HoverPanel } from './Hint';
import { useHoverCard } from './hover-card';
import { Icon } from './Icon';
import {
  PIN_LABELS,
  type PinLabels,
  type PinSource,
  type PinState,
  pinLabel,
  pinState,
  pinWords,
  sourceLine,
  staleWords,
} from './provenance';
import { exactTime, pieces } from './source-words';

export type { PinLabels, PinSource, PinState } from './provenance';

// provenance-pin.md. The tenon end with its pin, after every yield, price and FX figure. It opens the
// figure's source: first in plain words (what the number is, where it comes from, how fresh it is and
// whether it is live), and one step further, under "Details", the API's own `source`, `fetched_at`
// and `method` (gate TOOLTIP-WORDS). No pin, no number: a figure with no source is not shown at all.
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
  /**
   * What kind of number this is, said first in the popover: "Price", "Value", "Exit cost". Left out,
   * the popover starts at "From": a source does not say what was made of it.
   */
  what?: string;
  /** A further line in the popover. For a yield: the quoted rate, the rate after haircut, and the rule. */
  detail?: string;
  /** Adds a "how we measure" link to the popover. */
  docs?: { href: string; label: string };
  /** Open at first render. */
  defaultOpen?: boolean;
  /** The pin drops in on first reveal. */
  drop?: boolean;
  labels?: Partial<PinLabels>;
  className?: string;
};

/** A figure with its pin. The figure and the glyph never wrap apart. */
export function ProvenancePin({
  value,
  obs,
  labelValue,
  what,
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
  const card = useHoverCard(defaultOpen);
  const popover = useId();
  const summary = useId();
  const { open } = card;

  if (state === 'missing' || !obs)
    return (
      <span data-ui="figure" data-state="missing" className={cn('whitespace-nowrap', className)}>
        — <span className="text-caption text-muted-foreground">{text.missing}</span>
      </span>
    );

  const stale = state === 'stale' ? staleWords(obs, text) : null;

  return (
    <span
      ref={card.wrap.ref}
      data-ui="figure"
      data-state={state}
      onPointerEnter={card.wrap.onPointerEnter}
      onPointerLeave={card.wrap.onPointerLeave}
      onPointerDown={card.wrap.onPointerDown}
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
        ref={card.trigger.ref as Ref<HTMLButtonElement>}
        type="button"
        data-ui="pin"
        aria-label={pinLabel(labelValue ?? value, obs, text)}
        aria-expanded={open}
        aria-controls={open ? popover : undefined}
        aria-describedby={open ? summary : undefined}
        onClick={card.trigger.onClick}
        onFocus={card.trigger.onFocus}
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
        <HoverPanel
          ref={card.panel}
          id={popover}
          place={card.place}
          name={text.provenance}
          data-ui="pin-popover"
        >
          <PinFacts
            obs={obs}
            what={what}
            detail={detail}
            docs={docs}
            text={text}
            summaryId={summary}
          />
        </HoverPanel>
      )}
    </span>
  );
}

const LINK =
  'inline-flex cursor-pointer items-center gap-1 text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type PinFactsProps = {
  obs: PinSource;
  what?: string;
  detail?: string;
  docs?: { href: string; label: string };
  text: PinLabels;
  summaryId: string;
};

/**
 * What the popover holds. First the sentences a person reads: what the number is and where it comes
 * from, how fresh it is, whether it is live; a stale reading says so before anything else. Then
 * "Details", closed until asked for: the API's own source, time and method, with every address
 * shortened in the middle and its own copy button. Mounted only while the popover is open, so the
 * details are closed again the next time, and the clock is read then and not on the server.
 */
function PinFacts({ obs, what, detail, docs, text, summaryId }: PinFactsProps) {
  const [more, setMore] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const facts = useId();
  useEffect(() => {
    setNow(Date.now());
    return () => {
      if (reset.current) clearTimeout(reset.current);
    };
  }, []);

  const words = pinWords(obs, text, { what, now });
  const iso = isoUtc(obs.fetchedAt) ?? obs.fetchedAt;

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // No clipboard here (a frame without the permission, a page not on https): claim no copy,
      // say so in sight, and open the details, where the whole line is to select.
      setCopied(null);
      setFailed(true);
      setMore(true);
      return;
    }
    setFailed(false);
    setCopied(value);
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(null), 1500);
  }

  // The API's words, with each address shortened in the middle, in the mono face, beside its copy
  // button and, where the screen knows the explorer, its page there.
  const said = (value: string) =>
    pieces(value).map((piece) =>
      piece.address ? (
        <span
          key={piece.at}
          data-ui="pin-address"
          className="inline-flex items-baseline gap-1 whitespace-nowrap"
        >
          <span className="font-mono text-source">{shorten(piece.text)}</span>
          <button
            type="button"
            data-ui="pin-copy-address"
            aria-label={text.copyAddress.replace('{address}', shorten(piece.text))}
            onClick={() => copy(piece.text)}
            className="inline-flex size-6 cursor-pointer items-center justify-center self-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Icon name={copied === piece.text ? 'Check' : 'Copy'} size={16} />
          </button>
          {obs.explorer?.includes('{address}') && (
            <a
              data-ui="pin-explorer"
              href={obs.explorer.replace('{address}', encodeURIComponent(piece.text))}
              target="_blank"
              rel="noopener"
              aria-label={text.explorer.replace('{address}', shorten(piece.text))}
              className="inline-flex size-6 items-center justify-center self-center rounded-sm text-honey-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Icon name="ArrowUpRight" size={16} />
            </a>
          )}
        </span>
      ) : (
        <span key={piece.at}>{piece.text}</span>
      ),
    );
  const row = (label: string, children: ReactNode) => (
    <span className="flex flex-col">
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="break-words">{children}</span>
    </span>
  );

  return (
    <>
      <span id={summaryId} data-ui="pin-summary" className="flex flex-col">
        {words.lines.map((line, i) => (
          <span
            key={line.key}
            data-ui={`pin-${line.key}`}
            className={i === 0 ? 'font-medium' : 'text-muted-foreground'}
          >
            {/* the read's own time is on the words that say when it was read, and on no others */}
            {line.key === 'read' ? <time dateTime={iso}>{line.text}</time> : line.text}
          </span>
        ))}
        {detail && (
          <span data-ui="pin-detail" className="text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      <button
        type="button"
        data-ui="pin-details"
        aria-expanded={more}
        aria-controls={more ? facts : undefined}
        onClick={() => setMore((was) => !was)}
        className={LINK}
      >
        {text.details}
        <Icon name="ChevronDown" size={16} className={more ? 'rotate-180' : undefined} />
      </button>
      {more && (
        <span
          id={facts}
          data-ui="pin-source"
          className="flex w-full flex-col gap-2 border-t border-border pt-2"
        >
          {row(text.sourceLabel, said(obs.source))}
          {row(text.timeLabel, <time dateTime={iso}>{exactTime(iso)}</time>)}
          {row(text.methodLabel, said(obs.method))}
          <button
            type="button"
            data-ui="pin-copy"
            onClick={() => copy(sourceLine(obs))}
            className={cn(LINK, 'self-start')}
          >
            <Icon name={copied === sourceLine(obs) ? 'Check' : 'Copy'} size={16} />
            {text.copy}
          </button>
          {failed && (
            <span data-ui="pin-copy-failed" role="status" className="text-caption">
              {text.copyFailed}
            </span>
          )}
          {/* The line as the API wrote it, whole: every address in full, to read and to select
              where there is no clipboard. The one place the popover sets words in the mono face. */}
          <span
            data-ui="pin-line"
            className="w-full font-mono text-caption tracking-normal break-all text-muted-foreground select-all"
          >
            {sourceLine(obs)}
          </span>
        </span>
      )}
      <span data-ui="pin-copied" role="status" className="sr-only">
        {copied ? text.copied : ''}
      </span>
      {docs && (
        <a href={docs.href} target="_blank" rel="noopener" className={LINK}>
          {docs.label}
          <Icon name="ArrowUpRight" size={16} />
        </a>
      )}
    </>
  );
}
