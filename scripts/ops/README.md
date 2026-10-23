# scripts/ops

Scripts a person runs against the hosted systems. Each one says at its top what it reads, what it writes and what it refuses.

| Command | What it does |
|---|---|
| `pnpm ops:archive-risk --out <dir> [--dry-run] [--at <time>] [--all]` | Writes the rows older than their window (`risk-retention.ts`) of the tables the database alone holds (today `risk_pool_flow`; `--all`: every windowed table) to `<dir>/<table>/<day>….csv.gz`, deleting nothing; each later run adds only what aged since. `SOURCE_DATABASE_URL` (else `DATABASE_URL`). |
| `pnpm ops:prune-risk [--dry-run] [--archived <dir>]` | Deletes the rows older than their window in batches, then vacuums. A table the database alone holds (pool flow) is cut no further than the archive `--archived <dir>` names, and left whole without one. `DATABASE_URL`. |
| `pnpm ops:install-prune [--archive-dir <dir>] [--importers] [--dry-run-now]` | Loads the launchd job `com.colosseum.risk-prune`: daily at 05:30, the archive of pool flow into `~/tenonfi-archive`, then the prune. `--importers` rebuilds the loop's lending and Robinhood Chain importers, which skip rows older than the window. |
| `pnpm ops:move-db [--dry-run] --record <file> [--at <time>]`, `--recount --record <file>`, `--grants-only` | Copies the app's schemas to another server, the risk tables cut to their window, and checks every table's rows; `--recount` checks afterwards that nothing more was written on the source. `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL`. |
| `pnpm ops:table-sizes [--min-mb 1] [--json]` | Prints each table's size (heap, TOAST, indexes), live and dead rows, average row and average jsonb column, and for pool snapshots how many sides are stored as before (null), as pairs and as objects. Read-only; reads every row of each table it lists, on the server. `DATABASE_URL`. |
| `pnpm ops:copy-token-bars [--dry-run] [--chain <id>] [--days 31] [--max-mb 900]` | Copies the token bars (`market_bars`, `pool = 'asset'`) of the last days from one database to another, with an empty `detail`: the backfill's 30 days from the Mac's local database into the hosted one, once. A second run changes nothing; a row of another source on the target is never touched. Refuses a copy that would take the target past `--max-mb`. `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL`. |
| `pnpm ops:install-hosted-bars [robinhood\|solana] [--evm-dir <dir>] [--list <file>] [--dry-run-now] [--fill-now]` | Loads a launchd job that writes, every hour inside the hourly import's window, only the bars the asset lookups read (gate `HOURLY-BARS`): `com.colosseum.hosted-bars-robinhood` at minute 18, from its own walk of the chain's last hours (`--walk`); `com.colosseum.hosted-bars-solana` at minute 19, from the pool collector's mid prices in the same database (`pnpm risk:assets-mid-bars`). |

The windows and the reasons for them are in `docs/risk/STATE-RISK.md`, "Retention of the hosted tables".

## Where the rows the database no longer keeps live

The collectors write every reading to files under `~/.colosseum/hosted-risk` before the hourly import puts it in the database, append only, and nothing deletes them (no collector or job removes a day file; checked in `scripts/risk/collector/`, `scripts/risk-evm/` and `loop.sh`). Those files are the archive of the tables they feed, so the daily job reads nothing of them out of Neon:

| Table | Files under `~/.colosseum/hosted-risk` |
|---|---|
| `risk_pool_snapshots` | `pools/<day>.jsonl` |
| `risk_asset_snapshots` | `assets/<day>.jsonl` (Solana), `evm/assets/<day>.jsonl` (Robinhood Chain) |
| `risk_lending_snapshots` | `lending/<day>.jsonl` |
| `risk_quotes` | `quotes/<day>.jsonl` |
| `risk_events` | `events.jsonl` |
| `risk_lp_concentration` | `lp/<day>.jsonl` |
| `risk_lending_facts`, `risk_lending_coverage` | `data/lending-history/report/lending-report-<time>.json` |
| `risk_pool_flow` | none: the loop's daily rewalk keeps only its last walk (`evm/history/robinhood`), so the daily job archives these rows to `~/tenonfi-archive/risk_pool_flow/` before the prune |

