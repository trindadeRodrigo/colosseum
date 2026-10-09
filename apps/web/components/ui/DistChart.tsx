'use client';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { CHART_LABELS, type ChartLabels, SERIES_VAR, useWidth } from './chart';
import { nice } from './chart-scale';
import { cn } from './cn';
import { ChartHead, ChartLegend } from './TimeChart';

// The liquidity of a concentrated-liquidity pool by price band (analytics-charts.js, `dist`): bars by
// price around the pool price, the asset above it and the quote below, a pool-price tag, and + and −
// to zoom. Hover and the arrow keys read one band out.

export type DistBand = { lo: number; hi: number; usd: number | null; side: 'asset' | 'quote' };

export type DistChartProps = {
  title: string;
  value?: ReactNode;
  note?: ReactNode;
  bands: readonly DistBand[];
  mid: number;
  /** `USDC/SPYx`. */
  unit: string;
  fmtP: (v: number) => string;
  fmtY: (v: number) => string;
  asset: string;
  quote: string;
  aria: string;
  src?: ReactNode;
  labels?: Partial<ChartLabels>;
};

const AX = 64;
const XA = 22;

export function DistChart(c: DistChartProps) {
  const text = { ...CHART_LABELS, ...c.labels };
  const [zoom, setZoom] = useState(1);
  const [idx, setIdx] = useState(-1);
  const [box, W0] = useWidth<HTMLDivElement>();
  const W = Math.max(280, W0);
  const H = 280;
  const plotW = W - AX - 8;
  const plotH = H - XA;
  const lo0 = c.bands[0]?.lo ?? c.mid;
  const hi0 = c.bands[c.bands.length - 1]?.hi ?? c.mid;
  const half = Math.max(c.mid - lo0, hi0 - c.mid) / 2 ** zoom;
  const lo = c.mid - half;
  const hi = c.mid + half;
  const bs = c.bands.filter((b) => b.hi > lo && b.lo < hi);
  const X = (p: number) => 8 + ((p - lo) / (hi - lo || 1)) * plotW;
  const ny = nice(0, Math.max(...bs.map((b) => b.usd || 0), 1) * 1.08, 4);
  const Y = (v: number) => 30 + (plotH - 30) - (v / ny.hi) * (plotH - 30);
  const ticks = nice(lo, hi, Math.max(3, Math.floor(plotW / 110))).ticks.filter(
    (t) => t > lo && t < hi,
  );
  const band = idx >= 0 ? bs[Math.min(idx, bs.length - 1)] : undefined;
  const show = (i: number) => setIdx(Math.max(0, Math.min(bs.length - 1, i)));
  const onKey = (e: KeyboardEvent) => {
    const d = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (d == null) return;
    e.preventDefault();
    show(idx < 0 ? Math.floor(bs.length / 2) : idx + d);
  };
  const zoomBtn =
    'w-7 cursor-pointer rounded-md border border-input font-mono text-base/6 font-medium hover:border-primary hover:text-honey-text disabled:cursor-default disabled:opacity-40';
  const tools = (
    // biome-ignore lint/a11y/useSemanticElements: a pair of zoom buttons
    <div role="group" aria-label={text.zoom} className="inline-flex gap-1">
      <button
        type="button"
        aria-label={text.zoomIn}
        disabled={zoom >= 3}
        onClick={() => setZoom(zoom + 1)}
        className={zoomBtn}
      >
        +
      </button>
      <button
        type="button"
        aria-label={text.zoomOut}
        disabled={zoom <= 0}
        onClick={() => setZoom(zoom - 1)}
        className={zoomBtn}
      >
        −
      </button>
    </div>
  );
  return (
    <div data-ui="dist-chart">
      <ChartHead title={c.title} value={c.value} note={c.note} tools={tools} labels={c.labels} />
      <div
        ref={box}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys read the bands out, as the mouse does
        tabIndex={0}
        role="img"
        aria-label={c.aria}
        onKeyDown={onKey}
        className="relative pt-11"
      >
        {W0 > 0 && (
          <>
            <div
              className="absolute top-0 z-[1] -translate-x-1/2 rounded-md border border-input bg-muted px-2.5 py-0.5 whitespace-nowrap"
              style={{ left: X(c.mid) }}
            >
              <span className="block font-condensed text-[11.5px]/[14px] font-medium text-muted-foreground">
                {text.poolPrice}
              </span>
              <b className="block font-mono text-caption font-medium">
                {c.fmtP(c.mid)} {c.unit}
              </b>
            </div>
            <svg
              aria-hidden="true"
              width={W}
              height={H}
              viewBox={`0 0 ${W} ${H}`}
              className="block overflow-visible"
              onMouseMove={(e) => {
                const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
                const i = bs.findIndex((b) => x >= X(b.lo) && x <= X(b.hi));
                if (i >= 0) setIdx(i);
              }}
              onMouseLeave={() => setIdx(-1)}
            >
              {ny.ticks.map((t) => (
                <g key={t}>
                  <line x1={8} x2={8 + plotW} y1={Y(t)} y2={Y(t)} stroke="var(--tf-bearing-grid)" />
                  <text
                    x={W - AX + 6}
                    y={Y(t) + 4}
                    className="fill-foreground/80 font-mono text-[11px]"
                  >
                    {c.fmtY(t)}
                  </text>
                </g>
              ))}
              {bs.map((b, i) => {
                const a = Math.max(8, X(b.lo)) + 1;
                const z = Math.min(8 + plotW, X(b.hi)) - 1;
                return (
                  <rect
                    key={`${b.lo}-${b.side}`}
                    x={a}
                    y={Y(b.usd || 0)}
                    width={Math.max(1, z - a)}
                    height={Math.max(0, plotH - Y(b.usd || 0))}
                    fill={
                      i === idx ? 'var(--foreground)' : SERIES_VAR[b.side === 'asset' ? 's1' : 's2']
                    }
                  />
                );
              })}
              <line
                x1={X(c.mid)}
                x2={X(c.mid)}
                y1={22}
                y2={plotH}
                stroke="var(--foreground)"
                strokeWidth={2}
              />
              {ticks.map((t) => (
                <text
                  key={t}
                  x={X(t)}
                  y={plotH + 16}
                  textAnchor="middle"
                  className="fill-foreground/80 font-mono text-[11px]"
                >
                  {c.fmtP(t)}
                </text>
              ))}
              <line x1={8} x2={8 + plotW} y1={plotH} y2={plotH} stroke="var(--input)" />
            </svg>
          </>
        )}
      </div>
      <ChartLegend
        items={[
          { cls: 's2', label: text.below(c.quote) },
          { cls: 's1', label: text.above(c.asset) },
        ]}
      />
      <div
        aria-live="polite"
        className={cn('min-h-5 font-mono text-b-meta/5 text-muted-foreground')}
      >
        {band && (
          <span>
            <i
              aria-hidden="true"
              className="mr-1.5 inline-block size-2"
              style={{ background: SERIES_VAR[band.side === 'asset' ? 's1' : 's2'] }}
            />
            {c.fmtP(band.lo)}–{c.fmtP(band.hi)} {c.unit} ·{' '}
            <b className="font-medium text-foreground">
              {band.usd == null ? text.noUsd : c.fmtY(band.usd)}
            </b>{' '}
            {text.held(band.side === 'asset' ? c.asset : c.quote)}
          </span>
        )}
      </div>
      {c.src}
    </div>
  );
}
