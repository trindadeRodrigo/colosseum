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
- Themes and the safe-yield switch: the proposed Solana AI list is **Rodrigo's to confirm** (`THEMES`).
- Rebalancing per sleeve needs `split` in the shared `BasketProposal`: Thom.

## Gate COUNTRY-REMOVED (Rodrigo, Oct 6)

The engine has no country rule: `blockOf` ignores `blockedCountries` and `sheet.country`, `NOT_IN_COUNTRY` and its overflow sentence are gone, and `BasketSheet.country` is optional (`941e3580`, and the shared-type commit `158f4974` for Thom). Tests that held a blocked asset out now hold it in (`inputs.test.ts` "country", `said.test.ts`). Restrictions on who may hold an asset are for sign-up and the terms of service: open for the founders.

## Open items for people

- **Rodrigo:**
  - the stress sizes (`stress` in `params.ts`, the old engine's: yields −50%, credit gated 6 months, the goal currency ±20% over 12 months; stocks and gold fall `fallBps`);
  - the candidate overrides (`candidates` in `params.ts`: Cover 12 months, credit half the person's limit (set: gate `COVER-CREDIT`), tau 0.5%, shareOfDepth 0.125; Spread one band, issuer 30%; distinct from 1,000 bps), and `wayScaleStepBps` (1%);
  - the 25% cash in Solana income plans;
  - the Solana AI theme list in slice 4.
- **Thom:**
  - read slice 2's two schema commits, merged without his approval;
  - approve the shared types of slice 3 (`ebdbb13`: `PlanCandidate`, `PlanScorecard`, `PlanStatus`, additive);
  - the web: show `candidates` side by side, none pre-selected (gate `THREE-PLANS`), instead of the one `proposal`. Done on `web/candidates` (WEB-CANDIDATES); the top-level `proposal` stays for agents only (gate `PROPOSAL-FOR-AGENTS`, Thom, Oct 6);
  - decide whether the mock app gets yield readings for Robinhood Chain (`apps/api/src/testing/fixtures/mock-yields.json` has Solana's only, so a Robinhood plan on the mock holds no dollar yield).
- **The API reads no FX readings yet:** a withdrawal in another currency answers 422 with the fix. Wiring a source of FX readings is open.
