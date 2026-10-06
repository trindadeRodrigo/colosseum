# apps/snapshot

The snapshot worker (docs/vault/PROMPT-BUILD-PORTFOLIO.md, slice 1): a worker with no HTTP listener that reads every vault we know on each chain, values it on the chain's own prices, and keeps what it read as one row of `vault_snapshots`, a pass every ten minutes. The portfolio section draws its history from those rows. It reads and never signs.

```sh
CHAIN_MODE_SOLANA=readonly SOLANA_RPC_URL=<devnet node> \
  pnpm --filter @colosseum/snapshot start --once           # one pass over every chain, then exit
  ... --loop [--interval 600]                              # a pass every interval seconds (60 or more)
  ... --dry-run                                            # reads and prints; writes nothing
```

- `--once` or `--loop`, exactly one. With `--once` the exit code is 1 when a pass failed. A flag it does not know stops it: `--dryrun` is refused, not ignored.
- It reads the environment it is started with and loads no `.env` file, as the keeper.
- `DATABASE_URL` is the database it writes to. Unset, it is the local one of `pnpm db:up`.
- What is wrong at start (mainnet, no chain to read, a missing node address, a node of another network, a deploy record it cannot read, a database of another network) is said on stderr and ends it with 1 before any pass.

## Which chains

- `SNAPSHOT_CHAINS`: a comma list of chain ids (`solana`, `robinhood`, `base`). Unset, the worker reads every chain whose `CHAIN_MODE_<CHAIN>` is `live` or `readonly`. `live` means what `readonly` means here: the worker only ever reads.
- A chain on the mock (`CHAIN_MODE_<CHAIN>=mock`, which is also the default for Solana and Robinhood Chain) is read only when `SNAPSHOT_CHAINS` names it, so nothing fills the tables with sample rows by omission.
- A named chain that is `off` is refused. So is an id that is not a chain, and so is starting with no chain at all.
- A real chain is Solana or Robinhood Chain, each from the record its deploy committed: `deployments/solana-devnet.json`, `deployments/robinhood-testnet.json`, and `solana-local.json` or `robinhood-local.json` for `CHAIN_NETWORK_<CHAIN>=local` where there is one. The program or the factory, the price account and the tokens come from the record. `CHAIN_ROUTER_<CHAIN>` and `CHAIN_PRICE_SOURCE_SOLANA` may repeat the record's address and never replace it.
- The node is `SOLANA_RPC_URL` or `ROBINHOOD_RPC_URL`. It is asked which network it is before the first pass, and has to answer the record's genesis or chain id, never a mainnet's.
- Base has no reader for a real network yet: `CHAIN_MODE_BASE=readonly` is refused by name. On the mock it is a chain like the others.
- The flags are read once, by `parseFlags`, as the API reads them. A name under `CHAIN_`, `AUTO_FOLLOW_` or `KEEPER_` that nobody reads is refused as a typo; the keeper's own names (`KEEPER_CHAIN`, `KEEPER_STATE_DIR` and the rest) are known, so one environment can serve the keeper and the worker.

## The local run

```sh
pnpm db:up && pnpm db:migrate

# Solana devnet
CHAIN_MODE_SOLANA=readonly CHAIN_NETWORK_SOLANA=testnet SOLANA_RPC_URL=<devnet node> \
  pnpm --filter @colosseum/snapshot start --once

# Robinhood Chain's test network (46630)
CHAIN_MODE_ROBINHOOD=readonly CHAIN_NETWORK_ROBINHOOD=testnet ROBINHOOD_RPC_URL=<46630 node> \
  pnpm --filter @colosseum/snapshot start --once

# both, every ten minutes
CHAIN_MODE_SOLANA=readonly SOLANA_RPC_URL=<devnet node> \
CHAIN_MODE_ROBINHOOD=readonly ROBINHOOD_RPC_URL=<46630 node> \
  pnpm --filter @colosseum/snapshot start --loop

# no node at all: the mock
SNAPSHOT_CHAINS=solana CHAIN_MODE_SOLANA=mock pnpm --filter @colosseum/snapshot start --loop
```

`CHAIN_NETWORK_<CHAIN>` is `testnet` when unset. Every row read from a test network or a local copy is labelled `sandbox`; every row read from the mock is labelled `mock`.

At start the worker holds the database to the networks of its environment, as the API does at its start: it writes the rows of `chains` (`seedChains`), which every `chain_id` points at, and refuses a database whose row names another network. Devnet and a local validator are both `sandbox`, and a snapshot row does not say which, so one database serves one network. A dry run writes nothing and makes the same check on the rows it reads.

