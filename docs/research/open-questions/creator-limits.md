# Creator limits for community indexes

Oct 1, 2026. Closes open item 3 in `basket-app-brief.md`. Contract numbers below were read from source on GitHub today unless marked [S] (search snippet or secondary source) or [U] (unverified). Nothing was run.

## 1. Recommended limits

Applied by the registry when a creator publishes version N+1 of a community recipe. Version 1 is exempt from the change caps. Constants, not per-index settings.

| Limit | Value | Why this number |
|---|---|---|
| Per-asset weight change per version | 1,000 bps (10 points), up or down, including adds and removals | Bounds the flow into any one pool to 10% of auto-follow money. A 25% position takes three versions to remove |
| Turnover per version, `sum(abs(delta)) / 2` | 2,000 bps | Worst-case follower cost is 2 legs x turnover x tolerance = 0.5% of the vault on EVM (1.25%), 0.3% on Solana (0.75%) |
| Turnover per rolling 7 days | 6,000 bps, linear decay | 60% x 2 legs x 1.25% = 1.5%, inside the vault's 2% weekly loss budget, so creator updates alone can never exhaust it. A full rewrite of an index takes more than a week; Balancer v1's default minimum for one weight change is about two |
| Versions | 1 per rolling 24h per index; none while one is pending | Already decided. Keep `minInterval >= delay` as an invariant (Balancer v1 requires the same of its two timelocks) |
| Minimum weight | 200 bps per asset | A personal basket holding this index at 25% still gets a 0.5% position, which is the flatten floor. Balancer v1's floor is also 2% |
| Maximum weight | 5,000 bps per asset | Product choice, not a security bound. Rodrigo may want 2,500 for single stocks (DPI used 25%) |
| Asset count | 3 to 12 | Leaves room under the 15-position flatten cap; one swap leg per transaction on Solana; dHEDGE's default is also 12 |
| Weight step | multiples of 50 bps | Readable diffs, no dust versions |
| Effective delay | 12h, computed by the contract, checked by the vault | Keep the decision. Stock legs then wait for US market hours, so the real delay is longer. 24h would cost nothing given one version a day; not reopening it |
| New asset | Platform list only, and each follower taps once | Already decided |
| Auto-follow capacity per index per chain | $250k on Solana; $50k on Base and Robinhood Chain until their liquidity is measured | At $250k a maximum-size version moves $25k per asset. GLDx, the thinnest measured token, costs about 11 bps at $10k and 32 bps at $50k (`solana-liquidity.md`) |
| Keeper flow per asset per hour | size where a live quote costs 25 bps or less: about $150k SPYx, $75k QQQx, $35k GLDx | Interpolated from the same measurements. Vaults past the limit sync in the next hour instead of being refused |

Two additions that cost little:

- A guardian veto on a pending version. A delay only protects followers who are watching; Enzyme describes its own loss cap as buying time to alert and exit, not as prevention. The guardian already pauses the keeper path; let it also cancel one version before `effectiveAt`. The creator can cancel too, without getting the daily slot back.
- "A different index is a new index." The caps always apply after version 1. Following is consent to this recipe changing slowly, not to an arbitrary one.

Where each limit lives:

- Registry (onchain, on publish): change caps, turnover budget, interval, weight bounds, asset count, step, delay, platform list.
- Vault (onchain, keeper path): `block.timestamp >= effectiveAt`, accepted assets only, price check, loss budget. Unchanged.
- Keeper and app (off-chain): capacity and hourly flow. Separate vaults share no counter, and the brief removed the per-vault deposit cap, so capacity cannot be enforced onchain cheaply. The onchain backstop is the price check: an over-capacity trade waits.

Fees are out of the MVP. When they arrive: a maximum committed at creation that can never be raised (Set), increases announced two weeks ahead and capped per step (dHEDGE), and a platform ceiling (Reserve).

## 2. What each limit stops

| Abuse | Limits that stop it | What is left |
|---|---|---|
| Creator adds or upweights a thin token they hold; follower vaults become exit liquidity | Platform list, follower tap on new assets, 10-point cap, capacity, price check | Up to the tolerance per trade on a listed asset |
| Bait and switch: build a following on an S&P index, then rotate it into something else | 10-point and 20% caps, 60% a week, 12h delay, guardian veto | A slow rotation over a week or more, visible at every step |
| Churn: flip weights back and forth so followers pay tolerance each time | One version a day, weekly turnover budget, vault loss budget | At most 1.5% a week at worst-case fills on EVM |
| Creator trades ahead of their own update | Small flow per version (caps x capacity), price check makes vaults wait, random vault order | Reduced, not removed. The delay gives everyone the same notice, including other front-runners |
| Dust and gas griefing: 50 assets at 0.1% | 2% floor, 12 assets, 50 bps step | None |
| A compromised or prompt-injected creator key, human or agent | All of the above; the worst case equals a hostile creator | Same bounds |

