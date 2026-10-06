# apps/keeper

The keeper (DESIGN-VAULT 3.5 and section 10): a worker with no HTTP listener that moves vaults with auto-follow on toward their targets, one leg at a time, on one chain a process: Solana (KEEP-1) or Robinhood Chain (KEEP-2), by `KEEPER_CHAIN`.

```sh
SOLANA_RPC_URL=<devnet node> KEEPER_SOLANA_KEYPAIR=<path to the keeper key> \
  pnpm --filter @colosseum/keeper start --once            # one round
  ... --loop [--interval 60]                             # a round every interval seconds (10 or more)
  ... --dry-run                                          # plans and builds; signs and sends nothing
```

- `CHAIN_NETWORK_SOLANA`: `testnet` (default, `deployments/solana-devnet.json`) or `local` (`deployments/solana-local.json`). `mainnet` is refused.
- Everything it acts on comes from that record: the program, the test exchange, the price account, the tokens, and the keeper it signs as. The node behind `SOLANA_RPC_URL` has to answer the record's genesis, never mainnet's.
- It signs with the one key at `KEEPER_SOLANA_KEYPAIR`, only if that key is the record's default keeper, and only transactions whose signer is that key. Neither the path nor anything in the file is ever printed: a file it cannot read is reported in those words only.
- `KEEPER_STATE_DIR` (default `~/.tenonfi/keeper`) holds what it remembers between runs, one file per network and genesis (`solana-devnet-<genesis>.json`), held by one keeper at a time. See "Legs in flight and reverted legs".

- With `--loop`, a round that fails (the node does not answer, a DNS error, a 429 or a 5xx) is one line with `"outcome":"round-failed"`, its reason and `"alert":true`; the next round comes after 15 s, doubled after each failure in a row up to 5 minutes, and the interval returns once a round goes through. A failed round never ends the loop, and the state file stays held. What is wrong at start (no node, a key that is not the keeper's, the wrong network) stops it before the first round, as before. With `--once` the failed round is said and the keeper exits 1. The same on both chains: `src/loop.ts` runs the rounds, `src/keeper.ts` gives each its lines, alerts and health ping, and a failed round's reason never carries `SOLANA_RPC_URL` or `ROBINHOOD_RPC_URL`.
## A round

Every vault with auto-follow on, read from the chain, in random order. For each vault, at most one adoption, one sync and one leg, each built and simulated by the adapter, signed, sent, and tracked until the chain settles it:

0. **The leg sent earlier.** If a leg sent for the vault has no known fate, its fate is read first (below). While it could still land, nothing more is planned for the vault.
1. **Adopt.** A pending version whose time has come by the cluster's clock is adopted when it adds no asset and the keeper is not paused. One that adds an asset waits for the owner.
2. **Sync.** See below.
3. **Leg.** Not built while the vault is blocked for the keeper, has no price account, or has used its whole loss budget. The plan is `rebalancePlan` from `packages/basket` on the vault as the chain holds it and the prices the adapter reads for that vault's own holdings (never the API's database), so an asset another vault holds cannot stop it. The first planned trade the program would take now is built: a trade on an asset switched off for the keeper, with no reference the program takes now, in its cooldown, outside its session or on a closed day, in a multiplier window, or with a transfer hook is passed over. The builder simulates it, so a leg the program would refuse costs nothing.

It writes one JSON line per vault per round: `acted` (a leg landed), `synced` or `adopted` (the vault got that and no leg, with the reason why not), `would-act` in a dry run, or `skipped`, each with the signatures it sent and the reason, and `alert: true` where a person should look. Every line of a vault past half its weekly loss budget is an alert and says how much is used. Then one line for the round: vaults, acted, alerts, legs in flight.

## Assets with no oracle

Gate UNIVERSE (`docs/GATES.md`): a stock is rebalanced by the vault only if it has an oracle, Scope on Solana. Without one it is the owner's to trade, and its keeper switch (bit 0 of its entry's flags, `keeperOn` in the deploy record) is off. The keeper passes over a planned trade in such an asset before building it.

The program goes further: a leg values every position it does not trade by its reference, so a vault that holds any of a switched-off asset gets no keeper leg at all (`KeeperAssetOff`). The keeper skips that vault before building, with an alert, and adoptions still go through.

On devnet, tGLDx's price comes from a pool's mid, not an oracle, so its keeper switch is off there. A devnet vault that holds tGLDx (the first KEEP-1 check vault does) is skipped with that alert.

