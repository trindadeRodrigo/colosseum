# PLAN.md — 12-day build plan, Colosseum Crypto World's Fair

> Historical: the build plan of the first product. Superseded by `docs/vault/PLAN-VAULT.md` and the ledger, `docs/vault/STATE-VAULT.md`.

*Written Wed 2026-09-30 from `HANDOFF-IDEA1.md` (authoritative), `eval/FINAL.md`, `eval/FEASIBILITY.md`, `eval/IDEA1-MARKET.md`, `eval/PANEL.md`. Build runs Thu Oct 1 (D1) to Mon Oct 12 (D12). Video recorded by Sun Oct 11. Submission 11:59pm PT Oct 12.*

Calendar: D1 Thu Oct 1 · D2 Fri Oct 2 · **D3 Sat Oct 3 · D4 Sun Oct 4** · D5 Mon Oct 5 · D6 Tue Oct 6 · D7 Wed Oct 7 · D8 Thu Oct 8 · D9 Fri Oct 9 · **D10 Sat Oct 10 · D11 Sun Oct 11** · D12 Mon Oct 12. Weekends in bold: xStocks depth is thin, so xStocks execution is scheduled on weekdays only.

*Amended after the D1 verification run (see `docs/structurer/VERIFICATION.md`, "Plan changes"): Solana client library, local Postgres port, D2-PM spike scope, D4-PM yield method.*

---

## 1. Plan summary

- **Ships:** a goal-based structurer for Brazilian self-custody wallets. A goal in reais becomes a typed constraint sheet, a deterministic allocation across Solana legs (Kamino USDC, syrupUSDC, USDY, a BRL leg, USDC buffer, xStocks for high-risk goals), a month-by-month BRL cash-flow schedule with stresses, a per-leg risk sheet with provenance, real mainnet execution into the user's wallet, a stored policy with at least one mainnet rebalance, a monitoring page, and a three-endpoint API with public docs and an unbranded partner embed.
- **Must prove (1):** the product is real on mainnet. Evidence: explorer links for every execution and rebalance, live yields with source and timestamp, three goals giving three different allocations.
- **Must prove (2):** partners can plug it in. Evidence: `POST /plans/{id}/transactions` returns unsigned transactions that a script signs and lands on mainnet; public API docs; embed view.
- **Most likely failure point:** multi-leg execution and the policy mechanism (D2–D3, and D7-AM). Mitigation: first mainnet transaction on D2-AM, the policy mechanism decided on D2-PM with a dated fallback to user-signed rebalances, a second builder assignable to all execution slots, and the D10-PM buffer reserved for slips from D3–D8 only.
- **G-Nora** resolves by end of D6. Both branches close by D11-AM. The engine is currency-generic until then; BRS work is a fixed 1.5-day block at D7-PM–D8-PM that displaces polish, not core.
- **Feature freeze:** Fri Oct 9, 18:00 BRT.

## 2. Stack decision

| Layer | Choice | Why (one line) |
|---|---|---|
| Language | TypeScript end to end, pnpm workspace monorepo (`apps/api`, `apps/web`, `packages/schemas`, `packages/engine`, `packages/chain-solana`, `packages/chain-evm`) | Jupiter and klend-sdk are TS; one language for a solo builder. |
| API | Fastify + `fastify-type-provider-zod`; OpenAPI generated from zod; Scalar docs page served at `/docs` | The three endpoints and the docs page come from the same schemas; no hand-written spec. |
| Schemas | zod in `packages/schemas`, shared by API, engine, UI and the LLM parser | One `ConstraintSheet` type validates LLM output, API input and DB rows. |
| Database | **Postgres from day 1** (Drizzle ORM + drizzle-kit migrations; local `docker run` on port 5433, hosted on Railway or Neon) | Deviation from "SQLite for speed": hosting Postgres is one click, friendly users need a hosted DB by D8, and it removes the migration note. The product continues after Oct 12. |
| UI | Next.js (App Router) + Tailwind, plain components; `@solana/wallet-adapter-react` (Phantom); deployed on Vercel | Serves chat, plan view, monitoring, embed route and docs link from one app; wallet connect is the only auth. |
| Solver | Rules layer (eligibility, caps, profile) + small LP via `javascript-lp-solver` (pure JS, no WASM toolchain); greedy waterfall fallback when infeasible, reported as such | Deterministic, explainable in one screen as "binding constraints"; no LLM in the loop. |
| LLM | Anthropic Claude API (TS SDK), structured output validated by zod; default model `claude-sonnet-5-5`, swap by env var | Parses goals into `ConstraintSheet` only. Invalid output → user edits the sheet; the solver never runs on unvalidated input. |
| Solana | `@solana/kit` 2.x in `chain-solana` (klend-sdk 12.x depends on it, not on web3.js v1; V3); Jupiter REST `api.jup.ag/swap/v1` (`quote`, `swap-instructions`) with `x-api-key`; `@kamino-finance/klend-sdk` 12.x; Helius or Triton RPC. The web app keeps `@solana/wallet-adapter` (web3.js v1) and exchanges base64 transactions with the API | Direct REST for Jupiter avoids SDK churn; `swap-instructions` lets the executor compose atomic multi-instruction transactions. |
| EVM (stub) | viem; `packages/chain-evm` returns calldata for a plan leg; no execution unless S1 is approved | Keeps the core chain-agnostic at near-zero cost. |
| Data feeds | Kamino API / klend-sdk on-chain reads; issuer-reported yields (Maple, Ondo) with realised-yield cross-check from on-chain price or exchange rate; BCB SGS API for PTAX, Selic, CDI; Jupiter quotes for depth | Every observation stores `source`, `fetched_at`, `method`. |
| Tooling | vitest, Biome (lint + format), tsx scripts, GitHub Actions on push (typecheck, lint, test) | One config each; CI proves in-window commits build. |

