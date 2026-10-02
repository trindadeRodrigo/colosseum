# HANDOFF: Idea 1 build for the Colosseum video

*Written 2026-09-30.*

**Purpose.** This file is the full context for writing a build plan. The founder will ask another model to write a prompt from it, and that prompt will generate the day-by-day plan. Everything a planner needs is here. It does not assume access to earlier conversations.

**Supporting files:**
- `eval/FINAL.md`: the decision and scoring.
- `eval/FEASIBILITY.md`: dependencies and the half-day plan written for the original idea.
- `eval/IDEA1-MARKET.md`: competitors, the asset table and sizing.
- `eval/PANEL.md`: one-liners and the misreadings to avoid.

---

## 1. The situation in one paragraph

The founder is entering the Colosseum Crypto World's Fair hackathon.
- **Dates:** online, Sept 14 to Oct 12, 2026. The deadline is **11:59pm PT, Oct 12**.
- **Tracks:** the primary track is Solana ($100k across the top 10 and an accelerator path). They are also entering the Superteam Brasil track ($5k). The Base track is possible if a partner pilots there.
- **What is judged:** only work done inside the window. Prior work must be disclosed.
- **What judges reward:** companies, not tools. Founder-market fit, insight, product, market, communication, viability and traction.

A multi-agent evaluation compared this idea with a risk-engine alternative. This idea won narrowly, 47.65 vs 46.50 out of 100. Its weakest scores were:
- traction (3/10);
- business viability (4/10);
- the risk that the "agent policy" would be faked in the demo.

Since then the founder has secured partners who change the traction picture (§3). The build now has to prove two things:
1. The product is real: live on mainnet with real money, and not a chatbot in front of a list of yields.
2. The partners can plug it in.

## 2. Product definition (post-evaluation, repositioned)

**One-liner.** Goal-based structuring for Brazilian self-custody wallets: goals in reais, portfolios matched across on-chain reais (BRS), dollar yield and, for riskier goals, tokenized stocks, with FX and credit risk priced.

**What it does.**
1. A user states a goal in natural language, in Portuguese or English. Examples:
   - "R$3.000 por mês a partir de 2028, resgate em até 7 dias"
   - "R$250k em 3 anos, aceito risco de crédito"
2. The engine turns the goal into explicit constraints: target cash flow or target balance, currency (BRL), horizon, liquidity window, risk budget, and credit and FX tolerance.
3. It solves an allocation across on-chain assets. Which assets are eligible depends on the goal's risk profile:
   - **Conservative / income:** USD yield legs plus a BRL stablecoin leg.
   - **Growth / higher risk:** the same, plus tokenized stocks.
4. It shows:
   - a **month-by-month cash-flow schedule in BRL**, with stress cases;
   - a **risk sheet** with provenance for each leg.
5. It executes into the user's own wallet. **Funding is USDC or USDT that the user already holds.** Fiat on-ramps are out of scope for now.
6. It then runs as a **policy, not a fund**: allowed assets, weight bands, rebalance rules, and withdrawals only to the user.

**Business model.** B2B2C.
- The distributors are Brazilian self-custody wallets and neobanks. They own the user, the KYC and the regulatory relationship.
- This product is the structuring and risk layer they embed through an API.
- The consumer chat is the demo surface.

**Liability matching with a BRL leg (the core structuring idea).** The goal is in reais and the yield is in dollars. The engine matches each part of the goal to an asset:
- **Near-term BRL obligations** (the next N months of withdrawals, and the liquidity window) are matched with **BRS**, Nora's 1:1 BRL stablecoin. This has no FX risk, but also no yield.
- **Longer-dated obligations** are funded by USD yield legs, and the FX gap is priced.

The BRS share is set by the matching. **BRS is minted directly from USDC or USDT through Nora**, capped by Nora's mint limits. This route is pending confirmation (gate G-Nora, §6). This is the founder's FX-hedging background turned into a product feature, and none of the competitors below does it.

