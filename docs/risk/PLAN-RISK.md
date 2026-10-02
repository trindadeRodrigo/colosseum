# PLAN-RISK.md — build plan for the liquidity and risk layer (v2)

*v2, written Thu 2026-10-01 ~01:10Z on branch `risk-layer`. It replaces v1 (commit `07a4fcf`). Spec: `HANDOFF-RISK.md`. Founder decisions on 2026-10-01: build now at full speed rather than waiting for Oct 13; read the pools directly as the main data source; quotes are a cross-check.*

---

## 1. Summary

- **What changed from v1:**
  - We read every pool's on-chain state over RPC and simulate sales of any size exactly. Jupiter quotes are kept, but only as an independent check.
  - Work starts today, at build speed. There is no artificial start date and no half-day padding.
  - `main` stays untouched until the founder decides to merge (Q1).
- **What was proven today** (dated evidence in §2):
  - Decoders for the four pool types that hold 99.5% of xStocks liquidity reproduce Jupiter's same-pool quotes, to between 1e-9 and 3e-4 depending on pool type.
  - Only 50 of 1,171 verified xStocks have any DEX pool. 34 pools hold 80% of liquidity, and 301 pools hold 99%.
- **Most likely failure:** history.
  - Quotes cannot be backfilled, and replaying past pool state on Solana is heavy: about 1,000 transactions an hour on the busiest SPYx pool.
  - **Mitigation:** collect forward from today at 5-minute resolution. For the 34 pools that matter, backfill past trades (not full state) from transaction history. Check an indexer (Dune) as a shortcut before writing our own backfill.

## 2. What we know now (measured 2026-10-01, evidence in repo)

| Finding | Evidence |
|---|---|
| The old depth job ran without the Jupiter key: 115 of 416 rows on Sep 30 were `429`. Re-installed with the key (founder approved). The first keyed run had 1 failure in 16. | `~/.colosseum/depth/2026-10-01.jsonl`, run at 00:28Z |
| Jupiter lists 1,171 verified xStocks, all with one mint authority `7pt9…taCj` | `data/risk/xstocks-20261001T0049.json` (gitignored data dir) |
| 50 of them have any DEX pool; 715 pools in total, 82 of them with zero liquidity | `data/risk/pools-dexscreener-20261001T0049.pareto.json` |
| Liquidity: 34 pools (18 assets) = 80%, 75 = 90%, 138 = 95%, 301 = 99%. 24h volume: 28 pools = 80%, 129 = 99%. | same file (DexScreener estimates; used for discovery only) |
| By venue: Raydium CLMM holds most of the liquidity; then Orca Whirlpool, Raydium CPMM, Meteora DLMM. These four = 99.5% of liquidity, 98.4% of volume. | same file |
| Raydium CLMM decoder: liquidity rebuilt from tick arrays equals the pool's stored value exactly; simulated sales equal Jupiter same-pool quotes to ≤ 2e-8 | `scripts/risk/validate-clmm.ts`, `tests/risk-layer/pools.test.ts` |
| Orca Whirlpool: liquidity exact; sales within 3e-4. The gap grows with ticks crossed, consistent with Orca's adaptive fee, which is not yet modelled; our output is slightly optimistic. | same |
| Meteora DLMM: sales within 3e-5; bins sum to 97–98% of reserves (the rest is likely fees) | `scripts/risk/validate-dlmm.ts` |
| Raydium CPMM: exact (3e-13) once Token-2022 transfer fees are applied to the fee-bearing leg | `scripts/risk/validate-cpmm.ts` |
| Byreal (a Raydium CLMM fork): header decodes and small sales match, but its tick arrays differ, so the liquidity check fails. **Not supported yet.** | probe output, 2026-10-01 |
| RPC: one `getProgramAccounts` returns a pool's full tick arrays in about 2 s. Some transactions are now version 1 and need `maxSupportedTransactionVersion: 1`. Signatures for a 12-day-old transaction were still served. | `scripts/verify/vr-pools-probe.ts` |
| Teiten has no Solana pool-state decoding. Reusable, both Python: the swap inference from transfers (`teiten-solana/analysis/solana/lib/dex_census.py`) and the rate-control design (`teiten-solana/ingestion/src/solana_capture.py`). | Teiten survey, 2026-10-01 |

## 3. The steps, in plain English

**Who does what:** I build. You (the founder) do the five things marked **YOU**. Every step ends with tests passing, a commit, and a one-line entry in `docs/risk/STATE-RISK.md`. Dates are targets, not padding. If a step finishes early, the next one starts.

