# PROMPT (restart): stock labels for narratives and themes, and the open items of ENG-3

> Written 2026-10-06 by Rodrigo's session before clearing it. Start a fresh Claude Code session in `~/Documents/Colosseum` (the hooks load there), then say: `Run ~/Documents/Colosseum-try/docs/vault/PROMPT-THEMES-LABELS.md`.

---

## Where things stand (read before acting)

The engine work is on five branches, each in its own worktree:

| Worktree | Branch | PR | What |
|---|---|---|---|
| `~/Documents/Colosseum-engine` | `engine/plans` | #64 → `staging` | Three candidates (Cover, Spread, Carry), scorecard, status; base of the stack |
| `~/Documents/Colosseum-themes` | `engine/themes` | #72 → #64 | Theme sleeve; AI list for Solana (`content/themes/solana/ai.json`) |
| `~/Documents/Colosseum-rebalance` | `engine/rebalance` | #73 → #72 | Rebalancing with a sleeve book |
| `~/Documents/Colosseum-intake` | `engine/intake` | #71 → `staging` | Guided intake (model reader, checks, read-back) |
| `~/Documents/Colosseum-try` | `tools/try-plans` | #93 → `staging` | Playground (`pnpm plan:try`) and the `/plan-chat` skill; it merges all of the above plus the yield shelf (#95, #97, #98) |

How work moves between them:
- The engine changes go in `engine/plans`, then are merged without rebasing into `engine/themes` and then `engine/rebalance`.
- Intake changes go in `engine/intake`.
- `tools/try-plans` merges all of them.
- Never rebase or force-push.

Read `docs/vault/HANDOFF-ENG3.md` on `engine/plans` and the `docs/GATES.md` rows of Oct 5 and 6. Decisions made on Oct 6:

| Gate | What it settles |
|---|---|
| `COVER-CREDIT` | |
| `CANDIDATE-NAMES` | |
| `THEME-AI-SOLANA` | The seven AI names |
| `THEME-FIRST` | |
| `GLIDE-OPT-IN` | |
| `OUTCOME-VIEW` | Downside and yield only, no upside |
| `MAX-YIELD-SLEEVE` | Specified, not built |
| `COUNTRY-REMOVED` | |
| `EXPLICIT-MIX` | A stated mix or market is held as stated, and no risk question is asked |

## Part 1: stock labels for narratives and themes (the main task)

Persons in `/plan-chat` ask to invest by narrative ("AI", "big tech", "space", "crypto economy", "defense"). Today only `ai` (a theme list) and The Seven (a shared portfolio) exist.

**1a. A label set, from the tracked stocks.** On Solana these are the 18 stocks of gate `UNIVERSE` (`docs/risk/PLAN-UNIVERSE.md` §2). On Robinhood Chain, the stock tokens on the launch shelf (`docs/vault/research/open-questions/launch-shelf.seed.json`, `assets.robinhood`), plus the RU.3 cut where it exists. Start from this proposal, refine it, and add what the research supports:
- Big Tech
- Semiconductors
- AI infrastructure / data centers
- Crypto economy
- Fintech / brokers
- Space
- Quantum computing
- EV and autonomy
- Cloud and software
- Emerging markets / Asia
- Commodities and real assets
- Broad market (index funds)
- Meme / retail favourites
- Defense, if any tracked name fits

Per label, per chain, one file under `content/themes/<chain>/<slug>.json`, in the shape of `ai.json`: slug, name in English and Portuguese, version, curator, status `proposed`, members each with symbol and a one-line reason. Membership is Rodrigo's call (gate `THEMES`). Write the lists as proposed and bring them to him in one table. Do not mark any confirmed yourself.

**1b. Sourced attributes per tracked stock**, so asks that no label covers can still be served without the model picking assets (see 1c). Write one data file per chain, `content/stocks/<chain>.json`, with one row per tracked stock:
- issuer company;
- GICS-style sector, industry and sub-industry;
- 3 to 8 business-line keywords ("cybersecurity", "GLP-1", "cloud", "advertising");
- for a fund, what it tracks;
- its sources and the date read: company filings and the issuer's site, read from the web; no figure is invented.