**The insight judges must see.** Competitors sell fixed model portfolios:
- Glider (a16z CSX; non-custodial, policy-based, B2B wallet API on Base);
- Ondo Intelligent Portfolios (BlackRock-designed income and growth tokens, launched Sept 24, 2026);
- Peaks (a Solana agent portfolio app, which placed at Colosseum Frontier).

This product instead solves for a **user-specific cash-flow target in local currency**, with **credit-aware haircuts on quoted yields**. The founder's prior analytics work found that naive on-chain yield and volume numbers are wrong by 2–5.6x. **The product also prices the FX gap between a BRL goal and USD assets.**

That combination is the moat: the founder's background is fixed income, credit structuring, FX hedging and FIDC surveillance.

**Modelling fact the product must handle honestly.**
- On-chain yield assets don't pay coupons. "Income" means **scheduled withdrawals of accrued yield plus principal, under the policy**.
- Stocks and gold pay nothing, so they are **excluded from income goals**.
- **Tokenized stocks (xStocks) are eligible only for growth or accumulation goals with a higher risk budget.** Their risk sheet must show:
  - 0% yield;
  - 24/5 primary redemption (KYC, ~$5k minimum);
  - thinner weekend liquidity;
  - geo-gating of front-ends (the token itself moves freely).

## 3. Partners (the founder handles all partner conversations; the plan should not include outreach tasks)