---

### Step 1 — Pool registry *(today, Oct 1)*
- **What it does:** turns today's discovery list into a confirmed list of pools.
  - Each pool is opened on-chain: which program owns it, which two tokens it pairs, and whether a token charges a transfer fee.
  - Pools that fail confirmation are dropped with a reason.
  - A second pass searches each of the 50 assets on-chain (by mint) for pools that DexScreener missed.
- **Pool tiers:**
  - **Tier A:** the pools that together hold 99% of liquidity. Refreshed every 5 minutes.
  - **Tier B:** everything else. Refreshed hourly.
- **What you'll see:** `pnpm risk:pools` prints the tiers, and the database table `risk_pools` holds them.
- **YOU:** nothing.
- **Done when:** every Tier A pool is confirmed on-chain, and the tier counts match the Pareto file.

### Step 2 — Pool snapshot collector *(today, Oct 1)*
- **What it does:** a new background job (`com.colosseum.risk-pools`) reads Tier A pools every 5 minutes and Tier B hourly. Each run:
  1. Reads the pool's state: price, active liquidity, and liquidity at every price level.
  2. Simulates selling and buying the asset for USDC at 8 sizes, from $100 to $5M.
  3. Writes the result with source, time and method.

  Raw account bytes are kept for Tier A once an hour, so any number can be recomputed later. The Kamino and Jupiter Lend market accounts are also stored raw every hour, for Step 10. The old depth job keeps running untouched.
- **What you'll see:** `~/.colosseum/risk/pools/YYYY-MM-DD.jsonl` grows every 5 minutes. `pnpm risk:coverage` shows runs, failures and samples per hour.
- **YOU:** keep the laptop **plugged in with sleep off**, starting this weekend (Oct 3–4). In Terminal: `sudo pmset -c sleep 0`. Afterwards, `sudo pmset -c sleep 1` restores the default.
- **Done when:** two consecutive runs are on disk and the old job is still writing.

### Step 3 — Quote cross-check *(today, Oct 1)*
- **What it does:** a lighter job, every 15 minutes, asks Jupiter for real quotes on the 18 assets in the 80% set, at a few sizes, sell and buy, and compares them with our simulation.
  - Jupiter can split a sale across pools. If it gets a better price than our best single pool, the gap tells us how much routing adds.
  - If our simulation is better than Jupiter, something is wrong, and the check flags it.
  - Failed quotes are stored as rows, never retried in a loop.
- **What you'll see:** a column "sim vs Jupiter" in `risk:coverage`.
- **YOU:** nothing.
- **Done when:** the gap is recorded for every Tier A asset, and any pool where it exceeds the venue's tolerance is listed.

### Step 4 — Who provides the liquidity *(Oct 1–2)*
- **What it does:** reads every liquidity position in Tier A pools and who owns it. That gives LP concentration: what share of the liquidity near the current price belongs to the top 1, 3 and 10 providers.
  - New stress test: "the top N providers withdraw". The pool's depth is recomputed without their positions. This replaces a flat "weekend factor" with a measured one.
  - Liquidity withdrawals become events. The collector compares each snapshot with the last and records any drop in liquidity near the price, with the transaction that caused it.
- **What you'll see:** per pool, "top-3 LPs hold X% of depth within ±2%". Per asset, the sale size that costs 1% before and after the top LP leaves.
- **YOU:** nothing.
- **Done when:** concentration is computed for every Tier A pool, and an LP-withdrawal event appears in the log within 5 minutes of happening (checked against the transaction on Solscan).

### Step 5 — History *(Oct 2)*
- **What it does:**
  1. Checks how far back the RPC serves transactions (archive or not).
  2. Checks whether Dune already has Solana xStocks trades. If it does, we use it and skip our own backfill. **YOU:** a Dune API key, if you have or want one (optional).
  3. Otherwise ports Teiten's swap inference to TypeScript and backfills past swaps for the 34 pools that hold 80% of liquidity. Each swap's size and price give the real cost by trade size and hour of the week, across every past weekend in the window.
  4. Liquidity adds and removes come from the same transactions, giving past LP withdrawals.
  5. Compares the realised cost of our own Sep 30 SPYx/QQQx buys (`executions`) with their quotes.
- **What you'll see:** `pnpm risk:history` prints how many weeks are covered per pool and the weekend-vs-weekday cost ratio from real trades.
- **Done when:** at least 4 past weekends are covered for the top 10 pools, or the RPC limit is documented with the depth we did reach.

