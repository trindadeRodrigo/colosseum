# The venues we do not read

PLAN-UNIVERSE RU.13. One table per chain and a ranking of the venues the risk layer does not read. It builds no decoder: decision D4 of `docs/risk/PLAN-RISK.md` stands, and a venue is added only when its decoder passes the validation the four we have went through. The tables as they stood on 2026-10-07 are in `docs/risk/PLAN-UNIVERSE.md` section 6, "The venues we do not read (RU.13)".

Everything here reads files, and one table of the local database with a `SELECT`. Nothing is written outside `fixtures/risk/venues/`, and only the three freeze commands write there. No transaction, no key, no wallet. Nothing reads an oracle (gate `ORACLE-VS-DEX`).

## The table

```sh
pnpm risk:venues --md                  # the tables as text, as they stand in the plan
pnpm risk:venues                       # the same as one JSON, with every source and date
pnpm risk:venues --fixtures --md       # the tables of the rows frozen in the repository: no collector's home, no database
```

From a worktree, three things have to be named, because `data/` and `.env` are in the main checkout:

```sh
RISK_DATA_DIR=<main checkout>/data/risk \
RISK_EVM_DIR=~/Documents/Colosseum-data/risk-evm \
DOTENV_CONFIG_PATH=<main checkout>/.env \
pnpm risk:venues --until 2026-10-07T12:00:00.000Z --captures ~/ru11-baseline/captures --md
```

| Option | What it names | Default |
|---|---|---|
| `--fixtures` | everything from the rows frozen under `fixtures/` (the window of Oct 6 21:15Z to Oct 7 01:10Z, the registry run of Oct 1, DexScreener's rows, Robinhood's rows); the options below still apply on top | the collector's files and the database |
| `--quotes <file or folder>` | Jupiter's stored quotes, `.jsonl` or `.jsonl.gz` | `RISK_HOME/quotes`, the collector's, read only |
| `--until <time>` | leaves out the quotes fetched after it, so a table can be made again from files that keep growing | every row |
| `--registry <file>` | the collector's registry | `RISK_HOME/registry.json`, read only |
| `--known <file>` | every pool the registry run found, dust included | the copy frozen for RU.1 under `fixtures/risk/universe/`; it has to be the same run as the registry, or the command stops |
| `--discovery <file>` | DexScreener's pairs | the newest `pools-dexscreener-*.jsonl` of `RISK_DATA_DIR`; with none, the discovery column says so |
| `--pools <file>` | the chain read of the pools on the routes | the newest `fixtures/risk/venues/route-pools-*.json` |
| `--byreal <file>` | the Byreal probe | the newest `fixtures/risk/venues/byreal-*.json` |
| `--captures <folder>` | captures of `pnpm risk:split-capture --two-hop`: adds the gap to Jupiter by venue (Tables 4 and 4b) | no gap table |
| `--robinhood <file>` | Robinhood Chain from one frozen file, as `pnpm risk:venues-freeze-fixtures` writes it: no database | |
| `--cut <file>` | Robinhood Chain's cut, read with the discovery file of the same stamp; the 28-day flow rows then come from `risk_pool_flow` of the local database | the newest `cut-robinhood-*.json` of `RISK_EVM_DIR` |
| `--no-robinhood` | the Solana tables only | both chains |

## What is measured and what is an estimate

- **Measured.** Where Jupiter routes an amount: the collector's own quote rows. Who owns each pool on those routes, and what a Byreal or PancakeSwap pool held: one chain read. What a registered pool held: the registry run. The swaps of Robinhood Chain's pools: `risk_pool_flow`.
- **Estimates.** Every DexScreener figure: liquidity and 24-hour volume, at most 30 pairs a token, and not the 30 largest. A figure DexScreener did not give prints "no figure", never `$0`.
- **No data** is said in words, with its reason. A venue on no stored route prints "on none of the N routes": that one is measured.

## How a share is counted (`lib.ts`)

The collector's quote row keeps each leg's pool, Jupiter's label, and the two raw amounts. It keeps no mints, and Jupiter's `percent` is the percent of a leg's own token (100 on a second hop that carries 6% of the quote). So:

