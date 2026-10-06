# PROMPT (build): the new solver, from the research and the decisions of Oct 5

> Written 2026-10-05 by Rodrigo's session, after `docs/vault/research/portfolio-method.md` and the decisions of Oct 5 (`docs/GATES.md`: `SOLVER`, `SOLVER-PARAMS`, `SLEEVES`, `THEMES`, `THREE-PLANS`, `GUIDED-INTAKE`, `NO-FREEZE`). Run it in a fresh Claude Code session started at the repo root, on a checkout that has pulled `staging` with those decisions merged.

---

## The prompt

You are building the plan engine of Tenonfi: the deterministic code that turns a person's confirmed sheet into a plan. The method was researched and decided; your job is to build it, in four slices, each one pull request into `staging`. Act as the orchestrator described in `.claude/rules/orchestration.md`: delegate bounded pieces where that helps, review every diff yourself, and keep the ledger true.

There is no feature freeze (`NO-FREEZE`). Build as much as you can, in the order below, until the submission on Mon Oct 12. A finished slice beats two half slices: never leave `staging` with a half-built slice.

### Read first, as files

1. `CLAUDE.md` and `.claude/rules/orchestration.md`.
2. `docs/GATES.md`, the decisions of Oct 3 and Oct 5 above all: `ONE-CHAIN`, `EXIT-SOURCE`, `PROTECT-NO-STOCKS`, `UNIVERSE`, `SOLVER`, `SOLVER-PARAMS`, `SLEEVES`, `THEMES`, `THREE-PLANS`, `GUIDED-INTAKE`, `NO-FREEZE`.
3. `docs/vault/research/portfolio-method.md`. Section 2.1 says what the old solver does, 2.3 why the linear program goes, 2.4 the three plans and the scorecard, 2.5 the status without odds, 2.6 the read-back check, 2.7 currency and stocks, 4.2 the changes table with the test for each row. Your tests come from that table.
4. `docs/vault/DESIGN-VAULT.md` sections 2 (who imports whom), 3.6 (the types), 7 (the engine) and 8 (risk sheet).
5. Code: `packages/engine/src/{solver,schedule,assets,risk,policy}` (the old engine, which you do not edit), `packages/schemas/src/{basket-sheet,basket,basket-asset,liquidity,recipe}.ts`, `packages/basket/src` (`flatten`, `planRebalance`, `rollUp`, `view`), Thom's ENG-2 port of the prototype on branch `eng/personal` (`packages/engine/src/personal/`: `compose`, the sleeve table, exit-source ceilings, issuer caps, `PROTECT-NO-STOCKS`, the 12-goal set and `POST /v1/baskets/personalize`), `docs/risk/PLAN-UNIVERSE.md` (which stocks are tracked).

### Settled; do not reopen

- The engine is deterministic: the same inputs give the same plan, byte for byte. The model never sets a weight, picks an asset or states a figure.
- Rules and a banded fill. No linear program in the new engine (`SOLVER`).
- The old `solve()`, its parser, registry and `ConstraintSheet` stay as they are, and `tests/engine-baseline.test.ts` stays green. The new engine lives in `packages/engine/src/personal/`, which Thom's ENG-2 port on `eng/personal` already holds: the slices build on it, reuse what it covers (note section 4.3) and change what the decisions of Oct 5 change (decided by Rodrigo on Oct 5, after this prompt was first written). Ledger row ENG-3 is this work; ENG-2 is Thom's port.
- A plan lives on one chain (`ONE-CHAIN`). What an asset may weigh comes from Bearing's measured exit numbers; a tier stands in only where nothing is measured, labelled as a fallback (`EXIT-SOURCE`). Stocks never sit in an income or protect goal (`PROTECT-NO-STOCKS`).
- Every yield, price, FX and exit figure carries `source`, `fetched_at` and `method`; nothing mocked or from a test network is shown as live. No yield number in code: the numbers below are policy parameters and live in the parameter table, never in logic.
- No odds and no percentage chance of reaching a goal. ENG-1's "odds estimate" stays open for Rodrigo; do not build it.
- The BRL leg stays abstract: no BRS-specific code (`G-NORA` is open).

