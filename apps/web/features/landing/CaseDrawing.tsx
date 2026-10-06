import { useId } from 'react';
import { cn } from '../../components/ui/cn';

// The places of the two sample people, drawn in the hero joint's ink (gate JOINT-3D): lines in the
// page's foreground, the route and the mark in its brand wood, near forms filled with the card so they
// hide what lies behind them, far lines dashed. Outline 1.5 px, other lines 0.85, at any size
// (non-scaling strokes). No people: the place stands for the goal. The drawing covers its slot as the
// photograph did, so the layout does not move: it is square, and everything that matters sits in its
// middle band, which is what a wide slot on a phone keeps.

const SIZE = 480;
const STROKE = { outline: 1.5, edge: 0.85 } as const;

type Pt = readonly [number, number];
const poly = (pts: readonly Pt[]) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

/**
 * A line drawn in the drawing's ink: an outline or an edge, solid or dashed (far, or a route). With
 * `fill` it is a shape in the card's colour with no line of its own: what stands in front and hides.
 */
function Ink({
  d,
  weight = 'edge',
  dash,
  fill = false,
  tone = 'line',
  part,
}: {
  d: string;
  weight?: keyof typeof STROKE;
  dash?: 'far' | 'route';
  fill?: boolean;
  tone?: 'line' | 'wood';
  part?: string;
}) {
  return (
    <path
      d={d}
      data-part={part ?? (dash ? dash : weight)}
      vectorEffect="non-scaling-stroke"
      fill={fill ? 'var(--card)' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={STROKE[weight]}
      strokeDasharray={dash === 'far' ? '4 3' : dash === 'route' ? '6 4' : undefined}
      className={cn(
        dash === 'far' && 'opacity-55',
        part === 'level' && 'opacity-40',
        tone === 'wood' && 'text-primary',
      )}
    />
  );
}

// --- Mariana: a coastline, calm and level. The sea's horizon; a far headland, dashed; a middle cliff
// and the near ground, each with its face drawn in short falls; a route along the near ground, dashed
// like a path on a map, to a flag where the trip ends. ----------------------------------------------
const HORIZON = 168;
const MID_EDGE: Pt[] = [
  [0, 212],
  [60, 205],
  [130, 206],
  [190, 214],
  [236, 226],
  [258, 236],
];
const NEAR_EDGE: Pt[] = [
  [0, 318],
  [80, 306],
  [170, 304],
  [260, 314],
  [340, 332],
  [410, 350],
  [480, 360],
];
const ROUTE = 'M36 448C110 424 180 402 240 390S330 372 380 380';
const FLAG: Pt = [380, 380];

function Coast() {
  return (
    <>
      <Ink d={`M0 ${HORIZON}H480`} part="horizon" />
      <Ink d="M300 168C330 160 352 148 384 146S440 150 480 144" dash="far" part="far" />
      {[
        [300, 190, 40],
        [372, 202, 28],
        [330, 222, 54],
        [420, 232, 34],
        [290, 254, 24],
        [380, 262, 46],
        [452, 280, 22],
        [320, 290, 30],
      ].map(([x, y, w]) => (
        <Ink key={`${x}-${y}`} d={`M${x} ${y}h${w}`} dash="far" part="sea" />
      ))}
      {/* the middle cliff: its land, its edge, and the face falling to the sea */}
      <Ink d={`${poly(MID_EDGE)}L266 272L0 272Z`} fill part="cliff-land" />
      <Ink d={`${poly(MID_EDGE)}L266 272`} weight="outline" part="cliff" />
      <Ink d="M150 272H282" part="waterline" />
      {[
        [214, 220],
        [228, 225],
        [240, 230],
        [250, 233],
      ].map(([x, y]) => (
        <Ink key={x} d={`M${x} ${y}V272`} part="face" />
      ))}
      {/* the near ground and its edge, filled, so the sea stops behind it */}
      <Ink d={`${poly(NEAR_EDGE)}V480H0Z`} fill part="ground-land" />
      <Ink d={poly(NEAR_EDGE)} weight="outline" part="ground" />
      {[
        [424, 352],
        [446, 355],
        [466, 358],
      ].map(([x, y]) => (
        <Ink key={x} d={`M${x} ${y}v${30 + (x - 424) / 2}`} part="face" />
      ))}
      <Ink d={ROUTE} dash="route" tone="wood" part="route" />
      <g
        data-part="mark"
        className="text-primary"
        stroke="currentColor"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      >
        <circle cx={FLAG[0]} cy={FLAG[1]} r={4} fill="var(--card)" />
        <path
          d={`M${FLAG[0]} ${FLAG[1] - 4}V${FLAG[1] - 30}L${FLAG[0] + 15} ${FLAG[1] - 24}L${FLAG[0]} ${FLAG[1] - 18}`}
        />
      </g>
    </>
  );
}

// --- Diego: a ridge above the cloud, drawn as a survey: the ridge line, the far ridge dashed, levels
// across the mountain's face, the cloud filling the valley, and the summit marked as a target with its
// height held level to the edge of the page, as his goal line is drawn in the chart beside it. -------
const RIDGE: Pt[] = [
  [0, 286],
  [56, 252],
  [100, 262],
  [160, 204],
  [196, 216],
  [242, 162],
  [290, 118],
  [328, 160],
  [356, 150],
  [416, 210],
  [480, 236],
];
const SUMMIT: Pt = [290, 118];
const CLOUD_TOP =
  'M0 340C30 328 58 334 86 326S142 314 176 324S236 336 270 326S334 312 372 324S438 336 480 326';

function Ridge({ clip }: { clip: string }) {
  const mountain = `${poly(RIDGE)}V480H0Z`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <path d={mountain} />
        </clipPath>
      </defs>
      <Ink
        d={poly([
          [0, 196],
          [52, 176],
          [96, 186],
          [148, 152],
          [190, 166],
          [230, 140],
        ])}
        dash="far"
      />
      <Ink
        d={poly([
          [372, 166],
          [418, 150],
          [452, 170],
          [480, 162],
        ])}
        dash="far"
      />
      <Ink d={mountain} fill part="mountain" />
      <Ink d={poly(RIDGE)} weight="outline" part="ridge" />
      {/* levels across the face: the mountain's heights, as a surveyor draws them */}
      <g clipPath={`url(#${clip})`}>
        {[160, 200, 240, 280].map((y) => (
          <Ink
            key={y}
            d={`M0 ${y + 4}C80 ${y - 2} 160 ${y + 6} 240 ${y}S400 ${y - 4} 480 ${y + 3}`}
            part="level"
          />
        ))}
      </g>
      {/* the goal, held level from the summit to the page's edge */}
      <Ink d={`M${SUMMIT[0] + 16} ${SUMMIT[1]}H480`} dash="route" tone="wood" part="goal" />
      <Ink d={`${CLOUD_TOP}V480H0Z`} fill part="cloud-body" />
      <Ink d={CLOUD_TOP} part="cloud" />
      <Ink d="M0 372C60 364 120 372 180 366S300 360 360 368S440 374 480 366" dash="far" />
      <Ink d="M0 408C70 402 140 410 210 404S350 398 420 406S460 410 480 404" dash="far" />
      <g
        data-part="mark"
        className="text-primary"
        stroke="currentColor"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      >
        <circle cx={SUMMIT[0]} cy={SUMMIT[1]} r={8} fill="var(--card)" />
        <path
          d={`M${SUMMIT[0] - 14} ${SUMMIT[1]}H${SUMMIT[0] + 14}M${SUMMIT[0]} ${SUMMIT[1] - 14}V${SUMMIT[1] + 14}`}
        />
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
  const clip = `tf-ridge-${useId().replace(/:/g, '')}`;
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
      {place === 'coast' ? <Coast /> : <Ridge clip={clip} />}
    </svg>
  );
}
