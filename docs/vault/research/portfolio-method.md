# The portfolio method, and what our solver should change

Oct 3, 2026. Research for the SOLVER gate and for ENG-2. Written from `docs/vault/research/PROMPT-RESEARCH-METHOD.md`. Six research threads ran in parallel, one agent each; the code was read on `staging` at `1b8be80`. Later the same day eleven papers were read in full from PDFs Rodrigo supplied (kept out of the repository); section 8 says what that changed. Section 2.7 was added after Rodrigo's reading: the product is global, so the goal's currency is a parameter, and the stock rule covers the whole shelf. Four decisions of Oct 3 landed on `staging` after the code was read (`ONE-CHAIN`, `EXIT-SOURCE`, `PROTECT-NO-STOCKS`, `AUDIT-BRACES`); where they touch a finding, the text says so. This note changes no code and proposes changes to other documents without making them; the same pull request adds a line to this folder's README and a row to the ledger.

Tags: `[n]` checked today against source n. `[na]` only the abstract of source n was read. `[ns]` only a search-result snippet of source n was seen; the page was blocked or not opened. `[repo]` read in the code. `[run]` computed today (section 2.3). `[audit]` from `docs/vault/AUDIT-VAULT.md`. `[own]` our derivation, not from a source. `[memory]` not checked. Competitor names appear here because this note is internal.

## 1. Bottom line

- **The shape of the solver is right, and the literature says so.** Rules and caps first, a near-term sleeve matched to dated obligations in the goal's currency, haircut yields, a stress table in place of odds, and a model that only fills a form. Each of these has support (section 4.1). The changes below are to what the rules bind on, not to the form.
- **The linear program should go.** With one budget row, one credit row and per-asset caps, the LP is a continuous knapsack that a sort solves exactly `[24]`. On 20,000 random instances it never beat a greedy fill and returned the same weights; on tied yields its answer changed with the order of the inputs in 2,969 of 5,465 cases `[run]`. An LP earns a place only if we adopt caps that overlap (issuer × chain) or one row per withdrawal date `[own]`.
- **Yield ranking is the weak part, and the caps are doing the work.** A point ranking of noisy yields is the "error maximiser" of the literature `[27][28a]`; with caps it is defensible, and only because of the caps. Rank in bands, fill equally inside a band, and fix the yield feed first: the "realised 30d" figure is still two points of a DEX price `[repo][audit]`.
- **Exit cost should bind on every leg, and once more on the whole plan.** Today it caps stocks only; yield legs and the BRL leg are uncapped and the schedule sells yield legs at par `[repo]`. A Brazilian retail holder cannot redeem USDY with the issuer `[62]`, so the pool is the only exit for the leg the solver fills to 40%.
- **The method is the same in any goal currency; only one leg depends on it.** Most goals will be in dollars. A dollar goal needs no currency-matching leg and no FX stress, and its safe sleeve can sit in liquid rate legs that pay. The BRL leg is the special case, not the base case (section 2.7). Today each engine handles one currency: the legacy sheet is reais only and the ENG-2 sheet dollars only `[repo]`.
- **Three candidates should be three objectives, not three risk levels:** most covered, most spread, most carry, all inside the person's stated limits. None may be dominated on the scorecard, none is pre-selected, and the engine returns fewer than three when the limits leave fewer (section 2.4).
- **"Will the goal be met" has an answer with no forecast:** months covered, the funded ratio at a rate the person can hold today, the carry the goal needs beside the carry observed, and the shortfall under named stresses. A probability of reaching the goal is a return forecast whatever the disclaimer `[2][3]`. That argues against the odds estimate in ENG-1; it is question 1 in section 7.

## 2. What to use

### 2.1 What the current solver does, from the code

`solve()` in `packages/engine/src/solver/index.ts`, version `rules+lp-0.1` `[repo]`. It reads the target, `profile`, `liquidityWindowDays`, `riskBudget`, `creditTolerance` and `fxStance`. It never reads `horizonMonths` or `monthlyContributionBrl`.

| Step | Rule | Parameters in `SOLVER_PARAMS` |
|---|---|---|
| 0. Eligibility | `isEligible(asset, profile)`; stocks never for `income`; USDT dropped | none |
| 1. Cash | BRL withdrawals due inside the window, in USD, over capital, plus the floor; capped | `cashFloor` 0.02, `cashMax` 0.2 |
| 2. BRL leg | Under `hedge_near_term`: the next months of withdrawals, less what cash already covers, plus a reserve that grows as the window shortens; capped at the registry cap (0.3). Under `accept_fx`: the reserve only | `nearTermMonths` 6; `brlReserveByWindow` 5% at ≤7 days, 3% at ≤30, 1.5% at ≤90, 0.5% beyond |
| 3. Stocks | `high_risk` only. A budget by risk level, split equally. With a provider: each stock at most min(target, registry cap, `shareOfDepth` × exit capacity at `tau` ÷ capital). A stock that is cut does not hand its share to the other stocks; it falls to the yield legs | `equityShareByRisk` 0 / 0.2 / 0.35; `impactTolerancePct` 1; `shareOfDepth` 0.25 |
| 4. Yield legs | LP: maximise Σ haircut yield × weight, subject to Σ weight = the remainder, Σ credit legs ≤ the credit budget, each weight ≤ its registry cap (Kamino 0.6, syrupUSDC 0.4, USDY 0.4). A missing yield counts as zero | `creditShareByTolerance` 0 / 0.25 / 0.5 |
| 4b. Waterfall | Only when the LP is infeasible (caps cannot absorb the remainder): fill by haircut yield, leftover to cash, which can then pass `cashMax` | none |
| 5. Legs | One sentence of reasoning per leg, built in code | none |

Around it `[repo]`:

- **Haircuts** (`assets/haircuts.ts`): one fraction. For the dollar-yield tokens it is chosen by how the yield was measured, not by what the asset is. Lending rate from the protocol 25%, realised 10%, aggregator 30%; cash, BRL and stocks 100%. syrupUSDC and USDY measured the same way get the same haircut. Credit risk is carried by the credit budget and the cap, not by the haircut.
- **Yield choice** (`pickPrimaryYield`): realised or protocol before aggregator, then the freshest. No age limit.
- **Risk sheet** (`risk/index.ts`): descriptive fields per asset (issuer, exposure, oracle, redemption path and time, gates, depth note) and, with a provider, a liquidity block. No risk tier and no risk score; the liquidity block carries one score, capacity over the leg's size.
- **Schedule** (`schedule/index.ts`): monthly, in reais. Yield legs accrue at haircut rates; stocks, cash and the BRL leg accrue nothing. A withdrawal is drawn from the BRL leg, then cash, then the yield legs pro rata **at par**. Without a provider, stocks sit in that same at-par pool; with one, they are sold last, at their measured exit cost, up to 5%. A frozen credit leg and the BRL leg are never in the pool. Stresses: yields fall 50%, BRL ±20% over 12 months, credit leg frozen 6 months, stocks −20%, liquidity dry (depth × the measured weekend ratio, floor 0.25).
- **Policy** (`policy/`): a rebalance triggers when any asset is outside its band or the largest single drift reaches `driftPct`; it trades all the way back to target. An asset with no band gets a band of zero width. A likely liquidity breach takes precedence and proposes sales to USDC.
- **Where the liquidity provider is used:** the stock cap (step 3), the liquidity block of the risk sheet, the last-resort stock sale and the dry stress in the schedule, and the breach assessment, where the API passes stocks as the only illiquid legs (`apps/api/src/routes/monitor.ts:151`).
- **Where it is available and unused:** `exitCapacity` and `exitCost` for yield legs and the BRL leg; `exitCost` anywhere in construction; the window argument, which the provider ignores, returning the worst of every measured regime (`packages/risk/src/provider.ts:83-84`).

Where notes and code disagree `[repo]`:

- The prompt for this note speaks of exit-cost curves "by regime". The regimes are hours of the week (market hours, weekday off-hours, weekend, US holiday). There is no measured stressed-market regime; stress is a multiplier.
- `docs/risk/HANDOFF-RISK.md` states the stock cap with a window. The window does nothing. `DESIGN-VAULT.md` §3.4 already says so.
- `packages/schemas/src/basket-sheet.ts` says `compose()` lives in `packages/engine/src/personal`. That folder does not exist on `staging`; ENG-2 is `todo`.
- The audit's finding 7 is still true: `fetchRealised30d` annualises the first and last of 31 daily DEX prices (`feeds/yields.ts:35-60`).
- The balance-goal verdict is still dropped: `targetMet` is computed in the schedule and `apps/api/src/routes/plans.ts` never reads it; it survives only inside each stored stress summary, which nothing reads back.

