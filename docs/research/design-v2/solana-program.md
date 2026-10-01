# Solana vault program: design v2 note

Oct 1, 2026. Stream: `programs/basket`. A claim tagged [n] was checked today against source n in section 7. "(memory)" means not re-checked.

## 1. Bottom line

- One Anchor program holds the vaults, the index registry and the platform asset list. The spike's shape stands: one program-derived account (PDA, an address only the program can sign for) per basket stores the state and signs the swap. Keep its balance checks; add the keeper path.
- Port the spike to Anchor 1.2.0 (current stable) with a half-day limit. If it is not green by Oct 2, stay on 0.31.1 exactly as the spike builds today.
- Take the swap instruction from Jupiter's `GET /swap/v2/build`. It is now the documented path and returns `route_v2`; the `/quote` + `/swap-instructions` pair the spike used is labelled legacy [4][5]. `route_v2` has not yet been run from a vault.
- Kamino Scope's free prices cover ten stock tokens and nothing else: no MSFTx, AMZNx, COINx, GLDx or yield token [7]. Auto-follow on Solana can only run on vaults whose every asset is in that list. The 500 is 100% SPYx and never rebalances, so the auto-follow demo needs another index.
- The index registry is onchain, in the same program, and small: components, version, effective time, creator limits. Names and copy stay in Postgres.

## 2. What to use for the MVP

**Versions**

