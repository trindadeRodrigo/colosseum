# PROMPT: the relaxed intake, a model that reads intent off the table with the fewest rules that still work

> Written 2026-10-07 by Rodrigo's session. Start a fresh Claude Code session in a new worktree and paste this whole file. It builds an experiment beside the guided intake, not in its place: the guided intake stays as it is until Rodrigo decides between them (section 8).

## 1. Why

The guided intake has two readers: the model fills the sheet, and `packages/engine/src/personal/intake-text.ts` (2,566 lines of regexes and templates, in two languages) reads the same text and can veto the model. Every phrasing that fails needs a new regex. Calibrating that is where the time goes, and the conversation it produces is stiff.

Rodrigo's principle (Oct 7): **the model is constrained where it touches money and free where it talks.** The solver stays deterministic on the parameter table and the model never sets a weight, picks a figure or states a yield. Reading the goal, asking, saying it back and explaining the plan are the model's, in its own words, with the whole shelf in front of it and no regex gate.

"I want to invest in Elon" must end as: Tesla, one line, SpaceX named as not available if it is not on the shelf, equal split, "is that right?". No question about risk, horizon or terms, because nothing in the sentence needs them.

## 2. The four rules, and nothing else by default

1. **Pick only from the table.** The model may reason about anything (a person means the companies they are known for, a theme means the members on the shelf) but may only output ids that exist in the shelf it was given. Zod checks every id; an unknown id is dropped and reported to the model once, then dropped for good. What it understood but could not place goes in `not_available`, with one line on why.
2. **Equal split unless the person said otherwise.** Weights come from one deterministic function after the model, never from the model. A stated preference ("mostly Tesla", "70/30") is recorded in `stated` and the function follows it.
3. **Say it back, get a yes.** One read-back in the person's language: what was understood, what was picked and why, what was not available, what was assumed. Nothing is built before the yes. Prefer a stated assumption over a question; at most one question, only when a pick is impossible without it.
4. **No figure the table does not hold.** The model never states a yield, price or return. Where it mentions one it quotes the table row, which carries `source`, `fetched_at` and `method`.

Two rules the repo already enforces in data, kept because they cost nothing: a plan to protect or for income holds no stock tokens (`packages/engine/src/personal/registry.ts`, gate PROTECT-NO-STOCKS), and no line exceeds the exit cap Bearing measured (gate EXIT-SOURCE, through the `LiquidityProvider` in `ComposeContext`). Everything else in `PERSONAL_PARAMS` applies only when a shape below switches it on.

## 3. Shapes, switched on by the person's words

| Shape | Trigger | What happens after the model |
|---|---|---|
| `pick` | the default: named people, companies, themes, tickers | equal split, or the stated weights; exit cap trims; no sleeves, no floors |
| `grow` | "grow", "make it grow", "long term", "for my kids", and their Portuguese cousins | the existing `compose` runs with a `PersonalSheet` for `grow`; missing fields take the defaults of `PERSONAL_PARAMS` and are said as assumptions in the read-back (risk medium, no date set) |
| `income` | "live off it", "monthly income", "renda", "receber todo mês" | same, for `income` |
| `protect` | "keep it safe", "não quero perder", "proteger" | same, for `protect` |
| `split` | "part safe, part risky", "two pots", "metade", a stated share | each bucket is its own shape and its own vault; shares as stated, else equal |

A `pick` that also names a shape word ("Elon, but mostly safe") is a `split`: the picks in one bucket, the shape in the other.

## 4. The model's text (the relaxed prompt)

System prompt, with `{SHELF}` the compact shelf of section 5 and `{TODAY}` the day:

```
You help a person turn what they want into a list of holdings from one table. You see the whole table below.

Read what the person wrote. Work out what they mean, including people, companies, themes and nicknames. A person named means the companies they are known for. A theme means the holdings on the table that belong to it.

Then write one JSON object:
  understood: one sentence in the person's language saying what you understood.
  shape: "pick" unless the words call for another: "grow" when they want the money to grow over time, "income" when they want to live off it or want monthly money, "protect" when they want to keep it safe, "split" when they want part safe and part risky or state two shares.
  lines: holdings from the table, each {id, why}. Only ids that appear in the table. If a thing they named is not on the table, do not pick a stand-in; put it in not_available with one line on why.
  buckets: only for "split": each {name, share, lines}. Shares as stated, else equal.
  stated: only what the person actually said, in their own numbers: amount, currency, preferred weights, horizon, risk words. Leave out anything they did not say.
  not_available: names you understood but could not place on the table.
  question: at most one, only when you cannot pick without it. Prefer an assumption you state in `understood` over a question.

Rules:
- Never state a yield, price, return or any figure that is not on the table row you are quoting.
- Never choose weights. Equal split is applied after you, unless `stated` holds a preference.
- Answer in the person's language. Keep `understood` to one sentence.
- Output only the JSON.

Today is {TODAY}.

TABLE
{SHELF}
```