### The starting parameters (`SOLVER-PARAMS`)

Put them in one versioned table (`PersonalParams` or beside it), each with a comment naming the test in the note that will tune it:

| Name | Value |
|---|---|
| Yield band | 0.5 percentage points |
| Cap per asset | today's registry caps (Kamino 60%, syrupUSDC 40%, USDY 40%), lowered to `shareOfDepth` × measured exit capacity ÷ plan size where that is smaller; `shareOfDepth` 0.25, `tau` 1%. A token the table does not name takes its leg type's figure (`SOLVER-CAPS`) |
| Issuer cap | 50% of the plan, for dollar yield, gold and cash (`SOLVER-CAPS`) |
| Months of withdrawals set aside | 6 |
| Drift band | 5 percentage points |
| Safe-yield switch | another asset ahead by more than the band for 7 days |
| Lines per plan | 8 at most (`DESIGN-VAULT.md` §7), minimum line 0.5% |

### Slice 1: the fill and the caps

What it delivers:
- `bandedFill`: sort eligible assets by haircut yield, highest first. A band is the run of assets within the yield band of the band's top. Fill a band equally, each asset up to its cap, handing what a capped asset cannot take to the others in the band, then move to the next band. Ties break by asset id.
- An asset with no yield observation is left out with a reason, never counted as zero.
- The effective cap per asset, as in the table, with the reason for whichever limit binds.
- The issuer cap, and a credit budget by the person's credit tolerance, carried over from the old solver.
- On the shelf asset, a leg type (rate, credit, basis, market deposit; more than one allowed: syrupUSDC is credit and basis), with its source and date.

