# contracts

The EVM vault contracts, a Foundry project. The design is `docs/vault/DESIGN-VAULT.md`, sections 3.8, 5, 6 and 13.

Built so far:

| Contract | What it is | Slot |
|---|---|---|
| `src/BasketVault.sol` | One person's vault for one plan, the logic behind every vault's beacon proxy. The owner's path: deposit cash, swap, set targets, withdraw in kind, accept a version, switch auto-follow. The keeper's swap, and the adopt anyone may call | EVM-1, EVM-2, EVM-3 |
| `src/VaultFactory.sol` on `src/VaultConfig.sol` | Creates the vaults and lists them; holds the platform's settings, the three roles and the guardian's switches. A UUPS proxy | EVM-1, EVM-2 |
| `src/IndexRegistry.sol` | The shared portfolios and the four author limits. A UUPS proxy | EVM-2 |
| `src/VaultBeacon.sol` | The one beacon of a chain, handed over in two steps | EVM-2 |
| `testnet/` | TEST NETWORK ONLY: the test cash, the test stock token, the test price contract, the sequencer stub and the test market of the EVM test networks; never deployed on a mainnet. See "The Robinhood Chain test network" | TNET-1, TNET-2 |

## Run

```
pnpm install                                   # OpenZeppelin 5.6.1 and forge-std 1.17.0 come from pnpm
pnpm test:contracts                            # forge test, from contracts/
node contracts/script/rules-bite.mjs           # takes each check out in turn; a named test must fail
RH_FORK_URL=https://robinhood.drpc.org pnpm test:contracts   # also the tests on a fork of Robinhood Chain
```

The fork tests read a pinned block and send nothing. Without `RH_FORK_URL` they are skipped.

The ABIs of the five contracts are committed in `idl/evm/`, beside the Solana interface files: `BasketVault`, `VaultFactory`, `VaultConfig` (the settings half of the factory), `IndexRegistry`, `VaultBeacon`. After a change to a contract's interface, `cd contracts && forge build && node script/abi.mjs` writes them again; `test/Abi.t.sol` fails while they are not what the build gives.

Run forge from this folder, not with `--root`: with `--root` a failing run writes a `cache/` folder where it was called from.

`rules-bite.mjs` works on copies of the project in a temporary folder and never edits the checkout. It runs one compiler at a time unless told otherwise (`--jobs 3` needs a machine with memory for three), and a full run takes about an hour and a half that way; `--from` and `--count` run it in pieces, and `RULES_BITE_DIR` keeps the copy between them. A rule bites only when its named test fails: a set-up that fails with the rule removed does not count. `--check` verifies in a second that each rule's text and test still exist, and prints how many rules and distinct removals there are, by file.

## Deploy, as a dry run

```
anvil                                                                   # a local chain, in another terminal
cd contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# Robinhood Chain's test network (46630), read only: the deployer's address, never its key
cd contracts && forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com \
  --sender <deployer address>
```

It simulates against the chain the URL answers for and prints every transaction it would send, numbered, with its target and what it does (`tx 1 ... create the vault logic`, ..., `setClosedDay(20783, closed)`), then what it deployed. Nothing is sent without `--broadcast`, and sending is a person's to do. The settings come from `script/config/<chain id>.json`; `example.json` shows every field. A file is refused on any chain but the one it names.

The deployer is the admin while the script runs and proposes the file's admin at the end. Until that key calls `acceptAdmin()` on the factory and `acceptOwnership()` on the beacon, the deployer still holds both. A file with `"adminIsDeployer": true` keeps them with the deployer, as on a test network with one key: `46630.json` does, with no guardian (the admin makes the guardian's calls) and no keeper yet.

`46630.json` lists no asset, no cash token and no router until the test network kit has run: `scripts/testnet/robinhood/vault-config.ts` fills them from the kit's record ("The Robinhood Chain test network" below). On a factory already deployed, the second entry lists them, as its admin:

```
FACTORY=<factory proxy> forge script script/Deploy.s.sol --sig "settings()" \
  --rpc-url https://rpc.testnet.chain.robinhood.com --sender <admin address>
```

## What holds today

**A vault and its owner**

