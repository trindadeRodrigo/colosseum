# AUDIT: `main` and `risk-layer` before the vault work

*Written 2026-10-01. For Rodrigo and Thom. Companion to `HANDOFF-VAULT.md` and `CONVERGENCE-VAULT.md`.*

Scope: `main` at `6970dc5` and `risk-layer` at `75ae4f0`. Eight reviewers read the code and ran it in scratch copies, with no keys and nothing sent to mainnet. The fourteen most serious findings then went to a second pass whose job was to refute them. The reviewers' notes and probe logs are kept outside this repo; ask Thom for any of them.

## What it is

A goal-based structurer. A goal typed in reais becomes an editable constraint sheet, a deterministic allocation with a reason per leg, a monthly schedule with stresses, a risk sheet, unsigned mainnet transactions, and a stored policy that rebalances. `risk-layer` adds measured exit cost by size and hour of week for xStocks on four Solana AMMs.

What is strong:

- The model only fills a typed form. zod validates, the person edits, and a deterministic solver returns legs that each carry a reason. The new design asks for exactly this.
- Provenance is real: every yield, FX and depth row has a source, method and fetch time, and each plan leg points at the observation it used. `docs/structurer/schedule-check.csv` reproduces to within R$0.83.
- Every write path returns unsigned transactions for the owner, the transaction composer is correct and tested, and every mainnet transaction gets a log row. Five signatures in the docs were checked on chain and match.
- The pool decoders are exact: on Oct 1 the Raydium decoder matched Jupiter's same-pool quote for a $100k SPYx sale to 8e-10. The curve and regime maths is small, pure and tested, and reaches the engine through one interface.
- Tests are deterministic and offline (shuffled, four time zones, clock moved 800 days, network blocked). Strict TypeScript, one lockfile, migrations that match the schema, no secrets in any commit, and docs that say plainly what is unverified.

## Build and test status

Local runs on macOS arm64, Node 22, pnpm 11.5.3.

| Check | `main` | `risk-layer` |
|---|---|---|
| Frozen install | passes | passes |
| `pnpm lint` | passes, 14 warnings | fails, 3 errors |
| `pnpm typecheck` | passes | passes |
| Root `tsc` over `scripts/` and `tests/` (nothing runs it) | 4 errors | 11 errors |
| `pnpm test` | 73 pass, no database | 146 pass with a migrated Postgres 16; exit 1 without |
| `pnpm build` (web only) | passes | passes |
| Statement coverage | 36% | 50% |
| `pnpm audit` | 16 advisories, 5 high | same |

GitHub CI has never executed a check. All 38 runs fail within seconds at `pnpm/action-setup`: `.github/workflows/ci.yml:9` sets `version: 11`, `package.json:6` pins `pnpm@11.5.3`, and the action compares the strings. Every later step is skipped.

Coverage sits in the pure logic (schemas 100%, risk 87%, solver and schedule above 90%). The code that moves money is close to untested: `delegate.ts` 6%, `rebalance-executor.ts` 2%, positions, prices and sign 0%, route handlers 7 to 13%, web 0%.

## Findings

Severity is for the code as a product. Exposure today is small: the API is not deployed, one demo policy exists, and about $12 is delegated on mainnet. "Confirmed twice": the second pass reproduced it. "Confirmed once": one reviewer reproduced it and the code path was re-read for this report.

### High

Custody and API

