# PLAN-UNIVERSE.md — the tracked stocks, every pool they trade in, and the oracle a rebalance needs

*Written Mon 2026-10-05 on branch `docs/universe-plan` (cut from `staging` at `7bbdef6`). It continues `docs/risk/PLAN-RISK.md` and `docs/risk/PLAN-ANALYTICS.md`; methods and decisions there still apply. Build prompt: `docs/risk/PROMPT-BUILD-UNIVERSE.md`. Decision: gate `UNIVERSE` in `docs/GATES.md`. Ledger row: RISK-5 in `docs/vault/STATE-VAULT.md`.*

*Scope: Solana and Robinhood Chain. Base is not in this plan (gates `BASE` and `RH-PARALLEL`).*

---

## 1. Summary

- **The rule (founder, 2026-10-05).** On each chain, rank the pools of every stock token by the money they hold. The pools that make 80% of the total name the **tracked stocks**. Then track **every pool** of each tracked stock, not only the pools inside the 80%. More pools known means a better route for a trade.
- **The oracle.** A rebalance the vault runs by itself is checked against an oracle price. So each tracked stock carries its oracle (which one, where, how old it runs, how far it sits from the pool price). A tracked stock with no oracle is still tracked and still tradable with the owner's signature; it is never rebalanced automatically.
- **Solana: the cut is done, most pools are already collected.** 18 stocks, 869 live pools, read every 5 minutes or every hour since Oct 1. What is missing is using them: the router plans through 129 of the 869.
- **Robinhood Chain: nothing systematic exists.** The collector measures 21 tokens picked by hand and keeps three pools each. The chain's 195 stock tokens were never ranked.
- **What this plan builds.** One asset list per chain (the tracked stocks, their pools, their oracle), a Robinhood discovery pass and a collector that reads the list, the oracle recorded beside the pool price on both chains, and a router that can use the pools it ignores today.
- **Most likely failure:** the Robinhood discovery. Uniswap v4 keeps every pool inside one contract, so listing all pools of a token needs event logs, and the free RPC may refuse the range. Item 2 probes this first and has a fallback.

## 2. What we know now

