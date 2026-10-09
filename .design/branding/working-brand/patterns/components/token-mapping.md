# Token mapping: working-brand → Tailwind v4 `@theme` (shadcn-compatible)
> Phase: guidelines (Pass 2: Components) | Brand: Tenonfi (provisional) | Generated: 2026-10-01 | Regenerated 2026-10-08 on `IDENTITY-2` and `LOGO-2` (honey on night)
> Source of truth: [../working-brand.yml](../working-brand.yml) and its OKLCH export [../working-brand.theme.json](../working-brand.theme.json). Strategy: **generate**. Stack: Next.js 16 + React 19 + Tailwind v4, no shadcn yet.

This file says how the confirmed preset becomes CSS in `apps/web/app/globals.css`, and how every existing `apps/web` component consumes it. It does not add or change any token. If a value here disagrees with the `.yml`, the `.yml` wins. The shadcn variable **names are unchanged** from the 2026-10-01 mapping; every **value** is new.

---

## 1. Three layers

| Layer | Where | Names | Who writes it |
|---|---|---|---|
| **A. Semantic vars** (shadcn-native) | `:root` and `.dark` in `globals.css` | `--background`, `--primary`, `--chart-1` … exactly shadcn's names | `theme-css.js` from the `.yml` (the values in `working-brand.theme.json`), installed by `/gsp-brand-apply`. Never hand-edited |
| **B. Brand extensions** | `:root` / `.dark`, prefixed `--tf-*` | `--tf-honey`, `--tf-pin`, `--tf-leaf-tint`, `--tf-glow` … | Hand-written once from `tokens.brand-color` + `tokens.provenance` + `tokens.status` |
| **C. Tailwind theme** | `@theme inline { … }` | `--color-*`, `--font-*`, `--radius-*`, `--text-*`, `--ease-*` | Maps A + B to utilities (`bg-card`, `text-muted-foreground`, `font-display`, `rounded-full`) |

Because Layer A uses shadcn's names 1:1, a later `npx shadcn init` (or the `theme.json` export) reads the same variables with no translation. `components.json` would set `"cssVariables": true`, `"baseColor": "neutral"` (ignored; our vars win) and `"tailwind.css": "app/globals.css"`.

## 2. Layer A: generated semantic vars

Values are `working-brand.theme.json` (OKLCH); the hex column is the `.yml` value. Light mode is "day" (warm paper, white cards); dark mode is "night" (cool near-black with a trace of blue).

