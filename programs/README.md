# Solana programs

| Path | What |
|---|---|
| `basket/` | The vault program. Today: config, create a vault, deposit cash, withdraw any token to the owner. Design: `docs/vault/DESIGN-VAULT.md` sections 3.7, 5 and 13 |
| `mock-router/` | A test exchange for LiteSVM and devnet. Not part of the product. It takes the input token from the signer and pays the output from its own reserve at a price its admin sets |
| `test-hook/` | A hostile transfer hook, for the tests only. It logs the privileges it is handed and uses any signature it gets |
| `tests/` | The LiteSVM suite, under Vitest. Its own install: `litesvm` needs `@solana/kit` 8 and the repo is on 2.3 |
| `../idl/` | The interface files other code builds against, committed |

Tools: anchor-cli 0.31.1, solana-cli 3.0.1, platform tools v1.54 (which build with Rust 1.89.0). On the host, Rust 1.89.0 for clippy and `nightly-2025-09-09` for the interface files. There is no `rust-toolchain.toml`: the build picks its own compiler, and the two host versions are named where they are used.

CI: `.github/workflows/program.yml` installs the same versions, checked against their sha256 where the release publishes one, and runs the build, the tests, the interface-file check and clippy. It runs when `programs/`, `idl/`, `Anchor.toml`, `Cargo.toml` or `Cargo.lock` change. A version bump here is a bump of the `env` block there.

## Build

```sh
anchor build --no-idl -- --tools-version v1.54
```

- `--tools-version v1.54`: the default platform tools (v1.51) cannot build `block-buffer 0.12`, an edition-2024 dependency.
- `--no-idl`: the interface files are built separately (below).
- Pinned in each program's `Cargo.toml`: `anchor-lang` and `anchor-spl` at `=0.31.1` (unpinned, cargo picks 0.31.2), and `solana-program` at `=2.3.0` for `test-hook`. Not ours to pin, and held by the committed `Cargo.lock` at 0.31.2: `anchor-syn`, `anchor-derive-accounts`, `anchor-derive-serde`, `anchor-derive-space` and the six `anchor-attribute-*` macro crates, which `anchor-lang` 0.31.1 asks for as `^0.31.1`.
- `default = ["no-idl"]` in `basket` and `mock-router`: the built program refuses Anchor's instruction that creates an on-chain IDL account. Without it, whoever sends that instruction first becomes the account's authority.
- One warning is expected per Anchor program: Anchor's own macro uses a deprecated `realloc`.

Sizes on Oct 2: `basket.so` 306,096 bytes, `mock_router.so` 212,376 bytes, `test_hook.so` 68,640 bytes.

## Test

```sh
pnpm test:program        # from the repo root
```

It installs `programs/tests`, typechecks it, rebuilds a program whose sources are newer than its binary, and runs the suite. Nothing leaves the machine: the programs run inside LiteSVM. The root `pnpm test` does not include these tests: they need the Solana toolchain, which only the program workflow installs.

```sh
pnpm --dir programs/tests rules-bite          # every rule; a rebuild each, a few minutes
pnpm --dir programs/tests rules-bite owner    # only rules whose name contains "owner"
```

`rules-bite` takes one check out of the vault program at a time, rebuilds, and reports which tests fail. A rule that no test notices is listed and the command exits 1. It edits files under `programs/basket` while it runs and restores them at the end, also when it is interrupted or killed. When you add a check, add a line to its table. A check that no test in LiteSVM can notice goes in the same table with the reason (today one: the extra accounts of a transfer carry no signature, and Token-2022 strips signatures before calling a hook anyway).

## What the program holds to today

- Money comes in as the cash mint only (`Config.cash_mint`, gate `DEPOSIT`). `withdraw` takes out any token the vault holds, to a token account the owner owns, and reads no Config.
- Cash is not a position. What a vault holds in cash is the balance of its associated token account for the cash mint; nothing is stored for it. `Position.tracked` is a hint: the program rewrites it when it moves that mint (today: on withdraw), and a token sent in from outside is not in it.
- The router, the owner of the price accounts and the cash mint are fields of `Config`, set at `init_config` and changed only by the admin. Each change emits the old and the new value.

## Before the swap and the keeper leg

Left for SOL-2 and SOL-3, from the review of SOL-1. None of it is built.

- Bounds for every parameter, at `init_config` and in `set_params`: today only tolerance, loss cap, cooldown and publish delay have one. `twap_dev_bps`, `max_price_age_s`, `band_bps` and the session times take any value, and the guardian, the keeper and the price owner may be the zero address at `init_config`. The 172,800 s floor on the publish delay arrives with `launch()`.
- The three setters take effect at once. Decide with the swap whether they lock at `launch()` or take a delay (`// SOL-2:` in `instructions/config.rs`).
- `owner_swap` and the keeper leg read `Config` the way `deposit` does: `seeds = [CONFIG_SEED], bump = config.bump`.
- The keeper leg reloads both token accounts after the call, and pins the input and the output to the vault's own associated token accounts. `mock-router` pays whatever destination it is told to, as a real router does.
- `sync_balances` before any valuation. `tracked` is not a balance, and cash is not tracked at all.
- `set_targets` and `accept_version` reuse `check_targets`, and carry `tracked` and `last_keeper_ts` across for a mint that stays. Once they read `Config`, they should refuse the cash mint as a target.
- `mock-router`'s `init_router` is first come, first served. Pin it to an admin before devnet (TNET-4), as `init_config` is pinned to the upgrade authority.
- When `close_vault` arrives, an owner-only sweep of token accounts the vault owns that are not the associated ones. Tokens sent to such an account cannot be withdrawn today.
- The destination rule looks at the token account's owner field only. A builder should send withdrawals to the owner's associated token account: an account someone else prepared and handed to the owner can still carry their delegate.

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

The ids are in `Anchor.toml` and in each program's `declare_id!`; the tests read `Anchor.toml`. `test-hook` has no id of its own: the tests load it at a fresh address. No code holds Jupiter's, Scope's or a dollar token's address.

The keypairs behind the ids are not in git. They were created in `keys/` of the checkout that built SOL-1 (`keys/basket-keypair.json`, `keys/mock_router-keypair.json`). A program can be deployed at its id only with its keypair, so a person moves those two files to where the deploy keys are kept. If they are lost before the first deploy, make new ones and update `Anchor.toml` and `declare_id!`:

```sh
solana-keygen new --no-bip39-passphrase -o keys/basket-keypair.json
cp keys/basket-keypair.json target/deploy/basket-keypair.json    # where anchor looks
anchor keys sync
```

The tests need no keypair.
