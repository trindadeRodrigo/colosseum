// The arithmetic of the Bearing heatmap tile (HeatmapTile.tsx), in a plain module so it is tested
// alone and a server component may call it: the ramp step of a value and the words for an hour.

export type HeatCell = {
  /** 0 is Monday. */
  day: number;
  /** 0 to 23. */
  hour: number;
  value: number;
  samples: number;
};

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const HOURS = Array.from({ length: 24 }, (_, h) => h);
export const hh = (h: number) => String(h).padStart(2, '0');

/** The ramp step of each value, 1 (least depth) to 5 (most): quintiles of the values shown. */
export function heatLevels(
  values: readonly number[],
  deeper: 'high' | 'low',
): (v: number) => number {
  const sorted = values.slice().sort((a, b) => a - b);
  const q = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
  const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
  return (v) => {
    let b = 0;
    while (b < 4 && v > (cuts[b] as number)) b++;
    // b is 0 for the lowest fifth, 4 for the highest
    return deeper === 'high' ? b + 1 : 5 - b;
  };
}

/** A cell's accessible name, and the readout's words for it. */
export function heatName(
  day: number,
  hour: number,
  zone: string,
  cell: HeatCell | undefined,
  fmt: (v: number) => string,
  what: string,
): string {
  const when = `${DAYS[day]} ${hh(hour)}:00 ${zone}`;
  return cell ? `${when} · ${fmt(cell.value)} ${what} · n=${cell.samples}` : `${when} · no sample`;
}

/** The hour alone, as the readout starts it: "Sun 03:00 UTC". */
export const heatWhen = (how: number, zone: string) =>
  `${DAYS[Math.floor(how / 24)]} ${hh(how % 24)}:00 ${zone}`;
