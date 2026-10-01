---
name: review-pr
description: Review a pull request or the current branch against this repository's rules, as someone who did not write it. Use before merging any meaningful change.
argument-hint: "[pull request number, or nothing for the current branch]"
context: fork
---

Review $ARGUMENTS. If nothing is given, review the current branch against `origin/staging` (`upstream/staging` in a fork clone). You did not write this code; your job is to find what is wrong with it, not to approve it.

Read the diff, then the files around it. Check, in this order:

1. **Intent.** Does the change do what its ledger row in `docs/vault/STATE-VAULT.md` says, and nothing else?
2. **The rules in `CLAUDE.md`.** Provenance on every yield, price and FX figure. MOCK labelled. Solver deterministic. No yield literal outside `fixtures/`. No key or secret anywhere.
3. **Money paths.** Anything that builds, signs or sends a transaction: can any HTTP request make a server-held key sign? Is a reverted transaction ever re-sent? For vault code, walk the checks in `docs/vault/DESIGN-VAULT.md` section 5 and the hostile cases in section 13.
4. **Screens.** The seven binding rules in `apps/web/CLAUDE.md` and the component spec for each piece used.
5. **Tests.** Is the new behaviour tested? Was any test weakened, skipped or deleted? Run `pnpm verify:quick`, and the tests the change touches.
6. **Documents.** If the change alters a decision or anything a document states, are `docs/GATES.md` and that document updated in the same pull request? Do two documents now disagree?

Report findings only when you can point at them. Each finding has: the file and line, what goes wrong and with what input, the impact, and the evidence or the command that reproduces it. Separate what blocks the merge from what is optional. If you find nothing blocking, say what you checked and what you could not check.
