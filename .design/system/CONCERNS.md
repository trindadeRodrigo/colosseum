# Concerns
> Design System Analysis | Generated: 2026-10-01

## Design Debt

| Issue | File(s) | Severity | Fix Approach |
|-------|---------|----------|--------------|
| No tokens at all: every color/size is a raw Tailwind default or hex | `apps/web/app/globals.css`, all components | high | Add `@theme` in `globals.css` from `working-brand/identity/palettes.json` + `typography.md`; swap `gray-*`/`black` for semantic tokens (`--color-surface`, `--color-ink`, `--color-muted`, `--color-ok/warn/danger`) |
| Primitives duplicated as inline class strings (button ×3, input ×4, card ×5, table ×5, explorer link ×3) | `GoalFlow.tsx`, `PlanView.tsx`, `monitor/page.tsx`, `StatsCard.tsx`, `app/page.tsx` | high | Extract `components/ui/{Button,Input,Select,Card,DataTable,ExplorerLink,Stat}.tsx` |
| Chart colors hard-coded hex, outside any palette, no legend mapping stress → color | `components/ScheduleChart.tsx` | medium | Drive strokes from CSS vars (`currentColor` / `var(--chart-n)`), add legend |
| Formatters (`pct`, `brl`, USD `toFixed`, `toLocaleString`) re-implemented per file with inconsistent precision (1 vs 2 decimals) and locale | `PlanView.tsx`, `monitor/page.tsx`, `StatsCard.tsx`, `app/page.tsx` | medium | `lib/format.ts`, one locale policy, tabular figures |
| No fonts loaded; brand specifies Newsreader + IBM Plex Sans/Mono | `app/layout.tsx` | medium | `next/font/google` + `--font-*` theme vars |
| Raw JSON `<pre>` dumped as the policy-run result UI | `app/monitor/page.tsx` | medium | Render outcome/signatures/explorer links as a result card |

## Component Fragility

| Issue | File(s) | Severity | Fix Approach |
|-------|---------|----------|--------------|
| PlanView is ~300 lines, 7 sections, IIFE inside JSX, `Record<string, unknown>` casts for risk sheet | `components/PlanView.tsx` | medium | Split into `ConstraintSheet`, `AllocationTable`, `ScheduleSection`, `RiskSheetTable`, `PolicySummary`, `ExecutionList` |
| Monitor page ~380 lines mixing data types, signing flow and UI; `revoke()` implemented but no button calls it | `app/monitor/page.tsx` | medium | Move signing to a hook (`useSignAndReport`), extract sections; wire or remove revoke |
| Execution list duplicated between PlanView and Monitor | `PlanView.tsx`, `monitor/page.tsx` | low | Shared `ExecutionList` |
| No `className` passthrough or variants on any component | `components/*` | low | Add when extracting primitives |

## Accessibility Gaps

| Issue | File(s) | Severity | Fix Approach |
|-------|---------|----------|--------------|
| No visible focus styles defined (relies on browser default; `border-gray-300` inputs) | `GoalFlow.tsx`, `monitor/page.tsx` | medium | `focus-visible:` ring token on all interactive primitives |
| Data tables have no `<caption>`/`scope`; header cells unstyled spacing | `PlanView.tsx`, `monitor/page.tsx` | medium | DataTable primitive with caption + `scope="col"` |
| Status conveyed by color only (green "holds"/red "breaks" mostly has text, but out-of-band drift rows = amber background only; chart break ticks red only) | `monitor/page.tsx`, `ScheduleChart.tsx` | medium | Add icon/text marker ("out of band"), chart legend/text summary |
| Errors and busy states not announced (no `aria-live`, no `aria-busy`) | `GoalFlow.tsx`, `monitor/page.tsx` | medium | `role="alert"` on error lists, `aria-live="polite"` for results |
| `text-gray-400` caption on white (~2.5:1) fails AA | `app/embed/[id]/layout.tsx` | low | Use gray-500+ or muted token checked >= 4.5:1 |
| Mixed-language UI under `lang="pt-BR"`; EN sections not marked `lang="en"` | `app/layout.tsx`, `PlanView.tsx`, `monitor/page.tsx` | low | Pick language per view or set `lang` on EN blocks |
| Chart axis text 10px | `ScheduleChart.tsx` | low | >= 12px equivalent |

## Token Coverage Gaps

| Category | Status | Details |
|----------|--------|---------|
| Colors | hardcoded | Tailwind default grays/amber/green/red/blue + 8 raw hexes in SVG; brand wood/neutral palette exists only in `.design/` |
| Typography | hardcoded | Browser default font; Tailwind default sizes; no tabular figures for financial numbers |
| Spacing | hardcoded (defaults) | Consistent-ish Tailwind scale, no semantic spacing |
| Radii | hardcoded (defaults) | `rounded` only |
| Shadows | n/a | None used |
| Status / semantic | hardcoded | ok/warn/danger/mock/live colors repeated inline; ProvenanceBadge is the only centralized one |

## Dark Mode Gaps

| Issue | File(s) | Severity | Fix Approach |
|-------|---------|----------|--------------|
| No dark mode anywhere; `bg-white text-gray-900` fixed on body | `app/layout.tsx` | low | Decide in brand guidelines; if wanted, semantic tokens + `prefers-color-scheme` / class strategy |
| SVG chart colors fixed for light background (`#111827` base line) | `ScheduleChart.tsx` | low | Use `currentColor` / CSS vars |
| Wallet adapter modal ships its own (dark) stylesheet, unthemed | `app/providers.tsx` | low | Override `.wallet-adapter-*` vars to brand tokens |

## Responsive Gaps

| Issue | File(s) | Severity | Fix Approach |
|-------|---------|----------|--------------|
| Allocation, stress, drift and month tables have no `overflow-x-auto` wrapper (only risk sheet does); Monitor drift table has 7 columns | `PlanView.tsx`, `monitor/page.tsx` | medium | Wrap all tables; or stacked-card layout under `sm` |
| Capital input fixed `w-32` inline with label and button in a non-wrapping flex row | `GoalFlow.tsx` | low | `flex-wrap` |
| Embed route inherits root layout (Nav, wallet button, `max-w-4xl`, footer) despite its comment "no nav, no wallet button" | `app/embed/[id]/layout.tsx`, `app/layout.tsx` | high | Move main app under a route group `(app)/` with its own layout so `/embed` gets a bare root; container queries for partner widths (brand typography spec "Embedded" scale) |

## Naming Inconsistencies

| Issue | File(s) | Severity | Fix Approach |
|-------|---------|----------|--------------|
| `Provenance.tsx` exports `ProvenanceBadge` | `components/Provenance.tsx` | low | Rename file or export |
| Product called "Structurer" in Nav, "Colosseum" in metadata, "Tenonfi" in brand work | `Nav.tsx`, `app/layout.tsx` | low | Single product-name constant once naming is final |
| PT/EN copy mixed across screens (home + GoalFlow PT, plan/monitor EN, sheet field labels are raw schema keys like `target.kind`) | `GoalFlow.tsx`, `PlanView.tsx`, `monitor/page.tsx` | medium | Copy dictionary keyed by `language`; human labels for sheet fields |

## Summary

- **High severity:** 3
- **Medium severity:** 12
- **Low severity:** 11
- **Overall health:** significant-issues (functional and honest about provenance, but no design system layer: 0/6 token categories, no primitives)
