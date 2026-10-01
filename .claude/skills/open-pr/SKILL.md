---
name: open-pr
description: Open a pull request in the house style. Use when a branch is verified and ready for review.
argument-hint: "[base branch, default staging]"
---

Base branch: `$ARGUMENTS` if given, otherwise `staging`. Only a pull request from `staging` targets `main`.

Before opening:

- `/verify` has passed on this exact commit, and the ledger row has the evidence.
- The branch is up to date with its base (`git fetch`, then merge or rebase if the base moved).
- `git diff <base>...HEAD` contains only this work. Look at it.
- If the work changed a decision or anything a document says, the documents and `docs/GATES.md` are updated in this branch (`/decide`).
- Nothing private: no key, no token, no private RPC URL, no `.env`.

Then push the branch and open the pull request with `gh pr create --base <base>`, using `.github/pull_request_template.md`. Write it the way a busy engineer leaves a note for a teammate: what changed and why in a few sentences, the evidence stated once, the ledger id. No checklists of emoji, no restating the diff.

After it is open, read its checks. A red check is yours to fix before asking anyone to review. Do not merge your own pull request into `main`; merging into `main` needs a person's word.
