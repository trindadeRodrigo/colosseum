# The EVM adapter for vaults

`import { createEvmVaultAdapter } from '@colosseum/chain-evm/vault'` for the whole `ChainAdapter` (reads, builders, quotes, the probe; ADE-2), and `buildCancelPending` beside it; `createEvmVaultReader` for the read side alone (ADE-1). The root entry does not re-export either, and nothing here holds a key.

One codebase for every EVM chain. The adapter takes a `ChainConfig` (its network, its router, and the factory and the registry under `contracts`), a viem public client the caller makes (`createEvmRpc(url)`), the asset list, and the pools it trades in (`V4Pools`; `ROBINHOOD_TESTNET_POOLS` for 46630). It reads no environment and no file. The cash token, the keeper, the pause, the keeper's limits and each asset's feed come from the factory, so what it reports is what the contracts enforce.

| File | What it holds |
|---|---|
| `adapter.ts` | `createEvmVaultAdapter`: every builder of DESIGN-VAULT 3.2, `quote`, and `buildCancelPending` |
| `compose.ts` | One transaction from a builder's call: `eth_simulateV1` with its transfers traced, the refusal a revert maps to, gas, fee, nonce, preview, message hash |
| `routes.ts` | The route: Uniswap's v4 Quoter for a quote, Universal Router call data for a swap (`V4Pools`) |
| `send.ts` | The probe (`TxProbe`): `messageHashOf`, `relay`, `carries`, `fate`, `nonceOf`. Key-free |
| `reader.ts` | `createEvmVaultReader`: vaults, prices, holdings, funding, `track`, the platform's settings, each asset's settings |
| `deployment.ts` | The record an EVM deploy commits (`deployments/<chain>-<network>.json`), the assets it lists, and `assertNode` |
| `generated/abi.ts` | The four ABIs of `idl/evm`, typed. `pnpm --filter @colosseum/chain-evm abi` writes them again (`scripts/evm/abi-types.ts`); a test fails while they differ |
| `errors.ts` | A revert as the code every adapter reports (`CONTRACT_ERROR_CODE`), with the contract's name and numbers in the message |
| `market.ts` | The session rule of the keeper's path: Monday to Friday, `sessionOpen` to before `sessionClose`, no closed day, not before `closedUntil` |
| `unlisted.ts` | The id of a token the app does not list: `<chain>:token-` and its 20 bytes in hex |
| `rpc.ts` | `createEvmRpc`, and the line between a node that did not answer (`Unavailable`) and a call that reverted |

## How it reads

- One moment per read: the latest block is asked first and every call of the read names it. Calls made together go as one JSON-RPC batch. A fork case holds every `eth_call` of each read to one block number and to the override, through a transport that records them.
- The node's chain id is asked once and must be the config's `evmChainId` (`Unavailable`, not retryable, otherwise): a reader set up for the test network does not read a local copy, nor the other way round.
- Each listed token's decimals, cash included, must be what the factory states (`asset(token).tokenDecimals`), checked on every read that shows a balance or a price: a list off by a power of ten is refused as `Unavailable`, not retryable. Held on the fork at 6 (USDG), 8 (a test token of our own) and 18 (the stock tokens).
- A balance is read or refused by name (`BalanceUnreadable`): a token that reverts or has no code is never a zero.
- `stateOverride` is handed to every `eth_call`. It is the room left for Base, whose stock tokens a plain fork cannot run: the code and storage a read needs are put in place for the call only. Nothing on Robinhood Chain uses it.
- A vault is one `snapshot()`: its targets in the vault's order (by token address), then the cash token with the share the targets leave. Every token the app lists that the vault holds with no target on it is read too (`balanceOf`) and shown at a target of zero. A token it does not list is not seen unless it is a target.
- `getVault` answers only for a vault the factory lists (`isVault`): an address that merely runs the same code is `null`.
- `getVaults(owner)` is `vaultsOf(owner)`, sorted by plan id. `listAutoFollowVaults` walks `vaultAt(0..vaultCount)` and asks each `following()`: there is no indexer yet.
- A plan id above 64 bits, a snapshot that does not end with the factory's cash token, and a target on the cash token are refused with `Unknown`: the app never makes them. The contracts let a vault follow a version that names today's cash token (README of `contracts/`, known limits); such a vault cannot be read here until that case is decided.
- `pending` is the version in effect when the vault took an earlier one, else the version that waits, with `newAssets` the ones the vault has no target above zero on. The registry answers the version in effect by the block's clock, as the vault does.
- `lossUsedBps` is the snapshot's own figure, held to 10,000.

