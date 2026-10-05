# EVM vault contracts: note for design v2

Oct 1, 2026. Covers `BasketVault`, `VaultFactory` and `IndexRegistry` on Robinhood Chain (4663) and Base (8453).

Markers: **[C n]** checked today against source n in section 7. **[R]** run or read onchain by me today. **[S]** from the spike in `spikes/evm-vault`. **[M]** from memory. **[E]** estimate.

## 1. Bottom line

- Make each vault an OpenZeppelin `BeaconProxy`. One beacon per chain holds the logic address, so one transaction fixes every vault. A minimal clone saves 40–70k gas per vault (under half a cent) and can never be fixed [R]. With unaudited code and team-held keys, the beacon wins.
- Pin OpenZeppelin Contracts 5.6.1, not 5.7.0. 5.7.0 is released on GitHub, but npm still tags it `dev` and the repo has no audit report for it [C2].
- The vault judges outcomes, not routes. Robinhood Chain swaps go through Universal Router 2.1.2 and Permit2. On Base the stock liquidity sits in an Aerodrome factory that Aerodrome's public router does not serve, so we ship our own small pool adapter [S][R].
- A fresh price does not prove the market is open: Chainlink's stock feeds have no heartbeat off-hours [C6]. Keeper trades on stock legs run only Mon–Fri 14:30–20:00 UTC, plus a staleness bound, a pause probe and a guardian halt.
- Stock Foundry still cannot run Base's stock tokens (1.8.3 has no Base network) [C1]. Test Base with mocks, a read-only simulation in CI and a $10 mainnet run. Keep deploy and config code free of token calls so `forge script` works there.

## 2. What to use for the MVP

### Versions

| Thing | Pin | Note |
|---|---|---|
| Foundry | v1.8.3 (Sep 15) [C1] | Thom's machine has a July 2025 nightly, 1.2.3 [R]. 1.8 makes isolate mode the default, so gas numbers change |
| forge-std | v1.17.0 [C3] | |
| OpenZeppelin Contracts and `-upgradeable` | 5.6.1 [C2] | Audit report dated Feb 2026 |
| solc | 0.8.30, `evm_version = "cancun"`, `via_ir`, 200 runs | Same solc as base-std, so its mocks compile with ours [C9]. Latest is 0.8.37 [C3]. Uniswap v4 needs Cancun and is live on 4663, so Cancun works there (inference) |
| base-std | `main`, tests only | Mocks in `test/lib/mocks/` [C9] |

Dependencies are git submodules in `contracts/lib`, pinned to tags.

### Where files go

```
contracts/                      Foundry root, as v1 names it
  src/BasketVault.sol  VaultFactory.sol  IndexRegistry.sol
  src/interfaces/  src/lib/  src/adapters/SlipstreamAdapter.sol
  test/unit  test/invariant  test/fork     script/Deploy.s.sol  Configure.s.sol  base-sim.sh
  deployments/4663.json  8453.json         address, tx hash, explorer link (Rodrigo's logging rule)
packages/chain-evm/src/abi/*.ts            ABIs as `as const`, generated and committed
```

Committed ABIs keep his TypeScript CI free of Foundry. Add one CI job with the toolchain pinned: `forge build --sizes`, `forge test`. Add `contracts/{lib,out,cache}` to Biome's ignore list. Mocks live only in `test/` and are named `Mock*`.

### Keys, upgrades, pause

- `admin` (team) owns the beacon, upgrades the factory and registry (both UUPS proxies) and sets config. It can replace vault logic, so it can take funds. The app must say so.
- `guardian` (a hot key next to the keeper) can `pauseKeeper()`, `haltAsset(token, until)` and `vetoVersion(id)`. It cannot unpause.
- Pause gates `keeperSwap` only. `withdraw` reads no feed and calls neither factory nor registry, so only a beacon upgrade can block it.
- ERC-7201 namespaced storage; `_disableInitializers()` in every logic constructor.

### Interfaces to freeze on day 1