| Fact | Evidence |
|---|---|
| Solana, registry of 2026-10-01 01:39Z: the pools holding 80% of on-chain TVL belong to 18 stocks: AAPLx, AMZNx, COINx, CRCLx, GLDx, GMEx, GOOGLx, HOODx, MCDx, METAx, MSFTx, MSTRx, NVDAx, QQQx, SPCXx, SPYx, STRCx, TSLAx | `data/risk/registry-20261001T0139.json`, sorted by `tvlUsd` (recomputed 2026-10-05) |
| Those 18 stocks have 5,179 pools with money in them; 869 hold $1,000 or more. Together the 18 hold 96.3% of all xStocks pool TVL | same file |
| The 869 by venue: 610 Raydium CPMM, 163 Raydium CLMM, 60 Orca Whirlpool, 36 Meteora DLMM. By refresh: 661 every 5 minutes, 208 hourly. All 869 are already collected | same file; `docs/risk/STATE-RISK.md` rows 1 and 2 |
| The 869 by how a seller reaches dollars: 71 straight to USDC or USDT, 58 through SOL, 22 through another xStock, 718 paired with some other token. The router (`routeTrade`) and the split snapshot use only the first two groups: 129 pools | same file (`exitPath`); `PLAN-ANALYTICS.md` §7 item 4 |
| Raw tick and bin arrays are recorded hourly for 32 concentrated-liquidity pools (the 80% pools). The 18 stocks have 259 such pools | `PLAN-ANALYTICS.md` §7 item 20 |
| Against Jupiter at $100k our router is worse by 27 bp (sell) and 19 bp (buy); with the same pools on both sides the gap is 2.9 bp. The rest is pools we do not model: one Raydium fork (Byreal), proprietary market makers, an order book, and two-hop pools | `docs/GATES.md`, gate `ROUTING` |
| Solana oracle: Kamino Scope prices 10 of the 18 (AAPLx, CRCLx, GOOGLx, HOODx, METAx, MSTRx, NVDAx, QQQx, SPYx, TSLAx). No Scope entry found for AMZNx, COINx, GLDx, GMEx, MCDx, MSFTx, SPCXx, STRCx | `fixtures/solana-vault/scope-indexes.json` (from the Kamino collateral reserves, 2026-10-01) |
| The Solana vault refuses a keeper trade unless the Scope price is at most 120 s old and within a set distance of its 1-hour average. The distance (200 bps) is a placeholder | `docs/vault/DESIGN-VAULT.md`, the rule table, row 8 |
| Scope reads are already stored every 5 minutes (5,612 by Oct 2) in `risk_price_observations`, and `risk_reference_prices` holds one price per asset and hour with each venue's oracle beside it | `STATE-RISK.md` row 11 |
| Robinhood Chain has 195 stock tokens in the issuer's registry; 36 have a Chainlink feed. ETFs sit in the same registry (SPY, QQQ, GLD, SLV, USO, SGOV) | `docs/vault/research/open-questions/launch-shelf.md` (Oct 1) |
| The EVM collector reads 21 Robinhood tokens, keeps the three deepest pools DexScreener returns per token, measures only pools the vault's swap path reaches (Uniswap v3 pools the factory confirms, v4 pools with no hook), and stores the best single pool per size as `evmq-0.1` | `scripts/risk-evm/README.md`, `config.ts`, `pools.ts` |
| Other venues on Robinhood Chain quote stock tokens tighter than Uniswap; the vault's router does not reach them | `scripts/risk-evm/README.md`, known limits |
| Chainlink stock feeds on Robinhood Chain were seen 12 to 53 minutes old in session and 10 to 14 hours old off session. The EVM vault accepts a stock price up to 26 hours old inside a session window | `DESIGN-VAULT.md` line 68; `launch-shelf.md` spot checks |
| EVM curves are still stored under the Solana method name with a cut address for a symbol: the six lines in `scripts/risk/compute.ts` and the `inArray` in `apps/api/src/liquidity.ts` are not written (RISK-1). `pnpm risk-evm:import` has never met a database | `origin/staging` at `7bbdef6`; ledger row REVM-1 |
| `risk_price_observations` and `risk_reference_prices` have a `chain` column. `risk_pools` and `risk_asset_snapshots` do not | `packages/db/src/risk-schema.ts` |
| The migration token is held by Thom (API-2) | ledger row MIGRATION |

Not yet known, and item 2 or 5 finds out: how many Robinhood tokens the 80% cut names; how many of them have a feed; how many pools each has; how much of their liquidity sits in venues the vault cannot reach.

## 3. The steps

**Who does what:** the session builds. The founder does what is marked **YOU**. Each item ends with tests passing, `pnpm verify`, a commit `RU.N: …` and its row in §6.

**Constraints for the whole plan.**

- **Read-only on mainnet.** `eth_call`, `eth_getLogs`, account reads and public GETs. No transaction, no key, no wallet.
- **Nothing running is disturbed.** The Solana collectors and their launchd jobs are not edited, reloaded or re-installed before Oct 12 (`CLAUDE.md`). Thom's EVM loop keeps its `evmq-0.1` row shape: his files gain options, they do not change what a plain run writes.
- **Additive.** `LiquidityProvider`, the `/risk/*` routes and the `risk-0.3` and `evmq-0.1` rows keep their shape. New fields are optional.
- **No migration in the first pass** (DU6). The token is taken only if an item cannot be done without one.
- **Provenance.** Every figure carries `source`, `fetched_at`, `method` and `provenance`. A missing fact is `null` with a reason, never zero. No price, fee or yield literal outside `fixtures/`.
- **Nothing under `data/` is committed.** The asset list of item 4 is the one generated file that is.

### Phase 1 — Robinhood Chain