Gate GOLD-ONE-TAP (Thom, Oct 5): a shared portfolio holding gold, or any asset with no oracle, gets the one-tap rebalance prompt, which the owner signs, not auto-follow. The keeper never rebalances such a portfolio's vaults.

## Sync policy

`buildKeeperLeg` refuses while any position's account holds another amount than the program records (`needsSync`). The keeper syncs those records only when every changed position has a reference price that is in its range and fresh. Otherwise it leaves the vault alone and raises an alert.

The reason, from the adapter's review: once synced, one raw unit of a position with no reference, or one out of its range, stops every leg in that vault. A stranger can send a vault dust of such a token; syncing it would stop the keeper for that vault until the owner sells or withdraws it. Not syncing leaves the vault's legs refused too, but the alert names it and nothing new is recorded.

## Legs in flight and reverted legs

A leg is remembered from the moment it is signed, before it is sent, with its signature and the last block height it can land in. It stays remembered until the chain settles its fate: an error from the node after sending, or no answer within the wait, does not make it "not taken", because the bytes may still land. Until its fate is known, nothing more is planned for its vault. The keeper asks for its status by signature at the start of every round:

- landed: the vault is planned again;
- reverted: its vault, the vault's version, and its sale and purchase join the reverted set, and that leg is never sent again while the vault is on that version (decided by the team lead under Thom's authority, Oct 5). Every round that passes it over raises an alert, until a person looks. When the vault takes another version, its reverted legs of the version before are forgotten and it is planned afresh;
- expired (past its last valid block height, finalized, and not found): it never landed, and the vault is planned again;
- still able to land, or the status cannot be read: the vault waits, with an alert.

What holds: the legs in flight and the reverted set are in the state file, read at start and written (flushed, then renamed into place) before a leg is sent and whenever either changes, so `--once` run twice remembers as `--loop` does. A keeper takes the file with a lock beside it (`<file>.lock`, holding its process id, start time and a nonce, written to a file of its own and hard-linked into place, so it is never seen empty) and refuses to start while a live process holds it. A lock whose process is gone, or that names the keeper's own process id (reused after a restart), is taken over with a line on stderr; one with no process id in it counts as held for 30 s. A takeover runs under a second lock (`<file>.lock.takeover`, taken the same way): the stale lock is moved aside, checked to be the one read, then removed, so two keepers starting at once never both hold the file. So a manual `--once` beside a `--loop` refuses instead of sending the same leg twice. What does not hold: a deleted or lost state file forgets both; the lock is per machine, so two keepers on two machines would not see each other (run one); adoptions and syncs are not remembered, as each is planned again from the chain and the builder refuses one that is no longer due. `keeper_runs` and `keeper_legs` (`packages/db`) are not written yet.

## Robinhood Chain (KEEP-2)

```sh
KEEPER_CHAIN=robinhood ROBINHOOD_RPC_URL=<46630 node> KEEPER_ROBINHOOD_KEY=<path to the keeper key> \
  pnpm --filter @colosseum/keeper start --once [--dry-run]
```

