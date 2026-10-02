# PLAN-ANALYTICS.md — Step A of the risk layer: facts the agent reads

*Written Fri 2026-10-02 on branch `risk-analytics` (cut from `risk` at `42d37aa`, after `origin/main` was merged in). It continues `docs/risk/PLAN-RISK.md`; methods and decisions there still apply. Build prompts: `docs/risk/PROMPT-BUILD-ANALYTICS.md`.*

*Why a separate file and branch: Step 11 (the oracle standard) is being built on `risk` in the main checkout at the same time. This step lives beside it until it merges. Its status table (§7) moves into `STATE-RISK.md` as row A at that merge, and its decisions (§6) into `PLAN-RISK.md` §6.*

---

## 1. Summary

- **What exists.** The risk layer measures: exact pool simulation, routed sell and buy curves by time-of-week regime, LP concentration, 28 days of pool history, the whole life of the stock-collateral lending pools, and a lending report with a liquidation coverage ratio.
- **What is missing.** Nothing packages those measurements for the agent. Cost is one number with no fee split. The provider answers only "worst of all regimes". The lending analysis is a printed report with no route and no API. Assets other than xStocks have no measured facts.
- **What this step builds.** Three fact sheets with a fixed schema, each number carrying its source, time, method and quality:
  - `AssetFacts`: what it costs to enter and exit at your size, why, and how stable that is;
  - `LendingPoolFacts`: what a lender can withdraw, how well the collateral is covered, and how a liquidation gets sold;
  - `PlanFacts`: where a set of positions concentrates, what the whole plan costs to exit, and what a bad day does to it.
- **The founder's two questions (2026-10-02)** are the first deliverables: the expected loss when a client sells, with every fee, so the return is net (items 3–6); and how covered the stock-collateral lending pools are, with the best liquidation route the data allows (items 8–9).
- **Build now, fill later.** A fact whose data has not arrived is `null` with a reason, never zero. When the data lands, the fact fills in with no code change. §2 lists what is still to arrive.
- **Most likely failure:** scope. Seventeen items is more than one week. Phase 1 (items 1–11) is what the agent needs; Phase 2 (items 12–17) only fills more facts. If time runs short, Phase 2 items are dropped from the end.

## 2. Information still to arrive

Nothing here blocks an item. It decides which facts are `null` on day one.

| Information | Arrives | From | Facts it fills | Null reason until then |
|---|---|---|---|---|
| Weekend regime curves | Mon Oct 5, after the first collected weekend | the running collector | weekend exit cost, weekend ratio, coverage ratio in the measured worst regime | `no_samples_in_regime` |
| One reference price per asset and time | Step 11 items 3–5 | the Step 11 session | USD value of history, premium or discount against each lending oracle, volatility, drawdown, gap frequency | `no_reference_price` |
| The underlying share price | when D19 picks an external feed | open | tracking against the real stock, gap frequency on a long history | `no_external_source` |
| EVM depth (Robinhood Chain, Base) | Thom's collector, `method_version = evmq-0.1` | vault stream | the same exit facts on the two EVM chains | `chain_not_covered` |
| Pools of non-stock assets (USDY, syrupUSDC, USDT) | item 17, Mon Oct 5 at the earliest (DA3) | new read-only snapshot script | measured exit cost for dollar-yield tokens and stablecoins | `not_collected` |
| Issuer mint and burn history | item 14 | new read-only fetch | measured primary redemption capacity, replacing today's labelled assumption | `not_collected` |
| Where liquidators take seized stock when they do not sell in the same transaction | item 13 | new read-only fetch | the observed liquidation route for the other 164 of 268 liquidations | `not_collected` |
| BRS mint path | G-Nora | founder | anything specific to the BRL leg | `gate_open` |

## 3. The steps

**Who does what:** I build. You (the founder) do what is marked **YOU**. Each item ends with tests passing, `pnpm verify`, a commit `RA.N: …` and a row in §7.

