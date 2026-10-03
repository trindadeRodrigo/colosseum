import { FlattenError, flattenReport } from '@colosseum/basket';
import type { BasketAsset, BasketLine, Component, Reason, Recipe } from '@colosseum/schemas';
import { BPS, byName, largestFirst, shareOf, shareOfUp, split, sum, toUsd } from './money';
import { type Book, once } from './placement';
import { reason } from './templates';
import { type PersonalProposal, SLEEVES, type Sleeve } from './types';
import type { World } from './world';

// Packaging: the plan as lines, and the one recipe a vault on the person's chain can take.
//
// The recipe is the lines: each line's share of the plan, in whole basis points, is its target, and
// the amount is the deposit. Targets add up to at most 10,000; what they leave out is cash. A shared
// portfolio held whole stays one component, and `flatten` of packages/basket is what opens it into
// the lines. A target is never more than its token's ceiling: where whole basis points would round
// one over, the basis point stays in cash, and the cash line says so.

type Row = {
  asset: BasketAsset;
  cents: number;
  bps: number;
  reasons: Reason[];
  sleeve: Sleeve;
  via: Map<string, number>;
};

export type Packaged = Pick<PersonalProposal, 'lines' | 'recipes' | 'sleeves'>;

/** A family id and a meta hash are 32 bytes in hex. A personal recipe has neither: all zeros. */
const NO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** The components as the `Recipe` that `flatten` reads. Only the chain and the components count. */
function asRecipe(w: World, components: Component[]): Recipe {
  return {
    schemaVersion: 1,
    familyId: NO_HASH,
    chain: w.chain,
    onchainId: null,
    creator: w.cash.address,
    kind: 'personal',
    version: 1,
    effectiveAt: 0,
    components,
    metaHash: NO_HASH,
    maxFeeBps: 0,
    flags: 0,
  };
}

const keyOf = (c: Component) => (c.kind === 'asset' ? c.asset : `index:${c.family}`);

/** The most basis points of the plan a token's ceiling allows, rounded down. */
const limitOf = (w: World, asset: BasketAsset) => Math.floor((w.ceilingOf(asset) * BPS) / w.amount);

/**
 * The lines as components, with the shared portfolios in `whole` kept as one component each, and the
 * targets `flatten` opens them into. Null when it would not give back exactly these lines, or would
 * put a target over its token's ceiling: the caller then holds those portfolios part by part.
 */
function componentsOf(
  w: World,
  rows: Row[],
  whole: string[],
): { components: Component[]; targets: Map<string, number> } | null {
  const components: Component[] = [];
  const through = new Map<string, number>();
  for (const row of rows) {
    // A line's basis points, split between what each shared portfolio feeds it and what is its own.
    const fed = whole.map((slug) => row.via.get(slug) ?? 0);
    const own = row.cents - sum(fed);
    const shares = split(row.bps, [...fed, own]);
    whole.forEach((slug, i) => {
      through.set(slug, (through.get(slug) ?? 0) + (shares[i] ?? 0));
    });
    const direct = shares[whole.length] ?? 0;
    if (direct > 0) components.push({ kind: 'asset', asset: row.asset.id, weightBps: direct });
  }
  for (const slug of whole) {
    const weightBps = through.get(slug) ?? 0;
    if (weightBps > 0) components.push({ kind: 'index', family: slug, weightBps });
  }
  const targets = new Map<string, number>();
  if (components.length === 0) return rows.length === 0 ? { components, targets } : null;
  try {
    const report = flattenReport(asRecipe(w, components), w.shelf, {
      minLineBps: w.P.minLineBps,
      maxLines: w.P.maxLinesPerChain,
    });
    if (report.dropped.length > 0) return null;
    for (const t of report.targets) targets.set(t.asset, t.weightBps);
  } catch (error) {
    if (error instanceof FlattenError) return null;
    throw error;
  }
  const same = rows.length === targets.size && rows.every((row) => targets.has(row.asset.id));
  const within = rows.every((row) => (targets.get(row.asset.id) ?? 0) <= limitOf(w, row.asset));
  if (!same || !within) return null;
  return { components: largestFirst(components, (c) => c.weightBps, keyOf), targets };
}

