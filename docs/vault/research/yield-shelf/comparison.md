# The extended shelf against the launch shelf

Oct 6, 2026. What the fixed-income tokens of the extended shelf change in the plans the engine makes, per chain. From `docs/vault/PROMPT-YIELD-SHELF.md`, part (a). The goals are those of `try/prompts/examples.md` and the six of `try/prompts/yield-shelf.md`, every one run on the chain of its section, on both shelves, with the rules parser:

```sh
pnpm -s plan:compare try/prompts/examples.md try/prompts/yield-shelf.md --chain <chain> --now 2026-10-06T12:00:00Z
```

Every figure below is **MOCK**. The shelves, the yields and the exit capacities are fixtures: the launch shelf's are written by hand, the extended shelf's yields are figures claimed on a date in the research notes (`solana.md`, `robinhood.md`), and no exit of an added token is measured, so each takes the ceiling of its tier, a labelled fallback (gate `EXIT-SOURCE`). Nothing here is a reading of a market, a forecast or a promise of a return. The same command gives the same tables.

## Solana

Written on `shelf/solana-yield`.

## Robinhood Chain

Written on `shelf/robinhood-yield`.
