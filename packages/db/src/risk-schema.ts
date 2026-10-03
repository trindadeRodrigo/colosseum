import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { provenanceEnum } from './schema';

// Risk layer tables (branch risk-layer). Kept apart from schema.ts so the structurer's schema and its
// tests are untouched. Every computed row carries method_version plus source / method / fetched_at.
const ts = (name: string) => timestamp(name, { withTimezone: true });
const provenanceCols = {
  source: text('source').notNull(),
  method: text('method').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
};

/** Every DEX pool that trades an xStock, confirmed on-chain, with its refresh tier. */
export const riskPools = pgTable(
  'risk_pools',
  {
    address: text('address').primaryKey(),
    program: text('program').notNull(),
    venue: text('venue').notNull(),
    assetMint: text('asset_mint').notNull(),
    assetSymbol: text('asset_symbol').notNull(),
    quoteMint: text('quote_mint').notNull(),
    quoteSymbol: text('quote_symbol'),
    /** direct_usd (USDC/USDT), via_sol, via_xstock, other: how a seller reaches dollars through this pool. */
    exitPath: text('exit_path').notNull(),
    assetIsToken0: integer('asset_is_token0').notNull(),
    decimals0: integer('decimals0').notNull(),
    decimals1: integer('decimals1').notNull(),
    transferFeeBps0: integer('transfer_fee_bps0').notNull().default(0),
    transferFeeBps1: integer('transfer_fee_bps1').notNull().default(0),
    /** Pool TVL in USD measured on-chain from vault balances at registry build time. */
    tvlUsd: doublePrecision('tvl_usd'),
    discoveryLiquidityUsd: doublePrecision('discovery_liquidity_usd'),
    discoveryVolume24hUsd: doublePrecision('discovery_volume24h_usd'),
    /** A = refreshed every 5 min (pools holding the top share of TVL), B = hourly, X = excluded. */
    tier: text('tier').notNull(),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [index('risk_pools_asset_idx').on(t.assetMint), index('risk_pools_tier_idx').on(t.tier)],
);

/** One simulated depth snapshot of one pool: price, active liquidity, sell and buy curves. */
export const riskPoolSnapshots = pgTable(
  'risk_pool_snapshots',
  {
    pool: text('pool')
      .notNull()
      .references(() => riskPools.address),
    fetchedAt: ts('fetched_at').notNull(),
    slot: doublePrecision('slot'),
    /** Mid price of the asset in the quote token (UI units). */
    midPrice: doublePrecision('mid_price').notNull(),
    activeLiquidity: text('active_liquidity'),
    /** [{notionalUsd, out, costPct, unfilledShare}] for selling the asset into the quote token. */
    sell: jsonb('sell').notNull(),
    buy: jsonb('buy').notNull(),
    /** Liquidity within ±band of price, for LP-withdrawal detection. */
    inBandLiquidity: doublePrecision('in_band_liquidity'),
    methodVersion: text('method_version').notNull(),
    source: text('source').notNull(),
    method: text('method').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pool, t.fetchedAt] })],
);

/** Fitted sell/buy depth curve per asset, side and regime (packages/risk fitCurve), versioned. */
export const riskDepthCurves = pgTable(
  'risk_depth_curves',
  {
    assetMint: text('asset_mint').notNull(),
    assetSymbol: text('asset_symbol').notNull(),
    side: text('side').notNull(),
    regime: text('regime').notNull(),
    /** [{notionalUsd, cost, samples}] after isotonic fit; cost is a fraction. */
    points: jsonb('points').notNull(),
    insufficientFrom: integer('insufficient_from'),
    quantile: doublePrecision('quantile').notNull(),
    minSamples: integer('min_samples').notNull(),
    samples: integer('samples').notNull(),
    dataFrom: ts('data_from'),
    dataTo: ts('data_to'),
    computedAt: ts('computed_at').notNull(),
    methodVersion: text('method_version').notNull(),
    source: text('source').notNull(),
    method: text('method').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.assetMint, t.side, t.regime, t.methodVersion] })],
);

/** Collector events: LP withdrawals near the price, stale tick maps. */
export const riskEvents = pgTable(
  'risk_events',
  {
    pool: text('pool').notNull(),
    kind: text('kind').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    slot: doublePrecision('slot'),
    asset: text('asset'),
    detail: jsonb('detail').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pool, t.kind, t.fetchedAt] })],
);