**RU.1 — The 80% rule as one pure function.**
`trackedSet(pools, { share: 0.8, minPoolUsd: 1000 })` in `packages/risk/src/universe.ts`: sorts by TVL, takes the shortest prefix that reaches the share, returns the pools of the cut, the assets they name, and every pool of those assets. No I/O. Both chains use it.
- **Check:** on a frozen copy of the Solana registry of Oct 1 (pool address, asset, TVL only) it returns the 18 stocks of §2 and their 869 pools. The cut's pool count is pinned by the test; the 34 in `PLAN-RISK.md` was counted on a slightly different base and the test records which base gives which count.

**RU.2 — Robinhood token list and pool discovery.**
- `pnpm risk-evm:universe`: reads the issuer's registry (`api.robinhood.com/rhj/assets`), checks each address on chain (`decimals()`, `symbol()`), writes `data/risk-evm/universe-robinhood-<stamp>.json`.
- `pnpm risk-evm:discover`: for every token, every pool, from three sources: DexScreener (at most 30 per token), the Uniswap v3 factory asked directly (`getPool` for the token against each quote token seen, at each fee tier), and Uniswap v4 `Initialize` events of the pool manager filtered by the token. Each pool is confirmed on chain as today. TVL is measured on chain where the pool holds its own balances (v3); for v4 it is computed from the pool's liquidity around the price, labelled as such.
- A pool the vault cannot reach (a hook, another venue) is kept and marked `reachable: false` with the reason (DU3).
- **Probe first:** whether the free RPC answers `eth_getLogs` over the pool manager's life. If not: dRPC's free archive, then DexScreener alone with the gap stated per token.
- **Check:** every token of the registry has a row (pools found, or `no_pool`); for the 21 tokens of today's `config.ts` the three pools the collector uses are among those found; the run prints its RPC calls and duration.

**RU.3 — The cut on Robinhood Chain.**
`pnpm risk-evm:pareto` applies RU.1 to RU.2's file and writes the tracked stocks, the pools of the cut, and all pools of the tracked stocks.
- **Check:** the file exists with counts at 80, 90, 95 and 99%; the tracked stocks are compared with the 21 collected today and the differences are listed for the founder.

**RU.4 — The asset list, one file per chain.**
`scripts/risk/universe/robinhood.json` and `solana.json`, generated by `pnpm risk:universe <chain>`, committed (DU2). One row per tracked stock:
- identity in the vault's shape (`BasketAsset` fields: id, chain, address, symbol, decimals, class, underlying, issuer, session);
- `inCut`, pool counts (all, reachable, by venue), TVL and share;
- `oracle`: `{ kind: 'chainlink' | 'scope', ref }` or `null` with `reason`;
- `autoRebalance`: true only with an oracle; otherwise false with the reason;
- `source`, `fetchedAt`, `method` on the row and on the oracle.
- A zod schema in `packages/schemas` (additive). The Solana file comes from the existing registry and the Scope fixture's source; no new chain read.
- **Check:** both files parse; Solana has 18 rows, 10 with a Scope oracle and 8 with `no_scope_entry`; every Robinhood row with a feed names an address that item 5 confirmed.

**RU.5 — The oracle map for Robinhood Chain.**
Feeds from Chainlink's reference directory (`feeds-robinhood-mainnet.json`). Each is confirmed on chain: `description()`, `decimals()`, `latestRoundData()`. A feed whose description does not name the token is refused.
- **Check:** every tracked stock has a confirmed feed or `no_feed`; the count of tracked stocks without one is printed for the founder.

**RU.6 — The collector reads the list and keeps every pool.**
- `scripts/risk-evm/config.ts` takes its Robinhood tokens from `robinhood.json` (the hand list stays as the fallback when the file is absent).
- The per-token pool limit becomes a setting; with the list present it is "all reachable pools".
- The asset row stays `evmq-0.1` (best single pool per size, now chosen among all). A new per-pool file `data/risk-evm/pools/<day>.jsonl` holds every pool's own quote at every size, method `evmq-pools-0.1`, so a split across pools can be computed later.
- **Check:** a run on the list writes one asset row per tracked stock and one pool row per reachable pool; for a token collected today, cost at each size is equal to or lower than the three-pool run at the same block (it can only improve); calls and seconds are recorded, and stay inside the hour.

