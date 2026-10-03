# Research notes

The notes in this folder are the evidence behind `../HANDOFF-VAULT.md` and `../DESIGN-VAULT.md`. They were written on Oct 1, 2026, before the brand strategy on the `design` branch, and are kept as written.

They use earlier words. Read "personal basket" as plan, "community index" or "index" as shared portfolio, "creator" as the author of a shared portfolio, and "risk layer" as Bearing.

- `vaults/decision-memo.md`: why each plan gets its own vault, and what the vault checks.
- `open-questions/`: wallets, limits on authors, the launch shelf, the agent surface.
- `design-v2/`: the nine notes and the review log behind the second design, a prototype of the rules that cut a plan, and the quoter scripts used to measure exit cost on the EVM chains.
- `solana-liquidity.md`: what the main Solana tokens cost to buy and sell at four sizes.
- `test-networks.md` (Oct 2): what exists on Solana devnet, Robinhood Chain's test network and Base Sepolia, and what we bring so the same vault code runs there.

Eleven earlier notes were left out of the repo because the design overtook them (vault feasibility per chain, precedents, the keeper, the price reference, the test-rig write-ups). The notes here still cite some of them by file name; Thom has them.

## Where the design later went another way

The notes are kept as written, so some of what they say was overtaken. `../DESIGN-VAULT.md` is the reference.

| The notes say | The design says |
|---|---|
| Pyth prices on Solana, so every launch portfolio can be rebalanced automatically (`open-questions/launch-shelf.md`) | Free tiers only. Kamino Scope's free prices cover ten stock tokens, so automatic rebalancing on Solana covers only portfolios built from those ten |
| Eight launch portfolios, one of them meme tokens (`open-questions/launch-shelf.md` and its seed file) | No meme tokens at launch. "The 500" holds one asset, so it is a single-asset portfolio outside the registry. A five-stock portfolio of Scope-priced tokens is proposed for the Solana demo |
| A deposit cap per vault during the hackathon (`vaults/decision-memo.md`) | No deposit cap |
| Turnkey as the fallback for sign-in (`open-questions/wallet-providers.md`) | Turnkey is no longer free; the fallback is still to be decided |
| About twelve MCP tools and an optional paid endpoint (`open-questions/agent-native.md`) | Seven tools, no paid endpoint |
| Anchor 1.2 with a generated client, the keeper on a scheduled GitHub workflow, a multisig for the upgrade keys (`design-v2/` notes) | Anchor 0.31.1 with hand-written builders, the keeper run locally while testing and on a small VM at deploy, one disclosed key per chain for now. `design-v2/review-log.md` records why |
| US visitors blocked by location (`design-v2/web-app.md`) | No location block; the terms say the product is not for US persons |
| Seven limits on authors, with a 10-point cap per asset and a rolling weekly counter (`open-questions/creator-limits.md`) | Four: 3 to 12 assets up to a ceiling each, one version per 48 hours, 20% moved per version, the 48-hour notice |
| A plan placed over several chains: a vault per plan per chain, a three-chain buy, overflow to the same asset on another chain (`vaults/decision-memo.md`, `design-v2/personalization-ai.md`, `design-v2/wallets-signing.md`) | A plan lives on one chain, the chain of the person's wallet. The product still runs on several chains |
| Tiers set from price impact alone, and The Seven holding the Tesla token at 14.28% (`open-questions/launch-shelf.md` and its seed file) | Bearing's measured exit numbers decide what an asset may weigh; the tiers are a labelled fallback where nothing is measured. Measured, the Tesla token's cap is near 6%, so a launch portfolio that holds more changes before it is published |
| Storm Cellar, with 35 to 40% in the S&P 500 token, as the default for a goal to protect (`open-questions/launch-shelf.md`) | A plan whose goal is to protect holds no stock tokens: dollar yield, gold and cash only |
| A new version of a followed portfolio takes effect 12 hours after it is published (`design-v2/` notes, `open-questions/creator-limits.md`, `open-questions/agent-native.md`) | 48 hours |

