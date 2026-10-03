# HANDOFF: Liquidity & Risk Layer (Idea 2 folded into Idea 1)

*Written 2026-09-30. Companion to `docs/structurer/HANDOFF-IDEA1.md`. This file is the spec a planner needs to write the build plan for the risk layer. It assumes access to this repository.*

**Supporting files:** `docs/structurer/HANDOFF-IDEA1.md` (the structurer), `eval/briefs/SHARED-CONTEXT.md` §"Idea 2" (the original risk-engine concept), `eval/FEASIBILITY.md` §"Idea 2" (dependencies and half-day plan), `eval/IDEA2-MARKET.md` (evidence corrections, redemption rails, risk providers, EVM markets), `eval/FINAL.md` §6 (why Idea 1 won and the "cheap hedge" that already started), `docs/structurer/STATE.md`, `docs/GATES.md`, `docs/DATA-MODEL.md` (what exists today).

---

## 1. Where we are

The Idea 1 MVP exists in this repo (`main`, commits D1-AM through D6-PM plus parts of D7 and D9, all done on 2026-09-30). What runs today:

- Goal → typed `ConstraintSheet` → deterministic solver (rules + LP) → BRL schedule with stresses → per-leg risk sheet → real mainnet execution (Jupiter swaps, Kamino deposit, xStocks buys) → stored policy → one mainnet rebalance under the policy → monitoring page → three-endpoint API with OpenAPI → unbranded embed.
- Packages: `schemas`, `db` (Drizzle/Postgres, 15 tables), `engine`, `chain-solana`, `chain-evm` (stub). Apps: `api` (Fastify), `web` (Next.js). Tests in `tests/`.
- **A depth cron already runs** (`scripts/depth-snapshot.mjs`, launchd job `com.colosseum.depth-snapshot`, every 15 min, from `~/.colosseum/depth/`): Jupiter **buy-side** quotes at $50 / $500 / $5k / $50k for SPYx, QQQx, USDY, syrupUSDC. Rows land in `depth_observations` via `pnpm depth:import`. This is the seed of the risk layer. It must keep running untouched through Oct 12 (the weekend of Oct 3–4 cannot be re-collected).
- Hackathon constraints still apply to `main`: feature freeze Fri Oct 9 18:00 BRT, submission Oct 12. Remaining Idea 1 integrations (BRS via Nora, EVM adapter, second rebalance, deploy) are gated and tracked in `docs/GATES.md`; they are **not** part of this handoff.

## 2. What we are adding, in one paragraph

A **liquidity and risk layer** that answers, for any tokenized asset a user holds or a pool accepts as collateral: *how much of it can actually be turned into dollars, at what cost, at this hour of the week, through which path (DEX or issuer redemption), and does that cover what the holder needs to pay out?* It is built as an independent package and service, then wired into the structurer at four points: sizing (stock legs capped by measured exit capacity), scheduling (exit cost and a "liquidity dries up" stress), the risk sheet (a structured liquidity block per leg), and the policy (a liquidity-breach trigger that proposes a rebalance before the breach happens). The same service is exposed to third parties (lending markets, curators, issuers, other wallets) as an API and dashboard, and later underpins a lending product: supplying USDC to pools that take stocks as collateral, and assessing borrowing against stocks.

## 3. Product definition

### 3.1 Core quantities (all versioned, all with provenance)

