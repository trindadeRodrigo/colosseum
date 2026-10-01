# Token mapping: working-brand → Tailwind v4 `@theme` (shadcn-compatible)
> Phase: guidelines (Pass 2: Components) | Brand: Tenonfi (provisional) | Generated: 2026-10-01
> Source of truth: [../working-brand.yml](../working-brand.yml). Strategy: **generate**. Stack: Next.js 16 + React 19 + Tailwind v4, no shadcn yet.

This file says how the confirmed preset becomes CSS in `apps/web/app/globals.css`, and how every existing `apps/web` component consumes it. It does not add or change any token. If a value here disagrees with the `.yml`, the `.yml` wins.

---

## 1. Three layers

| Layer | Where | Names | Who writes it |
|---|---|---|---|
| **A. Semantic vars** (shadcn-native) | `:root` and `.dark` in `globals.css` | `--background`, `--primary`, `--chart-1` … exactly shadcn's names | `theme-css.js` from the `.yml`, installed by `/gsp-brand-apply`. Never hand-edited |
| **B. Brand extensions** | `:root` / `.dark`, prefixed `--tf-*` | `--tf-hatch`, `--tf-pin`, `--tf-status-*`, `--tf-primary-hover` … | Hand-written once from `tokens.brand-color` + `tokens.provenance` + `tokens.status` |
| **C. Tailwind theme** | `@theme inline { … }` | `--color-*`, `--font-*`, `--radius-*`, `--text-*`, `--ease-*` | Maps A + B to utilities (`bg-card`, `text-muted-foreground`, `font-display`) |

Because Layer A uses shadcn's names 1:1, a later `npx shadcn init` (or a `theme.json` export) reads the same variables with no translation. `components.json` would set `"cssVariables": true`, `"baseColor": "neutral"` (ignored; our vars win) and `"tailwind.css": "app/globals.css"`.

## 2. Layer A: generated semantic vars

Generated with `node ~/.claude/skills/gsp-brand-guidelines/bin/theme-css.js patterns/working-brand.yml --stdout` (run 2026-10-01). Hex → OKLCH; the hex column is the `.yml` value.

| Var | Light (hex → oklch) | Dark (hex → oklch) | Role |
|---|---|---|---|
| `--background` | `#F6F1E8` → `oklch(95.96% 0.0130 82.40)` | `#0D0B09` → `oklch(15.13% 0.0055 67.77)` | paper / black |
| `--foreground` | `#1C1712` → `oklch(20.88% 0.0125 67.03)` | `#ECE4D6` → `oklch(92.14% 0.0206 81.78)` | ink / washi |
| `--card` | `#FBF8F2` → `oklch(97.98% 0.0085 84.59)` | `#1A1714` → `oklch(20.70% 0.0075 67.36)` | paper-raised / char |
| `--card-foreground` | ink | washi | |
| `--popover` | paper-raised | `#24201B` → `oklch(24.62% 0.0110 73.40)` | char-2 in dark (one step up from card) |
| `--primary` | `#7A5A3A` → `oklch(49.32% 0.0626 65.50)` | `#E6D3B7` → `oklch(87.52% 0.0429 77.60)` | **species rule**: hardwood / hinoki |
| `--primary-foreground` | paper-raised | black | |
| `--secondary`, `--muted`, `--accent` | `#EDE6DA` → `oklch(92.72% 0.0177 81.33)` | char-2 | paper-sunk: wells, table heads, hover rows. `accent` is a surface, not a hue |
| `--accent-foreground` | `#5A3A1E` → `oklch(37.95% 0.0615 60.46)` | hinoki | heartwood / hinoki |
| `--muted-foreground` | `#6E655B` → `oklch(51.21% 0.0192 70.28)` | `#A49A8E` → `oklch(69.14% 0.0208 72.45)` | stone / stone-d. Also the hatch colour |
| `--destructive` | `#A8324A` → `oklch(50.01% 0.1535 12.83)` | `#E58AA0` → `oklch(73.48% 0.1134 4.60)` | madder: off track, validation error |
| `--border` | `#D9CDBB` → `oklch(85.32% 0.0278 78.16)` | `#3A322A` → `oklch(32.31% 0.0179 67.10)` | hair: **decoration only** |
| `--input` | `#8C7F70` → `oklch(60.39% 0.0272 71.23)` | `#7A6D5F` → `oklch(54.28% 0.0267 69.27)` | member: **every control edge** (≥ 3:1) |
| `--ring` | hardwood | hinoki | 2px outline, 2px offset |
| `--chart-1…4` | hardwood, heartwood, wood-400 `#9D7751`, stone | hinoki, hinoki-deep, wood-400, stone-d | plan legs 1–4 |
| `--chart-5` | ink | washi | base-case line |
| `--success` / `--warning` / `--info` | forest `#2F4A2A` / ochre `#8A5A00` / ink | forest-d `#7FA37A` / ochre-d `#D9A441` / washi | status, never colour alone |
| `--sidebar-*` | mirrors background / primary / accent / border / ring | char sidebar | docs nav |
| `--radius` | `2px` | — | `calc(var(--radius) - 4px)` clamps to 0 in shadcn: intended |
| `--font-sans` / `--font-mono` / `--font-display` | Plex Sans / Plex Mono / Newsreader stacks | — | |

