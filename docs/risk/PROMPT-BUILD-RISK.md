# PROMPT 2 (risk layer) — Build from PLAN-RISK.md

> Use after `docs/risk/PLAN-RISK.md` exists and the founder has answered its open questions. Four prompts: **2A** runs once to open the branch and Phase 0, **2B** runs once per slot, **2C** runs at the start of Phase 3 (the join), **2D** runs when a decision in the plan's log resolves. All run in Claude Code at the repo root.

---

## 2A — Kickoff (run once, Oct 1, before any slot work)

You are the sole engineer adding a liquidity and risk layer to this repository. Read `HANDOFF-RISK.md` and `docs/risk/PLAN-RISK.md` fully, then `CLAUDE.md`, `docs/structurer/STATE.md` and `docs/GATES.md`. `PLAN-RISK.md` is the schedule; `HANDOFF-RISK.md` is the spec. Where they conflict, stop and tell me.

Standing constraint for this whole build: the hackathon submission on `main` is live and freezes Oct 9. **Do not modify `scripts/depth-snapshot.mjs`, `scripts/launchd/*`, the launchd job `com.colosseum.depth-snapshot`, anything under `~/.colosseum/depth/`, or the `main` branch.** If a task seems to need it, stop and ask.

Do these in order:

1. **Branch.** `git checkout -b risk-layer` from `main`. All commits for this work land here. Commit prefix is the slot id from `PLAN-RISK.md` (e.g. `R0-AM: risk collector`).
2. **Append to `CLAUDE.md`** a section "Risk layer rules", verbatim:
   - `packages/risk` never imports from `packages/engine`. The seam is `packages/schemas` (`LiquidityProvider`). A test fails the build if it does.
   - Every computed curve, score, assessment and market snapshot stores `method_version`, `source`, `fetched_at`/`computed_at`, sample count and date range. Primary-redemption capacity is always `provenance: assumption` and labelled in UI and API.
   - With no `LiquidityProvider` passed, the engine's outputs are byte-identical to today. Snapshot tests in `tests/` prove it and must not be edited to pass.
   - The collector never retries a 429 in a tight loop; it records the 429 as a row and moves on. Quote spacing ≥ 1.3 s.
   - The service publishes asset-level and market-level aggregates only, never another wallet's positions.
   - Risk pages and `/risk/*` responses carry the `DISCLAIMER` constant. No letter grades, no "safe"/"unsafe" wording.
   - The existing collector, its launchd job and its data directory are read-only until Oct 12.