## The mock's sample world

`packages/chain-mock` is a chain in memory, one per process. The worker's mock is not the one the API's mock holds, so a vault a person opened through an API on the mock does not exist on the worker's chain until the worker makes it again. Before each pass (`src/mock-world.ts`):

1. The mock's clock goes to the time of the pass, and each price that is not cash to where it stands in this ten minutes.
2. Every vault the `vaults` table names under the label `mock`, and that the worker's chain does not hold yet, is made: the same owner and plan number (the mock derives a vault's address from the two, so the address is the row's), a deposit of what the row was last worth (a hundred dollars where the row has no value), and purchases at the row's targets. A target the mock's shelf does not list is dropped and its share stays in cash. A row the mock cannot make is said once on stderr and skipped; the rest are made.
3. With no row at all, one sample vault is made for a sample owner: a thousand dollars, four tenths in the mock's SPY, three in its dollar-yield token, two in its gold, one in cash.

What it is: sample owners, sample deposits and sample prices, so the portfolio section can be built with no node. Every row carries `provenance: mock` and `source: chain-mock`.

What it is not:

- It is not the API's chain. What a person does through the API after a vault was first made here (a deposit, a rebalance, a withdrawal) does not reach the worker's copy, and the worker's value of a vault differs from the API's.
- Its prices are not market prices. Each is the shelf's round number moved by the sum of the last day's steps, one step every ten minutes, each step at most 20 bps and taken from a hash of the asset and the ten minutes. A price depends on the time alone, so a worker started again, or run with `--once` from time to time, goes on with the same history. No price moves more than 40 bps in ten minutes or stands further than 28.8% from its round number.
- The mock has a band and no other rule: `loss_cap_bps` and `paused` are null on its rows, and `loss_used_bps` is always 0.
- A worker started again makes its vaults again from the cache as it is then, in cash and then bought at the targets: the amounts start over, the addresses do not.
- The sample vault of step 3 belongs to nobody: no person's portfolio shows it. It is there so that a mock run on an empty database still writes rows. Once the `vaults` table names a vault on the chain, the sample is no longer made, and a worker started then does not read it.

## Which vaults it reads

Only our people's vaults, never every vault the program or the factory holds.

- By address, at every pass: the vaults the `vaults` table names for the chain under the worker's label, and every address the worker has snapshotted or found before.
- By owner, the heavy read (`getProgramAccounts` on Solana, `vaultsOf` and a read of each vault on EVM): for every owner at the first pass after start and once an hour, and at once for an owner the worker has not asked before. The owners are the wallets in `user_wallets`, whoever an order with a confirmed step on the chain belongs to, and the owners the `vaults` rows name. A vault opened outside the app is found within the hour.
- An address with no vault is a `skipped` line and is not asked again until every owner is.

## What it never does

