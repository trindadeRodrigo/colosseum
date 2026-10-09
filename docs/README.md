# Documents

Every document under `docs/`, once, with what it is and where it stands:

- **current**: describes the product or the process as it is, and is kept up to date;
- **decision record**: a dated record of what was decided or measured, kept as written;
- **historical**: a plan, prompt or spec that did its job and has been overtaken. Read it for how the work got here, not for what the product does.

The product today, which the older documents do not all reflect: English only (gate `ENGLISH-ONLY`); a goal is said in a chat, not filled into a form (`RELAXED-INTAKE`); the deposit opens in place on `/goal` (`DEPOSIT-STEP`, `DEPOSIT-DERIVE`); the chain is chosen where a plan starts (`CHAIN-AT-THE-PLAN`); a person's own vault may hold any composition of listed assets, with measured exit capacity as a warning and not a cap (`ANY-COMPOSITION`); everything runs on test networks (`SHOW`, `SPEND`). Where a document disagrees with [`GATES.md`](GATES.md), the gate is right.

## Reading order for someone new

1. The root [`README.md`](../README.md): what works today and how to run it.
2. [`vault/HANDOFF-VAULT.md`](vault/HANDOFF-VAULT.md): the product, in two pages.
3. [`vault/DESIGN-VAULT.md`](vault/DESIGN-VAULT.md), sections 2, 5, 6 and 13: the layout, what the vault checks on each chain, the limits on authors of shared portfolios, and the security model.
4. [`GATES.md`](GATES.md) for why a thing is the way it is, and [`vault/STATE-VAULT.md`](vault/STATE-VAULT.md) for the evidence behind a task.

## Shared

| Document | What it is | Status |
|---|---|---|
| [`GATES.md`](GATES.md) | Every decision, with its date and who made it | Decision record, current |
| [`PRIOR-WORK.md`](PRIOR-WORK.md) | What existed before the hackathon window and what is reused | Current. Three rows of its reuse table still say "pending" |
| [`DATA-MODEL.md`](DATA-MODEL.md) | The database tables of the structurer and the first risk tables | Historical in part: see the note at its top |

## `vault/`: plans held in a vault (the live work)

| Document | What it is | Status |
|---|---|---|
| [`HANDOFF-VAULT.md`](vault/HANDOFF-VAULT.md) | The product: what a person does, shared portfolios, the vault, the chains, the MVP | Current, with a note at its top on what changed since Oct 1 |
| [`DESIGN-VAULT.md`](vault/DESIGN-VAULT.md) | The technical design: layout and import rules, shared types, vault rules per chain, the registry, the engine, wallets, the web app, the agent surface, security | Current and amended gate by gate. Some passages of section 11 predate later gates and stand beside the newer ones: the screens "in both languages" (`ENGLISH-ONLY`), and the earlier goal sheet and separate screens for a plan and its deposit (`RELAXED-INTAKE`, `DEPOSIT-STEP`) |
| [`STATE-VAULT.md`](vault/STATE-VAULT.md) | The task ledger: owner, status, evidence and blockers per task | Current. Many build rows say `in-review` after their pull request merged |
| [`PLAN-VAULT.md`](vault/PLAN-VAULT.md) | The days, the milestones and the cut order of the MVP, written Oct 1 | Historical for the dates; the cut order still holds |
| [`RUN-DEVNET-LOCAL.md`](vault/RUN-DEVNET-LOCAL.md) | How to run one checkout against Solana devnet with a passkey wallet | Current for the launcher. Its browser steps predate `CHAIN-AT-THE-PLAN` and `DEPOSIT-STEP`: the chain is now chosen on `/goal`, and the deposit opens there |
| [`SECURITY-DEPS.md`](vault/SECURITY-DEPS.md) | The dependency advisories accepted for now, each with its reason | Current |
| [`AUDIT-VAULT.md`](vault/AUDIT-VAULT.md) | A review of the code as it was on Oct 1, before the vault work | Decision record |
| [`CONVERGENCE-VAULT.md`](vault/CONVERGENCE-VAULT.md) | What happens to each package of the structurer under the vault work, as decided on Oct 1 | Decision record |
| [`HANDOFF-ENG3.md`](vault/HANDOFF-ENG3.md) | Where the solver build stopped on Oct 5, for the session that continued it | Historical |
| [`PROMPT-BUILD-SOLVER.md`](vault/PROMPT-BUILD-SOLVER.md) | The prompt that drove the plan engine (ENG-3) | Historical: see the note at its top |
| [`PROMPT-RELAXED-INTAKE.md`](vault/PROMPT-RELAXED-INTAKE.md) | The prompt for the goal conversation, written as an experiment | Historical: see the note at its top |
| [`PROMPT-BUILD-PORTFOLIO.md`](vault/PROMPT-BUILD-PORTFOLIO.md) | The prompt that drove the portfolio section and the snapshot worker | Historical. It asks for both languages; the app is English only |
| [`PROMPT-THEMES-LABELS.md`](vault/PROMPT-THEMES-LABELS.md), [`PROMPT-THEMES-LABELS-2.md`](vault/PROMPT-THEMES-LABELS-2.md) | The prompts for the stock labels and the matched theme, and their restart | Historical |
| [`PROMPT-TUNE-PLAN-CHAT.md`](vault/PROMPT-TUNE-PLAN-CHAT.md) | The prompt for tuning the plan chat on the playground | Historical |
| [`PROMPT-WEB-IDENTITY-2.md`](vault/PROMPT-WEB-IDENTITY-2.md) | The prompt for moving the web app to the current visual identity | Historical |
| [`PROMPT-YIELD-SHELF.md`](vault/PROMPT-YIELD-SHELF.md) | The prompt for the extended shelf of dollar fixed-income tokens | Historical; the launch shelf did not change |