1. Anyone can make the server sign and broadcast with the agent key. `POST /policies/:id/rebalance` (`apps/api/src/routes/monitor.ts:184-313`) has no auth, policy ids come from public read routes, and CORS reflects any origin (`app.ts:33`). The caller cannot change the trade and the output goes to the owner, so this does not steal. It hands outsiders the timing of every agent trade, and five concurrent calls produced five sends. Confirmed twice.
2. The policy's only onchain limit is an amount. `ApproveChecked` (`packages/chain-solana/src/delegate.ts:45-52`) lets the agent key send the approved amount anywhere; assets, bands and owner-only output live in TypeScript and Postgres. One plaintext key file serves every user and is read inside the API process (`wallet.ts:5-12`). A mainnet simulation moved the demo wallet's 5 USDY to an unrelated account with the agent as sole signer; that wallet still delegates 5 USDY and 5 syrupUSDC. One correction: the Token program accepts a revoke signed by the delegate, so the operator can revoke every approval. Confirmed twice.
3. The agent signs whatever the swap endpoint returns. `buildDelegatedSwapTx` (`delegate.ts:89-111`) appends the response's instructions as given, with no program allowlist, destination check or minimum-out of its own; the only gate is that simulation did not error. Run offline, a hostile response emptied an unrelated delegator's accounts. It needs control of the endpoint's response: low likelihood, the impact of a key leak. Confirmed twice.
4. Execution status can be forged. `POST /executions/:id/report` (`transactions.ts:107-135`) marks a row confirmed with any 64-character string, or none, and never checks the chain; the helpers in `packages/db/src/executions.ts:23-42` have no status guard. A forged row appeared in `/stats`. Reproduced by two reviewers independently.

Solana execution

5. Token-2022 holdings are never read. `ata()` (`delegate.ts:30-31`) always derives with the classic Token program and `readPositions` skips a missing account silently (`positions.ts:36-37`). The demo wallet's SPYx and QQQx are invisible; drift treats stocks as zero and proposes buying more. Stock orders are user-signed, so nothing moves without the owner. Confirmed twice, with a control fix.
6. Rebuilding a plan re-issues legs that already confirmed. `POST /plans/:id/transactions` (`transactions.ts:64-81`) builds every leg on every call and never reads prior outcomes, and the response schema (`packages/schemas/src/api.ts:34-38`) strips `skipped` and `errors`. Sends are fire-once, so one dropped leg strands the rest, and the recovery the code suggests buys the confirmed legs again. Confirmed twice.

Engine and parser

7. The "realised 30d" yield is two points of a noisy DEX price. `fetchRealised30d` (`packages/engine/src/feeds/yields.ts:38-50`) gave 3.1% for USDY on Oct 1 and 5.6% on Sep 30; Ondo's own oracle shows a steady 3.6%. The solver ranks and fills, so USDY's weight in a new plan flips between 40% and 8% or 0%. Existing plans keep their targets. Confirmed twice.
8. The default parser turns refusals into acceptances. `rules.ts:112-129` matches bare substrings: "sem ações" and "no stocks please" return a valid high-risk sheet, and "I do not want credit risk" returns credit accepted. Through the solver that is 35% stocks or 40% credit the person declined. The person does see the sheet first. Confirmed twice.

Risk layer

9. One public request freezes the API. `POST /risk/positions/assess` (`apps/api/src/routes/risk.ts:371-392`) accepts a 365-day window and an unbounded withdrawals array, and walks every hour of the window per withdrawal. Measured: 37 seconds of blocked event loop. Confirmed once.
10. The hourly import re-reads all history (`scripts/risk/import.ts:20-31`). Measured on generated files of the documented shape: about 0.7 GB of heap per day of collection, so it fails after roughly a week, and curves are then still served as live. Confirmed once; the failure day is an estimate.
11. The data is not in the repo. Registry, snapshots, curves and history live under `~/.colosseum/risk` and in Postgres on one Mac, on an RPC plan `docs/risk/PLAN-RISK.md` describes as free for one week. From the repo alone every `/risk` list route is empty. Confirmed once.

Web

12. The goal form crashes the page on any API error and hangs when the API is down: `GoalFlow.tsx:33-46` has no `try` and no `res.ok` check. Reproduced in a browser. Confirmed once.

### Medium

