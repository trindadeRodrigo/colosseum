'use client';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { useLitPart } from './CaseParts';
import type { SampleLeg } from './sample';

// The picture of a sample case is its plan, drawn as a joint in the hero's ink (gates JOINT-3D and
// PLAN-JOINT): one post stacked from the plan's parts, each layer as tall as its share and drawn in the
// part's legend colour, each set on the one below by a tenon. A hairline reveal at every joint shows the
// shoulders and the tenon crossing it; the tenon's length inside the layer above is dashed, as a hidden
// edge is. A leader runs from each layer to its share and name in mono, in one aligned column. The parts
// come from the case's own data, the same the legend and the chart read, so they cannot disagree.
// Outline 1.5 px, other lines 0.85 px. When the card comes into view the layers come together from a
// little apart, the lowest first, about 1 s in all; with reduced motion, or without script, the joint
// stands as it is. Each layer is a part the reader can point at: a mouse over it, a tap, or the
// keyboard (one tab stop, the arrows step through the layers, Escape lets go) lifts it a little out of
// the stack, brightens it and dims the rest, and lights the same part in the card's list and chart
// (CaseParts.tsx); pointing at a row of the list lights the layer. With reduced motion nothing moves:
// only the colours change.

const VIEW = { w: 480, h: 400 };
const WEIGHT = { outline: 1.5, edge: 0.85 } as const;
const COLOUR = {
  1: 'var(--chart-1)',
  2: 'var(--chart-2)',
  3: 'var(--chart-3)',
  4: 'var(--chart-4)',
} as const;

/** The post: its height, half its width, and the joints between its layers. */
const POST = { h: 260, half: 40, reveal: 6, tenonHalf: 13, tenonIn: 18 } as const;
/** Where the post's foot stands, and the column the labels hang in. */
const FOOT = { x: 118, y: 330 } as const;
/**
 * The label column: where it starts, its type sizes in viewBox units (a name at least 12 px on a
 * 360 px wide card, where the drawing is drawn at three quarters of its size), and the room a line of
 * mono type has before the drawing's edge. Plex Mono sets every character 0.6 em wide.
 */
export const LABEL = { x: 232, share: 19, name: 16.5, lead: 19, edge: 476 } as const;
const MONO = 0.6;

/** A label's name without its tickers in brackets, so it fits its column; the reader hears them all. */
const short = (name: string) => name.replace(/\s*\([^)]*\)$/, '');

/** A name broken into lines that fit the label column, at word breaks. */
export function nameLines(name: string): string[] {
  const room = Math.floor((LABEL.edge - LABEL.x) / (LABEL.name * MONO));
  const lines: string[] = [];
  for (const word of short(name).split(' ')) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= room)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}
/** How wide a line of the name is set, in viewBox units. */
export const nameWidth = (line: string) => line.length * LABEL.name * MONO;

const C30 = Math.cos(Math.PI / 6);
/** Isometric: x runs right and down, z left and down, y up. */
const at = (x: number, y: number, z: number): [number, number] => [
  FOOT.x + (x - z) * C30,
  FOOT.y + (x + z) * 0.5 - y,
];
const line = (...pts: [number, number][]) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

export type PlanPart = { leg: SampleLeg; name: string };

type Layer = PlanPart & { y0: number; y1: number; share: number };

/** The layers bottom to top, each as tall as its share of the post less the reveals between them. */
export function layersOf(parts: readonly PlanPart[]): Layer[] {
  const total = parts.reduce((sum, p) => sum + p.leg.weightBps, 0);
  const solid = POST.h - POST.reveal * (parts.length - 1);
  let y = 0;
  return parts.map((part) => {
    const h = (solid * part.leg.weightBps) / total;
    const layer = { ...part, y0: y, y1: y + h, share: part.leg.weightBps / 100 };
    y += h + POST.reveal;
    return layer;
  });
}

/**
 * Label rows (the share's baseline): at each layer's middle, pushed apart so no two blocks touch, and
 * kept inside the drawing: pushed down from the top, then, if the last runs off the foot, held there
 * and the rest pushed up above it.
 */
