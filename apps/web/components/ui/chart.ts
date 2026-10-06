import { useEffect, useRef, useState } from 'react';

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