**RU.7 — The oracle recorded beside the pool price.**
In the same run and at the same block, one Multicall3 call reads `latestRoundData()` of every tracked stock's feed. Rows go to `data/risk-evm/oracle/<day>.jsonl`; `pnpm risk-evm:import` loads them into `risk_price_observations` (`chain: 'robinhood'`, `price_source: 'chainlink'`, `source_ts` = the feed's `updatedAt`). No migration: the table already has the chain.
- **Check:** each row's age equals block time less `updatedAt`; a second import inserts nothing; a replayed fixture gives the same rows.

**RU.8 — EVM curves reach the API (closes RISK-1's lines).**
- The six lines in `scripts/risk/compute.ts` and the `inArray` in `apps/api/src/liquidity.ts`, as listed in `scripts/risk-evm/README.md`.
- `pnpm db:seed` also writes an `assets` row per tracked EVM stock from `robinhood.json`, `mint` holding the address exactly as the collector writes it.
- First real `pnpm risk-evm:import` against the local database. **YOU:** start the loop here (DU5: it runs on this machine). The files collected so far are on Thom's machine; they are imported too if he sends them, otherwise the history starts with the first local run.
- **Check:** `GET /risk/assets/<id>` for one Robinhood stock answers with its own symbol and `evmq-0.1`; every Solana answer is byte-identical before and after (`pnpm risk:provider-check`).

**RU.9 — What a rebalance needs to know, per asset.**
An optional `oracle` block on `AssetFacts` (additive), for both chains, built from `risk_price_observations` and the pool mids:
- which oracle and where; age at the median and the 95th percentile, by regime;
- gap between oracle and pool mid at the median, the 95th percentile and the maximum, by regime (kept apart, never blended: gate `ORACLE-VS-DEX`);
- the share of hours in which the vault's own check would have refused a trade, at the limits the vault holds today;
- `autoRebalance` and its reason.
- These measured ages and gaps are what replaces the vault's placeholder limits (Thom's side; this plan only delivers the numbers).
- **Check:** on a fixture, each figure is recomputed by hand; a stock with no oracle answers `autoRebalance: false, reason: no_oracle` and every oracle figure `null`; a stock with fewer than 8 observations in a regime answers `insufficient_samples` there.

### Phase 2 — Solana

**RU.10 — The Solana list.** Covered by RU.4: 18 stocks, 869 pools, 10 oracles. No collector change. **Check:** RU.4's.

**RU.11 — The router uses the pools it ignores.**
- First, a table for the founder: the 740 unused pools (22 through another xStock, 718 other) by quote token, with TVL, so it is plain where the money sits.
- Then `routeTrade` learns two hops: stock → quote token → dollars, only where the quote token's own way to dollars is measured (SOL, USDC, USDT, a tracked xStock). Other quote tokens stay listed, not routed.
- The split snapshot (`pnpm risk:split-snapshot`) reads the wider set. It is our own script and job, not a collector.
- **Check:** on frozen pools, a two-hop route equals the two swaps simulated by hand; with two hops off, every stored result is unchanged; `pnpm risk:routing-gap` is run before and after on the same quotes, and the $100k gap to Jupiter (27 bp sell, 19 bp buy) is reported as it comes out. If the gain is under 2 bp, that is recorded and the wider read is switched off.

**RU.12 — Raw arrays and history for every concentrated-liquidity pool of the 18.**
Today 32 pools are recorded hourly; the 18 stocks have 259. A new hourly job with its own installer writes the other pools' tick and bin arrays in the collector's format, the way the price job was added (gate `PRICE-JOB`): no existing collector file is edited and no running job is reloaded.
- **YOU:** install it. Until then the session proves the bundle from a temporary folder only.
- **Check:** one run's files decode with `packages/risk/src/pools`; the pool-liquidity route answers `basis=recorded` for a pool outside the 80%; the job's RPC calls and duration are recorded.