## 3. Layer B: brand extensions (`--tf-*`)

Hand-written; values are the `.yml` hex verbatim. Kept out of `theme-css.js` because shadcn has no slot for them.

```css
:root {
  /* species-press */
  --tf-primary-hover: #63482E;      /* wood-600 */
  --tf-primary-pressed: #5A3A1E;    /* heartwood */
  /* provenance pin (J1) — the pin is the species opposite the ground */
  --tf-pin-outline: #6E655B;        /* stone */
  --tf-pin: #7A5A3A;                /* hardwood */
  /* P4 hatch: MOCK and stale only */
  --tf-hatch: #6E655B;              /* stone, 5.08:1 on paper: a valid state indicator alone */
  --tf-hatch-pitch-ui: 6px;
  --tf-hatch-pitch-glyph: 3px;
  --tf-mock-plate: #FBF8F2;         /* paper-raised */
  --tf-mock-plate-fg: #1C1712;      /* ink */
  --tf-mock-plate-border: #6E655B;  /* stone */
  /* status: word + shape + colour */
  --tf-status-on: #2F4A2A;  --tf-status-on-bg: #DEEEDB;
  --tf-status-watch: #8A5A00; --tf-status-watch-bg: #FFEADB;
  --tf-status-off: #A8324A; --tf-status-off-bg: #FAEAEC;
  /* surfaces (three warm layers) */
  --tf-layer-sunk: #EDE6DA; --tf-layer-ground: #F6F1E8; --tf-layer-raised: #FBF8F2;
  /* Bearing heatmap, low → high depth */
  --tf-heat-1: #F2E6D3; --tf-heat-2: #C9AE86; --tf-heat-3: #8A6C4B; --tf-heat-4: #5A3A1E; --tf-heat-5: #1A1714;
  /* motion */
  --tf-dur-fade: 160ms; --tf-dur-slide: 320ms; --tf-delay-pin: 120ms; --tf-dur-reduced: 120ms; --tf-stagger: 60ms;
  /* founder change 2026-10-01: the composer (typing box) is the ONE rounded shape */
  --tf-radius-composer: 20px;       /* composer container: goal input, subscribe field */
  --tf-radius-round: 9999px;        /* the composer's send button only */
  /* layout */
  --tf-measure-body: 66ch; --tf-measure-docs: 72ch; --tf-measure-display: 18ch;
  --tf-page-max: 1280px; --tf-hit-min: 24px; --tf-row-dense: 28px; --tf-row-comfortable: 32px;
}
.dark {
  --tf-primary-hover: #D7C09E;
  --tf-primary-pressed: #C9AE86;    /* hinoki-deep */
  --tf-pin-outline: #A49A8E;        /* stone-d */
  --tf-pin: #E6D3B7;                /* hinoki */
  --tf-hatch: #A49A8E;              /* stone-d, 7.10:1 on black */
  --tf-mock-plate: #1A1714;         /* char */
  --tf-mock-plate-fg: #ECE4D6;      /* washi */
  --tf-mock-plate-border: #A49A8E;  /* stone-d */
  --tf-status-on: #7FA37A;  --tf-status-on-bg: #050D04;
  --tf-status-watch: #D9A441; --tf-status-watch-bg: #180C00;
  --tf-status-off: #E58AA0; --tf-status-off-bg: #220409;
  --tf-layer-sunk: #0D0B09; --tf-layer-ground: #1A1714; --tf-layer-raised: #24201B;
  --tf-heat-1: #1A1714; --tf-heat-2: #5A3A1E; --tf-heat-3: #8A6C4B; --tf-heat-4: #C9AE86; --tf-heat-5: #F2E6D3;
}
```

