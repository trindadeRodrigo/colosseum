import { assets as assetsTable, yieldObservations } from '@colosseum/db';
import type { YieldObservation } from '@colosseum/schemas';
import { desc, eq, inArray } from 'drizzle-orm';
import { loadLiquidityProvider, RISK_METHOD_VERSION } from './liquidity';
import type { PlanInputs } from './orders/personalize';
import { loadStockAttributes } from './stock-attributes';
import { loadThemeLists } from './theme-lists';

// What the server hands `POST /v1/baskets/personalize` (gate EXIT-SOURCE): Bearing's measured sell
// depth and the stored yields, for the tokens of the person's chain, and the curated theme lists of
// that chain (gate THEMES, `content/themes/<chain>/`). Both are matched by the token's
// address, so a token is measured only under its own mint. A token on a test network or the mock has
// no measurement under its address: its line takes its tier's ceiling and says so.
//
// And the sourced attributes of the stocks tracked on that chain (gate THEME-MATCHED,
// `content/stocks/<chain>.json`), which a theme sleeve filled by a filter reads. A chain with no
// such file hands none: a matched theme then holds no stock, and the plan says so.
//
// Outside the /v1 route table: it reads the risk layer's calendar from a file and its switch from the
// environment, which no file the /v1 routes reach may do (apps/api/src/orders/orders.test.ts).

export const BEARING_SOURCE = `Bearing: sell-side depth measured on chain (risk_depth_curves, ${RISK_METHOD_VERSION})`;

export const bearingPlanInputs: PlanInputs = async ({ db, chain, assets }) => {
  const lists = loadThemeLists(chain);
  const stocks = loadStockAttributes(chain);
  // What is read from `content/`: the theme lists and the stock attributes of the chain.
  const content = { ...(lists.length ? { themes: lists } : {}), ...(stocks ? { stocks } : {}) };
  const addresses = assets.filter((a) => a.cls !== 'cash').map((a) => a.address);
  if (!addresses.length) return content;
  const provider = await loadLiquidityProvider(
    db,
    assets.map((a) => ({ id: a.id, mint: a.address })),
  );
  const idOf = new Map(assets.map((a) => [a.address, a.id]));
  const rows = await db
    .select({ y: yieldObservations, mint: assetsTable.mint })
    .from(yieldObservations)
    .innerJoin(assetsTable, eq(yieldObservations.assetId, assetsTable.id))
    .where(inArray(assetsTable.mint, addresses))
    .orderBy(desc(yieldObservations.fetchedAt))
    .limit(200);
  const yields = rows.flatMap(({ y, mint }): YieldObservation[] => {
    const assetId = mint ? idOf.get(mint) : undefined;
    return assetId
      ? [
          {
            assetId,
            quotedYield: Number(y.quotedYield),
            haircutYield: Number(y.haircutYield),
            haircutRule: y.haircutRule,
            source: y.source,
            method: y.method,
            fetchedAt: y.fetchedAt.toISOString(),
            provenance: y.provenance,
          },
        ]
      : [];
  });
  return {
    ...(provider ? { liquidity: { provider, source: BEARING_SOURCE } } : {}),
    ...(yields.length ? { yields } : {}),
    ...content,
  };
};
