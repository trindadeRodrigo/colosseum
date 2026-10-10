# INCIDENT: what to do when something is wrong on an EVM chain

For the EVM vault contracts. Who holds which key is in `SECURITY.md`. Every transaction here is signed by a person; an agent prepares the command and never holds a mainnet key.

## First five minutes

1. **Stop the keeper and new money.** The guardian sends two calls to the factory. No delay, no Safe.

   ```
   cast send <factory> "pauseKeeper()"   --rpc-url <rpc> --account <guardian keystore>
   cast send <factory> "pauseDeposits()" --rpc-url <rpc> --account <guardian keystore>
   ```

   For one asset only: `haltAsset(address token, uint64 until)`, with a time later than the one stored. For the whole stock market: `extendClosedUntil(uint64 until)`.

2. **Stop the keeper process** on its machine, if one runs.

3. **Check who holds what**, read-only:

   ```
   pnpm ops:authority-check --record deployments/robinhood-<network>.json --rpc-env ROBINHOOD_RPC_URL
   ```

   It exits non-zero if the admin, the beacon's owner, a timelock role, the guardian, the keeper or an implementation address is not the record's, and it lists every operation waiting in the timelock with the time it may run.

4. **Tell people**, in the app's banner: what is stopped, and that withdrawing works.

## What the pause does and does not do

| | `pauseKeeper` | `pauseDeposits` |
|---|---|---|
| Keeper trades, `adoptVersion` | stopped | not touched |
| `deposit`, the first deposit of a create | not touched | stopped |
| Creating an empty vault | not touched | not touched |
| An owner's swap | not touched | not touched |
| `withdraw`, `withdrawAll` | not touched | not touched |

There is no call that stops a withdrawal.

## Known limit: no fast stop for a fault in the vault itself

If the vault's own code is what is wrong, nothing stops it quickly. The guardian can stop the keeper and new deposits; it cannot stop an owner's swap, and it cannot change code. The only fix is an upgrade, and an upgrade waits the timelock's 48 hours like everything else. This is accepted for the first step, knowingly, because of what bounds it: deposits are capped, one known person may create a vault, there is no keeper, and the owner's own calls are the only ones that move tokens.

What an owner can always do in that time: `withdraw(token, amount)` for each token, or `withdrawAll()`, which take the tokens out as they are and depend on nothing but the token. Tell owners to withdraw in kind, then schedule the fix.

## If a key is lost or stolen

| Key | What the thief can do | What to do |
|---|---|---|
| Guardian | Pause the keeper and deposits; halt assets; close the market. Nothing moves and withdrawals work | The Safe schedules `setGuardian(new)` and then `unpauseKeeper()`, `unpauseDeposits()`, `setHalt`, `setClosedUntil`. 48 hours. Until then the thief can pause again |
| Keeper | Trade auto-follow vaults at the worst allowed price: the weekly cap at once, twice it in seven days (`SECURITY.md`) | Guardian: `pauseKeeper()`, at once. Then the Safe schedules `setKeeper(new)` and `unpauseKeeper()` |
| One Safe signer, under the threshold | Nothing | Replace the signer through the Safe |
| The Safe, at or over the threshold | Schedule anything. It runs 48 hours later | Any remaining honest signers cannot cancel without the threshold. Tell every owner to withdraw in kind within 48 hours; `authority-check` shows what is queued and when. Owners with auto-follow on should switch it off or withdraw |
| Deployer | Nothing after the deploy | Nothing |

## If a queued operation is not ours

`authority-check` prints each waiting operation: its target, the function's selector and when it may run. If the Safe did not mean it, the Safe cancels it (`cancel(bytes32 id)` on the timelock). If the Safe cannot be trusted, see the row above.

## Lifting a stop

Only the Safe, through the timelock: `unpauseKeeper()`, `unpauseDeposits()`, `setHalt(token, 0)`, `setClosedUntil(0)`. Schedule them only after the cause is understood and written down, since each takes 48 hours either way.

## Afterwards

A dated note in `docs/vault/STATE-VAULT.md` under the incident's row: what happened, the transactions with their explorer links, what was paused and when, what changed.

## Not rehearsed

The pause has been run in tests only (`contracts/test/Timelock.t.sol`, and on a fork with the real tokens). It has not been rehearsed on a live network, and the five-minute target of `DESIGN-VAULT.md` 13 is untested. `pnpm ops:pause` does not exist: the two `cast` calls above are the procedure.
