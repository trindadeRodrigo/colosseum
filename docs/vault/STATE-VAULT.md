# STATE-VAULT.md: the task ledger

One list of tasks for the vault work and the repository around it. Status is `todo | in-progress | in-review | done | blocked`. Evidence points to a command and its result, a pull request, a CI run or a transaction. Update the row in the pull request that does the work. Times are UTC.

## Repository and process

| ID | What it delivers | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|
| ORG-1 | The vault documents, the audit and green checks on `main` | Thom | done | PR #2, merged 2026-10-01 19:32 as `9eb082d`. CI on `main` after the merge: lint, both typechecks, migration, 22 test files, build, all pass | |
| ORG-2 | The repository organised: documents in three folders with an index, third-party photos removed, one-off mainnet scripts archived, the live one isolated, dead code removed, the alias block declared once, a complete `.env.example` loaded from the repo root by every app | Thom | done | PR #3 into `staging`: `pnpm verify` green in CI. Reviewed on 2026-10-01 by three agents that did not write it (documents, code and config, Claude setup); what they confirmed is fixed in the same pull request | |
| ORG-3 | The shared Claude setup: `CLAUDE.md`, `.claude/rules/orchestration.md`, `.claude/settings.json` with four hooks, six commands, a pull-request template, `pnpm verify` | Thom | done | PR #3. `tests/claude-hooks.test.ts` runs 130 commands through the guard (63 blocked, 67 allowed) and the push forms from `main`. Checked live in a scratch project: `.env` and `.env.production` unreadable, `.env.example` readable. Not covered: a command written to get around the guard, and a session started outside the checkout, where nothing loads | |
| ORG-4 | The `staging` branch and the flow into `main` | Thom | done | `staging` created from `main` on 2026-10-01 | |
| ORG-5 | `main` and `staging` protected: no direct push, checks required | Rodrigo | todo | | Needs repository admin |
| ORG-6 | A decision on what early planning material stays in the public tree: the first handoff, plan and video script under `docs/structurer/`, and `discover/` and `strategy/naming.md` in the design folder | Rodrigo, Thom | todo | | |

## Before the build

| ID | What it delivers | Owner | Status | Evidence | Blocked by |
|---|---|---|---|---|---|
| PLAN-1 | `docs/vault/PLAN-VAULT.md`: the streams as slots, with dates, owners and the cut order | Thom | todo | | ORG-2, ORG-3 |
| OPS-1 | The three $10 mainnet tests of the vault rigs (`spikes/`), one per chain | Thom (a person) | todo | | Funded wallets |
| OPS-2 | The Privy apps, a second Jupiter organisation, the origin for passkeys | Thom (a person) | todo | | |
| SEC-1 | The two live approvals on the demo wallet revoked (5 USDY, 5 syrupUSDC to the agent key) | Rodrigo (a person) | todo | | |
| DES-1 | One specification of the provenance pin, and the final logo artwork | Rodrigo | todo | | |
| ENG-1 | The goal status for every goal kind, and the odds estimate | Rodrigo | todo | | |
| ENG-2 | The risk scripts read the root `.env`: `risk:retier`, `risk:routing-gap`, `risk:pareto` and `risk:discover` load none, and `risk:registry` reads the RPC URL before the file loads. `esbuild`, which the collector installer calls, becomes a declared dependency | Rodrigo | todo | | After Oct 12: the collectors are not touched before |
| DES-2 | The four photos in the landing prototype (`closing.avif`, `closing.jpg`, `photo-ridge.jpg`, `photo-trip.jpg`) replaced, or given a licence note beside them | Rodrigo | todo | | |

The build streams are added here when `PLAN-VAULT.md` is written.
