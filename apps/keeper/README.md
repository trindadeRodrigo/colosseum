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
- It signs with the one key at `KEEPER_SOLANA_KEYPAIR`, only if that key is the record's default keeper, and only transactions whose signer is that key. The path is never printed.

## A round

Every vault with auto-follow on, read from the chain, in random order. For each vault, at most one adoption, one sync and one leg, each built and simulated by the adapter, signed, sent, and tracked until the chain settles it:

1. **Adopt.** A pending version whose time has come is adopted when it adds no asset and the keeper is not paused. One that adds an asset waits for the owner.
2. **Sync.** See below.
3. **Leg.** Not built while the vault is blocked for the keeper, has no price account, or has used its whole loss budget. The plan is `rebalancePlan` from `packages/basket` on the vault as the chain holds it and the prices the adapter reads (never the API's database). The first planned trade the program would take now is built: a trade on an asset switched off for the keeper, with no reference the program takes now, in its cooldown, outside its session or on a closed day, in a multiplier window, or with a transfer hook is passed over. The builder simulates it, so a leg the program would refuse costs nothing.

It writes one JSON line per vault per round: `acted`, `adopted`, `synced` or `would-act` with the signatures, or `skipped` with the reason, and `alert: true` where a person should look. Then one line for the round: vaults, acted, alerts.

## Assets with no oracle

Gate UNIVERSE (`docs/GATES.md`): a stock is rebalanced by the vault only if it has an oracle, Scope on Solana. Without one it is the owner's to trade, and its keeper switch (bit 0 of its entry's flags, `keeperOn` in the deploy record) is off. The keeper passes over a planned trade in such an asset before building it.

The program goes further: a leg values every position it does not trade by its reference, so a vault that holds any of a switched-off asset gets no keeper leg at all (`KeeperAssetOff`). The keeper skips that vault before building, with an alert, and adoptions still go through.

On devnet, tGLDx's price comes from a pool's mid, not an oracle, so its keeper switch is being turned off there. From then on, a devnet vault that holds tGLDx (the KEEP-1 check vault does) is skipped with that alert.

## Sync policy

`buildKeeperLeg` refuses while any position's account holds another amount than the program records (`needsSync`). The keeper syncs those records only when every changed position has a reference price that is in its range and fresh. Otherwise it leaves the vault alone and raises an alert.

The reason, from the adapter's review: once synced, one raw unit of a position with no reference, or one out of its range, stops every leg in that vault. A stranger can send a vault dust of such a token; syncing it would stop the keeper for that vault until the owner sells or withdraws it. Not syncing leaves the vault's legs refused too, but the alert names it and nothing new is recorded.

## Reverted legs

A leg that reverted is never sent again: the keeper remembers it (vault, sell, buy) and passes it over in later rounds, raising an alert. The memory lasts as long as the process: the keeper does not write `keeper_runs` or `keeper_legs` (`packages/db`) yet, so a restarted keeper may send a reverted leg once more. Writing them is open work for KEEP-2.

## Tests

- `tests/keeper/keeper.test.ts`, in LiteSVM with the real program: a weights-only version adopted and a leg sent; a changed position synced when it can be valued, and skipped with an alert when its price is out of range; a reverted leg not sent again; a vault holding an asset switched off for the keeper skipped with nothing built; a dry run that sends nothing.
- `tests/keeper/policy.test.ts`: the choice of trade, passing over an asset switched off, one with no usable reference, and one in cooldown.
- `tests/solana-vault/validator.test.ts`, on a local validator: a vault following its own shared portfolio, the next version published, the round adopting it and sending a leg through the node's preflight.

## The check on devnet

`scripts/solana/keeper-check.ts setup` makes a test creator and owner (keys in that process only), funds them from the deploy key, publishes a three-asset portfolio, opens a vault following it, buys at its weights, switches auto-follow on and publishes the next version. Then `--once` runs the keeper. The run of Oct 5 is in `docs/vault/STATE-VAULT.md` (KEEP-1).
