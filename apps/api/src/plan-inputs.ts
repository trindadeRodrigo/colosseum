import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { assets as assetsTable, riskPools, yieldObservations } from '@colosseum/db';
import { PERSONAL_PARAMS } from '@colosseum/engine/personal';
import { chainFamily, type YieldObservation } from '@colosseum/schemas';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { loadLiquidityProvider, RISK_METHOD_VERSION } from './liquidity';
import {
  asSandbox,
  exitTwins,
  isMeasured,
  issuerTwins,
  type RegistryAsset,
  shelfTiers,
  standIns,
  tierTwins,
  twinSource,
  twinSymbols,
} from './model-exits';
import { type ModelReading, modelledTokens, modelYields } from './model-yields';
import type { PlanInputs } from './orders/personalize';

// What the server hands `POST /v1/baskets/personalize` (gate EXIT-SOURCE): Bearing's measured sell
// depth and the stored yields, for the tokens of the person's chain. Both are matched by the token's
// address, so a token is measured only under its own mint. A test-network token that models a mainnet
// token takes that token's stored reading (model-yields.ts) and its measured sell depth (model-exits.ts),
// both labelled sandbox. A token with neither (the mock, or a model Bearing does not measure) takes its
// tier's ceiling and says so.
//
// Outside the /v1 route table: it reads the risk layer's calendar from a file and its switch from the
// environment, which no file the /v1 routes reach may do (apps/api/src/orders/orders.test.ts).

const ROOT = process.env.REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');
const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T;
  } catch {
    return null;
  }
};
/**
 * The mainnet tokens' tiers, copied from the launch shelf (a proposal, Oct 1), the one place that gives
 * syrupUSDC and jlUSDC a tier. A stand-in whose model Bearing does not measure takes its model's from
 * it; without the file it keeps its own (C on a test network).
 */
type TierFile = {
  source: string;
  fetchedAt: string;
  rows: Array<{ chain: string; symbol: string; tier: string; issuer?: string }>;
};
const TIER_FILE = readJson<TierFile>('fixtures/risk/launch-shelf-tiers.json');
const SHELF = TIER_FILE ? shelfTiers(TIER_FILE) : [];
/** The xStocks' mints by symbol (the Solana price index): a Solana stand-in's twin is pinned by mint. */
const SCOPE = readJson<{ assets: Array<{ symbol: string; mint: string }> }>(
  'fixtures/solana-vault/scope-indexes.json',
);

export const BEARING_SOURCE = `Bearing: sell-side depth measured on chain (risk_depth_curves, ${RISK_METHOD_VERSION})`;

export const bearingPlanInputs: PlanInputs = async ({ db, chain, assets, provenance }) => {
  const addresses = assets.filter((a) => a.cls !== 'cash').map((a) => a.address);
  if (!addresses.length) return {};
  // On a chain that runs as a test network, a test-network token reads the depth of the mainnet token it
  // models (model-exits.ts); every other token reads its own.
  const tokens = standIns(assets, provenance);
  const names = [...new Set(tokens.flatMap(twinSymbols))];
  const lower = names.map((n) => n.toLowerCase());
  // Solana's stocks are in Bearing's pool registry; the EVM stocks have no pool rows there (PLAN-UNIVERSE
  // RU.14, DU6) and are found by their seeded `assets` rows, under the collector's spelling.
  // The pool registry is Solana's; an EVM stock's chain is the prefix of its seeded row's id.
  const registry: RegistryAsset[] = lower.length
    ? [
        ...(SCOPE?.assets ?? [])
          .filter((a) => names.includes(a.symbol))
          .map((a) => ({
            chain: 'solana',
            assetSymbol: a.symbol,
            assetMint: a.mint,
            tvlUsd: null,
            pinned: true,
          })),
        ...(
          await db
            .select({
              assetSymbol: riskPools.assetSymbol,
              assetMint: riskPools.assetMint,
              tvlUsd: riskPools.tvlUsd,
            })
            .from(riskPools)
            .where(inArray(sql`lower(${riskPools.assetSymbol})`, lower))
        ).map((r) => ({ ...r, chain: 'solana' })),
        ...(
          await db
            .select({
              id: assetsTable.id,
              assetSymbol: assetsTable.symbol,
              assetMint: assetsTable.mint,
            })
            .from(assetsTable)
            .where(
              and(eq(assetsTable.chain, 'evm'), inArray(sql`lower(${assetsTable.symbol})`, lower)),
            )
        ).flatMap((r) =>
          r.assetMint
            ? [
                {
                  chain: r.id.split(':')[0] as string,
                  assetSymbol: r.assetSymbol,
                  assetMint: r.assetMint,
                  tvlUsd: null,
                },
              ]
            : [],
        ),
      ]
    : [];
  const twins = exitTwins(tokens, registry);
  const twinOf = new Map(twins.map((t) => [t.id, t.twinMint]));
  const loaded = await loadLiquidityProvider(
    db,
    assets.map((a) => ({ id: a.id, mint: twinOf.get(a.id) ?? a.address })),
  );
  const read = twins.filter((t) => loaded?.covers(t.id));
  const measured = (id: string) => isMeasured(loaded, id, PERSONAL_PARAMS.tau, EXIT_WINDOW_DAYS);
  const tiers = tierTwins(
    tokens.filter((t) => !measured(t.id)),
    SHELF,
  ).map((t) => ({
    assetId: t.id,
    tier: t.tier,
    source: `tier ${t.tier} of ${t.twinSymbol} on mainnet (${TIER_FILE?.source}), applied to the test-network token ${t.symbol}`,
    method: 'the launch shelf tier of the token it models; its exit is not measured',
    fetchedAt: TIER_FILE?.fetchedAt ?? '',
    provenance: 'sandbox' as const,
  }));
  const issuers = issuerTwins(tokens, SHELF).map((t) => ({
    assetId: t.id,
    issuer: t.issuer,
    of: t.twinSymbol,
  }));
  const provider = loaded && read.length ? asSandbox(loaded) : loaded;
  const source = read.length ? twinSource(BEARING_SOURCE, read) : BEARING_SOURCE;
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
  const modelled = modelledTokens(assets, own, provenance);
  const models = [...new Set(modelled.map((a) => a.underlying))];
  const modelRows = models.length
    ? await db
        .select({ y: yieldObservations, symbol: assetsTable.symbol, id: assetsTable.id })
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
      // the table names the family; an EVM row's chain is the prefix of its id (`robinhood:sgov`)
      modelRows.map(
        ({ y, symbol, id }): ModelReading => ({
          symbol,
          chain: chainFamily(chain) === 'evm' ? (id.split(':')[0] as string) : 'solana',
          reading: reading(y, y.assetId),
        }),
      ),
    ),
  ];
  return {
    ...(provider ? { liquidity: { provider, source } } : {}),
    ...(yields.length ? { yields } : {}),
    ...(tiers.length ? { tiers } : {}),
    ...(issuers.length ? { issuers } : {}),
  };
};