**Constraints for the whole step.**
- **Branch and tree.** All work is on `risk-analytics`, in its own worktree. The main checkout belongs to the Step 11 session. Nothing here edits `docs/risk/PLAN-RISK.md` or `docs/risk/STATE-RISK.md`.
- **Nothing running is disturbed.** The six launchd jobs are not stopped, reloaded or re-installed, and nothing is written into `~/.colosseum/`. `scripts/launchd/`, `scripts/risk/collector/` and `scripts/depth-snapshot.mjs` are not edited before Oct 12 (CLAUDE.md). This weekend's collection cannot be repeated.
- **No migration until Step 11's lands.** Step 11 item 5 adds a migration. Two branches each generating the next number would collide, so this step's tables come in one migration in item 11, generated after Step 11 item 5 is merged. Before that, facts are computed from the existing tables.
- **Additive only (DA1).** `LiquidityProvider`, the existing `/risk/*` routes and `risk_depth_curves` rows of `risk-0.3` keep their shape. New fields are optional; new methods and routes are added beside the old ones. The vault design (`docs/vault/DESIGN-VAULT.md` §3.4) builds on them as they are.
- **Read-only.** No transaction is sent. New RPC fetches follow DA3.
- **Wallets (D13).** Positions, liquidators, LP owners and holders are stored locally and published as aggregates only.
- **Provenance.** Every number carries `source`, `fetched_at`, `method` and `provenance`. No price, fee or yield literal outside `fixtures/`. `packages/risk` takes no SDK and never imports `packages/engine`.

### Phase 1 — what the agent reads