Temperature 0. Output token budget 1,200. The person's text bounded as today (`GOAL_TEXT` in `apps/api/src/routes/v1/intake.ts`). Model and endpoint through the existing env (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in `packages/engine/src/parser/llm.ts`): start with the cheapest model that passes the eval set of section 7, move up one only if it misses.

## 5. The tables the model reads, and the tables that bind it

**Handed to the model, compacted to one line per row (id, symbol, company or issuer, class, chain, sector/industry/keywords for a stock, theme slugs it belongs to):**

| Table | Where | What is in it |
|---|---|---|
| Stock attributes, Robinhood Chain | `content/stocks/robinhood.json` (42 rows) | `symbol`, `underlying`, `kind`, `company`, `headquarters`, `sector`, `industry`, `subIndustry`, `keywords`, `tracks`, `sets`, `sources`. Schema `packages/engine/src/personal/stock-attributes.ts` |
| Stock attributes, Solana | `content/stocks/solana.json` (19 rows) | same shape |
| Themes (labels), per chain | `content/themes/{robinhood,solana}/*.json` (17 each: ai, big-tech, space, defense, semiconductors, …) | `slug`, `name.en/pt`, `members[{symbol, reason.en/pt}]`, `status: confirmed`, gate LABELS-CONFIRMED |
| Yield shelf, per chain | `packages/engine/src/personal/fixtures/shelves/{robinhood,solana}-yield.json` (5 and 19 rows, `provenance: fixture`) and the live `Shelf` the API assembles for the person's chain (see how `apps/api/src/routes/v1/intake.ts` builds `ComposeContext`) | `asset.{id, chain, address, symbol, cls, underlying, issuer, tier, maxWeightBps}` and the observed yield row with `source`, `fetched_at`, `method` |
| Asset shape | `packages/schemas/src/basket-asset.ts`, `packages/schemas/src/asset.ts` | `BasketAsset`, `AssetClass` (`stock`, `etf`, `crypto`, `gold`, `commodity`, `dollar_yield`, `cash`) |

The model sees one chain only: the chain of the person's wallet (`personChain` in `apps/api/src/orders/person.ts`; gate ONE-CHAIN).

**Never handed to the model; applied after it:**

| Table | Where | What binds |
|---|---|---|
| Parameter table | `packages/engine/src/personal/params.ts`, `PERSONAL_PARAMS` | sleeves by goal and risk, `glideFloor`, `cashFloor`, `capPerStockBps`, `capPerIssuerBps`, `shareOfDepth`, `tau`, `tierCeilingUsd`, `minLineBps`, `minLineUsd`, `maxLinesPerChain`. Used only by the `grow`, `income`, `protect` shapes |
| Intake bounds | same file, `INTAKE_LIMITS`, `STOCK_KEYWORDS` | reply and text lengths, turns read |
| Eligibility | `packages/engine/src/personal/registry.ts`, `packages/engine/src/assets/eligibility.ts` | no stock tokens in `income` or `protect` |
| Exit caps | `LiquidityProvider` on `ComposeContext` (`packages/engine/src/personal/types.ts`), Bearing's measured numbers | the most of one token a plan may hold; tier ceiling as the labelled fallback |
| The words the UI says | `apps/web/components/ui/labels.ts`; `packages/engine/src/personal/templates.ts` (`READBACK_TEMPLATES`, `QUESTION_TEMPLATES`, `WORDS`) | reuse the labels; the read-back sentence itself is the model's |
| Disclaimer | `DISCLAIMER` in `packages/schemas` | on the plan view, as today |

## 6. What to build

Worktree `~/Documents/Colosseum-relaxed`, branch `engine/relaxed-intake` cut from `tools/try-plans` (gate TUNE-ON-TRY: that is the integrated branch Rodrigo tests on). Stacked pull request, draft, into `tools/try-plans`.

