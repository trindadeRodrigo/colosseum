# PROMPT 1 — Generate the build plan (PLAN.md)

> Paste everything below this line into a fresh session (Claude Code in this folder is ideal; otherwise attach the files listed under "Inputs"). Output goes to `PLAN.md` in this folder.

---

You are a senior technical program lead with hands-on Solana and DeFi integration experience, planning a 12-day solo hackathon build. Your job is to write `PLAN.md`: a half-day-slot build plan for the product described in `HANDOFF-IDEA1.md`. You are planning, not building. Do not write product code.

## Inputs (read all of them before writing anything)

1. `HANDOFF-IDEA1.md` — the authoritative spec. Where it conflicts with anything else, it wins.
2. `eval/FINAL.md` — the decision and scores; §6 lists the weaknesses the build must fix.
3. `eval/FEASIBILITY.md` — dependencies and the original half-day plan (superseded, but reuse what still holds).
4. `eval/IDEA1-MARKET.md` — competitors and asset table.
5. `eval/PANEL.md` — one-liners and misreadings to avoid.

Do not use earlier conversations or assumptions outside these files. If a fact is missing, say so in the plan as an assumption with a default, and keep going.

## Hard constraints (from the handoff, restated so you cannot miss them)

- Today is Wed 2026-09-30. Build runs Oct 1–12. Video recorded by Oct 11. Submission 11:59pm PT Oct 12.
- Granularity: **half-day slots** (D1-AM, D1-PM, … D12-PM). Every slot has one concrete deliverable and one check that proves it.
- Solo by default. Mark slots a second builder could take with `[B2]`; the default assignment for B2 is execution and policy plumbing. The plan must still close solo.
- Front-load the founder's weak areas: Solana execution plumbing and consumer UX. Their strengths (credit, structuring, FX, data pipelines, risk models) go later and faster.
- **No partner outreach tasks.** The founder handles Nora, Chainless and Picnic outside the plan. The plan only contains the technical consequences of those conversations.
- **G-Nora gate:** no BRS-specific development before the gate passes (mint/redeem integration, BRS execution step, BRS cap and provenance, BRS tests). Before the gate, the engine is built currency-generic with an abstract "BRL leg" (zero yield, no FX risk vs goal, parameterised cap and mint path). The gate's latest date is end of D6 (Oct 6). The plan must contain **both branches** and stay on schedule under either.
- **Policy mechanism decision by end of D2.** Spike delegated execution (Squads spending limits, token delegate approvals, or a minimal custom program) and pick one, or fall back to user-signed rebalance that the policy checks and proposes. The fallback is decided on a date, not discovered on D10.
- **EVM adapter (S1) decision by D5.** Only if a partner confirms a pilot chain and the core MVP is on schedule.
- Feature freeze: propose a date (Oct 9 suggested) and say what "freeze" means in practice.
- Build it as the product (real API, real data model, in-window commits clearly separable from prior work), UI can be plain.
- Nothing in the video may be simulated and shown as real. Any mock or sandbox is labelled on screen.

## Verification-first rule

`HANDOFF-IDEA1.md` §8 lists unverified items. The plan must schedule **explicit verification tasks in D1** for every one the build depends on (live yields for Kamino USDC / syrupUSDC / USDY; delegated-execution support; xStocks depth at demo notionals; Jupiter API key and endpoint; Kamino SDK version). Each verification task states: what to check, how (URL, SDK call, or script), and what to do if it fails. Do not carry a number from the dossiers into the plan as if it were current.

## What PLAN.md must contain, in this order

