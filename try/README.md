# The plan playground

Write goals the way a person would, in a file. One command shows how the engine reads them and what
plans it builds, in an HTML page that opens in your browser. It is a developer tool for local use. It
does not give advice, and nothing it shows is live unless the page says so.

```sh
pnpm plan:try try/prompts/examples.md
pnpm plan:try try/mine/my-goals.md --data db
pnpm plan:try try/mine/my-goals.md --now 2026-10-06T12:00:00Z --no-open
```

The page goes to `try/out/<file>-<time>.html`, and the terminal prints one line per goal. Put your own
files in `try/mine/`: that folder and `try/out/` are not committed.

With `--json` the command prints one JSON document to stdout instead (`scripts/try/json.ts`): per goal
the reader, what was read, the flags and disagreements, the open questions with their answer keys, text
and options, the read-back, each candidate shown (lines with symbol, share, dollars and reasons; the
scorecard, the status, the income verdict and its ways), the candidates not shown with why, the plates
and the disclaimer. No page is written and nothing opens.

## Chat with it

A Claude Code session can play the product: it asks for your goal, reads it as the API's reader does
(the `SYSTEM` instructions in `apps/api/src/llm.ts`), asks the tool's questions, reads back the sheet for
you to confirm, and then shows the engine's candidates, none ranked, every figure from the tool and
plated MOCK. Start it in this checkout with the model you choose, then type `/plan-chat`:

```sh
cd ~/Documents/Colosseum-try
claude --model sonnet
> /plan-chat
```

Each chat writes its own file, `try/mine/chat-<time>.md`: your messages about a goal are its text, one
paragraph each, read again together on every turn as the API reads `followUps`, with the session's
reading pasted as a `json reply` block, so earlier chats stay and can be rerun. The chat speaks to you,
not in the engine's words: rule ids, flags and the reasons as written stay in the HTML report, and the
session gives its path when you ask for detail. Ask
for changes as you go ("make it 20 years", "add 50% AI", "I already hold $3k of NVDA"): the session
writes them as answers, runs again and says what changed. The skill is
`.claude/skills/plan-chat/SKILL.md`.

## Writing a goal

One goal per `## heading`. Under the heading, write the goal exactly as a person would type it, in
English or Portuguese. Anything before the first `##` is notes and is not read, and neither are HTML
comments (`<!-- ... -->`).

````markdown
## Income for my parents

chain: solana

I have $50,000 and want about $300 a month for my parents, careful with risk. I live in Brazil.

```yaml answers
goal: income
amount: 50000
income: 300
horizon: 5y
risk: low
withdrawals: { monthly: 300, from: 2026-11, months: 24 }
```
````

- `chain:` is optional and names the chain of the wallet: `solana` (the default), `base` or `robinhood`.
  A plan lives on that one chain.
- The `yaml answers` block is optional. It holds the person's answers to the intake's questions. The
  goal text is read first; the answers are then applied the same way the API's intake route applies
  them (`runIntake` with `answers`).

## Answering questions

Run the file first with no answers. Each goal shows the questions left open, each with the exact key to
add under `answers`, and a block you can copy. Add the answers and run it again.

