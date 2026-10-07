# Raw arrays for every concentrated-liquidity pool of the tracked stocks

PLAN-UNIVERSE RU.12 (gates `UNIVERSE` and `RAW-ARRAYS`; added the way the price job was, gate `PRICE-JOB`; method `raw-arrays-0.1`). The pool collector writes the raw pool account and tick arrays of the Raydium and Orca pools among the pools that hold 80% of registry TVL: 32 pools on the registry of 2026-10-01, each in the runs where the collector lists the pool's arrays again, which is about half the hours. The 18 tracked stocks have 260 concentrated-liquidity pools. This job records the other 228 every hour, in the collector's file format, into a folder of its own. The API reads both folders (`apps/api/src/pool-recorded.ts`).

No collector file is edited and no running job is reloaded. The job reads the collector's `registry.json` and `cache.json` and never writes under the collector's folders.

```sh
pnpm risk:raw-arrays --plan                                             # what a run would read; no network, nothing written
RISK_RAW_ARRAYS_DIR=<folder> pnpm risk:raw-arrays                       # one run by hand, into a folder you name
pnpm risk:raw-arrays-check <folder> <capture.json.gz>                   # a run's files against the capture it saved
COLOSSEUM_HOME=<temp folder> pnpm risk:raw-arrays-install-job --no-load # rehearsal: bundle and plist, nothing loaded
pnpm risk:raw-arrays-install-job                                        # THE INSTALL (a person's)
```

The source has no default folder: a hand run names one, and stops if it does not. Only a bundle the installer built knows where to write (`<home>/raw-arrays`).

## What one run does

1. **Which pools.** Every pool of the collector's registry, in tier A or B, on Raydium CLMM, Orca or Meteora DLMM, that is filed under one of the 18 stocks of `scripts/risk/universe/solana.json`, or that pairs two stock tokens with the tracked one on the other side (one pool on this registry: TQQQx against SPYx). Less the pools the collector writes itself, by its own rule read from the same registry in the same run. Less the exit paths named in `RISK_RAW_ARRAYS_SKIP`.
2. **Which arrays.** The addresses the collector's `cache.json` lists for the pool (`children`). The job makes no `getProgramAccounts` call.
3. **The read.** `getMultipleAccounts`, 100 accounts a call, one call at a time, through the shared `rpc()` and its backoff: the pool accounts, then the Raydium fee configs and the arrays (`readSplitCapture` of `scripts/risk/lib-split.ts`). A call that fails is made again, three times in all; a call that still fails costs only the pools with an account in it. No call starts after two minutes.
4. **One outcome per pool.** A file, or a line in the run's row with the reason there is none.
5. **The files.** `<folder>/<YYYY-MM-DD>/<HH>/<pool>.json.gz`, UTC, each written beside and renamed. A second run in the same hour replaces the first's files.
6. **The run's row.** Printed to the job's log, then appended to `<folder>/runs.jsonl`. A run that stops, or is ended by a signal, leaves a row too, with how far it got. A run that is given no folder, or one it may not write into, is in the log only.

## A file

The collector's seven keys in its order, then this job's:

| Key | What it holds |
|---|---|
| `pool`, `venue` | The pool address and `raydium_clmm`, `orca_whirlpool` or `meteora_dlmm` |
| `slot` | The highest context slot among the calls this pool's arrays came in |
| `fetchedAt` | When the read ended |
| `head` | The pool account, base64 |
| `children` | Every address the cache lists, in its order, base64; `""` for one the chain did not return |
| `config` | The Raydium fee config the pool account names; `null` on other venues |
| `slotHead` | Context slot of the call this pool's account came in |
| `childrenListedAt` | When the collector listed these arrays |
| `invariantRelErr` | Raydium and Orca: how far the arrays read are from adding up to the pool account; `null` on Meteora |
| `source`, `method`, `methodVersion`, `provenance` | `raw-arrays-0.1`, `live` |

`invariantRelErr` above 1e-9 says the arrays read do not add up to the pool account. At or below it nothing is proven about an array above the price: it is not a test that the list is whole.

## Written, or listed with its reason

Every pool of the tracked stocks is in exactly one place in the run's row: written, not written, left to the collector, or left out by the setting. The row says `accounted: false` and the run exits 1 if the numbers do not add up, or if the registry files a pool of a tracked stock on a venue or in a tier the job does not know (`notUnderstood`).

| Reason | Meaning | The run exits |
|---|---|---|
| `head_missing` | The chain returned no pool account, or one with no data | 0 |
| `no_arrays_in_cache` | The collector's cache lists no account for the pool yet | 0 |
| `no_array_read` | None of the accounts that came back is a tick or bin array of the pool | 0 |
| `decode_failed` | The pool account or an array does not decode with `packages/risk/src/pools`; the decoder's words are kept | 0 |
| `read_failed` | One of the pool's accounts was in a call the RPC did not answer | 1 |
| `read_torn` | The pool's accounts were read more than 300 slots apart (about two minutes): not one state of the pool | 1 |
| `write_failed` | The file could not be written; the error is kept | 1 |
| `run_failed` | The run stopped before its pools had an outcome; the row names the stage | 1 |

