# Constraint sheet (editable)
> Type: custom | Component: `<ConstraintSheet mode="edit" | "read">` | Replaces: the 11-field `field()` grid in GoalFlow and the raw `dl` in PlanView

The LLM reads a goal into a typed sheet, asking where the goal is unclear and saying back what it understood (gate `GUIDED-INTAKE`); it never decides the plan. The person sees exactly what was read, can change any field, and **the solver never runs on a sheet that failed zod validation**. This component is where that rule becomes visible.

## Anatomy (edit mode)

```
How we read your goal                                    parser: llm-v3 · 2026-10-01 14:02 UTC  ← h3 + source line (mono)
"R$ 5.000 por mês a partir de 2029, posso precisar em 7 dias"                                   ← the original goal, quoted, muted
┌ Errors summary (only when invalid) ─────────────────────────────────────────────┐
│ ◪ 2 things don't fit yet. Fix them to build the plan.                            │  role="alert", focus moves here
│   · Profile: a monthly income goal needs the income profile. [Go to field]        │
│   · Risk budget: a high-risk profile needs a medium or high risk budget.          │
└──────────────────────────────────────────────────────────────────────────────────┘
Goal ─────────────────────────────────────────────  ← group (fieldset) with hairline legend
  Kind [Monthly income ▾]   Amount (BRL) [5.000]   From [2029-01]   Until [—]
Profile and risk ─────────────────────────────────
  Profile [Income ▾]  Risk budget [Low ▾]  Credit [None ▾]  FX [Hedge near term ▾]
Time and cash ────────────────────────────────────
  Horizon (months) [36]  Cash within (days) [7]  Monthly contribution (BRL) [ ]
Notes [                                      ]
Language [Português ▾]
─────────────────────────────────────────────────
Capital (USD, from USDC/USDT in your wallet) [1.000]      [ Build my plan ]   ← primary, the one per view
```

- Wrapper: [card](./card.md) (`p-6`), fields grouped in `<fieldset>` with `<legend>` (Plex Sans 600 caption) and a 1px hair rule.
- Fields: [field.md](./field.md). Human labels and option names (`monthly_cashflow` → "Monthly income", `accept_fx` → "Accept FX risk"); the schema key is available in a `title`/dev tooltip only.
- Fields changed by the person vs the parser get the "edited" marker (6px primary square + "edited").
- Source line: `parser: {method} ({model}) · fetched_at` in Plex Mono muted. If the parser was a fixture or mock, the [MOCK plate](./mock-plate.md) appears here.

## Validation states

| State | What the person sees | Primary button |
|---|---|---|
| **Valid** | no summary; fields at rest | "Build my plan" enabled |
| **Invalid** (zod `issues`) | summary box at top: `--status-off-bg` fill, 1px `--destructive` border, notched-square glyph + "N things don't fit yet." Each issue = field label + a sentence saying what to change + "Go to field" link. Each field: `aria-invalid`, madder border, its sentence under it | `aria-disabled="true"`, label stays "Build my plan", hint: "Fix the 2 fields above to continue." Clicking it moves focus to the summary. **No request is sent to `/plans`** |
| **Server rejected** (API returns 400 with issues) | same as invalid, mapped from `issues[].path` | same; the server is the final gate, the UI is the first |
| **Parsing** | composer busy; sheet area shows the static lattice + "Reading your goal…" | hidden |
| **Solving** | sheet becomes read-only (`fieldset disabled` semantics with readable text), button busy "Building your plan…", `role="status"` | busy |
| **Solver error** (valid sheet, no feasible plan) | a card under the sheet: "No plan fits these limits." + which constraint binds + "Edit sheet". Not styled as a validation error | rest |

Error copy rules: say what to change, never blame, sentence case, no exclamation marks, no raw zod text ("Expected number, received nan" → "Enter an amount in reais."). Validation messages live in a copy dictionary keyed by `issues[].path` + `code`, in the sheet's `language`.

## Read mode (PlanView)

A `<dl>` grid of the same human labels and formatted values, no wells (read-only field style), with "Edit sheet" (secondary) that returns to GoalFlow with the sheet prefilled. A new solve creates a new plan; the old one is kept.

## Product rules surfaced here

- **xStocks never in income**: when Profile = Income, the sheet shows a caption under Profile: "Income plans don't include tokenized stocks." This is informational; enforcement is in the asset registry.
- No yield, price or APY appears on the sheet: it holds limits, not outcomes, so it carries no pins. If a future field shows a rate (e.g. an FX reference), it gets a pin.
- The disclaimer is not on the sheet; it's under the plan ([disclaimer-block](./disclaimer-block.md)).

## Accessibility (WCAG 2.2 AA)

- 3.3.1 / 3.3.3: errors identified in text, with suggestions. 3.3.4 not applicable (no transaction here); signing has its own confirm.
- On failed submit, focus moves to the summary (`tabIndex={-1}`); each item links to its field (`href="#field-id"`).
- 3.3.7 Redundant entry: the original goal text and all edits persist when going back.
- 2.4.6: fieldset legends group related controls. Target size ≥ 24px for selects (40px tall).

## Code hint

```tsx
const result = ConstraintSheet.safeParse(draft);
const issues = result.success ? [] : result.error.issues;
<Button variant="primary" aria-disabled={!result.success || busy}
  onClick={() => (result.success ? solve(result.data) : summaryRef.current?.focus())}>
  Build my plan
</Button>
```

`solve()` accepts only `ConstraintSheet` (the parsed type), so an unvalidated draft cannot reach it by type.

## Do / don't

| Do | Don't |
|---|---|
| Show the parser's reading and let every field be edited | Hide the sheet and go straight to a plan |
| Block the solve on invalid input and say why | Let the solver "best-effort" an invalid sheet |
| "Monthly income" | `target.kind: monthly_cashflow` |
