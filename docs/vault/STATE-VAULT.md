# STATE-VAULT.md: the task ledger

One list of tasks for the vault work and the repository around it. Status is `todo | in-progress | in-review | done | blocked`. Evidence points to a command and its result, a pull request, a CI run or a transaction. Update the row in the pull request that does the work. Times are UTC.

## Repository and process

| ID | What it delivers | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|
| ORG-1 | The vault documents, the audit and green checks on `main` | Thom | done | PR #2, merged 2026-10-01 19:32 as `9eb082d`. CI on `main` after the merge: lint, both typechecks, migration, 22 test files, build, all pass | |
| ORG-2 | The repository organised: documents in three folders with an index, third-party photos removed, one-off mainnet scripts archived, the live one isolated, dead code removed, the alias block declared once, a complete `.env.example` loaded from the repo root by every app | Thom | done | PR #3 into `staging`: `pnpm verify` green in CI. Reviewed on 2026-10-01 by three agents that did not write it (documents, code and config, Claude setup); what they confirmed is fixed in the same pull request | |
| ORG-3 | The shared Claude setup: `CLAUDE.md`, `.claude/rules/orchestration.md`, `.claude/settings.json` with four hooks, six commands, a pull-request template, `pnpm verify` | Thom | done | PR #3. `tests/claude-hooks.test.ts` runs 130 commands through the guard (63 blocked, 67 allowed) and the push forms from `main`. Checked live in a scratch project: `.env` and `.env.production` unreadable, `.env.example` readable. Not covered: a command written to get around the guard, and a session started outside the checkout, where nothing loads | |
| ORG-4 | The `staging` branch and the flow into `main` | Thom | done | `staging` created from `main` on 2026-10-01 | |
| ORG-5 | `main` and `staging` protected: no direct push, checks required | Rodrigo | todo | | Needs repository admin |
| ORG-6 | A decision on what early planning material stays in the public tree: the first handoff, plan and video script under `docs/structurer/`, and `discover/` and `strategy/naming.md` in the design folder | Rodrigo, Thom | todo | | |

## Before the build

| ID | What it delivers | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|
| PLAN-1 | `docs/vault/PLAN-VAULT.md`: the days, the milestones, who does what and the cut order; the slots are the rows under "The build" | Thom | in-review | The pull request that adds this row. Not verified by running: it is a plan | |
| OPS-1 | Fri Oct 2, in market hours: the three $10 mainnet tests of the vault rigs (`spikes/`), one per chain, and the Scope read. All three chains funded | Thom (a person) | todo | | Funded wallets |
| OPS-2 | Fri Oct 2: the two Privy apps, a second Jupiter organisation, the passkey origin test, the hosting and RPC accounts | Thom (a person) | todo | | |
| OPS-3 | The two live approvals on the demo wallet revoked (5 USDY, 5 syrupUSDC to the agent key), before anything is hosted | Rodrigo (a person) | todo | | |
| DES-1 | One specification of the provenance pin, and the final logo artwork | Rodrigo | todo | | |
| ENG-1 | The goal status for every goal kind, and the odds estimate | Rodrigo | todo | | |
| RISK-4 | The risk scripts read the root `.env`: `risk:retier`, `risk:routing-gap`, `risk:pareto` and `risk:discover` load none, and `risk:registry` reads the RPC URL before the file loads. `esbuild`, which the collector installer calls, becomes a declared dependency | Rodrigo | todo | | After Oct 12: the collectors are not touched before |
| DES-2 | The four photos in the landing prototype (`closing.avif`, `closing.jpg`, `photo-ridge.jpg`, `photo-trip.jpg`) replaced, or given a licence note beside them | Rodrigo | todo | | |

## The build

The days and milestones are in `PLAN-VAULT.md`. A slot is half a day of one stream. "Check" is what proves the row; section numbers are in `DESIGN-VAULT.md`. Owner "Thom" or "Rodrigo" means that person's sessions; either can take a row by writing their name in it first.

