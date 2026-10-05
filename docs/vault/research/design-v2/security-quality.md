# Security and quality: note for design v2

Oct 1, 2026. Markers: **[C n]** checked today against source n in section 7. **[R]** run by me today. **[L]** read in a local file. **[M]** from memory. Nothing was installed, signed or sent.

## 1. Bottom line

- **The keeper is the bounded risk; the upgrade key is the unbounded one.** A leaked keeper key can cost each auto-follow vault at most the weekly cap (2%) while the price reference is honest. A leaked upgrade key can take everything, and there is no deposit cap. Drift lost $285M in April through phished multisig signers and no timelock [C7]. Put both upgrade authorities in a multisig before the first outside deposit.
- **One list of hostile cases, the same IDs on both chain families.** Auto-follow goes live on a chain only when every case passes there (gate `G-SEC`). A chain that misses it by Oct 8 ships owner-signed only, which the brief allows.
- **The API must not be able to sign.** Do not register the old `POST /policies/:id/rebalance` route, keep the keeper as a worker with no HTTP listener, and ban key-loading imports from `apps/api` and `apps/mcp` in CI.
- **One gap in the Solana spike.** It checks delegate and close authority only on the input and output accounts (`lib.rs` 96–107) [L]. The vault's signature reaches every program in a Jupiter route, so a route could set a delegate on a third vault account. Fix: reject any other vault token account in the account list.
- **Use the runners already chosen.** Foundry invariants, Slither, Aderyn and `forge lint` for Solidity; Rust property tests and LiteSVM sequences driven by fast-check for the program. Trident's stable release predates Anchor 1.x [C4]; give it two hours at most.

## 2. What to use for the MVP

### Threats, precedent, check

