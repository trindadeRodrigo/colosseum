# HANDOFF: ENG-3, the solver slices, where the last session stopped

> For a fresh Claude Code session that continues `docs/vault/PROMPT-BUILD-SOLVER.md`. Read that prompt first, then this. Rewritten 2026-10-05 (evening) by the session that built the rest of slice 3. Delete this file in the pull request that finishes ENG-3.

## Where things are

| Piece | Branch / PR | State |
|---|---|---|
| Rodrigo's decisions of Oct 5 | #43 | **Merged** into `staging` (Oct 6) |
| Thom's engine (ENG-2) | #47 | Merged |
| Slice 1: the banded fill and the caps | `engine/fill`, #46 | **Merged** (Oct 6) |
| Slice 2: the sheet, currency, sleeves, withdrawals, coverage, schedule | `engine/sheet`, #48 | **Merged** (Oct 6, `a87a52c`). Rodrigo merged it before Thom approved its two schema commits (`5bccfad`, `f354d75`): Thom should still read them |
| Slice 3: three plans, scorecard, status | `engine/plans`, draft PR #64 into `staging` | **Built**: the status, the ways, the three candidates, the scorecard, the API. Waits for `/review-pr`, Thom's approval of the shared types (`ebdbb13`), and out of draft |
| Slice 4 | `engine/themes` (#72), `engine/rebalance` (#73, stacked on #72), `engine/intake` (#71) | The theme sleeve and rebalancing per sleeve (with the safe-yield switch) built, in draft; the guided intake on its own branch |

Worktree: `~/Documents/Colosseum-engine` (a `git worktree` of the main checkout), on `engine/plans`. Start the session in the main checkout so the hooks load, and work in that worktree. Its `apps/web/.next` goes stale when `staging` moves pages: delete it (gitignored) if the web typecheck names a missing page.

## What exists now (in `packages/engine/src/personal/`)

DESIGN §7 "As built (ENG-3 slice 2)" and "As built (ENG-3 slice 3, part 1)" hold the rules. In short:

- `fill.ts`, `placement.ts` (`Book.fillBanded`, `fillInOrder`, `toCash`): the banded fill, caps, issuer cap 50% on dollar yield, gold and cash (`SOLVER-CAPS`), credit budget.
- `world.ts`: validation; `withdrawals` converted at the FX reading (refused without one); `matchingOf`, `fxOf`.
- `set-aside.ts`: the next `setAsideMonths` of withdrawals placed first; the coverage check, with pools through the LOCAL TYPE `PooledLiquidityProvider`.
- `schedule.ts`: `scheduleOf`, in the goal's currency, at measured exit cost, with `atPar` and a named `stress`.
- `status.ts`: `statusOf` and `stressesFor`. `PersonalProposal.schedule` and `.status` are engine types; the API strips them.
- Tests to model new ones on: `withdrawals.test.ts`, `status.test.ts`, and `violations()` in `testing.ts` (every property test runs it; teach it each new rule, or the property tests will not see it broken).

## Slice 3: what was built (part 2, Oct 5)

DESIGN §7 "As built (ENG-3 slice 3, part 2)" holds the rules. In short:

- `candidates.ts`: `candidates(sheet, shelf, context)`, Cover, Spread, Carry through `composeAs`; the distance rule, then neither dominated nor ahead on nothing; each not shown says why.
- `scorecard.ts`: `scorecardOf`, on each candidate's plan.
- `compose.ts`: `build` takes a `Run` (`ways`, `status`, `candidate`); the status's ways (larger amount, smaller withdrawals).
- `world.ts`: `tableFor(P, candidate)`; Cover's credit limit is the plan's, said as such.
- `packages/schemas/src/plan-candidates.ts`: the shared types (commit `ebdbb13`, for Thom).
- `POST /v1/baskets/personalize` adds `candidates` and `candidatesNotShown`; `id`, `proposal`, `rollUp` unchanged.

Left before slice 3 merges: `/review-pr` by an agent that did not write it, Thom's approval of `ebdbb13`, out of draft. The web's view of three plans is a web task (Thom), not this slice.

## Slice 4 (after slice 3), as the prompt orders it

- The guided intake (`apps/api`) needs only slice 2's schema, now on `staging`: it can run beside slice 3 in its own worktree.
- Themes: the Solana AI list is confirmed (Rodrigo, Oct 5, gate `THEME-AI-SOLANA`; `content/themes/solana/ai.json`). The theme sleeve is built on branch `engine/themes`, stacked on `engine/plans` (DESIGN-VAULT section 7, "As built (ENG-3 slice 4, the theme sleeve)").
- Rebalancing per sleeve, with the safe-yield switch (the 7-day rule) and the monthly refill of the set-aside: built on branch `engine/rebalance` (#73), stacked on `engine/themes`, and fixed after its review (DESIGN-VAULT section 7, "As built (ENG-3 slice 4, rebalancing)"). `proposeSleeveRebalances` in `rebalance.ts`; who owns what is the sleeve book (LOCAL TYPE `SleeveBook`, settled by `settleBook`); `split` is in the shared `BasketProposal` (commit `56cf503`, for Thom). Not built: the API route, and storing the sleeve book beside the plan (what both need is in that section), and the new split once a switch is accepted.

## Gate COUNTRY-REMOVED (Rodrigo, Oct 6)

The engine has no country rule: `blockOf` ignores `blockedCountries` and `sheet.country`, `NOT_IN_COUNTRY` and its overflow sentence are gone, and `BasketSheet.country` is optional (`941e3580`, and the shared-type commit `158f4974` for Thom). Tests that held a blocked asset out now hold it in (`inputs.test.ts` "country", `said.test.ts`). Restrictions on who may hold an asset are for sign-up and the terms of service: open for the founders.

## Open items for people

- **Rodrigo:**
  - the choices of rebalancing per sleeve listed in its pull request (the sleeve book derived from the plan only within the drift band of it; with `restoreSplit` off a deposit or withdrawal follows what each sleeve holds; the refill goes to cash; the switch's last day; dust at `minLineUsd`, batch cost at `tau`; `fxMaxAgeDays` 3, a new `starting` number);
  - the stress sizes (`stress` in `params.ts`, the old engine's: yields −50%, credit gated 6 months, the goal currency ±20% over 12 months; stocks and gold fall `fallBps`);
  - the candidate overrides (`candidates` in `params.ts`: Cover 12 months, credit half the person's limit (set: gate `COVER-CREDIT`), tau 0.5%, shareOfDepth 0.125; Spread one band, issuer 30%; distinct from 1,000 bps), and `wayScaleStepBps` (1%);
  - the 25% cash in Solana income plans;
  - the theme sleeve's open choices listed in PR #72 (a theme in a plan to protect or for income is held in dollar yield and cash, not refused; capped equal weights redistribute; measured names rank before tier names). Themes first is decided (`THEME-FIRST`).
- **Thom:**
  - read slice 2's two schema commits, merged without his approval;
  - approve the shared types of slice 3 (`ebdbb13`: `PlanCandidate`, `PlanScorecard`, `PlanStatus`, additive);
  - approve the shared type of slice 4's rebalancing (`56cf503`: `PlanSplitSleeve` and `BasketProposal.split`, additive and optional; the API now answers and stores the split);
  - the web: show `candidates` side by side, none pre-selected (gate `THREE-PLANS`), instead of the one `proposal`; and whether the top-level `proposal` (the table's plan, the same as Carry) leaves the answer then. Until the web moves it is shown as the one plan even where the rule hides Carry (the reviewer's first finding, Oct 5);
  - decide whether the mock app gets yield readings for Robinhood Chain (`apps/api/src/testing/fixtures/mock-yields.json` has Solana's only, so a Robinhood plan on the mock holds no dollar yield).
- **The API reads no FX readings yet:** a withdrawal in another currency answers 422 with the fix. Wiring a source of FX readings is open.

## Next engine task: the max-yield sleeve (gate `MAX-YIELD-SLEEVE`, Rodrigo, Oct 6)

When a person wants "the highest yield possible" for a part of the plan, that part fills with the highest-yield eligible assets within the caps, instead of stocks. Today such a part is a goal sleeve and fills from the sleeve table (at high risk, 95% stocks): in Rodrigo's first `/plan-chat` the 30% "to go crazy for the highest yield" became SPYx. The intake already flags it (`max_yield_asked`) and says that the part is built as a goal to grow; the chat says it in one line.

**Depends on the `shelf/*` branches** (the fixed-income shelf research, `docs/vault/PROMPT-YIELD-SHELF.md`, cut from `tools/try-plans`): on Solana the launch shelf has two dollar-yield tokens (jlUSDC, syrupUSDC) and no rate leg, so a max-yield sleeve built today would hold the same two tokens as the goal sleeve's dollar yield. Start once those fixtures and their readings land.

1. **The sleeve objective (a shared type change: its own commit, Thom approves).** `PlanSleeve` in `packages/schemas/src/basket-sheet.ts` gains a kind `{ kind: 'max_yield', shareBps }`, at most one per plan (the `PlanSleeves` refine), beside `goal`, `theme` and `safe_yield`. A kind rather than a field on the goal sleeve: the goal sleeve keeps its table, and a plan can hold a safe part, a max-yield part and a goal part. `BasketSheetDraft.sleeves` takes it with no change. The intake's reply schema (`apps/api/src/llm.ts`) and `REPLY_FIELDS.sleeves` (`intake.ts`) gain the kind, the read-back a `SLEEVE_MAX_YIELD` sentence, and `MAX_YIELD_LATER` goes.
2. **Which assets qualify.** Tokens of class dollar yield on the plan's chain (`ONE-CHAIN`) of any leg type (market deposit, rate, credit, basis), plus the yield positions the shelf research adds (a Uniswap LP, Pendle PT-USDG on Robinhood Chain), each with a stored yield reading carrying `source`, `fetched_at` and `method` (no reading, left out with `NO_YIELD`; never zero). No stocks, crypto or gold: they have no yield reading and no return is assumed for them. The person's refusals hold (`cannotHold`, `creditTolerance: none` leaves out credit and basis legs). A token whose exit is longer than the person's time to get out, where they gave one for this part, is left out (needs a per-sleeve exit limit: a second field in the same schema commit, `maxExitMonths?` on the sleeve, read from "can take up to 3 months to get out").
3. **Caps.** Ranked by yield after haircut, highest first, filled by the banded fill (`bandedFill`, `yieldBand`) but in rank order rather than spread evenly; each token up to `capPerAssetBps`, its exit ceiling (`shareOfDepth` of measured capacity, the tier ceiling labelled where nothing is measured, `EXIT-SOURCE`), the 50% issuer cap (`issuerCapBps`) and the plan's credit budget (`creditShareBps` by tolerance; a person who said "go crazy" has not said "accept credit", so the default `limited` holds until the intake asks). What no token takes stays in cash with `UNPLACED`. The caps count across sleeves, as they do now for dollar yield.
4. **How it shows in the plan.** A `SPLIT_MAX_YIELD` sentence on its lines ("30% of the plan for the highest yield the caps allow"), the split in `PersonalProposal.split`, and on the card only the figures of gate `OUTCOME-VIEW`: the yield range on the dollar-yield part (low after haircut, high quoted), months paid where there are withdrawals, the named stresses (a credit loss on a credit or basis leg, a depeg), the loss in a fall (none for yield tokens), and the exit cost. No upside and no base case. The three candidates (`THREE-PLANS`) may differ in how the max-yield part is spread (by rank or evenly within the band).
5. **Tests.** Rodrigo's first chat as a sheet (70% safe yield, 30% max yield, high risk) holds no stock token; the max-yield part's yield after haircut is the highest the caps allow (no swap of a held token for an unheld higher one would fit the caps); every cap is named where it binds; shuffled shelf, same plan.