1. `packages/engine/src/personal/relaxed/` (imports `schemas`, the shelf types and `PERSONAL_PARAMS`; nothing from `intake*.ts`):
   - `shelf-text.ts`: the compact one-line-per-row table of section 5 from a `Shelf`, the stock attributes and the theme lists of one chain. Deterministic, sorted by id, with a hash.
   - `reply.ts`: the zod schema of the model's JSON (`RelaxedReply`), with the id check against the shelf, the one retry on unknown ids, and the trim to `not_available`.
   - `shape.ts`: `pick` → equal or stated weights, exit cap, `PersonalProposal` shape; `grow|income|protect` → a `PersonalSheet` from `stated` plus defaults, then the existing `compose`; `split` → one proposal per bucket. The assumptions made are returned as a list for the read-back.
   - `index.ts`: `runRelaxed(text, shelfBundle, model, deps) → { reply, proposals, assumptions, readBack }`.
2. `apps/api/src/routes/v1/intake-relaxed.ts`: `POST /v1/intake/relaxed` with the same request shape as `/v1/intake` and the same deps; answers `{ understood, shape, lines|buckets, not_available, assumptions, question?, readBack, provenance }`. The confirm goes to `POST /v1/baskets/personalize` exactly as today, one call per bucket for `split`. Behind a flag `RELAXED_INTAKE=1`; off, the route is not registered.
3. The web: a switch on the goal screen, visible only with the flag, that sends to the relaxed route and shows the read-back as one paragraph with a yes button and a text box. Reuse the composer and sheet labels. Follow `.design/branding/working-brand/patterns/STYLE.md`.
4. `tests/try-plans.test.ts` gets a `relaxed` mode, so Rodrigo can type a goal and see the reply, the lines and the read-back without the web.

## 7. The eval set and the finish line

`packages/engine/src/personal/fixtures/relaxed-eval.json`: 24 utterances with the expected `shape`, the ids that must be among `lines`, the names that must be in `not_available`, and whether a `question` is allowed. The set is the finish line: tuning stops the day it passes. Start with these, in English and Portuguese:

- "I want to invest in Elon" → pick; TSLA in lines; SpaceX in `not_available` if not on the chain's shelf (it is, as SPCX, on Robinhood Chain: then both); no question.
- "Nvidia and gold" → pick; NVDA and the gold token; no question.
- "the chip makers" → pick; the members of `semiconductors`; no question.
- "I have 10k, grow it for my kids" → grow; `stated.amount` 10000; no question; assumptions say risk and date.
- "metade em algo seguro, metade em Tesla" → split; two buckets, 50/50; TSLA in one; the other `protect`.
- "quero viver de renda" → income; no stock tokens.
- "put it all in SpaceX" on Solana → pick; SpaceX in `not_available`; `lines` empty; a question is allowed.
- "something safe" → protect; no question.

Tests, all offline, with the model's replies recorded in `fixtures/relaxed-replies.json` the way `intake-replies.json` does it: the id check drops unknown ids; equal split sums to 10,000 bps to the unit; stated weights are followed; the exit cap trims and says so; no numeric yield literal outside `fixtures/` (the existing build test); `protect` and `income` hold no stock tokens; `split` gives two proposals; the compact shelf text is deterministic. One live test, skipped without `LLM_MODEL`, runs the eval set against the configured model and prints a table of passes.

Done when: `pnpm verify` passes; the eval set passes on the recorded replies and, once, live; the ledger row RELAXED-1 in `docs/vault/STATE-VAULT.md` has the command, the result and the pull request; `/review-pr` by an agent that wrote none of it.

## 8. What is Rodrigo's, not the session's

- The decision. This builds an experiment beside the guided intake. Adopting it, and retiring the two-reader rule of DESIGN-VAULT section 7, is a founders' decision recorded with `/decide` (`RELAXED-INTAKE`) and needs Thom's word, since it changes a design rule and the intake code he reviews.
- The model and the endpoint (`.env`; never read it).
- Any mainnet transaction.

## 9. Rules of the session

One worktree, at most two implementation agents, never two `pnpm verify` at once; cut from `tools/try-plans`, push the branch, open a draft pull request into `tools/try-plans`; no push to `staging` or `main`, no merge, no `.env`, no `secrets/`. Commits prefixed `RELAXED-1:`; no Co-Authored-By line. Prior-work reuse (the shelf loading, the compose call, the personalize confirm) is reuse of this repo, not of prior work, and needs no `prior:` commit. Document what you leave out and why in the pull request and the ledger row.
