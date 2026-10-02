# Backend, data and keeper: note for design v2

Oct 1, 2026. Tags: [repo] read in Rodrigo's repo (`risk-layer` at `75ae4f0`); [ran] run today, read-only; [S1]… checked, listed in section 7; [mem] from memory.

## 1. Bottom line

- Keep his stack. `apps/api` gains a local Privy token check (`jose`), hashed API keys for agents and `@fastify/rate-limit`, and loses the routes where the server signs with the agent key.
- Read state, not events. Free RPC caps log scans (Alchemy free: 10 blocks; dRPC free: 10,000), so the contracts need enumerable views and the Solana vault a fixed-offset header. No indexer.
- No queue library. One `legs` table is both the keeper's queue and the per-leg status the app shows. The keeper is a reconcile pass that can run from cron.
- Free hosting: Vercel Hobby (web), Render (API), Supabase (Postgres), GitHub Actions cron (keeper, EVM collector). Rodrigo's collectors stay on his Mac and an hourly job copies what the API reads to the hosted database; if the Mac stops, the curves show their date.
- Sell cost by size is measurable on Robinhood Chain and Base from free RPC: one `eth_call` per pool returns every size, and history 28 days back works. It plugs into `LiquidityProvider` with no interface change.

## 2. What to use for the MVP

**Versions** [S1]. His pins are current (fastify 5.12.5, drizzle-orm 0.45.3, postgres 3.4.9). Add `@fastify/rate-limit` 11.2.0, `@fastify/helmet` 13.1.1, `jose` 6.2.12, `viem` 2.57.2. Stay on `@solana/kit` ^2.3 this week: latest is 8.4.0, a five-major jump that also moves every `@solana-program/*` package.

**Auth** (`apps/api/src/plugins/auth.ts`). Today there is none, CORS is `origin: true`, and `POST /policies/:id/rebalance` signs with `AGENT_KEYPAIR_PATH` for any caller [repo].

- Person: `Authorization: Bearer <Privy access token>`, verified with `jose.jwtVerify` (ES256, issuer `privy.io`, audience = app id, key from env). Wallets come from the `privy-id-token` header (`linked_accounts`), verified the same way [S2][S3]. Privy's own SDK (`@privy-io/node` 0.35.0) is not needed for this.
- Agent: `Authorization: Bearer bk_<prefix>_<secret>`. Store `prefix` and SHA-256 of the secret; scopes `read`, `propose`, `publish`.
- Every route declares `config.auth: 'public' | 'user' | 'agent' | 'any'`; non-GET routes default to deny. Shelf, risk sheets and quotes stay keyless.
- Rate limits: in-memory store, keyed by API key, else user, else IP; 60/min anonymous, 120/min signed in, 10/min on the goal parser and transaction builders [S4].
- CORS allowlist from `WEB_ORIGINS`. Drop `/policies/:id/rebalance`, `/policies/:id/revoke` and the agent key on the basket branch.

```ts
type Principal =
  | { kind: 'anon' }
  | { kind: 'user'; userId: string; wallets: { family: 'solana' | 'evm'; address: string }[] }
  | { kind: 'agent'; userId: string; apiKeyId: string; scopes: ('read' | 'propose' | 'publish')[] };
```

**Tables** in a new `packages/db/src/basket-schema.ts`, registered the way `risk-schema.ts` is, migration `0006` [repo]. They cache chain state and hold off-chain metadata.

- `users`, `user_wallets`, `api_keys`
- `index_families` (slug, name, copy, creator, `kind`, `agent_run`), `recipes` (family, chain, onchain id), `recipe_versions` (components, hash, `effective_at`, status)
- `vaults` (chain, address, owner, recipe, accepted version, auto-follow, balances, `observed_at`)
- `follows` (user, family): watchlist and pending "new asset" prompts. Follower counts come from `vaults`.
- `intents`: what an agent proposes and the approval link opens.
- `legs`: one row per swap leg, owner-signed or keeper-signed.
- `idempotency_keys`, `price_observations` (with his `source`, `method`, `fetched_at`, `provenance` columns), `keeper_runs`.

Additive changes to his tables, which need his nod: `chain` gains `robinhood` and `base`; `asset_kind` gains `commodity` and `crypto`; `execution_kind` gains `create_vault`, `publish`, `keeper_leg`; `executions` gains nullable `vault_id`, `leg_id`, `signer`. Every mainnet transaction still gets an `executions` row with its explorer link. The zod enums in `packages/schemas` change in the same commit.

**Reading chain state.** Ask the contract streams to freeze these on day 1:

- EVM: `VaultFactory.vaultCount()`, `vaultAt(i)`, `vaultsOf(owner)`; `IndexRegistry.recipeCount()`, `latest(id)`; `BasketVault.snapshot()` returning owner, recipe, accepted version, auto-follow, balances, loss budget, last keeper trade. Read through Multicall3, which has code on both chains [ran].
- Solana: vault account starts `discriminator(8) | owner(32) | recipe(32) | accepted_version(u32) | auto_follow(u8)`, so `getProgramAccounts` with `memcmp` serves the portfolio (by owner) and the keeper (by recipe and flag).
- Keep his `POST /executions/:id/report`, but the server checks the signature on chain before marking it confirmed.
- RPC: viem `fallback` over Alchemy free (30M compute units a month, lists Robinhood mainnet [S5]), dRPC (about 100 keyless calls in three minutes without a refusal [ran]) and the public endpoint. Solana: Helius free, 1M credits a month, 10 requests a second, `getProgramAccounts` at 10 credits [S6].

**Keeper** (`apps/keeper`: `main.ts` with `--once` and `--loop`, `reconcile.ts`, `submit/solana.ts`, `submit/evm.ts`, `signer.ts`, `alerts.ts`).

Each pass, per chain: take `pg_advisory_lock`, list auto-follow vaults behind a recipe version whose `effective_at` has passed, plan with the engine, insert legs, then submit serially.

```ts
// legs: unique (vault_id, recipe_version, leg_index, attempt)
type LegStatus = 'planned' | 'built' | 'sent' | 'confirmed' | 'rejected' | 'expired' | 'skipped';
interface Submitter {
  chain: ChainId;
  submit(leg: Leg): Promise<{ txId: string; validUntil?: bigint; nonce?: number }>;
  status(txId: string): Promise<'pending' | 'confirmed' | 'reverted' | 'expired'>;
}
```

