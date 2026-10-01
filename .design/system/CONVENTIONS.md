# Conventions
> Design System Analysis | Generated: 2026-10-01

## Naming Patterns

| Convention | Value |
|------------|-------|
| Components | PascalCase files, one per file (`GoalFlow.tsx`, `PlanView.tsx`). Exception: `Provenance.tsx` exports `ProvenanceBadge` |
| Files | Routes: Next.js lowercase folders + `page.tsx` / `layout.tsx`; libs: camelCase (`api.ts`) |
| Utilities | camelCase, short inline arrow helpers (`pct`, `pct3`, `brl`, `fmt`, `field`, `cell`) defined per file |
| CSS classes | Tailwind utility strings inline in `className`; template literals for conditional classes (`${r.outOfBand ? 'bg-amber-50' : ''}`) |
| Copy | Mixed PT-BR (home, GoalFlow) and EN (PlanView, Monitor, Nav); `<html lang="pt-BR">` |

## Export Style

| Pattern | Usage |
|---------|-------|
| Default exports | Route files only (`page.tsx`, `layout.tsx`) as Next.js requires |
| Named exports | All components (`export function GoalFlow`), `lib/api.ts` (`API`, `apiGet`, types) |
| Barrel files | no |

## Styling Approach

| Aspect | Value |
|--------|-------|
| Primary method | Tailwind v4 utility classes against the default theme |
| Class merging | manual string concatenation / template literals; no `cn()`, `clsx` or `tailwind-merge` |
| Component styling | Hard-coded `className` inside components; no `className` prop passthrough, no variants |
| Responsive approach | Mobile-first, `sm:` only (grid column counts); wide tables rely on `overflow-x-auto` in one place (risk sheet) |
| Charts | Inline SVG with presentational attributes (`stroke`, `fill`, `fontSize`) and raw hex |

## Import Aliases

| Alias | Maps to |
|-------|---------|
| `@/*` | `apps/web/*` (e.g. `@/components/Nav`, `@/lib/api`) |
| `@colosseum/schemas` | `packages/schemas/src/index.ts` (also `@colosseum/db`, `engine`, `chain-solana`, `chain-evm` mapped in tsconfig; only `schemas` is a web dependency) |
| `./X` | Relative imports between sibling components (`PlanView` → `./Provenance`, `./ScheduleChart`) |

## File Organization

**Pattern:** type-based, flat

`app/` holds routes and the root layout/providers; `components/` holds every component (screens-sized and primitive alike) in one flat folder; `lib/` holds the API client and response types. Shared domain types and the `DISCLAIMER` constant come from `packages/schemas`. Formatting: Biome (2-space, single quotes, semicolons, 100 cols).

## Where to Add

| Type | Location | Naming | Example |
|------|----------|--------|---------|
| Component | `apps/web/components/` (primitives → new `apps/web/components/ui/`) | PascalCase, named export | `components/ui/Button.tsx` |
| Page | `apps/web/app/<route>/page.tsx` | lowercase route folder, default export | `app/bearing/page.tsx` |
| Utility | `apps/web/lib/` | camelCase file, named exports | `lib/format.ts` (`pct`, `brl`, `usd`, `shortSig`) |
| Token / Theme | `apps/web/app/globals.css` | Tailwind v4 `@theme` block, `--color-*`, `--font-*`, `--radius-*` | `@theme { --color-wood-500: oklch(0.493 0.063 65.5); }` |