Note: on dark the heatmap ramp is reversed (`scales.heatmap-dark`) so "more depth" is always "more contrast against the ground".

## 4. Layer C: `@theme inline`

```css
/* apps/web/app/globals.css */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

/* Layer A (generated) and Layer B (above) go here, then: */

@theme inline {
  /* shadcn-standard colour utilities */
  --color-background: var(--background);  --color-foreground: var(--foreground);
  --color-card: var(--card);              --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);        --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);        --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);    --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);            --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);          --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);          --color-input: var(--input);  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1); --color-chart-2: var(--chart-2); --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4); --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar); --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary); --color-sidebar-border: var(--sidebar-border);
  --color-success: var(--success); --color-warning: var(--warning); --color-info: var(--info);

  /* brand utilities */
  --color-primary-hover: var(--tf-primary-hover);   --color-primary-pressed: var(--tf-primary-pressed);
  --color-pin: var(--tf-pin);                       --color-pin-outline: var(--tf-pin-outline);
  --color-hatch: var(--tf-hatch);
  --color-mock-plate: var(--tf-mock-plate);         --color-mock-plate-foreground: var(--tf-mock-plate-fg);
  --color-status-on: var(--tf-status-on);           --color-status-on-bg: var(--tf-status-on-bg);
  --color-status-watch: var(--tf-status-watch);     --color-status-watch-bg: var(--tf-status-watch-bg);
  --color-status-off: var(--tf-status-off);         --color-status-off-bg: var(--tf-status-off-bg);
  --color-leg-1: var(--chart-1); --color-leg-2: var(--chart-2); --color-leg-3: var(--chart-3); --color-leg-4: var(--chart-4);
  --color-heat-1: var(--tf-heat-1); --color-heat-2: var(--tf-heat-2); --color-heat-3: var(--tf-heat-3);
  --color-heat-4: var(--tf-heat-4); --color-heat-5: var(--tf-heat-5);

  /* shape: 0 / 2px only */
  --radius-none: 0px; --radius-sm: 0px; --radius-md: var(--radius); --radius-lg: var(--radius);
  --radius-xl: var(--radius); --radius-2xl: var(--radius); --radius-full: var(--radius); /* pills disarmed */
  /* the only rounded shapes: composer container + its send button (founder change, see composer.md) */
  --radius-composer: var(--tf-radius-composer);   /* → rounded-composer */
  --radius-round: var(--tf-radius-round);         /* → rounded-round */

  /* type */
  --font-sans: "IBM Plex Sans", "Plex Sans Fallback", system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  --font-display: "Newsreader Variable", "Newsreader", "Newsreader Fallback", Georgia, "Times New Roman", serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-condensed: "IBM Plex Sans Condensed", "IBM Plex Sans", "Arial Narrow", system-ui, sans-serif;

  /* expressive scale (typography: scale-expressive) */
  --text-display: clamp(3.0625rem, 2.5834rem + 2.0442vw, 4.2188rem);
  --text-display--line-height: clamp(3.5rem, 2.9820rem + 2.2099vw, 4.75rem);
  --text-h1: clamp(2.4375rem, 2.1397rem + 1.2707vw, 3.1562rem);
  --text-h1--line-height: clamp(3rem, 2.6892rem + 1.3260vw, 3.75rem);
  --text-h2: clamp(1.9375rem, 1.7562rem + 0.7735vw, 2.375rem);
  --text-h2--line-height: clamp(2.5rem, 2.2928rem + 0.8840vw, 3rem);
  --text-h3: clamp(1.5625rem, 1.4719rem + 0.3867vw, 1.7812rem);
  --text-h3--line-height: clamp(2rem, 1.8964rem + 0.4420vw, 2.25rem);
  --text-h4: clamp(1.25rem, 1.2112rem + 0.1657vw, 1.3438rem);  --text-h4--line-height: 1.75rem;
  --text-body-lg: 1.125rem;   --text-body-lg--line-height: 1.75rem;
  --text-body: 1rem;          --text-body--line-height: 1.5rem;
  --text-body-sm: 0.875rem;   --text-body-sm--line-height: 1.5rem;
  --text-caption: 0.78125rem; --text-caption--line-height: 1.25rem;
  --text-source: 0.8125rem;   --text-source--line-height: 1.25rem;
  /* productive scale (Bearing): fixed */
  --text-b-kpi: 1.4688rem;    --text-b-kpi--line-height: 2rem;
  --text-b-title: 1.3125rem;  --text-b-title--line-height: 1.75rem;
  --text-b-section: 1.0313rem; --text-b-section--line-height: 1.5rem;
  --text-b-emph: 0.9063rem;   --text-b-emph--line-height: 1.25rem;
  --text-b-cell: 0.8125rem;   --text-b-cell--line-height: 1.25rem;
  --text-b-head: 0.75rem;     --text-b-head--line-height: 1rem;
  --text-b-meta: 0.75rem;     --text-b-meta--line-height: 1rem;

  /* shadows disarmed: depth = layers + hairlines */
  --shadow-2xs: none; --shadow-xs: none; --shadow-sm: none; --shadow-md: none;
  --shadow-lg: none; --shadow-xl: none; --shadow-2xl: none;

  /* motion */
  --ease-seat: cubic-bezier(0.2, 0, 0, 1);
  --animate-seat: seat var(--tf-dur-slide) var(--ease-seat) both;
  --animate-pin-drop: pin-drop var(--tf-dur-fade) var(--ease-seat) var(--tf-delay-pin) both;

  /* layout */
  --container-page: 1280px;
}

@layer base {
  html { font-family: var(--font-sans); font-variant-numeric: lining-nums tabular-nums; }
  body { background: var(--background); color: var(--foreground); }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .dark { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
}
```

