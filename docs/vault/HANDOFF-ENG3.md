# HANDOFF: ENG-3, the solver slices, where the last session stopped

> For a fresh Claude Code session that continues `docs/vault/PROMPT-BUILD-SOLVER.md`. Read that prompt first, then this. Written 2026-10-05 by the session that built slice 1. Delete this file in the pull request that finishes ENG-3.

## Where things are

| Piece | Branch | State |
|---|---|---|
| Rodrigo's decisions of Oct 5 and the prompt | `docs/decisions-oct5-rodrigo`, PR #43 into `staging` | Open, **not merged** (a person merges); its content already reached `staging` through #47 |
| The research note | `docs/portfolio-method`, PR #23 | Merged into `staging` |
| Thom's engine (ENG-2) | `eng/personal`, PR #47 | **Merged into `staging`** on Oct 5 |
| Slice 1: the banded fill and the caps (ENG-3) | `engine/fill`, PR #46, **now into `staging`** | `staging` merged in at `1782c24`; Thom's two new roll-up pins in `personalize.test.ts` re-pinned to slice 1's plan (explained in the commit); engine + API tests green |
| Slice 2: the sheet, currency, sleeves, coverage | `engine/sheet`, draft PR #48 into `engine/fill` | `engine/fill` merged in; see "Slice 2 progress" below |

Worktree used: `~/Documents/Colosseum-engine` (a `git worktree` of the main checkout). Start the session in the main checkout (`~/Documents/Colosseum`) so the hooks load, and work in that worktree, or make a new one.

Merge order: #46 → #48 (retarget #48 to `staging` once #46 merges) → slice 3 …

## Settled in the last session (in `docs/GATES.md`)

- The slices build on Thom's `eng/personal`, not from scratch (Rodrigo, Oct 5; the prompt says so).
- `SOLVER-CAPS`: the 50% issuer cap binds on dollar yield, gold and cash, counting only those sleeves; tokens the cap table does not name take their leg type's figure (market deposit 60%, rate 40%, credit and basis 40%); credit tolerance defaults to `limited` (25%).
- Ledger: Thom's port is ENG-2; the solver slices are ENG-3.

## How slice 1 is built (what slice 2 plugs into)

- `packages/engine/src/personal/fill.ts`: `bandedFill`, pure, whole cents.
- `placement.ts`: `Book.fillBanded` places dollar yield; `usedOf` counts an issuer per sleeve; `creditUsed`.
- `world.ts`: `yieldCapOf`, `issuerCapOf`, `isCredit`, `creditBudget`.
- `params.ts`: the `SOLVER-PARAMS` numbers, marked `set`, including `setAsideMonths` (6), `driftBandBps` (500), `switchDays` (7) not read yet.
- `leg-types.ts`: leg types per symbol, local until slice 2 moves them onto the shelf asset (a schema change, Thom approves).
- Test helpers: `roomyYield()` (a table where dollar-yield limits do not bind, for tests about sleeves), `violations()` (every plan rule and every sentence of the fill).
- Consequence Rodrigo has seen: an income plan on Solana is 50% jlUSDC, 25% syrupUSDC, 25% cash.

## Slice 2

See the section "Slice 2 progress" at the end of this file, kept up to date by the session working on it.

## Open items for people

- Thom: open the `eng/personal` PR; review #46 (it changes his placement and tests); approve the slice 2 schema commit; decide whether the mock app gets yield readings in `fixtures/` (today the mock answers no dollar yield, since a missing yield is never counted as zero).
- Rodrigo: merge #43; judge the 25% cash on Solana income plans; confirm the Solana AI theme list in slice 4.

## Slice 2 progress