| Var | Light (hex → oklch) | Dark (hex → oklch) | Role |
|---|---|---|---|
| `--background` | paper `#F7F5F0` → `oklch(97.03% 0.0070 88.64)` | night `#0C0D12` → `oklch(16.04% 0.0107 276.24)` | ground |
| `--foreground` | ink `#15161C` → `oklch(20.19% 0.0121 277.81)` | text `#F3F1EC` → `oklch(95.83% 0.0070 88.64)` | text (16.57 on paper / 17.2 on night) |
| `--card` | paper-2 `#FFFFFF` → `oklch(100% 0 0)` | night-2 `#13151C` → `oklch(19.69% 0.0144 272.52)` | cards, tiles, nav. White is allowed |
| `--card-foreground` | ink | text | |
| `--popover` | paper-2 (white) | night-3 `#1A1D26` → `oklch(23.18% 0.0180 270.53)` | popovers: one layer up, with `--tf-shadow-popover` |
| `--primary` | honey `#F5A83A` → `oklch(78.86% 0.1494 71.36)` | honey (same) | **the one brand colour**, both modes |
| `--primary-foreground` | ink | ink `#15161C` | **ink on honey, 9.06.** Never white on honey (2.0) |
| `--secondary`, `--muted` | paper-3 `#EFECE5` → `oklch(94.35% 0.0099 87.47)` | night-3 | wells, table heads, code, secondary-button hover |
| `--accent` | `#F7EAD6` → `oklch(94.20% 0.0300 78.78)` | `#2D2318` → `oklch(26.44% 0.0246 69.12)` | **honey at 14% over the ground** (opaque equivalent): selected rows, hover rows, chips |
| `--accent-foreground` | honey-l `#9D5A00` → `oklch(53.33% 0.1218 62.87)` | honey | honey as text: links, selected-chip text (5.39 on white / 9.75 on night) |
| `--muted-foreground` | muted-l `#676A75` → `oklch(52.55% 0.0176 273.62)` | muted `#9A9DAD` → `oklch(69.87% 0.0235 277.32)` | muted text (5.39 on white / 6.77 on night-2). Also the hatch colour |
| `--destructive` | madder-l `#B52F44` → `oklch(55.88% 0.1797 16.38)` | madder `#EF5A6F` → `oklch(66.77% 0.1832 15.21)` | off track, negative deltas, validation error, destructive action |
| `--border` | line-l `#E3DFD6` → `oklch(90.43% 0.0129 86.83)` | line `#262A36` → `oklch(28.63% 0.0228 270.50)` | hairlines, card edges |
| `--input` | line-l2 `#C9C4B9` → `oklch(82.13% 0.0161 86.44)` | line-2 `#363B4B` → `oklch(35.43% 0.0287 271.32)` | control edges (controls also carry a fill: `--secondary`) |
| `--ring` | chalk-l `#2A73B0` → `oklch(54.02% 0.1193 247.65)` | chalk `#78B4E8` → `oklch(74.90% 0.0978 245.75)` | **focus only**: 2px outline, 2px offset. The carpenter's line, never a fill |
| `--chart-1…4` | honey, honey-deep `#D9881B`, wood-deep `#B9803F`, muted-l | honey, wood `#E9C48E`, honey-deep, muted | plan legs 1–4 |
| `--chart-5` | ink | text | base-case line (stress cases dashed `--muted-foreground` / `--destructive`) |
| `--success` / `--warning` / `--info` | leaf-l `#117940` / clay-l `#A64618` / chalk-l | leaf `#3FC47C` / clay `#F0703A` / chalk | status words (never colour alone); info = guides and the "test network" plate |
| `--sidebar-*` | mirrors background / primary / accent / border / ring | night-2 sidebar | docs nav |
| `--radius` | `8px` | — | buttons, inputs, popovers. `calc(var(--radius) - 2px)` = 6px tags; `+ 2px` = 10px cards |
| `--font-sans` / `--font-mono` / `--font-display` | Inter / IBM Plex Mono / Inter Tight stacks | — | from `cssVars.theme` in `theme.json` |

## 3. Layer B: brand extensions (`--tf-*`)

Hand-written; values are `tokens.brand-color` verbatim. Kept out of `theme-css.js` because shadcn has no slot for them.

