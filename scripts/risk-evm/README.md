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
- **Second chances within the hour.** If tokens are left without a row for a reason that may pass (network down, endpoint refusing, block state gone), the loop tries again for those tokens only, about 2, 6, 14, 30 and 50 minutes after the first attempt (`RETRY_AFTER_MIN` in `slot.ts`). A ten-minute outage costs minutes, and one of 45 minutes still leaves the hour its sample. No retry starts within two minutes of the next scheduled run. A late retry does mean that hour's sample for the retried tokens can sit ten minutes before the next hour's. A token is not retried when its pools are the reason (no eligible pool, no sell quote) or its call reverted: the same call gives the same answer. A one-off run makes one attempt.
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

## The token list and every pool

Two commands beside the hourly collector (PLAN-UNIVERSE RU.2, gate `UNIVERSE`). They are read-only (`eth_getLogs`, `eth_call`, public GETs), they are run by hand, and the hourly run reads nothing they write: a plain `pnpm risk-evm:collect` behaves as before.

```sh
pnpm risk-evm:universe                    # the issuer's token list, each address checked on chain: 3 seconds, 2 RPC calls
pnpm risk-evm:discover                    # every pool of every token: about 30 minutes, 1,500 RPC calls (4,200 the first time)
pnpm risk-evm:discover --check-collector  # and compare with the pools the hourly collector would keep
pnpm risk-evm:discover --only NVDA,SPY    # some symbols only
pnpm risk-evm:discover --no-logs          # without the creation events (the fallback, with its gaps stated)
```

**`universe`** reads the issuer's registry (`api.robinhood.com/rhj/assets`) and asks each address for `decimals()` and `symbol()`. A token whose contract is silent or disagrees with the registry stays in the file as `confirmed: false` with the reason. It writes `data/risk-evm/universe-<chain>-<stamp>.json`. On 2026-10-05: 194 tokens, all confirmed.

**`discover`** (method `evm-discovery-0.1`) writes `data/risk-evm/discovery-<chain>-<stamp>.json`: a summary per token, and one row per pool.

1. **Where pools come from.** Three sources, merged by pool id:
   - the creation events: `PoolCreated` of the Uniswap v3 factory and `Initialize` of the v4 pool manager, filtered on the tokens (either side of the pair). An event is the contract's own word, so it needs no second check. The events are kept in `data/risk-evm/creation-logs-<chain>.json`; a later run reads only the blocks since (`--rescan` starts over).
   - DexScreener, every pair of the token (at most 30 a token). It is the only source for other venues. A v3-style pool it names must answer `token0()` and `token1()`; one that claims the allowlisted factory must be named by that factory's `getPool`, or it is refused.
   - the factory asked directly: `getPool` for each pair seen, at each fee tier seen. On Oct 5 it named the same 2,544 pools as the events, and none besides.
