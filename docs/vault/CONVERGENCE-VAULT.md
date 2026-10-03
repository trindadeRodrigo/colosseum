# CONVERGENCE: from the structurer to plans held in a vault

*Written 2026-10-01, and brought in line with `DESIGN-VAULT.md` the same day. For Rodrigo and Thom. The verdicts follow from the direction Thom and Rodrigo spoke about on Oct 1; either of them can reopen one.* Read with the audit (`AUDIT-VAULT.md`), the product (`HANDOFF-VAULT.md`) and the design (`DESIGN-VAULT.md`), which is the reference wherever more detail is needed.

Product words follow the brand strategy on the `design` branch: plan, shared portfolio, vault, exit plan, Bearing. Paths and code names in backticks are working names.

## Starting point

The repo is closer to the design than it looks. `apps/api`, `apps/web`, `packages/engine`, `packages/chain-solana` and `packages/chain-evm` keep their paths and names. `risk-layer` is a fast-forward of `main`, so there is one history. The new work adds files; it does not edit or delete Rodrigo's.

Two things get replaced: custody (a token approval to a server-held key) and the Brazil-specific frame around the engine. The engine, Bearing, the provenance rules and the execution log stay.

On Oct 1 Rodrigo merged the risk layer and the design system into `main`, so the work builds from there: short-lived branches, each with a pull request into `staging`, and `staging` into `main`.

## What happens to each piece

"His edit" marks a change Rodrigo makes on `risk-layer`, which then arrives by merge.

| Piece | Verdict | What changes |
|---|---|---|
| `packages/schemas` | keep, append only | New files for the plan, vault, chain adapter, order and leg types, in basis points and raw units. His types are not edited |
| `packages/engine` | keep, under its name | Gains `src/personal/`, new files only: the rules that cut a plan from the shelf of the person's chain. A rename to `core` was tried in a scratch copy and works; it is not done while he is still committing there |
| engine `solver/`, `schedule/`, `policy/` | keep | Not edited. The new module reuses `applyHaircut`, `YieldObservation`, `LiquidityProvider` and `Language`. His baseline snapshot stays green. The audit's fixes here (the yield estimate, the verdict, the BRL-leg trigger) are his edits |
| engine `parser/rules.ts` | keep | Stays as the path with no model key and as a cross-check on the model. The negation and amount fixes are his edit |
| engine BRL parts (FX feed and stresses, reserve table, Portuguese regexes) | untouched | The new module works in dollars. Nothing is parked or deleted |
| `packages/risk` | keep | His edits: the three fixes from the audit (items 9 and 10, and a regime with too few samples counting as zero), and six lines in `scripts/risk/compute.ts` so curves keep their method version, which lets EVM rows in |
| `packages/db` | keep | New tables in their own schema file and one additive migration. No table of his changes. His edit: `seed-assets.ts` moves to `scripts/` (done on Oct 2: `scripts/seed-assets.ts`) |
| chain-solana `jupiter`, `compose`, `simulate`, `rpc`, `explorer` | keep, reused | Timeout and backoff, a required key, a compute budget from our own simulation. The package passes to Thom when the branch is cut |
| chain-solana `sign`, `wallet` | move behind a server-only entry | Only the keeper and scripts may import them. A new key-free `send.ts` broadcasts and tracks |
| chain-solana `positions`, `prices` | superseded | New readers: holdings over both token programs with the multiplier applied once; reference prices from Kamino Scope with age and market state |
| chain-solana `executor`, `rebalance-executor`, `delegate`, `kamino`, `brl-leg` | switched off, deleted after the freeze | Vault transaction builders replace them, one leg at a time. `buildRevokeUnsigned` stays as the migration tool |
| `packages/chain-evm` | replace | The stub becomes the Base and Robinhood Chain adapter |
| `apps/api` | adapt | New routes under `routes/v1/`, auth, a CORS allowlist, rate limits, one error handler. With `LEGACY_STRUCTURER=off` the `/policies/*` routes are not registered. `/risk` routes stay. His edit: delete the routes that sign on the server |
| `apps/risk-api` | keep | Not touched |
| `apps/web` | adapt | New screens in `features/` folders. His `/risk/*` pages stay. His three screens (home, plan, monitor) are rebuilt on his design system and extended, and `/embed` stays (section 11 of the design). Privy replaces the wallet-adapter provider |
| `scripts/`, `fixtures/`, `tests/`, `docs/` | keep | Collectors and launchd jobs untouched before Oct 12. Old docs get a "superseded by" line once he agrees |
| `packages/basket` | new | Chain-free logic: flatten a plan that holds shared portfolios, value and drift, the rebalancing planner, the check on authors' limits, the risk roll-up |
| `packages/chain-mock` | new | The mock adapter the web app, keeper and adapter contract tests run against |
| `programs/basket` | new | Anchor vault and registry, grown from `spikes/solana-vault-swap` |
| `contracts/` | new | Foundry `BasketVault`, `VaultFactory`, `IndexRegistry`, from `spikes/evm-vault` |
| `apps/keeper` | new | A worker with no inbound HTTP and its own tables |
| `packages/sdk`, `apps/mcp` | new | Typed SDK, with the guard that checks every transaction before it is signed, and the MCP server |
| `content/risk-sheets/` | new | One sheet per issuer family, written by Rodrigo; per-asset fields are generated |
| `scripts/risk-evm/` | new | Hourly quote collector for the EVM chains, writing rows in Bearing's snapshot shape |

