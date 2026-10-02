# STATE-VAULT.md: the task ledger

One list of tasks for the vault work and the repository around it. Status is `todo | in-progress | in-review | done | blocked`. Evidence points to a command and its result, a pull request, a CI run or a transaction. Update the row in the pull request that does the work. Days are in BRT unless a row says otherwise.

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
| PLAN-1 | `docs/vault/PLAN-VAULT.md`: the days, the milestones, who does what and the cut order; the slots are the rows under "The build" | Thom | in-review | The pull request that adds this row, reviewed against the design by an agent that did not write it. Not verified by running: it is a plan | Thom and Rodrigo agreeing it |
| DES-1 | One specification of the provenance pin, and the final logo artwork. Wanted by Sat Oct 3, with WEB-1 | Rodrigo | todo | | |
| DES-2 | The four photos in the landing prototype (`closing.avif`, `closing.jpg`, `photo-ridge.jpg`, `photo-trip.jpg`) replaced, or given a licence note beside them. Before the link is shared on Oct 8 | Rodrigo | todo | | |
| ENG-1 | The goal status for every goal kind, and the odds estimate. Wanted by Wed Oct 7, with WEB-5; until then the goal card shows the verdict where one exists and no percentage | Rodrigo | todo | | |
| RISK-3 | The risk scripts read the root `.env`: `risk:retier`, `risk:routing-gap`, `risk:pareto` and `risk:discover` load none, and `risk:registry` reads the RPC URL before the file loads. `esbuild`, which the collector installer calls, becomes a declared dependency | Rodrigo | todo | | After Oct 12: the collectors are not touched before |

## The build

The days and milestones are in `PLAN-VAULT.md`. A slot is about half a day of one stream. "Check" is what proves the row; section numbers, the hostile cases (A1 to A18) and the invariants (I1 to I5) are in `DESIGN-VAULT.md`. Owner "Thom" or "Rodrigo" means that person's sessions; either can take a row by writing their name in it first.