```solidity
struct Weight   { address token; uint16 bps; }      // sorted by token
struct IndexRef { bytes32 indexId; uint16 bps; }    // nesting, one level
struct Swap     { address router; address tokenIn; address tokenOut;
                  uint256 amountIn; uint256 minOut; bytes data; }

interface IBasketVault {
  // owner only: no pause, no feed
  function deposit(address token, uint256 amount) external;
  function withdraw(address token, uint256 amount, address to) external;
  function withdrawAll(address to) external returns (address[] memory skipped);
  function ownerSwap(Swap[] calldata swaps) external;          // balance deltas and minOut only
  function setTargets(Weight[] calldata direct, IndexRef[] calldata refs) external;
  function acceptAssets(address[] calldata tokens) external;
  function setAutoFollow(bool on) external;
  // keeper only
  function keeperSwap(Swap calldata s) external returns (uint256 spent, uint256 received);
  // one read for the app and for agents: balances, prices, ages, value, budget left
  function snapshot() external view returns (Snapshot memory);
}
interface IVaultFactory {
  function createVault(bytes32 salt, Weight[] calldata direct, IndexRef[] calldata refs,
                       bool autoFollow) external returns (address);
  function vaultOf(address owner, bytes32 salt) external view returns (address);  // known before it exists
  function asset(address token) external view returns (AssetConfig memory);
  function routerPull(address router) external view returns (uint8);   // 0 no, 1 direct, 2 Permit2
}
interface IIndexRegistry {
  function create(bytes32 salt, Weight[] calldata c, bytes32 metaHash,
                  uint16 maxFeeBps, uint8 flags) external returns (bytes32 id);
  function publish(bytes32 id, Weight[] calldata next, bytes32 metaHash)
      external returns (uint32 version, uint64 effectiveAt);
  function cancel(bytes32 id) external;                        // creator or guardian, pending only
  function weightOf(bytes32 id, address token) external view returns (uint16);   // active version
  function previewPublish(bytes32 id, Weight[] calldata next) external view
      returns (bytes4 err, uint16 turnover, uint16 maxDelta, uint64 nextAllowedAt);
  function limits() external view returns (Limits memory);
}
event RecipePublished(bytes32 indexed id, uint32 indexed version, address indexed creator,
                      Weight[] components, uint64 effectiveAt, uint16 turnoverBps, bytes32 metaHash);
```

- `AssetConfig`: feed, token decimals, feed decimals, `maxAge`, `session` (0 always, 1 US stocks), pause probe (target and selector), `haltUntil`. Decimals are passed in, never read from the token.
- The vault stores its own targets: direct weights plus index references. A token's target is `direct + Σ ref.bps × registry.weightOf(ref.indexId, token)`. That is one level of nesting computed onchain, so the keeper cannot invent a target. A token outside the accepted set reverts `TokenNotAccepted`; the follower taps `acceptAssets`.
- Index id is `keccak256(creator, salt)` with no chain id: one index, one id on every chain.
- Every refusal is a typed error carrying the numbers, as in the spike.

### How `keeperSwap` checks a trade

1. Caller is the keeper, keeper path not paused, auto-follow on, cooldown passed.
2. Router allowlisted. Both tokens accepted, each with a feed.
3. Gate on each stock leg: inside the session window, feed younger than `maxAge`, pause probe false, not halted.
4. Read balances and prices of all accepted assets. Cash counts as $1 while its feed is within 0.5% of $1, else revert.
5. `forceApprove` exactly `amountIn` (through Permit2, expiring this block, when the router pulls that way), call, set approvals back to zero.
6. Own balance deltas: `spent ≤ amountIn`, `received ≥ minOut`, no other accepted asset fell.
7. Value: `received × priceOut ≥ spent × priceIn × (1 − tolerance)`. v1 measured the tolerance on the whole vault, which lets one small trade lose 1.25% of everything.
8. Direction: `tokenIn` was above target and ends at or above `target − 50 bps`; `tokenOut` was below and ends at or below `target + 50 bps`.
9. Weekly budget: add `loss / vaultValue` to a counter that decays over 7 days; revert past 2%. Ten lines, written by hand.

### Reading Chainlink

- Require `answer > 0` and `0 < updatedAt ≤ now`. `maxAge` is 26 hours for stocks: the feeds move on 0.5% deviation with a 24-hour heartbeat in session and none off-hours [C6][C9].
- Session window: weekday from `block.timestamp`, 14:30–20:00 UTC. That sits inside the 09:30–16:00 New York session in summer and winter time, so no daylight-saving code. For holidays and half days the guardian sets `haltUntil`.
- Pause probe: `token.oraclePaused()` on Robinhood Chain [C8]. On Base the registry `0x3f3E…5CaD` holds the flag, but its read function is not documented [C9][R]; use the guardian halt until it is known.
- Sequencer uptime feed: Base `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`, one-hour grace after a restart. Robinhood Chain has none [C5]; the config slot stays empty there.

