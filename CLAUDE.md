# CLAUDE.md — standing rules for this repository

Read `docs/HANDOFF-IDEA1.md` (spec) and `docs/PLAN.md` (schedule) before any slot. Where they conflict, stop and ask.

## Rules (apply to every line written)

- Every yield, price or FX figure in code, DB or UI carries `source`, `fetched_at` and `method`. No hard-coded APYs anywhere. A test fails the build if a numeric yield literal appears outside `fixtures/`.
- Anything mocked, sandboxed or stubbed is labelled `MOCK` in the UI and in the API response (`"provenance": "mock"`). Never display a mock as live.
- The solver is deterministic. The LLM only parses goals into a zod-validated `ConstraintSheet`. If validation fails, the user sees the error and edits the sheet; the solver never runs on unvalidated input.
- xStocks are ineligible for `income` profiles. Enforce in the asset registry, not in the prompt. Test it.
- The "BRL leg" is an abstract asset with a parameterised cap and mint path. No BRS-specific code until `docs/GATES.md` marks G-Nora as PASSED.
- Every mainnet transaction is logged with its explorer link in `executions` table and shown in the UI.
- Commits are small, dated, and describe the slot: `D3-PM: first mainnet Jupiter swap USDC→USDY`. Prior-work reuse goes in commits prefixed `prior:` and is listed in `docs/PRIOR-WORK.md`.
- Do not present the product as licensed advice. The disclaimer text lives in one constant and appears on the plan view and in API docs.
- Build the product, not demo code: real API, real schema, real migrations. UI can be plain.

## Working rules

- Slot work follows `docs/PLAN.md` §4. Stay inside the slot; log out-of-slot discoveries in `docs/STATE.md` under "discovered".
- Mainnet: demo wallet only, smallest sensible amount, print signature and explorer link, never auto-retry a failed mainnet transaction.
- Before finishing a slot: `pnpm typecheck && pnpm lint && pnpm test`, then run the slot's check and record evidence in `docs/STATE.md`.

## Layout

- `apps/api` Fastify + zod → OpenAPI (`/docs`). `apps/web` Next.js (chat, plan, monitor, embed).
- `packages/schemas` zod types shared everywhere, plus the `DISCLAIMER` constant.
- `packages/db` Drizzle schema and migrations (Postgres).
- `packages/engine` parser, asset registry, solver, schedule, risk sheet, policy.
- `packages/chain-solana` executors (Jupiter, Kamino, abstract BRL leg), compose, sign, log. `packages/chain-evm` calldata stub.
- `scripts/verify` reproducible checks behind `docs/VERIFICATION.md`. `scripts/depth-snapshot.mjs` the xStocks depth cron.

## Vault work

- Read `docs/HANDOFF-VAULT.md` (the product) and `docs/DESIGN-VAULT.md` (the design) before any vault work. Decisions are in section 17 of the design and in `docs/GATES.md`.
- For any screen, `.design/branding/working-brand/patterns/STYLE.md` and the component specs beside it are binding.
- New work adds files where it can. An edit to an existing file is fine when it makes the product better; say so in the pull request.
- Slot ids here are `<stream>-<n>`, and a commit prefix may name the area (`vault:`, `api:`, `web:`).