### `vault/research/`

Written Oct 1 to 6 as the evidence behind the handoff and the design, and kept as written. The Oct 1 notes say "basket" and "community index" where the product says plan and shared portfolio.

| Document | What it is | Status |
|---|---|---|
| [`README.md`](vault/research/README.md) | The folder's own index and how to read the notes | Current |
| [`vaults/decision-memo.md`](vault/research/vaults/decision-memo.md) | Why one vault per plan, our own small contract, and auto-follow with a delay | Decision record |
| [`solana-liquidity.md`](vault/research/solana-liquidity.md) | What Solana's stock, gold and yield tokens cost to trade, measured Oct 1 | Decision record |
| [`test-networks.md`](vault/research/test-networks.md) | What exists on each test network and what we bring, checked Oct 2 | Decision record |
| [`portfolio-method.md`](vault/research/portfolio-method.md) | The research behind the plan engine and what it changed, Oct 3 | Decision record |
| [`PROMPT-RESEARCH-METHOD.md`](vault/research/PROMPT-RESEARCH-METHOD.md) | The prompt that produced the note above | Historical |
| [`design-v2/agent-surface.md`](vault/research/design-v2/agent-surface.md) | Research note for the design: the API, SDK and MCP server | Historical |
| [`design-v2/backend-data-keeper.md`](vault/research/design-v2/backend-data-keeper.md) | Research note: backend, data and the keeper. Its scripts and build file are in `design-v2/backend-evidence/` | Historical |
| [`design-v2/evm-contracts.md`](vault/research/design-v2/evm-contracts.md) | Research note: the EVM vault contracts | Historical |
| [`design-v2/modularity-roadmap.md`](vault/research/design-v2/modularity-roadmap.md) | Research note: module seams and what comes after the MVP | Historical |
| [`design-v2/personalization-ai.md`](vault/research/design-v2/personalization-ai.md) | Research note: from a sentence to a personal plan. Its prototype is in `design-v2/personalization-proto/`. It assumes a sentence or a form; the product is a chat | Historical |
| [`design-v2/security-quality.md`](vault/research/design-v2/security-quality.md) | Research note: security and quality | Historical |
| [`design-v2/solana-program.md`](vault/research/design-v2/solana-program.md) | Research note: the Solana vault program | Historical |
| [`design-v2/wallets-signing.md`](vault/research/design-v2/wallets-signing.md) | Research note: wallets and signing | Historical |
| [`design-v2/web-app.md`](vault/research/design-v2/web-app.md) | Research note: the web app | Historical |
| [`design-v2/review-log.md`](vault/research/design-v2/review-log.md) | What three reviews changed in the design, and what was not taken | Decision record |
| [`open-questions/agent-native.md`](vault/research/open-questions/agent-native.md) | How outside agents use the app | Historical |
| [`open-questions/creator-limits.md`](vault/research/open-questions/creator-limits.md) | Limits on authors of shared portfolios. The four rules decided on Oct 2 are simpler (gate `AUTHOR-LIMITS`) | Historical |
| [`open-questions/launch-shelf.md`](vault/research/open-questions/launch-shelf.md) | A draft of the launch portfolios and the asset list, with `launch-shelf.seed.json` beside it | Historical: a proposal, never approved as written |
| [`open-questions/wallet-providers.md`](vault/research/open-questions/wallet-providers.md) | The choice of sign-in provider | Decision record |
| [`yield-shelf/solana.md`](vault/research/yield-shelf/solana.md) | Screening of dollar fixed-income tokens on Solana, Oct 6 | Decision record |
| [`yield-shelf/robinhood.md`](vault/research/yield-shelf/robinhood.md) | The same screening on Robinhood Chain | Decision record |
| [`yield-shelf/comparison.md`](vault/research/yield-shelf/comparison.md) | What the extended shelf changes in the plans the engine makes, a run of Oct 6 | Decision record |
| [`yield-shelf/TEMPLATE.md`](vault/research/yield-shelf/TEMPLATE.md) | The format of a yield-shelf note | Current |

