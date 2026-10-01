# Design v2: review log

Oct 1, 2026. What the three reviews (scope, security, seams) changed in `docs/DESIGN-VAULT.md`, and what was not taken.

Thom asked whether work can run in parallel instead of waiting. It can: only the TypeScript streams wait for the frame (PR1a). The Solana program, the contracts, Rodrigo's streams, the Privy page, the personalization port and account opening start now (sections 15 and 16).

Length: about 8,200 words of prose. With tables and the interface listings in section 3 the file is about 15,600 by `wc -w`, above the 6,000 to 8,000 target. The listings are what the build agents code against, so they stayed.

## Must-fix, all applied

| Finding | Change |
|---|---|
| Scope 1: the gate was decided before its evidence, and there were three auto-follow test cycles in total | The publish delay is a parameter with a one-way `launch()` latch on both families: 300 s on team money from Oct 5, then a 12-hour floor that cannot drop. Rehearsals move to Oct 6 and 7, the gate stays Oct 8 noon, footage is recorded Oct 7, and Oct 9 confirms one cycle at production settings. `authority-check` reads the latch and the delay |
| Scope 2: every stream waited on one person's Oct 2 | PR1 split into PR1a (types, mock, migration) and PR1b (boundary test, workflows). SOL, EVM, RISK, BRAND, OPS, the Privy page and the personalization port do not wait. The Anchor 1.2 port is dropped. Thom does only the $10 runs during the Oct 2 session |
| Scope 3 and security 2: GitHub cron cannot run `basket` code, and the workaround exposes the keys | The keeper is `keeper --loop` on a team machine with no coding agent, started for session hours. The guardian key is out of the keeper's store and its powers only tighten. GitHub Actions is written up as the later option with the reviewer's hardening and a question for Rodrigo |
| Security 1: the guard checked contracts, not functions | The guard moves to `packages/sdk` and checks program, selector and arguments, with consent required for auto-follow and accept. `ownerSwap` needs an allowlisted router. Swap amounts must equal the review screen. Content security policy and a lint ban in the web app. Negative vectors are in gate `G-LINK`. One step further than asked: withdrawals pay only the owner, enforced by the vault on both families, so a redirect is not possible even past the guard |
| Seams 1: a half-rebalanced vault was never revisited, and the job key collided | The pass takes every auto-follow vault that is behind a version or not yet back in band since its last adoption. Keeper legs are keyed on `(vault_id, keeper_run_id, seq)`. `listAutoFollowVaults` takes no recipe. The keeper path needs stored targets, not a newer version |

## Should-fix and notes, applied

Scope

- 4: OPS is a stream with a runbook, a checklist per session and a named person per item. Ops scripts are idempotent with a dry run and one JSON input. All three chains funded on Oct 2. Rodrigo is asked to take the Solana sessions.
- 5: the cut list is now "out unless ahead" with dates: Anchor 0.31.1 and hand-written builders (no `basket-client` package, two kit versions instead of three), English first, no agent keys, seven MCP tools, no backfill, no off-chain capacity limits, a simple publish form, Base owner-signed by default.
- 6: `G-SEC` has two tiers. Tier 1 switches auto-follow on; tier 2 is recorded and blocks only on a real loss path.
- 7: interfaces freeze in two steps (v0 on Oct 2, final on Oct 4 evening after real adapters have built and simulated). Personal baskets are capped at 8 lines per chain. Create and first-buy sizes are measured on Oct 3.
- 8: one of Thom's agents ports the personalization prototype; Rodrigo owns the table and wording. Risk sheets per issuer family with generated fields. A 12-goal eval. A dated dump before any copy job.
- 9: one origin decided by Oct 4; the Render fallback for the web is gone; demo wallets only after that.
- 10: a 5-minute uptime ping, public pages served from the last good copy, the Supabase pooler in session mode, a cold-start test on Oct 5. The keeper lock is a row, not an advisory lock.
- 11: a second Jupiter organisation for app and keeper with fixed shares, a 30-second quote cache, the "quoted" number from stored snapshots, fixtures in tests.
- 12: a default Solana auto-follow index made only of Scope-priced tokens; The 500 as a single-asset basket outside the registry; a public read-only vault view; owner trades allowed at any hour.
- Housekeeping: the audit report and blueprint are now cited; `risk-layer` tip is `9cb2294`; chain is text with a foreign key; the Solana stack limit is 5 with one level spare, not 4 with none.

Security

- 3: create and accept carry an expected version; new error `VersionMismatch`; hostile case A18.
- 4: every proxy is initialised in its constructor; expected authorities are written before deploy; multisigs are created on Oct 4, before the deploy; A15 runs through the multisig.
- 5: the keeper plans from chain state and never signs from a stored row; its own tables and Postgres role; Supabase Data API off.
- 6: wallets are read from Privy's identity token; `aud` pinned; consent bound to a hash of the legs; a reported transaction must match the built leg.
- 7: limits keyed by user first; the client address is forwarded with a shared secret; a service key for the MCP server; a cap on Jupiter-backed routes.
- 8: closed days in the factory and Config, guardian extend-only; a multiplier probe on Robinhood Chain tokens; cases A5b and A6b; "plus any error in the price reference" in the trust notice.
- 9: turnover decays linearly on both families; shape limits from version 1; a cancel returns nothing; `flags` must be zero.
- 10: a family row only after a confirmed publish by the signed-in creator; creator address and platform badge everywhere; rank by value following; `agentLabel` shown as unverified.
- 11 and 12: token accounts are derived, never passed; data length checked; `withdrawAll` treats `false` as skipped; hard parameter bounds; Permit2 in I3; a reentrancy guard and A17; no ERC-1271; A13 in the rehearsal.

