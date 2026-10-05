# PROMPT 2 — Build the MVP from PLAN.md

> Use after `PLAN.md` exists and the founder has reviewed it (answered the open questions, confirmed the stack, set the freeze date). Three prompts here: **2A** runs once to set up the repo, **2B** runs once per half-day slot, **2C** runs when a gate resolves. Run them in Claude Code inside the product repo, with `HANDOFF-IDEA1.md` and `PLAN.md` copied into `docs/`.

---

## 2A — Kickoff (run once, D1-AM, before any slot work)

You are the sole engineer on a 12-day hackathon build. Read `docs/structurer/HANDOFF-IDEA1.md` and `docs/structurer/PLAN.md` fully before doing anything. `PLAN.md` is the schedule; `HANDOFF-IDEA1.md` is the spec. Where they conflict, stop and tell me.

Set up the repository so that every later slot can start immediately. Do these in order:

1. **Scaffold** the stack exactly as `PLAN.md` §2 decided. Monorepo or single package as the plan says. Include: lint, typecheck, test runner, `.env.example` with every secret named (Jupiter API key, RPC URL, LLM key, DB URL, demo wallet path), and a `make`/npm script for each of: dev, test, typecheck, `plan:demo` (runs the three demo goals end to end without executing), `execute:demo` (executes on mainnet with a confirm prompt).
2. **Write `CLAUDE.md`** at the repo root with these standing rules, verbatim:
   - Every yield, price or FX figure in code, DB or UI carries `source`, `fetched_at` and `method`. No hard-coded APYs anywhere. A test fails the build if a numeric yield literal appears outside `fixtures/`.
   - Anything mocked, sandboxed or stubbed is labelled `MOCK` in the UI and in the API response (`"provenance": "mock"`). Never display a mock as live.
   - The solver is deterministic. The LLM only parses goals into a zod-validated `ConstraintSheet`. If validation fails, the user sees the error and edits the sheet; the solver never runs on unvalidated input.
   - xStocks are ineligible for `income` profiles. Enforce in the asset registry, not in the prompt. Test it.
   - The "BRL leg" is an abstract asset with a parameterised cap and mint path. No BRS-specific code until `docs/GATES.md` marks G-Nora as PASSED.
   - Every mainnet transaction is logged with its explorer link in `executions` table and shown in the UI.
   - Commits are small, dated, and describe the slot: `D3-PM: first mainnet Jupiter swap USDC→USDY`. Prior-work reuse goes in commits prefixed `prior:` and is listed in `docs/PRIOR-WORK.md`.
   - Do not present the product as licensed advice. The disclaimer text lives in one constant and appears on the plan view and in API docs.
   - Build the product, not demo code: real API, real schema, real migrations. UI can be plain.
3. **Create `docs/GATES.md`** listing every decision from `PLAN.md` §5 with status `OPEN`, its cut-off date, and the default. Create `docs/structurer/STATE.md` with a slot-by-slot status table (`todo | in-progress | done | slipped`) copied from the plan, plus a "what changed vs plan" section.
4. **Data model.** Write the core schema (migrations) for: `goals`, `constraint_sheets`, `assets` (with provenance fields), `yield_observations`, `fx_observations`, `plans`, `plan_legs`, `schedules`, `stress_cases`, `risk_sheets`, `policies`, `positions`, `executions`, `rebalances`. Keep it minimal but real. Explain each table in one line in `docs/DATA-MODEL.md`.
5. **Run the D1 verification tasks** from `PLAN.md` exactly as written (live yields, Jupiter endpoint and key, Kamino SDK version, delegated-execution support, xStocks depth). Record each result in `docs/structurer/VERIFICATION.md` with the command or URL used, the value, and a timestamp. If anything fails, say so and propose the plan change; do not silently work around it.
6. **Prior work.** Create `docs/PRIOR-WORK.md` with the disclosure list from `HANDOFF-IDEA1.md` §7 and leave placeholders for what actually gets reused.
7. Commit as `D1-AM: kickoff — scaffold, CLAUDE.md, schema, verification`. Print a short report: what is set up, what verification found, and which slots in `PLAN.md` need to change because of it.

Do not start D1-PM work. Stop after the report.

---

## 2B — Slot execution (run once per half-day slot; replace `{SLOT}`)

Execute slot **{SLOT}** from `docs/structurer/PLAN.md`.

Before you write code:
1. Read the slot row: deliverable, check, dependencies. Read `docs/structurer/STATE.md` and `docs/GATES.md`. If a dependency slot is not `done`, or a gate this slot needs is still `OPEN`, stop and tell me what is blocking.
2. Read the rules in `CLAUDE.md`. They apply to every line you write.
3. State in two lines what you will build and how the check will be proven.

While you work:
- Stay inside the slot. If you discover work that belongs to another slot, note it in `docs/structurer/STATE.md` under "discovered", do not do it now.
- Write the test or script that proves the check before or alongside the code.
- If the slot involves mainnet, use the demo wallet, the smallest sensible amount, and print the transaction hash and explorer link. Never retry a failed mainnet transaction automatically.
- If the slot cannot close in the half day, stop at a clean commit, mark it `slipped` in `STATE.md`, and tell me exactly what remains and what it displaces in the plan.

When done:
1. Run typecheck, lint and the full test suite. Paste any failure verbatim; do not summarise it away.
2. Run the slot's check and show the evidence (test output, tx hash, screenshot path, spreadsheet value).
3. Update `docs/structurer/STATE.md`: status, evidence link, and any deviation from the plan.
4. Commit as `{SLOT}: <deliverable in ≤ 10 words>`.
5. Reply with: what shipped, the evidence, what changed vs plan, and the next slot's name.

---

## 2C — Gate resolution (run when the founder resolves a gate; replace the bracketed parts)

Gate **[G-Nora | POLICY | EVM-S1]** is now **[PASSED | FAILED]**. Founder's facts:

[paste what was confirmed, e.g. for G-Nora: who mints, API/auth/sandbox, accepted inputs and chain, min/max size, fees, FX rate source and spread, settlement time, redeem path, KYB status of the demo wallet]

Do this:
1. Update `docs/GATES.md` with the status, date and the facts above.
2. Apply the branch from `docs/structurer/PLAN.md` §5 for this outcome: insert or remove the slots the plan specifies, renumber nothing, and record every change in `docs/structurer/STATE.md` "what changed vs plan". Confirm the plan still closes by Oct 11 and the freeze date holds; if not, list what you propose to cut, cheapest first, and stop for my decision.
3. If PASSED for G-Nora: unlock BRS work in `CLAUDE.md` (replace the abstract-leg rule with the concrete mint path), create the BRS asset entry with provenance from the facts above, and set the cap from Nora's limits. Do not execute a mint yet; that belongs to the slot the plan assigns.
4. If FAILED for G-Nora: set the BRL leg label to "BRS mint via Nora: integration in progress" everywhere it renders, keep the leg in plan/schedule/risk sheet, and exclude it from execution. Add a test that asserts execution never includes it.
5. Commit as `gate: [name] [outcome]` and report the slot table diff.
