'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import type { SampleLeg } from './sample';

// The picture of a sample case is its plan, drawn as a joint in the hero's ink (gates JOINT-3D and
// PLAN-JOINT): one post stacked from the plan's parts, each layer as tall as its share and drawn in the
// part's legend colour, each set on the one below by a tenon. A hairline reveal at every joint shows the
// shoulders and the tenon crossing it; the tenon's length inside the layer above is dashed, as a hidden
// edge is. A leader runs from each layer to its share and name in mono, in one aligned column. The parts
// come from the case's own data, the same the legend and the chart read, so they cannot disagree.
// Outline 1.5 px, other lines 0.85 px. When the card comes into view the layers settle from the bottom
// up, about 0.8 s in all; with reduced motion, or without script, the joint stands as it is.

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
const FOOT = { x: 150, y: 330 } as const;
const LABEL = { x: 300, gap: 34 } as const;

/** A label's name without its tickers in brackets, so it fits its column; the reader hears them all. */
const short = (name: string) => name.replace(/\s*\([^)]*\)$/, '');

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

/** Label rows: at each layer's middle, pushed apart so no two are closer than the row gap. */
function labelRows(layers: Layer[]): number[] {
  const ys = layers.map((l) => at(POST.half, (l.y0 + l.y1) / 2, 0)[1]);
  // from the top down, each at least a gap below the one above
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1];
    const cur = order[k];
    if (prev && cur && cur.y - prev.y < LABEL.gap) cur.y = prev.y + LABEL.gap;
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
  // shown unless it is about to come into view and motion is welcome: then it settles in
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
  const step = 0.8 / Math.max(layers.length, 1);
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={said}
      data-ui="plan-drawing"
      data-state={state}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('block bg-card text-foreground', className)}
    >
      <title>{said}</title>
      {layers.map((layer, i) => {
        const [lx, ly] = at(POST.half, (layer.y0 + layer.y1) / 2, 0);
        const row = rows[i] ?? ly;
        return (
          <g
            key={layer.leg.chart}
            data-part="layer"
            data-share={layer.share}
            data-chart={layer.leg.chart}
            stroke="currentColor"
            style={{
              color: COLOUR[layer.leg.chart],
              transitionDelay: state === 'in' ? `${(i * step).toFixed(2)}s` : undefined,
            }}
            className={cn(
              'transition-[opacity,translate] duration-300 ease-seat motion-reduce:transition-none',
              state === 'armed' ? '-translate-y-3 opacity-0' : 'translate-y-0 opacity-100',
            )}
          >
            <Piece layer={layer} first={i === 0} last={i === layers.length - 1} />
            <path
              d={line([lx + 8, ly], [LABEL.x - 28, row], [LABEL.x - 8, row])}
              strokeWidth={WEIGHT.edge}
              className="opacity-60"
            />
            <text
              x={LABEL.x}
              y={row - 2}
              stroke="none"
              className="fill-foreground font-mono"
              fontSize={15}
              fontWeight={500}
            >
              {layer.share}%
            </text>
            <text
              x={LABEL.x}
              y={row + 14}
              stroke="none"
              className="fill-muted-foreground font-mono"
              fontSize={12.5}
            >
              {short(layer.name)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