/** Hourly LP concentration per pool and the LP-exit stress curve. */
export const riskLpConcentration = pgTable(
  'risk_lp_concentration',
  {
    pool: text('pool').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    asset: text('asset').notNull(),
    positions: integer('positions').notNull(),
    inBandPositions: integer('in_band_positions').notNull(),
    top1: doublePrecision('top1').notNull(),
    top3: doublePrecision('top3').notNull(),
    top10: doublePrecision('top10').notNull(),
    holderKind: text('holder_kind').notNull(),
    bandPct: doublePrecision('band_pct').notNull(),
    lpExitN: integer('lp_exit_n').notNull(),
    sellBase: jsonb('sell_base'),
    sellWithoutTopN: jsonb('sell_without_top_n'),
    methodVersion: text('method_version').notNull(),
    source: text('source').notNull(),
    method: text('method').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pool, t.fetchedAt] })],
);

/** Jupiter quote cross-checks (routes kept) for the routing gap against pool simulation. */
export const riskQuotes = pgTable(
  'risk_quotes',
  {
    runId: text('run_id').notNull(),
    assetMint: text('asset_mint').notNull(),
    asset: text('asset').notNull(),
    side: text('side').notNull(),
    notionalUsd: doublePrecision('notional_usd').notNull(),
    amountIn: text('amount_in'),
    outAmount: text('out_amount'),
    route: jsonb('route'),
    error: text('error'),
    fetchedAt: ts('fetched_at').notNull(),
    source: text('source'),
    method: text('method'),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.assetMint, t.side, t.notionalUsd] })],
);

/** Routed (multi-pool) asset-level sell/buy curves per collector run. */
export const riskAssetSnapshots = pgTable(
  'risk_asset_snapshots',
  {
    assetMint: text('asset_mint').notNull(),
    asset: text('asset').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    slot: doublePrecision('slot'),
    refPool: text('ref_pool').notNull(),
    refMidUsd: doublePrecision('ref_mid_usd').notNull(),
    pools: integer('pools').notNull(),
    sell: jsonb('sell').notNull(),
    buy: jsonb('buy').notNull(),
    methodVersion: text('method_version').notNull(),
    source: text('source').notNull(),
    method: text('method').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.assetMint, t.fetchedAt] })],
);

/** Lending-market parameters per reserve / vault: on-chain decoded where possible, else protocol API. */
export const riskMarketParams = pgTable(
  'risk_market_params',
  {
    venue: text('venue').notNull(),
    market: text('market').notNull(),
    account: text('account').notNull(),
    assetMint: text('asset_mint'),
    asset: text('asset').notNull(),
    borrowAsset: text('borrow_asset'),
    isXStock: integer('is_xstock').notNull(),
    /** Normalised: ltv, liquidationThreshold (fractions), liquidationBonus (fraction), plus raw fields. */
    params: jsonb('params').notNull(),
    /** Supply / borrow totals as reported (API), for market-level aggregates. */
    totals: jsonb('totals'),
    /** 'onchain' when decoded from account bytes and matched; 'api' when only the protocol API is available. */
    verification: text('verification').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    slot: doublePrecision('slot'),
    source: text('source').notNull(),
    method: text('method').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.fetchedAt] })],
);

/**
 * Lending pools (Step 10b): one row per Kamino reserve, Jupiter Lend vault, or curated vault that supplies into a
 * registered reserve, confirmed on-chain. `role`: collateral | debt (a reserve lenders supply into) | vault
 * (a Jupiter Lend vault: one collateral, one debt token) | curated_vault. `offered` is false for curated vaults
 * (founder D15, 2026-10-01) and null where no product decision applies yet. No wallet or position data here.
 */
