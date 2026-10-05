# HANDOFF: ENG-3, the solver slices, where the last session stopped

> For a fresh Claude Code session that continues `docs/vault/PROMPT-BUILD-SOLVER.md`. Read that prompt first, then this. Written 2026-10-05 by the session that built slice 1. Delete this file in the pull request that finishes ENG-3.

## Where things are

| Piece | Branch | State |
|---|---|---|
| Rodrigo's decisions of Oct 5 and the prompt | `docs/decisions-oct5-rodrigo`, PR #43 into `staging` | Reviewed; review fixes pushed; **not merged** (an agent may not merge it without a second review of the fix commit; a person merges) |
| The research note | `docs/portfolio-method`, PR #23 | Merged into `staging` |
| Thom's engine (ENG-2): `compose`, sleeves table, exit ceilings, `POST /v1/baskets/personalize` | `eng/personal` | No PR yet; Thom opens it |
| Slice 1: the banded fill and the caps (ENG-3) | `engine/fill`, PR #46 into `eng/personal` | Open; `pnpm verify` green; independently reviewed twice, findings fixed |
| Slice 2: the sheet, currency, sleeves, coverage | `engine/sheet`, from `engine/fill` | See "Slice 2" below |

Worktree used: `~/Documents/Colosseum-engine` (a `git worktree` of the main checkout). Start the session in the main checkout (`~/Documents/Colosseum`) so the hooks load, and work in that worktree, or make a new one.

Merge order: #43 → `eng/personal` → #46 → slice 2 → … Once `eng/personal` is in `staging`, retarget open PRs to `staging`.

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

**Left in slice 2**, in this order. Each step removes its refusal in `world.ts` as it lands.

1. **Sleeves in the engine.** `sizeSleeves` (`exposure.ts`) takes its sizes from `sleevesOf(sheet)` when the person gave a split:
   - A goal sleeve keeps today's table and floors, scaled to its share.
   - A safe-yield sleeve is dollar yield only, rate legs only (leg type `rate`), filled by `fillBanded`.
   - A theme sleeve waits for slice 4. Until then, refuse a theme sleeve and accept goal plus safe-yield splits.
   - The restore choice is stored only; slice 4 uses it.
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