| Key | What it is |
| --- | --- |
| `goal` | `grow`, `income` or `protect` |
| `amount` | the dollars put in |
| `income` | for an income goal, the dollars a month |
| `horizon` | the time frame: `10y`, `18m`, `2 anos`, or a number of months |
| `risk` | `low`, `medium` or `high` |
| `country` | accepted and ignored: a plan reads no country (gate `COUNTRY-REMOVED`, Oct 6) |
| `currency` | the goal's currency when not dollars (`BRL`) |
| `language` | `en` or `pt`, when the text does not settle it |
| `themes` | shared portfolios to start from, by slug: `[the-seven]` |
| `chain` | the same as the `chain:` line |
| `withdrawals` | a monthly amount over a run of months: `{ monthly: 300, from: 2026-11, months: 24, currency: BRL }` (one, or a list) |
| `obligations` | dated withdrawals one by one: `- { month: 2030-02, amount: 20000, currency: BRL }` |
| `sleeves` | the split of the plan in percent: `{ goal: 50, ai: 50 }`. `goal` and `safe_yield` are sleeves; any other name is a theme list in `content/themes/<chain>/` |
| `restoreSplit` | `true` to bring the sleeves back to their split when they drift |
| `limits` | the person's limits: `mustKeepUsd`, `mayNeedInMonths`, `creditTolerance` (`none`, `limited`, `accept`), `cannotHold: { classes: [stock, etf], underlyings: [TSLA] }` |
| `rules` | `{ useHoldings: true, glide: true }`. Holdings count unless said; the glide is off unless the text asks for it or names a date the money is needed by (gate `GLIDE-OPT-IN`) |
| `horizonOpen` | `true` for a goal with no date (the text's "no hard cap" or "sem prazo" does the same) |
| `holdings` | what the person already holds, in dollars: `{ NVDA: 2000, "solana:spyx": 500 }` |

A mistake in the file (an unknown key, a value the sheet does not accept, YAML that does not parse) stops
the run before anything is computed, and every problem is printed with its line.

## The model, on or off

With `ANTHROPIC_API_KEY` set in the shell that runs the command, the model reads each goal, as the API's
intake does. Without it, the rules parser reads it. The page says which read each goal, and why the model
did not. The command never reads `.env` and never prints the key: export it in your shell if you want
the model.

With the rules parser, the goal, the time frame and the risk it reads are always asked once, and it
reads no refusals ("no stocks" goes under `limits`). The examples answer those, so they run either way.

## The two data modes

- `--data fixtures` (the default): the engine's own test data. The launch shelf, the yields and exit
  capacities written by hand for the tests, and one rate of dollars into reais. Every figure is
  plated **MOCK** on the page.
- `--data db`: your local database (`pnpm db:up`), read the way the API reads it: the mock chain's tokens,
  the shared portfolios in effect, Bearing's measured exit and the stored yields
  (`bearingPlanInputs`). Each figure keeps its own provenance. The database comes from `DATABASE_URL` in
  the environment, else the local default. This mode reads no exchange rate, as the API reads none
  yet, so a withdrawal in reais has no plan here.

Theme lists come from `content/themes/<chain>/` in both modes.

## What MOCK means

A figure plated **MOCK** is not a reading of any market: it was written by hand or comes from a mock
chain. **MOCK · test network** is a figure from a test network. Neither is ever shown as live. In db mode a
live figure is marked `live`.

## What the page shows, for each goal

The goal text; what was read and by which reader; the questions left open and the intake's flags; the
read-back the person would confirm; then the candidates in their fixed order (Cover, Spread, Carry), none
marked: each line with its token, weight, dollars and every reason sentence; for an income goal, the
Income block (the target a month, what the plan pays a month at the yields observed after haircut, met
or short, the gap, the ways to reach it, and the sentence when no larger amount closes it); the
scorecard, the status with months paid, the stresses and the ways to close a gap, the flags, and the
figures with their provenance. Candidates not shown are listed with why. The plain plan (`compose`) is
the same as Carry unless the page says otherwise; its Income block is shown either way. For an income
goal the terminal line adds the verdict: "income short by $396.50/month of $500.00, no larger amount
closes it".

The page uses the time from `--now`, or the clock: the same file and `--now` give the same page.

The code is in `scripts/try/`; the tests are in `tests/try-plans.test.ts`.

## Reading the goal with a model in a chat

You can let a model in a chat (Claude Code, with any model you pick, say Sonnet or Haiku) read a goal, and run what it read through the engine here. The model gets the same instructions as the API's reader (`SYSTEM` in `apps/api/src/llm.ts`) and answers in the same JSON shape. Paste its answer under the goal in a block named `json reply <who>`:

````
## Grow for ten years
I have $20,000 and want it to grow over 10 years, medium risk. I live in Brazil.
```json reply sonnet
{"goal":"grow","risk":"medium","amountUsd":20000,"incomeTargetUsdMonthly":null,"horizonMonths":120,
 "currency":null,"chain":null,"portfolios":[],"noCredit":false,"cannotHold":[],
 "language":"en","unclear":[]}
```
````

The reply goes through the same checks as one from the API (every amount and date must be in the text, every field the text gives no cue for is asked), so a model that guesses is caught here as it would be live. The report names who wrote it and labels it mock: it was not read through the API. A goal with a pasted reply does not call the API, with or without `ANTHROPIC_API_KEY`.