export const riskLendingPools = pgTable(
  'risk_lending_pools',
  {
    account: text('account').primaryKey(),
    chain: text('chain').notNull(),
    venue: text('venue').notNull(),
    program: text('program').notNull(),
    market: text('market').notNull(),
    marketName: text('market_name'),
    role: text('role').notNull(),
    mint: text('mint').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    /** Jupiter Lend vaults: the debt token. */
    debtMint: text('debt_mint'),
    debtSymbol: text('debt_symbol'),
    /** The DEX-registry asset this row's stock maps to (risk_pools.asset_mint), when it is an xStock. */
    dexAssetMint: text('dex_asset_mint'),
    /** Vault token accounts, cToken mint, vault state and liquidity-layer position accounts. */
    accounts: jsonb('accounts').notNull(),
    /** Oracle accounts (Scope feed + chain; Jupiter Lend oracle + source caches). */
    oracles: jsonb('oracles').notNull(),
    /** Parameters at registry time (LTV, thresholds, caps), from the decoded account. */
    params: jsonb('params').notNull(),
    manager: text('manager'),
    offered: integer('offered'),
    firstTxAt: ts('first_tx_at'),
    /** 'onchain' when decoded from the account and checked against the SDK; 'api' when only the API is available. */
    verification: text('verification').notNull(),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    index('risk_lending_pools_market_idx').on(t.market),
    index('risk_lending_pools_dex_asset_idx').on(t.dexAssetMint),
  ],
);

/**
 * Lending state rows (Step 10b item 8): the collector's 5-minute on-chain rows (`kind` kamino_reserve | jl_vault |
 * jl_liquidity | kvault) and the reconstructed hourly history (`kind` kamino_reserve_hourly | jl_vault_hourly).
 * `observed_at` is the time the state refers to (the read, or the hour); `fetched_at` is when the row was made.
 * The full source row is kept in `detail`; it holds protocol accounts only, never a wallet or a position.
 */
export const riskLendingSnapshots = pgTable(
  'risk_lending_snapshots',
  {
    account: text('account').notNull(),
    observedAt: ts('observed_at').notNull(),
    kind: text('kind').notNull(),
    chain: text('chain').notNull(),
    venue: text('venue').notNull(),
    market: text('market').notNull(),
    symbol: text('symbol'),
    role: text('role'),
    slot: doublePrecision('slot'),
    /** Whole tokens. Curated vaults: supplied = assets under management, available = idle cash. */
    supplied: doublePrecision('supplied'),
    borrowed: doublePrecision('borrowed'),
    available: doublePrecision('available'),
    shareLentOut: doublePrecision('share_lent_out'),
    supplyApr: doublePrecision('supply_apr'),
    borrowApr: doublePrecision('borrow_apr'),
    supplyApy: doublePrecision('supply_apy'),
    borrowApy: doublePrecision('borrow_apy'),
    priceUsd: doublePrecision('price_usd'),
    suppliedUsd: doublePrecision('supplied_usd'),
    borrowedUsd: doublePrecision('borrowed_usd'),
    usdNullReason: text('usd_null_reason'),
    detail: jsonb('detail').notNull(),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({ columns: [t.account, t.observedAt, t.kind] }),
    index('risk_lending_snapshots_market_idx').on(t.market, t.observedAt),
  ],
);

/**
 * Lending events from the decode pass of the complete history (Step 10b items 4–5): one row per lending instruction
 * that touches a registered reserve, vault or curated vault (refreshes and obligation bookkeeping are counted in the
 * decode pass, not stored), plus one row per configuration change with its old and new value. `pool` is the
 * risk_lending_pools account the event maps to. No owner, obligation, position or liquidator column: `detail`
 * keeps protocol accounts, amounts and arguments only (`scrubLendingPayload`).
 */
export const riskLendingEvents = pgTable(
  'risk_lending_events',
  {
    signature: text('signature').notNull(),
    /** Instruction path in the transaction (`2.1`), or `config:<target>:<param>:<n>` for a configuration change. */
    eventKey: text('event_key').notNull(),
    slot: doublePrecision('slot').notNull(),
    blockTime: ts('block_time').notNull(),
    chain: text('chain').notNull(),
    venue: text('venue').notNull(),
    program: text('program').notNull(),
    market: text('market'),
    pool: text('pool'),
    kind: text('kind').notNull(),
    ix: text('ix'),
    /** Program that invoked the instruction (a router, curated vault or liquidator program), when not top level. */
    caller: text('caller'),
    /** Flows on protocol token accounts, raw units: [{account, role, mint, delta}]. */
    flows: jsonb('flows').notNull(),
    detail: jsonb('detail').notNull(),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.eventKey] }),
    index('risk_lending_events_pool_idx').on(t.pool, t.blockTime),
    index('risk_lending_events_kind_idx').on(t.kind, t.blockTime),
  ],
);