### 2.2 What each thread gives us

**Goals and liabilities. Take:**

- *Dedication for the near window.* Pension practice matches each near payment with a holding that pays on that date; it needs no covariance and no forecast `[4]`. Our cash and BRL rules are this already.
- *The funded ratio at a rate you can buy.* Assets over the present value of obligations, discounted only at a rate the person can hold today: "If you cannot buy it, you cannot use it as a discount rate" `[4]`. It is a fact about today. It becomes a forecast the moment the rate is an expected return, which is how public pensions understated liabilities by 30 to 60% `[4]`.
- *Floor and cushion.* The safe sleeve is the floor; what a plan may put at risk is a multiple of the distance between wealth and the floor `[5]`. This is the one knob that separates candidates.
- *A stress table in place of odds.* Chhabra's framework uses scenario analysis as the risk measure in all three of its buckets `[1]`.

**Reject:**

- Probability of success and the goals-based dynamic programme: they need means and covariances, they are forecasts, and strategies that maximise the chance of a target take more risk when behind near the horizon `[2][3]`. The dynamic programme assumes wealth follows geometric Brownian motion along an efficient frontier `[3]`: every input is one we do not have.
- Sizing the safe sleeve by discounting at an assumed return, as Brunel's worked case does (4% and 6%) `[6]`: a promise in disguise.
- Duration immunisation: our tokens have no reliable duration `[own]`.
- Cash buckets of three to five years: failure rates rise with the size of the reserve `[7]`, and with yearly rebalancing a bucket rule is the same as a static mix `[9]`. A one-year reserve wins only once transaction costs are counted `[8]`, which is our case.
- A glide path driven by the calendar alone: it ignores funded status `[10]`, and in decumulation the evidence on direction runs the other way `[11]`.
- Daily floor-and-cushion rebalancing: Chhabra's own caveat is that dynamic protection fails when it is most needed `[1]`.

**The test:** replay the withdrawal schedule through the measured exit costs for N = 0, 3, 6, 12 and 24 months of dedication, and take the smallest N beyond which the exit cost paid to meet obligations stops falling.

**Liquidity. Take:**

- *A cap on every leg at the worst regime.* Fund regulation puts the limit in a classification and a cap, judged at the size the fund would actually trade, under stressed conditions `[17]`. ESMA's "time to liquidity" is our `exitCapacity`, and it says not to assume a full day's volume can be sold `[18]`; `shareOfDepth` 0.25 is that caution.
- *A coverage check on the whole plan.* For each of the next obligations, what can be turned into cash by then, after exit cost, must cover what is owed. This is the liquidity coverage ratio's shape `[19]`. Portfolios close in risk and return can differ a great deal in liquidity `[15a]`, and per-asset caps miss thin assets going illiquid together `[16]` and several tokens draining one USDC pool.
- *No uplift for a longer window* unless we have measured pools refilling. Capacity that grows with time assumes liquidity returns between sales `[14]`; on a pool that happens only through arbitrage or issuer redemption `[own]`.
- *One scale for a pool exit and an issuer queue:* time to cash at cost ≤ tau. A queue counts only for obligations beyond its stressed length `[17][21]`.
- *Exit cost as a tie-break,* net of yield, never as a weighted term that needs a risk-aversion number.

