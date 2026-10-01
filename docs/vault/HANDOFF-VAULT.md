# HANDOFF: plans held in a vault

*Written 2026-10-01 by Thom, and rewritten the same day in the words of the brand strategy on the `design` branch. Companion to `docs/structurer/HANDOFF-IDEA1.md` (the structurer) and `docs/risk/HANDOFF-RISK.md` (the liquidity and risk layer, "Bearing" in the brand). Thom and Rodrigo spoke on Oct 1 and the work continues on this basis; the decisions are listed below and in `docs/GATES.md`. Technical design: `DESIGN-VAULT.md`. How it maps onto the code in this repo: `CONVERGENCE-VAULT.md`. Review of the current code: `AUDIT-VAULT.md`. Research behind it: `research/`.*

The positioning stays as it is: tell us what your money needs to do, and the product builds the portfolio that gets it there, with an exit plan before it invests and every joint in sight. This document is about what it takes to make each part of that sentence hold on chain, for every asset, on more than one chain.

The name is provisional (Tenonfi on the `design` branch), so this document says "the product".

## What this adds

Three things around the engine and Bearing, and two smaller ones.

1. **A vault per plan.** The person's portfolio sits in a vault only they can withdraw from. The limits they approved are checked by the vault itself, on chain, every time the agent trades.
2. **Shared portfolios.** Anyone can publish a portfolio for others to start from. Nobody buys one as it is: it goes through the goal and the limits like any other input, and comes out as a plan made to measure.
3. **Robinhood Chain and Base, next to Solana.** A wider shelf for the solver to cut from, and the chains where partners are.
4. **Sign-in with a passkey,** for the person who has a goal and no wallet.
5. **A surface for agents:** an API, an SDK and an MCP server over the same logic.

## Why, line by line of the positioning

| The positioning says | What is true in the code today | What this adds |
|---|---|---|
| "the agent builds and manages the portfolio" | The policy is a token approval to a key on the server. Only the approved amount is enforced on chain. It runs by itself for USDC, USDY and syrupUSDC; stocks and Kamino ask for a signature every time | A vault that checks every agent trade itself: only the plan's assets, a fair price against a reference, toward the target, a weekly loss limit, market open. It works for stock tokens, and it holds if the server is compromised |
| "an exit plan before it invests" | Bearing measures what a sale costs, by size and hour of week | An exit that needs no sale at all: the owner can take the tokens themselves out of the vault at any time, with the agent paused, the market closed or our servers down. The measured exit plan is shown next to it |
| "every joint in sight" | Source, method and time on every number; a reason per leg; an explorer link per transaction | The limits themselves are on chain and readable in numbers. Every agent trade is logged with what it spent, what it received and how much of the weekly limit it used |
| "anyone with a specific goal for their money" | Wallet connect only; goals in reais; eight Solana assets | A passkey wallet; dollars, with the reais logic kept behind a parameter; stocks, gold, dollar yield and crypto across three chains |
| "consumer apps as distribution" | Nothing brings a person back or gives them something to share | Shared portfolios: people publish, others start from them, and every one of them gets the exit plan |

## What a person does

1. **Says what the money needs to do,** in a sentence or a short form: the outcome, the amount, the date, how much risk, cash they must be able to reach. They connect a wallet or create one with a passkey, so the product sees what they already hold.
2. **Confirms the sheet.** The goal and the limits, written down and editable.
3. **Sees the plan before anything moves:** each line with its reason ("less Nvidia because you already hold $4k of it", "20% in dollar yield because you need the money in 18 months"), and the exit plan at their size: how much they can get back, how fast, at what cost.
4. **Buys in one tap.** The trades run on each chain and the assets land in their own vault.
5. **Stays on track.** The product shows drift and whether the goal still lands. Rebalancing takes one tap, or runs by itself inside the limits.
6. **Can start from a shared portfolio, or publish their own.**

When a goal can't be met as set, the product says so, shows the gap and the ways to close it. It never pretends a goal works.

## Shared portfolios

A shared portfolio is a named, versioned list of assets and weights that anyone can publish. In the positioning's terms it is an idea. Here an idea is an input, never the product.

- **It always goes through the goal.** Choosing one sets the themes on the sheet. The goal, the limits, what the person already holds and the exit plan then decide how much of it they hold, and the plan says why, line by line. Someone who only wants to hold it still gets the sheet, the reasons and the exit plan at their size.
- **Following.** When its author publishes a new version, the people following it are told, with the change. They rebalance with one tap. A switch, off by default, lets the vault do it by itself: after a 48-hour delay, inside the vault's limits, and never into a new asset without the owner's tap.
- **Limits on authors.** 3 to 12 assets, each between 2% and 50%; no weight moves more than 10 points per version; one version a day. An asset's maximum weight is capped by its measured exit capacity, from Bearing.
- **Why have them.** They are the reason to come back and the thing to share, and each one carries the exit plan to whoever picks it up.
- **At launch:** about six, serious assets only, no meme tokens. Names and weights are drafts in `research/open-questions/launch-shelf.md`.

## What changes the plan

Each input has to change the plan visibly. If it doesn't, it's a template.

