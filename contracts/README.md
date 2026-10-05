# contracts

The EVM vault contracts, a Foundry project. The design is `docs/vault/DESIGN-VAULT.md`, sections 3.8, 5, 6 and 13.

Built so far:

| Contract | What it is | Slot |
|---|---|---|
| `src/BasketVault.sol` | One person's vault for one plan, the logic behind every vault's beacon proxy. The owner's path: deposit cash, swap, set targets, withdraw in kind, accept a version, switch auto-follow. The keeper's swap, and the adopt anyone may call | EVM-1, EVM-2, EVM-3 |
| `src/VaultFactory.sol` on `src/VaultConfig.sol` | Creates the vaults and lists them; holds the platform's settings, the three roles and the guardian's switches. A UUPS proxy | EVM-1, EVM-2 |
| `src/IndexRegistry.sol` | The shared portfolios and the four author limits. A UUPS proxy | EVM-2 |
| `src/VaultBeacon.sol` | The one beacon of a chain, handed over in two steps | EVM-2 |

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

`46630.json` lists no asset, no cash token and no router: the test tokens, the price feeds and the exchange of that network are TNET-1 and TNET-2. Once they exist, their addresses go into the file and the second entry lists them on the factory already deployed, as its admin:

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

## For the test network and the adapter

What TNET-1 and TNET-2 need from these contracts, to list a test token for the keeper:

- A price contract per token with Chainlink's `latestRoundData()` and 8 decimals, and a second one for the token's one-hour average, each with its own `updatedAt`. The keeper's switch cannot go on without the average.
- On each test stock token, `effectiveAt()` and `paused()` as Robinhood's tokens have them, for `scheduleSelector` and `pauseProbe`.
- The routers' addresses, with how each pulls (2 for Universal Router through Permit2), and the cash token. Then `script/config/46630.json` takes them, with each asset's range (`minPrice`, `maxPrice`, at most a factor two, around a price checked against the pool) and `flags` 1, and `settings()` writes them.

What ADE-1 and ADE-2 need: the ABIs in `idl/evm/`; `snapshot()` for one read of a vault (the targets, then the cash token with what the targets leave); the keeper's swap carries `minOut` and the vault checks the value too; `ownerSwap` and `createVaultAndBuy` take a deadline the guard holds to at most 30 minutes ahead, which the adapter states as the attempt's `validUntil`; the error codes are in `packages/schemas` (`CONTRACT_ERROR_CODE`).