1. **Depth curve.** For an asset, a side (**sell** is the one that matters for exit and liquidation; buy for entry sizing), and a time bucket: price impact and recoverable USDC as a function of notional, from Jupiter quotes at log-spaced notionals ($100 to $5M, ~8 points). Fitted (monotone, piecewise) with sample counts, so `impactAt(notional)`, `maxNotionalAt(impactTolerance)` and `recoverableValue(notional)` are cheap queries.
2. **Time-of-week profile.** Every observation is bucketed by hour-of-week and by regime: `us_market_hours`, `us_offhours_weekday`, `weekend`, `us_holiday`. Curves are aggregated per regime (and per hour-of-week when data allows). The weekend/weekday ratio per asset is a measured output, not an assumption.
3. **Primary-redemption overlay.** Per issuer: window (xStocks 24/5, Ondo 24/7 for six assets), minimum size, KYC requirement, settlement time, and a **capacity assumption that is a labelled scenario input** because issuers do not publish it. `primaryCapacity(issuer, at, horizonHours, notional)`.
4. **Recoverable value.** `recoverable(asset, notional, at, horizonHours)` = best of DEX path (from the curve for the buckets inside the horizon) and primary path (if the window opens inside the horizon and settlement fits), with the path and provenance returned. Saturday and Tuesday-11am give different numbers; the API shows both.
5. **Liquidity score.** Per asset and horizon: the fraction of a reference notional exitable within the horizon at ≤ τ impact, in the worst measured regime the horizon can contain. A number in [0,1] with the inputs beside it, and the regimes the curves do not measure named beside it; with no measured regime in the horizon it is `null`, never 0 (DA2, PLAN-ANALYTICS). No letter grades.
6. **Position assessment (liquidity breach).** For a set of positions plus a withdrawal schedule and a liquidity window: for each upcoming withdrawal, the amount that must come from illiquid legs after cash, BRL and liquid USD legs are used, versus exit capacity at τ in the worst bucket inside that withdrawal's window. `breach` if capacity < need in the base case; `likelyBreach` if it fails under the `liquidity_dry` stress (depth scaled by the measured weekend ratio, floored by a parameter). Output includes the months at risk, the shortfall, and recommended orders (illiquid → cash) sized to remove the breach.
7. **Lending-market view (Phase 4).** Per market and reserve that accepts tokenized stocks (Kamino xStocks reserves, Jupiter Lend vaults; Aave V4 Base Equities Hub as the EVM analog): parameters read on-chain (LTV, liquidation threshold, liquidation bonus, caps, oracle and price-band config), collateral supplied vs debt, recoverable collateral (from the curves) vs debt at the current hour and at the next reopen, and a gap simulator (`gapPct` input, close factor per docs). The dispersion table (Kamino 35–50% vs Jupiter Lend 75% vs Aave 65–79% on the same collateral) is a first-class output.

### 3.2 Consumers

| Consumer | What it gets | How |
|---|---|---|
| **The structurer (Idea 1)** | exit capacity for sizing, exit cost and dry stress for the schedule, liquidity block for the risk sheet, breach assessment for the policy | in-process through a `LiquidityProvider` interface (§5) |
| **Third parties** | curves, scores, recoverable value, market pages, position assessment | `/risk/*` HTTP API (OpenAPI) and a dashboard; no auth in the first cut |
| **Lending product (Phase 4)** | pool risk score that gates and haircuts "supply USDC against stock collateral" legs; borrow capacity and liquidation distance for users holding stocks | the same engine, new asset kinds and rules in the registry |

### 3.3 Honesty rules specific to this layer

- Depth measured in calm markets overstates depth in stress. Every curve carries its regime, sample count and date range. The dashboard says this in one line.
- Primary-redemption capacity is a scenario input, labelled `assumption`, never shown as measured.
- Jupiter quotes are executable-route quotes, not order-book depth. The methodology page says what a quote is and is not. Where a swap was actually executed (the `executions` table), realised slippage is compared with the quoted impact and reported.
- Published numbers are reflexive. The service publishes asset-level and market-level aggregates; it never publishes another wallet's positions.
- Nothing here is licensed advice or a rating. The existing `DISCLAIMER` constant applies to every risk page and API response.

## 4. Build shape: independent first, then joined

Build inside this monorepo, on a branch (`risk-layer`) off `main`, as new packages and a separately mountable API plugin. Do not merge into `main` before the hackathon submission (Oct 12) unless the founder decides otherwise. Do not modify `scripts/depth-snapshot.mjs`, its launchd job, or `~/.colosseum/depth/` before Oct 12.

