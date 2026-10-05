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

**Left in slice 2**, in this order. Each step removes its refusal in `world.ts` as it lands.

2. **Currency and the matching leg.** For a goal in a currency other than dollars, the matching leg is the asset in that currency, if the shelf lists one. That is the BRL leg for reais: an abstract asset with a parameterised cap, no BRS-specific code (G-NORA open). It needs an FX observation per pair, with source, time and method. There is no BRL asset on the launch shelf, so a reais goal on it says so and holds the withdrawals in cash. A dollar goal has no matching leg, no FX stress and no open-FX line.
3. **Setting aside.**
   - First, cash for the liquidity window.
   - Then the next `setAsideMonths` (6) of `obligations`: in the matching leg for other currencies, or in the most liquid rate legs for dollars.
   - The reason names the months and the amounts.
4. **The coverage check (C6).** For each withdrawal in the next 6 months: what can be sold in time, after exit cost, through `LiquidityProvider.exitCapacity` and `exitCost`, must cover what is owed. If it doesn't, move money toward cash and add a reason.
   - The joint case: legs sharing one pool. The provider has no joint figure, so the fixture provider needs a "same pool" group. Test: per-asset caps pass, the shared pool fails, and the fix is visible.
5. **The schedule, ported into `personal/schedule.ts`.** Monthly, in the goal's currency. Yield legs are sold at their measured exit cost, not at par (C7). Do not edit `packages/engine/src/schedule`. Test: with a provider, months funded falls or holds, never rises, against the par draw.
6. **The tests the prompt names:**
   - The same goal in dollars and in reais: the dollar plan has no matching leg, no FX stress and no open-FX line; the two differ only by the matching leg and what funded it.
   - The coverage fixture.
   - Sleeve validation (done) and the restore round trip (done).

Then `/verify`, `/review-pr` by an agent that did not write it, take the draft PR out of draft, and update ENG-3 in `docs/vault/STATE-VAULT.md`.

**Watch for:**
- `violations()` in `testing.ts` must learn sleeves and the set-aside rule, or the property tests will not see a broken split.
- Thom's tests that compare sleeves to `expectedSleeves()` must keep passing when no split is given.

**Design agreed for steps 2 and 3** (by the session that built step 1; not built yet):
- The matching leg is a shelf token of class `cash` with `currency` set (a new optional `BasketAsset.currency`, ISO 4217, only on cash tokens: **a second schema commit for Thom**). `world.cash` becomes the cash token in dollars; `world.matchingOf(currency)` the cash token in that currency on the chain, or null. No BRL-specific code (G-NORA): it is any currency.
- Its cap: no new parameter. As a cash-class token it already takes the plan's 50% issuer cap (`SOLVER-CAPS`) and its exit ceiling (tier or measured). The old engine's `BRL_LEG_CAP_WEIGHT_DEFAULT` (0.3) is not carried over; if Rodrigo wants a separate cap, it is a parameter outside the table and his call.
- FX: `ComposeContext.fx?: FxObservation[]`, pair `USD<cur>` (units of the currency per dollar), validated like yields, recorded in `observations` (kind `fx`). Needed only to convert withdrawals not in dollars; a goal in reais with no withdrawals needs none. A withdrawal in a currency with no FX reading is refused (`InvalidContext`), never guessed.
- The open-FX line: for a goal not in dollars, flag `fx_open:<cur>` and an `FX_OPEN` reason on each line not in the goal's currency. A dollar goal has neither. With no matching leg on the shelf: flag `no_matching_leg:<cur>` and a reason on the cash line.
- Set-aside (step 3): the withdrawals of this month and the next five, converted to dollars, become a set-aside share taken off the goal sleeve before the table is scaled (`sizeSleeves` scales to `goal − setAside`); if it is more than the goal sleeve, it is held to it, flagged `set_aside_short`, and said. Placed first: in the matching leg for withdrawals in its currency, in rate-only legs by measured exit capacity (most liquid first, unmeasured last, by id) for dollars, the rest in cash. The reason names the months and the amounts.
