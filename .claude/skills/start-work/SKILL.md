---
name: start-work
description: Start a piece of work the standard way. Use at the beginning of any task that will change files in this repository, before editing anything.
argument-hint: "[ledger id or short description]"
---

Start the work described by: $ARGUMENTS

1. **Sync.** Run `git fetch --all --prune` and `git status`. If the working tree has uncommitted changes that are not part of this task, stop and say so.
2. **Find the row.** Open `docs/vault/STATE-VAULT.md` and find the row for this work. If there is none, add one: id, what it delivers, owner, status `in-progress`, and what "done" will look like as a check someone can run. If the work is not in the approved scope (`docs/vault/HANDOFF-VAULT.md`, `docs/vault/DESIGN-VAULT.md`), stop and ask.
3. **Read the spec** for the piece you will touch, and `.design/branding/working-brand/patterns/STYLE.md` if a screen is involved.
4. **Branch.** Create `<area>/<short-name>` from the tip of `staging` (`git switch -c <branch> origin/staging`, or `upstream/staging` where that is the shared remote). Never work on `main` or `staging`.
5. **Say what done means** before writing anything: the acceptance criteria, the check that proves each one, the files you expect to change, and anything that needs a person (a decision, a key, a mainnet action).

Then do the work. Finish with `/verify` and `/open-pr`.
