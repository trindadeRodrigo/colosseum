import {
  type FocusEvent,
  type PointerEvent,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { PIN_CLOSE_MS, PIN_OPEN_MS } from './provenance';

// The behaviour of the one tooltip (Hint.tsx, gate TOOLTIP-WORDS): what opens it, what closes it and
// where it goes. A hook and a pure function, apart from the components, because a client module
// exports components only (server-safe.test.ts). Only client components call the hook.

/** How long a mouse rests before it opens, and how long it has to cross to the panel (provenance.ts). */
export const HINT_OPEN_MS = PIN_OPEN_MS;
export const HINT_CLOSE_MS = PIN_CLOSE_MS;

/** How long after a press a focus on the trigger is still taken for the press's own. */
const PRESS_MS = 700;
const GAP = 8;
const EDGE = 16;

export type Place = { top: number; left: number; maxHeight: number; side: 'below' | 'above' };

/**
 * Where a panel of this size goes for a trigger at this box, in a viewport of this size. Below, unless
 * it does not fit there and fits above; where it fits on neither side, the side with more room, with
 * its height held to that room. Never over the trigger; never nearer than 16px to an edge.
 */
export function placeFor(
  at: { top: number; bottom: number; left: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): Place {
  const below = view.height - EDGE - (at.bottom + GAP);
  const above = at.top - GAP - EDGE;
  const side = size.height <= below || below >= above ? 'below' : 'above';
  const room = Math.max(0, side === 'below' ? below : above);
  const height = Math.min(size.height, room);
  return {
    side,
    top: side === 'below' ? at.bottom + GAP : at.top - GAP - height,
    left: Math.max(EDGE, Math.min(at.left, view.width - size.width - EDGE)),
    maxHeight: room,
  };
}

export type HoverCard = {
  open: boolean;
  /** Opened by a press: it stays until a second press, Escape or a press elsewhere. */
  pinned: boolean;
  place: Place | null;
  close(): void;
  /** On the element that holds the trigger and the panel. */
  wrap: {
    ref: Ref<HTMLSpanElement>;
    onPointerEnter(event: PointerEvent<HTMLElement>): void;
    onPointerLeave(): void;
    onPointerDown(): void;
  };
  /** On the trigger. */
  trigger: {
    ref: Ref<HTMLElement>;
    onClick(): void;
    onFocus(event: FocusEvent<HTMLElement>): void;
  };
  panel: Ref<HTMLSpanElement>;
};

/** The behaviour of the one tooltip: what opens it, what closes it and where it goes. */
export function useHoverCard(defaultOpen = false): HoverCard {
  const [open, setOpen] = useState(defaultOpen);
  const [pinned, setPinned] = useState(defaultOpen);
  const [place, setPlace] = useState<Place | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A press focuses the trigger before it clicks it: that focus is the press's, not the keyboard's.
  const pressed = useRef(false);
  // Escape gives focus back to the trigger, which must not open it again.
  const returning = useRef(false);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const at = trigger.current?.getBoundingClientRect();
      const box = panel.current;
      if (!at || !box) return;
      // The panel's own height, not the one a held height gave it.
      const rect = box.getBoundingClientRect();
      const size = { width: rect.width, height: Math.max(rect.height, box.scrollHeight) };
      setPlace(placeFor(at, size, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    // What the panel holds can grow (the pin's details): it is placed again when it does.
    const grown = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (panel.current) grown?.observe(panel.current);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      grown?.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // A press anywhere else closes it, and so does focus that moves to something else on the page.
    // Focus that goes nowhere (a press on the panel's own text, another window) leaves it open.
    // Escape closes it and gives focus back to the trigger.
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
      if (inside && document.activeElement !== trigger.current) {
        returning.current = true;
        trigger.current?.focus();
        returning.current = false;
      }
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
      if (press.current) clearTimeout(press.current);
    },
    [],
  );

  return {
    open,
    pinned,
    place,
    close() {
      setOpen(false);
      setPinned(false);
    },
    wrap: {
      ref: wrap,
      // A mouse that rests on the trigger opens it, and the panel can be hovered in turn: the panel
      // is inside this element, and leaving does not close at once, so the pointer has time to cross
      // the gap between the two.
      onPointerEnter(event) {
        if (event.pointerType !== 'mouse') return;
        if (leave.current) clearTimeout(leave.current);
        leave.current = null;
        if (!open) hover.current = setTimeout(() => setOpen(true), HINT_OPEN_MS);
      },
      onPointerLeave() {
        if (hover.current) clearTimeout(hover.current);
        if (!open || pinned) return;
        leave.current = setTimeout(() => setOpen(false), HINT_CLOSE_MS);
      },
      onPointerDown() {
        // The focus a press brings comes with it on a mouse and at the lift of a finger: until the
        // click, or for as long as a tap may last, a focus is the press's own.
        pressed.current = true;
        if (press.current) clearTimeout(press.current);
        press.current = setTimeout(() => {
          pressed.current = false;
        }, PRESS_MS);
      },
    },
    trigger: {
      ref: trigger,
      // A tap, a click, Enter or Space: it opens and stays, and the next one closes it.
      onClick() {
        if (hover.current) clearTimeout(hover.current);
        pressed.current = false;
        const next = !(open && pinned);
        setOpen(next);
        setPinned(next);
      },
      // The keyboard arriving opens it; it closes when focus goes elsewhere.
      onFocus() {
        if (pressed.current || returning.current) return;
        setOpen(true);
      },
    },
    panel,
  };
}