export function packageUp(w: World, book: Book): Packaged {
  const { P, lang } = w;
  const rows: Row[] = byName(
    [...book.lines.values()].filter((line) => line.cents > 0),
    (line) => line.asset.id,
  ).map((line) => ({ ...line, bps: 0, sleeve: w.sleeveOf(line.asset) }));
  const cash: Row = {
    asset: w.cash,
    cents: book.cash.cents,
    bps: 0,
    reasons: [...book.cash.reasons],
    sleeve: 'cash',
    via: new Map(),
  };
  const all = [...rows, cash];
  const inSleeve = (sleeve: Sleeve) =>
    largestFirst(
      all.filter((row) => row.sleeve === sleeve),
      (row) => row.cents,
      (row) => row.asset.id,
    );

  // Shares of the plan: each sleeve to whole basis points first, then each line within its sleeve, so
  // a sleeve's lines add up to the sleeve.
  const sleeveBps = split(
    BPS,
    SLEEVES.map((sleeve) => sum(inSleeve(sleeve).map((row) => row.cents))),
  );
  const least = Math.max(1, P.minLineBps);
  SLEEVES.forEach((sleeve, at) => {
    const members = inSleeve(sleeve);
    const shares = split(
      sleeveBps[at] ?? 0,
      members.map((row) => row.cents),
    );
    members.forEach((row, i) => {
      row.bps = shares[i] ?? 0;
    });
    // A line is at least the least a target can be. Rounding within a sleeve can leave one a basis
    // point short: the largest line of the sleeve gives it.
    const [largest] = members;
    for (const row of members)
      if (largest && row !== cash && row !== largest && row.bps < least) {
        largest.bps -= least - row.bps;
        row.bps = least;
      }
  });

  // A target is never more than its token's ceiling. Where whole basis points round one over, the
  // difference stays in cash.
  for (const row of rows) {
    const limit = limitOf(w, row.asset);
    const over = row.bps - limit;
    if (over <= 0) continue;
    // The line's dollars come down to what its target is worth, and no further.
    const moved = Math.max(0, row.cents - shareOf(w.amount, limit));
    row.bps -= over;
    row.cents -= moved;
    cash.bps += over;
    cash.cents += moved;
    cash.reasons.push(reason('ROUNDING', { bps: over, asset: row.asset.symbol }, lang));
  }

  // One recipe: the plan lives on one chain, and the amount is the deposit. A shared portfolio stays
  // one component when `flatten` gives back these lines from it; otherwise its parts are held one by
  // one, and its lines say they no longer follow it.
  const whole = [...new Set(rows.flatMap((row) => [...row.via.keys()]))].sort();
  const opened = new Set<string>();
  let packed = componentsOf(w, rows, whole);
  if (packed === null) {
    for (const slug of whole) opened.add(slug);
    packed = componentsOf(w, rows, []);
  }
  if (packed === null) throw new Error('the plan cannot be written as targets a vault takes');
  // Opening a shared portfolio into whole basis points can move one between its own lines.
  for (const row of rows) row.bps = packed.targets.get(row.asset.id) ?? row.bps;

  const lines: BasketLine[] = [];
  for (const sleeve of SLEEVES)
    for (const row of largestFirst(
      all.filter((r) => r.sleeve === sleeve && (r.cents > 0 || r.bps > 0)),
      (r) => r.bps,
      (r) => r.asset.id,
    )) {
      const followed = [...row.via.entries()].filter(([slug]) => !opened.has(slug));
      const [only] = followed;
      const viaIndex =
        followed.length === 1 &&
        only &&
        sum([...row.via.values()]) === only[1] &&
        row.via.size === 1
          ? only[0]
          : undefined;
      const reasons = row.reasons.flatMap((r) => {
        // A portfolio opened here no longer follows its updates, and the line says so.
        const slug =
          r.rule === 'FOLLOWS'
            ? [...row.via.keys()].find(
                (s) => opened.has(s) && w.families.get(s)?.meta.name === r.params.theme,
              )
            : undefined;
        return slug ? [reason('OPENED', { theme: String(r.params.theme) }, lang)] : [r];
      });
      // Where the line's limit came from, when it is not a measurement of the whole week.
      if (row !== cash) reasons.push(...w.ceilingNotes(row.asset));
      // Stocks, crypto and gold: no return assumed, and what a fall would cost.
      if (sleeve === 'growth' || sleeve === 'gold')
        reasons.push(
          reason(
            'NO_RETURN_ASSUMED',
            { fallBps: P.fallBps, lossUsd: toUsd(shareOfUp(row.cents, P.fallBps)) },
            lang,
          ),
        );
      lines.push({
        chain: row.asset.chain,
        assetId: row.asset.id,
        ...(viaIndex === undefined ? {} : { viaIndex }),
        weightBps: row.bps,
        amountUsd: toUsd(row.cents),
        reasons: once(reasons),
      });
    }

  return {
    lines,
    recipes: [{ chain: w.chain, amountUsd: toUsd(w.amount), components: packed.components }],
    sleeves: SLEEVES.map((sleeve) => {
      const members = all.filter((row) => row.sleeve === sleeve);
      return {
        sleeve,
        weightBps: sum(members.map((row) => row.bps)),
        amountUsd: toUsd(sum(members.map((row) => row.cents))),
      };
    }),
  };
}
