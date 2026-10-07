# PROMPT (build): the portfolio section and the snapshot pipeline behind it

> Written 2026-10-06 by Rodrigo's session, after the discussion of Oct 6 on how a person's portfolio is to be watched over time. Run it in a fresh Claude Code session started at the repo root, on a branch cut from `staging` (`/start-work`, area `portfolio/`). It builds locally first, on the test networks; going live and mainnet are a person's word, later.

> **As built after slice 1 (PORT-1, 2026-10-07).** Where the code could not follow this prompt, the code and `DESIGN-VAULT.md` are right and these lines are not. Read them before starting slice 2 or 3:
> - `GET /v1/portfolio` already names each vault's stored plan (`planId`, the plan's id; API-ADD-MONEY did it, and `basketId` stays the plan's number on chain), so the line under slice 2 that extends the route is done and nothing more is added to that route. Slice 1 keeps the join in the database (`vaults.basket_id`, a `baskets` row per vault) and reads a vault's plan through it with `plansOf` (`VaultPlan`: kind, when it was placed, and for a stored plan its sheet, card, observations and verdict): slice 2's `/v1/portfolio/plans` is where that is answered.
> - The migration is `0017`, not `0016`: `0016_vault_name` was merged first.
> - Nothing writes `keeper_runs` or `keeper_legs`: the keeper's trades are not in the database, only the owner's legs are. `leg_attempts` holds no reference price and no cost: the quoted cost is in `legs.expected`, and it is the latest build's. ("Settled", and the rebalances route of slice 2.)
> - No read of many vaults by address exists on either reader, and `packages/chain-evm` makes no Multicall3 call: the worker reads one vault a call through its own seam (`apps/snapshot/src/source.ts`). ("Discovery".)
> - `user_wallets` is written by nothing. Owners are those of orders with a confirmed step and of the `vaults` rows, which the goal join now writes when a vault is opened. A leg names no vault address.
> - The band, the loss budget and the pause are kept on each snapshot row (`band_bps`, `loss_cap_bps`, `paused`), read once a pass from the chain's own settings. `VaultState` gained no field.
> - The index the body names on `vault_snapshots`, `(chain_id, address, observed_at desc)`, was not made: the unique key on `(chain_id, address, observed_at)` serves that read. The one other index is `(owner, observed_at)`, for a person's history by the addresses of their wallets.
> - `block_or_slot` is the chain's height at the start of the pass that read the vault, not the vault's own slot. Every read of the pass is at or after it, and it is null where the chain could not say.
> - A chain on the mock is read only when `SNAPSHOT_CHAINS` names it, and the worker's mock is a chain of its own, replayed from the `vaults` rows (`apps/snapshot/README.md`).
> - Two decisions were recorded, not one: `ON-TRACK-V1` and `SNAPSHOT-WORKER` (`docs/GATES.md`).

---

## The prompt

You are building the portfolio section of Tenonfi and the data pipeline under it: a worker that reads every vault we know every ten minutes and keeps what it read, an API that serves that history, and a section of the web app that shows a person their plans over time, whether each is on track, what rebalancing did, and how their strategies add up. Act as the orchestrator described in `.claude/rules/orchestration.md`: delegate bounded slices, verify what comes back, keep the ledger.

Build it in three slices, each one pull request into `staging`, each stacked on the one before if the earlier one is not merged yet (do not wait for a merge). A finished slice beats two half slices.

### Read first, as files

