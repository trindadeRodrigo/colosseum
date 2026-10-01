# Stack
> App: `apps/web` | Repo type: monorepo (pnpm workspaces: `apps/*`, `packages/*`)
> Design System Analysis | Generated: 2026-10-01

## Classification

**Codebase type:** `existing`
**Rationale:** Real product UI: 6 custom components (GoalFlow, Nav, PlanView, Provenance, ScheduleChart, StatsCard), 4 routes (home, `plans/[id]`, `monitor`, `embed/[id]`), live API calls, Solana wallet signing. Styling is ad-hoc Tailwind utilities with no theme or tokens, so the *design system* itself is effectively greenfield.

## Tech Stack

| Layer | Value |
|-------|-------|
| Framework | Next.js 16 (`^16.3.8`, App Router) + React 19 (`^19.3.0`). `apps/web/AGENTS.md` warns this Next has breaking changes; read `node_modules/next/dist/docs/` before writing code |
| Language | TypeScript 5.9 (strict, `jsx: react-jsx`, `moduleResolution: bundler`) |
| Styling | Tailwind CSS v4 (`tailwindcss ^4.1.0`) via `@tailwindcss/postcss`; `app/globals.css` is only `@import "tailwindcss";` (no `@theme`, no custom properties, no `tailwind.config.*`) |
| UI Kit | none (no shadcn, no `components.json`, no Radix). Only third-party UI: `@solana/wallet-adapter-react-ui` (WalletMultiButton + modal, ships its own `styles.css`) |
| Package Manager | pnpm 11.5.3 (`packageManager`), Node >= 22 |
| Build Tool | Next.js built-in (Turbopack/SWC); `transpilePackages: ['@colosseum/schemas']` |
| Lint / format | Biome 2.5 (repo root `biome.json`: 2-space, single quotes, semicolons, line width 100). No ESLint/Prettier |
| Tests | Vitest 5 at repo root (no component/visual tests for `apps/web`) |

## Architecture Patterns

| Pattern | Value |
|---------|-------|
| Component style | Plain functional components, named exports, inline prop types; local render helpers (`field()`, `cell()`) instead of sub-components. No forwardRef, no compound components, no variants API |
| State management | `useState` / `useCallback` only; wallet state from `@solana/wallet-adapter-react` context (`app/providers.tsx`) |
| Data fetching | Async Server Components (`page.tsx`, `StatsCard`) calling `apiGet()` with `cache: 'no-store'` + `dynamic = 'force-dynamic'`; client components (`GoalFlow`, `monitor/page.tsx`) use raw `fetch` in handlers / `useEffect` |
| Routing | Next.js App Router: `/`, `/plans/[id]`, `/monitor`, `/embed/[id]` (embed layout is nested inside the root layout, so Nav and wallet button still render — see CONCERNS) |
| File organization | Type-based and flat: `app/` (routes), `components/` (all components, flat), `lib/` (API client + types) |

## Key Paths

| Path | Purpose |
|------|---------|
| Components | `apps/web/components/` |
| Layouts | `apps/web/app/layout.tsx` (root: Nav, `max-w-4xl` container, DISCLAIMER footer), `apps/web/app/embed/[id]/layout.tsx` |
| Pages / Screens | `apps/web/app/page.tsx`, `app/plans/[id]/page.tsx`, `app/monitor/page.tsx`, `app/embed/[id]/page.tsx` |
| Tokens / Theme | `apps/web/app/globals.css` (empty of tokens). Brand tokens-in-progress: `.design/branding/working-brand/identity/palettes.json`, `typography.md` |
| Config | `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/tsconfig.json`, `/biome.json` |
| Public / Assets | none (no `public/`, no fonts, no icons, no favicon) |
| Shared types / copy | `packages/schemas` (`DISCLAIMER` constant, zod types), `apps/web/lib/api.ts` (`PlanDetail`, `WalletView`) |
