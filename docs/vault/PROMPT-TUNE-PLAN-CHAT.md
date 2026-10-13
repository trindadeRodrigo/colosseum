# PROMPT: tune the plan chat on `tools/try-plans` until it is fit to ship

> Written 2026-10-07 (about 12:45) by Rodrigo's session. Start a fresh Claude Code session in `~/Documents/Colosseum-try` (this checkout, so the `/plan-chat` skill and the hooks load), then say: `Run docs/vault/PROMPT-TUNE-PLAN-CHAT.md`.

## The goal

Rodrigo tests the chat and the playground and says what is wrong; the session fixes it, here, fast. The aim is a working thing to ship this afternoon. Section 4 says what stands between this branch and production: read it to him before promising a time.

## 1. Where things stand

- `tools/try-plans` (pull request #93, draft) at `9720dee8` plus the documents commit that added this file. `pnpm verify` exit 0 at `9720dee8`: 245 files, 4,541 tests. CI's `check`, `e2e`, `program` and `validator` pass on it.
- It holds the plan engine (three candidates, the theme sleeve, a stated mix, the issuer rule), the guided intake after three independent reviews, 30 confirmed stock label lists, the matched theme, the playground (`pnpm plan:try`) and the `/plan-chat` skill.
- Gate `TUNE-ON-TRY` (Rodrigo, Oct 7): every change is committed on this branch directly. The stack branches (`engine/plans`, `engine/themes`, `engine/rebalance`, `themes/labels`, `engine/intake`) are not touched until the carry-back (ledger row ENG-3f).
- Gate `CHAINS-NOW`: Solana and Robinhood Chain only. Nothing for Base.
- The ledger rows are ENG-3b (done today) and ENG-3c to ENG-3j (put off) in `docs/vault/STATE-VAULT.md`. The decisions are in `docs/GATES.md`, sections "Open on 2026-10-06" and "Decided on 2026-10-07".

## 2. How to run it

```sh
pnpm plan:try try/prompts/examples.md            # the page, every goal of a file; add --shelf extended, --json, --no-open
```

`/plan-chat` in this session plays the product. Each chat writes `try/mine/chat-<time>.md`. Every figure is MOCK from fixtures unless `--data db`. `try/README.md` has the rest.

## 3. How to work

1. Ask Rodrigo what he saw: the words he typed, what the chat asked or said, what he expected. Reproduce it first with the playground (`--json`) or a probe through `runIntake`, and show him the reproduction in one line.
2. Find which layer is wrong before changing anything:
   - what the chat says and how it asks: `.claude/skills/plan-chat/SKILL.md`;
   - what is read from the text: `packages/engine/src/personal/intake.ts`, `intake-text.ts`; the model's instructions are `INTAKE_SYSTEM` in `apps/api/src/llm.ts`;
   - the sentences: `packages/engine/src/personal/templates.ts` (English and Portuguese, both);
   - what the plan holds: `packages/engine/src/personal/` (`compose.ts`, `placement.ts`, `mix.ts`, `theme-sleeve.ts`), numbers in `params.ts`;
   - which stocks a narrative means: `content/themes/<chain>/*.json` (membership is Rodrigo's call, gate `THEMES`), `content/stocks/<chain>.json`.
3. Fix by rule, not by adding his sentence to a list. The standing rules of the intake: neither reader (the model, the text check) decides alone; the last word wins over an answer; asking one question more is allowed, taking what was not stated is not. The model never sets weights, picks assets or states a figure.
4. Each fix: a test that fails before it, the document that states the old behaviour updated in the same commit (`docs/vault/DESIGN-VAULT.md` section 7; `docs/GATES.md` through `/decide` when he decides something), `pnpm openapi:emit` when the route's description or a question's field changes.
5. Checks per fix: `pnpm verify:quick` (the commit hook runs it) and the focused set, `pnpm exec vitest run packages/engine tests/try-plans.test.ts tests/stock-labels.test.ts apps/api/src`. Before a push: one `pnpm verify`. The machine is shared with other sessions: check `uptime` first; under load 5-second tests time out, and that run is not a pass (memory `verify-under-load`).
6. Small things he asks for (a word, a number in `params.ts`, a list member) do not need an agent. Use one for a change that reads many files, and an independent reviewer before anything ships.

## 4. What stands between this branch and production

"Production" is `main`. Work reaches it through `staging`, and merging into `main` needs a person's word. As of Oct 7:

1. **`audit` is red on every pull request**: a new high advisory in `source-map-js` (GHSA-68fv-2mgg-jv7q), beside the `braces` one gate `AUDIT-BRACES` allows. That gate blocks a merge while any other advisory is open. Ledger row ENG-3h; a task chip was left in the earlier session.
2. **`tools/try-plans` is 455 commits behind `staging`**, and `staging` is 735 commits ahead of `main`. This branch must take `staging` in and pass `pnpm verify` again before #93 can merge (ENG-3g). Conflicts are likely in the API, the web and `docs/`.
3. **#93 is a draft and so is the stack.** #93 contains the stack's commits, so it can merge on its own if Rodrigo and Thom agree to that; otherwise the order is #64, #72, #73, #161, then #71, then #93, after the carry-back (ENG-3f). Thom still approves the shared-type commits.
4. **Not independently reviewed**: the third review's intake fixes and the engine commits since `a4a5765f` (ENG-3c). The repository's contract asks for a review by someone other than the author before work is done.
5. **The web client** does not send `answersThen`, so there a plain yes or no after form answers is ignored (ENG-3d). The playground and `/plan-chat` send it.
6. Deploying is a person's action (`CLAUDE.md`). Say plainly which of these Rodrigo chooses to accept and which must be closed first; do not shorten the list to meet the afternoon.

## 5. Known behaviour, so it is not reported as new

- With no model, a holding the person states is asked once before it is held.
- A confirmed list with one listed name (Semiconductors or Space on Solana) holds that name up to the cap per stock, and the rest goes to the safe part; the read-back does not warn (ENG-3e).
- On Robinhood Chain a goal to grow holds 50% cash at low risk and 30% at medium (gate `ISSUER-COUNTS`).
- "Put 10% in AI at most." is taken as 10%; "I have $5,000 and owe $2,000" asks the amount (ENG-3d).
- A narrative only a model can name ("obesity drugs") is not read with the model off.

## 6. Rules

No push to `staging` or `main`, no merge of a pull request, no `.env`, no transaction, no deploy without Rodrigo's word. A push of this branch needs his word in the new session. Commits end with the session's attribution lines. At most two implementation agents at once; never two `pnpm verify` runs at once.