3. **Create `docs/risk/STATE-RISK.md`** (slot status table copied from the plan, plus "what changed vs plan" and "discovered") and `docs/GATES-RISK.md` (the plan's decision log with `OPEN` status, cut-offs and defaults).
4. **Run the Phase 0 verification tasks** from the plan (Jupiter tier window with the key; mints and token programs for the four additional xStocks via the V6 method). Record each in `docs/VERIFICATION-RISK.md` with command, value, timestamp. If a mint cannot be verified, leave that asset out of the collector and say so.
5. **Phase 0 collector.** Write `scripts/risk-collect.mjs` (dependency-free, same style as `scripts/depth-snapshot.mjs`): sell and buy quotes at the plan's notionals for the verified assets, hourly Kamino reserve metrics and Jupiter Lend vault reads, JSONL to `~/.colosseum/risk/YYYY-MM-DD.jsonl`, 429s as rows. Write `scripts/launchd/com.colosseum.risk-collect.plist` and `scripts/launchd/install-risk.sh` (new files only) with a 7-minute offset from the existing job. Install it. Then run the plan's Phase 0 checks: the new file grows; **the old job's file mtime keeps advancing**.
6. Commit as `R0-AM: branch, rules, verification, risk collector`. Print a short report: what is set up, what verification found, the first rows of the new file, and any slot in the plan that must change.

Stop after the report. Do not start Phase 1.

---

## 2B — Slot execution (run once per slot; replace `{SLOT}`)

Execute slot **{SLOT}** from `docs/risk/PLAN-RISK.md`.

Before you write code:
1. Confirm you are on branch `risk-layer`. Read the slot row, `docs/risk/STATE-RISK.md`, `docs/GATES-RISK.md`. If a dependency slot is not `done` or a decision the slot needs is still `OPEN`, stop and tell me what blocks it.
2. Read the "Risk layer rules" in `CLAUDE.md`. Re-read the method definition in `PLAN-RISK.md` §4 for whatever this slot implements; implement that definition, not a variant.
3. Say in two lines what you will build and how the check will be proven.

While you work:
- Stay inside the slot. Out-of-slot discoveries go in `docs/risk/STATE-RISK.md` under "discovered".
- Tests or scripts that prove the check come with the code. Fixtures come from the collected JSONL, trimmed and committed under `fixtures/risk/` with their date range in the filename.
- Never touch the existing collector, its data, or `main`.
- Mainnet actions (Phase 3 only): demo wallet, smallest sensible amount, signature and explorer link printed, no automatic retry.
- If the slot cannot close in its half day, stop at a clean commit, mark it `slipped`, and say what remains and what it displaces.

When done:
1. `pnpm typecheck && pnpm lint && pnpm test`. Paste any failure verbatim.
2. Run the slot's check and show the evidence.
3. Update `docs/risk/STATE-RISK.md`: status, evidence, deviations.
4. Commit as `{SLOT}: <deliverable in ≤ 10 words>`.
5. Reply with: what shipped, the evidence, what changed vs plan, the next slot.

---

## 2C — The join (run once at the start of Phase 3, before its first slot)

Phase 3 wires `packages/risk` into the structurer. Before any engine change, establish the proof that nothing changes without a provider:

1. Read `HANDOFF-RISK.md` §5 (seams) and `PLAN-RISK.md` §3–4.
2. Add `LiquidityProvider` to `packages/schemas` exactly as the plan defines it, plus a `FixtureLiquidityProvider` under `tests/` that returns values from `fixtures/risk/`.
3. Add snapshot tests that capture, for the three demo goals in `fixtures/goals.json`, the full `solve`, `buildScheduleWithStresses`, `buildRiskSheet` and `proposeRebalance` outputs **with no provider**. Commit them as `R3-00: no-provider snapshots`. These files are not edited again in Phase 3; if an engine change breaks them, the change is wrong.
4. Then, and only then, start the Phase 3 slots with 2B. Each of the four hooks (solver cap, schedule exit cost and dry stress, risk-sheet block, policy trigger) is its own slot, each guarded by the snapshots and by new tests with the fixture provider.
5. Report: the snapshot files, their sizes, and confirmation that `pnpm test` is green on the unchanged engine.

---

## 2D — Decision resolution (run when a plan decision resolves; replace bracketed parts)

Decision **[name from GATES-RISK.md]** is now **[outcome]**. Founder's facts:

[paste: e.g. Phase 1 start date; the six xStocks; τ and share-of-depth defaults; whether hour-of-week curves have enough samples; whether direct pool reads are in; whether obligation enumeration is in; whether the old collector is folded in on Oct 13]

Do this:
1. Update `docs/GATES-RISK.md` with status, date and facts.
2. Apply the branch from `PLAN-RISK.md` §6 for this outcome: insert or remove the slots it specifies, record every change in `docs/risk/STATE-RISK.md` "what changed vs plan". If the plan no longer closes in its phase budget, list what to cut, cheapest first, and stop for my decision.
3. If the decision changes a parameter (τ, share-of-depth, dry floor), change it in one place (`packages/risk` params or `SOLVER_PARAMS`/`STRESS_PARAMS`), never in a fixture or a test expectation, and re-run the snapshots to show which plans moved and why.
4. Commit as `gate-risk: [name] [outcome]` and report the slot table diff.