- It holds no key. It loads no signing entry (`@colosseum/chain-*/server`), makes a reader of each real chain and never an adapter, and names no builder, relay, signer or send: `tests/snapshot/reads-only.test.ts` reads the source of this folder and fails on any of them. The one file that builds and lands a transaction is `src/mock-world.ts`, on the chain in memory only, and it may import no real chain.
- It does not run on mainnet. `CHAIN_NETWORK_<CHAIN>=mainnet` stops it at start for every chain, read or not and whatever its mode, with a sentence that names the variable, before a node or the database is asked anything. Both node checks also refuse a node that answers a mainnet's genesis or chain id. That holds until a person says otherwise.
- Nothing it reads is ever labelled `live`. A test network or a local copy is `sandbox`, the mock is `mock`, and a network whose figures would carry another label is refused.
- It writes two tables, `vault_snapshots` and `snapshot_runs`, and at start the rows of `chains`. `vaults`, `orders`, `legs` and `user_wallets` are the API's and are only read.
- It prints no node address, no database address and no ping address: every reason goes through `src/hide.ts` first (each `*_RPC_URL`, `DATABASE_URL` and `SNAPSHOT_PING_URL` by its setting's name, any other `URL: ...` cut), and only an error's message is ever said, never its cause.

## The lines it prints

One JSON object a line on stdout, each with `at`, `chain` and `name` ("Solana devnet", "Robinhood Chain testnet", "Solana (mock)"):

- a vault: `vault` and `outcome`, one of `read` (with `observedAt`, `valueUsd` cut to cents, `blockOrSlot`, `provenance`), `failed` or `skipped`, each with its `reason`;
- an owner whose vaults could not be asked for: `owner`, `outcome: failed`, `reason`. The owner is asked again at the next pass;
- the pass: `pass: done` with `read`, `failed`, `skipped` and `dryRun`, or `pass: skipped` with `alert: true` when another worker's run is open on the chain;
- a failed pass: `outcome: round-failed`, its `reason`, `alert: true`, `failures` in a row and, with `--loop`, `retryInS`.

A pass fails when the chain does not answer (its rules or its asset list cannot be read, no vault at all could be read, or no price at all), when the mock's sample world cannot be brought up to date, or when the database does not answer. One vault that cannot be read, valued or written is a `failed` line for that vault and the others go on. The chain's height (a slot, a block, the mock's second) is read at the start of the pass and kept on every row as `block_or_slot`; a chain that cannot say it within ten seconds gives null, not a failed pass.

Each chain has a loop of its own (`src/loop.ts`, a copy of the keeper's, held equal by `tests/snapshot/loop.test.ts`): after a failed pass the next comes after 15 s, doubled after each failure in a row up to 5 minutes, and the interval returns once a pass goes through. A chain that fails backs off alone while the others keep their interval.

Each pass is one row of `snapshot_runs` per chain, with what it read, what failed and, when the pass failed, why (a dry run opens none). One run is open per chain at a time. A worker that was killed in the middle of a pass left its run open; the next start closes it and says so in the row.

Stopped by SIGINT or SIGTERM, the worker closes its database client and exits with 130 or 143.

## The health check

`SNAPSHOT_PING_URL` (healthchecks.io), optional: a POST after a pass when no chain's newest pass failed, and to its `/fail` after a pass that failed, with ten seconds to answer. The URL is never printed. A post that fails is said on stderr in words of its own (`the health check answered 500`, `the health check could not be reached`) and never stops a pass.

## What a pass costs

Reads go one vault a call today, at most four in flight a chain:

- Solana: about 2 to 3 `getMultipleAccounts` a vault a pass, one more for the prices, one for the rules and one `getSlot`. The hourly read by owner adds one `getProgramAccounts` an owner.
- Robinhood Chain: about 40 `eth_call`s a vault a pass, sent as JSON-RPC batches, about two a priced asset for the prices, about 13 for the rules and one `eth_blockNumber`. The settings and the multipliers are read again for every vault.

A read of many vaults by address in one call is not built on either reader. The Solana reader already reads many internally and the EVM reader could share one block and one read of the settings; neither is public yet, and the EVM reads do not go through Multicall3. With many vaults this is the first thing to build, before the interval is shortened.

## For later

- A batched read by address on both readers.
- A run script and a unit for the worker's machine, as `scripts/keeper/` has for the keeper.
- Base on a real network, when it has a reader.

## Tests

- `src/args.test.ts`: `--once` or `--loop` and exactly one, the interval and its floor, the dry run, a flag it does not know.
- `src/hide.test.ts`: every configured address named by its setting, the longer taken out whole, any other `URL: ...` cut.
- `src/chains.test.ts`, with no connection opened: mainnet refused for each chain and each mode with the variable named, before anything else; the selection (the default, the list, a mock chain only when named, an off chain, an id it does not know, no chain); Base refused on a real network; a missing node said by its variable before any node is asked; the record missing, unreadable or another network's; an address in the environment that is not the record's; a height that cannot be read as null; the keeper's names known.
- `src/mock-world.test.ts`, on `packages/chain-mock`: a vault made at the address another process gave it, with weights near its targets; the approval on an EVM chain; a target the mock does not list dropped; a row the mock cannot make skipped and said once; one sample vault and no second one; the prices moving every ten minutes inside their bound, the same on any worker.
- `src/main.test.ts`: a bad command line, mainnet and no chain each stopping the worker before the database is opened; the chain rows held before the first pass and only checked in a dry run; the database closed after a failed pass; the health check.
- `tests/snapshot/start.test.ts` starts the worker as a process: mainnet stops it with the sentence, a code that is not 0 and no line of a pass, for a chain it reads, one it does not and one on the mock.
- `tests/snapshot/reads-only.test.ts`: the source of this folder names nothing that builds, signs, relays or sends, and takes from a real chain only what reads.
- `tests/boundaries.test.ts`: the worker's row, and nothing `src/main.ts` loads at start reaching a signing entry.
- `src/pipeline.test.ts`, `src/pass.test.ts`, `src/discover.test.ts` and `tests/snapshot/loop.test.ts`: the passes on the mock with the database, the lines and the rows, the discovery by owner, and the loop held to the keeper's. `src/pipeline.test.ts` needs the database (`pnpm db:up`).
