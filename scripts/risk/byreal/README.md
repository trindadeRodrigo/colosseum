# Byreal's pools of the tracked stocks

PLAN-UNIVERSE RU.15. Byreal is the venue RU.13 ranked first among those the risk layer did not read. Decision D4 of `docs/risk/PLAN-RISK.md`: a venue is added only when its decoder passes the validation the four we have went through. This folder finds Byreal's pools, validates the decoder (`packages/risk/src/pools/byreal-clmm.ts`) against the chain and against Jupiter, and lets our own capture and router read those pools behind options that are off unless given. It does not touch the collector or the registry.

Everything here is read-only: no transaction, no key of ours, no database, nothing under `~/.colosseum`. No oracle account is read and no pool price is set against an oracle (gate `ORACLE-VS-DEX`). From a worktree, name the `.env` that holds the RPC: `DOTENV_CONFIG_PATH=<main checkout>/.env`. The commands stop when `SOLANA_RPC_URL` is not set.

| Command | What it reads | What it writes |
|---|---|---|
| `pnpm risk:byreal-pools [out.json] [--md]` | the registry's search on Byreal's program (accounts of 1,544 bytes with a tracked stock's mint at byte 73 or 105: 36 calls), the pools, their fee configs and vaults, and the first 112 bytes of every account each pool owns | the table of pools: tokens, tick spacing, vaults, arrays by kind, fee settings (default `data/risk/byreal/pools-<stamp>.json`, ignored by git) |
| `pnpm risk:byreal-validate <table.json> [out.json] [--quote POOL,…] [--no-quotes] [--max-quotes N]` | (a) every pool of the table and every account it owns; (b) for the pools named, Jupiter's quote through that pool alone, a sale and a purchase at $1,000, $10,000 and $100,000, with the pool account read before and after each | one file with both checks and, for each quoted pool, every byte the comparison needs |
| `pnpm risk:byreal-report <validation.json> [more …]` | those files, no network | the validation's two tables as text, every amount computed again from the bytes in the files |
| `pnpm risk:byreal-freeze-fixture <validation.json> <pool> <out.json.gz>` | one such file, no network | one quoted pool, whole, for the tests (`fixtures/risk/byreal/`) |

Jupiter's key is the collector's. `risk:byreal-validate` keeps 1.4 s between quotes, asks none in minutes 4, 19, 34 and 49 or in the 40 s after them, and stops at `--max-quotes` (24 unless given).

## What the decoder does, said once

- **The two kinds of tick array** are told apart by the account's own first 8 bytes and by nothing else: `c09b55cd31f9812a` is Raydium's fixed array, read by Raydium's reader as it is; `6a8b98247599b838` is the second kind (a 216-byte header with a table of 60 slots, then one 168-byte tick for each slot allocated). An account that is neither reads as null and holds no tick: today a pool owns two such accounts, its bitmap extension and a reward config. An account with one of the two first-8-bytes and another layout throws, and the pool is not built.
- **The fee** is the pool's own rate when it is not zero (byte 393) and its config's otherwise, the same in both directions. It is not computed for a pool with the dynamic fee switched on (bit 4 of byte 1096: the rate comes from two Pyth feeds, which nothing here reads), for one with the decaying fee on (bit 0: the rate changes with the clock and the direction, and no pool of a tracked stock had it on to validate against), or for one with swaps switched off. Such a pool is listed and not built.
- **Two checks run every time a Byreal pool is built** (`byrealClState`, called by `buildPoolSim`): in each capture replayed, each run of the split snapshot with its setting on, each run of the router's report with `--byreal`. *The liquidity check*, exact, in whole numbers: the ticks at or below the price add up to the pool's stored liquidity, and all the ticks add up to nothing. *The arrays check*: the arrays read with a tick in them are exactly the ones the pool's own bitmap names (it sees a missing array whose ticks happen to cancel, which the sums do not; an array further from tick 0 than the bitmap reaches, 512 arrays on each side, is not checked). A pool that fails either is named in the run's `failures` and routed nowhere, and so is one with an array listed and not read. That is the alarm for a change in Byreal's program, and for an array that was not read.
- **Which pools a capture takes** (`pnpm risk:split-capture --byreal <table.json>`): a pool of the table that pairs one tracked stock with a dollar token, holds $1,000 or more at its own price (DU1) and has a fee its own accounts give. The others are in the capture's `byreal.leftOut`, each with its reason.

## Using the pools

```sh
pnpm risk:split-capture <out.json.gz> --two-hop --byreal <table.json>   # the registry's pools and Byreal's, frozen
pnpm risk:routing-gap --router <captures> --quotes <file>               # before: Byreal's pools passed over
pnpm risk:routing-gap --router <captures> --quotes <file> --byreal      # after: routed as dollar pools of their stock
RISK_SPLIT_BYREAL=<table.json> pnpm risk:split-snapshot                 # the snapshot's own setting, off unless set
```

With the snapshot's setting on, the `split-0.1` rows are still computed without Byreal's pools; the rows routed with them (`split-0.3`) go to `SPLIT_DIR/byreal/<day>.jsonl`, a folder no reader of the split rows looks in. The hourly job does not set it.

## Not here

Byreal's pools are not in the collector's registry and are not collected: `scripts/risk/build-registry.ts` searches four programs and is not edited before Oct 12. What that would take is listed in the plan's RU.15 row.
