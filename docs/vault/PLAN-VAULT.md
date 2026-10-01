# PLAN-VAULT.md: the plan for the MVP

Written on Thu Oct 1, at night. The freeze is Fri Oct 9 at 18:00 BRT and the submission is Mon Oct 12. What gets built is in `DESIGN-VAULT.md` (section 1 lists the nine MVP items); this file says when, in what order, who, and what is cut if we are late. The tasks themselves, with status and evidence, are rows in `STATE-VAULT.md`. This file does not repeat them.

## Where we start

- Done: the documents, the audit, green checks, the repo organised, the shared Claude setup (ORG-1 to ORG-4).
- Not started: any product code for the vault. The two test rigs in `spikes/` pass on local forks; neither has run on mainnet.
- One day behind the design. Its day plan had the program, the contracts, the personalization port and the sign-in page starting on Oct 1. They start on Oct 2. The day comes out of the spare session on Oct 9, so there is no slack left: a slip now costs a cut, in the order below.

## How the days are used

Eight working days, two people, and agents doing most of the typing. What limits us is not typing. It is three things:

1. **What only a person can do.** Mainnet sessions, keys, accounts, the name. These are listed per day below so nobody finds one at 17:00.
2. **The stock market's hours.** Auto-follow on stocks can only be tried and filmed Mon to Fri, 11:30 to 17:00 BRT. That leaves Oct 2 and Oct 5 to 9.
3. **Review.** Every stream ends in a pull request into `staging` that someone other than its author reviews. Small pull requests, one slot each.

A slot is half a day of one stream, named `<stream>-<n>`. A slot is done under the contract in `CLAUDE.md`, not when the code is written.

## Milestones

Each is a check anyone can run. If one is missed by a day, the cut beside it is taken that evening; it is not discussed again the next morning.

| When | What must be true | If missed |
|---|---|---|
| **M1** Sat Oct 3, night | The walking line on the mock: a sentence becomes a plan, the plan becomes an order with a leg per chain, the legs settle, the portfolio shows them. Every figure labelled MOCK. Contract tests pass on `chain-mock` | Nothing is cut. The TypeScript streams stop adding screens until it passes |
| **M2** Mon Oct 5, night | The program and the contracts are deployed. On Solana, with real money: create a vault, buy into it, see it, withdraw the tokens to the owner. `authority-check` is green | Deploy moves to Tue morning. If Base has not passed its $10 run, Base is read-only |
| **M3** Tue Oct 6, night | The same owner path on Robinhood Chain and Base with a passkey wallet. A shared portfolio is published and followed. Rehearsal 1 recorded on Solana | Auto-follow on Robinhood Chain becomes owner-signed only |
| **M4** Wed Oct 7, night | Auto-follow has run a full cycle on Solana in market hours and is filmed. Portfolio and rebalance work end to end. Risk sheets render. An outside agent builds a plan and a person approves it from the link | Auto-follow on Solana becomes the one-tap prompt. The five extra agent tools stay out |
| **M5** Thu Oct 8 | `G-SEC` recorded per chain at 12:00 BRT. Then `launch()`, so the delay is 48 hours from here on. Then `G-LINK`. Only then is the link shared | A chain that misses tier 1 ships owner-signed. The link is not shared until `G-LINK` passes |
| **Freeze** Fri Oct 9, 18:00 BRT | `main` tagged. After it: P0 fixes only, each with a test | n/a |

## Day by day

Slot ids point at rows in `STATE-VAULT.md`. "In session" means in market hours, with a person at the keyboard.

