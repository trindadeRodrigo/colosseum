# Solana programs

| Path | What |
|---|---|
| `basket/` | The vault program. The config and its switches, the asset list, the shared-portfolio registry with the author limits, the owner path (create a vault with targets of its own or following a shared portfolio, deposit cash, swap through the one allowed router, set targets, accept a version, switch auto-follow, withdraw any token to the owner) and the keeper path (one trade per call under the checks of section 5, and adopting a version that adds no asset). Design: `docs/vault/DESIGN-VAULT.md` sections 3.7, 5, 6 and 13 |
| `mock-router/` | A test exchange and a test price source, for LiteSVM and devnet. Not part of the product. It takes the input token from the signer and pays the output from its own reserve, either at a fixed ratio its admin sets or at the price in its own price account less a spread. The price account has Scope's layout to the byte, so the vault program reads it as it reads Scope's; the admin writes it, and so does one more key the admin names (the job that copies real prices). Only its upgrade authority can initialise it, and becomes that admin |
| `puppet-router/` | A hostile router, for the tests only. It runs whatever calls a test scripts, with every privilege the vault handed it |
| `test-hook/` | A hostile transfer hook, for the tests only. It logs the privileges it is handed and uses any signature it gets |
| `tests/` | The LiteSVM suite, under Vitest. Its own install: `litesvm` needs `@solana/kit` 8 and the repo is on 2.3 |
| `../idl/` | The interface files other code builds against, committed |

Tools: anchor-cli 0.31.1, solana-cli 3.0.1, platform tools v1.54 (which build with Rust 1.89.0). On the host, Rust 1.89.0 for clippy and `nightly-2025-09-09` for the interface files. There is no `rust-toolchain.toml`: the build picks its own compiler, and the two host versions are named where they are used.

