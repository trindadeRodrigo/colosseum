# DESIGN: plans held in a vault, technical design v2

*Written 2026-10-01. The working design. Thom and Rodrigo spoke on Oct 1 and the work continues on this basis. Whoever builds a piece decides what makes sense for the product and records it in section 17 and in `docs/GATES.md`; either founder can reopen a choice. It replaces the first version, which is in this branch's history. For Rodrigo, Thom and the coding agents that build each piece.*

How this was made: nine research notes (`docs/vault/research/design-v2/*.md`) merged with the product (`docs/vault/HANDOFF-VAULT.md`), the first version, the audit (`docs/vault/AUDIT-VAULT.md`) and the convergence blueprint (`docs/vault/CONVERGENCE-VAULT.md`), then revised after three reviews: scope against time, security, and seams. What each review changed is in `docs/vault/research/design-v2/review-log.md`. Marks: **[C n]** means checked on Oct 1 against source n in the last section, by a stream note, a reviewer or this revision; **(memory)** means not re-checked. Other numbers come from the stream notes, which carry their own source lists.

Nothing here has run on mainnet. The three $10 runs come first in time.

**Changed on Oct 1, night:** the delay between an author publishing a new version and a vault applying it is 48 hours after launch, up from 12. The person has two days to see the change and refuse it.

**Words.** The product words follow the brand strategy on the `design` branch. The code names in the listings are working names, chosen before the strategy. They are renamed once, together with the package scope, when the name is final (section 17, item 18).

| Product word | What it is | Working code name |
|---|---|---|
| Plan | A portfolio made to measure for one goal, with its reasons, its card and its exit plan | `BasketSheet`, `BasketProposal`, `baskets`, `packages/basket` |
| Shared portfolio | A public, versioned list of assets and weights that a plan can start from or follow | `Recipe` with `kind: 'community'`, `index_families`, `IIndexRegistry`, `/indexes/[slug]` |
| Vault | The person's own onchain account for one plan on one chain | `Vault`, `IBasketVault`, `programs/basket` |
| Rebalance | Trade back toward the targets. His voice rules keep "re-true" for marketing copy; the product says rebalance | `rebalance`, `planRebalance`, `keeper_leg` |
| Exit plan | What it costs to get out at your size, and the withdrawal of the tokens themselves | `RiskRollUp.exit`, `LiquidityProvider`, `withdraw` |
| Bearing | The liquidity and risk layer | `packages/risk` |

**Decided by Thom after the reviews (Oct 1).** The text below is updated for these.

- US persons: no location block and no banner. The terms say the app is not for US persons, and a person accepts the terms before the first deposit.
- Upgrade keys: one disclosed key per chain for now, and the app says so. A multisig comes after the MVP.
- Keeper: run locally while testing, with a gas-only key. At deploy it moves to a small VM.
- Nothing is spent (decided on Oct 2; it replaces the $10 of model credit and the three $10 tests on mainnet). The rules parser reads the goal sentence, and a model is used only if a key is already at hand. The vault tests run on copies of mainnet. Where the text below names a $10 run, a funded deploy, a mainnet rehearsal or a bought domain, `PLAN-VAULT.md` says what stands in for it; how the product is shown without a funded deploy is gate `SHOW` in `docs/GATES.md`.
- Build tools may be installed on Thom's machine. Already there: Anchor 0.31.1, Solana CLI 3.0.1, Rust, Foundry (older than the pin), Docker. Missing: surfpool, solana-verify, Slither.

## 0. What changed from v1

- The code lands in Rodrigo's repo and builds on `main`, which has had the risk layer and the design system since Oct 1. `packages/engine` keeps its name; Thom's chain-free logic goes in a new `packages/basket`. New work adds files where it can.
- Nine MVP items: the agent surface is item 9. Free tiers only, so the backend reads chain state and runs no indexer.
- One object, the **order**, with **legs**, backs every buy, rebalance, publish and agent approval. Keeper legs sit in their own table, which only the keeper can write.
- The browser handles bytes only. A guard checks every transaction down to the function and its arguments before it is signed.
- EVM vaults are beacon proxies, so one transaction can fix every vault. Withdrawals go only to the owner, on both chain families. The value check is per trade.
- Solana: Kamino Scope prices cover ten stock tokens and nothing else, so auto-follow runs only on vaults whose every asset is in that list.
- EVM: a fresh price does not prove an open market, so stock legs trade only in a fixed weekday window, minus a list of closed days.
- The model fills a form and nothing else. Explanation text comes from templates.
- The keeper runs as a loop on a machine the team controls. GitHub's scheduler only runs workflows from the default branch **[C 16]**, which is `main`.
- The publish delay has a one-way launch latch: short while only team money is in, 48 hours and locked before the public link.
- Hostile cases A1 to A18, a two-tier security gate per chain, and a separate gate before the public link is shared.
- The build starts small. Section 16 lists what is out unless the team is ahead, each with a date.
- Turnkey and Privy's gas sponsorship are no longer free. The app uses a funding check that includes gas.
- The web app follows Rodrigo's design system, which is now on `main`: his three screens are rebuilt on it and extended, the goal comes first, and section 11 lists where his component specs change what we build.

**Conflicts between notes and reviews, settled**

| Conflict | Choice | Why |
|---|---|---|
| Rename `engine` to `core` (the blueprint), or keep it | Keep `engine` | Rodrigo is still committing there; a byte-exact snapshot test guards it |
| Personalization in `engine` or in `packages/basket` | `engine/src/personal/`, new files only | The fixed split gives the engine to Rodrigo. `engine` may import `basket`, so nesting is flattened in one place |
| Extend his `executions` table and enums, or add our own | New `leg_attempts` table in his column style | No change to his tables while he is still migrating; his `tx.ts` is not edited |
| His `chain` enum, a new enum, or text | `chain_id` as text with a foreign key to a `chains` table | A new chain is a row, not a migration |
| Keeper on GitHub cron, or a loop on a team machine | The loop | Its secrets would be open to anything that can push, and scheduled runs can be delayed or dropped |
| A hard 48-hour floor on the delay, or a short delay for test cycles | Both, through the launch latch | Three test cycles in total were too few; after `launch()` the floor cannot drop |
| Accept may name a pending version, or only the active one | Only the active one, by number | Pre-acceptance needs extra vault state; the prompt appears when the version takes effect |
| Keeper revisits any vault outside the band, or only after a shared-portfolio update | Any auto-follow vault not yet back in band since its last adoption | Fixes half-finished rebalances without shipping drift rebalancing, which is on the roadmap |
| Relay signed bytes, or report only | Report, with optional signed Solana bytes that must match a leg the server built | The browser has no RPC; binding to a built leg avoids an open relay |
| viem 2.57.x or 2.56.x | 2.56.0 everywhere | `@privy-io/react-auth` 3.46.0 depends on exactly 2.56.0 **[C 8]** |
| Cooldown per vault or per asset | Per asset | A rebalance finishes in one pass and cannot ping-pong |
| "Fresh within 120 s" everywhere | 120 s on Solana; 26 h plus a session window on EVM | Chainlink stock feeds were 12 to 53 minutes old in session |

## 1. What gets built

| # | MVP item | Pieces that deliver it |
|---|---|---|
| 1 | Sign in two ways; a chain is usable once funded | Privy behind `WalletPort`; `users`, `user_wallets`; `GET /v1/funding` (cash plus gas per chain) |
| 2 | At least 6 shared portfolios, 2 on more than one chain | Onchain registries; `index_families`, `recipes`, `recipe_versions`; shelf and shared-portfolio screens; a seed script from `launch-shelf.seed.json` |
| 3 | Plan from a sentence or a form | `engine/src/personal/` (`compose`); `/v1/baskets/parse` and `/personalize`; fit screens; the three-profile test |
| 4 | One-tap buy on three chains, status per leg, retry | `POST /v1/orders`; legs and attempts; owner builders; `/orders/[id]` |
| 5 | Portfolio across chains with drift | `getVaults`, `getPrices`; `view()` in `packages/basket`; portfolio screen |
| 6 | Rebalance in one tap | `planRebalance` in `packages/basket`; a rebalance order |
| 7 | Publish, follow, update, prompt; auto-follow off by default | Registry with creator limits; accept, adopt and keeper-leg calls; `apps/keeper`; a simple publish form |
| 8 | The exit plan and the risk sheet: a sheet per asset, a roll-up per plan | `content/risk-sheets/` (Rodrigo); `LiquidityProvider`; the EVM collector; `rollUp` in `packages/basket` |
| 9 | Built for agents | `/v1` REST with a committed OpenAPI file; `packages/sdk`; `apps/mcp`; `skills/basket/SKILL.md`; approval at `/orders/[id]` |

Not built: bridging, shared pools, an adviser view, creator fees, fiat ramps, perps, CCIP sync, sponsored gas, session signers, an event indexer, agent API keys, keeper rebalancing on drift.

## 2. Repo layout

Base: `staging`. Each stream works in a short-lived branch and opens a pull request into `staging`; `staging` goes into `main` when its checks pass. Only one branch at a time generates migrations.

**The add-only rule.** New work adds files. An edit to a file Rodrigo owns is made by him and arrives by merge, so the morning merge never conflicts. In the API, his server-signing surfaces are switched off, not deleted: with `LEGACY_STRUCTURER=off` the `/policies/*` routes are not registered. In the web app his three screens (home, plan, monitor) are rebuilt on his design system and extended, as section 11 describes; who edits which file there is agreed per screen. Exceptions he agrees to (section 17): the PR0 chores, and `packages/chain-solana` and `packages/chain-evm`, which pass to Thom at the cut.

| Path | Status | Owner | May import |
|---|---|---|---|
| `packages/schemas` | exists; new files only | shared, append-only | nothing |
| `packages/basket` | new: flatten, view and drift, planner, creator-limit check, roll-up, meta hash | Thom | schemas |
| `packages/engine` | exists; gains `src/personal/` | Rodrigo | schemas, basket |
| `packages/risk` | exists | Rodrigo | schemas |
| `packages/db` | exists; gains `basket-schema.ts`, `curves.ts`, migration `0006` | one agent | schemas |
| `packages/chain-solana` | exists; gains vault builders, `send.ts` and a `./server` entry for `sign.ts` and `wallet.ts` | Thom | schemas |
| `packages/chain-evm` | stub replaced; ABIs committed | Thom | schemas |
| `packages/chain-mock` | new; stamps `provenance: 'mock'` | Thom | schemas |
| `packages/sdk` | new, built; types from OpenAPI; the guard and the leg executor | Thom | schemas (types only) |
| `apps/api` | exists; new routes under `routes/v1/` | shared | all packages |
| `apps/risk-api` | exists | Rodrigo; not touched | as today |
| `apps/keeper`, `apps/mcp` | new | Thom | keeper: schemas, basket, db, chain-*; mcp: sdk |
| `apps/web` | exists | shared | schemas, sdk |
| `programs/basket`, `programs/mock-router`, `idl/`, `contracts/` | new | Thom | none |
| `content/risk-sheets/`, `content/chains.json` | new, data only | Rodrigo writes sheets | none |
| `scripts/risk-evm/`, `scripts/ops/`, `scripts/solana/` | new | Thom | any |
| `scripts/risk/`, launchd jobs | exist | Rodrigo; not touched | n/a |

**Dependency rules**, enforced by `tests/boundaries.test.ts` (a table of forbidden pairs, with a planted bad import as a self-check):

1. `schemas` imports nothing. Interfaces live there, implementations elsewhere, and the apps wire them, as his `LiquidityProvider` already does.
2. `risk` never imports `engine`. `basket` imports only `schemas`.
3. Only `apps/api` and `apps/keeper` join logic, chains and the database.
4. `apps/web` and `apps/mcp` never import `db`, `engine` or a chain package.
5. Only `apps/keeper` and `scripts/` may import the signing entry, `@colosseum/chain-solana/server`, or the EVM signer. Broadcast and status live in a key-free `send.ts`, which the API may import.
6. No new library reads `process.env`. A pure `parseFlags(env)` in `packages/schemas` is called once by each app.