- `CHAIN_NETWORK_ROBINHOOD`: `testnet` (default, `deployments/robinhood-testnet.json`) or `local` (`deployments/robinhood-local.json`, mainnet's pools). `mainnet` is refused. The node has to answer the record's chain id, never a mainnet's, with code at the record's factory.
- The key at `KEEPER_ROBINHOOD_KEY` (one 0x private key in hex) has to be the keeper the factory names now (`keeper()`), read at start; neither its path nor its contents are printed. It is loaded and signs through `@colosseum/chain-evm/server`, the only place an EVM key becomes a signer.
- The round is the same one (`round.ts` over `KeeperAdapter`, `chain.ts`): `getKeeperContext` of the EVM reader is the vault as `keeperSwap` would find it, its checks written again in `packages/chain-evm/src/vault/keeper.ts` (cooldown, multiplier window, issuer's pause, guardian's halt, session; the reference of every held target: feed, switch, range, both ages, the distance from the average). Balances are read, not tracked, so nothing is synced. Adoption is `adoptVersion`, a leg is `keeperSwap` with `minOut` the quote less 100 bps.
- A leg carries no deadline on EVM. It is remembered with its nonce, the call's hash and its signer; a leg still pending at the next round is asked of `fate`: taken by another call, it can never land (expired); landed, it is read under the id the chain has; still open and held by the node, the vault waits, with an alert; open and never seen by the node (turned away, or somewhere it cannot see), the vault is planned again and its next leg is signed on the same nonce, so of the two at most one can land. A leg the relay's preflight refuses never left the keeper (`ChainError.unsent`): it is forgotten at once. A target the vault holds that cannot be valued stops every leg, a dropped one kept at weight zero included, and an asset taken off the factory's list is sold and never bought.
- The state file is `robinhood-testnet-<chain id>-<factory>.json`, under the same lock.
- Checked on a copy of the test network (`tests/keeper/evm.test.ts`, `RH_TESTNET_FORK_URL`): the read, a dry run that sends nothing, a leg that lands and stamps its cooldown, a leg the relay's preflight refuses, forgotten with its vault free, a leg that lands and reverts and is not sent again on that version, and a weights-only version adopted, forgetting the reverted legs of the version before.
- Setting the keeper on 46630 is the deployer's `setKeeper`, and its gas a forward from the price writer: `scripts/testnet/robinhood/ops.ts keeper <address>` prints both as a dry run and sends them only with `--send`.

## Alerts and the keeper's machine

- `KEEPER_DISCORD_WEBHOOK`: every round's alert lines go there as one message (a vault past half its loss budget, a reverted leg passed over, a leg that would be refused for a reason that does not pass by waiting, a vault held by an unsettled leg), and so does a round that failed. `KEEPER_LOW_GAS` (wei on Robinhood Chain, default 0.0005 ETH; lamports on Solana, default 0.05 SOL): below it, the keeper's own balance is an alert.
- `KEEPER_HEALTHCHECK_URL`: pinged after every round, and its `/fail` after a round that failed, so a keeper that stopped or hangs is noticed by the check's own schedule.
- Neither URL is ever printed; a post that fails is said on stderr in words of its own (`apps/keeper/src/alerts.ts`, `tests/keeper/alerts.test.ts`).
- `scripts/keeper/run.sh <solana|robinhood>` runs the keeper in a loop and starts it again 30 s after it stops (a failed round no longer stops it; a crash or a set-up error does); `scripts/keeper/tenonfi-keeper@.service` is the systemd unit for a Linux machine, its environment in `/etc/tenonfi/keeper-<chain>.env`.

## For later

- `buildKeeperLeg` makes the keeper pay the rent of any token account a leg creates for the vault: a slow drain on the keeper's SOL to watch with the low-gas alert.
- The run and leg rows in the database: the log line, the alerts and the state file are the record for now.
- On Robinhood Chain, a read of a pinned leg's fate from more than one node: an open leg the one node never saw frees its vault, and the next leg takes its nonce.

## Tests

- `tests/keeper/keeper.test.ts`, in LiteSVM with the real program: a weights-only version adopted and a leg sent; a changed position synced when it can be valued, and skipped with an alert when its price is out of range; a reverted leg not sent again in the next run, the memory read back from the state file; a leg whose send failed after the bytes went out kept and found reverted the next round; a pending leg holding its vault until it has expired; a vault holding an asset switched off for the keeper skipped with nothing built; a dry run that sends nothing.
- `tests/keeper/policy.test.ts`: the choice of trade, passing over an asset switched off, one with no usable reference, one in cooldown, and a buy of an asset taken off the list.
- `tests/keeper/round.test.ts`, on a stand-in for the chain: the loss cap skipped and half the budget alerted; prices asked for the vault's own holdings only; a version adopted by the cluster's clock, not the machine's; a version that adds an asset left to the owner; a reverted leg passed over with an alert every round on its version and sent again on the next; a vault that only settled an earlier leg not called adopted; on EVM, by its nonce and across a reload of the state file, an open leg the node holds keeping its vault, one gone freeing it, one landed read as confirmed or reverted, one the node never saw freeing the vault with the next leg on its nonce, and one the preflight refused forgotten.
- `tests/keeper/memory.test.ts`: a second process refused while the first holds the state file, and let in once it is released; a lock whose process is gone, one empty and old, and one naming the keeper's own process id taken over, one empty and fresh refused; six real processes starting at once, over 30 trials with no lock, a dead holder's or an old empty one, exactly one holding in each; the file written whole.
- `tests/solana-vault/validator.test.ts`, on a local validator: a vault following its own shared portfolio, the next version published, the round adopting it and sending a leg through the node's preflight.

## The check on devnet

`scripts/solana/keeper-check.ts setup` makes a test creator and owner (keys in that process only), funds them from the deploy key, publishes a portfolio of three stocks with an oracle (spyx, qqqx, nvdax), opens a vault following it, buys at its weights, switches auto-follow on and publishes the next version. Then `--once` runs the keeper. The run of Oct 5, made before gold was switched off, used gldx in place of nvdax; it is in `docs/vault/STATE-VAULT.md` (KEEP-1).
