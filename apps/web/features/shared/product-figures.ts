import type {
  AssetClass,
  HoldingFigures,
  Provenance,
  SharedRecipe,
  Sourced,
} from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';
import type { Dictionary } from '../../i18n';
import { formatBps } from '../order/amounts';
import { displayName } from '../order/plain';

// A shared portfolio as figures (gate PRODUCTS-PLAN-PANE): what its card and its page say of its
// holdings. Every figure is the server's (`recipe.figures`: the stored yield and Bearing's measured
// exit, the readings a plan is made from) and is handed on with its source to its pin. Nothing is
// worked out here and nothing is added up across holdings: a holding the server has no reading for
// says so, and is never shown as zero. A yield of the whole portfolio is the engine's to work out, as
// for a plan's card, and it has no entry that takes a recipe yet: none is shown.

/** A figure's source as its pin takes it. */
export const pinOf = (s: Sourced): PinSource => ({
  source: s.source,
  fetchedAt: s.fetchedAt,
  method: s.method,
  provenance: s.provenance,
  staleAgeSec: null,
});

/** A share of a year as a percentage: 0.0312 is "3.12%". */
export const rate = (fraction: number, locale: string) =>
  formatBps(Math.round(fraction * 10_000), locale);

/** One holding of a product, as the plan pane shows a row. */
export type ProductHolding = {
  /** The asset's id, or the mint of a token this app does not list. */
  asset: string;
  name: string;
  shareBps: number;
  cls: AssetClass | null;
  /**
   * The holding's own stored reading, as shares of a year: after the haircut, and as quoted. Null
   * where it pays no yield, or the server has no reading of it.
   */
  yield: { afterHaircut: number; quoted: number; obs: PinSource } | null;
  exit: (NonNullable<HoldingFigures['exit']> & { obs: PinSource }) | null;
  /** One sentence: what it is. */
  why: string;
  /** Not live: the label of the chain, or of a figure on the row. */
  provenance: Provenance;
};

const worst = (a: Provenance, b: Provenance): Provenance =>
  a === 'live' ? b : b === 'live' || a === b ? a : 'mock';

/**
 * The rows of a version: each component with the server's figures for that token, matched by its id.
 * `components` are the ones shown (the chain's where this app read them), so a token the server
 * measured nothing for, or one this app does not list (`mint`), still has its row.
 */
export function holdingsOf(
  recipe: Pick<SharedRecipe, 'figures' | 'provenance'>,
  components: readonly { asset: string; weightBps: number; mint?: string }[],
  t: Dictionary,
): ProductHolding[] {
  const words = t.shared.product;
  return components.map((c) => {
    const figure = c.mint ? undefined : recipe.figures?.holdings.find((h) => h.asset === c.asset);
    const cls = figure?.cls ?? null;
    return {
      asset: c.asset,
      name: c.mint ? c.mint : displayName(c.asset, t.plan),
      shareBps: c.weightBps,
      cls,
      yield: figure?.yield
        ? {
            afterHaircut: figure.yield.afterHaircut,
            quoted: figure.yield.quoted,
            obs: pinOf(figure.yield),
          }
        : null,
      exit: figure?.exit ? { ...figure.exit, obs: pinOf(figure.exit) } : null,
      why: c.mint ? words.why.unknown : cls ? words.why[cls] : words.why.unread,
      provenance: [figure?.yield?.provenance, figure?.exit?.provenance].reduce<Provenance>(
        (label, p) => (p ? worst(label, p) : label),
        recipe.provenance,
      ),
    };
  });
}

/** The share of each kind of asset, largest first: "Stocks 50%", "Dollar yield 30%". */
export function kindShares(
  holdings: readonly Pick<ProductHolding, 'cls' | 'shareBps'>[],
  locale: string,
  kinds: Dictionary['plan']['kinds'],
): string[] {
  const shares = new Map<string, number>();
  for (const h of holdings) {
    const key = h.cls ?? 'other';
    shares.set(key, (shares.get(key) ?? 0) + h.shareBps);
  }
  return [...shares]
    .sort((a, b) => b[1] - a[1])
    .map(([key, bps]) => `${kinds[key as keyof typeof kinds]} ${formatBps(bps, locale)}`);
}