```css
:root {
  /* the brand colour and its states */
  --tf-honey: #F5A83A; --tf-honey-hover: #E99C2E; --tf-honey-deep: #D9881B;
  --tf-honey-text: #9D5A00;                 /* honey-l: honey as text or link on light grounds (5.39 on white) */
  --tf-honey-tint: rgba(245,168,58,0.14);   /* selected rows, chips, badges */
  /* grounds and lines, by name (for drawings and the embed boundary) */
  --tf-paper: #F7F5F0; --tf-paper-2: #FFFFFF; --tf-paper-3: #EFECE5; --tf-line-l: #E3DFD6; --tf-line-l2: #C9C4B9;
  --tf-night: #0C0D12; --tf-night-2: #13151C; --tf-night-3: #1A1D26; --tf-line: #262A36; --tf-line-2: #363B4B;
  --tf-ink: #15161C; --tf-text: #F3F1EC; --tf-muted: #9A9DAD; --tf-muted-2: #6E7282; --tf-muted-l: #676A75;
  /* direction colours: always with a word and a square glyph */
  --tf-leaf: #117940;   --tf-leaf-tint: rgba(63,196,124,0.14);
  --tf-clay: #A64618;   --tf-clay-tint: rgba(240,112,58,0.14);
  --tf-madder: #B52F44; --tf-madder-tint: rgba(239,90,111,0.14);
  /* the carpenter's line: focus, "today", guides, dimension lines, the test-network plate. Never a fill */
  --tf-chalk: #2A73B0;  --tf-chalk-tint: rgba(120,180,232,0.14);
  /* wood: imagery and the 3D joint only (and dark chart-2) */
  --tf-wood: #E9C48E; --tf-wood-deep: #B9803F;
  /* provenance pin: outline + square pin */
  --tf-pin: #9D5A00;                /* honey-l */
  --tf-pin-outline: #C9C4B9;        /* line-l2 */
  /* P4 hatch: sample and stale only; the sample line's text colour (gate MOCK-QUIET: no plate vars) */
  --tf-hatch: #676A75;              /* muted-l, 5.39 on white */
  --tf-hatch-pitch-ui: 6px; --tf-hatch-pitch-glyph: 3px;
  --tf-sample-fg: #676A75;          /* muted-l: "Sample figures · test network", once per sample card */
  /* light as gradient: the only gradients allowed */
  --tf-glow: radial-gradient(60% 90% at 78% 30%, rgba(245,168,58,0.28), rgba(245,168,58,0) 70%);   /* glow-l */
  --tf-curve-fill: linear-gradient(to bottom, rgba(245,168,58,0.35), rgba(245,168,58,0));
  /* the one shadow: popovers and the composer */
  --tf-shadow-popover: 0 8px 24px rgba(0,0,0,0.35);
  /* Bearing heatmap, low → high depth (light: pale → night) */
  --tf-heat-1: #FFE9C2; --tf-heat-2: #F5A83A; --tf-heat-3: #B06C12; --tf-heat-4: #5C3707; --tf-heat-5: #1A1D26;
  /* motion */
  --tf-dur-fade: 160ms; --tf-dur-slide: 320ms; --tf-delay-pin: 120ms; --tf-dur-reduced: 120ms; --tf-stagger: 60ms;
  /* shape beyond --radius */
  --tf-radius-composer: 20px;       /* the goal composer and the subscribe field */
  --tf-radius-pill: 9999px;         /* chips, status badges, filter tabs, the composer's send button */
  /* layout */
  --tf-measure-body: 66ch; --tf-measure-docs: 72ch; --tf-measure-display: 16ch;
  --tf-page-max: 1280px; --tf-hit-min: 24px; --tf-row-dense: 36px; --tf-row-comfortable: 44px;
}
.dark {
  --tf-honey-text: #F5A83A;         /* honey itself is the text colour on night (9.75) */
  --tf-leaf: #3FC47C; --tf-clay: #F0703A; --tf-madder: #EF5A6F; --tf-chalk: #78B4E8;
  --tf-pin: #F5A83A;                /* honey */
  --tf-pin-outline: #6E7282;        /* muted-2 */
  --tf-hatch: #9A9DAD;              /* muted, 6.77 on night-2 */
  --tf-sample-fg: #9A9DAD;          /* muted */
  --tf-glow: radial-gradient(60% 90% at 78% 30%, rgba(245,168,58,0.22), rgba(245,168,58,0) 70%);
  --tf-heat-1: #1A1D26; --tf-heat-2: #5C3707; --tf-heat-3: #B06C12; --tf-heat-4: #F5A83A; --tf-heat-5: #FFE9C2;
}
```

