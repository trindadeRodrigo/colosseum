---
name: open-pr
description: Open a pull request in the house style. Use when a branch is verified and ready for review.
argument-hint: "[base branch, default staging]"
---

Base branch: `$ARGUMENTS` if given, otherwise `staging`. Only a pull request from `staging` targets `main`.

Before opening:

- `/verify` has passed on the code being pushed, and the ledger row has the evidence (the row may be the last commit).
- The branch is up to date with its base: `git fetch`, then merge the base in if it moved. Do not rebase a branch that is already pushed; force pushes are blocked.
- `git diff origin/<base>...HEAD` (`upstream/<base>` in a fork clone) contains only this work. Look at it.
- If the work changed a decision or anything a document says, the documents and `docs/GATES.md` are updated in this branch (`/decide`).
- Nothing private: no key, no token, no private RPC URL, no `.env`.

Then push the branch (`git push -u origin HEAD`) and open the pull request with `gh pr create --base <base>` (from a fork clone, add `--repo trindadeRodrigo/colosseum`), using `.github/pull_request_template.md`. Write it the way a busy engineer leaves a note for a teammate: what changed and why in a few sentences, the evidence stated once, the ledger id. No checklists of emoji, no restating the diff.

After it is open, read its checks. A red check is yours to fix before asking anyone to review. Do not merge your own pull request into `main`; merging into `main` needs a person's word.
