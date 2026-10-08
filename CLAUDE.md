# CLAUDE.md: the rules of this repository

Two people work here, each with Claude. This file and `.claude/` are the same for both, so the work looks the same whoever does it. How a session runs the work is in `.claude/rules/orchestration.md`, which loads with this file.

Start Claude Code inside this checkout, in the folder that holds this file. The settings, hooks and commands load only from the folder a session starts in, never from a parent folder.

## What this is

Tenonfi turns a person's goal into a plan made to measure, with an exit plan before it invests, held in the person's own vault on one chain. Three pieces of work live here: the structurer (the engine), the liquidity and risk layer ("Bearing"), and the vault work, which is the live one. `docs/README.md` says which document is which.

Before any work, read the spec for the piece you touch:

- Vault work: `docs/vault/HANDOFF-VAULT.md` (the product), `docs/vault/DESIGN-VAULT.md` (the design) and `docs/vault/PLAN-VAULT.md` (the days, the milestones and the cut order).
- Any screen: `.design/branding/working-brand/patterns/STYLE.md` and the component specs beside it. They are binding.
- The structurer and the risk layer: `docs/structurer/HANDOFF-IDEA1.md`, `docs/risk/HANDOFF-RISK.md`.

## Rules that apply to every line

- Every yield, price or FX figure in code, DB or UI carries `source`, `fetched_at` and `method`. No hard-coded APYs anywhere. A test fails the build if a numeric yield literal appears outside `fixtures/`.
- Anything mocked or stubbed is marked as sample in the UI and labelled in the API response (`"provenance": "mock"`): a hatched card edge with one quiet line ("Sample figures"), and a hatched pin or glyph on a figure, named for screen readers; never the boxed word MOCK beside each figure (gate `MOCK-QUIET`). A figure from a test network or a local copy of mainnet is `"provenance": "sandbox"` and gets the same mark, with the words "test network". Never display either as live. On the buy screen (gate `BUY-STEPS`) the card's one line reads "Test network · <chain> · not live" on a test network, whose figures are real reads, and the card's hatch band with "Sample figures" at its foot on the mock (MOCK-QUIET).
- Existing solver routes remain deterministic (`GUIDED-INTAKE`). Thom reopened the private vault conversation design on Oct 7: the model may propose assets and reasons from supplied catalog/risk data, never weights; code validates the proposal and its evidence, and sets the weights (`ANY-COMPOSITION`). A conversational preview is not an executable order or an applied vault strategy (`MODEL-LED-VAULT-CONVERSATION` in `docs/GATES.md`). Financial figures still come from sourced server data.
- A person's own vault may hold any composition of listed assets the person chooses (gate `ANY-COMPOSITION`, Thom, Oct 8). The model picks assets; the weights come from one deterministic function after it, an equal split unless the person stated shares in their own words, which it follows. What stays a limit: listed on the vault's chain, each once, at most 16 besides cash, evidence for each line, and the person's own stated limits. Shared portfolios keep their author limits, and engine-made plans keep the solver's caps.
- Stock tokens are ineligible for income plans and for plans whose goal is to protect (gate `PROTECT-NO-STOCKS`). Enforce in the asset registry, not in the prompt. Test it. The one exception is the person's own vault when the person asked for that stock in their own words, as the server reads them; it then passes with a warning, and neither the engine nor the model adds one on its own (`ANY-COMPOSITION`).
- A plan lives on one chain, the chain of the person's wallet: the deposit, the vault and every trade are there, and nothing is split across chains (gate `ONE-CHAIN`).
- What an asset may weigh comes from Bearing's measured exit numbers: the cap on chain, the ceiling in a plan, the exit cost shown. A tier stands in only where nothing is measured, and is labelled as a fallback (gate `EXIT-SOURCE`). In the person's own vault the measured exit capacity is a warning that cites its figure, not a cap (`ANY-COMPOSITION`).
- The "BRL leg" is an abstract asset with a parameterised cap and mint path. No BRS-specific code until `docs/GATES.md` marks G-Nora as PASSED.
- Every mainnet transaction is logged with its explorer link in the `executions` table and shown in the UI.
- Do not present the product as licensed advice. The disclaimer text lives in one constant and appears on the plan view and in API docs.
- Build the product, not demo code: real API, real schema, real migrations.
- Product words follow the brand: goal, limits, plan, portfolio, exit plan, rebalance, Bearing. No return promises. Competitors are not named in anything a user reads. The package scope `@colosseum` and the code names `basket` and `index` are working names until the one rename (FRAME-4).