| Day | Streams | A person does |
|---|---|---|
| **Fri Oct 2** | FRAME-1 (the types, the mock, the migration, the flags: every TypeScript stream waits for it, so it lands by midday). SOL-1, EVM-1 (vault with create, deposit, withdraw in kind, from the rigs). ENG-2 (the personalization port). WAL-1 (the sign-in page). BRAND-1, RISK-1. Three half-day tries: one mock MCP tool on the free host, Slither on the rig, one hand-written kit builder | **Thom, in session, and nothing else:** the three $10 runs and the Scope read (OPS-1); all three chains funded. Privy apps, the second Jupiter organisation, the passkey origin test, the accounts (OPS-2). **Rodrigo:** revoke the two live approvals (OPS-3), before anything is hosted |
| **Sat Oct 3** | FRAME-2 (the import-rules test, the program and contracts workflows). SOL-2 (the swap route on surfpool, the registry, sizes at 7 and 12 assets). EVM-2 (factory and registry). BAS-1. ADS-1, ADE-1 (read side). API-1 (sign-in and orders). AGT-1 (guard and executor). WEB-1 (the app shell on the design system). **M1** | Review. Rodrigo: the sleeve table and the wording for ENG-2 when he can |
| **Sun Oct 4** | SOL-3, EVM-3 (the keeper path and the hostile cases). ADS-2, ADE-2 (build and simulate on a fork). API-2. WEB-2 (his three screens on the primitives). In the evening the interfaces freeze and the hash test turns on (FRAME-3) | **Thom:** the origin decided (a domain or one fixed URL), the admin and guardian keys created, the deploy dry run read (OPS-4) |
| **Mon Oct 5** | KEEP-1 (the keeper against Solana). WEB-3 (plan, buy, order status on the real API). SEC-1 (`SECURITY.md`, `authority-check`) | **In session:** deploy on three chains, config, hand-over to the admin key, hosting, the cold-start test (OPS-5). The owner path on three chains. First keeper leg on Solana. **M2** |
| **Tue Oct 6** | WEB-4 (publish and follow, the shelf). API-3. AGT-2 (SDK and MCP on the real API). KEEP-2 (Robinhood Chain). REVM-1 | **In session:** a three-chain buy with a passkey wallet; auto-follow cycles on Robinhood Chain; rehearsal 1 (OPS-6). **M3** |
| **Wed Oct 7** | WEB-5 (portfolio and rebalance). RISK-2 (sheets render). AGT-3 (skill, `llms.txt`). SEC-2 (tier 2 runs). Add-backs decided | **In session:** rehearsal 2 and the market-open footage (OPS-7). **M4** |
| **Thu Oct 8** | Fixes only, from the rehearsals and the gates | **12:00 BRT:** `G-SEC` per chain. Then `launch()`, `G-LINK`, the pause drill, the link shared, a new version of the demo portfolio published (OPS-8). **M5** |
| **Fri Oct 9** | Fixes only | Freeze at 18:00 BRT; tag (OPS-9) |
| **Sat Oct 10** | P0 fixes, each with a test. README and the documents brought up to date | Record the remaining screens |
| **Sun Oct 11** | | Edit both videos. Fill the submission form |
| **Mon Oct 12** | | **In session:** the Oct 8 version takes effect and rebalances at production settings; if it fails, auto-follow is switched off on that chain. Then submit, with time to spare (OPS-10) |

## What is cut, and when

In this order, each on its date. A cut flips a flag; it does not delete code.

1. **Sat Oct 3.** The new Jupiter build route: fall back to the route the rig proved.
2. **Fri Oct 2, or Mon Oct 5 at M2.** Trading on Base: read-only if its $10 run fails or it is not deployed.
3. **Tue Oct 6 at M3, final on Oct 7.** Auto-follow on Robinhood Chain: owner-signed only.
4. **Wed Oct 7 at M4, final on Oct 8.** Auto-follow on Solana: followers get the one-tap prompt instead.

Never cut: withdrawing the tokens to the owner; tier 1 on any chain where auto-follow is on; `G-LINK`; no route that reaches a signer; the three-profile test.

Out from the start, back only if ahead on Oct 7: Portuguese copy, five more agent tools, auto-follow on Base, the 28-day EVM backfill, the hourly copy of the curves. The full table is in section 16 of the design.

**The floor.** With every cut taken, the submission is still: sign in two ways; a plan from a sentence; a one-tap buy into the person's own vault on Solana and Robinhood Chain; the portfolio with drift; a one-tap rebalance; shared portfolios published and followed with a prompt; the exit plan and risk sheet; the agent surface; and every withdrawal going to the owner only.

## Who owns what

As in section 15 of the design. In short: Rodrigo owns the engine's numbers and wording, Bearing and the risk sheets, the design system in the app, the name and the logo. Thom owns the program, the contracts, the adapters, the API, the keeper, sign-in, the agent surface, the screens built on Rodrigo's system, security and the mainnet sessions. Either can pick up a slot marked for the other; say so in the ledger row first.

## Still to settle, with the day it bites

| What | Who | Bites on |
|---|---|---|
| Who runs the Solana mainnet sessions (deploy, config, rehearsals) | Thom and Rodrigo | Mon Oct 5 |
| Who holds each admin key, who is guardian on call each day, who funds 5 SOL for the Solana deploy | Thom and Rodrigo | Sun Oct 4 |
| Which VM runs the keeper once it leaves a founder's machine | Thom | Mon Oct 5 |
| Where the Bearing data runs for the demo: a hosted collector or a dated snapshot | Rodrigo | Wed Oct 7 |
| The name. It fixes the package scope, the origin and the passkeys, so a late change costs a re-deploy of sign-in | Rodrigo | Sun Oct 4, with the origin |
| One specification of the provenance pin; the final logo | Rodrigo | Sat Oct 3, with WEB-1 |
| `main` and `staging` protected (ORG-5) | Rodrigo | Now |

## How a slot runs

`/start-work <slot id>`, the work, `/verify`, `/review-pr`, `/open-pr` into `staging`. One slot, one pull request. Only one branch at a time generates a migration: FRAME-1 first, and after it whoever holds the row `MIGRATION` in the ledger. Until the interfaces freeze on Sun Oct 4, a change to a shared type is made in `packages/schemas` by FRAME's owner and announced in the pull request; after the freeze it needs a row in `docs/GATES.md`. `staging` goes into `main` at each milestone, with a person's word.