| Phase | What | Independent of Idea 1 code? |
|---|---|---|
| **0. Collect** (start immediately, ≤ ½ day) | A second collector, `scripts/risk-collect.mjs`, dependency-free, its own launchd job (`com.colosseum.risk-collect`) and directory (`~/.colosseum/risk/`), offset from the existing job by 7 minutes. Sell **and** buy side, 8 notionals, 6 xStocks (SPYx, QQQx, TSLAx, NVDAx, AAPLx, GOOGLx: verify mints first) plus USDY and syrupUSDC. Also snapshots Kamino reserve metrics for the xStocks reserves and Jupiter Lend vault configs once an hour. Uses the Jupiter key; spaced ≥ 1.3 s; logs 429s as rows, never retries in a tight loop. | yes (writes files only) |
| **1. Engine** | `packages/risk`: curves, time buckets, redemption overlay, recoverable value, score, breach assessment, gap simulator. Pure functions over typed inputs, fixtures from the collected JSONL, tests. A CLI (`pnpm risk:report`) that prints curves and scores from the files. | yes |
| **2. Service** | Tables (`risk_*`), importer for the collector's files, computed curves and scores persisted with method version, `/risk/*` routes as a Fastify plugin in `apps/api/src/routes/risk.ts` **and** a thin standalone server `apps/risk-api` that mounts only that plugin, OpenAPI, dashboard pages under `apps/web/app/risk/*`, methodology page. | yes (new routes and pages only) |
| **3. Join** | `LiquidityProvider` interface in `packages/schemas`, implemented by `packages/risk` and by a fixture provider for tests; the four hooks in `packages/engine` (§5); API responses and UI panels extended; acceptance checks. Everything opt-in: when no provider is passed, the engine behaves exactly as today (snapshot tests prove it). | touches engine, api, web |
| **4. Lending** | Market readers and snapshots, market pages and gap simulator; new registry entries for "USDC supplied to a stock-collateral market" gated by pool score with a new haircut rule; borrow-capacity assessment for stock holders (read-only, no borrow execution). | touches registry, feeds, risk sheet |

Out of scope for this handoff (later work the founder listed): the agent layer, new product lines beyond §3.2, the design system and UI consistency pass, auth and API keys for third parties, on-chain publication of scores, EVM market execution.

## 5. Integration seams (concrete; the code exists)

| Seam | Today | Change at Phase 3 |
|---|---|---|
| `packages/schemas` | `DepthObservation`, `RiskSheetEntry.depthNote: string` | Add `DepthCurve`, `LiquidityScore`, `LiquidityAssessment`, `LiquidityEntry` (structured; keep `depthNote` as a rendered summary), `LiquidityProvider` interface, `Policy.trigger.liquidity?` (`impactTolerancePct`, `horizonMonths`, `dryFactor`), `LegOrder.reason` values include `liquidity_breach` |
| `packages/engine/src/solver` | per-stock cap = `asset.capWeight`; equity budget split equally | effective cap = `min(capWeight, shareOfDepth × exitCapacity(τ, window, worst regime) / capital)`; binding-constraint text names the regime and the dollar capacity; `SOLVER_PARAMS.impactTolerancePct`, `shareOfDepth` |
| `packages/engine/src/schedule` | withdrawals draw BRL → cash → liquid USD legs; equity never drawn; stresses: yields, FX ×2, credit gate, equity drawdown | equity drawable as last resort at `recoverableValue` (exit cost applied); new stress `liquidity_dry`; `liquidityOk` accounts for exit cost; `STRESS_PARAMS.dryFactorFloor` |
| `packages/engine/src/risk` | `buildRiskSheet` renders a `depthNote` from raw observations | takes `liquidity?: LiquidityProvider`; emits `liquidity` block: score, exit capacity at the plan's window, weekend ratio, primary path summary, sample count, date range, provenance |
| `packages/engine/src/policy` | `proposeRebalance` triggers on band breach or drift ≥ trigger; orders over → under | accepts `liquidity?: LiquidityAssessment`; when `likelyBreach`, adds orders illiquid → `usdc` sized to the shortfall, reason `liquidity_breach`; invariants added to `tests/policy.test.ts`: never above band max, always owner destination, liquidity orders only reduce illiquid legs |
| `apps/api` | `POST /plans` builds the sheet; `GET /policies/:id/drift` computes drift and a proposal | both pass the provider; responses gain `liquidity`; `/risk/*` mounted |
| `apps/web` | `PlanView`, `/monitor` | liquidity panel in `PlanView` (capacity vs need per window, regime), liquidity status row in `/monitor` with the proposal reason; `/risk` pages |
| `packages/db` | `depth_observations` | keep; add `risk_depth_curves`, `risk_liquidity_scores`, `risk_redemption_models`, `risk_market_params`, `risk_market_snapshots`, `risk_assessments` |
| `scripts/` | `depth-snapshot.mjs`, `depth-import.ts` | add `risk-collect.mjs`, `risk-import.ts`, `risk-report.ts`; leave the originals alone until Oct 12, then fold the old collector into the new one |