| Threat | Precedent | Check | Cases |
|---|---|---|---|
| Keeper, or its leaked key, trades at a bad price | 3Commas 2022: leaked trade-only keys drained accounts through thin pairs, $14.8M verified [L15] | Minimum output computed onchain from the reference price; toward target only; cooldown; weekly cap | A2 A3 A7 |
| Sandwich, or buying ahead of a public index update | Index Coop left DEX-only rebalances after value decay [L15] | Same minimum output: the trade reverts and the keeper retries. Random order and delay | A2 |
| Malicious index creator | Copy-trade baiting [L15] | Registry limits, platform asset list, 12-hour delay, tap for a new asset, guardian veto. Keeper skips a leg whose measured exit cost (Rodrigo's `LiquidityProvider`) exceeds the tolerance | A14 A16 |
| Stale or closed-market price | Stock feeds freeze at Friday close [C11]; our Solana notes saw a 27% wick in weekend pools [L15] | Age bound, session window, guardian halt. A fresh timestamp does not prove an open market | A5 A6 |
| Issuer pauses or freezes a token | dHEDGE audit: one reverting token blocked all withdrawals [L15] | Withdraw per token; `withdrawAll` skips and reports | A9 |
| Token-2022 permanent delegate (issuer can move or burn any holder's tokens) | Used in burn scams since 2024 [C9]; SPYx carries it [L] | Nothing stops the issuer. Assets enter only by address on the platform list; no cached balance is trusted; the risk sheet says it | A10 |
| Multiplier on stock tokens | 370 of 927 xStock mints hold a stale stored multiplier; Kamino runs price bands around corporate actions [C10] | Raw units onchain; never multiply a price that already includes it; no keeper legs within 24 hours of a change; the app reads the effective value by timestamp | A12 |
| Router or approval abuse | LI.FI, July 2024: $11.6M taken through standing approvals and a five-day-old facet [C6] | Exact approval, zeroed in the same call; router allowlist; own balance deltas; the Solana fix above | A1 A11 |
| Upgrade or admin key | Drift [C7]; Bybit 2025: signers approved what a tampered interface showed [C8] | Multisig, two people, two devices; read the decoded transaction; never sign a durable-nonce transaction | A15 |
| Supply chain | Injective SDK (July 2026) and Mastra (June 2026): npm releases that stole wallet keys [C12] | pnpm settings below | CI |

### Hostile cases (freeze on day 1)

Each chain family has a test named after the ID; `docs/SECURITY.md` holds the matrix.

A1 output sent to the keeper. A2 price worse than tolerance (thin pool, 90%-fee pool). A3 back-and-forth churn. A4 token outside the accepted recipe. A5 stale price. A6 Saturday, and one minute before the open. A7 wrong direction or past target. A8 paused: keeper reverts, owner withdraws. A9 one token frozen: the rest withdraw. A10 balance changed from outside (seizure, donation). A11 any approval, delegate or close authority left after a call. A12 inside the multiplier window. A13 caller not the keeper; auto-follow off. A14 new asset not accepted by the owner. A15 upgrade to a dummy v2: state intact, withdraw works. A16 creator limits.

### Tests and what passing means

| Layer | Tool | Passing |
|---|---|---|
| EVM unit, fuzz | Foundry, `[fuzz] runs = 1000` (default 256 [C2]) | All A-cases at 6, 8 and 18 decimals |
| EVM invariants | Handlers: owner, hostile keeper, creator, donor, issuer, clock. CI on defaults (256 runs, depth 500 [C2]); freeze profile 5,000 runs | Zero violations, and each handler call succeeds at least 20% of the time. `fail_on_revert` is off by default [C2], so a suite where everything reverts passes and proves nothing |
| EVM static | Slither 0.11.6, Aderyn 0.6.8 [C3], `forge lint` (since 1.3 [C2]; Thom's 1.2.3 lacks it [R]) | No High or Medium untriaged; each kept finding gets a line in `docs/SECURITY.md` |
| Each rule bites | Comment out each of the eight checks in turn | A named test fails for each |
| Solana logic | `proptest` on `checks.rs` | I2 and I5 hold |
| Solana runtime | LiteSVM under Vitest, mock router, sequences from fast-check 4.10.2 [C17] | All A-cases; 10,000 sequences, no invariant broken |
| Solana static | `cargo clippy -D warnings`, cargo-deny 0.20.2, Radar [C5], the Solana MCP `program_autofixer` | No vulnerability advisory. Today the spike's tree has none, plus two "unmaintained" notices (bincode, libsecp256k1) [R]; list those in `deny.toml` |
| API | `apps/api/src/security.test.ts`: the audit's proofs, inverted | No anonymous path to a signer; wallet B cannot read or approve wallet A's data; errors carry a request id and no SQL |
| Mainnet rehearsal | $10–20 per chain, scripted, every transaction logged with its explorer link | Create, deposit, owner swap, publish v2 on a demo index, one keeper leg; A1, A2, A4, A8 simulated on live state and failing with the expected error; pause; withdraw while paused; A15 through the multisig. Twice in a row |

Invariants: **I1** tokens leave only by an owner call. **I2** value at reference prices after any keeper sequence in 7 days ≥ start × (1 − cap), net of owner flows. **I3** no allowance survives a call. **I4** withdraw works with feeds, registry and factory reverting. **I5** a keeper call never widens distance from target.

### API, agents, approval link

Sibling notes fix sign-in (Privy token checked with `jose`), the browser guard and the intent shape. This stream adds:

- First: revoke the two live approvals on the demo wallet (5 USDY, 5 syrupUSDC to the agent key) [L16].
- `apps/api/src/plugins/`: `auth.ts`; `limits.ts` (`@fastify/rate-limit` 11.2.0, per IP and per wallet, stricter on goal parsing and intent creation); `errors.ts` (one handler); `@fastify/helmet` 13.1.1 [C17]; a CORS allowlist. Bind Postgres to localhost and drop the default-password fallback.
- A Biome `noRestrictedImports` rule: only `apps/keeper` and `scripts/` may import `wallet.ts` or `sign.ts`.
- Approval link: the intent is bound to the owner address, built at approval time, expires, and its summary is written by the server. Turning auto-follow on needs its own tap on a screen showing the creator and the keeper limits in numbers. Index text is untrusted everywhere.
- The keeper simulates every leg and compares balance changes, not only "no error".

### Keys, with no paid service

| Key | Power | Where |
|---|---|---|
| Deployer | Deploy, then nothing | Fresh per chain. EVM: Foundry's encrypted keystore. Solana: keypair file encrypted with `age` at rest [M], or a Ledger. Hands authority to the multisig in the same session |
| Admin / upgrade | Replace vault code, set config | Squads on Solana (free, has a time lock [C14]); Safe 1.4.1, canonical on 8453 and 4663 [C13] |
| Guardian | Pause, halt an asset, veto a version; cannot unpause | Hot: keeper host and each founder's machine |
| Keeper | One function | One per chain family, created on the host, in its secret store, gas only |

- Freeze now: keeper and guardian addresses are read from one place (`Config` on Solana, the factory on EVM), so rotation is one transaction.
- No funded key on a machine or user account where coding agents have a shell [C12].
- `scripts/ops/authority-check.ts` compares the upgrade authority, beacon owner and proxy admins on all three chains with `deployments/`. Run it daily in demo week.

### Supply chain

- Keep pnpm 11's defaults: releases under a day old are not resolved, and unapproved build scripts fail the install [C1]. His `pnpm-workspace.yaml` has 29 age exclusions and five `allowBuilds` entries still holding placeholder text [L]. Set those to `false`; add `blockExoticSubdeps: true` and `trustPolicy: no-downgrade` [C1].
- A pull request that changes the lockfile names the new packages, and a person reads that diff. This is the control on agents adding dependencies.
- `.github/workflows/security.yml`: gitleaks 8.30.1, `pnpm audit --prod`, cargo-deny; actions pinned by commit. Today gitleaks reports 9 hits on `risk-layer`, all public addresses in fixtures and one script [R]; allow them in `.gitleaks.toml`.
- Cargo builds use `--locked`. The spike's `keys/` folder stays out of the repo.

### Files

```
docs/SECURITY.md  docs/INCIDENT.md  docs/GATES.md (+ G-SEC per chain)
contracts/test/invariant/  tests/solana/*.test.ts  programs/basket/src/checks.rs
apps/api/src/plugins/{auth,limits,errors}.ts  apps/api/src/security.test.ts
scripts/ops/{pause,status,authority-check,withdraw-without-app}.ts
packages/schemas/src/trust.ts  .gitleaks.toml  deny.toml
```

```ts
// packages/schemas/src/trust.ts, next to DISCLAIMER
export const TRUST_STATUS = {
  audited: false, upgradeKeys: 'team', admin: { solana: '', base: '', robinhood: '' },
  keeperLimits: { toleranceBps: { solana: 75, evm: 125 }, weeklyLossBps: 200 },
  usPersons: 'blocked', incident: null as null | { since: string; text: string },
} as const;
```

### What the app must say

From `TRUST_STATUS`, at the first deposit (a checkbox, stored with text version and time), in vault settings, on the risk sheet, in the API docs, the skill file and the README:

1. The contracts are unaudited.
2. The team holds the upgrade keys and can change vault code, so it could move funds. Addresses shown.
3. Auto-follow: the keeper trades only the index's assets, no worse than X% from the reference price, at most 2% loss a week; you can switch it off and withdraw at any time. Never "cannot lose funds".
4. Issuers can pause, freeze or seize stock tokens.
5. Not for US persons. Not investment advice.
6. A lost, unsynced passkey loses the wallet; add a second sign-in.

### Pause and incident plan (`docs/INCIDENT.md`)

- Triggers, posted by the keeper to a chat webhook: three reverts on the price bound, a vault past half its loss budget, an authority mismatch, a keeper-key transaction missing from the jobs table, a stale feed in session.
- Order: `pnpm ops:pause` (three chains, one command) → stop the keeper → set `TRUST_STATUS.incident` (banner; the API serves reads and withdrawals only) → rotate the keeper key → if vault code is at fault, tell users to withdraw and point to `withdraw-without-app.ts` → upgrade only through the multisig after both have read the diff.
- Rehearse the pause once on mainnet. Name who is on call each day.

## 3. Skip or defer

- Trident past the two-hour try: 0.12.0 (Nov 2025) targets solana-sdk 2.3; 0.13 is still a release candidate [C4].
- Echidna, Medusa, Halmos, Certora: Foundry's runner covers the same properties this week.
- KMS, HSM or Turnkey for the keeper: paid, and the vault bounds the key.
- A timelock on upgrades in demo week: a fix may be needed within hours. Say so in the app; add it after submission.
- Private relays, auctions, netting: the price check bounds the loss.
- Onchain US block, OAuth on the MCP server, a bug bounty, paid monitoring.

## 4. Seams for the roadmap

- Community and gamification: creator text is a separate untrusted field; counts come from chain state.
- Creator fees: I2 carries a fee term, zero today.
- CCIP sync: one `onlyPublisher` check on `publish`; versions only increase, which blocks replays.
- More chains: a per-chain checklist in `docs/SECURITY.md` (sequencer feed, mempool, pause probe, Safe present).
- New basket types: one invariant file per kind; the case IDs stay.
- Drift rebalancing: the loss budget is per time, not per version.
- Paid feeds: prices go through one function; a second source becomes a cross-check.
- Agent-run indexes: same creator limits; rate limits keyed by publisher.
- Pooled token: keep share maths out of the vault; a pool needs its own review.
- Embeds: CORS and `frame-ancestors` are config lists.
- Audits and governance: `docs/SECURITY.md`, the invariant suite, verified builds and one admin address make a timelock and an audit additive.

## 5. Risks and the test that settles each

| Risk | Test before Oct 9 |
|---|---|
| No deposit cap on unaudited, upgradeable code (fixed decision; flagged) | Multisig in place and `authority-check` green before the public link is shared |
| The delegate gap carries into `programs/basket` | A11 on LiteSVM: a mock route calls `Approve` on a third vault account and must revert |
| The reference price is wrong (Scope is one source) | Fuzz the fake Scope entry ±5%: the 1-hour-average check trips, and loss stays within what direction and cooldown allow |
| Invariant suite passes while reverting everywhere | The 20% success gate |
| Slither or Aderyn fails on `via_ir` or transient storage | Run both on the spike vault on Oct 2 |
| Anchor 1.2's tree has open advisories | cargo-deny on the ported spike on Oct 2 |
| A 2-of-2 multisig loses a signer and upgrades stop | Question 1; rehearse A15 with the real signers |
| Pause is slow in practice | Timed drill: alert to paused on three chains in under 5 minutes |
| The old signing route ships by accident | `security.test.ts` fails if any registered route imports a signer |

## 6. Questions for a person

1. Admin and upgrade keys: 2-of-2 (Thom, Rodrigo) or 2-of-3 with a cold third key? Does either of you own a hardware wallet?
2. Who is guardian on call in demo week, and may the guardian key sit on the keeper host?
3. Rodrigo: may the basket branch drop `POST /policies/:id/rebalance` and retire `delegate.ts`, and will you revoke the two live approvals today?
4. Which host runs the keeper? Its secret store holds the keeper keys.
5. No cap is decided. Is a warning above some amount, not a cap, acceptable?

## 7. Sources

1. pnpm: https://pnpm.io/supply-chain-security , https://pnpm.io/settings/build
2. Foundry: https://getfoundry.sh/config/reference/testing , https://www.getfoundry.sh/forge/linting , https://github.com/foundry-rs/foundry/releases/tag/v1.3.0
3. https://github.com/crytic/slither/releases (0.11.6, Jul 28) ; https://github.com/Cyfrin/aderyn/releases (0.6.8, Jan 22)
4. Trident: https://github.com/Ackee-Blockchain/trident/releases , its `CHANGELOG.md`, crates.io `trident-cli` 0.12.0
5. https://github.com/EmbarkStudios/cargo-deny/releases ; https://github.com/gitleaks/gitleaks/releases ; https://github.com/Auditware/radar
6. https://li.fi/knowledge-hub/incident-report-16th-july
7. https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation ; https://www.chainalysis.com/blog/lessons-from-the-drift-hack/
8. https://www.sygnia.co/blog/sygnia-investigation-bybit-hack/
9. https://www.tradingview.com/news/cointelegraph:13ab18ce1094b:0-scammers-have-found-a-way-to-burn-tokens-from-inside-solana-wallets/
10. https://github.com/iamrobertmoore/record-date (third-party measurement, not reproduced) ; https://docs.xstocks.fi/developers
11. https://cryptoslate.com/coinbase-stock-tokens-stayed-within-0-6-of-friday-prices-through-the-weekend-as-aave-collateral-remained-pending/
12. https://www.stepsecurity.io/blog/injective-npm-supply-chain-attack-18-packages-backdoored-to-steal-crypto-wallet-keys ; https://tech-insider.org/npm-supply-chain-attack-2026/ ; https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/
13. `safe-deployments`, `src/assets/v1.4.1/safe_l2.json`, 4663 and 8453 both "canonical": https://github.com/safe-global/safe-deployments
14. https://docs.squads.so/main/development/reference/accounts
15. `docs/vault/research/vaults/permission-security.md`, which links 3Commas, dHEDGE, Enzyme and Index Coop
16. Local: the audit reviewers' notes (outside this repo; summary in `docs/vault/AUDIT-VAULT.md`); both spikes; the five sibling notes in `docs/vault/research/design-v2/`; `risk-layer` at `75ae4f0`. Runs today: `gitleaks git` on `risk-layer` (read-only), `cargo deny check advisories` on the Solana spike, local tool versions
17. npm registry today: `fast-check` 4.10.2, `@fastify/rate-limit` 11.2.0, `@fastify/helmet` 13.1.1, `jose` 6.2.12
