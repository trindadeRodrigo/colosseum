# Colosseum — goal-based structuring for self-custody wallets

Goals in reais, allocations across on-chain legs (USD yield, a BRL leg, cash, and tokenized stocks for higher-risk goals), a month-by-month BRL cash-flow schedule with stresses, a per-leg risk sheet with provenance, real mainnet execution into the user's own wallet, and a policy that rebalances inside limits the user set. **Policy in your wallet, not a fund.**

Built for the Colosseum Crypto World's Fair (Solana track, Superteam Brasil track), Oct 1–12, 2026. Spec: `docs/HANDOFF-IDEA1.md`. Plan: `docs/PLAN.md`. Status: `docs/STATE.md`. Decisions: `docs/GATES.md`.

Next (Oct 1): hold each plan in a vault that enforces its limits on chain, let people start from portfolios others have shared, and add Robinhood Chain and Base. See `docs/HANDOFF-VAULT.md`.

## Run

```
cp .env.example .env                      # fill keys
docker run -d --name colosseum-pg -p 5433:5432 -e POSTGRES_PASSWORD=colosseum -e POSTGRES_USER=colosseum -e POSTGRES_DB=colosseum postgres:16
pnpm install
pnpm db:migrate
pnpm db:seed                              # the asset registry rows
pnpm feeds:refresh                        # yield and FX observations; POST /plans needs them
pnpm dev                                  # api :3001 (/docs), web :3000
pnpm test && pnpm typecheck && pnpm lint
pnpm verify:all                           # reproduces docs/VERIFICATION.md
pnpm plan:demo                            # three demo goals, no execution
pnpm execute:demo                         # mainnet, asks for confirmation
```

## Layout

`apps/api` Fastify + zod → OpenAPI · `apps/web` Next.js · `packages/schemas` shared zod types and the disclaimer · `packages/db` Drizzle schema and migrations · `packages/engine` parser, registry, solver, schedule, risk, policy · `packages/chain-solana` executors and the abstract BRL leg · `packages/chain-evm` calldata stub · `packages/risk` pool decoders, exit-cost curves and the liquidity provider · `apps/risk-api` the `/risk/*` routes on their own · `scripts/verify` reproducible checks.

## Disclaimer

This tool is not licensed investment advice. It structures and explains an allocation from a goal you state; the decision and custody are yours. The distributor embedding this tool holds the client relationship.

Esta ferramenta não presta consultoria de investimentos nem é licenciada para tal.

## Licence

Apache-2.0. See `LICENSE`.
