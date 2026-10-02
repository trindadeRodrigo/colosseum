# DATA-MODEL.md

Postgres, Drizzle ORM. 23 tables in two schema files: `packages/db/src/schema.ts` (the structurer, 15 tables) and `packages/db/src/risk-schema.ts` (the risk layer, 8 tables). Migrations in `packages/db/migrations/`: `0000`–`0001` create the structurer tables, `0002`–`0005` the risk tables. Enums are declared in `schema.ts`, mirror `packages/schemas/src/enums.ts`, and `tests/db-schema.test.ts` keeps them in sync (all but `chain`, which it does not check).

"Provenance columns" below means the four columns `source`, `method`, `fetched_at`, `provenance`. `provenance` is the enum `live`, `mock`, `sandbox`, `fixture`, `prior_dataset`.

## Structurer tables (`schema.ts`)

All have a uuid `id` primary key except `assets`, whose `id` is text.

| Table | One line | Key columns |
|---|---|---|
| `goals` | The goal text as typed, its language and the wallet that typed it. | `raw_text`, `language`, `wallet`, `created_at` |
| `constraint_sheets` | Each parsed or user-edited `ConstraintSheet` for a goal, with `valid` and validation errors; origin `llm`, `user_edit` or `fixture`. | `goal_id` → `goals`, `sheet`, `valid`, `validation_errors`, `origin`, `model` |
| `assets` | The registry: kind (`usd_yield`, `brl_stable`, `cash`, `equity`), chain, mint, token program, eligible profiles, cap weight, mint path and static metadata (oracle, redemption, gates, issuer). No yield numbers. | `id`, `symbol`, `name`, `kind`, `chain`, `mint`, `token_program`, `decimals`, `eligible_profiles`, `cap_weight`, `mint_path`, `metadata`, `provenance`, `updated_at` |
| `yield_observations` | Every yield figure ever used: quoted, haircut and the haircut rule id. | `asset_id` → `assets`, `quoted_yield`, `haircut_yield`, `haircut_rule`, provenance columns |
| `fx_observations` | USD/BRL, Selic and CDI observations. | `pair`, `value`, provenance columns |
| `depth_observations` | Jupiter quote depth by asset, side and notional (price impact, out amount, route); the xStocks weekend cron lands here. | `asset_id` → `assets`, `side`, `notional_usd`, `price_impact_pct`, `out_amount`, `route`, provenance columns |
| `plans` | A solved plan for one constraint sheet: profile, capital, solver version, binding constraints, disclaimer. | `goal_id` → `goals`, `constraint_sheet_id` → `constraint_sheets`, `profile`, `capital_usd`, `wallet`, `solver_version`, `binding_constraints`, `disclaimer` |
| `plan_legs` | Weight, USD amount and reasoning per leg, linked to the yield observation it was priced on. | `plan_id` → `plans`, `asset_id` → `assets`, `weight`, `amount_usd`, `reasoning`, `yield_observation_id` → `yield_observations` |
| `schedules` | Month-by-month BRL rows for the base case and each stress, with the liquidity check result. | `plan_id` → `plans`, `case_id` (`base` or a stress id), `rows`, `liquidity_ok`, `fx_observation_id` → `fx_observations` |
| `stress_cases` | Stress definitions (params) and outcomes per plan. | `plan_id` → `plans`, `stress_id`, `name`, `params`, `liquidity_ok`, `summary` |
| `risk_sheets` | The risk sheet entry for one plan and asset as rendered at plan time (frozen JSON). | `plan_id` → `plans`, `asset_id` → `assets`, `entry` |
| `policies` | Allowed assets, weight bands, trigger, withdrawal destination and mechanism (`delegated` or `user_signed`), with a per-asset mechanism override and the delegation record. | `plan_id` → `plans`, `wallet`, `allowed_assets`, `bands`, `trigger`, `withdrawal_destination`, `mechanism`, `mechanism_by_asset`, `delegation` |
| `positions` | Observed on-chain balances per wallet and asset. | `wallet`, `asset_id` → `assets`, `amount`, `value_usd`, `observed_at`, `source` |
| `executions` | Every transaction built or sent: kind, status, signature, explorer link, amounts. | `plan_id` → `plans`, `plan_leg_id` → `plan_legs`, `wallet`, `chain`, `kind`, `asset_id` → `assets`, `signature`, `explorer_url`, `status`, `error`, `amount_in`, `amount_out`, `provenance`, `confirmed_at` |
| `rebalances` | A policy decision (trigger reason, proposed orders, mechanism) linked to the execution that carried it out. | `policy_id` → `policies`, `trigger_reason`, `proposed`, `mechanism`, `execution_id` → `executions` |

## Risk tables (`risk-schema.ts`)

No uuid ids here: the primary key is the pool address or a composite, shown in the last column. Measures are `double precision`, raw on-chain amounts (`active_liquidity`, `amount_in`, `out_amount`) are text, and curves are JSON. The only foreign key is `risk_pool_snapshots.pool` → `risk_pools.address`; the other `pool`, `ref_pool` and `asset_mint` columns are plain text.