**Reject:** the Almgren and Chriss frontier (needs risk aversion and volatility) `[14]`, the square-root impact law (an order-book regularity; a pool's curve is deterministic `[20]`), Basel's haircut numbers as depth multipliers (they are value haircuts `[19]`), and limits as a share of traded volume.

**Not found:** a primary source that measures how much depth concentrated-liquidity pools lose in stress. One abstract says providers were slow to return during the UST and USDT drops `[22a]`.

**Robustness. Take:**

- *Caps for concentration, not for estimation error.* Jagannathan and Ma show that a long-only constraint acts like shrinking the estimates, and that with it in place a plain estimate does as well as a refined one. An upper bound has the same algebra, but in their tests it added no significant improvement once the portfolio was already long-only `[29]`. Ours always is. So the caps are justified by what a single failure can cost (2.2, tokenised assets), not by this paper.
- *Capped equal weight as the baseline every other fill must beat.* Across 14 models and seven datasets none consistently beat 1/N; the sample needed for an optimiser to win was about 3,000 months at 25 assets `[25a][26]`. The rebuttal blames short-sample estimates `[30a]`, which are all we have.
- *Ranking in bands.* A small change in one mean drives half the assets out of the optimum while the portfolio's return and risk barely move `[28a]`. No source prescribes a width; it has to be measured.
- *Haircuts as they are.* With long-only weights, the worst case over a box of possible yields is each yield at its low end, so the haircut already is the robust version of the problem `[own]`.

**Reject:** mean-variance, risk parity, hierarchical risk parity `[32a]`, mean-CVaR (fragile even in ideal conditions `[31]`), resampling and Black-Litterman. Each needs a covariance, a tail or an equilibrium we do not have. For tokens near a peg, weeks of prices show almost no volatility and say nothing about default `[own]`.

**Robo-adviser practice. Take:**

- *Objective inputs before self-assessment.* Betterment sets its recommendation from the goal's type and horizon, not from a questionnaire score `[35]`.
- *One published drift number.* Betterment: 3% by default, 7% for its crypto and custom portfolios, drift defined as the sum of absolute deviations from target divided by two `[33]`. Vanguard Digital Advisor: checked daily, 5% `[36]`.
- *Safer only.* Scalable Capital lets a client choose a lower risk limit than proposed, never a higher one `[37]`.
- *Outcome language that is arithmetic:* the observed yield with its source and date, obligations covered, a table of named shocks with the bad cases shown `[38]`.

**Reject:** the median line and cone, "likelihood of reaching the goal" and projected balances `[34][37]`. These are forecasts with a disclaimer. CVM Resolution 19 bars guaranteeing a level of return, not projecting one `[39]`; our rule is stricter than the law. Twenty to a hundred risk levels are not needed: the three candidates replace them.

**No precedent:** none of the methodologies read shows three solved plans side by side for one goal. The choice-architecture findings in 2.4 carry the weight, and most of them were seen only as abstracts or snippets.

**Models. Take the boundary as chosen.** The evidence for it:

- Model backtests are not identified inside the training window; instructions to ignore history and masking the names both fail `[47a]`. Retested over two decades and a hundred symbols, the agent papers' advantage disappears `[48a]`. Of 120 evaluations of ten frontier models, 32.5% beat equal weight `[49a]`.
- Weighting is the weak step: one study found the model useful for picking and poor at weights `[50a]`.
- The same input does not give the same output: accuracy varied by up to 15% across runs at "deterministic" settings `[51a]`, and by up to 76 points across formats that mean the same `[52a]`.
- GPT-4 portfolios were "rather insensitive to the investment horizon" `[53a]`, which would disqualify an engine for dated goals.

The evidence against is real and narrow: post-cutoff news scores predicting returns on liquid US equities `[60a]`. It concerns a ranking signal, not a mapping from goal to weights, and none of it is on tokenised assets.

**For narration,** the evidence supports it only behind a check. In 21 generated data-to-text stories, annotators found 418 accuracy errors, among them 184 in numbers, 105 in names, 80 in words and 19 in context `[54]`. Those systems predate current models; no equivalent count exists for them on financial text. The check is in 2.6.

**Tokenised assets. Take:**

- *A sheet in the S&P shape:* asset quality first, then governance, legal and regulatory, redeemability and liquidity, technology, and track record `[66]`. Add two fields no framework has: whether this person can reach primary redemption, and the date the issuer's terms were read.
- *The liquidity tier from our measured curve, not from issuer terms.* The terms are unreachable or moving: USDY in Brazil needs qualified-investor status of R$1 million `[62]`; its issuer was folded into another entity in December 2025 `[63]`; sUSDe's cooldown is now 1 to 7 days set by governance `[65]`; syrupUSDC's queue is "usually under 24 hours" and can extend to 30 days `[64]`.
- *Leg types in place of one flag.* A rate leg passes through sovereign bills (USDY; holders have no claim on the Treasuries `[63]`). A credit leg writes losses down across the pool (syrupUSDC `[64]`). A basis leg can pay a negative rate and exits through a cooldown (sUSDe `[65]`). A market deposit can be blocked at full utilisation. syrupUSDC is both credit and basis: its disclosures allow basis trades `[64]`.
- *A haircut in four lines,* each with its own source: strip the reward part, as DefiLlama separates base from reward `[68]`; a trailing low percentile of the base rate; an expected-loss line by tier; exit cost over the holding period.
- *The cap carries the tail.* The loss record is a handful of events, with pool losses from 3% to 80% `[69]`, and one 2025 failure that took three tokens far below par `[70]`. No default probability can be estimated from that, and a 50 bp expected-loss line does nothing against an 80% loss `[own]`.
- *Third-party grades as a cross-check, never an input.* Exponential grades pools A to F on four dimensions (chain, protocol, asset, pool) and reports its own backtest from 2022: no defaults in A, 79% in F `[76]`. The vendor is grading its own ratings in a sponsored report, so this is a claim, not evidence. Its table does show how little yield separates the grades: a median of 3.19% for A against 5.32% for F `[76]`.
- *Yield as a one-sided flag.* Venues without buffers pay about 125 bp more at the median, far short of the tail `[71a]`. Low yield is not safety: USDC traded at $0.87 with 8% of its reserves at one bank `[72]`.

**Reject:** third-party letter grades as inputs, one PD × LGD figure per asset, and any redemption term written as a constant.

### 2.3 The LP, measured

`[run]` A scratch script, outside the repository, using the repository's own `javascript-lp-solver`: 20,000 random instances, 2 to 20 yield legs, caps 0.05 to 0.60, a credit budget of 0, 0.25 or 0.5, 30% of instances with tied yields. The LP was feasible in 18,533. In those, the LP beat the greedy fill in 0, the greedy fill beat the LP in 0, the largest difference in objective was 5.6e-17, and the weights differed in 0. In the 1,467 infeasible ones the greedy fill also left a remainder. With tied yields, shuffling the input order changed the LP's weights in 2,969 of 5,465 instances; the greedy fill breaks ties by asset id and did not move.

This matches the theory: the constraints are nested (asset inside the credit group inside the total), and a greedy fill is exact on nested caps `[24]` `[memory]` for the general statement. It stops being exact when two kinds of group cap overlap. A counterexample `[own]`: A (issuer 1, chain 1, yield 5), B (issuer 1, chain 2, yield 4), C (issuer 2, chain 1, yield 4), every cap 1, budget 2. Greedy takes A, which blocks B and C, and ends at 5 with the budget unfilled; the optimum is B and C at 8.

### 2.4 Three candidates from one engine

Each candidate is the same engine with a different objective, inside the same limits. The sheet's `riskBudget`, `creditTolerance` and caps are ceilings for all three: a candidate may sit below them, never above `[37]`.

| Working name | What it optimises | Parameters that move | Wins on |
|---|---|---|---|
| Cover | Obligations matched by date in the goal's currency, lowest exit cost | Dedication months up (12 where today's is 6); credit share 0 (changed on 2026-10-05, gate `COVER-CREDIT`: at most half the person's credit limit); stocks at the lower budget; `tau` and `shareOfDepth` tighter | Months covered; exit cost at the person's size |
| Spread | Least concentration | Dedication as today; yield legs filled equally within caps; issuer and chain caps tighter | Largest issuer share; number of issuers |
| Carry | Most observed haircut yield inside the limits | Dedication at the window only; credit share at the person's tolerance; yield legs filled by band | Observed carry; funded ratio |

The names are placeholders; product words are a brand decision.

How they are kept different, each rule with its study:

1. No candidate is dominated on the scorecard: the decoy effect is a dominated option raising its neighbour's share `[41s]`.
2. Each wins at least one attribute, so there is no single ordering and no fixed middle; people pick the middle when they must justify the choice `[42]`.
3. Wording does not replace rule 1. The decoy effect is weak outside displays where every attribute is a number: 11 reliable effects in 91 attempts, at chance with verbal or pictorial descriptions `[44]`, and none in 38 studies with perceptual stimuli `[43]`. But with numbers kept and words added it did replicate `[43]`, and our scorecard keeps its numbers. So the defence is that no candidate is dominated, not how the card is worded.
4. None is pre-selected and none is badged. A default is read as advice `[46s]`, and the FCA names defaulting and prominence as poor practice `[40]`.
5. The candidates are solved from the goal, never taken from a fixed menu. A majority of investors preferred the median portfolio of their peers to the one they had chosen themselves `[45]`: the menu sets the answer.
6. If the limits leave fewer than three plans that differ, the engine returns fewer and says why. It never invents a foil.

**The scorecard** (deterministic, every figure with `source`, `fetched_at`, `method`):

- Months of obligations covered by cash and the matching sleeve (2.7).
- The base schedule: months funded and the shortfall, in the goal's currency.
- The same under each named stress.
- The funded ratio at the haircut rate of the safest rate leg held.
- Exit cost at the person's size in the worst regime, with the share of the plan that is measured (`rollUp` already returns both).
- Concentration by issuer, chain and class (`rollUp`).
- Yield confidence: the share of observed carry that comes from realised or protocol readings, and the age of the oldest observation.
- Open FX exposure: obligations beyond what the matching leg covers. Zero, and not shown, when the goal is in dollars.
- Credit and basis share.
- Whether primary redemption is reachable by this person, per leg.

**Risk to say plainly:** with eight assets, three of them yield legs, Spread and Carry may come out the same for an income goal. The test in section 6 decides it; rule 6 is the honest answer when they do.

### 2.5 Feasibility with no return promise

Three numbers and a list, all from re-running the engine `[own]`:

1. **Covered now.** Months funded in the base schedule, which accrues at haircut rates observed on a stated date and assumes no growth in stocks. Shown as "at the rates observed on Oct 3", never as what will happen.
2. **Covered under stress.** The same count under each named stress.
3. **Carry needed beside carry observed.** The single flat rate at which the schedule funds every month, found by bisection on the schedule, next to the plan's observed haircut carry. No source frames it this way; it is safe only while both are labelled as observed and required, not expected.
4. **Each way to close a gap,** found by solving for one input at a time with the others fixed: more capital, a smaller monthly amount, a later start, a monthly contribution. `Verdict.ways` in `basket-sheet.ts` has this shape for income goals.

The status "met" means every month is funded in the base case and in every named stress; "short" comes with the gap in the goal's currency and the ways. The same computation serves balance goals, where today the verdict is dropped `[repo]`.

### 2.6 The narration check, if narration is adopted

In order, all in pure code except item 6:

1. Every numeral maps to a fact id, after locale is normalised ("1.234,56" and "1,234.56"), including percentages, dates and spelled-out numbers ("three", "três", "metade"). Number errors are the largest class `[54]`.
2. No numeral that is not in the facts, derived ones included. The model does no arithmetic.
3. No asset, issuer, protocol or venue outside the fact set. Name errors are the second class `[54]`.
4. No promissory construction. English: "will earn", "will return", "guaranteed", "risk-free", "safe", "certain", "expected to yield", "you will have". Portuguese: "vai render", "renderá", "garantido", "garantia de", "sem risco", "seguro", "com certeza", "retorno esperado", "você terá". The list is ours `[memory]`.
5. No comparative or superlative that is not a fact ("safer than", "mais seguro").
6. An entailment check per sentence, as a second filter only: the best-known metric scores 74.4% balanced accuracy on its own benchmark `[57a]` and was trained on English.
7. Each sentence names the fact ids it rests on, and the ids are verified: in commercial systems 74.5% of citations supported their sentence `[58a]`. Anthropic's citations cannot be combined with structured outputs in one call; the API returns a 400 `[56]`.
8. Source, date, method, the MOCK label and the disclaimer are rendered by the template layer, never by the model.
9. On any failure, the template is shown and the failing rule is logged. No silent retry.

Portuguese is measured on its own. No study of numeric faithfulness in Portuguese financial text was found; on Brazilian clinical cases English led Portuguese by 7.5 to 12.1 points on one task and by nothing on others `[61a]`.

### 2.7 Goal currency, and the stock shelf

**Currency.** The product is global, and most goals will be in dollars. Nothing in the method depends on reais. Stated without a currency `[own]`:

- An obligation is a date, an amount and a currency.
- The **matching leg** is an asset in the goal's currency that carries no FX risk against it. It is needed only when the goal's currency differs from the currency of the assets, which is dollars. For a goal in reais it is the BRL leg, as today. For a goal in dollars there is none to add: cash and the rate legs are already in the goal's currency.
- **Dedication for a dollar goal:** cash for the liquidity window, then the next months of withdrawals in the most liquid rate legs. Those pay; the BRL leg pays nothing. So a dollar goal gives up less carry for the same coverage, and the Cover candidate costs less.
- The FX stance, the FX stresses and the open-FX line of the scorecard apply only when the currencies differ. For a dollar goal they are absent, not shown as zero risk.
- Bands, caps, the coverage check, the three candidates, the yield, credit, stock and liquidity stresses, and the status in 2.5 are the same in any currency.

This is what the liability literature says too: match the currency of the obligations `[4][12]`; when the assets are already in it, there is nothing to hedge.

What the code has `[repo]`: `ConstraintSheet.currency` is the literal `'BRL'`, the target is `amountBrl`, and the schedule runs in reais. `BasketSheet` is in dollars (`amountUsd`, `incomeTargetUsdMonthly`) and has no currency field. So neither engine takes both. The seam is one field on the sheet, the goal's currency, with obligations carrying it, an FX observation per pair with its source and time, and the BRL leg generalised to "the matching leg for the goal's currency, if one is listed". The registry rule that the BRL leg is abstract already has this shape.

**The test:** the same goal in dollars and in reais at the day's rate. The dollar plan has no matching leg, no FX stress rows and no open-FX line; the two plans differ only in the matching leg and in what was reduced to fund it.

**Stocks.** The rule covers every stock token listed on the person's chain, by one rule, with no subset picked in the engine. Where things stand `[repo]`:

- The legacy registry holds two (SPYx, QQQx).
- On Solana the shelf is the set Bearing already measures. Its registry of Oct 1 found that 34 pools hold 80% of the on-chain liquidity of stock tokens, and those 34 pools belong to 18 assets (`docs/risk/PLAN-RISK.md`, `docs/risk/STATE-RISK.md` Step 1). The 18 are the stock products: they have curves, and the analytics pages already show them. The 34 is a count of pools, not of stocks. The collector follows 47 tokens in all; the other 29 are thin and stay off the shelf until their depth says otherwise.
- A plan lives on one chain (`ONE-CHAIN`), so a plan can hold only that chain's stock tokens.
- Stocks are for growth plans only (`PROTECT-NO-STOCKS`, and the income rule).
- What a stock may weigh comes from its measured exit numbers (`EXIT-SOURCE`), which is change C5 already decided for stocks; a tier stands in where nothing is measured, labelled as a fallback.
- A plan holds at most 8 lines in the MVP and the vault allows 16 (`DESIGN-VAULT.md` §7), with a minimum line of 0.5%. Every stock on the shelf is a product, and one plan holds a few of them: the person's themes, or a shared portfolio, choose which (Rodrigo, Oct 3).
- On Solana, Kamino Scope prices ten stock tokens, so automatic rebalancing covers plans built from those ten only.

What changes in the solver for a wide shelf:

- Equal split inside the stock sleeve stays `[25a]`.
- A stock cut by its exit cap hands its share to the other chosen stocks first, and only then to the yield legs. Today it goes straight to the yield legs `[repo]`, which with two stocks hardly matters and with many does.
- A single-stock cap by risk level, which ENG-2 has (`capPerStockBps`).
- A stock with no measured curve is held to its fallback ceiling and shown as not measured, never left out silently.

**The test:** every stock token on the shelf is eligible for growth and for nothing else; on the full shelf the plan holds at most 8 lines, each within its cap, and shuffling the shelf changes nothing.

## 3. What to skip or defer

- Any optimiser that needs a covariance matrix. Nothing we can measure feeds it.
- Probability of success, cones and Monte Carlo survival rates.
- A default-probability figure per asset. A handful of events does not make an estimate.
- A calendar glide path as the only de-risking rule. Defer until the window-driven rule has been compared with it (R6).
- Overlapping issuer × chain caps. Since `ONE-CHAIN` a plan sits on one chain, so there is no chain cap inside a plan, and the caps stay nested (asset, issuer, class): the fill remains a sort and the LP question recedes.
- A stressed-market regime for the curves. It needs data the collectors do not hold, and they are not edited before Oct 12.
- Exit curves for USDY and syrupUSDC, for the same reason. Until then a dollar ceiling by tier stands in, as ENG-2 already plans.
- Multi-stage stochastic goal programming `[77]`. It is a peer-reviewed linear program over a scenario tree, and the scenarios are return forecasts. It is the same trap as the LP, larger.
- A goals-based asset pricing model `[78]`: an unreviewed draft about how assets should be priced, not about how to build a plan.
- A model-produced news score as an engine input. The only positive evidence is on US equities `[60a]`.

## 4. Compared with our solver

### 4.1 What the solver gets right

- **Rules and caps before any optimisation.** This is where the evidence points when inputs are few and noisy `[25a][26]`; a constraint that is wrong in the population can still help out of sample `[29]`.
- **Cash for the window and a BRL leg for the next six months.** That is dedication in the liability's currency `[4]`. For bond-like assets the risk-minimising hedge of the liability currency is close to full `[12]`.
- **Haircut yields with a rule id on every observation.** The haircut is the robust form of the problem `[own]`, and the rule id is what makes it auditable.
- **Realised before aggregator.** DefiLlama itself aims for the minimum attainable yield and separates rewards `[68]`.
- **No return assumed for stocks, and stresses that only cut.** A table of named shocks is the outcome language that survives `[1][38]`.
- **A credit budget as a bucket across assets,** the shape of the LCR's Level 2 cap `[19]`. Today the bucket has one member, syrupUSDC, whose own cap of 0.4 binds before the 0.5 budget `[repo]`; the rule is right and so far untested by a second credit leg.
- **Stocks split equally** `[25a]`, and capped by the worst regime at a quarter of measured depth `[18]`.
- **The breach assessment.** Coverage of each coming withdrawal by what can be sold in time is the redemption coverage ratio `[18]`.
- **The model fills a form and nothing else** `[47a][48a][50a]`. ESMA's position is that the decision stays with the firm whatever tool produced it, and that language tools are known to hallucinate `[59]`. A deterministic engine can also be inspected, which CVM Resolution 19 asks of automated advice `[39]`.
- **xStocks out of income plans,** in the registry.

### 4.2 Changes

"Documents touched" names what the founders would edit through `/decide`. Nothing here edits them.

| id | change | verdict | finding and evidence | the test that settles it | documents touched | size |
|---|---|---|---|---|---|---|
| C1 | The LP is replaced by a deterministic fill with a tie-break by asset id | remove | Same weights as greedy on 20,000 instances; order-dependent on ties `[run]`; continuous knapsack `[24]`; the same finding from the audit's reviewers, as recorded in `personalization-ai.md` §2 | Property test: on nested caps the fill equals the LP to 1e-9. Shuffle the assets 100 times: identical output. The A/B/C case as a fixture for the day caps overlap | `GATES.md` SOLVER row; `HANDOFF-IDEA1.md` §"Solver form"; `docs/structurer/PLAN.md` §5 | S |
| C2 | Yield legs are ranked in bands; inside a band they are filled equally | change | Point ranking is unstable while outcomes are flat `[28a]`; USDY flipped between 40% and 8% in a day, and the audit's fix 6 asks for a gap before one leg displaces another `[audit]` | Perturb each yield by its observed week-on-week spread; set the band where adjacent ranks swap more than a chosen share of the time. Then: a ±1 band change moves weights by less than a set L1 | `DESIGN-VAULT.md` §7; `HANDOFF-IDEA1.md` | M |
| C3 | The yield feed reads the issuer's rate or a trailing low percentile, with an age limit; a missing yield excludes the leg with a reason, never counts as zero | change | Two-point realised figure `[repo][audit]`; base and reward kept apart `[68]` | Bootstrap 90 days of each asset's rate: the ranking under the new figure flips less often than under the spot figure | `HANDOFF-IDEA1.md`; `VERIFICATION.md`; `DESIGN-VAULT.md` §7 | M |
| C4 | The haircut becomes four stored lines: reward strip, stability, expected loss by tier, exit cost over the holding period | change | One fraction by measurement method hides what is being discounted `[repo]`; `[68][67]` | Vary the expected-loss line ×0.5 to ×3: if weights move less than the caps bind, keep it for display and out of the ranking | `DESIGN-VAULT.md` §7, §8; `HANDOFF-IDEA1.md` | M |
| C5 | Exit capacity caps every leg that has a curve; a leg without one takes a dollar ceiling by tier and is shown as not measured | change | Stocks only today `[repo]`; classification and cap at the traded size `[17][18]`; USDY has no primary exit for this user `[62]` | Re-solve the fixture goals: count plans where a yield leg exceeds `shareOfDepth` × its capacity once curves exist. Any count above zero settles it | `DESIGN-VAULT.md` §3.4, §7; `HANDOFF-RISK.md` §5 | M |
| C6 | A coverage check on the whole candidate at construction: each coming obligation covered by what can be sold in time, after exit cost | add | `assessLiquidity` exists and never runs at construction: `solve()` and `plans.ts` do not call it; the monitor passes stocks as the only illiquid legs `[repo]`; `[19][18][16]` | Fixture: a plan whose per-asset caps pass and whose legs share one USDC pool. Joint capacity from pool state against the sum of the per-asset figures; a gap above `tau` means the per-asset cap alone is unsafe | `DESIGN-VAULT.md` §3.4, §8; `HANDOFF-RISK.md` | M |
| C7 | The schedule sells yield legs at their measured exit cost, not at par | change | `schedule/index.ts:203-214` `[repo]` | Schedule test: with a provider that covers a yield leg, months funded falls or holds, never rises, against the par draw | `HANDOFF-IDEA1.md`; `docs/structurer/schedule-check.csv` and `ACCEPTANCE.md` row 7 (the hand cross-check is redone) | S |
| C8 | Issuer and class caps, with issuer, curator and custodian counted as one group | add | The legacy solver has none; ENG-2 has `capPerIssuerBps` `[repo]`; UCITS and 2a-7 issuer limits `[73][74]`. A 5% issuer limit cannot be met with 8 assets `[own]`, so the proposal is a 25% ceiling with buckets | Inject an 80% loss on any credit or basis leg: the withdrawal schedule still pays for a stated number of months | `DESIGN-VAULT.md` §7 | S |
| C9 | The `creditLeg` flag becomes a leg type (rate, credit, basis, market deposit; more than one allowed) and each asset gets a risk tier and a liquidity tier | change | syrupUSDC is credit and basis `[64]`; `[66][63][65]` | Registry test: every asset has a type, both tiers, and a dated source for its redemption terms; CI warns when a date is older than 30 days | `DESIGN-VAULT.md` §8; `HANDOFF-IDEA1.md`; `PersonalParams` in §3.6 | M |
| C10 | Three candidates as Cover, Spread and Carry, inside the person's limits, with fewer returned when fewer differ | add | Section 2.4; `[41s][42][43][45][37]` | Over a grid of goals: no candidate weakly dominated; each wins one attribute; pairwise distance of at least 10 points (L1 ÷ 2), a starting value; when fewer than three pass, fewer are returned with a reason | `DESIGN-VAULT.md` §3.6, §7, §11; `HANDOFF-VAULT.md`; `GATES.md` (a new row) | L |
| C11 | A deterministic scorecard per candidate | add | Section 2.4; `rollUp` already gives concentration and exit cost `[repo]` | Snapshot test of the three scorecards; every figure carries source, time and method | `DESIGN-VAULT.md` §3.6, §8 | M |
| C12 | Feasibility for every goal kind: covered now, covered under stress, carry needed beside carry observed, each way to close the gap | change | `targetMet` computed and dropped `[repo][audit]`; `[4][1][38]` | A lint fails the build on a percentile, a probability or a projected balance in UI copy or API output. The verdict for a balance goal is correct past the target month | `DESIGN-VAULT.md` §7, §11, §17; `HANDOFF-VAULT.md` (the odds paragraph); `STATE-VAULT.md` ENG-1 | M |
| C13 | De-risking driven by obligations entering the dedication window and by the cushion, not by the calendar alone | change | `solve()` ignores `horizonMonths` `[repo]`; ENG-2's `glideFloor` is by months left only; `[10][11][5]` | On recorded paths: the calendar rule against the window rule on the worst count of uncovered months | `DESIGN-VAULT.md` §3.6, §7 | M |
| C14 | Drift is one number (sum of absolute deviations ÷ 2), with a default band and a wider one for stocks; an asset with no band no longer has a band of zero | change | Zero-width default in `drift.ts:29-30` `[repo]`; 3%, 7% and 5% in practice `[33][36]` | Replay recorded prices at 3%, 5% and 7%: count rebalances and exit cost; take the band where the cost per rebalance stays under a stated cap | `DESIGN-VAULT.md` §3.6 (`planRebalance`), §5 | S |
| C15 | Dedication months N is set by a replay, not by hand | change | `nearTermMonths` 6 is a judgment `[repo]`; `[7][8]` | The replay in section 2.2, goals thread | `HANDOFF-IDEA1.md`; `DESIGN-VAULT.md` §7 | S |
| C16 | No candidate is pre-selected; equal visual weight; neutral order | add | `[40][46s]` | End-to-end test: nothing is selected on load. Later, with real use: if one candidate takes more than about 60% whatever the goal, the set is one option with two foils (the threshold is ours) | `DESIGN-VAULT.md` §11; `STYLE.md` if a component is added | S |
| C17 | The parser gains a stability gate and locale cases | add | A schema guarantees structure, not values, and number ranges are checked locally `[55]`; `[51a][52a]`; "R$ 3.000,00", "3 mil", "até 2029" are an engineering risk, not a cited one `[memory]` | 20 goals × 10 runs × 5 paraphrases: one sheet per goal, or a typed refusal | `DESIGN-VAULT.md` §7 (the evaluation set) | S |
| C18 | The narration check of section 2.6, if narration is adopted | add | `[54][58a][56][57a]` | Inject 100 corrupted narrations per language (wrong number, swapped asset, added promise, added comparison): every numeric, name and banned-phrase case is caught; entailment recall is reported apart. A gap in Portuguese keeps Portuguese on templates | `DESIGN-VAULT.md` §7; `GATES.md` (a new row) | M |
| C19 | The goal's currency is a field on the sheet; obligations carry it; the matching leg and the FX stresses exist only when it differs from dollars | add | Section 2.7; the legacy sheet is reais only and `BasketSheet` dollars only `[repo]`; `[4][12]` | The dollar and reais versions of one goal, as in 2.7 | `DESIGN-VAULT.md` §3.6, §7; `HANDOFF-VAULT.md`; `HANDOFF-IDEA1.md`; `CLAUDE.md` (the BRL-leg rule's wording) | M |
| C20 | The stock rule runs over every stock token on the person's chain: equal split, a cut stock's share goes to the other stocks first, a cap per stock, a fallback ceiling where unmeasured | change | Section 2.7; today the freed share falls to the yield legs `[repo]`; `ONE-CHAIN`, `EXIT-SOURCE`, `PROTECT-NO-STOCKS` | The full-shelf test in 2.7 | `DESIGN-VAULT.md` §7; the asset list | M |
| K1 | Rules, caps, cash and BRL dedication, the credit budget, the stress table, equal split of stocks | keep | Section 4.1 | The baseline snapshot test stays green where behaviour is unchanged | none | n/a |
| K2 | The model only parses; templates explain | keep | Section 2.2, models | Same sheet, 100 runs: byte-identical plan | none | n/a |

