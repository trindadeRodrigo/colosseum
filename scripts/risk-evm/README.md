# EVM depth collector

What it costs to sell (and buy) a stock token at a given size on an EVM chain, measured once an hour from the real pools. The rows feed the same exit-cost curves the Solana risk layer produces. Slot REVM-1; design in `docs/vault/DESIGN-VAULT.md` section 8.

It reads Robinhood Chain mainnet (chain 4663), whatever network the product itself runs on, because that is where the liquidity is. It only makes `eth_call` requests and public GETs: no transaction, no key, no wallet.

## What a run does

1. Reads the latest block. Every later call is pinned to that block, so all figures in a row come from one state. The row's `fetched_at` is the block's time and `slot` its number.
2. Loads the pool list from `data/risk-evm/pools-<chain>.json`. If the file is missing, a day old, or `--rediscover` is passed, it asks DexScreener for each token's pairs against the dollar token and checks the candidates on chain. A Uniswap v3 pool is kept only if its `factory()` is on the chain's allowlist; a Uniswap v4 pool only if its key (from the PositionManager) has no hook. Those are the pools the vault's swap path reaches. The three deepest per token are kept.
3. Reads every pool's mid price in one Multicall3 call (`slot0` on v3 pools, `StateView.getSlot0` on v4). A pool more than 2% from the median of the token's pools is left out of that run.
4. Quotes each pool at Rodrigo's size grid ($100 to $5M, eight sizes), selling and buying:
   - v3-style pools: `ClQuoter.sol` in this folder, placed at a made-up address with an `eth_call` state override. It calls `swap` and reverts inside the callback, so it returns what the pool would take in and pay out without anything being deployed or paid.
   - v4 pools: the deployed v4 Quoter, all sizes in one Multicall3 call.
5. Per size, keeps the pool that loses the least, and appends one row per token to `data/risk-evm/assets/YYYY-MM-DD.jsonl`. A line of `data/risk-evm/runs.jsonl` records the run: block, rows, calls made, duration, errors.

## Method `evmq-0.1`

- A sale of size `n` sells `n / mid` tokens into a pool, where `mid` is that pool's own price at the same block. `outUsd` is the dollar tokens received (one dollar token counts as one dollar) and `costPct = (1 - outUsd / n) * 100`. A purchase spends `n` dollar tokens and values the tokens received at the pool's mid.
- The cost therefore includes the pool's fee as well as price impact. A 0.05% pool costs 0.05% at $100.
- The reference is the pool's price, not the Chainlink feed, because the feed can be hours old.
- Each point carries `pool` (the pool chosen), `midUsd` (the price it was measured against), `quoted` (how many pools answered at that size) and `unfilledShare`. `outUsd` is null when no pool answered.
- `ref_pool` and `ref_mid_usd` are the deepest pool in the run and its mid. `source` names the block, the chain and the RPC.

Known limits:

- **Best single pool overstates cost when liquidity is split.** A router that splits a sale across pools does better than any one of them. The gap grows with size.
- **Only pools the vault can reach are measured.** Other venues on Robinhood Chain quote stock tokens tighter than Uniswap does; an aggregator would use them, the vault's router does not.
- Pool prices of one token differ by up to about 0.3% (a 0.3% pool is not arbitraged inside its fee). Measuring each pool against its own mid is right on average and can be off by that much in one sample.
- The deployed v4 Quoter does not say how much of the amount a pool took. When a v4 pool runs out, `outUsd` stops growing and `unfilledShare` is null.
- The public RPCs cap `eth_call` at 50M gas. A size that walks a whole pool can exceed it; that pool is then missing at that size (`quoted` shows it). v3 quotes stop at 20M gas per swap.
- DexScreener returns at most 30 pairs per token and its liquidity figure only ranks the candidates.

## Run it

```sh
pnpm risk-evm:collect                # one run, about 10 seconds and 110 RPC calls for 21 tokens
pnpm risk-evm:collect --rediscover   # look for the deepest pools again first
pnpm risk-evm:collect --loop         # one run now, then one an hour, until stopped
pnpm risk-evm:import                 # load the JSONL into risk_asset_snapshots (needs the database)
```

- The loop runs on a fixed hourly grid from its start. Runs never overlap: `run.lock` covers one run (a one-off run and the loop share it) and `loop.lock` stops a second loop. A failed run is logged to stderr and to `runs.jsonl`, and the loop carries on. Ctrl-C or SIGTERM lets a run in progress finish.
- If a loop refuses to start after a crash and none is running, delete `data/risk-evm/loop.lock`.
- The import is idempotent: the table's key is `(asset_mint, fetched_at)` and existing rows are left alone.
- Nothing here installs a scheduled job. To keep the loop alive across a closed terminal: `nohup pnpm risk-evm:collect --loop >> data/risk-evm/collect.log 2>&1 &`.
- Settings are in `.env.example` under "EVM depth collector". Tokens, addresses and chains are in `config.ts`; Base is there, switched off (`--chain base` runs it once).
- Curves: `pnpm risk:compute` fits every row of `risk_asset_snapshots`, these included, and today stores every curve as `risk-0.3`. The lines that keep `evmq-0.1` on EVM curves are Rodrigo's (RISK-1).

## Files

| File | What it is |
|---|---|
| `collect.ts` | The command: one run, or the hourly loop |
| `run.ts` | One run for one chain |
| `pools.ts` | Finding and caching the pools |
| `curve.ts` | Mid price, sizes, cost, best pool per size, the row. No I/O |
| `abi.ts` | The few ABI encodings needed, by hand (no dependency added) |
| `rpc.ts`, `loop.ts`, `config.ts` | JSON-RPC client, loop and locks, chains and tokens |
| `import.ts` | JSONL into the database |
| `ClQuoter.sol`, `cl-quoter.json` | The injected quoter and its compiled bytecode |
| `build-quoter.ts`, `record-fixture.ts` | Rebuild the bytecode; re-record the test fixture. Both need Foundry |

After editing `ClQuoter.sol`, run `pnpm exec tsx scripts/risk-evm/build-quoter.ts`; a test fails while the JSON is stale. The tests are in `tests/risk-evm.test.ts` and replay `fixtures/risk-evm/robinhood-nvda-quotes.json`; none calls the network.
