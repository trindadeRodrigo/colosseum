# Components
> Design System Analysis | Generated: 2026-10-01

## UI Kit Detection

**UI Kit:** none
**Source:** No `components.json`, no `components/ui/`, no Radix/MUI/Headless UI in `apps/web/package.json`. The only external UI is `@solana/wallet-adapter-react-ui` (`WalletMultiButton`, `WalletModalProvider`, imported `styles.css` in `app/providers.tsx`).

## Existing Components

| Component | Path | Props / Variants | Reusable? | Notes |
|-----------|------|------------------|-----------|-------|
| GoalFlow | `apps/web/components/GoalFlow.tsx` | none (client; owns state) | no | Hero flow: goal textarea + example chips → POST `/goals` → editable constraint sheet (11 fields via local `field()` helper: text/number/select) → capital input → POST `/plans` → router push. Contains the de-facto button, input, select, chip and error-list styles |
| Nav | `apps/web/components/Nav.tsx` | none (client) | no | Header: Structurer / Monitor / API docs links + `WalletMultiButton`. No active-link state |
| PlanView | `apps/web/components/PlanView.tsx` | `d: PlanDetail`, `embed?: boolean` | partially | ~300 lines, 7 sections (header, constraint sheet `dl`, allocation table, schedule + stresses table + month-by-month `details`, 10-column risk sheet table, policy, executions). Used by `/plans/[id]` and `/embed/[id]`; `embed` only hides the disclaimer line |
| ProvenanceBadge | `apps/web/components/Provenance.tsx` | `value?: string \| null` (`live` → green; `mock` → amber uppercase `MOCK`; other → amber raw) | yes | The only true primitive. Required by CLAUDE.md MOCK rule. Not used in GoalFlow parser output or Monitor prices |
| ScheduleChart | `apps/web/components/ScheduleChart.tsx` | `base: Row[]`, `stresses: {id,name,rows}[]` | partially | Hand-rolled SVG (720×220 viewBox): base line `#111827`, dashed stress lines from 5 hard-coded hexes, red liquidity-break ticks, 3 gridlines. `role="img"` + aria-label; no legend, no tooltip |
| StatsCard | `apps/web/components/StatsCard.tsx` | none (async Server Component) | no | "Live on mainnet": 4 stat cells (local `cell()` helper) + by-kind summary line from `/stats`. Returns `null` on error |
| RootLayout | `apps/web/app/layout.tsx` | `children` | n/a | `bg-white text-gray-900`, `max-w-4xl px-4` container, footer with `DISCLAIMER.pt/.en` |
| Providers | `apps/web/app/providers.tsx` | `children` | n/a | Solana Connection/Wallet/WalletModal providers |
| Home page | `apps/web/app/page.tsx` | — | n/a | Headline + GoalFlow + StatsCard + recent plans list |
| MonitorPage | `apps/web/app/monitor/page.tsx` | — (client) | no | ~380 lines: drift table (out-of-band amber rows), 3 info cards, proposal orders, "Run policy now" button, raw JSON `<pre>` result, rebalances and executions lists, revoke() flow (defined, not wired to a button) |
| EmbedLayout | `apps/web/app/embed/[id]/layout.tsx` | `children` | n/a | Bordered frame + "Partner embed · unbranded" caption |
| Plan / Embed pages | `apps/web/app/plans/[id]/page.tsx`, `apps/web/app/embed/[id]/page.tsx` | `params` | n/a | Thin server wrappers around PlanView |

> 12 entries; under the 30 cap.

### Implicit (unextracted) patterns

Repeated inline class strings that should become primitives:

| Pattern | Class string | Occurrences |
|---------|--------------|-------------|
| Primary button | `rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50` | GoalFlow ×2, Monitor ×1 |
| Chip / ghost button | `rounded bg-gray-100 px-2 py-0.5 hover:bg-gray-200` | GoalFlow |
| Input / select | `rounded border border-gray-300 p-1` (textarea `p-2`) | GoalFlow ×4 |
| Card / panel | `rounded border border-gray-200 p-2/p-3` | GoalFlow, StatsCard, Monitor ×3 |
| Section heading | `font-semibold` h2 | everywhere |
| Data table | `w-full text-sm` + `text-left text-gray-500` header + `border-t border-gray-100` rows | PlanView ×4, Monitor ×1 |
| Explorer link | `text-blue-700 underline` + `signature.slice(0,12)…` | PlanView, Monitor, Home |
| Execution list item | `{kind} {assetId} · {status} · link` | PlanView, Monitor (duplicated) |
| Status text | `text-green-700` ok / `text-red-700` break / `text-amber-800` warn | PlanView, Monitor, GoalFlow |
| Muted meta line | `text-xs text-gray-500` | everywhere |

## Where to Add

| Type | Location | Pattern |
|------|----------|---------|
| UI component | `apps/web/components/` (propose `components/ui/` for primitives: Button, Input, Card, Table, Badge, ExplorerLink) | PascalCase `.tsx`, named export, no barrel |
| Page / Screen | `apps/web/app/<route>/page.tsx` | App Router folders, lowercase / `[param]` |
| Utility | `apps/web/lib/` | camelCase file, named exports (e.g. `api.ts`); formatters (`pct`, `brl`) currently duplicated inline — move to `lib/format.ts` |
| Hook | none yet; propose `apps/web/lib/hooks/` or `apps/web/hooks/` | `useX` camelCase, named export |
