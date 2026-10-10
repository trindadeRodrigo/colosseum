# SECURITY: the EVM vault contracts

What the contracts in `contracts/` let each key do, what a person whose vault it is can always do, and what has not been checked by anyone outside the team. Written for the first, small, owner-signed deployment on Robinhood Chain mainnet (4663). The Solana program has its own section in `DESIGN-VAULT.md` 13; its matrix is not in this file yet (see "Open").

Nothing here is audited. No contract is deployed on any mainnet.

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

**"A Safe" is checked, as far as a contract can say it of itself.** The script and `authority-check` refuse an owner with no code, a key with delegated code (EIP-7702, 23 bytes starting `0xef0100`), anything that does not answer `getThreshold()` and `getOwners()`, a threshold under `safeMinThreshold` (2 at least on a mainnet), fewer than two owners, or a threshold above the owner count. Both print the owners and the threshold. That the contract is a real Safe and that those owners are the people meant is a person's comparison; a contract written to answer like one would pass. The person who compares the owners also confirms the Safe has no module enabled: a module can move a Safe without its signers. `authority-check` reads the modules and fails on a mainnet when there is one; the deploy script does not read them.

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

Read-only, and meant to run every day once anything is deployed. On a mainnet it also holds the timelock's owner to being a Safe of two or more with no module enabled (and to the owners and threshold the record names). It prints the deposit caps and who may create a vault, and compares them with the record only where the record states them. It compares the live admin, beacon owner, pending hand-overs, the three implementation addresses, guardian, keeper, the timelock's delay and the holders of each of its roles, `launched`, the publish delay and the caps with the record, prints whether each holder is a contract, lists every operation waiting in the timelock, and exits non-zero on any difference or any broken mainnet rule. The record is written from the deploy's output and reviewed before anyone deposits.

## Not audited, not done

- No outside audit of any contract here. No Slither or Aderyn run. Tier 2 of gate `G-SEC` is not complete: the Saturday fork and the second rehearsal have not been run.
- No mainnet rehearsal. Fork tests cover NVDA and USDG only; the other tokens were not tested in a vault.
- There is no fast stop for a fault in the vault's own code, and a fix takes the timelock's 48 hours: see `INCIDENT.md`. Both are limits the product owner accepted (Thom, 2026-10-10), with no deposit cap beside them.
- The Safe checks (threshold, owners, modules) and the creator list in `authority-check` have run against a model only; the rest of it has run against a local chain and the test network.
- The Safe does not exist yet. Its address, signers and threshold go here when it does, and into `script/config/4663.json`.
- The guardian key does not exist yet.
- What Robinhood's stock tokens do on freeze or seizure is not published; only `paused()` and `effectiveAt()` were read.
- Cash is counted at one dollar with no peg check.
- The hostile-case matrix for the Solana program (A1 to A18 by test name) is not in this file.
- `BasketVault` is 1,923 bytes under the contract size limit.
