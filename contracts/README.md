# contracts

The EVM vault contracts, a Foundry project. The design is `docs/vault/DESIGN-VAULT.md`, sections 3.8, 5, 6 and 13.

Built so far:

| Contract | What it is | Slot |
|---|---|---|
| `src/BasketVault.sol` | One person's vault for one plan, the logic behind every vault's beacon proxy. The owner's path: deposit cash, swap, set targets, withdraw in kind | EVM-1, EVM-2 |
| `src/VaultFactory.sol` on `src/VaultConfig.sol` | Creates the vaults and lists them; holds the platform's settings, the three roles and the guardian's switches. A UUPS proxy | EVM-1, EVM-2 |
| `src/IndexRegistry.sol` | The shared portfolios and the four author limits. A UUPS proxy | EVM-2 |
| `src/VaultBeacon.sol` | The one beacon of a chain, handed over in two steps | EVM-2 |

The keeper path is EVM-3: `keeperSwap`, `acceptVersion`, `adoptVersion`, `setAutoFollow`, `snapshot`.

## Run

```
pnpm install                                   # OpenZeppelin 5.6.1 and forge-std 1.17.0 come from pnpm
pnpm test:contracts                            # forge test, from contracts/
node contracts/script/rules-bite.mjs           # takes each check out in turn; a named test must fail
RH_FORK_URL=https://robinhood.drpc.org pnpm test:contracts   # also the tests on a fork of Robinhood Chain
```

The fork tests read a pinned block and send nothing. Without `RH_FORK_URL` they are skipped.

Run forge from this folder, not with `--root`: with `--root` a failing run writes a `cache/` folder where it was called from.

`rules-bite.mjs` works on copies of the project in a temporary folder and never edits the checkout. A full run takes about 40 minutes with three jobs; `--check` only verifies that each rule's text and test still exist, in a second.

## Deploy, as a dry run

```
anvil                                                                   # a local chain, in another terminal
cd contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

It simulates against the chain the URL answers for and prints what it would deploy: the vault logic, the beacon, the factory and the registry with their logic contracts, and the settings it wrote. Nothing is sent without `--broadcast`, and sending is a person's to do. The settings come from `script/config/<chain id>.json`; `example.json` shows every field. A file is refused on any chain but the one it names.

The deployer is the admin while the script runs and proposes the file's admin at the end. Until that key calls `acceptAdmin()` on the factory and `acceptOwnership()` on the beacon, the deployer still holds both.

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

**Storage**

ERC-7201 namespaces: `basket.storage.BasketVault`, `basket.storage.VaultConfig`, `basket.storage.VaultFactory`, `basket.storage.IndexRegistry`. Append to the structs, never reorder. `test/StorageLayout.t.sol` pins where each field is.

## Known limits

From the review of this slot. None lets anyone but the owner move a vault's tokens.

- **A token sent to a vault's address before the vault exists** waits for its owner as long as the factory's logic carries the same proxy creation code: the address is derived from it. A factory upgrade built with another compiler, other settings or another OpenZeppelin would move `vaultOf` for every vault not yet created. `test_vaultOf_theProxysCreationCodeIsPinned` fails when a build changes that code. Vaults that exist are unaffected.
- **Ether at a vault's address cannot be taken out.** Nothing in the vault is payable, so none can be sent to a live vault; ether sent to the address before the vault exists, or forced in, stays.
- **`launch()` does not lengthen a wait that has begun.** The 48-hour floor holds for every version published after it. A version already waiting keeps the time it was given, so before `launch()` the team lets waiting versions take effect or cancels them.
- **A shared portfolio can be left unable to publish.** An asset taken off the list cannot be in a new version at all, and dropping more than 20% in one version is over the turnover limit; the same if the asset becomes the cash token or its ceiling falls more than 20 points under its weight. The four rules say this on every chain. Until it is decided otherwise, do not remove an asset that a live portfolio holds above 20%.
- **A vault can follow a version that names a removed asset or today's cash token**: it copies the active version as it is. It cannot buy the removed asset. The keeper path has to live with such targets.
- **A token that fixes Permit2's allowance at infinity** (some token libraries do by default) can be bought, withdrawn and sold through a router that pulls directly, and not sold through one that pulls through Permit2: the vault cannot set or clear that allowance. Do not list one on a chain whose only router is pull 2, and do not build test tokens that way.
- **The check that a router is not a token** is made once, when the router is listed, with 100,000 gas for the probe. A contract that starts answering as a token later is not seen. What that could reach is a token sent to a vault from outside and never listed: listed tokens are refused by address.

## For the keeper path (EVM-3)

1. **The vault's storage is ready**: `indexId`, `acceptedVersion`, `autoFollow`, `operator` and `targets` are in `VaultStorage`. Nothing sets `autoFollow` or `operator` yet, and the factory refuses `autoFollow = true` at creation (`AutoFollowUnavailable`). Turning that on is a decision about what a create with auto-follow must check; lift the refusal in the same change that builds `setAutoFollow`. Append `lastKeeperAt` and the loss counter after `targets`.
2. **`_follow` is the accept.** `acceptVersion(indexId, expectedVersion)` is `_follow` behind `onlyOwner nonReentrant`, plus `VersionNotEffective` for a version that is still waiting. `adoptVersion` reads the registry the same way.
3. **Every new function that changes state takes the guard**, `adoptVersion` included: it is callable by anyone, and A17 is a router re-entering it mid-swap.
4. **`keeperSwap` can reuse `_swap`**, which already does the approval, the take-back and the balance checks. Two things differ. The keeper's `minOut` is computed by the vault from the feeds, not passed in. And the "no other token went down" check leaves out a token whose balance could not be read before the swap: for the owner that is a liveness choice, for the keeper decide whether an unreadable accepted asset should stop the trade.
5. **A removed asset keeps its settings** (`asset()` still answers, `isAsset` is false, `wasAsset` true), so it can be valued and sold. Decide whether the keeper may sell one.
6. **The guardian's switches are stored and not yet read**: `keeperPaused`, `haltUntil`, `closedUntil`, `closedDay`, the params. The keeper path reads them; the owner path must never.
7. **A later version of the vault logic that needs a `reinitializer` must gate it to the owner or the factory.** An open one is a second `initialize`.
8. **Each new check gets a row in `script/rules-bite.mjs`**, and each new entry point a line in `test/EntryPoints.t.sol`.
