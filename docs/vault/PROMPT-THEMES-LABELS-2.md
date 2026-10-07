# PROMPT (restart 2): finish the stock labels, the matched theme and the review fixes of ENG-3

> Written 2026-10-06 (evening) by Rodrigo's session when the machine had to be turned off. It continues `docs/vault/PROMPT-THEMES-LABELS.md`. Start a fresh Claude Code session in `~/Documents/Colosseum` (the hooks load there), then say: `Run ~/Documents/Colosseum-try/docs/vault/PROMPT-THEMES-LABELS-2.md`.

**Nothing is pushed.** Every commit is local, in its worktree, and no pull request was opened. The session tried to push the six branches as drafts on Oct 7 and the permission check refused it: Rodrigo pushes, or allows it (section 3, step 7).

---

## 1. Where things stand (Oct 7, after the session resumed)

| Worktree | Branch | Local state when this was written | `pnpm verify` |
|---|---|---|---|
| `~/Documents/Colosseum-engine` | `engine/plans` (#64) | `a4a5765f`, then the engine agent's next task (section 2) | exit 0 at `a4a5765f`: 3,833 tests |
| `~/Documents/Colosseum-themes` | `engine/themes` (#72) | `3e037893` (merge of `engine/plans`) | exit 0: 3,884 tests |
| `~/Documents/Colosseum-rebalance` | `engine/rebalance` (#73) | `97da959b` | exit 0: 3,930 tests |
| `~/Documents/Colosseum-labels` | `themes/labels` (no pull request yet) | `8185409c` (merge of `engine/themes`) | exit 0: 3,981 tests |
| `~/Documents/Colosseum-intake` | `engine/intake` (#71) | `469d3cbd`, then the intake agent's next task (section 2) | one run at `d4629631`: 4,074 passed, 1 timed out at 5 s under load and passes alone (it has a 60 s timeout since `469d3cbd`). No clean run yet |
| `~/Documents/Colosseum-try` | `tools/try-plans` (#93) | `6b26f29e` and later: everything merged, the wiring, the `/plan-chat` skill, this file | one run at `29b2c407`: 4,387 passed, 1 boundary self-check timed out under load and passes alone. No clean run yet |

The verify logs, the research files, the two content generators (`stocks/assemble.mjs`, `stocks/labels.mjs`), the three review reports' scripts and the gate text are in `~/Documents/Colosseum-data/themes-labels-session-20261006/` (outside the repo). `review/REPORT.md` is the first review; `review2-engine/` and `review2-intake/` hold the second round's scripts. Each of the two agents left an untracked note in its worktree: `Colosseum-engine/HANDOFF-ENGINE-WIP.md`, `Colosseum-intake/HANDOFF-INTAKE-WIP.md`.

**What works end to end** (the playground, model off, extended shelf): "all of it in semiconductors" on Robinhood Chain holds AMD, INTC, MU, NVDA, TSM, said as matched by industry; "defense stocks" on Solana says "There is no stock for “defense stocks” on Solana at the moment. We will be adding more soon." and builds the plan from the rest; "Put $1,000 in AI" of $2,000 on Solana holds the confirmed AI list at 50% and the rest in the safe-yield sleeve; "I am retired so no stocks please" reads back "You left out stocks and stock funds." and no plan holds either.

## 2. In flight when this was written, and what the second review found

Two independent reviewers looked at everything new on Oct 6 and 7. What they confirmed: the mix with withdrawals, the country leftovers, the merges, the labels fixes (each with a mutation that fails a test), the wiring's merges, the route's no-file rule, that no test was weakened. What they found is being fixed by rule, not by word list:

- **The intake agent** (`engine/intake`): (1) with a model, a holding (a mix, a narrative, its share) is taken only when the model read it and the text confirms it; words the model did not read are flagged, not taken; (2) with no model, a holding read from the text is asked once, never taken, and a question never comes back once answered; (3) the last mention wins across messages; (4) bare "funds" is not stock funds, and a refusal beside a holding of the same class is asked; (5) a share is taken only in its plain forms, and "the rest in stocks", "except $1,000" are asked; (6) a filter fills a sleeve only when the shelf lists at least two names for it, with its own sentence when there is exactly one; (7) two new inputs, `riskOfSleeves` and `shelfKnown`. The reviewer's sentences are in `review2-intake/` (`b1` to `b7`, `c2`, `c4`, `c5`, `a3`).
- **The engine agent** (`engine/plans`, then merges down): the risk a mix takes when a shared portfolio is followed whole (the plan took low and said "50% with one issuer" with Backed at 100%); the plan staying at a risk whose cap keeps stocks out; `violations()` re-deriving both without the plan's own sentences; the plan saying when its risk is above what the read-back could know; the odd cent. Scripts in `review2-engine/` (`p2` to `p11`, `fuzz-risk`).

**Queued, not started:**
1. On `themes/labels`, the engine side of rule (6): one rule, "a matched theme fills a sleeve only when the shelf lists at least two of its names", in `fillingList` (`theme-sleeve.ts`), replacing the rule on a keyword's tracked carriers in `matchStocks`; a true sentence for exactly one name (today `matched-keyword-smartphones` on Solana says "There is no stock" while AAPLx carries it); `attributeVocabularyOf` takes the shelf's tokens and gives only values at least two listed names carry; `violations()` and the tests follow. The intake's rule (6) already keeps the product's own path from making such a sleeve.
2. On `tools/try-plans`, after the last merges: wire `riskOfSleeves` (the lowest risk at which the theme sleeves hold their whole share in their names: make the plan at each risk) and `shelfKnown: false` where the route could not read the chain's shelf, in `apps/api/src/routes/v1/intake.ts` and `scripts/try/run.ts`; fix three sentences the wiring made false (`docs/vault/DESIGN-VAULT.md` "The route hands none yet", twice, and `try/README.md` "it reads no refusals"); in `.claude/skills/plan-chat/SKILL.md` the example "pharma" has a market id now (use "streaming").
3. `docs/GATES.md`, the same bytes on every branch (edit it on `engine/plans` and `engine/intake`, let it flow down): `THEME-NONE-YET` (a proposed list counts as none at the intake; a sheet that still names it says "its list is proposed and not confirmed yet"); `MATCH-RULES` (rule 6 replaces the keyword rule; and the sentence about what the model is shown: none of the classification values of our files is sent, the reader's instructions name the classification and three of its industries as examples); `MIX-AS-WRITTEN` and `MIX-RISK` as the two agents finally build them.
4. One ledger row for this work in `docs/vault/STATE-VAULT.md`, the same line on `engine/plans` and `engine/intake` (the ENG-3 row is one long line: add rows after it, do not edit it on two branches). It still has none of this work.

## 3. What to do, in this order

1. **Read the two agents' reports or notes**, and check their diffs: their reports are claims. Run the reviewers' scripts again on the result.
2. **Merge**: `engine/plans` into `engine/themes`, that into `engine/rebalance` and `themes/labels` (the engine agent was asked to do these three); then `themes/labels`, `engine/rebalance` and `engine/intake` into `tools/try-plans`. Conflicts so far were always import and export lines, the header of `templates.ts`, and `docs/GATES.md` (take the intake's or the engine's, they are the same file).
3. **The queue of section 2**, items 1 to 4.
4. **Re-review the affected scope only** with an agent that wrote none of it: the two agents' new commits and items 1 and 2. Do not restart a broad audit: both reviewers said what is sound.
5. **`pnpm verify`, one branch at a time, with nothing else running on the machine** (a second test process makes 5-second tests time out: that is what failed every non-clean run so far). All six branches at their final tips.
6. **Ledger evidence**, then the memory `eng3-solver-handoff`.
7. **Push and pull requests, with Rodrigo's word**: the six branches, then a pull request for `themes/labels` into `engine/themes` (stacked on #72) with `/open-pr`. #64, #71, #72, #73 and #93 exist as drafts. Merge none.

## 4. For Rodrigo to decide

1. **Label membership** (gate THEMES). Every list is `proposed`; confirming one means its file, the table in `tests/stock-labels.test.ts` and a gate row, in one change. A name in brackets is tracked and not on the launch shelf, so it cannot be held yet.

| Label | Solana | Robinhood Chain |
|---|---|---|
| AI | NVDAx MSFTx GOOGLx METAx AMZNx TSLAx AAPLx (**confirmed**, THEME-AI-SOLANA) | NVDA MSFT GOOGL META AMZN TSLA AAPL |
| Big Tech | AAPLx MSFTx GOOGLx AMZNx METAx NVDAx TSLAx | AAPL MSFT GOOGL AMZN META NVDA TSLA |
| Semiconductors | NVDAx | NVDA AMD INTC MU TSM (ASML) SNDK |
| AI infrastructure | NVDAx MSFTx AMZNx GOOGLx | NVDA AMD INTC MU TSM DELL (CRWV) (NBIS) (ORCL) MSFT AMZN GOOGL |
| Crypto economy | COINx CRCLx HOODx MSTRx | COIN CRCL MSTR (CLSK) |
| Fintech and brokers | HOODx COINx CRCLx | COIN CRCL |
| Space | SPCXx | SPCX (RKLB) |
| Quantum computing | none | (IONQ) (RGTI) |
| Electric vehicles and self-driving | TSLAx GOOGLx | TSLA GOOGL |
| Cloud and software | MSFTx AMZNx GOOGLx PLTRx | MSFT AMZN GOOGL (ORCL) PLTR |
| Emerging markets and Asia | none | TSM BABA (EWY) |
| Commodities and real assets | GLDx | GLD SLV USO (USAR) |
| Broad market | SPYx QQQx | SPY QQQ |
| Retail favourites | (GMEx) | GME (AMC) |
| Defense | PLTRx SPCXx | PLTR (RKLB) SPCX |
| Health care (added) | none | (LLY) (HIMS) |
| Social media (added) | METAx | META (RDDT) (DJT) |

   Judgment calls inside it: Tesla is in Big Tech only to match The Seven (no filing supports it); Sandisk is in Semiconductors though classified as hardware; a company that only holds bitcoin (GameStop, Trump Media, Tesla) and STRC (a preferred stock) are out of Crypto economy; SpaceX is in Defense and in Space, and is classified as telecommunications, so no filter by industry finds it.
2. **The alternative to the filter**: the model proposes a list, shown "inferred, not curated", and he or the person confirms it. Not built; it needs `/decide`, since it breaks "the model never picks assets".
3. **The six rules of section 2.**
4. **The classification names.** `content/stocks/` uses GICS names, which MSCI and S&P own; MSCI's document carries a notice against use in a database, as input to a language model, or commercially, without permission (DESIGN-VAULT section 17, item 30, on `themes/labels`). A licence, or a classification of our own or from the SIC code of each filing.
5. **For Thom:** the web goal screen no longer asks the country (`eebe04bf` on `engine/plans`); the shared-type commits listed in the first prompt still wait for him.

## 5. Not started

- The three gaps of the explicit mix that need the engine: a mix inside a split ("70% safe, and the other 30% all in stocks").
- `MAX-YIELD-SLEEVE`, risk and liquidity per sleeve, the rebalancing route, and the yield-shelf models (Etherfuse, Uniswap LP, Pendle PT), as listed in the first prompt.
- Labels and attributes for Base.

## 6. Rules for the session

As in the first prompt: act as the orchestrator; at most two implementation agents at once, each in its own worktree; never two `pnpm verify` runs at the same time; every meaningful change reviewed by an agent that did not write it; no merge of a pull request, no push to `staging` or `main`, no `.env`, no transaction; commits end with the session's attribution lines. Stop and ask Rodrigo only for label membership, the "model proposes a list" decision, or a product choice the documents do not settle.
