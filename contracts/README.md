# contracts

The EVM vault contracts, a Foundry project. The design is `docs/vault/DESIGN-VAULT.md`, sections 3.8, 5 and 13.

Built so far (EVM-1): the vault's owner path behind a beacon (`src/BasketVault.sol`) and the platform settings it reads (`src/VaultConfig.sol`). The factory, the registry and the owner swap are EVM-2; the keeper path is EVM-3.

## Run

```
pnpm install                                   # OpenZeppelin 5.6.1 and forge-std 1.17.0 come from pnpm
pnpm test:contracts                            # forge test, from contracts/
node contracts/script/rules-bite.mjs           # takes each check out in turn; a named test must fail
RH_FORK_URL=https://robinhood.drpc.org pnpm test:contracts   # also the tests on a fork of Robinhood Chain
```

The fork tests read a pinned block and send nothing. Without `RH_FORK_URL` they are skipped.

Run forge from this folder, not with `--root`: with `--root` a failing run writes a `cache/` folder where it was called from.

## What holds today

- Tokens leave a vault only by the owner's call and only to the stored owner. No function takes a recipient. There is no `fallback` and no `receive`. A test pins the full list of entry points.
- A deposit is the chain's cash token, read from the config each time. A token sent in from outside is not in `tokens()`; the owner takes it out with `withdraw(token, amount)`.
- `withdraw` and `withdrawAll` call neither the config nor anything else but the token.
- `withdrawAll` gives each token 100,000 gas for its balance read and 300,000 for its transfer, and needs 420,000 left before each token. Short of that it fails as a whole, so a token is never skipped for lack of gas. `withdraw` passes on all the gas.
- State is in ERC-7201 namespaces: `basket.storage.BasketVault` and `basket.storage.VaultConfig`. Append to the structs, never reorder.

## Before the factory and the swaps

Not built in EVM-1. EVM-2 and EVM-3 start from this list.

1. **The factory creates every vault with the init call inside the proxy's constructor, and binds the address to the owner** (the salt includes the owner). A beacon proxy created without its init call belongs to whoever initialises it first: in the review a stranger did that and withdrew tokens that had been sent to the address in advance. The app and the keeper trust only vaults the factory registered (`vaultOf`, `vaultAt`), never an address that merely runs the same code.
2. **Every way in adds the token to `tokens`.** `createVaultAndBuy`, the output of `ownerSwap` and the output of `keeperSwap` each add their token, as `deposit` does. Otherwise `withdrawAll` leaves it behind and reports nothing.
3. **A token is never a router, and Permit2 is never a router.** With a token as the "router", swap data can be `approve(attacker, max)`: it moves no balance, so it passes every balance check. The config already refuses a listed asset as a router and a router as an asset. Permit2 is neither a listed asset nor ours, so the factory must refuse it by address, and with it the vault's own address.
4. **There is no delisting.** An asset, once listed, stays. If a way to remove one is added, decide what happens to the cash token, to targets that name the asset, and to a vault's `tokens`.
5. **`setAsset` keeps the stored `haltUntil`.** The guardian's `haltAsset` (tighten only) and the admin's way to shorten a halt are both still to build.
6. **A later version of the vault logic that needs a `reinitializer` must gate it to the owner or the factory.** An open one is a second `initialize`.
7. **`multicall` and the reentrancy guard cannot both be on the same functions.** `multicall` is a delegatecall to the vault itself, so a guarded `multicall` blocks every guarded call inside it. Guard the inner functions and leave `multicall` unguarded, and check that hostile case A17 (a router that re-enters `multicall`) still fails.
8. **`isValidSignature` must be absent, with a test.** With ERC-1271 on the vault, the router's Permit2 command becomes usable from the keeper's call data. The entry-point test in `test/BasketVaultProxy.t.sol` is the place: it fails when any function is added.
9. **The beacon should be `Ownable2Step`.** OpenZeppelin's `UpgradeableBeacon` hands ownership over in one step and can renounce it. A mistyped address there loses the upgrade key for every vault.
10. **`initialize` will change.** It takes the owner, the plan id and the config today. Nothing is deployed, so EVM-2 adds the targets, the index and the registry freely, and appends to `VaultStorage`.
11. **Each new check gets a row in `script/rules-bite.mjs`**, and each new entry point a line in the entry-point test.
