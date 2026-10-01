# Modularity and roadmap seams: note for design v2

Oct 1, 2026. Tags: `[repo]` read in Rodrigo's code today, `[audit]` from the audit reviewers' notes (outside this repo; summary in `docs/AUDIT-VAULT.md`), `[n]` checked today against source n, `[memory]` not checked. Nothing was installed or run in his trees.

## 1. Bottom line

- **Do not rename `packages/engine`.** Design v1 calls the pure logic `core` and the structure audit proposes the rename. Rodrigo keeps `engine`, is still committing (upstream `risk-layer` moved to `9cb2294` today [3]), and a byte-exact snapshot test guards its output [repo]. Thom's chain-free logic goes in one new package, `packages/basket`. Read v1's "core" as `schemas` + `engine` + `basket`.
- **`Recipe`, the vault types and the `ChainAdapter` interface go in `packages/schemas`.** That is where his `LiquidityProvider` seam already lives: an interface in the leaf package, implemented elsewhere, wired by the API [repo].
- **Freeze six things by Oct 2, then fan out:** shared types, the adapter interface, the onchain layouts, the order type, the database tables, the `/v1` API description. A hash test makes any later change visible in review.
- **One integration branch, `basket`, cut from `risk-layer`.** Stream pull requests target `basket`; one draft pull request goes `basket` → `main`. Merge `risk-layer` in daily. That stays cheap only if Thom's side never edits `engine`, `risk` or `scripts/risk`.
- **His slot process carries over unchanged.** A stream is a column of half-day slots. A failed gate flips a feature flag; it does not change code.

## 2. What to use for the MVP

### Package map

| Path | Status | Owner | May import (workspace) |
|---|---|---|---|
| `packages/schemas` | exists | shared, append-only | nothing |
| `packages/engine` | exists | Rodrigo | schemas |
| `packages/risk` | exists | Rodrigo | schemas (never engine) |
| `packages/db` | exists | one agent | schemas |
| `packages/basket` | **new** | Thom | schemas |
| `packages/basket-client` | **new**, generated from the program's interface file | Thom | nothing; carries its own `@solana/kit` 8 |
| `packages/chain-solana` | exists, add vault builders | Thom | schemas, basket-client |
| `packages/chain-evm` | exists as a stub, replace | Thom | schemas |
| `packages/chain-mock` | **new** | Thom | schemas |
| `packages/sdk` | **new**, built | Thom | none at runtime (types generated from OpenAPI) |
| `apps/api` | exists | shared | all packages |
| `apps/keeper` | **new** | Thom | schemas, basket, db, chain-* |
| `apps/mcp` | **new** | Thom | sdk |
| `apps/web` | exists | shared | schemas, sdk |
| `programs/basket`, `contracts/`, `idl/` | **new** | Thom | none |
| `content/risk-sheets/`, `content/assets/`, `content/chains.json` | **new**, data only | Rodrigo writes sheets | none |

- `packages/basket` holds flatten, the rebalance planner, creator-limit checks, the risk roll-up, the canonical recipe hash and the plan-to-recipe converter. No network, no env. The keeper needs the planner and must not pull in the solver or the model call, which is why this is not added to `engine`.
- **Weights.** The engine keeps float weights; changing them breaks `tests/engine-baseline.test.ts` [repo]. Convert once, in `basket/from-plan.ts`: floats to basis points summing to exactly 10,000 (largest remainder).
- **Kit versions.** `chain-solana` stays on kit 2.3 while klend-sdk is there; `litesvm` 1.5.0 needs kit 8 [6]. `basket-client` isolates kit 8 and hands over plain objects (Solana note). The web gets bytes only (wallet and web notes).
- **Database.** New tables go in `packages/db/src/basket-schema.ts`, the way his `risk-schema.ts` does it; Drizzle's config already takes a list of schema files [repo].
- **API.** New routes under `apps/api/src/routes/v1/`, one register line each in `app.ts`.

### Dependency rules and how to enforce them

The table's last column is the rule. In words: `schemas` imports nothing; `risk` never imports `engine` (his rule); `basket` never imports `engine`, `risk`, `db` or a chain package; only `apps/api` joins engine, risk, chains and db; `web` and `mcp` never import `db`, `engine` or a chain package; no new library reads `process.env`.

pnpm does not enforce this: path aliases and root-level `scripts/` and `tests/` make every package resolvable from everywhere [audit]. His guard is a regex test on the literal `@colosseum/engine` [repo]. Add `tests/boundaries.test.ts`: one table of forbidden pairs, the same technique, plus a self-check that a planted bad import is caught. Biome's `noRestrictedImports` could do it too [5]; one mechanism is enough.