### What the tokens require

- Both families follow ERC-8056, still a Draft [C7]: raw balances never change and `uiMultiplier()` scales the display. The vault accounts in raw units. The feeds already include the multiplier, so never apply it again [C8][C9]. Robinhood emits `TransferWithScaledUI` where the draft says `TransferWithUIAmount`; indexers should key on `uiMultiplier()`.
- Robinhood: 18 decimals; the issuer can pause, burn and upgrade. Base B20: 8 decimals, a precompile with code `0xef`; a transfer can revert on sender, receiver or executor policy, and `approve` is not gated [S].
- So `withdrawAll` wraps each transfer in try/catch and returns the tokens it skipped. One frozen token must not trap the others.

### Swaps

- Robinhood Chain: Universal Router 2.1.2 at `0x204FAca1764B154221e35c0d20aBb3c525710498` [C4]. The keeper builds calldata with the 2.1 struct, which has `minHopPriceX36` [C4], and uses hookless pools only (131 of 182 USDG/NVDA pools have hooks [S]).
- Base: the main callers of the NVDAc pool over the last 5,700 blocks are contracts I could not match to a public router [R]. Harden the spike's adapter: check `pool.factory()` against the allowlisted factory, send output to `msg.sender` only, hold nothing.
- Stock to stock is two legs through cash.

### IndexRegistry

The limits in `creator-limits.md` become constants, checked on every version after the first: listed assets, 3–12 assets, 2–50% each, 50 bps steps, 10 points per asset, 20% turnover per version, 60% per rolling week, one version per 24 hours, none while one is pending, 12-hour delay. The registry stores the current and the pending version; `weightOf` switches to the pending one at `effectiveAt` without a transaction. History lives in events.

### Tests

- Unit and fuzz with mocks at 6, 8 and 18 decimals. Adversarial router modes: output to the keeper, bad price, partial fill, re-entry, leftover approval.
- Invariants: only the owner moves tokens out; weekly loss stays under the cap; `withdrawAll` succeeds with factory, registry and feeds all reverting; no allowance survives a call; a keeper trade never moves a leg away from target. `max_time_delay` (Foundry 1.7) exercises the cooldown and the budget [C1].
- `forge test --mutate` (1.8) once on the vault, to see that the tests bite [C1].
- Robinhood: fork tests on a pinned block through dRPC's free archive, including a Saturday block that must revert `MarketClosed`.
- Base: base-std mocks etched at the real addresses, including a policy flip to an allowlist; the spike's `eth_call` simulation with state overrides, in CI; `base-forge` if it can fork mainnet (not verified); the $10 run.

### Deploy and verify