All of them go back to Oct 6, as the database does. They grow by about 190 MB a day (2 GB from Oct 6 to Oct 16) on the Mac's disk; keep them, and back them up with the archive folder. `RISK_IMPORT_ALL=1 pnpm risk:import` (and `RISK_LENDING_IMPORT_ALL=1`, `RISK_EVM_IMPORT_ALL=1` for the other two importers) puts a file's rows back into a database that keeps everything. None of these scripts prints a database address, and each lifts the server's statement timeout for its own statements (Supabase sets 120 s).

## Giving the freed space back to Neon (DB-STORAGE, Oct 18)

**Putting the change in place, in this order.** (1) Deploy the API: an older API reads the new pairs as no points. Rolling the API back after the new import has run empties the heatmap and the capacity series until the new API is deployed again. (2) Rebuild the refresh bundle on the Mac by hand; `install.sh` would load launchd jobs that compete with the loop's, so build only the bundle, with its flags, into the folder the loop runs it from (`~/.colosseum/hosted-risk`), keeping the old one beside it:

```sh
H=~/.colosseum/hosted-risk
cp "$H/risk-refresh.mjs" "$H/risk-refresh.before-$(date +%Y%m%d%H%M).mjs"
node_modules/.bin/esbuild scripts/risk/collector/refresh.ts --bundle --platform=node --format=esm --target=node22 \
  --tsconfig=tsconfig.json --outfile="$H/risk-refresh.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
```

(3) Rebuild the lending and Robinhood Chain importers and the prune: `pnpm ops:install-prune --importers` (the prune now cuts pool snapshots on the UTC hour, so the oldest row it keeps of a pool is from a full run and no side stored as null loses the curve it repeats).

Since Oct 18 the import stores curves as pairs and an unchanged pool side as null, and lending detail cut to four keys (`docs/risk/STATE-RISK.md`, "What a row stores"). The daily prune deletes the older, larger rows and vacuums, so their space is used again by new rows and the tables stop growing; the files keep their size, and Neon counts the files, until the table's owner runs `VACUUM FULL`. Do it once, after the old rows have aged out: four days after the new import first runs for pool and lending snapshots, seven for asset snapshots. Each statement rewrites one table and locks it while it runs (seconds to a minute; the heatmap and history reads wait), so run it away from the hourly jobs (minutes 10 to 25), with the Neon owner role's direct (not `-pooler`) address, and compare with `pnpm ops:table-sizes` before and after:

```sh
read -rs "DATABASE_URL?Neon owner address: " && export DATABASE_URL; echo
pnpm ops:table-sizes --min-mb 5
psql "$DATABASE_URL" <<'SQL'
set statement_timeout = 0;
vacuum (full, analyze) public.risk_pool_snapshots;
vacuum (full, analyze) public.risk_lending_snapshots;
vacuum (full, analyze) public.risk_asset_snapshots;
vacuum (full, analyze) public.risk_lending_facts;
vacuum (full, analyze) public.risk_lending_coverage;
SQL
pnpm ops:table-sizes --min-mb 5
```

Each rewrite needs free room for the table's new copy (largest about 150 MB), well inside the limit. The reconstructed lending history (`kind like '%\_hourly'`) is never cut and keeps its whole rows in `detail`, which nothing reads; a person may cut it to the same four keys before the `VACUUM FULL` (it changes stored rows, so it is a person's call):

```sql
update public.risk_lending_snapshots
set detail = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(detail) e(k, v)
              where k in ('symbol', 'debtSymbol', 'supplyApr', 'borrowApr'))
where kind like '%\_hourly';
```

## The asset lookups' data on the hosted database (Oct 21)

The asset lookups (`GET /v1/assets/{id}/facts`, the conversations' `asset_profile`, `asset_price_history`, `asset_pools`) are deployed, but the hosted database held none of their rows: on Oct 21 `robinhood:nvda` answered an empty profile and 720 hours not collected. The two tables are windowed now (`risk-retention.ts`: `asset_observations` 7 days, keeping the plan's rows and 41 days of exchange rates; `market_bars` 31 days, archived like pool flow), and the hosted database keeps only the bars the lookups read (`scripts/risk/assets/lookup-rows.ts`). In this order, from a checkout of `staging` with this change and `pnpm install`:

