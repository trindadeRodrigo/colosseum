# The Solana adapter for vaults

`import { createSolanaVaultAdapter } from '@colosseum/chain-solana/vault'` for the whole `ChainAdapter` (reads, builders, quotes, the probe); `createSolanaVaultReader` for the read side alone. The root entry does not re-export either, and nothing here holds a key: signing is behind `@colosseum/chain-solana/server`.

Both take a `ChainConfig`, an RPC client the caller makes (`createVaultRpc(url)`), and the asset list. They read no environment. The program id (`contracts.program`), the router and the price account come from the config; the cash mint, the price owner and the default keeper come from the program's own Config account.

It decodes the program's four accounts: Config, Vault, the asset list (`getAssetList`) and a shared portfolio (`getRecipe`). The asset list on chain holds mints, ceilings and price entries; the ids, classes and sheets of the assets still come from the caller's list, matched by mint.

| File | What it holds |
|---|---|
| `adapter.ts` | `createSolanaVaultAdapter`: the builders of DESIGN-VAULT 3.2, `quote`, and two steps the shared interface does not name (`buildCancelPending`, `buildSyncBalances`) |
| `program.ts` | The program's instructions, written by hand from `idl/basket.json`; "create if missing" and the compute budget |
| `compose.ts` | One transaction from a builder's instructions: blockhash, simulation, budget, fee, preview, message hash; the refusal a failure maps to |
| `routes.ts` | The route sources: the test exchange (`testExchange`) and Jupiter's build endpoint (`jupiter`) |
| `send.ts` | The probe (`TxProbe`): `messageHashOf`, `relay`, `carries`, `fate`, `nonceOf`. Key-free; the API imports it |
| `reader.ts` | The read side (ADS-1): vaults, prices, holdings, funding, `track`, `getKeeperContext` |
| `unlisted.ts` | The id of a token the app does not list: `solana:mint-` and the mint's 32 bytes in hex |

## The builders

Every builder returns one unsigned transaction (`BuiltTx`) and refuses with a `ChainError`, for bad arguments as much as for a simulated revert. Each one:

- reads what it needs at the moment it is called (the vault, Config, the recipe, the token accounts), and refuses first what it can tell without the chain: `VaultNotFound`, `VaultExists`, `NotFunded`, `SpentTooMuch`, `TooManyTrades` (one trade per transaction), `NotSupported` (a nonce, an approval, trades inside a create or a deposit), `MintNotAccepted`, `AutoFollowOff`, `NotFollowing`, `NotCashLeg`;
- simulates the transaction against the chain as it is (`sigVerify` off), and maps a failure to the program's own error by name (a log line `creator limit: reason=<n> <Name>` goes into the message of `CreatorLimit`); Anchor's check of the one key a step expects is `NotOwner`, a payer who cannot pay is `NoGas`, anything else `Unknown` with what the chain said;
- asks for a compute budget of what the simulation used plus a fifth, and a priority fee from the recent fees of the accounts it writes, capped so the priority part stays under 0.001 SOL (`priority` overrides both);
- previews the token balances the transaction moves, read before and from the simulation, by holder (`wallet` or `vault`), and states `minimums` for each owner trade: `inRaw` and the `min_out` in the bytes, which is the route's quote less the slippage asked for. A keeper leg states none: `keeper_leg` carries none;
- puts the SHA-256 of the message bytes in `messageHash`, the base64 of the unsigned transaction in `payload`, and the blockhash's last valid height in `lastValidBlockHeight` (`validUntil`).

The shape every owner step has, because the guard of `packages/sdk` (DESIGN-VAULT section 9) takes nothing else: the owner is the one signer and the fee payer; the vault program's instructions for the step and no other program's; a "create if missing" (`data = [1]`) only for the vault's account of what comes in (the cash of a create or a deposit, the side a swap buys) or the owner's account of what a withdrawal takes out; one compute-unit limit and at most one price; and every account an instruction names for itself in the message. Only a swap's router accounts may be read through the route's own lookup tables, and only those the transaction names nowhere else (`lookupRouterAccounts`). `tests/solana-vault/builders.test.ts` holds every owner step to it; the guard itself, run on the same transactions from its branch, passed them on Oct 4 (not committed: the guard is not merged).

