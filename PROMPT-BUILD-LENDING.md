# PROMPT (risk layer) — Build the lending-pool ingestion (PLAN-RISK Step 10b)

> Use in a fresh Claude Code session at the repo root. Four prompts: **L-A** runs once (verify, registry, live collector, then starts the history fetch), **L-B** runs once per remaining item, **L-C** checks on the long-running jobs, **L-D** runs when a decision resolves. The plan is `docs/PLAN-RISK.md` Step 10b.

---

## L-A — Kickoff: verify, registry, live collector, start the history fetch (run once; items 1–3 before Fri Oct 2 20:00 ET)

You are adding lending-pool ingestion to the risk layer of this repository. The DEX-pool side already exists: a pool registry, a 5-minute collector, a complete transaction history for the 34 largest pools, and replay-based completeness checks. Lending pools that take tokenized stocks as collateral (Kamino markets, Jupiter Lend vaults) are only snapshotted hourly from the protocol APIs. Your job is to give them the same treatment the pools got, so that later work can measure lender withdrawal risk, liquidation history, and whether the DEX pools can absorb the stock collateral if it is liquidated.

Read these fully before writing code:
1. `docs/PLAN-RISK.md` Step 10b (the spec for this work), then §4 and Step 5b (the method and the pattern you are copying), and decisions D10–D14.
2. `docs/STATE-RISK.md`, including "Discovered".
3. `CLAUDE.md`.
4. The code you extend, as files, not summaries: `scripts/risk/lib-pools.ts`, `scripts/risk/lib-history.ts`, `scripts/risk/history-full.ts`, `scripts/risk/history-full-measure.ts`, `scripts/risk/history/verify.ts`, `scripts/risk/collector/pools.ts` (`snapshotMarkets` and the run loop), `scripts/risk/collector/install.sh`, `scripts/risk/verify-markets.ts`, `packages/risk/src/events/`, `packages/db/src/risk-schema.ts`, `tests/risk-layer/events.test.ts`.

Where Step 10b conflicts with anything else, stop and tell me.

**Standing constraints for the whole build, and why:**
- **Branch `risk`.** Check `git branch --show-current` before every commit. `main` is the frozen hackathon submission. Design files never go on this branch.
- **Do not disturb what is running.** A pool history fetch (`scripts/risk/history-full.ts`, started with nohup + caffeinate) may still be running; check with `pgrep -f history-full.ts`. Four launchd jobs are collecting data that cannot be re-collected: `com.colosseum.risk-pools`, `risk-quotes`, `risk-refresh` and `depth-snapshot`. Do not stop, reload or re-install any of them, and do not write into their output directories. Do not change the behaviour of anything `lib-history.ts` or `history-full.ts` already exports, because a restart of the fetch would pick it up; add new exports or new files instead.
- **RPC budget.** While `history-full.ts` runs, use at most 16 parallel requests. `getProgramAccounts` is rate-limited per method; use the existing `rpc()` backoff and never loop tightly on a failure.
- **Read-only.** No transaction is sent in this work.
- **Provenance.** Every rate, price and balance row carries `source`, `fetched_at`, `method` and `provenance`. No numeric yield or price literal outside `fixtures/`. A parameter read only from a protocol API is labelled `verification: 'api'` until it matches the on-chain account.
- **Positions.** Obligations and positions are stored locally. Nothing you expose (table meant for the API, report, endpoint) names a wallet or a single position; publish LTV buckets and top-N shares only.
- **Package boundary.** `packages/risk` never imports from `packages/engine` and takes no protocol SDK as a dependency. Decoders there are hand-written and checked against the SDK from a script under `scripts/risk/`.
- **Git hygiene.** `docs/PLAN.md` and `docs/GATES.md` have uncommitted founder edits. Stage your own files by path; never `git add -A`. Never commit anything under `data/` or any database dump. Do not push unless I ask.
- **Long jobs** run under `nohup` + `caffeinate -is`, not as session background tasks, which are killed after two hours.

Do these in order. Each ends with a commit prefixed `R10b.N:` and a line in `docs/STATE-RISK.md`.