Use a research agent per chain. Facts that could not be verified are marked unverified.

**1c. Serving an ask that has no label.**
- **The rule:** the core rule (`CLAUDE.md`, gate `GUIDED-INTAKE`) says the model never picks assets. Keep it.
- **The model's part:** it maps the person's words to a filter over 1b's attributes (for example "defense" becomes industry = Aerospace & Defense; "obesity drugs" becomes keyword GLP-1).
- **The engine's part:** pure code selects the members deterministically and builds a theme sleeve from them.
- **What the plan says:** "matched by industry: Aerospace & Defense, not a curated theme". It is labelled as matched, not curated.
- **When no member matches:** it says so in one line and offers the nearest label.
- **Where it lives:**
  - the reader schema (`apps/api/src/llm.ts`) gets a `marketFilter` field;
  - the filter itself is a pure engine function;
  - the theme sleeve accepts a matched list as it accepts a curated one.

Bring Rodrigo the alternative too, as a decision he may make with `/decide`: the model proposes a list, shown "inferred, not curated", and he or the person confirms it. Today that would break the "model never picks assets" rule. Do not build it without his decision.

**1d. Wire it in, in this order.**
1. The intake maps narrative words to a label or a filter, with "big tech" mapping to The Seven or the Big Tech label.
2. `/plan-chat` lists the labels it can use when the person asks "what can I invest in?".
3. Tests: every label file parses and every member is a tracked token on its chain; the same filter gives the same members in any order; an unknown narrative falls back honestly; `violations()` holds a matched theme as it holds a curated one.

Branches:
- the labels, the attributes and the filter go in a new branch `themes/labels`, cut from `origin/engine/themes`;
- the intake mapping goes on `engine/intake`;
- then merge both into `tools/try-plans`.

## Part 2: open items from the last session

1. **Independent review, not yet run**, of the country removal (`COUNTRY-REMOVED`) and the explicit mix (`EXPLICIT-MIX`) on all five branches. Run `/review-pr` with an agent that did not write it, then fix and re-review the affected scope.
2. **Gaps in the explicit mix:**
   - "about 5 years" is read back as "over 60 months": say "about 5 years";
   - a share given in a later message in words is read only through the chat (`answers.mix`), not by the API's follow-up path;
   - a mix and a split cannot be combined ("70% safe, and the other 30% all in stocks").
3. **On `engine/rebalance`:** one `pnpm verify` run timed out under load in `risk-split.test.ts`. Re-run `pnpm verify` there when the CPU is quiet.
4. **For Thom, not code:**
   - approve the shared-types commits in #64, #71, #73 and the newest (`9aa4153b`, the mix; `158f4974`, country optional);
   - the small web edits ("No date set");
   - the migration token, for the rebalancing route.
5. **Not built yet:**
   - the `MAX-YIELD-SLEEVE` objective (spec in `HANDOFF-ENG3`; it needs the yield shelf, now merged into `tools/try-plans`);
   - risk and liquidity per sleeve (a shared type, Thom's);
   - the rebalancing API route (needs the migration token);
   - the Etherfuse bonds, the Uniswap LP and Pendle PT models, waiting on Rodrigo's choices from the yield-shelf session (see the notes under `docs/vault/research/yield-shelf/`).

## Rules for this session

- Act as the orchestrator (`.claude/rules/orchestration.md`).
- At most two implementation agents at once, each in its own worktree; never two `pnpm verify` runs at the same time.
- Every meaningful change gets a review by an agent that did not write it.
- Do not merge PRs, push `staging` or `main`, read `.env`, or send any transaction.
- Commits end with the session's attribution lines.
- Stop and ask Rodrigo only for:
  - label membership;
  - the "model proposes a list" decision;
  - a product choice the documents do not settle.

## Report back

- The label table, with members per chain and the status of each, for Rodrigo to confirm.
- What 1c does, in three lines, with one example ask served by a filter.
- The PR links.
- The test and verify results.
- What is left.