/**
 * Hourly position aggregates per market and collateral asset (Step 10b item 8; D13): positions, collateral, debt,
 * LTV buckets and the share of the asset's collateral held by the largest 1, 3 and 10 positions. A position counts
 * under its dominant collateral asset by USD. No owner or position column, by design.
 */
export const riskLendingPositions = pgTable(
  'risk_lending_positions',
  {
    market: text('market').notNull(),
    collateralAsset: text('collateral_asset').notNull(),
    observedAt: ts('observed_at').notNull(),
    chain: text('chain').notNull(),
    venue: text('venue').notNull(),
    positions: integer('positions').notNull(),
    positionsWithDebt: integer('positions_with_debt'),
    /** Positions whose state is not known at this hour (Jupiter Lend positions in a liquidated branch). */
    positionsStateUnknown: integer('positions_state_unknown').notNull().default(0),
    collateralUnits: doublePrecision('collateral_units').notNull(),
    collateralUsd: doublePrecision('collateral_usd'),
    debtUsd: doublePrecision('debt_usd'),
    /** Debt in whole tokens by debt asset. */
    debtByAsset: jsonb('debt_by_asset'),
    ltvBucketsPct: jsonb('ltv_buckets_pct').notNull(),
    /** {label: {positions, collateralUnits, collateralUsd, debtUsd}}; labels `<=10` … `>100`. */
    buckets: jsonb('buckets').notNull(),
    ltvNull: integer('ltv_null').notNull(),
    ltvNullUnits: doublePrecision('ltv_null_units').notNull(),
    top1: doublePrecision('top1'),
    top3: doublePrecision('top3'),
    top10: doublePrecision('top10'),
    usdNullReason: text('usd_null_reason'),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({
      name: 'risk_lending_positions_pk',
      columns: [t.market, t.collateralAsset, t.observedAt, t.method],
    }),
  ],
);

/**
 * Price observations of the oracle standard (PLAN-RISK Step 11): one price of one asset from one price source at
 * one time. `price_source` is pool_mid | kamino_scope | jupiter_lend_oracle | external:<name>; `source` names the
 * data source, as on every table. `price` is per whole token in `quote` (`usd`, or the mint a lending oracle quotes
 * in). `live` is false while a stock oracle held a placeholder price, and `failed_checks` names the venue's own
 * checks a price failed: both are still the venue's price, never a valuation.
 */
export const riskPriceObservations = pgTable(
  'risk_price_observations',
  {
    chain: text('chain').notNull(),
    mint: text('mint').notNull(),
    priceSource: text('price_source').notNull(),
    observedAt: ts('observed_at').notNull(),
    /** 0 when the source reports no slot. */
    slot: doublePrecision('slot').notNull(),
    price: doublePrecision('price').notNull(),
    quote: text('quote').notNull(),
    /** Pool, Kamino reserve or Jupiter Lend vault the price came from. */
    ref: text('ref').notNull(),
    /** Lending market or vault, for a lending oracle. */
    market: text('market'),
    live: boolean('live').notNull().default(true),
    /** The venue's own checks the price failed when logged (klend: `twap`, `heuristic`), comma-separated. */
    failedChecks: text('failed_checks'),
    /** The source's own timestamp for the price, when it reports one. */
    sourceTs: ts('source_ts'),
    marketStatus: integer('market_status'),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({
      name: 'risk_price_observations_pk',
      columns: [t.priceSource, t.ref, t.mint, t.observedAt, t.slot, t.price],
    }),
    index('risk_price_observations_mint_idx').on(t.mint, t.priceSource, t.observedAt),
  ],
);

/**
 * The reference price per asset and hour (PLAN-RISK Step 11): the resolver's valuation, with the source it came
 * from, the observation's age, the regime and the quality (traded | oracle_open | oracle_closed |
 * oracle_continuous | external | par). `price_usd` is null with `null_reason` when no source had a usable price.
 * `others` keeps every other source's price at that hour with its gap to the answer, so the DEX price and each
 * venue's oracle price stay side by side. The newest row of an asset is its live reference price. The price
 * parameters of a `method_version` (order, sessions, limits) are in the import's run log, not on every row.
 */