| ID | Day | What it delivers, and the check | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|---|
| MIGRATION | n/a | Who may generate a database migration right now. One holder at a time | FRAME-1 | n/a | | |
| FRAME-1 | Oct 2 | The first version of the shared types in `packages/schemas` (section 3), `packages/chain-mock` stamping `provenance: 'mock'`, migration `0006`, `parseFlags` and `GET /v1/config`. Check: the adapter contract tests pass on the mock | Thom | todo | | |
| FRAME-2 | Oct 3 | `tests/boundaries.test.ts` for the import rules (section 2), with a planted bad import; `program.yml` and `contracts.yml` in CI; the build tools pinned. Check: the planted import fails the test | Thom | todo | | FRAME-1 |
| FRAME-3 | Oct 4 | The interfaces frozen: the hash test on `packages/schemas` turns on | Thom | todo | | FRAME-1 |
| SOL-1 | Oct 2 | `programs/basket` on Anchor 0.31.1, from the rig: create a vault, deposit, withdraw the tokens to the owner; the LiteSVM suite under Vitest; `mock-router`. Check: I1 and A8 pass | Thom | todo | | |
| SOL-2 | Oct 3 | An owner swap through Jupiter from the vault, replayed on surfpool; the shared-portfolio registry; create and first buy at 7 and 12 assets. Check: A1, A2 and A4 pass | Thom | todo | | SOL-1 |
| SOL-3 | Oct 4 | The keeper leg and the remaining hostile cases; the IDL committed. Check: every A-case that applies passes, and each rule bites when its check is commented out | Thom | todo | | SOL-2 |
| EVM-1 | Oct 2 | `contracts/`, from the rig: the vault behind a beacon, with create, deposit and withdraw the tokens to the owner. Check: unit tests at 6, 8 and 18 decimals; I1 | Thom | todo | | |
| EVM-2 | Oct 3 | The factory and the registry with creator limits; the owner swap. Check: unit tests; A16 from the shared vectors | Thom | todo | | EVM-1 |
| EVM-3 | Oct 4 | The keeper swap and the remaining hostile cases; ABIs committed; deploy scripts with a dry run that prints the transactions. Check: every A-case passes, and each rule bites | Thom | todo | | EVM-2 |
| BAS-1 | Oct 3 | `packages/basket`: flatten, view and drift, planner, limit check, roll-up, meta hash. Check: unit and property tests; the limit check agrees with both registries on the shared vectors | Thom | todo | | FRAME-1 |
| ADS-1 | Oct 3 | The Solana adapter, read side: vaults, Scope prices, holdings for both token programs. Check: the contract tests on a fork | Thom | todo | | FRAME-1, SOL-1 |
| ADS-2 | Oct 4 | The Solana adapter, builders: create, deposit, swap, withdraw; `send.ts` and `track`. Check: each builds and simulates on a fork | Thom | todo | | ADS-1, SOL-3 |
| ADE-1 | Oct 3 | The EVM adapter, read side: one codebase, a config per chain. Check: the contract tests on forks of both chains | Thom | todo | | FRAME-1, EVM-1 |
| ADE-2 | Oct 4 | The EVM adapter, builders: quoters and router calldata. Check: each builds and simulates on both forks | Thom | todo | | ADE-1, EVM-3 |
| API-1 | Oct 3 | Sign-in and the `/v1` plan and order routes with legs and attempts, on the mock. Check: endpoint tests; wallet B cannot approve wallet A's order | Thom | todo | | FRAME-1 |
| API-2 | Oct 4 | Funding, `prepareIntent`, report matching, rate limits, the OpenAPI file committed; the server-signing routes behind `LEGACY_STRUCTURER`. Check: no registered route reaches a signer | Thom | todo | | API-1 |
| API-3 | Oct 6 | The shared-portfolio routes: the shelf, publish, follow, versions | Thom | todo | | API-2, BAS-1 |
| ENG-2 | Oct 2 | The personalization prototype ported into `engine/src/personal/` with starting numbers; Rodrigo tunes the sleeve table and the wording. Check: the three-profile test passes; his baseline test stays green | Thom, then Rodrigo | todo | | |
| WAL-1 | Oct 2 | Privy behind `WalletPort`, a test wallet, the "Sign in" choice of passkey or wallet. Check: a passkey wallet signs on three chains; `next build` passes | Thom | todo | | OPS-2 |
| AGT-1 | Oct 3 | The guard and the leg executor in `packages/sdk`. Check: the six guard negatives in `G-LINK` | Thom | todo | | FRAME-1 |
| AGT-2 | Oct 6 | The SDK types from the OpenAPI file; `apps/mcp` with seven tools on the real API | Thom | todo | | API-2 |
| AGT-3 | Oct 7 | The skill and `llms.txt`. Check: an outside agent builds a plan and a person approves it from the link | Thom | todo | | AGT-2 |
| BRAND-1 | Oct 2 to 3 | The design system in the app: tokens and fonts in `globals.css`, the primitives in `components/ui/`, route groups. Check: the primitives render in light and dark | Rodrigo | todo | | |
| WEB-1 | Oct 3 | The app shell on the design system, sign-in, and the goal screen on the mock | Thom | todo | | BRAND-1, WAL-1 |
| WEB-2 | Oct 4 | His three screens (home, plan, monitor) on the primitives and extended: the goal first, the vault panel | Thom, Rodrigo per screen | todo | | WEB-1 |
| WEB-3 | Oct 5 | Plan, buy and order status per leg with retry, on the real API | Thom | todo | | API-2, AGT-1 |
| WEB-4 | Oct 6 | The shelf, a shared portfolio's page, the publish form, follow, and the prompt when a followed portfolio changes | Thom | todo | | API-3 |
| WEB-5 | Oct 7 | The portfolio across chains with drift, the one-tap rebalance, the exit plan and risk sheet. Check: the nine MVP items work end to end; the seven binding rules hold; axe passes at 375 px in light and dark | Thom | todo | | WEB-4, RISK-2 |
| KEEP-1 | Oct 5 | `apps/keeper` against Solana: it plans from chain state and sends one leg. Check: an update to a shared portfolio rebalances an auto-follow vault | Thom | todo | | BAS-1, ADS-2, OPS-5 |
| KEEP-2 | Oct 6 | The keeper on Robinhood Chain, alerts, the run script for the keeper machine | Thom | todo | | KEEP-1, ADE-2 |
| REVM-1 | Oct 6 | The hourly EVM depth collector (`scripts/risk-evm/`). Check: curves for five tokens per EVM chain | Thom | todo | | RISK-1 |
| SEC-1 | Oct 5 | `docs/vault/SECURITY.md` with the hostile-case matrix, `INCIDENT.md`, `scripts/ops/authority-check.ts`, the rehearsal script | Thom | todo | | SOL-3, EVM-3 |
| SEC-2 | Oct 7 | Tier 2 of `G-SEC`: invariants, fuzz sequences, static analysis, the fork at a Saturday block. Check: results recorded, open items in `SECURITY.md` | Thom | todo | | SEC-1 |
| RISK-1 | Oct 2 | The three fixes before anything public reads Bearing (the request that freezes the API, the import that runs out of memory, the thin regime), the six lines in `compute.ts`, and a dated dump of the curves | Rodrigo | todo | | |
| RISK-2 | Oct 7 | About ten risk sheets, one per issuer family, in `content/risk-sheets/`. Check: the sheets render and hosted curves show their date | Rodrigo | todo | | |

