'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';

// The closing section's picture (gate CLOSING-INK): the hero's joint (JOINT-3D, form 3) drawn as an
// exploded view in the same ink as the hero and the plan drawings: a slender post with its through-
// mortise, the rail standing back along its axis with its tenon, and the flat pin above the tenon's
// slot, with dashed guides showing how they come together. Outline 1.5 px, other edges 0.85 px, faces
// filled with the page's ground so a nearer piece hides a farther one, the guides a hairline in the
// brand wood. When it comes into view the rail slides home and the pin drops, once, in about 1.2 s.
// With reduced motion it stands assembled and still (CSS alone, before any script runs); without
// script it stays exploded.

const W = { outline: 1.5, edge: 0.85 } as const;
/** The rail's and the pin's travel when the view is exploded, in drawing units. */
export const APART = { rail: 115, pin: 160 } as const;

type V3 = readonly [number, number, number];
const C30 = Math.cos(Math.PI / 6);
const ORIGIN = { x: 270, y: 290 };
/** Isometric: x runs right and down, z left and down, y up. */
const at = ([x, y, z]: V3): [number, number] => [
  ORIGIN.x + (x - z) * C30,
  ORIGIN.y + (x + z) * 0.5 - y,
];
const path = (...pts: V3[]) =>
  pts
    .map((p, i) => {
      const [sx, sy] = at(p);
      return `${i ? 'L' : 'M'}${sx.toFixed(1)} ${sy.toFixed(1)}`;
    })
    .join('');

