import { mockAssets } from '@colosseum/chain-mock';
import { createDb } from '@colosseum/db';
import {
  type ComposeContext,
  type ShelfLabel,
  type ShelfPortfolio,
  type StockAttributesFile,
  shelfLabelsOf,
} from '@colosseum/engine/personal';
import type { ChainId, FxObservation, Shelf } from '@colosseum/schemas';
import { shelfVersionOf } from '../../apps/api/src/orders/personalize';
import { loadFamilies } from '../../apps/api/src/orders/store';
import { BEARING_SOURCE, bearingPlanInputs } from '../../apps/api/src/plan-inputs';
import { loadStockAttributes } from '../../apps/api/src/stock-attributes';
import { loadThemeLists } from '../../apps/api/src/theme-lists';
import {
  extendedHeldOut,
  extendedShelf,
  extendedYields,
  fixtureLiquidity,
  fixtureYields,
  LIQUIDITY_SOURCE,
  launchShelf,
  usdBrl,
} from '../../packages/engine/src/personal/testing';

// Where the playground's figures come from. Two modes, each reusing what already exists:
// - `fixtures`: the engine's own test data (packages/engine/src/personal/testing.ts): the launch shelf,
//   the fixture yields and exit capacities, and one fixture rate of dollars into reais. Every figure is
//   a fixture, written by hand, and the report plates all of it MOCK.
// - `db`: the local database, read the way the API reads it: the mock chain's tokens (what the API
//   lists when a chain runs on the mock), the shared portfolios in effect (`loadFamilies`), and
//   Bearing's measured exit and the stored yields (`bearingPlanInputs`). Each figure keeps its own
//   provenance; the API reads no exchange rate yet, and neither does this mode.
// Theme lists come from `content/themes/<chain>/` and the stock attributes from
// `content/stocks/<chain>.json`, through the API's loaders in both modes. The attributes are sourced
// facts about listed securities, not figures: each row names where it was read.
//
// In `fixtures` mode the shelf is one of two: `launch`, the launch shelf, or `extended`, the launch
// shelf plus the fixed-income tokens screened in docs/vault/research/yield-shelf/ with their dated
// yield claims (fixtures/shelves/, fixtures/yields-extended.json). Both are fixtures, plated MOCK.

export type DataMode = 'fixtures' | 'db';
export type ShelfName = 'launch' | 'extended';
/** A token the shelf lists and no plan holds yet, with the reason its row gives. */
export type LeftOffPlans = { symbol: string; reason: string };

/** What a plan on one chain is made from, besides the time and the person's holdings. */
export type ChainData = {
  shelf: Shelf;
  portfolios: ShelfPortfolio[];
  /** The curated stock labels of the chain, each with how many of its names the shelf lists (gate THEMES). */
  labels: ShelfLabel[];
  /** The sourced attributes of the chain's tracked stocks (gate THEME-MATCHED); null where it has none. */
  stocks: StockAttributesFile | null;
  context: Omit<ComposeContext, 'now' | 'holdings' | 'fx'>;
  /** Exchange rates, handed in only to a goal that needs one. */
  fx: FxObservation[];
  /** Where the shelf and the figures come from, in words. */
  sources: string[];
  /** What the shelf lists on this chain and leaves out of every plan. */
  heldOut: LeftOffPlans[];
};

export type DataSource = {
  mode: DataMode;
  forChain(chain: ChainId): Promise<ChainData>;
  close(): Promise<void>;
};

/** The shelf of one chain only: its tokens, and the shared portfolios with a recipe there. */
function shelfOn(shelf: Shelf, chain: ChainId): Shelf {
  const families = shelf.families
    .filter((f) => f.recipes.some((r) => r.chain === chain))
    .map((f) => ({ ...f, recipes: f.recipes.filter((r) => r.chain === chain) }));
  return {
    version: `${shelf.version}:${chain}`,
    assets: shelf.assets.filter((a) => a.chain === chain),
    families,
  };
}

/** Where the stock attributes of a chain come from, in words. */
const stocksSource = (chain: ChainId, stocks: StockAttributesFile | null): string =>
  stocks
    ? `Stock attributes: content/stocks/${chain}.json (version ${stocks.version}, read ${stocks.readOn}, ${stocks.stocks.length} rows, each with its sources)`
    : `Stock attributes: none for ${chain}, so no theme can be matched by a filter there`;