Tests (from the note's C1, C2, C5, C8, C9):
- With the band at zero, the fill equals the old linear program's optimum on at least 5,000 random cases (use the existing `javascript-lp-solver` only inside the test).
- Shuffling the assets 100 times gives the same plan.
- Two yields 0.3 points apart share evenly; 0.8 points apart, the higher fills first.
- Each cap holds, and the binding one is named in the reason; an unmeasured asset gets the fallback and the label.
- The issuer cap holds across several assets of one issuer.

### Slice 2: the sheet, currency, sleeves and the coverage check

This slice changes `packages/schemas`. Every shared type change is Thom's to approve (`DESIGN-VAULT.md` §3): put the schema diff in its own commit, say so in the pull request, and ask for his review before merging.

What it delivers:
- On the sheet and its draft:
  - the goal's currency;
  - dated obligations (month, amount, currency);
  - sleeves, each with its kind (goal, theme, safe yield), its share in basis points and its own fields;
  - the person's choice of whether a sleeve that has grown is brought back to its share (`SLEEVES`).
  - Shares sum to 10,000. A sheet with no sleeves is one goal sleeve at 10,000.
- The matching leg: for a goal in a currency other than dollars, the asset in that currency (the BRL leg for reais); for a dollar goal there is none.
- Setting aside: cash for the liquidity window, then the next 6 months of withdrawals in the matching leg (other currencies) or in the most liquid rate legs (dollars).
- The coverage check: for each withdrawal in the next 6 months, what can be sold in time, after exit cost, through `LiquidityProvider`, covers what is owed. If not, the plan moves money toward cash and says why.
- A schedule in the goal's currency, ported into `personal/` (the old `buildSchedule` is not edited). Yield legs are sold at their measured exit cost, not at par.

Tests (C5 to C7, C19):
- The same goal in dollars and in reais: the dollar plan has no matching leg, no FX stress and no open-FX line; the two differ only by the matching leg and what funded it.
- A plan whose per-asset caps pass but whose legs share one pool fails the coverage check, and the fix is visible.
- Sleeve shares are validated, and the restore choice survives a round trip through the API.

### Slice 3: three plans, the scorecard and the status

What it delivers:
- Three candidates (`THREE-PLANS`), all inside the person's limits:
  - Cover: more months set aside, no credit leg, tighter exit tolerance.
  - Spread: equal fill within caps, tighter issuer cap.
  - Carry: the banded fill, credit up to the person's tolerance.
- If two come out within 10 points of each other (half the sum of absolute weight differences), return fewer and say why. Never a foil.
- None is marked recommended. The API returns them in a fixed neutral order, with no "selected" field.
- The scorecard per candidate, as in the note's section 2.4 (reuse `rollUp` for concentration and exit cost).
- The status, as in section 2.5:
  - months funded at the rates observed on a stated date;
  - months funded under each named stress;
  - the carry the goal needs beside the carry observed;
  - each way to close a gap, found by re-running the engine on one input at a time.

Tests (C10 to C12):
- On a grid of goals, no candidate is weakly dominated on the scorecard, and each wins at least one attribute.
- A test fails the build on a probability, a percentile, "chance" or "likely to reach" in templates or API output.
- A balance goal gets a correct status past its target month.

### Slice 4: themes, the safe-yield sleeve, rebalancing, and the guided intake

What it delivers:
- **Theme lists** as data, one file per theme per chain, under `content/themes/`. Each name has a reason, the curator and a version. Add the folder to the layout row in `DESIGN-VAULT.md` §2.
  - Write a proposed Solana AI list from the tracked stocks of `UNIVERSE`, each name with its reason, marked "proposed". Rodrigo confirms it; membership is a person's call (`THEMES`). Do not invent a list on another chain.
- **The theme sleeve:**
  - Eligible: the list, intersected with the tracked stocks on the person's chain, that can be sold at the person's size within `tau`.
  - Weights: equal, each name capped.
  - Lines: when the names outnumber the lines left in the plan, take the ones easiest to sell.
- **The safe-yield sleeve:** rate legs only, banded fill, issuer cap.
- **Rebalancing, per sleeve,** as proposals the person taps. The keeper does not rebalance on drift in the MVP.
  - Drift inside a sleeve is half the sum of absolute deviations; propose a rebalance at 5 points, using deposits and withdrawals first. Use `planRebalance`.
  - The safe-yield sleeve switches asset only on the 7-day rule.
  - The goal sleeve refills its set-aside withdrawals each month.
  - Between sleeves, nothing moves unless the person chose to restore the split.
  - A likely liquidity breach comes before everything, as today.
- **The guided intake** (`GUIDED-INTAKE`), in `apps/api`:
  - The model fills the draft and asks one question per field the text leaves open or unclear.
  - The read-back the person confirms is drawn from the validated sheet by a template, in English and Portuguese, never written by the model.
  - The person confirms before the engine runs.
  - Model down: the regex parser and the form, as today.

Tests (C14, C16 to C18):
- The 12-goal set in `fixtures/goals-eval.json`, grown with negations ("sem ações", "no credit"), two amounts in one sentence, and Portuguese numbers ("R$ 3.000,00", "3 mil"). Replay recorded model replies in CI.
- The same goal sent 10 times gives one sheet.
- The read-back holds no number or name the sheet does not.
- The theme sleeve on Solana holds at most the lines left, each within its cap, and is the same under shuffling.

### Order and parallel work

1 → 2 → 3, one after the other. Slice 4 has three parts with their own inputs:
- the guided intake needs only slice 2's schema commit, so it can run beside slice 3;
- themes and the safe-yield sleeve need slice 1;
- rebalancing needs slice 2.

Run at most two implementation agents at once, in their own worktrees, and never two full test suites at the same time.

### How each slice lands

`/start-work` (branch `engine/<slice>` from `staging` once `eng/personal` is merged there; until then from `eng/personal`, and the pull request says it stacks on it), `/verify`, `/review-pr` by an agent that did not write it, `/open-pr`. Update ENG-3 in `docs/vault/STATE-VAULT.md` with the evidence of each slice, and DESIGN §3.6 and §7 where the code now differs from what they say.

Stop and ask Rodrigo only for:
- a product choice the documents do not settle;
- a theme list's membership;
- a parameter outside the table.

Ask Thom for any shared type change. Everything else, decide and note it in the pull request.

### Report back

For each slice:
- the pull request link;
- what it does, in three lines;
- the tests and their result;
- what was left out and why;
- any number or name that needs Rodrigo.
