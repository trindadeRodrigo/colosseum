# Solana programs

| Path | What |
|---|---|
| `basket/` | The vault program. The config and its switches, the asset list, the shared-portfolio registry with the author limits, the owner path (create a vault with targets of its own or following a shared portfolio, deposit cash, swap through the one allowed router, set targets, accept a version, switch auto-follow, withdraw any token to the owner) and the keeper path (one trade per call under the checks of section 5, and adopting a version that adds no asset). Design: `docs/vault/DESIGN-VAULT.md` sections 3.7, 5, 6 and 13 |
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

Sizes on Oct 4: `basket.so` 572,816 bytes (3.99 SOL of rent at deploy, and as much again while an upgrade is in flight; it was 460,600 before the keeper leg), `mock_router.so` 275,224 bytes, `puppet_router.so` 29,992 bytes, `test_hook.so` 68,640 bytes.

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

More that the suite holds:

- `creator-limits.vectors.test.ts` drives the registry through every case of `fixtures/creator-limits/vectors.json`, building each case's state with real publishes at the times it gives. A refusal is `CreatorLimit`, and the rule's number is read from the log (`creator limit: reason=<number> <name>`).
- `basket-swap-hostile.test.ts` makes `puppet-router` the router in Config. A test scripts the calls the router makes: the instruction data is eight bytes the router ignores, then one call after another (`src/puppet.ts` writes it).
- `sizes.test.ts` prints the bytes and compute units of the create transactions at 7 and 12 targets, and fails if one that should fit no longer does. `keeper-sizes.test.ts` does the same for a keeper leg in a vault that holds 2, 7, 12 and 16 positions, and for an accept and an adopt.
- `basket-keeper.test.ts` runs the keeper's leg through the test exchange against a price account written by hand in Scope's layout (`src/prices.ts`), one test for each check of section 5 at its boundary. `basket-keeper-hostile.test.ts` puts the hostile router behind it. `basket-accept.test.ts` is accept, adopt and the auto-follow switch; `basket-keeper-admin.test.ts` the setters the keeper slot added.
- The price and average positions the tests give their assets are the real ones of SPYx and QQQx, read from `fixtures/solana-vault/scope-indexes.json`.

## A real route, replayed

```sh
pnpm exec tsx programs/tests/jupiter-replay.ts freeze                  # from the repo root; read-only
pnpm exec tsx programs/tests/jupiter-replay.ts replay <dir> <rpc port>
```

`freeze` asks Jupiter's `/swap/v2/build` for one route (USDC into SPYx through one Raydium pool, for a placeholder taker) and reads the accounts it names from mainnet over the public RPC. It sends nothing. What it keeps is in `fixtures/solana-vault/jupiter-route.json`: the instruction bytes and account list, the lookup table's contents, and 13 accounts (the pool, its tick arrays, both mints) as they were at that slot, 47,594 bytes in all. The two programs of the route are named, not kept.

`replay` starts `solana-test-validator` with the vault program, clones Jupiter and the pool's program from mainnet at start (read-only, so it needs the network; it gets the programs as they are that day, not as they were at the frozen slot), loads the frozen accounts, and sends real transactions to it. The vault of the replay takes the taker's place in the account list, and its token accounts the place of the taker's. Nothing leaves the machine but those two reads.

On Oct 3, with the route frozen at slot 452,983,734 (`route_v2`, 29 accounts):

| What | Result |
|---|---|
| A vault buys SPYx with 10 USDC through `owner_swap` | Lands. The vault spent 10,000,000 and received 1,290,137 raw units, the amount Jupiter quoted. 659 bytes with the token account opened in the same transaction, 26 accounts, 116,717 to 127,248 compute units over three runs, deepest call 4 |
| After it (hostile case A11) | Neither token account of the vault has a delegate or a close authority, and the vault owns both |
| The same route with the output paid to another wallet's account (hostile case A1) | Fails on chain with `ReceivedTooLittle` (6006), raised by the vault program after Jupiter itself succeeded (read from the logs: the route's own programs number their errors from 6000 too). The other wallet got nothing and the vault's cash did not move |
| Create with 7 targets, deposit and the first buy, one transaction | Lands: 1,000 bytes, 183,532 to 188,032 compute units, with Jupiter's lookup table and one of the platform's own |
| The same with 12 targets | Lands: 1,170 bytes of the 1,232 allowed, 186,131 to 190,631 compute units |