export function labelRows(layers: Layer[]): number[] {
  const lines = Math.max(1, ...layers.map((l) => nameLines(l.name).length));
  const gap = LABEL.share + lines * LABEL.lead + 10;
  const top = LABEL.share + 4;
  const bottom = VIEW.h - lines * LABEL.lead - 6;
  const ys = layers.map((l) => at(POST.half, (l.y0 + l.y1) / 2, 0)[1]);
  const order = ys.map((y, i) => ({ y: Math.max(top, y), i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1];
    const cur = order[k];
    if (prev && cur && cur.y - prev.y < gap) cur.y = prev.y + gap;
  }
  const last = order[order.length - 1];
  if (last && last.y > bottom) {
    last.y = bottom;
    for (let k = order.length - 2; k >= 0; k--) {
      const cur = order[k];
      const next = order[k + 1];
      if (cur && next && next.y - cur.y < gap) cur.y = next.y - gap;
    }
  }
  const out: number[] = [];
  for (const { y, i } of order) out[i] = y;
  return out;
}

function Piece({ layer, last, first }: { layer: Layer; last: boolean; first: boolean }) {
  const a = POST.half;
  const { y0, y1 } = layer;
  const seen = [
    // the three upright edges in sight
    line(at(-a, y0, a), at(-a, y1, a)),
    line(at(a, y0, a), at(a, y1, a)),
    line(at(a, y0, -a), at(a, y1, -a)),
    // the shoulder at its foot and its head, round the two faces in sight
    line(at(-a, y0, a), at(a, y0, a), at(a, y0, -a)),
    line(at(-a, y1, a), at(a, y1, a), at(a, y1, -a)),
  ];
  // the top of the post: its whole face
  if (last) seen.push(line(at(-a, y1, a), at(-a, y1, -a), at(a, y1, -a)));
  const t = POST.tenonHalf;
  const tenon: string[] = [];
  const hidden: string[] = [];
  if (!first) {
    // its tenon goes down across the reveal (in sight) and into the layer below (hidden)
    const gap = y0 - POST.reveal;
    tenon.push(
      line(at(-t, gap, t), at(-t, y0, t)),
      line(at(t, gap, t), at(t, y0, t)),
      line(at(t, gap, -t), at(t, y0, -t)),
    );
    const end = gap - POST.tenonIn;
    hidden.push(
      line(at(-t, end, t), at(-t, gap, t)),
      line(at(t, end, t), at(t, gap, t)),
      line(at(t, end, -t), at(t, gap, -t)),
      line(at(-t, end, -t), at(-t, gap, -t)),
      line(at(-t, end, t), at(t, end, t), at(t, end, -t), at(-t, end, -t), at(-t, end, t)),
    );
  }
  return (
    <>
      <path d={seen.join('')} strokeWidth={WEIGHT.outline} />
      {tenon.length > 0 && <path d={tenon.join('')} strokeWidth={WEIGHT.edge} />}
      {hidden.length > 0 && (
        <path
          d={hidden.join('')}
          data-part="hidden"
          strokeWidth={WEIGHT.edge}
          strokeDasharray="4 3"
          className="opacity-70"
        />
      )}
    </>
  );
}

export function PlanDrawing({
  parts,
  label,
  className,
}: {
  parts: readonly PlanPart[];
  label: string;
  className?: string;
}) {
  const layers = layersOf(parts);
  const rows = labelRows(layers);
  // what a reader hears: the case's sentence, then each part with its share, from the same data
  const said = `${label} ${layers.map((l) => `${l.name} ${l.share}%`).join(', ')}.`;
  const ref = useRef<SVGSVGElement>(null);
  const pieces = useRef<(SVGGElement | null)[]>([]);
  const { lit, setLit } = useLitPart();
  // the layer the arrow keys stand on: one tab stop for the drawing, the arrows move it
  const [at0, setAt] = useState(0);
  // still unless it is about to come into view and motion is welcome: then it assembles, once
  const [state, setState] = useState<'still' | 'armed' | 'in'>('still');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    setState('armed');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setState('in');
        observer.disconnect();
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // a tap anywhere but on a layer or a row of the parts lets the lit part go
  useEffect(() => {
    if (lit === null) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('[data-part="layer"], [data-ui="case-leg"]')) return;
      setLit(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [lit, setLit]);
  const go = (i: number) => {
    const next = Math.max(0, Math.min(layers.length - 1, i));
    setAt(next);
    pieces.current[next]?.focus();
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, i: number) => {
    const step = (
      { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>
    )[e.key];
    if (step !== undefined) {
      e.preventDefault();
      go(i + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(layers.length - 1);
    } else if (e.key === 'Escape') setLit(null);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG has no fieldset; its layers are a group
    <svg
      ref={ref}
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={said}
      data-ui="plan-drawing"
      data-state={state}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('block bg-card text-foreground', className)}
    >
      {layers.map((layer, i) => {
        const [lx, ly] = at(POST.half, (layer.y0 + layer.y1) / 2, 0);
        const row = rows[i] ?? ly;
        const on = lit === layer.leg.chart;
        const dim = lit !== null && !on;
        return (
          // the assembly: apart, then into the stack, the lowest first
          <g
            key={layer.leg.chart}
            style={{
              translate: state === 'armed' ? `0px ${-(i + 1) * 10}px` : undefined,
              transitionDelay: state === 'in' ? `${(i * 0.12).toFixed(2)}s` : undefined,
            }}
            className="transition-[translate] duration-700 ease-seat motion-reduce:transition-none"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a layer of an SVG drawing cannot be a <button> */}
            <g
              ref={(el) => {
                pieces.current[i] = el;
              }}
              data-part="layer"
              data-share={layer.share}
              data-chart={layer.leg.chart}
              data-lit={on}
              role="button"
              aria-pressed={on}
              aria-label={`${layer.name}, ${layer.share}%`}
              tabIndex={i === at0 ? 0 : -1}
              onFocus={() => {
                setAt(i);
                setLit(layer.leg.chart);
              }}
              onBlur={(e) => {
                if (!ref.current?.contains(e.relatedTarget as Node | null)) setLit(null);
              }}
              onKeyDown={(e) => onKey(e, i)}
              onPointerEnter={(e) => e.pointerType === 'mouse' && setLit(layer.leg.chart)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && setLit(null)}
              onPointerUp={(e) => {
                // a finger or a pen: a tap picks the part, a second tap lets it go
                if (e.pointerType !== 'mouse') setLit(on ? null : layer.leg.chart);
              }}
              stroke="currentColor"
              style={{ color: COLOUR[layer.leg.chart] }}
              className={cn(
                'cursor-pointer outline-none motion-safe:transition-[translate,opacity] motion-safe:duration-200 motion-safe:ease-seat',
                on && '-translate-y-1.5 motion-reduce:translate-y-0',
                dim && 'opacity-35',
              )}
            >
              {/* what a pointer can rest on: the layer's whole outline and its label, not only its lines */}
              <path
                data-part="hit"
                d={`${line(
                  at(-POST.half, layer.y0, POST.half),
                  at(POST.half, layer.y0, POST.half),
                  at(POST.half, layer.y0, -POST.half),
                  at(POST.half, layer.y1, -POST.half),
                  at(-POST.half, layer.y1, -POST.half),
                  at(-POST.half, layer.y1, POST.half),
                )}Z`}
                fill="transparent"
                stroke="none"
              />
              <rect
                data-part="hit"
                x={LABEL.x - 8}
                y={row - LABEL.share}
                width={LABEL.edge - LABEL.x + 8}
                height={LABEL.share + nameLines(layer.name).length * LABEL.lead + 8}
                fill="transparent"
                stroke="none"
              />
              <Piece layer={layer} first={i === 0} last={i === layers.length - 1} />
              <path
                d={line([lx + 8, ly], [LABEL.x - 22, row - 6], [LABEL.x - 6, row - 6])}
                strokeWidth={WEIGHT.edge}
                className={on ? 'opacity-100' : 'opacity-60'}
              />
              <text
                x={LABEL.x}
                y={row}
                stroke="none"
                className="fill-foreground font-mono"
                fontSize={LABEL.share}
                fontWeight={500}
              >
                {layer.share}%
              </text>
              <text
                data-part="name"
                x={LABEL.x}
                y={row}
                stroke="none"
                className={cn('font-mono', on ? 'fill-foreground' : 'fill-muted-foreground')}
                fontSize={LABEL.name}
              >
                {nameLines(layer.name).map((text) => (
                  <tspan key={text} x={LABEL.x} dy={LABEL.lead}>
                    {text}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