Seams

- 2: a leg is a plan step; each build is a row in `leg_attempts`; `seq` is per chain; `dependsOn` is gone; orders can be `partial`.
- 4 and 5: `sign.ts` and `wallet.ts` behind a `./server` entry, `send.ts` key-free; `parseFlags` in `schemas`; `loadCurves` in `db`; `apps/risk-api` listed; the two existing rule breaks named as dated exemptions.
- 6: section 3.4 says every provider call is worst-regime today, and fixes the curve keys.
- 7: one guard and one leg executor, both in `packages/sdk`, used by the web and by agents.
- 8: one formula each for value and display with a test vector; `view()` in `packages/basket` is the only place that computes drift; `engine` may import `basket`, so there is one `flatten`; the missing types are defined.
- 9: `familyId` is 32 random bytes, onchain on all three chains; ids and slugs have one meaning each.
- 10: reserved bytes per Solana asset entry, a vault type byte, `max_fee_bps` and `flags` at publish on Solana, `org_id` on orders, the basket-type row reworded.
- 11: `basket` adds files; Rodrigo's surfaces are switched off by a flag and deleted after the freeze.
- 12: a component above a lowered cap may stay if it falls toward the cap.

## Rejected or changed, with the reason

| Suggestion | What was done | Why |
|---|---|---|
| Scope 5: consider non-upgradeable factory and registry | Kept UUPS on both | Fees, CCIP publishing and price sources all land in those two contracts. The cost is the constructor-init rule and one test, both already added |
| Scope 4: a low-value ops key for config | Used only for publishing launch indexes | Asset and feed config decides what the keeper's checks trust. It is written by the deployer in the deploy session, then only by the multisig |
| Scope 7: a `maxNewAssetsPerTx` capability | Not added | On Solana, position token accounts are created in the leg that first buys them, so the create transaction stays small. Measured on Oct 3 |
| Scope 12c: US visitors read-only | Taken as the default, left for both founders to confirm | The brief says US visitors are blocked |
| Security 2: a pinned-commit workflow on `main` as the main fix | Second option | It needs a file on Rodrigo's frozen `main` and repo-admin rights, and scheduled runs can be delayed inside a 5.5-hour session |
| Security 3: accept may name the pending version | Accept names only the active version | Pre-acceptance needs separate "accepted assets" state in the vault. The prompt appears when the version takes effect |
| Security 8: check Scope's mappings account onchain | 32 bytes reserved; switched on only if the Oct 2 read confirms the layout | The layout is not verified. If it stays off, the gap is listed in `SECURITY.md` |
| Security 10: Unicode confusable folding | ASCII-only names and a folded key | Smaller, and enough for the launch shelf |
| Security 11: a hard 12-hour floor on the delay | The floor applies after `launch()` | It conflicted with scope 1, which needs short test cycles before launch |
| Seams 1: revisit any vault outside the band | Only vaults not yet back in band since their last adoption | A stateless rule would ship keeper rebalancing on drift, which is a roadmap item. Removing one step turns it on later |
| Seams 3: extend his `executions` table and map eleven leg kinds to its enum | A new `leg_attempts` table; `BasketTx` omits his `kind` | No change to his tables or enums while he is migrating, and no mapping to maintain |
| Seams 6: ask Rodrigo for `exitCostIn(asset, usd, regime)` now | Deferred | The keeper skips on the live quote against the reference price, which the vault enforces anyway |

## Checked for this revision

- GitHub scheduled workflows run on the default branch, 5-minute minimum, may be delayed or dropped, and stop after 60 days without activity: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- Solana instruction stack depth is 5, and 9 under SIMD-0268: https://solana.com/docs/core/cpi
- `MulticallUpgradeable` exists at OpenZeppelin upgradeable v5.6.1: https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/blob/v5.6.1/contracts/utils/MulticallUpgradeable.sol
- Supabase: direct connection IPv6 only, shared pooler IPv4, session mode on 5432, advisory locks lost in transaction mode: https://supabase.com/docs/guides/database/connecting-to-postgres
- Privy identity tokens: ES256, linked accounts, verified with a public key, enabled in the dashboard: https://docs.privy.io/user-management/users/identity-tokens.md
- Jupiter free plan: 1 request a second, per organisation: https://developers.jup.ag/docs/portal/rate-limits
- UptimeRobot free plan: 50 monitors at 5 minutes: https://uptimerobot.com/pricing/
- Robinhood stock tokens expose `newUIMultiplier()` and `effectiveAt()`: https://docs.robinhood.com/chain/building-with-stock-tokens/
- Read-only in `risk-layer` at `75ae4f0`: the `chain-solana` barrel re-exports `sign` and `wallet`; `db/src/seed-assets.ts` imports `engine`; `risk/src/provider.ts` ignores the window; `engine/package.json` has no `exports` map; the holiday list is `fixtures/risk/us-market-holidays.json`.

Not verified: Scope's mappings-account layout, whether Jupiter's terms allow a second organisation, the Squads vault-address detail, and every item the document marks "(memory)".