## Mainnet sessions and other things a person does

| ID | Day | What happens | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|---|
| OPS-4 | Oct 4 | The origin decided (a domain or one fixed URL); the admin and guardian keys created; the deploy dry run read line by line | Thom | todo | | EVM-3, SOL-3 |
| OPS-5 | Oct 5 | Deploy on three chains: config, caps, hand-over to the admin key; the first hosted web and API; the cold-start test. Check: `authority-check` is green | Thom; Solana sessions to be agreed | todo | | OPS-4, SEC-1 |
| OPS-6 | Oct 6 | Rehearsal 1 on Solana and Robinhood Chain, $10 to $20, every transaction logged | A person | todo | | OPS-5, KEEP-1 |
| OPS-7 | Oct 7 | Rehearsal 2, and the market-open footage | A person | todo | | OPS-6 |
| OPS-8 | Oct 8 | `G-SEC` per chain at 12:00 BRT, then `launch()`, then `G-LINK`, the pause drill, and the link shared. A new version of the demo portfolio published | Thom and Rodrigo | todo | | OPS-7, SEC-2 |
| OPS-9 | Oct 9 | The freeze at 18:00 BRT: `main` tagged | Thom | todo | | |
| OPS-10 | Oct 12 | In market hours: the Oct 8 version takes effect and rebalances at production settings. Then the submission | Thom and Rodrigo | todo | | OPS-8 |
