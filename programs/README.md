# Solana programs

| Path | What |
|---|---|
| `basket/` | The vault program. Today: the config and its switches, the asset list, the shared-portfolio registry with the author limits, and the owner path: create a vault (with targets of its own or following a shared portfolio), deposit cash, swap through the one allowed router, set targets, withdraw any token to the owner. Design: `docs/vault/DESIGN-VAULT.md` sections 3.7, 5, 6 and 13 |
| `mock-router/` | A test exchange for LiteSVM and devnet. Not part of the product. It takes the input token from the signer and pays the output from its own reserve at a price its admin sets. Only its upgrade authority can initialise it, and becomes that admin |
| `puppet-router/` | A hostile router, for the tests only. It runs whatever calls a test scripts, with every privilege the vault handed it |
| `test-hook/` | A hostile transfer hook, for the tests only. It logs the privileges it is handed and uses any signature it gets |
| `tests/` | The LiteSVM suite, under Vitest. Its own install: `litesvm` needs `@solana/kit` 8 and the repo is on 2.3 |
| `../idl/` | The interface files other code builds against, committed |

Tools: anchor-cli 0.31.1, solana-cli 3.0.1, platform tools v1.54 (which build with Rust 1.89.0). On the host, Rust 1.89.0 for clippy and `nightly-2025-09-09` for the interface files. There is no `rust-toolchain.toml`: the build picks its own compiler, and the two host versions are named where they are used.

CI: `.github/workflows/program.yml` installs the same versions, each download checked against a sha256 written in the workflow, and runs the build, the tests, the interface-file check and clippy. It runs when `programs/`, `idl/`, `Anchor.toml`, `Cargo.toml` or `Cargo.lock` change. A version bump here is a bump of the `env` block there.

## Build

```sh
anchor build --no-idl -- --tools-version v1.54
```

- `--tools-version v1.54`: the default platform tools (v1.51) cannot build `block-buffer 0.12`, an edition-2024 dependency.
- `--no-idl`: the interface files are built separately (below).
- Pinned in each program's `Cargo.toml`: `anchor-lang` and `anchor-spl` at `=0.31.1` (unpinned, cargo picks 0.31.2), and `solana-program` at `=2.3.0` for `test-hook`. Not ours to pin, and held by the committed `Cargo.lock` at 0.31.2: `anchor-syn`, `anchor-derive-accounts`, `anchor-derive-serde`, `anchor-derive-space` and the six `anchor-attribute-*` macro crates, which `anchor-lang` 0.31.1 asks for as `^0.31.1`.
- `default = ["no-idl"]` in `basket` and `mock-router`: the built program refuses Anchor's instruction that creates an on-chain IDL account. Without it, whoever sends that instruction first becomes the account's authority.
- One warning is expected per Anchor program: Anchor's own macro uses a deprecated `realloc`.

Sizes on Oct 3: `basket.so` 455,704 bytes (3.17 SOL of rent at deploy, and as much again while an upgrade is in flight), `mock_router.so` 212,376 bytes, `puppet_router.so` 29,992 bytes, `test_hook.so` 68,640 bytes.

## Test

```sh
pnpm test:program        # from the repo root
```

It installs `programs/tests`, typechecks it, rebuilds a program whose sources are newer than its binary, and runs the suite. Nothing leaves the machine: the programs run inside LiteSVM. The root `pnpm test` does not include these tests: they need the Solana toolchain, which only the program workflow installs.

```sh
pnpm --dir programs/tests rules-bite          # every rule; a rebuild each, a few minutes
pnpm --dir programs/tests rules-bite owner    # only rules whose name contains "owner"
```

```sh
pnpm --dir programs/tests rules-bite --check          # builds nothing: every row names a test that exists and an edit that still applies
pnpm --dir programs/tests rules-bite --from=<text>    # from the first rule with that text in its name to the end
```

`rules-bite` takes one check out of the vault program at a time, rebuilds, and reports which tests fail. A rule that no test notices is listed and the command exits 1. It edits files under `programs/basket` while it runs and restores them at the end, also when it is interrupted or terminated: do not build, test or commit that folder while it runs. A run that is killed outright (out of memory, `kill -9`) leaves its one edit behind; the next run refuses to start until `git checkout -- programs/basket` puts it back, and `--from` picks the run up where it stopped. When you add a check, add a line to its table. A check that no test in LiteSVM can notice goes in the same table with the reason (today one: the extra accounts of a transfer carry no signature, and Token-2022 strips signatures before calling a hook anyway).