## Target structure

```
apps/        api  web  keeper  mcp  risk-api
packages/    schemas  engine  basket  risk  db  chain-solana  chain-evm  chain-mock  sdk
programs/    basket              Anchor; Anchor.toml and Cargo.toml at the root
contracts/   src  test  script   Foundry
content/     risk-sheets
scripts/     verify  risk  risk-evm  ops  solana
tests/  fixtures/  spikes/
docs/        GATES  PRIOR-WORK  DATA-MODEL  README
             vault/  risk/  structurer/
```

`schemas` imports nothing. `risk` and `basket` import only `schemas`; `engine` may import `basket`. Only `api` and `keeper` join logic, chains and the database. `web` and `mcp` never import the database, the engine or a chain package. Only the keeper and scripts can reach a signing key.

## Decisions

Settled on Oct 1 unless marked open. Each keeps its trade-off, so it can be reopened with the cost in view. The full list is section 17 of `DESIGN-VAULT.md`.

- [x] **Custody.** A program-owned vault per plan replaces the token approval. For: the rules hold if the server is compromised, and stocks can be rebalanced without a signature each time. Against: two unaudited contracts with upgrade keys, built in eleven days, where today the tokens never leave the wallet. He ruled out a custom program on time; the spike behind the new estimate passed locally, not yet on mainnet.
- [x] **Brazil-specific logic.** New plans and their card are in dollars; the reais schedule, BRL leg, FX stresses and the G-NORA gate stay where they are, for the structurer. For: one global product, and the BRL leg cannot execute today. Against: goals in reais are his differentiator and his partners' frame. Middle path: a BRL stable as one shelf asset if G-NORA passes by Oct 6.
- [x] **Stocks.** From "high-risk only, at most 35%, zero expected return" to the core of the shelf. The design keeps "no return assumed" for stocks and gold and shows the dollar loss in a 20% fall; whether to show a sourced range is his call. His rule keeping xStocks out of income profiles stays: an income plan holds no stock tokens, and neither does a plan whose goal is to protect (decided on Oct 3).
- [x] **Chains.** Three from day one, against Solana only. For: partner pilots may land on an EVM chain (gate EVM-S1), and one adapter interface contains the cost. Against: three mainnet rehearsals, and Bearing data that is Solana only, so the exit plan on the other two is thinner. A chain that fails its test becomes read-only. Each plan is on one chain, the chain of the person's wallet (decided on Oct 3).
- [x] **Audience and shared portfolios.** Direct to a person, next to the partner embed. The positioning stays: the goal comes first. A shared portfolio is an input to the goal and a way for the product to spread, never the product: nobody takes one without the sheet, the reasons and the exit plan. For: a reason to return and something to share. Against: a shelf of them can read as "an idea turned into a basket", the frame the positioning rejects, so they stay one step behind the goal on every screen. The embed is parked, not removed.
- [x] **Sign-in.** Privy (connect or passkey) against wallet-adapter only. It reaches people without a wallet and covers three chains; it adds a vendor and a free-tier ceiling. The API needs auth either way.
- [x] **Units.** New types and tables use basis points and raw token amounts, so weights sum to exactly 10,000 and an 18-decimal token can be stored. His float weights and his tables stay as they are.
- [x] **Process.** Parallel streams against frozen interfaces, beside his slot plan, with slot ids of the form `<stream>-<n>`. His rules stay: provenance, MOCK labels, deterministic engine, explorer links, no advice claim. One rule needs his word: "never auto-retry" against a keeper that re-plans a leg which expired without landing.
- [x] **The `risk-layer` branch.** Merged into `main` on Oct 1, with the design system. The vault work builds on `main`.
- [x] **Four small edits to his files,** which we make: the routes that sign on the server go behind a flag and are deleted once the vault path replaces them, `seed-assets.ts` moves to `scripts/` (done), the CI chores (done), and six lines in `compute.ts`.
- [ ] **Smaller ones.** Still open: where the Bearing data runs for the demo, revoking the two live approvals on the demo wallet, and who runs the Solana mainnet sessions. The licence is Apache-2.0. The name (Tenonfi is provisional on the `design` branch), which also decides the `@colosseum/` scope and the working code names.

