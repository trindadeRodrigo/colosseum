# packages/basket

The chain-free logic of a plan held in a vault: the author limits on a shared portfolio, flattening a plan to assets, valuing a vault, planning a rebalance, the risk roll-up and the meta hash. It imports only `@colosseum/schemas`, and every function is pure: the time, the prices and the asset list come in as arguments.

The author limits and the meta hash are specified, with test vectors, in `fixtures/creator-limits/README.md`.

## What the keeper and the API must know

**Rebalancing**

- **One keeper leg per plan, then plan again.** Send the first trade of `planRebalance`, wait for it to land, read the vault, plan again, and stop when the plan is empty. A plan is exact for the state it was made from. Once a leg has landed at any cost, the rest of that plan is sized for a vault that no longer exists.
- **Use `bandBps: 0` when planning a deposit.** With the keeper's band, cash worth less than the band (under 0.5% of the vault at 50 bps) is inside it and nothing is planned.
- **The planner ignores `lastKeeperAt`.** The cooldown, the session window and whether a vault is eligible are the keeper's to check before it sends a leg.
- **An owner sending sales and purchases together passes `costBps`**: the most a trade may lose, which is the slippage the order allows. The purchases are then sized for that: the batch has its cash and no purchase ends past its target, as long as no trade loses more. Cut the plan with `batchTrades(plan, capabilities.maxTradesPerTx)`.
- **`view` and `planRebalance` take the chain's asset list** as their last argument, for each token's decimals. A vault whose cash token is not on that list is refused.
- **Cash is one dollar**, whatever a feed says, and weights are shares of everything the vault holds, cash included. That is how the vault checks a leg (design section 5).
- **An asset with no price is left out, not guessed.** `rebalancePlan` returns the trades with `unpriced` (the assets left out) and `weighed`. When an unpriced asset is both held and a target, `weighed` is false and there are no trades: the vault's value is unknown.
- **Bad input throws `RebalanceError`** with a code (`BadPolicy`, `BadTargets`, `BadInput`, `AssetNotPriced`). `view` throws `BasketInputError`.

**The roll-up**

- **`rollUp` needs `now`** (an ISO time) in its context, to tell a fresh stored quote from a stale one. It throws without it.
- A quote older than three hours is flagged `exit_quote_stale`; one for less than half or more than double the line's size is flagged `exit_quote_far_from_size`. Both are still shown.
- Each exit number is null until a line that would have to be sold has one. Null means not measured; show it as that, never as zero.
- A number from a source that is not live carries a flag naming which number: `quoted_provenance:mock`, `measured_provenance:fixture`.

**Flattening**

- `flatten` throws `OverCeiling` when dropping small lines pushes a kept line over its ceiling on the shelf. `flattenReport` returns the same targets with what was dropped and what was pushed over, and does not throw for it.
- The shelf holds one shared portfolio per slug and one recipe per chain for each: the version in effect.

**Publishing**

- `checkCreatorLimits` needs `publishDelay` in its context and throws without it. The platform list it is given marks the chain's cash token with `cls: 'cash'`.
- A refusal's `code` is the rule broken (`TurnoverTooHigh`, `VersionTooSoon`, ...). On a chain every one of them is `CreatorLimit`.
- `metaHash` covers `familyId`, `slug`, `name`, `copy` and `kind`. Publishing on one more chain does not change it.