| Partner | What it is | Relevance | Status |
|---|---|---|---|
| **Nora Finance (BRS)** | A 1:1 BRL stablecoin, live on Solana, Ethereum, Base and Polygon. Only approved, KYB-verified minters can do primary mint and redeem. There is a REST API (`/v2/intents/onramp`, "Issue BRS, settle PIX") with a sandbox. BRS pays no yield. The site shows ~R$100K in circulation. Solana mint `BRSxQRUaGswjLs7ewcH7uXj3r7SgmfKSSLLXyCKHZtUo`. [nora.finance](https://www.nora.finance/) | **BRS is an allocation leg:** the zero-FX-risk BRL asset that matches near-term BRL obligations (see §2). It pays no yield and circulation is small, so its weight is capped. **Intended route: mint BRS directly from USDC or USDT through Nora** (primary mint, not a DEX swap). Feasibility and approach are **pending the founder's conversation with Nora** (see §6, gate G-Nora). The Pix on-ramp is **out of scope for now** (post-hackathon). | Founder is confident of integration; mint approach to be confirmed |
| **Chainless (Notus)** | A Brazilian self-custody app on ERC-4337 account abstraction, running on EVM chains: Polygon, Arbitrum, Base, Optimism, Ethereum and others. It already offers "global investments, gold, bonds, dollar income" with Pix deposits. [chainless.finance](https://chainless.finance/en/about-us) | A distributor. **EVM, not Solana.** It already sells "dollar income", so position this product as the layer that decides and explains allocations, not as a new list of assets. | LOI (founder) |
| **Picnic** | A Brazilian self-custody app with a Web3Auth wallet per user, a Gnosis Pay Visa card, Pix via BRLA, and a Polygon grant. It plans yield products such as sDAI. [usepicnic.com](https://usepicnic.com/en) | A distributor. **EVM.** | LOI (founder) |

**Consequence.** The engine core must be **chain-agnostic**:
- Solana gets full live execution, for the primary track.
- EVM gets a plan-to-transactions API that a partner wallet signs and executes.

Which EVM chain each partner would pilot on is still **unknown**. That decides whether an EVM adapter is built in-window at all (see §6).

## 4. MVP for the video

The video runs about 3 minutes. The MVP is whatever the video shows working **for real, on mainnet, with the founder's own money plus a few friendly users**.

### 4.1 Hero flow (must be real)
1. **Goal input** (chat, PT/EN). The output is a typed constraint sheet shown to the user and editable: target, currency, horizon, liquidity window, risk and credit budget, FX stance.
2. **Allocation.** The solver allocates across Solana legs. The output is weights and the reasoning behind each leg. The asset universe:
   - **USD yield:** Kamino USDC lending, Maple syrupUSDC, Ondo USDY (bought on the secondary market).
   - **BRL:** BRS (Nora). It matches near-term BRL withdrawals and is capped by liquidity.
   - **Cash buffer:** USDC.
   - **Growth, risky profiles only:** 2–3 xStocks, e.g. SPYx or QQQx.
3. **Cash-flow schedule in BRL.** It runs month by month with a base case and at least three stresses:
   - yields fall;
   - BRL appreciates or depreciates against USD;
   - a credit event or redemption gate on the credit leg;
   - for profiles that hold stocks, an equity drawdown (e.g. −20%).
   
   The schedule must show whether the liquidity window holds.
4. **Risk sheet for each leg.** It covers:
   - quoted yield vs haircut yield, with the rule applied;
   - yield source and timestamp;
   - the oracle;
   - the redemption path and time (primary vs DEX, with depth);
   - jurisdiction or KYC gates;
   - issuer and credit exposure.
5. **Funding.** The user's wallet already holds USDC or USDT. USDT is converted via Jupiter where needed. **No fiat on-ramp in the MVP.**
6. **Execution.** Real mainnet transactions into the user's wallet: Jupiter swaps (USDC/USDT into USDY, syrupUSDC, BRS and xStocks) and a Kamino deposit. Small amounts are fine.
   - **BRS: mint it directly from USDC or USDT through Nora.** This is built only after gate G-Nora (§6).
   - Buy xStocks via Jupiter. This must be shown for **at least one high-risk goal**.
7. **Policy plus one rebalance.** A stored policy object (allowed assets, bands, rebalance trigger, withdrawal destination) and **at least one rebalance on mainnet executed under that policy**.
   - Delegated execution without a fresh user signature is the target.
   - If it isn't achievable by the cut-off (see §6), fall back to a user-signed rebalance that the policy checks and proposes. **Say so honestly in the video.** Do not show a simulated button as autonomous.
8. **Monitoring page.** Positions, drift against the policy bands, next scheduled withdrawal, and a projected-vs-actual schedule.

### 4.2 B2B piece (must be real, can be minimal)
- **API** with three endpoints:
  - `POST /goals` → constraints;
  - `POST /plans` → allocation, schedule and risk sheet;
  - `POST /plans/{id}/transactions` → unsigned transactions for the partner's wallet to sign.
- **A public API docs page.**
- **A thin "partner embed" view:** the same plan rendered inside a generic partner frame.
  - Use a partner's name or logo only with that partner's written permission.
  - Otherwise keep it unbranded.

### 4.3 Traction shown in the video (the founder supplies it)
- The LOIs from Chainless and Picnic (named, dated in-window).
- The Nora integration, with BRS live as the BRL leg.
- Live mainnet numbers: wallets, deposited value, rebalances executed.

### 4.4 Explicitly OUT of the MVP
- Pix and fiat on-ramps, and the Nora on-ramp API. This is the next phase after the hackathon.
- Tokenized gold and Hyperliquid legs.
- xStocks in income goals. They are allowed only in growth and high-risk profiles.
- Full EVM execution, unless §6's decision says build it.
- A mobile app.
- Accounts or auth beyond wallet connect.
- Multi-user admin.
- Any claim of "autonomous agent" that isn't live on mainnet.
- The "$5k a month" example, which needs about $1.2M of capital. Use realistic goals: "R$3k a month from ~R$600–700k" (at current USD yield minus the haircut, **to be computed, not assumed**), or accumulation goals such as "R$250k in 3 years".

### 4.5 Acceptance checks before recording
- [ ] Three different goals give three sensibly different allocations, with visible reasoning:
  - income (includes BRS for near-term months);
  - accumulation;
  - high-risk (includes xStocks and credit).
- [ ] The BRL-leg weight changes with the liquidity window and the near-term obligations, and never exceeds its cap.
- [ ] If G-Nora passed, the demo contains one real mainnet BRS mint from USDC or USDT. If it didn't, the BRL leg is labelled as in progress.
- [ ] xStocks never appear in an income-profile allocation.
- [ ] Every yield shown carries a source and a timestamp. No hard-coded APYs appear in the UI.
- [ ] A mainnet explorer link exists for every execution and rebalance shown.
- [ ] The BRL schedule reproduces by hand for one month (a spreadsheet cross-check).
- [ ] Any mocked or sandbox element is labelled as such on screen.
- [ ] The API returns a valid unsigned transaction set for a plan, and a script can sign and send it.

### 4.6 Stretch goals (only after the MVP passes 4.5)
- **S1. EVM adapter** for one partner's chain: one or two legs (for example syrupUSDC or a Morpho vault on Base), returned as calldata through the API. This also qualifies for the Base track, subject to organiser confirmation.
- **S2.** A Pendle PT-USDC leg (Ethereum/Arbitrum) as the fixed-rate, coupon-like asset for income goals.
- **S3.** The policy enforced on-chain rather than in the backend.
- **S4.** The Nora Pix on-ramp (Pix to BRS to the portfolio). This is the start of the post-hackathon roadmap.

## 5. Known dependencies

**Verified 2026-09-30 by the feasibility dossier.** A = available, U = uncertain, B = blocked.

| Dependency | Status | Notes |
|---|---|---|
| Jupiter Swap API | A | Needs an API key. The lite-api was deprecated on 2026-01-31, so use `api.jup.ag/swap/v1`. |
| Kamino deposit (`KaminoAction.buildDepositTxns`, klend-sdk) | A | |
| syrupUSDC on Solana | A | On Kamino and Jupiter Lend. Primary redemption without KYC. |
| USDY | A, secondary market only | Minting needs KYC and $100k, non-US only. Buy via Jupiter. |
| Yield feeds (Kamino API; USDY and syrupUSDC issuer-reported) | U | Store the source and timestamp for every figure. |
| Squads spending limits or session keys for delegated multi-protocol execution | U | Unproven for a multi-protocol policy in this time frame. Squads v5 is "in development". |
| BRS mint from USDC/USDT via Nora (Solana mint `BRSxQRUa…ZtUo`) | **Gated on G-Nora** | Primary mint is limited to approved, KYB-verified minters. It is unconfirmed how this project mints: as an approved minter, through Nora's API, or through a partner minter. The founder confirms this directly with Nora. |
| xStocks via Jupiter (SPYx, QQQx…) | A (U for geo) | Front-ends block US/UK/CA/AU; the founder is in Brazil. Prices move 24/5 and there is thin weekend depth. Use Jupiter quotes for depth-based sizing. |
| USDT → USDC conversion | A | Via Jupiter. |
| FX and rate data (USD/BRL, CDI/Selic) | A | Candidates are public BCB series or the founder's prior macro dataset. |
| An LLM for goal parsing | A | Output must be a validated typed schema. The solver is deterministic, not the LLM. |

## 6. Decisions the plan must schedule (with cut-off dates)

1. **Policy mechanism (by the end of day 2).** Spike delegated execution on Solana: Squads spending limits, token delegate approvals, or a minimal custom program. Pick one, or fall back to user-signed rebalances. **The fallback is decided on a date, not discovered on day 10.**
2. **Gate G-Nora: BRS mint approach.** This is a founder task (a conversation, not development).

   **No BRS-specific development may be scheduled before this gate passes.** BRS-specific work means:
   - the mint and redeem integration;
   - the BRS execution step;
   - the BRS sizing cap and the BRS risk-sheet provenance;
   - BRS tests.

   **The founder confirms with Nora:**
   - who mints: the project as an approved minter, Nora's API, or a partner minter;
   - the API, auth and sandbox;
   - accepted inputs (USDC, USDT) and the chain;
   - minimum and maximum size, fees, the FX rate source and spread, and settlement time;
   - the redeem path back to USDC;
   - any KYB needed for the demo wallet.

   **Before the gate, the engine is built currency-generic.** The solver and schedule support a "BRL leg" as an abstract asset: zero yield, no FX risk against the goal, a parameterised weight cap and a parameterised mint path. This lets BRS slot in without rework. The abstraction is general engine work, not BRS development.

   **After the gate passes,** schedule the BRS work as its own block, about 1.5–2.5 days: the mint call from USDC/USDT, a position record, the risk-sheet entry, the weight cap from Nora's limits, and one mainnet mint in the demo.

   **Latest date for the gate: end of day 6 (Oct 6).** If it isn't passed by then:
   - the video shows the BRL leg in the plan, the schedule and the risk sheet, labelled "BRS mint via Nora: integration in progress";
   - only the USD and xStock legs are executed.

   The plan must stay on schedule whichever way the gate resolves.
3. **EVM adapter, S1 (by day 5).** Build it only if a partner confirms a pilot chain and the core MVP is on schedule.
4. **Solver form.** Keep it small and deterministic: an LP/QP or a rules-plus-optimisation approach over 3–4 legs. It must be explainable in one screen.

## 7. Constraints for the plan
- **Time:** today is Wed Sept 30. The build runs Oct 1–12, about 12 days. **The video must be recorded by Oct 11**, with Oct 12 as buffer and submission.
- **Plan granularity:** half-day slots. Every slot has a concrete deliverable and a check.
- **People:** the founder builds mostly solo, possibly with one more builder. Make the plan work solo, and mark which workstreams a second builder takes. The feasibility dossier suggests they take execution and policy.
- **Founder strengths:** credit, structuring, FX, data pipelines, risk models. **Weaker areas:** consumer UX and Solana execution plumbing. Front-load the unfamiliar work.
- **Build order:** the video is the forcing function, and the product continues after the hackathon. Build it as the product (a real API and a real data model), not as throwaway demo code. The UI can be plain.
- **Required plan contents:**
  - a risk register;
  - the most likely failure point, with its mitigation;
  - a feature freeze date (suggested Oct 9);
  - a video script and shot list slot;
  - the submission checklist: repo, prior-work disclosure, and dated in-window commits.
- **Prior work to disclose:**
  - teiten (live LatAm stablecoin analytics, 9 EVM chains plus XRPL and Stellar, 1,454 macro series);
  - the analysis-rules and haircut discipline;
  - a 13.5k-contract tokenized-credit database;
  - the pre-existing relationships with partners.
  
  Reusing these is allowed. The in-window work must be clearly separable in the commit history.

## 8. Still UNVERIFIED (the plan should not depend on these without a check)
- Current live yields for Kamino USDC, syrupUSDC and USDY. The dossier figures come from aggregators, dated April to September 2026.
- Whether Squads (or an alternative) supports delegated execution across Jupiter and Kamino.
- Everything about minting BRS from USDC/USDT: who mints, the API, fees, limits and settlement. This is pending the founder's conversation with Nora (G-Nora). Circulation is small: ~R$100K on Nora's site.
- xStocks depth at demo notionals, and weekend behaviour.
- Which chain each LOI partner would pilot on.
- Whether one submission can win both the Solana and Base tracks. Ask in the Colosseum Discord.
- The regulatory position on personalised allocation in Brazil: who carries it, the distributor or this product. The founder is raising it with partners. **The MVP must not present itself as licensed advice.**

## 9. Pitch guardrails for the video
- **Lead with the output, not the chat:** the BRL income schedule under stress, and the risk sheet.
- **Say "policy in your wallet, not a fund"** in the first sentence.
- **Have a one-slide answer to "isn't this Glider or Ondo Intelligent Portfolios with a chatbot?"** They sell fixed model portfolios. This product solves a user-specific BRL cash-flow target with credit haircuts and FX pricing.
- **Use Nexa (Brazil) as the analog slide, not the opener.** Its facts:
  - it raised R$25M led by Maya Capital in **July 2025**;
  - "800+" is a count of structured issuances;
  - it launched Genesis on Sept 22–24, 2026, with FIDC wrappers, no on-chain assets and advisor distribution.
- **Claim only what is live or signed.** Label everything else "in discussion".
