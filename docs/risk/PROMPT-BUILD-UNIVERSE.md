# PROMPT (risk layer) — Build the tracked universe (PLAN-UNIVERSE)

> Use in a fresh Claude Code session started inside a checkout of this repository. Two prompts: **U-B** runs once per item, **U-D** runs when a decision of §4 is answered. The plan is `docs/risk/PLAN-UNIVERSE.md`.

---

## Where this stands (2026-10-05)

RU.1 to RU.6 and RU.10 are done. RU.1: `trackedSet` in `packages/risk/src/universe.ts`, checked on the frozen Solana registry. RU.2: `pnpm risk-evm:universe` and `pnpm risk-evm:discover` write the Robinhood token list and one row per pool (`scripts/risk-evm/README.md`, "The token list and every pool"); their files are under `data/risk-evm/` on the founder's machine and are not committed. RU.3: `pnpm risk-evm:pareto` writes the cut from the discovery file (`scripts/risk-evm/README.md`, "The cut"): 30 tracked stocks at 80%, `data/risk-evm/cut-robinhood-<stamp>.json`, not committed. RU.5: `pnpm risk-evm:oracles` writes the oracle map from the cut and Chainlink's directory (`scripts/risk-evm/README.md`, "The oracle map"): 24 of the 30 have a confirmed feed, `data/risk-evm/oracles-robinhood-<stamp>.json`, not committed. RU.4 (with RU.10): `pnpm risk:universe <chain>` writes the asset list of each chain from those files (`scripts/risk/universe/README.md`): `scripts/risk/universe/robinhood.json` (30 rows, 24 with a feed) and `solana.json` (18 rows, 10 with a Scope oracle), both committed; the schema is `AssetList` in `packages/schemas/src/universe.ts`. RU.6: `pnpm risk-evm:collect --list` collects the list's 30 stocks and writes one `evmq-pools-0.1` row per reachable pool to `data/risk-evm/pools/<day>.jsonl` (`scripts/risk-evm/README.md`, "A run on the asset list"); without `--list` a run is as it was. The next item is RU.7. The plan, this prompt, gate `UNIVERSE` and ledger row RISK-5 were written on branch `docs/universe-plan`; the status of every item is in section 6 of the plan.

What already exists and is reused, not rebuilt:

- Solana: the pool registry and collectors (`scripts/risk/build-registry.ts`, `retier.ts`, `pool-pareto.ts`, `scripts/risk/collector/`), the router (`routeTrade` in `packages/risk`), the split snapshot (`scripts/risk/split-snapshot.ts`), the price tables (`risk_price_observations`, `risk_reference_prices`) and the fact sheets (`packages/risk/src/facts/`).
- Robinhood Chain: Thom's hourly depth collector (`scripts/risk-evm/`, slot REVM-1), with its tests in `tests/risk-evm.test.ts`.

Decided: the Robinhood loop and its database run locally on the founder's machine (DU5); a dedicated machine or cloud infrastructure may come later. Waiting on a person: starting that loop (RU.8), and installing RU.12's job.

## U-B — Item execution (run once per item; replace `{N}` with 1–13)

Execute item **RU.{N}** of `docs/risk/PLAN-UNIVERSE.md`.

The risk layer measures what tokenized stocks cost to sell. Until now it chose its pools by one rule on Solana (the pools holding 80% of the money) and by hand on Robinhood Chain. The founder's rule of Oct 5 is: the 80% pools name the tracked stocks, then every pool of each tracked stock is tracked, so a trade can be routed through all of them. A rebalance the vault runs by itself is checked against an oracle, so each tracked stock also carries its oracle and how that oracle behaves. Whoever reads these facts later (the agent, the vault's keeper, a person) cannot ask where a number came from, so each one carries its source, time and method, and a fact with no data is `null` with a reason.

Before you write code:

1. Run `/start-work` with a branch `universe/ru{N}` cut from `staging` (not `risk/…`: a local branch `risk` exists and git refuses a name under it). The ledger row is RISK-5.
2. Read `docs/risk/PLAN-UNIVERSE.md` in full, then `CLAUDE.md`, then `docs/GATES.md` (gates `UNIVERSE`, `ROUTING`, `ORACLE-VS-DEX`, `EXIT-SOURCE`, `PRICE-JOB`).
3. Read the code the item extends, as files, not summaries:
   - RU.1, RU.3: `scripts/risk/pool-pareto.ts`, `scripts/risk/retier.ts`, `packages/risk/src/index.ts`.
   - RU.2, RU.5, RU.6, RU.7: all of `scripts/risk-evm/` (the README first), `tests/risk-evm.test.ts`, `fixtures/risk-evm/`.
   - RU.6, RU.7, RU.8 also: `scripts/risk/universe/README.md`, `robinhood.json` and `packages/schemas/src/universe.ts` (the list they read).
   - RU.4: `packages/schemas/src/basket-asset.ts`, `fixtures/solana-vault/scope-indexes.json`, `scripts/seed-assets.ts`.
   - RU.8: `scripts/risk/compute.ts`, `apps/api/src/liquidity.ts`, the last section of `scripts/risk-evm/README.md`.
   - RU.9: `packages/risk/src/facts/`, `packages/risk/src/prices/`, `packages/db/src/risk-schema.ts`.
   - RU.11: `routeTrade` and `packages/risk/src/pools/`, `scripts/risk/split-snapshot.ts`, `scripts/risk/routing-gap.ts`.
   - RU.12: `scripts/risk/prices/install-job.sh` and `scripts/risk/jobs/` (the pattern to copy), `apps/api/src/pool-recorded.ts`. `scripts/risk/collector/pools.ts` is read only.