## Pull requests

1. **Documents and clean-up into `main`:** the product, the design, the audit, this map, the research, the two test rigs, the decisions in `docs/GATES.md`, the licence, and the fixes that make every check run and pass. No product behaviour changes.
2. **Repo organisation,** from `main`: remove what is dead or stale, and lay out the folders the design needs.
3. **The frame** the TypeScript streams wait for: the first version of the shared types, the mock adapter with its contract tests, the migration, the flags. Then the test that enforces the import rules and the CI workflows for the program and the contracts.
4. **One pull request per stream.** The streams, their owners and what "done" means are in section 15 of the design; the days, the milestones and the cut order are in `PLAN-VAULT.md`.

Before every merge: `pnpm verify` locally and a green run on GitHub.

## What the audit fed into the design

Already solved in this repo, and reused:

- The parser contract, the reason per leg, the provenance columns and one log row per transaction.
- Market regimes and the holiday calendar (`packages/risk/src/time.ts`), for the keeper's market-open rule.
- Exit cost by size: the curves hold $10k and $50k as measured points and give $1k by interpolation.
- The three-goals test (`tests/solver.test.ts:72`), extended to the card.

Found by running the code, and taken into the design:

- `schemas` stays the leaf; "the logic package depends on nothing" would have cost 46 import rewrites.
- A program-owned account as Jupiter's `userPublicKey` fails Jupiter's own pre-simulation, so the adapter sets the compute budget itself. Keyless Jupiter allows about four calls per burst, so a key is required.
- Legs cannot share one blockhash. Each leg is built just before it is signed and confirmed by block height.
- The browser cannot send through the public Solana RPC. Signed transactions go through the backend.
- The dividend multiplier is a schedule (current, next, effective time). SPYx's transfer hook is unset today while permanent delegate, pause and freeze are live; that belongs on the risk sheet.
- The exit plan needs two numbers. At $1k to $50k most Jupiter flow went through a venue Bearing does not decode, so the design shows "quoted" beside "measured, worst regime".
- No HTTP request may make a server-held key sign, and the keeper plans from chain state, never from a row the API wrote.
- Kamino Scope prices ten stock tokens and no dollar-yield token, so on Solana automatic rebalancing covers only plans built from those ten.
- One Solana client per place: `@solana/kit` 2.3 in the packages, a newer kit in the web app only, and the two never meet.

Still open after the design:

- A verdict for balance goals. The design gives one for income goals only.
- The odds of reaching a goal. The engine gives a verdict and a gap, not a probability.