CI: `.github/workflows/program.yml` installs the same versions, each download checked against a sha256 written in the workflow, and runs the build, the tests, the interface-file check and clippy, then the Solana adapter's contract and builder tests and the keeper's round from the root (`tests/solana-vault/contract.test.ts`, `builders.test.ts`, `tests/keeper/keeper.test.ts`) on the programs just built. A second job, `validator`, takes those two programs and runs `tests/solana-vault/validator.test.ts` on a local validator (the adapter's sending groups, the API end to end with a Postgres service, and the keeper's round), one validator that the test stops. It runs when `programs/`, `idl/`, `Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `packages/chain-solana/`, `packages/chain-mock/`, `tests/solana-vault/`, `tests/keeper/`, `apps/api/`, `apps/keeper/`, `packages/db/`, `packages/schemas/`, `packages/basket/`, `packages/engine/` or `packages/risk/` change: the validator job runs the API on the chain, so a change to the API or to any package it loads runs it too. A version bump here is a bump of the `env` block there.

## Build

```sh
anchor build --no-idl -- --tools-version v1.54
```

- `--tools-version v1.54`: the default platform tools (v1.51) cannot build `block-buffer 0.12`, an edition-2024 dependency.
- `--no-idl`: the interface files are built separately (below).
- Pinned in each program's `Cargo.toml`: `anchor-lang` and `anchor-spl` at `=0.31.1` (unpinned, cargo picks 0.31.2), and `solana-program` at `=2.3.0` for `test-hook`. Not ours to pin, and held by the committed `Cargo.lock` at 0.31.2: `anchor-syn`, `anchor-derive-accounts`, `anchor-derive-serde`, `anchor-derive-space` and the six `anchor-attribute-*` macro crates, which `anchor-lang` 0.31.1 asks for as `^0.31.1`.
- `default = ["no-idl"]` in `basket` and `mock-router`: the built program refuses Anchor's instruction that creates an on-chain IDL account. Without it, whoever sends that instruction first becomes the account's authority.
- One warning is expected per Anchor program: Anchor's own macro uses a deprecated `realloc`.

Sizes on Oct 4: `basket.so` 582,952 bytes (4.06 SOL of rent at deploy, and as much again while an upgrade is in flight; it was 460,600 before the keeper leg), `mock_router.so` 311,600 bytes (2.17 SOL), `puppet_router.so` 29,992 bytes, `test_hook.so` 68,640 bytes.

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
- Cash is not a position. What a vault holds in cash is the balance of its associated token account for the cash mint; nothing is stored for it. `Position.tracked` is a hint: the program rewrites it when it moves that mint (on a withdrawal, on both sides of a swap, on a keeper leg) and the vault's owner or its keeper can have it rewritten from the vault's own token accounts (`sync_balances`). A token sent in from outside is not in it until then. Nobody else can have it recorded: a leg holds every recorded balance to its price reference, so one raw unit of an asset with no reference, recorded by a stranger, would stop the keeper for that vault, and a recorded gift moves the weights.
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
| The asset, and every other position the vault holds something of, has a price reference (below) | `AssetNotPriced`, `KeeperAssetOff`, `PriceOutOfRange`, `PriceStale`, `PriceDeviation` |
| The router is called for a route and nothing else, and its account list holds no third token account of the vault | `RouterNotAllowed`, `AccountTampered` |
| The vault is worth at most 10^17 raw units of cash, before the trade and after it | `AssetNotPriced` |
| A purchase finds the asset under its target, a sale over it | `NotTowardTarget` |
| After the call: the vault's two token accounts are as they were but for the balance, and still no third one is in the list | `AccountTampered` |
| Something was spent, and at most `amount_in` | `NothingTraded`, `SpentTooMuch` |
| What came in is worth what went out less the tolerance, at the reference price | `ReceivedTooLittle` |
| The asset ends inside the band on the far side of its target, or before it, no further from its target than it began, and, if it crossed the target, at most half as far on the other side | `PastTarget` |
| What the leg lost, added to what is left of the week's losses, is within the cap | `LossCapReached` |

A weight is the asset's value over everything the vault holds: its cash account at one dollar, the traded asset's own account, and the other positions by `tracked`, each at its price. The vault's value is bounded at 10^17 raw units of cash (a hundred billion dollars at six decimals): under it no product the checks form can overflow, so none of them needs a refusal of its own.

"No further from its target" is what stops a stolen key walking an asset from one edge of the band to the other and back, paying the tolerance each way: a leg may cross the target, and may end at most half as far from it on the other side as it began. With "no further" alone a stolen key could still flip an asset that had drifted to exactly as far on the other side, every cooldown; half as far makes each crossing close the distance. A leg that spends nothing is refused, so it cannot use up the asset's one trade of the hour; a zero `amount_in` is that leg.

The loss counter is in raw units of the cash mint; it falls in a straight line to nothing over seven days from the last loss, and a leg that loses nothing neither reads the cap nor touches the counter. Because the counter drains while it fills, the most that can be lost in any seven days is just under twice the parameter, not the parameter. What a person is told is "no more than 2% of the vault in any seven days", so `loss_cap_bps` starts at 100 (design section 5); at its hard bound of 500 the same sum is 10%. A later loss starts the seven days again for everything left on the counter. That is the careful side: the counter drains more slowly than each loss would on its own date, so the figure the reader shows (`lossUsedBps`) does not clear seven days after a loss while later legs go on losing.

Three things a builder or an operator meets:

- A vault has 16 lines. A version that drops an asset the vault still holds keeps it as a line with a target of zero, so an owner whose shared portfolio swaps many assets can find that the next version and the leftovers do not fit (`InvalidTargets`). The owner sells or withdraws a leftover first, in the same transaction as the accept so that nothing can be sent back in between. Or clears every line and takes the version in one transaction: `set_targets([])`, `accept_version`, then `set_auto_follow(true)`, since `set_targets` switches it off, and `sync_balances` for the new lines, since their recorded balances start at zero. What the vault still holds of the dropped assets then has no line: the keeper does not sell it, and the owner swaps or withdraws it.
- The guardian can only close days, and the list holds 32. A guardian that fills it leaves no slot for a real holiday until the admin opens one (`set_closed_day(day, false)`); `closed_until` still closes the market in the meantime, and either key can push it later.
- Every position the vault holds something of needs a fresh price and a fresh average on every leg, not only the one traded. A stock's entry is not refreshed outside market hours, so a vault that holds one stock cannot have any of its assets traded by the keeper off-hours, the ones with no session included.

What it costs, through the test exchange (`keeper-sizes.test.ts`, Oct 4, after the review's fixes): 718 bytes, or 504 with the platform's lookup table, and 59,909 compute units in a vault with 2 positions, 64,349 with 7, 74,964 with 12 and 91,685 with 16, since every position the vault holds is valued. The figures move by a few thousand units from run to run with the keys. That is one account more than the owner's swap and a few thousand units per position on top of it; through Jupiter's route the owner's swap alone measured 117,000 to 127,000 units, so a builder asks for a budget above the default 200,000 for a leg in a full vault. An accept is 250 bytes and 10,875 units, an adopt 278 bytes and 14,449, a sync of 12 balances 642 bytes and 60,265. A keeper leg through Jupiter's own route has not been replayed.

### The price reference, and what the admin checks before switching an asset on

A leg is valued at the entries of one price account in Kamino Scope's layout: the asset's price entry and the entry of its one-hour average. On every leg the program holds the price to `max_price_age_s`, the average to one hour, and the two to `twap_dev_bps` of each other. That catches a feed that stopped, or a price that jumped away from its own recent past. It does not catch a feed that is wrong and steady: on mainnet two stock tokens read exactly 1.0000 on every refresh for six months, and an average of that is 1.0000 too (`docs/risk/STATE-RISK.md`, 2026-10-02). A leg valued at such an entry is not bounded by the tolerance or by the loss cap: the counter sees only the tolerance, and the vault pays the distance between the entry and the market.

Two things stand in front of that, both the admin's, both written with `upsert_asset`:

- **The switch.** The keeper trades an asset, and values a vault that holds it, only when bit 0 of the asset's `flags` is set.
- **The price range.** `min_price` and `max_price`, in millionths of a dollar for one whole token (`500_000000` is 500 dollars). On every leg the price entry of the traded asset, and of every other position the vault holds something of, has to be inside its asset's range: outside it the leg is refused (`PriceOutOfRange`). The ceiling is above the floor and at most twice it, so a range is never "any price". Zero and zero is no range, which is allowed only with the switch off: the switch does not go on without one (`AssetNotPriced`), and an entry that somehow had the switch and no range would pass no price at all.

The range turns "wrong by anything" into "wrong by at most the width of the range". It is a bound, not a price: inside it a wrong entry still costs the vault the distance to the market on each leg, up to the band of the asset's target. So it is set narrow and moved by hand.

Before switching an asset on, the admin checks, for that asset, over at least one full US session:

1. The price index and the average index are the ones in `fixtures/solana-vault/scope-indexes.json` for the mint, in the price account named there, and the asset list names that account for the entry's slot (`set_price_account`).
2. The price moves. Read the entry at the price index at least every minute through the session: it takes many different values, and none of them is a round placeholder.
3. Its time refreshes. In market hours no two reads are more than `max_price_age_s` apart in the entry's own unix time, and the average's time is never more than an hour old.
4. It is the price of the raw token, not of the share behind it. The program values raw units at the entry and never applies the mint's multiplier (the scaled UI amount), so an entry that prices one share misprices the token by the multiplier: 57 bps for SPYx at 1.0057, and more with every dividend. At three moments of the session, at least an hour apart, read in the same minute the entry, the mint's multiplier and the mid of the token's deepest pool against the dollar, per raw token (the liquidity layer's pool price, never the same feed). The entry is within 25 bps of that mid, and closer to it than to the mid divided by the multiplier, at all three. Where the multiplier is within 50 bps of 1 the reads cannot tell the two apart: then the feed's own definition of the entry settles it, and which it is goes into the ledger row. An entry that follows the share stays off: applying the multiplier is not built. This is settled for each asset before its switch goes on, and again after each change of its multiplier.
5. The exponent of both entries is at most 18, and the mint has no transfer hook program and no multiplier change scheduled.
6. The range. Take the price just checked against the pool and write a band around it: for example 20% under and 20% over, never wider than the program allows (a ceiling of twice the floor). Then `upsert_asset` with `flags` 1 and the range.

Moving the range is the same act as setting it. When the checked price has come within a few percent of an edge, or after a multiplier change, the admin checks the price against the pool again (step 4) and writes a new band around it. It is widened on purpose, by a person, and never by a script that follows the feed: a range that follows the feed bounds nothing. Until the admin gets there, a price outside the range stops the keeper for that asset and for every vault that holds it, and stops nobody else.

What was read, and when, goes into the ledger row of the deploy. The switch comes off the same way (`upsert_asset` with `flags` 0) the moment any of this stops holding; until the admin gets there, the guardian's `pause_keeper` stops every leg. The switch never touches the owner: `owner_swap` and `withdraw` do not read it.

## Not built yet

- `set_keeper`: the program honours a keeper a vault names for itself, and nothing writes that field. `close_vault`.
- The comparison of an asset's price source with a pinned one (`source_check`, hostile case A5b). The field stays zero; the keeper leg refuses an asset whose field is not zero, so setting it is not mistaken for protection.
- A keeper leg takes one price account. A vault whose positions are priced in two of the asset list's four slots cannot be valued, so every listed asset goes in one slot for now.
- A strict bound of one cap on what can be lost in any seven days: the losses would be kept per day (eight daily sums fit in the vault's reserved bytes). Today's counter drains as it fills.
- The guardian cannot switch a single asset off for the keeper: it has the pause, and the admin has the switch.
- `launch()` locks the price accounts, not which entry of them an asset reads: the admin can still point an asset at another index with `upsert_asset`. Locking the indexes of an asset whose switch is on is not built.
- A multiplier the issuer changes at once is not seen at all: the token program then writes the same value as the mint's current multiplier and its next one, and the window only knows a change by the two being different. It catches a scheduled change, which is how the stock tokens have changed theirs so far. Remembering the multiplier a leg last saw, and holding the keeper back when it has moved, is not built.
- The mint's multiplier is not applied to a price: an asset whose entry prices the share and not the raw token cannot be switched on (step 4 of "The price reference").
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

A person's word starts it, every time. The commands below are the ones the rehearsal ran (`scripts/testnet/solana/rehearse.ts`, transcript in the `TNET-4` row of the ledger), with devnet's URL in place of the local one. Costs are devnet's, which charges mainnet's rent: 6,960 lamports a byte, plus 128 bytes an account.

What it needs: the two programs built, the two program keypairs (`keys/basket-keypair.json`, `keys/mock_router-keypair.json`, never committed), a deploy key outside the repo holding at least 7 SOL (the rehearsal used 6.64), and `pnpm --dir programs/tests install` once. The deploy key becomes the upgrade authority of both programs and the admin of both: of the vault program's Config, of the test exchange, of its price account and of every test token's mint, freeze and extension authorities.

```sh
export SOLANA_RPC_URL=https://api.devnet.solana.com
export SOLANA_KEYPAIR=<path of the deploy key, outside the repo>
```

**0. Build, and fill in the roles.** `anchor build --no-idl -- --tools-version v1.54`. In `scripts/testnet/solana/devnet.config.json`, set `roles.guardian` and `roles.defaultKeeper` to an address each, or to `"admin"` for the deploy key, and `roles.priceWriter` to the key of the job that copies prices (TNET-5), or `null` for none yet. The script refuses to run while a role is `null`. The rest of the file is the keeper's parameters (loss cap 100 bps), the thirteen test tokens with their first prices and the source of each, their spreads, their reserves and, for those the keeper may trade, their price ranges. Commit the file as it is run.

**1. Dry run.** Free.

```sh
pnpm exec tsx scripts/testnet/solana/setup.ts --dry-run
```

It reads devnet's genesis hash first: mainnet's is refused, and so is any cluster that is neither devnet nor on this machine. Before the deploy it says the programs are not there and prints the 46 transactions it would send, each with its accounts and data. Nothing is sent and no file is written.

**2. Deploy the two programs, each by name.** 4.06 SOL for `basket` (582,952 bytes) and 2.17 SOL for `mock_router` (311,600 bytes), all of it rent held by the programs' data accounts. The key never dips below what it ends with: the buffer's rent moves into the program.

```sh
solana program deploy --url devnet --keypair "$SOLANA_KEYPAIR" \
  --program-id keys/basket-keypair.json target/deploy/basket.so
