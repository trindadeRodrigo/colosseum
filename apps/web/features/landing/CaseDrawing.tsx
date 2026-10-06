import { cn } from '../../components/ui/cn';

// The places of the two sample people, drawn as a landscape etching in the hero joint's ink (gate
// SHOWCASE-INK, after JOINT-3D): lines only, no fills; the near form in the outline weight (1.5 px),
// everything else in the edge weight (0.85), far forms dashed and fainter, the trail and the marks in
// the brand wood. A line that passes behind a nearer form stops where it meets it, as an etcher leaves
// it. No people: the place stands for the goal. The drawing covers its slot as the
// photograph did (square, its subject in the middle band that a wide slot on a phone keeps).

const SIZE = 480;
const WEIGHT = { outline: 1.5, edge: 0.85 } as const;

type Pt = readonly [number, number];

const path = (pts: readonly Pt[]) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

/** The height of a polyline at x (it runs left to right). */
function at(line: readonly Pt[], x: number): number {
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1] as Pt;
    const [x1, y1] = line[i] as Pt;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
  }
  return (line[line.length - 1] as Pt)[1];
}

/** The parts of a polyline that `seen` keeps, each its own path: what is left of a line behind others. */
function visible(line: readonly Pt[], seen: (p: Pt) => boolean): string[] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1] as Pt;
    const [x1, y1] = line[i] as Pt;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const p: Pt = [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n];
      if (seen(p)) run.push(p);
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 2).map(path);
}

type Stroke = {
  d: string;
  part: string;
  weight?: keyof typeof WEIGHT;
  dash?: 'far' | 'trail' | 'cloud';
  wood?: boolean;
  faint?: boolean;
};

const DASH = { far: '5 4', trail: '6 5', cloud: '2 6' } as const;

function Line({ d, part, weight = 'edge', dash, wood, faint }: Stroke) {
  return (
    <path
      d={d}
      data-part={part}
      vectorEffect="non-scaling-stroke"
      fill="none"
      stroke="currentColor"
      strokeWidth={WEIGHT[weight]}
      strokeDasharray={dash ? DASH[dash] : undefined}
      className={cn(faint && 'opacity-50', wood && 'text-primary')}
    />
  );
}

// --- Mariana: a coastal walking path. The sea's horizon high in the frame; a headland in front with
// its cliff dropping to the water and a few strokes of hatching on its face; a fainter headland
// behind it across the bay; the trail winding along the cliff top into the distance, to a small
// cross where the trip ends; three wave strokes. ---------------------------------------------------
const HORIZON = 132;
const FAR_HEAD: Pt[] = [
  [262, HORIZON],
  [292, 122],
  [330, 110],
  [372, 104],
  [410, 110],
  [440, 122],
  [470, 128],
  [480, 130],
];
const CLIFF_TOP: Pt[] = [
  [0, 226],
  [44, 216],
  [92, 212],
  [140, 218],
  [184, 230],
  [222, 242],
  [252, 254],
];
const CLIFF_FACE: Pt[] = [
  [252, 254],
  [258, 278],
  [262, 300],
  [270, 324],
];
const SHORE: Pt[] = [
  [270, 324],
  [300, 330],
  [336, 328],
  [372, 334],
];
const DOWN: Pt[] = [
  [0, 352],
  [90, 354],
  [170, 348],
  [230, 338],
  [270, 324],
];
const TRAIL: Pt[] = [
  [14, 318],
  [52, 296],
  [96, 276],
  [140, 262],
  [184, 258],
  [216, 262],
  [232, 266],
];
const END: Pt = [232, 266];
const WAVES = [
  [318, 168, 34],
  [384, 206, 24],
  [334, 246, 28],
] as const;

