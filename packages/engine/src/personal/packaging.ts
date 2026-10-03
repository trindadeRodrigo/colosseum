import { FlattenError, flattenReport } from '@colosseum/basket';
import type { BasketAsset, BasketLine, Component, Reason, Recipe } from '@colosseum/schemas';
import { BPS, byName, largestFirst, shareOf, split, sum, toUsd } from './money';
import { type Book, once } from './placement';
import { reason } from './templates';
import { type PersonalProposal, SLEEVES, type Sleeve } from './types';
import type { World } from './world';

// Packaging: the plan as lines, and the one recipe a vault on the person's chain can take.
//
// A line's dollars are what placement gave it, to the cent, and the lines add up to the amount. The
// recipe is those lines in whole basis points of the amount, which is the deposit. Its targets add up
// to at most 10,000: what it leaves out is cash. A shared portfolio held whole stays one component,
// and `flatten` of packages/basket is what opens it into the lines.

type Row = {
  asset: BasketAsset;
  cents: number;
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

/**
 * The lines as components, with the shared portfolios in `whole` kept as one component each. Returns
 * null when `flatten` would not give back exactly these lines.
 */
function componentsOf(w: World, rows: Row[], cash: number, whole: string[]): Component[] | null {
  const entries: {
    component: { kind: 'index'; family: string } | { kind: 'asset'; asset: string };
    cents: number;
  }[] = [];
  for (const slug of whole)
    entries.push({
      component: { kind: 'index', family: slug },
      cents: sum(rows.map((row) => row.via.get(slug) ?? 0)),
    });
  for (const row of rows) {
    const direct = row.cents - sum(whole.map((slug) => row.via.get(slug) ?? 0));
    if (direct > 0)
      entries.push({ component: { kind: 'asset', asset: row.asset.id }, cents: direct });
  }
  const weights = split(BPS, [...entries.map((e) => e.cents), cash]);
  const components = entries.flatMap((e, i): Component[] => {
    const weightBps = weights[i] ?? 0;
    return weightBps > 0 ? [{ ...e.component, weightBps }] : [];
  });
  if (components.length === 0) return rows.length === 0 ? [] : null;
  try {
    const report = flattenReport(asRecipe(w, components), w.shelf, {
      minLineBps: w.P.minLineBps,
      maxLines: w.P.maxLinesPerChain,
    });
    const targets = report.targets.map((t) => t.asset).sort();
    const lines = rows.map((row) => row.asset.id).sort();
    if (report.dropped.length > 0 || targets.join() !== lines.join()) return null;
  } catch (error) {
    if (error instanceof FlattenError) return null;
    throw error;
  }
  return largestFirst(components, (c) => c.weightBps, keyOf);
}

export function packageUp(w: World, book: Book): Packaged {
  const { P, lang } = w;
  const rows: Row[] = byName(
    [...book.lines.values()].filter((line) => line.cents > 0),
    (line) => line.asset.id,
  ).map((line) => ({ ...line, sleeve: w.sleeveOf(line.asset) }));
  const cash = book.cash.cents;

  // One recipe: the plan lives on one chain, and the amount is the deposit.
  const whole = [...new Set(rows.flatMap((row) => [...row.via.keys()]))].sort();
  const opened = new Set<string>();
  let components = componentsOf(w, rows, cash, whole);
  if (components === null) {
    // Whole basis points would lose a line of a shared portfolio: hold its parts one by one.
    for (const slug of whole) opened.add(slug);
    components = componentsOf(w, rows, cash, []);
  }
  if (components === null) throw new Error('the plan cannot be written as targets a vault takes');
  const recipes: Packaged['recipes'] = [{ chain: w.chain, amountUsd: toUsd(w.amount), components }];

  if (cash > 0)
    rows.push({
      asset: w.cash,
      cents: cash,
      reasons: [...book.cash.reasons],
      sleeve: 'cash',
      via: new Map(),
    });

  // Shares of the plan: each sleeve to whole basis points first, then each line within its sleeve, so
  // a sleeve's lines add up to the sleeve.
  const inSleeve = (sleeve: Sleeve) =>
    largestFirst(
      rows.filter((row) => row.sleeve === sleeve),
      (row) => row.cents,
      (row) => row.asset.id,
    );
  const sleeveCents = SLEEVES.map((sleeve) => sum(inSleeve(sleeve).map((row) => row.cents)));
  const sleeveBps = split(BPS, sleeveCents);

  const lines: BasketLine[] = [];
  SLEEVES.forEach((sleeve, at) => {
    const members = inSleeve(sleeve);
    const shares = split(
      sleeveBps[at] ?? 0,
      members.map((row) => row.cents),
    );
    members.forEach((row, i) => {
      const followed = [...row.via.entries()].filter(([slug]) => !opened.has(slug));
      const [only] = followed;
      const viaIndex = followed.length === 1 && only && only[1] === row.cents ? only[0] : undefined;
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
      // Stocks, crypto and gold: no return assumed, and what a fall would cost.
      if (sleeve === 'growth' || sleeve === 'gold')
        reasons.push(
          reason(
            'NO_RETURN_ASSUMED',
            { fallBps: P.fallBps, lossUsd: toUsd(shareOf(row.cents, P.fallBps)) },
            lang,
          ),
        );
      lines.push({
        chain: row.asset.chain,
        assetId: row.asset.id,
        ...(viaIndex === undefined ? {} : { viaIndex }),
        weightBps: shares[i] ?? 0,
        amountUsd: toUsd(row.cents),
        reasons: once(reasons),
      });
    });
  });

  return {
    lines,
    recipes,
    sleeves: SLEEVES.map((sleeve, at) => ({
      sleeve,
      weightBps: sleeveBps[at] ?? 0,
      amountUsd: toUsd(sleeveCents[at] ?? 0),
    })),
  };
}