1. **Item 1: verify and measure (VL-1 to VL-8).** Write `scripts/risk/lending-measure.ts` (`pnpm risk:lending-measure`), with results appended to `data/risk/lending-measure.jsonl`. For each VL task record the command, the value and the time. Treat the probe numbers in the plan as hints to be replaced by your counts. If VL-5 fails (Jupiter Lend cannot be decoded on-chain), keep Jupiter Lend API-only, label it, and continue with Kamino. Two founder decisions already apply: other lending venues found by VL-1 are listed with their balances and not ingested (D14); curated vaults that supply into our reserves are tracked in full but not offered (D15), so they get registry rows with `offered: false` and collector rows, and nothing is added to the engine's asset registry.
2. **Item 2: registry.** `pnpm risk:lending-registry`, the registry JSON, the `risk_lending_pools` table and its additive migration. Every row is confirmed on-chain or dropped with a reason.
3. **Item 3: live collector.** `scripts/risk/collector/lending.ts` and the job `com.colosseum.risk-lending` at minutes 1, 6, …, 56. Give `install.sh` a one-job mode (for example `install.sh lending`) whose default behaviour with no argument is unchanged, and install only the new job. Before and after installing, record the mtime of each existing job's log and show that they kept advancing.
4. **Item 4: start the history fetch.** I have already decided the window (each market's whole life) and the timing (now, beside the pool fetch). If VL-4 counted 3 million transactions or fewer, write `scripts/risk/lending-history.ts`, start it under `nohup` + `caffeinate -is` at 16 parallel (more only if `history-full.ts` is no longer running), confirm the first units complete with raw bodies on disk, and commit. If VL-4 counted more, do not start it; report the count instead. Do not wait for the fetch to finish.

Items 1–3 are the part with the deadline. If time runs short, finish and verify them before touching item 4.

Before you finish:
- `pnpm typecheck && pnpm lint && pnpm test`. `pnpm lint` already fails on HEAD in five files outside this work (listed in STATE-RISK "Discovered"); do not fix those, and report any new failure verbatim.
- Show the evidence: the VL results table, the registry counts, two consecutive collector runs on disk with one decoded row printed, and the on-chain row for one reserve next to the API row for the same hour.

Then stop and report: what is set up, what each VL task found, anything in Step 10b that must change because of it, the list of other venues VL-1 found with their balances, the curated vaults VL-8 found with their share of each reserve, the measured transaction count, and the fetch's rate, time estimate and the command to check its progress. Do not start item 5.

---

## L-B — Item execution (run once per item; replace `{N}` with 5–9)

Execute item **{N}** of Step 10b in `docs/PLAN-RISK.md`.

Before you write code:
1. Confirm the branch is `risk`. Read the item, `docs/STATE-RISK.md` row 10b and "Discovered". If an earlier item is not `done`, or a decision the item needs (D10–D14) is still open, stop and tell me what blocks it.
2. Re-read the standing constraints in L-A above; they all still apply. Check `pgrep -f history-full.ts` and set your parallelism accordingly.
3. Say in two lines what you will build and how the item's check will be proven.

While you work:
- Stay inside the item. Anything else you find goes in STATE-RISK under "Discovered".
- Tests come with the code. Fixtures are real mainnet transactions and account bytes, frozen under `fixtures/risk/` the way `scripts/risk/history/freeze-tx-fixtures.ts` does it.
- The test that matters for every decoder: decoded amounts equal the vault token-balance changes exactly. For state decoders: the hand-written reader equals the SDK's decode on every live reserve or vault.
- Item 4's fetch is normally started by L-A. If it was not (VL-4 counted over 3 million, or L-A stopped early), start it here the same way: `nohup` + `caffeinate`, confirm the first units complete, print the command to check progress, and end the item there. The fetch finishing is checked with L-C.
- For item 5, the decode pass reads the raw bodies the fetch saved; it never fetches again. It can run on whatever has been fetched so far.
- For item 6, a failed check is a finding, not something to tune away. Locate the gap (bisection between snapshots, as Step 5b.4 did) and report it. Do not widen `borrowReplayTolBps` to make a check pass.
- For item 9, the report is the deliverable. No API route, no UI, no change to `packages/engine`.
- If the item cannot close, stop at a clean commit, mark it `in-progress` with what remains, and say so.

When done:
1. `pnpm typecheck && pnpm lint && pnpm test`. Paste any new failure verbatim.
2. Run the item's check and show the evidence.
3. Update `docs/STATE-RISK.md` row 10b: status, evidence, deviations from the plan.
4. Commit as `R10b.{N}: <deliverable in ≤ 12 words>`.
5. Reply with: what shipped, the evidence, what changed against the plan, the next item.

---

## L-C — Check the running jobs (run any time)

Report the state of the lending ingestion without changing anything:
1. `launchctl list | grep colosseum`, and the last two runs of `com.colosseum.risk-lending`: time, rows written, failures. List any gap longer than 10 minutes since the job was installed, with its start and end.
2. If the lending history fetch is running or has run: units done out of total, transactions fetched, errors, rate, and the estimated time left. If it stopped before finishing, say why (last log lines) and give me the exact command to resume it; do not resume it yourself unless I say so.
3. Confirm the four older jobs and, if present, `history-full.ts` are still writing (log or output mtime).
4. Free disk space, and the size of `data/risk/lending-history/` and `~/.colosseum/risk/lending*`.

Reply with a short table and one line on anything that needs my action.

---

## L-D — Decision resolution (run when a decision resolves; replace bracketed parts)

Decision **[D10–D15 from `docs/PLAN-RISK.md`]** is now **[outcome]**. My facts:

[paste: for example the history window; whether to fetch beside the pool fetch; which extra venues to ingest; whether a curated vault may now be offered]

Do this:
1. Update the decision row in `docs/PLAN-RISK.md` §6 (or the question in §9) with the outcome and date.
2. Apply what the outcome changes in Step 10b, and record every change in `docs/STATE-RISK.md` row 10b.
3. If the outcome changes a parameter (`utilAlarmPct`, `gapGridPct`, `borrowReplayTolBps`, the fetch window), change it in one place, never in a fixture or a test expectation, and re-run the affected check to show what moved.
4. Commit as `gate-risk: [name] [outcome]` and report what changed.
