# PROMPT (restart 2): finish the stock labels, the matched theme and the review fixes of ENG-3

> Written 2026-10-06 (evening) by Rodrigo's session when the machine had to be turned off. It continues `docs/vault/PROMPT-THEMES-LABELS.md`. Start a fresh Claude Code session in `~/Documents/Colosseum` (the hooks load there), then say: `Run ~/Documents/Colosseum-try/docs/vault/PROMPT-THEMES-LABELS-2.md`.

**Nothing of this session is pushed.** Every commit below is local, in its worktree. Nothing was merged into `staging` or `main`, no pull request was opened, and `pnpm verify` (the full gate) was not run on any branch: only `pnpm verify:quick` and focused tests.

---

## 1. Where things stand

| Worktree | Branch | Local state | What it holds |
|---|---|---|---|
| `~/Documents/Colosseum-labels` (new) | `themes/labels`, cut from `origin/engine/themes`, no upstream | 17 commits, clean | The contract `market-filter.ts`, the matched theme sleeve, `content/stocks/` (19 + 42 rows), 30 proposed label files, the content tests, DESIGN-VAULT sections 2, 7, 17. Reviewed once; its 8 blocking findings are fixed, not re-reviewed |
| `~/Documents/Colosseum-intake` | `engine/intake` (#71) | 15 commits ahead of origin | The same contract file (byte-identical), the narratives in the intake (a narrative reads to a shared portfolio, a confirmed label, a filter, or nothing), the reader's `marketFilter`, and the intake findings of the review of COUNTRY-REMOVED and EXPLICIT-MIX. Not reviewed |
| `~/Documents/Colosseum-engine` | `engine/plans` (#64) | 10 commits ahead of origin, 2 files uncommitted (`compose.ts`, `mix.test.ts`) | The engine findings of that review (a mix with withdrawals, `riskForMix`, `violations()`), the country leftovers in the web goal screen and the wording. Not reviewed |
| `~/Documents/Colosseum-try` | `tools/try-plans` (#93) | 18 commits ahead of origin | `themes/labels` merged in (`9dbe82f8`), and this file. The intake and the engine fixes are not merged here yet, and nothing is wired |
| `~/Documents/Colosseum-themes`, `-rebalance` | `engine/themes` (#72), `engine/rebalance` (#73) | untouched | They wait for the merge-down of `engine/plans` |

Two agents were stopped when the machine went down, and each left a note, untracked, in its worktree. Read both first:
- `Colosseum-intake/HANDOFF-INTAKE-WIP.md`: the intake agent finished and committed every item of its task (the last commit is `286b38b0`); the note says what it changed, which tests moved and why, and what it chose differently. Its last runs: `verify:quick` passed, 435 tests in the engine folder, 28 in the API.
- `Colosseum-engine/HANDOFF-ENGINE-WIP.md`: the engine agent committed every finding (the last commit is `969be609`, 316 tests in the engine folder) and left two files uncommitted, `compose.ts` (one late change, `Run.alone`, typechecked and not re-run) and `mix.test.ts` (a new property test). Run `pnpm exec vitest run packages/engine/src/personal` there; if it fails, drop only the `compose.ts` change, as the note says. The note also lists what to watch when merging `engine/plans` into `engine/themes`, `engine/rebalance` and `tools/try-plans`, and the two rules it implemented for Rodrigo to confirm (a mix with withdrawals; the risk a mix takes).

The session's scratch files were copied to `~/Documents/Colosseum-data/themes-labels-session-20261006/` (outside the repo):
- `stocks/`: the two research files, Robinhood's registry as read (`rh-assets.json`), and the two generators that write the content (`assemble.mjs` writes `content/stocks/`, `labels.mjs` writes `content/themes/`: edit the tables there and run them again rather than editing 30 files by hand);
- `review/REPORT.md`: the independent review of COUNTRY-REMOVED and EXPLICIT-MIX (9 blocking findings), with its reproductions;
- `review-labels/`: the reproductions of the review of `themes/labels`;
- `docs/gates-rows.md`: the two gate rows, written and not yet in any `docs/GATES.md`.

## 2. What was built, and what was decided on the way

**The contract** (`packages/engine/src/personal/market-filter.ts`, the same file on `themes/labels` and `engine/intake`): a filter is `{ by: 'sector' | 'industry' | 'sub_industry' | 'keyword', value }`. It travels in the sheet as a theme sleeve's slug, `matched-<by>-<key>` (`matched-industry-aerospace-defense`), so no shared type changed.

**What 1c does, in three lines.** The model, or the intake's fixed word lists, name only a filter over the sourced attributes (never a stock). Pure code (`matchStocks`) selects the stocks that carry the value, and the theme sleeve holds them as it holds a curated list, every line said as "matched, not curated". Example: "semiconductors" on Robinhood Chain, while its label is only proposed, becomes industry: Semiconductors & Semiconductor Equipment and holds NVDA, AMD, INTC, MU and TSM.

**Rodrigo's instruction of Oct 6** ("if there is no stock that fits the label and cannot be inferred, tell the client there is no stock at the moment and we'll be implementing soon") is built as: "There is no stock for “X” on <chain> at the moment. We will be adding more soon.", with the nearest portfolio or label offered where the shelf has one. Nothing is held for it: no sleeve, no mix, no share question.

**Rules added by the build and its reviews, for Rodrigo to confirm** (each is in DESIGN-VAULT section 7 on `themes/labels`):
1. A field a row marks `unverified` is never matched on.
2. A fund and a preferred stock are matched by keyword only.
3. A keyword selects nothing unless at least two tracked stocks of the chain carry it (nine keywords in ten were carried by one stock: naming one was picking the stock).
4. A narrative held as a theme sleeve takes the share the person wrote, and the rest goes to the safe-yield sleeve (gate EXPLICIT-MIX says "the rest in cash" for a portfolio).
5. A narrative with nothing to hold no longer becomes "that share in generic stocks at high-risk limits", which is what the first build of EXPLICIT-MIX did.
6. No sector, industry or sub-industry name is sent to the model: only our own keywords (see the licence question below).

## 3. What to do, in this order

1. **Check the state** of section 1 against `git status` and `git log` in each worktree, and read the two notes. In `Colosseum-engine`, test the two uncommitted files and commit or drop them.
2. **Confirm the two agents' tasks are whole** (their reports are claims until checked: read the diffs). Their task lists were:
   - Intake (`engine/intake`): (A) a narrative with nothing to hold is not a stated holding; (B) the narratives table with ordered fallback filters and two new narratives, `health_care` and `social_media`; (C) review findings 1, 4, 6 and 9 of `review/REPORT.md`; (D) "about 5 years" read back in years, and a share said in a later message read by the API's follow-up path; (E) DESIGN-VAULT section 7 for the intake; plus the words "names matched by" and "keyword" / "palavra-chave".
   - Engine (`engine/plans`): (A) a mix with withdrawals; (B) `riskForMix` takes a risk that admits the mix; (C) `violations()` sees an under-held mix; (D) the small optional findings; (E) the country leftovers (web goal screen, wording, PLAN-VAULT line 91).
3. **`docs/GATES.md` on every branch.** The Oct 6 rows differ by branch (review finding 7). `origin/tools/try-plans` has the union: copy that file onto `engine/plans` and `engine/intake` (it only adds rows), then append the two rows of `docs/gates-rows.md` (`THEME-MATCHED`, `THEME-NONE-YET`) after `EXPLICIT-MIX`, the same bytes on `themes/labels`, `engine/intake` and `tools/try-plans`. Check the rows against what the agents really built before writing them.
4. **Merge down the stack**, never rebasing: `engine/plans` into `engine/themes`, that into `engine/rebalance`; `engine/themes` into `themes/labels`; then `themes/labels`, `engine/rebalance` and `engine/intake` into `tools/try-plans`. Expect conflicts in `packages/engine/src/personal/index.ts` (keep both sides' exports; `MARKET_SLUG` is gone on the intake side), `templates.ts`, `intake.ts` (the `riskOfMix` lines that exist only on `tools/try-plans`) and `DESIGN-VAULT.md`.
5. **Wire it on `tools/try-plans`** (the only place where the intake and the theme sleeve meet):
   - `scripts/try/data.ts`: load `content/stocks/<chain>.json` (`loadStockAttributes`), hand `stocks` in the context, and give each chain its `labels` (`shelfLabelsOf`).
   - `scripts/try/run.ts`: pass `labels` and `matchOf: (f) => filterMatchOf(f, stocks, shelf.assets)` to `runIntake`, and the keywords of `attributeVocabularyOf(stocks)` to the reader (no sector or industry names).
   - `apps/api/src/routes/v1/intake.ts`: the same, through injected inputs (no file reachable from the `/v1` routes may read a file: `orders.test.ts`), and `riskOfMix` too (review finding 5).
   - `scripts/try/json.ts`: put `narratives` and what the shelf offers (portfolios, usable labels) in the JSON.
   - `.claude/skills/plan-chat/SKILL.md`: when the person asks "what can I invest in?", list the shared portfolios and the confirmed labels with a name on the shelf from that JSON; say the founder's sentence for the rest; take a `marketFilter` value only from the keywords given; remove "where they live" (line 92).
   - Tests (1d.3 of the first prompt): an unknown narrative falls back honestly end to end; the same filter gives the same members in any order; `violations()` holds a matched theme as a curated one.
6. **Verify**, one branch at a time, never two at once: `pnpm db:up`, then `pnpm verify` on `engine/plans`, `engine/themes`, `engine/rebalance` (its earlier run timed out under load in `risk-split.test.ts`), `themes/labels`, `engine/intake`, `tools/try-plans`. Restore `apps/web/next-env.d.ts` after each build.
7. **Independent review** by an agent that wrote none of it: the fix commits on `themes/labels` (`f7c4f716`, `2ffe6bef`, `4c8866d8`, `e9262362`), the whole of the intake's and the engine's new commits, and the wiring. Fix, and re-review the affected scope.
8. **Ledger and pull requests.** One new row in `docs/vault/STATE-VAULT.md` for this work (the ENG-3 row is one very long line: do not edit it on two branches), with the commands and results. Push the branches. Open a pull request for `themes/labels` into `engine/themes` (stacked on #72) with `/open-pr`; #64, #71 and #93 already exist as drafts. Do not merge any.
9. **Update the memory** `eng3-solver-handoff` and this file's state.

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