## 3. Architecture sketch

```
 apps/web (Next.js)                          apps/api (Fastify, OpenAPI from zod)
 ├─ /            chat → ConstraintSheet editor   POST /goals                 → ConstraintSheet
 ├─ /plans/[id]  weights, reasoning, schedule,   POST /plans                 → allocation + schedule + risk sheet
 │               stresses, risk sheet            POST /plans/{id}/transactions → UnsignedTx[] (chain-specific)
 ├─ /monitor     positions, drift, next          GET  /plans/{id}, /policies/{id}, /positions
 │               withdrawal, projected vs actual GET  /docs (Scalar)          disclaimer constant in every plan response
 └─ /embed/[id]  same plan in an unbranded frame
                                    │
 packages/engine                    ▼
 ├─ parser/       LLM → zod ConstraintSheet (target, currency, horizon, liquidity window, risk, credit, FX stance)
 ├─ assets/       registry: Asset {kind: usd_yield | brl_stable | cash | equity, chain, mint, eligibleProfiles,
 │                cap, oracle, redemption, gates, issuer}; feeds → yield_observations, fx_observations, depth_observations
 │                haircut rules (analysis-rules) → haircut_yield with rule id
 ├─ solver/       rules (eligibility, caps, profile) + LP over legs → weights + reasoning + binding constraints
 ├─ schedule/     BRL month-by-month: withdrawals, accrual on haircut yields, FX path; stress cases; liquidity check
 ├─ risk/         per-leg risk sheet assembled from registry + latest observations
 └─ policy/       Policy {allowedAssets, bands, trigger, withdrawalDestination}; drift; rebalance proposal → LegOrders
                                    │
 packages/chain-solana              ▼                         packages/chain-evm
 ├─ executors/    LegExecutor per asset kind:                  └─ calldata builder stub (viem), no send
 │    jupiterSwap (USDY, syrupUSDC, xStocks, dex-listed BRL)
 │    kaminoDeposit / kaminoWithdraw
 │    brlLeg: MintAdapter  ← abstract. Pre-gate: {kind:'unavailable', label:'BRS mint via Nora: integration in progress'}
 │                            Post-gate: NoraMintAdapter {kind:'issuer_mint'} added here, nothing else changes
 ├─ compose/      plan → ordered UnsignedTx[] (USDT→USDC first), per-leg status, partial-failure handling
 ├─ sign/         user wallet (adapter) | agent keypair (mechanism A) | script signer (API demo)
 └─ log/          executions table: leg, signature, explorer link, status
```

**Where the BRL leg abstraction sits.** The registry holds one asset of `kind: 'brl_stable'` with `yield = 0`, `fxRiskVsGoal = 0`, `cap` (parameter, default from config) and `mintPath` (a `MintAdapter` interface). The solver, schedule, risk sheet and UI consume the leg through the registry and never reference Nora or BRS. Post-gate work touches exactly three places: a `NoraMintAdapter` in `chain-solana/executors`, the registry entry's provenance and cap, and tests. Nothing upstream is rewritten.

**Data model (D1-AM migrations):** `goals`, `constraint_sheets`, `assets`, `yield_observations`, `fx_observations`, `depth_observations`, `plans`, `plan_legs`, `schedules`, `stress_cases`, `risk_sheets`, `policies`, `positions`, `executions`, `rebalances`. Every numeric yield, price or FX value lives in an observations table with `source`, `fetched_at`, `method`; a test greps the codebase and fails on a numeric yield literal outside `fixtures/`.

## 3a. D1 verification tasks (run in D1-AM, results in `docs/structurer/VERIFICATION.md`)

Each entry records command or URL, value, timestamp. No number from the dossiers is carried into code, docs or UI.

