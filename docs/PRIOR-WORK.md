# PRIOR-WORK.md — disclosure

Per the Colosseum rules, only work done inside the window (Sep 14 – Oct 12, 2026) is judged and prior work must be disclosed. Everything in this repository was written from Sep 30, 2026 onward. Reused prior code is committed with the `prior:` prefix and listed below.

## Prior work that exists outside this repository

1. **teiten** — live LatAm stablecoin analytics service: nine EVM chains plus XRPL and Stellar, 1,454 macro series.
2. **Analysis rules and haircut discipline** — the rule set that found naive on-chain yield and volume figures overstated by 2–5.6x.
3. **Tokenized-credit database** — ~13,500 contracts.
4. **Partner relationships** — pre-existing conversations with Nora Finance, Chainless and Picnic. The LOIs themselves are dated inside the window.
5. **solana-vault-standard (SVS)** — Superteam Brasil's open vault standard for Solana (`solanabr/solana-vault-standard`). Thom, who joined on Oct 1, is one of its main contributors. Nothing from it is in this repository yet.

## What is reused in this repository (fill in as it happens)

| Item | Where it lands | Commit(s) | Reused how |
|---|---|---|---|
| Haircut rules (subset relevant to USD yield legs) | `packages/engine/src/assets/haircuts.ts` (D4-PM) | _pending_ | Rule ids and thresholds ported; provenance label `prior_dataset` if any data comes with them |
| Macro dataset (USD/BRL, CDI) | fallback for `fx_observations` only if BCB API fails | _pending_ | V7 passed, so not expected |
| SVS math and oracle crates, naming conventions | the vault program, if `docs/HANDOFF-VAULT.md` is accepted | _pending_ | Vendored with attribution; `prior:` commits |

## Submission-form text (draft)

Prior work reused, all pre-dating the hackathon: (1) teiten, a live LatAm stablecoin analytics service covering nine EVM chains plus XRPL and Stellar with 1,454 macro series; (2) our analysis-rules and yield-haircut discipline; (3) a 13,500-contract tokenized-credit database; (4) pre-existing relationships with Nora Finance, Chainless and Picnic. Everything in this repository (goal parser, registry, solver, schedule and stress engine, risk sheet, policy and rebalance engine, Solana executors, API and UI) was written between Sep 30 and Oct 12, 2026; reused code is in commits prefixed `prior:`.

## Written inside the window, outside the slot plan

`spikes/solana-vault-swap` and `spikes/evm-vault` (Thom, Oct 1, 2026): throwaway test rigs for the vault proposal.
