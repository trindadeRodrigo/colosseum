# Personalization engine: design v2 note

Oct 1, 2026. Stream: turning a sentence or a form into a personal basket. Tags: `[n]` checked today against source n; `[repo]` read in `risk-layer`; `[audit]` from the audit reviewers' notes (outside this repo; summary in `docs/AUDIT-VAULT.md`); `[proto]` run today in `docs/research/design-v2/personalization-proto/`; `[memory]` not checked.

## 1. Bottom line

- Add a `basket/` module beside Rodrigo's solver. Do not edit `solve()`, his parser, his registry or `ConstraintSheet`. His code changes by two export lines, and his baseline snapshot test stays green `[repo]`.
- The engine has three pure steps. **Exposure**: how big each sleeve is (stocks and crypto, dollar yield, gold) and what is inside it. **Placement**: which chain's token carries each exposure. **Packaging**: one recipe per chain in basis points, a reason on every line, the five-field card.
- A prototype over the launch shelf passes the brief's test 3: three people, three baskets, and each of the seven inputs alone moves the basket and adds a reason that names that input `[proto]`. Every number in it is a placeholder for Rodrigo.
- The model fills a form and nothing else. Use Claude Haiku 4.5 on Anthropic's own Messages API with structured outputs, about a fifth of a cent per sentence `[2][3]`. Rodrigo's parser speaks the OpenAI format, and Anthropic's OpenAI-compatible endpoint ignores `response_format` `[1]`.
- The risk layer's exit capacity becomes a dollar ceiling per token. It covers only Solana stock tokens today `[audit]`; other lines use the shelf's measured tier.

## 2. What to use for the MVP

**Versions.** zod 4.6.5 (in repo, latest) `[4]`. `@anthropic-ai/sdk` 0.131.0, peer zod ^4 `[4]`, added to `apps/api` only. No new dependency in `packages/engine`. No linear program: the audit found his LP never beats a greedy fill `[audit]`.

**Where files go.**

```
packages/schemas/src/basket-sheet.ts   BasketSheet, BasketSheetDraft
packages/schemas/src/basket.ts         Reason, BasketLine, BasketCard, Verdict, BasketProposal
packages/engine/src/basket/            params, sleeves, exposure, placement, package, card, reasons, index
packages/engine/src/parser/basket-rules.ts, basket-prompt.ts   (pure: regex parse, prompt, draft checks)
apps/api/src/llm.ts                    the network call, as apps/api/src/liquidity.ts wires the risk layer
apps/api/src/routes/baskets.ts         POST /baskets/parse, POST /baskets/personalize
fixtures/basket/                       shelf.json, yields.json, profiles.json, goals-eval.json, llm-recorded/
tests/basket-*.test.ts
```

Reused: `applyHaircut`, `YieldObservation`, `LiquidityProvider`, `ParseOutcome`, `Language`, `computeDrift`. Not reused: `solve`, `buildSchedule`, `REGISTRY`, `Profile`, `Chain`, all tied to reais and eight Solana assets `[repo]`.

**Interfaces to freeze on day 1.**

```ts
const BasketSheet = z.object({
  basketType: z.literal('standard'),
  goal: z.enum(['grow', 'income', 'protect']),
  amountUsd: z.number().min(10).max(1_000_000),
  horizonMonths: z.number().int().min(1).max(480),
  risk: z.enum(['low', 'medium', 'high']),
  themes: z.array(z.string()).max(3),            // index family slugs
  country: z.string().regex(/^[A-Z]{2}$/),       // self-declared
  chains: z.array(ChainId).min(1),               // in the person's order of preference
  incomeTargetUsdMonthly: z.number().positive().optional(),
  rules: z.object({ useHoldings: z.boolean(), glide: z.boolean() }),
  language: Language,
});

type Reason = { rule: RuleId; inputs: InputName[]; params: Record<string, string | number>; text: string };
type BasketLine = { chain: ChainId; assetId: string; viaIndex?: string; weightBps: number; amountUsd: number; reasons: Reason[] };
type BasketProposal = {
  sheet: BasketSheet; engineVersion: string; paramsHash: string; shelfVersion: string; inputsHash: string;
  lines: BasketLine[];                                                // sum to 10_000
  recipes: { chain: ChainId; amountUsd: number; components: Component[] }[];  // each sums to 10_000
  removed: { ref: string; reasons: Reason[] }[];
  card: BasketCard; verdict?: Verdict; flags: string[]; observations: ObservationRef[]; disclaimer: string;
};
function compose(i: { sheet; holdings; shelf; yields; liquidity?: LiquidityProvider; params; now: string }): BasketProposal;
```

`compose` takes the clock, the shelf and the parameter table as arguments and does no I/O `[audit]`. Shelf assets need `id`, `chain`, `address`, `cls`, `underlying` (NVDA for NVDAx, NVDAc and NVDA), `issuer`, `tier`, `blockedCountries`.

