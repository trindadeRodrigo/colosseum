# SECURITY: the EVM vault contracts

What the contracts in `contracts/` let each key do, what a person whose vault it is can always do, and what has not been checked by anyone outside the team. Written for the first, small, owner-signed deployment on Robinhood Chain mainnet (4663), which was made on 2026-10-12. The Solana program has its own section in `DESIGN-VAULT.md` 13; its matrix is not in this file yet (see "Open").

Nothing here is audited. The contracts are deployed on Robinhood Chain mainnet since 2026-10-12 ([`MAINNET-DEPLOY.md`](MAINNET-DEPLOY.md): every address and transaction; the record is `deployments/robinhood-mainnet.json`), and the hosted app has served that chain since 2026-10-13. No deposit has been made there: no vault exists and no trade has run. They are deployed on no other mainnet.

## Who can do what

On a mainnet the admin of the factory and the owner of the beacon are one contract, OpenZeppelin's `TimelockController` (5.6.1, unchanged), created by `contracts/script/Deploy.s.sol`. A Safe is its only proposer, canceller and executor. The timelock administers its own roles, so changing who proposes also waits out the delay.

| Who | Can | Cannot | How fast |
|---|---|---|---|
| Vault owner | Deposit cash (no cap is set; the Safe can set one); swap listed assets through a listed router; set targets; follow a portfolio; switch auto-follow; withdraw any token to themselves | Change the owner; name another recipient | At once |
| Safe, through the timelock | Everything the admin can: replace the vault code (beacon), the factory, the registry; list or change an asset, its feeds, range and decimals; routers; the cash token; the keeper; the guardian; the keeper's limits; deposit caps and who may create a vault, both off unless it sets them; lift a pause or a halt; `launch()`; change the timelock's own delay and roles | Call into a vault; skip or shorten the delay; act without the operation being readable on chain first | 48 hours after it is scheduled, never sooner |
| Safe, directly | Cancel an operation it scheduled | Any admin call (`NotAdmin`) | At once |
| Guardian | `pauseKeeper`, `pauseDeposits`, `haltAsset` (later only), `extendClosedUntil` (later only), `addClosedDay`, cancel a waiting portfolio version | Lift any of them; change a setting; upgrade; touch the timelock; move a token; stop a withdrawal or an owner's swap | At once |
| Keeper (none at the first deployment) | `keeperSwap` on auto-follow vaults, inside the checks of `DESIGN-VAULT.md` 5 | Withdraw; trade a vault whose owner has auto-follow off | At once, when set |
| Deployer | Nothing, once the deploy script ends: it removes its own timelock roles in the hand-over batch and reads that back | | |
| Anyone | Create a vault for themselves; `syncDeposits`; `adoptVersion` on an auto-follow vault; read a queued operation | Anything on another person's vault | |

Why 48 hours: it is the notice a follower already gets before a new version of a shared portfolio takes effect, so one number answers "how long before anything about my vault can change". The script refuses a mainnet delay under it.

**The delay has no floor in the timelock itself.** `TimelockController` is used unmodified, and its `updateDelay` takes any value. The Safe can schedule `updateDelay(0)`; 48 hours later every admin call is instant. The same holds for the roles and for the admin itself: after one delay the Safe can hand either to anything. None of this can be prevented without changing OpenZeppelin's contract, which this deployment does not do. What stands in its place is that each is an operation readable on chain for 48 hours first: `authority-check` fails on a mainnet when the live delay is under 48 hours and when an `updateDelay` to less is waiting, and warns on any waiting `updateDelay`, `grantRole` or `revokeRole`. So it runs daily, and a red run is a reason to withdraw.

**"A Safe" is checked, as far as a contract can say it of itself.** The script and `authority-check` refuse an owner with no code, a key with delegated code (EIP-7702, 23 bytes starting `0xef0100`), anything that does not answer `getThreshold()` and `getOwners()`, a threshold under `safeMinThreshold` (2 at least on a mainnet), fewer than two owners, or a threshold above the owner count. Both print the owners and the threshold. That the contract is a real Safe and that those owners are the people meant is a person's comparison; a contract written to answer like one would pass. The person who compares the owners also confirms the Safe has no module enabled: a module can move a Safe without its signers. The deploy script and `authority-check` both ask the Safe for its modules both ways (`getModulesPaginated` and `getModules()`) and refuse one on a mainnet that lists a module under either, that answers neither, or whose empty page names a next module. A Safe's guard can block its transactions but cannot make one: the deploy script does not read it, and `authority-check` reads the guard slot, prints it, and warns on a mainnet when one is set. That is a warning, not a failure.