4. If an item this one depends on is not `done` in §6, or a decision it needs is marked **YOU** and unanswered, stop and say what blocks it.
5. Say in two lines what you will build and how the item's check will be proven.

**Standing constraints, and why:**

- **Read-only on mainnet.** `eth_call`, `eth_getLogs`, account reads, public GETs. No transaction is built, signed or sent, and no key is read. Never read `.env` or anything under `secrets/`.
- **Do not disturb what is running.** The Solana launchd jobs collect data that cannot be collected again. Do not stop, reload or re-install any of them, write nothing under `~/.colosseum/`, and do not edit `scripts/launchd/`, `scripts/risk/collector/` or `scripts/depth-snapshot.mjs` before Oct 12. Thom's EVM loop may be running on his machine from the same files: a plain `pnpm risk-evm:collect` must write the same `evmq-0.1` rows after your change as before it.
- **Additive only.** The vault work reads `LiquidityProvider`, the `/risk/*` routes and the `risk-0.3` and `evmq-0.1` rows. Keep their shape. New fields are optional; new behaviour sits behind a setting or a new command.
- **No migration** unless the item cannot be done without one. If it cannot, stop: the migration token in the ledger has one holder at a time.
- **A missing fact is `null` with a reason, never zero.** A zero reads as "no liquidity" or "no gap" and would be acted on.
- **Oracle and pool price are kept apart, never blended** (gate `ORACLE-VS-DEX`). The pool price costs a trade; the oracle is what the vault checks before a rebalance.
- **Provenance.** Every figure carries `source`, `fetched_at`, `method` and `provenance`. No price, fee or yield literal outside `fixtures/`. `packages/risk` takes no SDK and never imports `packages/engine`; `packages/schemas` imports nothing.
- **RPC manners.** Use the existing clients and their backoff (`scripts/risk-evm/rpc.ts`, `rpc()` on Solana). Record calls and duration of every new read. If a free endpoint refuses a range, narrow it and say so; do not hammer it.
- **Git.** Stage your own files by path; never `git add -A`. Nothing under `data/` is committed; the asset list of RU.4 is the one generated file that is. Do not push unless asked.

While you work:

- Stay inside the item. Anything else you find goes under "Discovered" in `PLAN-UNIVERSE.md` §6.
- Tests come with the code. Fixtures are real chain reads frozen under `fixtures/`, the way `scripts/risk-evm/record-fixture.ts` and `scripts/risk/capture-pool-fixture.ts` do it. No test calls the network.
- A failed check is a finding. Do not widen a tolerance or weaken a test to pass it.
- RU.2: run the `eth_getLogs` probe before building on it, and record what the endpoint allowed. If v4 pools cannot be listed, build the fallback and state per token what may be missing.
- RU.6: the test that matters is that the cost at each size with every pool is equal to or lower than with three pools at the same block.
- RU.8: every Solana answer must be identical before and after. Prove it with `pnpm risk:provider-check` output diffed.
- RU.11: measure the routing gap before and after on the same stored quotes. Report the number as it comes out, better or not.
- RU.12: the installer is run by the session only into a temporary folder with no load. The real install is the founder's.
- If the item cannot close, stop at a clean commit, mark it `in-progress` with what remains, and say so.

When done:

1. `pnpm verify` (the database must be up: `pnpm db:up`). Paste any failure verbatim.
2. Run the item's check and show the evidence.
3. Update the item's row in `PLAN-UNIVERSE.md` §6 and row RISK-5 in `docs/vault/STATE-VAULT.md`: status, evidence, deviations from the plan. If the item changed what another document says (`scripts/risk-evm/README.md`, `docs/vault/DESIGN-VAULT.md` section 8, `docs/DATA-MODEL.md`), that document changes in the same pull request.
4. Commit as `RU.{N}: <deliverable in ≤ 12 words>`, then `/review-pr` and `/open-pr`.
5. Reply with: what shipped, the evidence, which facts are still `null` and why, what changed against the plan, the next item.

---

## U-D — A decision was answered (replace the bracketed part)

Decision **[DU-number]** of `docs/risk/PLAN-UNIVERSE.md` §4 is answered: **[the answer, in the founder's words]**.

1. Read `PLAN-UNIVERSE.md` §4 and every item that names the decision.
2. If the answer is the default, mark the row decided with the date and stop.
3. If it differs, use `/decide`: record it in `docs/GATES.md` with its date and who made it, and update the plan's items, checks and "Not in this plan" list in the same commit. Say which built items it reopens, if any. Build nothing in this run.