solana program deploy --url devnet --keypair "$SOLANA_KEYPAIR" \
  --program-id keys/mock_router-keypair.json target/deploy/mock_router.so
```

Never a bare `anchor deploy`: it deploys every program of the workspace, and two of them are test tools (`puppet_router`, a router made to misbehave, and `test_hook`, a transfer hook). Check: `solana program show 529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW --url devnet` and the same for `2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f` print the deploy key as `Authority` and the binary's length as `Data Length`. A deploy that stops half-way leaves a buffer holding its rent: `solana program show --buffers --url devnet` lists it, `solana program close <buffer> --url devnet` returns the SOL.

**3. Set up.** 0.40 SOL, about half of it the price account (28,712 bytes, 0.20 SOL); the rest is fourteen mints, 26 pairs, fourteen reserves, Config, the asset list and the lookup table, and the fees of 46 transactions.

```sh
pnpm exec tsx scripts/testnet/solana/setup.ts
```

In order, each step reading the chain first and sending only what is missing:

1. The test tokens, at addresses the deploy key derives by seed (`test-mint:<slug>`): the test dollar `tUSDC` (classic token program, 6 decimals) and thirteen tokens that each say "Test … (test network, no value)": ten stock tokens with the indexes, the decimals and the Token-2022 extension set of the real ones, in the real mint's order (metadata pointer, permanent delegate, default account state, scaled UI amount, pausable, confidential transfer, a transfer hook with no program, then the name), two dollar-yield tokens on the classic program, and tPAXG, "Test Paxos Gold", with PAXG's set and 6 decimals (close authority, permanent delegate, a transfer fee at zero that the issuer may raise, confidential transfers and their fee, a transfer hook with no program, metadata pointer, then the name) at Scope's PAXG entries 454 and 168. The vault program takes PAXG's set as it is: a transfer fee would arrive as a worse fill, a loss the counter keeps inside the tolerance and a refused leg past it (`basket-paxg.test.ts`). tGLDx was listed until Oct 5 and is retired. Not modelled, for want of an entry in `fixtures/solana-vault/scope-indexes.json`: MSFTx, AMZNx, SPCXx, COINx and PLTRx. The deploy key holds every authority, so it can change a stock token's multiplier with Token-2022's own `update_multiplier`.
2. The exchange (`init_router`), its price account (`create_account_with_seed` "test-prices", then `init_prices`, which writes Scope's discriminator) and the price writer, if the config names one.
3. A first price and average for every token, stamped with the cluster's clock. A price already there is never overwritten: from the first copy on, the prices are the copying job's.
4. Two pairs per token against the test dollar, paying the price account's price less the token's spread (15 bps, 5 for the dollar-yield tokens), and each reserve filled to a million dollars at the first price (ten million test dollars). A reserve under half of that is topped up on a later run.
5. `init_config` with the roles of the config file, the test exchange as router and as price owner, and the test dollar as cash; then the market's closed days ahead from `fixtures/risk/us-market-holidays.json` (`set_closed_day`; Config holds 32).
6. `init_assets`, `set_price_account(0)`, then `upsert_asset` per token with its two indexes, its session and `flags` 0, and a second `upsert_asset` with its price range for each token the config gives a range to: `flags` 1, or `flags` 0 with the range kept for a token whose `keeper` entry says `"on": false`. On a test network the price is the test exchange's own, so the checks of "The price reference" above are the config file's ranges, not a session of reads.
7. The platform's lookup table, with the programs, Config, the asset list, the price account, the exchange, every mint, pair and reserve.

It never calls `launch()`. It prints what it holds and what the run cost, then writes `deployments/solana-devnet.json` (the full record: programs, accounts, roles, parameters, closed days, every token with its mint, token program, decimals, indexes, range, pairs and reserve, `provenance: "sandbox"` and the genesis hash) and the `chains.solana` entry of the SDK guard's file for the test network, `packages/sdk/deployments/testnet.json` (`--out` and `--guard-file` put them elsewhere). The guard's file is read by `loadDeployments` in `packages/sdk/src/guard/deployment.ts`; once written, `pnpm --filter @colosseum/sdk tables` regenerates the package's table of committed files and its deployment test reads it.

What the config no longer asks for is undone or refused, never kept quietly. A price writer it no longer names is revoked (`set_price_writer` to zeros). A token it no longer lists cannot leave the asset list, so its keeper switch goes off and its range to zero; the record keeps it under `retired`, and the guard's file keeps it, since vaults may still hold it. Its asset id comes from the earlier record or, failing that, the guard's file; on devnet a token neither names is refused before anything is sent. A mint whose extensions differ from what the run asks for is refused: they are fixed when the mint is made, so a run with `--omit-extension` has to be repeated with the same flag. The record states what is on chain after the run.

Check: run step 3 again. It reads every account it would write and says `nothing to send: the network is as the config says`; anything else it prints is what differs. A run that stops part-way is picked up by the next one, with one exception: a lookup table made by a run that stopped before writing the record is not found again, and the next run makes another (0.0013 SOL each).

**4. A vault's life on it.** In the rehearsal: the deploy key hands a person 1,000 test dollars, the person creates a vault (40% tSPYx, 30% tjlUSDC), deposits, buys tSPYx through the exchange, the prices are stamped again, the default keeper sends one leg into tjlUSDC with the lookup table, a creator publishes a shared portfolio and the person accepts it: 0.002 SOL to the deploy key. On devnet this is the owner path of `OPS-6`.

Total for the deploy key: 6.64 SOL at mainnet's rent, which is also the most it ever has out at once; from 10 SOL it keeps 3.36. The real devnet deploy on Oct 4 cost 4.83 SOL (`basket` 2.96, `mock_router` 1.58, the set-up 0.29): devnet's program rent is now below mainnet's, so read the figures above as an upper bound. An upgrade of `basket` holds the new binary's rent in a buffer until it lands (4.06 SOL at mainnet's rent, about 2.96 on devnet today): keep that much on the key before one. `mock_router` upgrades within what is left.

The order matters where one step needs another: `init_config` takes the dollar mint as an account, `set_price_account` checks the account is the price owner's and 28,712 bytes, and the switch is refused without a range. Shared portfolios (`publish_recipe`) are published by their creators after the set-up. `launch()` comes last, and only once the router, the price owner, the cash mint and the price account are final: until then `set_router`, `set_price_owner`, `set_cash_mint`, `set_price_account` and `set_params` change them, and after it only an upgrade does. It also raises the publish delay to two days.

The rehearsal itself, on this machine and nowhere else:

```sh
pnpm exec tsx scripts/testnet/solana/rehearse.ts <folder outside the repo> <rpc port>
```

It starts `solana-test-validator` with the features devnet has not turned on switched off (`scripts/testnet/solana/devnet-features.json`, from `solana feature status -u devnet --display-all --output json`; one of them, account data mapped in place, makes Token-2022 refuse a mint's metadata), gives a fresh key 10 SOL, and runs steps 1 to 4 with it, checking that the dry run printed what the first run sent and that the second run sent nothing. Refresh the feature file before a deploy if it is more than a few weeks old.

The sizes and offsets of Config, Vault, Recipe and the asset list have not changed since SOL-2: the keeper's switch is a bit of a byte that was already there, the loss counter two fields that were, and the price range sixteen bytes of an entry that were reserved (`min_price` at 75, `max_price` at 83; an entry is still 96 bytes). A program already deployed at these ids upgrades in place and keeps its accounts; an entry written before the range reads as no range, so its switch, if it was on, passes no price until the admin writes one. Two instructions changed shape, and a client built against the earlier interface file fails on both: `upsert_asset` takes two more numbers, and `sync_balances` takes a signer and Config ahead of the vault's token accounts. The program is 582,952 bytes, 122,352 more than before the keeper leg, so an upgrade first extends the program's data account (`solana program deploy` does it, for the rent of the added bytes).

## Copying prices onto the test network

`scripts/testnet/solana/prices.ts` (TNET-5) copies real prices onto the devnet price account, so a test price moves and goes stale as the real one does. Each round it reads mainnet, read only, and writes through `write_price`, six assets a transaction, signed by the price writer the exchange names (`roles.priceWriter`): never the deploy key, which it refuses.

- **What it copies.** `scripts/testnet/solana/price-sources.json` says where each token's two entries come from. The ten stock tokens: Kamino Scope's entries at the same indexes, value, exponent and unix time byte for byte. tsyrupUSDC: the price chain and average chain of Kamino's syrupUSDC reserve (Scope 314 × 13 and 504 × 456), their product stamped with the older time. tjlUSDC: Jupiter Lend's token exchange price for jlUSDC times Scope's USDC price (13) and average (456), stamped with the older of the rate's last update and the Scope entry; the rate has no average of its own. tPAXG (gold on Solana is PAXG, gate `GOLD-PAXG`): Scope's entries 454, the price of Kamino's PAXG reserve (capped and floored to Chainlink's XAU/USD at entry 167), and 168, its one-hour average, copied byte for byte with their times like a stock's. tPAXG trades at all hours (`session` 0), and its keeper switch is on with a range. tGLDx, whose devnet price was the GLDx/USDC pool's mid and whose keeper switch was off under gate UNIVERSE, is retired on devnet since Oct 5: its switch and range are off, it stays in the record (`retired`) and the guard's file so a vault that holds it can withdraw it, and the copier no longer writes its price. A vault that still holds tGLDx is owner-signed for everything, since the program refuses every keeper leg in a vault that holds a switched-off asset (`KeeperAssetOff`).
- **What it refuses.** An entry is written only when its source time is newer than what devnet holds; a time is never made up. A value outside the asset's keeper range on devnet is refused. So is one further from what devnet holds than the allowed move: `--max-jump-bps` (default 1,000) times the hours since devnet's entry was stamped, never less than one hour's worth and never more than 5,000 bps. Within the first hour of an entry, then, each write may move the price by up to the full limit, and a round every 30 seconds can walk it that far each time; past an hour the allowance grows with the gap. The check compares with the chain, not with anything the job remembers, so a token that moved by less than 5,000 bps while the copier was stopped is copied when it starts again, and such a refusal does not freeze a token: the next real move is judged against the chain again. A move past the 5,000 bps cap is refused however long the gap: raising `--max-jump-bps` does nothing there, and a person checks the source and writes the entry with the admin key (`write_price`), after moving the range if the value is outside it. A refusal is logged with what to do if it persists, and the other assets go on. A source that cannot be read leaves its token unchanged, and the round says why. A source entry holding nothing is refused, never written as a zero. On Oct 5 tAAPLx, tGOOGLx and tMSTRx were refused because their real prices had left the ranges set around placeholders; the stock tokens' ranges in `devnet.config.json` were then set from that day's Scope prices (−22.5% and +25%) and the set-up run again, which sent one `upsert_asset` per changed range. A range is moved the same way, by a person, as "The price reference" says.
- **Where it may write.** The destination's genesis is checked as the set-up checks it (mainnet refused), and the source must answer with mainnet's genesis. Nothing is ever sent to the source. Both RPCs retry on 429.
- **When a node does not answer.** `SOLANA_RPC_URL` and `MAINNET_RPC_URL` each take a list, comma separated; the source defaults to two public mainnet nodes. Every node is checked at the start (a destination that is mainnet, or a source that is not, stops the job). A node that fails with `fetch failed`, a timeout, a 429 or a 5xx is left for the next one, and a round that fails is tried again after 2 s, then 4, 8, 16, up to the interval. A URL may carry a key, so no line names one: the log says `source node 1 failed (fetch failed): asking node 2`.

- **Holding the last price (`--hold-last`, off unless said).** A source that posts nothing new, as a stock's does while its market is closed, leaves devnet's price past the program's 120 seconds, and the app then refuses a deposit into that token. With the flag, an entry whose source has not moved is written again with the same value and the cluster's time: a price once it is 45 seconds old (every second round, so it is never much past 60), an average once it is 30 minutes old. A value that arrives with a time already past that (a chain of entries carries its oldest time) takes the cluster's time when it is copied, and is logged as held. Only a value the source still holds is held, and a real entry is still copied the moment the source's value differs, whatever its time (a held entry is stamped ahead of the source's next one, so the time alone would hide it). Each held write is logged: `held tSPYx at 669.1 (source last posted 2026-10-09T20:00:00.000Z)`. The price is then real but old: use it to keep a test network usable over a weekend, not to show a moving market. A source that has posted nothing for four days is held no longer, so a dead feed or a halted stock goes stale as on mainnet. Two things to know. On Monday the jump limit counts the hours since devnet's entry was stamped, and a held entry is young, so a gap above `--max-jump-bps` is refused at first; a refused value is not written and not held, so the entry ages and the allowance grows by that many bps an hour until the value is copied (a 15% gap clears after about 90 minutes), and only a gap above 5,000 bps needs a person, as before. Until it clears that token's price is stale and the app refuses deposits into it. And the keeper: the session clock still stops it on nights, weekends and listed closed days, but in a closure inside session hours that `closed_days` does not list (an early close, a halt) the stale price was what stopped it, and with the flag on it trades the held price. That is why the flag is for test networks only. The rule is `decide` in `programs/tests/src/testnet/hold.ts`.

One round, or a look at what one would write:

```sh
export SOLANA_RPC_URL=https://api.devnet.solana.com
export SOLANA_PRICE_WRITER_KEYPAIR=<path of the price writer's key, outside the repo>
# MAINNET_RPC_URL defaults to https://api.mainnet-beta.solana.com, read only
pnpm exec tsx scripts/testnet/solana/prices.ts --once --dry-run
pnpm exec tsx scripts/testnet/solana/prices.ts --once
```

Each round logs one line: what was written, what was unchanged and why, what was refused and why, and the signatures.

`pnpm exec tsx scripts/testnet/health.ts` reads both test networks and prints, for each, the oldest price and the oldest average against the age the vault takes; it exits 1 when one is past 75% of its limit, which a copier running with `--hold-last` never lets happen, and 2 when a network cannot be read.

**On this Mac.** It runs every 30 seconds (`--interval`), which keeps a copied price inside the program's 120 seconds: Scope itself lags 40 seconds or so. `caffeinate -i` keeps the Mac from sleeping while it runs. The log lives outside the repo; the job keeps no state of its own.

```sh
mkdir -p ~/Library/Logs/tenonfi
nohup caffeinate -i pnpm exec tsx scripts/testnet/solana/prices.ts --loop \
  >> ~/Library/Logs/tenonfi/devnet-prices.log 2>&1 &
tail -f ~/Library/Logs/tenonfi/devnet-prices.log                     # watch it
pkill -f 'scripts/testnet/solana/prices.ts --loop'                    # stop it: it ends after the round in flight
```

Run it from a checkout of its own (`git worktree add --detach <dir> upstream/staging`, used for nothing else), from that checkout's root, with the two variables exported in the same shell: `tsx` reads the job's files from disk at start, and a checkout where other work changes branches or files could change what a restart runs. It is not a launchd job and touches no existing collector: it is its own runner, started and stopped by hand. Each written round costs the writer up to three transaction fees (5,000 lamports each, six assets a transaction); out of market hours only tsyrupUSDC, tjlUSDC and tGLDx move. At most about 0.04 devnet SOL a day, so the writer's 1 SOL lasts some three weeks.

**On the keeper's machine, later.** The same command under the keeper's own supervisor (a systemd unit or the host's process manager), with `SOLANA_RPC_URL`, `MAINNET_RPC_URL` and `SOLANA_PRICE_WRITER_KEYPAIR` set there and the key copied there, and this Mac's job stopped first: two copiers would race to write the same entries. An EVM test network (TNET-1) adds a writer beside `copyRound` that takes the same readings from `readPrices`; the reading half does not change.