/** A box seen from +x, +y, +z: its three faces in sight filled, its outline heavy, its inner edges light. */
function Box({ x, y, z }: { x: [number, number]; y: [number, number]; z: [number, number] }) {
  const [x0, x1] = x;
  const [y0, y1] = y;
  const [z0, z1] = z;
  const faces = [
    // +y (top), +x (right), +z (front)
    path([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    path([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    path([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
  ];
  const outline = path(
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z1],
    [x0, y1, z0],
  );
  const inner = `${path([x1, y1, z1], [x1, y1, z0])}${path([x1, y1, z1], [x0, y1, z1])}${path([x1, y1, z1], [x1, y0, z1])}`;
  return (
    <g>
      {faces.map((d) => (
        <path key={d} d={`${d}Z`} fill="var(--background)" stroke="none" />
      ))}
      <path d={`${outline}Z`} strokeWidth={W.outline} />
      <path d={inner} strokeWidth={W.edge} />
    </g>
  );
}

/** A rectangle drawn on a face, as an opening or a slot: light, or dashed where it is hidden. */
const Opening = ({ d, hidden = false }: { d: string; hidden?: boolean }) => (
  <path
    d={`${d}Z`}
    strokeWidth={W.edge}
    strokeDasharray={hidden ? '4 3' : undefined}
    className={hidden ? 'opacity-70' : undefined}
    data-part={hidden ? 'hidden' : 'opening'}
  />
);

// The joint, in millimetres: a 30 × 30 post, a 24 × 30 rail whose tenon (8 thick, 20 high) passes
// through the post and stands 60 proud, a 6 × 4 pin down a slot in the tenon's nose.
const POST = { half: 15, y0: -120, y1: 120 };
const TENON = { halfZ: 4, halfY: 10, len: 90 };
const RAIL = { halfZ: 12, halfY: 15, len: 90 };
/** The slot and the pin, 15 mm past the post's far face (the pin's centre, along x). */
const PIN_X = 30;
const SLOT = { halfX: 3.1, halfZ: 2.1 };
const PIN = { halfX: 3, halfZ: 2, half: 24 };
const shoulder = -POST.half;

export function ClosingDrawing({
  label,
  className,
  still = false,
}: {
  label: string;
  className?: string;
  /** Assembled and still: the closing's stand-in where its 3D scene does not run (Closing3D.tsx). */
  still?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  // apart until it comes into view; still (and drawn assembled by CSS) with reduced motion
  const [state, setState] = useState<'apart' | 'in' | 'still'>(still ? 'still' : 'apart');
  useEffect(() => {
    const el = ref.current;
    if (still || !el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setState('still');
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setState('in');
        observer.disconnect();
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [still]);
  const apart = state === 'apart';
  const move = 'transition-[translate] duration-[1200ms] ease-seat motion-reduce:transition-none';
  // the rail moves along x, which the drawing shows going right and down
  const railShift = apart ? { translate: `${-APART.rail * C30}px ${-APART.rail * 0.5}px` } : {};
  const pinShift = apart ? { translate: `0px ${-APART.pin}px` } : {};
  const t = TENON;
  const nose = shoulder + POST.half * 2;
  return (
    <svg
      ref={ref}
      viewBox="0 0 480 520"
      role="img"
      aria-label={label}
      data-ui="closing-drawing"
      data-state={state}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('block text-foreground', className)}
    >
      {/* the rail and the tenon's length inside the post, behind it */}
      <g data-part="rail" style={railShift} className={cn(move, 'motion-reduce:!translate-none')}>
        <Box
          x={[shoulder - RAIL.len, shoulder]}
          y={[-RAIL.halfY, RAIL.halfY]}
          z={[-RAIL.halfZ, RAIL.halfZ]}
        />
        <Box x={[shoulder, nose]} y={[-t.halfY, t.halfY]} z={[-t.halfZ, t.halfZ]} />
      </g>
      {/* the post, its mortise open on the face in sight and dashed through it */}
      <g data-part="post">
        <Box x={[-POST.half, POST.half]} y={[POST.y0, POST.y1]} z={[-POST.half, POST.half]} />
        <Opening
          d={path(
            [POST.half, -t.halfY, -t.halfZ],
            [POST.half, t.halfY, -t.halfZ],
            [POST.half, t.halfY, t.halfZ],
            [POST.half, -t.halfY, t.halfZ],
          )}
        />
        <Opening
          hidden
          d={path(
            [-POST.half, -t.halfY, -t.halfZ],
            [-POST.half, t.halfY, -t.halfZ],
            [-POST.half, t.halfY, t.halfZ],
            [-POST.half, -t.halfY, t.halfZ],
          )}
        />
      </g>
      {/* the tenon's nose, proud of the post, with the pin's slot */}
      <g data-part="nose" style={railShift} className={cn(move, 'motion-reduce:!translate-none')}>
        <Box x={[nose, shoulder + t.len]} y={[-t.halfY, t.halfY]} z={[-t.halfZ, t.halfZ]} />
        <Opening
          d={path(
            [PIN_X - SLOT.halfX, t.halfY, -SLOT.halfZ],
            [PIN_X + SLOT.halfX, t.halfY, -SLOT.halfZ],
            [PIN_X + SLOT.halfX, t.halfY, SLOT.halfZ],
            [PIN_X - SLOT.halfX, t.halfY, SLOT.halfZ],
          )}
        />
      </g>
      {/* the pin, above its slot */}
      <g
        data-part="pin"
        style={pinShift}
        className={cn(
          move,
          apart && 'delay-0',
          !apart && 'delay-[400ms]',
          'motion-reduce:!translate-none',
        )}
      >
        <Box
          x={[PIN_X - PIN.halfX, PIN_X + PIN.halfX]}
          y={[-PIN.half, PIN.half]}
          z={[-PIN.halfZ, PIN.halfZ]}
        />
      </g>
      {/* the guides: the tenon's axis through the mortise, the pin's path down into its slot */}
      <g
        data-part="guides"
        strokeWidth={W.edge}
        strokeDasharray="2 5"
        className={cn(
          'text-primary transition-opacity duration-500 motion-reduce:opacity-0',
          apart ? 'opacity-100' : 'opacity-0',
        )}
      >
        {/* from the tenon's tip, standing back, to the far face it will come out of */}
        <path d={path([shoulder - APART.rail + t.len + 4, 0, 0], [POST.half + 30, 0, 0])} />
        {/* from the pin's foot, standing above, down into its slot */}
        <path d={path([PIN_X, APART.pin - PIN.half - 4, 0], [PIN_X, t.halfY + 2, 0])} />
      </g>
    </svg>
  );
}