## The contract: what "done" means

A piece of work is done when all of this is true, and not before:

1. It does what its row in the ledger says, shown by a test or a recorded check, not by a claim.
2. `pnpm verify` passes locally, and the same checks pass on GitHub for the pull request. The one exception is gate `AUDIT-BRACES` in `docs/GATES.md`: the audit check may be red while that advisory is its only finding.
3. No test was weakened or skipped to get there.
4. Its row in `docs/vault/STATE-VAULT.md` has the evidence: the command, the result, a link.
5. If it changed anything a document says, the document says the new thing, in the same pull request.
6. Someone other than the author has reviewed it: the other person, or `/review-pr`.

## How work moves

- **Start of a session:** a hook prints whether this checkout is behind. If it is, pull before anything else.
- **Branches:** work happens on a branch cut from `staging`, named `<area>/<short-name>` (`vault/keeper-leg`, `web/goal-screen`, `chore/...`). Start one with `/start-work`.
- **Pull requests:** every branch opens a pull request into `staging` (`/open-pr`). When a batch on `staging` is verified, one pull request goes from `staging` into `main`. Nobody pushes to `main` or `staging` directly. A hook stops Claude doing it by mistake; branch protection on GitHub is what enforces it (ORG-5 in the ledger).
- **Verification:** `pnpm verify` is the one command. It runs lint, both typechecks, the tests and the build, and CI runs the same command. `pnpm verify:quick` (lint and typechecks) runs before every commit Claude makes, by a hook; a commit that changes only documents skips it. The tests need the database: `pnpm db:up`.
- **The other two test commands:** `pnpm verify` does not build the Solana programs or the EVM contracts. `pnpm test:program` builds the programs and runs their tests in LiteSVM; it needs Anchor and the Solana CLI (`programs/README.md`). `pnpm test:contracts` runs `forge test` in `contracts/`; it needs Foundry. Run the one for the folder you changed before you commit. CI runs them only when their files change: `program.yml` on `programs/`, `idl/`, `Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `packages/chain-solana/`, `packages/chain-mock/`, `tests/solana-vault/`, `tests/keeper/`, `apps/api/`, `apps/keeper/`, `packages/db/`, `packages/schemas/`, `packages/basket/`, `packages/engine/` or `packages/risk/` (it also runs the Solana adapter's contract and the keeper's round in LiteSVM and, in its `validator` job, the money path and the keeper on a local validator), and `contracts.yml` on `contracts/`. `security.yml` runs on every pull request and weekly: gitleaks on the commits, `pnpm audit --prod` (fails on a high or critical advisory that is not in `docs/vault/SECURITY-DEPS.md`) and cargo-deny (`deny.toml`).
- **Commits:** small, with a prefix that names the area or the slot: `vault:`, `api:`, `web:`, `docs:`, `chore:`, or a slot id such as `SOL-2:`. Prior-work reuse goes in commits prefixed `prior:` and is listed in `docs/PRIOR-WORK.md`.
- **Ledger:** `docs/vault/STATE-VAULT.md` is the one list of tasks, with owner, status, evidence and blockers. Update it in the pull request that does the work.
- **Plugins and personal skills:** where a plugin's workflow disagrees with this file, this file wins. Plans, specs and notes go under `docs/`, never in a plugin's default folder.

## Decisions change documents

A decision that changes something a document says is not finished until the document says it. Use `/decide`: it records the decision in `docs/GATES.md` with its date and who made it, and updates every document the decision touches, in the same commit. Both people's sessions read these files, so this is how they stay in step. If you find two documents that disagree, stop and fix it before building on either.

## Money, keys and things only a person does

- Mainnet: demo wallet only, smallest sensible amount, print the signature and the explorer link. A transaction that reverted is never sent again.
- Scripts under `scripts/mainnet/` send real transactions. So do the two rigs under `spikes/` when run with `CLUSTER=mainnet` or `--broadcast`, and `pnpm wallet:export` prints a private key. A person runs these, never an agent; `/mainnet` prepares them. `scripts/archive/` is a record and is never run. Hooks block the usual ways of running them: they stop mistakes, they are not a sandbox.
- Never read `.env` or anything under `secrets/`. Never put a key, a token or a private RPC URL in a file, a brief, a log or a pull request.
- Test networks are the one exception to "a person runs it": an agent may hold and use a test-network key that carries only faucet funds, kept outside the repo. A mainnet key, never. A deploy to a test network still needs a person's word.
- The collectors and their launchd jobs (`scripts/launchd/`, `scripts/risk/collector/`, `scripts/depth-snapshot.mjs`) are not edited before Oct 12.
- Deploying, changing live data, messaging anyone outside the team, and merging into `main` need a person's word.

## Layout

- `apps/api` Fastify + zod → OpenAPI (`/docs`). `apps/risk-api` the `/risk/*` routes on their own. `apps/web` Next.js.
- `apps/snapshot` the worker that reads every vault we know every ten minutes and keeps what it read (`vault_snapshots`, gate `SNAPSHOT-WORKER`). It holds no key and reads the test networks only until a person says otherwise.
- `packages/schemas` zod types shared everywhere, plus the `DISCLAIMER` constant. It imports nothing.
- `packages/engine` parser, asset registry, solver, schedule, risk sheet, policy. `packages/risk` pool decoders, exit-cost curves, the liquidity provider; it never imports `engine`.
- Who may import whom is the layout table in `docs/vault/DESIGN-VAULT.md` section 2, and `tests/boundaries.test.ts` fails on anything else. A new folder under `packages/` or `apps/` needs a row in both.
- `packages/basket` the chain-free logic of a plan in a vault: author limits, flatten, view and drift, the rebalance planner, the roll-up, the meta hash, the weights of a person's picks. It imports only `schemas`. `packages/chain-mock` a chain in memory behind `ChainAdapter`, stamped `mock`, with the contract tests every adapter runs.
- `packages/sdk` the guard, which reads a transaction's bytes and refuses anything that is not the step the person approved, and the order executor the web and outside agents share. It imports `schemas` for types only and has no dependency; its tables are generated from `idl/` (`pnpm --filter @colosseum/sdk tables`).
- `packages/db` Drizzle schema and migrations (Postgres). `packages/chain-solana` Jupiter, Kamino, compose, sign, log, and the vault reader under `/vault`. `packages/chain-evm` the EVM adapter under `/vault`: the reader (ADE-1), the builders, the quotes and the probe (ADE-2), one codebase with a config per chain.
- `programs/` the Solana programs, with their interface files in `idl/`. `contracts/` the EVM contracts.
- `scripts/verify` reproducible checks behind `docs/structurer/VERIFICATION.md`. `scripts/mainnet` the live sender. `scripts/archive` the Sep 30 one-offs. `scripts/risk-evm` the hourly collector of selling cost on Robinhood Chain. `scripts/try` the plan playground (`pnpm plan:try <file>`): goals in a Markdown file, run through the intake and the engine into a local HTML report; how to use it is in `try/README.md`.
- `.design/` the design system. `docs/` the specs, the decisions and the ledger. `spikes/` the two vault test rigs, until the program and the contracts replace them.