| # | Item (§8) | What to check | How | If it fails |
|---|---|---|---|---|
| V1 | Live yields: Kamino USDC, syrupUSDC, USDY | Current supply yield for each, with source and method | Kamino: klend-sdk `KaminoMarket.load` on the main market → USDC reserve supply APY (on-chain read), cross-check Kamino API. syrupUSDC: Maple's published rate plus realised yield from the syrupUSDC/USDC exchange rate over the last 30 days on-chain. USDY: Ondo's published rate plus realised yield from the USDY price oracle over 30 days. | If an issuer feed is missing, use the realised-30d method and label `method: realised_30d`. If the yield after haircut makes the R$3k/month example need implausible capital, switch the hero goal to accumulation ("R$250k in 3 years") and keep income as the second goal. |
| V2 | Jupiter API key and endpoint | Key works; quote returns for USDC→USDY, USDC→syrupUSDC, USDC→SPYx, USDT→USDC; rate-limit tier | Create key at portal.jup.ag; `curl -H "x-api-key: $KEY" "https://api.jup.ag/swap/v1/quote?inputMint=<USDC>&outputMint=<USDY>&amount=5000000&slippageBps=50"`; check response headers for limits | If a pair has no route, mark that asset `unavailable` in the registry and drop it from demo goals. If the key tier is too low for the depth cron, reduce cron to 30-min and 3 notionals. |
| V3 | Kamino SDK version | Installed version, its `@solana/web3.js` peer, `buildDepositTxns` signature, a dry-run deposit tx simulates | `npm view @kamino-finance/klend-sdk version`; load main market; build a deposit tx for a tiny USDC amount; `simulateTransaction` | If the SDK is broken or its web3 peer conflicts, replace the Kamino leg with Jupiter Lend USDC (same asset kind) and record the substitution in `docs/GATES.md`. |
| V4 | xStocks depth at demo notionals and weekend behaviour | Price impact for SPYx and QQQx at 4 notionals; start the 15-minute depth snapshot cron so Oct 3–4 is captured | Script calling Jupiter quote at $50, $500, $5k, $50k for each, writing `depth_observations`; cron via launchd or a hosted cron from D1-PM through D12 | If impact > 1% at $500, cap demo xStocks notional below that point. If quotes fail or the token is not routable, keep xStocks in the registry as `unavailable` and show them in the plan only, labelled. |
| V5 | Delegated execution support | (a) SPL `approve` works on the target mints and token programs; (b) Jupiter `swap-instructions` accepts `destinationTokenAccount` so output lands in the user's ATA; (c) Squads v4 spending limits are transfer-only (cannot CPI into Jupiter or Kamino); (d) Kamino deposit requires the obligation owner's signature | Read docs, then a devnet-free check: `getAccountInfo` on each mint for token program; quote with `destinationTokenAccount` set; read Squads v4 spending-limit docs | Write the 10-line assessment that D2-PM uses. If (a) or (b) fails, the D2-PM default becomes fallback C (user-signed). |
| V6 | Mint addresses and token programs | USDC, USDT, USDY, syrupUSDC, SPYx, QQQx, BRS (`BRSxQRUaGswjLs7ewcH7uXj3r7SgmfKSSLLXyCKHZtUo`), and whether each is Token or Token-2022 | `getAccountInfo` on each mint; record owner program | An unexpected token program changes the executor code path; note it for D1-PM. |
| V7 | FX and rate data | PTAX USD/BRL, Selic and CDI series return today's value | `https://api.bcb.gov.br/dados/serie/bcdata.sgs.<id>/dados/ultimos/1?formato=json` for the PTAX, Selic and CDI ids; confirm ids | Fall back to the founder's prior macro dataset, labelled `source: prior_dataset`. |

Founder-only items in §8 that are not build tasks: which chain each LOI partner pilots (feeds the D5 S1 decision); the Discord question on Solana + Base double eligibility (ask on D1, record the answer in `docs/GATES.md`); the regulatory position (drives the disclaimer wording only).

## 4. Slot table

Legend: **[B2]** = a second builder can take it (default B2 scope: execution and policy plumbing). Every mainnet action uses the demo wallet and the smallest sensible amount. Explorer links go in `executions`.