### 4.3 What ENG-2 already covers

The three-step engine in `DESIGN-VAULT.md` §7 (exposure, placement, packaging) covers more of this than the legacy solver does `[repo]` for the types, `[memory]` for the prototype's behaviour, which was not run today:

- No LP (C1 is already its design).
- A dollar ceiling per token from the tier and from `shareOfDepth` × exit capacity, for every token, not stocks alone (most of C5).
- Caps per stock and per issuer by risk level (most of C8).
- A verdict with the gap and each way to close it, for income goals (part of C12).
- A reason from a template on every line, and the hashes that make a plan reproducible.
- `rollUp` for concentration and the two exit numbers (most of C11).

What it does not have, and where each lands:

| Missing | Step it belongs to |
|---|---|
| Dated obligations and their currency (C19). `BasketSheet` has an amount, a horizon and an optional monthly income in dollars; the schedule in reais was left out on purpose (`personalization-ai.md` §3). Dedication, coverage and the funded ratio all need the dates | The sheet, before exposure |
| The cash and matching-leg dedication rules; the BRL leg as the matching leg for goals in reais | Exposure |
| Leg types and the two tiers (C9); the credit budget | Exposure, from the shelf |
| Banded fill inside the dollar-yield sleeve (C2) | Exposure |
| The coverage check (C6) | Between placement and packaging |
| Three candidates and the scorecard (C10, C11) | Packaging: `compose` is called once per objective with a different `PersonalParams` |
| Stresses and the verdict for balance goals (C12) | Packaging. `buildSchedule` takes a `ConstraintSheet`, registry assets and reais, and `personalization-ai.md` lists it as not reused, so this is a port or an adapter, not a call |