2. **One row per pool, keyed on the token address.** `token` is the stock's address as the registry writes it; a symbol is only a label. A pool of two stocks is one row, filed under token0 (the lower address), with `otherIsStock: true` and `filedUnder: "token0_of_two_stocks"`.
3. **What the vault can reach.** `reachable` is true for a pool of the allowlisted factory and for a v4 pool with no hook. Anything else is kept and marked: `unreachableReason` is `has_hook` or `other_venue`. `againstDollar` says whether the other side is the dollar token, which is what the hourly collector quotes.
4. **The money in a pool** (`tvlUsd`, with `tokenUsd` and `otherUsd` for the two sides):
   - a v3-style pool: the balances the pool holds (`balanceOf`), each at its token's price. `tvlMethod: "balances_held_by_the_pool"`.
   - a v4 pool has no balance of its own (the pool manager holds every pool's money). Its row is what its positions hold between price / 1.5 and price × 1.5: the tick bitmap and the liquidity of each initialized tick in that band are read at the same block as the price, and the amounts are added up tick by tick. `tvlMethod: "v4_positions_within_band_of_the_price"`. Liquidity placed further out is not counted.
   - the same sum is made on Uniswap v3 pools and stored as `bandUsd` beside the measured balances. On Oct 5, over the 109 v3 dollar pools of $1,000 or more, it came to 98% of the balances at the median (88% at the 10th percentile, 99% at the 90th). Against DexScreener's own figure, the v4 rows above $50,000 sit at 98% at the median.
   - `tvlUsd` is `null` with `tvlReason` when it was not measured, never zero: `token_not_priced`, `other_token_not_priced`, `stock_side_below_floor_other_token_not_looked_up`, `pool_state_not_read`.
   - a pool read as empty (no balance; on v4, no liquidity at the price at that block, though it may hold positions further out) has no row. It is counted on its token under `idle`. A pool whose read failed keeps its row, with `pool_state_not_read`.
5. **Prices** (the `prices` list; each names its pool and block). The dollar token counts as one dollar, as in the collector. A stock is priced by the mid of the reachable dollar pool holding the most dollar tokens (a Uniswap v3 pool's balance, a hookless v4 pool's dollar side within the band), if that is at least $1,000 (`--min-ref-usd`) and the pool has liquidity in range; otherwise it has no price. Any other token is looked up the same way, but only where a pool's stock side is worth $100 or more (`--min-side-usd`). The native coin takes the price of the wrapped coin the v4 position manager names (`WETH9()`).
6. **State is read at one block per pool.** The endpoint drops a block's state within minutes and a full pass takes longer, so the pass moves to a fresh block every 45 seconds. Each row carries its own `block` and `fetchedAt`; the file gives the first and the last.
7. **What a run could not have seen** is on each token under `gaps`: DexScreener failed for it, DexScreener returned its cap of 30 (other venues may have more), or the creation events were not available.

### What the endpoints allowed for `eth_getLogs` (probe of 2026-10-05)

| Question | `rpc.mainnet.chain.robinhood.com` | `robinhood.drpc.org` (free) |
|---|---|---|
| One query over the chain's life (81 million blocks) | refused: "only 10000000 are allowed" | refused: "ranges over 10000 blocks are not supported on free plan" |
| Ten million blocks, no token filter | refused where it matches more than 10,000 logs | as above |
| Ten million blocks, one value in each topic | answered | as above |
| A list of tokens in one topic | at most 100,000 blocks a query | as above |
| Ten such queries in one HTTP request, one request a second | answered; 16 refusals for rate in 3,240 queries, each answered on the next try | not tried |
| Fifty in one request | refused for rate | not tried |

So the public endpoint lists every pool, in 3,240 queries of 100,000 blocks (13 minutes, once). The fallback was not needed; it exists and is tested (`--no-logs`): DexScreener and `getPool` only, with `v4_pools_from_dexscreener_only` on every token. The run records its own probe in the file (`logsProbe`).

### The run of 2026-10-05 (blocks 81,044,145 to 81,057,597)

- 100,538 v4 pools and 2,544 Uniswap v3 pools name one of the 194 tokens. 38,434 of them have no row: nothing in the pool, or on v4 no liquidity at the price at that block (such a pool may still hold positions further out). 64,845 have a row. Most are not stock markets: 40,038 of the rows carry one launch hook and pair a stock token with a newly made token.
- 2,140 rows have a measured TVL, $91.0M together; 728 hold $1,000 or more, 543 of them reachable. By venue, pools of $1,000 or more: Uniswap v3 173 ($43.7M), Uniswap v4 430 ($43.3M, of which 60 hooked pools hold $7.0M), other venues 125 ($3.9M).
- 98 of the 194 tokens have a price: 46 from a Uniswap v3 dollar pool, 52 from a v4 one. The other 96 have no dollar pool holding $1,000, so their 2,248 rows are `token_not_priced`.
- 60,457 rows pair a stock with a token that has no dollar price here. For 52,361 the price was not looked up, because the stock side is under $100; for 8,096 it was looked up and no dollar pool of $1,000 exists. 994 of those hold $1,000 or more on the stock side.
- All 54 pools the hourly collector would keep for its 21 tokens are among the rows, all `reachable` (`collectorCheck` in the file).
- DexScreener answered for every token in this run. In the run before it failed for one (JOBY), which then carried `dexscreener_failed_other_venues_not_listed`; a file should be checked for that gap before it is used.

Known limits:

- A v4 row leaves out liquidity further than a third below or a half above the price. A v4 pool whose band holds more than 900 initialized ticks is not summed (`pool_state_not_read`).
- Other venues are only known through DexScreener, 30 pairs a token: 21 tokens were at that cap.
- A price is one pool's mid at one block. It values a pool; it is not the price a trade gets, and it is never mixed with an oracle (gate `ORACLE-VS-DEX`).
- A pool of two stocks is filed under one. Whether it also counts for the other is decided where such pools are routed.

## The cut

`pnpm risk-evm:pareto` (PLAN-UNIVERSE RU.3, method `evm-cut-0.1`) applies the 80% rule (`trackedSet` of `packages/risk`) to the newest discovery file. It reads that one file and calls nothing.

```sh
pnpm risk-evm:pareto                       # the newest discovery file, 80% and $1,000
pnpm risk-evm:pareto --discovery <file>    # another file
pnpm risk-evm:pareto --share 0.8 --min-pool-usd 1000
pnpm risk-evm:pareto --allow-gaps          # a file in which DexScreener failed for a token
pnpm risk-evm:pareto --allow-old           # a file more than a day old
```

It writes `data/risk-evm/cut-<chain>-<stamp>.json` (the stamp is the discovery file's) and prints the same in words. A cut by another share or floor is written beside it with the rule in its name (`…-share0.9-min1000.json`), so the rule's own file is never replaced by it. It refuses a discovery file more than 24 hours old, and one in which a token carries `dexscreener_failed_other_venues_not_listed`; with `--allow-gaps` the file is used and the token is named in the output.

What the file holds, and what it does not decide:

- **The mapping.** One row per pool: `address` is the pool id, `asset` the address of the stock the pool is filed under, `tvlUsd` as discovery measured it. A TVL that was not measured stays `null`: it is left out of the ranking and the total and counted (`counts.unmeasured`, by reason), never zero.
- **`shares`**: pools and stocks at 80, 90, 95 and 99%. **`tracked`**: the stocks of the 80% cut, each with its pools in the cut, every ranked pool, how many the vault reaches, and its pools left out as dust or as unmeasured. **`cut`** and **`pools`**: the rows themselves.
- **`unpricedTokens`**: the stocks with no dollar pool of $1,000. Their pools have no TVL and cannot enter the cut. Whether a thinner pool may price a stock is not decided.
- **`unrankedHoldingStock`**: rows with no TVL whose stock side alone is $1,000 or more, by stock, venue and reason. Not ranked.
- **`withoutV4`**: the same rule with the v4 rows taken out, because a v4 TVL is a band sum and a v3 TVL is the balances. Printed in full only when the two name different stocks.
- **`twoStockPools`**: the pools of two stocks that touch a tracked stock. The rule counts such a pool for the stock it is filed under (token0) only; whether it counts for both is not decided.
- **`vsCollector`**: the tracked stocks against the tokens of `config.ts`, and for each collected token that is not tracked, why and at what share it would enter.

### The run of 2026-10-05 (on `discovery-robinhood-20261005T1947.json`)

- 728 pools ranked ($90.9M). 80%: 93 pools, **30 stocks**, 427 ranked pools of those stocks ($84.0M), 274 of them reachable. 90%: 154 pools, 48 stocks. 95%: 225 and 67. 99%: 440 and 89.
- The 30: AAPL AMC AMD AMZN COIN COST CRCL DELL DJT GLD GME GOOGL HIMS INTC LLY META MSFT MSTR MU NVDA PLTR QQQ RDDT SGOV SLV SNDK SPCX SPY TSLA USO. Against the collector's 21: 20 are in both; AMC, COST, DJT, GME, HIMS, LLY, PLTR, QQQ, RDDT and SPCX are tracked and not collected; TSM is collected and not tracked (its largest pool is rank 102; any cut above 82.0% names it).
- The 93 pools of the cut: 42 Uniswap v3 ($36.8M) and 41 hookless v4 ($29.2M), all reachable; 8 hooked v4 ($6.0M) and 2 on another venue ($0.8M), not reachable.
- Without the v4 pools (298 pools, $47.6M) the cut names 29 stocks: IBM and NFLX enter; AMD, PLTR and SNDK leave.
- 19 of the 93 are pools of SPY against another stock ($9.3M), all filed under SPY. If such a pool also counted for its other side, TSM would be named too.
- 994 rows with no TVL hold $1,000 or more on the stock side, $5.0M of stock tokens in all, 796 of them under tracked stocks ($4.4M); 944 are v4 pools.
- 96 tokens have no price. DexScreener was at its cap of 30 pairs for 21 tokens, all of them tracked, so pools on other venues may be missing for those.

## The oracle map

`pnpm risk-evm:oracles` (PLAN-UNIVERSE RU.5, method `evm-oracles-0.1`) gives each tracked stock of the newest cut its Chainlink feed, or the reason it has none. Read-only: one public GET (Chainlink's reference directory, `feeds-robinhood-mainnet.json`) and one `eth_call` through Multicall3 at one block.

```sh
pnpm risk-evm:oracles                    # the newest cut and token list in data/risk-evm/
pnpm risk-evm:oracles --cut <file>       # another cut file
pnpm risk-evm:oracles --universe <file>  # another token list
pnpm risk-evm:oracles --allow-old        # a cut whose discovery is more than a day old
```

It writes `data/risk-evm/oracles-<chain>-<stamp>.json` (the stamp is the time of the block read) and prints the same in words, ending with the count and the names of the tracked stocks without a confirmed feed. The file is not committed and the hourly collector reads nothing of it. It refuses a cut more than 24 hours old, and a token list that does not hold every tracked stock.

One row per tracked stock, keyed on the token address: `feed` (the address, `description`, `decimals`, the round's `answer`, `price` and `updatedAt`, `ageSeconds`, the session at the block) or `feed: null` with `reason`. Every row carries `source`, `fetchedAt`, `method` and `provenance`. The tokens of `config.ts` that are not tracked are in `collectedNotTracked`, apart. The file states the following in `stated`, so nothing below is chosen silently:

- **How a feed is tied to a token.** By the directory's `name` and the token's symbol. The directory names no token address, so the symbol is the only tie. The name must read as the symbol, `RH` and the symbol, or `Robinhood` and the symbol, then `/ USD` or `-USD` (the forms in use on Oct 5: `GLD / USD`, `RHSPY / USD`, `Robinhood QQQ / USD`, `Robinhood DELL-USD`). The directory's `docs.baseAsset` is not used: three entries lack it and one reads `RHDELL`. Every tie that is not one to one is refused, and nothing picks between candidates: two registry tokens sharing a symbol get no feed (`symbol_shared_by_tokens`), two feeds naming one token are both listed in `candidates` (`two_feeds_name_the_token`), one feed reading as two tokens is refused (`feed_names_two_tokens`).
- **How a feed is confirmed.** By its own contract: `description()` must name the token by the same rule, `decimals()` must equal the directory, `latestRoundData()` must give a positive answer with a time not after the block. Otherwise there is no feed and the row says why (`description_does_not_name_the_token`, `no_answer_from_the_feed`, `decimals_differ_from_directory`, `answer_not_positive`, `round_time_not_in_the_past`). `no_feed` means the directory lists none.
- **Which address is stored.** The directory's `proxyAddress`, the one the vault would read: the aggregator behind a proxy is replaced when a feed is upgraded and the proxy stays. `aggregator()` of the proxy is recorded and compared with the directory's `contractAddress`, and the listed aggregator is called directly once to record whether it answers (GLD's does not). The second proxy the directory lists ("Shared SVR") is recorded and not read.
- **The price.** Recorded as read (`answer`, an integer in the feed's decimals) and with the point placed (`price`). It is not compared with, corrected by or blended into a pool price (gate `ORACLE-VS-DEX`); RU.7 records it over time and RU.9 measures the gap. No multiplier is applied to anything.
- **Age.** `ageSeconds` is the block's time less `updatedAt`. An old answer is still a confirmed feed: nothing is refused for age. The file counts the feeds older than the vault's 26 hours and older than their own heartbeat, and says whether the block was in the US session by the calendar of `packages/risk` (`fixtures/risk/us-market-holidays.json`).
- **Funds and the treasury token** (`funds`: SPY, QQQ, GLD, SLV, USO, SGOV): whether a feed exists and what the directory says it prices. `token_with_multiplier` is the directory's product `primaryTokenizedPrice`, which Chainlink documents as the share's price times the issuer's multiplier (https://docs.chain.link/data-feeds/tokenized-equity-feeds). `token_from_pools` is its attribute `dex_state_price`. Where the directory says neither, the answer is `null` (`not_stated_in_directory`). The registry's multiplier is printed beside and applied to nothing.

Every feed of the directory is read, whatever it is matched to (five reads each: `description()`, `decimals()`, `latestRoundData()` and `aggregator()` of the proxy, `latestRoundData()` of the listed aggregator), so the calls depend on the directory alone. `feedsOfOtherTokens` lists the feeds that name a registry token outside both lists.

### The run of 2026-10-05 (block 81,159,297, 23:03 UTC, off session; on `cut-robinhood-20261005T1947.json`)

- 58 feeds in the directory, none left out. 290 contract reads in one `eth_call`; 2 RPC calls, 0.6 seconds with the GET.
- **24 of the 30 tracked stocks have a confirmed feed. 6 have none (`no_feed`): AMC, COST, DJT, HIMS, LLY, RDDT.** No feed was refused, no symbol is shared by two tokens, no stock has two feeds.
- TSM, collected and not tracked, has a confirmed feed.
- Every confirmed feed has 8 decimals and points at the aggregator the directory lists. The contracts name themselves in four ways: `Robinhood X / USD` (12 of the 24), `RHX / USD` (9), `Robinhood X-USD` (2: DELL, SGOV), `X / USD` (1: GLD).
- Ages at the block, 3 hours after the close: 1 minute (SPCX) to 9.1 hours (AAPL), and 23.0 hours for SGOV. None older than 26 hours or than its 24-hour heartbeat.
- The six funds all have a feed. SPY, QQQ, SLV and USO: `token_with_multiplier`. **GLD: `token_from_pools`**, a reference price from the state of exchanges on chain, market hours "Crypto"; its aggregator does not answer a direct call. **SGOV: not stated**, the directory entry carries no product or asset name.
- 11 feeds name a registry token outside both lists: ASML, BABA, CLSK, CRWV, EWY, IONQ, NBIS, ORCL, RGTI, RKLB, USAR.

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
| `universe.ts`, `registry.ts` | The command for the token list; reading the registry and confirming it on chain |
| `discover.ts`, `discover-run.ts` | The command for the pools; one discovery pass |
| `discovery.ts` | Creation events, the merge of the sources, reach, filing, the money in a pool. No I/O |
| `multicall.ts`, `replay.ts` | Many reads in one `eth_call`; recorded answers given back to a test |
| `record-discovery-fixture.ts` | Re-records `fixtures/risk-evm/robinhood-discovery.json.gz` from the chain |
| `pareto.ts`, `cut.ts` | The command for the cut; the rule applied to a discovery file and what it reports. `cut.ts` has no I/O |
| `oracles.ts`, `feeds.ts` | The command for the oracle map; the directory, the match, the confirmation and one pass. `feeds.ts` reads only through the client it is given |
| `record-oracles-fixture.ts` | Re-records `fixtures/risk-evm/robinhood-oracles.json.gz` from the directory and the chain |

After editing `ClQuoter.sol`, run `pnpm exec tsx scripts/risk-evm/build-quoter.ts`; a test fails while the JSON is stale. The tests are in `tests/risk-evm.test.ts`. They replay `fixtures/risk-evm/robinhood-nvda-quotes.json` and the endpoint errors in `fixtures/risk-evm/rpc-errors.json`; none calls the network. The token list and the discovery are tested in `tests/risk-evm-universe.test.ts`, which replays one recorded pass for two tokens (`fixtures/risk-evm/robinhood-discovery.json.gz`). The cut is tested in `tests/risk-evm-cut.test.ts`, on the discovery of Oct 5 frozen to what the cut reads (`fixtures/risk/universe/robinhood-discovery-20261005T1947.json.gz`, made by `pnpm risk:freeze-universe-fixture <discovery.json> --chain robinhood`). The oracle map is tested in `tests/risk-evm-oracles.test.ts`, which replays one recorded pass (`fixtures/risk-evm/robinhood-oracles.json.gz`: the directory and the chain's answers at block 81,158,299).

## What Rodrigo's side needs before the API can serve these curves (RISK-1)

`scripts/risk/compute.ts` already fits every row; it needs about six lines so EVM curves keep their own symbol and method version. Line numbers are for the file as it is on `staging` on Oct 2.

1. In the select (lines 30 to 35), add `asset: riskAssetSnapshots.asset` and `methodVersion: riskAssetSnapshots.methodVersion`.
2. After line 41: `const meta = new Map<string, { asset: string; version: string }>();`
3. Inside the loop that starts at line 42: `meta.set(r.assetMint, { asset: r.asset, version: r.methodVersion });`
4. Line 70: `assetSymbol: symbol.get(mint) ?? meta.get(mint)?.asset ?? mint.slice(0, 6),` (today an EVM row's symbol would be `0xd060`).
5. Line 81: keep the snapshot's version when it starts with `evmq-`, otherwise `CURVE_METHOD_VERSION` as today, so Solana rows stay `risk-0.3`.
6. Line 82, `source`: it says "routed: best split across dollar-exit pools", which is wrong for EVM rows; make it follow the version.

Outside `compute.ts`: `apps/api/src/liquidity.ts:37` filters on one method version with `eq` and needs `inArray`; and each EVM token needs an `assets` row whose `mint` is the token address exactly as written in `config.ts`, because that is what `asset_mint` holds.
