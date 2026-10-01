# Typography
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01

**Three faces, two families, all free (OFL), all with Latin Extended** for EN, PT and ES (ã õ ç ñ á é í ó ú ü ¿ ¡ ª º). All three ship from Google Fonts or self-hosted, so they can go out before Oct 4.

The split mirrors the voice: **the serif says the answer to a person, the sans explains, the mono cites.** In the voice's terms (answer → reason → risk → action), the serif carries the *answer*, the sans the *reason and action*, and the mono the *source*.

---

## Display: **Newsreader** (Production Type), Display optical size, upright

**Why:** the founder asked for a humanist serif, and Newsreader is one. Its construction follows the pen, so it reads as a person writing to you (Caregiver). At the Display optical size (opsz 36–72) its serifs become sharp, bracketed wedges that read as *cut*, not calligraphic, so the craft stays precise (Sage). It is slightly narrow, which helps the PT and ES headlines that run 20–30% longer. It has a true optical-size axis and a broad weight range.

**Chosen over Source Serif 4** (the mood board's pick): Source Serif is transitional (Fournier-like), cooler and more bookish. Newsreader is warmer at the same sharpness, and that warmth is the Caregiver's 40%.

- **Weights:** 400 for display sentences, 500 for the logotype base and short headlines. Never bold, never italic in brand use (Wealthfront owns the serif-italic flourish, and an italic leans to calligraphy).
- **Use:** the goal sentence on the plan view ("Your apartment fund is on track."), marketing headlines, video title cards, the manifesto, the wordmark.
- **Never:** in the embed, in Bearing, in tables, buttons, labels, or for numbers that carry a pin. The serif is the *one* place for emotional weight, and it's spent once per screen.

## UI and body: **IBM Plex Sans** (+ **Plex Sans Condensed** for dense tables)

**Why:** an engineered grotesk with visible "cut" details. Its angled terminals and squared curves read like tooling marks, so it feels made rather than generated. It is warmer than a neo-grotesk and is used by none of the benchmarked competitors (Söhne, Inter, Satoshi, Plus Jakarta and Gelix are taken). Its tabular figures are excellent. The Condensed width lets Bearing's tables fit without a second family.

- **Weights:** 400 body, 500 labels, buttons and emphasis, 600 for UI headings only. No light weights (they fail on warm grounds) and no heavy weights (they shout).
- **Use:** all product UI, body copy, API docs prose, Bearing, the "Powered by" line, the "Bearing" word in the product lockup.

## Numbers, provenance, code: **IBM Plex Mono**

**Why:** the provenance line (`source · fetched_at · method`), explorer hashes, ISO timestamps, OpenAPI examples and the MOCK label. Same skeleton as Plex Sans, so it's one system. Mono means *cited*: when you see mono, you are looking at a source.

- **Weights:** 400, 500.
- **Use:** provenance popovers, activity log hashes, code, API reference, the MOCK and stale labels, Bearing method versions (`method v1.3 · n=412`).
- **Never** for headlines. Mono-led headlines are the retro-OS / Teiten register.

---

## Rules

- **Sentence case everywhere.** The only all-caps word is **MOCK**. It's a label, not a word.
- **Figures:** tabular and lining in all UI (Plex Sans `tnum`). Old-style figures are allowed only in serif marketing prose. A yield figure is always followed by the pin glyph at cap height.
- **Scale direction:**
  - **Consumer and marketing:** airy, with large contrast between the serif sentence and the sans body. One serif line, then quiet.
  - **Docs:** editorial and measured (swiss-minimalist structure, set flush left and ragged right).
  - **Bearing:** tight and technical, Condensed at small sizes with hairline rows.
- **Alignment:** flush left, ragged right. Never justified, never centred for body text. Video title cards may centre.
- **Language length:** headlines are written in EN to about 80% of their measure so PT and ES fit without shrinking the type.
- **Embed:** Plex is **replaced by the partner's font**. Only the mono provenance line may keep Plex Mono if the partner allows. Otherwise it falls back to the partner's monospace.
- **The logotype is artwork, not type.** It's drawn from Newsreader, outlined, and the fi ligature is custom (logo-directions.md).

## Paid upgrade path (post-hackathon, optional)

Klim **Signifier** (display) and Klim **Untitled Sans** (UI), keeping Plex Mono, if the brand later wants a more ownable voice. Avoid Söhne (Gauntlet) and Inter (Chaos Labs, Peaks). Same roles, same rules. Not before the name is final.


---

# Technical system (`/gsp-typography --enrich`, 2026-10-01)

The faces and roles above are unchanged. This section adds the arithmetic. There are **three scales for three registers**, because one ratio can't serve an airy marketing page, a 13 px instrument table and a module that lives inside someone else's app:

| Register | Surfaces | Base | Ratio | Fluid | Faces |
|---|---|---|---|---|---|
| **Expressive** | marketing, plan view, API docs, deck | 16 px | 1.333 perfect fourth (desktop) → 1.25 major third (mobile) | yes, headings | Newsreader + Plex Sans + Plex Mono |
| **Productive** | Bearing dashboard | 13 px | 1.125 major second | no | Plex Sans Condensed + Plex Mono |
| **Embedded** | partner embed | the partner's `1em` | 1.2 minor third | no, container queries | the partner's font, plus Plex Mono or the partner's mono |

The grid unit is **4 px** everywhere. Every line height is a multiple of 4 at its endpoints.

## 1. Expressive scale (marketing, plan view, docs)

The size at step *n* is `16 × r^n`, rounded to the nearest 0.5 px. Headings interpolate between 375 px and 1280 px viewports: `slope = (desktop − mobile) / 905`, `intercept = mobile − slope × 375`. The min and max are always rem, never bare vw (WCAG 1.4.4), and max ÷ min is at most 1.38, well under the 2.5 zoom limit.

Below the base, the ratio drops to **1.125**, a hybrid scale. At 1.333, caption would be 9 px, under the 12 px floor.

| Level | Face · weight | Mobile px | Desktop px | font-size | Line height (mobile → desktop) | Tracking |
|---|---|---|---|---|---|---|
| **display** | Newsreader 400 | 49 | 67.5 | `clamp(3.0625rem, 2.5834rem + 2.0442vw, 4.2188rem)` | 56 → 76 (1.1) | −0.015em |
| **h1** | Newsreader 400 (500 for short headlines) | 39 | 50.5 | `clamp(2.4375rem, 2.1397rem + 1.2707vw, 3.1562rem)` | 48 → 60 (1.15) | −0.01em |
| **h2** | Plex Sans 600 (marketing section head: Newsreader 500) | 31 | 38 | `clamp(1.9375rem, 1.7562rem + 0.7735vw, 2.3750rem)` | 40 → 48 (1.2) | −0.015em |
| **h3** | Plex Sans 600 | 25 | 28.5 | `clamp(1.5625rem, 1.4719rem + 0.3867vw, 1.7812rem)` | 32 → 36 (1.25) | −0.01em |
| **h4** | Plex Sans 500 | 20 | 21.5 | `clamp(1.2500rem, 1.2112rem + 0.1657vw, 1.3438rem)` | 28 (1.3) | −0.005em |
| **body-lg** | Plex Sans 400 | 18 | 18 | `1.125rem` | 28 (1.5) | 0 |
| **body** | Plex Sans 400 | 16 | 16 | `1rem` | 24 (1.5) | 0 |
| **body-sm** | Plex Sans 400 | 14 | 14 | `0.875rem` | 24 (1.5) | 0.01em |
| **caption** | Plex Sans 500 | 12.5 | 12.5 | `0.78125rem` | 20 (1.4) | 0.015em |
| **label-mock** | Plex Mono 500, uppercase | 12.5 | 12.5 | `0.78125rem` | 20 | 0.08em |
| **source** | Plex Mono 400 | 13 | 13 | `0.8125rem` | 20 | 0 |

Fluid line heights for the headings, so leading tracks size between the two grid-snapped endpoints:

```
--lh-display: clamp(3.5rem, 2.9820rem + 2.2099vw, 4.75rem);
--lh-h1:      clamp(3rem,   2.6892rem + 1.3260vw, 3.75rem);
--lh-h2:      clamp(2.5rem, 2.2928rem + 0.8840vw, 3rem);
--lh-h3:      clamp(2rem,   1.8964rem + 0.4420vw, 2.25rem);
```

**Deviations from the default curve, and why:**
- **Newsreader is tracked less** (−0.015em, not −0.025em). At opsz 36–72 it already spaces tightly, and its bracketed wedge serifs collide sooner than a grotesk's terminals do.
- **No overline level.** The brand is sentence case. The only uppercase setting is `label-mock`, used for the word MOCK.
- **body-lg is held at 18 px.** Body steps stay fixed, and the desktop value (18.5) isn't worth a fluid rule.
- **Weights stay within the creative director's limits.** Newsreader is 400 or 500 and never bold. Plex Sans peaks at 600. Nothing is light.

**Serif budget.** `display` or `h1` in Newsreader appears **once per screen**: the goal sentence on the plan view, the hero on marketing. On marketing only, `h2` may be Newsreader 500 for a section headline, one per viewport-height section. In product UI and docs, `h2` is always Plex Sans 600.

**Measure.**
- Body copy: `max-inline-size: 66ch`.
- Docs prose column: `72ch`.
- Display: `max-inline-size: 18ch`.
- Write EN headlines to about 80% of that measure, so PT and ES fit without stepping down a size.

## 2. Productive scale (Bearing dashboard)

The base is 13 px, the body size of a Bearing table. The size at step *n* is `13 × 1.125^n`. The scale is fixed, with no clamp: Bearing is a desktop instrument, and the table should not reflow its type as the window narrows. Line heights snap to the 4 px grid.

| Level | Face · weight | px | rem | Line height | Use |
|---|---|---|---|---|---|
| **b-kpi** | Plex Mono 500 | 23.5 | 1.4688 | 32 | headline metric in a tile (e.g. `$1.2M`) |
| **b-title** | Plex Sans 600 | 21 | 1.3125 | 28 | view title, e.g. "Depth by hour" |
| **b-section** | Plex Sans 600 | 16.5 | 1.0313 | 24 | panel heading |
| **b-emph** | Plex Sans Condensed 500 | 14.5 | 0.9063 | 20 | selected row, tile label |
| **b-cell** | Plex Sans Condensed 400 · values Plex Mono 400 | 13 | 0.8125 | 20 | table cells |
| **b-head** | Plex Sans Condensed 500 | 12 | 0.75 | 16 | column headers, axis labels (step −1 is 11.5, floored to 12) |
| **b-meta** | Plex Mono 400 | 12 | 0.75 | 16 | `n=412 · method v1.3 · Sun 03:00 UTC` |

- **Row rhythm:** a dense row is 28 px (20 px line + 4 px block padding top and bottom), and a comfortable row is 32 px. Hairline rules sit on the row boundary, not inside the padding.
- **Heatmap cells (24 × 7):** labels only, set in `b-head`. Cell values go in the tooltip, set in `b-cell` mono. No text sits on the lattice itself.
- **Dark ground (the default):** apply `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale` on dark only. Plex has no GRAD axis, so 400 stays at 400 on dark. Do not drop to 300 to compensate.
- **The Bearing landing page** is marketing, so it uses the expressive scale.

## 3. Embedded register (partner embed)

The brand recedes, and so does its scale. The embed sets no root size and loads **no Newsreader and no Plex Sans**. Every size is in `em` from the partner's own text size at the module root, on a gentle 1.2 ratio, so the module sits inside the partner's hierarchy rather than on top of it:

| Token | Value | Use |
|---|---|---|
| `--tf-e-title` | `1.44em` | module title (partner font, partner heading weight) |
| `--tf-e-lead` | `1.2em` | goal sentence (partner font, *not* the serif) |
| `--tf-e-body` | `1em` | body, disclaimer |
| `--tf-e-small` | `0.8333em` | secondary, provenance line |
| `--tf-e-credit` | `max(0.6944em, 11px)` | "Powered by tenonfi" only |

- **Fonts:** `font-family: inherit` for everything except provenance. Provenance uses `var(--tf-mono, "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)`, where the partner sets `--tf-mono` to refuse Plex.
- **Line height:** `1.5` unitless for body and `1.25` for the title, so it inherits cleanly from any root.
- **Container queries, not viewport:**
  - Below `@container (inline-size < 360px)`, the title drops to `1.2em` and the plan callouts stack.
  - The module's container is `container-type: inline-size`.
- **The 11 px credit floor** is the only text under 12 px in the system. It is allowed because the credit carries no information the user must act on. The disclaimer is never set smaller than `1em`.

## 4. Figures

Numbers are the product, so figures get their own rules. All of them are set in CSS and enforced in the component, not left to the font defaults.

```css
/* Product UI (plan view, docs, Bearing): every Plex Sans number is tabular and lining */
.tf-app { font-variant-numeric: lining-nums tabular-nums; }

/* Running prose in Newsreader on marketing pages: old-style, proportional, if the face ships onum */
.tf-prose-serif { font-variant-numeric: oldstyle-nums proportional-nums; }

/* Any number carrying a pin, anywhere (including serif contexts): always tabular lining */
.tf-figure { font-variant-numeric: lining-nums tabular-nums; font-feature-settings: "tnum" 1, "lnum" 1; }

/* Numeric table columns */
td[data-numeric], th[data-numeric] { text-align: end; font-variant-numeric: tabular-nums; }
```

- **Fixed decimals per column.** The formatter, not the font, aligns decimals: `Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.
  - Yields always carry 2 decimals. USD amounts carry 0 or 2, by column.
  - With tabular figures and right alignment, decimal points line up without `text-align: "."`.
- **Locale:** let `Intl` place separators. EN `9.10%`, pt-BR `9,10%`, es `9,10 %`.
  - A tabular comma and point have equal width in Plex, so columns stay aligned across locales.
  - Never hard-code the `%` spacing.
- **The pin glyph** follows a yield figure at cap height. Size it `block-size: 1cap; inline-size: 1cap; vertical-align: baseline` (the `cap` unit ships in all current engines). Fallback: `0.7em`. Put a thin no-break space (U+202F) between the figure and the glyph so they never wrap apart.
- **Signs:** use a true minus (U+2212) for negative deltas, not a hyphen. It has the tabular width of the plus.
- **Bearing values** are in Plex Mono, which is inherently fixed-pitch, so no feature is needed. Plex Sans Condensed figures in cells still get `tabular-nums` from `.tf-app`.
- **Hashes and addresses** (Plex Mono): truncate in the middle (`5Hk3…9xQa`), never at the end. Keep the full value in `title` and copy-to-clipboard.

## 5. Vertical rhythm

The 24 px body line is the rhythm unit for the expressive register (`1rlh` on a 16/24 root). The 20 px cell line is the unit for Bearing.

| Token | px | Expressive lines | Bearing lines |
|---|---|---|---|
| `--space-1` | 4 | 1/6 | 1/5 |
| `--space-2` | 8 | 1/3 | 2/5 |
| `--space-3` | 12 | 1/2 | 3/5 |
| `--space-4` | 16 | 2/3 | 4/5 |
| `--space-5` | 24 | 1 | — |
| `--space-6` | 32 | 4/3 | — |
| `--space-7` | 48 | 2 | — |
| `--space-8` | 64 | 8/3 | — |
| `--space-9` | 96 | 4 | — |

Spacing rules:
- **Paragraphs:** `margin-block: 0 1lh`.
- **Heading space:** a heading gets `margin-block: 2rlh 0.5rlh`. That is more above than below, so it binds to its own section.
- **Plan view stack:** the goal sentence (display), then `--space-5`, then answer → reason → risk lines (body-lg, `0.5rlh` apart), then `--space-7`, then the plan drawing.
- **Trim headings:** apply `text-box: trim-both cap alphabetic` to headings, as progressive enhancement. It removes Newsreader's half-leading, so the goal sentence's cap line sits on the grid. Without support, the 4 px grid still holds.
- **Text spacing (WCAG 1.4.12):** no fixed heights on text containers and no clipped overflow. Bearing rows use `min-block-size`, not `height`, so a 1.5× line-height override grows the row instead of clipping it.

Wrapping: `h1, h2, h3, .display { text-wrap: balance }` and `p, li { text-wrap: pretty }`.

## 6. Font loading (Next.js, self-hosted via Fontsource)

```bash
pnpm add @fontsource-variable/newsreader @fontsource/ibm-plex-sans @fontsource/ibm-plex-sans-condensed @fontsource/ibm-plex-mono
```

| Face | Package / file | Axes or weights | Loaded on |
|---|---|---|---|
| Newsreader | `@fontsource-variable/newsreader/opsz.css` | wght 200–800 + opsz 6–72, upright only (no `opsz-italic.css`) | marketing and plan-view routes |
| Plex Sans | `@fontsource/ibm-plex-sans/{400,500,600}.css` | 400, 500, 600 | app, docs, marketing |
| Plex Sans Condensed | `@fontsource/ibm-plex-sans-condensed/{400,500}.css` | 400, 500 | Bearing only |
| Plex Mono | `@fontsource/ibm-plex-mono/{400,500}.css` | 400, 500 | everywhere, embed included (if the partner allows) |

**Subsets.** The default Fontsource CSS files declare each subset as its own `@font-face` with a `unicode-range`:
- `latin` and `latin-ext` are both always declared. Do **not** switch to the `latin-400.css` per-subset files, which would drop latin-ext.
- The browser fetches latin-ext only when a glyph needs it. The core PT/ES set (ã õ ç ñ á é í ó ú ü ¿ ¡ ª º) sits in Latin-1, which Fontsource's `latin` file covers along with `U+2000-206F` punctuation, `€` and the minus sign `U+2212`.
- latin-ext (`U+0100-02BA`, `U+20A0-20C0`, and more) is what catches the rest: partner, person and place names (ł, ő, ğ), user-typed goal text, and currency signs such as ₿ and ₫.
- Treat latin-ext as **required**, because user and partner text is unbounded. It costs nothing until a glyph calls for it.
- Fontsource also declares Cyrillic, Greek and Vietnamese ranges. These never download for EN/PT/ES, so leave them.

**Where to import (App Router):** import per route group, so each surface pays only for its faces.

```ts
// app/layout.tsx — the shared minimum
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

// app/(marketing)/layout.tsx and app/plan/layout.tsx
import "@fontsource-variable/newsreader/opsz.css";

// app/bearing/layout.tsx
import "@fontsource/ibm-plex-sans-condensed/400.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";

// embed bundle: Plex Mono 400 only, and only when the partner opts in (the --tf-mono default)
```

**Display strategy:**
- Fontsource ships `font-display: swap`, which is right for Plex body and UI text.
- Newsreader is the one face where a late swap is visible: the goal sentence reflows. Two fixes, both needed:
  1. **A metric-matched fallback.** Generate `size-adjust`, `ascent-override`, `descent-override` and `line-gap-override` for a local Georgia fallback with `@capsizecss/metrics` (or `fontaine`) at build time. Do the same for Plex Sans against Arial. Do not hand-type these numbers. The script writes them to `fallbacks.css`.
  2. Set Newsreader to `font-display: fallback` (100 ms block, then commit to the fallback if late) by overriding its `@font-face` locally, or accept `swap` once the matched fallback holds the layout.
- **Preload:** Next can't preload bundled Fontsource URLs, which are hashed. If Lighthouse shows Newsreader late on the marketing hero, copy `newsreader-latin-opsz-normal.woff2` to `public/fonts/` in a postinstall step and add one `<link rel="preload" as="font" type="font/woff2" crossorigin>` on marketing routes only. Preload nothing else.

**Font stacks:**

```css
:root {
  --font-display: "Newsreader Variable", "Newsreader Fallback", Georgia, "Times New Roman", serif;
  --font-sans: "IBM Plex Sans", "Plex Sans Fallback", system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  --font-sans-condensed: "IBM Plex Sans Condensed", "IBM Plex Sans", "Arial Narrow", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.display, .h1-serif { font-family: var(--font-display); font-optical-sizing: auto; font-style: normal; }
```

`font-optical-sizing: auto` maps opsz to the rendered px. The goal sentence at 39–67.5 px lands in the Display optical range (36–72) the creative director chose. If Newsreader is ever set below 36 px, which only the marketing `h2` at mobile size does (31 px), pin it with `font-variation-settings: "opsz" 36` so the wedge serifs stay cut rather than softening into Text forms.

**Budget** (latin + latin-ext, woff2, approximate):
- App routes: Plex Sans ×3 + Plex Mono ×2, about 5 latin files at about 20–25 KB each.
- Marketing adds the Newsreader variable file, the largest single file. Check its size against the 150 KB variable budget after install.
- Bearing adds 2 Condensed files.
- Embed: 0–1 files.

**To check after install:** whether `@fontsource-variable/ibm-plex-sans` now exposes a `wdth` axis (IBM shipped a variable Plex Sans). If it does, Condensed becomes `font-stretch: 85%` on one file, replacing two families, and only the import list changes.

## 7. Tailwind v4 tokens (for `/gsp-brand-guidelines`)

```css
@theme {
  --font-display: "Newsreader Variable", "Newsreader Fallback", Georgia, serif;
  --font-sans: "IBM Plex Sans", "Plex Sans Fallback", system-ui, Arial, sans-serif;
  --font-condensed: "IBM Plex Sans Condensed", "IBM Plex Sans", "Arial Narrow", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;

  --text-display: clamp(3.0625rem, 2.5834rem + 2.0442vw, 4.2188rem);
  --text-display--line-height: clamp(3.5rem, 2.9820rem + 2.2099vw, 4.75rem);
  --text-display--letter-spacing: -0.015em;
  --text-h1: clamp(2.4375rem, 2.1397rem + 1.2707vw, 3.1562rem);
  --text-h1--line-height: clamp(3rem, 2.6892rem + 1.3260vw, 3.75rem);
  --text-h1--letter-spacing: -0.01em;
  --text-h2: clamp(1.9375rem, 1.7562rem + 0.7735vw, 2.375rem);
  --text-h2--line-height: clamp(2.5rem, 2.2928rem + 0.8840vw, 3rem);
  --text-h2--letter-spacing: -0.015em;
  --text-h3: clamp(1.5625rem, 1.4719rem + 0.3867vw, 1.7812rem);
  --text-h3--line-height: clamp(2rem, 1.8964rem + 0.4420vw, 2.25rem);
  --text-h3--letter-spacing: -0.01em;
  --text-h4: clamp(1.25rem, 1.2112rem + 0.1657vw, 1.3438rem);
  --text-h4--line-height: 1.75rem;
  --text-body-lg: 1.125rem;   --text-body-lg--line-height: 1.75rem;
  --text-body: 1rem;          --text-body--line-height: 1.5rem;
  --text-body-sm: 0.875rem;   --text-body-sm--line-height: 1.5rem;   --text-body-sm--letter-spacing: 0.01em;
  --text-caption: 0.78125rem; --text-caption--line-height: 1.25rem;  --text-caption--letter-spacing: 0.015em;
  --text-source: 0.8125rem;   --text-source--line-height: 1.25rem;

  /* Bearing (productive) */
  --text-b-kpi: 1.4688rem;     --text-b-kpi--line-height: 2rem;
  --text-b-title: 1.3125rem;   --text-b-title--line-height: 1.75rem;
  --text-b-section: 1.0313rem; --text-b-section--line-height: 1.5rem;
  --text-b-emph: 0.9063rem;    --text-b-emph--line-height: 1.25rem;
  --text-b-cell: 0.8125rem;    --text-b-cell--line-height: 1.25rem;
  --text-b-head: 0.75rem;      --text-b-head--line-height: 1rem;
}
```

Bearing's `b-meta` reuses the `b-head` size (12/16) in `--font-mono`, so it has no token of its own.

---

## Related

- [Brand applications](./brand-applications.md): where each register applies
- [Color system](./color-system.md): contrast for `stone` captions and the dark Bearing ground
- [Logo directions](./logo-directions.md): the logotype is outlined artwork, outside this scale
