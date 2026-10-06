// The banded fill (gate SOLVER, Oct 5): how money is shared among assets ranked by yield, with no
// linear program. Assets are sorted by yield after haircut, highest first, ties by id. A band is the
// run of assets whose yield is within `band` of the band's top: yields that close cannot be told
// apart, so the band is filled equally, each asset up to its own room and its groups' room (an
// issuer, the credit budget), and what one asset cannot take goes to the others in the band. Only
// when a band is full does the next band get anything.
//
// Pure and in whole units (cents): the same inputs give the same output, whatever order they came in.
// With `band` at zero this is the greedy fill that the note shows equal to the old linear program on
// nested caps (docs/vault/research/portfolio-method.md section 2.3, change C1).

export type FillItem = {
  id: string;
  /** Yield after haircut, as a fraction. Null when nothing was read: the asset is left out, never counted as zero. */
  yield: number | null;
  /** The most units this asset may take, from its own limits. */
  room: number;
  /** The groups this asset counts against, by key of `groupRoom`. */
  groups: string[];
};

export type FillInput = {
  amount: number;
  items: FillItem[];
  /** Units each group may still take. A group with no entry has no limit. */
  groupRoom: Record<string, number>;
  /** Yields within this of a band's top share the band (a fraction: 0.005 is half a point). */
  band: number;
};

/** What stopped an asset: its own room, or a group by its key. Null when it was not stopped. */
export type Bound = { by: 'own' } | { by: 'group'; group: string } | null;

export type FillResult = {
  /** Units each asset takes, by id; only assets that take more than zero. */
  take: Map<string, number>;
  /** What no asset could take. */
  left: number;
  /** Assets left out because no yield was read for them, by id. */
  noYield: string[];
  /** For each asset that was offered money, what stopped it short of more. */
  bound: Map<string, Bound>;
  /** The bands as they were filled, each a list of ids, highest yield first. */
  bands: string[][];
};

/** Assets in rank order: yield after haircut, highest first, then id. */
export function rank<T extends { id: string; yield: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.yield - a.yield || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Splits ranked assets into bands: each starts at the highest yield left and takes all within `band` of it. */
export function bandsOf<T extends { id: string; yield: number }>(ranked: T[], band: number): T[][] {
  const out: T[][] = [];
  for (const item of ranked) {
    const current = out.at(-1);
    const top = current?.[0];
    // A yield on the edge is inside it: a band is not split by the rounding of a subtraction.
    const edge = Number.EPSILON * (Math.abs(top?.yield ?? 0) + Math.abs(item.yield) + band);
    if (current && top && top.yield - item.yield - band <= edge) current.push(item);
    else out.push([item]);
  }
  return out;
}

const finite = (y: number | null): y is number => y !== null && Number.isFinite(y);

export function bandedFill(input: FillInput): FillResult {
  if (!Number.isSafeInteger(input.amount) || input.amount < 0)
    throw new Error('bandedFill: the amount is a whole, non-negative number of units');
  if (!(input.band >= 0)) throw new Error('bandedFill: the band is zero or more');
  const noYield = input.items
    .filter((i) => !finite(i.yield))
    .map((i) => i.id)
    .sort();
  const ranked = rank(
    input.items.filter((i) => finite(i.yield)).map((i) => ({ ...i, yield: i.yield as number })),
  );
  const room = new Map(ranked.map((i) => [i.id, Math.max(0, Math.floor(i.room))]));
  const groupRoom = new Map(
    Object.entries(input.groupRoom).map(([k, v]) => [k, Math.max(0, Math.floor(v))]),
  );
  const take = new Map<string, number>();
  const bound = new Map<string, Bound>();
  const bands = bandsOf(ranked, input.band);
  let left = input.amount;

  /** What stops an asset now, or null when it can still take. */
  const stopped = (i: FillItem): Bound => {
    if ((room.get(i.id) ?? 0) <= 0) return { by: 'own' };
    for (const g of [...i.groups].sort())
      if (groupRoom.has(g) && (groupRoom.get(g) ?? 0) <= 0) return { by: 'group', group: g };
    return null;
  };
  const give = (i: FillItem, units: number) => {
    take.set(i.id, (take.get(i.id) ?? 0) + units);
    room.set(i.id, (room.get(i.id) ?? 0) - units);
    for (const g of i.groups)
      if (groupRoom.has(g)) groupRoom.set(g, (groupRoom.get(g) ?? 0) - units);
    left -= units;
  };

  for (const band of bands) {
    if (left <= 0) break;
    // Water-filling: every asset of the band that can still take gets the same step, the largest
    // step no asset or group overruns. Leftover units under one per asset go one each, by rank.
    for (;;) {
      for (const i of band) {
        const why = stopped(i);
        if (why && !bound.has(i.id)) bound.set(i.id, why);
      }
      const active = band.filter((i) => stopped(i) === null);
      if (left <= 0 || active.length === 0) break;
      let step = Math.floor(left / active.length);
      for (const i of active) step = Math.min(step, room.get(i.id) ?? 0);
      const inGroup = new Map<string, number>();
      for (const i of active)
        for (const g of i.groups) if (groupRoom.has(g)) inGroup.set(g, (inGroup.get(g) ?? 0) + 1);
      for (const [g, n] of inGroup) step = Math.min(step, Math.floor((groupRoom.get(g) ?? 0) / n));
      if (step > 0) {
        for (const i of active) give(i, step);
        continue;
      }
      // Fewer units than assets, or a group with less room than members: one unit each, in rank order.
      for (const i of active) if (left > 0 && stopped(i) === null) give(i, 1);
    }
    for (const i of band) if (!bound.has(i.id)) bound.set(i.id, stopped(i));
  }
  for (const [id, units] of take) if (units <= 0) take.delete(id);
  return { take, left, noYield, bound, bands: bands.map((b) => b.map((i) => i.id)) };
}
