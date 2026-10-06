# PROMPT (build): more fixed-income assets on the shelf, Solana and Robinhood Chain, up to the rollout

> Written 2026-10-06 by Rodrigo's session after his screening of two lists he mapped:
> - `~/Downloads/solana_yield_assets.xlsx` (55 rows);
> - `~/Downloads/robinhood_chain_yield_assets.xlsx` (30 rows).
>
> Run it in a fresh Claude Code session started in the main checkout, `~/Documents/Colosseum`, so the hooks load. It stops before the live rollout (part (b) below).

---

## The prompt

You add dollar fixed-income assets to the plan engine's shelf on two chains, Solana and Robinhood Chain, for testing only. The work is a research pass and then the fixture work (part (a)). Act as the orchestrator in `.claude/rules/orchestration.md`: delegate bounded pieces, run at most two implementation agents at once, review every diff yourself, and get each pull request reviewed by an agent that did not write it.

### Read first

1. `CLAUDE.md` and `.claude/rules/orchestration.md`.
2. `docs/GATES.md`, these rows above all:
   - `ONE-CHAIN`, `EXIT-SOURCE`, `PROTECT-NO-STOCKS`, `UNIVERSE`;
   - `SOLVER-PARAMS`, `SOLVER-CAPS`, `THREE-PLANS`, `COVER-CREDIT`;
   - `G-NORA`, and the CLAUDE.md line on the BRL leg.