**Disarming** `--radius-full` and `--shadow-*` means a stray `rounded-full` or `shadow-lg` (copied from shadcn examples) renders square and flat instead of off-brand. The provenance pin's disc is SVG, so it is unaffected.

**Rounded exception (founder change, 2026-10-01).** The typing box alone is rounded, because a square one read too much like Teiten. `rounded-composer` (20px) and `rounded-round` (9999px) exist for [composer.md](./composer.md) only: the goal composer (GoalFlow, landing simulator) and the subscribe field. A verify check should allow these two utilities only inside `components/ui/Composer.tsx`. Chips, cards, panels, buttons, inputs in the constraint sheet, the MOCK plate and everything else stay at 0/2px.

**Banned utilities** (a Biome/grep check in `scripts/verify` should fail on them in `apps/web`): `bg-blue-*`, `text-blue-*`, `indigo-*`, `violet-*`, `purple-*`, `backdrop-blur*`, `bg-gradient-*` / `bg-linear-*`, `uppercase` (except inside `MockPlate`), `font-light`, `font-thin`, `italic` on `font-display`, raw hex in `className` or SVG attributes.

## 5. Fonts (`next/font`)

```ts
// apps/web/app/fonts.ts
import { IBM_Plex_Sans, IBM_Plex_Mono, IBM_Plex_Sans_Condensed, Newsreader } from 'next/font/google';
export const plexSans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-sans', display: 'swap' });
export const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });
export const plexCond = IBM_Plex_Sans_Condensed({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-cond', display: 'swap' }); // Bearing routes only
export const newsreader = Newsreader({ subsets: ['latin'], style: ['normal'], axes: ['opsz'], variable: '--font-newsreader', display: 'swap' }); // never in /embed
```