- Custody and API: no auth on any route, so every wallet's plans and positions are public; no rate limits; 500 responses return SQL text; the rebalance interval is check-then-act (`monitor.ts:98-103`, `:275-284`). The agent path has no independent price or impact cap (`prices.ts:30-39`); fills are deep today, and this becomes high the day a keeper trades a thin asset.
- Solana execution: a wallet with no Kamino obligation never gets a proposal (`positions.ts:61-67`). The dividend multiplier is ignored. Expiry is guessed from a timer (`sign.ts:33`). Self-composed transactions pay about 100 times a Jupiter swap's priority fee (`compose.ts:64`).
- Engine: a policy built from a plan with the abstract BRL leg stays triggered and its first order cannot execute (`policy/rebalance.ts:35-56`). Balance goals get no verdict: `targetMet` is computed and dropped (`plans.ts:194-200`), and is wrong past the target month. Missing yields count as zero and observations have no age limit.
- Parser and data: the first `R$` wins and any monthly phrase makes an income goal, so "Tenho R$50 mil e quero R$3.000 por mês" gives R$50,000 a month. No indexes, unique or check constraints; no database transactions; money stored as display decimals.
- Web: no screen calls the transaction-building route, so buying exists only as a script. The monitor keeps the previous wallet's policy after a wallet switch. The revoke function is not wired to a button, though `docs/structurer/STATE.md:20` says it is. The default public RPC returns 403 to browser requests (re-checked).
- Risk layer: a regime with two samples sets exit capacity to zero and removes stocks from a plan (`provider.ts:29`). At $1k to $50k the pool curves overstate cost, because 74 to 100% of that day's Jupiter flow went through a venue the layer does not decode. No table has a chain column.
- Repo: no licence. `scripts/` and `tests/` are never typechecked. The README's run block omits `db:seed` and `feeds:refresh`, and the root `.env` is not read by the API. klend-sdk pins `@solana/kit` six majors back and brings three of the five high advisories.

### Changed on verification

Nothing was refuted. Seven findings went from high to medium: the CI failure and the Postgres-dependent test (tooling only), the price-manipulation path, the Kamino-obligation and BRL-leg blocks (both fail closed), the missing verdict and the amount misparse (the sheet is shown first). The licence, the stale-wallet monitor and the RPC default are rated medium here by the same yardstick, though their reviewers said high.

## Top fixes

| # | Fix | Where | Size |
|---|---|---|---|
| 1 | Revoke the two live approvals; keep the agent key off any public host | demo wallet (Rodrigo) | one transaction |
| 2 | Delete `with: { version: 11 }` | `ci.yml` | one line |
| 3 | Remove the HTTP rebalance trigger; add auth and a CORS allowlist | `apps/api` | the keeper replaces it |
| 4 | Read holdings with each mint's own token program | `positions.ts`, `delegate.ts` | small |
| 5 | Key executions by plan and leg, skip confirmed legs, declare `skipped` and `errors`, guard status changes, confirm from chain | `transactions.ts`, `executions.ts`, `api.ts` | medium |
| 6 | Read the issuer rate for yields; require a gap before one leg displaces another | `feeds/yields.ts`, solver | medium |
| 7 | Negation, amount binding and month names in the rules parser, with eval cases | `parser/rules.ts` | small |
| 8 | Return the verdict and the gap, correct past the target month | `schedule/index.ts`, `plans.ts` | small |
| 9 | Cap the assess input; import incrementally and flag stale curves; treat thin regimes as unmeasured | `risk.ts`, `import.ts`, `provider.ts` | small each |
| 10 | Export a dated risk dataset, or host the collector | Rodrigo's machine | a decision |
| 11 | Lint errors, root typecheck, Postgres in CI, a licence | repo root | small |

## Not verified

- Anything on Linux, and any deployed instance.
- The API against a real database: handler probes used an in-memory stand-in or an embedded Postgres.
- Whether other wallets have approved the agent key (the public RPC refused the query).
- The price-manipulation attack and the double-buy on chain; both need a send.
- Liquidity and RPC limits on Base and Robinhood Chain.
- Upstream commits after the review: `risk-layer` is now at `9cb2294` and a `design` branch exists at `3309b1f`.
