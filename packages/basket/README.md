# packages/basket

The chain-free logic of a plan held in a vault: the author limits on a shared portfolio, flattening a plan to assets, valuing a vault, planning a rebalance, the risk roll-up, the status of a plan and the meta hash. It imports only `@colosseum/schemas`, and every function is pure: the time, the prices and the asset list come in as arguments.

The author limits and the meta hash are specified, with test vectors, in `fixtures/creator-limits/README.md`.

## What the keeper and the API must know

**Rebalancing**

- **One keeper leg per plan, then plan again.** Send the first trade of `planRebalance`, wait for it to land, read the vault, plan again, and stop when the plan is empty. A plan is exact for the state it was made from. Once a leg has landed at any cost, the rest of that plan is sized for a vault that no longer exists.
- **Use `bandBps: 0` when planning a deposit.** With the keeper's band, cash worth less than the band (under 0.5% of the vault at 50 bps) is inside it and nothing is planned.
- **The planner ignores `lastKeeperAt`.** The cooldown, the session window and whether a vault is eligible are the keeper's to check before it sends a leg.
- **An owner sending sales and purchases together passes `costBps`**: the most a trade may lose, which is the slippage the order allows. The purchases are then sized for that: the batch has its cash and no purchase ends past its target, as long as no trade loses more. Cut the plan with `batchTrades(plan, capabilities.maxTradesPerTx)`.
- **`view` and `planRebalance` take the chain's asset list** as their last argument (`AssetUnits[]`; a `BasketAsset[]` fits), for each token's decimals. A vault whose cash token is not on that list is refused. The policy is the shared `RebalancePolicy`, and `rebalancePlan` returns a `RebalancePlan`.
- **Cash is one dollar**, whatever a feed says, and weights are shares of everything the vault holds, cash included. That is how the vault checks a leg (design section 5).
- **An asset with no price is left out, not guessed.** `rebalancePlan` returns the trades with `unpriced` (the assets left out) and `weighed`. When an unpriced asset is both held and a target, `weighed` is false and there are no trades: the vault's value is unknown.
- **Bad input throws `RebalanceError`** with a code (`BadPolicy`, `BadTargets`, `BadInput`, `AssetNotPriced`). `view` throws `BasketInputError`.

**The roll-up**

- **`rollUp` needs `now`** (an ISO time) in its context, the shared `RollUpContext`, to tell a fresh stored quote from a stale one. It throws on a time it cannot read.
- A quote older than three hours is flagged `exit_quote_stale`; one for less than half or more than double the line's size is flagged `exit_quote_far_from_size`. Both are still shown.
- Each exit number is null until a line that would have to be sold has one. Null means not measured; show it as that, never as zero.
- A number from a source that is not live carries a flag naming which number: `quoted_provenance:mock`, `measured_provenance:fixture`.

**The status of a plan**

- **`statusOf` is the rule `ON-TRACK-V1`** (`docs/GATES.md`): "On track", "Watch" or "Off track" from the newest snapshot of a plan's vault, with the line of the rule that gave it. The gate's row has the lines in order. It answers the shared `TrackStatus`: the status (null where the rule gives none yet), the rule's name, the line, the figures the line names and one English sentence.
- **The clock comes in as an argument**: `now` and `chainAnsweredAt` are ISO instants with their zone. A time with none is refused (`BadTime`): it would be read in the machine's own zone.
- **It reads a snapshot as it was kept**: drift in whole basis points, as `view` rounds it. `rebalancePlan` tests the band on exact values, so a position past the band by under one basis point can read here as inside while the keeper trades it. What this rule calls outside the planner calls outside too.
- **A verdict handed in wins** (`TrackVerdict`, the seam for the engine's verdict), and the answer names its rule. Hand in none for a figure that was worked out when the plan was built: it is not a verdict on the vault today.

**Flattening**

- `flatten` throws `OverCeiling` when dropping small lines pushes a kept line over its ceiling on the shelf. `flattenReport` returns the same targets with what was dropped and what was pushed over, and does not throw for it.
- The shelf holds one shared portfolio per slug and one recipe per chain for each: the version in effect.

**Publishing**

- `checkCreatorLimits` takes the shared `LimitContext`, `publishDelay` included, and throws on a delay or a time that is not a whole number of seconds. The platform list it is given marks the chain's cash token with `cls: 'cash'`; a `BasketAsset[]` fits.
- A refusal's `code` is the rule broken, one of the fourteen in `CreatorLimitReason` (`TurnoverTooHigh`, `VersionTooSoon`, ...); `creatorLimitReasonId` gives its number, 1 to 14. On a chain every one of them is `CreatorLimit`.
- A version refused only for being too soon carries `allowedAt` (unix seconds): published then, with nothing else changed, it is accepted. A version that is too soon and also breaks a later rule carries none, and neither does one refused while another is pending.
- `metaHash` covers `familyId`, `slug`, `name`, `copy` and `kind`. Publishing on one more chain does not change it.