The tints are translucent on purpose: `--tf-honey-tint` over night is `#2D2318`, over white `#FEF3E3`, over paper `#F7EAD6` (= `--accent`). Status tints behave the same way, so a badge sits on whatever surface it is placed on.

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
  --color-honey: var(--tf-honey); --color-honey-hover: var(--tf-honey-hover); --color-honey-deep: var(--tf-honey-deep);
  --color-honey-text: var(--tf-honey-text); --color-honey-tint: var(--tf-honey-tint);
  --color-leaf: var(--tf-leaf); --color-leaf-tint: var(--tf-leaf-tint);
  --color-clay: var(--tf-clay); --color-clay-tint: var(--tf-clay-tint);
  --color-madder: var(--tf-madder); --color-madder-tint: var(--tf-madder-tint);
  --color-chalk: var(--tf-chalk); --color-chalk-tint: var(--tf-chalk-tint);
  --color-wood: var(--tf-wood); --color-wood-deep: var(--tf-wood-deep);
  --color-pin: var(--tf-pin); --color-pin-outline: var(--tf-pin-outline);
  --color-hatch: var(--tf-hatch);
  --color-sample-foreground: var(--tf-sample-fg);
  --color-leg-1: var(--chart-1); --color-leg-2: var(--chart-2); --color-leg-3: var(--chart-3); --color-leg-4: var(--chart-4);
  --color-heat-1: var(--tf-heat-1); --color-heat-2: var(--tf-heat-2); --color-heat-3: var(--tf-heat-3);
  --color-heat-4: var(--tf-heat-4); --color-heat-5: var(--tf-heat-5);

  /* shape: soft, not square */
  --radius-none: 0px;
  --radius-sm: calc(var(--radius) - 2px);   /* 6px  → tags on a dense row, inline code */
  --radius-md: var(--radius);               /* 8px  → buttons, inputs, selects, popovers */
  --radius-lg: calc(var(--radius) + 2px);   /* 10px → cards, panels, table containers, Bearing tiles */
  --radius-xl: calc(var(--radius) + 8px);   /* 16px → app tiles, hero media */
  --radius-2xl: var(--radius-xl);           /* nothing above 16px except chips, badges and the composer */
  --radius-full: var(--tf-radius-pill);     /* chips, status badges, filter tabs, the composer's send button */
  --radius-composer: var(--tf-radius-composer);   /* → rounded-composer: the goal composer and the subscribe field */

  /* type */
  --font-sans: "Inter", "Inter Fallback", system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  --font-display: "Inter Tight", "Inter", system-ui, Arial, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /* expressive scale (typography: scale-expressive) — display faces are Inter Tight 600 */
  --text-display: clamp(2.75rem, 2.2rem + 2.2vw, 4rem);          --text-display--line-height: 1.05; --text-display--letter-spacing: -0.025em;
  --text-h1: clamp(2.125rem, 1.8rem + 1.3vw, 2.875rem);          --text-h1--line-height: 1.1;       --text-h1--letter-spacing: -0.02em;
  --text-h2: clamp(1.625rem, 1.45rem + 0.8vw, 2.125rem);         --text-h2--line-height: 1.15;      --text-h2--letter-spacing: -0.02em;
  --text-h3: clamp(1.25rem, 1.15rem + 0.4vw, 1.5rem);            --text-h3--line-height: 1.25;      --text-h3--letter-spacing: -0.015em;
  --text-h4: 1.125rem;        --text-h4--line-height: 1.5rem;    --text-h4--letter-spacing: -0.01em;
  --text-body-lg: 1.125rem;   --text-body-lg--line-height: 1.75rem;
  --text-body: 1rem;          --text-body--line-height: 1.5rem;
  --text-body-sm: 0.875rem;   --text-body-sm--line-height: 1.375rem;
  --text-caption: 0.75rem;    --text-caption--line-height: 1rem;      --text-caption--letter-spacing: 0.04em;   /* uppercase: eyebrows, column heads */
  --text-figure-lg: 1.75rem;  --text-figure-lg--line-height: 2rem;    --text-figure-lg--letter-spacing: -0.02em; /* the amount on a goal card */
  --text-sample-line: 0.78125rem; --text-sample-line--line-height: 1.125rem;   /* "Sample figures · test network": Inter 400, muted, no box */
  --text-source: 0.8125rem;   --text-source--line-height: 1.25rem;
  /* productive scale (Bearing): 13px base, fixed */
  --text-b-kpi: 1.375rem;     --text-b-kpi--line-height: 1.75rem;     --text-b-kpi--letter-spacing: -0.02em;
  --text-b-title: 1.25rem;    --text-b-title--line-height: 1.75rem;
  --text-b-section: 0.9375rem; --text-b-section--line-height: 1.5rem;
  --text-b-emph: 0.8125rem;   --text-b-emph--line-height: 1.25rem;
  --text-b-cell: 0.8125rem;   --text-b-cell--line-height: 1.25rem;
  --text-b-head: 0.6875rem;   --text-b-head--line-height: 1rem;       --text-b-head--letter-spacing: 0.05em;
  --text-b-meta: 0.75rem;     --text-b-meta--line-height: 1rem;
  --text-b-delta: 0.6875rem;  --text-b-delta--line-height: 1rem;

  /* shadows: none, except the popover (and the composer) */
  --shadow-2xs: none; --shadow-xs: none; --shadow-sm: none; --shadow-md: none;
  --shadow-lg: none; --shadow-xl: none; --shadow-2xl: none;
  --shadow-popover: var(--tf-shadow-popover);

  /* light as gradient */
  --background-image-glow: var(--tf-glow);               /* → bg-glow (heroes, the composer) */
  --background-image-curve-fill: var(--tf-curve-fill);   /* → bg-curve-fill (under the base-case line) */

  /* motion */
  --ease-seat: cubic-bezier(0.2, 0, 0, 1);
  --animate-seat: seat var(--tf-dur-slide) var(--ease-seat) both;
  --animate-pin-drop: pin-drop var(--tf-dur-fade) var(--ease-seat) var(--tf-delay-pin) both;

  /* layout */
  --container-page: 1280px;
  --spacing-row-dense: var(--tf-row-dense); --spacing-row-comfortable: var(--tf-row-comfortable);
}