1. **Room.** `pnpm ops:table-sizes --min-mb 5` against the hosted database. The copy adds about 100 MB, the metrics about 3 MB a day for seven days, the hourly bars a few MB.
2. **The prune knows the two tables** (Thom's Mac): `pnpm ops:install-prune`, which rebundles the archive and the prune with the new list. Until then both tables are kept whole.
3. **The profile** (Thom's Mac, beside the hosted collectors): `zsh scripts/risk/assets/install-job-solana.sh --hosted` and `zsh scripts/risk-evm/install-assets-job.sh --hosted` (its discovery file is the hosted loop's, `~/.colosseum/hosted-risk/evm`, unless `RISK_EVM_DIR` names another folder). They load `com.colosseum.hosted-assets-solana` (minute 21) and `com.colosseum.hosted-assets-robinhood` (minute 17), inside the hourly import's window so the database wakes no more often. Since Oct 22 (gate `ASSET-METRICS` amended) they read only the rows the lookups answer for (about 100 Solana and 46 Robinhood Chain rows), their daily parts once a day (SOL's supply among them), and touch the database from about :10 to about :25 UTC (checked once a phase, so a last query can land just after :25): the slow reads stop at :23:30 and the next hour reads what they did not reach, a run past :25 writes nothing. They wait up to two minutes for the network after a wake and otherwise end with one `offline` line; their plists set `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000`. Run both again after pulling a change to them. Check after the next run: `tail -2 ~/.colosseum/hosted-risk/risk-assets-solana.log` ends without an error, and the facts below show a profile.
4. **The 30 days of token bars** (the Mac whose local database holds the backfill, Rodrigo's): `read -rs "TARGET_DATABASE_URL?Neon tenonfi_api address: " && export TARGET_DATABASE_URL; echo`, then `SOURCE_DATABASE_URL=postgres://colosseum:colosseum@localhost:5433/colosseum pnpm ops:copy-token-bars --dry-run`, then the same without `--dry-run`. Rehearsed on Oct 21 into a fresh local database: 24,059 Robinhood Chain and 42,934 Solana rows, 100 MB with the indexes; a second run inserted and replaced nothing. Every day this waits, a day of the 30 ages out unseen: the backfill ends on 2026-10-13 (Robinhood Chain) and 10-15 (Solana).
5. **The hourly bars** (Thom's Mac; gate `HOURLY-BARS`): `pnpm ops:install-hosted-bars --dry-run-now --fill-now`, then `pnpm ops:install-hosted-bars solana --dry-run-now --fill-from-files` (counts only), then `pnpm ops:install-hosted-bars solana --fill-now --fill-from-files`. Robinhood Chain (minute 18): the cut and the universe file are read from `~/.colosseum/hosted-risk/evm` unless `--evm-dir` names another folder, and the stock list is the hosted loop's own (`~/.colosseum/hosted-risk/evm-work/scripts/risk/universe/robinhood.json`, the cut of Oct 6 with IBM) or else the repository's, the first whose cut is in that folder (`--list <file>` names one); it refuses to load when no list's cut is there, naming each, when the universe file is missing, or, with `--fill-now`, the loop's swap history. Its own runs (`--dry-run-now`, `--fill-now`) go before the agent is loaded: on Oct 22 the dry run's first walk still held the walk's lock when the 13:18 run came. The load is the script's exit trap's, so a failed run, a Ctrl-C or a kill never leaves the job unloaded. Both jobs wait up to two minutes for the network after a wake, and a run with none ends with one `offline` line, not a crash; an error that reads as the network's with the hosts answering (a refused connection, a TLS error) is still a crash. Each run walks the Swap events since its last run on the chain's public endpoint into `~/.colosseum/hosted-risk/bars-walk/robinhood` (its own folder, about the last 30 hours, up to about 600 MB; the loop's `history/` is never touched), and writes the complete hours no earlier run wrote: the token bars and each token's top five pools' bars, the pool bars older than two days deleted. Measured on Oct 21: an hour of the chain is about 40,000 blocks and 25,000 swaps, 16 RPC calls, 7 s; the first run walks 30 hours (a few minutes) and writes about the last 24. A scheduled run outside :10 to :25 UTC of the hour it started in writes nothing (`--write-window 10-25`, Neon's window; Solana's job too) and the next run writes those hours, so the first run, or a run on a Mac waking late, may write an hour later; a crash mid-run leaves the folder readable (files written whole, a half line dropped). `--fill-now` runs once over 720 hours from the loop's rewalk, so the days between the copy's last (Oct 13) and the hourly job's first are written too (the rewalk reaches back about 28 days); install the hourly job the same day as the fill, or the hours between the rewalk's end and the first run's 24 stay missing until they age out. Solana (minute 19): the token bars of the last six complete hours from `risk_pool_snapshots` (`mids-0.1`: one USDC pool of tier A or B an hour, the deepest; close, high and low, no volume); `--fill-now` builds the 96 hours of snapshots the database keeps, and `--fill-from-files [dir]` (once, after it) the hours between the copied backfill's last bar (Oct 15 23:00) and the first whole hour of those snapshots from the collector's own day files (`~/.colosseum/hosted-risk/pools/<day>.jsonl` unless a folder is named; the same rule, the same readings: rehearsed on Oct 21, the files and the database gave 1,102 identical bars; about 3 million lines read in seconds). Without it, Solana's 7- and 30-day windows answer `not_collected` until the days between age out of them. Logs: `~/.colosseum/hosted-risk/risk-hosted-bars-robinhood.log` and `risk-hosted-bars-solana.log`.
6. **Check:** `curl -s 'https://tenonfi-api.onrender.com/v1/assets/robinhood:nvda/facts?window=30d'` shows `price_history` facts (close, high, low, volume) and a `profile`, where it showed `not_collected`; `curl -s 'https://tenonfi-api.onrender.com/v1/assets/solana:tslax/facts?window=24h'` shows close, high and low from the collector's mid prices and the volumes `not_collected`. A window with some hours not collected (an outage of the collector) is still shown while no more than 5% of its hours are missing (1 of 24, 8 of 168, 36 of 720), each figure with `missingHours` and `windowHours`; with more missing, or bars that stop more than two hours short of now, it answers `not_collected` (gate `HOURLY-BARS` as amended 2026-10-22).

## Moving the database from Supabase to Neon

About an hour, most of it the archive and the copy; the site's API is down from step 3 to step 8. The Neon project is `small-wildflower-45388591` (aws-us-west-2, Postgres 18, 1 GB a branch).

**Before.** Install the client tools (pg_dump and psql 18) and fetch the code:

```sh
brew install libpq
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
cd <a checkout of staging with this change> && pnpm install
API=https://tenonfi-api.onrender.com
```

Copy the Neon owner role's connection string from the Neon console, with the direct host (without `-pooler`).

**1. The two addresses**, typed and never echoed: Supabase's `postgres` login through the session pooler (port 5432), and Neon's owner.

```sh
read -rs "SOURCE_DATABASE_URL?Supabase address: " && export SOURCE_DATABASE_URL; echo
read -rs "TARGET_DATABASE_URL?Neon owner address: " && export TARGET_DATABASE_URL; echo
```

**2. The two logins** the API and the snapshot worker use, so the move gives them the grants they have on Supabase. Made with SQL they hold only those grants (a role made in the Neon console also joins `neon_superuser`). `\password` asks for each password without showing it; use a long random one, Neon refuses a weak password.

```sh
psql "$TARGET_DATABASE_URL"
  create role tenonfi_api login;
  \password tenonfi_api
  create role snapshot_worker login connection limit 3;
  \password snapshot_worker
  \q
```

Their addresses are the owner's with the user and password replaced.

**3. Stop everything that writes.** The API writes too (chat turns, orders, publishes, rate limits, its read cache), so it is suspended until it runs on Neon; anything it wrote to Supabase after the move's snapshot would be lost.

- Render, service `tenonfi-api`: Settings, **Suspend Service**.
- On the Mac:

```sh
~/.colosseum/hosted-risk/stop.sh
pkill -f 'colosseum/snapshot/run'      # the snapshot worker's loop first, so it does not start it again
pkill -f '@colosseum/snapshot start'   # then the worker
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/config   # anything but 200: the API is suspended
```

**4. Archive what the move leaves behind** and nothing else holds: the pool flow rows older than seven days (a few MB; the dry run says how much). Every other table's older rows are in the collectors' files (above). The move reads about 0.55 GB out of Supabase.

```sh
export AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # one time for the archive and the move, so nothing falls between them
pnpm ops:archive-risk --out ~/tenonfi-archive --at $AT --dry-run
pnpm ops:archive-risk --out ~/tenonfi-archive --at $AT
```

A run that stopped is run again with the same `$AT`; finished files are not written twice. A file goes back with
`gunzip -c <file> | psql "$TARGET_DATABASE_URL" -c "\copy public.<table> from stdin with (format csv, header)"`.

**5. Move.** The dry run prints every table, what is copied of it and the size it leaves (about 545 MB, near 670 MB just before each daily prune):

```sh
pnpm ops:move-db --dry-run --at $AT
pnpm ops:move-db --at $AT --record ~/tenonfi-archive/move-counts.json
```

The last line must read `every table and sequence matches the source snapshot`. If it stops part way, reset the Neon branch (or drop its `drizzle`, `archive_rh_testnet` and `public` schemas) and run it again: it refuses a target that already holds tables. If a login was missing, create it and run `pnpm ops:move-db --grants-only`.

**6. Point everything at Neon.**

- Render, `tenonfi-api`, Environment: `DATABASE_URL` to the `tenonfi_api` address (**Save only**: the service stays suspended). Leave `DB_PGBOUNCER` unset (or `session`): the direct host is no transaction pooler.
- `~/.colosseum/hosted-risk/env`: the `DATABASE_URL` line, to the `tenonfi_api` address (the prune deletes rows, which `tenonfi_api` may; only the owner may vacuum, so the prune logs that it left that to autovacuum).
- `~/.colosseum/snapshot/db-url` (read by `run.sh` and `run-mainnet.sh` beside it): the `snapshot_worker` address.

Edit each file in an editor; nothing here prints them.

**7. The daily archive and prune, and the importers**, before the loop starts again: the loop's lending and Robinhood Chain importers, as built on Oct 6, would put every older day back.

```sh
zsh scripts/ops/install-prune.sh --importers --dry-run-now
```

It keeps the old importers as `*.before-<stamp>.mjs` and loads `com.colosseum.risk-prune`: every day at 05:30 it archives the pool flow rows that aged out into `~/tenonfi-archive` (beside the move's files) and only then prunes, never a pool flow row past what the archive holds; the other tables are cut at their window, their rows being in the collectors' files. Log: `~/.colosseum/hosted-risk/risk-prune.log`. The dry runs at the end should find next to nothing. The daily job reads about 5 MB a day out of Neon (one day of pool flow, about 0.15 GB a month).

**8. Start again.** Render, `tenonfi-api`: **Resume Service**, then Manual Deploy, **Deploy latest commit**, so the running instance has the new address; wait for Live. Then on the Mac: `~/.colosseum/hosted-risk/start.sh`, and the snapshot worker as before (`zsh -i ~/.colosseum/snapshot/run-mainnet.sh --loop`).

```sh
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/config    # 200
psql "$TARGET_DATABASE_URL" -c "select count(*) from pg_stat_activity where usename = 'tenonfi_api'"   # above 0: the API is on Neon
```

**9. Nothing was missed.** The tables kept whole, counted again on Supabase against the move's counts:

```sh
pnpm ops:move-db --recount --record ~/tenonfi-archive/move-counts.json
```

It must end with `no table changed on the source since the move`. A table it names has rows on Supabase that Neon lacks (a write after the snapshot): stop there and bring those rows across before anyone acts on them.

**10. Check.**

```sh
curl -s $API/v1/config | jq '[.chains[] | {id, missingAssets}]'          # missingAssets null on every chain
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' $API/v1/shelf     # 200
curl -s "$API/v1/shelf?chain=robinhood" | jq '.families | length'        # the shared portfolios, as many as before
tail -5 ~/Library/Logs/tenonfi/hosted-risk.log                            # the loop's runs end without an error
psql "$TARGET_DATABASE_URL" -c "select max(fetched_at) from risk_pool_snapshots"      # within 15 minutes once pools has run
psql "$TARGET_DATABASE_URL" -c "select max(observed_at) from risk_lending_snapshots"  # after the next hourly import (minute 12 on)
psql "$TARGET_DATABASE_URL" -c "select max(fetched_at) from vault_snapshots"          # the snapshot worker, within ten minutes
psql "$TARGET_DATABASE_URL" -c "select pg_size_pretty(pg_database_size(current_database()))"
```

The next morning, `tail ~/.colosseum/hosted-risk/risk-prune.log` shows the first run: the pool flow file it added, then each table's cut and the rows deleted, then `"ok":true`.

**The way back.** Leave the Supabase project as it is until the checks pass for a day. Going back is step 6 with the old addresses, then step 8; whatever was written on Neon since the switch (chat turns, orders, publishes, the collectors' readings) stays on Neon and is not on Supabase.