function Coast() {
  return (
    <>
      <Line d={path([[0, HORIZON], FAR_HEAD[0] as Pt])} part="horizon" />
      <Line d={path(FAR_HEAD)} part="far" dash="far" faint />
      {WAVES.map(([x, y, w]) => (
        <Line key={x} d={`M${x} ${y}q${w / 4} -3 ${w / 2} 0t${w / 2} 0`} part="wave" faint />
      ))}
      <Line d={path(CLIFF_TOP)} part="cliff" weight="outline" />
      <Line d={path(CLIFF_FACE)} part="cliff" weight="outline" />
      <Line d={path(SHORE)} part="shore" />
      {/* hatching on the cliff's face, one direction, sparse */}
      {[
        [240, 284],
        [245, 300],
        [250, 316],
      ].map(([x, y]) => (
        <Line key={`${x}-${y}`} d={`M${x} ${y}l10 -9`} part="hatch" />
      ))}
      <Line d={path(DOWN)} part="down" />
      <Line d={path(TRAIL)} part="trail" dash="trail" wood />
      <g data-part="mark" className="text-primary">
        <Line
          d={`M${END[0] - 5} ${END[1] - 5}l10 10M${END[0] + 5} ${END[1] - 5}l-10 10`}
          part="mark"
          wood
        />
      </g>
    </>
  );
}

// --- Diego: a ridge above the cloud. Irregular ridgelines with a dominant summit, the nearest heavy,
// the middle light, the farthest dashed and faint, each stopping where a nearer one stands in front;
// soft dotted bands of cloud across the lower slopes, which hide what is behind them; a small cross
// and flag on the summit. The top of the frame is left empty. -----------------------------------------
const NEAR: Pt[] = [
  [0, 336],
  [34, 322],
  [52, 326],
  [88, 296],
  [104, 300],
  [118, 286],
  [150, 262],
  [160, 266],
  [196, 226],
  [214, 214],
  [226, 218],
  [246, 190],
  [262, 176],
  [270, 180],
  [282, 178],
  [296, 196],
  [318, 210],
  [328, 206],
  [352, 236],
  [388, 250],
  [404, 246],
  [432, 272],
  [480, 300],
];
const SUMMIT: Pt = [262, 176];
const MIDDLE: Pt[] = [
  [0, 288],
  [40, 268],
  [70, 276],
  [120, 246],
  [150, 250],
  [180, 232],
  [230, 238],
  [300, 232],
  [340, 214],
  [370, 222],
  [420, 204],
  [450, 212],
  [480, 208],
];
const FAR: Pt[] = [
  [0, 236],
  [50, 226],
  [110, 214],
  [170, 220],
  [240, 204],
  [320, 206],
  [380, 190],
  [440, 196],
  [480, 186],
];
/** The cloud's bands: each a soft line across the lower slopes, hiding what is behind it. */
const CLOUDS: Pt[][] = [
  [
    [0, 326],
    [70, 320],
    [150, 328],
    [240, 318],
    [330, 326],
    [410, 316],
    [480, 322],
  ],
  [
    [0, 354],
    [100, 348],
    [210, 356],
    [320, 348],
    [480, 354],
  ],
  [
    [0, 382],
    [140, 376],
    [280, 384],
    [480, 378],
  ],
];
const CLOUD_TOP = CLOUDS[0] as Pt[];

function Ridge() {
  const clear = (p: Pt) => p[1] < at(CLOUD_TOP, p[0]) - 6;
  const near = visible(NEAR, clear);
  const middle = visible(MIDDLE, (p) => clear(p) && p[1] < at(NEAR, p[0]) - 3);
  const far = visible(
    FAR,
    (p) => clear(p) && p[1] < at(MIDDLE, p[0]) - 3 && p[1] < at(NEAR, p[0]) - 3,
  );
  return (
    <>
      {far.map((d) => (
        <Line key={d} d={d} part="far" dash="far" faint />
      ))}
      {middle.map((d) => (
        <Line key={d} d={d} part="middle" />
      ))}
      {near.map((d) => (
        <Line key={d} d={d} part="ridge" weight="outline" />
      ))}
      {CLOUDS.map((band, i) => {
        const d = path(band);
        return <Line key={d} d={d} part="cloud" dash="cloud" faint={i > 0} />;
      })}
      <g data-part="mark" className="text-primary">
        <Line d={`M${SUMMIT[0]} ${SUMMIT[1] - 4}V${SUMMIT[1] - 28}l14 5l-14 5`} part="mark" wood />
      </g>
    </>
  );
}

export function CaseDrawing({
  place,
  label,
  className,
}: {
  place: 'coast' | 'ridge';
  label: string;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={label}
      data-ui="case-drawing"
      data-place={place}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('block bg-card text-foreground', className)}
    >
      <title>{label}</title>
      {place === 'coast' ? <Coast /> : <Ridge />}
    </svg>
  );
}