Tests: `contracts/test/Timelock.t.sol` (every guarded call refused when made directly, refused a second before the delay ends, accepted after it; the guardian can only stop), `contracts/test/DeployMainnet.t.sol` (where the keys are when the script ends).

## What an owner can always do

- **Withdraw in kind.** `withdraw(token, amount)` and `withdrawAll()` read no feed and call neither the factory, the registry nor the timelock. No pause, halt, cap, closed market or queued change stops them. Only a change of the vault's code can, and that waits 48 hours where anyone can read it. Tests: `test_pause_neverBlocksAnOwnersWithdrawalInKind`, `test_I4_withdraw_makesNoCallToTheConfig`, `test_I4_withdraw_worksWhateverTheConfigDoes`, `test_caps_neverReachAWithdrawal`, and on a fork with the real USDG and NVDA `test_fork_realDollars_areCappedOnTheWayIn_andNeverOnTheWayOut`.
- **Sell to cash and withdraw the cash**, while the router is listed. The deposit pause does not stop a swap.
- **Switch auto-follow off**, which ends the keeper's reach into that vault in the same transaction.
- **See a change coming.** Every admin act is a `CallScheduled` event on the timelock 48 hours before it can run. `pnpm ops:authority-check` prints what is waiting.

What an owner cannot do: recover a vault whose key is lost (the owner is fixed for the vault's life), or take out a token its issuer has frozen.

## What the team's keys can still do to a vault

Stated as it is, because the app's trust notice must say the same.

- **The Safe can take everything, after 48 hours.** An upgrade of the beacon replaces every vault's code. `test_H1_aHostileUpgradeWaits_andTheOwnerLeavesFirst` shows the wait and the exit.
- **The Safe can drain an auto-follow vault through settings alone, after 48 hours**: name a keeper, list a router, point the targets at feeds it controls. `test_H2_settingsAloneDrainAnAutoFollowVault_butOnlyAfterTheDelay` does it for 70% of a vault in two trades with the loss counter reading zero; `test_H2_theOwnerWhoLeavesOrSwitchesOffInTime_losesNothing` is the other half. Nothing in the contract bounds this. What bounds it is the delay and who signs the Safe.
- **The Safe can reach cash approved to a vault that does not exist yet**, by an upgrade of the factory (`test_trust_theFactoryAdminReachesAVaultNotYetCreated_andNoVaultThatExists`). The app approves the exact amount in the same step as the create.
- **The guardian can stop new deposits and the keeper for as long as the Safe leaves them stopped.** It cannot lift its own stop.

## No deposit cap

There is no limit on what a vault may take in, on any network (gate `NO-DEPOSIT-CAP`, Thom, 2026-10-10). Nothing in code replaces the cap as a limit on exposure: how much a person puts into an unaudited vault is that person's choice, and the app's trust notice has to say so. What remains between a vault and the team's keys is the timelock, the Safe and the guardian, as above. The sentence for the trust notice: "These contracts are not audited and nothing limits how much you can deposit. How much you put in is your decision. The team's Safe can change the contracts 48 hours after it says so on chain, and you can withdraw in kind at any time."

The mechanism is still in the contracts, switched off, for the Safe to use later through the timelock:

- **Deposit caps** (`setDepositCaps(perVault, total)`), in raw units of the cash token: one per vault and one across every vault of the factory. Zero is no cap for that one, which is how a new factory and an upgraded one both read; where both are set, one vault's is at most the total. A cap never closes deposits: only the guardian's `pauseDeposits` does. The deploy script sets none unless the file gives `depositCaps`.
- **Who may create a vault** (`setCreationRestricted`, `setCreator`): open to anyone unless the Safe restricts it to a list. A vault that exists is not touched by the list.

The count runs whether or not a cap is set, so a cap set later has something to hold: cash that came in through `deposit` or at creation, less cash that left through `withdraw` or `withdrawAll`, never below zero, per vault. The vault keeps the number, so a withdrawal still calls nothing. The factory's total is the sum of what each vault last reported, brought up to date by that vault's next deposit or by anyone's `syncDeposits`.

What a cap, if one is ever set, does and does not do:

- **It bounds deposits, not what a vault holds, and not what is at risk.** A vault whose stock doubled holds more than the cap. An owner can send the cash token, or any token, straight to their vault's address and trade it there: that is not a deposit, it is not counted, and no contract can refuse it.
- **A withdrawal of cash lowers the count. A withdrawal in kind does not.** `withdraw` of the cash token and `withdrawAll` lower the vault's own count at once; the factory's total follows at that vault's next deposit or `syncDeposits`. `withdraw` of a stock leaves the count where it was, since the contract has no price to say what left.
- **So a total cap can be used up for the price of a swap**: deposit to the cap, swap, take the stock out with `withdraw` (`test_creation_restricted_closesTheUseUpOfTheTotalCap`). Nothing is lost; new deposits are refused until the Safe raises the cap. The list of who may create a vault is what answers it, and anyone setting a total cap should restrict creation with it.
- A vault that was already over a cap when it was set keeps what it holds and takes no more.
- Should the cash token ever change, each vault's count starts again at its next deposit.

Tests: `contracts/test/DepositCaps.t.sol` (no cap at the start and after an upgrade, either cap alone, a cap taken away again), `DepositCaps.invariant.t.sol`.

## The keeper: what a stolen key could cost

Not live at the first deployment: `4663.json` has no keeper and no asset with the keeper's switch, and the script refuses a mainnet file that sets one while `keeperEnabled` is false. When it comes:

| Bound | Contract's hard limit | A mainnet file may set at most | Planned |
|---|---|---|---|
| Loss per trade against the reference price (`toleranceBps`) | 300 | 150 | 125 |
| Loss per vault taken at once (`lossCapBps`) | 500 | 200 | 100 |
| Loss per vault in any seven days (twice the cap: the counter drains) | 1,000 | 400 | 200 |
| Time between two keeper trades in one asset | at least 600 s | at least 3,600 s | 3,600 s |
| Price against its average (`priceDevBps`) | 1,000 | 200 | 150 |
| A stock's price in session (`sessionPriceAge`) | off, or 60 s to 26 h | must be set | 3,600 s |
| Price range, ceiling over floor | 2× | 1.36× | about 15% either side |

So at the planned numbers a stolen keeper key costs each auto-follow vault at most 1% at once and 2% in seven days, and the same again each week until the guardian calls `pauseKeeper`; at the most a mainnet file may set, 150 bps a trade and 200 bps at once, 4% in seven days. These are shares of a vault, and with no deposit cap nothing bounds the vault: the loss in dollars scales with what the vault holds. 2% of a 10,000 dollar vault is 200 dollars; of a 1,000,000 dollar vault, 20,000. This is measured at the reference price: an error in the reference adds to it and the counter does not see it. That is what the range, the average, and the in-session age are for.

Where a price is read: only in `keeperSwap`, and in the view `snapshot()`, which never reverts. Nothing an owner calls reads a feed (`test_M1_theOwnersPathReadsNoPrice`).

## Findings of the review of 2026-10-09 and where each stands

| Finding | Status | Evidence |
|---|---|---|
| H1 one key replaces every vault's code at once | Closed by the timelock and the Safe; the power remains, delayed and visible | `Timelock.t.sol`, `DeployMainnet.t.sol` |
| H2 the admin drains auto-follow vaults by settings | The same: every setter waits | `test_timelock_everyGuardedCallWaitsOutTheDelay`, the two `test_H2_*` |
| H3 no price reference for the keeper on mainnet | Open by design: no keeper at the first deployment. The pool-average feed (branch `contracts/pool-average-feed`) fills the `averageFeed` slot later | The script refuses a keeper while `keeperEnabled` is false |
| M1 a stock price 26 hours old passes in session | Closed where `sessionPriceAge` is set; a mainnet file with the keeper on for a stock must set it | `SessionPrice.t.sol` |
| M2 a stolen keeper key | Bounds are settings; the script holds a mainnet file to tighter ones; a guardian is required | The table above; `test_mainnet_holdsAnEnabledKeeperToAMainnetsLimits` |
| M3 `setAsset` took decimals on trust | Closed | `test_M3_*` in `VaultConfig.t.sol` |
| M4 the deploy path was a test-network path | Closed | `DeployMainnet.t.sol`, `fork/RobinhoodForkDeploy.t.sol`, `tests/authority-check.test.ts` |
| L1 the guard did not read a swap's route | Closed | `packages/sdk/src/guard/evm/route.test.ts` |
| L3 admin and beacon owner can part after launch | Watched: `authority-check` fails when they differ | `tests/authority-check.test.ts` |
| L4 `setCashToken` with vaults live | Behind the timelock; not otherwise changed | |
| L2, L5 to L9 | Accepted as written in the review | `contracts/README.md`, "Known limits" |

One thing M1 costs: Chainlink's stock feeds on Robinhood Chain write a round on a 0.5% move or once a day. With `sessionPriceAge` set, a quiet stock (SPY most days, SGOV every day, whose one round is at 00:00 UTC) has no price of the day and the keeper does not trade a vault that holds it. That is a refusal, not a loss. Whether the keeper runs with this rule, or with the pool-average check alone, is a person's decision before the keeper goes on.

## Test-only contracts

`contracts/testnet/` holds a price one key writes, tokens one key mints, and an exchange one key re-centres. Three things keep them off a mainnet:

1. Their constructors refuse chain ids 1, 4663 and 8453 (`TestnetOnly.sol`; `test_testOnlyContracts_cannotBeCreatedOnAMainnet`).
2. The deploy script refuses a mainnet file whose feed is not a Chainlink proxy naming its aggregator and describing itself as the file says, or that answers as a test price contract; whose cash token is not USDG; or whose router is not Universal Router (`test_mainnet_refusesAFileThatNamesATestPriceContract`).
3. The deploy script and the three contracts it deploys are compiled from no file under `testnet/` (`test_theDeployScriptAndTheContracts_areBuiltFromNoTestOnlySource`); the two test-network scripts refuse mainnet chain ids themselves.

## How to check who holds what

```
pnpm ops:authority-check --record deployments/robinhood-<network>.json --rpc-env ROBINHOOD_RPC_URL
```

Read-only, and meant to run every day now that the mainnet contracts are deployed. Against `deployments/robinhood-mainnet.json` it answered OK on 2026-10-12, the day of the deploy (`MAINNET-DEPLOY.md`). On a mainnet it also holds the timelock's owner to being a Safe of two or more with no module enabled (and to the owners and threshold the record names). It prints the deposit caps and who may create a vault, and compares them with the record only where the record states them. It compares the live admin, beacon owner, pending hand-overs, the three implementation addresses, guardian, keeper, the timelock's delay and the holders of each of its roles, `launched`, the publish delay and the caps with the record, prints whether each holder is a contract, lists every operation waiting in the timelock, and exits non-zero on any difference or any broken mainnet rule. The record is written from the deploy's output and reviewed before anyone deposits.

## An owner's trade and the price it fills at

The vault checks an owner's swap against one thing: the least it must receive (`minOut`). It reads no price on that path, and with the keeper's switch off nothing else does either. Until Oct 12 the app took `minOut` from the pool's own quote, 1% under it, so the pool's price was the price. The review of #245 put numbers on what that allows, the dollars that move each listed pool by 1%: GLD about $850, AMZN $3,000, MSFT $7,700, GOOGL $33,000, TSLA $41,000, AAPL $46,000, NVDA $47,000, META $220,000, SPY $730,000. Someone can push a thin pool, let a person's order quote and fill there, and trade back.

What the app's builder now does before it builds or quotes any owner trade (`packages/chain-evm/src/vault/trade-limits.ts`; a deposit's trades, a create that trades, a change of targets, any sale):

