# STATE-VAULT.md: the task ledger

One list of tasks for the vault work and the repository around it. Status is `todo | in-progress | in-review | done | blocked`. Evidence points to a command and its result, a pull request, a CI run or a transaction. Update the row in the pull request that does the work. Times are UTC.

## Repository and process

| ID | What it delivers | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|
| ORG-1 | The vault documents, the audit and green checks on `main` | Thom | done | PR #2, merged 2026-10-01 19:32 as `9eb082d`. CI on `main` after the merge: lint, both typechecks, migration, 22 test files, build, all pass | |
| ORG-2 | The repository organised: documents in three folders with an index, third-party photos removed, one-off mainnet scripts archived, the live one isolated, dead code removed, the alias block declared once, a complete `.env.example` loaded from the repo root by every app | Thom | in-review | `pnpm verify:quick` passes locally; tests and build in CI on the pull request | |
| ORG-3 | The shared Claude setup: `CLAUDE.md`, `.claude/rules/orchestration.md`, `.claude/settings.json` with four hooks, six commands, a pull-request template, `pnpm verify` | Thom | in-review | Hook tests: pushes to `main` and `staging`, force pushes, mainnet scripts and `--no-verify` are blocked; ordinary commands pass | |
| ORG-4 | The `staging` branch and the flow into `main` | Thom | done | `staging` created from `main` on 2026-10-01 | |
| ORG-5 | `main` and `staging` protected: no direct push, checks required | Rodrigo | todo | | Needs repository admin |

## Before the build

| ID | What it delivers | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|
| PLAN-1 | `docs/vault/PLAN-VAULT.md`: the streams as slots, with dates, owners and the cut order | Thom | todo | | ORG-2, ORG-3 |
| OPS-1 | The three $10 mainnet tests of the vault rigs (`spikes/`), one per chain | Thom (a person) | todo | | Funded wallets |
| OPS-2 | The Privy apps, a second Jupiter organisation, the origin for passkeys | Thom (a person) | todo | | |
| SEC-1 | The two live approvals on the demo wallet revoked (5 USDY, 5 syrupUSDC to the agent key) | Rodrigo (a person) | todo | | |
| DES-1 | One specification of the provenance pin, and the final logo artwork | Rodrigo | todo | | |
| ENG-1 | The goal status for every goal kind, and the odds estimate | Rodrigo | todo | | |

The build streams are added here when `PLAN-VAULT.md` is written.