- A vault is created by the factory and by nothing else. Its address is fixed by the factory, the beacon, the owner and the plan id, and the owner is the caller: no argument names one. `vaultOf(owner, planId)` answers before the vault exists, so a token sent there in advance waits for that owner.
- The proxy's constructor runs `initialize(owner, planId)`; the caller becomes the vault's config. The factory's next call, `start`, sets the targets and runs the first deposit and swaps. `start` answers only the factory and only in the creating transaction: the mark it needs is in transient storage. After that the factory has no way into a vault.
- Tokens leave a vault only by the owner's call: to the stored owner, or as the input of a swap the owner signed and for no more than its `amountIn`. No function takes a recipient. There is no `fallback`, no `receive` and no `isValidSignature`. `test/EntryPoints.t.sol` pins every entry point of every contract, each with its reason.
- A deposit is the chain's cash token, read from the config each time. A token sent in from outside is not in `tokens()`; the owner takes it out with `withdraw(token, amount)`, or trades it if the platform lists it.
- `withdraw` and `withdrawAll` call neither the config nor anything else but the token. `withdrawAll` gives each token 100,000 gas for its balance read and 300,000 for its transfer, and needs 420,000 left before each token. Short of that it fails as a whole, so a token is never skipped for lack of gas.

**The owner's swap**

- The router must be on the config's list, which says how it pulls: 1 directly, 2 through Permit2. The vault approves exactly `amountIn`, calls the router, takes the approval back and reads that it is gone, on the token and inside Permit2.
- The vault judges the swap by its own balances: at most `amountIn` of the input spent, at least `minOut` of the output received, no other token in `tokens()` lower than before. Both sides of a swap join `tokens()`.
- The input is a token the platform lists or once listed; the output one it lists now. So an asset taken off the list can be sold and withdrawn, and not bought.
- A token that is or was listed, Permit2, the factory, the registry, the beacon and every vault can never be a router. Neither can any contract that answers `allowance(address,address)` as a token does. The vault checks again for itself, Permit2 and any token it holds.
- One reentrancy guard covers every function that changes state. `multicall` is outside it on purpose: it only calls back into the vault, and each inner call takes the guard.
- A token whose balance cannot be read at all is left out of the "no other token went down" check, so that a token frozen by its issuer does not stop trades in the others.

**The platform's settings**

- The admin sets everything and is handed over in two steps. The guardian (or the admin) can only tighten: pause the keeper, halt an asset for longer, close the market for longer, add a closed day. Only the admin undoes any of it. None of it is read on the owner's path.
- `launch()` is one-way. From then on the publish delay is at least 172,800 s. Routers, the cash token and the feeds stay the admin's to change, each with an event. It is refused while a hand-over is half done: an admin proposed and not yet accepted, or a beacon that is not the admin's or is being handed to someone. A deploy leaves both in that state until the admin key accepts each, and a deployer key left with the beacon could replace every vault's code.
- The registry is set once. The keeper's limits have hard bounds: tolerance at most 300 bps, weekly loss cap at most 500 bps, cooldown at least 600 s.

**Shared portfolios**

- Version 1 takes effect at once. A later version takes effect one publish delay after it is published, by the clock and with no transaction; none can be published while one waits, and one per delay.
- The four limits are checked on every version and a refusal carries the number of the lowest rule broken, `CreatorLimit(reason)`. `test/IndexRegistryVectors.t.sol` drives the registry through all 87 cases of `fixtures/creator-limits/vectors.json`. `previewPublish` gives the same answer without sending.
- The creator, the guardian or the admin can cancel a waiting version. The wait before the next one is still counted from when it was published, and its number is not used again.
- A vault that follows a shared portfolio copies the active version at creation, if it is the version the person reviewed: otherwise `VersionMismatch` (A18).

**The keeper's swap (EVM-3)**

The checks of `DESIGN-VAULT.md` section 5, in the Solana program's order, each with a test at its boundary (`test/KeeperSwap.t.sol`, at 6, 8 and 18 decimals) and a bite row:

- The caller is the config's `keeper()`. There is no operator of a vault's own: `setOperator` is not in the interface, as Solana's `set_keeper` is not built. Auto-follow on, the keeper not paused.
- Cash on exactly one side; the other side a target of the vault, bought only while it is listed and sold whether or not it is. One trade per asset per cooldown, stamped only by a trade that spent something.
- The token: not within a day of its multiplier change either way (`scheduleSelector`, `effectiveAt()` on Robinhood Chain), not paused by its issuer (`pauseProbe`), not halted by the guardian. A schedule or a probe that does not answer refuses the trade. For a stock (`session` 1): Monday to Friday, inside the session, not a closed day, not before `closedUntil`.
- The reference price, for the asset and for every other target the vault holds: a Chainlink feed and the keeper's switch on, an answer above zero inside the asset's range, its average from `averageFeed`, both within `maxAge` of the clock either way, the two within `priceDevBps`. Base's sequencer feed, where the config names one. Cash at $1.
- Direction before the trade; after it, the vault's own balances as for the owner's swap (exact approval, revoked and read back, `minOut`, no other token lower), the value received within the tolerance at the reference, the band, no further from the target and at most half as far on the other side when it crosses, and the weekly counter, which drains over seven days and starts again at each loss.
- A stolen keeper key: `test/Keeper.invariant.t.sol` runs a keeper with a router that pays any price, pays someone else or takes another target, for seven days. The vault keeps 98% of its value at the reference (I2, twice the cap of 100 bps), no trade leaves its asset further from the target (I5), and nothing reaches the keeper or the router's choice (A1).

**Following (EVM-3)**

- `acceptVersion(indexId, version)` is the owner's: the version in effect, by its number (`VersionNotEffective` for the number that waits, `VersionMismatch` for any other). `setAutoFollow` is the owner's. A create can switch auto-follow on.
- `adoptVersion()` is anyone's, for a vault with auto-follow on and the keeper not paused, when a newer version is in effect and each of its assets is a target above zero (`NewAssetNeedsOwner` otherwise).
- Both keep an asset the version drops and the vault still holds as a target of zero, for the keeper to sell; past 16 targets is `InvalidTargets(1)`.

**Deadlines (EVM-3)**

`ownerSwap(swaps, deadline)` and `createVaultAndBuy(..., deadline)` are refused after `deadline`, in unix seconds. The guard passes one at most 30 minutes ahead of its own clock. The other owner calls take none; why is in `DESIGN-VAULT.md` 3.8, "Deadlines".

**Storage**

ERC-7201 namespaces: `basket.storage.BasketVault`, `basket.storage.VaultConfig`, `basket.storage.VaultFactory`, `basket.storage.IndexRegistry`. A later version adds fields at the end of `VaultStorage`, `ConfigStorage`, `FactoryStorage`, `RegistryStorage` and the registry's `Index`, and never reorders them. `test/StorageLayout.t.sol` pins where each field is, the `operator` in the slot it shares included.

Three structs cannot grow at all, because of where they are stored: `Params` sits inline in `ConfigStorage` with fields after it, so a new keeper limit is a new field at the end of `ConfigStorage`; the registry's `StoredVersion` sits twice in a fixed array, so a field added to it would move the second version; `Weight` is an array element of one slot. `AssetConfig` is a mapping's value and can take fields at its end.

## Known limits

From the review of this slot. None lets anyone but the owner move a vault's tokens.

- **A token sent to a vault's address before the vault exists** waits for its owner as long as the factory's logic carries the same proxy creation code: the address is derived from it. The project is built with no metadata hash in the bytecode (`bytecode_hash = "none"`, `cbor_metadata = false` in `foundry.toml`), so a comment, a file path or an unrelated source change does not move it. Two things still do: a change to the code of OpenZeppelin's `BeaconProxy` or of what it inherits, and a change to what the compiler emits for it (another solc version, optimizer setting or pipeline). A factory upgrade built after either would move `vaultOf` for every vault not yet created. `test_vaultOf_theProxysCreationCodeIsPinned` fails when a build changes that code. Vaults that exist are unaffected. The advice stands whatever the build: do not send tokens to a vault before it exists.
- **Ether at a vault's address cannot be taken out.** Nothing in the vault is payable, so none can be sent to a live vault; ether sent to the address before the vault exists, or forced in, stays.
- **`launch()` does not lengthen a wait that has begun.** The 48-hour floor holds for every version published after it. A version already waiting keeps the time it was given, so before `launch()` the team lets waiting versions take effect or cancels them.
- **A shared portfolio can be left unable to publish.** An asset taken off the list cannot be in a new version at all, so every removed asset must leave in the same version, and a version may move 20% at most. A portfolio whose removed assets weigh more than 20% together cannot publish: two at 15% each do it, though neither is above 20%. The same holds for an asset that becomes the cash token, or whose ceiling falls more than 20 points under its weight. The four rules say this on every chain. The way out is the admin's: list one of the assets again, and the author steps down over two versions. Until a rule for it is decided, do not remove assets that a live portfolio holds above 20% together.
- **A vault can follow a version that names a removed asset or today's cash token**: it copies the active version as it is. It cannot buy the removed asset. The keeper path has to live with such targets.
- **A token that fixes Permit2's allowance at infinity** (some token libraries do by default) can be bought, withdrawn and sold through a router that pulls directly, and not sold through one that pulls through Permit2: the vault cannot set or clear that allowance. Do not list one on a chain whose only router is pull 2, and do not build test tokens that way.
- **The check that a router is not a token** is made once, when the router is listed, with 100,000 gas for the probe. A contract that starts answering as a token later is not seen. What that could reach is a token sent to a vault from outside and never listed: listed tokens are refused by address.

