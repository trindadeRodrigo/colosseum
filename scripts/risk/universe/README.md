# The asset list, one file per chain

`pnpm risk:universe <chain>` (PLAN-UNIVERSE RU.4 and RU.10, gate `UNIVERSE`, decision DU2; method `universe-list-0.1`) writes `robinhood.json` and `solana.json` in this folder. They are generated and committed: the one generated file under the plan that is. The collector (RU.6), the seed (RU.8) and the vault's asset entries read them. The command reads files and calls nothing.

```sh
pnpm risk:universe robinhood                # the newest cut, oracle map and token list in data/risk-evm/
pnpm risk:universe robinhood --cut <file> --oracles <file> --universe <file>
pnpm risk:universe robinhood --allow-old    # a cut whose discovery is more than a day old
pnpm risk:universe solana                   # the frozen registry of Oct 1 and the Scope table
```

**Inputs.** Robinhood Chain: `cut-robinhood-<stamp>.json` (`pnpm risk-evm:pareto`), `oracles-robinhood-<stamp>.json` (`pnpm risk-evm:oracles`) and `universe-robinhood-<stamp>.json` (`pnpm risk-evm:universe`), described in `scripts/risk-evm/README.md`. The command refuses a cut more than 24 hours old, a cut made by another rule than 80% and $1,000, an oracle map that was not made from this cut and this token list (by the names it records), and a cut and an oracle map that do not name the same token addresses under the same symbols. A fund of the class table with no row in the map's `funds` is refused too, since its open question is read from that row. Solana: `fixtures/risk/universe/solana-registry-20261001T0139.json.gz` through `trackedSet`, `solana-registry-detail-20261001T0139.json.gz` (the same registry file, cut to the mint, its decimals, the quote mint, the venue and the way out of each pool of $1,000 or more) and `fixtures/solana-vault/scope-indexes.json`.

**A row** (schema `TrackedAsset` and `AssetList` in `packages/schemas/src/universe.ts`), one per tracked stock, keyed on the token address:

- identity in the shape of `BasketAsset`: `id`, `chain`, `address`, `symbol`, `decimals`, `cls`, `underlying`, `issuer`, `session`, and `clsSource`;
- `inCut`; `pools` (`ranked`, `inCut`, `reachable`, `byVenue` with the reach per venue, `twoStock`, `twoStockAsOther`, `dust`, `unmeasured`, and on Solana `byExitPath`); `tvlUsd`, `cutUsd`, `reachableUsd`, `share`;
- `oracle`: `{ kind: 'chainlink' | 'scope', ref, … }`, or `null` with `oracleReason`;
- `autoRebalance`, with `autoRebalanceReason` when false, and `autoRebalanceOpen`;
- `source`, `fetchedAt`, `method`, `provenance` on the row and on the oracle.

The file says the following in `stated`, so nothing is chosen silently:

- **Copied and derived.** Copied from the cut: the address, the symbol, every pool count but the three below, `tvlUsd`, `cutUsd`, `reachableUsd`. Copied from the token list: `decimals` (confirmed by the contract). Copied from the oracle map: the proxy address, the feed's `description` and `decimals`, the reason there is no feed, and what a fund's feed prices. Derived here: `id`, `underlying`, `issuer`, `session`, `cls`, `byVenue` with its reach, `twoStock`, `twoStockAsOther`, `share`, `autoRebalance`. On Solana the counts and the money are summed from the registry by `trackedSet`.
- **The class (DU7).** Funds and the treasury token are ranked with the stocks. No input carries a class the vault's `AssetClass` can take, so it is a table in `list.ts` by the underlying: SPY and QQQ `etf`, GLD `gold`, SLV and USO `commodity`, SGOV `dollar_yield`; everything else is `stock`. `clsSource` says which.
- **No feed.** A stock the directory lists no feed for is a row with `oracle: null`, `oracleReason: 'no_feed'` and `autoRebalance: false`. A stock whose feed the oracle map refused carries the map's reason, not `no_feed`. On Solana the reason is `no_scope_entry`.
- **GLD and SGOV.** `autoRebalance` is the rule alone: true with a confirmed oracle. GLD's feed is a price taken from the pools (`oracle.prices: 'token_from_pools'`), and SGOV's directory entry does not say what it prices (`prices: null`, `pricesReason: 'not_stated_in_directory'`). Both rows are written `autoRebalance: true` and carry `autoRebalanceOpen` (`oracle_prices_from_pools`, `what_the_oracle_prices_is_not_stated`). Whether either may be rebalanced automatically is the vault stream's question; a reader that must not act before the answer checks `autoRebalanceOpen`. No multiplier is applied to anything and none is in the file.
- **Pools the vault cannot reach (DU3)** are counted in `ranked` and `byVenue` and left out of `reachable` and `reachableUsd`. On Solana reach is not recorded per pool: `reachable` is `null` with its reason.
- **Pools of two stocks** are counted once, under the stock the chain files them (token0 on Robinhood Chain). The other stock has them in `twoStockAsOther` only, never in its money.
- **No price.** No answer of a feed is in the file, and nothing is compared with a pool price (`ORACLE-VS-DEX`).
- **A later run.** The list is written from one run. What happens to a stock that leaves the cut on a later run is not decided: no rule keeps or removes a row.

### The lists of 2026-10-05

- **Robinhood Chain** (cut `cut-robinhood-20261005T1947.json`, oracle map `oracles-robinhood-20261005T2312.json`): 30 rows, 427 ranked pools, 274 reachable, 46 of them pools of two stocks (32 under SPY). 24 rows with a Chainlink feed; 6 without (`no_feed`): AMC, COST, DJT, HIMS, LLY, RDDT. Class from the table: SPY, QQQ, GLD, SLV, USO, SGOV. Open: GLD, SGOV.
- **Solana** (registry of 2026-10-01 01:38 UTC): 18 rows, 869 ranked pools (610 Raydium CPMM, 163 Raydium CLMM, 60 Orca, 36 Meteora; 71 straight to dollars, 58 through SOL, 22 through another stock, 718 other). 10 rows with a Scope oracle; 8 with `no_scope_entry`: AMZNx, COINx, GLDx, GMEx, MCDx, MSFTx, SPCXx, STRCx. The list and its rows say `fixture`, as the frozen registry does; the oracles say `live`, as the Scope table says of itself.

## Files

| File | What it is |
|---|---|
| `build.ts` | The command |
| `list.ts` | The two lists from their inputs, the class table, what is stated. No I/O |
| `freeze-fixtures.ts` | `pnpm risk:freeze-list-fixtures`: freezes the inputs under `fixtures/risk/universe/` |
| `robinhood.json`, `solana.json` | The lists |

The tests are in `tests/risk-universe-list.test.ts`; none calls the network. They read `fixtures/risk/universe/robinhood-list-inputs-20261005T1947.json.gz` (the three Robinhood files cut to what the list reads: no round and no price) and the Solana fixtures above, and they hold the committed lists to those inputs. After a new run of the Robinhood list, freeze its inputs again:

```sh
pnpm risk:freeze-list-fixtures robinhood <cut.json> <oracles.json> <universe.json>
pnpm risk:freeze-list-fixtures solana <registry.json>
```