The running jobs are not listed in this section; seven are loaded (`depth-snapshot`, `risk-pools`, `risk-quotes`, `risk-refresh`, `risk-lending`, `risk-lending-import`, `risk-prices`, all `com.colosseum.*`). PLAN-ANALYTICS item 18 adds two, installed by `scripts/risk/jobs/install.sh` from `~/.colosseum/risk` with their files in `~/.colosseum/risk/data` (`RISK_DATA_DIR`): `com.colosseum.risk-facts-split` at minute 15 (split snapshot, then cost breakdown) and `com.colosseum.risk-facts-lending` at minute 20 (lending report, then facts import; blocked until its bundle loads, see item 18's row).

## 6. Acceptance checks per phase

**Phase 0**
- [ ] `~/.colosseum/risk/YYYY-MM-DD.jsonl` grows every 15 minutes with sell and buy rows for 8 assets × 8 notionals; 429s appear as rows with `error`, not as gaps.
- [ ] The existing `com.colosseum.depth-snapshot` job is unchanged and still writing (checked by file mtime).
- [ ] Hourly market rows for the Kamino xStocks reserves and Jupiter Lend vaults exist with `source` and `fetched_at`.

**Phase 1**
- [ ] From a fixture of ≥ 2 days including one weekend, `risk:report` prints per-asset sell curves for `weekend` and `us_market_hours`, `maxNotionalAt(1%)` for each, and the weekend/weekday ratio.
- [ ] `recoverable(spyx, $50k, Saturday 10:00 UTC, 24h)` returns a DEX-only path; the same at `72h` includes the primary path with the capacity labelled `assumption`.
- [ ] A fixture position set with a monthly withdrawal that exceeds cash + liquid legs produces `breach: false` in the base case and `likelyBreach: true` under `liquidity_dry`, with orders that remove it. A second fixture with enough cash produces neither.
- [ ] Every function is deterministic and unit-tested; no yield, price or depth literal outside `fixtures/`.

**Phase 2**
- [ ] `GET /risk/assets/spyx/depth?side=sell&regime=weekend` returns the fitted curve with sample count, date range and method version.
- [ ] `POST /risk/positions/assess` reproduces the Phase 1 fixture result over HTTP.
- [ ] `apps/risk-api` starts without the structurer's routes and serves `/risk/*` and `/docs`.
- [ ] The dashboard renders curves per regime, the time-of-week heatmap, and the methodology page with the honesty lines from §3.3.

**Phase 3**
- [ ] With no provider passed, every existing test and snapshot in `tests/` passes unchanged.
- [ ] With the provider: a high-risk plan's SPYx and QQQx weights fall when capital rises past measured weekend capacity at τ, and the binding constraint names the regime and capacity.
- [ ] The high-risk plan's risk sheet shows a `liquidity` block per stock leg with score, capacity, weekend ratio and dates; income and accumulation plans show it for USDY and syrupUSDC too.
- [ ] `liquidity_dry` appears in the stress table for plans that hold stocks; the schedule's `liquidityOk` changes when exit cost is applied to a withdrawal drawn from stocks.
- [ ] The monitor shows a `liquidity_breach` proposal for a fixture policy whose next withdrawal cannot be met from liquid legs; the proposal respects every existing invariant.
- [ ] One mainnet rebalance executed from a `liquidity_breach` proposal (user-signed for xStocks), logged with its explorer link.

**Phase 4**
- [ ] `GET /risk/markets` lists the Kamino xStocks reserves and Jupiter Lend vaults with on-chain parameters, source and timestamp, and the dispersion table.
- [ ] The gap simulator returns liquidatable-at-reopen and unliquidatable-while-closed for one market at a chosen `gapPct`, with every assumption listed.
- [ ] A "USDC supplied to a stock-collateral market" leg exists in the registry, gated by pool score, haircut by rule `HC-LEND-RWA`, and appears in an accumulation plan only when the score passes.
- [ ] Borrow-capacity assessment for a wallet holding SPYx returns capacity, liquidation distance and the hour-of-week at which it is thinnest; no borrow is executed.

## 7. Known dependencies and what is still unverified

| Item | Status | Note |
|---|---|---|
| Jupiter quote API with key | A | 429s seen at $5k keyless. 8 assets × 8 notionals × 2 sides = 128 quotes per run; at 1.3 s that is ~3 min every 15 min, inside the keyed tier. Verify the tier's window before Phase 0. |
| xStocks mints for TSLAx, NVDAx, AAPLx, GOOGLx | U | Resolve with the V6 method (Jupiter token search + `getAccountInfo`) before adding them. |
| Kamino xStocks reserves: addresses, `ReserveConfig` fields, Scope price-band config for weekends | U | Read from klend-sdk; the weekend band is UNVERIFIED and must be read from config, not assumed. |
| Jupiter Lend `getVaultConfig()` for SPYx/QQQx/TSLAx/NVDAx vaults | U | Docs say LTV "typically 65–75%". |
| Obligation enumeration (`getProgramAccounts`) | U, paid RPC | Optional in Phase 4; market aggregates come from reserve metrics first. |
| Primary redemption: xStocks T+5, $5k minimum; Ondo 24/7 size limits | U | Scenario inputs, labelled. |
| Whether Jupiter quote impact matches realised swap slippage | U | Compare against the `executions` rows from Sep 30 (SPYx, QQQx buys) and every later execution. |
| Direct pool reads (Raydium, Orca, Meteora) as a second depth source | not started | Stretch; would remove the dependency on Jupiter's router. |

## 8. Constraints for the plan

- **Start dates:** Phase 0 starts now (Oct 1). Phases 1–4 start after the hackathon submission, Tue Oct 13, unless the founder says otherwise; the plan must also work if Phase 1 starts on Oct 5 in the hackathon's flex slots, on the branch.
- **Granularity:** half-day slots for Phases 0–3, day slots for Phase 4. Every slot has one deliverable and one observable check.
- **People:** solo. Mark `[B2]` slots (default B2 scope: collectors, market readers, dashboard).
- **Founder strengths:** risk models, data pipelines, credit. This layer is home turf; the unfamiliar parts are Solana account reads for market parameters and the UI. Front-load the account reads.
- **Build it as the product:** real tables, versioned methods, OpenAPI. Plain UI. No presentation, GTM or video work in this plan.
- **Repository rules in `CLAUDE.md` apply**, plus: `risk_*` tables and `packages/risk` never import from `packages/engine` (the dependency points the other way, through `packages/schemas`); every computed number stores `method_version`; the existing collector and its data are read-only until Oct 12.
- **Required plan contents:** stack additions (if any), architecture sketch with the seam, slot table per phase, decision log with cut-offs, risk register, acceptance mapping (§6 → slots), open questions with defaults, self-check.
