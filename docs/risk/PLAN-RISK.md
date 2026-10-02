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

### Step 10b — Lending-pool ingestion: registry, live state, positions, complete history *(decided 2026-10-01; start in a fresh session with `PROMPT-BUILD-LENDING.md`)*

**Why.** The pool ingestion (Steps 1–5b) tells us how much stock can be sold and at what cost. The lending pools are the other half:
- how much stock collateral could be seized and sold, and when;
- how much of a lender's USDC is lent out and how much can be withdrawn;
- what liquidations actually happened and what they cost.

Step 10 reads parameters once an hour from the protocol APIs. That is not enough for risk analytics or for a "supply USDC against stock collateral" product. This step gives lending pools the same treatment the DEX pools got: a confirmed registry, a 5-minute collector, complete history, and replay-based checks.

**What a lending pool is here.** One debt reserve that lenders supply into, plus the collateral reserves or vaults that secure borrowing from it.
- **Kamino:** a market holds collateral reserves (the xStocks) and debt reserves (USDC, USDG, PYUSD). A lender's exposure is that market's collateral.
- **Jupiter Lend:** each vault pairs one collateral with one debt token, and all vaults borrow from one shared liquidity layer per debt token. A lender's exposure to stock collateral is the stock vaults' share of that layer's debt. The accounts were mapped and decoded on-chain in item 1 (VL-5: 872 of 872 fields equal the SDK's coders on all 8 vaults); the layer itself is live-only (D12).