## Tokens and multipliers

- A holding's `multiplier` is what the token answers to `uiMultiplier()` (18 decimals, ERC-8056): Robinhood's stock tokens turn it to `newUIMultiplier()` at `effectiveAt()` by themselves. `scheduled` is set while `effectiveAt()` is ahead of the block and the next multiplier differs. A token with no `uiMultiplier()` is '1' only where it may have none (the dollar token, a class other than stock or ETF, a token the app does not list); a stock or an ETF that answers none is refused with `Unknown`.
- A target or a portfolio line on a token the app does not list shows under `robinhood:token-<hex>`, with the decimals the factory states for it, never refused: one author's portfolio must not stop every read of every vault that follows it.

## Prices

- Only assets with `priceKind: 'chainlink'`. Cash is a dollar to the vault and is never priced here.
- The feed, its decimals and `maxAge` are the factory's (`asset(token)`). An app list that names another feed for the asset is refused (`Unavailable`, not retryable): the list is not this network's.
- `latestRoundData` as the vault reads it: no answer, or one of zero or below, is `AssetNotPriced`. `usdPerToken` is the answer over 10^feedDecimals, exactly; the feed already includes the multiplier. The age is the block's time less `updatedAt`. A stale price is returned with its age; one stamped ahead of the block by more than `maxAge` is refused.
- `market` follows the session rule of the keeper's path, with the factory's session hours, `closedUntil` and `closedDay(today)`.

## Funding and status

- `funding`: the cash token's balance, the native balance, and gas at `eth_gasPrice` doubled for `400,000` per step plus `400,000` for a new vault (the fork measured a first buy at 334,000 and `createVaultAndBuy` with one swap at 792,000). There is no rent: `newAccounts` changes nothing. The builder's estimate has the last word.
- `track(txId, validUntil?)`: a receipt is `confirmed` or `reverted`. A reverted one carries the code and the contract's error, from the same call replayed at the block before (an earlier transaction in the same block is not replayed, so it is the nearest answer). No receipt: `pending` while the node has the transaction or no deadline was given; past the deadline (`validUntil`, unix seconds) with nothing on the node, asked once more, then `expired`.

## The record and the node

`deployments/<chain>-<network>.json` (`robinhood-testnet`, `robinhood-local`) is what the API will read for a real EVM chain, as it reads `deployments/solana-devnet.json`. Strict: a field it does not have is refused, and so is a record whose `evmChainId` is a mainnet's (4663, 8453). Token contracts are under `address`, not `token`. `deploymentAssets(record)` makes the app's list from it, tier C and labelled `sandbox`. The shape, every field required:

```
{ network: 'robinhood-testnet' | 'robinhood-local' | 'base-…', chain, provenance: 'sandbox', evmChainId, deployBlock | null,
  contracts: { factory, registry, beacon, vaultLogic, factoryLogic, registryLogic },
  roles: { admin, guardian, keeper, priceWriter | null, tokenIssuer | null },
  routers: [{ address, pull: 1 | 2 }], sequencerFeed | null,
  cash: { id, symbol, name, address, decimals },
  assets: [{ id, symbol, name, address, decimals, modelOf, kind, feed, feedDecimals, averageFeed (zero address for none),
             maxAge, session: 0 | 1, maxWeightBps, keeperOn, range: { minPrice, maxPrice } | null }],
  retired: [{ id | null, symbol | null, address }] }
```

`priceWriter` is who writes the test price feeds, `tokenIssuer` who mints, schedules multipliers on and pauses the test tokens, `sequencerFeed` what the factory's `sequencerFeed()` names; each is null where the network's own are used.

`assertNode(rpc, record)` at start: the node's chain id is the record's and never a mainnet's, and the factory has code. A local copy of an EVM mainnet runs under its own chain id: the `local` presets are 31337 for Robinhood Chain and 31338 for Base (`LOCAL_EVM_CHAIN_IDS`), started with `anvil --chain-id`. A signature made for 4663 or 8453 is good on mainnet.

## The builders (ADE-2)

Every builder returns one unsigned transaction (`BuiltTx`) and refuses with a `ChainError`, for bad arguments as much as for a simulated revert. Each one:

- reads what it needs when it is called (the vault the factory lists and its owner, the plan's vault address by `vaultOf`, balances and the allowance to the vault), and refuses first what it can tell without the chain: `VaultNotFound`, `VaultExists`, `NotFunded` (the wallet's cash), `AllowanceTooLow` (the cash approved to the vault is short: approve first), `SpentTooMuch` (a trade of more than the vault holds by its turn, counting what the trades before it in the same step sell and, at the quote now, bring in: a sale's cash pays for the purchase after it; or trades in a create that spend more than it deposits), `TooManyTrades` (eight a transaction), `MintNotAccepted` (buying a token the app does not list; a keeper leg in an asset that is no target of the vault), `NotCashLeg`, `InvalidTargets` (cash as a target);
- simulates the call as its signer at the latest block with `eth_simulateV1` and its token transfers traced, and maps a revert to the contract's own error by name (`revertToChainError`: `CreatorLimit(12)`, `VersionMismatch`, `AutoFollowOff`, `NotTowardTarget`, `PastTarget`, `NewAssetNeedsOwner`, `VersionNotEffective`...);
- states the signer's next nonce (`pending`), or the one a rebuild is given; a gas limit of the node's estimate plus a fifth; and a fee of that gas at twice the node's gas price, with no tip (`preview.feeNativeRaw`);
- previews the token balances the call moves, from the simulation's `Transfer` logs, by holder (`wallet`, `vault`); states `minimums` for each trade as its bytes carry them; and puts the SHA-256 of `evmCallPreimage` in `messageHash`.

| Step | The call |
|---|---|
| Approve | `approve(vaultOf(owner, plan), amount)` on the cash token: never the factory, never more than asked |
| Create | `createVault(...)`, or `createVaultAndBuy(..., cash, swaps, deadline)` when it deposits or trades; following a portfolio, the version asked for or else the one in effect |
| Deposit | `deposit(amount)`, or `multicall([deposit, ownerSwap(swaps, deadline)])` with trades |
| Swap | `ownerSwap(swaps, deadline)`, up to eight |
| Targets, accept, auto-follow | `setTargets` (sorted by token), `acceptVersion(id, version)`, `setAutoFollow(on)` |
| Withdraw | `withdrawAll()` for everything (nothing when the vault holds nothing), or `withdraw(token, balance)` for each token named, in one `multicall` |
| Publish | `create(familyId, components, metaHash, 0, 0)` the first time, `publish(id, components, metaHash)` after; `cancel(id)` by `buildCancelPending` |
| Adopt, keeper leg | `adoptVersion()` and `keeperSwap(swap)`, signed by the factory's keeper; the keeper's `minOut` is the quote less 100 bps |

A trade is an exact-input swap in one hookless Uniswap v4 pool through Universal Router 2.1.x (`SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`, so the output goes to the vault), quoted by Uniswap's v4 Quoter. Its `minOut` is the quote less the slippage asked for. The router's own minimum is zero: the vault holds the swap to `minOut` by its own balances, so a price that moved is refused as the vault's `ReceivedTooLittle`, not wrapped as `RouterFailed`. Two trades in one pool are quoted one after the other (the cumulative amount less what came before), a unit lower for the pool's rounding; a pool traded both ways in one transaction is refused (`BadTrade`). An owner's trade carries a deadline `DEADLINE_S` (900 s) after the block's time, which the guard holds to at most 1,800 s ahead of its own clock; the adapter states it as the attempt's `validUntil` (`lastValidBlockHeight`). Calls that do not trade carry none.

Every owner step is the shape the guard of `packages/sdk` takes: one call, no value, to the cash token, the factory or the person's own vault, at most the deployment's gas and fee. Each passed the guard with the test network's deployment on Oct 6. The guard's deployment for 46630 is committed in `packages/sdk/deployments/testnet.json` (WEB-RH-BUY), with its registry since AGT-4, and `tests/evm-vault/guard.test.ts` holds every step to it. Since AGT-4 the guard signs a `publish` step on EVM too: `create`, `publish` or `cancel` on the registry the deployment names, held to the creator's id (`indexIdOf`, keccak256(abi.encode(creator, familyId))), the weights and the hash of the text shown.

## The probe

- `messageHashOf(signedTx)`: the call read back from the signed bytes, its signer recovered from the signature; `BadInput` for anything that is not one signed transaction with a target.
- `relay(signedTx)`: only bytes for this chain; the same call is run first (`eth_call` as the signer), and bytes that would revert are refused in the contract's words and not sent. Sent twice, the same id. A used nonce is `Expired`, a signer that cannot pay `NoGas`; the node's own message is not passed on.
- `carries(txId, hash)`: `unseen` while the node has no such transaction; `this` for the call built, `another` for any other call or signer.
- `fate(attempt)`: an attempt is (message hash, nonce). The head block is read first and the signer's nonce at that block, so both come from one node's one state. The nonce still free: `open`, or `gone` once the head's time is past a trade's deadline. The nonce taken: the block that took it is found by stepping back from the head (64 blocks, doubling) until the nonce is free, then halving, a few dozen reads; `landed` when its transaction is this call, `gone` when it is another. A node that no longer holds that height's state cannot tell, and the answer is `open`, never `gone` for a call that may have landed.
- `nonceOf`: from the signed bytes, or from the transaction the node has; null for an id it does not have.

## What the API runs Robinhood Chain on

- **The record:** `deployments/robinhood-testnet.json` for `CHAIN_NETWORK_ROBINHOOD=testnet` (TNET-2 wrote it), `deployments/robinhood-local.json` for `local`. `evmDeployment` in `apps/api/src/deployments.ts` reads it strictly, holds its `network` to the file's name, and puts its factory and registry in `contracts.robinhood` and its router in `CHAIN_ROUTER_ROBINHOOD`, which may say the same address and no other. The test network's router is also the preset's now (`chain-presets.ts`).
- **The node:** `ROBINHOOD_RPC_URL` (`https://rpc.testnet.chain.robinhood.com` serves the test network; nothing here needs an archive). `robinhoodFromEnv` checks it at start with `assertNode`: the record's chain id, never a mainnet's, code at the factory.
- **The assets:** the `robinhood` rows of `basket_assets`, held to the record (`holdToEvmRecord`: every row a token of the record with its decimals, class, session, feed, ceiling and keeper switch, the cash row the record's cash). `pnpm exec tsx scripts/robinhood/basket-assets.ts` fills them from the record, idempotently.
- **The mode:** `CHAIN_MODE_ROBINHOOD=live` or `readonly` runs `createEvmVaultAdapter` (`orders/chains.ts`), labelled `sandbox`; mainnet and Base refuse at start.
- **On `local`:** the preset, the record and the node all say 31337. The web never runs `local` (`walletChains` refuses it), so its dev self-transfer cannot sign for a copy.

## The check

`packages/chain-evm/test/fork.test.ts` forks Robinhood Chain mainnet at block 77,417,307 with anvil (chain id 31337), deploys the contracts on it as `Deploy.s.sol` does, lists the real USDG, NVDA, SPY, GLD, META, TSLA and MSFT tokens (the real NVDA feed, feeds of our own for the rest, MSFT taken off again), opens four vaults, publishes three shared portfolios, schedules a multiplier on the real NVDA token, and reads all of it back through the reader over JSON-RPC. It runs the adapter contract's `reads` group and the cases beyond it. Nothing is sent to any network.

```
cd contracts && forge build && cd ..
RH_FORK_URL=https://robinhood.drpc.org pnpm exec vitest run packages/chain-evm/test/fork.test.ts
```

The builders and the probe run the whole adapter contract, its seven groups, on a copy of Robinhood Chain's test network as TNET-1 and TNET-2 deployed it (`packages/chain-evm/test/testnet.test.ts`): anvil forks 46630 at its latest block, every vault, shared portfolio, deposit and trade of the world is built by the adapter and sent from anvil's own accounts, and on the copy only the deployer sets the keeper to an anvil account, opens the session to the whole day and shortens the publish delay to 60 s. Nothing is sent to the test network.

```
RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run packages/chain-evm/test/testnet.test.ts
```

The keeper's cases need a weekday by UTC: the copy opens the session to the whole day, not the week.

The world also deploys a token of 8 decimals of our own (the contracts' `MockToken`) and lists it, so decimals are held at 6, 8 and 18.

The chain's own RPC keeps state for a few minutes only, so the fork needs an archive endpoint; dRPC's free one refused every method for a few minutes on Oct 5 and came back.