| Slot | Workstream | Deliverable | Check (how we know it's done) | Depends on | [B2]? | Notes |
|---|---|---|---|---|---|---|
| **D1-AM** Thu Oct 1 | Setup + Verify | Repo scaffold per §2; `CLAUDE.md`; migrations for the 15 tables; `docs/GATES.md`, `STATE.md`, `docs/PRIOR-WORK.md`; V1–V7 run and recorded in `docs/structurer/VERIFICATION.md`; `.env.example`; CI | `pnpm typecheck && pnpm lint && pnpm test` green in CI on an Oct 1 commit; `VERIFICATION.md` has 7 entries with command, value, timestamp | — | no | This is PROMPT-BUILD 2A. Founder: ask the Discord double-eligibility question today. |
| **D1-PM** | Exec plumbing | Demo wallet (file keypair, gitignored) funded with USDC and SOL; RPC configured; `chain-solana`: `getQuote`, `buildSwapTx` (from `swap-instructions`), `simulate`; registry seeded with mints from V6 and the abstract BRL leg; depth cron running | `simulateTransaction` succeeds for a USDC→USDY swap at a few dollars; `depth_observations` has ≥ 4 rows | D1-AM | [B2] | Founder's own funds. Weak area, front-loaded. |
| **D2-AM** Fri Oct 2 | Exec | **First mainnet transactions:** Jupiter swap USDC→USDY, swap USDC→syrupUSDC, Kamino USDC deposit via klend-sdk; each logged in `executions` with explorer link | 3 signatures on Solscan; 3 rows in `executions` with `status = confirmed` | D1-PM | [B2] | If Kamino fails, log it and retry in D3-AM; the V3 substitute (Jupiter Lend) is the fallback. |
| **D2-PM** | Policy spike + **decision** | Timeboxed 4h spike of mechanism A: user `approve`s a delegate (agent key) for a bounded amount; agent composes one atomic tx: delegate transfer → Jupiter swap → output to the user's ATA via `destinationTokenAccount`. Read-only assessment of Squads v4 (B). Decision written to `docs/GATES.md` by 18:00 | Either a mainnet tx where the agent key rebalanced a few dollars of the user's USDY→syrupUSDC without a user signature (→ A), or the written decision for fallback C with the reason | D2-AM, V5 | [B2] | Kamino deposits and withdrawals need the owner's signature under A; the video says so. C = the policy checks and proposes; the user signs. Custom program is rejected on time grounds. |
| **D3-AM** Sat Oct 3 | Exec engine | `compose/`: plan → ordered `UnsignedTx[]` (USDT→USDC first), per-leg status, partial-failure handling, `executions` logging; `POST /plans/{id}/transactions` (first API route); `scripts/mainnet/sign-and-send.ts` | A 3-leg fixture plan (USDY, syrupUSDC, Kamino) executed on mainnet from the API's unsigned txs by the script; 3 links; a forced failure on leg 2 leaves legs 1 and 3 correctly recorded | D2-AM | [B2] | No xStocks on the weekend. |
| **D3-PM** | Policy + rebalance | `Policy` schema and table; drift calculation; rebalance engine producing `LegOrders` under the D2-PM mechanism (A: approve flow + agent executor; C: propose + user-sign); **mainnet rebalance #1** | Tests: rebalance never proposes an asset outside `allowedAssets`, never a destination other than the owner, never exceeds bands; one rebalance signature on Solscan | D2-PM, D3-AM | [B2] | |
| **D4-AM** Sun Oct 4 | UI skeleton | Next.js app: wallet connect, routes `/`, `/plans/[id]`, `/monitor`, `/embed/[id]`, `/docs` link; plan view renders a fixture plan; disclaimer constant in the footer | Screenshot: wallet connected and fixture plan rendered; deployed preview URL on Vercel | D1-AM | no | Weak area, front-loaded. Plain styling. |
| **D4-PM** | Registry + feeds + risk sheet | Feed fetchers (V1 methods) writing `yield_observations`, `fx_observations`; haircut rules from analysis-rules applied → `haircut_yield` + rule id; registry metadata per asset (oracle, redemption path and time, KYC/geo gates, issuer, credit exposure); `risk/` assembles the per-leg sheet including xStocks (0% yield, 24/5 primary redemption, minimum per xStocks FAQ, weekend depth from `depth_observations`) | Every asset has ≥ 1 observation with source URL, `fetched_at`, `method`; risk sheet JSON snapshot test; the literal-yield lint test passes | D1-AM, D1-PM | no | Founder strength: data pipelines and provenance. |
| **D5-AM** Mon Oct 5 | Solver | Rules + LP: match near-term BRL obligations and the liquidity window with the BRL leg (capped), fund later obligations with USD yield legs, cash buffer, risk and credit budgets, profile eligibility enforced in the registry; reasoning string and binding constraints per leg. **S1 decision recorded today.** | Three fixture goals (income, accumulation, high-risk) give three different allocations; tests: xStocks absent from `income`; BRL weight rises with a shorter liquidity window and never exceeds cap; infeasible goal returns a reported fallback | D4-PM | no | Side task, 30 min, [B2]: first xStocks mainnet buy (SPYx, smallest size) on a weekday; signature logged. |
| **D5-PM** | Schedule + stress | `schedule/`: month-by-month BRL schedule (withdrawals, accrual on haircut yields, FX path), liquidity-window check; stresses: yields fall (parameter), BRL appreciates and depreciates (parameter), credit event or redemption gate on the credit leg, equity −20% when stocks are held; CSV export | One month of the income goal reproduces by hand in `docs/structurer/schedule-check.csv` (spreadsheet); stress table has ≥ 4 rows per goal; liquidity check returns pass/fail | D5-AM | no | Founder strength. |
| **D6-AM** Tue Oct 6 | Parser + API | LLM parser → zod `ConstraintSheet` (PT and EN), eval fixture of 20 goals; Fastify routes `POST /goals`, `POST /plans`, `GET` reads, OpenAPI JSON, Scalar `/docs`; API deployed (Railway) with hosted Postgres | 20/20 goals give a valid sheet or an explicit validation error, zero silent failures; `curl` against the public URL works for all three POST routes; `/docs` renders | D5-PM, D3-AM | [B2] for the API half | Parser prompt lives in one file; temperature 0. |
| **D6-PM** | UI hero flow + high-risk execution | `/` chat → editable sheet → `/plans/[id]` with weights, reasoning, schedule chart, stress table, risk sheet, all from the live API; high-risk goal plan (incl. xStocks and credit leg) executed on mainnet (weekday) | Screenshots of the three demo goals in the UI; no hard-coded yields (lint test); xStocks execution signature logged | D6-AM, D5-AM | [B2] for the execution half | **G-Nora latest: 18:00 today.** Record outcome in `docs/GATES.md`. |
| **D7-AM** Wed Oct 7 | Monitoring + rebalance #2 | `/monitor`: live positions from chain, drift vs bands, next scheduled withdrawal, projected vs actual; trigger control (A: "run policy", agent-signed; C: "propose", wallet signs); **mainnet rebalance #2 from the UI** | Screenshot with real positions; rebalance signature on Solscan linked from the page | D3-PM, D6-PM | [B2] | |
| **D7-PM** | FLEX-1 | See the G-Nora branch table below | per branch | D7-AM | [B2] on PASS | |
| **D8-AM** Thu Oct 8 | FLEX-2 | See the G-Nora branch table below | per branch | D7-PM | [B2] on PASS | |
| **D8-PM** | FLEX-3 | See the G-Nora branch table below | per branch | D8-AM | [B2] on PASS | |
| **D9-AM** Fri Oct 9 | Hardening + acceptance | `scripts/acceptance.ts` runs every §4.5 check and writes `docs/structurer/ACCEPTANCE.md` with artifact links; hero income example capital computed from live haircut yields and reproduced in the spreadsheet; `/embed/[id]` unbranded route finished (1 h); friendly-user wallets invited with the public URL | `ACCEPTANCE.md` all ticked; capital figure matches the spreadsheet; ≥ 2 external wallets have a plan in the DB by end of day | D7-AM, FLEX | no | Last day for new code. |
| **D9-PM** | **FREEZE** + video prep | Freeze at 18:00 BRT (tag `freeze`); video script (§8) and shot list; slides: cold-open schedule, Glider/Ondo one-slider, Nexa analog, prior-work and disclaimer; **record the weekday xStocks execution clip today** with the date on screen | `docs/structurer/VIDEO.md` script and shot list; slide PDF; xStocks clip file exists | D9-AM | no | Freeze defined in §5. |
| **D10-AM** Sat Oct 10 | Video dry run | Full hero flow recorded end to end on mainnet with a fresh wallet (income goal); explorer links captured; P0 bug list | Dry-run file plays through all shots; P0 list ≤ 3 items | D9-PM | no | Income goal only on the weekend (no xStocks). |
| **D10-PM** | **Buffer** | Close every `slipped` row in `STATE.md` from D3–D8; fix P0s from the dry run with a test each; otherwise second dry run | `STATE.md` has no open `slipped` rows; P0 list empty | — | no | Not for new features. |
| **D11-AM** Sun Oct 11 | **Recording** | Final 3-minute recording and voiceover; live segments recorded live on mainnet; every mock or sandbox element labelled on screen | Final MP4 ≤ 3:00; shot list fully ticked | D10 | no | Deadline for the video. |
| **D11-PM** | Package | Edit and upload (unlisted); README with explorer link list, architecture, run instructions; `docs/PRIOR-WORK.md` final; LOI PDFs in `docs/loi/`; disclaimer check; submission form draft filled | Video URL plays; form draft complete; README links resolve | D11-AM | no | |
| **D12-AM** Mon Oct 12 | **Buffer** | Re-cut or re-upload only; submission form review | — | — | no | No code changes. |
| **D12-PM** | **Submission** | Submit Colosseum form and the Superteam Brasil track form by 18:00 BRT (14:00 PT); confirmation captured | Confirmation screenshot or email in `docs/submission/` | D11-PM | no | Deadline 11:59pm PT = 03:59 BRT Oct 13. Submit early. |

### 4a. G-Nora branch for the FLEX block (D7-PM, D8-AM, D8-PM)

The gate is a founder conversation. It can resolve any day from D1; the BRS block stays at D7-PM–D8-PM because it needs the executor (D3-AM), registry (D4-PM) and solver (D5-AM). If a second builder exists and the gate passes before D6, B2 starts BRS-1 in D5-PM instead and the FLEX block reverts to the FAIL content.

| Slot | Gate **PASSED** by 18:00 D6 (BRS block, 1.5 days, [B2]) | Check | Gate **FAILED** or unresolved at 18:00 D6 | Check |
|---|---|---|---|---|
| D7-PM | **BRS-1:** `NoraMintAdapter` (API client, auth, sandbox call, then mainnet mint of BRS from USDC at Nora's minimum); execution step in `compose/`; `executions` row | One mainnet BRS mint signature; sandbox call labelled `provenance: sandbox` in logs | Set BRL leg label "BRS mint via Nora: integration in progress" everywhere it renders; test asserting execution never includes the BRL leg; UI polish on schedule and risk-sheet views (weak area) | Test passes; label visible in plan view, risk sheet, API response |
| D8-AM | **BRS-2:** registry entry with provenance from Nora's facts (FX rate source, spread, fees, settlement, redeem path, KYB status); cap from Nora's limits; `positions` record; risk-sheet entry; tests (cap never exceeded; income goal includes BRS for near-term months) | Tests pass; risk sheet shows BRS with source and timestamp | **S1 EVM adapter** if approved on D5 (one leg on the partner's chain, calldata via `/transactions`; no send); otherwise Solana execution hardening (retries, partial-failure UX) and API docs polish | S1: calldata validates with viem and simulates on the partner chain; else: partial-failure test suite green |
| D8-PM | **BRS-3:** income-goal plan executed end to end on mainnet including the BRS mint; BRS position on `/monitor`; explorer link | End-to-end signature set incl. mint; monitor screenshot | Friendly-user onboarding (2–3 wallets run an income goal); monitor polish; second wallet's execution | ≥ 2 external wallets with executions in DB |

What PASS displaces: UI polish, S1, execution hardening, and the friendly-user slot. Friendly users then onboard on D9-AM with the public URL; S1 is cut unless B2 exists. Both branches leave D9-AM, the freeze and the video slots untouched.

## 5. Decision log with cut-offs

| Decision | Options | Default if no information arrives | Cut-off | Who | What changes in the slot table |
|---|---|---|---|---|---|
| Policy mechanism | A: token-delegate approvals + agent key composing atomic Jupiter txs (Kamino leg user-signed). B: Squads v4 vault with agent member. C: policy checks and proposes; user signs | **C** | D2-PM 18:00 | Founder (B2 advises) | A: D3-PM builds approve flow and agent executor; D7-AM has "run policy" with no signature; video claims delegated rebalancing for Jupiter legs only. C: D3-PM builds propose-and-sign; D7-AM has "propose" → wallet signs; video says "you sign each rebalance, the policy decides". B is chosen only if the spike shows spending limits can execute a swap, which V5 expects to be false. |
| G-Nora (BRS mint) | PASS with facts (who mints, API, inputs, limits, fees, FX source, settlement, redeem, KYB) / FAIL | **FAIL** | D6 18:00 | Founder | See §4a. PASS inserts BRS-1..3 at D7-PM–D8-PM and moves friendly users to D9-AM. FAIL keeps the leg labelled "integration in progress" and excluded from execution. |
| EVM adapter S1 | Build one leg on the confirmed pilot chain / skip | **Skip** | D5-AM | Founder | Build only if a partner has confirmed a chain in writing **and** `STATE.md` shows no `slipped` rows **and** G-Nora has not passed (or B2 exists). Lands in D8-AM (FAIL branch). |
| Solver form | LP via `javascript-lp-solver` with rules layer / rules-only greedy waterfall | **LP + rules**; greedy as the infeasibility fallback | D5-AM | Founder | If the LP misbehaves on the three fixture goals within 2 h, D5-AM finishes with the greedy waterfall and the LP is dropped; the check is unchanged. |
| Feature freeze | Oct 9 18:00 BRT / later | **Oct 9 18:00 BRT** | D9-PM | Founder | After the freeze: no new features, schema changes or dependency upgrades; only P0 fixes (crash, wrong number, failed mainnet path) with a test; copy changes allowed; `main` tagged `freeze`. |
| Second builder | Yes / no | **Yes** from 2026-10-01: Gabriel Thom, tech and infrastructure (was No on 2026-09-30; see `docs/GATES.md` B2) | D1-AM | Founder | Yes: B2 owns D1-PM, D2-AM, D2-PM, D3-AM, D3-PM, D6-AM API half, D6-PM execution half, D7-AM, the BRS block and S1; founder starts D4-PM engine work on D2 in parallel. Plan closes solo either way. |
| Kamino leg substitute | klend-sdk main market / Jupiter Lend USDC | **klend-sdk** | D1-AM (V3) | Founder | Substitute changes D2-AM leg 3 and the registry entry only. |

## 6. Risk register

| # | Risk | L | Impact | Early signal | Mitigation | Owner | Retired in |
|---|---|---|---|---|---|---|---|
| 1 | Delegated execution (A) not achievable | H | Video cannot claim autonomous policy | V5 finds `approve` or `destinationTokenAccount` unusable; D2-PM spike has no mainnet tx by 16:00 | Decide C on D2-PM; build propose-and-sign; script the honest sentence for the video | Founder / B2 | D2-PM |
| 2 | Nora gate slips past D6 | M | No BRS mint in the video | No written facts from Nora by D5 | Currency-generic engine; FAIL branch pre-planned; label "integration in progress" | Founder | D6-PM |
| 3 | xStocks liquidity too thin at weekend recording | H | High-risk execution fails or shows large impact on Oct 10–11 | Depth cron shows impact rising on Oct 3–4 | Execute and film xStocks on weekdays (D5-AM, D6-PM, D9-PM clip with date on screen); weekend recording uses income goal live and the dated clip | Founder | D9-PM |
| 4 | Live yields lower than dossier figures break the "R$3k/month" example | M | Hero example needs implausible capital | V1 haircut yields | Compute the capital on D9-AM from live data; if implausible, hero goal becomes "R$250k in 3 years" and income is the second goal; no number in the plan | Founder | V1 (D1-AM), D9-AM |
| 5 | LLM parser produces invalid constraint sheets | M | Solver runs on garbage or demo stalls | Eval fixture below 20/20 | zod validation is the gate; invalid → user edits the sheet; temperature 0; 20-goal eval in CI | Founder | D6-AM |
| 6 | Jupiter API key or rate limits | M | Quotes fail mid-demo; cron blocked | V2 headers; 429s in logs | Key from portal on D1; cron at 15 min and 4 notionals within the tier; cache the last good quote with its timestamp and label it | Founder | D1-AM |
| 7 | Kamino SDK breaking change | M | Deposit leg fails | V3 dry run fails; peer conflict | Substitute Jupiter Lend USDC (same asset kind); registry swap only | Founder / B2 | D1-AM, D2-AM |
| 8 | Time overrun on UI | H | Monitoring or plan view unfinished at freeze | D4-AM or D6-PM slips | UI front-loaded (D4-AM skeleton); plain components; FLEX FAIL branch and D10-PM buffer absorb; cut order: embed polish → charts → chat styling | Founder | D9-AM |
| 9 | Founder's own funds too small for convincing demo numbers | M | Judges see cents | Wallet balance at D1-PM | Plan is scale-invariant: show weights and the BRL schedule at the goal's scale, execute at small notional, say "executed at demo size" on screen; friendly users add wallets | Founder | D9-AM |
| 10 | Regulatory framing ("not licensed advice") | M | Judge reads it as unlicensed advice | Partner asks who holds the licence | Disclaimer constant on plan view, API docs, README and video end card; B2B2C framing: distributor holds the client relationship | Founder | D4-AM, D11-PM |
| 11 | Multi-leg execution partial failures | H | Wallet left half-executed on camera | D3-AM forced-failure test fails | Per-leg status, idempotent re-run of failed legs only, never automatic retry on mainnet | B2 / Founder | D3-AM |
| 12 | Token-2022 or transfer-hook mints break the executor | M | xStocks or USDY leg cannot be composed | V6 token program mismatch | Executor branches on token program; if hooks block delegate transfer, that asset stays user-signed under A | B2 / Founder | D1-PM |
| 13 | RPC instability during recording | M | Live segment fails | Timeouts in D10 dry run | Paid RPC with a second provider as fallback in env; pre-record a backup take, labelled as a recording of a real tx | Founder | D10-AM |
| 14 | Freeze discipline | M | Late change breaks the dry-run path | Commits after `freeze` tag touching `packages/` | P0-only rule with a test per fix; CI green required | Founder | D9-PM |
| 15 | Prior-work separation questioned | L | Eligibility | Commits without `prior:` prefix that copy old code | `prior:` commits listed in `docs/PRIOR-WORK.md`; all product code in-window and dated | Founder | D11-PM |

## 7. Acceptance checks mapping (`HANDOFF-IDEA1.md` §4.5)

| Check | Slot | Artifact |
|---|---|---|
| Three goals give three sensibly different allocations with visible reasoning (income incl. BRL leg; accumulation; high-risk incl. xStocks and credit) | D5-AM, D6-PM | Solver tests; three UI screenshots in `docs/structurer/ACCEPTANCE.md` |
| BRL-leg weight changes with liquidity window and near-term obligations, never exceeds cap | D5-AM | Parameterised test over windows; cap assertion |
| G-Nora passed → one real mainnet BRS mint; failed → BRL leg labelled in progress | D7-PM (PASS) / D7-PM (FAIL) | Mint signature on Solscan / label screenshot + exclusion test |
| xStocks never in an income-profile allocation | D4-PM (registry eligibility), D5-AM | Registry test; solver test |
| Every yield shown has source and timestamp; no hard-coded APYs | D4-PM, D6-PM | Lint test on literals; risk-sheet snapshot; UI screenshot |
| Mainnet explorer link for every execution and rebalance shown | D2-AM, D3-AM, D3-PM, D6-PM, D7-AM, D8-PM | `executions` and `rebalances` rows; README link list |
| BRL schedule reproduces by hand for one month | D5-PM | `docs/structurer/schedule-check.csv` |
| Any mocked or sandbox element labelled on screen | D4-AM (constant), D11-AM | `provenance` field in API; on-screen labels in the final cut |
| API returns a valid unsigned transaction set and a script signs and sends it | D3-AM, D6-AM | `scripts/mainnet/sign-and-send.ts` run log with signatures |

## 8. Video plan (3 minutes)

Guardrails: lead with the schedule under stress and the risk sheet; "policy in your wallet, not a fund" in the first sentence; one-slide Glider/Ondo answer; Nexa as analog, not opener; claim only what is live or signed; label mocks.

| Time | Segment | Script outline | On screen (must exist) | Produced by |
|---|---|---|---|---|
| 0:00–0:15 | Cold open | "R$3.000 por mês a partir de 2028. This is that goal, month by month, in reais, under a BRL devaluation and a credit gate. It runs as a policy in your own wallet, not a fund." | Schedule chart with stress rows; liquidity check pass/fail | D5-PM, D6-PM |
| 0:15–0:40 | Why this is not Glider or Ondo | "They sell fixed model portfolios. We solve a user-specific cash-flow target in reais, haircut every quoted yield, and price the FX gap between a BRL goal and USD assets." | One slide, three columns: Glider, Ondo Intelligent Portfolios, this | D9-PM slides |
| 0:40–1:25 | Hero flow | Type the goal in Portuguese; the constraint sheet appears and is edited; allocation with reasoning per leg; the BRL leg matched to near-term months; risk sheet with source, timestamp, haircut rule, redemption path | `/` chat, sheet editor, `/plans/[id]` | D6-AM, D6-PM |
| 1:25–2:05 | Execution | Wallet holds USDC; execute; explorer links appear per leg. PASS: BRS mint from USDC through Nora. FAIL: "BRS via Nora: integration in progress" label. High-risk goal: xStocks buy, clip dated on screen | Execution panel; Solscan tabs; BRS mint or label; dated xStocks clip | D3-AM, D6-PM, D7-PM/D8-PM, D9-PM |
| 2:05–2:30 | Policy and rebalance | State the mechanism honestly (A: "Jupiter legs rebalance under the limits you approved; Kamino needs your signature"; C: "the policy decides and proposes; you sign"). Monitoring page with drift; rebalance link | `/monitor`; rebalance signature | D3-PM, D7-AM |
| 2:30–2:48 | B2B and traction | Three endpoints on the docs page; unbranded embed; LOIs from Chainless and Picnic dated in-window; Nexa analog slide (R$25M seed Jul 2025; "800+" is an issuance count; Genesis Sept 2026 with FIDC wrappers, no on-chain assets) | `/docs`, `/embed/[id]`, LOI PDFs, Nexa slide | D6-AM, D9-AM, D9-PM |
| 2:48–3:00 | Close | Live numbers (wallets, deposited value, rebalances executed, all from the DB); prior work disclosed; "not licensed advice" end card | Stats card; end card | D9-AM, D11-PM |

Shot rules: every live segment is recorded live on Oct 11 with the income goal; the xStocks segment is the dated weekday clip; nothing simulated is shown as real.

## 9. Submission checklist

- [ ] Repo public, `README.md` with one-liner, architecture, run instructions, explorer link list, video link, disclaimer.
- [ ] Commits dated Oct 1–12 with slot prefixes (`D3-AM: …`); `prior:` commits listed in `docs/PRIOR-WORK.md`; `freeze` tag on Oct 9.
- [ ] Prior-work disclosure text (submission form): "Prior work reused, all pre-dating the hackathon: (1) teiten, a live LatAm stablecoin analytics service covering nine EVM chains plus XRPL and Stellar with 1,454 macro series; (2) our analysis-rules and yield-haircut discipline; (3) a 13,500-contract tokenized-credit database; (4) pre-existing relationships with Nora Finance, Chainless and Picnic. Everything in this repository (goal parser, registry, solver, schedule and stress engine, risk sheet, policy and rebalance engine, Solana executors, API and UI) was written between Oct 1 and Oct 12, 2026; reused code is in commits prefixed `prior:`."
- [ ] Explorer links: every execution and rebalance in the video, listed in README with dates.
- [ ] LOIs from Chainless and Picnic as PDFs in `docs/loi/`, dated in-window; partner names on screen only with written permission (embed stays unbranded otherwise).
- [ ] `docs/GATES.md` final state (policy mechanism, G-Nora, S1) matches what the video claims.
- [ ] Discord answer on Solana + Base double eligibility recorded; enter Base track only if confirmed and S1 shipped.
- [ ] Superteam Brasil track form submitted (same project, explicitly allowed).
- [ ] "Not licensed advice" disclaimer on plan view, API docs, README and video end card.
- [ ] `.env`, keypairs and LOIs with private data excluded from the repo; `.env.example` complete.
- [ ] Submit by 18:00 BRT Oct 12; confirmation saved in `docs/submission/`.

## 10. Open questions for the founder

**Resolved 2026-09-30 by the founder:** no second builder for now (may join later; `[B2]` marks stay so slots can be handed over mid-build). All other questions take the default below. Feature freeze confirmed for Oct 9 18:00 BRT.

| # | Question | Default assumed |
|---|---|---|
| 1 | Is a second builder available from D1? | No. Plan runs solo; B2 slots are marked. |
| 2 | How much USDC and SOL can the demo wallet hold? | Enough for three goals at small notional; minimums (Kamino, Jupiter, Nora) are the binding constraint, not the total. |
| 3 | Is Anthropic the LLM provider (key available on D1)? | Yes, Claude API. |
| 4 | Are Vercel (web) and Railway or Neon (API + Postgres) acceptable hosts? | Yes. |
| 5 | Video language? | English narration, Portuguese goal typed on screen. |
| 6 | If klend-sdk fails V3, may the Kamino leg be replaced by Jupiter Lend USDC? | Yes. |
| 7 | Have Chainless or Picnic given written permission to use their name or logo in the embed? | No; embed stays unbranded, LOIs named on the traction slide only. |
| 8 | Which wallet do friendly users have? | Phantom; two to three users, onboarding D8-PM or D9-AM. |
| 9 | Is Oct 9 18:00 BRT confirmed as the freeze? | Yes. |
| 10 | If G-Nora passes early (by D4), do you want B2 (if any) to start BRS on D5-PM? | Yes if B2 exists; otherwise the block stays at D7-PM–D8-PM. |

## 11. Plan self-check

- (a) **Both G-Nora branches close by Oct 11:** PASS ends BRS-3 at D8-PM, FAIL ends at D8-PM; D9-AM hardening, D9-PM freeze, D10 dry run and buffer, D11-AM recording are identical in both. Confirmed.
- (b) **No BRS-specific dev before the gate:** D1–D7-AM contain only the abstract BRL leg (registry kind `brl_stable`, parameterised cap and `MintAdapter`). BRS-1..3 appear only in the PASS column of §4a, after the gate. Confirmed.
- (c) **No outreach tasks:** partner conversations, the Nora gate and LOIs are founder inputs; the plan contains only their technical consequences. The only founder-side action listed is the Discord rules question, which is not partner outreach. Confirmed.
- (d) **Every §8 unverified item has a D1 verification task:** live yields (V1), delegated execution (V5), xStocks depth and weekend (V4), Jupiter key and endpoint (V2), Kamino SDK version (V3); BRS minting is the gate itself; partner chains, double eligibility and the regulatory position are founder items recorded in `docs/GATES.md`. Confirmed.
- (e) **Every §4.5 check maps to a slot:** nine checks, nine rows in §7. Confirmed.
- (f) **First mainnet tx ≤ D3:** D2-AM. Confirmed.
- (g) **Freeze set and respected:** Oct 9 18:00 BRT; D10–D12 slots contain only P0 fixes, recording, packaging and submission. Confirmed.
- (h) **No yield or APY figure as a fact:** the plan names sources and methods only; the hero capital figure is computed on D9-AM from live data. Confirmed.
