import { assets as assetsTable, yieldObservations } from '@colosseum/db';
import { chainFamily, type YieldObservation } from '@colosseum/schemas';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { loadLiquidityProvider, RISK_METHOD_VERSION } from './liquidity';
import { type ModelReading, modelledTokens, modelYields } from './model-yields';
import type { PlanInputs } from './orders/personalize';
import { loadThemeLists } from './theme-lists';

// What the server hands `POST /v1/baskets/personalize` (gate EXIT-SOURCE): Bearing's measured sell
// depth and the stored yields, for the tokens of the person's chain, and the curated theme lists of
// that chain (gate THEMES, `content/themes/<chain>/`). Both are matched by the token's
// address, so a token is measured only under its own mint. A token on a test network or the mock has
// no measurement under its address: its line takes its tier's ceiling and says so. A test-network token
// that models a mainnet token takes that token's stored reading, labelled sandbox (model-yields.ts).
//
// Outside the /v1 route table: it reads the risk layer's calendar from a file and its switch from the
// environment, which no file the /v1 routes reach may do (apps/api/src/orders/orders.test.ts).

export const BEARING_SOURCE = `Bearing: sell-side depth measured on chain (risk_depth_curves, ${RISK_METHOD_VERSION})`;

export const bearingPlanInputs: PlanInputs = async ({ db, chain, assets }) => {
  const lists = loadThemeLists(chain);
  const themes = lists.length ? { themes: lists } : {};
  const addresses = assets.filter((a) => a.cls !== 'cash').map((a) => a.address);
  if (!addresses.length) return themes;
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
  const reading = (
    y: typeof yieldObservations.$inferSelect,
    assetId: string,
  ): YieldObservation => ({
    assetId,
    quotedYield: Number(y.quotedYield),
    haircutYield: Number(y.haircutYield),
    haircutRule: y.haircutRule,
    source: y.source,
    method: y.method,
    fetchedAt: y.fetchedAt.toISOString(),
    provenance: y.provenance,
  });
  const own = rows.flatMap(({ y, mint }) => {
    const assetId = mint ? idOf.get(mint) : undefined;
    return assetId ? [reading(y, assetId)] : [];
  });
  // The live readings of the mainnet tokens the test-network tokens model, found by the model's symbol
  // (each token's `underlying`) on the same family of chains: on EVM that is any EVM chain, since the
  // assets table names the family and not the chain.
  const modelled = modelledTokens(assets, own);
  const models = [...new Set(modelled.map((a) => a.underlying))];
  const modelRows = models.length
    ? await db
        .select({ y: yieldObservations, symbol: assetsTable.symbol })
        .from(yieldObservations)
        .innerJoin(assetsTable, eq(yieldObservations.assetId, assetsTable.id))
        .where(
          and(
            inArray(assetsTable.symbol, models),
            eq(assetsTable.chain, chainFamily(chain)),
            eq(yieldObservations.provenance, 'live'),
          ),
        )
        .orderBy(desc(yieldObservations.fetchedAt))
        .limit(200)
    : [];
  const yields = [
    ...own,
    ...modelYields(
      modelled,
      modelRows.map(({ y, symbol }): ModelReading => ({ symbol, reading: reading(y, y.assetId) })),
    ),
  ];
  return {
    ...(provider ? { liquidity: { provider, source: BEARING_SOURCE } } : {}),
    ...(yields.length ? { yields } : {}),
    ...themes,
  };
};