Put the `next/font` variable first in each `--font-*` stack (`--font-sans: var(--font-plex-sans), "IBM Plex Sans", …`). Load `newsreader` in the `(app)` and `(marketing)` layouts only, never in the embed layout.

## 6. Theme switching

- Class strategy: `.dark` on `<html>` (`@custom-variant dark`). Default per surface: **marketing and Bearing dark**, **app (plan, monitor) and API docs light**. Both modes ship for every component (`always: light and dark as peers`).
- First paint: an inline script reads `localStorage.theme` or `prefers-color-scheme`. No `next-themes` needed.
- **Embed**: no `.dark` from us. The partner sets `--embed-*` vars (section 8); the embed inherits `color-scheme` from the host.

## 7. Wallet adapter (`@solana/wallet-adapter-react-ui`)

Its stylesheet ships a purple, rounded, dark modal. Override in `globals.css` after its import:

```css
.wallet-adapter-button { font: 500 0.9375rem/1 var(--font-sans); height: 40px; border-radius: var(--radius);
  background: var(--primary); color: var(--primary-foreground); }
.wallet-adapter-button:not([disabled]):hover { background: var(--tf-primary-hover); }
.wallet-adapter-button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.wallet-adapter-modal-wrapper { background: var(--popover); color: var(--popover-foreground); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: none; font-family: var(--font-sans); }
.wallet-adapter-modal-overlay { background: color-mix(in oklab, var(--background) 85%, transparent); } /* no blur */
.wallet-adapter-modal-list .wallet-adapter-button { background: transparent; color: var(--foreground); }
.wallet-adapter-modal-list .wallet-adapter-button:hover { background: var(--accent); }
.wallet-adapter-dropdown-list { background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: none; }
```

The wallet button never renders inside `/embed` (see [embed-shell.md](./embed-shell.md)).

## 8. Embed variables (partner skin)

The embed does not use Layer A colours. It reads a small partner contract, with neutral fallbacks:

| Var | Fallback | Used for |
|---|---|---|
| `--embed-fg` | `CanvasText` | body text |
| `--embed-muted` | `GrayText` | pin, hatch, provenance line, credit |
| `--embed-bg` | `Canvas` | ground; the MOCK plate fill |
| `--embed-border` | `color-mix(in oklab, var(--embed-fg) 40%, transparent)` | hairlines and control edges |
| `--embed-font` | `inherit` | everything (never Newsreader) |
| `--embed-mono` | `ui-monospace, monospace` | provenance popover |
| `--embed-radius` | `inherit` | partner radius (our 2px rule recedes here) |
| `--embed-accent` | `var(--embed-fg)` | links, focus ring |

Contrast is the partner's responsibility for their own colours, but the embed's verify script checks `--embed-muted` on `--embed-bg` ≥ 4.5:1 and refuses to render the hatch alone if it fails (MOCK word still renders).

## 9. Existing `apps/web` components: what each consumes

