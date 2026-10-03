# EVM depth collector

What it costs to sell (and buy) a stock token at a given size on an EVM chain, measured once an hour from the real pools. The rows feed the same exit-cost curves the Solana risk layer produces. Slot REVM-1; design in `docs/vault/DESIGN-VAULT.md` section 8.

It reads Robinhood Chain mainnet (chain 4663), whatever network the product itself runs on, because that is where the liquidity is. It only makes `eth_call` requests and public GETs: no transaction, no key, no wallet.

## What a run does

1. Reads the latest block and pins every later call to it. A token's prices and its quotes always come from one block; the row's `fetched_at` is that block's time and `slot` its number. All tokens of a run share the block unless it has to be replaced (see "When a block cannot be read").
2. Loads the pool list from `data/risk-evm/pools-<chain>.json`. If the file is missing, a day old, or `--rediscover` is passed, it asks DexScreener for each token's pairs against the dollar token and checks the candidates on chain. A v3-style pool is kept only if an allowlisted factory's own `getPool` returns it for that pair and fee (a contract can claim any factory, so the factory is asked). A Uniswap v4 pool is kept only if its key, from the PositionManager, has no hook. Those are the pools the vault's swap path reaches. The three deepest per token are kept. If DexScreener fails or comes back empty for a token that had pools, the old list stays.
3. Reads every pool's mid price in one Multicall3 call at the pinned block (`slot0` on v3 pools, `StateView.getSlot0` on v4). A pool more than 2% from the median of the token's pools is left out of that run.
4. Quotes each pool at Rodrigo's size grid ($100 to $5M, eight sizes), selling and buying:
   - v3-style pools: `ClQuoter.sol` in this folder, placed at a made-up address with an `eth_call` state override. It calls `swap` and reverts inside the callback, so it returns what the pool would take in and pay out without anything being deployed or paid.
   - v4 pools: the deployed v4 Quoter, all sizes in one Multicall3 call.