### Freeze on day one

```ts
// schemas/src/chain.ts. His Chain ('solana' | 'evm') stays and means the family; it is also a Postgres enum.
export const ChainId = z.enum(['solana', 'base', 'robinhood']);

// schemas/src/recipe.ts: v1's Recipe plus four fields
schemaVersion: z.literal(1),
familyId: z.string(),   // one id for the same index on every chain
hash: z.string(),       // canonical hash, identical on Solana and EVM
feeBps: z.literal(0),

// schemas/src/chain-adapter.ts: v1's interface, split by who calls it
interface ChainReader   { chain; capabilities; listAssets; getPrices; getVaults; getWalletHoldings; quote; track }
interface OwnerBuilder  { buildCreateVault; buildDeposit; buildOwnerRebalance; buildWithdrawInKind;
                          buildSetAutoFollow; buildAcceptAssets; buildPublishRecipe }   // return his UnsignedTx[]
interface KeeperBuilder { buildKeeperLeg }
type ChainAdapter = ChainReader & OwnerBuilder & KeeperBuilder;
type Capabilities = { trade: 'live' | 'readonly' | 'mock'; autoFollow: boolean };
```

| Frozen thing | File | Version marker |
|---|---|---|
| Recipe, vault, price types | `schemas/src/{recipe,vault,chain}.ts` | `schemaVersion` |
| `ChainAdapter` + contract tests | `schemas/src/chain-adapter.ts`, `chain-mock/src/contract.ts` | additive only |
| Solana accounts, instruction names, error order | `idl/basket.json` | `reserved` bytes; CI fails if a build changes the file |
| EVM interfaces and events | `contracts/src/interfaces/`, `chain-evm/src/abi/` | proxy storage namespaces; committed ABIs |
| Order and legs | `schemas/src/order.ts` | extends his `UnsignedTx` |
| Tables | one migration, `0006` | additive after that |
| REST | `packages/sdk/openapi.json`, `/v1` prefix | CI fails on drift (agent note) |

- `tests/frozen.test.ts` hashes these files against a committed list. Changing one means changing the list in the same commit and adding a row to `GATES.md`.
- Before freezing, run a walking skeleton: a mock buy on three chains through API, order, legs and report.
- Three conflicts between notes to settle at the freeze: `Order`/`Leg` (web note) against `Intent`/`IntentLeg` (agent note) are one object with two names; viem pinned to 2.56.0 (wallet note) against 2.57.x (web note); `core` (v1) against `engine` (this note).

### Flags and labelled mocks

- Extend what he has: the `Provenance` enum, the web badge, and `RISK_LIQUIDITY=off` [repo]. No flag service.
- `apps/api/src/flags.ts` parses env once with zod: `CHAIN_MODE_<CHAIN>=live|readonly|mock`, `AUTO_FOLLOW_<CHAIN>`, `KEEPER_ENABLED`, `AGENT_SURFACE`. Served at `GET /v1/config`, so web, SDK and MCP read one answer.
- A feature shows when the flag and the adapter's `capabilities` both allow it.
- `chain-mock` stamps `provenance: 'mock'` on every price, quote and transaction. The API refuses to start with a mock chain when `NODE_ENV=production` unless `ALLOW_MOCK=1`.
- Change `pnpm dev` to name `api` and `web`. Today it starts every app, which would include a keeper that signs [audit].

### Pull requests

1. **PR0, CI repair** (to `basket`, and the one-line fix offered to `main`): delete `version: 11` in `ci.yml`; fix two lint errors; add a Postgres 16 service and `pnpm db:migrate`; delete five placeholder `allowBuilds` lines; add `LICENSE`. CI has failed at setup on every run [audit].
2. **PR1, the frame:** frozen types, `chain-mock` with contract tests, migration `0006`, flags, boundary and freeze tests, empty wired directories, CI jobs, and every planned dependency, so later pull requests rarely touch the lockfile.
3. **Stream PRs** (Oct 2–7): each edits its own directory plus append-only lines in `schemas/src/index.ts`, `app.ts` and root `package.json`. Generated files (interface file, ABIs, `openapi.json`, client) go in their own commits.
4. **Umbrella:** a draft `basket` → `main`. It shows his `risk-layer` commits too, since those are not in `main`.

- Merge `risk-layer` into `basket` each morning. Merge, do not rebase: agent branches hang off `basket`.
- Only `basket` generates migrations after the cut. `STATE-RISK.md` already warns about colliding numbers [repo].
- pnpm holds back versions under a day old; his workspace file lists exceptions by hand [repo]. viem 2.57.2 came out today [6]. Pin versions at least a day old.