1. **Plan summary** (≤ 10 lines): what ships, the two things the build must prove (product is real on mainnet; partners can plug it in), and the single most likely failure point with its mitigation.
2. **Stack decision.** Propose a stack with one-line justification each. Defaults unless you have a reason to change them: TypeScript end to end (Jupiter and klend-sdk are TS); Node API (Fastify or Hono) with OpenAPI generated from zod schemas; Postgres (or SQLite for speed, with a migration note); Next.js or plain React for the chat/monitoring UI; a deterministic solver (small LP/QP via a JS library, or rules-plus-optimisation over 3–4 legs); an LLM only for goal parsing into a validated typed schema. State the deviations and why.
3. **Architecture sketch** (≤ 1 page): modules and their boundaries. Must include: goal parser → constraint sheet; asset registry with yield/provenance feeds; solver; BRL schedule and stress engine; risk sheet; policy object and rebalance engine; chain adapters (Solana live; EVM plan-to-calldata stub); API (`POST /goals`, `POST /plans`, `POST /plans/{id}/transactions`); UI (chat, plan view, monitoring, partner embed). Show where the "BRL leg" abstraction sits so BRS slots in without rework.
4. **The slot table.** One row per half-day, D1-AM through D12-PM. Columns: `Slot | Workstream | Deliverable | Check (how we know it's done) | Depends on | [B2]? | Notes`. Rules:
   - Every check is observable: a test passes, a mainnet tx hash exists, a screenshot exists, a number reproduces in a spreadsheet.
   - Show the G-Nora branch explicitly: slots that change if the gate passes vs fails, and the block of ~1.5–2.5 days of BRS work that gets inserted when it passes (say where it goes and what it displaces).
   - Show the policy-mechanism decision slot (D2-PM at the latest) and what changes on each outcome.
   - Reserve: video script and shot-list slot; recording slot; buffer; submission slot.
   - Put the first real mainnet transaction as early as possible (target D3), even if tiny, to de-risk plumbing.
5. **Decision log with cut-offs.** A table: decision, options, default if no information arrives, cut-off date, who decides, what changes in the slot table on each outcome. Include: policy mechanism; G-Nora; EVM S1; solver form; feature freeze; second builder yes/no.
6. **Risk register.** At least 10 rows: risk, likelihood (H/M/L), impact, early signal, mitigation, owner, slot where it is retired. Must include: delegated execution not achievable; Nora gate slips; xStocks liquidity too thin on weekend recording; live yields lower than dossier figures breaking the "R$3k/month" example; LLM parser producing invalid constraint sheets; Jupiter API key/rate limits; Kamino SDK breaking change; time overrun on UI; founder's own funds too small for convincing demo numbers; regulatory framing ("not licensed advice").
7. **Acceptance checks mapping.** Reproduce the checklist from `HANDOFF-IDEA1.md` §4.5 and map each item to the slot that satisfies it and the artifact that proves it.
8. **Video plan.** A 3-minute script outline that follows the pitch guardrails in §9 (lead with the BRL schedule under stress and the risk sheet; "policy in your wallet, not a fund" in the first sentence; the one-slide Glider/Ondo answer; Nexa as analog not opener; claim only what is live or signed). Shot list with what must exist on screen for each shot and which slot produces it.
9. **Submission checklist.** Repo hygiene, prior-work disclosure text (teiten, analysis-rules/haircut discipline, the 13.5k-contract tokenized-credit DB, partner relationships), dated in-window commits, explorer links, LOI documents, Discord question about Solana+Base double eligibility, and the "not licensed advice" disclaimer placement.
10. **Open questions for the founder** (≤ 10). Only questions whose answer changes the plan. For each, give the default you assumed so the plan is usable without an answer.
11. **Plan self-check.** Before you finish, confirm in writing: (a) both G-Nora branches close by Oct 11; (b) no BRS-specific dev appears before the gate; (c) no outreach tasks appear; (d) every §8 unverified item has a D1 verification task; (e) every §4.5 acceptance check maps to a slot; (f) the first mainnet tx is ≤ D3; (g) freeze date is set and respected by later slots; (h) no yield or APY figure appears as a fact anywhere in the plan.

## Style

- Plain language, short sentences. Tables over prose where possible.
- No motivational filler. No "we could also…" lists. Every line is a commitment or a decision.
- Target length: 6–10 pages of Markdown. If you exceed 12, cut detail from later slots, not from D1–D4.
- Write the file, then print only the plan summary and the open questions in your reply.
