# Typography
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01 | Rewritten 2026-10-08 on `IDENTITY-2` (docs/GATES.md)

**Two families, three roles, all free (OFL), all with Latin Extended** for EN, PT and ES (ã õ ç ñ á é í ó ú ü ¿ ¡ ª º). All ship from Google Fonts or self-hosted.

**The display face states, the UI face explains, the mono cites.** There is no serif in the product: the Oct 1 system spent Newsreader once per screen for "the answer to a person", and on screen it read as a literary magazine, not a product. Warmth now comes from the words, the honey and the photography, not from a typeface.

---

## Display and numbers: **Inter Tight** 600

**Why:** a tight grotesk reads as product, not as editorial. Inter Tight is Inter with the spacing closed up, so headlines and big numbers sit dense and confident, and the whole page stays one family. Weight 600 only (500 for the stacked wordmark's companions); never 700 or above, never light.

- **Tracking:** −0.02 em on headings, −0.025 em on display. Big numbers −0.02 em.
- **Use:** every heading, the goal card amount (`figure-lg`, 28 px), Bearing KPIs (`b-kpi`, 22 px), the wordmark (outlines, see logo-directions.md), video title cards.
- **Never:** body copy, labels, buttons, table cells.

## UI and body: **Inter** 400 / 500 / 600

**Why:** the category's face, and that is the point: Mariana and Rafael should feel at home in the product register before they notice the brand. Inter has tabular figures, a true minus, latin-ext and `opsz`. We are ownable through honey, the mark and the words, not through a quirky sans.

- **Weights:** 400 body, 500 labels and nav, 600 buttons, emphasis and row leads.
- **Figures:** `font-variant-numeric: lining-nums tabular-nums` in all UI; `slashed-zero` in Bearing.
- **Case:** sentence case. Uppercase only for captions and column heads at 11–12 px with +0.04 em. The word MOCK never appears in the UI (gate `MOCK-QUIET`): sample data is marked by the quiet line "Sample figures".

**If Inter feels too generic later:** Geist + Geist Mono, same rules, one swap in the tokens.

## Provenance, code, data: **IBM Plex Mono** 400 / 500

- Provenance lines (`source · fetched_at · method`), explorer hashes, dimension values on drawings, API docs code.
- The one face kept from Oct 1: its slab rhythm beside Inter reads as *cited*, and the pairing is distinct from Inter + Inter Mono.

---

## Scales (from `patterns/working-brand.yml`)

### Expressive (marketing, plan view, API docs): 16 px base

| Style | Face | Weight | Size | Line height | Tracking |
|---|---|---|---|---|---|
| display | Inter Tight | 600 | clamp(2.75rem, 2.2rem + 2.2vw, 4rem) | 1.05 | −0.025em |
| h1 | Inter Tight | 600 | clamp(2.125rem, 1.8rem + 1.3vw, 2.875rem) | 1.1 | −0.02em |
| h2 | Inter Tight | 600 | clamp(1.625rem, 1.45rem + 0.8vw, 2.125rem) | 1.15 | −0.02em |
| h3 | Inter Tight | 600 | clamp(1.25rem, 1.15rem + 0.4vw, 1.5rem) | 1.25 | −0.015em |
| h4 | Inter | 600 | 1.125rem | 1.5rem | −0.01em |
| body-lg | Inter | 400 | 1.125rem | 1.75rem | 0 |
| body | Inter | 400 | 1rem | 1.5rem | 0 |
| body-sm | Inter | 400 | 0.875rem | 1.375rem | 0 |
| caption | Inter | 500 | 0.75rem | 1rem | +0.04em, uppercase |
| figure-lg | Inter Tight | 600 | 1.75rem | 2rem | −0.02em |
| sample-line | Inter | 400 | 0.78125rem | 1.25rem | 0 ("Sample figures · test network", muted, once per card) |
| source | Plex Mono | 400 | 0.8125rem | 1.25rem | 0 |

### Productive (Bearing): 13 px base, fixed

| Style | Face | Weight | Size | Line height |
|---|---|---|---|---|
| b-kpi | Inter Tight | 600 | 1.375rem | 1.75rem |
| b-title | Inter Tight | 600 | 1.25rem | 1.75rem |
| b-section | Inter | 600 | 0.9375rem | 1.5rem |
| b-emph | Inter | 600 | 0.8125rem | 1.25rem |
| b-cell | Inter | 400 | 0.8125rem | 1.25rem |
| b-head | Inter | 500 | 0.6875rem | 1rem (uppercase, +0.05em) |
| b-meta | Plex Mono | 400 | 0.75rem | 1rem |
| b-delta | Inter | 500 | 0.6875rem | 1rem |

Rows are 36 px (20 px line + 8 px padding each side). Values tabular; deltas signed and coloured by direction beneath the value.

### Embedded (partner embed): the partner's font, em-relative

e-title 1.44em · e-lead 1.2em · e-body 1em (the disclaimer never smaller) · e-small 0.8333em · e-credit max(0.6944em, 11px).

### Measure

Body 66ch · docs 72ch · display 16ch.

---

## Rules

- **Every number carries a pin** at cap height, with a U+202F thin no-break space before it; the pin is sized to the figure's cap height.
- **True minus** (U+2212) for negatives, `Intl` formatting, two decimals on yields, one on capacities.
- **Line heights snap to 4 px.** The 4 px grid holds everywhere.
- **Flush left, ragged right.** Centred only on video title cards and the stacked lockup's companions.
- **`text-wrap: balance`** on headings, `pretty` on paragraphs.
- **Dark mode:** `-webkit-font-smoothing: antialiased` on night grounds.

## Loading

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```

In `apps/web`: `next/font/google` for Inter Tight, Inter and IBM Plex Mono, exposed as `--font-display`, `--font-sans`, `--font-mono` (token-mapping.md). Subsets `latin`, `latin-ext`.

---

## Related
- [color-system.md](./color-system.md) · [logo-directions.md](./logo-directions.md) · [../patterns/working-brand.yml](../patterns/working-brand.yml)