**RU.13 — The venues we cannot read.**
One table: for the 18 stocks, how much liquidity and 24-hour volume sits in Byreal, the proprietary market makers and the order book (from the discovery data, labelled as estimates). Decision D4 of `PLAN-RISK.md` stands: a venue is added only when its decoder passes the same validation as the four we have. This item decides, with numbers, which decoder is worth building first. It builds none.
- **Check:** the table exists with its source and date.

## 4. Decisions

| # | Question | Default | Status |
|---|---|---|---|
| DU1 | Which money counts for the 80% | TVL measured on chain, pools of $1,000 or more, every confirmed venue, reachable or not | default |
| DU2 | Where the asset list lives | `scripts/risk/universe/<chain>.json`, generated and committed. The collector, the seed and the vault's asset entries (OPS-4) read it | default |
| DU3 | Robinhood pools the vault cannot reach | Tracked and marked, never routed. They show what an aggregator would get, and which venue is worth allowlisting | default |
| DU4 | A second oracle on Solana for the 8 stocks Scope does not price | Not now. The vault reads Scope only; the 8 are tracked and owner-signed. Pyth lists feeds for most of them, unverified on chain | default; Thom's side if reopened |
| DU5 | Where the Robinhood loop and its database run | On the founder's machine, locally, with the local database, as a new job started on his word. Thom's loop keeps running until the new one has a clean day. A dedicated machine or cloud infrastructure may take it over later; nothing is built for that now | decided 2026-10-05 (founder) |
| DU6 | A `chain` column on `risk_pools` and `risk_asset_snapshots` | Not in the first pass. An EVM address cannot collide with a Solana one, and `venue` names the chain's exchange. Asked for later, with the migration token | default |
| DU7 | ETFs in the Robinhood registry (SPY, GLD, SGOV, USO, SLV) | Ranked with the stocks: they are the same issuer's tokens in the same pools. Their class is set on the list row | default |

Settled by the founder on 2026-10-05 (gate `UNIVERSE`): the rule of §1, both chains, and the oracle as a condition of automatic rebalancing.

## 5. Not in this plan

- Base.
- A yield or exchange-rate reading for treasury and dollar-yield tokens. The collector measures the cost to sell; SGOV's multiplier and a yield token's rate over time are a separate step.
- A router that splits one sale across pools on Robinhood Chain. RU.6 stores what it needs; building it waits for the numbers.
- New decoders on Solana (RU.13 only ranks them).
- Any change to the vault program, the contracts or their limits. RU.9 delivers measurements; who sets the limits from them is the vault stream.
- A deploy, a hosted job, or any live data change.

## 6. Status

| Item | Status | Evidence |
|---|---|---|
| RU.1 The rule as a function | todo | |
| RU.2 Robinhood universe and discovery | todo | |
| RU.3 The cut on Robinhood | todo | |
| RU.4 The asset list | todo | |
| RU.5 Robinhood oracle map | todo | |
| RU.6 Collector on the list, every pool | todo | |
| RU.7 Oracle recorded | todo | |
| RU.8 EVM curves in the API | todo | |
| RU.9 Oracle facts per asset | todo | |
| RU.10 Solana list | todo (with RU.4) | |
| RU.11 Two-hop routing | todo | |
| RU.12 Raw arrays for all CL pools | todo | |
| RU.13 Unread venues, ranked | todo | |

Order: RU.1 → RU.2 → RU.3 → RU.5 → RU.4 → RU.6 → RU.7 → RU.8 → RU.9, then Phase 2. RU.8's code does not wait for RU.2 and can go first if the Robinhood probe stalls. RU.11 and RU.13 depend on nothing in Phase 1.

### Discovered

*(findings outside an item go here, dated)*