### Step 5b — Complete history of the 34 value pools, RPC only *(decided 2026-10-01; start in a fresh session)*

**Why.** Sampled swaps (Step 5) tell us trade costs, not how liquidity moved. The founder wants a complete record for the 34 pools that hold 80% of on-chain value:
- every trade;
- every liquidity event: open, add, remove and close position, each with its price range.

From that record each pool's exact state can be rebuilt at any moment: price, active liquidity, and the full liquidity-by-price layout. This shows how large trades move the price and how LPs react, by adding, pulling or moving their ranges.

**Constraints.**
- RPC only: Chainstack enterprise, free for one week (from about 2026-10-01), then discounted. No Dune.
- So the bulk fetch should run inside the free week. Newest weeks go first, so recent weekends land first.

**Pool list.** The 34 pools come from `data/risk/registry-20261001T0139.json`: sort by `tvlUsd`, cumulative 80%. They are listed in `docs/risk/STATE-RISK.md`, Step 1, and can be regenerated with the snippet in this step's script. 30 are Raydium CLMM, 3 are Orca Whirlpool, 1 is Meteora DLMM.

**Do it in this order. Each item ends with a commit and a line in STATE-RISK.**
1. **Measure before fetching (30 min).**
   - Walk `getSignaturesForAddress` for all 34 pools over the chosen window (default 28 days). Count only; this is cheap, as the 5 pools in Step 5 showed.
   - Run a 5-minute `getTransaction` throughput test at 4, 16, 32 and 64 parallel requests (`maxSupportedTransactionVersion: 1`), recording rate and 429s.
   - Output: total transaction count and a time estimate. If the estimate exceeds the free week, shorten the window (14 days first) rather than sample.
2. **Fetcher (`scripts/risk/history-full.ts`).** Reuse the checkpointed signature walk in `history-backfill.ts`, but keep every signature, streamed to disk in chunks, not one JSON array.
   - Parallel `getTransaction` at the measured safe level, 30 s timeout, backoff on 429.
   - Resumable by signature cursor. Store **decoded events only**, as compact JSONL per pool per day, plus a raw-body sample of 1 in 1,000 for audits.
   - Run it under launchd or nohup, not as a session background task: those are killed after 2 h.
3. **Decoders for liquidity events** (pure functions in `packages/risk/src/events/`, tested against live transactions):
   - **Raydium CLMM:** `SwapEvent` (decoded already; 221-byte variant), `CreatePersonalPositionEvent`, `IncreaseLiquidityEvent`, `DecreaseLiquidityEvent`, `LiquidityChangeEvent` (tick range, liquidity delta, amounts). Discriminators are `sha256("event:<Name>")[0..8]`; check field offsets against a known transaction, as was done for `SwapEvent`.
   - **Orca Whirlpool:** `Traded` and the liquidity increase/decrease events if the program emits them. Otherwise decode the instructions (`increaseLiquidity`, `decreaseLiquidity`, `openPosition`, `closePosition`) with their position account and tick range.
   - **Meteora DLMM:** swap and add/remove liquidity events, with bin ranges.
   - Swaps also carry pre/post token balances: a cross-check of every decoded amount.