1. `CLAUDE.md` and `.claude/rules/orchestration.md`.
2. `docs/GATES.md`: `ONE-CHAIN`, `EXIT-SOURCE`, `CHAIN-SWITCH`, `CHAIN-PICK`, `MOCK-QUIET`, `UNIVERSE`, `NO-FREEZE`.
3. `docs/vault/DESIGN-VAULT.md`: section 2 (who imports whom; a new folder under `apps/` needs a row there and in `tests/boundaries.test.ts`), 3.1 and 3.2 (`VaultState`, `VaultView`, `Price`, `Sourced`, the adapter's `getVaults`, `getPrices`, `listAssets`), section 4 (the data model), section 10 (the keeper, hosting, the free RPC budgets), section 11 (the web app: "Home and the monitor", "His bar", "The portfolio", "Activity"), section 14 (roadmap seams: the event index is later).
4. `docs/vault/HANDOFF-VAULT.md`: item 5 "Stays on track", and the paragraph on the odds: the product says "On track", "Watch" or "Off track" with its reason, never a probability.
5. `docs/vault/research/portfolio-method.md` section 2.5: the status without odds. ENG-3 (Oct 5 to 12) is building that verdict inside the engine. You do not build it; you leave the seam for it (below).
6. `.design/branding/working-brand/patterns/STYLE.md` and the component specs beside it, above all the provenance pin, the goal card, the Bearing tile, and the "Never" and "Always" lists. They are binding on every screen.
7. Code, in this order:
   - `packages/db/src/basket-schema.ts`: `users`, `user_wallets`, `vaults` (the cache, overwritten on every read, one row per chain and address), `baskets`, `proposals`, `orders`, `legs`, `leg_attempts`, `keeper_runs`, `keeper_legs`, `price_observations`. The migrations in `packages/db/migrations/`.
   - `apps/api/src/routes/v1/portfolio.ts`: how a person's vaults are read today, chain by chain, through `view()` of `packages/basket`, and cached with `cacheVault` (`apps/api/src/orders/store.ts`).
   - `apps/keeper/src/{main,loop,round,chain}.ts` and `apps/keeper/README.md`: the loop with back-off, the adapters per chain, `hide` for node addresses in logs, `KEEPER_STATE_DIR`. Your worker reuses the loop and the adapters' read side and nothing that signs.
   - `packages/chain-mock`: the chain in memory, `withPriceMoved`, the contract tests. Your pipeline tests run on it.
   - `packages/sdk/deployments/testnet.json`: what exists on Solana devnet and Robinhood Chain's test network (46630).
   - `apps/web/features/portfolio/`: Thom's monitor (`MonitorScreen`, `VaultPanel`, `VaultGoalCard`, `use-portfolio.ts`, `use-vault-history.ts`, `vault-goal.ts`). Read `vault-goal.ts` closely: it joins a vault to its goal in the browser, from the order record, because the API does not. That join moves to the server in slice 1.
   - `apps/web/features/bearing/` and `apps/web/app/(app)/analytics/`: Rodrigo's Analytics 2.0 as built: a shell with a side menu, pages by id, a provider that holds the reads, figures drawn as SVG in `parts.tsx` and `Flow.tsx`. The portfolio section has the same shape.
   - `apps/web/features/order/order-record.ts` (`PlacedGoal`), `apps/web/features/order/activity.ts`.

### Settled; do not reopen

- The chain is the truth. Everything you store is a cache with `observed_at`, `provenance`, and for every price `source`, `fetched_at` and `method`. Nothing from a test network or the mock is ever shown as live: on the test networks every figure carries `sandbox` and the "test network" plate; on the mock, `mock` and the hatched glyph (`MOCK-QUIET`).
- No indexer and no event subscription (DESIGN-VAULT section 0 and 14). The worker reads state. Trades are already in `leg_attempts` and `keeper_legs`; that is the trade history.
- The worker holds no key, ever. It reads. It runs on the test networks until a person says otherwise; `mainnet` in `CHAIN_NETWORK_<CHAIN>` is refused at start, as the keeper refuses it.
- One plan, one chain (`ONE-CHAIN`). A person's portfolio is read on every chain they hold a wallet for (`CHAIN-SWITCH`), each chain on its own, and a chain that does not answer is said as unavailable, never as zero.
- No odds, no probability, no return promise. The status is one of "On track", "Watch", "Off track", with the rule that gave it printed beside it. The rule below is a first version (gate `ON-TRACK-V1`, to be recorded with `/decide` in the first pull request); ENG-3's verdict replaces it through the seam when it lands.
- No yield literal in code. No competitor named. The product words: goal, limits, plan, portfolio, exit plan, rebalance, Bearing. "Strategy" in a person's words is a plan in a vault; the screen may say "your plans" and, where a plan follows a shared portfolio, name it.
- Thom's monitor (`/monitor`, `features/portfolio/`) is not rewritten. The new section is additive, under its own route and feature folder. Which screen the bar's "Portfolio" item opens is Thom's and Rodrigo's to decide together, not yours: leave the bar as it is and reach the section from the monitor and from the goal page's vault card, until they decide.
- The collectors, `scripts/risk/`, `scripts/launchd/` and the launchd jobs are not touched.

### Discovery: how the worker knows which vaults to read

- The known vaults are the `vaults` table plus every vault a confirmed `create_vault` leg names. Each tick reads those by address: on Solana `getMultipleAccounts` in batches, on EVM `snapshot()` through Multicall3. This is cheap and is what runs every ten minutes.
- Discovery by owner (`getVaults(owner)` for every address in `user_wallets`) is heavier (`getProgramAccounts`, `vaultsOf`). Run it once an hour, at worker start, and when a new wallet row appears. A vault made outside the app is found this way within the hour.
- Only our people's vaults: those owned by an address in `user_wallets`, and those already in `vaults`. Not every vault the program holds.

### The snapshot and the status rule (`ON-TRACK-V1`)

A snapshot is one `VaultView` at one time, with the prices it stood on, kept whole. From snapshots and the trade tables the section derives everything else; nothing derived is stored except what is expensive and then only as a cache with its own time.

The status of a plan at a snapshot, first version:

| Status | When |
|---|---|
| On track | The deposit is confirmed on chain, every position is inside the vault's band, and loss used is under a quarter of the vault's loss budget |
| Watch | Any position is outside the band, or loss used is between a quarter and a half of the budget, or the newest snapshot is older than an hour |
| Off track | Loss used is past half the budget (the line the keeper alerts on), or the vault's chain has not answered for a day |

Printed beside the status: which line gave it, in words ("Every position inside the band; loss used 3% of the budget"). The band and the loss budget are the chain's settings, read with the vault (`KeeperView.rules` on the keeper's adapter; add the read to the adapter's read side if the plain `VaultState` lacks it, as a new optional field, never by changing an existing one). The seam: `statusOf(snapshot, goal, verdict?)`, where `verdict` is ENG-3's and absent today; when present it wins, and the rule says so.

### Slice 1: the schema, the goal join, and the worker

Delivers:

- Migration `0016` (renumber on rebase if Thom's work took it) in `packages/db`, in `basket-schema.ts`:
  - `vault_snapshots`: `id`, `chain_id`, `address`, `observed_at`, `block_or_slot`, `owner`, `basket_id` (nullable, the `baskets` row), `onchain_basket_id`, `accepted_version`, `auto_follow`, `value_usd` (display only), `cash` jsonb (`Holding`), `positions` jsonb (the `VaultView` positions: raw amount, display, price, value, weight, target, drift), `loss_used_bps`, `band_bps`, `loss_cap_bps`, `paused`, `prices` jsonb (every `Price` the view stood on, with its `source`, `fetched_at`, `method`), `provenance`, `source`, `method`. Unique on `(chain_id, address, observed_at)`. Index on `(chain_id, address, observed_at desc)`.
  - `snapshot_runs`: one row per tick per chain: `started_at`, `finished_at`, `vaults_read`, `vaults_failed`, `error`, `provenance`. One open run per chain, as `keeper_runs` does it.
  - `vaults.basket_id` is set by the API when an order's `create_vault` leg is confirmed: the order knows its proposal, the proposal its basket row, and the vault its plan number (`onchain_basket_id`, by the same rule the browser's `basketOfPlan` uses). That is the goal join, on the server. `baskets` gains nothing; `proposals.proposal` already holds the sheet.
- `apps/snapshot`: a worker with `--once`, `--loop [--interval 600]`, `--dry-run` (reads and prints, writes nothing), `SNAPSHOT_CHAINS` (default: every chain whose `CHAIN_MODE_<CHAIN>` is `live` or `readonly`), the keeper's `keepRunning` loop with its back-off (move `loop.ts` to a place both can import if that is the clean way; otherwise copy it with a note and a test that the two stay equal), the keeper's `hide` for node addresses, one JSON line per vault per tick (`read`, `failed`, `skipped` with the reason), healthchecks.io ping optional by `SNAPSHOT_PING_URL`. A row in DESIGN-VAULT section 2 ("`apps/snapshot`: schemas, basket, db, chain-* read side") and in `tests/boundaries.test.ts`.
- Discovery as above: by address each tick, by owner hourly and at start.
- `pnpm --filter @colosseum/snapshot start --loop` documented in `apps/snapshot/README.md`, with the local run: `pnpm db:up`, migrate, `CHAIN_MODE_SOLANA=readonly CHAIN_NETWORK_SOLANA=testnet SOLANA_RPC_URL=<devnet node>`; the same for Robinhood Chain's test network; and a `CHAIN_MODE_SOLANA=mock` run that fills the tables from `packages/chain-mock` so the web can be built with no node at all.

Tests:
- On `chain-mock`: two vaults, three ticks, `withPriceMoved` between them: three snapshot rows per vault, values move with the price, every price in `prices` carries source, time and method, provenance is `mock`.
- A chain that throws on one tick: `snapshot_runs` says so, the other chain's rows are written, the next tick goes on (the loop's back-off test, reused).
- A vault that appears by owner discovery between ticks is read from the next tick on.
- `mainnet` in `CHAIN_NETWORK_<CHAIN>` stops the worker before the first tick.
- The goal join: an order whose `create_vault` leg is confirmed on the mock sets `vaults.basket_id`; the portfolio route then answers the vault with its `basketId` and the plan's sheet.
- A recorded check, in the ledger row: the worker run `--once` against devnet, the line it printed and the row count, with no node address in either.