## 3. Balancer

Balancer limits the speed of a weight change, never its size, because arbitrage reprices an AMM continuously and slow change means small loss per block. Our keeper trades in discrete steps, so the equivalent is size per version times versions per period.

| | v1 Configurable Rights Pool | v2 Weighted | v2 Managed Pool | v2 LBP | v3 Weighted | v3 LBP |
|---|---|---|---|---|---|---|
| Weights change | Gradual, minimum 90,000 blocks by default (about two weeks at 13s) | Never | Gradual; the pool sets no minimum | Gradual; no minimum; owner can reschedule at any time | Never (immutable) | Schedule fixed at deploy (immutable) |
| Minimum weight | 2% (1 of 50) | 1% | 1% | 1% | 1% | 1% |
| Tokens | 2 to 8 | 2 to 8 [U, factory not read; math allows 100] | 2 to 50 | 2 to 4 | 2 to 8 | exactly 2 |
| Add or remove token | Commit, wait 500 blocks by default (about two hours), apply. Not during a gradual update | No | Not during or before a scheduled weight change; a removed token must have zero balance; the others rescale | No | No | No |
| Swap fee | 0.0001% to 10% | 0.0001% to 10% | 0.0001% to 95% | 0.0001% to 10% | 0.001% to 10% | same |
| Manager fee | none | none | AUM fee up to 95% | none | Pool creator fee up to 99.999% (of the fee left after the protocol's share [U]) | same |

Other points from the source:

- v1 rights (`canChangeWeights`, `canAddRemoveTokens`, `canChangeSwapFee`, `canPauseSwapping`, `canWhitelistLPs`, `canChangeCap`) are fixed at creation, and `createPool` requires the weight-change period to be at least the add-token timelock. A supply cap is the capacity limit.
- The v2 Managed Pool trusts its owner completely. The limits were meant to live in a separate `ManagedPoolController`: an immutable rights bitmap plus an immutable `minWeightChangeDuration`, reverting with `WEIGHT_CHANGE_TOO_FAST`. No default value. Balancer deleted the controller from the repo in Dec 2022 as "unused" (commit 04a4da8).
- Managed Pools have per-token circuit breakers (bounds on pool-share price per token) and an LP allowlist that cannot block exits.
- `GradualValueChange` is 80 lines of linear interpolation. If the start time is in the past it fast-forwards to now, so a value cannot jump.
- v2 LBP: nothing stops the owner rescheduling weights or toggling swaps mid-sale. v3 removed that: weights and times are immutable, the start must be at least one hour away, liquidity goes in only before the start and out only after the end, and selling the project token back can be blocked. Every swap is capped at 30% of the pool's balance in v2 and v3.
- QuantAMM, a Balancer v3 pool type with automated weights, has exactly three knobs per pool: `epsilonMax` (maximum weight change per update), `absoluteWeightGuardRail` (minimum weight) and `updateInterval`, plus `maxTradeSizeRatio`. Factory bounds on them were not read [U].

The direction across versions is less manager discretion and more committed at creation.

Sources: [v2 WeightedMath](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-weighted/contracts/WeightedMath.sol), [ManagedPoolSettings](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-weighted/contracts/managed/ManagedPoolSettings.sol), [ManagedPoolAddRemoveTokenLib](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-weighted/contracts/managed/ManagedPoolAddRemoveTokenLib.sol), [ManagedPoolController before removal](https://github.com/balancer/balancer-v2-monorepo/blob/d67a0e6eed3cc9d2795923ccfdf580680ec95185/pkg/pool-utils/contracts/controllers/ManagedPoolController.sol), [v2 GradualValueChange](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-weighted/contracts/lib/GradualValueChange.sol), [v2 LBP settings](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-weighted/contracts/lbp/LiquidityBootstrappingPoolSettings.sol), [v3 WeightedPool](https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/pool-weighted/contracts/WeightedPool.sol), [v3 LBPool](https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/pool-weighted/contracts/lbp/LBPool.sol), [v3 LBPValidation](https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/pool-weighted/contracts/lbp/LBPValidation.sol), [v3 ProtocolFeeController](https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/vault/contracts/ProtocolFeeController.sol), [v1 ConfigurableRightsPool](https://github.com/balancer/configurable-rights-pool/blob/master/contracts/ConfigurableRightsPool.sol), [v1 constants](https://github.com/balancer/configurable-rights-pool/blob/master/libraries/BalancerConstants.sol), [managed pool docs](https://docs-v2.balancer.fi/concepts/pools/managed.html), [QuantAMM pool](https://github.com/QuantAMMProtocol/QuantAMM-V1/blob/main/pkg/pool-quantamm/contracts/QuantAMMWeightedPool.sol).

## 4. The others

| Product | Delay on changes | Size or rate limit | Asset limits | Capacity | Abuse it targets |
|---|---|---|---|---|---|
| Set v2 `GeneralIndexModule` | None in the module | Per-asset `maxSize` per trade and `coolOffPeriod` between trades; a trade cannot pass the target unit | Manager-set targets; `DelegatedManager` adds an owner asset allowlist operators must stay inside | Supply cap via issuance hook [U] | Slippage from large rebalances; a rogue trader |
| Index Coop manager | Operator and methodologist must both sign (`mutualUpgrade`); a timelock that can only be lengthened; protected modules | DPI: monthly, determination in week three and reconstitution on the first business day [S]; 5% per token per rebalance after slippage problems [S, from `vaults/pooled-precedents.md`] | DPI 25% cap per token [S] | none found | Unilateral changes by one party |
| Set `StreamingFeeModule` | | Fee can never exceed the maximum committed at creation | | | Fee creep |
| Reserve Index DTF (Folio) | 48h governance timelock by default; guardian veto | Rebalance manager publishes low, spot and high weights; the launcher acts only inside them; price range at most 100x; rebalance TTL at most 4 weeks; auction 2 minutes to 1 week | Governance adds and removes; pausable, blocklist and fee-on-transfer tokens unsupported | none | A malicious launcher can push the portfolio to the edge of the governance-approved range and no further (README). TVL fee max 10% a year, mint fee max 5% |
| Enzyme | None on trades | `CumulativeSlippageTolerancePolicy`: loss budget over 7 days, linear refill, cannot be disabled or changed | `AllowedAdapterIncomingAssetsPolicy` and `AllowedAdaptersPolicy`, also permanent | `MinMaxInvestmentPolicy` per deposit | A manager draining a fund through bad trades; the stated aim is to slow it, not prevent it |
| dHEDGE | Fee increases: announced, 2 weeks, at most +10 points per step. None on trades | `SlippageAccumulator` with decay | Factory-validated assets; 12 per vault; a non-empty asset cannot be removed | none found | Fee ambush; hiding or stranding value. Fee ceilings 50% performance, 3% management, 2% entry, 2% exit (initializer values, DAO-settable) |
| Glider | None: a new strategy version is active at once and every enrolled portfolio retargets at its next rebalance | None documented. Per-strategy `slippageBps`, `priceImpactBps`, `thresholdUsd` | 1 to 50 assets, weights to two decimals | none documented | Relies on the provider and distributor relationship: the docs only advise coordinating with distributors before a material change |
| eToro CopyTrader | None, trades copy at once | Copy stop-loss required (US guide: default closes at a 95% loss) | Regulated instruments only | $200 minimum; legs under $1 are skipped; a user may stop being copyable past a threshold of copiers or assets (not quantified). $2M per copied trader and 100 traders per copier [S] | Risky traders are blocked from new copiers at a daily risk score of 8, for 30 days [S, secondary] |

No product reviewed limits how much a recipe can change per update the way section 1 does; they limit trade size and frequency (Set), speed (Balancer), loss (Enzyme, dHEDGE) or leave it to governance (Reserve). Glider, the closest product to ours, has no creator limits at all.

Sources: [GeneralIndexModule](https://github.com/SetProtocol/set-protocol-v2/blob/master/contracts/protocol/modules/v1/GeneralIndexModule.sol), [StreamingFeeModule](https://github.com/SetProtocol/set-protocol-v2/blob/master/contracts/protocol/modules/v1/StreamingFeeModule.sol), [DelegatedManager](https://github.com/SetProtocol/set-v2-strategies/blob/master/contracts/manager/DelegatedManager.sol), [BaseManagerV2](https://github.com/IndexCoop/index-coop-smart-contracts/blob/master/contracts/manager/BaseManagerV2.sol), [TimeLockUpgrade](https://github.com/IndexCoop/index-coop-smart-contracts/blob/master/contracts/lib/TimeLockUpgrade.sol), [DPI methodology](https://www.indexcoop.com/blog/defi-pulse-index-methodology), [Reserve constants](https://github.com/reserve-protocol/reserve-index-dtf/blob/main/contracts/utils/Constants.sol), [Reserve README](https://github.com/reserve-protocol/reserve-index-dtf/blob/main/README.md), [Reserve roles](https://docs.reserve.org/core-components/index-dtfs/roles), [Enzyme policies](https://specs.enzyme.finance/topics/policies), [dHEDGE PoolFactory](https://github.com/dhedge/V2-Public/blob/master/contracts/PoolFactory.sol), [PoolManagerLogic](https://github.com/dhedge/V2-Public/blob/master/contracts/PoolManagerLogic.sol), [SlippageAccumulator](https://github.com/dhedge/V2-Public/blob/master/contracts/utils/SlippageAccumulator.sol), [Glider strategy providers](https://docs.glider.fi/guides/strategy-providers), [eToro US CopyTrader guide](https://www.etoro.com/wp-content/uploads/2025/10/CopyTrader-Guide_Jan-2026.pdf), [eToro limits](https://help.etoro.com/en-us/s/article/What-are-the-investment-limits-for-CopyTrader-us).

## 5. Reuse

Reuse nothing beyond OpenZeppelin. The checks are about 60 lines in `IndexRegistry`.

| Candidate | License | Verdict |
|---|---|---|
| OpenZeppelin Contracts | MIT | Already the base. `TimelockController` in front of the upgrade keys would make "the team holds the keys" a delay users can see |
| Balancer `GradualValueChange`, `WeightedMath`, `ManagedPool*` | GPL-3.0 (v2 and v3; files say GPL-3.0-or-later) | No. Copying would make the vault GPL, v2 is Solidity 0.7, and the pool code is bound to the Balancer Vault. Interpolating targets over time would also turn one rebalance into many keeper trades, one leg per transaction on Solana. Capped discrete versions get the same effect |
| QuantAMM | GPL-3.0 | Pattern only: its three knobs are our three limits |
| Reserve Folio | MIT, Solidity 0.8.28 | License fits, shape does not: a pooled share token with Dutch auctions. Worth taking later: recipes that publish a weight range |
| Set / Index Coop modules | Apache-2.0 | Solidity 0.6, bound to SetToken. Pattern only |
| dHEDGE `SlippageAccumulator` | File header says MIT, repo license is AGPL-3.0 | Do not copy while that conflicts. The decaying budget is a few lines; write it |
| Enzyme policies | GPL-3.0 [U, GitHub reports no clear license] | Pattern only |

The registry check, as a sketch for stream C (Solana mirrors it):

```solidity
// components sorted by asset address; weights in bps
function publish(bytes32 id, Component[] calldata next) external onlyCreator(id) {
    Index storage ix = indexes[id];
    if (block.timestamp < ix.lastPublishedAt + MIN_INTERVAL) revert PublishTooSoon(ix.lastPublishedAt + MIN_INTERVAL);
    _checkShape(next);                       // 3..12 assets, listed, 200..5000 bps, 50 bps step, sum 10_000
    if (ix.version > 0) {
        (uint256 turnover, uint256 maxDelta, address worst) = _diff(ix.components, next);   // merge two sorted lists
        if (maxDelta > MAX_ASSET_DELTA) revert WeightChangeTooLarge(worst, maxDelta, MAX_ASSET_DELTA);
        if (turnover > MAX_TURNOVER) revert TurnoverTooLarge(turnover, MAX_TURNOVER);
        uint256 decayed = ix.turnoverUsed * (block.timestamp - ix.lastPublishedAt) / 7 days;
        ix.turnoverUsed = (ix.turnoverUsed > decayed ? ix.turnoverUsed - decayed : 0) + turnover;
        if (ix.turnoverUsed > WEEKLY_TURNOVER) revert WeeklyTurnoverExceeded(ix.turnoverUsed, WEEKLY_TURNOVER);
    }
    // store, then emit RecipePublished(id, version, hash, block.timestamp + DELAY, turnover)
}
```

If the weekly budget is one thing too many, drop it: with 20% a version and one version a day the vault's loss budget still stops the keeper, and auto-follow just stalls until it refills.

## 6. For agents

Creators and followers will include agents, and these limits are what make an agent-run index safe to follow: a hijacked creator agent can do no more than section 1 allows.

- `limits()` view on the registry and the same object from the API, so an agent reads the numbers and does not hard-code them.
- `previewPublish(id, components)` returning ok or a reason code, turnover, largest delta and `nextAllowedAt`, so an agent can check before paying for a transaction.
- Typed errors that carry the offending value and the limit, as in the sketch. The API returns the same codes.
- `RecipePublished` carries turnover and `effectiveAt`, so a follower agent can decide to stay or leave without diffing versions.

## 7. Not done

- Base and Robinhood Chain capacity numbers need the liquidity test from the brief.
- NVDAx and TSLAx were not quoted on Solana.
- eToro's tier and risk-score rules come from secondary pages. Glider's onchain enforcement is unpublished.
- Whether a creator limit changes the legal reading of auto-follow: ESMA says limits do not (`vaults/decision-memo.md`). These are safety limits only.