- **Holds the pool's quote to the token's Chainlink price.** Further than the bound from what the feed says the trade is worth, either way, pool fee included, and the step is refused with a line the person reads (`PriceDeviation`: "the pool's price for GLD is 3.10% worse than the reference price, more than the 2.00% allowed: not trading"). The bound is `priceBoundBps` in the network's deploy record: 200 on mainnet (`4663.json`, proposed), the bound the fork test holds every listed token's fill to.
- **Refuses with no witness.** A feed that gives no price refuses (`AssetNotPriced`).
- **The feed is the witness only while it is live** (Thom, 2026-10-12: stopping stock trades all weekend is not acceptable, dropping the check on a stale feed is the hole, and holding Saturday's trade to 2% of Friday's close is the same stop, only shorter). Live is an answer younger than the record's `sessionPriceAge`: 3,600 seconds on 4663, the chain's own setting for how fresh a price is in session. The stock feeds speak around the clock five days a week, on a 0.5% move or once a day, so a feed is often hours old overnight and always over a weekend. Once it is not live:
  - the witness is **the last hour's average price of the asset's average pool**: the Uniswap v3 pool `contracts/script/config/pool-feeds/4663.json` names for it, the pool the keeper's `PoolAverageFeed` is designed around. No `PoolAverageFeed` is deployed, so the builder reads the pool itself (`observe`) and works the average with the contract's own arithmetic in TypeScript (`readPoolAveragePlan`, `tickPrice`; `packages/chain-evm/test/pool-average.test.ts` holds that arithmetic to the contract's);
  - the bound is the same `priceBoundBps` against that average, and `minOut` is held to its floor as it is to the feed's;
  - an outer rail: the quote is within `staleRailBps` (10%, confirmed 2026-10-12, gate `MAINNET-FILE-CONFIRMED`) of the feed's last answer, however old, or the step is refused. A market that really moved more than that over a weekend is not traded until the feed speaks;
  - an asset whose record says its average cannot be used yet (`average.usable` false: its pool keeps too little history for an hour; **META and GLD today**) keeps the feed as its witness, at the same 2%, for as long as the feed is inside the asset's own `maxAge` (26 hours): it is the only witness it has. Past `maxAge` it is refused with "X trades only while its market is open, for now" and the reason.
  - **the witness is never chosen by thinning a pool.** An average the record calls usable that reads too thin (now or over the hour), short of an hour's history, or unreadable, refuses at once, whatever the feed's age. Falling back to the feed there would let whoever empties the average pool swap the pool's last hour for an answer twenty hours old;
  - **one trade is smaller**: at most `maxTradeUsdNotLive` ($20,000, confirmed the same day), or the asset's own largest trade where that is less. What one trade can lose to someone who moves both pools is the rail times its size: $2,000 at most now, where SPY's and META's $250,000 allowed $25,000;
  - **the rail has an age**: past `staleRailMaxAge` (four days, confirmed the same day: Friday's close to Tuesday's open, and little more) the feed's last answer anchors nothing and the asset is not traded against its pool at all. A feed that has died does not leave the pool as the only witness for ever. So META and GLD trade on weekday nights against a feed some hours old, are held to 2% of Friday's close until Saturday evening, and stop from then to Sunday evening; `usable` is stated in the record by whoever writes it, from the pool's observation cardinality; nothing guesses it when a trade is built;
  - an asset with no average pool, or a network with no rail, keeps the feed to `maxAge` and refuses past it (`PriceStale`: "the market is closed; trades of X resume when it opens");
  - a feed that keeps speaking stays live and stays the witness: nothing here is about the day of the week.
  Checked against the chain as it was at 03:00 UTC on Monday 2026-10-12 (block 86,341,544, read-only): every stock feed was 3.0 hours old; seven tokens were held to their pool's last hour, each within 0.2% of the feed's last answer, META and GLD to their feeds; a $500 trade each way passed for all nine. GLD's feed was 21.5 hours old at that block: it is not a stock feed and it goes long without speaking, so GLD is the one that can pass 26 hours on a weekday and stop.
  A refusal that cites a price says which one: "the reference price", "the last hour's average price" or "its last reference price, from 36 hours ago".
- **Sets `minOut` no lower than the feed's worth less the bound.** It is the higher of that and the slippage under the quote, so the vault itself refuses a fill further from the feed than the bound, whatever the pool does between the quote and the block. An order's steps carry the minimums the order stated; where the feed has since moved so that a stated minimum is under the feed's floor of now, the build is refused (`PriceMoved`, "ask for a new quote") rather than built under it.
- **Holds one trade to the asset's largest** (`maxTradeUsd` in the record, per asset): the largest size measured to cost 1% or less each way in its pool. Above it the step is refused ("at most $1,000 at a time"), and the person trades in parts. A sale is measured at the feed's price, so a pool pushed down cannot make a large sale look small.

What it does not do:

- **Null is unchecked, and a mainnet may not say null.** A record of a mainnet (by its chain's number, 4663, 1 or 8453, or by its name) that states no `priceBoundBps`, no `maxTradeUsd` for an asset, or a rail with no `maxTradeUsdNotLive` or no `staleRailMaxAge`, is refused by the record's schema and again where the limits are handed to the adapter; `Deploy.s.sol` refuses a mainnet file that leaves either out. The mainnet record committed on 2026-10-12 (`deployments/robinhood-mainnet.json`) states all of them.
- **It is the app's check, not the contract's.** Someone who writes their own call data for their own vault is held to their own `minOut` only, and can hurt nobody else's vault. Putting the bound in `ownerSwap` is a contract change (a new setting, a feed read on the owner's path, tests, bite rows, the storage layout, the ABI and the guard's tables: about two days and a re-review), and it would make the owner's path depend on a feed for the first time: a stale feed would stop an owner's swap on the chain itself, where today nothing but the owner's own minimum can. Not done for this deploy.
- **The weekend witness is a pool, and a pool can be moved.** To get a bad price past it someone has to hold the average pool off for most of an hour, against anyone who trades it back, and push the trade pool at the moment, and stay inside 10% of the feed's last answer. What that takes depends on the token (figures of 2026-10-12, dollars that move each pool 1%; the full table is in `ROBINHOOD-MAINNET-DRYRUN.md`): strong for NVDA ($208,000 in the average pool), AMZN ($79,000) and GOOGL ($90,000); fair for AAPL and TSLA ($51,000 and $32,000, about what their trade pools take); weak for MSFT ($17,000, and $4,400 for its trade pool: but about $50,000 into its average pool empties what is in range, the floor trips and MSFT stops, which a fork test shows). For SPY and META the average pool is the thin one ($29,000 and $19,000) and the trade pool the deep one ($726,000 and $221,000): the pair is strong because both must move. The floors are the pool-average file's, half of what each pool held one Friday: a person sets them again from two weeks of readings before the keeper relies on them, and the same goes here. What a single trade can lose to a perfect attack is the rail times its largest trade while the feed is not live: $2,000 for SPY, META, NVDA, AAPL, TSLA and GOOGL at the $20,000 limit, $500 for MSFT, $250 for AMZN.
- **It does not protect where the feed and the pool move together.** That is GLD. Its Chainlink feed is built from on-chain pool prices (`dex_state_price`, crypto hours), not from an exchange. Pushing GLD's one v4 pool does not move the feed at once, so the bound sees it and refuses, as the fork test shows with $4,000 into that pool. Someone who moves the pools the feed itself reads, by enough to shift its answer, moves the witness too, and the bound passes a price that is wrong. Which pools those are, and what that costs, was not measured. **What limits a loss on GLD then is the size limit alone: $1,000 a trade**, the tightest of the nine. A person who trades GLD in ten parts is exposed ten times. On a stale feed GLD is not traded at all for now (its average pool keeps 1,800 observations); once that pool's history is grown it is a deep witness, 180 times deeper than GLD's trade pool. Whether GLD's feed reads that same pool was not checked: if it does, the two witnesses are one. Thom decided on Oct 12 that gold stays listed (gate `GOLD-LISTED`). **Thom confirmed GLD on 2026-10-12 knowing that its feed reads pools and that which pools, and what moving them costs, has not been measured. It is an accepted, unmeasured risk, decided by him. The measurement is still owed.**
- **The test network does not check** (`priceBoundBps` null in its record): its pools are kept at its feeds by our own market maker and its feeds are written by our own copier, so a check would only let a stopped copier stop deposits on the demo. The check's first live use is mainnet, where the hosted app has run it since 2026-10-13; no owner's trade has been made there yet, so what shows it working is still the copy of mainnet with the real pools and feeds (`packages/chain-evm/test/mainnet-trade.test.ts`).
- **The guard does not hold it.** The guard reads bytes and has no price. It still holds `minOut` to the step the person approved.

Tests: `packages/chain-evm/test/trade-limits.test.ts` (the arithmetic and every refusal, fresh and stale), `mainnet-trade.test.ts` on a fork, with the clock moved six hours on (a token whose feed last spoke 3% under where both its pools have stood for an hour is traded, and lands, with its minimum at the average's floor; the same token on a feed minutes old is refused at 2%; a push of its trade pool is refused against the average) and then a day more so every feed is stale (an honest NVDA trade is built against its pool's last hour and lands with its minimum at the average's floor; $180,000 into NVDA's trade pool in one block is refused "against the last hour's average price" until it is traded back; GLD refuses for its short history; a feed that last spoke 12% under where both pools stand is refused at the rail; a feed silent past four days stops the token), at twenty hours ($60,000 into MSFT's average pool runs it under its floor and MSFT is refused, though its trade pool sits on the feed's answer and would pass against it; $20,001 of NVDA is refused where $50,000 passes on a live feed), and with fresh feeds (an honest trade lands with its minimum at or above the feed's floor; a trade above the limit is refused; a stranger pushes GLD's real pool through the real router and the order is refused, both ways, until the stranger trades back; a step built before the push reverts on the vault's minimum; a stale feed refuses).

## Not audited, not done

- No outside audit of any contract here. No Slither or Aderyn run. Tier 2 of gate `G-SEC` is not complete: the Saturday fork and the second rehearsal have not been run.
- No mainnet rehearsal, and no deposit on mainnet yet: the deployed contracts have held no vault. On a fork, every token `4663.json` lists has been deposited beside, traded into and out of through its recorded pool, and withdrawn (`RobinhoodForkDeploy.t.sol`, block 86,735,800). The keeper's path, the sweep's gas and a weekend block were tried with NVDA only.
- There is no fast stop for a fault in the vault's own code, and a fix takes the timelock's 48 hours: see `INCIDENT.md`. Both are limits the product owner accepted (Thom, 2026-10-10), with no deposit cap beside them.
- The Safe checks (threshold, owners, modules) of the deploy script have run against the real Safe on a fork (below). `authority-check` ran against the deployed mainnet contracts and this Safe on 2026-10-12 and answered OK (`MAINNET-DEPLOY.md`); its creator list has run against a model only.
- **The Safe exists** (Thom, 2026-10-12): `0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc` on Robinhood Chain (4663), created in block 86,734,497. Read on chain that day, by `eth_call` and `eth_getStorageAt` through a public node: `VERSION()` 1.5.0; `getThreshold()` 2; `getOwners()` `0x0a1c3312c808b23D019bF241028f6B5624f4cc98` and `0xAC3cBBCd6e51dBFAf4e79d5E8Cf54a1622D71e0e`; `getModulesPaginated(sentinel, 10)` an empty page ending at the sentinel; the guard slot zero; `nonce()` 0; a fallback handler set, `0x3EfCBb83A4A7AFcB4F68D501E2c2203a38be77f4`. It is `timelock.owner` in `script/config/4663.json`. Who holds them (Thom, 2026-10-12): `0x0a1c…cc98` is Thom Gabriel, `0xAC3c…1e0e` is Rodrigo Trindade. Not confirmed here: that the proxy's singleton and the fallback handler are Safe's own published 1.5.0 contracts (a person compares them with Safe's deployment list). Two owners with a threshold of two means one lost key locks the Safe, and with it every upgrade and setting; a third owner is a person's decision.
- **Safe 1.5.0 has no `getModules()` of its own**: the function left the Safe contract after 1.2.0. This Safe still answers it with an empty list, through its fallback handler. `checkSafe` asks both ways and needs one of them; the paged answer is the Safe's own. `test_fork_theRealSafe_passesCheckSafe_andTheFileDeploysWithItAsTheTimelocksOwner` runs the check and the whole deploy against this Safe on a fork: the first run against a real Safe rather than a model.
- **The guardian is Thom Gabriel's address**, `0x0a1c3312c808b23D019bF241028f6B5624f4cc98` (Thom, 2026-10-12), and `guardian` in `script/config/4663.json`. It is also one of the Safe's two owners. That is Thom's decision, and this is what it means:
  - He can stop alone and at once: the keeper, new deposits, an asset, the market, a waiting portfolio version. No second signature, no delay.
  - He cannot lift a stop alone. Lifting one is an admin call: both Safe owners sign it, and it waits the timelock's 48 hours.
  - That key alone cannot move a token, change a setting or upgrade anything: those need the Safe's two signatures and the delay. A stop never reaches `withdraw` or `withdrawAll`.
  - What is given up: the guardian is not a third party. If that one key is stolen, the thief can stop deposits and the keeper (until both owners lift it, 48 hours later) and holds one of the two signatures the Safe needs. If it is lost, the Safe is locked (two of two): nobody can upgrade, change a setting, lift a stop or name a new guardian, and nobody can stop anything at once either.
  - Neither the deploy script nor `authority-check` refuses or warns on a guardian that is a Safe owner. Both still refuse a guardian that is the deployer, the zero address or the keeper.
- What Robinhood's stock tokens do on freeze or seizure is not published; only `paused()` and `effectiveAt()` were read.
- Cash is counted at one dollar with no peg check.
- The hostile-case matrix for the Solana program (A1 to A18 by test name) is not in this file.
- `BasketVault` is 1,923 bytes under the contract size limit.