| Step | What the transaction holds | Bytes, units used (LiteSVM, Oct 4) |
|---|---|---|
| Create, own targets | `create_vault`, the vault's cash account, `deposit` when there is cash | 600 at 1 target, 805 at 7, 975 at 12, 1,111 at 16; 47,000 to 52,000 |
| Create, following | the same, no targets, `expected_version` the one the person saw or else the one in effect by the cluster's clock | 598; about 55,000 |
| Deposit | `deposit`, and the vault's cash account if it is missing | 426; 14,000 |
| Swap | `owner_swap` with the route; the vault's account for what it buys opened first when missing | 701 to 775 through the test exchange; 49,000 to 74,000 |
| Set targets | `set_targets` | 357 at 1 line; 12,000 |
| Accept a version | `accept_version` | 290; 9,500 |
| Auto-follow | `set_auto_follow` | 254; 6,500 |
| Withdraw | one transaction per token the vault holds: `withdraw` of all of it to the owner's associated account, opened if missing | 393 to 467; 15,000 to 37,000 |
| Publish | `publish_recipe` the first time, `update_recipe` after (the creator's) | 458; 13,000 |
| Cancel the version that waits | `cancel_pending`, by the creator or the guardian | 286; 9,600 |
| Keeper leg | `keeper_leg` with the price account and the route, signed by the vault's keeper | 726 through the test exchange; 63,000 to 68,000 with 3 positions, 76,000 to 87,000 with 16 |
| Adopt | `adopt_version`, sent by the keeper as fee payer | not measured here (278 bytes and 14,449 units in `programs/tests/keeper-sizes.test.ts`) |
| Sync | `sync_balances` with the vault's token accounts, signed by its keeper or owner | 385 with 3 positions, 814 with 16; 16,000 and 73,000 |

What the steps do not do, because the guard refuses it:

- **A create with its first buys.** Solana carries no trade in a create or a deposit (`tradesInCreate` false): the create and its deposit are one step and each buy is its own. The platform's own lookup table measured on Oct 3 (design 3.2) is not used: the guard refuses a named account read through a table.
- **An accept that would pass 16 lines and clears a leftover in the same transaction.** The guard takes an accept on its own. The builder refuses with `InvalidTargets` and says to sell or withdraw a leftover first, as its own step.
- **The owner's sync before auto-follow goes on, in the same transaction.** The guard takes `set_auto_follow` on its own and has no step for a sync. `buildSyncBalances(vault, owner)` builds the owner's as a transaction of its own, which the guard does not pass; the keeper's sync (`buildSyncBalances(vault)`) is the one that runs, before a leg, where `getKeeperContext` says `needsSync`.

Two steps are built under a kind the order layer already has, so the shared `LegKind` does not change: a cancel is a `publish` step (the registry's, like the publish it undoes) and a sync is a `keeper_leg` step.

A withdrawal of everything takes, one transaction each, every token the vault holds of the app's list, of the program's asset list and of its own lines, listed or not. A frozen account is left where it is: it cannot move until its issuer thaws it. A token with a transfer hook program is not something the program lists; its extra accounts are not resolved here.

## Quotes and routes

One route source per router, chosen by the config: Jupiter's build endpoint when the router is Jupiter's program (`JUP6...`), the test exchange of `programs/mock-router` for any other. `routes` replaces it.

- **The test exchange** reads its `Pair` account, as `staging` writes it (89 bytes, a fixed pair) and as TNET-4 writes it (95 bytes: `kind`, `asset_is_input`, `price_index`, `spread_bps` after the bump). A fixed pair (`kind` 0) pays `amount_in × price_num / price_den`, rounded down, with no fee. A priced pair (`kind` 1, every pair on devnet) pays at the asset's entry in the price account the exchange's own account names (`Router.prices`, after `admin` and `bump`), the dollar token at one dollar, rounded down as the program's `priced_out` does, less the spread; the route then carries that price account as its twelfth account. The exchange reads neither the entry's age nor a mint's multiplier, and neither does the quote. A pair it does not list, a priced pair with no price account or an empty entry, a reserve that cannot pay, and a trade too large for it are `BadTrade`; a layout or a kind it does not know is `Unavailable`. The route is `route_v2` with the vault as the trader, and the exchange's own minimum is left at zero so that a price that moved is refused by the vault's rule (`ReceivedTooLittle`), not the exchange's.
- **Jupiter** (`GET /swap/v2/build`, the endpoint the Oct 3 replay ran through the vault): asked with the vault as the taker and a slippage 50 bps looser than the vault's own minimum, so the vault's check binds first. Only its swap instruction is used, and only a direct or shared-accounts route (`route`, `shared_accounts_route`, `route_v2`, `shared_accounts_route_v2`) that spends the trade's amount, names the vault and its two token accounts, and asks for no signature but the vault's. Its lookup tables are read from the chain. A key, when the caller has one, goes in `x-api-key`; neither it nor the address is ever in a message. Tested on the recorded answer of Oct 3 only: nothing here calls it.
- `quote(trade, taker)` carries the route's source, its time and its method, the quote's output, a minimum `quoteSlippageBps` under it (100 by default), and the cost against the reference prices where both sides have one (cash is a dollar), `against: 'pool_mid'` and zero otherwise.

When `tnet/solana-devnet` lands nothing in the quoter changes: it reads both layouts and both kinds, held to the program's arithmetic by `routes.test.ts` on account bytes written by hand (the priced kind has not run against the program here, which is on that branch only). The same branch changes the keeper's `PastTarget` rule (a leg that crosses its target ends at most half as far on the other side); the contract's band cases have not been run against it.

## Signed bytes, sending, and what became of an attempt

- `messageHashOf(signedTx)` is the SHA-256 of the message: the same for the unsigned bytes the builder returned and for any signed copy. Bytes that are not exactly one transaction, with one signature per signer the message names, are `BadInput`.
- `relay(signedTx)` sends only bytes every signer signed over this message (each signature checked here), with the node's preflight. Sent twice, the node has them and the same id comes back. Bytes the chain will not take are refused in the program's words, from a simulation of the same bytes; the node's own message, which can carry its address, is never passed on.
- `carries(txId, hash)`: `unseen` while the node has no transaction under the id, `this` for the message built, `another` for any other.
- `fate(attempt)` looks through the signer's transactions, newest first, a page of 100 at a time with `before`, for one that carries the message (`landed`, confirmed or reverted), back to the first slot the attempt could land in: a transaction in a slot under its last valid height less 150 cannot carry its blockhash. Anyone can name an address in a transaction (dust sent to it), so the list can be long: past ten pages `fate` cannot tell and answers `open`, never `gone`. Not found: `open` until the finalized height is past `validUntil`; then it looks once more and says `gone` only when both looks read the whole window.
- The probe asks one client for everything: the list, the transactions, the status and the height. Behind a pool of nodes, a height from one node and a list from another can say `gone` for a transaction the second has not listed yet. Hand the probe a client that answers from one node.
- `nonceOf` is null: Solana has no nonce of record.
- `track` (the reader's) answers on the node the adapter was given; send and track through the same client.

## What other slots must know

**Vaults**

- A target, a line of a shared portfolio, or a token waiting for a vault (`pending.newAssets`) on a mint the caller's asset list does not have is read, not refused: it shows under `unlistedAssetId(mint)` (`solana:mint-<64 hex>`), with the decimals and multiplier of its mint and no price. An author can name such a token, and before ADS-2 that refused every read of every vault that followed. `getPrices` still refuses an id it does not list (`MintNotAccepted`): ask it for listed assets only, as the API's portfolio read does. A vault with a target on the cash mint, which the program never writes, refuses with `Unknown`.
- `lossUsedBps` is what is left of the vault's weekly loss counter as a share of what the vault holds now. The counter (`loss_accum`, in raw units of the cash mint, with `loss_ts`) falls in a straight line to nothing over seven days from the last loss, and each later loss starts those seven days again for all that is left: the figure does not clear seven days after a loss while legs go on losing. It is held to `Config.loss_cap_bps`, 100 at the start; because the counter drains as it fills, what can be lost in any seven days is up to just under twice that, the 2% a person is told. The vault's value is its cash at one dollar and each position at its price entry in the account the program's asset list names, as the entry is, fresh or not. A position whose price cannot be read counts for nothing, which makes the share larger and never smaller. The program measures the cap against the value at the moment of a leg, with its own freshness checks: between legs this is the nearest number, not the same one. The price account is read only when a vault has a loss to show.
- A vault that follows a shared portfolio reports it in `recipeOnchainId` (the Recipe account's address) with the version it took in `acceptedVersion`. `pending` is what it has not applied: the version in effect if the vault took an earlier one, or else the version that waits, with `newAssets` naming the assets the vault has no target on. The recipe is read in the same call as the balances.
- A vault whose `recipe` is not a shared portfolio of this program refuses with `Unknown`: the program never writes one.
- Balances are the associated token account for (holder, mint, the mint's token program) and nothing else. `Position.tracked` is never read. A listed token a vault holds with no target on it is a position with `targetBps: 0`. A token that is not listed is not seen.
- A frozen token account's balance is reported as held: it is still the holder's and a vault's value includes it. `funding` does not count frozen cash, because it cannot be deposited.
- A holding of a mint whose issuer has scheduled a multiplier carries `scheduled { multiplier, effectiveAt }` until the cluster's clock reaches that time. From then on it is the multiplier in force and nothing is scheduled.

**Shared portfolios**

- `getRecipe(address)` answers the version in effect and the one that waits, by the cluster's clock: a version whose time has come is the active one with no transaction, as it is for the program (`versionsAt`). The account's `current` and `pending` fields alone do not say which is in effect.
- Anything that is not a Recipe account of this program is `RecipeNotFound`. A line on a mint the caller's list does not have is `MintNotAccepted`, and a vault that follows that portfolio refuses with it.
- A version number names one set of weights for good: a cancelled version keeps its number, so the version that waits can be the active one plus two.
- `onchainId` is the Recipe account's address: seeds `["recipe", creator, family id]` (`recipeAddress`). `familyId` and `metaHash` are 64 lower-case hex characters.
- `listAutoFollowVaults(recipe)` filters on the vault's `recipe` at byte 40.

**For the keeper**

- `getKeeperContext(vault)` is one vault as `keeper_leg` would find it, read at one moment: the vault's state, the program's rules from Config (the pause, the tolerance, the cap, the band, the allowed ages, the cooldown), the one price account a leg passes, and each position with what its token account holds, what the program has recorded (`trackedRaw`, and `needsSync` when the two differ), the admin's switch on the asset, its price and its one-hour average with their ages, and two refusals by the program's own error names. `reference` is why the asset cannot be valued (`AssetNotPriced`, `KeeperAssetOff`, `PriceOutOfRange` when the price is outside the range the admin gave the asset, `PriceStale`, `PriceDeviation`); while the vault holds any of it, that stops every leg in the vault. `trade` is why the asset itself cannot be traded now (`Cooldown`, `HookNotAllowed`, `MultiplierWindow`, `MarketClosed`). `blocked` is why no leg at all would pass: auto-follow off, the pause, or a held position with no reference.
- These are the program's rules written again (`keeper.ts` against `programs/basket/src/price.rs` and `checks.rs`), with the same boundaries in both test suites. They say what a leg would be refused for before one is sent; the program still has the last word, and it also checks that something was spent, direction, the band, that the asset ends no further from its target than it began, the value received and the loss cap, which depend on the trade.
- A leg values the positions it does not trade by `tracked`. Where `needsSync` is true, send `sync_balances` first, in the same transaction or before. It is signed by the vault's keeper or its owner and by nobody else; its accounts are the signer, the vault, Config, then the token accounts to read.
- A leg has to end no further from the asset's target than it began, and has to spend something. Size a leg to land on the target or just before it. An asset already within a few basis points of its target is left alone: a fill better than the reference can carry it further past the target than it was short of it, and that is `PastTarget`.
- The asset's switch is bit 0 of its entry's `flags` in `getAssetList()` (`keeperOn(entry)`). The price account and the indexes the keeper's checks use are the ones in that list, not the ones in the caller's asset list: the two should agree, and where they do not, the program goes by its own.

**Prices**

- The price account starts with Scope's discriminator on every network, mainnet's and the test exchange's (TNET-4); `getPrices` refuses one that does not (`AssetNotPriced`).
- A stale price is returned, with its age and with `market: 'open'` if the session is open. Every price carries `maxAgeSeconds`, which is `Config.max_price_age_s` from the same read: `isStalePrice(price)` says whether the keeper would refuse it.
- A price stamped ahead of the cluster's clock by more than `Config.max_price_age_s` is refused with `AssetNotPriced`. Inside that bound it is clock skew and reads as zero seconds old.
- Cash has no price unless the list gives it a Scope index. An asset with `priceKind: 'none'` gets no entry in the answer.
- One bad entry refuses the whole call, and the message names the asset and the index. Ask per asset where a partial answer is wanted.
- `BasketAsset.priceRef` for `scope` is the entry's index, `"0"` to `"511"`, in the one price account of the config.

**Transaction status**

- `track` can answer `Custom:<n>` first and the program's own error name later: the name needs the transaction's logs, which the node may not have yet. A first answer for a reverted transaction is not final.
- `processed` is pending. Expired means the finalized block height is past `validUntil` and the status was asked for again after that.
- Behind a pool of nodes the status and the height can come from two of them. Expired is only as sure as the status node is close to the tip: `send.ts` (ADS-2) should track on the node it sent through.

**Gas**

- `funding` charges every leg a fee, plus the vault's rent for a new vault and the wallet's own rent floor. Token accounts: where the caller says how many the legs open (`FundingNeed.newAccounts`: the vault's cash account when the vault is new, and one per asset bought for the first time), that many are charged; where it does not, one per leg, which is a bound and not a quote. No priority fee is counted yet.

## The market rule the reader assumes (for SOL-3 to match)

A stock token is open when all of these hold, on the cluster's clock:

- Monday to Friday, UTC.
- `session_open_utc_s <= second of the day < session_close_utc_s`. A session whose close is not after its open (one that wraps past midnight) is never open.
- The day is not in `closed_days`. A zero there is an empty slot.
- `clock >= closed_until`: open at exactly `closed_until`.

## What TNET-4's price account must look like

- Owned by the program in `Config.price_owner`. Exactly 28,712 bytes.
- Entry `i` at byte `40 + 56·i`: value u64, exponent u64, slot u64, unix time u64, then 24 bytes the reader ignores. Price is value / 10^exponent, USD for one whole token. Exponent at most 30, value and time above zero.
- The time is the source's, in unix seconds, so a copied price ages as the real one does.
- The first eight bytes are Scope's discriminator (`SCOPE_PRICES_DISCRIMINATOR`) on every network, checked since ADS-2; the next 32 are not read.
- Mainnet's indexes, read on Oct 2: SPYx 344, QQQx 347, NVDAx 332, TSLAx 338, USDC 13. Keeping them lets one asset list serve both networks.
- Test stock mints carry the scaled-UI-amount extension; decimals equal the asset list's.

## Tests

- `tests/solana-vault/contract.test.ts`: the adapter contract of `packages/chain-mock`, five of its seven groups (`reads`, `shared portfolios`, `quotes`, `builds`, `refusals`), 43 cases, against the real program and the test exchange in LiteSVM (`svm-node.ts` answers the RPC calls the adapter makes), on a world made with the adapter's own builders (`contract-world.ts`). It runs when `target/deploy` holds both programs.
- `tests/solana-vault/validator.test.ts`: the other two groups (`signed bytes`, `state after a transaction lands`), 19 cases, on a local validator, where a node answers for sending, tracking and `fate`; then the API end to end on the same validator. `SOLANA_LOCAL_VALIDATOR=1`. LiteSVM keeps one blockhash and checks no signature, so those two groups are not run there.
- `builders.test.ts` (sizes at 1, 7, 12 and 16 targets, a keeper leg in a vault of 16 positions, the guard's shape, an accept past 16 lines), `program.test.ts` (every instruction decoded against `idl/basket.json`), `routes.test.ts` (Jupiter's recorded answer, the test exchange's pair), `send.test.ts` (the probe on a node in memory).

- `tests/solana-vault/`: against `fixtures/solana-vault/world.json`, account bytes the built program wrote in LiteSVM. `pnpm --dir programs/tests fixtures` rewrites it.
- The reader passes the adapter contract's own `reads` group (`adapterContract(name, setup, { groups: ['reads'] })` in `tests/solana-vault/reads.ts`), on the fixture and on a local validator. The other groups take a full adapter as their fixture, set up with the transactions it builds, so they wait for the builders (ADS-2). `shared portfolios` is one of them: the registry is on chain and the same file reads it (`getRecipe`, a follower's `pending`), but the group's fixture needs a second portfolio and a vault one version behind it.
- `SOLANA_LOCAL_VALIDATOR=1 pnpm exec vitest run tests/solana-vault/local-validator.test.ts`: the same read cases on a local validator, with real transactions.