The compute units differ from run to run because each run makes new keys, and finding an address's bump costs more for some keys than for others. The call chain is the vault program, Jupiter, the pool's program, the token program: level 4 of the 5 mainnet allows. A route through a private market maker cannot be replayed from a snapshot (it needs its live price), so the frozen route is restricted to one pool with plain maths.

## What the program holds to today

- Money comes in as the cash mint only (`Config.cash_mint`, gate `DEPOSIT`). `withdraw` takes out any token the vault holds, to a token account the owner owns, and reads no Config.
- Cash is not a position. What a vault holds in cash is the balance of its associated token account for the cash mint; nothing is stored for it. `Position.tracked` is a hint: the program rewrites it when it moves that mint (on a withdrawal, on both sides of a swap, on a keeper leg) and anyone can have it rewritten from the vault's own token accounts (`sync_balances`). A token sent in from outside is not in it until then.
- A target is a mint on the asset list, and never the cash mint. `create_vault` and `set_targets` hold the same rules.
- A mint whose transfer hook names a program is not listed, and the keeper does not trade one that gained a hook program after it was listed. The program walks the mint's extension list by hand (`mint_extension` in `checks.rs`): the token crate it is built with, `spl-token-2022` 6.0.0, knows extension types up to 24 and its `get_extension` stops with an error at the first newer one, and the stock tokens carry two of those (scaled UI amount 25, pausable 26) ahead of their hook. The first version of the check read that error as "no hook" and never saw the hook of the real mint; the tests now use the real mint's bytes from `fixtures/solana-vault/jupiter-route.json`, and the test stock mint has the real order. Nothing else in the programs reads an extension through the crate: `token_view` and Anchor's own token types use its `unpack`, which reads the fixed fields and the account-type byte and does not walk the list.
- The owner trades through one program, `Config.router_program`, with one of four route selectors. The vault signs; the owner's signature is not passed on. The vault counts its own two token accounts before and after, takes no third token account of its own in the router's list, and leaves no delegate, no close authority, no other owner and no change of size behind. The keeper's leg makes the same checks with the same functions, and passes on the vault's signature only, never the keeper's.
- A shared portfolio holds 3 to 12 listed assets, never cash, each from 2% to its ceiling in 50 bps steps; one version per publish delay, none while one waits; a version moves at most 20%. A version whose time has come is in effect with no transaction. A version number is never used twice: a cancel spends it.
- A vault takes a version three ways: at creation, by the owner's `accept_version`, or, with auto-follow on, by `adopt_version`, which anyone may send and which takes only a version whose assets the vault already has a target on. A version that drops an asset leaves it in the vault as a position with a target of zero while the vault holds any of it, so the keeper can sell it.
- The router, the owner of the price accounts, the cash mint and the price accounts of the asset list are set by the admin, and only until `launch()`. Each change emits the old and the new value. After `launch()` a change needs a program upgrade. The guardian and the default keeper can be replaced by the admin at any time.
- Every parameter has a hard bound, at `init_config` and in `set_params`. The guardian pauses the keeper paths, pushes `closed_until` later and closes a day; only the admin undoes any of it. No owner instruction reads the pause, the closed days, a price, or an asset's keeper switch.

## The keeper's leg

`keeper_leg(amount_in, data)` is the one thing the keeper key can do to a vault, and only to one whose owner switched auto-follow on. It trades cash for one of the vault's positions, or the position for cash, through the router. In the order the program checks, once the accounts themselves have passed (the router and the price account are the ones Config names, the two token accounts are the vault's associated ones):