### Slice 2: the API

Delivers, under `apps/api/src/routes/v1/`, all `auth: 'user'`, `limit: 'standard'`, documented in OpenAPI with the disclaimer in every answer:

- `GET /v1/portfolio/history?from&to&step`: the signed-in person's vaults, each with its snapshots in the window, downsampled to `step` (`10m`, `1h`, `1d`) in the query, not by a job. Each point: time, value, cash, positions with weight, target and drift, provenance.
- `GET /v1/portfolio/plans`: one entry per vault with its plan: the sheet's goal, amount, horizon, income target where there is one, what was put in (confirmed deposits from `legs`), the value now, the status (`ON-TRACK-V1`) with its reason, the newest snapshot's age, and whether the plan follows a shared portfolio (name and version). The join is the server's (`vaults.basket_id`), never the browser's.
- `GET /v1/portfolio/rebalances`: every leg that reached the chain for the person's vaults, owner's and keeper's, newest first: when, who sent it, why (`Leg.trigger`: a version adopted, drift, the owner's tap), the trade, the reference price and the quoted cost in bps from `leg_attempts`, the explorer link, provenance, and drift of the traded asset before and after from the snapshots nearest each side.
- `GET /v1/portfolio/exposure`: the person's holdings summed across every vault by underlying and by issuer, in bps of the total and in dollars, with the roll-up of `packages/basket` where it applies, and the exit cost at the person's total size from Bearing's measured numbers where measured, the tier labelled as fallback where not (`EXIT-SOURCE`).
- `GET /v1/portfolio` is extended, not changed: each vault gains `basketId` as the `baskets` row id and, when there is one, `plan` (the sheet). Nothing existing is renamed.