- The CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` and CreateX have code on both chains [R]. No chain-specific constructor arguments, the same salt and the same commit give the same addresses on both. Chain values go in `Configure.s.sol`.
- Verify with Sourcify on both: no key, and it supports 4663 and 8453 [C10]. Robinhood also has Blockscout at `robinhoodchain.blockscout.com` [C10]. Basescan needs a free Etherscan v2 key.

### Gas

Gas price today: 0.0204 gwei on Robinhood Chain, 0.006 gwei on Base [R]. ETH about $2,700.

| Action | Gas | Robinhood | Base |
|---|---|---|---|
| Create vault (beacon proxy, 6 assets) | 363k on a stand-in [R]; a clone is 324k | $0.02 | $0.006 |
| `keeperSwap` | 296k in the spike [S], about 400k with all checks [E] | $0.022 | $0.007 |
| 5-leg rebalance | about 2M [E] | $0.11 | $0.03 |
| Publish 12 assets | about 350k [E] | $0.02 | $0.006 |

## 3. Skip or defer

- Minimal clones: the gas saved is negligible and they cannot be upgraded.
- OpenZeppelin 5.7's `RateLimiter`: it fits the weekly budget, but 5.7 has no audit report yet.
- Safe with Zodiac, session keys, 4337: none can check value after a trade (v1 research).
- Aggregators (0x, 1inch, LiFi): coverage for a contract taker is unconfirmed and each adds an API dependency. The router allowlist admits one later.
- An onchain holiday calendar, batched keeper legs, deposit by permit, a per-vault agent slot, symbolic tests.
- A timelock on `admin`: one ownership transfer, after the event.

## 4. Seams for the roadmap

- Community and gamification: events index creator and owner; `metaHash` on each index; follower counts from `TargetsSet` events.
- Creator fees: `maxFeeBps` is committed at `create` and stored, zero for now; a beacon upgrade adds accrual.
- CCIP sync: chain-free index ids; `publish` later accepts an authorized remote publisher.
- More chains: zero constructor arguments and CREATE2; everything chain-specific is config.
- New basket types: the factory maps `kind → beacon`; the MVP has kind 0.
- Rebalance on drift: check 8 already works without a new index version.
- Paid feeds: prices go through one internal function keyed by `AssetConfig`; add a `source` field.
- Agent-run indexes: the `flags` byte at `create`.
- Pooled token: a vault owner may be a contract; no `tx.origin` checks.
- Embeds: `createVaultFor(owner, …, referrer)`; the event already carries the owner.
- Audits and governance: one `admin` address, so moving to a Safe or `TimelockController` is one call.

## 5. Risks and the test that settles each

| Risk | Test before Oct 9 |
|---|---|
| Robinhood's sequencer filters trades that start from a contract | The $10 script, already written (Thom, by Oct 3) |
| `SafeERC20` or the proxy misbehaves against a B20 precompile | Run the production vault through `base-sim.sh`, then the $10 run |
| The gate lets a trade through against a frozen feed | Fuzz timestamps across both daylight-saving switches; fork tests on a Saturday block and a Monday open |
| No sequencer feed on Robinhood Chain: a stale price just after an outage | Accepted. Direction, cooldown and budget bound it; the keeper also refuses when the last block is old |
| Vault logic exceeds the 24,576-byte limit | `forge build --sizes` in CI from the first commit; if over, move price math to a linked library |
| An upgrade breaks storage or withdrawal | Upgrade the beacon to a dummy v2 in a test: state intact, `withdrawAll` works |
| Our Base adapter is new code on the trade path | A fake pool must revert; the invariant suite runs with the adapter as router |
| Base pause flag unreadable | Read the registry's verified source on Basescan; otherwise the guardian halt stays |

## 6. Questions for a person

1. Who holds `admin`: a 2-of-2 Safe (Thom and Rodrigo) or one key? Who holds `guardian`?
2. Is it acceptable that auto-follow on stocks trades only Mon–Fri 14:30–20:00 UTC, with holidays halted by hand?
3. Sourcify and Blockscout need no account. Do we also want Basescan, which needs someone to create a free Etherscan key?
4. Thom: the two $10 runs, and local Foundry upgraded to 1.8.3.

## 7. Sources

1. Foundry releases and the networks crate at v1.8.3: https://github.com/foundry-rs/foundry/releases , https://github.com/foundry-rs/foundry/tree/v1.8.3/crates/evm/networks/src
2. OpenZeppelin releases, npm dist-tags, audits: https://github.com/OpenZeppelin/openzeppelin-contracts/releases , https://registry.npmjs.org/@openzeppelin/contracts , https://github.com/OpenZeppelin/openzeppelin-contracts/tree/v5.7.0/audits
3. https://github.com/foundry-rs/forge-std/releases , https://github.com/argotorg/solidity/releases
4. https://github.com/Uniswap/universal-router/releases , https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Router.sol
5. https://docs.chain.link/data-feeds/l2-sequencer-feeds
6. https://docs.chain.link/data-feeds/tokenized-equity-feeds and its `/robinhood` and `/coinbase` pages
7. https://eips.ethereum.org/EIPS/eip-8056
8. https://docs.robinhood.com/chain/building-with-stock-tokens/
9. https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base , https://github.com/base/base-std , https://github.com/base/base-std/blob/main/LIVE_PRECOMPILE_TESTING.md
10. https://sourcify.dev/server/chains , https://chainid.network/chains.json
11. Onchain reads today on `mainnet.base.org` (block 52,038,551) and `robinhood.drpc.org`: `eth_getCode`, `eth_gasPrice`, swap logs of pool `0x853f…7ab9`.
12. Local: `spikes/evm-vault`, `docs/vault/research/open-questions/{spike-evm-vault,creator-limits}.md`, `docs/vault/research/vaults/evm-feasibility.md`, and a scratch Foundry test comparing a clone with a beacon proxy.
