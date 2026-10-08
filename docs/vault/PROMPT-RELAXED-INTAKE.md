# Relaxed terminal intake experiment

Updated Oct 8 after the PR #182 audit and its merge into staging (`fcba147f`). This repair preserves Rodrigo’s per-entry recording provenance, explicit split-pot intent, chain allowlist, readiness display and chip-maker fixture correction. It validates stated shares rather than scaling them silently. This document describes the bounded terminal experiment in `scripts/relaxed/`, not a new product intake direction. The current production model-led vault conversation continues under `MODEL-LED-VAULT-CONVERSATION` in `docs/GATES.md`; the terminal experiment does not replace its preview, confirmation, sourced evidence or shared API quota.

The earlier build brief proposed an engine module, a flagged API route, a web switch and deterministic compose after confirmation. Those are not implemented here and are not acceptance criteria for this repair. No new API, shared schema, migration, order, funding, publishing or execution integration is added. Adopting another intake path remains a founders' decision.

The useful part of the experiment is a natural conversation about named assets, companies and themes on a compact table. Admiration alone (such as “I like Elon”) must lead to clarification, with no allocation inferred. An explicit investment instruction can select named holdings without a generic risk questionnaire.

## Running it

Use Node 22 and the repository's pinned dependencies. Offline examples:

```sh
pnpm exec tsx scripts/relaxed/intake.ts --recorded "I want to invest in Elon"
pnpm exec tsx scripts/relaxed/intake.ts --chain robinhood --recorded "metade em algo seguro, metade em Tesla"
```

The six committed replies in `scripts/relaxed/recorded.json` are hand-written samples, labeled `mock`. They are not a live model evaluation. Their IDs now match the fixture catalog and their split pots explicitly carry goals. They still lack complete grounded money terms and therefore cannot be acknowledged as complete proposals.

Importing `intake.ts` or `core.ts` has no file reads, environment access, provider calls or CLI execution. CLI flags are parsed before credential handling. No `.env` or secret file is loaded, including from another checkout. `--recorded` ignores provider credentials. Live mode requires `ANTHROPIC_API_KEY` and `RELAXED_MODEL` explicitly supplied in the shell; this repair neither selected nor tested a deployed model. Without a key, a non-chat run uses the matching recording.

`--chat` keeps history in the process. Each person message is bounded to 2,000 characters, with at most 12 person turns/provider calls, 1,200 output tokens per call, a 16,000-character reply bound and a 20-second request timeout. The first message and every follow-up count. This is a standalone CLI budget; it does not invoke the production API and has no per-person daily quota. Any future production integration must use the existing shared quota, authorization and confirmation contracts.

`--record` explicitly writes the first validated live reply under its full synthetic person-text key. Use synthetic test inputs only. Each captured entry carries its own `live-recorded` provenance; untouched hand-written replies retain `mock` provenance. Do not use repository recording for private production conversation text.

## Shelf and validation

`loadShelf` reads only the selected chain's static launch seed and yield fixture, enriching listed assets with sourced stock attributes and confirmed theme labels. Attributes describe an asset; they do not make it available. IDs use the current fixture catalog contract (for example `robinhood:tsla`, `solana:tslax`, `robinhood:steakusdg`), not a case-preserving symbol concatenation. Yield rows use their actual `asset.id`. Rows with `heldOut` or `verdict: hold` are omitted.

Every row and proposal says `fixture`; a live model response does not make the shelf live. Wallet ownership, country restrictions, adapter listings, routes, prices, FX and measured exit capacity are not verified. The shelf carries those limitations into the prompt and read-back. Unknown and ineligible holdings prevent acknowledgment, and removing a line never increases surviving requested weights. No alternative asset is inserted.

`core.ts` exports the reply schema and pure shelf, allocation, renderer, formatting, acknowledgment and bound helpers. The structured provider output uses a separate closed schema with required nullable fields; the local parser also accepts legacy mock replies. Tests cover those local contracts; a live provider evaluation has not been performed.

A direct proposal has one of `pick`, `grow`, `income`, `protect` or `discussion`; a `split` has explicit `pick`, `grow`, `income` or `protect` goals on every pot. Pot names alone cannot establish a goal. Eligibility calls the existing registry's `eligibleForGoal`: income holds dollar yield/cash, protect holds dollar yield/gold/cash. Missing pot goals keep holdings unresolved. Empty, duplicate and oversized allocations cannot be acknowledged.

Equal holding weights are applied only where no unresolved preference is stated, with deterministic integer basis points summing to 10,000. Exact percentages for every holding are supported in the person's text and retained exactly; offline numeric maps are basis points and must match those percentages. The latest matching person preference is used. Unsupported floors, ranges, partial allocations, qualitative preferences and ambiguous within-pot weights remain unresolved. Missing model preferences cannot silently become an equal allocation. Catalog cap conflicts retain the requested weights and prevent acknowledgment; there is no automatic trim or redistribution. The existing parameter table supplies the maximum lines per pot. No measured exit cap is claimed.

Pot shares must be explicit positive integer basis points totaling 10,000; they are never normalized or rounded into a different request. Numeric shares must match named pots in the person's percentage text. “Half/metade” is supported for equal pots, without treating unrelated numbers such as age or budget as percentages. Later conflicting or ambiguous instructions prevent acknowledgment.

Money terms come from person messages, never assistant history: the budget amount and currency must be grounded together and survive later corrections. USD is the only supported proposal currency; another currency remains explicit and unresolved because no conversion is wired. A date/horizon must quote actual date/horizon words rather than reuse a budget number. An income target must match the person's monthly amount, and an explicit monthly currency must match the budget currency; there is no FX conversion between them. Complex or ambiguous terms remain unresolved. The CLI does not impose a risk question for an explicit stock selection.

No numerical financial observations are supplied to this CLI. Numeric yield, return, price, FX, exit-cost, fee, volatility or liquidity claims are rejected before display, even if the same number appears in the person's budget or counts. Numeric prose is limited to grounded person figures; percentage notation must also be grounded. Unavailable reasons use code-owned wording that makes live availability unverified, rather than model-invented country or route restrictions. This is a conservative bounded check, not a production financial evidence validator.

## Read-back and acknowledgment

Display and the yes guard share the same independently validated `ready` result. Missing amount/currency, shape-specific date/monthly terms, allocation defects and model-reported open fields appear as unresolved. A bare yes does not become another investment instruction while terms are missing.

A complete proposal can be acknowledged locally. The printed JSON is labeled `kind: relaxed-terminal-proposal`, `executable: false`, and carries chain, catalog hash, fixture/model provenance, exact weights, stated terms, warnings and readiness. It is explicitly **not** a payload for `POST /v1/baskets/personalize`, whose current contract requires a `{ sheet: PersonalSheet }` envelope and server dependencies. No HTTP request is sent, no solver is promised after yes and no order is created.

## Verification

`tests/relaxed-intake.test.ts` runs in the ordinary repository Vitest suite. It covers all twelve synthetic audit reproductions and all six committed mock replies, plus bounds, import safety, source/provenance checks, registry eligibility, exact weights and integer totals, corrections, unsupported preferences, readiness and acknowledgment.

Focused check, with Node 22 and already pinned dependencies:

```sh
pnpm exec vitest run tests/relaxed-intake.test.ts
pnpm exec biome check scripts/relaxed tests/relaxed-intake.test.ts
pnpm exec tsc -p tsconfig.json --pretty false
```

The existing `RELAXED-1` row in `STATE-VAULT.md` records results and independent review. No live model, database, chain, worker, deployment or external message is part of these checks. The full integrated gate and CI remain the repository's normal completion requirements.
