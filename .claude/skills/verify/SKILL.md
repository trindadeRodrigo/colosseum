---
name: verify
description: Run the standard verification and record the evidence. Use before opening a pull request, and whenever someone asks whether the work is verified.
---

1. Make sure the database is up if tests need it: `pnpm db:up` (it starts Postgres with Docker and applies the migrations). If Docker is not available, say so and rely on CI for the database tests; do not skip them silently.
2. Run `pnpm verify`. It runs lint, the package typechecks, the root typecheck of `scripts/` and `tests/`, the tests and the build. Do not edit a test to make it pass; if a test is wrong, say why and fix the test in its own commit.
3. Run the check that is specific to this work, the one named in its ledger row.
4. Record the result in the row in `docs/vault/STATE-VAULT.md`: the command, the outcome (for example "22 test files pass"), the date, and a link once CI has run. Write what could not be verified and why.
5. If anything failed, the work is not done. Fix it and run this again.