Tests: endpoint tests on the mock as `portfolio.ts` has them; wallet B cannot read wallet A's history; a window with no rows answers an empty list, not an error; the downsample keeps the last point of each step; the status rule's three lines each produce their status on a constructed snapshot; the OpenAPI file is regenerated and committed.

### Slice 3: the section

Delivers, under `apps/web/app/(app)/portfolio/` and `apps/web/features/portfolio-section/` (a new folder, beside Thom's `portfolio/`), on the shape of the Bearing section (a shell with the side menu, pages by id, one provider holding the reads with TanStack Query keyed by person and chain), in both languages, at 375 px and 1280 px, light and dark, axe clean:

1. **Overview** (`/portfolio`): the total by chain with its pin, then one card per plan: the goal sentence, the chain plate, the value with its pin, what was put in, the status with its reason, the age of the newest snapshot. A person with several plans sees them side by side; the card opens the plan's page.
2. **A plan** (`/portfolio/plan/[chain]/[address]`): value over time (SVG, as Bearing draws its figures; no chart library without a decision recorded), with the deposits marked on the line; the drift table with the band as a shaded range; the status and its reason; the exit cost at this size; the risk roll-up; the rebalances of this vault; Thom's activity panel for its orders.
3. **Rebalancing** (`/portfolio/rebalancing`): the list from the API, grouped by vault, with a mark for the keeper's legs and the owner's, the cost in bps, drift before and after, and the explorer link beside the chain's explorer name (`WEB-CHAIN-A`).
4. **Exposure** (`/portfolio/exposure`): the sum across plans by underlying and by issuer as the Bearing heat tile draws shares, with the exit cost line.
5. **Methodology** (`/portfolio/methodology`): what a snapshot is, how often, what each status means and the rule's version, where each figure comes from, and that none of it is advice (the one `DISCLAIMER` constant).

Rules on the screens: every figure has its provenance pin (source, time, method, age; stale said as stale); test-network and mock plates per `MOCK-QUIET`; nothing on these pages signs; a chain that did not answer is a sentence, not a zero; the goal comes first on every card. Reach the section from the monitor's vault panel ("See over time") and from the goal page's vault card; the bar is left as it is.

Tests: event tests as Thom's screens have them (`*.events.test.ts`) for each page on fixtures; a Playwright spec as `e2e/bearing.spec.ts` is; the readings taken on the design (differences from the guide, as section 11 records them for other screens) written into DESIGN-VAULT section 11.

### Verification and the ledger

- `pnpm verify` green locally and on GitHub for each pull request. `pnpm test:program` and `pnpm test:contracts` only if you touched their folders; you should not need to.
- Each slice gets a row in `docs/vault/STATE-VAULT.md` (`PORT-1`, `PORT-2`, `PORT-3`) with the command, the result and the link, and `ON-TRACK-V1` in `docs/GATES.md` through `/decide` in slice 1.
- DESIGN-VAULT: section 2 (the new app folder), section 4 (the two tables and the goal join), section 10 (the worker beside the keeper: where it runs, that it holds no key), section 11 (the section's pages and the readings). Same pull request as the code it describes.
- `/review-pr` on each pull request before you call it done.

### Report, at the end of each slice

Changes, the evidence (commands and results), what could not be verified and why, the decisions you took that a document did not settle, and what the next slice depends on.