Three more things the suite holds:

- `creator-limits.vectors.test.ts` drives the registry through every case of `fixtures/creator-limits/vectors.json`, building each case's state with real publishes at the times it gives. A refusal is `CreatorLimit`, and the rule's number is read from the log (`creator limit: reason=<number> <name>`).
- `basket-swap-hostile.test.ts` makes `puppet-router` the router in Config. A test scripts the calls the router makes: the instruction data is eight bytes the router ignores, then one call after another (`src/puppet.ts` writes it).
- `sizes.test.ts` prints the bytes and compute units of the create transactions at 7 and 12 targets, and fails if one that should fit no longer does.

## A real route, replayed

```sh
pnpm exec tsx programs/tests/jupiter-replay.ts freeze                  # from the repo root; read-only
pnpm exec tsx programs/tests/jupiter-replay.ts replay <dir> <rpc port>
```

`freeze` asks Jupiter's `/swap/v2/build` for one route (USDC into SPYx through one Raydium pool, for a placeholder taker) and reads the accounts it names from mainnet over the public RPC. It sends nothing. What it keeps is in `fixtures/solana-vault/jupiter-route.json`: the instruction bytes and account list, the lookup table's contents, and 13 accounts (the pool, its tick arrays, both mints) as they were at that slot, 47,594 bytes in all. The two programs of the route are named, not kept.

`replay` starts `solana-test-validator` with the vault program, clones Jupiter and the pool's program from mainnet at start (read-only, so it needs the network), loads the frozen accounts, and sends real transactions to it. The vault of the replay takes the taker's place in the account list, and its token accounts the place of the taker's. Nothing leaves the machine but those two reads.

On Oct 3, with the route frozen at slot 452,983,734 (`route_v2`, 29 accounts):

| What | Result |
|---|---|
| A vault buys SPYx with 10 USDC through `owner_swap` | Lands. The vault spent 10,000,000 and received 1,290,137 raw units, the amount Jupiter quoted. 659 bytes with the token account opened in the same transaction, 26 accounts, 116,717 compute units, deepest call 4 |
| After it (hostile case A11) | Neither token account of the vault has a delegate or a close authority, and the vault owns both |
| The same route with the output paid to another wallet's account (hostile case A1) | Fails on chain with `ReceivedTooLittle` (6006). The other wallet got nothing and the vault's cash did not move |
| Create with 7 targets, deposit and the first buy, one transaction | Lands: 1,000 bytes, 186,532 compute units, with Jupiter's lookup table and one of the platform's own |
| The same with 12 targets | Lands: 1,170 bytes of the 1,232 allowed, 186,131 compute units |

The call chain is the vault program, Jupiter, the pool's program, the token program: level 4 of the 5 mainnet allows. A route through a private market maker cannot be replayed from a snapshot (it needs its live price), so the frozen route is restricted to one pool with plain maths.

## What the program holds to today

- Money comes in as the cash mint only (`Config.cash_mint`, gate `DEPOSIT`). `withdraw` takes out any token the vault holds, to a token account the owner owns, and reads no Config.
- Cash is not a position. What a vault holds in cash is the balance of its associated token account for the cash mint; nothing is stored for it. `Position.tracked` is a hint: the program rewrites it when it moves that mint (on a withdrawal, and on both sides of a swap), and a token sent in from outside is not in it.
- A target is a mint on the asset list, and never the cash mint. `create_vault` and `set_targets` hold the same rules.
- A mint whose transfer hook names a program is not listed. The program walks the mint's extension list by hand (`mint_has_hook_program` in `checks.rs`): the token crate it is built with, `spl-token-2022` 6.0.0, knows extension types up to 24 and its `get_extension` stops with an error at the first newer one, and the stock tokens carry two of those (scaled UI amount 25, pausable 26) ahead of their hook. The first version of the check read that error as "no hook" and never saw the hook of the real mint; the tests now use the real mint's bytes from `fixtures/solana-vault/jupiter-route.json`, and the test stock mint has the real order. Nothing else in the programs reads an extension through the crate: `token_view` and Anchor's own token types use its `unpack`, which reads the fixed fields and the account-type byte and does not walk the list.
- The owner trades through one program, `Config.router_program`, with one of four route selectors. The vault signs; the owner's signature is not passed on. The vault counts its own two token accounts before and after, takes no third token account of its own in the router's list, and leaves no delegate, no close authority, no other owner and no change of size behind.
- A shared portfolio holds 3 to 12 listed assets, never cash, each from 2% to its ceiling in 50 bps steps; one version per publish delay, none while one waits; a version moves at most 20%. A version whose time has come is in effect with no transaction. A vault created to follow one takes the version in effect, if it is the version the person reviewed.
- The router, the owner of the price accounts and the cash mint are fields of `Config`, set at `init_config` and changed only by the admin, and only until `launch()`. Each change emits the old and the new value. After `launch()` a change needs a program upgrade.
- Every parameter has a hard bound, at `init_config` and in `set_params`. The guardian pauses the keeper paths and only the admin starts them again; no owner instruction reads the pause.