**How each input changes the result.**

| Input | Rule | Reason shown |
|---|---|---|
| Goal, risk | A table gives the three sleeve sizes | "70% dollar yield: income goal, medium risk" |
| Time frame | A floor on dollar yield that rises as the date nears; the card lists the next step | "40% dollar yield: you need this in 18 months" |
| Themes | Decide what is inside each sleeve. An index made only of stocks stays an index component, so it can auto-follow | "From Sand to Server" |
| Holdings | Target is set on amount plus holdings, then what is held is subtracted. An index that overlaps is opened into its assets | "No NVDA: you already hold $4,000" |
| Risk | Cap per single stock and per issuer | "Split over two issuers: 70% cap" |
| Amount | Dollar ceiling per token; overflow goes to the same asset on another chain, then to dollar yield | "Gold on Solana limited to $10,000" |
| Country | Tokens blocked there are skipped; the same exposure is taken on another chain if one exists | "On Robinhood Chain: the Solana token is not offered in X" |

An index can be split across its family's recipes on two chains. If no chain can take it whole, or a per-asset rule fires, it is opened into assets and the line says it will no longer auto-follow `[proto]`. What no token can take stays in that chain's cash token, as a line with a reason.

**Exit capacity.** Ceiling per token = min(shelf tier ceiling, `shareOfDepth` × `exitCapacity(asset, tau)`), with his 0.25 and 1% `[repo]`. An index takes what its thinnest component allows. The card's fifth field sums `exitCost` at each line's size and states the share of the basket that is measured. `loadLiquidityProvider` already maps any asset list by mint `[repo]`.

**The card.** Money needed today (total, per chain, entry cost). Expected return (yield range from haircut to quoted rate on the dollar-yield share, each with its observation; stocks and gold assume no return, as his haircut rule says, plus the dollar loss in a 20% fall). Total term (months and the next glide step). Cash-flow pattern (`none`, `accrues_in_price` or `monthly_estimate`). When you can get out (tokens withdrawable any time; sell cost in the worst measured hour). Income goals add a verdict with the gap and each way to close it, found by re-running the engine `[proto]`.

**The model.**

- `claude-haiku-4-5`, $1 in and $5 out per million tokens `[3]`. Sonnet 5.5 ($2/$10) only if the eval fails. About 900 tokens in and 250 out, so roughly $0.002 a parse and $10 for 4,500.
- Native call with a schema the API enforces `[2]`:

```ts
const r = await client.messages.parse({ model: 'claude-haiku-4-5', max_tokens: 1024, temperature: 0,
  system: PROMPT, messages: [{ role: 'user', content: text }],
  output_config: { format: zodOutputFormat(BasketSheetDraft) } }, { timeout: 6000, maxRetries: 1 });
if (r.stop_reason !== 'end_turn' || !r.parsed_output) return rulesOutcome;
```

- `BasketSheetDraft` has every field nullable. The model returns null for what the sentence does not say. The API cannot enforce number ranges; the SDK checks them client-side `[2]`.
- Checks after the model, in pure code: amount and time frame must appear in the text; themes must be slugs from the platform shelf; any disagreement with the regex parser is flagged per field. These answer the audit's findings that the model's output is trusted once it fits the schema and that wrong amounts pass silently.
- Only the team's launch indexes are named in the prompt. Community index names are other people's text and never reach the model.
- Per IP limit, a cache keyed by text hash, a spend limit on the API key.
- Explanation text comes from one template per rule, in English and Portuguese. Lines appear on public pages, so they are not model-written.

**Fallback form.** The form is the sheet editor and is always the confirm step. Model down: the regex parser pre-fills it. That fails: it opens with defaults. Same schema, same `compose`.

**Software, not advice.** The person sets every input, can switch off the holdings and glide rules, can edit any weight, and signs every trade. The rules and parameter table are published with a version; the same inputs give anyone the same basket (`inputsHash`). No rule looks at fees. Risk comfort is labelled as cap levels, not as a profile of the person. A test bans "recommend", "suitable" and "best for you" in templates. A new disclaimer constant is needed: his says a distributor holds the client relationship `[repo]`. This is positioning only. Our research says a basket built from a person's circumstances is advice in the EU, the US and Brazil whatever the wording.

## 3. What to skip or defer

- Model-written explanations or summaries. Templates are enough and cannot invent a number.
- A historical or forecast return for stocks. It needs a sourced dataset and Rodrigo's sign-off.
- The month-by-month schedule and stress tables. They are in reais; the card needs one yield range and one stress.
- Weighing holdings by asset class. Per-asset overlap is enough for the demo.
- An optimizer, correlations or volatility targets. No free data feeds them.
- Prompt caching. Haiku 4.5 needs a 4,096-token prefix `[memory, SDK notes]`; ours is under 1,000.
- Changing his `Chain` enum. It is pinned to a Postgres enum that cannot drop values `[audit]`.