### Slots and streams together

- A third instance of his pattern, as he did for risk [repo]: `docs/PLAN-VAULT.md`, `docs/STATE-VAULT.md` (one section per stream, so parallel edits merge), rows appended to `docs/GATES.md`.
- Slot ids are `<stream>-<n>` (`SOL-3`, `EVM-2`, `KEEP-1`): half a day, one deliverable, one check, a depends-on. Serial inside a stream, parallel across. Commits are `SOL-3: keeper leg rejects stale price`.
- His rule "stop if a gate is OPEN" now stops one stream. Gates and defaults: `IFACE-FREEZE` (Oct 2; freeze as drafted), `SOL-$10`, `RH-$10`, `BASE-$10` (chain goes `readonly`), `SCOPE-PRICE` (Solana auto-follow off), `ANCHOR-1.2` (stay on 0.31.1; 1.2.0 is current [1]), `SUBMISSION-BRANCH`.
- `CLAUDE.md` on `basket` gains one paragraph pointing basket streams at the basket documents. His rules stay.

### CI

Three workflow files, the second and third filtered by `paths` at workflow level [memory]:

- `ci.yml` (always): install, lint, typecheck, migrate, test, `next build`, then `openapi:emit` and `git diff --exit-code`.
- `program.yml` (`programs/**`, `Cargo.*`, `Anchor.toml`, `idl/**`): toolchain from `rust-toolchain.toml` and `Anchor.toml`; `Swatinem/rust-cache@v2` [4]; `anchor build`; fail if `idl/` changed; Vitest with `litesvm` against the built program (LiteSVM is on Colosseum's resource list [8]).
- `contracts.yml` (`contracts/**`): checkout with submodules; `foundry-rs/foundry-toolchain@v1` with `version: v1.8.3` [2]; `forge fmt --check`, `forge build --sizes`, `forge test`; fail if the committed ABIs changed.
- Fork tests and anything needing an RPC key are `workflow_dispatch` only. Pull requests from a fork get no secrets [memory].
- Biome reads no `.gitignore` today [repo]. Set `vcs.enabled`, `clientKind: "git"`, `useIgnoreFile: true` [5] and exclude `target`, `.anchor`, `contracts/{lib,out,cache,broadcast}`, `idl`, and generated code.
- Leave his action versions alone apart from the one-line fix; `checkout@v4` got a release in July [4].

## 3. What to skip or defer

- **Renaming `engine`, or the `@colosseum/` scope:** 207 references [audit]. Do the scope in one commit once the name exists.
- **Moving `feeds/` and `parser/llm.ts` out of `engine`, folding `apps/risk-api` into `api`:** right, but his code and his week.
- **Turborepo, TypeScript project references, per-package builds:** source-consumed packages work. Build only `sdk`.
- **TypeScript 7, pnpm 12, kit 8 everywhere:** current [6], but upgrades are not features.
- **Changesets and an npm release:** the SDK installs from the repo.
- **A hosted flag service, CODEOWNERS, required checks:** env flags and the hash test cover eight days.
- **Per-package Vitest projects:** his tests read fixtures by repo-root paths [audit]; keep the single root config.
- **pnpm catalogs:** tidy, but one more thing to learn this week.

## 4. Seams for the roadmap

| Item | Leave in place now | Cost of the wrong choice |
|---|---|---|
| Community, gamification | The same events on both chain families (`RecipePublished`, `VersionAdopted`, `Followed`, `Unfollowed`) and one `chain_events` table. Profiles and rankings are views over it | Counts kept only in the API cannot be rebuilt or trusted |
| Creator fees | `feeBps = 0` and a recipient field in the recipe, onchain and in `schemas`; `order.fees` empty | Resizing every recipe account, or a second registry |
| Publish once (CCIP) | `familyId` and one canonical `hash` in every onchain recipe; a publisher role on the registry, empty today. Robinhood Chain's testnet has lanes to Base and Solana [7] | Ids derived per chain cannot be matched without the database |
| More chains | `ChainId` and `content/chains.json` are the only chain lists; swap venues are a strategy object in `chain-evm`; explorer links keyed by chain (his helper is Solscan only [repo]) | Reusing `Chain` as the chain id means migrating every table with a chain column |
| New basket types | Targets stored in the vault, separate from the recipe; `Recipe.kind` open; the planner takes a policy argument | A vault that reads weights from the recipe at trade time cannot hold a floor basket |
| Rebalance on drift | Keeper jobs carry `trigger: 'index_update' \| 'drift' \| 'liquidity_breach'`; the keeper path needs only auto-follow on and toward-target | Requiring "a newer version exists" onchain forces a program upgrade |
| Paid price feeds | A price-kind value per asset onchain; `source`, `fetched_at`, `method` on every `Price` | A hard-wired Scope layout in the check path |
| Agent-run indexes | A creator is an address; `creator_kind` is a database label | None onchain |
| Pooled token | The vault owner may be a program or a contract; never assume a person's key | A new vault for the pooled product |
| Embeds | Every write goes through `/v1`; a nullable `partner_id`; the web `(embed)` route group | Logic in Next server code that partners cannot call |
| Audits, upgrade governance | Admin is a stored address with two-step transfer; `deployments/*.json` and verified builds committed | A baked-in deployer key or fixed clones leave no path to a multisig |

## 5. Risks, and the test that settles each

| Risk | Test | By |
|---|---|---|
| His branch moves under ours | Each morning, trial-merge `risk-layer` into `basket`. Pass: conflicts only in the lockfile | Oct 3, after two merges |
| Interfaces frozen wrong | The walking skeleton passes on the mock, including the single EVM create-deposit-trade call the wallet note needs | Oct 2 |
| Two kit versions in one process | Build `create_vault` with `basket-client`, pass it as a plain object, simulate through `chain-solana`'s compose path. Fail: drop klend-sdk (two files [audit]) and move to kit 8 | Oct 2 |
| Migration collisions | CI runs `drizzle-kit generate` and fails unless it reports no changes | PR1 |
| Rust job too slow | Time PR1's job warm. Over 15 minutes: build on push to `basket` only | Oct 2 |
| Source-only packages cannot deploy | Container build of `api` and `keeper` on the free host; `pnpm pack` the SDK, install the tarball in an empty folder, call one method | Oct 3 |
| The boundary guard goes quiet | Its self-check fails when the planted import is not caught | PR1 |
| No branch can be the submission | Rodrigo's answer recorded in `GATES.md` | Oct 3 |

## 6. Questions only a person can answer

1. Rodrigo: does Thom get write access, so `basket` lives in his repo, or does it live on the fork?
2. Rodrigo: which branch is submitted? His rules freeze `main` and keep `risk-layer` out of it until Oct 12. Options: lift that for the basket pull request, or make `basket` the default branch.
3. Rodrigo: is it fine that `engine` keeps its name and Thom's logic lands in `packages/basket`?
4. Rodrigo: MIT or Apache-2.0? Borrowed MIT code cannot land cleanly without a licence.
5. Rodrigo: no new migrations on `risk-layer` after the cut, or a warning first?
6. Rodrigo: the keeper plans a fresh leg after a failed one. Does "never auto-retry a failed mainnet transaction" allow that, if the same bytes are never resent and attempts are capped?
7. Rodrigo: may the one-line CI fix go onto frozen `main`?
8. Both: rename the `@colosseum/` scope before the freeze, or after submission?

## 7. Sources

1. Anchor releases (v1.2.0 Sep 4; v0.31.2 and v0.32.2 Sep 14): https://github.com/solana-foundation/anchor/releases ; https://www.anchor-lang.com/docs/updates/release-notes/1-0-0
2. Foundry v1.8.3 (Sep 15): https://github.com/foundry-rs/foundry/releases ; action inputs: https://github.com/foundry-rs/foundry-toolchain
3. Upstream repo, GitHub API: `main` 6970dc5, `risk-layer` 9cb2294, `design` 3309b1f, no licence, no open pull requests
4. Action releases (GitHub API): `actions/checkout` v7.0.1 and v4.4.0 (both Jul 20), `pnpm/action-setup` v6.1.0, `Swatinem/rust-cache` v2.9.2
5. Biome: https://biomejs.dev/reference/configuration/ ; https://biomejs.dev/linter/rules/no-restricted-imports/
6. npm registry: `@solana/kit` 8.4.0, `litesvm` 1.5.0 (depends on kit ^8), `viem` 2.57.2 (Oct 1), `typescript` 7.0.2, `pnpm` 12.8.1
7. CCIP directory, Robinhood Chain testnet: https://docs.chain.link/ccip/directory/testnet/chain/robinhood-testnet (a mainnet page exists; its lanes could not be read)
8. Colosseum resources index: https://ColosseumOrg.github.io/hackathon-resources/current.json (lists LiteSVM, Surfpool, Codama, Anchor; no repo-structure or CI rules)