**From EVM-3.** None lets anyone but the owner move a vault's tokens; each bounds or stops the keeper.

- **Balances are read, not tracked.** There is no `tracked` and no `syncBalances`: the keeper's swap reads `balanceOf` of every target, which Solana's account model cannot. A target sent in counts at once. So a stranger's dust of a target the vault held none of, while that target's price cannot pass, stops the keeper for that vault; on Solana `tracked` hides such dust and only the owner or the keeper can record it. The owner sells the dust, or the price comes back.
- **A target whose balance cannot be read stops the keeper** for the vault (`BalanceUnreadable`); the owner's path skips it as before.
- **Cash is $1.** The 0.5% peg check first written for EVM is not built, as on Solana. A dollar token off its peg is the guardian's pause to stop.
- **The average is held to `maxAge`**, not to an hour as on Solana, since a stock feed updates only in session. No Chainlink feed of an average exists on Robinhood Chain or Base: the switch goes on only for an asset whose average feed the platform provides (on the test network, TNET-1's price contract).
- **The multiplier window does not compare the next multiplier with the current one**, as Solana does: a schedule that changes nothing still keeps the keeper away for a day either side.
- **The keeper measures nothing past 10^30 raw units of cash** (`ValueTooLarge`): under that bound no product its checks form comes near 2^256.

## What the app and the trust notice must say

The admin key can replace the factory's logic. Through that it can reach two things a vault that exists is safe from: cash a person has approved to a vault not yet created, and tokens sent to that address in advance (`test_trust_theFactoryAdminReachesAVaultNotYetCreated_andNoVaultThatExists`). The beacon's key can replace every vault's code. So:

- **Approve the exact amount, in the same step as the create.** The approval to `vaultOf(owner, planId)` and `createVaultAndBuy` go out together, the first for exactly `cashAmount`.
- **Never send tokens to a vault's address before the vault exists.** Create it first.
- **Never leave a standing allowance to a vault.** Each `deposit` gets its own approval for its own amount.
- **Never create a vault through a shared helper contract.** The owner is `msg.sender` of the factory call: a helper that calls the factory owns the vault, for good.

## The notes EVM-2 left for the keeper path, and what EVM-3 did

1. Auto-follow: `setAutoFollow` is built, and a create may switch it on (`AutoFollowUnavailable` is gone). `lastKeeperAt`, `lossAccum` and `lossTs` are appended after `targets` (`test/StorageLayout.t.sol`). `operator` stays reserved and unread.
2. `acceptVersion` is `_follow` behind `onlyOwner nonReentrant`, with `VersionNotEffective`; `adoptVersion` reads the registry the same way.
3. Every new function that changes state takes the guard; A17 re-enters `keeperSwap` and `adoptVersion` mid-trade.
4. `keeperSwap` reuses the owner's trade (`_trade`). Its `minOut` is passed in and held, as on the owner's path, and the vault also works out the value it must receive from the feeds (check 4). Every target must be readable: one that is not stops the keeper. A token outside the targets keeps the owner's rule.
5. The keeper may sell a removed asset still held as a target, and may not buy it.
6. The keeper path reads the pause, the halts, `closedUntil`, the closed days and the params; the owner path reads none of them (`test_I4_theOwnersPath_withEveryKeeperSwitchAgainstIt`).
7. Still true of any later version: a `reinitializer` must be gated to the owner or the factory.
8. Done: 89 more rows in `script/rules-bite.mjs`, 318 in all, and the entry points in `test/EntryPoints.t.sol`.
9. Not done, on purpose: accept and adopt copy a version that names a removed asset as it is, as Solana does. The keeper never buys a removed asset, so that weight stays in cash. The guardian still cancels waiting versions that name one.
10. Still open: a token in `tokens` whose balance read fails after having answered blocks later swaps of the owner and of the keeper; the owner cannot drop it from `tokens`.
11. Still open: versions published before `launch()` keep their short wait.
12. The vault logic and the factory are one build: `start` changed selector and `asset()` returns the appended fields. A chain that already runs the EVM-2 contracts upgrades the beacon and the factory in one transaction (a batch from the admin's Safe), never one without the other. Nothing EVM is deployed yet.

## The Robinhood Chain test network (TNET-1, TNET-2)

TEST NETWORK ONLY. Chain 46630 has Uniswap v4 (mainnet's PoolManager code at mainnet's address), Permit2, Multicall3, the CREATE2 deployer and Universal Router 2.1.1. It has no Universal Router 2.1.2, no Chainlink feed and none of our tokens (`docs/vault/research/test-networks.md`). The kit brings them, and the vault contracts run on it unchanged.

**The contracts (`testnet/`)**, outside `src/` so that nothing reading the vault's own contracts (the error codes, the ABIs, an audit's tools) takes them for product code.

| Contract | What it is |
|---|---|
| `TestToken` | An ERC-20 whose admin names who mints and burns (`MINTER_ROLE`). The test cash, tUSDG, 6 decimals. It leaves Permit2's allowance alone |
| `TestStockToken` | A test stock token, 18 decimals, with the calls of Robinhood's own (read from the implementation behind their test TSLA on 46630): `uiMultiplier`, `newUIMultiplier`, `effectiveAt`, `updateMultiplier` now or at a time, `balanceOfUI`, `totalSupplyUI`, `paused`, `pause`, `unpause`, `mint`, `burn`. A multiplier set for a time takes effect then; a paused token moves nothing, mint and burn included. The vault's probes read `effectiveAt()` and `paused()` on it |
| `TestPriceFeed` | Chainlink's aggregator interface (`decimals`, `description`, `version`, `latestRoundData`, `getRoundData`), 8 decimals. One price writer, or the owner, writes each round: above zero, newer than the last, at most 60 s ahead of the clock. No round yet reverts, as a new aggregator does. Each token has two: its price and its one-hour average |
| `StubSequencerFeed` | Chainlink's L2 sequencer uptime answer (0 up, 1 down, `startedAt` the change), flipped by its owner. For Base Sepolia; Robinhood Chain has no sequencer feed |
| `TestMarket` | The market maker of the test pools: one hookless v4 pool per stock token against the test cash (fee 500, tick spacing 10), opened at the token's test price, seeded over the whole range, and moved back to the test price (`recentre`) when it drifts more than 10 bps. It holds the minter role and no stock: it mints what a pool is owed and burns what it takes. The owner opens and seeds; the owner or the operator (the price writer) re-centres, and only ever to the price the token's own price contract holds |

**The scripts**

- `script/testnet/TestnetKit.s.sol` with `script/testnet/config/46630.json`: the test cash, eleven test stock tokens (tSPY, tQQQ, tNVDA, tAAPL, tMSFT, tGOOGL, tAMZN, tMETA, tTSLA, tGLD, tSGOV, each modelled on a Robinhood token with a Chainlink feed on mainnet), their 22 price contracts with a first round copied from mainnet, Universal Router 2.1.2, the market, its eleven pools and their liquidity (1,000,000 test dollars a side). Every contract goes through the CREATE2 deployer, and each step looks at the chain first, so a second run sends nothing. The deployer is the admin of everything; the price writer is never the deployer. With `TESTNET_RECORD` it writes the record (`deployments/robinhood-testnet.json`).
- `script/testnet/UniversalRouter-2.1.2.json`: Universal Router's creation code, built from its 2.1.2 tag with the repository's own settings. Its runtime equals mainnet's router at `0x204F…0498` byte for byte outside its immutables (`test_router_isMainnets2_1_2_outsideItsImmutables`, with `RH_FORK_URL`), and the kit deploys it with mainnet's constructor arguments.
- `scripts/testnet/robinhood/vault-config.ts`: fills `script/config/46630.json` from the record (the cash, each token with its price, average, pause probe, schedule and keeper switch, a range from 0.775 to 1.25 times the price it holds, the router at pull 2).
- `script/testnet/CopyPrices.s.sol`, run by `scripts/testnet/robinhood/prices.ts` (`--dry-run`, `--once`, `--loop`): reads each token's Chainlink feed on Robinhood Chain mainnet, read only, and writes the price with the feed's own answer and `updatedAt` when it is newer. The average, which no Chainlink feed gives, is the feed's rounds weighted by how long each held over the hour before the mainnet block, stamped with that block's time, written with each new round and between rounds at most every five minutes while it moves. Refused, with nothing of the token written: a source whose `description()` is not the record's, a value not above zero, stamped more than 60 s ahead, outside the vault's range (`FACTORY` set), or further from what the test network holds than 1,000 bps per hour since (at most 5,000), the Solana copier's rules. Then every pool more than 10 bps off its price is re-centred. A source that does not answer refuses its own token only, and an average whose rounds cover less than the hour says so. It signs only as the record's price writer and refuses the deploy key.

**Tests**: `test/testnet/TestnetContracts.t.sol` (the rules of the token, the stock token, the price contract and the stub; the market's are in `TestnetKit.t.sol`), `TestnetVault.t.sol` (the vault's keeper path against the test contracts: the feed and its average, their age, their distance, the range, the issuer's pause with `withdrawAll` skipping the paused token, the multiplier window either side of a change, the sequencer stub; the owner's path reads none of it), `TestnetKit.t.sol` (the kit on chain 46630 with the real PoolManager's code from `test/fixtures/v4-pool-manager.json` and Universal Router from source, then the vault deployed by `Deploy.s.sol` on the kit's tokens: an owner's buy and a keeper's rebalance through Universal Router 2.1.2, a keeper trade refused while its pool is off the test price and passed once re-centred; the same file runs on a fork of the live test network with `RH_TESTNET_FORK_URL`), `CopyPrices.t.sol` (the copier's reading and rules). `node script/rules-bite.mjs testnet` takes each rule out in turn.

**Deploying it.** On Thom's word (given for 46630 on Oct 5), with funded test keys only.

1. Keys, kept outside the repo (`testnet-keys/robinhood-testnet-deployer.key` and `robinhood-testnet-price-writer.key`, with their addresses beside them): the deployer (admin of every kit contract and, with `adminIsDeployer`, of the vault's factory and beacon; the guardian's calls too), the price writer (writes the 22 price contracts and re-centres the pools; never the deployer), and later the keeper (`setKeeper`). Put the price writer's address in `script/testnet/config/46630.json` (`priceWriter`) and the keeper's, if made, in `script/config/46630.json`.
2. Test ETH. The faucet is hard to reach, so only the deployer is funded (0.01 ETH, Oct 5) and it forwards the price writer's share. Measured on a local fork of 46630 on 2026-10-05: the kit 137 transactions and 40.9 million gas, the vault 36 transactions and 14.6 million gas, one copier round that writes all eleven tokens and re-centres every pool 33 transactions and 3.35 million gas. The test network's own gas estimates run about 15% above the fork's (its L1 share). At its 0.01 gwei base fee:

   | Step | Gas, with the 15% | ETH |
   |---|---|---|
   | Kit | 47 million | 0.00047 |
   | Vault | 17 million | 0.00017 |
   | To the price writer | | 0.008 |
   | Left with the deployer, for `setKeeper`, `settings()` and a re-run | | about 0.0013 |
   | A copier round that writes every token and moves every pool | 3.9 million | 0.000039 |

   So the price writer's 0.008 ETH pays for about 200 full rounds. A round with nothing newer on mainnet and every pool on its price sends nothing and costs nothing; what a loop costs is the mainnet rounds it copies (a few an hour per token in session, none off session), the averages catching up for an hour after each, and the pools that trades pulled away.
3. The kit, as a dry run, then sent:

   ```
   cd contracts
   forge script script/testnet/TestnetKit.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --sender <deployer>
   TESTNET_RECORD=script/testnet/deployed/46630.json forge script script/testnet/TestnetKit.s.sol \
     --rpc-url https://rpc.testnet.chain.robinhood.com --sender <deployer> --broadcast --slow --interactives 1
   ```

   A second dry run prints `transactions: 0`. `script/testnet/deployed/46630.json` is the kit's own record: the market, each token's price contracts and its mainnet source, for the copier and the scripts below.
4. The vault's config and the vault: `pnpm exec tsx scripts/testnet/robinhood/vault-config.ts` (each range around the price the kit wrote), then `forge script script/Deploy.s.sol` with the same RPC and `--sender <deployer>`, dry, then with `--broadcast --slow --interactives 1`.
5. The price writer's gas, from the deployer: `cast send <price writer> --value 0.008ether --rpc-url https://rpc.testnet.chain.robinhood.com --interactive`.
6. The first copy, so that every price is fresh and every pool on it: `pnpm exec tsx scripts/testnet/robinhood/prices.ts --dry-run`, then with `PRICE_WRITER_KEY_FILE=<path>` and `--once`.
7. The record the API and the guard read, in ADE-1's shape (`EvmDeploymentRecord`): `FACTORY=<factory proxy> pnpm exec tsx scripts/testnet/robinhood/record.ts` reads it all from the chain through the factory and writes `deployments/robinhood-testnet.json`. Commit it, the kit's record and the filled `script/config/46630.json`.
8. The copier runs while someone tests or shows the network, not for good: `FACTORY=<factory proxy> PRICE_WRITER_KEY_FILE=<path> pnpm exec tsx scripts/testnet/robinhood/prices.ts --loop --every <seconds>` (60 by default, 15 at the least). The vault takes a price and its average up to `maxAge` old, 93,600 s (26 hours) on 46630 as on mainnet, so for prices alone one `--once` a day in session keeps the keeper trading; the average also has to be within 200 bps of the price, which a round right after a move does not give until the average catches up. What needs a shorter interval is the pools: a buy moves its pool and the next keeper trade in that token is refused (`ValueTooLow`) until a round re-centres it, so while someone trades, `--every 60` to `300`. With `--hold-last` (off unless said) a price or an average whose mainnet feed has posted nothing newer is written again, same value, when it is four hours from the age the vault takes (26 hours for the stock tokens), stamped with the time of the mainnet block read, so the weekend does not leave the test network stale; a round mainnet posts later is newer and is copied as usual. Only a value the source still holds is held, and each one is logged as `held tSPY at 669.12000000 (source last posted 2026-10-09T20:00:00Z)`. The jump limit counts hours since the test network's value was stamped, so after a hold a Monday gap above `MAX_JUMP_BPS` is refused until a person raises it.

Deployed on 2026-10-05 on Thom's word: the record the API reads is `deployments/robinhood-testnet.json`, the kit's own is `script/testnet/deployed/46630.json`, the transactions and the cost are in TNET-2's row of `docs/vault/STATE-VAULT.md`. Rehearsed on 2026-10-05 against `anvil --fork-url https://rpc.testnet.chain.robinhood.com`, anvil's own account deploying and a throwaway key writing prices: kit 137 of 137 sent, second run 0; `vault-config.ts`, then the vault 36 of 36 with 12 assets and the router; the copier's dry run would write 11, `--once` wrote 11 and re-centred 11 pools, a second `--once` wrote 0, and a run with the deploy key stopped at `DeployKey`; `record.ts` wrote a record `EvmDeploymentRecord` parses, 11 assets.

**Known limits.** The pools follow the copied price because the market moves them there; a real pool does not, and this is what the test exchange is for, as on Solana. The average is ours: Chainlink publishes none on Robinhood Chain. Robinhood's own test stock tokens on 46630 are not listed. What a real stock token does between its calls (when a scheduled multiplier shows in `uiMultiplier`, what pausing stops) is not published; the test token does the plain thing. The kit's first rounds are copied when the config is written and go stale until the copier runs. The price writer's key is the hot key: it runs unattended, and `TestPriceFeed.write` holds a round only to above zero, newer and at most 60 s ahead, so the jump and range limits are the copier's and a stolen writer key can write any price the vault's range lets through (the range then stops the keeper). Its loss is the admin's `setWriter` and `setOperator` to a new key. The kit and the copier refuse Robinhood Chain's and Base's mainnet chain ids (4663, 8453) in Solidity, the copier reads only from 4663, and each TypeScript script asks the node its `eth_chainId` before anything else. A pool someone opened first at another price is moved to the test price by `open` while it is empty, and refused once it holds liquidity.

## For the adapter

What ADE-1 and ADE-2 need: the ABIs in `idl/evm/`; `snapshot()` for one read of a vault (the targets, then the cash token with what the targets leave); the keeper's swap carries `minOut` and the vault checks the value too; `ownerSwap` and `createVaultAndBuy` take a deadline the guard holds to at most 30 minutes ahead, which the adapter states as the attempt's `validUntil`; the error codes are in `packages/schemas` (`CONTRACT_ERROR_CODE`).