So the changes fit inside `compose` as parameters and one added check, on one condition: the sheet carries the obligations. That is the interface question to settle before FRAME-3 freezes the types. `BasketCard.expectedReturn` is also a field name that reads as a promise; "observed yield range" says what it is.

## 5. Seams for the roadmap

- **An LP later.** The fill is one function behind the candidate objective; overlapping caps or one row per withdrawal date swap it without touching the rules.
- **Curves for yield tokens and a stressed regime.** `exitCapacity` already takes any asset id; a tier ceiling stands in until a curve exists, and the scorecard states the measured share.
- **The BRL leg after G-Nora.** Its exit is unmeasured and its mint path unavailable today. The cap stays a parameter; issuer terms arrive as a dated redemption entry like any other leg's. No BRS-specific code.
- **More candidates or other objectives.** A candidate is a named parameter set with a hash; a partner can pass its own.
- **A funded-ratio history.** The ratio is a fact with a date, so it can be stored per day and shown as a series without becoming a forecast.
- **Narration.** The check takes facts and text and returns pass or the failing rule; it does not care which model wrote the text.

## 6. Risks and the test that settles each

| Risk | Test |
|---|---|
| R1. With 8 assets, Spread and Carry are the same plan for an income goal | The C10 grid on the real registry. If they collapse, two candidates are returned and the reason is shown |
| R2. The band width hides a real difference in yield | C2's perturbation test; then compare banded fill with capped equal weight on the history we have. Banded must beat equal by more than the bootstrap interval, or equal weight is the fill |
| R3. Caps do all the work and the ranking is decoration | Permute yields at random within a tier and re-solve. If the scorecards barely change, drop the ranking |
| R4. Capping yield legs by exit capacity leaves money in cash | C5's count, plus the share of plans where the remainder goes unplaced at $10k, $50k and $250k |
| R5. A per-asset cap passes while the plan cannot exit through one shared pool | C6's fixture |
| R6. The window-driven rule de-risks later than a calendar glide and leaves a month uncovered | C13's comparison |
| R7. Curves measured on quiet weekends overstate what a bad day gives; ignoring the variation in spreads understated risk by 25 to 30% in emerging markets `[23]` | Where both weekend and market-hours curves exist, predict one from the other with the peer ratio; the under-prediction must be within `tau`. Until a stressed regime is measured, the figure is labelled assumed |
| R8. Carry needed beside carry observed is read as a promise | Copy review against the banned-construction list, in both languages, by a person |
| R9. The Portuguese narration check is weaker than the English one | C18's injection set in Portuguese |
| R10. Issuer terms in the registry go stale | C9's date check in CI |

