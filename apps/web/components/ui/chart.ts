import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// What the Bearing charts share (TimeChart, DistChart, Sparkline): the colour of each series and the
// measured width a chart draws at. A plain module, so a server component may read the colours.

/** Two series at most (s1, s2), or covered and not covered (cv, un): wood plus the status pigments. */
export type ChartSeriesClass = 's1' | 's2' | 'cv' | 'un';

/** The colour of a series, by its class. */
export const SERIES_VAR: Record<ChartSeriesClass, string> = {
  s1: 'var(--tf-bearing-s1)',
  s2: 'var(--tf-bearing-s2)',
  cv: 'var(--tf-bearing-cv)',
  un: 'var(--tf-bearing-un)',
};
/** The width of an element, kept current. Zero until it is measured. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.clientWidth));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Where a chart's crosshair is: the index of the point it is on, and, for a pointer, how far down the
 * plot it is (TimeChart tags the value there). Null when nothing is pointed at.
 */
export type ChartCursorAt = { i: number; py: number | null } | null;

/** The point nearest to `x` among points drawn at `xs`, in the same units. */
export function nearestIndex(x: number, xs: readonly number[]): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  xs.forEach((at, i) => {
    const d = Math.abs(at - x);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}

/**
 * The crosshair of a chart, shared by every chart that has one (TimeChart, the showcase's two, the plan
 * pane's): one way to point, whatever does the pointing.
 * - A mouse moves it by hovering and takes it away on leaving the plot.
 * - A finger or a pen moves it by tapping and dragging; it stays where the finger lifted.
 * - The keyboard: the plot is one tab stop; the arrow keys step one point, Home and End go to the ends,
 *   Escape takes it away, and leaving the plot does too.
 * `indexAt` turns a position in the plot (CSS pixels from its top left corner, and the plot's width)
 * into the point it is over. The plot gets `touch-action: pan-y`, so a drag across it moves the
 * crosshair and a drag up or down still scrolls the page.
 */
export function useChartCursor(
  count: number,
  indexAt: (x: number, width: number) => number,
): {
  at: ChartCursorAt;
  set: (at: ChartCursorAt) => void;
  pointer: {
    onPointerDown: (e: PointerEvent<Element>) => void;
    onPointerMove: (e: PointerEvent<Element>) => void;
    onPointerLeave: (e: PointerEvent<Element>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    style: { touchAction: 'pan-y' };
  };
  keys: { onKeyDown: (e: KeyboardEvent<Element>) => void; onBlur: () => void };
} {
  const [at, set] = useState<ChartCursorAt>(null);
  // A finger or a pen that is down on the plot: its moves are a drag.
  const dragging = useRef(false);
  const last = Math.max(0, count - 1);
  const point = useCallback(
    (e: PointerEvent<Element>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const i = indexAt(e.clientX - rect.left, rect.width);
      set({ i: Math.max(0, Math.min(last, i)), py: e.clientY - rect.top });
    },
    [indexAt, last],
  );
  const onPointerDown = useCallback(
    (e: PointerEvent<Element>) => {
      // A finger keeps the crosshair while it drags, wherever it goes.
      if (e.pointerType !== 'mouse') {
        dragging.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      point(e);
    },
    [point],
  );
  const onPointerMove = useCallback(
    (e: PointerEvent<Element>) => {
      if (e.pointerType === 'mouse' || dragging.current) point(e);
    },
    [point],
  );
  const onPointerLeave = useCallback((e: PointerEvent<Element>) => {
    if (e.pointerType === 'mouse') set(null);
  }, []);
  // The finger lifts: the crosshair stays where it was, to be read.
  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<Element>) => {
      if (e.key === 'Escape') {
        set(null);
        return;
      }
      const step = (
        { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 } as Record<string, number>
      )[e.key];
      if (step == null || count === 0) return;
      e.preventDefault();
      set((now) => ({ i: Math.max(0, Math.min(last, (now ? now.i : last) + step)), py: null }));
    },
    [count, last],
  );
  const onBlur = useCallback(() => set(null), []);
  return {
    at,
    set,
    pointer: {
      onPointerDown,
      onPointerMove,
      onPointerLeave,
      onPointerUp,
      onPointerCancel: onPointerUp,
      style: { touchAction: 'pan-y' },
    },
    keys: { onKeyDown, onBlur },
  };
}

/** How strongly a series is drawn while another may be lit: dimmed, unless it is the one. */
export const seriesOpacity = (focus: string | null, id: string) =>
  focus === null || focus === id ? 1 : 0.25;

/** The class that fades a series in and out, unless the reader asked for reduced motion. */
export const SERIES_FADE = 'motion-safe:transition-opacity motion-safe:duration-150';

/** The words of the Bearing charts, in English unless the caller hands its own. */
export type ChartLabels = {
  range: string;
  noData: string;
  noValue: string;
  fewSamples: string;
  zoom: string;
  zoomIn: string;
  zoomOut: string;
  poolPrice: string;
  below: (quote: string) => string;
  above: (asset: string) => string;
  noUsd: string;
  held: (token: string) => string;
};
export const CHART_LABELS: ChartLabels = {
  range: 'Range',
  noData: 'No data',
  noValue: 'no value',
  fewSamples: 'too few samples',
  zoom: 'Zoom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  poolPrice: 'Pool price',
  below: (quote) => `${quote} (below the price)`,
  above: (asset) => `${asset} (above the price)`,
  noUsd: 'no USD price',
  held: (token) => `in ${token}`,
};