| Input | What it changes |
|---|---|
| Goal: grow, earn income, or protect | The mix between stocks, dollar yield and gold, and what the main chart shows |
| Amount | Which assets are allowed (some are too illiquid at larger sizes) |
| Time frame | How much sits in dollar yield, and how it shifts as the date gets closer |
| Risk comfort | Caps per asset and per issuer |
| What you already hold | The plan fills gaps and avoids doubling up |
| Themes you believe in | Which shared portfolios it starts from |
| Where you live | Which assets you can legally hold |

## What carries over from Nexa

1. **The input.** One sentence about the goal, turned into criteria for risk, term, cash flow and liquidity.
2. **The output.** Five things on every plan's card: money needed today, expected return, total term, cash-flow pattern, and when you can get out. Two people's plans look different at a glance.
3. **The line.** "A product built for one client used to need R$10 million. Now it starts at R$100."

Nexa's own shelf is Brazilian credit, off chain. This shelf is global assets, on chain, in the person's own vault.

## The vault

Decided from the research in `research/vaults/decision-memo.md`:

- **One vault per plan, per chain, owned by the person.** Only they can deposit or withdraw. There are no shared pools.
- **A plan can hold shared portfolios, one level deep.** The vault holds only the underlying assets. A shared portfolio lives on one chain; one that spans chains is a set of per-chain versions under one name.
- **The vault checks every agent trade itself:** only assets in the plan, what was bought must land back in the vault, the price must be close to a reference price, losses are capped per week, and the owner can always switch the agent off and withdraw the tokens directly.
- **The vault is our own small contract:** one program on Solana and one Solidity contract shared by Base and Robinhood Chain, built on OpenZeppelin's audited library where possible. Both are unaudited, and the product says so. There is no deposit cap.
- **The keeper** that triggers automatic rebalancing is a small service the team runs. Because the vault checks every trade, the keeper does not have to be trusted.

## Chains and assets

| Chain | What it brings |
|---|---|
| Solana | Stock tokens (S&P 500, Nasdaq-100, Nvidia, Tesla), gold, dollar yield at 4–5% |
| Robinhood Chain | 195 stock tokens, bought with the USDG stablecoin on Uniswap and 1inch |
| Base | 10 Coinbase stock tokens (Nvidia, Apple, Meta, Google, Amazon, Microsoft, Tesla, SpaceX and two more), dollar yield |

Checked on Solana (Oct 1): plans of $1k–$50k trade at low cost in the main stock tokens (about 0.07% for a $50k S&P 500 leg). Gold only works up to about $10k per plan. Details in `research/solana-liquidity.md`.

Stock tokens on the two EVM chains exist on mainnet only, so development and tests use a few real dollars. Whether a normal wallet in Brazil can hold them is unconfirmed.

## Where this sits

The positioning's three frames, with what this proposal adds to the third. No product is named here, per the guardrails.

| | An idea turned into a basket | A menu of model portfolios | A goal turned into a plan |
|---|---|---|---|
| Input | A theme | A chosen model | The goal and the limits; a shared portfolio is one more input |
| Rebalanced on | The theme's updates | Drift from the model | Whether the goal still lands, drift, and updates to a followed portfolio |
| Exit plan before investing | No | No | Yes, measured, plus withdrawal of the tokens themselves |
| Who enforces the limits | The operator | The operator | The person's own vault, on chain |
| Chains | One | One | Solana, Robinhood Chain, Base |

## The MVP

What Colosseum's form needs: a live app, a public GitHub repo, a 2–3 minute pitch video, a technical demo video of 3 minutes or less, team backgrounds, the chains and tools used, a go-to-market plan, and disclosure of prior work.

What must work live on mainnet, with real small amounts. These nine things are the MVP:

1. **Sign in two ways.** Connect a wallet, or create one with just a passkey (no seed phrase) that works on Solana, Robinhood Chain and Base. A chain becomes usable once it is funded; the product shows what each chain needs and does not bridge.
2. **Shared portfolios.** At least six on the shelf with real assets, at least two spanning more than one chain.
3. **A plan from a sentence or a form,** with a reason on every line. Three test people must get three visibly different plans.
4. **One-tap buy.** One confirmation places real swaps on all three chains, with a status per leg and a retry if one fails.
5. **The portfolio, across chains.** Holdings read on the three chains, valued correctly (stock tokens carry dividend multipliers), with drift from target.
6. **Rebalance in one tap,** on every chain.
7. **Publish and follow.** Publish a shared portfolio with its version recorded on chain, follow it from a second account, update it, and the follower is prompted to rebalance. Auto-follow is per plan, off by default, and goes live on each chain once that chain's price-check tests pass, Solana first.
8. **The exit plan and the risk sheet.** Every asset has a short, sourced sheet: who issues it, what backs it, how you get out, what could go wrong. Every plan and every shared portfolio shows the roll-up: what it holds, where the risk concentrates, and what it costs to exit at your size. The exit cost comes from Bearing (`packages/risk`).
9. **Built for agents.** An API, an SDK, an MCP server and a skill file over the same logic. Agents propose and the person approves from a link; an agent can also publish a shared portfolio.