## 4. Seams for the roadmap

- Community features: `themes` are family slugs, so rankings only change what the form offers.
- Creator fees: the card's money field is a list of cost lines; a fee is one more. The engine never ranks by fee.
- CCIP sync: the engine names an index by family slug and chain, never by an onchain id.
- More chains: placement reads chains and issuers from shelf rows; no chain name in engine code.
- Protected basket: `basketType` on sheet and proposal; `sleeves()` is chosen by type; the card gains an optional floor.
- Rebalancing on drift: lines are targets in basis points; `computeDrift` takes them as is.
- Paid price feeds: `observations` carry source and method, so a new feed is a new method string.
- Agent-run indexes: add `creatorKind` to shelf indexes now; a later sheet flag filters on it.
- Pooled token: placement handles units of kind `index` or `underlying`; `pool` is a third kind.
- Embeds: `params` is an argument, so a partner passes its own table and disclaimer.
- Audits: `engineVersion`, `paramsHash` and `inputsHash` on every proposal.

## 5. Risks and the test that settles each

| Risk | Test before Oct 9 |
|---|---|
| Three baskets look alike with real numbers | `tests/basket-three-profiles.test.ts`: pairwise distance of at least 3,000 bps by asset, three different cash-flow kinds, a reason on every line. Each input alone must move weights and change a reason whose `inputs` names it. Passes in the prototype; rerun with Rodrigo's table by Oct 3 |
| Ties or asset order change the result `[audit]` | Shuffle the shelf 100 times: identical output |
| The parser turns "no stocks" into high risk `[audit]` | 40-goal fixture in two languages with negation, two amounts and dates, run against recorded Haiku replies in CI and once live. Pass: no wrong amount, time frame or risk goes unflagged |
| Thin weekend data zeroes a stock's capacity `[audit]` | After Oct 3–4, compose with the live provider: no line dropped for too few samples |
| Risk data covers only Solana stock tokens `[audit]` | Card test: the unmeasured share is stated, never shown as zero cost |
| Issuer cap below the stock sleeve forces a second chain | Solana-only medium profile returns a flag, not an error |
| No dollar-yield token on Base | Base-only protect profile returns a cash line with a reason |
| jlUSDC and SGOV have no yield feed; his feed map is fixed to three assets `[audit]` | Each shelf dollar-yield asset has an observation, or the line shows MOCK |
| Model cost or abuse | With the key's limit at one cent, `/baskets/parse` still answers from the regex parser in under a second |
| A model swap breaks the call: Sonnet 5.5 rejects `temperature` `[memory, SDK notes]` | One live call per model named in `.env.example` |

## 6. Questions only a person can answer

1. Rodrigo: the sleeve table, the glide floors and the caps are investment judgment. The prototype's numbers are mine. Will you set them by Oct 3?
2. Rodrigo: your rule keeps stock tokens out of income plans. Keep that for income baskets, or allow a stock sleeve that is never counted as income?
3. Rodrigo: for stocks and gold, stay with "no return assumed", or show a sourced historical range?
4. Thom: is about $10 of Anthropic credit inside "free tiers only"? If not, the choices are Gemini's free tier through his existing OpenAI-compatible path `[5]` (limits not verified), or regex and form only. Colosseum's resource list has no model credits `[6]`.
5. Both: who fills `blockedCountries` per asset, and from what source? Without it the country input only blocks the US.
6. Both: fewest chains (the prototype's default) or spread over three for the demo? The demo can get three chains through themes without changing the rule.

## 7. Sources

1. Anthropic, OpenAI SDK compatibility (`response_format` and `strict` ignored, no prompt caching, not for production): https://platform.claude.com/docs/en/api/openai-sdk
2. Anthropic, structured outputs (generally available, Haiku 4.5 listed, `output_config.format`, `zodOutputFormat`, limits, refusals): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
3. Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
4. npm registry, Oct 1: `@anthropic-ai/sdk` 0.131.0, `zod` 4.6.5, `javascript-lp-solver` 1.0.3: https://registry.npmjs.org/@anthropic-ai/sdk
5. Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
6. Colosseum resources index: https://ColosseumOrg.github.io/hackathon-resources/current.json
7. Local: `risk-layer/packages/engine/src/{solver,parser,assets,schedule,risk}`, `packages/schemas/src/{constraint-sheet,liquidity,plan}.ts`, `packages/risk/src/provider.ts`, `apps/api/src/liquidity.ts`, `tests/engine-baseline.test.ts`; `research/rodrigo-repo/audit-{engine-finance,parser-data,risk-layer}.md`; `docs/research/open-questions/launch-shelf.seed.json`; `docs/research/vaults/nesting-and-legal.md`; prototype in `docs/research/design-v2/personalization-proto/` (`node run.mjs`).