export const riskReferencePrices = pgTable(
  'risk_reference_prices',
  {
    mint: text('mint').notNull(),
    observedAt: ts('observed_at').notNull(),
    chain: text('chain').notNull(),
    symbol: text('symbol'),
    priceUsd: doublePrecision('price_usd'),
    priceSource: text('price_source'),
    ref: text('ref'),
    quality: text('quality'),
    regime: text('regime').notNull(),
    /** Seconds between the observation used and the hour. */
    ageSec: doublePrecision('age_sec'),
    priceObservedAt: ts('price_observed_at'),
    nullReason: text('null_reason'),
    /** [{priceSource, price, quote, priceUsd, ref, ageSec, openAgeSec, sessionOpen, stale, live, gapToAnswer}] */
    others: jsonb('others').notNull(),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({
      name: 'risk_reference_prices_pk',
      columns: [t.mint, t.observedAt, t.methodVersion],
    }),
  ],
);

/**
 * LendingPoolFacts sheets built by the lending report (PLAN-ANALYTICS items 10–11): one row per lending pool and
 * report run, the sheet as the API serves it. Facts inside carry their own source and time; aggregates only (D13).
 */
export const riskLendingFacts = pgTable(
  'risk_lending_facts',
  {
    account: text('account').notNull(),
    /** The report run that built the sheet. */
    reportAt: ts('report_at').notNull(),
    chain: text('chain').notNull(),
    venue: text('venue').notNull(),
    market: text('market').notNull(),
    symbol: text('symbol').notNull(),
    sheet: jsonb('sheet').notNull(),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({
      name: 'risk_lending_facts_pk',
      columns: [t.account, t.reportAt, t.methodVersion],
    }),
  ],
);

/**
 * Liquidation coverage per report run, price gap and collateral asset (PLAN-ANALYTICS items 8 and 11): the earlier
 * ratio (sale cost ≤ the bonus) beside the ratio on the liquidator's margin. A ratio that is not measured is null
 * with its reason in `null_reason`, never zero.
 */
export const riskLendingCoverage = pgTable(
  'risk_lending_coverage',
  {
    reportAt: ts('report_at').notNull(),
    gapPct: doublePrecision('gap_pct').notNull(),
    asset: text('asset').notNull(),
    seizedUsd: doublePrecision('seized_usd').notNull(),
    earlierCapacityUsd: doublePrecision('earlier_capacity_usd'),
    earlierRegime: text('earlier_regime'),
    earlierRatio: doublePrecision('earlier_ratio'),
    capacityUsd: doublePrecision('capacity_usd'),
    regime: text('regime'),
    lowerBound: boolean('lower_bound'),
    derived: boolean('derived'),
    tau: doublePrecision('tau'),
    ratio: doublePrecision('ratio'),
    nullReason: text('null_reason'),
    limitingOracle: text('limiting_oracle'),
    regimesMissing: jsonb('regimes_missing').notNull(),
    positionsHour: text('positions_hour'),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [
    primaryKey({
      name: 'risk_lending_coverage_pk',
      columns: [t.reportAt, t.gapPct, t.asset, t.methodVersion],
    }),
  ],
);

/**
 * The network fee of real swap transactions (PLAN-ANALYTICS item 4): `meta.fee` (base plus priority fee, in
 * lamports) read from each confirmed swap the product sent (`executions`), with the SOL price when it was read.
 * The fact sheets give the median per swap. No wallet is stored.
 */
export const riskNetworkFees = pgTable('risk_network_fees', {
  signature: text('signature').primaryKey(),
  chain: text('chain').notNull(),
  /** Where the signature came from: `executions` (our own swaps). */
  origin: text('origin').notNull(),
  slot: doublePrecision('slot').notNull(),
  blockTime: ts('block_time').notNull(),
  feeLamports: doublePrecision('fee_lamports').notNull(),
  computeUnits: doublePrecision('compute_units'),
  solUsd: doublePrecision('sol_usd').notNull(),
  feeUsd: doublePrecision('fee_usd').notNull(),
  methodVersion: text('method_version').notNull(),
  ...provenanceCols,
});