- **The stock's own legs** are the legs whose stock amounts add up to the quote's, to the raw unit (a sale's `inAmount`, a purchase's `outAmount`). Exactly one set of legs must add up, or the quote gives nothing. A leg's share is its amount over the quote's.
- **A leg through two pools is two legs,** each counted once with its own share: the first by the stock it takes, the second by the dollars it pays. Second hops are the "onward" column. It is never added to the shares, and it does not add up to 100: a path counts once for each pool it crosses.
- **A class's share** at one side and size is the mean over the quotes of that group. Every quote of a group asks for the same dollars, so that is the share of the amount. Over all classes it is 100.
- **The check against the chain:** a stock leg's pool, where its account was read, must hold the quoted stock's mint. The count of legs that fail is printed with the sources; it is zero.

## What each pool is (`classifyPool`)

| Class | Meaning |
|---|---|
| `read:<exit path>` | in the collector's registry. The router uses `direct_usd` and `via_sol`; `via_xstock` is the two hops of RU.11, switched off; `other` is collected and listed |
| `registry:…` | on a program we decode, holding a tracked stock, not in the registry: dust at the registry run, or not found by it (created after). A registry matter, not a decoder |
| `other_market:<program>` | on a program we decode, holding no tracked stock: the second hop's own market |
| `unread:<program>` | owned by a program with no validated decoder here |

What each unread program is, and whether a decoder could reproduce its price from its accounts at all, is in `venue-facts.ts`, each statement with the page it comes from.

## The gap to Jupiter by venue (`replay.ts`)

RU.11's report gives, for each stored quote paired with a capture of our pools, the gap between Jupiter and our router. Here the same pair is run once more for each class the router does not use: our router routes the amount Jupiter did not send through the class, and the class's own legs are added exactly as Jupiter quoted them. The gap that leaves is what our route would have returned had it been given those legs. It is Jupiter's split at the quote's moment, not a route our router chose, so it is an estimate of what reading the venue would bring, not a bound. A leg whose dollars cannot be followed to the end of the route (two legs merged into one, or one split in two) is not replayed, and counted.

## The three freeze commands

They are the only things here that touch the network, and they only read.

| Command | Reads | Writes |
|---|---|---|
| `pnpm risk:venues-freeze-pools` | `getMultipleAccounts` for every pool on a stored route: owner and size; the whole account where the owner is a program we decode or the account has the size of a Raydium pool; the two vaults of such a pool under another program when it pairs a tracked stock. Jupiter's table of program to label and its symbols for the mints read. 5 RPC calls and 3 seconds on 2026-10-07 | `route-pools-<stamp>.json` |
| `pnpm risk:venues-freeze-byreal [pool]` | one Byreal pool account; the list of the program's accounts for that pool, with each one's size and first tick and nothing else; the one array that holds the current tick, whole. 3 RPC calls | `byreal-<pool>-<stamp>.json` |
| `pnpm risk:venues-freeze-fixtures` | the collector's quotes and registry, the discovery file, the Robinhood cut and its discovery file, and `risk_pool_flow` with a `SELECT` | the quote rows of a window, line for line; one stored row for each shape of route; the registry's excluded pools; DexScreener's rows for the tracked stocks; the Robinhood rows |

After `freeze-pools` or `freeze-byreal`: `pnpm exec biome format --write fixtures/risk/venues`, and the tests that pin the old file's figures have to be given the new ones.

## Tests

`pnpm vitest run tests/risk-layer/venues.test.ts`, on the rows frozen under `fixtures/risk/venues/` and on RU.1's and RU.11's fixtures (`frozen.ts` reads them back as the table's inputs, for the tests and for `--fixtures`). Each share is recomputed from a row's own amounts by a reference written apart from the code; the command itself is run on the frozen rows; no test calls the network, the collector's home or the database.

The tests recompute the frozen window's tables. The tables in the plan are the same functions over every stored quote, which is in the collector's files and not in the repository.