Two things in his code break these rules today. `packages/db/src/seed-assets.ts` imports `engine`. The `chain-solana` root barrel re-exports `sign.ts` and `wallet.ts`, and his `apps/api/src/routes/monitor.ts` imports the keypair loader from it. Rodrigo is asked to move the seed file to `scripts/` and delete the server-signing routes on `risk-layer` (the audit's top fix). When that merges, PR1b moves `sign.ts` and `wallet.ts` behind the `./server` entry. Until then the test lists both as dated exemptions, the routes are not registered, and no key file exists on the API host.

**Flags.** `CHAIN_MODE_<CHAIN>=live|readonly|mock`, `AUTO_FOLLOW_<CHAIN>`, `KEEPER_ENABLED`, `AGENT_SURFACE`, `LEGACY_STRUCTURER`, served at `GET /v1/config`. A feature shows only when the flag and the adapter's `capabilities` both allow it. A failed gate flips a flag; it does not change code.

**Pull requests.** PR0 repairs CI, which has failed at setup on every run: delete `version: 11` in `ci.yml`, fix three lint errors, add a Postgres 16 service and `pnpm db:migrate`, delete the placeholder `allowBuilds` lines, add `LICENSE`. PR1a is the frame every TypeScript stream waits for: the v0 types, `chain-mock` with contract tests, migration `0006`, flags. PR1b follows without blocking anyone: the boundary test, three CI workflows (`ci.yml`, `program.yml`, `contracts.yml`) and the dependency pins.

**Process.** His slot process carries over: `docs/vault/PLAN-VAULT.md`, `docs/vault/STATE-VAULT.md`, rows in `docs/GATES.md`. Slot ids are `<stream>-<n>`, half a day each. An open gate stops one stream. `pnpm dev` starts `api` and `web` only.

## 3. Frozen interfaces

Frozen in two steps. **v0 on Oct 2**, with the first types and the mock: streams start against it, and one named owner (Thom) approves any change. A walking skeleton on the mock (a three-chain buy through API, order, legs and report) proves it by Oct 3. **Final on Oct 4 evening**, after each real adapter has built and simulated a create, a deposit, one swap and one keeper leg on a fork. Only then does `tests/frozen.test.ts` start hashing the files; it hashes new files only, never his. Later changes are additive. Each TypeScript type below has a zod schema of the same name in `packages/schemas/src/`.

### 3.1 Shared types

```ts
// chain.ts. Rodrigo's Chain ('solana' | 'evm') stays and means the wallet family.
type ChainId = 'solana' | 'base' | 'robinhood';       // EVM ids: base 8453, robinhood 4663
type Address = string;                                // base58 on Solana; lower-case 0x on EVM
type RawAmount = string;                              // raw token units, decimal string. Never a float
type AssetId = string;                                // `${ChainId}:${slug}`, e.g. 'solana:spyx'
type Sourced = { source: string; method: string; fetchedAt: string; provenance: Provenance };

// basket-asset.ts (his Asset type is untouched)
type BasketAsset = { id: AssetId; chain: ChainId; address: Address; symbol: string; decimals: number;
  cls: 'stock' | 'etf' | 'gold' | 'commodity' | 'dollar_yield' | 'crypto' | 'cash';
  underlying: string;                                 // 'NVDA' for NVDAx, NVDAc and NVDA
  issuer: string; tier: 'A' | 'B' | 'C';
  priceKind: 'scope' | 'chainlink' | 'none'; priceRef: string;
  session: 'always' | 'us_equity'; autoFollowEligible: boolean;
  maxWeightBps: number;                               // creator cap, section 6
  blockedCountries: string[]; sheet: string; provenance: Provenance };

// recipe.ts
type Component =
  | { kind: 'asset'; asset: AssetId; weightBps: number }
  | { kind: 'index'; family: string; weightBps: number };   // personal recipes only; flattened before a vault sees it
type Recipe = { schemaVersion: 1; familyId: string; chain: ChainId; onchainId: string | null;
  creator: Address; kind: 'community' | 'personal';
  version: number; effectiveAt: number;               // unix seconds
  components: Component[];                            // sum is exactly 10_000
  metaHash: string; maxFeeBps: 0; flags: 0 };         // both stored onchain and required to be zero in the MVP
type Target = { asset: AssetId; weightBps: number };  // what a vault stores
type FamilyMeta = { familyId: string; slug: string; name: string; copy: string;
  kind: 'index' | 'single'; chains: ChainId[] };

// vault.ts
type Price = Sourced & { asset: AssetId; usdPerToken: string;   // USD for 10^decimals raw units
  ageSeconds: number; market: 'open' | 'closed' | 'unknown' };
type Holding = { asset: AssetId; raw: RawAmount; multiplier: string; display: string };
type VaultState = { chain: ChainId; address: Address; owner: Address; basketId: string;
  recipeOnchainId: string | null; acceptedVersion: number; autoFollow: boolean; keeper: Address; cash: Holding;
  positions: (Holding & { targetBps: number; lastKeeperAt: number | null })[];
  lossUsedBps: number; observedAt: string;
  pending: { version: number; effectiveAt: number; newAssets: AssetId[] } | null };
type VaultView = VaultState & { valueUsd: string;      // filled by view() in packages/basket, never by an adapter
  positions: (VaultState['positions'][number] & { valueUsd: string | null; weightBps: number; driftBps: number })[] };
type Trade = { sell: AssetId; buy: AssetId; amountInRaw: RawAmount };   // one side is the chain's cash token
type Quote = Sourced & { trade: Trade; outRaw: RawAmount; minOutRaw: RawAmount; costBps: number;
  against: 'reference' | 'pool_mid'; venue: string };
type Funding = { chain: ChainId; cashHaveRaw: RawAmount; cashNeedRaw: RawAmount;
  gasHaveRaw: RawAmount; gasNeedRaw: RawAmount; ok: boolean };
type TxStatus = { status: 'pending' | 'confirmed' | 'reverted' | 'expired'; explorerUrl: string;
  error?: { code: string; message: string } };
```

**Ids.**

- `basketId` is the decimal string of a 64-bit number, chosen by the client per owner. The Solana seed is its 8 little-endian bytes; the EVM salt is the same number as `bytes32`.
- `familyId` is 32 random bytes in hex, chosen when a family's first publish order is made. It is the Solana recipe seed and the EVM salt, so one family has one fixed id on all three chains.
- `onchainId` is the recipe account address on Solana and `keccak256(abi.encode(creator, familyId))` on EVM.
- `family` (in `Component`, `IntentRequest` and themes) is always the slug.
- `metaHash` is the SHA-256 of the canonical JSON of `FamilyMeta`. It is content, not identity: anyone can copy it.

**Value and display.** `display = raw × multiplier / 10^decimals` is shares of the underlying, for display only. `valueUsd = raw × usdPerToken / 10^decimals`, with no multiplier, because the reference price on all three chains is the price of one whole token and already includes it. Contract-test vector: 8 decimals, raw 250,000,000, multiplier 1.02, price 100 gives display 2.55 and value 250.00. `view(vault, prices)` in `packages/basket` is the only place that computes value, weight and drift. His `computeDrift` stays for his own screens.

### 3.2 Chain adapter (`chain-adapter.ts`)

```ts
type Capabilities = { trade: 'live' | 'readonly' | 'mock'; autoFollow: boolean;
  maxTradesPerTx: number;        // 1 on Solana, 8 on EVM; both re-measured on Oct 3
  tradesInCreate: boolean;       // false on Solana, true on EVM
  needsApprove: boolean };       // false on Solana, true on EVM
interface ChainReader {
  chain: ChainId; capabilities: Capabilities;
  listAssets(): Promise<BasketAsset[]>;
  getPrices(assets: AssetId[]): Promise<Price[]>;
  getVaults(owner: Address): Promise<VaultState[]>;
  getVault(vault: Address): Promise<VaultState | null>;
  listAutoFollowVaults(recipeOnchainId?: string): Promise<Address[]>;
  getRecipe(recipeOnchainId: string): Promise<{ active: Recipe; pending: Recipe | null }>;
  getWalletHoldings(owner: Address): Promise<Holding[]>;
  funding(owner: Address, need: { cashRaw: RawAmount; legs: number; newVault: boolean }): Promise<Funding>;
  quote(trade: Trade, taker: Address): Promise<Quote>;
  track(txId: string, validUntil?: string): Promise<TxStatus>;
}
interface OwnerBuilder {          // each call returns ONE transaction; the planner splits by the capabilities
  buildApprove(a: { owner: Address; spender: Address; amountRaw: RawAmount }): Promise<BasketTx>;
  buildCreateVault(a: { owner: Address; basketId: string; targets: Target[]; recipeOnchainId?: string;
    expectedVersion?: number; autoFollow: boolean; depositRaw?: RawAmount; trades?: Trade[];
    slippageBps: number }): Promise<BasketTx>;
  buildDeposit(a: { vault: Address; amountRaw: RawAmount; trades?: Trade[]; slippageBps: number }): Promise<BasketTx>;
  buildOwnerSwap(a: { vault: Address; trades: Trade[]; slippageBps: number }): Promise<BasketTx>;
  buildSetTargets(a: { vault: Address; targets: Target[] }): Promise<BasketTx>;
  buildAcceptVersion(a: { vault: Address; recipeOnchainId: string; expectedVersion: number }): Promise<BasketTx>;
  buildSetAutoFollow(a: { vault: Address; on: boolean }): Promise<BasketTx>;
  buildWithdrawInKind(a: { vault: Address; assets?: AssetId[] }): Promise<BasketTx[]>;   // always to the owner
  buildPublishRecipe(a: { creator: Address; recipe: Recipe }): Promise<BasketTx>;
}
interface KeeperBuilder {
  buildAdoptVersion(vault: Address): Promise<BasketTx>;
  buildKeeperLeg(vault: Address, trade: Trade): Promise<BasketTx>;
}
type ChainAdapter = ChainReader & OwnerBuilder & KeeperBuilder;
```

`chain-mock/src/contract.ts` holds the contract tests every adapter must pass. No builder sets a vault's keeper or operator.

On Solana, `create_vault` opens only the cash account. Each position's token account is created, idempotently, in the swap leg that first buys it. That should keep a 12-asset create inside the 1,232-byte transaction limit; the SOL stream measures create and first-buy sizes for 7 and 12 assets on Oct 3.

### 3.3 Transaction, order, legs, prepare-intent

```ts
// basket-tx.ts. His tx.ts is not edited; his fields payload, evm, chain, description,
// provenance and lastValidBlockHeight are reused.
const BasketTx = UnsignedTx.omit({ kind: true, legAssetId: true, executionId: true }).extend({
  legId, attemptId, legKind,                           // strings, LegKind
  chainId, signer, feePayer /* optional */,
  messageHash,                                         // hash of the exact bytes to sign
  preview });                                          // Sourced & { summary, simulated, feeNativeRaw,
                                                       //   changes: { holder: 'wallet' | 'vault', asset, deltaRaw }[] }

// order.ts
type LegStatus = 'planned' | 'built' | 'sent' | 'confirmed' | 'failed' | 'expired' | 'skipped';
type LegKind = 'approve' | 'create_vault' | 'deposit' | 'swap' | 'set_targets' | 'accept_version'
  | 'set_auto_follow' | 'withdraw' | 'publish' | 'adopt_version' | 'keeper_leg';
type Leg = { id: string; orderId: string | null;       // null for keeper legs
  chain: ChainId; seq: number;                         // order within its chain
  kind: LegKind; signer: 'owner' | 'keeper'; description: string; trades: Trade[];
  expected: { inRaw: RawAmount; outRaw: RawAmount; minOutRaw: RawAmount; costBps: number } | null;
  status: LegStatus; attempt: number; txId: string | null; explorerUrl: string | null;   // from the latest attempt
  validUntil: string | null; error: { code: string; message: string; retryable: boolean } | null;
  trigger: 'manual' | 'index_update' | 'drift' | 'liquidity_breach'; provenance: 'live' | 'mock' };
type Attempt = { id: string; legId: string; n: number; messageHash: string; nonce: number | null;
  status: 'built' | 'sent' | 'confirmed' | 'failed' | 'expired'; txId: string | null;
  explorerUrl: string | null; validUntil: string | null; builtAt: string };
type Owner = { solana?: Address; evm?: Address };
type Order = { id: string; type: 'buy' | 'rebalance' | 'follow' | 'publish' | 'withdraw' | 'settings';
  owner: Owner; summary: string;                       // written by the server, never caller text
  legs: Leg[]; warnings: { code: string; text: string }[];
  needsConsent: ('auto_follow_on' | 'new_asset')[];    // granted only on the approval page
  fees: { kind: string; bps: number }[];               // empty in the MVP
  preparedBy: 'app' | 'api' | 'mcp'; agentLabel?: string;   // shown as "unverified: …"
  status: 'open' | 'partial' | 'done' | 'failed' | 'expired';
  approvalUrl: string; expiresAt: number; createdAt: string; disclaimer: string };
type IntentRequest =
  | { type: 'buy'; owner: Owner; amountUsd: number; proposalId?: string; family?: string; chains?: ChainId[] }
  | { type: 'rebalance'; vaults: Address[]; reason: 'manual' | 'index_update' | 'drift' }
  | { type: 'follow'; vault: Address; family: string; autoFollow: boolean }
  | { type: 'publish'; creator: Owner; family: string; name: string; copy: string; recipes: Recipe[] }
  | { type: 'withdraw'; vaults: Address[]; sellToCash: boolean }
  | { type: 'settings'; vault: Address; autoFollow: boolean };
type Principal = { kind: 'anon' | 'user' | 'service'; userId?: string; wallets: WalletAccount[]; ip: string };
// apps/api/src/orders/prepare.ts: the one function behind the web buttons, REST, SDK and MCP
function prepareIntent(req: IntentRequest, ctx: { principal: Principal;
  adapters: Record<ChainId, ChainAdapter>; liquidity?: LiquidityProvider; now: string }): Promise<Order>;
```

Routes: `POST /v1/orders` (plans legs, builds nothing); `GET /v1/orders/{id}`; `POST /v1/orders/{id}/legs/{legId}/build` (a fresh `BasketTx` and a new attempt); `POST .../report` with `{ txId }` or `{ signedTx }`; `POST /v1/orders/{id}/consent` (signed-in owner only). Errors use his shape plus `code` and `fix`. Codes: `NOT_FUNDED`, `ASSET_NOT_ELIGIBLE`, `GOAL_NOT_ACHIEVABLE`, `NEW_ASSET_NEEDS_APPROVAL`, `VERSION_CHANGED`, `CREATOR_LIMIT`, `ORDER_EXPIRED`, `US_PERSON`, `RATE_LIMITED`, `CHAIN_UNAVAILABLE`. `MARKET_CLOSED` is a warning on an order, not an error: the owner may trade at any hour, and only keeper trades are bound to the session.

Leg rules:

- A leg is a planned step and is never duplicated. Each build is one row in `leg_attempts`; the leg's `status`, `txId`, `explorerUrl` and `attempt` mirror its latest attempt.
- Chains run in parallel; legs on one chain run in `seq` order. A leg is built just before it is signed.
- `failed` means it reverted onchain or was rejected: the decoded vault error is stored and the same bytes are never sent again. `expired` means it never landed: the next build is a new attempt with a fresh quote.
- An order is `partial` when one chain is done and another has a failed leg.
- An unsigned order expires after 15 minutes. Once its first leg is signed it stays open for 24 hours.
- Every attempt carries its explorer link and provenance, which is his rule that every mainnet transaction is logged.

### 3.4 How `LiquidityProvider` is used

His interface and his `apps/api/src/liquidity.ts` are unchanged. A new `loadCurves(db, keys, methodVersions)` in `packages/db` reads his curve tables for `['risk-0.3', 'evmq-0.1']`, and `apps/api/src/basket-liquidity.ts` wraps his `createLiquidityProvider` so callers pass an `AssetId`. Curve keys are the bare mint on Solana and `${ChainId}:${lower-case address}` on EVM.

His provider ignores the window argument today (`packages/risk/src/provider.ts`). Every call returns the worst of all measured regimes, the weekend included, and `exitCost` is `null` if any regime lacks that size. So every number from it is labelled "worst regime".

| Caller | Call | Used for |
|---|---|---|
| `compose` (engine) | `exitCapacity(asset, 0.01)` × 0.25 | Dollar ceiling per token |
| `rollUp` (basket) | `exitCost(asset, legUsd)`, `entry()` | Exit cost at your size, worst regime |
| `scripts/ops/sync-asset-caps.ts` | `exitCapacity(asset, 0.01)` | Onchain `maxWeightBps` |

`null` is shown as "not measured", never as zero. The keeper does not call the provider in the MVP: it skips a leg whose live quote costs more than the vault's tolerance against the reference price. A per-regime method (`exitCostIn(asset, usd, regime)`) is the later addition that lets it act on his curves.

### 3.5 Keeper job and wallet

```ts
// The keeper plans from chain state and signs in the same pass. A keeper_legs row is its own log
// and idempotency key, unique on (vault_id, keeper_run_id, seq). It never signs from a stored row.
interface Submitter { chain: ChainId;
  submit(leg: Leg): Promise<{ txId: string; validUntil?: string; nonce?: number }>;
  status(txId: string, validUntil?: string): Promise<'pending' | 'confirmed' | 'reverted' | 'expired'>; }
interface Signer { address(family: Chain): string; sign(family: Chain, tx: BasketTx): Promise<string>; }

// wallet.ts (no Privy types)
type WalletAccount = { family: Chain; address: string; kind: 'embedded' | 'external' };
interface WalletPort {
  status: 'loading' | 'signed-out' | 'ready'; userId: string | null; accounts: WalletAccount[];
  active(family: Chain): WalletAccount | null;
  caps(chain: ChainId): { silent: boolean; batchSign: number; signOnly: boolean };
  signIn(method: 'passkey' | 'wallet'): Promise<void>; signOut(): Promise<void>;
  sign(chain: ChainId, txs: BasketTx[]): Promise<string[]>;         // Solana any wallet; EVM embedded
  send(chain: ChainId, tx: BasketTx): Promise<{ txId: string }>;    // EVM external
  exportKey(family: Chain): Promise<void>; authHeaders(): Promise<Record<string, string>>; }
// throws WalletError { code: 'rejected' | 'expired' | 'no_gas' | 'wrong_chain' | 'unknown' }
```

### 3.6 Personalization and `packages/basket`

```ts
type BasketSheet = { basketType: 'standard'; goal: 'grow' | 'income' | 'protect';
  amountUsd: number;             // 10 to 1,000,000
  horizonMonths: number;         // 1 to 480
  risk: 'low' | 'medium' | 'high'; themes: string[];   // up to 3 family slugs
  country: string;               // ISO two-letter, self-declared
  chains: ChainId[]; incomeTargetUsdMonthly?: number;
  rules: { useHoldings: boolean; glide: boolean }; language: Language };
type Shelf = { version: string; assets: BasketAsset[]; families: { meta: FamilyMeta; recipes: Recipe[] }[] };
type PersonalParams = { version: string;               // Rodrigo owns the numbers
  sleeves: Record<string, { growthBps: number; dollarYieldBps: number; goldBps: number }>;   // key `${goal}:${risk}`
  glideFloor: { monthsLeft: number; dollarYieldBps: number }[];
  capPerStockBps: Record<string, number>; capPerIssuerBps: Record<string, number>;           // key risk
  tierCeilingUsd: Record<'A' | 'B' | 'C', number>; shareOfDepth: number; tau: number;
  minLineBps: number; maxLinesPerChain: number };      // 50 and 8 in the MVP
type Reason = { rule: string; inputs: string[]; params: Record<string, string | number>; text: string };
type BasketLine = { chain: ChainId; assetId: AssetId; viaIndex?: string; weightBps: number;
  amountUsd: number; reasons: Reason[] };
type BasketCard = { moneyTodayUsd: number; termMonths: number; cashFlow: 'none' | 'monthly' | 'at_end';
  expectedReturn: { lowPct: number; highPct: number; basis: string; lossInFallUsd: number };
  exit: { text: string; costBps: number | null } };
type Verdict = { met: boolean; gapUsdMonthly: number; ways: { change: string; closesGap: boolean }[] };
type ObservationRef = Sourced & { id: string; kind: 'yield' | 'price' | 'liquidity' };
type BasketProposal = { sheet: BasketSheet; engineVersion: string; paramsHash: string; shelfVersion: string;
  inputsHash: string; lines: BasketLine[];             // sum 10_000
  recipes: { chain: ChainId; amountUsd: number; components: Component[] }[];
  removed: { ref: string; reasons: Reason[] }[]; card: BasketCard; verdict?: Verdict;
  flags: string[]; observations: ObservationRef[]; disclaimer: string };
// packages/engine/src/personal/index.ts: pure. No clock, no network, no env. Calls flatten() from basket.
function compose(i: { sheet: BasketSheet; holdings: Holding[]; shelf: Shelf; yields: YieldObservation[];
  liquidity?: LiquidityProvider; params: PersonalParams; now: string }): BasketProposal;

// packages/basket
type Share = { key: string; bps: number };
type LimitContext = { assets: BasketAsset[]; now: number; lastPublishAt: number | null;
  turnoverBps: number; turnoverAt: number; hasPending: boolean };
type LimitResult = { ok: true; turnoverBps: number } | { ok: false; code: string; detail: string };
type RollUpContext = { shelf: Shelf; liquidity?: LiquidityProvider; quotes: Quote[] };
type RiskRollUp = { byIssuer: Share[]; byChain: Share[]; byClass: Share[]; flags: string[];
  exit: { quotedBps: number | null; quotedAt: string | null; measuredWorstBps: number | null; measuredShareBps: number } };
function flatten(recipe: Recipe, shelf: Shelf, p: { minLineBps: number; maxLines: number }): Target[];
function view(v: VaultState, prices: Price[]): VaultView;
function planRebalance(v: VaultState, targets: Target[], prices: Price[],
  policy: { bandBps: number; minTradeUsd: number }): Trade[];   // sells first, every trade through cash
function checkCreatorLimits(prev: Target[] | null, next: Target[], ctx: LimitContext): LimitResult;
function rollUp(lines: { asset: AssetId; amountUsd: number }[], ctx: RollUpContext): RiskRollUp;
function metaHash(family: FamilyMeta): string;
```

### 3.7 Solana program (`programs/basket`, `idl/basket.json`)

One Anchor program (0.31.1, the version the spike builds on) holds the vaults, the registry and the asset list. A program-derived account (PDA: an address only the program can sign for) per plan stores the state and signs swaps. The TypeScript builders in `chain-solana` are written by hand on `@solana/kit` 2.3, and a test decodes every built instruction against the IDL.

```rust
// seeds: ["config"] | ["assets"] | ["recipe", creator, family_id] | ["vault", owner, basket_id u64 LE]
pub struct Config { admin, pending_admin, guardian, default_keeper: Pubkey, keeper_paused: bool,
  launched: bool,                                  // one-way; raises the floor on publish_delay_s
  tolerance_bps: u16, loss_cap_bps: u16, band_bps: u16, twap_dev_bps: u16, max_price_age_s: u16,
  asset_cooldown_s: u32, publish_delay_s: u32, session_open_utc_s: u32, session_close_utc_s: u32,
  closed_until: i64, closed_days: [u16; 32] /* days since 1970, UTC */, reserved: [u8; 64] }
pub struct AssetRegistry { price_accounts: [Pubkey; 4], count: u8, assets: [AssetEntry; 64] }  // zero-copy
pub struct AssetEntry {                            // padded to 96 bytes
  mint: Pubkey, price_slot: u8, price_index: u16, twap_index: u16, decimals: u8,
  price_kind: u8 /*0 none, 1 scope*/, session: u8 /*0 always, 1 US hours*/, max_weight_bps: u16, flags: u8,
  source_check: [u8; 32] /* zero = off; section 5 */, reserved: [u8; 21] }
pub struct Recipe { creator: Pubkey, family_id: [u8; 32], current: RecipeVersion, pending: RecipeVersion,
  last_publish_ts: i64, turnover_ts: i64, turnover_bps: u16, max_fee_bps: u16, flags: u8,
  vetoed: bool, reserved: [u8; 32] }
pub struct RecipeVersion { version: u32, effective_at: i64, meta_hash: [u8; 32], count: u8,
  components: [Component; 12] }                    // Component { mint: Pubkey, weight_bps: u16 }
pub struct Vault {                                 // Borsh; this field order is frozen for memcmp filters
  owner: Pubkey /*offset 8*/, recipe: Pubkey /*40; default = none*/, accepted_version: u32 /*72*/,
  auto_follow: bool /*76*/, basket_id: u64, bump: u8, keeper: Pubkey /*default = Config's*/, count: u8,
  positions: [Position; 16], loss_accum: u64, loss_ts: i64,
  reserved: [u8; 128] }                            // byte 0 is the vault type; 0 = standard
pub struct Position { mint: Pubkey, target_bps: u16, tracked: u64, last_keeper_ts: i64 }
```

| Who | Instructions |
|---|---|
| Owner | `create_vault(basket_id: u64, targets: Vec<Target>, auto_follow: bool, expected_version: u32)` (with a recipe account passed, it copies the active version if its number matches); `deposit(amount: u64)`; `owner_swap(max_in: u64, min_out: u64, data: Vec<u8>)`; `withdraw(amount: u64)` (one mint per call; the destination token account must belong to the owner); `close_vault()` |
| Owner | `set_targets(targets)` (clears `recipe`, auto-follow off); `accept_version(expected_version: u32)` (follows the passed recipe at exactly that active version; new assets allowed); `set_auto_follow(on: bool)`; `set_keeper(keeper: Pubkey)` (reserved; no builder, and the guard refuses it) |
| Keeper | `keeper_leg(amount_in: u64, data: Vec<u8>)`. The program computes the minimum output. It needs auto-follow on and stored targets, not a recipe or a new version |
| Anyone | `adopt_version()` (weights-only change, after the delay, auto-follow on); `sync_balances()` |
| Creator | `publish_recipe(family_id: [u8; 32], components, meta_hash, max_fee_bps: u16, flags: u8)` (both must be zero); `update_recipe(components, meta_hash)`; `cancel_pending()` |
| Guardian | `pause_keeper()`; `veto_pending()`; `extend_closed_until(ts: i64)`; `add_closed_day(day: u16)`. Each can only tighten |
| Admin | `init_config(..)` and `init_assets()` (signer must be the upgrade authority); `set_params(..)`; `launch()`; `unpause_keeper()`; `set_closed(..)`; `set_guardian(..)`; `upsert_asset(entry)`; `propose_admin`, `accept_admin` |

- `withdraw` and `owner_swap` take no Config, registry or price account. A pause or a dead feed cannot block the owner.
- The swap target must be Jupiter's program id with selector `route_v2` or `shared_accounts_route_v2`, or the two legacy selectors the spike used. Bytes and accounts are forwarded as in the spike.
- Every instruction derives the associated token account for (vault, mint, the mint's own token program) and rejects any other account. The account list may hold exactly two token accounts owned by the vault, the input and the output; after the call their owner, delegate, close authority and data length must be unchanged. Anything else is `AccountTampered`.
- `set_params` enforces hard-coded bounds: tolerance at most 300 bps, loss cap at most 500 bps, cooldown at least 600 s, publish delay at least 60 s before `launch()` and at least 172,800 s after. The numbers the app shows cannot move past these without an upgrade.
- Errors, order frozen, append only: `NotKeeper, AutoFollowOff, KeeperPaused, MintNotAccepted, RouterNotAllowed, SpentTooMuch, ReceivedTooLittle, OtherAccountDebited, AccountTampered, PriceStale, PriceDeviation, MarketClosed, MultiplierWindow, NotTowardTarget, PastTarget, Cooldown, LossCapReached, AssetNotPriced, NewAssetNeedsOwner, VersionNotEffective, CreatorLimit, VersionMismatch, WrongDestination, ParamOutOfBounds`.
- Events, same names on EVM: `VaultCreated`, `Followed`, `Unfollowed`, `VersionAdopted`, `TargetsSet`, `KeeperTrade`, `RecipePublished`, `VersionCancelled`.

### 3.8 EVM contracts (`contracts/src/interfaces/`)

```solidity
struct Weight { address token; uint16 bps; }                  // sorted by token, no duplicates
struct Swap   { address router; address tokenIn; address tokenOut;
                uint256 amountIn; uint256 minOut; bytes data; }
struct AssetConfig { address feed; uint8 tokenDecimals; uint8 feedDecimals; uint32 maxAge;
                     uint8 session; /* 0 always, 1 US stocks */ uint8 source; /* 0 none, 1 Chainlink */
                     uint16 maxWeightBps; address pauseProbe; bytes4 pauseSelector;
                     bytes4 scheduleSelector; /* called on the token; 0 = none */ uint64 haltUntil; }
struct Limits { uint8 minAssets; uint8 maxAssets; uint16 minWeightBps; uint16 maxWeightBps; uint16 stepBps;
                uint16 maxDeltaBps; uint16 maxTurnoverBps; uint16 maxWeeklyTurnoverBps;
                uint32 minInterval; uint32 publishDelay; }
struct Snapshot { address owner; bytes32 indexId; uint32 acceptedVersion; bool autoFollow; address operator;
                  address[] tokens; uint16[] targetBps; uint256[] balances;
                  uint256[] prices; /* USD per whole token, 1e18 */ uint64[] priceUpdatedAt;
                  uint64[] lastKeeperAt; uint16 lossUsedBps; }

interface IBasketVault {
  // owner only: no pause, no feed; withdraw calls neither factory nor registry and pays only the owner
  function deposit(address token, uint256 amount) external;
  function withdraw(address token, uint256 amount) external;
  function withdrawAll() external returns (address[] memory skipped);
  function ownerSwap(Swap[] calldata swaps) external;           // allowlisted router; own balance deltas and minOut
  function setTargets(Weight[] calldata targets) external;      // clears the index, auto-follow off
  function acceptVersion(bytes32 indexId, uint32 expectedVersion) external;
  function setAutoFollow(bool on) external;
  function setOperator(address operator) external;              // reserved; no builder, and the guard refuses it
  function multicall(bytes[] calldata data) external returns (bytes[] memory);
  // anyone, when auto-follow is on and the active version only changes weights
  function adoptVersion() external;
  // keeper only; needs auto-follow on and stored targets, not an index
  function keeperSwap(Swap calldata s) external returns (uint256 spent, uint256 received);
  function snapshot() external view returns (Snapshot memory);
}
interface IVaultFactory {
  function createVault(bytes32 salt, Weight[] calldata targets, bytes32 indexId, uint32 expectedVersion,
      bool autoFollow) external returns (address vault);        // indexId != 0: targets must be empty
  function createVaultAndBuy(bytes32 salt, Weight[] calldata targets, bytes32 indexId, uint32 expectedVersion,
      bool autoFollow, uint256 cashAmount, Swap[] calldata swaps) external returns (address vault);
  function vaultOf(address owner, bytes32 salt) external view returns (address);  // known before it exists
  function vaultCount() external view returns (uint256);
  function vaultAt(uint256 i) external view returns (address);
  function vaultsOf(address owner) external view returns (address[] memory);
  function asset(address token) external view returns (AssetConfig memory);
  function assets() external view returns (address[] memory);
  function routerPull(address router) external view returns (uint8);   // 0 no, 1 direct, 2 Permit2
  function keeper() external view returns (address);            // also guardian(), cashToken(), sequencerFeed()
  function keeperPaused() external view returns (bool);
  function launched() external view returns (bool);
  function closedUntil() external view returns (uint64);
  function closedDay(uint32 day) external view returns (bool);  // days since 1970, UTC
  function params() external view returns (uint16 toleranceBps, uint16 lossCapBps, uint16 bandBps,
      uint32 assetCooldown, uint32 sessionOpen, uint32 sessionClose);
  // guardian: each call can only tighten. Only the admin unpauses, shortens, removes or rotates the guardian
  function pauseKeeper() external;
  function haltAsset(address token, uint64 until) external;
  function extendClosedUntil(uint64 until) external;
  function addClosedDay(uint32 day) external;
}
interface IIndexRegistry {
  function create(bytes32 familyId, Weight[] calldata c, bytes32 metaHash, uint16 maxFeeBps, uint8 flags)
      external returns (bytes32 id);                            // id = keccak256(abi.encode(creator, familyId))
  function publish(bytes32 id, Weight[] calldata next, bytes32 metaHash)
      external returns (uint32 version, uint64 effectiveAt);
  function cancel(bytes32 id) external;                         // creator or guardian, pending only
  function active(bytes32 id) external view returns (uint32 version, Weight[] memory components);
  function pending(bytes32 id) external view
      returns (uint32 version, uint64 effectiveAt, Weight[] memory components);
  function creatorOf(bytes32 id) external view returns (address);
  function indexCount() external view returns (uint256);
  function indexAt(uint256 i) external view returns (bytes32);
  function previewPublish(bytes32 id, Weight[] calldata next) external view
      returns (bytes4 err, uint16 turnoverBps, uint16 maxDeltaBps, uint64 nextAllowedAt);
  function limits() external view returns (Limits memory);
}
event RecipePublished(bytes32 indexed id, uint32 indexed version, address indexed creator,
                      Weight[] components, uint64 effectiveAt, uint16 turnoverBps, bytes32 metaHash);
event KeeperTrade(address indexed vault, address tokenIn, address tokenOut,
                  uint256 spent, uint256 received, uint256 lossUsd, uint16 lossUsedBps);
// VersionCancelled, VaultCreated, Followed, Unfollowed, VersionAdopted, TargetsSet: vault and id indexed
```

- Each vault is an OpenZeppelin `BeaconProxy`, one beacon per chain. Factory and registry are UUPS proxies. ERC-7201 namespaced storage; `_disableInitializers()` in every logic constructor.
- Every proxy is created with its init call inside its constructor, and the beacon with its owner. The admin address is therefore part of the creation code, so anyone who replays our code and salt on another chain gets our admin, not theirs.
- `active()` switches to the pending version at `effectiveAt` with no transaction. The registry keeps current and pending only; history is in events. Its `publishDelay` is an admin parameter whose floor depends on the factory's `launched()`.
- `ownerSwap` requires `routerPull(router) != 0`. The factory may call `ownerSwap` only inside `createVaultAndBuy`. No `tx.origin` checks anywhere.
- One reentrancy guard covers every state-changing vault function. `multicall` is `MulticallUpgradeable`, which ships in 5.6.1 **[C 5]**. The vault never implements ERC-1271 (`isValidSignature`), or the router's Permit2 command would become usable from the keeper's call data; a test pins this.
- `withdrawAll` uses a low-level call per token and treats a revert or a `false` return as skipped.
- The factory enforces the same parameter bounds as the Solana program, and `flags` and `maxFeeBps` must be zero in `create`.
- Every refusal is a typed error carrying the numbers, named as on Solana where the rule is the same.
- Pins: Foundry v1.8.3, forge-std v1.17.0, OpenZeppelin Contracts 5.6.1 (5.7.0 has no audit report yet), solc 0.8.30, `evm_version = "cancun"`, `via_ir`. ABIs are generated into `packages/chain-evm/src/abi/*.ts` and committed, so the TypeScript CI needs no Foundry.

## 4. Data model

**New tables** (`packages/db/src/basket-schema.ts`, migration `0006`). They cache chain state and hold off-chain text. The chains are the source of truth. No table of his changes.

| Table | Key columns |
|---|---|
| `chains` | text id (`solana`, `base`, `robinhood`), seeded from `content/chains.json`; every `chain_id` column is text with a foreign key here |
| `users`, `user_wallets` | `privy_id`; `(family, address)` unique, `kind`; written only from a verified identity token |
| `consents` | order id, address, kind, text version, a hash of the legs it covers, time |
| `basket_assets` | id `chain:slug`; `(chain_id, address)` unique; class, underlying, issuer, tier, price source, session, `max_weight_bps`, `blocked_countries` |
| `index_families` | `family_id`, slug, a folded-name key (unique), name, copy, `creator_user_id`, `creator_kind`, `kind` (`index`, `single`), `platform` badge, `params jsonb` |
| `recipes`, `recipe_versions` | family, chain, onchain id; version, components, `meta_hash`, `effective_at`, status, nullable `fee_bps` |
| `baskets`, `proposals` | user, kind (`personal`, `follow`), family; the stored `BasketProposal` keyed by `inputs_hash` |
| `vaults` | `(chain_id, address)` unique; owner, plan, recipe, accepted version, auto-follow, targets, balances, `value_usd`, `vault_type`, `observed_at` |
| `follows` | user, family: the watchlist and pending prompts |
| `orders`, `legs`, `leg_attempts` | the `Order`, `Leg` and `Attempt` fields; nullable `org_id` on orders; attempts carry `message_hash`, `nonce`, his provenance columns, nullable `fee_amount`, unique `(chain_id, tx_id)` |
| `keeper_runs`, `keeper_legs`, `keeper_vaults` | one open run per chain (a partial unique index, which works through any connection pooler); the keeper's own leg log; `synced_version` per vault |
| `price_observations` | asset, value, his `source`, `method`, `fetched_at`, `provenance` |
| `idempotency_keys` | as named |

Three Postgres roles. `api` can read the keeper tables and not write them. `keeper` writes only the keeper tables and its attempts. `collector` writes only the risk tables. Supabase's Data API is switched off, because it exposes `public` tables to anonymous callers by default (security review, checked against Supabase's docs).

Units: weights are integer basis points; token amounts are raw units in `numeric(78,0)`; dollars are display values only.

**Onchain.** Solana: the accounts in 3.7. A vault is about 1.06 KB (0.0060 SOL rent) plus a token account per asset (about 0.0015 SOL); a 12-asset vault costs about 0.027 SOL, refundable. EVM: a proxy per vault holds owner, portfolio id, accepted version, auto-follow, operator, targets, last keeper time per asset and the loss counter. The factory holds asset config, the router allowlist, keeper, guardian, closed days and parameters.

**Reading state, with no events.** EVM: `vaultsOf`, `vaultAt`, `snapshot()`, `indexAt` and `active()` through Multicall3. Solana: `getProgramAccounts` with `memcmp` at offset 8 for the portfolio, and at offsets 40 and 76 for the keeper.

## 5. Vault rules per chain

**The owner can always** deposit, swap with their own signature and slippage through an allowed router, set targets, switch auto-follow, and withdraw every token in kind to their own wallet. Withdrawal is per token and calls no router, feed, factory or registry. Only a program or beacon upgrade can block it. Owner trades are allowed at any hour; outside the session the app shows a warning.

**The keeper can call one function,** and the vault checks each call. Starting values are not yet calibrated.

| # | Check | Solana | EVM | Parameter, start |
|---|---|---|---|---|
| 1 | Caller and switch | Signer is `vault.keeper` or Config's default; auto-follow on | Caller is `operator` or the factory's keeper; auto-follow on | none |
| 2 | Recipe assets only | Both mints are in `positions` or are the cash mint | Both tokens accepted, each with a feed | none |
| 3 | Balance change | Own input and output accounts read before and after; no third vault token account; no delegate, close authority or size change after | Exact approval, zeroed after, Permit2 included; own balance deltas; no other accepted asset fell | none |
| 4 | Value, per trade | `value(received) ≥ value(spent) × (1 − tolerance)` from two Scope entries; USDC counts as $1 | Same from two Chainlink feeds; cash counts as $1 while its feed is within 0.5% of $1 | 75 bps Solana, 125 bps EVM |
| 5 | Toward target | Sell only if overweight, buy only if underweight, stop inside the band. Vault value = Σ `tracked × price` | Same | band 50 bps |
| 6 | Cooldown | Per non-cash asset | Same | 3,600 s |
| 7 | Weekly loss cap | Lost value added to a counter that decays linearly over 7 days | Same | 200 bps of vault value |
| 8 | Fresh price | Scope entry at most 120 s old, and within `twap_dev_bps` of Scope's 1-hour average | `answer > 0` and `updatedAt` within `maxAge`; Base also checks the sequencer feed | 120 s and 200 bps (placeholder); 26 h for EVM stocks |
| 9 | Market open | Clock inside the session; not a closed day; past `closed_until` | Same, from `block.timestamp`; plus the pause probe and `haltUntil` | Mon to Fri, 14:30 to 20:00 UTC |
| 10 | Multiplier window | Not within 24 h of the mint's scheduled multiplier change | Robinhood Chain: not within 24 h of the token's own `effectiveAt()` **[C 13]**. Base: the guardian sets `haltUntil` from the issuer's schedule | 24 h |
| 11 | Pause | `Config.keeper_paused` | `keeperPaused()` | guardian pauses, admin unpauses |

The session window sits inside the New York session in summer and winter time, so there is no daylight-saving code. Closed days are loaded at deploy from his `fixtures/risk/us-market-holidays.json`, as far ahead as it runs, with half days counted as closed. A fresh-looking feed on a holiday then fails check 9.

**What the cap does and does not bound.** Checks 4 and 7 are measured at the reference price. If the reference is wrong by X, a leg can lose X plus the tolerance while the counter records only the tolerance. Check 5 limits this to assets that are truly off target. The app's trust notice says "plus any error in the price reference".

**New versions.** After `effectiveAt`, anyone may call adopt on an auto-follow vault if the version only changes weights among accepted assets. If it adds an asset, the call fails with `NewAssetNeedsOwner` and the owner taps accept. Accept and create both name the version the person reviewed and revert with `VersionMismatch` if the active version has moved on. Accept before `effectiveAt` reverts with `VersionNotEffective`.

**Solana specifics.**

- `anchor_spl::token_interface` and `transfer_checked` everywhere, which covers classic SPL and Token-2022 (the newer token program with optional extensions).
- SPYx carries pausable, a freeze authority, a permanent delegate, a scaled UI amount, and a transfer-hook extension with no program set. So `tracked` is a hint that `sync_balances` repairs from the one derived token account; `upsert_asset` rejects a mint with a hook program; `withdraw` forwards extra accounts in case the issuer adds one.
- One swap leg per transaction. Mainnet's instruction stack limit is 5 levels, counting the transaction's own instruction as level 1 **[C 15]**; the spike's route reached level 4. The spare level is kept for a deeper route or a transfer hook, so a keeper leg is never wrapped in another program.
- Scope is parsed by hand (its crate is BUSL-licensed). Kamino can remap an index, so the keeper re-derives each asset's `(account, index)` before a run. That check is off-chain. If the Oct 2 Scope read confirms the layout of Scope's mappings account (memory), `keeper_leg` also compares the mapping entry at the pinned index with `source_check`. If not, the field stays zero and the gap is listed in `docs/vault/SECURITY.md`.

**EVM specifics.** Raw units everywhere; the feeds already include the multiplier. Decimals (18 on Robinhood Chain, 8 on Base) are passed in config, never read from the token. Robinhood Chain swaps go through Universal Router 2.1.2 (`0x204FAca1764B154221e35c0d20aBb3c525710498`) on hookless pools. Base uses our hardened `SlipstreamAdapter`: it checks `pool.factory()`, sends output only to `msg.sender` and holds nothing. Robinhood Chain has no sequencer feed; that risk is accepted.

## 6. Shared-portfolio registry and creator limits

- Onchain and small: creator, family id, version, components, effective time, `metaHash`, creator counters. Names and copy stay in Postgres.
- A multi-chain shared portfolio is a family with one recipe per chain, tied together by `familyId`.
- A family row is created or renamed only after its publish transaction confirms and its creator matches the signed-in wallet. Names are ASCII in the MVP. Uniqueness is checked on a folded key (lower case, spaces and punctuation removed, look-alike digits mapped to letters), and the launch names are reserved.
- Cards, the approval page and the server-written summary show the creator address and a platform badge, set from the platform creator address. Shared portfolios rank by value following. The follower count includes only vaults holding $10 or more, since an empty vault costs almost nothing to make.
- Following is the vault pointing at a recipe.
- The 500 holds one asset, so it is not a registered shared portfolio. It sits on the shelf as a single-asset portfolio (`kind: 'single'`): a vault with one target and no recipe. The registry keeps one rule set and no admin exception.

Limits, checked by the registry. Constants, not per-portfolio settings. Shape limits and `maxWeightBps` apply from version 1; change limits from version 2.

| Limit | Value |
|---|---|
| Assets | 3 to 12, platform list only, each 2% to 50%, in 50 bps steps |
| Change per asset per version | 10 points, including adds and removals |
| Turnover | 20% per version; 60% per 7 days, on a counter that decays linearly over 7 days, the same on both families |
| Frequency | One version per 24 hours; none while one is pending |
| Delay | `publishDelay`, 48 hours after `launch()`; computed by the registry, checked by the vault |
| Cancel | The creator or the guardian can cancel a pending version. A cancel gives back neither the 24-hour slot nor the turnover |

**The cap from measured exit capacity.** Each listed asset has `maxWeightBps` in the onchain asset list. The registry rejects a component above `min(5000, maxWeightBps)`. An ops script sets it from Rodrigo's curves:

`maxWeightBps = 10_000 × shareOfDepth × exitCapacity(asset, τ) / indexCapacityUsd`, rounded down to a 50 bps step,

with `shareOfDepth` 0.25 and `τ` 1% (his values), and `indexCapacityUsd` $250k on Solana and $50k on the EVM chains (from `creator-limits.md`). An asset with no measured curve keeps the ceiling of its shelf tier. The first values are written in the deploy session on Oct 5.

Caps follow the curves, so a cap can fall below a live weight. A component above its cap is then allowed if it does not rise and falls by the lesser of 10 points or the distance to the cap. Without this rule a shared portfolio whose cap dropped by more than 10 points could never publish again.

`previewPublish` and `limits()` let an agent check before paying for a transaction. The TypeScript check, the Solana program and the EVM registry share one file of test vectors, including a week boundary, a cap below a live weight and a non-zero `flags`.

## 7. Personalization engine

Rodrigo's `solve()`, parser, registry and `ConstraintSheet` are not edited; they are tied to reais and eight Solana assets. A new module `packages/engine/src/personal/` sits beside them and reuses `applyHaircut`, `YieldObservation`, `LiquidityProvider` and `Language`. His baseline snapshot test stays green.

Who builds it: one of Thom's agents ports the working prototype (`docs/vault/research/design-v2/personalization-proto/`) into the module on Oct 2 and 3 with placeholder numbers, as new files only, so the three-profile test is green early. Rodrigo then reviews it and owns the parameter table and the template wording. The package has no `exports` map, so the API imports the module by path until he adds an export line.

Three pure steps. **Exposure:** how big each sleeve is (stocks and crypto, dollar yield, gold) and what is inside it. **Placement:** which chain's token carries each exposure. **Packaging:** one recipe per chain in basis points, a reason on every line, the five-field card.

| Input | Rule | Reason shown |
|---|---|---|
| Goal, risk | A table gives the three sleeve sizes | "70% dollar yield: income goal, medium risk" |
| Time frame | A floor on dollar yield that rises as the date nears | "40% dollar yield: you need this in 18 months" |
| Themes | Decide what is inside each sleeve | "From Sand to Server" |
| Holdings | Target is set on amount plus holdings, then holdings are subtracted | "No NVDA: you already hold $4,000" |
| Risk | Cap per single stock and per issuer | "Split over two issuers: 70% cap" |
| Amount | Dollar ceiling per token = min(tier ceiling, 0.25 × exit capacity); overflow goes to the same exposure on another chain, then to dollar yield | "Gold on Solana limited to $10,000" |
| Country | Blocked tokens are skipped; the same exposure is taken on another chain if one exists | "On Robinhood Chain: the Solana token is not offered in X" |

- A prototype over the launch shelf passes the handoff's test: three people, three plans, and each input alone moves the plan and adds a reason naming it. Its numbers are placeholders for Rodrigo.
- A plan holds at most 8 lines per chain in the MVP. The vault itself allows 16.
- **The card:** money needed today; expected return (a yield range on the dollar-yield share; stocks and gold assume no return, plus the dollar loss in a 20% fall); total term; cash-flow pattern; when you can get out. Income goals add a verdict with the gap and each way to close it.
- **The model** fills `BasketSheetDraft` (every field nullable) and nothing else: Claude Haiku 4.5 on Anthropic's Messages API with structured outputs, about $0.002 a parse **[C 11]**. The call lives in `apps/api/src/llm.ts` with a 6-second timeout and a daily budget.
- Checks after the model, in pure code: the amount and time frame must appear in the text; themes must be shelf slugs; any disagreement with the regex parser is flagged per field. The form is always the confirm step. Model down: the regex parser pre-fills it. That fails: it opens with defaults.
- Shared portfolio names never reach the model. Explanation text is one template per rule, in English and Portuguese. A 12-goal evaluation set guards the parser.
- A test bans "recommend", "suitable" and "best for you" in templates; the disclaimer stays in its one constant (section 17). This is positioning only: a plan built from a person's circumstances can count as advice whatever the wording.

## 8. Risk sheet

**Per asset.** Rodrigo writes one sheet per issuer family in `content/risk-sheets/` (xStocks, Robinhood stock tokens, Coinbase stock tokens, each dollar-yield token, gold, the crypto majors: about ten files). Each covers the issuer, what backs the token, how you exit, issuer powers (pause, freeze, seize), who can hold it, incidents, sources and the date reviewed. The per-asset fields (address, price feed, token extensions, decimals) are generated from the asset list and chain reads. Liquidity numbers are computed, not written.

**Roll-up** (`rollUp`): concentration by issuer, chain and class; exit cost at the person's size; flags. It shows two exit numbers, because the audit found they differ several times over on Solana:

- **Quoted:** the latest stored quote at the nearest size, shown with its time. On Solana these are his 15-minute Jupiter snapshots; on EVM the collector's rows. A live quote is made only when an order is planned or a leg is built.
- **Measured, worst regime:** `LiquidityProvider.exitCost`. What the measured pools alone would give on a bad day.

The roll-up states the share of the plan that is measured.

**Solana.** His risk layer as it stands: four pool decoders, cost curves by time-of-week regime, LP concentration. It covers xStocks only; dollar-yield tokens show the quoted number alone. Rodrigo's side fixes three things before anything public reads it: the request that freezes the API (`POST /risk/positions/assess`), the hourly import that grows until it runs out of memory, and a regime with too few samples counting as zero capacity.

**EVM depth source** (`scripts/risk-evm/collect.ts`, free RPC):

- v3-style pools (Uniswap v3, Aerodrome Slipstream): a 30-line quoter that reverts inside the swap callback, injected with an `eth_call` state override and never deployed. v4 pools: the deployed v4 Quoter, eight sizes in one Multicall3 call.
- It picks the deepest dollar pools per token from DexScreener, quotes his size grid, keeps the best single pool per size, and writes `risk_asset_snapshots` rows in his shape with `method_version = 'evmq-0.1'`. Cost is against the pool's own mid, because the feed lags.
- His `scripts/risk/compute.ts` already fits every row. It needs about six lines so curves keep the snapshot's method version; that change is his.
- Measured today in session, selling $10k and $50k: Robinhood NVDA 0.01% and 0.07%; Base NVDAc 0.03% and 0.14%. The method is "best single pool", so cost is overstated when liquidity is split.
- The collector runs hourly from Oct 2, which gives weekend and weekday regimes by Oct 5. A 28-day backfill on dRPC's free archive works but is out unless a stream is idle.

**Where the data runs.** His collectors stay on his Mac. The hosted database gets a dated dump of his curves first; an hourly copy job is a later add. Every sheet shows the date of its curves; stale curves are never shown as live.

## 9. Wallets and signing

- **Privy**, free plan (0 to 499 monthly users) **[C 7]**. Login methods `passkey` and `wallet`. Embedded Solana and EVM wallets created on login, `showWalletUIs: false`. Chain 4663 is a viem `defineChain` with our own RPC URL.
- **One origin, decided by Oct 4 evening.** Passkeys bind to a domain and Privy does not accept a wildcard such as `*.vercel.app` **[C 7]**. Either a custom domain (about $10 a year, a person's decision under "free tiers only"), which lets the host change later, or one fixed Vercel project URL confirmed with Privy on Oct 2. No real wallet is created before that, and each demo wallet's key is exported once as the recovery path.
- **Packages:** `@privy-io/react-auth` 3.46.0, `viem` 2.56.0, and `@solana/kit` 3.0.3 or newer in `apps/web` only **[C 8]**. Remove wallet-adapter and `@solana/web3.js` 1.x. Two kit versions coexist (2.3 in `chain-solana`, 3 or newer in the web) and never meet: the web gets bytes.
- **One person, three chains.** One Privy user id; a Solana address and one EVM address that serves both EVM chains. A vault's owner is the active wallet of that family at creation and never changes.
- **API sign-in.** `plugins/auth.ts` verifies two Privy tokens locally with `jose`: the access token, which names the user, and the identity token (`privy-id-token`, ES256, switched on in the dashboard), which lists the linked wallets **[C 7]**. Wallets are read only from the identity token, never from what the client says. The `aud` claim is pinned to the app id of each environment. No Privy secret on the server.

| Wallet | A three-chain buy |
|---|---|
| Passkey (embedded) | Reads our review screen, taps once. Each leg is built fresh, checked by the guard, signed with no pop-up and sent |
| External, Solana | One prompt signs up to three legs; they are relayed in order; a leg that misses is rebuilt |
| External, EVM | First buy per chain: `approve`, then `createVaultAndBuy`. Later: one `multicall` |

"One confirmation" is literally true only for the passkey wallet. The demo uses it.

- **No session signers and no Privy agent authorization.** Both hand a server or an agent the owner's full signing power, and the owner path has no limits in the vault.
- **The guard.** A passkey wallet signs with no pop-up, so the guard is the only check between a compromised API and the owner's key. It lives in `packages/sdk/src/guard/`, with program id, selectors and deployment addresses generated from `idl/` and the committed ABIs, and it runs inside the one leg executor that the web and the SDK share.
  - Solana, top level: compute budget; associated-token create-idempotent for the owner or the owner's vault; our program's instructions except `set_keeper`, with the owner as signer and fee payer. No System or token-program instruction at the top level; deposits move tokens inside our program.
  - EVM, by address and selector: the factory's two create calls; the person's own vault, with the address derived locally, for `deposit`, `withdraw`, `withdrawAll`, `ownerSwap`, `setTargets`, `acceptVersion`, `setAutoFollow`, and `multicall` decoded recursively; the registry's `create`, `publish`, `cancel`; the cash token's `approve` only to the factory or that vault, for the stated amount. Never `setOperator`. `value` is zero.
  - Swap amounts in the bytes must equal the `inRaw` and `minOutRaw` shown on the review screen.
  - A call that turns auto-follow on or accepts a version is refused unless the executor was handed a consent the UI itself collected for that order.
  - Limits: the guard runs in the page it protects, so it does nothing against script injection. `apps/web` ships a nonce-based content security policy and a lint ban on `dangerouslySetInnerHTML`. A compromised API can still show a bad price; the review screen prints the minimum received per leg.
- **Sending and reporting.** On Solana the wallet signs and the web posts the bytes; the server broadcasts only if they hash to the `messageHash` of an attempt it built. If a wallet changed the bytes, the server does not relay; the wallet sends and the web reports the id. For every reported id the server fetches the transaction and matches signer, target and call data (on Solana: our instruction's accounts and data) to the built leg before marking it confirmed.
- **Fees.** `GET /v1/funding` returns what is missing per chain: cash plus native gas. The buy button is disabled per chain until funded.
- **Recovery.** "Export key" per family in settings. After the first deposit the app prompts for a second passkey or an email. `scripts/ops/withdraw-without-app.ts` withdraws in kind with only the owner key.

## 10. Backend, keeper and hosting

**API (`apps/api`).** His Fastify app, plus:

- `plugins/auth.ts`: a person by Privy tokens; the MCP server by one service key in its environment. Every route declares `config.auth`; non-GET routes default to deny. Shelf, risk sheets, quotes, personalize and order creation stay keyless. An order is reachable only by its UUIDv4.
- `plugins/limits.ts` (`@fastify/rate-limit`, in memory), keyed by Privy user or service key first, then by client address: 60 a minute anonymous, 120 signed in, 10 on the parser, 30 on the builders. `@fastify/helmet`. A CORS allowlist. One error handler that returns a request id and no SQL.
- The browser calls `/api/*`. `apps/web/proxy.ts` rewrites it to the API host and adds the client address with a shared-secret header; the API trusts a forwarded address only with that header.
- Consent is stored against the order id, the address and a hash of the legs it covers.
- With `LEGACY_STRUCTURER=off`, no route that reaches a signer is registered.

**RPC, free.** EVM: viem `fallback` over Alchemy free, dRPC and the public endpoint. Solana: Helius free (1M credits a month).

**Jupiter.** The free plan is 1 request a second and 60 a minute per organisation, not per key **[C 2]**. Rodrigo's collectors keep his organisation; the app and the keeper use a second one that Thom opens on Oct 2. Inside it the API is capped at 30 calls a minute and the keeper at 30. All read quotes pass through a cache keyed by asset and size bucket, held for 30 seconds; only leg builds call Jupiter live. Tests use recorded fixtures and the mock router; one named job may hit Jupiter.

**Keeper (`apps/keeper`).** A plain TypeScript worker with `--once` and `--loop` and no HTTP listener. Each pass, per chain:

1. Open a run row (one open run per chain).
2. List auto-follow vaults. Take each one that is behind a version whose `effectiveAt` has passed, or whose `synced_version` is behind its accepted version.
3. Adopt where needed. Read the vault from the chain and plan with `planRebalance`.
4. Skip a leg whose live quote costs more than the tolerance against the reference price; log it as `skipped`.
5. Write the leg row, build, simulate, compare the simulated balance changes with the plan, sign and send. Vaults go serially in random order.
6. When a vault has every position inside the band, set `synced_version`. The keeper then leaves it alone until the next version. Drift rebalancing later is this pass without step 6.

- Solana send: blockhash just before signing; compute limit = units used × 1.2; priority fee from recent fees, clamped; the same signed bytes go to Helius Sender and the RPC, rebroadcast every 2 s until confirmed or past `lastValidBlockHeight`.
- EVM send: `pending` nonce stored on the attempt; `simulateContract` first; `maxFeePerGas` at twice the base fee (memory).
- Retries: a reverted leg is never sent again. A leg that expired without landing is re-planned from chain state in the next pass, at most 3 times per vault and version, then an alert.
- Alerts go to a Discord webhook: a rejected leg, three expired attempts, low gas, a stale feed in session, a vault past half its loss budget, a failed authority check. The keeper holds no guardian key; it only alerts. Each pass pings healthchecks.io.

| Piece | Where (all free) | Note |
|---|---|---|
| Web | Vercel Hobby, one fixed origin | Terms say non-commercial (section 17) |
| API | Render free web service | Sleeps after 15 idle minutes and takes about a minute to wake. UptimeRobot's free plan pings `/health` every 5 minutes **[C 12]** |
| MCP | Vercel, its own project | Stateless; calls the API through the SDK with its service key |
| Postgres | Supabase free | 500 MB. The free direct connection is IPv6 only; use the shared pooler in session mode, port 5432 **[C 12]**. Data API off |
| Keeper | `keeper --loop`, run locally while testing; a small VM at deploy | A gas-only key, kept away from coding agents. It only has to work Mon to Fri, 14:30 to 20:00 UTC |
| EVM collector | An hourly loop on the same machine | No chain keys; its own database role |
| Solana collectors | Rodrigo's Mac | Unchanged |

GitHub Actions is the later home for the keeper, not the MVP one. It needs Rodrigo's consent, one workflow on `main` that checks out a pinned commit of `basket`, an environment restricted to `main`, `--ignore-scripts` on install, and a test that a run from another branch cannot read the environment's secrets. Scheduled runs can also be delayed or dropped, and they stop after 60 days without repository activity **[C 16]**.

## 11. Web app

**The contract.** Rodrigo's design system is on `main` and it is binding: `.design/branding/working-brand/patterns/STYLE.md`, the component specs beside it, and `working-brand.theme.json`. A screen that breaks one of its seven rules is wrong, however good it looks. In short: a provenance pin after every yield, price and FX figure; MOCK always as a hatch plus the word; the disclaimer from the one `DISCLAIMER` constant; no Japanese words or clichés; nothing like Teiten; no blue or violet; the brand recedes in a partner embed. Everything is square (2px radius, no shadows, no pills) except the typing box. Light and dark both ship. His voice rules apply to every string: answer, then reason, then risk, then action; "I" for the agent; no exclamation marks; MOCK is the only uppercase word.

Stack kept: Next 16.3.8, React 19.3.0, Tailwind 4.3.3. There is no UI library: tokens go into `globals.css` through Tailwind's `@theme`, with shadcn-compatible variable names, as his `token-mapping.md` lays out. Added: Privy, viem, TanStack Query, next-intl, `lucide-react` behind his one icon wrapper, Playwright with axe. `cacheComponents` stays off. No Server Functions for writes; the Fastify API is the one backend.

**His screens are extended, not replaced.** His specs already describe the product flow: the composer, the constraint sheet, the goal card, the plan legs, the exit-plan line, the execution list. They name the screens they belong to: home, the plan view and the monitor. So the web app is those three screens, rebuilt on his primitives, with the vault under them, plus the screens his system has no spec for. This replaces the earlier idea of parallel screens with his switched off.

Order of work:

1. **The design system is applied first.** Tokens, fonts and the primitives in `components/ui/` (button, field, card, data table, status mark, provenance pin, MOCK plate, explorer link, icon) come from his specs. His brand pipeline can apply them; Rodrigo is asked to run it as soon as the branches are merged (section 17).
2. **Route groups, as his embed spec requires:** `app/(app)/` for the product, `app/(marketing)/` for his landing page, and a bare `app/embed/[id]/`. The embed is his, stays, and is read-only.
3. **Then one agent per screen,** against the mock adapter.

- **Same for everyone** (the shelf, a shared portfolio's page, risk sheets): statically generated with `revalidate: 60` and a 3-second fetch timeout, so a slow or sleeping API serves the last good copy.
- **Per wallet** (plans, portfolio, vaults, orders, quotes): client components with TanStack Query. Every key includes owner and chain, which fixes the audit's stale-wallet bug.

| Screen | Route | Built from his specs | What we add, from his primitives |
|---|---|---|---|
| Goal (home) | `/`, `/fit/[slug]` | Composer; constraint sheet with "Build my plan" blocked until valid; lattice loader | Sheet fields for the new inputs (amount in dollars, themes, holdings, chains); per-field flags where the model and the rules parser disagree. `/fit/[slug]` is the same screen started from a shared portfolio |
| Plan | `/plans/[id]` | Goal card as header; plan legs; schedule chart; exit-plan panel; risk sheet table; disclaimer block; execution list | The vault panel: its limits in numbers, the auto-follow switch, pause state, withdraw. "Portfolio changed: rebalance" and "new asset: accept" prompts |
| Monitor | `/monitor` | Goal cards; drift table with "Out of band"; execution list | One row per chain, with a failing chain shown as "unavailable"; the rebalance order |
| Shelf | `/shelf` | Cards, status marks, pins | A card per shared portfolio: name, author address, platform badge, value following, chains |
| Shared portfolio | `/indexes/[slug]` | Plan legs, exit-plan line, Bearing heatmap tile, data table | Versions and a pending version with its effective time; follow; "Start from this" leading to the goal screen |
| Order | `/orders/[id]` | Execution list; primary button that names the action and amount | Review (summary, minimum received, warnings, consents); funding missing per chain; a status per leg; resume on reload; wrong wallet |
| Vault, public | `/vaults/[chain]/[address]` | Data table, explorer links | A read-only view of any vault, so a visitor with no funds sees real state |
| Publish | `/publish` | Fields, error summary | One simple form; limit errors from `previewPublish`; a leg per chain |
| Sign-in and notices | all | Buttons, cards | Passkey or wallet; before the first deposit, the terms and the "unaudited, team holds the keys" notice |

**Where his specs change what we build.**

- **The goal comes first.** The home screen is the composer, not the shelf. A shared portfolio is reached from the plan or the shelf and always leads back to the goal screen.
- **At most four legs in the bar.** His plan-leg spec treats more as an engine error. The bar shows the plan's sleeves (stocks, dollar yield, gold, cash). The tokens inside each sleeve go in a data table under it.
- **Status on the goal card.** "On track", "Watch" or "Off track" comes from the engine, never the UI. The design computes a verdict for income goals only, so the status for other goals, and the odds his showcase prints, are open (section 17).
- **The exit plan is tiers in time,** such as "up to $4,000 within a day, the rest within 7 days, cost ≤ 0.50%", shown before the invest button, with costs as "≤" or "about" and never as a promise. The roll-up in `packages/basket` gives a cost at a size; it also has to give tiers. Withdrawing the tokens themselves is stated on its own line and is not called access to cash.
- **Pins need staleness.** The pin has a stale state that the API must state; the UI may not infer it. `Sourced` gets a staleness field at the first interface freeze, agreed with Rodrigo (his own open item).
- **Signing.** A button that signs names the action and the amount ("Sign: swap 5 USDC → USDY"), and there is one primary per view. A failed mainnet line has no retry button and reads "(not retried)"; a new attempt is a new action the person signs. A busy button changes its label; there are no spinners.
- **The agent's log speaks in the first person with its reason and its source:** "I moved $1,200 from USDC to USDY because rates dipped and your June date needs a little more income. Source · Tx ↗". Every keeper leg stores the reason it was made, so the line can be written.
- **Wallets.** His specs style the Solana wallet-adapter button and modal, and his landing page says "Connect wallet". Passkey sign-in through Privy needs the same care. The button says "Sign in" and opens a choice of passkey or wallet (section 17).
- **Languages.** Strings live in a dictionary keyed by language from day one, with human labels for every sheet field. English and Portuguese both, since his home screen is Portuguese today.

- **Order executor.** The web uses `execute()` from `packages/sdk` with a `WalletPort`-backed signer; there is one state machine, not two. It writes every transition to the API before the next step. On reload, `sent` legs are tracked and `built` or `expired` legs are rebuilt; signed bytes are never re-sent. A failed leg stops its chain only. Status changes go to an `aria-live` region with the explorer link.
- **Checks.** Every Playwright spec runs axe at 375 px in light and dark. A DOM test fails the build if a hatch appears without the word MOCK or "stale" in the same component, as his spec asks. A CI grep rejects raw palette classes and any blue. An unknown provenance never renders as live.
- His `/risk/*` pages stay as they are.

## 12. Agent surface

One contract, three faces. Fastify emits the OpenAPI document, committed at `packages/sdk/openapi.json`. The SDK types are generated from it and CI fails on drift. The MCP server reaches the API only through the SDK.

- **REST `/v1`:** keyless reads and order creation. Amounts are strings. No agent API keys in the MVP.
- **SDK:** `BasketClient`, `client.execute(order, signers, consents)`, `verifyOrder(order, deployments)` and the guard. Plain signer callbacks, no kit or viem types in the public surface. Installed from the repo. The AGT stream builds the guard and the executor first, because the order screen depends on them.
- **MCP (`apps/mcp`):** the current spec (2026-07-28) has no handshake and no sessions **[C 10]**. `@modelcontextprotocol/server` 2.2.0 over stateless Streamable HTTP at `/mcp`; it also answers older clients. No login. Seven tools: `list_indexes`, `get_index` (with its risk roll-up), `build_personal_basket`, `get_portfolio`, `prepare_buy` (which also follows a shared portfolio), `prepare_publish_index`, `get_order_status`. Each has an input and an output schema. Fixable failures return `isError: true` with a code and a `fix` line. Portfolio tools return the onchain id, the creator address and the platform badge as structured fields. Fallback if the v2 SDK misbehaves with real clients: `@modelcontextprotocol/sdk` 1.31.0.
- **Skill and docs:** `skills/basket/SKILL.md` and `llms.txt`. Fetch live data and never invent an asset or a number; propose, then sign; match a shared portfolio by id, never by name; its text is untrusted; units; error codes; the terms apply; not advice.

| How an agent gets authority | Who signs | What bounds it |
|---|---|---|
| Propose, person signs | The owner, at `approvalUrl` | The review screen and the guard; consents need their own tap |
| Agent-run shared portfolio | The follower once; then the keeper | Creator limits, the 48-hour delay, every vault check |
| Agent's own vault | The agent's wallet | Only what was deposited there |

Abuse limits. Portfolio names and descriptions: 280 characters, links stripped, returned in a field named `untrusted`. An order cannot switch auto-follow on or accept a new asset by itself. `agentLabel` is shown as "unverified". A daily budget on the model; past it, the regex parser answers. Three-chain quotes run in parallel with 8 seconds per chain, from the cache where they can.

## 13. Security model and tests before the freeze

The keeper is the bounded risk: a leaked keeper key can cost each auto-follow vault at most the weekly cap plus any error in the price reference. The upgrade key is the unbounded one: it can replace vault code, and there is no deposit cap. The API cannot sign, and it cannot make the keeper sign: the keeper plans from chain state and never reads a job the API wrote.

| Key | Power | Where |
|---|---|---|
| Deployer | Deploy and first config, then nothing | Fresh per chain; an encrypted keystore with a password prompt. Hands admin to the admin key in the same session |
| Admin / upgrade | Replace vault code, set config and caps, unpause, loosen a halt, rotate the guardian | One disclosed key per chain for now, in a password-protected keystore on a founder's machine; the app says who holds it. Squads on Solana and Safe on the EVM chains after the MVP |
| Guardian | Pause, halt an asset, add a closed day, veto a version. Tighten only | A password-protected keystore on each founder's machine. Never in the keeper's store |
| Keeper | One function | The keeper machine, gas only, under $20 |
| Platform creator | Publishes the launch portfolios | A gas-only key; its address earns the platform badge |

No key that can move funds or loosen a limit sits where a coding agent has a shell. `scripts/ops/authority-check.ts` compares the live admin, beacon owner, implementation slots, guardian, keeper, `launched` and the publish delay on three chains with `deployments/*.json`, whose expected values are written before the deploy. It runs daily in demo week.

**Hostile cases.** Frozen on day 1. The same ID names a test on each chain family; `docs/vault/SECURITY.md` holds the matrix.

- A1 output sent to the keeper. A2 price worse than tolerance. A3 back-and-forth churn. A4 token outside the accepted recipe.
- A5 stale price. A5b another asset's price at the pinned Scope index (Solana; must revert once `source_check` is on).
- A6 Saturday, and one minute before the open. A6b a weekday holiday with a feed under 26 hours old.
- A7 wrong direction or past target. A8 paused: keeper reverts, owner withdraws.
- A9 one token frozen or returning `false`: the rest withdraw. A9b a transfer hook added after deposit (Solana).
- A10 balance changed from outside, including a second token account owned by the vault.
- A11 any approval, Permit2 allowance, delegate or close authority left after a call. A12 inside the multiplier window.
- A13 caller not the keeper, or auto-follow off. A14 new asset not accepted by the owner.
- A15 upgrade to a dummy v2 with the admin key: state intact, withdraw works; `initialize` reverts on every logic contract and live proxy.
- A16 creator limits, from the shared vectors.
- A17 a router or hooked pool re-enters `adoptVersion`, `multicall` or `keeperSwap` mid-swap.
- A18 a create or accept signed against version N lands after N+1 is active.

**Invariants.** I1 tokens leave only by an owner call, and only to the owner. I2 value at reference prices after any keeper sequence in 7 days ≥ start × (1 − cap), net of owner flows. I3 no allowance survives a call, Permit2 included. I4 withdraw works with feeds, registry and factory reverting. I5 a keeper call never widens distance from target.

**Gate `G-SEC`, per chain, in two tiers.** Auto-follow goes live on a chain only when tier 1 passes; until then the app hides the switch. A chain that misses on Oct 8 ships owner-signed only.

| Tier 1: required to switch auto-follow on | Passing |
|---|---|
| Every A-case that applies, as a named test (Foundry at 6, 8 and 18 decimals; LiteSVM under Vitest with `mock-router` at Jupiter's address and a hand-written Scope account) | All pass |
| Each rule bites: comment out each check in turn, in the contracts and in `checks.rs` | A named test fails for each |
| I1 and I4 | Hold in unit tests and on live state |
| One scripted mainnet rehearsal, $10 to $20, every transaction logged | Create, deposit, owner swap, publish, adopt, one keeper leg; A1, A2, A4, A8 and A13 fail as expected on live state; pause; withdraw while paused |
| The keeper key holds only gas, sits in a password-protected keystore no coding agent can read, and is in no repository secret | Checked by a person |

| Tier 2: run and recorded; open items go in `docs/vault/SECURITY.md` and the trust notice | Tool |
|---|---|
| EVM invariants I2, I3, I5 with handlers (owner, hostile keeper, creator, donor, issuer, clock, a re-entering router) | Foundry |
| Solana logic and sequences | `proptest` on `checks.rs`; 10,000 fast-check sequences on LiteSVM |
| A1 and A11 against a real `route_v2` account list; a saved route replays | surfpool |
| Static analysis | Slither, Aderyn, `forge lint`, `forge build --sizes`, `cargo clippy`, cargo-deny |
| Robinhood fork at a pinned block, including a Saturday block | dRPC |
| A second rehearsal, with A15 run with the admin key | Scripted |

A tier 2 failure blocks only if it shows a real way to lose funds.

**Gate `G-LINK`, once, before the public link is shared.**

- Guard negatives, one vector each: a hostile instruction in an allowed program, a withdraw built for a third party, a wrong spender, `setOperator`, auto-follow without consent, a swap whose minimum differs from the screen.
- Identity: wallet B cannot approve wallet A's order; B claiming A's address is refused; an unrelated successful transaction cannot confirm a leg.
- No registered route reaches a signer. A keeper row inserted with the `api` role is never submitted. 100 anonymous quote calls cause a bounded number of upstream calls.
- `authority-check` is green with the disclosed admin key as admin, `launched` true and the delay at 172,800 s. The Supabase Data API is off.
- The three-profile test passes: pairwise distance at least 3,000 bps, a reason on every line.

**Supply chain.** Keep pnpm 11's one-day release hold and build-script approval. A pull request that changes the lockfile names the new packages and a person reads the diff. `security.yml` runs gitleaks, `pnpm audit --prod` and cargo-deny.

**First, today.** Revoke the two live approvals on Rodrigo's demo wallet (5 USDY and 5 syrupUSDC to the agent key). Do not deploy the current API publicly with `secrets/agent.json` present.

**What the app says,** from one `TRUST_STATUS` constant: unaudited; the team holds the upgrade keys and could move funds; what the keeper may do, in numbers, plus any error in the price reference; issuers can pause, freeze or seize; not advice; the open tier 2 items.

**Incident plan** (`docs/vault/INCIDENT.md`): `pnpm ops:pause` on three chains in one command, stop the keeper, set the banner, rotate the keeper key. Rehearse it once on mainnet: alert to paused in under 5 minutes.

## 14. Roadmap seams

| Roadmap item | In place at the MVP | Added later |
|---|---|---|
| Community, gamification | Same events on both families; `follows`; `creator_user_id`; value and counts from `vaults`; a `badges` slot on cards | Profiles, rankings, an event index |
| Creator fees | `maxFeeBps` and `flags` stored at publish on both families and required to be zero; `Order.fees`; nullable `fee_bps`, `fee_amount` | Accrual through an upgrade |
| Publish once (CCIP) | `familyId` onchain on all three chains; chain-free EVM portfolio ids; publish is already an order with a leg per chain | An authorized remote publisher; one leg |
| More chains | `chains` rows and `content/chains.json` are the only chain lists; init in the proxy constructor, CREATE2; a `Submitter` per chain | One config, one deploy. A third wallet family would touch `Owner` and `WalletPort` |
| New plan types | Targets stored in the vault, separate from the recipe; a vault type byte; `basketType` on the sheet; `kind` and `params` on families | A protected plan is an upgrade that adds a target rule to check 5, plus fields and a sleeve rule |
| Rebalance on drift | The keeper path needs auto-follow and stored targets, not a recipe or a new version; `listAutoFollowVaults()` takes no recipe; `Leg.trigger` has `drift` | The keeper pass without its `synced_version` step, and the switch shown on plans |
| Paid price feeds | On Solana: `price_kind`, four price-account slots, and a 32-byte field plus 21 spare bytes per asset (a Pyth feed id is 32 bytes). On EVM: `source` in `AssetConfig`. `Sourced` on every price | A second source or a cross-check |
| Agent-run portfolios | A creator is an address; `creator_kind`; a per-vault `keeper` / `operator` slot | A per-vault agent operator under the same checks; agent API keys |
| Pooled token | The vault owner may be a program or a contract; no `tx.origin`; `vault_type` | A separate program reading the same recipes |
| Embeds | Every write goes through `/v1`; `WalletPort` has no Privy types; nullable `org_id` on orders; an `(embed)` route group | Partner keys, OAuth, `createVaultFor` |
| Audits, governance | One admin address with two-step transfer; `deployments/*.json`; parameter bounds in code; the invariant suite | A multisig, a timelock, an audit, verified builds |

## 15. Workstreams

Only the TypeScript streams wait for PR1a. `SOL`, `EVM`, `RISK`, `BRAND`, `OPS`, the Privy page and the personalization port import nothing from it and start now, while PR0 and PR1a are written.

| ID | Stream | Owner | Inputs | Outputs | Depends on | Done when |
|---|---|---|---|---|---|---|
| FRAME | PR0, PR1a, PR1b | Thom | Sections 2 to 4 | Green CI, v0 types, mock adapter, migration `0006`, flags; then boundary test and workflows | Rodrigo's answers on branch and licence | The walking skeleton passes on the mock |
| SOL | Solana program | Thom | 3.7, 5, the spike | `programs/basket`, IDL, LiteSVM suite | none | All A-cases pass; the $10 run passes |
| EVM | Contracts | Thom | 3.8, 5, 6, the spike | `contracts/`, ABIs, deploy scripts, `deployments/*.json` | none | Unit and fuzz tests pass; deployed and verified on both chains |
| ADS | Solana adapter | Thom | 3.2, the IDL | Vault builders on kit 2.3; Scope and multiplier reads; holdings for both token programs; `send.ts`, `track` | FRAME, SOL's IDL | Contract tests pass on a fork, then on mainnet with small amounts |
| ADE | EVM adapter | Thom | 3.2, ABIs | One codebase, a config per chain; quoters; router calldata | FRAME, EVM's ABIs | Same, on both chains |
| BAS | `packages/basket` | Thom | 3.6, 6 | Flatten, view, planner, limit check, roll-up, meta hash, shared limit vectors | FRAME | Unit and property tests pass; the limit check matches both registries on the vectors |
| API | Backend | Thom | 3.3, 3.4, 4, 10 | Auth, limits, `/v1` routes, `prepareIntent`, funding, report matching, OpenAPI emit | FRAME | Endpoint and security tests pass |
| KEEP | Keeper | Thom | 3.5, 10 | `apps/keeper`, alerts, the run script for the keeper machine | BAS, ADS, ADE | A shared-portfolio update rebalances an auto-follow vault on each live chain; two sessions of clean runs |
| WAL | Sign-in | Thom | 3.5, 9 | Privy provider, `WalletPort`, test wallet | The Privy app and origin | A passkey wallet signs on three chains; `next build` passes |
| AGT | Agent surface | Thom | 9, 12 | Guard and executor first; then `packages/sdk`, `apps/mcp`, skill, `llms.txt` | FRAME; API for the rest | Guard negatives pass; an outside agent builds a plan and a person approves it from the link |
| WEB | Screens | Thom, on Rodrigo's design system | 11 | His three screens extended, then the new ones, one agent per screen | BRAND's primitives, WAL, AGT's executor, API (mock first) | The nine MVP items work end to end; the seven binding rules hold; axe passes at 375 px in light and dark |
| ENG | Personalization | Thom's agent ports; Rodrigo owns the table and wording | 3.6, 7, the prototype | `engine/src/personal/`, the parameter table, templates, a 12-goal eval | BAS's `flatten` | The three-profile test passes; his baseline test stays green |
| RISK | Risk layer, sheets | Rodrigo | 8 | Three fixes; about ten family sheets; a dated dump; six lines in `compute.ts` | none | Sheets render; hosted curves show their date |
| REVM | EVM depth | Thom | 8 | The hourly collector | RISK's `compute.ts` change | Curves for five tokens per EVM chain, 8 samples per regime |
| SEC | Security, rehearsal | Thom | 13 | `SECURITY.md`, `INCIDENT.md`, the rehearsal script, `authority-check` | SOL, EVM, API | `G-SEC` recorded per chain; `G-LINK` recorded |
| OPS | Mainnet work a person does | Thom; Rodrigo is asked to take the Solana sessions | 10, 13, 16 | `docs/vault/RUNBOOK-OPS.md`: a checklist per session with a name per item. Hosting, accounts, admin keys, funded wallets, deploys, config, seeding, rehearsals, footage | Accounts opened | The public URL serves the app; `authority-check` is green |
| BRAND | Design system in the app | Rodrigo | `.design/branding/working-brand/patterns/` | Tokens and fonts in `globals.css`, the primitives in `components/ui/`, route groups, his three screens on them; the final name and logo artwork | none | The primitives exist and his screens render on them in light and dark |

OPS sets the pace and is planned like a stream. It is three $10 runs, three deploys, about 50 asset entries, about 13 recipe publishes, three admin keys, funded wallets, two rehearsals, a pause drill and the footage, mostly inside five sessions of 5.5 hours. Every `scripts/ops/*` script is idempotent, has a dry run that prints the exact transactions, and reads one JSON file of assets, feeds and recipes. The deployer writes config in the deploy session; later changes go through the admin key as one batch.

## 16. Day-by-day plan and what is out

The schedule of record is `PLAN-VAULT.md`, written on the night of Oct 1 with the streams not yet started: it moves the Oct 1 row below into Oct 2 and adds dated milestones. Where the two differ, the plan wins. The table below is kept for its reasoning.

Stock markets are closed on Oct 3, 4, 10 and 11. Keeper trades on stocks, and any footage of them, can only happen on Oct 2 and Oct 5 to 9, between 14:30 and 20:00 UTC (11:30 to 17:00 BRT). Until `launch()` the publish delay is 300 s, so one session holds several publish, adopt and trade cycles; each cycle uses a fresh test portfolio and vault with a few dollars of team money. Oct 12 is a US trading day (memory).

| Day | What happens |
|---|---|
| Thu Oct 1 | SOL, EVM, the personalization port and the Privy page start from sections 3.7, 3.8 and 7. Accounts opened |
| Fri Oct 2 | PR0 and PR1a by midday; v0 interfaces. In session, and nothing else for Thom: the three $10 runs and the Scope read. All three chains funded, so a failure to get USDG on chain 4663 shows on day 1. Second Jupiter organisation. Privy origin test. Half-day tries: one mock MCP tool on the free host, Slither on the spike vault, one hand-written kit 2.3 builder. Rodrigo answers section 17 |
| Sat Oct 3 | SOL: `route_v2` on surfpool, registry, create and first-buy sizes at 7 and 12 assets. EVM: vault, factory, registry with unit tests. Adapters: read side. API: auth and orders. AGT: guard and executor. WEB: shared layer. Three-profile test green on placeholder numbers. Log feed ages over the weekend |
| Sun Oct 4 | The keeper path in program and contracts; A-cases; adapters build and simulate on a fork. Evening: the interface amendment window closes and the hash test turns on. Origin decided. Admin keys created. Design system applied to the app by now. Deploy dry run |
| Mon Oct 5 | Deploy on three chains: config, caps, handover to the admin key, `authority-check`. First hosted web and API; cold-start test (no pings for 20 minutes, then load the home page). In session: the owner path on three chains; first keeper leg and first publish-adopt-trade cycle on Solana |
| Tue Oct 6 | A three-chain buy with a passkey wallet; publish and follow. In session: auto-follow cycles on Robinhood Chain; rehearsal 1 on Solana and Robinhood Chain. MCP against the real API |
| Wed Oct 7 | In session: rehearsal 2, and the market-open footage. Portfolio and rebalance end to end. Sheets render. Add-backs decided |
| Thu Oct 8 | `G-SEC` per chain at 12:00 BRT. Then `launch()`: the delay is 48 hours from here on. Then `G-LINK`, and only then is the link shared. Pause drill in session. In session: publish a version of the demo portfolio |
| Fri Oct 9 | Spare session for a failed test cycle. Freeze at 18:00 BRT; tag. The version published on Oct 8 takes effect on Saturday, when the stock market is closed, so its rebalance waits for Monday |
| Sat Oct 10 | P0 fixes only, each with a test. README, `HANDOFF-VAULT`, `DESIGN-VAULT`, `PRIOR-WORK`. Record the remaining screens |
| Sun Oct 11 | Edit both videos. Fill the submission form |
| Mon Oct 12 | In session: the Oct 8 version adopts and rebalances at production settings. If it fails, auto-follow is switched off on that chain. Then submit with a buffer |

**Out unless ahead.** Each item starts out and comes back only on its date, if the streams it needs are done.

| Out at the start | Comes back | Decided by |
|---|---|---|
| Anchor 1.2 and a generated client (stay on 0.31.1 and hand-written builders) | After the MVP | n/a |
| Portuguese interface copy; Spanish | Portuguese if screens are done; Spanish after the MVP | Oct 7 |
| Agent API keys and their table | After the MVP | n/a |
| Five more MCP tools (`get_risk_sheet`, `quote`, `prepare_rebalance`, `prepare_follow`, `prepare_withdraw`) | If AGT is done | Oct 7 |
| The 28-day EVM backfill | If a stream is idle | Oct 6 |
| Off-chain capacity per shared portfolio and flow limit per asset in the keeper | After the MVP; there are a handful of vaults | n/a |
| A free-form publish screen | After the MVP | n/a |
| Auto-follow on Base (owner-signed only; its keeper rehearsal and sequencer-feed tests leave `G-SEC`) | If Solana and Robinhood Chain pass tier 1 | Oct 7 |
| The hourly copy of his curves | If the dated dump goes stale | Oct 7 |

**Cut order if still late,** with the date each is decided:

1. `/swap/v2/build`: fall back to the legacy route the spike proved locally. Oct 3.
2. Trading on Base (read-only) if its $10 run fails. Oct 2.
3. Auto-follow on Robinhood Chain: owner-signed only, which the handoff allows. Oct 7.
4. Auto-follow on Solana: followers get the one-tap prompt, which still meets item 7's base case. Oct 7, at night: after `launch()` on Oct 8 a cycle takes 48 hours.
5. (Taken on Oct 1: one disclosed upgrade key in place of a multisig.)

Never cut: in-kind withdrawal; tier 1 on any chain where auto-follow is on; `G-LINK`; no registered route that reaches a signer; the three-profile test.

## 17. Decisions: made, and still to make

**Settled on Oct 1.** These were written as questions for Rodrigo. They are decided here because they make sense for the product; either founder can reopen one.

1. Write access: granted. Rodrigo merged his branches into `main` on Oct 1. Each stream works in a short-lived branch with a pull request into `staging`; `staging` goes into `main`, and `main` is what gets submitted.
2. The licence: Apache-2.0.
3. Adding files stays the default, to keep merges clean. Where an edit to an existing file makes the product better, we make it and say so in the pull request. The four edits are ours to make: the server-signing routes go behind `LEGACY_STRUCTURER` and are deleted once the vault path replaces them; `seed-assets.ts` moves to `scripts/`; the CI chores are done; and six lines in `scripts/risk/compute.ts`. `chain-solana` and `chain-evm` are Thom's. One branch at a time generates migrations.
4. One of Thom's agents ports the personalization prototype into `engine/src/personal/` with sensible starting numbers. Rodrigo tunes the sleeve table, glide floors, caps and wording when he can.
5. Stock tokens stay out of income plans, as his rule says.
6. Stocks and gold: no return assumed, with the dollar loss in a 20% fall shown. A sourced range can come later.
7. The keeper may re-plan a leg that expired without landing, up to three times. A leg that reverted is never sent again, which keeps the point of his never-auto-retry rule.
8. Risk sheets per issuer family with generated per-asset fields; a dated dump of curves first.
9. The design system is applied to `apps/web` from his specs at the start of the web stream (tokens, fonts, primitives, route groups), by whoever gets there first. His three screens are rebuilt and extended, not retired, and the embed stays.
10. Open: who runs the Solana mainnet sessions (deploy, config, rehearsals). Rodrigo has already run mainnet transactions from his demo wallet.
11. Later: one keeper workflow on `main` with a pinned commit and a restricted environment.
12. For agents, a self-declared country is enough.

**From his design system** (read on Oct 1)

- The provenance pin is specified three ways across his files (size, outline colour, hatch pitch). We build it from `patterns/components/provenance-pin.md` and `working-brand.yml`, since his own rule is that the `.yml` wins.
- Open: there is no final logo artwork yet. The spec says to draw the outlines from it.
- The pin's stale state needs a staleness field from the API (his open item). It is added to `Sourced` at the first interface freeze.
- The goal card needs a status from the engine, and his showcase prints odds. The design computes a verdict for income goals only. Rodrigo builds the status for other goals and the odds estimate; until then the card shows the verdict where one exists and no percentage.
- The label on the sign-in button is "Sign in", opening a choice of passkey or wallet. His landing page says "Connect wallet" and changes to match.
- The plan-leg bar allows four legs: sleeves go in the bar, with the tokens in a table under it.
- The disclaimer says "the decision and custody are yours". Only the owner can withdraw from a vault, so it stays; the "unaudited, team holds the upgrade keys" notice sits beside it before the first deposit.
- Auto-follow. It is off by default; the person sees an author's change 48 hours before it takes effect and can refuse; then the vault copies the change inside its own limits. It does not re-check the person's goal. Thom's decision is to keep it this way. It sits beside the voice rule that the agent "proposes and explains": the 48-hour notice is the proposal, and the person can refuse.

**Thom**

13. Create the two Privy apps on the free tier. Fix one free URL as the origin by Oct 4; no domain is bought.
14. The three vault tests run on copies of mainnet, not with $10 on mainnet (decided on Oct 2). Agents may install the build tools.
15. No paid model credit (decided on Oct 2). The rules parser reads the sentence; a model is optional.
16. Turnkey costs about $0.10 a signature after 25 a month **[C 9]**, so it is not the fallback. If Privy fails, the fallback is connecting a wallet only.
17. Which VM runs the keeper at deploy. It runs locally while testing.

**Defaults taken, and what is still open**

18. The name (Tenonfi is provisional on the `design` branch). It fixes the package scope, the server and skill names, the origin and the passkeys, and with it the working code names in the Words table are renamed.
19. Oct 2: the Solana shared portfolio that shows auto-follow. It must hold only Scope-priced tokens: AAPLx, CRCLx, GOOGLx, HOODx, METAx, MSTRx, NVDAx, QQQx, SPYx, TSLAx **[C 3]**. Taken: a new launch portfolio of NVDAx 25%, AAPLx 20%, GOOGLx 20%, METAx 20%, TSLAx 15%. The Seven needs MSFTx and AMZNx, which Scope does not price.
20. The 500 is a single-asset portfolio outside the registry (section 6).
21. US visitors: decided on Oct 1. No location block and no banner; the terms say the app is not for US persons.
22. If the capacity formula puts GLDx below Storm Cellar's 25%, the recipe changes; the capacity rule does not.
23. Upgrade keys: decided on Oct 1, one disclosed key per chain. Still open: who holds each one and who is guardian on call each day. A live deploy on Solana would lock about 5 SOL; nothing is spent, so it waits on gate `SHOW`.
24. External wallets get one review screen and then several wallet prompts. The demo uses a passkey wallet.
25. Auto-follow on stocks trades only Mon to Fri 14:30 to 20:00 UTC, and never on a listed closed day.
26. Who opens the accounts (Supabase, Render, Vercel, Helius, Alchemy, UptimeRobot, the second Jupiter organisation), whether Jupiter's terms allow a second organisation, and whether Vercel Hobby's non-commercial clause is acceptable.
27. Who fills `blockedCountries` per asset. Until it is filled, the self-declared country skips no token.
28. A warning above $1,000 per vault, since there is no cap. No agent-run portfolio at launch.

**Flags on fixed decisions.** None is shown unworkable. Four carry risk.

- No deposit cap sits on unaudited, upgradeable code, and one disclosed key per chain holds the upgrade power. The app says so and `G-LINK` checks the key against `deployments/*.json`.
- The 48-hour delay holds for every public user, but test cycles before `launch()` run at 300 s on team money. The latch is one-way and `authority-check` reads it.
- Free tiers can sleep the API or throttle Jupiter. Each has a mitigation in section 10 and a test in `G-LINK` or the Oct 5 cold-start test.
- Jupiter's `route_v2` from a vault is unproven: settled on surfpool by Oct 3, then by the $10 run.

## Sources checked for choices in this document

Each stream note in `docs/vault/research/design-v2/` lists its full sources. The ones a choice here depends on:

1. Anchor releases (1.2.0, Sep 4): https://github.com/otter-sec/anchor/releases (`coral-xyz/anchor` redirects there)
2. Jupiter build endpoint and rate limits ("per organisation, not per API key"): https://developers.jup.ag/docs/swap/build , https://developers.jup.ag/docs/portal/rate-limits
3. Kamino Scope layout and priced reserves: https://github.com/Kamino-Finance/scope , https://api.kamino.finance/kamino-market/5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua/reserves/metrics
4. Foundry v1.8.3: https://github.com/foundry-rs/foundry/releases
5. OpenZeppelin Contracts 5.6.1 and 5.7.0; `MulticallUpgradeable` at tag v5.6.1: https://github.com/OpenZeppelin/openzeppelin-contracts/releases , https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/blob/v5.6.1/contracts/utils/MulticallUpgradeable.sol
6. Chainlink tokenized equity and sequencer feeds: https://docs.chain.link/data-feeds/tokenized-equity-feeds , https://docs.chain.link/data-feeds/l2-sequencer-feeds
7. Privy pricing, allowed domains, identity tokens: https://www.privy.io/pricing , https://docs.privy.io/recipes/dashboard/allowed-domains.md , https://docs.privy.io/user-management/users/identity-tokens.md
8. npm registry: `@privy-io/react-auth` 3.46.0 depends on `viem` 2.56.0 and has peer `@solana/kit >=3.0.3`. https://registry.npmjs.org/@privy-io/react-auth/3.46.0 , https://registry.npmjs.org/viem
9. Turnkey pricing: https://www.turnkey.com/pricing
10. MCP specification 2026-07-28 and the v2 TypeScript SDK: https://modelcontextprotocol.io/specification/2026-07-28/server/tools , https://ts.sdk.modelcontextprotocol.io/v2/serving/http
11. Anthropic structured outputs and pricing: https://platform.claude.com/docs/en/build-with-claude/structured-outputs , https://platform.claude.com/docs/en/about-claude/pricing
12. Hosting limits: https://render.com/docs/free , https://supabase.com/pricing , https://supabase.com/docs/guides/database/connecting-to-postgres , https://vercel.com/docs/plans/hobby , https://uptimerobot.com/pricing/
13. Stock token behaviour, including `newUIMultiplier()` and `effectiveAt()`: https://docs.robinhood.com/chain/building-with-stock-tokens/ , https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base
14. In this repo: `docs/vault/AUDIT-VAULT.md`, `docs/vault/CONVERGENCE-VAULT.md`; `spikes/*/README.md`; `docs/vault/research/open-questions/{creator-limits,launch-shelf,agent-native,wallet-providers}.md` and `launch-shelf.seed.json`; `risk-layer` at `75ae4f0` (`packages/schemas/src/{tx,liquidity,enums}.ts`, `packages/chain-solana/src/index.ts`, `packages/db/src/seed-assets.ts`, `packages/risk/src/{provider,time}.ts`, `packages/engine/package.json`, `fixtures/risk/us-market-holidays.json`).
15. Solana instruction stack depth (5 today, 9 under SIMD-0268): https://solana.com/docs/core/cpi
16. GitHub Actions `schedule` (default branch only, 5-minute minimum, delays and drops, disabled after 60 days without activity) and environments: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows , https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