Branch `engine/sheet`, from `engine/fill` (PR #46). Draft PR into `engine/fill`, so Thom can approve the schema commit early.

**Done**

- `5bccfad` (**the shared type change, its own commit; Thom approves**): `BasketSheet` gains `currency?`, `obligations?`, `sleeves?` (`PlanSleeves`: shares add up to 10,000, one goal and one safe-yield sleeve at most, each theme once) and `restoreSplit?`, all optional. `sleevesOf` and `currencyOf` give the defaults: dollars, one goal sleeve at 10,000. `BasketSheetDraft` gains the same four fields, nullable and defaulting to null, so old drafts still parse. Tests: `tests/plan-sleeves.test.ts`.
- `62ccf9c`:
  - The rules draft fills the new fields with null.
  - The 12-goal set expects `currency: 'USD'` for every goal.
  - `compose` (in `world.ts`) **refuses** a non-dollar currency, obligations, or a split into sleeves, with `InvalidSheet` "not built yet", so nothing is silently ignored.
  - The API round-trips `currency`, `sleeves` and `restoreSplit`, and gives 400 on bad shares.
  - DESIGN 3.6 lists the fields.

- `bcb739f` **Step 1, sleeves in the engine** (done):
  - `sizeSleeves` scales the row and the date's floors to the goal share (floors rounded up); `mustKeep` counts the safe-yield share. `SleevePlan` gains `goalBps`, `safeYieldBps`.
  - `compose` places the safe-yield sleeve **before** the goal's dollar yield (it can hold only rate legs, so it has first call on them), with `fillBanded` over `w.isRateOnly` tokens; what is left stays in cash with `SAFE_YIELD_NO_RATE` (no rate leg at all, flag `safe_yield_no_rate_leg`) or `UNPLACED`.
  - New templates `SPLIT_GOAL`, `SPLIT_SAFE_YIELD`, `SAFE_YIELD_NO_RATE`; new input name `sleeves`.
  - `PersonalProposal.split?` (engine type only; `sharedProposal` in the API strips it, so the API answer is unchanged). Rebalancing per sleeve (slice 4) will need it in the shared `BasketProposal`: a schema change for Thom then.
  - A theme sleeve is still refused ("a theme sleeve is not built yet").
  - Tests: `sleeves.test.ts` (10); the property tests now generate splits (`splitOn`) for the violations and determinism properties; `violations()` checks the split's shares and dollars, the safe-yield sleeve in rate legs and cash only, `SPLIT_*` sentences only on split plans, and that `mustKeepUsd` is in dollar yield and cash. Two mutations (safe yield over every leg type; `mustKeep` not counting the sleeve) each fail a test.
  - **For Rodrigo:** on Solana the launch shelf has no rate-only token (jlUSDC is a market deposit, syrupUSDC credit and basis), so a safe-yield sleeve on Solana is all cash, said and flagged. On Robinhood Chain it is SGOV to its 40% cap, then cash.

- `f354d75` (**the second shared type change, its own commit; Thom approves**): `BasketAsset.currency?` (ISO 4217, only on cash tokens; no DB column until the first such token) and `ObservationRef.kind` gains `fx`. Test in `tests/vault-schemas.test.ts`.
- `e273aae` **Step 2, currency and the matching leg** (done, as designed below): `world.currency`, `world.cash` is the dollar cash token, `world.matchingOf(cur)`, `world.fxOf(cur)` (records the `fx` observation only when used), `ComposeContext.fx` validated (pair `^[A-Z]{6}$`, finite positive rate; the latest reading per pair counts), hashed only when given. Flags `fx_open:<cur>` and `no_matching_leg:<cur>`; `FX_OPEN` sentence on every line not in the goal's currency. New input names `currency`, `obligations`. `violations()` holds the open-FX line both ways. Tests: `currency.test.ts` (4), which also exports the MOCK `reaisToken()`, `withReais` and `usdBrl()` for step 3. The API test now expects a reais goal with a goal/safe-yield split to be answered (200, `fx_open:BRL`).

- **Steps 3 to 6** (done, one commit after `f4383c1`; DESIGN §7 "As built (ENG-3 slice 2)" has the rules):
  - Step 3, setting aside: `set-aside.ts` `setAsideOf` and `placeSetAside`; `world.withdrawals` (converted at the FX reading, refused without one, past ones flagged `obligations_past`); `sizeSleeves(w, setAsideBps)` scales the row to the goal less the set-aside; `Book.fillInOrder` for rate legs, most liquid first. The `obligations` refusal is gone. Cash for the liquidity window is read as the existing cash floor.
  - Step 4, the coverage check: `checkCoverage`, one window's capacity a month (cautious), pools through the LOCAL TYPE `PooledLiquidityProvider` (no shared-type change); moves the unsellable part to cash, then stocks and gold; `Book.toCash`.
  - Step 5, the schedule: `schedule.ts` `scheduleOf`, `PersonalProposal.schedule` (engine type only; the API strips it like `split`).
  - Step 6, the tests: `withdrawals.test.ts` (12): set-aside on Solana (cash) and Robinhood (SGOV); window, past, short, missing FX; dollars against reais on the same shelf; the shared-pool fixture (`pooledLiquidity`, MOCK second rate leg `secondRateToken`); the schedule against the par draw on 200 random plans. `violations()` checks set-aside, the withdrawal sentences, coverage flags and the schedule; the property tests generate withdrawals and a currency. Two mutations (coverage blind to pools; set-aside never placed) fail tests. The API test now expects withdrawals to be answered and echoed.
  - Property runs found three cases on the way, all fixed: a cap sentence for a rate leg too small for a line; a goal sleeve under a cent; a plan with no goal sleeve.
- **Not done in slice 2:** an FX stress on the schedule (it comes with slice 3's status); the schedule draws at one rate for the whole term.

Next: `/verify`, `/review-pr` by an agent that did not write it, take #48 out of draft, update ENG-3 in `docs/vault/STATE-VAULT.md`.

**Watch for:**
- `violations()` in `testing.ts` must learn sleeves and the set-aside rule, or the property tests will not see a broken split.
- Thom's tests that compare sleeves to `expectedSleeves()` must keep passing when no split is given.

**Design agreed for steps 2 and 3** (step 2 built as written; step 3 not built yet):
- The matching leg is a shelf token of class `cash` with `currency` set (a new optional `BasketAsset.currency`, ISO 4217, only on cash tokens: **a second schema commit for Thom**). `world.cash` becomes the cash token in dollars; `world.matchingOf(currency)` the cash token in that currency on the chain, or null. No BRL-specific code (G-NORA): it is any currency.
- Its cap: no new parameter. As a cash-class token it already takes the plan's 50% issuer cap (`SOLVER-CAPS`) and its exit ceiling (tier or measured). The old engine's `BRL_LEG_CAP_WEIGHT_DEFAULT` (0.3) is not carried over; if Rodrigo wants a separate cap, it is a parameter outside the table and his call.
- FX: `ComposeContext.fx?: FxObservation[]`, pair `USD<cur>` (units of the currency per dollar), validated like yields, recorded in `observations` (kind `fx`). Needed only to convert withdrawals not in dollars; a goal in reais with no withdrawals needs none. A withdrawal in a currency with no FX reading is refused (`InvalidContext`), never guessed.
- The open-FX line: for a goal not in dollars, flag `fx_open:<cur>` and an `FX_OPEN` reason on each line not in the goal's currency. A dollar goal has neither. With no matching leg on the shelf: flag `no_matching_leg:<cur>` and a reason on the cash line.
- Set-aside (step 3): the withdrawals of this month and the next five, converted to dollars, become a set-aside share taken off the goal sleeve before the table is scaled (`sizeSleeves` scales to `goal − setAside`); if it is more than the goal sleeve, it is held to it, flagged `set_aside_short`, and said. Placed first: in the matching leg for withdrawals in its currency, in rate-only legs by measured exit capacity (most liquid first, unmeasured last, by id) for dollars, the rest in cash. The reason names the months and the amounts.

## Next engine task: the max-yield sleeve (gate `MAX-YIELD-SLEEVE`, Rodrigo, Oct 6)

When a person wants "the highest yield possible" for a part of the plan, that part fills with the highest-yield eligible assets within the caps, instead of stocks. Today such a part is a goal sleeve and fills from the sleeve table (at high risk, 95% stocks): in Rodrigo's first `/plan-chat` the 30% "to go crazy for the highest yield" became SPYx. The intake already flags it (`max_yield_asked`) and says that the part is built as a goal to grow; the chat says it in one line.

**Depends on the `shelf/*` branches** (the fixed-income shelf research, `docs/vault/PROMPT-YIELD-SHELF.md`, cut from `tools/try-plans`): on Solana the launch shelf has two dollar-yield tokens (jlUSDC, syrupUSDC) and no rate leg, so a max-yield sleeve built today would hold the same two tokens as the goal sleeve's dollar yield. Start once those fixtures and their readings land.

1. **The sleeve objective (a shared type change: its own commit, Thom approves).** `PlanSleeve` in `packages/schemas/src/basket-sheet.ts` gains a kind `{ kind: 'max_yield', shareBps }`, at most one per plan (the `PlanSleeves` refine), beside `goal`, `theme` and `safe_yield`. A kind rather than a field on the goal sleeve: the goal sleeve keeps its table, and a plan can hold a safe part, a max-yield part and a goal part. `BasketSheetDraft.sleeves` takes it with no change. The intake's reply schema (`apps/api/src/llm.ts`) and `REPLY_FIELDS.sleeves` (`intake.ts`) gain the kind, the read-back a `SLEEVE_MAX_YIELD` sentence, and `MAX_YIELD_LATER` goes.
2. **Which assets qualify.** Tokens of class dollar yield on the plan's chain (`ONE-CHAIN`) of any leg type (market deposit, rate, credit, basis), plus the yield positions the shelf research adds (a Uniswap LP, Pendle PT-USDG on Robinhood Chain), each with a stored yield reading carrying `source`, `fetched_at` and `method` (no reading, left out with `NO_YIELD`; never zero). No stocks, crypto or gold: they have no yield reading and no return is assumed for them. The person's refusals hold (`cannotHold`, `creditTolerance: none` leaves out credit and basis legs). A token whose exit is longer than the person's time to get out, where they gave one for this part, is left out (needs a per-sleeve exit limit: a second field in the same schema commit, `maxExitMonths?` on the sleeve, read from "can take up to 3 months to get out").
3. **Caps.** Ranked by yield after haircut, highest first, filled by the banded fill (`bandedFill`, `yieldBand`) but in rank order rather than spread evenly; each token up to `capPerAssetBps`, its exit ceiling (`shareOfDepth` of measured capacity, the tier ceiling labelled where nothing is measured, `EXIT-SOURCE`), the 50% issuer cap (`issuerCapBps`) and the plan's credit budget (`creditShareBps` by tolerance; a person who said "go crazy" has not said "accept credit", so the default `limited` holds until the intake asks). What no token takes stays in cash with `UNPLACED`. The caps count across sleeves, as they do now for dollar yield.
4. **How it shows in the plan.** A `SPLIT_MAX_YIELD` sentence on its lines ("30% of the plan for the highest yield the caps allow"), the split in `PersonalProposal.split`, and on the card only the figures of gate `OUTCOME-VIEW`: the yield range on the dollar-yield part (low after haircut, high quoted), months paid where there are withdrawals, the named stresses (a credit loss on a credit or basis leg, a depeg), the loss in a fall (none for yield tokens), and the exit cost. No upside and no base case. The three candidates (`THREE-PLANS`) may differ in how the max-yield part is spread (by rank or evenly within the band).
5. **Tests.** Rodrigo's first chat as a sheet (70% safe yield, 30% max yield, high risk) holds no stock token; the max-yield part's yield after haircut is the highest the caps allow (no swap of a held token for an unheld higher one would fit the caps); every cap is named where it binds; shuffled shelf, same plan.