**1. The contract.** `packages/schemas/src/facts.ts` (zod; the package still imports nothing).
- `Fact`: `{ value, unit, fetchedAt, regime?, sizeUsd?, source, method, methodVersion, provenance, quality }` or `{ value: null, reason, … }`. `quality` is one of `measured`, `lower_bound`, `assumption`. `reason` is a closed list (§2's reasons plus `beyond_measured_size`, `insufficient_samples`).
- `AssetFacts`, `LendingPoolFacts`, `PlanFacts` as in §4.
- A fixture provider for tests.
- **Check:** a test fails if any builder returns a numeric fact without `source`, `asOf` and `method`, or returns `0` where the input was missing.
- **YOU:** show Thom §4 and item 11's routes. His MCP tools read these.

**2. Three fixes owed before anything public reads the layer** (`DESIGN-VAULT.md` §8 lists them as this side's).
- A regime with too few samples counts as zero capacity. It becomes "not measured": the regime is skipped and named in `regimesMissing` (DA2).
- `POST /risk/positions/assess` can freeze the API.
- The hourly import grows until it runs out of memory.
- Each is reproduced with a failing test first. One that does not reproduce is recorded as such, not patched blind.

**3. The router as a pure function, with the fee tracked.** `packages/risk/src/pools/route.ts`.
- The same greedy split the collector uses (32 chunks across an asset's dollar-exit pools), moved into the package so it can be tested and reused. The collector file is not edited; it keeps its own copy until Oct 12.
- It returns what the collector's rows lack: the amount sent to each pool, and the cost split of §5.
- **Check:** on frozen raw snapshots, it reproduces the collector's stored routed row of the same run to 1e-9, for every asset and size, and the four parts of the split sum to the total exactly.

**4. Cost breakdown curves.** `pnpm risk:cost-breakdown`.
- Reads the hourly raw pool snapshots (account bytes, already on disk), re-runs the router, and fits the split per asset, side, size and regime.
- Stored as optional keys on the existing curve points (`poolFee`, `transferFee`, `basis`; `impact` is the rest). No migration. A test shows the provider's answers are identical before and after.
- Network fee per swap: measured from the fee field of real swap transactions (our own `executions` first, the Step 5b history if it kept the field). `null` with `insufficient_samples` below `minSamplesPerPoint`.
- **What you'll see:** per asset, a table by size and regime: total cost, then pool fee, transfer fee, impact and basis summing to it, plus the network fee in dollars.

**5. Entry, round trip and net return.** Pure functions in `packages/risk/src/facts/returns.ts`.
- Entry cost from the buy curves (already fitted, never exposed).
- Round trip for a size, an entry regime and an exit regime.
- Net return and break-even gross return for a holding period (§5).
- **Check:** hand-computed cases, and the property that net return is below gross whenever any cost is positive.

**6. Per-regime answers from the provider.** Additive methods: `exitCostIn(asset, usd, regime)`, `entryCostIn(…)`, `costBreakdownIn(…)`, `regimesMeasured(asset)`.
- The existing worst-regime methods are unchanged, except for item 2's fix.
- **Check:** `tests/engine-baseline.test.ts` is unchanged; with a fixture provider, `exitCostIn` in each regime equals the curve, and the worst-regime method equals the maximum over the measured regimes.

**7. `AssetFacts` for stocks.** `packages/risk/src/facts/asset.ts`, built from the existing tables:
- exit and entry cost on the size grid by regime, with the split; exit capacity at τ; the weekend ratio;
- LP concentration (top 1, 3, 10 in the band), the cost if the top `lpExitN` leave, and LP-withdrawal events in the last 7 days;
- premium or discount of the pool mid against each lending oracle, by regime (from the lending report's rows until Step 11's table exists);
- lending use: the share of the token's lending collateral, and its coverage ratio at each gap (item 8);
- the issuer route, labelled `assumption` until item 14;
- data coverage: samples and dates per regime, and which regimes are missing.

**8. Liquidation: coverage and the simulated route.** `packages/risk/src/lending/route.ts`, and two new sections in `pnpm risk:lending-report`.
- **Liquidator margin** per route, size and regime (§5): the bonus, the oracle-against-DEX gap and the sale cost in one number.
- **Routes compared:** one routed sale across dollar and SOL pools now; a two-hop sale through the pools that pair the stock with another token (188 pools not counted today); waiting for the next US market open; issuer redemption (`assumption`).
- **Liquidation capacity** = the largest seized amount with margin ≥ `minLiquidatorMarginPct`. **Coverage ratio** = capacity ÷ collateral liquidatable at each gap. The report keeps the earlier definition beside it so the two can be compared.
- **Check:** on the frozen report fixture, the earlier ratio is unchanged; with the oracle gap set to zero and one route, the new ratio equals the earlier one.

**9. Liquidation: the observed route.** From the liquidation events already decoded (no new fetch).
- Per asset, regime and size bucket: which venue and pool the 104 same-transaction sales used, and the realised price against the oracle and against the pool mid.
- Simulated best route against the observed one, where both exist.
- The other 164 liquidations are counted as `not_followed` until item 13.

**10. `LendingPoolFacts` and `PlanFacts`.**
- `LendingPoolFacts`: withdrawable now and the share lent out; hours above `utilAlarmPct`; supply-rate level and variability; lender concentration; collateral mix; coverage ratio per gap; best liquidation route; liquidations and socialised losses to date; parameter changes in the last 30 days; the oracle gap.
- `PlanFacts` for a list of positions: concentration by issuer, chain, class, venue and quote token; exit cost of each leg and of the plan sold at once (legs that share a route are flagged, not summed blindly); net return after entry and exit; the existing breach assessment; a stress table (weekend gap on the stock legs, top LPs leaving, a lending pool fully lent out). The share of the plan that is measured is stated.
- No probability of reaching the goal: the product has none yet (`HANDOFF-VAULT.md`, "the odds").

**11. Surface.** One additive migration (after Step 11 item 5 is merged), an hourly import, and routes in `apps/api` and `apps/risk-api`:
- `GET /risk/facts/assets/:id?sizeUsd=`, `GET /risk/facts/lending/:account`, `POST /risk/facts/plan`, `GET /risk/lending/coverage`.
- OpenAPI from the zod schemas; a methodology section generated from §5.
- **Check:** each route over HTTP equals the pure builder on the same rows; a `null` fact reaches the response with its reason.
- **YOU:** open `/docs`, read one asset sheet and one lending sheet, and tell me what reads wrong.

### Phase 2 — more facts (each one fills `null`s; dropped from the end if time runs short)

**12. Market risk** (needs Step 11's `risk_reference_prices`). Per asset and per plan: volatility, drawdown, correlation between legs. **Gap frequency:** how often the price moved by more than each value of `gapGridPct` between a Friday close and the Monday open, with the sample count, never extrapolated. It turns the coverage ratio at a 20% gap into "seen N times in M weekends".

**13. Follow the seized stock** (new fetch, small: 164 liquidations). For `followHours` after each liquidation: sold in a registry pool (which, at what price), sent to another program, or held. Aggregates only.

**14. Issuer mint and burn.** A probe first: which address sees mints and burns without seeing every transfer. Then the history, and the measured size and timing of primary flows. It replaces `capacityUsdPerOpenHour`.

**15. Liquidity stability.** Variation of exit capacity across snapshots by regime; LP owners behind the position NFTs, so one owner in several pools is seen; how long depth takes to return after a large trade (from the Step 5b history).

**16. Flow and holders.** Volume from successful swaps only; turnover against depth; net sell pressure; holder concentration and the share held in wallets, lending and pools.

**17. Assets that are not stocks.**
- **Dollar-yield tokens and stablecoins:** a read-only snapshot script, outside the collector, simulates their pools with the same decoders and writes routed rows under its own `method_version`. Then the same exit facts apply. Plus the deviation from par or from the issuer's published value, and redemption terms as a labelled sheet.
- **Lending supply legs outside the stock markets** (the engine's `kamino-usdc`): `LendingPoolFacts` once the reserve is registered. The lending collector reads the registry, so this waits for Oct 12.
- **Gold** is an xStock (GLDx) and is already covered.
- **BRL leg:** FX variability from the BCB series and the parameterised cap. Nothing BRS-specific (CLAUDE.md).
- **EVM stock tokens:** the builders read Thom's `evmq-0.1` rows as they are. No EVM code here.

**Done when:**
- the three routes answer for every asset in the 80% set, with each missing fact `null` and its reason;
- for one asset and size, the sheet's exit loss in dollars equals a live Jupiter quote taken at the same minute within the routing tolerance, fees included;
- `pnpm risk:lending-report` prints the route table and both coverage ratios;
- the engine baseline test is unchanged;
- `pnpm verify` passes.

**Not in this step:** any dashboard page, the MCP tools (Thom's stream), an external price adapter (D19), EVM collectors, a probability of reaching the goal, and any change to the collectors.

## 4. The fact sheets

Field lists, not final schemas; item 1 fixes them.

| Sheet | Keyed by | Blocks |
|---|---|---|
| `AssetFacts` | asset id, optional `sizeUsd` | `exit`, `entry`, `roundTrip`, `breakdown`, `capacity`, `liquidityStability`, `tracking`, `lendingUse`, `issuerRoute`, `marketRisk`, `coverage` |
| `LendingPoolFacts` | reserve or vault account | `withdrawal`, `rates`, `lenders`, `collateral`, `coverageByGap`, `liquidationRoute`, `history`, `oracle`, `coverage` |
| `PlanFacts` | a list of `{assetId, valueUsd}` and optional withdrawals | `concentration`, `exit`, `netReturn`, `breach`, `stress`, `measuredShare` |

`coverage` in each sheet is the data's own coverage: samples, dates, regimes measured and missing.

## 5. Methods (`method_version = facts-0.1`)

Names in `code` are policy inputs, stored beside every output.

- **Cost of a trade.** For a sale of notional `n` (USD at the reference mid `P_ref`, the mid of the asset's largest pool) that returns `out`: `cost = 1 − out / n`. Split, with `a_i` the filled USD sent to pool `i`:
  - `poolFee = Σ a_i × f_i / n`, where `f_i` is pool `i`'s fee rate at that snapshot (the static rate on Orca, flagged, until the adaptive fee is modelled);
  - `transferFee`: the token's own Token-2022 fee on each leg it applies to;
  - `basis = Σ a_i × (1 − P_i / P_ref) / n`: the pools used against the reference pool. It can be negative, which is why small sales sometimes show a negative cost today;
  - `impact = cost − poolFee − transferFee − basis`.
- **Loss in dollars** for a client: `n × cost + networkFeeUsd + n × platformFeeBps / 10⁴`. `networkFeeUsd` is measured. `platformFeeBps` is what the product or the aggregator charges; it is a policy input (DA5).
- **Round trip.** `1 − (1 − entryCost(n, r_in)) × (1 − exitCost(n', r_out))`, with `n'` the position's value at exit.
- **Net return.** With gross return `g` over the holding period, entry cost `c_in` and exit cost `c_out`: `net = (1 − c_in)(1 + g)(1 − c_out) − 1`, less fixed fees over `n`. Break-even: `g* = 1 / ((1 − c_in)(1 − c_out)) − 1`. Returns are computed, never promised.
- **Liquidator margin.** A liquidator repays debt `d` and seizes stock worth `d(1 + b)` at the venue's oracle price `P_o`. Sold through a route at cost `c(s, regime)` against the DEX mid `P_m`: `margin = (1 + b) × (P_m / P_o) × (1 − c) − 1`. The venue's own oracle is used for `P_o` (D18).
- **Liquidation capacity and coverage.** Capacity is the largest seized notional with `margin ≥ minLiquidatorMarginPct` (default 0) on the best measured route. Coverage ratio at gap `g` is capacity ÷ the collateral that becomes liquidatable at `g`, from the positions, under each venue's close factor.
- **Best route.** The route with the highest recovered value among those measured. Every alternative is listed with its value or its `null` reason. A route resting on an assumption (issuer redemption) is never chosen over a measured one; it is shown beside it.
- **Joint exit.** Legs are routed in the same snapshot. Legs whose routes share a pool, or the SOL leg, are flagged `shared_route`, and their cost is recomputed with the shared pool taking the combined amount.
- **Stress.** Each scenario is a named change to an input, applied to the same functions: a gap `g` on stock legs, the top `lpExitN` LPs leaving, a lending pool with nothing to withdraw. No scenario invents a number; each states its inputs.

## 6. Decisions

Defaults apply unless you change them.

| # | Decision | Default | Needed by |
|---|---|---|---|
| DA1 | May this step change the shape of anything the vault work already reads? | **No.** Additive only | item 1 |
| DA2 | A regime with too few samples | **Not measured** (skipped, named in `regimesMissing`), no longer zero capacity. Capacity answers can rise where a thin regime was zeroing them; the plan view says which regimes were measured | item 2 |
| DA3 | New read-only RPC fetches during this weekend's collection | **Small ones only:** at most 8 parallel, no `getProgramAccounts` scans. Items 14–17's larger fetches start Mon Oct 5 | item 13 |
| DA4 | Wallet-level data (liquidators, LP owners, holders) | **Local, aggregates only**, as D13 | item 9 |
| DA5 | Platform fee in the client's loss | **Shown as its own line, 0 bps** until the product charges one | item 4 |
| DA6 | Does any of this go into the Oct 12 submission? | **Follows Q1** in `PLAN-RISK.md` §9 (decide by Oct 9) | Oct 9 |

## 7. Status

| Item | Status | Evidence |
|---|---|---|
| 1. Contract | done | `packages/schemas/src/facts.ts`: `Fact` (measured or `null` with one of 11 reasons), `CostBreakdown`, `AssetFacts`, `LendingPoolFacts`, `PlanFacts`, and `collectFacts` (every fact in a sheet, plus any bare number stored as one). `tests/risk-layer/facts-contract.test.ts` (4 tests): a measured fact without its source, method, time, version, provenance or quality is rejected; a `null` without a listed reason is rejected; a sheet with a missing weekend parses and its 40+ facts are all complete. The check on builders (no `0` for missing input) runs in each builder's own test from item 7 on. Still **YOU**: show Thom §4. |
| 2. Three fixes | in-progress (1 of 3) | **Zero capacity: fixed (DA2 default applied).** Reproduced first: with a weekend curve of 3 samples per size, `exitCapacity` answered `$0` in `weekend`, `exitCost` `null`, the weekend ratio `0`, and a breach check gave the leg no capacity (`tests/risk-layer/provider-regimes.test.ts`, 5 failing tests before the change). Now `measuredRegimes` (`packages/risk/src/assess.ts`) names such a regime with its reason; the provider's worst-regime answers, the weekend ratio and the breach check skip it, and `assess` returns `regimesMissing`. `worstCapacity` itself is unchanged (the lending report passes it measured regimes). `tests/engine-baseline.test.ts` and `tests/liquidity-hooks.test.ts` unchanged and passing. **Still todo:** the `POST /risk/positions/assess` freeze and the hourly import's memory. |
| 3. Router with fee split | todo | |
| 4. Cost breakdown curves | todo | |
| 5. Entry, round trip, net return | done | `packages/risk/src/facts/returns.ts`: `lossUsd`, `roundTripCost`, `netReturn`, `breakEvenReturn`, `annualCostDrag`, `netReturnAtSize` (the exit is priced at the size the position has become; `null` with the side that is not measured). `tests/risk-layer/facts-returns.test.ts` (7 tests): hand-computed cases, net below gross for every positive cost, fixed fees charged both ways. Deviation: the round trip compounds, `1 − (1 − c_in)(1 − c_out)`, so it agrees with the net return; §5 said the sum, which is the same to first order. |
| 6. Per-regime provider | done | `RegimeLiquidityProvider` (`packages/schemas/src/liquidity.ts`) extends `LiquidityProvider` with `regimes`, `exitCostIn`, `entryCostIn`, `exitCapacityIn`; `createLiquidityProvider` returns it and takes optional `buyCurves`; `apps/api/src/liquidity.ts` loads both sides. Existing callers typed `LiquidityProvider` compile unchanged. `tests/risk-layer/provider-regimes.test.ts` (11 tests). Live check `pnpm risk:provider-check 10000` (2026-10-02 ~18:00Z, curves `risk-0.3`): SPYx exit 0.0216% in US market hours and −0.0070% on weekday off-hours, entry 0.0756% and 0.0889%, round trip 0.0972% and 0.0819%, capacity at 1% $380k and $444k; QQQx exit 0.1903% and 0.1964%, capacity $90k and $87k; weekend and holiday `no_samples_in_regime` for both. The numbers move with each hourly curve fit. |
| 7. `AssetFacts` | todo | |
| 8. Liquidation coverage and simulated route | todo | |
| 9. Observed liquidation route | todo | |
| 10. `LendingPoolFacts`, `PlanFacts` | todo | |
| 11. Surface | todo (waits for Step 11 item 5's migration) | |
| 12–17. Phase 2 | todo | |

### Discovered

- 2026-10-02: order changed. The stored curves' cost already holds the pool fee and the token's transfer fee, so the return math needed the entry side, the round trip and per-regime answers first (items 5 and 6, done). The fee split (items 3–4) explains the cost; it does not correct it.
- 2026-10-02: item 3's check cannot be met from the raw snapshots as written. The collector keeps raw account bytes hourly for concentrated-liquidity pools in the top 80% of TVL only, while a routed row uses every dollar-exit pool of the asset (CPMM and DLMM included). Three ways to get the amount sent to each pool: a read-only snapshot script of our own (new RPC reads, DA3); the per-pool 5-minute curves interpolated between grid sizes (approximate, error measurable against the stored routed total); or two lines in the collector after Oct 12 so each routed row stores its split. Item 3's router is still tested for equality with the collector's algorithm on frozen pool fixtures.

- 2026-10-02: the routed curves show a negative sell cost at small sizes (NVDAx $100: −0.02% at 00:02Z). The reference mid is the largest pool's, and a smaller pool was priced better. It is the `basis` term of §5, not an error; the sheet must show it so a negative cost is not read as a free trade.
- 2026-10-02: `main`'s `pnpm verify` typechecks `scripts/` and `tests/` and formats fixtures. The merge into `risk` (`42d37aa`) fixed eight type errors and two fixture formats that the older check never saw.
- 2026-10-02: `PROMPT-BUILD-LENDING.md` still sits at the repo root; `main` moved its siblings to `docs/risk/`. Left in place: Step 10b's plan text names that path.
