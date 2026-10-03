# PLAN-VAULT.md: the plan for the MVP

Written on Thu Oct 1, at night. The freeze is Fri Oct 9 at 18:00 BRT and the submission is Mon Oct 12. What gets built is in `DESIGN-VAULT.md` (section 1 lists the nine MVP items); this file says when, in what order, who, and what is cut if we are late. The tasks themselves, with status and evidence, are rows in `STATE-VAULT.md`. This file does not repeat them. Where this file and section 16 of the design differ on a date, this file wins.

## Where we start

- Done: the documents, the audit, green checks, the repo organised, the shared Claude setup (ORG-1 to ORG-4).
- Not started: any product code for the vault. The two test rigs in `spikes/` pass on copies of mainnet; neither has run on mainnet itself.
- Decided on Oct 2: no money goes onto mainnet for now, and the product is built and shown on test networks first. The $10 of model credit stays. Everything through Sunday is local and free anyway; what changes is under "Where it runs" below.
- One day behind the design. Its day plan had the program, the contracts, the personalization port and the sign-in page starting on Oct 1. They start on Oct 2, which now carries two days of starts. There is no spare day: Oct 8 is for the gates and Oct 9 for fixes. A slip costs a cut, in the order below.

## How the days are used

Eight working days, two people, and agents doing most of the typing. What limits us is not typing. It is three things:

1. **What only a person can do.** Keys, accounts, the recordings. These are listed per day below so nobody finds one at 17:00.
2. **The days left after the deploy.** The deploy is planned for Mon Oct 5 and may come sooner (see "Still to settle"), so a full auto-follow cycle can be tried and filmed on Oct 5, 6 and 7. On mainnet two more limits would apply: auto-follow on stocks trades only Mon to Fri, 11:30 to 17:00 BRT, and `launch()` turns the delay into 48 hours.
3. **Review.** Every slot ends in a pull request into `staging` that someone other than its author reviews. One slot, one pull request.

A slot is about half a day of one stream, named `<stream>-<n>`. A slot is done under the contract in `CLAUDE.md`, not when the code is written.

**The two tight days are Sun Oct 4 and Mon Oct 5.** On Sunday the keeper path lands in the program and the contracts in the morning, the adapters build against it in the afternoon, and the interfaces freeze in the evening: three steps in a row, each waiting for the last. On Monday the deploy, the hosting and the first real buy share one session. If Sunday's chain does not finish, the freeze moves to Monday morning and the deploy to Monday afternoon or Tuesday morning.

## Milestones

Each is a check anyone can run. If one is missed by a day, the cut beside it is taken that evening; it is not discussed again the next morning.

| When | What must be true | If missed |
|---|---|---|
| **M1** Sat Oct 3, night | The walking skeleton on the mock: a buy on each chain the mock runs goes through the API as an order with its legs on that one chain, the legs settle, and the result reads back through the API. Every figure labelled MOCK. The contract tests pass on `chain-mock`. The three-profile test is green on starting numbers | Nothing is cut. The TypeScript streams add nothing new until it passes |
| **M2** Mon Oct 5, night | The program and the contracts are deployed and `authority-check` is green. On Solana devnet: create a vault, buy into it, see it, withdraw the tokens to the owner | The deploy moves to Tue morning. A chain not deployed by Tue 12:00 BRT is read-only, Base first |
| **M3** Tue Oct 6, night | The same owner path on Robinhood Chain with a passkey wallet. A shared portfolio is published and followed. Rehearsal 1 recorded on Solana and Robinhood Chain, with a first auto-follow cycle on each | Auto-follow on Robinhood Chain becomes owner-signed only |
| **M4** Wed Oct 7, night | Auto-follow has run a full cycle on Solana in market hours and is filmed. Portfolio and rebalance work end to end. Risk sheets render. An outside agent builds a plan and a person approves it from the link | Auto-follow on Solana becomes the one-tap prompt. The five extra agent tools stay out |
| **M5** Thu Oct 8 | `G-SEC` recorded per chain at 12:00 BRT. Then `launch()`, so the delay is 48 hours from here on. Then `G-LINK`. Only then is the link shared | A chain that misses tier 1 ships owner-signed. The link is not shared until `G-LINK` passes |
| **Freeze** Fri Oct 9, 18:00 BRT | `main` tagged. After it: P0 fixes only, each with a test | n/a |