| ID | Day | What it delivers, and the check | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|---|
| MIGRATION | n/a | Who may generate a database migration right now. One holder at a time | FRAME-1 | n/a | | |
| FRAME-1 | Oct 2 | The first version of the shared types in `packages/schemas` (section 3), `packages/chain-mock` stamping `provenance: 'mock'`, migration `0006` with the three database roles, `parseFlags` and `GET /v1/config`; each chain's config names its network (mainnet, test network or local) so a figure from a test network is labelled as one. Check: the adapter contract tests pass on the mock | Thom | todo | | |
| FRAME-2 | Oct 3 | `tests/boundaries.test.ts` for the import rules (section 2), with a planted bad import; `program.yml`, `contracts.yml` and `security.yml` in CI; the build tools pinned, `base-anvil` tried; `seed-assets.ts` moved to `scripts/`. Check: the planted import fails the test | Thom | todo | | FRAME-1 |
| FRAME-3 | Oct 4, evening | The interfaces frozen: the hash test on `packages/schemas` turns on, after each adapter has built and simulated a create, a deposit, a swap and a keeper leg | Thom | todo | | ADS-2, ADE-2 |
| FRAME-4 | When the name is final | The rename: package scope, server and skill names, the working code names in the design's Words table. After Oct 4 it also means a re-deploy of sign-in | Thom | todo | | The name (Rodrigo) |
| SOL-1 | Oct 2 | `programs/basket` on Anchor 0.31.1, from the rig: create a vault, deposit, withdraw the tokens to the owner; the LiteSVM suite under Vitest; `mock-router`; the router and the price source read from config, not fixed in code. Check: I1 | Thom | todo | | |
| SOL-2 | Oct 3 | An owner swap through Jupiter from the vault; the shared-portfolio registry with the four author limits. Check: a saved swap route replays on surfpool; create and first buy fit at 7 and 12 assets; A16 from the shared vectors | Thom | todo | | SOL-1, BAS-1 (the vectors) |
| SOL-3 | Oct 4, morning | The keeper leg, pause, accept and adopt; the IDL committed. Check: every A-case that applies passes (A1, A2, A4 and A8 among them), and each rule bites when its check is commented out | Thom | todo | | SOL-2 |
| EVM-1 | Oct 2 | `contracts/`, from the rig: the vault behind a beacon, with create, deposit and withdraw the tokens to the owner; the router and the price feeds read from config. Check: unit tests at 6, 8 and 18 decimals; I1 | Thom | todo | | |
| EVM-2 | Oct 3 | The factory and the registry with the four author limits; the owner swap; feed ages logged over the weekend. Check: unit tests; A16 from the shared vectors | Thom | todo | | EVM-1, BAS-1 (the vectors) |
| EVM-3 | Oct 4, morning | The keeper swap, pause, accept and adopt; ABIs committed; deploy scripts with a dry run that prints the transactions. Check: every A-case passes, and each rule bites | Thom | todo | | EVM-2 |
| BAS-1 | Oct 3 | `packages/basket`: the shared limit vectors first, then flatten, view and drift, planner, limit check, roll-up, meta hash. Check: unit and property tests; the limit check passes the vectors | Thom | todo | | FRAME-1 |
| ADS-1 | Oct 3 | The Solana adapter, read side: vaults, Scope prices, holdings for both token programs. Check: the contract tests on a fork | Thom | todo | | FRAME-1, SOL-1 |
| ADS-2 | Oct 4, afternoon | The Solana adapter, every builder in section 3.2: create, deposit, swap, withdraw, keeper leg, publish, accept, adopt, auto-follow, targets; `send.ts` and `track`. Check: each builds and simulates on a fork | Thom | todo | | ADS-1, SOL-3 |
| ADE-1 | Oct 3 | The EVM adapter, read side: one codebase, a config per chain. Check: the contract tests on a fork of Robinhood Chain. Base is added when it comes back (by `eth_call` with state overrides, since a plain fork cannot run its stock tokens) | Thom | todo | | FRAME-1, EVM-1 |
| ADE-2 | Oct 4, afternoon | The EVM adapter, every builder, with quoters and router calldata. Check: each builds and simulates on the Robinhood Chain fork | Thom | todo | | ADE-1, EVM-3 |
| API-1 | Oct 3 | Sign-in; the `/v1` plan and order routes with `prepareIntent`, legs and attempts; the portfolio read; all on the mock. Check: endpoint tests; wallet B cannot approve wallet A's order; the walking skeleton of M1 | Thom | todo | | FRAME-1 |
| API-2 | Oct 4 | Funding, report matching, rate limits, the OpenAPI file committed; the server-signing routes behind `LEGACY_STRUCTURER`; `sign.ts` and `wallet.ts` behind the `./server` entry. Check: no registered route reaches a signer; an unrelated transaction cannot confirm a leg | Thom | todo | | API-1 |
| API-3 | Oct 6 | The shared-portfolio routes: the shelf, publish, follow, versions | Thom | todo | | API-2, BAS-1, ADS-2, ADE-2 |
| ENG-2 | Oct 2 to 3 | The personalization prototype ported into `engine/src/personal/` with starting numbers, and the 12-goal evaluation set for the parser; Rodrigo tunes the sleeve table and the wording. Check: the three-profile test passes; his baseline test stays green | Thom, then Rodrigo | todo | | BAS-1 (`flatten`) for the last step |
| WAL-1 | Oct 2 | Privy behind `WalletPort`, a test wallet, the "Sign in" choice of passkey or wallet. Check: a passkey wallet signs on Solana devnet and on Robinhood Chain's test network; `next build` passes | Thom | todo | | OPS-2 (the Privy apps) |
| AGT-1 | Oct 3 | The guard and the leg executor in `packages/sdk`. Check: the six guard negatives in `G-LINK` | Thom | todo | | FRAME-1 |
| AGT-2 | Oct 6 | The SDK types from the OpenAPI file; `apps/mcp` with seven tools on the real API, hosted | Thom | todo | | API-2, OPS-6 |
| AGT-3 | Oct 7 | The skill and `llms.txt`. Check: an outside agent builds a plan and a person approves it from the link | Thom | todo | | AGT-2, WEB-3 |
| BRAND-1 | Oct 2 to 3 | The design system in the app: tokens and fonts in `globals.css`, the primitives in `components/ui/`, route groups. Check: the primitives render in light and dark | Rodrigo | todo | | |
| WEB-1 | Oct 3 | The app shell on the design system, sign-in, and the goal screen, on the mock API | Thom | todo | | BRAND-1, WAL-1, API-1 |
| WEB-2 | Oct 4 | His three screens (home, plan, monitor) on the primitives and extended: the goal first, the vault panel | Thom, Rodrigo per screen | todo | | WEB-1 |
| WEB-3 | Oct 5 | Plan, buy and order status per leg with retry, on the real API; the terms and the trust notice (`TRUST_STATUS`) before the first deposit | Thom | todo | | WEB-2, API-2, AGT-1, ADS-2, ADE-2 |
| WEB-4 | Oct 6 | The shelf, a shared portfolio's page, the publish form, follow, the prompt when a followed portfolio changes, and the public vault page | Thom | todo | | API-3 |
| WEB-5 | Oct 7 | The portfolio across chains with drift, the one-tap rebalance, the exit plan and risk sheet. Check: the nine MVP items work end to end; the seven binding rules hold; axe passes at 375 px in light and dark | Thom | todo | | WEB-4, RISK-2 |
| KEEP-1 | Oct 5; live check Oct 5 or 6 | `apps/keeper` against Solana: it plans from chain state and sends one leg. Check, in session: an update to a shared portfolio rebalances an auto-follow vault | Thom | todo | | BAS-1, ADS-2, OPS-6 |
| KEEP-2 | Oct 6, morning | The keeper on Robinhood Chain, alerts, the run script for the keeper machine. Check: two sessions of clean runs by Oct 7 | Thom | todo | | KEEP-1, ADE-2 |
| REVM-1 | Oct 2 to 3 | The hourly EVM depth collector (`scripts/risk-evm/`), running from Oct 2 so the weekend is sampled. Check: curves for five tokens on Robinhood Chain, 8 samples per regime | Thom | in-review | Branch `risk-evm/depth` on GitHub (`risk/evm-depth` locally; the remote already has a branch named `risk`). `pnpm risk-evm:collect --rediscover` on Oct 2 at block 78439254, read-only on mainnet: 21 rows, one per Robinhood Chain token in a launch recipe, in 24 s and 113 RPC calls (11 s and 111 calls once the pool list is cached). NVDA sells at 0.067% for $10k and 0.147% for $50k, the 0.05% pool fee included. `pnpm verify:quick` exits 0; `pnpm test --exclude apps/risk-api/src/app.test.ts` passes 23 files and 194 tests, 44 of them in `tests/risk-evm.test.ts`. One run proves the rows and the method (`scripts/risk-evm/README.md`). Still open: 8 samples per regime needs the loop running through Oct 5; `pnpm risk-evm:import` has not met a database (none on this machine); curves keep `evmq-0.1` only once RISK-1 lands | RISK-1 (the lines in `compute.ts`) |
| SEC-1 | Oct 4 | `scripts/ops/authority-check.ts` and `deployments/*.json` with the expected values, written before the deploy | Thom | todo | | SOL-3, EVM-3 |
| SEC-2 | Oct 5 | `docs/vault/SECURITY.md` with the hostile-case matrix, `INCIDENT.md`, the rehearsal script | Thom | todo | | SEC-1, API-2 |
| SEC-3 | Oct 7 | Tier 2 of `G-SEC`: invariants, fuzz sequences, static analysis, the fork at a Saturday block. Check: results recorded, open items in `SECURITY.md` | Thom | todo | | SEC-2 |
| RISK-1 | Oct 2 | The three fixes before anything public reads Bearing (the request that freezes the API, the import that runs out of memory, the thin regime), the six lines in `compute.ts`, and a dated dump of the curves | Rodrigo | todo | | |
| RISK-2 | Oct 7 | About ten risk sheets, one per issuer family, in `content/risk-sheets/`. Check: the sheets render and hosted curves show their date | Rodrigo | todo | | |
| OPS-4 | Oct 3 to 4 | `scripts/ops/*`, each with a dry run that prints its transactions: the Solana deploy, the test tokens, test exchange and test prices for the test networks, config, the asset entries, the caps, seeding and publishing the launch portfolios, pause on three chains, withdraw without the app; `docs/vault/RUNBOOK-OPS.md` with a checklist per session | Thom | todo | | SOL-3, EVM-3 for the last step |
| TNET-1 | Oct 3 | For the EVM test networks: a test stock token with the multiplier and pause calls the real ones have, test cash, a price contract with Chainlink's interface, a stub sequencer feed. Check: the vault's unit tests run against them unchanged | Thom | todo | | EVM-1 |
| TNET-2 | Oct 4 | Robinhood Chain's test network (46630): Universal Router 2.1.2 deployed, a Uniswap v4 pool per test token, a liquidity script. Check: a dry run prints the transactions | Thom | todo | | TNET-1, EVM-3 |
| TNET-3 | Oct 6, only if M3 is met | Base Sepolia (84532): the test stock tokens created through the real stock-token factory, a Uniswap v3 pool per token, the adapter's pool factory read from config. Check: a dry run prints the transactions | Thom | todo | | TNET-1, EVM-3 |
| TNET-4 | Oct 3 | Solana devnet: one test program holding the test exchange (`mock-router`, paying from its own reserve at the test price) and a price account with Scope's layout; test mints with the real token's extension set; test cash. Check: the LiteSVM suite passes against it | Thom | todo | | SOL-1 |
| TNET-5 | Oct 4 | The price updater: copies real prices and their timestamps from mainnet onto the three test networks, so a test price moves and goes stale as the real one does; every figure labelled as a test network's | Thom | todo | | TNET-1, TNET-4 |
| TNET-6 | Oct 4 | Swaps on devnet: a second quote-and-build path for the test exchange, since Jupiter's API serves mainnet only | Thom | todo | | TNET-4, ADS-1 |
| TNET-7 | Oct 5 | A small, rate-limited hand-out of test cash and gas for a new person | Thom | todo | | OPS-6 |