## 7. Questions only a person can answer

1. **The odds.** `HANDOFF-VAULT.md` says the plan is managed on the odds of reaching the goal, and ENG-1 is to deliver an estimate. Every method that produces a probability needs expected returns and a covariance `[2][3]`, and every robo-adviser that shows one labels it hypothetical `[34][37]`. The evidence says to deliver the status in section 2.5 and no percentage. Rodrigo: does ENG-1 change to that?
2. **"On track".** As Betterment defines it, the phrase means the median projection reaches the target `[34]`. Ours can be defined as covered in the base case and in every named stress. Is that definition, with its method and date shown, acceptable under the brand guardrails, or does the wording change?
3. **Three plans and CVM Resolution 19.** Article 1 defines advice as individualised "orientação, recomendação e aconselhamento", and article 17 applies the full duties to automated systems `[39]`. Three plans solved from one person's goal look like that, whatever the wording. The decision to offer three is recorded so far only in the brief for this note, and this does not reopen it; it is the regulatory question already open in `GATES.md`, with a sharper edge. Both founders, and a lawyer.
4. **The numbers.** The cap matrix by risk and liquidity tier, the band width, the dedication months and the drift band are judgment. The tokenised-assets thread proposes, by analogy with UCITS, Basel and 2a-7 and from no source: per asset 25 / 20 / 10% for a rate leg at the three liquidity tiers, 20 / 15 / 7.5% for a market deposit, 10 / 7.5 / 5% for a credit or basis leg, 5 / 2.5 / 0% for an asset under a year old or opaque; credit plus basis plus new at most 40%; one issuer group at most 25%. These are far below today's registry caps (0.6, 0.4, 0.4), and with three yield legs they cannot absorb an income plan. Rodrigo: which wins, the matrix or a shelf wide enough to satisfy it?
5. **The BRL leg beyond the window.** Theory says match the liability currency fully for bond-like assets `[12]`; institutions hedge 21 to 44% of their dollar holdings `[13]`; nothing verified speaks to the real. The leg also pays nothing and has no measured exit. How much of the obligations beyond the dedication window should it hold?
6. **The SOLVER gate.** Close it as "rules and a banded fill, no LP"? The gate's written default is the LP.
7. **Narration.** The decision to let the model narrate is stated as pending in the brief for this note and is in no other document yet. Templates cannot invent a number, and the evidence for model narration is fluency only. If it passes, does Portuguese ship on templates until C18 has run?
8. **One engine.** `DESIGN-VAULT.md` §7 says `solve()` is not edited. Do these changes go only into `engine/src/personal/`, with the legacy solver frozen behind its baseline test, or into both?
9. **Names** for the three candidates, and whether any attribute leads the scorecard.
10. **The Solana stock shelf.** The 80% set is 18 assets in 34 pools. Is the shelf those 18, and does it follow the set when the registry is re-run?
11. **Which currencies beyond dollars and reais** at launch, and for each, is there a listed asset that can serve as its matching leg?

## 8. What could not be verified

- Eight of the papers behind 2.2 and 2.4 have now been read in full: `[2][3][27][29][42][43][44][45]`. Two claims changed. The note had said caps work by shrinking the estimates; the paper finds upper bounds add nothing significant once a portfolio is long-only, so the caps now rest on concentration alone. The note had said words beside the numbers defeat the decoy effect; the paper finds they do not, so that rule is gone and non-dominance carries it. No recommendation changed.
- The rest were read as abstracts or snippets; the tags say which. The specific figures (3,000 months for an optimiser to beat 1/N, 32.5% of evaluations beating equal weight) rest on abstracts.
- The general statement that a greedy fill is exact on nested caps is `[memory]`; our own run supports it for our case.
- Schwab's and Wealthfront's methodology papers were blocked. Betterment's use of cash flows before sales was not on the page read today.
- The full S&P criteria, Gauntlet and Chaos Labs parameters, and any secondary-market discount on USDY or syrupUSDC: not found or not reachable.
- USDY's minimum, fee and settlement time are not in the issuer documents reached; third-party figures conflict. The 40 to 50 day transfer restriction appears only in a 2023 report and is probably stale.
- Whether the product falls under CVM Resolution 19 is a legal question this note does not answer. The article number of its no-guarantee paragraph was not captured.
- The ENG-2 prototype was read, not run.
- Several sources are dated 2026 and are newer than anything we could cross-check against a second source: `[21][49a][61a][70][71a]`.

## 9. Sources

Checked on Oct 3, 2026 by the thread agents; four were fetched again by the session that wrote this note and are marked †.

