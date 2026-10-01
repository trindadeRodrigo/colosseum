# GATES.md — decisions with cut-offs

Source: `docs/structurer/PLAN.md` §5. Status is one of `OPEN | PASSED | FAILED | DECIDED`. A slot that needs a gate stops if the gate is `OPEN` (PROMPT-BUILD 2B).

| Gate | Status | Cut-off | Default if nothing arrives | Decided on | Facts / outcome |
|---|---|---|---|---|---|
| **POLICY** — rebalance mechanism | **DECIDED: A (delegated) for Token-program legs; user-signed for Kamino and xStocks** | D2-PM, Fri Oct 2 18:00 BRT | C | 2026-09-30 (two days early) | Proven on mainnet: user-signed setup [`3PCcL9bP…YoEu2y`](https://solscan.io/tx/3PCcL9bPKnD7WdwMgGCLPoVCqfecp5BuV7cqA5UCDzAWsGgzzuRE6eGLeR2GoNcJy6g8HGmPmEYYZo1oJPYoEu2y) (approveChecked 3 USDY to agent + 0.02 SOL fees), then **agent-only** rebalance [`351mCDMs…7qzVMa`](https://solscan.io/tx/351mCDMsrA4FYk9cmYRDc9wZ5Z4UAG1fLdBKGpzY2Urenk2tcRkBcuQgpkbCPxFR8QZbeo7UkFEYotZeL27qzVMa): delegate transfer → Jupiter swap → output to the user's ATA, one signer (`B3ui…io1T`), user USDY 4.37→2.37, syrupUSDC 4.22→6.15, agent holds 0 tokens. Scope: USDC, USDY, syrupUSDC (Token program). Kamino deposits/withdrawals need the owner signature; xStocks (Token-2022 transfer hooks) stay user-signed in this window. Video wording: "USD yield legs rebalance under limits you approved; the Kamino and stock legs ask for your signature." Off-switch: `buildRevokeTx`. Failure modes found and fixed: transactions without a compute-unit price were dropped (two timeouts); Jupiter `swap-instructions` returns a unit limit only unless a priority fee is requested. |
| **G-NORA** — BRS mint approach | OPEN | D6, Tue Oct 6 18:00 BRT | **FAIL**: BRL leg labelled "BRS mint via Nora: integration in progress", excluded from execution | — | D1 facts: BRS (`BRSxQRUa…ZtUo`) is a plain Token-program mint, 6 decimals, ~2,885 BRS in circulation on Solana (V6); **not routable on Jupiter** (`TOKEN_NOT_TRADABLE`, V2), so primary mint is the only path. Founder to confirm: who mints, API/auth/sandbox, accepted inputs and chain, min/max, fees, FX source and spread, settlement, redeem path, KYB for the demo wallet. |
| **EVM-S1** — EVM adapter | OPEN | D5-AM, Mon Oct 5 | **Skip** | — | Build only if a partner confirms a pilot chain in writing, `docs/structurer/STATE.md` has no `slipped` rows, and G-Nora has not passed. |
| **SOLVER** — form | OPEN | D5-AM, Mon Oct 5 | LP (`javascript-lp-solver`) + rules layer; greedy waterfall on infeasibility | — | |
| **FREEZE** — feature freeze | DECIDED | Fri Oct 9 18:00 BRT | — | 2026-09-30 | After the freeze: P0 fixes only (crash, wrong number, failed mainnet path), each with a test; no schema or dependency changes; `main` tagged `freeze`. |
| **B2** — second builder | DECIDED: no | D1-AM | No | 2026-09-30 | Solo. `[B2]` marks stay in the plan for a possible later hand-over. |
| **KAMINO-LEG** — SDK vs substitute | DECIDED: klend-sdk | D1-AM | klend-sdk | 2026-09-30 | `@kamino-finance/klend-sdk@12.0.1` loads the main market and reads the USDC reserve on public RPC (V3). Note: it depends on `@solana/kit` 2.x, not web3.js v1. 13.0.1 was published 2026-09-30 and is held back by pnpm's minimum-release-age policy; revisit only if 12.x breaks. |

## Founder items (not build tasks, recorded here when answered)

| Item | Status | Answer |
|---|---|---|
| Discord: can one submission win Solana and Base tracks? | OPEN | — |
| Which chain each LOI partner pilots on (Chainless, Picnic) | OPEN | — |
| Written permission to use partner names or logos in the embed | OPEN | default: unbranded |
| Regulatory position (who carries personalised-allocation liability) | OPEN | default: disclaimer on plan view, API docs, README, video |

## Decided on 2026-10-01 (Thom, after speaking with Rodrigo)

From `docs/vault/HANDOFF-VAULT.md`. Either founder can reopen one.

| Gate | Status | Decision | Facts |
|---|---|---|---|
| **CUSTODY** — who enforces the policy | DECIDED | A vault per plan per chain (Anchor program on Solana, contract on EVM) in place of delegation to the agent key for automatic rebalances | POLICY A covers USDC, USDY and syrupUSDC only, and the only on-chain limit is the approved amount. A program-owned vault bought SPYx through Jupiter CPI on a validator with cloned mainnet state on Oct 1 (`spikes/solana-vault-swap`); mainnet run still to do. |
| **SHARED-PORTFOLIOS** | DECIDED | Public, versioned portfolios anyone can publish. A plan can start from one or follow it, always through the goal and the limits. Serious assets only in the MVP | `docs/vault/research/open-questions/creator-limits.md`, `launch-shelf.md` |
| **EVM-S1** — EVM adapter | DECIDED: build | Build it for Robinhood Chain and Base, with the same vault | `spikes/evm-vault` passed on a Robinhood Chain fork; Base passed as a read-only simulation |
| **B2** — second builder | DECIDED: yes | Thom joins; split in `docs/vault/HANDOFF-VAULT.md` | Engine, risk layer and brand stay with Rodrigo |
| **SIGN-IN** | DECIDED | Wallet connect or a passkey wallet (Privy) | `docs/vault/research/open-questions/wallet-providers.md` |
| **BRANCH** — where the vault work lands | DECIDED | The vault work builds on `main`, in short-lived branches per stream | Rodrigo merged the risk layer and the design system into `main` on Oct 1 |
| **RISK-DATA** — risk data for the demo | OPEN | Hosted collector or a dated snapshot | The collectors run under launchd on one machine today |
| **NAME** | OPEN | Tenonfi is provisional on the `design` branch; final after the trademark, domain and native-speaker checks | — |
| **LICENCE** | DECIDED | Apache-2.0 | The repo was public with no licence |