@layer base {
  html { font-family: var(--font-sans); font-variant-numeric: lining-nums tabular-nums; }
  body { background: var(--background); color: var(--foreground); }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .dark { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
}
```

**Disarming** `--shadow-*` means a stray `shadow-lg` (copied from shadcn examples) renders flat instead of off-brand. `shadow-popover` is the one shadow and exists for popovers and the composer only. `rounded-full` is **allowed** again, for chips, status badges, filter tabs and the composer's send button; a verify check should fail on `rounded-full` applied to a `<button>` that is not inside `Composer.tsx` or a `Chip` (pills never on primary or secondary buttons) and on any radius utility above `rounded-xl` outside those files.

**Banned utilities** (a Biome/grep check in `scripts/verify` should fail on them in `apps/web`): `bg-blue-*`, `text-blue-*`, `bg-chalk`, `bg-info` (chalk is a line: `ring-*`, `border-*`, `text-*`, `stroke-*` only), `indigo-*`, `violet-*`, `purple-*`, `backdrop-blur*`, `bg-gradient-*` / `bg-linear-*` / `bg-radial-*` (only `bg-glow` and `bg-curve-fill`), `font-serif`, `uppercase` (except `text-caption` and `text-b-head`), any element whose text content is exactly `MOCK` (gate MOCK-QUIET), `font-light`, `font-thin`, `italic` on `font-display`, `text-white` on `bg-primary` / `bg-honey`, raw hex in `className` or SVG attributes.

## 5. Fonts (`next/font`)

```ts
// apps/web/app/fonts.ts
import { Inter, Inter_Tight, IBM_Plex_Mono } from 'next/font/google';
export const inter = Inter({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-inter', display: 'swap' });
export const interTight = Inter_Tight({ subsets: ['latin', 'latin-ext'], weight: ['500', '600', '700'], variable: '--font-inter-tight', display: 'swap' }); // never in /embed
export const plexMono = IBM_Plex_Mono({ subsets: ['latin', 'latin-ext'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });
```

Put the `next/font` variable first in each `--font-*` stack (`--font-sans: var(--font-inter), "Inter", …`; `--font-display: var(--font-inter-tight), "Inter Tight", …`). Load `interTight` in the `(app)` and `(marketing)` layouts only, never in the embed layout. There is no condensed face and no serif: Bearing heads use Inter 500 at 11px uppercase (`text-b-head`).

## 6. Theme switching

- Class strategy: `.dark` on `<html>` (`@custom-variant dark`). Default per surface: **marketing and Bearing dark**, **app (plan, monitor) and API docs light**. Both modes ship for every component (`always: light and dark as peers`).
- First paint: an inline script reads `localStorage.theme` or `prefers-color-scheme`. No `next-themes` needed.
- The hero and the composer may sit on `bg-glow` in both modes (glow-l on paper is 28%, glow on night 22%: the `.dark` block swaps `--tf-glow`).
- **Embed**: no `.dark` from us. The partner sets `--embed-*` vars (section 8); the embed inherits `color-scheme` from the host.

## 7. Wallet adapter (`@solana/wallet-adapter-react-ui`)

Its stylesheet ships a purple, rounded, dark modal. Override in `globals.css` after its import:

```css
.wallet-adapter-button { font: 600 0.9375rem/1 var(--font-sans); height: 40px; border-radius: var(--radius);
  background: var(--primary); color: var(--primary-foreground); }                 /* honey, ink on it */
.wallet-adapter-button:not([disabled]):hover { background: var(--tf-honey-hover); }
.wallet-adapter-button:not([disabled]):active { background: var(--tf-honey-deep); }
.wallet-adapter-button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.wallet-adapter-modal-wrapper { background: var(--popover); color: var(--popover-foreground); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: var(--tf-shadow-popover); font-family: var(--font-sans); }
.wallet-adapter-modal-overlay { background: color-mix(in oklab, var(--background) 85%, transparent); } /* no blur */
.wallet-adapter-modal-list .wallet-adapter-button { background: transparent; color: var(--foreground); }
.wallet-adapter-modal-list .wallet-adapter-button:hover { background: var(--accent); }
.wallet-adapter-dropdown-list { background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--tf-shadow-popover); }
```

The wallet button never renders inside `/embed` (see [embed-shell.md](./embed-shell.md)).

## 8. Embed variables (partner skin)

The embed does not use Layer A colours. It reads a small partner contract, with neutral fallbacks:

| Var | Fallback | Used for |
|---|---|---|
| `--embed-fg` | `CanvasText` | body text |
| `--embed-muted` | `GrayText` | pin outline and square, hatch, provenance line, the "Powered by" credit |
| `--embed-bg` | `Canvas` | ground |
| `--embed-border` | `color-mix(in oklab, var(--embed-fg) 40%, transparent)` | hairlines and control edges |
| `--embed-font` | `inherit` | everything (never Inter Tight) |
| `--embed-mono` | `ui-monospace, monospace` | provenance popover |
| `--embed-radius` | `inherit` | partner radius (our 8/10px recede here) |
| `--embed-accent` | `var(--embed-fg)` | links, focus ring (never honey) |

Contrast is the partner's responsibility for their own colours, but the embed's verify script checks `--embed-muted` on `--embed-bg` ≥ 4.5:1 and refuses to render the hatch alone if it fails (the sample line still renders).

## 9. Existing `apps/web` components: what each consumes

| Component | Today | Consumes | Changes beyond tokens |
|---|---|---|---|
| **RootLayout** `app/layout.tsx` | `bg-white text-gray-900`, `max-w-4xl`, DISCLAIMER as footer micro-text | `bg-background text-foreground font-sans`, `max-w-(--container-page)`; font vars on `<html>` | Split into route groups: `(app)/layout.tsx` (Nav, wallet), `(marketing)/layout.tsx` (compact nav), `embed/[id]/layout.tsx` (bare). Remove the footer disclaimer and render [disclaimer-block](./disclaimer-block.md) under the plan instead (footer micro-text is banned) |
| **Nav** | links + `WalletMultiButton`, no active state | `border-b border-border bg-background`; mark (24 hint) + wordmark left; links `text-muted-foreground hover:text-foreground`; active `text-foreground underline decoration-2 decoration-honey underline-offset-[6px]` | App nav per `patterns.nav`; marketing uses [compact-nav](./compact-nav.md). Product name from one constant (Nav says "Structurer", metadata "Colosseum") |
| **ProvenanceBadge** `Provenance.tsx` | green "live" / amber "MOCK" pill | `text-pin`, `stroke-pin-outline`, `text-hatch`, `text-sample-foreground` | **Replaced** by [provenance-pin](./provenance-pin.md) (`<ProvenancePin>`) for figures and the sample marking ([mock-plate.md](./mock-plate.md)) for cards. Both pills go (gate MOCK-QUIET): live is the solid square pin, not a badge, and a sample card keeps its hatched edge with one muted line, "Sample figures" or "Sample figures · test network" |
| **GoalFlow** | textarea, chips, 11-field sheet, buttons, red error list | [composer](./composer.md) for the goal textarea + "Interpretar objetivo" (round honey send), [field](./field.md) for sheet fields, [button](./button.md), `bg-card border-border rounded-lg` | Goal textarea becomes the composer; sheet extracted to [constraint-sheet](./constraint-sheet.md); human labels instead of schema keys; parser method shown as a source line; suggestion chips become pills |
| **PlanView** | 7 sections, 4 tables, IIFE | [card](./card.md), [data-table](./data-table.md), `--chart-*`, `font-display` for the goal sentence and figures only | Split: GoalHeader ([goal-card](./goal-card.md) header form), ConstraintSheet (read-only), [plan-leg](./plan-leg.md) bar + table, ScheduleSection, RiskSheetTable, [exit-plan-line](./exit-plan-line.md), ExecutionList, [disclaimer-block](./disclaimer-block.md) |
| **ScheduleChart** | raw hex SVG, red ticks, no legend | base case `stroke="var(--tf-honey)"` 2px with `bg-curve-fill` beneath (solid = measured/base), stresses `var(--muted-foreground)` dashed `4 3`, breaks `var(--destructive)` dashed + text label, "today" `var(--tf-chalk)` dashed 1px + Plex Mono label, grid `var(--border)`, axis text `fill="var(--muted-foreground)"` 12px Plex Mono | Direct labels at line ends instead of a legend; a visually hidden summary table; `currentColor` everywhere so dark works |
| **StatsCard** | 4 `cell()` stats | [card](./card.md) stat cells: label `text-caption uppercase text-muted-foreground`, value `font-display font-semibold text-figure-lg tabular-nums` + signed delta | Any rate/price in a cell gets a `<ProvenancePin>`; counts (plans, txs) do not need one |
| **MonitorPage** | drift table with amber rows, raw JSON `<pre>` | [data-table](./data-table.md), status pills (`bg-clay-tint text-clay` etc.) | Out-of-band rows get the "Watch" half-square + word in a pill, not a row fill; JSON `<pre>` becomes a result card with explorer links |
| **EmbedLayout** + `/embed/[id]` | bordered frame, gray-400 caption, inherits Nav + wallet | `--embed-*` only | **Rebuilt** as [embed-shell](./embed-shell.md): bare root, no Nav, no wallet, credit at foot |
| **Home** `app/page.tsx` | headline + GoalFlow + StatsCard + list | the composer on `bg-glow` in the first viewport with a sample plan beneath it; one `font-display` line (the question to the person), rest Inter | Recent plans list → [goal-card](./goal-card.md) list. The product in the first viewport, not a manifesto |

## 10. Utility cheat sheet

| Need | Classes |
|---|---|
| Ground / card / well | `bg-background` / `bg-card border border-border rounded-lg` / `bg-muted` |
| Control edge | `border border-input rounded-md bg-secondary` (controls carry a fill; never `border-border` on a control) |
| Primary action | `h-10 px-4 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-honey-hover active:bg-honey-deep` (ink on honey, both modes) |
| Composer (typing box only) | `rounded-composer border border-input bg-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring`; send `size-9 rounded-full bg-primary text-primary-foreground` |
| Chip / status badge | `h-8 px-3 rounded-full border border-input` · selected `bg-honey-tint text-honey-text border-transparent` / `h-[22px] px-2 rounded-full bg-leaf-tint text-leaf text-xs font-semibold` (+ `<StatusMark>` + word) |
| Focus | inherited from base `:focus-visible` (chalk); add `outline-offset-2` if overridden |
| Body text / meta / source | `text-body` / `text-caption uppercase text-muted-foreground` / `font-mono text-source text-muted-foreground` |
| Display line, big number | `font-display font-semibold text-display text-balance max-w-[16ch]` / `font-display font-semibold text-figure-lg tabular-nums` |
| Figures | `tabular-nums` in Inter everywhere; `font-mono` only for provenance, hashes, timestamps and code |
| Delta | `text-b-delta font-medium text-leaf` (up) / `text-madder` (down) / `text-muted-foreground` (flat); signed, true minus |
| Sample marking | `.tf-sample-card` (hatched left edge) + `text-sample-line text-sample-foreground` line, once per card (see [mock-plate.md](./mock-plate.md)) |
| Light | `bg-glow` behind a hero or the composer; `bg-curve-fill` under the base-case line. Nothing else |
