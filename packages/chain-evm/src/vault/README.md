# The EVM adapter for vaults

`import { createEvmVaultReader } from '@colosseum/chain-evm/vault'` for the read side (ADE-1): every `ChainReader` call of DESIGN-VAULT 3.2, plus `getPlatform` and `getAssetSettings`. The builders, quotes and the probe are ADE-2. The root entry does not re-export it, and nothing here holds a key.

One codebase for every EVM chain. The reader takes a `ChainConfig` (its network, and the factory and the registry under `contracts`), a viem public client the caller makes (`createEvmRpc(url)`), and the asset list. It reads no environment and no file. The cash token, the keeper, the pause, the keeper's limits and each asset's feed come from the factory, so what it reports is what the contracts enforce.

| File | What it holds |
|---|---|
| `reader.ts` | `createEvmVaultReader`: vaults, prices, holdings, funding, `track`, the platform's settings, each asset's settings |
| `deployment.ts` | The record an EVM deploy commits (`deployments/<chain>-<network>.json`), the assets it lists, and `assertNode` |
| `generated/abi.ts` | The four ABIs of `idl/evm`, typed. `pnpm --filter @colosseum/chain-evm abi` writes them again (`scripts/evm/abi-types.ts`); a test fails while they differ |
| `errors.ts` | A revert as the code every adapter reports (`CONTRACT_ERROR_CODE`), with the contract's name and numbers in the message |
| `market.ts` | The session rule of the keeper's path: Monday to Friday, `sessionOpen` to before `sessionClose`, no closed day, not before `closedUntil` |
| `unlisted.ts` | The id of a token the app does not list: `<chain>:token-` and its 20 bytes in hex |
| `rpc.ts` | `createEvmRpc`, and the line between a node that did not answer (`Unavailable`) and a call that reverted |

## How it reads

- One moment per read: the latest block is asked first and every call of the read names it. Calls made together go as one JSON-RPC batch.
- `stateOverride` is handed to every `eth_call`. It is the room left for Base, whose stock tokens a plain fork cannot run: the code and storage a read needs are put in place for the call only. Nothing on Robinhood Chain uses it.
- A vault is one `snapshot()`: its targets in the vault's order (by token address), then the cash token with the share the targets leave. Every token the app lists that the vault holds with no target on it is read too (`balanceOf`) and shown at a target of zero. A token it does not list is not seen unless it is a target.
- `getVault` answers only for a vault the factory lists (`isVault`): an address that merely runs the same code is `null`.
- `getVaults(owner)` is `vaultsOf(owner)`, sorted by plan id. `listAutoFollowVaults` walks `vaultAt(0..vaultCount)` and asks each `following()`: there is no indexer yet.
- A plan id above 64 bits, a snapshot that does not end with the factory's cash token, and a target on the cash token are refused with `Unknown`: the app never makes them. The contracts let a vault follow a version that names today's cash token (README of `contracts/`, known limits); such a vault cannot be read here until that case is decided.
- `pending` is the version in effect when the vault took an earlier one, else the version that waits, with `newAssets` the ones the vault has no target above zero on. The registry answers the version in effect by the block's clock, as the vault does.
- `lossUsedBps` is the snapshot's own figure, held to 10,000.

## Tokens and multipliers

- A holding's `multiplier` is what the token answers to `uiMultiplier()` (18 decimals, ERC-8056): Robinhood's stock tokens turn it to `newUIMultiplier()` at `effectiveAt()` by themselves. `scheduled` is set while `effectiveAt()` is ahead of the block and the next multiplier differs. A token with no `uiMultiplier()` (the dollar token) is '1'.
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

`deployments/<chain>-<network>.json` (`robinhood-testnet`, `robinhood-local`) is what the API will read for a real EVM chain, as it reads `deployments/solana-devnet.json`: the six contracts, the roles, the routers with how each pulls, the cash token and the assets with their feeds, average feeds, ages, sessions, ceilings, keeper switches and ranges, and the retired tokens. Strict: a field it does not have is refused. Token contracts are under `address`, not `token`. `deploymentAssets(record)` makes the app's list from it, tier C and labelled `sandbox`.

`assertNode(rpc, record)` at start: the node's chain id is the record's and never a mainnet's (4663, 8453), and the factory has code. A local copy of mainnet runs with another chain id (`anvil --chain-id 31337`): a signature made for 4663 is good on mainnet.

## The check

`packages/chain-evm/test/fork.test.ts` forks Robinhood Chain mainnet at block 77,417,307 with anvil (chain id 31337), deploys the contracts on it as `Deploy.s.sol` does, lists the real USDG, NVDA, SPY, GLD, META, TSLA and MSFT tokens (the real NVDA feed, feeds of our own for the rest, MSFT taken off again), opens four vaults, publishes three shared portfolios, schedules a multiplier on the real NVDA token, and reads all of it back through the reader over JSON-RPC. It runs the adapter contract's `reads` group and the cases beyond it. Nothing is sent to any network.

```
cd contracts && forge build && cd ..
RH_FORK_URL=https://robinhood.drpc.org pnpm exec vitest run packages/chain-evm/test
```

The chain's own RPC keeps state for a few minutes only, so the fork needs an archive endpoint; dRPC's free one refused every method for a few minutes on Oct 5 and came back.