| Piece | Use | Notes |
|---|---|---|
| Anchor | `anchor-lang`, `anchor-spl` `=1.2.0` (Sep 4) [1] | 1.0 (Apr 2) moved to Solana 3.x crates, made `CpiContext::new` take a program id, moved the onchain IDL to the Program Metadata program, and runs `anchor test` on surfpool. 1.2 adds the `--tools-version` flag the spike needed and pausable-mint helpers |
| Solana CLI | 3.1.x for builds | The foundation vault pins 3.1.14 [13]. Mainnet runs Agave 4.3.0 [3] |
| Fast tests | npm `litesvm` 1.5.0 under Vitest [9] | In-process runtime that loads the built `.so`; no Rust version matching |
| Fork tests | surfpool 1.6.0 [10] | Local validator that fetches mainnet accounts on demand; replaces the spike's clone list |
| Client | `@codama/nodes-from-anchor` 1.5.6 → `@codama/renderers-js` 2.5.0 [11] | Turns the IDL (the program's interface file) into a typed `@solana/kit` client |
| Verified build | `solana-verify` 0.5.2 [12] | `--remote` is deprecated: upload the PDA with the upgrade key, then `remote submit-job` |

**Where files go** (Rodrigo's repo has no Rust yet)

- Root: `Anchor.toml`, `Cargo.toml`, `rust-toolchain.toml`. Program: `programs/basket/src/{lib,state,errors,events,checks}.rs` and `instructions/`. Test only: `programs/mock-router/`.
- `programs/basket/vendor/{svs-math,svs-oracle}`: copied from solanabr at `ceb54f3`, in a commit prefixed `prior:`.
- `idl/basket.json`, committed. CI fails if a build changes it (foundation vault pattern).
- `packages/basket-client/`: generated client, PDA helpers, error table. It carries its own `@solana/kit@^8`: the repo is on kit 2.3 (klend-sdk 12 requires `^2.3.0`), while the current renderer and `litesvm` need kit 8 [11][14]. Instructions cross into `packages/chain-solana` as plain objects.
- `scripts/solana/`: client generation, fork run, the $10 mainnet run (the spike's scripts, ported).
- `.github/workflows/program.yml`: build, IDL check, tests.

**Accounts.** Freeze these before the parallel build.

```rust
// seeds: ["config"] | ["assets"] | ["recipe", creator, recipe_id u64 LE] | ["vault", owner, basket_id u64 LE]
pub struct Config {            // one
  admin, pending_admin, guardian, default_keeper: Pubkey,
  keeper_paused: bool,
  tolerance_bps: u16, loss_cap_bps: u16, band_bps: u16, twap_dev_bps: u16,
  max_price_age_s: u16, asset_cooldown_s: u32, publish_delay_s: u32,
  session_open_utc_s: u32, session_close_utc_s: u32, closed_until: i64,
  reserved: [u8; 128] }
pub struct AssetRegistry {     // one, zero-copy, about 3.4 KB
  price_accounts: [Pubkey; 4], count: u8, assets: [AssetEntry; 64] }
pub struct AssetEntry { mint: Pubkey, price_slot: u8, price_index: u16, twap_index: u16,
  decimals: u8, price_kind: u8 /*0 none,1 scope*/, session: u8 /*0 always,1 US hours*/, flags: u8 }
pub struct Recipe {            // one per index, about 1 KB
  creator: Pubkey, recipe_id: u64, current: RecipeVersion, pending: RecipeVersion,
  last_publish_ts: i64, week_start_ts: i64, week_turnover_bps: u16, vetoed: bool, reserved: [u8; 64] }
pub struct RecipeVersion { version: u32, effective_at: i64, hash: [u8; 32], count: u8,
  components: [Component; 12] }                 // Component { mint: Pubkey, weight_bps: u16 }
pub struct Vault {             // about 1.06 KB
  owner: Pubkey, basket_id: u64, bump: u8, keeper: Pubkey /*default = Config's*/,
  auto_follow: bool, recipe: Pubkey, accepted_version: u32, count: u8,
  positions: [Position; 16],
  loss_accum: u64, loss_ts: i64, reserved: [u8; 128] }
pub struct Position { mint: Pubkey, target_bps: u16, tracked: u64, last_keeper_ts: i64 }
```

- Only `current` and `pending` versions live onchain. History goes out as a `RecipePublished` event and into Postgres. A pending version counts as current once `effective_at` passes.
- The vault copies its targets when it adopts a version, so a keeper leg needs no recipe account.
- Rent [15]: vault 0.0060 SOL, token account about 0.0015. A 12-asset vault costs about 0.027 SOL, refundable.

**Instructions**

- Owner: `create_vault`, `deposit`, `owner_swap(max_in, min_out, data)` (the spike's `swap`), `set_targets`, `accept_version` (new assets), `set_auto_follow`, `set_keeper`, `withdraw(mint, amount)`, `close_vault`.
- Keeper: `keeper_leg(amount_in, data)`. No `min_out` argument; the program computes it.
- Anyone: `adopt_version` (weights-only change, after the delay, auto-follow on), `sync_balances`.
- Creator: `publish_recipe`, `update_recipe`. Guardian: `pause_keeper`, `unpause_keeper`, `veto_pending`. Admin: `init_config` (signer must be the program's upgrade authority), `set_params`, `upsert_asset`, two-step admin transfer.
- `withdraw` and `owner_swap` take no Config, registry or price account, so a pause or a dead feed cannot block the owner.
- One error per rule, order frozen on day 1: `NotKeeper, AutoFollowOff, KeeperPaused, MintNotAccepted, RouterNotAllowed, SpentTooMuch, ReceivedTooLittle, OtherAccountDebited, AccountTampered, PriceStale, PriceDeviation, MarketClosed, MultiplierWindow, NotTowardTarget, PastTarget, Cooldown, LossCapReached, AssetNotPriced, NewAssetNeedsOwner, VersionNotEffective, CreatorLimit`.

**The keeper checks, cheaply**

| Rule | How |
|---|---|
| 1 Caller | Signer equals `vault.keeper` (or Config's default); `auto_follow` on; not paused |
| 2 Assets | Both mints are in `positions` or are the cash mint |
| 3 Output lands | The spike's code: read both vault token accounts before and after; no other vault account debited; no delegate or close authority set |
| 4 Value | `value(received) ≥ value(spent) × (1 − tolerance)` from two Scope entries. USDC counts as $1, which fails closed on a depeg |
| 5 Toward target | Vault value = Σ `tracked × price`. `tracked` is rewritten from the live balance on every deposit, withdraw and leg, so no extra token accounts are passed. Sell only if overweight, buy only if underweight, stop within `band_bps` of target |
| 6 Rate | Cooldown per asset, so a rebalance runs in one pass but nothing ping-pongs. Loss: add `spent − received` value to `loss_accum`, decayed over 7 days, capped at `loss_cap_bps` of vault value |
| 7 Fresh and open | Scope entry at most 120 s old and within `twap_dev_bps` of Scope's 1-hour average entry (Scope has no confidence value); clock inside the US session; not within 24 h of the mint's scheduled multiplier change |
| 8 Pause | `Config.keeper_paused` |

All of it is integer maths over at most 16 entries through `svs-math`. Estimate: 35–40k compute units on top of the spike's 20k (memory; measure).

**Tokens.** Use `anchor_spl::token_interface` and `transfer_checked` everywhere; that covers classic SPL and Token-2022 (the newer token program with optional extensions). SPYx's extensions, read today [8]:

| Extension | Meaning for the vault |
|---|---|
| Pausable, freeze authority | The issuer can stop a mint or an account. Withdraw is per mint, so one stuck asset never blocks the rest |
| Permanent delegate | The issuer can move or burn the vault's tokens. `tracked` is a hint; `sync_balances` repairs it |
| Scaled UI amount (multiplier 1.0057) | Program maths is in raw units. Scope prices are per raw token; do not multiply again |
| Transfer hook: authority set, program null | No hook runs today. `upsert_asset` rejects a mint with a hook program; `withdraw` forwards extra accounts in case the issuer adds one |
| Default state initialized, no transfer fee | New token accounts work at once |

**Jupiter by CPI** (cross-program invocation: our program calls Jupiter and signs as the vault).

- `GET https://api.jup.ag/swap/v2/build?taker=<vault>&maxAccounts=30&dexes=…` returns the swap instruction, lookup-table contents and a blockhash in one call, with no Jupiter fee [4]. A keyless call with a program address as taker returned `route_v2` (first 8 bytes `bb64facc31c4af14`): 29 accounts for one Raydium pool, 45 for a two-pool split [5].
- The program accepts only Jupiter's program id and the `route_v2` or `shared_accounts_route_v2` selector, then forwards bytes and accounts as the spike does. Jupiter's setup instructions are dropped; token accounts are created with the vault.
- `/build` has no direct-route switch [4]. The adapter rejects any `routePlan` step whose mints are outside the pair.
- One leg per transaction: v0, Jupiter's lookup tables (lists that shorten addresses to one byte) plus one of ours for Config, registry, the Scope account and program ids.
- Compute budget: Jupiter returns only the price. Simulate, set the limit to 1.2× the result, and clamp the price [4].
- Mainnet still allows 4 nested calls (SIMD-0296 inactive) [3]. The spike used all 4, so a keeper leg cannot be wrapped in another program.

**Scope.** Prices account `3t4JZcue…`, owned by `HFn8GnPA…`, 28,712 bytes. Entry `i` is 56 bytes at offset `40 + 56·i`: value u64, exponent u64, slot u64, unix time u64, 24 spare [6]. Read at 14:56 UTC: SPYx 764.82, 46 s old [6]; Jupiter quoted 764.8 [5]. Parse by hand; the Scope crate is BUSL-licensed. Pin `(account, index)` per asset in the registry. Kamino can remap an index, so the keeper re-derives it from Kamino's reserve before each run.

**Authority.** Upgrade authority: a Squads 2-of-2 if set up by Oct 8, otherwise one disclosed key. Guardian and keeper are hot keys with one power each.

**Tests**

1. Rust unit and property tests on `checks.rs`.
2. LiteSVM with `mock-router` loaded at Jupiter's address and a hand-written Scope account: every adversarial case in the v1 design, plus a paused mint, a seizure, a donation and a hook added after deposit.
3. surfpool: real `route_v2`, real pools, real Scope account, replaying a saved route.
4. The $10 mainnet run.

## 3. What to skip or defer

- Mollusk: one harness is enough; LiteSVM reports compute units.
- Rust-side LiteSVM tests: matching crate versions with Anchor costs time.
- Pyth and Chainlink on Solana: paid or gated.
- v1 transactions (4 KB, no lookup tables): kit 2.3 cannot build them.
- Jupiter at top level between two of our instructions: a PDA cannot sign there.
- Share tokens, onchain flattening of nested baskets, an account per recipe version, view instructions.

## 4. Seams for the roadmap

- Creator fees: `reserved` in `Recipe` and `Vault`.
- CCIP sync: `RecipeVersion.hash` uses the same encoding as the EVM `RecipePublished` hash.
- New basket types: `reserved` in `Vault`; a protected basket adds fields, not accounts.
- Drift rebalancing: rule 5 already measures drift; add a trigger that needs no new version.
- Paid price feeds: `price_kind` and four `price_accounts` slots.
- Agent-run indexes: `vault.keeper` is per vault.
- Pooled token: a separate program reading the same `Recipe`.
- Embeds: the committed IDL and generated client.
- Audits and governance: two-step admin, Squads, verified build.
- Community: `Vault.recipe` at a fixed offset, so follower counts are one filtered query.

## 5. Risks and the test that settles each

| Risk | Test, by when |
|---|---|
| `route_v2` from a vault is unproven; Jupiter's default picks are private market makers that failed locally | Port the spike to `/build`; run on surfpool, then $10 on mainnet with default routing. Oct 3 |
| Anchor 1.2 port stalls | Half-day limit on Oct 2; else `=0.31.1` |
| Only ten priced tokens; Scope's off-hours behaviour unknown | Re-read the entries on Saturday Oct 3; pick a demo index inside the ten |
| Keeper leg exceeds 1,232 bytes or 64 accounts on split routes | Measure three route shapes with our lookup table. Oct 4 |
| Depth 4 is the ceiling | Run each DEX label Jupiter returns for SPYx, QQQx and NVDAx on surfpool; allowlist those that pass |
| kit 2.3 and kit 8 side by side | Typecheck one generated instruction passed into `chain-solana`'s builder. Oct 2 |
| Jupiter free tier is 1 request a second per organisation [4] | Keeper dry run over 20 vaults; quote with Rodrigo's pool decoders, call Jupiter only to build |
| Deploy cost: 500 KB is 2.54 SOL of rent [15] | Fund the deploy wallet with 5 SOL |
| Verified build is slow in Docker on Apple Silicon (memory) | Dry run by Oct 6 |

## 6. Questions for a person

1. Which Solana index shows auto-follow? It must be multi-asset and inside AAPLx, CRCLx, GOOGLx, HOODx, METAx, MSTRx, NVDAx, QQQx, SPYx, TSLAx.
2. Must auto-follow cover a personal basket that contains an index, or only a vault that follows one index directly? This note assumes the second.
3. Upgrade authority: Squads 2-of-2 or one key, and who funds 5 SOL?
4. Thom: may agents install Anchor 1.2.0, Solana CLI 3.1.x, surfpool and Docker on the build machine?
5. Rodrigo: are a Rust workspace at the repo root, a second CI job and a kit 8 package beside kit 2.3 acceptable?

## 7. Sources

1. Anchor (repo now `otter-sec/anchor`): https://github.com/otter-sec/anchor/releases , https://github.com/otter-sec/anchor/blob/master/CHANGELOG.md , https://www.anchor-lang.com/docs/updates/release-notes/1-0-0
2. crates.io: `anchor-lang` 1.2.0, `litesvm` 0.17.0, `mollusk-svm` 0.15.1
3. `solana cluster-version -um` and `solana feature status -um`, run today; https://github.com/anza-xyz/agave/releases
4. Jupiter: https://developers.jup.ag/docs/swap/build , https://developers.jup.ag/docs/swap/migration/metis-to-build , https://developers.jup.ag/docs/swap/build/common-instructions , https://developers.jup.ag/docs/portal/rate-limits , https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml
5. Two keyless read-only calls to `api.jup.ag/swap/v2/build` (10 USDC → SPYx), today
6. https://github.com/Kamino-Finance/scope : `programs/scope/src/states/{oracle_prices,dated_price}.rs`, `utils/consts.rs`, `oracles/chainlink.rs`; `getAccountInfo` on the prices account, today
7. https://api.kamino.finance/kamino-market/5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua/reserves/metrics
8. `getAccountInfo` (jsonParsed) on the SPYx mint, today
9. https://github.com/LiteSVM/litesvm/releases/tag/v0.17.0 ; npm `litesvm` 1.5.0
10. https://github.com/solana-foundation/surfpool (README, v1.6.0)
11. npm `@codama/renderers-js` 2.5.0, `@codama/nodes-from-anchor` 1.5.6; https://github.com/codama-idl/renderers-js
12. https://github.com/solana-foundation/solana-verifiable-build (README, v0.5.2)
13. https://github.com/solana-foundation/vault (`Cargo.toml`, `Anchor.toml`)
14. npm `@kamino-finance/klend-sdk` (requires kit `^2.3.0`); `@solana/kit` latest 8.4.0
15. `solana rent <bytes> -um`, today
16. Local: `spikes/solana-vault-swap/README.md`; `docs/research/open-questions/{spike-solana-vault,solana-vault-standards,solana-price-reference}.md`; `docs/research/vaults/{solana-feasibility,permission-security}.md`
