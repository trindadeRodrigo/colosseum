# PROMPT 1 (risk layer) — Generate the build plan (PLAN-RISK.md)

> Paste everything below this line into a fresh Claude Code session at the repo root. Output goes to `docs/risk/PLAN-RISK.md`.

---

You are a senior technical program lead with hands-on experience in DeFi risk analytics and Solana account reads. Your job is to write `docs/risk/PLAN-RISK.md`: the build plan for the liquidity and risk layer described in `HANDOFF-RISK.md`. You are planning, not building. Do not write product code.

## Inputs (read all before writing anything)

1. `HANDOFF-RISK.md` — the authoritative spec for this work. Where it conflicts with anything else, it wins.
2. `docs/structurer/HANDOFF-IDEA1.md` — the product the layer joins.
3. `docs/structurer/STATE.md`, `docs/GATES.md`, `docs/DATA-MODEL.md`, `docs/structurer/VERIFICATION.md` — what exists and what is gated.
4. `eval/briefs/SHARED-CONTEXT.md` §"Idea 2", `eval/FEASIBILITY.md` §"Idea 2", `eval/IDEA2-MARKET.md` — the original risk-engine research. Use it for dependencies and evidence; the product definition in `HANDOFF-RISK.md` supersedes it.
5. The code the layer hooks into. Read these files, not summaries of them: `packages/schemas/src/{asset,plan,policy,constraint-sheet,enums}.ts`, `packages/engine/src/solver/index.ts`, `packages/engine/src/schedule/index.ts`, `packages/engine/src/risk/index.ts`, `packages/engine/src/policy/{drift,rebalance}.ts`, `packages/db/src/schema.ts`, `apps/api/src/routes/{plans,monitor}.ts`, `scripts/depth-snapshot.mjs`, `scripts/depth-import.ts`, `scripts/launchd/install.sh`, `packages/chain-solana/src/{prices,positions,kamino}.ts`, `packages/engine/src/feeds/yields.ts`.

Do not rely on earlier conversations. If a fact is missing, write it as an assumption with a default and keep going.

## Hard constraints (restated so you cannot miss them)

- **Phase 0 starts Thu Oct 1.** Phases 1–4 start Tue Oct 13 by default. Also show the alternative where Phase 1 starts Mon Oct 5 in the hackathon flex slots on the branch, and say what it costs the hackathon.
- **Do not touch** `scripts/depth-snapshot.mjs`, the launchd job `com.colosseum.depth-snapshot`, `~/.colosseum/depth/`, or `main` before Oct 12. The plan works on branch `risk-layer`.
- Granularity: half-day slots for Phases 0–3, day slots for Phase 4. Every slot has one deliverable and one observable check.
- Solo. Mark `[B2]` slots (default B2 scope: collectors, market readers, dashboard).
- `packages/risk` never imports from `packages/engine`. The seam is `packages/schemas` (`LiquidityProvider`). With no provider passed, the engine behaves exactly as today; existing tests and snapshots pass unchanged.
- `CLAUDE.md` rules apply: provenance on every number, mocks labelled, deterministic engine, no literals outside `fixtures/`, disclaimer everywhere.
- No presentation, GTM, video or submission work in this plan.

## Verification-first rule

`HANDOFF-RISK.md` §7 lists unverified items. Schedule an explicit verification task for each one the build depends on, in the first slot of the phase that needs it (Phase 0 for the Jupiter tier and the four extra xStocks mints; Phase 4 for Kamino reserve config and Scope band, Jupiter Lend vault configs). Each task states what to check, how (URL, SDK call, script), and what changes if it fails. Carry no number from the dossiers into the plan as a fact.

## What PLAN-RISK.md must contain, in this order

1. **Plan summary** (≤ 10 lines): what ships per phase, the one thing each phase must prove, and the single most likely failure point with its mitigation.
2. **Stack additions.** Only what the existing stack lacks. Expected: nothing new for the engine; a curve-fitting approach (state it: monotone piecewise-linear interpolation in log-notional is the default, no library); a charting choice for the dashboard consistent with `ScheduleChart.tsx`; a second launchd job. Justify any dependency you add in one line.
3. **Architecture sketch** (≤ 1 page): `packages/risk` modules (`curves`, `time`, `redemption`, `recoverable`, `score`, `breach`, `gap`, `markets`, `provider`), the `risk_*` tables, the collector and importer, the `/risk/*` plugin and the standalone `apps/risk-api`, the dashboard routes, and the seam into `packages/engine`. Show the data flow from a Jupiter quote to a binding constraint in a plan and to a `liquidity_breach` order in a policy.
4. **Method definitions** (½ page, formulas in plain text): depth curve fit and the three queries; time buckets and regimes (US market hours in ET with DST handled, holidays as a fixture list); primary-redemption overlay; recoverable value; liquidity score; breach and likely-breach; effective cap in the solver; exit-cost in the schedule; `liquidity_dry` stress. Every parameter named and marked as a policy input. This section is what the methodology page will be generated from.
5. **Slot table per phase.** Columns: `Slot | Phase | Workstream | Deliverable | Check | Depends on | [B2]? | Notes`. Rules: every check is observable (test name, file, HTTP response, screenshot, explorer link); Phase 0 is ≤ 2 slots and its first check is "the existing job is still writing"; Phase 3's first slot is the no-provider snapshot proof; Phase 3 ends with one mainnet rebalance from a `liquidity_breach` proposal on a weekday.
6. **Decision log with cut-offs.** Decision, options, default, cut-off, what changes on each outcome. Include at least: Phase 1 start date (Oct 5 vs Oct 13); curve fit method; whether hour-of-week curves are used or regime curves only (depends on sample counts by the end of Phase 0's second weekend); second depth source (direct pool reads) yes/no; obligation enumeration in Phase 4 yes/no; whether the old collector is folded into the new one on Oct 13.
7. **Risk register.** ≥ 10 rows: risk, likelihood, impact, early signal, mitigation, slot where retired. Must include: Jupiter rate limits corrupting the time series; sparse weekend samples making regime curves unreliable; quote impact diverging from realised slippage; Kamino weekend price band unreadable; Jupiter Lend vault API changes; the solver change altering existing plans' allocations unexpectedly; policy liquidity orders conflicting with band invariants; the second launchd job disturbing the first (shared key, rate window); laptop asleep during collection; scope creep into the agent layer or design system.
8. **Acceptance mapping.** Reproduce `HANDOFF-RISK.md` §6 and map every check to the slot that satisfies it and the artifact that proves it.
9. **Open questions for the founder** (≤ 8), each with the default you assumed. Candidates: impact tolerance τ default (1%?); share-of-depth default; which six xStocks; whether `liquidity_dry` uses the measured ratio or a floor; whether third-party responses need a rate limit; Phase 1 start date.
10. **Plan self-check.** Confirm in writing: (a) nothing touches the existing collector, its data, or `main` before Oct 12; (b) `packages/risk` has no import from `packages/engine`; (c) the no-provider path is proven before any engine change; (d) every §7 unverified item has a verification task in the right phase; (e) every §6 check maps to a slot; (f) no depth, yield or price figure appears as a fact in the plan; (g) Phase 0 fits in ≤ 2 slots and starts Oct 1.

## Style

- Plain language, short sentences, tables over prose. No filler, no option lists you will not pursue. Every line is a commitment or a decision.
- Target 8–12 pages of Markdown. If longer, cut Phase 4 detail, not Phase 0–3.
- Write the file, then print only the plan summary and the open questions in your reply.
