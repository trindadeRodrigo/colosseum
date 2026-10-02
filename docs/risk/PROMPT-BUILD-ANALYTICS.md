# PROMPT (risk layer) — Build the analytics the agent reads (PLAN-ANALYTICS Step A)

> Use in a Claude Code session started inside the worktree `.claude/worktrees/risk-analytics` (branch `risk-analytics`), not in the main checkout. Three prompts: **A-B** runs once per item, **A-C** runs when missing information arrives, **A-D** runs when a decision resolves. The plan is `docs/risk/PLAN-ANALYTICS.md`.

---

## A-B — Item execution (run once per item; replace `{N}` with 1–17)

Execute item **{N}** of Step A in `docs/risk/PLAN-ANALYTICS.md`.

The risk layer of this repository already measures what tokenized stocks cost to sell on Solana and how the lending pools that take them as collateral behave. Step A turns those measurements into three fact sheets (`AssetFacts`, `LendingPoolFacts`, `PlanFacts`) that an AI agent and the product read through the API. The reader of a fact cannot ask where it came from, so each one carries its source, time, method and quality, and a fact with no data is `null` with a reason.

Before you write code:
1. Confirm `git branch --show-current` prints `risk-analytics` and that you are in the worktree. Another session builds Step 11 on `risk` in the main checkout: do not `cd` there, and do not edit `docs/risk/PLAN-RISK.md` or `docs/risk/STATE-RISK.md`.
2. Read `docs/risk/PLAN-ANALYTICS.md` in full, then `docs/risk/PLAN-RISK.md` §4 and Appendix A (the methods you build on), and `CLAUDE.md`.
3. Read the code the item extends, as files, not summaries. For items 1–7: `packages/schemas/src/liquidity.ts`, `packages/risk/src/provider.ts`, `assess.ts`, `curves.ts`, `time.ts`, `pools/simulate.ts`, `scripts/risk/collector/pools.ts` (read only: `build` and `writeRoutedCurves`), `scripts/risk/compute.ts`, `apps/api/src/liquidity.ts`. For items 8–10: `packages/risk/src/lending/report.ts`, `scripts/risk/lending-report.ts`, `packages/db/src/risk-schema.ts`. For item 11: `apps/api/src/routes/risk.ts`, `apps/risk-api/`.
4. If an earlier item the item depends on is not `done` in §7, or a decision it needs (§6) has no default, stop and tell me what blocks it.
5. Say in two lines what you will build and how the item's check will be proven.

**Standing constraints, and why:**
- **Do not disturb what is running.** Six launchd jobs collect data that cannot be collected again, this weekend's first of all. Do not stop, reload or re-install any of them, write nothing under `~/.colosseum/`, and do not edit `scripts/launchd/`, `scripts/risk/collector/` or `scripts/depth-snapshot.mjs`. Read their output; never change it.
- **Additive only (DA1).** The vault work already reads `LiquidityProvider`, the `/risk/*` routes and the `risk-0.3` curve rows. Keep their shape. Add optional fields, new methods and new routes.
- **No migration before item 11.** Step 11 adds one on `risk`; a second one generated here would collide with it. Compute from the existing tables until then.
- **A missing fact is `null` with a reason, never zero.** A zero reads as "no liquidity" and would shrink a real plan.
- **RPC budget (DA3).** Until Mon Oct 5: at most 8 parallel requests, no `getProgramAccounts` scans. Use the existing `rpc()` backoff. Read-only: no transaction is sent.
- **Wallets (D13, DA4).** Liquidators, LP owners, holders and positions stay local. Tables, reports and routes publish aggregates only.
- **Provenance.** Every number carries `source`, `fetched_at`, `method` and `provenance`. No price, fee or yield literal outside `fixtures/`. `packages/risk` takes no SDK and never imports `packages/engine`; `packages/schemas` imports nothing.
- **Git.** Stage your own files by path; never `git add -A`. Nothing under `data/` and no database dump is ever committed. Do not push unless I ask.

While you work:
- Stay inside the item. Anything else you find goes under "Discovered" in `PLAN-ANALYTICS.md` §7.
- Tests come with the code. Fixtures are real mainnet account bytes and rows, frozen under `fixtures/risk/` the way `scripts/risk/capture-pool-fixture.ts` does it.
- A failed check is a finding. Do not widen a tolerance or weaken a test to pass it.
- For item 2, reproduce each bug with a failing test before fixing it. If it does not reproduce, record that and move on.
- For item 3, the test that matters: the router reproduces the collector's stored routed row of the same run to 1e-9, and the four cost parts sum to the total.
- For items 8–9, the earlier coverage ratio must stay in the report unchanged, beside the new one.
- If the item cannot close, stop at a clean commit, mark it `in-progress` with what remains, and say so.

When done:
1. `pnpm verify` (the database must be up: `pnpm db:up`). Paste any failure verbatim.
2. Run the item's check and show the evidence.
3. Update the item's row in `PLAN-ANALYTICS.md` §7: status, evidence, deviations from the plan.
4. Commit as `RA.{N}: <deliverable in ≤ 12 words>`.
5. Reply with: what shipped, the evidence, which facts are still `null` and why, what changed against the plan, the next item.

---

## A-C — Information arrived (run when a row of §2 arrives; replace the bracketed part)

**[Weekend curves | Step 11's reference prices | an external feed | Thom's EVM rows | non-stock pools | mint and burn history]** is now available.

1. Show that it is: the table or file, the row count, the time range.
2. Re-run the builders and list every fact that moved from `null` to a value, with one example each. No code should need to change; if some does, say what and why before changing it.
3. Re-run `pnpm risk:compute` and `pnpm risk:lending-report` where the new data feeds them, and record what moved.
4. Update §2 and §7 of `PLAN-ANALYTICS.md`, and commit as `RA.fill: <what arrived>`.

---

## A-D — Decision resolution (replace bracketed parts)

Decision **[DA1–DA6]** is now **[outcome]**. My facts: [paste].

1. Update the row in `PLAN-ANALYTICS.md` §6 with the outcome and date.
2. Apply what it changes, and record each change in §7.
3. A parameter changes in one place, never in a fixture or a test expectation. Re-run the affected check and show what moved.
4. Commit as `gate-risk: [name] [outcome]` and report what changed.

---

## Merging back

When Step 11 has reached its item 5 on `risk`: merge `risk` into `risk-analytics`, generate item 11's migration on top of Step 11's, run `pnpm verify`, then open the pull request from `risk-analytics` into `risk`. In that pull request, move §7 into `STATE-RISK.md` as row A and §6 into `PLAN-RISK.md` §6.