**Probe 2026-10-01 ~20:10Z** (kept for the record; item 1's counts below replace it):

| Finding | Evidence |
|---|---|
| 27 accounts are snapshotted hourly today: 19 Kamino reserves in 3 markets (xStocks Market 13, STRCx Market 2, Sentora xStocks Market 4) and 8 Jupiter Lend vaults (TSLAx, SPYx, QQQx, NVDAx, each against USDC and JupUSD) | `~/.colosseum/risk/markets/2026-10-01.jsonl`, 20:02Z |
| Lending history is small. Transactions per day, from one page of 1,000 signatures per account: Kamino xStocks Market about 2,060 (by market address), STRCx Market about 1,120, Sentora about 260; Jupiter Lend vaults 8 to 77 each. The busiest DEX pool alone does about 250,000 a day. | `data/risk/lending-probe-20261001T2010.txt` |
| The xStocks Market USDC reserve had $5.69M supplied and $5.19M borrowed (91% lent out). What a lender can withdraw is the first thing to measure. | same markets file, 20:02Z, Kamino API (not yet checked on-chain) |
| `getTokenLargestAccounts` is not served by the Chainstack shared node. Holder searches must use `getProgramAccounts` by mint. | RPC error -32601, 20:12Z |
| `@jup-ag/lend` (0.4.0-beta.0) and `@jup-ag/lend-read` (0.0.14) exist on npm. Not yet tried. | `npm view`, 20:09Z |
| The pool history fetch (Step 5b.2) is still running: 13.8M of 24.9M transactions at about 495 tx/s, 128 parallel, 0 rate-limit errors. About 6 hours left. | `data/risk/history-full/fetch.jsonl`, 20:11Z |

**Measured by item 1 (2026-10-01 20:45–21:26Z; `data/risk/lending-measure.jsonl`, STATE-RISK row 10b):**

| Finding | Evidence |
|---|---|
| 4 Kamino markets list an xStock (a fourth, `BBmb1SYx…`, is missing from Kamino's API), 23 reserves; the same 8 Jupiter Lend xStock vaults on-chain and in the API; other programs holding xStocks listed for D14. | VL-1 |
| History: **1,635,068 distinct transactions over 515 days** (from 2025-04-15), within D10's 3M. VL-4's 2,363,692 summed per group counted shared transactions more than once. First transaction: xStocks Market 2025-07-08, STRCx 2026-05-03, Sentora 2026-08-26, `BBmb1SYx` 2026-09-15, Jupiter Lend vaults 2026-03-20…31. | VL-4, item 4 |
| Jupiter Lend's USDC liquidity layer sees about 139k transactions a day (≈27M over the vaults' life): live-only (D12). | VL-4 |
| Kamino and Jupiter Lend decode on-chain: 805 Kamino reserve fields = klend-sdk, 872 Jupiter Lend fields = the read SDK; on-chain = API within interest accrued between reads (xStocks Market USDC: 5,702,241.03 on-chain at 21:21Z vs 5,702,229.73 API at 21:02Z). | VL-2, VL-5, item 3 |
| Obligations per market: 7,041 xStocks, 337 STRCx, 25 Sentora, 1 `BBmb1SYx`; their cTokens equal the collateral vaults. | VL-6 |
| klend logs no events (amounts from instructions and token balances); Jupiter Lend logs `LogOperate`/`LogUserPosition`. | VL-7 |
| 10 curated vaults have a slot in a registered reserve, 6 hold cTokens (Sentora PYUSD 27% of the Sentora PYUSD reserve, Elemental USDC Turbo about 15% of the STRCx USDC reserve). | VL-8 |
| Storage: about 1.3 KB per transaction compressed, 2.1 GB of raw bodies, 4.6 GB in all in `data/risk/lending-history/`. | item 4, 2026-10-02 |
| The pool history fetch (Step 5b.2) finished 2026-10-02 01:39Z (24,776,866 transactions; 512 retried 15:48Z) and was repaired and closed at 16:19Z. | STATE-RISK row 5b |

**Constraints.**
- The running pool fetch (`history-full.ts`), the three risk launchd jobs and the old depth job are not disturbed. While the pool fetch runs, lending fetches use at most 16 parallel requests.
- Nothing already exported by `scripts/risk/lib-history.ts` or `scripts/risk/history-full.ts` changes behaviour; new code is added beside it.
- Read-only. No transaction is sent.
- **The collector (items 1–3) must be live before the weekend starts, Fri Oct 2 20:00 ET.** The first weekend of oracle prices against DEX prices cannot be re-collected.
- Obligations and positions are public chain data and are stored locally. The API and reports publish only market-level aggregates (LTV buckets, concentration shares), never a wallet's position.
- New tables carry a `chain` column (`solana` today), and each venue sits behind one adapter (`discover`, `readState`, `readPositions`, `decodeTx`), so Base and Robinhood Chain markets can be added later without changing the pipeline. No EVM code in this step.

**Do it in this order. Each item ends with a commit (`R10b.N: …`) and a line in STATE-RISK.**

1. **Verify and measure (about 1 hour).** Results go to `data/risk/lending-measure.jsonl` and STATE-RISK.
   - **VL-1 Venues.** Find every Solana lending venue that holds xStocks as collateral, not only the two we know:
     - Kamino `Reserve` accounts by liquidity mint, searched on-chain for each of the 50 registry xStock mints;
     - Jupiter Lend vaults from the API and from on-chain vault configs;
     - token accounts by mint for the 18 assets of the 80% set, grouped by the program that owns each account's authority.

     Programs we do not recognise are listed with their balance for the founder (D14). They are not ingested in this step.
   - **VL-2 Account map.** For each reserve: the liquidity vault, the collateral mint and vault, the fee vault and the oracle accounts. For each Jupiter Lend vault: its config and state accounts, the liquidity-layer accounts for its debt token, and its oracle accounts. Each is decoded and compared with the API.
   - **VL-3 Which addresses see every transaction.** Default: walk each reserve's vault token accounts (every money movement touches them) plus the market address (configuration changes). Over one day, confirm that the union covers every transaction found by walking the reserve accounts themselves.
   - **VL-4 Count.** Walk signatures back to each market's first transaction, counting only. Record the total, the first date per market and the failed share.
   - **VL-5 Jupiter Lend on-chain.** Decode vault config, state and positions with the two SDKs and compare with the API on all 8 vaults. If that fails, Jupiter Lend stays API-only, labelled `verification: 'api'`, and items 5–7 cover Kamino only.
   - **VL-6 Obligations.** One `getProgramAccounts` per Kamino market: count, time, size. Check that the obligations' deposits and debts per reserve sum to the reserve's own totals.
   - **VL-7 Events or instructions.** Check on 10 known transactions whether each program logs events for deposits, borrows and liquidations. If it does not, amounts come from the instructions plus token balance changes.
   - **VL-8 Curated vaults** (founder, 2026-10-01: track them, do not offer them). Find every curated vault that supplies into a registered reserve: decode the vault accounts, list each vault's allocations, and check that its position in each of our reserves matches the supplier found in VL-6. Count its transactions for VL-4. If the vault accounts cannot be decoded, the vaults are still counted as suppliers and the gap is reported.
2. **Registry.** `pnpm risk:lending-registry` writes `data/risk/lending-registry-<stamp>.json` and the table `risk_lending_pools`. One row per reserve or vault: chain, venue, program, market, role (`collateral` or `debt`), mints, vault accounts, oracle accounts, decimals, first-transaction time, the DEX-registry asset it maps to, and `verification` (`onchain` or `api`). Rows that fail confirmation are dropped with a reason.
   - Curated vaults from VL-8 are rows too, with role `curated_vault`, their manager, and `offered: false`. That flag keeps them out of every product list until the founder changes it (D15). Nothing is added to the engine's asset registry.
3. **Live collector.** A new job `com.colosseum.risk-lending` at minutes 1, 6, …, 56, from its own script `scripts/risk/collector/lending.ts`. `install.sh` gains a one-job mode so installing it does not reload the running jobs.
   - **Every 5 minutes:** one batched read of every reserve, vault, liquidity-layer and oracle account, decoded on-chain. Per row: supplied, borrowed, available to withdraw, share lent out, supply and borrow rate computed from the on-chain rate curve, caps and remaining headroom, the borrow index, and the oracle price with its age. Per curated vault: total assets, share price, idle cash, and the amount allocated to each reserve.
   - **Every hour:** every obligation and position (raw bytes, compressed, plus one decoded row each: collateral by asset, debt by asset, LTV), and raw bytes of all state accounts.
   - Failures are rows, never retried in a loop. The hourly API rows in the pool collector stay as they are; they become the independent cross-check, as Jupiter quotes are for pools.
   - Output: `~/.colosseum/risk/lending/`, `lending-positions/`, `raw-lending/`.
4. **History fetcher** (`scripts/risk/lending-history.ts`). Reuses the checkpointed signature walk, the per-day partition and the done markers from Step 5b, with the output directory as a parameter. Output: `data/risk/lending-history/`.
   - Window: each market's whole life (D10, founder 2026-10-01). If VL-4 counts more than 3 million transactions, stop and report before fetching.
   - Starts as soon as items 1–3 are done, beside the pool fetch, at 16 parallel while that fetch runs (founder 2026-10-01).
   - The raw body of every transaction is kept, compressed. So the fetch does not wait for the decoders of item 5.
   - A decode pass over the raw bodies writes one row per transaction: decoded events, the pre and post balances of every reserve vault it touches, instruction names, any undecoded payload, and a truncated-log flag. It can be re-run whenever a decoder changes, without fetching again.
   - Runs under `nohup` + `caffeinate`, resumable, with errors retried on the next run.
5. **Decoders** (pure functions in `packages/risk/src/lending/`, tested against frozen mainnet transactions and account bytes in `fixtures/risk/`). Hand-written, with no SDK import in the package; each one is checked against the SDK's own decoding in a script (D11).
   - **State:** Kamino `Reserve` and `Obligation` (the fields used, at fixed offsets); Jupiter Lend vault config, state and position.
   - **Kamino transactions,** including calls made by other programs (leverage routers, curated vaults): lender deposit and redeem, collateral deposit and withdraw, borrow, repay, liquidation, flash loan, reserve-configuration change, socialised loss. Refreshes are counted, not stored.
   - **Jupiter Lend transactions:** vault `operate` (collateral in or out, borrow or pay back), `liquidate`, and lender deposit and withdraw on the liquidity layer.
   - **Curated-vault transactions:** user deposit and withdraw, and the manager's reallocations between reserves (from which reserve, to which, how much). A reallocation out of one of our reserves is the event that can leave the remaining lenders unable to withdraw.
   - **Amounts** come from token balance changes, because instructions carry requests such as "all". The test: decoded amounts equal the vault balance changes exactly.
   - **Liquidation row:** market, position, debt repaid, collateral seized, implied bonus, liquidator, and any DEX sale of the seized stock in the same transaction, decoded with the Step 5b pool decoders. That sale gives the realised price against the oracle price and the pool's mid price.
   - **Configuration-change row:** which parameter, old and new value. This is the history of LTV, thresholds and caps.
6. **Completeness checks** (`pnpm risk:lending-verify`). They decide whether the history can be trusted.
   - Every walked signature is fetched or listed in `errors.jsonl`.
   - **Vault-balance chain:** for every vault, each transaction's pre-balance equals the previous transaction's post-balance. This is exact and is the main check.
   - **Backward replay:** from an hourly raw snapshot, undo events to an earlier snapshot. Available liquidity and collateral units must match exactly. Borrowed amounts must match within the interest accrued between events, recomputed from the reserve's rate curve; the error distribution is reported against `borrowReplayTolBps`.
   - **Positions:** for every live obligation opened inside the fetched window, the sum of its collateral events equals its current collateral exactly.
   - The 5-minute on-chain rows equal the hourly API rows at the same time, within rounding.
7. **Reconstruction** (`pnpm risk:lending-reconstruct`). Hourly series per reserve since its first transaction: supplied, borrowed, available, share lent out, rates, collateral units by asset, number of positions, and the LTV distribution by collateral asset.
   - USD values use the reconstructed pool mid price where Step 5b covers the hour. Earlier hours keep units only, with USD `null` and reason `no_price_source`. A uniform price source is Step 11 (the oracle standard).
8. **Tables and import.** One additive migration: `risk_lending_pools`, `risk_lending_snapshots`, `risk_lending_events`, and `risk_lending_positions` (hourly aggregates per market and collateral asset: LTV buckets and top 1, 3 and 10 shares; no owner column). `pnpm risk:lending-import` runs hourly from its own job at minute 12. Every row carries `source`, `fetched_at`, `method` and `provenance`.
9. **Analysis** (`pnpm risk:lending-report`; the founder's question: can the market absorb the collateral?). Report only; no product or UI in this step.
   - **Per lending pool:** history covered, events by type, and the share of hours with more than `utilAlarmPct` lent out (default 95%, a policy input).
   - **Lender concentration:** top 1, 3 and 10 suppliers' share, aggregates only. Curated vaults are products, not wallets, so they are named: each vault's share of each reserve's supply, its past reallocations, and what the share lent out would become if it left.
   - **Liquidations:** count, USD, largest, and the realised sale price against the pool mid, by regime.
   - **Oracle against DEX:** the gap between the lending oracle's price and the pool mid, by regime, from the 5-minute rows.
   - **Collateral at risk:** for each price gap in `gapGridPct`, the stock collateral that becomes liquidatable per asset (from the positions), against the routed DEX sale capacity at a cost equal to the liquidation bonus, in the worst regime. The ratio of the two is the **liquidation coverage ratio**. It reuses `gapSim` and the routed curves, with every assumption listed.

**Storage.** Raw bodies are about 15 KB each before compression and about 1.3 KB compressed: 2.1 GB measured for the whole history, 4.6 GB in all in `data/risk/lending-history/` (gitignored).

**Done when:**
- the registry is confirmed on-chain;
- the 5-minute collector has run through one full weekend without gaps other than laptop sleep;
- every signature in the window is fetched;
- the vault-balance chain has 0 breaks and the replay matches the saved snapshots;
- STATE-RISK records the counts, error rate and window;
- `pnpm risk:lending-report` prints the liquidation table and the coverage-ratio table.

**Not in this step:** the "supply USDC to a stock-collateral market" leg in the asset registry (Step 10), offering curated vaults as products (D15), dashboard pages, Base and Robinhood Chain markets, and the product catalogue. Each is planned separately and builds on these tables. The oracle standard is Step 11.

### Step 11 — The oracle standard: one reference price per asset and time *(decided 2026-10-02; started the same day)*

**Why.** Every USD figure in the risk layer needs a price, and today each script picks its own.
- 84% of the lending history has no USD value (125,992 of 150,364 reserve-hours, `data/risk/lending-history/hourly/reserves.jsonl.gz`): the only price is the pool mid, and Step 5b covers 28 days (D16), while the lending history starts on 2025-07-08.
- USDG, cbBTC, PYUSD, EURC and EUROP have no price at any hour.
- The lending oracles and the DEX disagree off-hours: Kamino's Scope prices sit below the routed pool mid by a median 0.2% to 2.2% on weekday off-hours and within 0.34% in US market hours (Step 10b item 9, `lending-report-20261002T1619.json`; 189 and 34 samples). A price without its source and its regime cannot be compared with another.

The oracle standard is one rule that answers "what is this asset's price at this time, from which source, and how old is it", used by every script, table and, later, the API.

**What it is.**
- **Sources** write **price observations** in one shape. A source is a pool mid, a lending venue's oracle, or (later) an external feed. Sources are never blended.
- **One resolver** picks a price from the observations for an asset, a time and a **purpose** (founder, 2026-10-02: D17, D18):
  - `valuation`: what the asset is worth. Order: pool mid, then an external feed once one is plugged in (D19), then a lending oracle. A price from a session that is open goes before a price an oracle is holding.
  - `liquidation`: what a venue acts on. Only that venue's own oracle, never the DEX.
- Every answer carries the price, its source and reference account, the observation's age, the regime at that time, and a **quality** label: `traded` (pool mid), `oracle_open` (a lending oracle while its session is open), `oracle_closed` (a lending oracle while it is closed: the last price of the session, held, not a traded price), `oracle_continuous` (an oracle of an asset priced around the clock: stablecoins, cbBTC), `external`, `par`. The other sources' prices at the same time are listed beside it, so both are always kept.
- **Recent enough** (set from item 2): a stock's lending oracle moves only in its own session, so its age is counted in session time: at most `maxOpenAgeSec` (2 hours) of open session since the observation, and never more than `maxClosedAgeSec` (4 days). Kamino's session is US market hours; Jupiter Lend's is the whole weekday, Sunday 20:00 ET to Friday 20:00 ET, without holidays. Everything else is judged on wall clock (`maxAgeSec`: pool mid 1 hour, others 2 hours, USD stablecoins 1 day).
- **Live** (found by item 2): an oracle that does not move through a US trading day is not pricing the stock (a placeholder). Its price is still what the venue acts on, so `liquidation` returns it, flagged; `valuation` does not use it.
- **Unit:** USD per whole token as held on-chain (raw amount ÷ 10^decimals), which is what the pool mid measures. Item 2 checks that every source agrees on it.
- No answer is a price too: `null` with a reason (`no_observation`, `stale`, `oracle_not_live`, `no_quote_price`).

**Probe 2026-10-02 ~17:40Z** (hints; item 2 replaces them with counts):

| Finding | Evidence |
|---|---|
| klend logs the Scope price it used on every reserve refresh (`Token: SPYx Price: 765.9673`), in the raw bodies already fetched: 25 to 44 readings per token on a quiet day | `data/risk/lending-history/raw/2025-09-01.jsonl.gz` |
| That day was a US holiday and MSTRx stayed at 334.1000: Scope holds the last price while the market is closed | same file |
| Each of the 17 Kamino reserve tokens maps to one mint, so a logged symbol names one asset | `~/.colosseum/risk/lending-registry.json` |
| Jupiter Lend's oracle program returns the exchange rate it used inside vault transactions (two u128, 60 returns on one day) | `raw/2026-09-10.jsonl.gz`, `Program return: jupnw4B6…` |
| The live Kamino rows hold two prices: the Scope feed now (about 30 s old) and the reserve's price at its last refresh (27 hours old on a quiet reserve). Only the first is a current price. | `~/.colosseum/risk/lending/2026-10-02.jsonl`, 17:26Z |
| The holiday calendar starts in 2026; the history needs 2025 | `fixtures/risk/us-market-holidays.json` |

**Constraints.**
- The six running launchd jobs are not stopped, reloaded or re-installed, and nothing is written into their output directories. The weekend collection that starts Fri Oct 2 20:00 ET cannot be repeated.
- No new fetching for items 1–4: they read the raw bodies and hourly rows already on disk.
- Read-only. `packages/risk` takes no SDK and never imports `packages/engine`.
- Every observation and every resolved price carries `source`, `fetched_at`, `method` and `provenance`. No price literal outside `fixtures/`.

**Do it in this order. Each item ends with a commit (`R11.N: …`) and a line in STATE-RISK.**

1. **Extract the observations** (`pnpm risk:prices-extract` → `data/risk/prices/obs/<source>/<day>.jsonl.gz`). Parsers are pure functions in `packages/risk/src/prices/`, tested on frozen mainnet transactions.
   - `kamino_scope`: each klend reserve refresh in the lending history, attributed to its reserve by the instruction's account, with the logged price, slot and block time. Refreshes of reserves outside the registry are counted, not stored.
   - `jupiter_lend_oracle`: the oracle program's return value inside each vault transaction, in the vault's debt token.
   - `pool_mid`: Step 5b's hourly mid of the asset's reference USDC pool, and the live 5-minute reference mid.
   - Live rows of the two lending oracles from the 5-minute collector files (Scope feed price, Jupiter Lend cache price with its market status).
2. **Validate** (`pnpm risk:prices-validate` → `data/risk/prices/validate-<stamp>.json`). It decides whether the logged prices can be trusted and sets the staleness limit.
   - **P-1 Coverage:** observations per asset and day, and the distribution of the time between consecutive observations.
   - **P-2 Extraction:** a logged price equals the reserve's stored price at the same refresh slot, as the collector read it later (the history ends 24 minutes before the collector starts, so the two never share a slot); a Jupiter Lend return agrees with the protocol API's oracle price in the hourly rows; one asset refreshed in two Kamino markets in one slot has one price.
   - **P-1 Liveness:** every stock oracle moves within US trading days; the days it does not are listed.
   - **P-3 Overlap:** each lending oracle against the pool mid from 2026-09-04, by asset and regime. This is the bias carried into earlier hours.
   - **P-4 Unit:** in US market hours the sources agree within the P-3 spread, which a per-share price would not (the tokens' multipliers are 1.0017 to 1.0057).
   - **P-5 Calendar:** on each 2025 date added to the holiday calendar, no Scope stock price changes.
   - A failed check is a finding. The tolerance is not widened to pass it.
3. **Resolver** (`packages/risk/src/prices/resolve.ts`, pure, no I/O). Inputs: an index of observations, the asset, the time, the purpose and `defaultPriceParams()` (`valuationOrder`, the limits from P-1, `parMints`, `continuousMints`), with the calendar and a clock of US market hours (`session.ts`). The liveness rule is `liveness.ts`. Output as in "What it is". Tests on frozen observations: order, staleness on market time, liveness, the quote conversion, both purposes, null reasons, an external source plugged in, determinism.
4. **Use it.** `lending-reconstruct`, `lending-import` and `lending-report` take prices from the resolver instead of their own lookups. The share of reserve-hours without USD is recorded before and after, by asset and by quality. Liquidations before 2026-09-04 gain a USD value.
5. **Tables, import and the live price.** One additive migration: `risk_price_observations` and `risk_reference_prices` (per asset and hour, the valuation price with its source, age, regime and quality, and each venue's oracle price beside it). `pnpm risk:prices-import` fills them from the observation files and the collectors' files, and is run by hand for now: the collectors and their launchd jobs are not edited before Oct 12 (`CLAUDE.md`), so its hourly job (minute 14, one-job mode) is installed after that date or on the founder's word. The latest row per asset is the live reference price; the oracle-against-DEX gap per asset is published with it.
6. **External source: the contract, not the code** (D19). An external feed is one more source. It is plugged in by writing observations with `priceSource: 'external:<name>'` and adding that name to `valuationOrder`; the resolver, the tables and the consumers do not change. What an adapter must state and pass:
   - what it prices (the stock share or the token) and its session: the hours in which its price moves, as an entry in `sessionBySource` (or none, if it is judged on wall clock);
   - the conversion to the standard unit: a per-share price is multiplied by the token's multiplier at that time, so the adapter needs the multiplier history of each mint;
   - its licence and cost, and whether history back to 2025-07 is served;
   - P-3 against the pool mid in US market hours, within `externalTolPct`, before it enters `valuationOrder`.

   Candidates to check when the founder decides, none verified yet: an oracle network's historical API for the same feeds the venues use (Pyth, Chainlink Data Streams), the issuer's own price feed, and a licensed equities market-data API.
7. **Weekend** (Mon Oct 5). Re-run item 2 with the first weekend of 5-minute rows: the `weekend` regime's gap per asset, and whether `oracle_closed` needs a published haircut.

**Done when:**
- every check in item 2 is recorded, pass or finding;
- the lending history's reserve-hours without USD fall to those with a stated reason, and the report says how many are `traded`, `oracle_open` and `oracle_closed`;
- `risk_reference_prices` holds one row per registered asset and hour up to the last import (hourly once the job is installed);
- the same inputs give the same resolved prices on two runs.

**Not in this step:** an external adapter (D19), an API route or dashboard page for prices (Step 7), any change to `packages/engine` (Step 8), and full-life pool history (D16).

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
| D10 | Lending history window and start | **Each market's whole life, fetched now beside the pool fetch at 16 parallel** (founder, 2026-10-01). Above 3 million transactions in VL-4: stop and report first. | done |
| D11 | Lending decoders | **Hand-written in `packages/risk`, each checked against the protocol SDK in a script and on frozen bytes.** SDKs stay in `scripts/`. | Step 10b item 5 |
| D12 | Jupiter Lend shared liquidity layer | **Live-only** (VL-4, 2026-10-01): the USDC layer's accounts see about 139k transactions a day, ≈27M over the vaults' life, far above D10's 3M; live 5-minute state since 2026-10-01 21:21Z. So Jupiter Lend has no replay or per-vault balance chain in item 6, and its lenders are not measured; the report states both. | done |
| D13 | Position-level data | **Stored locally; published as aggregates only** (LTV buckets, top-N shares) | done |
| D14 | Other lending venues found by VL-1 | **Listed with balances, not ingested for now** (founder, 2026-10-01); revisit when the list exists | done |
| D15 | Curated vaults that supply into registered reserves | **Tracked** (registry, 5-minute state, history, reallocations) **but not offered** (founder, 2026-10-01): `offered: false`, nothing in the engine's asset registry | done |
| D16 | Pool history window (Step 5b) | **28 days for the 29 older value pools until after the MVP; full-life history revisited then** (founder, 2026-10-02). The 5 pools created inside the window (MSFTx, AAPLx, SPCXx ×2, NVDAx/memecoin) are complete from creation; the lending pools are the long-horizon sample (whole life, D10). Estimated cost of the full life: 40–130 GB, 1–5 days at 500 tx/s, unmeasured. | done; revisit after the MVP |
| D17 | Oracle standard: what it serves | **Both the valuation of history and the live reference price** (founder, 2026-10-02) | done |
| D18 | When the DEX and a lending oracle disagree | **Keep both, never blend** (founder, 2026-10-02): valuation uses the pool mid where one exists and a lending oracle before that; a venue's liquidation triggers always use that venue's own oracle | done |
| D19 | External price source | **Planned, not built** (founder, 2026-10-02): Step 11 item 6 is the contract an adapter must meet, so one can be plugged in without changing the resolver. Which source: open. | open |

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
- **V-LEND-REG:** every lending reserve and vault is confirmed on-chain and mapped to its DEX-registry asset (Step 10b items 1–2; `risk_lending_pools`).
- **V-LEND-LIVE:** 5-minute decoded rows and hourly positions on disk, equal to the API rows at the same time (Step 10b items 3 and 6; `~/.colosseum/risk/lending/`).
- **V-LEND-HIST:** the vault-balance chain has 0 breaks and the backward replay matches the saved snapshots (Step 10b item 6; `tests/risk-layer/lending.test.ts`, `data/risk/lending-history/verify-*.json`).
- **V-LEND-RISK:** the liquidation table and the liquidation coverage ratio per asset and gap (Step 10b item 9; `pnpm risk:lending-report`).
- **V-PRICE:** every USD value names its price source, age, regime and quality, and the logged oracle prices pass the checks of Step 11 item 2 (`pnpm risk:prices-validate`).

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
| The lending collector is not live before the first weekend | Medium | Items 1–3 of Step 10b come first, with a cut-off of Fri Oct 2 20:00 ET; history can wait, the weekend cannot | Step 10b item 3 |
| The lending fetch slows the running pool fetch | Low | At most 16 parallel while `history-full.ts` runs; lending transactions per day are under 1% of the pools' (probe) | Step 10b item 4 |
| A lending program's account layout differs from the SDK version we check against | Medium | Hourly on-chain rows compared with the API rows; a mismatch marks the venue `degraded` and stops its numbers being published | Step 10b item 6 |
| Jupiter Lend accounts cannot be decoded | Medium | API-only, labelled; history and positions cover Kamino only, and the report says so | Step 10b item 1 (VL-5) |
| Interest accrual hides a missing borrow or repay event in the replay | Low | The vault-balance chain is exact and is the main check; borrowed amounts are checked within a stated tolerance | Step 10b item 6 |
| Installing the new job reloads the running collectors | Low | `install.sh` one-job mode; the other jobs' log mtimes are checked before and after | Step 10b item 3 |
| No price for collateral before the pool-history window | High | Units kept, USD `null` with a reason; filled from the lending oracles' logged prices, labelled by source and regime | Step 11 |
| A lending oracle's price is read as a traded price off-hours | High | Every resolved price carries its source, regime and quality; the off-hours gap per asset is measured and published (items 2 and 7) | Step 11 |
| Logged prices are too sparse on quiet days | Medium | The gap distribution sets `maxAgeSec`; past it the price is `null` with reason `stale`, never carried forward | Step 11 item 2 |

## 9. Open questions

| # | Question | Default |
|---|---|---|
| Q1 | Should any of the risk layer go into the hackathon submission (merge before Oct 12)? | No; decide by Oct 9 |
| Q2 | Dune API key for history? | Optional; without it, the RPC backfill is used |
| Q3 | LP-withdrawal alarm: drop in liquidity near price that triggers it (`withdrawalAlarmPct`)? | 20% within ±2% of price |
| Q4 | Tier A cut-off: 99% of liquidity (301 pools) or 95% (138)? | 99% |

**Answered on Oct 1:** lending history covers each market's whole life and is fetched now, beside the pool fetch (D10); other lending venues are listed, not ingested, for now (D14); curated vaults are tracked but not offered (D15); τ 1%; `shareOfDepth` 0.25; dry floor 0.25; too-slow issuer redemption is listed, not counted; no API rate limit locally, limited when live; old job re-installed with the key; start now; pool reads first.

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