5. Per size, keeps the pool that loses the least, and appends one row per token to `data/risk-evm/assets/YYYY-MM-DD.jsonl`. If a pool's call fails for any reason other than gas (the endpoint refused it, no answer), the token gets no row from that attempt: a row without its deepest pool would show a thinner pool's cost as the best. `data/risk-evm/runs.jsonl` records each attempt (block, rows, calls made, duration, each token's error) and each scheduled hour (see "The run log").

## Method `evmq-0.1`

- A sale of size `n` sells `n / mid` tokens into a pool, where `mid` is that pool's own price at the same block. `outUsd` is the dollar tokens received (one dollar token counts as one dollar) and `costPct = (1 - outUsd / n) * 100`. A purchase spends `n` dollar tokens and values the tokens received at the pool's mid.
- The cost therefore includes the pool's fee as well as price impact. A 0.05% pool costs 0.05% at $100.
- The reference is the pool's price, not the Chainlink feed, because the feed can be hours old.
- Each point carries `pool` (the pool chosen), `midUsd` (the price it was measured against), `quoted` (how many pools gave a quote at that size) and `unfilledShare`. `outUsd` is null when no pool gave one.
- `ref_pool` and `ref_mid_usd` are the deepest pool in the run and its mid. `source` names the block, the chain and the RPC.

Known limits:

- **Best single pool overstates cost when liquidity is split.** A router that splits a sale across pools does better than any one of them. The gap grows with size.
- **Only pools the vault can reach are measured.** Other venues on Robinhood Chain quote stock tokens tighter than Uniswap does; an aggregator would use them, the vault's router does not.
- Pool prices of one token differ by up to about 0.3% (a 0.3% pool is not arbitraged inside its fee). Measuring each pool against its own mid is right on average and can be off by that much in one sample.
- A pool that runs out is treated differently by kind. A v3-style pool answers with a partial fill: the unfilled part counts as lost in `costPct` and shows in `unfilledShare`. The v4 Quoter refuses the size (`NotEnoughLiquidity`), so a v4 pool gives no quote there.
- The public RPCs cap `eth_call` at 50M gas. A size that walks a whole pool can exceed it; that pool is then missing at that size (`quoted` shows it). v3 quotes stop at 20M gas per swap, and a v4 batch that runs out of gas is asked again without its largest size, up to three times.
- DexScreener returns at most 30 pairs per token and its liquidity figure only ranks the candidates.

## When a block cannot be read

The public RPC keeps a block's state for a few minutes. On Oct 3, 2,000 blocks back (about 3 minutes) still answered and 10,000 did not. A run takes about ten seconds, so this only matters when something stops it part-way, and the overnight run of Oct 2 to 3 showed what does: the Mac slept during runs, which then took 16 to 94 minutes of wall time and found the state of their block gone.

- **The block's state is gone.** The endpoint answers `historical state … is not available`, `missing trie node … layer stale`, or names a block it does not have. The token being measured is started again on the latest block, prices first, then quotes; nothing read at the old block is kept for it. This is tried twice per token (`MAX_REPINS_PER_TOKEN`). Rows already written keep their block, and the tokens still to do move to the new one.
- **The run was paused.** Before each token the run checks how long it has held its block. Past two minutes (`MAX_PIN_AGE_MS` in `run.ts`) it takes a fresh block for everything that is left, rather than ask about state that is probably gone.
- **The pause ran into the next hour.** A fresh block is never taken once the next scheduled run is due, between tokens or for a token whose own block has just turned out to be gone. The run stops and leaves that token and the rest to the next run, so no token is sampled twice a minute apart and no row lands in the wrong hour. A quote that was on the wire during the pause and still comes back good is kept: it is a sample of the hour it was asked in.
- **The fresh block is refused.** If the endpoint answers the call for a new block with an error of its own (rate, plan limit), the run stops there and the hour tries again, as below.
- **The network is down.** After three tries the run stops at once (the other tokens would only wait out the same timeouts) and marks what is left for another try.

A row is never written with a price from one block and quotes from another, and a token whose quotes failed gets no row and no cost.

## Run it

```sh
pnpm risk-evm:collect                # one run, about 10 seconds and 110 RPC calls for 21 tokens
pnpm risk-evm:collect --rediscover   # look for the deepest pools again first
pnpm risk-evm:collect --loop         # one run now, then one an hour, until stopped
pnpm risk-evm:import                 # load the JSONL into risk_asset_snapshots (needs the database)
```

### The loop

- It runs on a fixed hourly grid from its start. Runs never overlap: inside the loop one run ends before the next starts, `run.lock` keeps a one-off run and the loop apart, and `loop.lock` stops a second loop. Ctrl-C or SIGTERM lets an attempt in progress finish.
- **Second chances within the hour.** If tokens are left without a row for a reason that may pass (network down, endpoint refusing, block state gone), the loop tries again for those tokens only, about 2, 6, 14 and 30 minutes after the first attempt (`RETRY_AFTER_MIN` in `collect.ts`). A ten-minute outage costs minutes, not the hour. No retry starts within two minutes of the next scheduled run. A token is not retried when its pools are the reason (no eligible pool, no sell quote) or its call reverted: the same call gives the same answer. A one-off run makes one attempt.
- **A sleeping Mac.** macOS stops the process while the machine sleeps. An idle Mac sleeps on its own, so run the loop under `caffeinate -i`, which prevents idle sleep while the command runs:

  ```sh
  nohup caffeinate -i pnpm risk-evm:collect --loop >> data/risk-evm/collect.log 2>&1 &
  ```

  `caffeinate -i` does not stop sleep from a closed lid or a low battery. If the machine sleeps anyway:
  - a run caught mid-way finishes on a fresh block when the machine wakes (above), or stops and is retried if the network is not back yet;
  - on waking, the loop does not catch up the hours it slept through. It runs the latest scheduled hour, late, only if at least half the interval is left before the next scheduled run (with the hourly grid: it woke in the first 30 minutes of that hour). Otherwise it waits for the grid. So two samples are never closer than half an interval;
  - each hour that got no run, slept through or woken into too late, gets a line in the run log saying which.
- If a loop refuses to start after a crash and none is running, delete `data/risk-evm/loop.lock`.
- Nothing here installs a scheduled job.

### The run log

`data/risk-evm/runs.jsonl` has two kinds of line. A line per attempt holds the block, the rows written, the calls made, `repins` (fresh blocks taken), `scheduledAt`, `attempt`, and each token's error. A line with `"event":"slot"` closes each scheduled hour: `rows` out of `tokens`, `attempts`, the tokens still `missing` with the reason, and how it `ended` (`complete`, `nothing to retry`, `out of attempts`, `next run is due`, `stopped`, or `missed` for an hour with no run at all). A run started by hand closes with `"event":"one_off"` instead, so it does not count as an hour. To list the gaps in the sample:

```sh
jq -c 'select(.event == "slot" and .rows < .tokens) | {scheduledAt, rows, ended, error, missing}' data/risk-evm/runs.jsonl
```

### Other notes

- The import is idempotent: the table's key is `(asset_mint, fetched_at)` and existing rows are left alone.
- Settings are in `.env.example` under "EVM depth collector". Tokens, addresses and chains are in `config.ts`; Base is there, switched off (`--chain base` runs it once).
- Curves: `pnpm risk:compute` fits every row of `risk_asset_snapshots`, these included, and today stores every curve as `risk-0.3`. The lines that keep `evmq-0.1` on EVM curves are Rodrigo's (RISK-1).

## Files

| File | What it is |
|---|---|
| `collect.ts` | The command: one run, or the hourly loop |
| `run.ts` | One run for one chain, and what it does when its block can no longer be read |
| `slot.ts` | The retries within one scheduled hour |
| `pools.ts` | Finding and caching the pools |
| `curve.ts` | Mid price, sizes, cost, best pool per size, the row. No I/O |
| `abi.ts` | The few ABI encodings needed, by hand (no dependency added) |
| `rpc.ts`, `loop.ts`, `config.ts` | JSON-RPC client, loop and locks, chains and tokens |
| `import.ts` | JSONL into the database |
| `ClQuoter.sol`, `cl-quoter.json` | The injected quoter and its compiled bytecode |
| `build-quoter.ts`, `record-fixture.ts` | Rebuild the bytecode; re-record the test fixture. Both need Foundry |

After editing `ClQuoter.sol`, run `pnpm exec tsx scripts/risk-evm/build-quoter.ts`; a test fails while the JSON is stale. The tests are in `tests/risk-evm.test.ts`. They replay `fixtures/risk-evm/robinhood-nvda-quotes.json` and the endpoint errors in `fixtures/risk-evm/rpc-errors.json`; none calls the network.

## What Rodrigo's side needs before the API can serve these curves (RISK-1)

`scripts/risk/compute.ts` already fits every row; it needs about six lines so EVM curves keep their own symbol and method version. Line numbers are for the file as it is on `staging` on Oct 2.

1. In the select (lines 30 to 35), add `asset: riskAssetSnapshots.asset` and `methodVersion: riskAssetSnapshots.methodVersion`.
2. After line 41: `const meta = new Map<string, { asset: string; version: string }>();`
3. Inside the loop that starts at line 42: `meta.set(r.assetMint, { asset: r.asset, version: r.methodVersion });`
4. Line 70: `assetSymbol: symbol.get(mint) ?? meta.get(mint)?.asset ?? mint.slice(0, 6),` (today an EVM row's symbol would be `0xd060`).
5. Line 81: keep the snapshot's version when it starts with `evmq-`, otherwise `CURVE_METHOD_VERSION` as today, so Solana rows stay `risk-0.3`.
6. Line 82, `source`: it says "routed: best split across dollar-exit pools", which is wrong for EVM rows; make it follow the version.

Outside `compute.ts`: `apps/api/src/liquidity.ts:37` filters on one method version with `eq` and needs `inArray`; and each EVM token needs an `assets` row whose `mint` is the token address exactly as written in `config.ts`, because that is what `asset_mint` holds.