const portfoliosOf = (shelf: Shelf): ShelfPortfolio[] =>
  shelf.families.map((f) => ({ slug: f.meta.slug, name: f.meta.name }));

export function fixturesSource(shelfName: ShelfName = 'launch'): DataSource {
  const extended = shelfName === 'extended';
  return {
    mode: 'fixtures',
    async forChain(chain) {
      const shelf = shelfOn(extended ? extendedShelf() : launchShelf(), chain);
      const themes = loadThemeLists(chain);
      const stocks = loadStockAttributes(chain);
      const heldOut = extended
        ? extendedHeldOut(chain).map((row) => ({
            symbol: row.asset.symbol,
            reason: row.heldOut ?? '',
          }))
        : [];
      return {
        shelf,
        portfolios: portfoliosOf(shelf),
        labels: shelfLabelsOf(themes, shelf.assets),
        stocks,
        context: {
          yields: extended ? extendedYields() : fixtureYields(),
          liquidity: fixtureLiquidity(),
          liquiditySource: LIQUIDITY_SOURCE,
          ...(themes.length ? { themes } : {}),
          ...(stocks ? { stocks } : {}),
        },
        fx: [usdBrl()],
        heldOut,
        sources: [
          extended
            ? `Shelf: the extended shelf (${shelf.version}), a fixture: the launch shelf and ${
                chain === 'solana' || chain === 'robinhood'
                  ? `the fixed-income tokens of docs/vault/research/yield-shelf/${chain}.md`
                  : 'no token added on this chain'
              }`
            : `Shelf: the launch shelf (${shelf.version}), a fixture`,
          extended
            ? 'Yields: packages/engine/src/personal/fixtures/yields.json, written by hand, and fixtures/yields-extended.json, dated claims from the research notes, not readings (MOCK)'
            : 'Yields: packages/engine/src/personal/fixtures/yields.json, written by hand (MOCK)',
          `Exit: ${LIQUIDITY_SOURCE} (MOCK)`,
          'FX: one fixture rate of dollars into reais (MOCK)',
          `Theme lists: content/themes/${chain}/ (${themes.map((t) => `${t.slug} ${t.status}`).join(', ') || 'none'})`,
          stocksSource(chain, stocks),
        ],
      };
    },
    async close() {},
  };
}

/** The local database, read as the API reads it. `DATABASE_URL` from the environment, else the local default. */
export function dbSource(): DataSource {
  const { db, client } = createDb();
  return {
    mode: 'db',
    async forChain(chain) {
      const assets = mockAssets(chain);
      const families = await loadFamilies(db, chain);
      const shelf: Shelf = { version: shelfVersionOf(chain, assets, families), assets, families };
      const figures = await bearingPlanInputs({ db, chain, assets });
      return {
        shelf,
        portfolios: portfoliosOf(shelf),
        labels: shelfLabelsOf(figures.themes ?? [], shelf.assets),
        stocks: figures.stocks ?? null,
        context: {
          ...(figures.yields ? { yields: figures.yields } : {}),
          ...(figures.themes ? { themes: figures.themes } : {}),
          ...(figures.stocks ? { stocks: figures.stocks } : {}),
          ...(figures.liquidity
            ? { liquidity: figures.liquidity.provider, liquiditySource: figures.liquidity.source }
            : {}),
        },
        fx: [],
        heldOut: [],
        sources: [
          `Shelf: the mock chain's tokens for ${chain} (packages/chain-mock, MOCK) and the shared portfolios in effect in the database (${families.length})`,
          `Yields: the stored readings of those tokens (${figures.yields?.length ?? 0}), each with its own provenance`,
          figures.liquidity
            ? `Exit: ${BEARING_SOURCE}`
            : 'Exit: nothing measured for these tokens; each line takes its tier ceiling, labelled a fallback',
          'FX: none (the API reads no exchange rate yet)',
          `Theme lists: content/themes/${chain}/ (${figures.themes?.map((t) => `${t.slug} ${t.status}`).join(', ') || 'none'})`,
          stocksSource(chain, figures.stocks ?? null),
        ],
      };
    },
    async close() {
      await client.end();
    },
  };
}
