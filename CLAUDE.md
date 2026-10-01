# CLAUDE.md: the rules of this repository

Two people work here, each with Claude. This file and `.claude/` are the same for both, so the work looks the same whoever does it. How a session runs the work is in `.claude/rules/orchestration.md`, which loads with this file.

## What this is

A product that turns a person's goal into a plan made to measure, with an exit plan before it invests, held in the person's own vault. Three pieces of work live here: the structurer (the engine), the liquidity and risk layer ("Bearing"), and the vault work, which is the live one. `docs/README.md` says which document is which.

Before any work, read the spec for the piece you touch:

- Vault work: `docs/vault/HANDOFF-VAULT.md` (the product) and `docs/vault/DESIGN-VAULT.md` (the design).
- Any screen: `.design/branding/working-brand/patterns/STYLE.md` and the component specs beside it. They are binding.
- The structurer and the risk layer: `docs/structurer/HANDOFF-IDEA1.md`, `docs/risk/HANDOFF-RISK.md`.

## Rules that apply to every line

- Every yield, price or FX figure in code, DB or UI carries `source`, `fetched_at` and `method`. No hard-coded APYs anywhere. A test fails the build if a numeric yield literal appears outside `fixtures/`.
- Anything mocked, sandboxed or stubbed is labelled `MOCK` in the UI and in the API response (`"provenance": "mock"`). Never display a mock as live.
- The solver is deterministic. The LLM only parses goals into a zod-validated `ConstraintSheet`. If validation fails, the user sees the error and edits the sheet; the solver never runs on unvalidated input.
- xStocks are ineligible for `income` profiles. Enforce in the asset registry, not in the prompt. Test it.
- The "BRL leg" is an abstract asset with a parameterised cap and mint path. No BRS-specific code until `docs/GATES.md` marks G-Nora as PASSED.
- Every mainnet transaction is logged with its explorer link in the `executions` table and shown in the UI.
- Do not present the product as licensed advice. The disclaimer text lives in one constant and appears on the plan view and in API docs.
- Build the product, not demo code: real API, real schema, real migrations.
- Product words follow the brand: goal, limits, plan, portfolio, exit plan, rebalance, Bearing. No return promises. Competitors are not named in anything a user reads.

## The contract: what "done" means

A piece of work is done when all of this is true, and not before:

1. It does what its row in the ledger says, shown by a test or a recorded check, not by a claim.
2. `pnpm verify` passes locally, and the same checks pass on GitHub for the pull request.
3. No test was weakened or skipped to get there.
4. Its row in `docs/vault/STATE-VAULT.md` has the evidence: the command, the result, a link.
5. If it changed anything a document says, the document says the new thing, in the same pull request.
6. Someone other than the author has reviewed it: the other person, or `/review`.

## How work moves

- **Start of a session:** a hook prints whether this checkout is behind. If it is, pull before anything else.
- **Branches:** work happens on a branch cut from `staging`, named `<area>/<short-name>` (`vault/keeper-leg`, `web/goal-screen`, `chore/...`). Start one with `/start-work`.
- **Pull requests:** every branch opens a pull request into `staging` (`/open-pr`). When a batch on `staging` is verified, one pull request goes from `staging` into `main`. Nobody pushes to `main` or `staging` directly; a hook blocks it.
- **Verification:** `pnpm verify` is the one command. It runs lint, both typechecks, the tests and the build, and CI runs the same command. `pnpm verify:quick` (lint and typechecks) runs before every commit, by a hook. The tests need the database: `pnpm db:up`.
- **Commits:** small, with a prefix that names the area or the slot: `vault:`, `api:`, `web:`, `docs:`, `chore:`, or a slot id such as `D3-PM:`. Prior-work reuse goes in commits prefixed `prior:` and is listed in `docs/PRIOR-WORK.md`.
- **Ledger:** `docs/vault/STATE-VAULT.md` is the one list of tasks, with owner, status, evidence and blockers. Update it in the pull request that does the work.

## Decisions change documents

A decision that changes something a document says is not finished until the document says it. Use `/decide`: it records the decision in `docs/GATES.md` with its date and who made it, and updates every document the decision touches, in the same commit. Both people's sessions read these files, so this is how they stay in step. If you find two documents that disagree, stop and fix it before building on either.

## Money, keys and things only a person does

- Mainnet: demo wallet only, smallest sensible amount, print the signature and the explorer link. A transaction that reverted is never sent again.
- Scripts under `scripts/mainnet/` can spend real money. A person runs them, never an agent. `scripts/archive/` is a record and is never run. Hooks block both.
- Never read `.env` or anything under `secrets/`. Never put a key, a token or a private RPC URL in a file, a brief, a log or a pull request.
- The collectors and their launchd jobs (`scripts/launchd/`, `scripts/risk/collector/`, `scripts/depth-snapshot.mjs`) are not edited before Oct 12.
- Deploying, changing live data, messaging anyone outside the team, and merging into `main` need a person's word.

## Layout

- `apps/api` Fastify + zod → OpenAPI (`/docs`). `apps/risk-api` the `/risk/*` routes on their own. `apps/web` Next.js.
- `packages/schemas` zod types shared everywhere, plus the `DISCLAIMER` constant. It imports nothing.
- `packages/engine` parser, asset registry, solver, schedule, risk sheet, policy. `packages/risk` pool decoders, exit-cost curves, the liquidity provider; it never imports `engine`.
- `packages/db` Drizzle schema and migrations (Postgres). `packages/chain-solana` Jupiter, Kamino, compose, sign, log. `packages/chain-evm` a stub until the EVM adapter.
- `scripts/verify` reproducible checks behind `docs/structurer/VERIFICATION.md`. `scripts/mainnet` anything that can send a transaction. `scripts/archive` the Sep 30 one-offs.
- `.design/` the design system. `docs/` the specs, the decisions and the ledger. `spikes/` the two vault test rigs, until the program and the contracts replace them.