`yield-shelf/inputs/` holds the two asset lists the screenings started from, as spreadsheets and CSV.

## `risk/`: Bearing, the liquidity and risk layer

Built and merged; the collectors still run.

| Document | What it is | Status |
|---|---|---|
| [`HANDOFF-RISK.md`](risk/HANDOFF-RISK.md) | The spec of the layer, written Sep 30, that the build plan was made from | Historical |
| [`PLAN-RISK.md`](risk/PLAN-RISK.md) | The build plan, with the methods and decisions D1 onward | Decision record |
| [`STATE-RISK.md`](risk/STATE-RISK.md) | Progress and evidence per step of that plan | Decision record |
| [`PLAN-ANALYTICS.md`](risk/PLAN-ANALYTICS.md) | The facts the agent and the analytics pages read. Its section 5 is the methodology the API serves word for word (`tests/risk-layer/facts-methodology.test.ts`) | Current |
| [`PLAN-UNIVERSE.md`](risk/PLAN-UNIVERSE.md) | The tracked stocks, every pool they trade in and the oracle a rebalance needs. Its section 6 says what is merged | Current |
| [`PROMPT-PLAN-RISK.md`](risk/PROMPT-PLAN-RISK.md), [`PROMPT-BUILD-RISK.md`](risk/PROMPT-BUILD-RISK.md) | The prompts that produced the plan and drove the build | Historical |
| [`PROMPT-BUILD-ANALYTICS.md`](risk/PROMPT-BUILD-ANALYTICS.md), [`PROMPT-BUILD-ANALYTICS-PAGE.md`](risk/PROMPT-BUILD-ANALYTICS-PAGE.md) | The prompts for the analytics and for its page prototype | Historical |
| [`PROMPT-BUILD-UNIVERSE.md`](risk/PROMPT-BUILD-UNIVERSE.md) | The prompt for the tracked universe | Historical |

## `structurer/`: the first engine, built Sep 30

The engine the vault work builds on. Its documents describe the first product: goals in reais, typed in Portuguese or English, run from the person's wallet under a token approval. The vault work replaced that shape.

| Document | What it is | Status |
|---|---|---|
| [`HANDOFF-IDEA1.md`](structurer/HANDOFF-IDEA1.md) | The first spec | Historical: see the note at its top |
| [`PLAN.md`](structurer/PLAN.md) | The first 12-day plan | Historical: see the note at its top |
| [`VIDEO.md`](structurer/VIDEO.md) | A draft script for the first product's video | Historical: see the note at its top |
| [`STATE.md`](structurer/STATE.md) | Slot status of that plan, with the signatures of the Sep 30 mainnet transactions | Decision record |
| [`VERIFICATION.md`](structurer/VERIFICATION.md) | The checks of Sep 30, reproduced by `pnpm verify:all` | Decision record |
| [`ACCEPTANCE.md`](structurer/ACCEPTANCE.md) | The acceptance run of Sep 30 | Decision record |
| [`PROMPT-PLAN.md`](structurer/PROMPT-PLAN.md), [`PROMPT-BUILD.md`](structurer/PROMPT-BUILD.md) | The prompts that produced the plan and drove the build | Historical |

`schedule-check.csv` is the schedule export the acceptance run checked, and `screenshots/` holds three screens of the first app.

## Elsewhere

The design system is not here: it lives in `.design/branding/working-brand/patterns/`, and `STYLE.md` there is binding for every screen. The rules of the repository are in [`CLAUDE.md`](../CLAUDE.md). Folder notes sit beside the code: [`programs/README.md`](../programs/README.md), [`contracts/README.md`](../contracts/README.md), [`apps/mcp/README.md`](../apps/mcp/README.md), [`apps/keeper/README.md`](../apps/keeper/README.md), [`apps/snapshot/README.md`](../apps/snapshot/README.md), [`try/README.md`](../try/README.md).