**Where it runs.** Decided on Oct 2: test networks first, mainnet maybe later. "Deployed" in M2 to M5 means on Solana devnet and the EVM test networks. The stock tokens, Jupiter and the price feeds do not exist there, so the deploy brings its own: test tokens with the same shape as the real ones, a test exchange, test prices. The app and the API say "test network" on every figure that comes from them. Two things keep this honest. The program and the contracts take their router and price source from config, so the same code runs on mainnet by changing config, not code. And the tests still run the vault against the real tokens and pools on copies of mainnet, as the rigs do. What exists on each test network and what we bring is in `research/test-networks.md`; it adds about eight half-days of work the plan did not have before Oct 2 (rows TNET-1 to TNET-7). On a test network the prices and the clock are ours, so the market's hours and the 48-hour delay are tested by setting them, and "in session" below means a person at the keyboard.

## Day by day

Slot ids point at rows in `STATE-VAULT.md`. "In session" means in market hours, with a person at the keyboard.

| Day | Streams | A person does |
|---|---|---|
| **Fri Oct 2** | FRAME-1 (the first version of the types, the mock, the migration, the flags: every TypeScript stream waits for it, so it lands by midday). SOL-1, EVM-1 (the vault, from the rigs). ENG-2 starts (the personalization port). WAL-1 (the sign-in page). REVM-1 (the EVM depth collector starts now, so it has a weekend of samples). BRAND-1, RISK-1. Three half-day tries: one mock MCP tool on the free host, Slither on the rig, one hand-written kit builder | **Thom, first thing:** the Privy apps, so WAL-1 can start; then the second Jupiter organisation, the passkey origin test, the accounts (OPS-2). The three vault tests and the Scope read on copies of mainnet (OPS-1): free, and an agent can run them. **Thom, today, because they are rate-limited and need a person:** the faucets for devnet SOL (5 to 7 needed) and Robinhood test network ETH (OPS-2). **Rodrigo:** revoke the two live approvals (OPS-3), before anything is hosted |
| **Sat Oct 3** | FRAME-2 (the import-rules test, the CI workflows). BAS-1, with the shared limit vectors first. SOL-2 (the swap route on surfpool, the registry, sizes at 7 and 12 assets). EVM-2 (factory and registry). ADS-1, ADE-1 (read side). API-1 (sign-in, orders, the portfolio read). AGT-1 (guard and executor). WEB-1 (the app shell on the design system, on the mock). ENG-2 ends. OPS-4 starts (the ops scripts). TNET-1, TNET-4 (the test tokens, the test price source, the Solana test exchange). Feed ages logged over the weekend. **M1** | Review. Rodrigo: the sleeve table and the wording for ENG-2 when he can; one specification of the pin (DES-1) |
| **Sun Oct 4** | Morning: SOL-3, EVM-3 (the keeper path and the hostile cases). Afternoon: ADS-2, ADE-2 (every builder, simulated). API-2. WEB-2 (his three screens on the primitives). SEC-1 (`authority-check` and the expected values, written before the deploy). OPS-4 ends. TNET-2, TNET-5, TNET-6 (pools on Robinhood Chain's test network, the price updater, swaps on devnet). Evening: the interfaces freeze and the hash test turns on (FRAME-3) | **Thom:** the origin decided (a domain or one fixed URL); the admin, guardian, keeper and platform-creator keys created; the deploy dry run read line by line (OPS-5) |
| **Mon Oct 5** | KEEP-1 (the keeper against Solana). WEB-3 (plan, buy, order status on the real API, with the terms and the trust notice). SEC-2 (`SECURITY.md`, `INCIDENT.md`, the rehearsal script) | **In session:** deploy, config, caps, the launch portfolios published, hand-over to the admin key, hosting, the cold-start test. The owner path on Solana devnet, then on Robinhood Chain's test network if the session allows (OPS-6). A first keeper leg on Solana in the last hour, or on Tuesday. **M2** |
| **Tue Oct 6** | Morning: KEEP-2 (Robinhood Chain). WEB-4 (the shelf, publish and follow). API-3. AGT-2 (SDK and MCP on the real API, hosted) | **In session:** a buy with a passkey wallet on Solana, and one on Robinhood Chain; auto-follow cycles on both; rehearsal 1 (OPS-7). **M3** |
| **Wed Oct 7** | WEB-5 (portfolio and rebalance). RISK-2 (sheets render). AGT-3 (skill, `llms.txt`). SEC-3 (tier 2 runs). Add-backs decided | **In session:** rehearsal 2 and the market-open footage (OPS-8). The last day a full auto-follow cycle can be shown. **M4** |
| **Thu Oct 8** | Fixes only, from the rehearsals and the gates | **12:00 BRT:** `G-SEC` per chain. Then `launch()`, `G-LINK`, the pause drill, the link shared, a new version of the demo portfolio published (OPS-9). **M5** |
| **Fri Oct 9** | Fixes only | Freeze at 18:00 BRT; tag (OPS-10) |
| **Sat Oct 10** | P0 fixes, each with a test. README and the documents brought up to date | Record the remaining screens (OPS-11). The version published on Oct 8 takes effect today, with the market closed |
| **Sun Oct 11** | | Edit both videos. Fill the submission form (OPS-11) |
| **Mon Oct 12** | | **In session:** the Oct 8 version rebalances at production settings; if it fails, auto-follow is switched off on that chain. Then submit, with time to spare (OPS-12) |

## What is cut, and when

In this order, each on its date. A cut flips a flag; it does not delete code.

1. **Sat Oct 3.** The new Jupiter build route: fall back to the route the rig proved.
2. **Taken on Oct 2.** Base comes after Solana and Robinhood Chain. It comes back on Tue Oct 6 only if M3 is met on time (TNET-3).
3. **Tue Oct 6 at M3, final on Wed Oct 7.** Auto-follow on Robinhood Chain: owner-signed only.
4. **Wed Oct 7 at M4, final that night.** Auto-follow on Solana: followers get the one-tap prompt instead. Thursday's session opens 30 minutes before `G-SEC`, and after `launch()` a cycle takes 48 hours, so there is no later day to try again.

Never cut: withdrawing the tokens to the owner; tier 1 on any chain where auto-follow is on; `G-LINK`; no route that reaches a signer; the three-profile test.

Out from the start, back only if ahead: Base (decided on Oct 6), Portuguese copy, five more agent tools, auto-follow on Base and the hourly copy of the curves (each decided on Oct 7), and the 28-day EVM backfill (decided on Oct 6). The full table is in section 16 of the design.

**The floor.** With every cut taken, the submission is still: sign in two ways; a plan from a sentence; a one-tap buy into the person's own vault, on Solana or on Robinhood Chain; the portfolio with drift; a one-tap rebalance; shared portfolios published and followed with a prompt; the exit plan and risk sheet; the agent surface; and every withdrawal going to the owner only.

## Who owns what

As in section 15 of the design. In short: Rodrigo owns the engine's numbers and wording, Bearing and the risk sheets, the design system in the app, the name and the logo. Thom owns the program, the contracts, the adapters, the API, the keeper, sign-in, the agent surface, the screens built on Rodrigo's system, security and the deploy and rehearsal sessions. Either can pick up a slot marked for the other; say so in the ledger row first.

## Still to settle, with the day it bites

| What | Who | Bites on |
|---|---|---|
| `main` and `staging` protected (ORG-5) | Rodrigo | Now |
| Who gives a new person test cash and gas on a test network. A passkey wallet starts empty; the cheap answer is a small, rate-limited hand-out from our own key (TNET-7) | Thom | Mon Oct 5 |
| Whether mainnet follows the test networks before the freeze (gate `SHOW`). It needs about 5 SOL locked on Solana | Thom and Rodrigo | Wed Oct 7 |
| Whether Jupiter's terms allow a second organisation | Thom | Fri Oct 2 |
| One specification of the provenance pin; the final logo (DES-1) | Rodrigo | Sat Oct 3, with WEB-1 |
| Who holds each admin key and who is guardian on call each day. Still open on Oct 3 | Thom and Rodrigo | Sun Oct 4 |
| The deploy to the test networks. Thom's word is given (Oct 3): it may happen before Mon Oct 5, once the security reviews of the Solana program and the EVM contracts have passed | Thom | When both reviews have passed |
| Who runs the Solana sessions (deploy, config, rehearsals) | Thom and Rodrigo | Mon Oct 5 |
| Which VM runs the keeper once it leaves a founder's machine | Thom | Mon Oct 5 |
| Whether Vercel Hobby's non-commercial clause is acceptable for the hosted app | Thom | Mon Oct 5 |
| Who fills the blocked countries per asset; until then the declared country skips no token | Thom and Rodrigo | Mon Oct 5, with the asset entries |
| The short disclaimer ("Policy in your wallet, not a fund"), now that the assets sit in a vault the person owns | Rodrigo | Mon Oct 5, before the app is hosted |
| The goal status for every kind of goal, and the odds (ENG-1) | Rodrigo | Wed Oct 7, with WEB-5 |
| Where the Bearing data runs for the demo: a hosted collector or a dated snapshot | Rodrigo | Wed Oct 7 |
| The photos in the landing prototype (DES-2) | Rodrigo | Thu Oct 8, before the link is shared |

## How a slot runs

`/start-work <slot id>`, the work, `/verify`, `/review-pr`, `/open-pr` into `staging`. One slot, one pull request. Only one branch at a time generates a migration: FRAME-1 first, and after it whoever holds the row `MIGRATION` in the ledger. Until the interfaces freeze on Sun Oct 4, a change to a shared type is made in `packages/schemas` by FRAME's owner and announced in the pull request; after the freeze it needs a row in `docs/GATES.md`. `staging` goes into `main` at each milestone, with a person's word.