3. `docs/vault/DESIGN-VAULT.md` section 7, every "As built" paragraph: how dollar yield is filled, with leg types, caps per asset and per issuer, the credit budget, the safe-yield sleeve and matching legs.
4. Code, in the worktree `~/Documents/Colosseum-try` (branch `tools/try-plans`, PR #93):
   - `packages/engine/src/personal/leg-types.ts` (`LEG_TYPES`, the four leg types);
   - `params.ts` (`capPerAssetBps` by symbol and by leg type);
   - `testing.ts` (`launchShelf`, `fixtureYields`, `fixtureLiquidity`);
   - `docs/vault/research/open-questions/launch-shelf.seed.json`;
   - `packages/engine/src/personal/fixtures/yields.json`;
   - the playground under `scripts/try/` and `try/README.md`, and the `/plan-chat` skill in `.claude/skills/plan-chat/`.
5. The two spreadsheets above. Copy them into `docs/vault/research/yield-shelf/inputs/`, each with a CSV beside it so diffs are readable. They are research inputs: their yields are point-in-time claims, not readings.

### Where the work happens

Cut every branch from `origin/tools/try-plans`. That branch merges the whole engine stack (#64, #71, #72, #73) and the playground. Use your own worktrees under `~/Documents/`. Do not edit the worktrees `-engine`, `-intake`, `-themes`, `-rebalance` or `-try`.

| Branch | What it holds | PR into |
|---|---|---|
| `shelf/common` | Shared pieces, first: the playground's `--shelf extended` option and an extended-shelf loader; any leg type the research shows is missing (see "Leg types"); the research note's template | `tools/try-plans` |
| `shelf/solana-yield` | Solana research note, fixture rows, leg types, fixture yields, tests | `shelf/common` |
| `shelf/robinhood-yield` | The same for Robinhood Chain | `shelf/common` |

Solana and Robinhood Chain are separate tracks: a plan lives on one chain, so each shelf is independent. They can run in parallel once `shelf/common` is pushed.

### What Rodrigo decided (2026-10-06)

- **Solana, add for testing:**
  - The first wave: USDY, sUSD (Solayer), wYLDS (Hastra), sUSDS (Sky), Kamino main-market USDC (kToken), jlJupUSD, sUSDe, PST (Huma).
  - The second wave: ONyc, PRIME, AUTO, USD* (Perena), USDC+ (Reflect), USX/eUSX (Solstice), oTFY.
  - The Etherfuse stablebonds: TESOURO (BRL), CETES (MXN), and any other Etherfuse bond with a Solana mint that the research confirms.
- **Solana, out:**
  - everything permissioned, because a vault is a program and cannot be allowlisted: BUIDL, OUSG, BENJI, USTB, VBILL, USYC, WTGXX, SWEEP/SAFO/BAGEY, ACRED, kicUSDC, SCOPE;
  - wound down, defunct or exploit-linked: strcUSX, Credix, stSOL, dSOL;
  - not dollar fixed income: SOL liquid staking and restaking tokens, JLP;
  - high risk: stSLX, hyUSD/sHYUSD, jrONyc;
  - PT/YT tokens, whose maturities the engine does not model;
  - PYUSD (no native yield);
  - reUSD and nPERENA (unconfirmed).
- **Robinhood Chain:** run the same screening on its list, with the same filters. Expect:
  - **candidates:** steakUSDG (Morpho vault), syrupUSDG, spUSDG (Spark), rUSDG (Mellow, verify), mGLO (Midas; it has no DEX pool, so check how it exits), and syrupUSDC if it is really on the chain;
  - **added by Rodrigo on 2026-10-06, research and then ask** (see "Uniswap LP and Pendle PT" below): Uniswap LP positions in dollar pairs, and Pendle PT-USDG;
  - **out:** USDG itself (cash, already the chain's cash token), USDe (no base yield), ETH staking tokens (not dollar), other DEX LPs (up, Ramses X, Fables, Ekubo, PancakeSwap), Pendle YT (it goes to zero at maturity) and the matured PT/YT-sNET, permissioned funds, anything not deployed, and Robinhood Earn (an app account, not a token a vault holds).

  Any Robinhood candidate whose verdict is not clear from the filters goes to Rodrigo with a recommendation. Do not add it on your own.

### The filters (apply them in the research pass and say which one decides each verdict)

1. A vault can hold it: no allowlist and no KYC on transfer to a program or contract address.
2. It is a dollar asset, or, for the Etherfuse bonds, a local-currency bond (see below).
3. It can be sold at a person's size: depth from read-only public sources only (DexScreener, Jupiter quote API on Solana, the EVM collector's sources on Robinhood Chain). A thin market is not a reason to leave an asset out, but it is said, and the asset's tier reflects it.
4. Live, not wound down, defunct or exploit-linked.
5. Low or medium risk; levered, algorithmic and junior tranches are out.

### The research pass

For every candidate, verify from primary sources (the issuer's docs, the token's contract or mint on an explorer, audits, and official announcements), dated:

- issuer, and what backs the yield;
- the mechanism, which gives the leg types;
- the Solana mint or the Robinhood Chain contract address, decimals, and token program or standard;
- transfer restrictions (freeze authority, allowlist, transfer hooks);
- redemption path and its delays;
- geo-blocks, recorded in the research note as information (gate `COUNTRY-REMOVED`, Oct 6: they are not set as engine blocks; `blockedCountries` may carry them as information, and the engine ignores it);
- the DEX pools and the depth at $10k and $50k;
- whether a yield figure can be read live with source, time and method (an API or on-chain rate), for the rollout;
- known incidents;
- your verdict (add / add with caution / hold / out), with the filter that decides it.

Write one note per chain:
- `docs/vault/research/yield-shelf/solana.md`
- `docs/vault/research/yield-shelf/robinhood.md`

Use the house style of `docs/vault/research/portfolio-method.md`: numbered sources, dated, with what could not be verified said plainly. A fact you could not verify stays marked unverified, and the fixture row says so. Use a research agent per chain; web reads are fine.

### Part (a): the fixtures, so the playground and `/plan-chat` can use them

- **Do not change the launch shelf** (`launch-shelf.seed.json`, `launchShelf()`): hundreds of tests pin plans to it. Add an **extended shelf** instead:
  - `packages/engine/src/personal/fixtures/shelves/<chain>-yield.json`, holding the new tokens as `BasketAsset` rows, `provenance: 'fixture'`;
  - a loader, `extendedShelf()`, that adds them to the launch shelf;
  - `pnpm plan:try … --shelf extended`, and `/plan-chat` accepting "use the extended shelf".
- **Each row:**
  - class `dollar_yield`, except the Etherfuse bonds;
  - the issuer as the research names it (issuer caps depend on it);
  - a tier from the measured depth (`tierCeilingUsd` A/B/C);
  - `blockedCountries` from the geo-blocks, as information only: the engine never acts on it (gate `COUNTRY-REMOVED`);
  - the real mint or contract where verified;
  - the verdict and the source in a comment field if the type allows, otherwise in the research note.
- **Leg types:** one `LEG_TYPES` row per new symbol, each with the research note as its source and the date read. Use the four types that exist (rate, credit, basis, market_deposit), more than one where the research says so. If a token fits none of the four (for example a stablecoin LP like USD*, or reinsurance like ONyc), stop and bring Rodrigo the choice with a recommendation: map it to the nearest existing type, or add a type (and its cap and credit-budget rule). Do not invent a type silently.
- **Caps:** a token the table does not name takes its leg type's cap (`SOLVER-CAPS`). Add no cap by symbol unless the research gives a reason, and then mark it `starting` in `params.ts`.
- **Yields:** fixture readings in `packages/engine/src/personal/fixtures/yields-extended.json` from the research's dated figures:
  - each with its source and date, `provenance: 'fixture'`, labelled MOCK wherever shown;
  - never a yield number in code (`tests/no-yield-literals.test.ts`).
- **The Etherfuse bonds (TESOURO, CETES and the others).**
  - **Default (recorded):** list each as a token counted in its own currency (`BasketAsset.currency`), usable as the matching leg for a goal in that currency. TESOURO serves a goal in reais with withdrawals in reais. It is never held in a dollar goal's dollar yield.
  - **The catch:** today the matching leg is a cash token in that currency (`world.ts` `matchingOf`), and a bond is not cash. It has price risk and a yield. Find the smallest honest change:
    - a matching-leg candidate that is not `cash` class but carries `currency`;
    - a leg type `rate`;
    - its yield accruing in the schedule;
    - its price risk in the stresses (`fx_goal_*`, plus a rate-shock stress if the research supports one).
  - **Approval:** that is an engine change. Write it up as a short proposal in the Solana note and ask Rodrigo before building it. Until he answers, list the bonds on the extended shelf with `currency` set, and leave them out of every plan with a reason ("a bond in reais is not a cash leg yet").
  - **Not BRS:** gate `G-NORA` concerns BRS only. Etherfuse is not BRS, and no BRS-specific code is written.
- **Tests, per chain:**
  - Every extended row parses as `BasketAsset`.
  - Every new dollar-yield token has a `LEG_TYPES` row.
  - Every fixture yield has a source and a date.
  - Run `candidates()` and `violations()` over a grid of goals on the extended shelf, against the launch shelf:
    - every plan passes `violations()`;
    - an income goal at low risk on Solana holds a rate token (USDY or sUSD), not only cash;
    - the safe-yield sleeve on Solana holds a rate token;
    - "no lending" leaves out credit and basis tokens and still has a rate token to hold;
    - the share stuck in cash falls on the grid, by how much stated;
    - the existing tests on the launch shelf are unchanged.
- **The comparison report:** `docs/vault/research/yield-shelf/comparison.md`. Run the playground on the same goals with `--shelf launch` and `--shelf extended` and record what changed, per chain: lines, cash share, candidates shown, scorecard lines, income verdicts. The goals are `try/prompts/examples.md` plus 6 new ones, written to exercise the new tokens:
  - low-risk income;
  - "no lending";
  - protect;
  - a reais goal with withdrawals in reais;
  - a USDG goal on Robinhood Chain;
  - (no country goal: the plan reads no country since gate `COUNTRY-REMOVED`).

### Uniswap LP and Pendle PT (Robinhood Chain)

Rodrigo asked for both. Research them like the other candidates, then bring him the modelling choice with a recommendation, before any fixture row:

- **Uniswap LP.**
  - **Can the vault hold it?** On v3 and v4 a position is an NFT, so check whether the vault (`contracts/`, the EVM registry and the guard in `packages/sdk`) can hold one. It cannot today: it holds token balances. Only a fungible LP token can be a line (a v2 pool, or a vault that wraps a v3/v4 position into an ERC-20). Find which dollar pairs exist (USDG with USDC or USDe, for example), how deep they are, and which route is fungible.
  - **Is its yield real?** Separate fees from emissions.
  - **Its risks:** the depeg risk of the pair's other token, and how it exits (burning the LP token, then the two tokens back to USDG).
  - **The modelling question:** it fits none of the four leg types. Propose either the nearest type or a new one, with its cap and its credit-budget rule.
- **Pendle PT-USDG (March 2027).**
  - **Research:** the fixed implied rate and how it is read live; the SY underlying (USDG in what?); depth before maturity; and what happens at maturity (redeem 1:1).
  - **The modelling question:** the engine has no maturity date. Propose the smallest honest model:
    - a rate leg until maturity, priced at its market price, with its exit cost before maturity;
    - its maturity date on the asset row;
    - the schedule counting it at par only after maturity;
    - not held past a goal's date if it matures after it.

    Say what the scheduler would need.
  - YT is out.
- **Until Rodrigo answers:** list the PT on the extended shelf with its maturity, left out of every plan with a reason. Do not list the LP until the holdability answer is yes.

### Part (b), the live rollout: do NOT do it here, but write it down

At the end of each chain's note, add a section "Rollout (b)": per token added, what is left and who does it.
- **Verify on mainnet before listing:** the real mint and contract (already verified in the research), decimals, and token program.
- **A live yield source:** the API or on-chain rate, with its method.
- **Bearing's exit measurement.** The collectors are not edited before Oct 12 (`CLAUDE.md`), so until then the tier fallback is used, labelled.
- **The vault's on-chain asset list:** the Solana program's list and the EVM registry. That is a deploy, which needs a person's word, and it is Thom's.
- **The production registry row.**
- **A `/decide` entry** under gate `UNIVERSE` for the final list.

Add a ledger row in `docs/vault/STATE-VAULT.md` (`SHELF-YIELD`) with owner Rodrigo, status, the evidence of (a), and the (b) items as blockers.

### Limits

- **Read-only on every chain:** public RPC reads, explorer pages and public APIs. No transaction, no key, no wallet.
- **Secrets:** never read `.env` or `secrets/`. No key or private URL in any file.
- **Running jobs:** do not edit the collectors or their launchd jobs (`scripts/launchd/`, `scripts/risk/collector/`, `scripts/depth-snapshot.mjs`), and do not run anything under `scripts/mainnet/`.
- **Branches:** do not merge PRs, push to `staging` or `main`, or edit the shared types in `packages/schemas`. If you must change a shared type, put it in its own commit titled "(shared types, for Thom)" and say so.
- **Competitors:** the brand rule (CLAUDE.md) applies to what a user reads. Issuer and protocol names in research notes and fixture rows are fine; plan wording names the token, as it does today.

### Stop and ask Rodrigo only for

- a candidate whose verdict the filters do not settle;
- a token that fits no existing leg type;
- the Uniswap LP and Pendle PT models (above);
- the Etherfuse matching-leg change;
- anything that changes what a plan for an existing goal does on the launch shelf.

Everything else: decide, and note it in the PR.

### How each branch lands

Each branch lands the same way:
1. Run `pnpm verify` (exit 0), at most twice per branch; never two full suites at once.
2. Get an independent review with `/review-pr`, then fix and re-review the affected scope.
3. Open a draft PR (`/open-pr`) into the base in the table.
4. Update the `SHELF-YIELD` ledger row with the evidence.

Commits are prefixed `shelf:`, `docs:` or `tools:`.

### Report back

- The PR links.
- Per chain: the final list (added / hold / out) with one line each.
- The tokens that need Rodrigo, with your recommendation for each.
- What the comparison shows, in five lines per chain.
- The test and verify results.
- The (b) list, with owners.
