# apps/keeper

The keeper on Solana (DESIGN-VAULT 3.5 and section 10): a worker with no HTTP listener that moves vaults with auto-follow on toward their targets, one leg at a time. Robinhood Chain is KEEP-2.

```sh
SOLANA_RPC_URL=<devnet node> KEEPER_SOLANA_KEYPAIR=<path to the keeper key> \
  pnpm --filter @colosseum/keeper start --once            # one round
  ... --loop [--interval 60]                             # a round every interval seconds (10 or more)
  ... --dry-run                                          # plans and builds; signs and sends nothing
```

- `CHAIN_NETWORK_SOLANA`: `testnet` (default, `deployments/solana-devnet.json`) or `local` (`deployments/solana-local.json`). `mainnet` is refused.
- Everything it acts on comes from that record: the program, the test exchange, the price account, the tokens, and the keeper it signs as. The node behind `SOLANA_RPC_URL` has to answer the record's genesis, never mainnet's.
- It signs with the one key at `KEEPER_SOLANA_KEYPAIR`, only if that key is the record's default keeper, and only transactions whose signer is that key. Neither the path nor anything in the file is ever printed: a file it cannot read is reported in those words only.
- `KEEPER_STATE_DIR` (default `~/.tenonfi/keeper`) holds what it remembers between runs, one file per network (`solana-devnet.json`). See "Legs in flight and reverted legs".

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

On devnet, tGLDx's price comes from a pool's mid, not an oracle, so its keeper switch is being turned off there. From then on, a devnet vault that holds tGLDx (the KEEP-1 check vault does) is skipped with that alert.

Thom decided on Oct 5 that a shared portfolio holding gold gets the one-tap rebalance prompt, which the owner signs, not auto-follow. The keeper never rebalances such a portfolio's vaults.

## Sync policy

`buildKeeperLeg` refuses while any position's account holds another amount than the program records (`needsSync`). The keeper syncs those records only when every changed position has a reference price that is in its range and fresh. Otherwise it leaves the vault alone and raises an alert.

The reason, from the adapter's review: once synced, one raw unit of a position with no reference, or one out of its range, stops every leg in that vault. A stranger can send a vault dust of such a token; syncing it would stop the keeper for that vault until the owner sells or withdraws it. Not syncing leaves the vault's legs refused too, but the alert names it and nothing new is recorded.

## Legs in flight and reverted legs

A leg is remembered from the moment it is signed, before it is sent, with its signature and the last block height it can land in. It stays remembered until the chain settles its fate: an error from the node after sending, or no answer within the wait, does not make it "not taken", because the bytes may still land. Until its fate is known, nothing more is planned for its vault. The keeper asks for its status by signature at the start of every round:

- landed: the vault is planned again;
- reverted: its sale and purchase (vault, sell, buy) join the reverted set, and that leg is never sent again; the line raises an alert;
- expired (past its last valid block height, finalized, and not found): it never landed, and the vault is planned again;
- still able to land, or the status cannot be read: the vault waits, with an alert.

What holds: the legs in flight and the reverted set are in the state file, read at start and written before a leg is sent and whenever either changes, so `--once` run twice remembers as `--loop` does. What does not: a deleted or lost state file forgets both; the file is per machine, so two keepers on two machines do not share it (run one); adoptions and syncs are not remembered, as each is planned again from the chain and the builder refuses one that is no longer due. `keeper_runs` and `keeper_legs` (`packages/db`) are not written yet.

## For KEEP-2

- `buildKeeperLeg` makes the keeper pay the rent of any token account a leg creates for the vault: a slow drain on the keeper's SOL to watch with the low-gas alert.
- The run and leg rows, alerts beyond the log line, and Robinhood Chain.

## Tests

- `tests/keeper/keeper.test.ts`, in LiteSVM with the real program: a weights-only version adopted and a leg sent; a changed position synced when it can be valued, and skipped with an alert when its price is out of range; a reverted leg not sent again in the next run, the memory read back from the state file; a leg whose send failed after the bytes went out kept and found reverted the next round; a pending leg holding its vault until it has expired; a vault holding an asset switched off for the keeper skipped with nothing built; a dry run that sends nothing.
- `tests/keeper/policy.test.ts`: the choice of trade, passing over an asset switched off, one with no usable reference, and one in cooldown.
- `tests/keeper/round.test.ts`, on a stand-in for the chain: the loss cap skipped and half the budget alerted; prices asked for the vault's own holdings only; a version adopted by the cluster's clock, not the machine's; a version that adds an asset left to the owner.
- `tests/solana-vault/validator.test.ts`, on a local validator: a vault following its own shared portfolio, the next version published, the round adopting it and sending a leg through the node's preflight.

## The check on devnet

`scripts/solana/keeper-check.ts setup` makes a test creator and owner (keys in that process only), funds them from the deploy key, publishes a three-asset portfolio, opens a vault following it, buys at its weights, switches auto-follow on and publishes the next version. Then `--once` runs the keeper. The run of Oct 5 is in `docs/vault/STATE-VAULT.md` (KEEP-1).