## Sessions, and other things a person does

No money goes onto mainnet for now (gates `SPEND` and `SHOW`): a deploy or a rehearsal below is on the test networks.

| ID | Day | What happens | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|---|
| OPS-1 | Oct 2 | The three vault tests of the rigs (`spikes/`) re-run on copies of mainnet, and the Scope read, with the results recorded. No money; an agent can run it | Thom | todo | | |
| OPS-2 | Oct 2 | First thing: the two Privy apps. Then the faucets (devnet SOL, 5 to 7 needed, two requests per 8 hours; Robinhood test network ETH), a second Jupiter organisation, the passkey origin test, the hosting and RPC accounts. Free tiers only | Thom | todo | | |
| OPS-3 | Now | The two live approvals on the demo wallet revoked (5 USDY, 5 syrupUSDC to the agent key), before anything is hosted | Rodrigo | todo | | |
| OPS-5 | Oct 4 | The origin decided (a domain or one fixed URL); the admin, guardian, keeper and platform-creator keys created; the deploy dry run read line by line | Thom | todo | | OPS-4 |
| OPS-6 | Oct 5, in session | Deploy on the test networks and verify the contracts: config, caps, hand-over to the admin key. The launch portfolios published: at least six, two on more than one chain. The first hosted web and API; the cold-start test. The owner path on Solana devnet, then on Robinhood Chain's test network. Check: `authority-check` is green | Thom; Solana sessions to be agreed | todo | | OPS-5, SEC-1 |
| OPS-7 | Oct 6, in session | A three-chain buy with a passkey wallet. Auto-follow cycles on Solana and Robinhood Chain. Rehearsal 1 on both, every transaction logged | A person | todo | | OPS-6, KEEP-1, KEEP-2 |
| OPS-8 | Oct 7, in session | Rehearsal 2, and the market-open footage | A person | todo | | OPS-7 |
| OPS-9 | Oct 8 | `G-SEC` per chain at 12:00 BRT, then `launch()`, then `G-LINK`, the pause drill, and the link shared. A new version of the demo portfolio published | Thom and Rodrigo | todo | | OPS-8, SEC-3 |
| OPS-10 | Oct 9 | The freeze at 18:00 BRT: `main` tagged | Thom | todo | | OPS-9 |
| OPS-11 | Oct 10 to 11 | The remaining screens recorded, both videos edited, the documents brought up to date, the submission form filled | Thom and Rodrigo | todo | | OPS-10 |
| OPS-12 | Oct 12, in session | The Oct 8 version, in effect since Saturday, rebalances at production settings. Then the submission | Thom and Rodrigo | todo | | OPS-9 |