| Component | Today | Consumes | Changes beyond tokens |
|---|---|---|---|
| **RootLayout** `app/layout.tsx` | `bg-white text-gray-900`, `max-w-4xl`, DISCLAIMER as footer micro-text | `bg-background text-foreground font-sans`, `max-w-(--container-page)`; fonts vars on `<html>` | Split into route groups: `(app)/layout.tsx` (Nav, wallet), `(marketing)/layout.tsx` (compact nav), `embed/[id]/layout.tsx` (bare). Remove the footer disclaimer and render [disclaimer-block](./disclaimer-block.md) under the plan instead (footer micro-text is banned) |
| **Nav** | links + `WalletMultiButton`, no active state | `border-b border-border bg-background`; links `text-muted-foreground hover:text-foreground`; active `text-foreground underline decoration-2 decoration-primary underline-offset-[6px]` | App nav per `patterns.nav`; marketing uses [compact-nav](./compact-nav.md). Product name from one constant (Nav says "Structurer", metadata "Colosseum") |
| **ProvenanceBadge** `Provenance.tsx` | green "live" / amber "MOCK" pill | `text-pin`, `text-pin-outline`, `text-hatch`, `bg-mock-plate` | **Replaced** by [provenance-pin](./provenance-pin.md) (`<ProvenancePin>`) for figures and [mock-plate](./mock-plate.md) for sections. The green "live" pill goes: live is the solid pin, not a badge |
| **GoalFlow** | textarea, chips, 11-field sheet, buttons, red error list | [composer](./composer.md) for the goal textarea + "Interpretar objetivo" (round send), [field](./field.md) for sheet fields, [button](./button.md), `bg-card border-border` | Goal textarea becomes the composer; sheet extracted to [constraint-sheet](./constraint-sheet.md); human labels instead of schema keys; parser method shown as a source line |
| **PlanView** | 7 sections, 4 tables, IIFE | [card](./card.md), [data-table](./data-table.md), `--chart-*`, `font-display` for the goal sentence only | Split: GoalHeader ([goal-card](./goal-card.md) header form), ConstraintSheet (read-only), [plan-leg](./plan-leg.md) bar + table, ScheduleSection, RiskSheetTable, [exit-plan-line](./exit-plan-line.md), ExecutionList, [disclaimer-block](./disclaimer-block.md) |
| **ScheduleChart** | raw hex SVG, red ticks, no legend | `stroke="var(--chart-5)"` base (solid = measured/base), stresses `var(--muted-foreground)` dashed `4 3`, breaks `var(--destructive)` + text label, grid `var(--border)`, axis text `fill="var(--muted-foreground)"` 12px Plex Mono | Direct labels at line ends instead of a legend; a visually hidden summary table; `currentColor` everywhere so dark works |
| **StatsCard** | 4 `cell()` stats | [card](./card.md) stat cells: label `text-caption text-muted-foreground`, value `font-mono font-medium tabular-nums` | Any rate/price in a cell gets a `<ProvenancePin>`; counts (plans, txs) do not need one |
| **MonitorPage** | drift table with amber rows, raw JSON `<pre>` | [data-table](./data-table.md), status marks (`--tf-status-*`) | Out-of-band rows get the "Watch" half-square + word, not just a fill; JSON `<pre>` becomes a result card with explorer links |
| **EmbedLayout** + `/embed/[id]` | bordered frame, gray-400 caption, inherits Nav + wallet | `--embed-*` only | **Rebuilt** as [embed-shell](./embed-shell.md): bare root, no Nav, no wallet, credit at foot |
| **Home** `app/page.tsx` | headline + GoalFlow + StatsCard + list | one `font-display` line (the question to the person), rest Plex Sans | Recent plans list → [goal-card](./goal-card.md) list |

## 10. Utility cheat sheet

| Need | Classes |
|---|---|
| Ground / card / well | `bg-background` / `bg-card border border-border rounded-md` / `bg-muted` |
| Control edge | `border border-input` (never `border-border` on a control) |
| Composer (typing box only) | `rounded-composer border border-input bg-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring`; send `size-9 rounded-round bg-primary` |
| Focus | inherited from base `:focus-visible`; add `outline-offset-2` if overridden |
| Body text / meta / source | `text-body` / `text-caption text-muted-foreground` / `font-mono text-source text-muted-foreground` |
| The one serif line | `font-display font-normal text-display tracking-[-0.015em] max-w-[18ch] text-balance` |
| Figures | `font-mono tabular-nums` in tables and KPIs; `tabular-nums` in prose |
| Status | `text-status-on`, `bg-status-on-bg` etc., always with `<StatusMark>` + word |
| Hatch band | `.tf-hatch` (see [mock-plate.md](./mock-plate.md)) |