| Table | One line | Key columns |
|---|---|---|
| `risk_pools` | Every DEX pool that trades an xStock, confirmed on-chain, with its refresh tier. | PK `address`; `program`, `venue`, `asset_mint`, `asset_symbol`, `quote_mint`, `quote_symbol`, `exit_path` (`direct_usd`, `via_sol`, `via_xstock`, `other`), `asset_is_token0`, `decimals0`, `decimals1`, `transfer_fee_bps0`, `transfer_fee_bps1`, `tvl_usd`, `discovery_liquidity_usd`, `discovery_volume24h_usd`, `tier` (`A` every 5 min, `B` hourly, `X` excluded), `status`, `status_reason`, `method_version`, provenance columns |
| `risk_pool_snapshots` | One simulated depth snapshot of one pool: mid price, active liquidity, sell and buy curves. | PK (`pool`, `fetched_at`); `slot`, `mid_price`, `active_liquidity`, `sell`, `buy`, `in_band_liquidity`, `method_version`, provenance columns |
| `risk_depth_curves` | The fitted depth curve per asset, side and regime, versioned by method. | PK (`asset_mint`, `side`, `regime`, `method_version`); `asset_symbol`, `points`, `insufficient_from`, `quantile`, `min_samples`, `samples`, `data_from`, `data_to`, `computed_at`, `source`, `method`, `provenance` |
| `risk_events` | Collector events: LP withdrawals near the price, stale tick maps. | PK (`pool`, `kind`, `fetched_at`); `slot`, `asset`, `detail` |
| `risk_lp_concentration` | Hourly LP concentration per pool and the LP-exit stress curve. | PK (`pool`, `fetched_at`); `asset`, `positions`, `in_band_positions`, `top1`, `top3`, `top10`, `holder_kind`, `band_pct`, `lp_exit_n`, `sell_base`, `sell_without_top_n`, `method_version`, provenance columns |
| `risk_quotes` | Jupiter quote cross-checks, routes kept, for the routing gap against pool simulation. | PK (`run_id`, `asset_mint`, `side`, `notional_usd`); `asset`, `amount_in`, `out_amount`, `route`, `error`, provenance columns (`source` and `method` nullable) |
| `risk_asset_snapshots` | Routed (multi-pool) sell and buy curves per asset, one row per collector run. | PK (`asset_mint`, `fetched_at`); `asset`, `slot`, `ref_pool`, `ref_mid_usd`, `pools`, `sell`, `buy`, `method_version`, provenance columns |
| `risk_market_params` | Lending-market parameters per reserve or vault: decoded on-chain where possible, else from the protocol API. | PK (`account`, `fetched_at`); `venue`, `market`, `asset_mint`, `asset`, `borrow_asset`, `is_xstock`, `params`, `totals`, `verification` (`onchain` or `api`), `slot`, provenance columns |
| `risk_price_observations` | The oracle standard's inputs (PLAN-RISK Step 11): one price of one asset from one price source at one time. | PK (`price_source`, `ref`, `mint`, `observed_at`, `slot`, `price`); `price_source` (`pool_mid`, `kamino_scope`, `jupiter_lend_oracle`, `external:<name>`), `quote` (`usd` or a mint), `market`, `live` (false while a stock oracle held a placeholder price), `failed_checks` (the venue's own checks the price failed, comma-separated), `source_ts`, `market_status`, `chain`, `method_version`, provenance columns |
| `risk_reference_prices` | The reference price per asset and hour: the resolver's valuation with its source, age, regime and quality; the newest row of an asset is its live reference price. | PK (`mint`, `observed_at`, `method_version`); `symbol`, `price_usd` (null with `null_reason`), `price_source`, `ref`, `quality` (`traded`, `oracle_open`, `oracle_closed`, `oracle_continuous`, `external`, `par`), `regime`, `age_sec`, `price_observed_at`, `others` (every other source's price at that hour with its gap), `chain`, provenance columns |

## Provenance

Provenance rule: any row that is not `live` (`mock`, `sandbox`, `fixture`, `prior_dataset`) must be labelled wherever it renders.

Which tables carry what:

| Columns | Tables |
|---|---|
| All four (`source`, `method`, `fetched_at`, `provenance`) | `yield_observations`, `fx_observations`, `depth_observations`, `risk_pools`, `risk_pool_snapshots`, `risk_lp_concentration`, `risk_asset_snapshots`, `risk_market_params`, `risk_price_observations`, `risk_reference_prices`, `risk_quotes` (`source` and `method` nullable) |
| `source`, `method`, `provenance`, with `computed_at` in place of `fetched_at` | `risk_depth_curves` |
| `provenance` only | `assets`, `executions` |
| `source` and `observed_at` only | `positions` |
| `fetched_at` only | `risk_events` |

`method_version` is on `risk_pools`, `risk_pool_snapshots`, `risk_depth_curves`, `risk_lp_concentration`, `risk_asset_snapshots`, `risk_price_observations` and `risk_reference_prices`. It is not on `risk_events`, `risk_quotes` or `risk_market_params`.

## Notes for code

- `createDb` in `packages/db/src/index.ts` registers only `schema.ts` with Drizzle, so `db.query.*` covers the 15 structurer tables. Risk tables are exported from `@colosseum/db` and read with `db.select().from(riskPools)` and the like.
- `tests/db-schema.test.ts` asserts the 15 structurer tables by name. No test asserts the list of risk tables.
- `risk_pools.asset_is_token0` and `risk_market_params.is_xstock` are integers used as flags, not booleans. `risk_price_observations.live` is a boolean.
- The price parameters behind a `risk_reference_prices.method_version` (source order, sessions, age limits) are in `data/risk/prices/import-runs.jsonl`, one line per import, not on the rows.