One thing is not in the MVP and should be said plainly: **the odds.** The positioning says the plan is managed on the odds of reaching the goal. Today the engine gives a verdict and a gap, not a probability. Until an estimate exists, the product says "On track", "Watch" or "Off track" with its method and date, as the guardrails ask.

After the MVP, in this order:

- Profiles for authors, counts and rankings, author fees.
- Publish a shared portfolio once and sync it to all three chains with Chainlink CCIP.
- A "protected" plan with a floor on the principal at a chosen date.

Out: an adviser view, fiat on-ramps, tax, perps or leverage, Brazilian credit assets.

## The 3-minute demo

Along the narrative arc in `messaging.md`.

1. **Three people, three goals (60s).** Each types what their money needs to do. Three visibly different plans appear, every line explained, each with its exit plan.
2. **One tap, three chains (40s).** One of them buys. Legs settle on Solana, Robinhood Chain and Base, and the assets sit in their own vault.
3. **Starting from someone else's idea (35s).** Pick a shared portfolio, and watch it get cut to the goal.
4. **It stays on track (25s).** An author updates a portfolio; a follower's vault rebalances inside its limits, and the log shows why.
5. **Why us (20s).** The structuring, credit and risk background behind the engine and Bearing; live on mainnet.

## How it gets built

- Day 1: freeze the interfaces: the plan format, the rules that cut it, and one chain adapter every chain implements (read holdings, quote, build trades, track them).
- Days 2–6: parallel build, one coding agent per piece.
- Day 7: integration.
- Days 8–9: real-money rehearsals on all three chains.
- Days 10–11: videos and submission.

What agents can't do, and what therefore sets the pace: funding and testing real wallets on mainnet, recording the videos, and deciding the name and voice. The days, the milestones and the cut order are in `PLAN-VAULT.md`.

## Tests for the first two days

1. Solana: buy and sell $10 of an S&P 500 token and a dollar-yield token through the vault.
2. Robinhood Chain and Base: buy $10 of a stock token on each, and measure what $1k and $10k would cost. If a chain refuses the wallet or is too thin, it shows read-only.
3. Build plans for three made-up people with the real rules. If the three look alike, the inputs need more teeth before anything else gets built.

## Risks

- **Read as "an idea turned into a basket".** If the shelf is the first thing a person sees, the product looks like the frame the positioning rejects. The goal comes first on every screen and in the first minute of the demo; shared portfolios are reached from the plan.
- **A plan built for one person can count as investment advice.** Keep it as software the person controls and show the reasoning for every choice.
- **Stock tokens can be paused or frozen by their issuers** and exclude US persons.
- **Two unaudited contracts with upgrade keys,** built in eleven days, where today the tokens never leave the wallet.

## Decided

- The vault replaces the token approval for automatic rebalancing.
- Shared portfolios are in, with serious assets only at launch.
- Solana, Robinhood Chain and Base from day one. The person funds each chain they want to use.
- Wallet connect or a passkey wallet (Privy).
- The product is not for US persons, and the terms say so. There is no location block and no banner.
- When an author adds a new asset, each follower approves it with a tap. A new version takes effect for followers 48 hours after it is published.
- On Robinhood Chain, only the stock tokens with a price feed (about 36 of 195) can be rebalanced automatically. The rest are one-tap only.
- The team holds the upgrade keys for the vault contracts for now, one disclosed key per chain, and the product says so.
- Free tiers only, apart from about $10 of model credit for reading the goal sentence. On Solana the price reference is Kamino's free onchain prices.
- Author limits as in `research/open-questions/creator-limits.md`.
- The sign-in button says "Sign in" and opens a choice of passkey or wallet.
- The keeper runs on a founder's machine while testing, and on a small VM at deploy.
- The work lands in short-lived branches in this repo, each with a pull request into `staging`; `staging` goes into `main`. Thom and Rodrigo are both on the team, in the prior-work note and in the registration.
- The structurer is the engine that cuts the plan, and Bearing is the source of the exit plan.

## Still open

1. The name.
2. The $10 mainnet tests on the three chains (`spikes/`), and the Privy app.
3. Where the Bearing data runs for the demo: a hosted collector or a dated snapshot.
4. The decisions in `DESIGN-VAULT.md`, section 17.
5. Two lines of shipped copy that the vault touches. `DISCLAIMER` says "the decision and custody are yours", and `DISCLAIMER_SHORT` says "Policy in your wallet, not a fund." Only the owner can withdraw from a vault, so the first stays, with the "unaudited, team holds the upgrade keys" notice beside it. The second needs a word from Rodrigo, since the assets move from the wallet to a vault the person owns.
6. Auto-follow against the voice rules, which say rebalancing is "never to follow a theme or a rate" and that the agent "proposes and explains". What it does: off by default; the person sees an author's change 48 hours ahead and can refuse; then the vault copies it inside its own limits, without re-checking the person's goal. Label: "Rebalance without asking when the portfolio I follow changes". Thom's decision is to keep it this way; the 48-hour notice is the proposal, and the person can refuse.

The research notes under `research/` were written before the brand strategy. They say "basket" and "community index" where this document says plan and shared portfolio.