Claim with `UPDATE legs … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.

Retries, reconciled with his "never auto-retry" rule:

- Reverted on chain: `rejected`, decoded vault error stored, never sent again by the keeper.
- Expired without landing: re-quote and insert `attempt + 1`, at most 3, then alert. First confirm the old signature is absent (`searchTransactionHistory: true`) and the block height is past `lastValidBlockHeight` [S7].
- Owner legs: the retry button creates `attempt + 1`. Build each owner leg just in time (`POST /intents/:id/legs/:n/build`) so a slow passkey prompt does not outlive the blockhash.

Solana send, on free tiers:

1. Blockhash at `confirmed` just before signing; store `lastValidBlockHeight`.
2. Simulate; compute limit = units used × 1.2 (the spike used 83k). Priority fee from `getRecentPrioritizationFees` on the leg's writable accounts, 75th percentile, clamped.
3. Send the same signed bytes to Helius Sender (`swqos_only=true`, tip at least 0.000005 SOL, 0 credits, 15 a second on the free plan) and to the RPC with `maxRetries: 0`; rebroadcast every 2 s until confirmed or expired [S6][S7]. Tip accounts go in our lookup table.
4. Jupiter's free key allows 1 request a second per organisation; keyless is half that [S8]. Put a token bucket in `packages/chain-solana/src/jupiter.ts` and give the app a different key from Rodrigo's collectors.

EVM send: nonce read as `pending` at the start of the pass and stored on the leg; `simulateContract` first and skip on revert; explicit gas; `maxFeePerGas` at twice the base fee; same-nonce replacement at +10% if stuck [mem].

Keeper key: two new keys (Solana, EVM), gas only, in the keeper's secret store and never in the API's environment, behind a `Signer` interface.

**Hosting** (all free; no card needed [mem]):

| Piece | Where | Note |
|---|---|---|
| Web | Vercel Hobby | Terms say non-commercial use [S9] |
| API | Render free web service | Sleeps after 15 idle minutes; 750 hours a month covers one always-on service if pinged [S10] |
| Postgres | Supabase free | 500 MB, no idle suspend; pauses after a week without traffic [S11]. Neon's 100 compute-hours would run out under a 5-minute poll [S12] |
| Keeper, EVM collector | GitHub Actions `schedule` | Free on public repos; 5-minute minimum; runs can be delayed or dropped [S13]. Fine for a trigger with a 12-hour delay |
| Solana collectors | Rodrigo's Mac, unchanged | A fifth launchd job copies `risk_pools`, `risk_depth_curves`, and the latest LP, market and asset-snapshot rows to Supabase |

Ruled out: Vercel Hobby cron (once a day [S14]), Koyeb (no free compute now [S15]). Northflank's sandbox has two always-on services and two cron jobs but verifies a card [S16].

**Free data per chain.**

- Solana: multiplier from the mint account; reference price from Kamino Scope; display prices from Jupiter price v3 (same rate bucket as quotes).
- Robinhood Chain: `api.robinhood.com/rhj/assets` lists 195 tokens with `currentMultiplier`, no key; 58 Chainlink feeds [ran].
- Base: token list from Base's docs; Chainlink feeds.
- Both EVM chains: DexScreener for pool discovery and DefiLlama's coins API for display prices; both answered for NVDA on each chain [ran].

Chainlink feed ages during today's session were 12 to 53 minutes, and 11 hours for GLD (0.5% deviation, 24-hour heartbeat) [ran]. A "fresh within 120 seconds" rule cannot hold on EVM.

**Logging and alerts.** Fastify's pino logger with auth headers redacted. The keeper posts to a Discord webhook on a rejected leg, three expired attempts, low gas or a stale feed. Each cron run pings healthchecks.io (20 free checks) [S17]. `/health` shows the last keeper pass per chain and the date of the risk curves.

**EVM exit cost: evidence** [ran, 14:53–15:01 UTC, US session]

| Sell | $1k | $10k | $50k | Basis |
|---|---|---|---|---|
| Robinhood NVDA, Uniswap v3 USDG pool | about 0.00% | 0.01% | 0.07% | over a $100 sale |
| Robinhood NVDA, v4 0.3% pool | 0.25% | 0.38% | 0.94% | against the feed |
| Robinhood GME, v4 1% pool | 6.2% | 55% | 91% | against the feed |
| Base NVDAc, Aerodrome pool | 0.00% | 0.03% | 0.14% | over a $100 sale |

- v3-style pools (Uniswap v3, Aerodrome Slipstream): a 30-line quoter that reverts inside the swap callback, injected with an `eth_call` state override, never deployed. Worked on Base's public RPC, Robinhood's own RPC and dRPC for both. Code in `backend-evidence/`.
- v4 pools: the deployed v4 Quoter, eight sizes in one Multicall3 call.
- History: the same call at blocks 4 and 28 days old worked on dRPC (both chains) and Base's public RPC. Robinhood's own RPC keeps no old state.

How it plugs in:

1. `scripts/risk/evm/collect.ts` picks the deepest dollar pools per token from DexScreener, quotes his notional grid, takes the best single pool per size, and writes `risk_asset_snapshots` rows in his shape (`{notionalUsd, outUsd, costPct, unfilledShare}`) with `method_version = 'evmq-0.1'`. Cost is against the pool's own mid, as in his `usdCurves`, because the feed lags.
2. `scripts/risk/compute.ts` already fits every row of that table by regime [repo]. It needs about six lines so curves keep the snapshot's method version and source.
3. `apps/api/src/liquidity.ts`: change the `methodVersion` filter from `eq` to `inArray`. EVM tokens need `assets` rows, since curves are keyed by `assets.mint`.
4. `lpExitCostPct` stays null on EVM, which the interface allows. Label the method: best single pool, so cost is overstated when liquidity is split.
5. Backfill 28 days hourly (672 calls per pool) so weekend and off-hours regimes exist before Oct 9.

## 3. Skip or defer

- pg-boss, graphile-worker, Redis: the reconcile pass rebuilds work from chain state, and job rows must join to vaults and executions.
- Event indexers, webhooks, websockets: free log ranges are too small.
- OAuth for agents, per-agent server wallets, Turnkey or KMS for the keeper key, Jito bundles, Sentry.
- Vercel for the API: it reads fixture files by path and opens a database client per route module [repo]; one container avoids both.
- Moving his launchd collectors; LP concentration and split routing on EVM.

## 4. Seams for the roadmap

- Community and gamification: `follows`, `index_families.creator_user_id`; counts are queries over `vaults`.
- Creator fees: nullable `fee_bps` on `recipe_versions`, `fee_amount` on `legs`.
- CCIP sync: `index_families` already groups per-chain recipes; add `origin_chain`.
- More chains: the `chain` enum plus one `ChainConfig` entry and a `Submitter`.
- New basket types: `kind` and `params jsonb` on `index_families`.
- Drift rebalancing: `legs.trigger` (`index_update` now); detectors plug into `reconcile.ts`.
- Paid feeds: `price_observations.source` and a per-asset source setting.
- Agent-run indexes: the `publish` scope and `index_families.agent_run`.
- Pooled token: `vaults.vault_type`.
- Embeds: nullable `org_id` and an origin allowlist on `api_keys`; his `/plans/:id/transactions` stays.
- Audits and governance: contract addresses and upgrade authority in one config, shown at `/health`.

## 5. Risks and the test for each

| Risk | Test before Oct 9 |
|---|---|
| GitHub cron delays or drops runs | 24 hours of no-op `keeper --once` with healthchecks pings; more than two gaps over 30 minutes and the keeper moves to a machine we run |
| Solana legs do not land on free RPC | 20 keeper-shaped $1 legs through Sender plus RPC; 19 must land within two blockhash windows |
| Jupiter at 1 request a second | Time the build of a six-leg buy; count 429s with collectors running |
| Supabase 500 MB against his table sizes | `pg_total_relation_size` on his database; sync only what fits |
| EVM feeds lag | Log feed age and pool mid against feed across a weekend; set the EVM freshness rule from that |
| EVM curves thin on samples | 28-day backfill for five tokens; compute needs 8 samples per regime |
| Server-signing routes survive | A test that lists routes and fails if any non-keeper code loads a signing key |
| Keeper key in CI on a public repo | Environment secrets limited to `main`; key holds under $20; rotate once as a drill |
| RPC credits after Chainstack's free week | Log one day of credits on Helius free; his hourly `getProgramAccounts` rediscovery is the heavy part |

## 6. Questions for a person

1. Rodrigo: may the keeper re-plan a leg that expired without landing, up to three times, while never re-sending one that reverted?
2. Rodrigo: how big are the `risk_*` tables, and is a fifth launchd job that copies them hourly acceptable, or one dated dump?
3. Rodrigo: agree to the additive enum and `executions` changes, six lines in `scripts/risk/compute.ts`, and removing the agent-key routes on the basket branch?
4. Both: is a card on file for a $0 Northflank sandbox within "free tiers only"? It would replace Render and the cron keeper.
5. Who opens the accounts: Supabase, Render, Helius, Alchemy, the Privy app, and a Jupiter key separate from the collectors'?

## 7. Sources

- S1 npm registry, read Oct 1: https://registry.npmjs.org/ (packages named above)
- S2 Privy access tokens: https://docs.privy.io/authentication/user-authentication/access-tokens
- S3 Privy identity tokens: https://docs.privy.io/user-management/users/identity-tokens ; pricing: https://www.privy.io/pricing
- S4 `@fastify/rate-limit`: https://github.com/fastify/fastify-rate-limit
- S5 Alchemy pricing and `eth_getLogs` limits: https://www.alchemy.com/pricing , https://www.alchemy.com/docs/reference/eth-getlogs ; dRPC limits: https://drpc.org/docs/howitworks/ratelimiting and the error returned today ("ranges over 10000 blocks are not supported on free plan")
- S6 Helius rate limits, credits and Sender: https://www.helius.dev/docs/billing , https://www.helius.dev/docs ; Colosseum resource index: https://ColosseumOrg.github.io/hackathon-resources/current.json
- S7 Solana retry guide: https://solana.com/developers/guides/advanced/retry
- S8 Jupiter rate limits: https://developers.jup.ag/docs/portal/rate-limits
- S9 Vercel Hobby: https://vercel.com/docs/plans/hobby ; Fastify on Vercel: https://vercel.com/docs/frameworks/backend/fastify
- S10 Render free: https://render.com/docs/free
- S11 Supabase pricing: https://supabase.com/pricing
- S12 Neon pricing: https://neon.com/pricing
- S13 GitHub Actions schedule and billing: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows , https://docs.github.com/en/billing/concepts/product-billing/github-actions
- S14 Vercel cron limits: https://vercel.com/docs/cron-jobs/usage-and-pricing
- S15 Koyeb pricing: https://www.koyeb.com/pricing
- S16 Northflank pricing: https://northflank.com/pricing
- S17 healthchecks.io pricing: https://healthchecks.io/pricing/
- Ran today: quotes at Robinhood Chain blocks 77460966–77462311 and Base block 52038547; historical calls at Robinhood block 53466194 and Base block 50829186; `api.robinhood.com/rhj/assets`; `reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`; `api.dexscreener.com/latest/dex/tokens/<address>`; `coins.llama.fi/prices/current/…`. Scripts: `docs/vault/research/design-v2/backend-evidence/`.
- Repo files read: `apps/api/src/{app.ts,liquidity.ts,routes/*}`, `packages/db/src/{schema.ts,risk-schema.ts,executions.ts}`, `packages/schemas/src/{liquidity.ts,enums.ts,tx.ts,asset.ts}`, `packages/risk/src/{provider.ts,curves.ts,time.ts}`, `scripts/risk/{compute.ts,collector/*}`, `packages/chain-solana/src/{rpc.ts,sign.ts}`.
