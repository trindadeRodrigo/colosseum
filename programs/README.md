# Solana programs

| Path | What |
|---|---|
| `basket/` | The vault program. Today: config, create a vault, deposit, withdraw to the owner. Design: `docs/vault/DESIGN-VAULT.md` sections 3.7, 5 and 13 |
| `mock-router/` | A test exchange for LiteSVM and devnet. Not part of the product. It takes the input token from the signer and pays the output from its own reserve at a price its admin sets |
| `tests/` | The LiteSVM suite, under Vitest. Its own install: `litesvm` needs `@solana/kit` 8 and the repo is on 2.3 |
| `../idl/` | The interface files other code builds against, committed |

Tools: anchor-cli 0.31.1, solana-cli 3.0.1, platform tools v1.54.

## Build

```sh
anchor build --no-idl -- --tools-version v1.54
```

- `--tools-version v1.54`: the default platform tools (v1.51) cannot build `block-buffer 0.12`, an edition-2024 dependency.
- `--no-idl`: the interface files are built separately (below).
- `Cargo.lock` is committed and `anchor-lang` is pinned to `=0.31.1`. Unpinned, cargo picks 0.31.2.
- One warning is expected per program: Anchor's own macro uses a deprecated `realloc`.

Sizes on Oct 2: `basket.so` 353,152 bytes, `mock_router.so` 266,952 bytes.

## Test

```sh
pnpm test:program        # from the repo root
```

It installs `programs/tests`, typechecks it, rebuilds a program whose sources are newer than its binary, and runs the suite. Nothing leaves the machine: the programs run inside LiteSVM. The root `pnpm test` does not include these tests, because CI has no Solana toolchain yet.

```sh
pnpm --dir programs/tests rules-bite          # every rule; a rebuild each, a few minutes
pnpm --dir programs/tests rules-bite owner    # only rules whose name contains "owner"
```

`rules-bite` takes one check out of the vault program at a time, rebuilds, and reports which tests fail. A rule that no test notices is listed and the command exits 1. It edits `programs/basket/src` while it runs and restores it at the end. When you add a check, add a line to its table.

## Interface files

```sh
anchor idl build -p basket -o idl/basket.json
anchor idl build -p mock_router -o idl/mock_router.json
```

Run both after any change to an instruction, an account or an error. `tests/idl.test.ts` compares the committed files with the instructions the tests build, and fails until they agree.

## Program ids and keypairs

The ids are in `Anchor.toml` and in each program's `declare_id!`; the tests read `Anchor.toml`. No code holds Jupiter's or Scope's address: the router and the owner of the price accounts are fields of `Config`, set by the admin.

The keypairs behind the ids are not in git. They were created in `keys/` of the checkout that built SOL-1 (`keys/basket-keypair.json`, `keys/mock_router-keypair.json`). A program can be deployed at its id only with its keypair, so a person moves those two files to where the deploy keys are kept. If they are lost before the first deploy, make new ones and update `Anchor.toml` and `declare_id!`:

```sh
solana-keygen new --no-bip39-passphrase -o keys/basket-keypair.json
cp keys/basket-keypair.json target/deploy/basket-keypair.json    # where anchor looks
anchor keys sync
```

The tests need no keypair.