4. **Completeness checks** (they decide whether the history can be trusted):
   - Every signature in the walk is fetched or listed in `errors.jsonl` (a retry pass runs at the end).
   - **Backward replay:** start from the hourly raw snapshots saved since 2026-10-01 (`~/.colosseum/risk/raw/`) and undo events in reverse order. The rebuilt pool state at an earlier snapshot must equal that snapshot exactly (active liquidity and every tick's `liquidityNet`). A mismatch means a missing or misdecoded event; the gap is located by bisection.
   - The sum of liquidity deltas per position equals each live position's current liquidity (positions decoded in Step 4).
5. **Reconstruction (`packages/risk/src/replay.ts`).** Pool state at any slot comes from the latest raw snapshot plus reversed events. The depth curves, depth within ±2%, LP concentration and the LP-exit stress are recomputed per hour of history. This gives a **historical** curve per regime: 4 past weekends instead of only the ones collected live.
6. **Analysis (the founder's question).** Find large trades, by size relative to depth within ±2%, then measure:
   - the price displacement;
   - the time for the price to recover (arbitrage);
   - LP reactions in the next N minutes: adds, removes or range moves near the price, and by whom (position owner).

   Report this per asset and per regime. It feeds the stress parameters (`dryFactorFloor`, LP-exit N) with measured values instead of defaults.

**Storage.** Decoded events are about 200 bytes each; budget 5–8 GB for 20–40M transactions in `data/risk/history-full/` (gitignored). Raw sample about 1 GB.

**Done when:** all signatures for the 34 pools in the window are fetched; the backward replay matches the saved snapshots; STATE-RISK records the counts, error rate and window covered; and `pnpm risk:history-report` prints the large-trade / LP-reaction table.

**Status at handover (2026-10-01 ~04:30Z).**
- Step 5 sampled swaps exist for 4 pools, complete: NVDAx `49iMatQt`, SPYx `6truu3rZ`, CRCLx `GYqHjuDz`, SPCXx `AHNN6Jmv`. QQQx `GMjGLWzv` is partial (3,720 of 18,570). All in `data/risk/history/`. They stay useful as a cross-check.
- No liquidity events have been captured historically yet. The live collector captures them from 2026-10-01 onward (`events.jsonl`, hourly `lp/` and `raw/`).

### Step 6 — The risk engine *(Oct 2–3)*
- **What it does:** `packages/risk` gets the math from the spec, as pure functions with tests:
  - time of week (US market hours, weekday off-hours, weekend, holiday, with DST handled);
  - depth curves per time bucket;
  - the issuer redemption route (labelled assumption);
  - recoverable value;
  - liquidity score;
  - breach and likely-breach;
  - the weekend-gap simulator.

  Curves now come from simulated pool snapshots plus trade history, not from quotes.
- **What you'll see:** `pnpm risk:report` prints, per asset: the sale size that costs 1% in market hours vs on the weekend, the weekend/weekday ratio, and the top-LP-exit stress.
- **Done when:** the Phase 1 acceptance checks pass (§7).

### Step 7 — Service and dashboard *(Oct 3–4, during the weekend's collection)*
- **What it does:**
  - database tables;
  - an importer for the collected files;
  - `/risk/*` API routes;
  - a standalone `apps/risk-api` that serves only those routes;
  - dashboard pages: per-asset depth curves, an hour-of-week heatmap, LP concentration, and a methodology page with the honesty notes.
- **What you'll see:** `http://localhost:3000/risk` in the browser, and `http://localhost:3002/docs` for the API.
- **YOU:** look at the dashboard once on Saturday and once on Sunday and tell me anything that reads wrong. 10 minutes each.
- **Done when:** the Phase 2 acceptance checks pass.

### Step 8 — Join to the structurer *(Oct 5–6)*
1. Freeze a snapshot of today's three demo plans. With no liquidity data passed in, the structurer must produce exactly the same plans; that proof comes before any engine change.
2. Add the four hooks:
   - **Sizing:** stock weights capped by measured weekend exit capacity.
   - **Schedule:** exit cost and a "liquidity dries up" stress.
   - **Risk sheet:** a liquidity block per leg.
   - **Policy:** sell stock to cash ahead of a likely breach.
3. Show it in the plan view and the monitor.
- **What you'll see:** a high-risk plan whose SPYx/QQQx weights shrink as capital grows, with the reason naming the weekend capacity. A "liquidity breach" proposal on the monitor.
- **Done when:** the Phase 3 checks 1–5 pass.

### Step 9 — One real rebalance *(a weekday, Oct 6 or 7)*
- **What it does:** on the demo wallet, a policy with a stated 1% cost tolerance proposes selling a small amount of stock to USDC because a withdrawal could not be met on a weekend.
- **YOU:** open `/monitor`, read the proposal, and sign it in Phantom. This is the same flow as your earlier rebalance, a few dollars.
- **Done when:** the transaction's Solscan link is on the monitor and in `executions`.

### Step 10 — Lending markets *(Oct 7–9)*
- **What it does:**
  - Reads Kamino's xStocks reserves and Jupiter Lend's xStocks vaults on-chain: loan-to-value, liquidation threshold and bonus, caps, and the weekend price band. This verification comes first.
  - Shows them side by side, with a weekend-gap simulator per market.
  - Adds a "supply USDC to a stock-collateral market" leg, allowed only when the pool's score passes.
  - Adds a read-only borrow-capacity check for a wallet holding SPYx.
- **YOU:** nothing. This step is read-only; no borrowing is executed.
- **Done when:** the Phase 4 checks pass.

---

**Throughout:**
- `main` is not touched, and the hackathon tasks on `main` (rebalance #2, deploy, video, submission) are unaffected.
- On Oct 9 (feature freeze) I report where the risk layer stands, so you can decide Q1: whether any of it goes into the submission.

## 4. Methods (source for the methodology page; `method_version = risk-0.2`)

Names in `code` are policy inputs stored next to every output. Anything not listed here is as in Appendix A.

- **Pool simulation (primary depth).** For each pool, decode its state and simulate an exact-input swap at notional `n`:
  - **Concentrated liquidity** (Raydium CLMM, Orca): step through initialized ticks, using `Δx = L(1/√P_target − 1/√P)` and `Δy = L(√P − √P_target)`, and update `L` by each tick's `liquidityNet` at the crossing.
  - **DLMM:** walk bins from the active bin, consuming each bin's opposite-token amount at the bin price.
  - **CPMM:** `out = R_out × n' / (R_in + n')`, using reserves net of owed fees.
  - **Fees:** taken from input at the pool's rate. Token-2022 transfer fees are applied to the leg in that token.
  - Liquidity outside the fetched ticks is treated as absent, which can only understate depth.
  - Per-venue tolerance against Jupiter same-pool quotes is a tested constant: Raydium CLMM 1e-6, CPMM 1e-9, DLMM 1e-4, Orca 1e-3 until adaptive fees are modelled.
- **Asset depth.** At each snapshot, the asset's sell curve is the best single-pool output at each notional across its USDC and SOL pools. SOL is converted at the SOL/USDC pool price in the same snapshot.
  - Multi-pool routing is not added, so the curve is a lower bound on what a router gets.
  - Step 3 measures the routing gap and stores it beside the curve.
- **Cost.** `I(n) = 1 − out(n) / (n × P_mid)`, where `P_mid` is the pool's mid price at the snapshot. It includes the fee. Jupiter's `priceImpactPct` is never used.
- **Founder defaults** (answered Oct 1): τ = 1%, `shareOfDepth` = 0.25, `dryFactorFloor` = 0.25. The dry multiplier stays `d = max(dryFactorFloor, min(1, ρ))`, and the measured top-N-LP-exit curve is reported beside it.
- **LP concentration.** For each pool and band `±b` around the price (`concentrationBandPct`, default 2%):
  - share of in-band liquidity held by the top 1, 3 and 10 owners;
  - **LP-exit stress:** recompute the pool without the top `N` owners' positions (`lpExitN`, default 3).
- **LP-withdrawal event.** Between consecutive snapshots, a drop of more than `withdrawalAlarmPct` (default 20%) in in-band liquidity, attributed to the `decrease_liquidity` or `remove_liquidity` transactions in that window. It feeds the policy as an early warning, before any withdrawal date.
- **Trade history (calibration).** Each past swap gives its size and execution price. Pre-trade mid price comes from the pool state or the previous trade. Realised cost by size and hour-of-week is compared with the simulated curve for the same bucket, and the comparison is published.
- **Redemption.** An issuer redemption that settles after the horizon is listed with status `settles_after_horizon` and is not counted in recoverable value (founder, Oct 1).

## 5. Stack additions

| Need | Choice | Why |
|---|---|---|
| Pool decoding | **Hand-written decoders in `packages/risk`, no SDK** | Validated against Jupiter. The SDKs pull `web3.js` v1 and Anchor, while this repo uses `@solana/kit` 2.x. |
| Curve fit, time zones | No library (isotonic + piecewise-linear in ln n; `Intl` for ET) | Deterministic, auditable |
| Charts | Plain SVG like `ScheduleChart.tsx` | No dependency |
| Collectors | Two new launchd jobs: `com.colosseum.risk-pools` (5 min) and `com.colosseum.risk-quotes` (15 min). Each has its own directory and env file. | Same proven mechanism; the old job is left alone |
| History | Dune API if available (Step 5), else RPC + a port of Teiten's swap inference | Fastest path to past weekends |

## 6. Decisions

| # | Decision | Default | Decided by / when |
|---|---|---|---|
| D1 | Start date | **Now** (founder, Oct 1) | done |
| D2 | Main depth source | **Pool reads; quotes as cross-check** (founder, Oct 1) | done |
| D3 | Pool coverage | **Tier A = pools holding 99% of liquidity (5 min); Tier B = the rest (hourly)** | Step 1; re-tiered weekly from fresh discovery |
| D4 | Byreal and other unsupported venues | **Excluded and listed until their decoder passes the same validation**; then added | Step 2 |
| D5 | History source | **RPC only (founder, 2026-10-01): complete history of the 34 value pools, trades and liquidity events (Step 5b); Dune not used** | done |
| D6 | Hour-of-week curves vs regime curves | **Regime curves for decisions; hour-of-week as a heatmap**, upgraded where 5-min samples give ≥ `minSamplesPerPoint` per bucket | Step 6 |
| D7 | Merge into `main` / the hackathon submission | **Not before Oct 12 unless the founder says so (Q1)** | Founder, by Oct 9 |
| D8 | Fold the old depth job | **After Oct 12**: final import, then unload. Its data stays read-only. | Oct 13 |
| D9 | Orca adaptive fee | **Model it in Step 3** if Orca pools are in Tier A for assets the structurer uses; else keep the documented tolerance | Step 3 |

## 7. Acceptance mapping (`HANDOFF-RISK.md` §6)

| Check | Step | Proof |
|---|---|---|
| P0.1 collector grows every 15 min, sell and buy, 429s as rows | 2, 3 | `~/.colosseum/risk/` files; `risk:coverage` (the pool collector runs every 5 min, exceeding the spec) |
| P0.2 old job unchanged and writing | 2 (and daily) | `stat` mtime; old script unchanged vs `main` (key-only re-install, approved) |
| P0.3 hourly Kamino / Jupiter Lend rows | 2 (raw), 10 (decoded) | `markets-*.jsonl` |
| P1.1–P1.4 report, recoverable, breach fixtures, determinism | 6 | `docs/risk/report-*.txt`; `tests/risk-layer/*.test.ts` |
| P2.1–P2.4 depth endpoint, assess over HTTP, standalone API, dashboard | 7 | saved responses; screenshots |
| P3.1 no-provider unchanged | 8 (first) | `tests/engine-baseline.test.ts`, empty snapshot diff |
| P3.2–P3.5 sizing, risk sheet, dry stress, monitor proposal | 8 | tests + screenshots |
| P3.6 mainnet rebalance from `liquidity_breach` | 9 | Solscan link in `executions` |
| P4.1–P4.4 markets, gap sim, lending leg, borrow capacity | 10 | API responses + tests |

**Added beyond the spec:**
- **V-POOL:** every venue decoder passes the same-pool Jupiter check in `tests/risk-layer/pools.test.ts`. Done for 4 venues.
- **V-LP:** an LP withdrawal is detected within one snapshot (Step 4).
- **V-HIST:** realised trade cost compared with the simulation per bucket (Step 5).

## 8. Risks

| Risk | Likelihood | Mitigation | Retired in |
|---|---|---|---|
| Laptop asleep, so gaps in the 5-min series | High | Founder power setting (Step 2); gaps reported, never filled in | ongoing |
| Unlimited RPC ends | Medium | Tier B hourly; the collector's request rate is configurable; raw bytes kept so nothing must be re-fetched | Step 2 |
| A decoder silently breaks after a program upgrade | Medium | Hourly self-check: liquidity rebuild plus one Jupiter same-pool quote per venue. A failure marks the venue `degraded` and stops its numbers being published. | Step 3 |
| Simulation overstates depth (single pool vs routing; Orca adaptive fee) | Low for overstating; routing makes us conservative | Routing gap measured; Orca tolerance tested; adaptive fee in D9 | Step 3 |
| History too heavy to backfill | Medium | Dune first; top 34 pools only; trades, not full state | Step 5 |
| Engine change alters existing plans | Low | No-provider snapshot proof before any hook | Step 8 |
| Liquidity orders conflict with band invariants | Medium | Liquidity orders only to USDC and only reduce illiquid legs; invariants tested | Step 8 |
| Scope creep (agent layer, design system) | Medium | Out of scope per spec; logged, not built | ongoing |
| Discovery source (DexScreener) misses pools | Low–Medium | On-chain `getProgramAccounts` by mint for the 50 assets as a second pass | Step 1 |

## 9. Open questions

| # | Question | Default |
|---|---|---|
| Q1 | Should any of the risk layer go into the hackathon submission (merge before Oct 12)? | No; decide by Oct 9 |
| Q2 | Dune API key for history? | Optional; without it, the RPC backfill is used |
| Q3 | LP-withdrawal alarm: drop in liquidity near price that triggers it (`withdrawalAlarmPct`)? | 20% within ±2% of price |
| Q4 | Tier A cut-off: 99% of liquidity (301 pools) or 95% (138)? | 99% |

**Answered on Oct 1:** τ 1%; `shareOfDepth` 0.25; dry floor 0.25; too-slow issuer redemption is listed, not counted; no API rate limit locally, limited when live; old job re-installed with the key; start now; pool reads first.

## 10. Self-check

- **(a) `main` and the old collector:** untouched, except the approved key-only re-install of the old job on Oct 1. All work is on `risk-layer`.
- **(b) `packages/risk` never imports `packages/engine`:** enforced by `tests/risk-layer/boundary.test.ts`.
- **(c) No-provider proof before any engine change:** first action of Step 8.
- **(d) Verification before dependence:**
  - Jupiter tier: Step 3.
  - Mints: Step 1 (confirmed on-chain).
  - Kamino, Scope and Jupiter Lend: Step 10, first.
  - Quote vs realised: Step 5.
  - Pool decoders: done today, tested.
- **(e) Every §6 check maps to a step:** §7.
- **(f) No market figure is carried as fact:** §2 lists dated measurements with their files; method defaults are policy inputs.

## Appendix A — Method definitions carried from v1 (`risk-0.1`, unchanged unless §4 says otherwise)

Every name in `code font` below is a **policy input** in `RISK_PARAMS`, `SOLVER_PARAMS` or `STRESS_PARAMS`. Each input is stored next to each output and is never a market fact.

**Collection.**
- Notional grid `G` = 8 log-spaced USD notionals from `gridMinUsd` to `gridMaxUsd` (defaults: 100 and 5,000,000).
- Buy quote: USDC→asset, exact-in `n` USDC.
- Sell quote: asset→USDC, exact-in `n / p_ref` units, where `p_ref` is the USDC rate from the same run's smallest buy quote. If that quote failed, sell rows are written with `error: 'no_ref_price'`.
- A failed quote is a row with `error` and null values. It is never retried in a loop.

**Impact.** For a quote with input value `n` (USD) and output value `o` (USD), the effective rate is `r(n) = o/n`. Own impact is `I(n) = 1 − r(n)/r(n_min)`, where `n_min` is the smallest successful grid notional in the same run and side. Jupiter's `priceImpactPct` is stored beside it and never used in formulas. The methodology page states that a quote is an executable route at that instant, not order-book depth and not a fill guarantee.

**Buckets and regimes** (`time` module). Convert `at` to ET with `Intl` (DST is automatic). Hour-of-week is `h = weekday(ET)×24 + hour(ET)`, 0..167. The regime is the first match in this order:
1. `us_holiday`: ET date is in `fixtures/risk/us-market-holidays.json`.
2. `weekend`: from `weekendStartET` to `weekendEndET`. Defaults: Fri 20:00 and Sun 20:00. These are parameters, set from the issuer's published trading window in VR-6.
3. `us_market_hours`: Mon–Fri `rthOpenET`–`rthCloseET` (09:30–16:00).
4. `us_offhours_weekday`: everything else.

A `us_holiday` bucket with fewer than `minSamplesPerPoint` samples falls back to the `weekend` curve, and the response says so. There is no NYSE holiday between Oct 1 and Nov 25, 2026, so this fallback will be live. Tests cover the DST change on Sun Nov 1, 2026.

**Curve fit** (`curves`). For each (asset, side, regime), and per hour-of-week only if D3 allows it:
1. At each grid point take the `curveQuantile` (default median) of `I` over successful samples. Record `samples_k`, `errors_k`, `from`, `to`.
2. Apply isotonic regression in `n` so impact never falls as notional rises.
3. Interpolate linearly in `x = ln n`.

Queries:
- `impactAt(n)` = interpolated value for `n` in [min G, max G]. Below the grid it is the value at min G. Above the grid it is `null` (`beyond_measured`).
- `maxNotionalAt(τ)` = largest `n` with `impactAt(n) ≤ τ`, solved on the segment. It is 0 if `impactAt(min G) > τ`. If `impactAt(max G) ≤ τ` it is `≥ max G`, flagged as a lower bound.
- `recoverableValue(n)` (sell side) = `n × (1 − impactAt(n))`.
- A point with `samples_k < minSamplesPerPoint` makes the curve `insufficient` above that point.

**Weekend ratio.** `ρ(asset, τ) = maxNotionalAt_weekend(τ) / maxNotionalAt_us_market_hours(τ)` on the sell side. It is a measured output with both sample counts beside it, and `null` if either curve is `insufficient`.

**Primary-redemption overlay** (`redemption`). Issuer model `M` = {`windowSchedule` (fixture: 24/5 or 24/7 in ET), `minNotionalUsd`, `kycRequired`, `settlementHours`, `capacityUsdPerOpenHour`, `feePct`}. Every field has `provenance: 'assumption'` unless VR-6 finds a primary source.

`primaryCapacity(issuer, at, H, n)` is:
- 0 if `n < minNotionalUsd`;
- 0 if no window hour lies in `[at, at + H − settlementHours]`;
- otherwise `min(n, capacityUsdPerOpenHour × open hours in that interval)`.

The response always lists the primary path with its status: `available`, `window_closed`, `below_minimum`, `settles_after_horizon` or `kyc_required`.

**Recoverable value** (`recoverable`). For `(asset, n, at, H)`:
- DEX path: `n × (1 − impactAt_b(n))` in the best bucket `b` reachable in `[at, at+H]`. It is a single sale; `splitAcrossBuckets` defaults to off.
- Combined path: `x(1 − feePct) + DEX(n − x)` with `x = primaryCapacity`.
- Result: `max(DEX, combined)`, returned with path, bucket, curve ids, sample counts and provenance (`live` for curves, `assumption` for the issuer model).

**Liquidity score** (`score`). `S(asset, H, τ, Nref) = min(1, min_{regimes reachable in H} maxNotionalAt_r(τ) / Nref)`. `Nref` is the leg's USD amount inside a plan and `refNotionalUsd` on public pages. It is a number in [0,1], published with τ, Nref, the worst regime, samples and dates. No grades.

**Breach** (`breach`). Inputs:
- positions (cash, BRL leg, liquid USD legs, illiquid legs);
- withdrawals `W_k` over `horizonMonths`;
- `liquidityWindowDays`;
- τ, `shareOfDepth`, `dryFactorFloor`.

Steps:
1. Draw each `W_k` in order from BRL leg, then cash, then liquid USD legs (same order as `buildSchedule`), depleting balances.
2. `need_k` is the remainder.
3. `cap_k = Σ_illiquid shareOfDepth × maxNotionalAt_worst(τ)`, where "worst" is the worst regime inside `[t_k − liquidityWindowDays, t_k]`.
4. Dry depth multiplier `d = max(dryFactorFloor, min(1, ρ))`. The dry curve is `I_dry(n) = I(n/d)`, so `cap_k^dry = d × cap_k`.

Outputs:
- `breach` = ∃k: `cap_k < need_k`.
- `likelyBreach` = ∃k: `cap_k^dry < need_k`.
- `shortfall` = `max_k (need_k − cap_k^dry)⁺`, plus `monthsAtRisk`.
- Orders: sell illiquid → `usdc` for `shortfall`, least liquid leg first, each order ≤ that leg's value. The function re-runs on the post-order positions, and a test asserts `likelyBreach = false` afterwards.

**Effective cap in the solver.** With a provider:
- `capEff_i = min(capWeight_i, shareOfDepth × maxNotionalAt_worst(τ; window = liquidityWindowDays) / capital)`.
- The equity budget is split as today within `capEff`; anything not placed flows to the LP remainder, as today.
- Binding text names the regime, dollar capacity, τ, samples and dates.

Without a provider, `capEff_i = capWeight_i` through untouched code.

**Exit cost in the schedule.** With a provider, equity becomes the last-resort source after liquid legs.
- Drawing `y` USD of value yields `y × (1 − impactAt_worst(y))`. Bisection finds the `y` that covers the remaining need, capped at `maxNotionalAt_worst(τ_exit)`, where `τ_exit = exitImpactCapPct`.
- `liquidityOk` is false if equity cannot cover the remainder at that cap.

Without a provider, equity is never drawn (today).

**`liquidity_dry` stress.** Same schedule with `I_dry` (multiplier `d` as above, `STRESS_PARAMS.dryFactorFloor`). Added only when the plan holds a leg with a curve and a provider is present.

**Gap simulator** (`gap`). Market params `{ltvLiq, closeFactor, fullLiqLtv, liqBonus, bandPct}` come from on-chain in Phase 4, or a labelled fixture in Phase 1. Aggregates are collateral `C` and debt `D` at the last close. For gap `g = gapPct`:
- **Liquidatable at reopen:** debt where `D > ltvLiq × C(1−g)`, repaid at `closeFactor` (or fully above `fullLiqLtv`). Seized collateral is valued at `recoverable(seized, reopen bucket, H = liquidationHorizonHours)`.
- **Unliquidatable while closed:** debt underwater at `C(1−g)` but not at the banded oracle price `C(1 − min(g, bandPct))`.

Every assumption is listed in the response.