| Check | Refusal |
|---|---|
| The signer is the vault's keeper, or Config's default when the vault names none | `NotKeeper` |
| Auto-follow is on; the keeper is not paused | `AutoFollowOff`, `KeeperPaused` |
| Cash is on exactly one side; the other side is a position of the vault | `NotCashLeg`, `MintNotAccepted` |
| The asset was not traded by the keeper within the cooldown | `Cooldown` |
| Its mint has no hook program and no multiplier change within a day, before or after | `HookNotAllowed`, `MultiplierWindow` |
| For a stock: Monday to Friday, inside the session, not a closed day, not before `closed_until` | `MarketClosed` |
| The asset, and every other position the vault holds something of, has a price reference (below) | `AssetNotPriced`, `KeeperAssetOff`, `PriceStale`, `PriceDeviation` |
| The router is called for a route and nothing else, and its account list holds no third token account of the vault | `RouterNotAllowed`, `AccountTampered` |
| A purchase finds the asset under its target, a sale over it | `NotTowardTarget` |
| After the call: the vault's two token accounts are as they were but for the balance, and still no third one is in the list | `AccountTampered` |
| At most `amount_in` was spent | `SpentTooMuch` |
| What came in is worth what went out less the tolerance, at the reference price | `ReceivedTooLittle` |
| The asset ends inside the band on the far side of its target, or before it | `PastTarget` |
| What the leg lost, added to what is left of the week's losses, is within the cap | `LossCapReached` |

A weight is the asset's value over everything the vault holds: its cash account at one dollar, the traded asset's own account, and the other positions by `tracked`, each at its price. The loss counter is in raw units of the cash mint; it falls in a straight line to nothing over seven days from the last loss, and a leg that loses nothing neither reads the cap nor touches the counter. Because the counter drains while it fills, the most that can be lost in any seven days is under twice the cap, not the cap (design section 5).

What it costs, through the test exchange (`keeper-sizes.test.ts`, Oct 4): 718 bytes, or 504 with the platform's lookup table, and 65,778 compute units in a vault with 2 positions, 68,338 with 7, 78,573 with 12 and 81,790 with 16, since every position the vault holds is valued. That is one account more than the owner's swap and a few thousand units per position on top of it; through Jupiter's route the owner's swap alone measured 117,000 to 127,000 units, so a builder asks for a budget above the default 200,000 for a leg in a full vault. An accept is 250 bytes and 10,875 units, an adopt 278 bytes and 14,449, a sync of 12 balances 608 bytes and 49,185. A keeper leg through Jupiter's own route has not been replayed.

### The price reference, and what the admin checks before switching an asset on

A leg is valued at the entries of one price account in Kamino Scope's layout: the asset's price entry and the entry of its one-hour average. On every leg the program holds the price to `max_price_age_s`, the average to one hour, and the two to `twap_dev_bps` of each other. That catches a feed that stopped, or a price that jumped away from its own recent past. It does not catch a feed that is wrong and steady: on mainnet two stock tokens read exactly 1.0000 on every refresh for six months, and an average of that is 1.0000 too (`docs/risk/STATE-RISK.md`, 2026-10-02). A leg valued at such an entry is not bounded by the tolerance or by the loss cap.

So the keeper trades an asset, and values a vault that holds it, only when bit 0 of the asset's `flags` is set. The admin sets it with `upsert_asset`, and before doing so checks, for that asset, over at least one full US session:

1. The price index and the average index are the ones in `fixtures/solana-vault/scope-indexes.json` for the mint, in the price account named there, and the asset list names that account for the entry's slot (`set_price_account`).
2. The price moves. Read the entry at the price index at least every minute through the session: it takes many different values, and none of them is a round placeholder.
3. Its time refreshes. In market hours no two reads are more than `max_price_age_s` apart in the entry's own unix time, and the average's time is never more than an hour old.
4. It is the price of the token. At three moments of the session, at least an hour apart, the entry is within 100 bps of the mid of the token's deepest pool against the dollar, read in the same minute (the liquidity layer's pool price, never the same feed).
5. The exponent of both entries is at most 18, and the mint has no transfer hook program and no multiplier change scheduled.

What was read, and when, goes into the ledger row of the deploy. The switch comes off the same way (`upsert_asset` with `flags` 0) the moment any of this stops holding; until the admin gets there, the guardian's `pause_keeper` stops every leg. The switch never touches the owner: `owner_swap` and `withdraw` do not read it.

## Not built yet

