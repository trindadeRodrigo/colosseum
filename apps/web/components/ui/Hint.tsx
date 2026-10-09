'use client';
import {
  type CSSProperties,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
} from 'react';
import { cn } from './cn';
import { type Place, useHoverCard } from './hover-card';

// The one tooltip (gate TOOLTIP-WORDS). Everything that says more about a thing on hover goes through
// it: the provenance pin's popover and every plain hint. It opens when a mouse rests on its trigger,
// when the keyboard brings focus to it, and on a tap; Escape closes it; it stays open while the
// pointer is inside it, so what it holds can be reached (WCAG 1.4.13). It is placed against the
// viewport, so a scrolling table cannot cut it off: under its trigger, or above when there is no
// room below, never over the trigger and never past the edge of the screen. It takes no room in the
// page, so nothing moves when it opens. It fades in, and does not under reduced motion.

export type HoverPanelProps = {
  ref: Ref<HTMLSpanElement>;
  id: string;
  place: Place | null;
  /** With a name it is a dialog (it holds controls); without, a tooltip that describes its trigger. */
  name?: string | null;
  'data-ui'?: string;
  className?: string;
  children: ReactNode;
};

/** The panel of the one tooltip: the popover surface, placed by `useHoverCard`. */
export function HoverPanel({
  ref,
  id,
  place,
  name = null,
  className,
  children,
  ...rest
}: HoverPanelProps) {
  const style: CSSProperties | undefined = place
    ? { position: 'fixed', top: place.top, left: place.left, maxHeight: place.maxHeight }
    : undefined;
  const shared = {
    ref,
    id,
    'data-ui': rest['data-ui'] ?? 'hint-panel',
    'data-side': place?.side,
    style,
    className: cn(
      'z-20 flex w-max max-w-[min(21rem,calc(100vw-2rem))] flex-col items-start gap-1 overflow-y-auto rounded-md border border-border bg-popover shadow-popover px-3 py-2 text-left font-sans text-body-sm font-normal tracking-normal normal-case whitespace-normal text-popover-foreground motion-safe:animate-crossfade',
      // The 8px between the trigger and the panel belong to the panel, on whichever side it is.
      "before:absolute before:inset-x-0 before:-top-2 before:h-2 before:content-[''] after:absolute after:inset-x-0 after:-bottom-2 after:h-2 after:content-['']",
      !place && 'absolute top-full left-0 mt-2',
      className,
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

export type HintProps = {
  /** What the tooltip says: a sentence, in plain words. Nothing essential: that stays on the page. */
  tip: ReactNode;
  /**
   * What it is about. A link or a button is the trigger itself and is handed the tooltip's id; plain
   * text is wrapped in a button, so the keyboard and a finger reach the tooltip too.
   */
  children: ReactNode;
  /** The trigger's accessible name, when its text is not one (a shortened address). */
  label?: string;
  /** Open at first render. */
  defaultOpen?: boolean;
  className?: string;
  /** On the button that plain text is wrapped in: `truncate`, where the text is cut to fit. */
  triggerClassName?: string;
};

type Described = { 'aria-describedby'?: string };

const interactive = (node: ReactNode): node is ReactElement<Described> =>
  isValidElement(node) &&
  (node.type === 'a' || node.type === 'button' || typeof node.type !== 'string');

/** A plain tooltip on a word, a shortened address or an icon button. */
export function Hint({
  tip,
  children,
  label,
  defaultOpen = false,
  className,
  triggerClassName,
}: HintProps) {
  const card = useHoverCard(defaultOpen);
  const id = useId();
  const own = interactive(children);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only listens for its own trigger's focus and pointer; the trigger is the control
    <span
      data-ui="hint"
      ref={card.wrap.ref}
      onPointerEnter={card.wrap.onPointerEnter}
      onPointerLeave={card.wrap.onPointerLeave}
      onPointerDown={card.wrap.onPointerDown}
      // The trigger's own focus and press, heard here when the trigger is the page's own control.
      onFocus={own ? card.trigger.onFocus : undefined}
      className={cn('relative inline-flex max-w-full', card.open ? 'z-30' : 'z-10', className)}
    >
      {own ? (
        <span ref={card.trigger.ref as Ref<HTMLSpanElement>} className="inline-flex max-w-full">
          {cloneElement(children, { 'aria-describedby': card.open ? id : undefined })}
        </span>
      ) : (
        <button
          ref={card.trigger.ref as Ref<HTMLButtonElement>}
          type="button"
          data-ui="hint-trigger"
          aria-label={label}
          aria-describedby={card.open ? id : undefined}
          aria-expanded={card.open}
          onClick={card.trigger.onClick}
          onFocus={card.trigger.onFocus}
          className={cn(
            'max-w-full cursor-help text-left font-[inherit] text-inherit decoration-muted-foreground decoration-dotted underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            triggerClassName,
          )}
        >
          {children}
        </button>
      )}
      {card.open && (
        <HoverPanel ref={card.panel} id={id} place={card.place}>
          {tip}
        </HoverPanel>
      )}
    </span>
  );
}