A pool that is written can carry a flag, which does not stop the write:

| Flag | Meaning |
|---|---|
| `arraysMissing` | Accounts the cache lists that the chain did not return: kept under their address with no bytes |
| `liquidityCheckFailed` | The arrays read do not add up to the pool account: an array exists that the cache does not list yet, or liquidity in range changed between the two reads |
| `noMid` | A Meteora pool none of whose bins holds anything |
| `configMissing` | A Raydium pool whose fee config was not returned |

The row also says, for each of the collector's own pools, the hours since the collector's newest file of it and in how many of the collector's newest 24 hour folders it has one.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `RISK_RAW_ARRAYS_DIR` | none in the source; always `<home>/raw-arrays` in an installed bundle | The job's folder. The API reads the same variable, with `~/.colosseum/risk/raw-arrays` as its default |
| `RISK_RAW_ARRAYS_ALL` | off | `1`: also record the pools the collector writes itself. Where both folders hold a pool's hour the API reads the collector's file, and this job's if that one does not read |
| `RISK_RAW_ARRAYS_SKIP` | none | Exit paths to leave out, for example `other,via_xstock` |
| `RISK_RAW_ARRAYS_BATCH` | 100 | Accounts in one call |
| `RISK_RAW_ARRAYS_CAPTURE` | none | Also saves what the run read as a split capture, and what the read knew beside it (`<file>.read.json`), for the check. Refused inside the collector's home |
| `RISK_HOME` | `~/.colosseum/risk` | Where the collector's registry and cache are read |
| `SOLANA_RPC_URL` | none | Required: the job stops without it instead of using the public endpoint |

The installer puts the folder inside the bundle, always `<home>/raw-arrays`: it does not read `RISK_RAW_ARRAYS_DIR`. `RISK_RAW_ARRAYS_ALL` and `RISK_RAW_ARRAYS_SKIP` are put inside the bundle from the installer's own environment, so the collector's installer (which rewrites the shared env file) cannot lose them. A line in the env file still wins over the bundle, for all three, and is the only way to move the folder; the API must then be given the same `RISK_RAW_ARRAYS_DIR`.

The job writes only into a folder of its own. It refuses the collector's raw folder and anything inside it, the collector's home and every other folder of it, a folder that holds the home, and a folder whose `runs.jsonl` begins with another job's line, under whatever name the folder is given (a link, another letter case, another spelling of the volume). Trim `runs.jsonl` by whole lines, or delete it.

## Installing (a person's)

```sh
pnpm risk:raw-arrays-install-job                          # the 228
RISK_RAW_ARRAYS_ALL=1 pnpm risk:raw-arrays-install-job    # all 260
```

It bundles `job.ts` with its dependencies and the list of 18 into `~/.colosseum/risk/risk-raw-arrays.mjs`, proves the new bundle starts before it replaces the one that was there (kept beside it as `risk-raw-arrays.before-<time>.mjs`), writes `~/Library/LaunchAgents/com.colosseum.risk-raw-arrays.plist` from the collector's plist template (read, not edited) and loads that one agent at minute 25. It does not write the env file. Run it again after a code change, and after a new list of tracked stocks: the list is inside the bundle.

Around the install, as gate `PRICE-JOB` asks of a new job, so that nothing running is shown to have been disturbed:

```sh
stat -f '%Sm %N' ~/.colosseum/risk/*.log ~/.colosseum/cron.log   # before, and again an hour after: every log has moved on
launchctl list | grep com.colosseum                               # after: ten labels, the new one among them
tail -1 ~/.colosseum/risk/raw-arrays/runs.jsonl                   # after minute 25: pools, notWritten, rpc, seconds, bytes
```

Install it, and install it again, at another minute than 25: the job may be running then.

Remove it with `launchctl unload ~/Library/LaunchAgents/com.colosseum.risk-raw-arrays.plist` and then delete that plist: a plist left in the folder is loaded again at the next login.

## Files

| File | What it is |
|---|---|
| `lib.ts` | The selection, the reader in batches, the outcome of each pool, the bytes of a file, the run's row. No client, no environment, no clock |
| `job.ts` | The hourly job: the reader, the clock and the files |
| `check.ts` | `pnpm risk:raw-arrays-check`: a run's files against the run's capture, as bytes and as the API's reader sees them |
| `install-job.sh` | The installer, with its rehearsal mode |

The tests are `tests/risk-layer/raw-arrays.test.ts`, `tests/risk-layer/raw-arrays-job.test.ts` and `tests/risk-layer/raw-arrays-install.test.ts`; none calls the network. The second runs the job as a process against a server on the same machine that answers from frozen accounts. The third runs the installer under a made-up HOME with a stand-in for `launchctl`; the installer is zsh, so those four tests run where zsh is (the Macs the job is installed on) and are skipped on GitHub's Linux runner. The fixture is `fixtures/risk/raw-arrays/hoodx-strcx-20261007T0431.json.gz`, eleven pools frozen by:

```sh
pnpm risk:split-capture fixtures/risk/raw-arrays/<name>.json.gz --raw-arrays --only HOODx,STRCx
```