1. Chhabra, "Beyond Markowitz: A Comprehensive Wealth Allocation Framework for Individual Investors", Journal of Wealth Management 7(4), 2005 (pp. 1-16 read): https://www.contemplata.it/wp-content/uploads/2017/01/BEYOND-MARKOWITZ-A-COMPREHENSIVE-WEALTH-ALLOCATION-FRAMEWORK-FOR-INDIVIDUAL-INVESTORS.pdf
2. Das, Markowitz, Scheid, Statman, "Portfolio Optimization with Mental Accounts", JFQA 45(2), Apr 2010 (full text): https://econpapers.repec.org/article/cupjfinqa/v_3a45_3ay_3a2010_3ai_3a02_3ap_3a311-334_5f00.htm
3. Das, Ostrov, Radhakrishnan, Srivastav, "Dynamic portfolio allocation in goals-based wealth management", Computational Management Science, 2019/2020 (full text): https://doi.org/10.1007/s10287-019-00351-7
4. Ryan, "The Evolution of Asset/Liability Management", CFA Institute Research Foundation, Sep 2013 (pp. 1-9; the source for Leibowitz and Redington, not read directly): https://rpc.cfainstitute.org/sites/default/files/-/media/documents/book/rf-lit-review/2013/rflr-v8-n2-1-pdf.pdf
5. Martellini, Milhau, Mulvey, "Goal-Based Investing and Application to the Retirement Problem", EDHEC-Risk, about 2018 (page summary): https://climateinstitute.edhec.edu/goal-based-investing-and-application-retirement-problem
6. Brunel, "Goals-Based Wealth Management in Practice", CFA Institute Conference Proceedings Quarterly, Mar 2012: https://static1.squarespace.com/static/59e8d89d914e6b37450c946a/t/5c643e15104c7b43f7b84187/1550073366884/CFA+Goals+Based+WM_PDOC.pdf
7. Estrada, "The Bucket Approach for Retirement: A Suboptimal Behavioral Trick?", IESE, May 2019 (pp. 1-12): https://blog.iese.edu/jestrada/files/2019/07/BucketApproach.pdf
8. Pfeiffer, Salter, Evensky, "The Benefits of a Cash Reserve Strategy in Retirement Distribution Planning", Journal of Financial Planning, Sep 2013: https://www.financialplanningassociation.org/article/benefits-cash-reserve-strategy-retirement-distribution-planning-OPEN
9. Kitces, "Managing Sequence of Return Risk with Bucket Strategies vs a Total Return Rebalancing Approach", Nov 2014 (practitioner blog): https://www.kitces.com/blog/managing-sequence-of-return-risk-with-bucket-strategies-vs-a-total-return-rebalancing-approach/
10. Estrada, "The Glidepath Illusion: An International Perspective", Journal of Portfolio Management, Summer 2014 (pp. 52-54): https://blog.iese.edu/jestrada/files/2014/08/Glidepath.pdf
11. Pfau, Kitces, "Reducing Retirement Risk with a Rising Equity Glide Path", Journal of Financial Planning, Jan 2014: https://www.financialplanningassociation.org/article/journal/JAN14-reducing-retirement-risk-rising-equity-glide-path
12. Campbell, Serfaty-de Medeiros, Viceira, "Global Currency Hedging", NBER WP 13088, 2007, revised 2009 (pp. 1-5; seven developed currencies, not the real): https://www.nber.org/system/files/working_papers/w13088/w13088.pdf
13. Du, Huber, "Dollar Asset Holdings and Hedging Around the Globe", NBER WP 32453, May 2024, revised Dec 2024 (pp. 1-5): https://www.nber.org/system/files/working_papers/w32453/w32453.pdf
14. Almgren, Chriss, "Optimal Execution of Portfolio Transactions", Dec 2000 (pp. 1-8): https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf
15. Lo, Petrov, Wierzbicki, "It's 11pm—Do You Know Where Your Liquidity Is?", Journal of Investment Management 1(1), 2003 (abstract): https://ideas.repec.org/h/wsi/wschap/9789812700865_0003.html
16. Acharya, Pedersen, "Asset pricing with liquidity risk", Journal of Financial Economics 77, 2005 (pp. 375-378): https://w4.stern.nyu.edu/facdir/lpederse/papers/liquidity_risk.pdf
17. SEC, 17 CFR § 270.22e-4 (rule text): https://www.law.cornell.edu/cfr/text/17/270.22e-4
18. ESMA, "Guidelines on liquidity stress testing in UCITS and AIFs", ESMA34-39-897, Jul 2020 (pp. 1-18): https://www.esma.europa.eu/sites/default/files/library/esma34-39-897_guidelines_on_liquidity_stress_testing_in_ucits_and_aifs_en.pdf
19. Basel Committee, Basel Framework LCR30: https://www.bis.org/basel_framework/chapter/LCR/30.htm
20. Adams and others, "Uniswap v3 Core", Mar 2021 (pp. 1-3): https://app.uniswap.org/whitepaper-v3.pdf
21. Born and others, "Tokenised money market funds: new technology, familiar risks?", ECB Macroprudential Bulletin, Apr 2026: https://www.ecb.europa.eu/press/financial-stability-publications/macroprudential-bulletin/html/ecb.mpbu202604_04.en.html
22. Heimbach, Schertenleib, Wattenhofer, "Exploring Price Accuracy on Uniswap V3 in Times of Distress", arXiv, Aug 2022 (abstract): https://arxiv.org/abs/2208.09642
23. Bangia, Diebold, Schuermann, Stroughair, "Modeling Liquidity Risk", working paper, 1998 (pp. 1-5): https://archive.nyu.edu/bitstream/2451/27135/2/wpa99062.pdf
24. "Continuous knapsack problem", Wikipedia, citing Goodrich and Tamassia 2002 and Korte and Vygen 2012; Dantzig 1957 seen as a snippet only: https://en.wikipedia.org/wiki/Continuous_knapsack_problem
25. DeMiguel, Garlappi, Uppal, "Optimal Versus Naive Diversification", Review of Financial Studies 22(5), May 2009 (abstract): https://ideas.repec.org/a/oup/rfinst/v22y2009i5p1915-1953.html
26. Haldane, Madouros, "The dog and the frisbee", Jackson Hole, Aug 2012: https://www.bis.org/review/r120905a.pdf
27. Michaud, "The Markowitz Optimization Enigma", Financial Analysts Journal 45(1), 1989 (full text): https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2387669
28. Best, Grauer, "On the Sensitivity of Mean-Variance-Efficient Portfolios to Changes in Asset Means", Review of Financial Studies 4(2), 1991 (abstract): https://www.jstor.org/stable/2962107
29. Jagannathan, Ma, "Risk Reduction in Large Portfolios: Why Imposing the Wrong Constraints Helps", NBER WP 8922, May 2002; Journal of Finance 58(4), 2003 (full text of the journal version): https://www.nber.org/papers/w8922
30. Kritzman, Page, Turkington, "In Defense of Optimization: The Fallacy of 1/N", Financial Analysts Journal 66(2), 2010 (abstract): https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1591171
31. El Karoui, Lim, Vahn, "Performance-Based Regularization in Mean-CVaR Portfolio Optimization", arXiv 1111.2091, Nov 2011 (the source for the fragility result of Lim, Shanthikumar, Vahn 2011): https://arxiv.org/abs/1111.2091
32. López de Prado, "Building Diversified Portfolios that Outperform Out of Sample", Journal of Portfolio Management 42(4), 2016 (abstract): https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2708678
33. † Betterment, "How and when will my portfolio be rebalanced?", updated Aug 7, 2026: https://www.betterment.com/help/portfolio-rebalancing
34. Betterment, "Goal Projection and Advice Disclosure", updated Sep 25, 2026: https://www.betterment.com/legal/goal-projection
35. Betterment, "Recommended Allocation Methodology": https://www.betterment.com/resources/research/goals-advice-explained/
36. Vanguard, Digital Advisor FAQ: https://ownyourfuture.vanguard.com/content/en/advice-profile/digital-advisor/faq.html
37. Scalable Capital, "Der Investmentprozess von Scalable Capital", Aug 2018 (sections 3.1, 3.2, 5): https://de.scalable.capital/images/kcbf79ije7q7/3GZgOJuj16qE44qCGcQy4K/e0347ffd4fd7ae142490df20b80d4c0f/Scalable_Capital_Investmenprozess.pdf
38. FCA Handbook, COBS 4.6.7R: https://handbook.fca.org.uk/handbook/cobs4/cobs4s6
39. CVM, Resolução nº 19, Feb 25, 2021, consolidated with Resolução 179/23 (articles 1, 17, 18): https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/resolucoes/anexos/001/resol019consolid.pdf
40. FCA, FG22/5, "Final non-Handbook Guidance for firms on the Consumer Duty", Jul 2022: https://www.fca.org.uk/publication/finalised-guidance/fg22-5.pdf
41. Huber, Payne, Puto, "Adding Asymmetrically Dominated Alternatives", Journal of Consumer Research 9(1), 1982 (snippet): https://ideas.repec.org/a/oup/jconrs/v9y1982i1p90-98.html
42. Simonson, "Choice Based on Reasons: The Case of Attraction and Compromise Effects", Journal of Consumer Research 16(2), 1989 (full text): https://ideas.repec.org/a/oup/jconrs/v16y1989i2p158-74.html
43. Frederick, Lee, Baskin, "The Limits of Attraction", Journal of Marketing Research 51(4), 2014 (full text): https://journals.sagepub.com/doi/abs/10.1509/jmr.12.0061
44. Yang, Lynn, "More Evidence Challenging the Robustness and Usefulness of the Attraction Effect", Journal of Marketing Research 51(4), 2014 (full text): https://journals.sagepub.com/doi/10.1509/jmr.14.0020
45. Benartzi, Thaler, "How Much Is Investor Autonomy Worth?", Journal of Finance 57(4), 2002 (full text): https://ideas.repec.org/a/bla/jfinan/v57y2002i4p1593-1616.html
46. Johnson, Goldstein, "Do Defaults Save Lives?", Science 302, 2003 (secondary snippet): https://www.researchgate.net/publication/8996952_Medicine_Do_defaults_save_lives
47. Lopez-Lira, Tang, Zhu, "The Memorization Problem: Can We Trust LLMs' Economic Forecasts?", arXiv, Apr 2025 (abstract): https://arxiv.org/abs/2504.14765
48. Li, Kim, Cucuringu, Ma, "Can LLM-based Financial Investing Strategies Outperform the Market in Long Run?", arXiv, May 2025 (abstract): https://arxiv.org/abs/2505.07078
49. Zhao, Chen, Su, "PortBench", arXiv 2605.27887, May 2026 (abstract): https://arxiv.org/abs/2605.27887
50. Romanko, Narayan, Kwon, "ChatGPT-based Investment Portfolio Selection", arXiv, Aug 2023 (abstract): https://arxiv.org/abs/2308.06260
51. Atil and others, "Non-Determinism of 'Deterministic' LLM Settings", arXiv, Aug 2024 (abstract): https://arxiv.org/abs/2408.04667
52. Sclar, Choi, Tsvetkov, Suhr, "Quantifying Language Models' Sensitivity to Spurious Features in Prompt Design", arXiv, Oct 2023 (abstract): https://arxiv.org/abs/2310.11324
53. Fieberg, Hornuf, Streich, "Using GPT-4 for Financial Advice", CESifo WP 10529, 2023 (abstract): https://www.ifo.de/en/cesifo/publications/2023/working-paper/using-gpt-4-financial-advice
54. Thomson, Reiter, "A Gold Standard Methodology for Evaluating Accuracy in Data-To-Text Systems", INLG, Nov 2020 (full text): https://arxiv.org/abs/2011.03992
55. Anthropic, "Structured outputs": https://platform.claude.com/docs/en/build-with-claude/structured-outputs
56. † Anthropic, "Citations": https://platform.claude.com/docs/en/build-with-claude/citations
57. Laban, Schnabel, Bennett, Hearst, "SummaC", TACL, Nov 2021 (abstract): https://arxiv.org/abs/2111.09525
58. Liu, Zhang, Liang, "Evaluating Verifiability in Generative Search Engines", Findings of EMNLP, Apr 2023 (abstract): https://arxiv.org/abs/2304.09848
59. ESMA, "Public Statement on AI and investment services", ESMA35-335435667-5924, May 30, 2024: https://www.esma.europa.eu/sites/default/files/2024-05/ESMA35-335435667-5924__Public_Statement_on_AI_and_investment_services.pdf
60. Anic, Barbon, Seiz, Zarattini, "ChatGPT in Systematic Investing", arXiv, Oct 2025 (abstract); see also Lopez-Lira, Tang, "Can ChatGPT Forecast Stock Price Movements?", arXiv 2304.07619: https://arxiv.org/abs/2510.26228
61. Souza, Melo, Lima, Schneider, "Beyond English benchmarks: clinical LLM evaluation in Brazilian Portuguese", arXiv 2606.07853, Jun 2026 (abstract): https://arxiv.org/abs/2606.07853
62. † Ondo Finance, "USDY Eligibility": https://docs.ondo.finance/general-access-products/usdy/faq/eligibility
63. Ondo Finance, "USDY Basics" and "Important Notes": https://docs.ondo.finance/general-access-products/usdy/basics
64. † Maple Finance, "Withdrawal Process"; also "Risk Disclosures" and "Defaults and Impairments" under `docs.maple.finance/legal/`: https://docs.maple.finance/syrupusdc-usdt-usdg-for-lenders/withdrawal-process.md
65. Ethena Labs, "Staking USDe": https://docs.ethena.fi/technical-design/staking-usde.md
66. S&P Global Ratings, "Launches Stablecoin Stability Assessment", Dec 12, 2023 (press release; S&P's own page was blocked): https://www.prnewswire.com/news-releases/sp-global-ratings-launches-stablecoin-stability-assessment-302012532.html
67. Credora, "DeFi rating scale: A+ to D": https://www.credora.network/docs/methodologies/defi-rating-scale/
68. DefiLlama, yield-server README: https://github.com/DefiLlama/yield-server/blob/master/README.md
69. CoinDesk, "FTX Contagion Spreads as Orthogonal Trading Gets Default Notice for $36M Debt on Maple Finance", Dec 5, 2022: https://www.coindesk.com/markets/2022/12/05/maple-finance-severs-ties-with-orthogonal-trading-alleging-it-misrepresented-financial-position
70. Pharos, "Stream Finance: loss broke three stablecoins", Jun 15, 2026 (secondary): https://pharos.watch/learn/case-studies/stream-elixir-contagion-2025/
71. Bundi, "Pricing the DeFi Tail", arXiv 2609.00911, Sep 2026 (abstract): https://arxiv.org/abs/2609.00911
72. CCData, "Market Analysis: Silicon Valley Bank, Circle & USDC", Mar 13, 2023: https://data.coindesk.com/blogs/market-analysis-silicon-valley-bank-circle-usdc
73. Directive 2009/65/EC (UCITS), Article 52: https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/ucits/article-52
74. SEC, 17 CFR § 270.2a-7: https://www.law.cornell.edu/cfr/text/17/270.2a-7
76. DL News Research with Exponential, "Evaluating Risk in DeFi", undated (full text; an industry report in which the vendor backtests its own ratings): www.dlnews.com/research
77. Kim, Kwon, Lee, Kim, Lin, "Personalized goal-based investing via multi-stage stochastic goal programming", Quantitative Finance, Oct 2019 (full text): https://doi.org/10.1080/14697688.2019.1662079
78. Muralidhar, "A Very Simple Goals- and Risk-Based Asset Pricing Model", SSRN 3051726, draft of Mar 2019 (full text; a working paper, not peer reviewed): https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3051726
75. Local, on `staging` at `1b8be80`: `packages/engine/src/{solver,assets,risk,policy,schedule,feeds}`, `packages/schemas/src/{constraint-sheet,plan,liquidity,asset,basket-sheet,basket,policy}.ts`, `packages/risk/src/{assess,curves,provider,breach,time}.ts`, `apps/api/src/routes/{plans,monitor}.ts`, `tests/`; `docs/structurer/HANDOFF-IDEA1.md`, `docs/risk/HANDOFF-RISK.md`, `docs/vault/{DESIGN-VAULT,AUDIT-VAULT,HANDOFF-VAULT,STATE-VAULT}.md`, `docs/GATES.md`, `docs/vault/research/design-v2/personalization-ai.md` and `personalization-proto/compose.mjs`.
