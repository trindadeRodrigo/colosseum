# HANDOFF: ENG-3, the solver slices, where the last session stopped

> For a fresh Claude Code session that continues `docs/vault/PROMPT-BUILD-SOLVER.md`. Read that prompt first, then this. Rewritten 2026-10-06 by the session that finished slice 2 and started slice 3. Delete this file in the pull request that finishes ENG-3.

## Where things are

| Piece | Branch / PR | State |
|---|---|---|
| Rodrigo's decisions of Oct 5 | #43 | **Merged** into `staging` (Oct 6) |
| Thom's engine (ENG-2) | #47 | Merged |
| Slice 1: the banded fill and the caps | `engine/fill`, #46 | **Merged** (Oct 6) |
| Slice 2: the sheet, currency, sleeves, withdrawals, coverage, schedule | `engine/sheet`, #48 | **Merged** (Oct 6, `a87a52c`). Rodrigo merged it before Thom approved its two schema commits (`5bccfad`, `f354d75`): Thom should still read them |
| Slice 3: three plans, scorecard, status | `engine/plans`, draft PR into `staging` | **Part 1 of 3 done** (the status); see below |
| Slice 4 | none | Not started |

Worktree: `~/Documents/Colosseum-engine` (a `git worktree` of the main checkout), on `engine/plans`. Start the session in the main checkout so the hooks load, and work in that worktree. Its `apps/web/.next` goes stale when `staging` moves pages: delete it (gitignored) if the web typecheck names a missing page.

## What exists now (in `packages/engine/src/personal/`)

DESIGN §7 "As built (ENG-3 slice 2)" and "As built (ENG-3 slice 3, part 1)" hold the rules. In short:

- `fill.ts`, `placement.ts` (`Book.fillBanded`, `fillInOrder`, `toCash`): the banded fill, caps, issuer cap 50% on dollar yield, gold and cash (`SOLVER-CAPS`), credit budget.
- `world.ts`: validation; `withdrawals` converted at the FX reading (refused without one); `matchingOf`, `fxOf`.
- `set-aside.ts`: the next `setAsideMonths` of withdrawals placed first; the coverage check, with pools through the LOCAL TYPE `PooledLiquidityProvider`.
- `schedule.ts`: `scheduleOf`, in the goal's currency, at measured exit cost, with `atPar` and a named `stress`.
- `status.ts`: `statusOf` and `stressesFor`. `PersonalProposal.schedule` and `.status` are engine types; the API strips them.
- Tests to model new ones on: `withdrawals.test.ts`, `status.test.ts`, and `violations()` in `testing.ts` (every property test runs it; teach it each new rule, or the property tests will not see it broken).

## Slice 3: what is left, in order

1. **Ways to close a gap** (section 2.5 item 4): re-run the engine one input at a time with the others fixed. Build two: the smallest larger amount whose status is met (reuse `smallestThatMeets` in `compose.ts`; the `meets` run must then build the schedule and status, which `withWays = false` skips today), and the largest scale of the withdrawals that is met. Later start and a monthly contribution have no field on the sheet: say so, do not invent one.
2. **The three candidates** (section 2.4, C10): `candidates(sheet, shelf, context)` runs `compose` three times with parameter overrides inside the person's limits:
   - Cover: `setAsideMonths` 12, credit share 0, `tau` and `shareOfDepth` tighter.
   - Spread: dollar yield filled equally within caps (a `yieldBand` of 1 does it: every token in one band), a tighter issuer cap.
   - Carry: the table as it is.
   - Two within 1,000 bps of each other (`distanceBps` in `testing.ts`): keep the first in the fixed order, say why the other is not shown. None marked, no "selected" field, a fixed neutral order.
   - **The override numbers are not in any document:** put them in the table as a `candidates` row marked `starting`, and list them for Rodrigo, as `stress` is.
3. **The scorecard** (C11), per candidate: months covered by cash and the matching leg; base and stressed months paid (the status has them); exit cost and measured share, and concentration (`rollUp`); credit and basis share; open FX (withdrawals beyond the matching leg, none for a dollar goal). Yield confidence and primary redemption need data the shelf does not carry: leave them out and say so.
4. **The API**: `POST /v1/baskets/personalize` answering candidates is a shared-type change (`BasketProposal` has no candidates, scorecard or status): its own commit, for Thom.
5. **Tests** (C10–C12): on a grid of goals no candidate is weakly dominated on the scorecard and each wins at least one attribute; the no-odds scan (done, in `status.test.ts`) extended to the API answer once candidates are there.

Then `/verify`, `/review-pr` by an agent that did not write it, out of draft, ENG-3 in the ledger.

## Slice 4 (after slice 3), as the prompt orders it

- The guided intake (`apps/api`) needs only slice 2's schema, now on `staging`: it can run beside slice 3 in its own worktree.
- Themes and the safe-yield switch: the proposed Solana AI list is **Rodrigo's to confirm** (`THEMES`).
- Rebalancing per sleeve needs `split` in the shared `BasketProposal`: Thom.

## Open items for people

- **Rodrigo:**
  - the stress sizes (`stress` in `params.ts`, the old engine's: yields −50%, credit gated 6 months, the goal currency ±20% over 12 months; stocks and gold fall `fallBps`);
  - the candidate overrides, when slice 3 adds them;
  - the 25% cash in Solana income plans;
  - the Solana AI theme list in slice 4.
- **Thom:**
  - read slice 2's two schema commits, merged without his approval;
  - approve the shared-type change of slice 3;
  - decide whether the mock app gets yield readings for Robinhood Chain (`apps/api/src/testing/fixtures/mock-yields.json` has Solana's only, so a Robinhood plan on the mock holds no dollar yield).
- **The API reads no FX readings yet:** a withdrawal in another currency answers 422 with the fix. Wiring a source of FX readings is open.