- `set_keeper`: the program honours a keeper a vault names for itself, and nothing writes that field. `close_vault`.
- The comparison of an asset's price source with a pinned one (`source_check`, hostile case A5b). The field stays zero; the keeper leg refuses an asset whose field is not zero, so setting it is not mistaken for protection.
- A keeper leg takes one price account. A vault whose positions are priced in two of the asset list's four slots cannot be valued, so every listed asset goes in one slot for now.
- A strict bound of one cap on what can be lost in any seven days: the losses would be kept per day (eight daily sums fit in the vault's reserved bytes). Today's counter drains as it fills.
- The guardian cannot switch a single asset off for the keeper: it has the pause, and the admin has the switch.
- The asset list has no way to take a token off it or to mark one as closed to new buys, and `upsert_asset` refuses a listed mint once its issuer gives it a hook program, so the entry of exactly the token that turned cannot be rewritten: its keeper switch stays as it was, and the keeper leg itself refuses the mint. A delist flag in `AssetEntry.flags` is the place for it.
- A ceiling lowered under a weight a shared portfolio already holds leaves that portfolio with no version it can publish when the weight is above 20%: leaving the weight breaks the ceiling, and taking it out moves more than a version may. A version should be allowed to lower an over-ceiling weight toward its ceiling. This changes the author limits on both chains.
- Events are logged with `emit!`, in the transaction's log, which a long log can cut short. `emit_cpi!` is not used.
- A proposed admin does not expire.
- A version published before `launch()` keeps the delay it was published under. Publish nothing in the last short delay before launching, or cancel what waits.
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

## Deploying to a test network

A person's step. Deploy two programs, each by name:

```sh
anchor build --no-idl -- --tools-version v1.54
anchor deploy -p basket --program-keypair keys/basket-keypair.json --provider.cluster devnet
anchor deploy -p mock_router --program-keypair keys/mock_router-keypair.json --provider.cluster devnet
```

Never a bare `anchor deploy`: it deploys every program of the workspace, and two of them are test tools. `puppet_router` is a router made to misbehave and `test_hook` a transfer hook; neither belongs on a network people use.

The wallet that deploys a program is its upgrade authority, and only that key can run `init_router` and `init_config`. Then, in this order:

1. The test mints: the dollar token and the stock tokens (TNET-4). `init_config` takes the dollar mint as an account, so it has to exist first.
2. `mock_router`: `init_router()`, then `init_pair(price_num, price_den)` once per direction, and tokens into the router's reserve accounts (the associated token accounts of the router's address).
3. `basket`: `init_config(args)` with the dollar mint as `cash_mint`, `router_program` the test exchange, and a guardian, a default keeper and a price owner that are not the zero address. The admin can replace the guardian and the default keeper later (`set_guardian`, `set_default_keeper`).
4. `init_assets()`, then `set_price_account(0)` with the price account as an account: it has to exist, be owned by the price owner in Config, and be 28,712 bytes, the size of Scope's. On a test network that is the test price program's account, which has to hold, for every asset, a price entry and a second entry for its one-hour average, both kept fresh: the keeper leg reads both.
5. `upsert_asset(args)` for each mint, with `price_kind` 1, the price and average indexes, `session` 1 for a stock token, and `flags` 0. For the ten stock tokens the indexes are in `fixtures/solana-vault/scope-indexes.json` (the real ones, so one asset list serves both networks). Every asset goes in slot 0: a leg takes one price account.
6. The closed days: `set_closed_day(day, true)` for each market holiday ahead, as days since 1970 (`fixtures/risk/us-market-holidays.json`). The list holds 32.
7. `publish_recipe(..)` for each shared portfolio, by its creator.
8. For each asset the keeper should trade, the checks of "The price reference" above, then `upsert_asset` again with `flags` 1. Until then the keeper trades nothing, and owners are not affected.
9. `launch()` last, and only once the router, the price owner, the cash mint and the price account are final: until then `set_router`, `set_price_owner`, `set_cash_mint`, `set_price_account` and `set_params` change them, and after it only an upgrade does. It also raises the publish delay to two days.

The layouts of Config, Vault, Recipe and the asset list have not changed since SOL-2: the keeper's switch is a bit of a byte that was already there, and the loss counter two fields that were. A program already deployed at these ids upgrades in place and keeps its accounts. The program is 112,216 bytes larger than before the keeper leg, so an upgrade first extends the program's data account (`solana program deploy` does it, for the rent of the added bytes).
