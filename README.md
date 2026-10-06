# tenonfi

Tell it what your money needs to do. It builds the portfolio that gets it there, plans the exit before it invests, and shows where every number comes from.

Built for the Colosseum Crypto World's Fair (Sep 14 to Oct 12, 2026) by Rodrigo Trindade and Thom Gabriel.

## What is here

| Piece | State |
|---|---|
| **The structurer.** A goal in plain language becomes an editable sheet of limits, then a deterministic plan with a reason for every leg, a month-by-month schedule with stress cases, and a risk sheet with sources | Built. Ran on Solana mainnet on Sep 30 |
| **Bearing, the liquidity and risk layer.** Measures what it costs to sell a tokenized asset, by size and by hour of the week, from the pools themselves | Built. Collectors running since Oct 1 |
| **The design system.** Tokens, type, components and the landing prototype | Specified in `.design/`; not yet applied to the app |
| **The vault work.** Each plan held in the person's own vault, which checks every trade the agent makes; portfolios people share for others to start from; Robinhood Chain and Base next to Solana | Designed, with two test rigs in `spikes/`. Not built yet |

The documents are indexed in [`docs/README.md`](docs/README.md). Start with `docs/vault/HANDOFF-VAULT.md`.

## Run

```
cp .env.example .env                      # one file at the repo root serves every app and script
pnpm install
pnpm db:up                                # Postgres 16 in Docker, then the migrations
pnpm db:seed                              # the asset registry rows
pnpm feeds:refresh                        # yield and FX observations; POST /plans needs them
pnpm feeds:refresh-models                 # yields of the tokens the test networks' stand-ins model (jlUSDC, SGOV); after db:seed
pnpm dev                                  # api :3001 (/docs), web :3000
pnpm verify                               # lint, typechecks, tests, build: what CI runs
pnpm verify:all                           # reproduces docs/structurer/VERIFICATION.md
pnpm plan:demo                            # three demo goals, no execution
```

Node 22 or later and pnpm 11.

## Layout

`apps/api` Fastify + zod → OpenAPI · `apps/risk-api` the `/risk/*` routes on their own · `apps/web` Next.js · `packages/schemas` shared zod types and the disclaimer · `packages/db` Drizzle schema and migrations · `packages/engine` parser, registry, solver, schedule, risk, policy · `packages/risk` pool decoders, exit-cost curves and the liquidity provider · `packages/chain-solana` Jupiter, Kamino, compose, sign · `packages/chain-evm` the EVM vault reader, one codebase for every EVM chain · `scripts/verify` reproducible checks · `scripts/mainnet` anything that can send a transaction · `spikes/` the two vault test rigs · `.design/` the design system.

## How work moves

Work happens on a branch, goes into `staging` through a pull request, and reaches `main` from `staging`. `pnpm verify` is the one check, locally and in CI. The rules, for people and for Claude sessions alike, are in [`CLAUDE.md`](CLAUDE.md) (start Claude Code in the repository root, or its settings and hooks do not load); tasks and their evidence are in `docs/vault/STATE-VAULT.md`; decisions are in `docs/GATES.md`.

## Disclaimer

This tool is not licensed investment advice. It structures and explains an allocation from a goal you state; the decision and custody are yours. The distributor embedding this tool holds the client relationship.

Esta ferramenta não presta consultoria de investimentos nem é licenciada para tal.

## Licence

Apache-2.0. See `LICENSE`.