## Before the keeper leg

Left for SOL-3. None of it is built.

- `keeper_leg` takes what `owner_swap` has: the router and selector checks, `refuse_other_vault_accounts` before and after the call, `check_untampered` on both accounts, the input and the output pinned to the vault's associated token accounts, and only the vault's signature passed on. It adds the keeper's own checks (section 5) and computes the minimum output itself. It is the first instruction to read `Config.keeper_paused`.
- `sync_balances` before any valuation. `tracked` is not a balance, and cash is not tracked at all.
- `accept_version` and `adopt_version` read the version in effect through `Recipe::active(now)`, never `current` alone, and write the targets through `Vault::set_positions`, which keeps `tracked` and `last_keeper_ts` for a mint that stays. The fields they write (`recipe`, `accepted_version`, `auto_follow`) are in place.
- The asset list has no writer for `price_accounts`, and `AssetEntry.flags` must be zero until a bit means something. `Recipe.vetoed` is never written: the guardian's veto is `cancel_pending`.
- Not built from the admin's and the guardian's lists: `set_guardian`, `set_closed`, `extend_closed_until`, `add_closed_day`. Until `set_guardian` exists the guardian named at `init_config` cannot be changed.
- A version published before `launch()` keeps the delay it was published under. Publish nothing in the last short delay before launching, or cancel what waits.
- The reader (`packages/chain-solana/src/vault`) refuses a vault with a non-zero `loss_accum` until the keeper leg defines its unit.
- When `close_vault` arrives, an owner-only sweep of token accounts the vault owns that are not the associated ones. Tokens sent to such an account cannot be withdrawn today, and such an account in a router's list makes the swap fail.
- The destination rule of `withdraw` looks at the token account's owner field only. A builder should send withdrawals to the owner's associated token account: an account someone else prepared and handed to the owner can still carry their delegate.

## Interface files

```sh
anchor idl build -p basket -o idl/basket.json
anchor idl build -p mock_router -o idl/mock_router.json
```

Run both after any change to an instruction, an account or an error. `tests/idl.test.ts` compares the committed files with the instructions the tests build, and fails until they agree. CI builds both again and fails if a committed file differs by a byte. Anchor builds them with a nightly compiler; to use the one CI uses: `RUSTUP_TOOLCHAIN=nightly-2025-09-09 anchor idl build ...`.

```sh
cargo +1.89.0 clippy --workspace --all-targets --locked    # what CI lists; warnings do not fail it yet
cargo deny --locked check advisories licenses              # security.yml; the rules are in deny.toml
```

Three warnings per Anchor program come from Anchor's own macros (`unexpected cfg condition value: solana` twice, and the deprecated `realloc`).

## Program ids and keypairs

The ids are in `Anchor.toml` and in each program's `declare_id!`; the tests read `Anchor.toml`. `test-hook` and `puppet-router` have no id of their own: the tests load them at a fresh address. No program holds Jupiter's, Scope's or a dollar token's address, and a test fails if one appears in `basket/src`. The replay script and its fixture name the real ones: that is what they are for.

The keypairs behind the ids are not in git. They were created in `keys/` of the checkout that built SOL-1 (`keys/basket-keypair.json`, `keys/mock_router-keypair.json`). A program can be deployed at its id only with its keypair, so a person moves those two files to where the deploy keys are kept. If they are lost before the first deploy, make new ones and update `Anchor.toml` and `declare_id!`:

```sh
solana-keygen new --no-bip39-passphrase -o keys/basket-keypair.json
cp keys/basket-keypair.json target/deploy/basket-keypair.json    # where anchor looks
anchor keys sync
```

The tests need no keypair.
