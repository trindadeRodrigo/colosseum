# Goal showcase case (marketing)
> Type: custom | Component: `<ShowcaseCase>` | Source: landing prototype `.case` (Mariana / trip fund, Diego / mountain season) | Revised 2026-10-08 (honey on night)

A sample person, their goal in their own words, and the plan cut for it: photo + prompt + plan panel (sheet chips, KPIs, chart, legs, exit line) + the sample marking. It shows *the same pieces fit differently for different people*. **Everything in it is sample.**

## Anatomy

```
┌──────────────────────┬────────────────────────────────────────────────────┐ 1px --border, 10px radius, bg --card
│ [photo]              │ Trip fund · Jan–Mar 2029                            │ pane head: Inter 600 18px + sub (muted)
│                      │ Low risk · reachable in 1 day · income, so no stocks│
│                      │ [target: $1,000/mo × 3] [horizon: 27 months] …     │ sheet chips (6px tags, mono 12px) = the constraint sheet
├──────────────────────┤ ┌ you save ┬ for ┬ earned on top ┬ odds of funding ┐│ KPI strip (card.md stat cells, Inter Tight 600)
│ Mariana · 31 · USDC  │ │ $1,029/mo│ 27 m│ $1,212 ⊡▨     │ 97% est.        ││
│ "I want a savings    │ └──────────┴─────┴───────────────┴─────────────────┘│
│ plan I can reach any │ [chart: honey base case + curve-fill, payout dashed]│
│ day, that pays …"    │ [plan legs: direct labels, weight, rate ⊡▨]        │ plan-leg.md
│                      │ ┃ Exit plan · whole balance within a day …         │ exit-plan-line.md
│                      │ sample rates, not live ⊡▨ · DISCLAIMER_SHORT       │ pane foot (mono 12px)
└──────────────────────┴────────────────────────────────────────────────────┘
```

Grid: 5 / 7 columns (≥ 980px), stacked below. One case per row, 32px between cases.

## Parts

1. **Photo column**: `<img>` cover, no filter, no scrim. **The prompt sits on a solid plate below the photo**, not on it: `who` line (Plex Mono 12px, `--tf-honey-text`) + the quote (Inter Tight 600, 20–23px, −0.015em, typographic quotes). No serif. Photo credit / "placeholder · generated" as a caption under the image in Plex Mono 12px (not overlaid).
2. **Pane head**: title (Inter 600 18px), sub-line muted, the case keeps a 6px hatched left edge (frame placement); no badge (gate MOCK-QUIET).
3. **Sheet chips**: the constraint sheet in compact form, `key: value`, Plex Mono 12px, `bg-muted`, 1px `--border`, **6px radius** (tags, not pills: they are not interactive). Not interactive.
4. **KPI strip**: [card.md](./card.md) stat cells joined by hairlines; values in Inter Tight 600 (`text-figure-lg` at ≥ 980px, `text-b-kpi` below); 4 columns, 2×2 below 620px. Rates, prices and anything derived from yields ("earned on top") carry a hatched pin; estimates say "estimate" in the unit slot. Odds are labelled "estimate", never "chance to win".
5. **Chart**: SVG, `currentColor` + tokens. Base case honey 2px with `curve-fill` beneath (solid = base/measured); payouts, stresses and range edges dashed in `--muted-foreground` / `--destructive`; the target line dashed `--foreground`; "today" a dashed chalk line with a Plex Mono label. Direct labels at line ends. `role="img"` + `aria-label` summary, plus a visually hidden data table.
6. **Legs**: [plan-leg.md](./plan-leg.md) in label-list form (weight + why), honey family + one neutral.
7. **Exit line**: [exit-plan-line.md](./exit-plan-line.md), with "Sourced live after you connect." in muted.
8. **Pane foot**: hairline top; "sample rates, not live" + hatched pin glyph; `DISCLAIMER_SHORT` on the right. The full [disclaimer block](./disclaimer-block.md) sits once below the showcase section.

## Data rules

- All figures come from `fixtures/showcase/*.json` with `"provenance": "mock"` and `source`/`fetched_at`/`method` fields (e.g. `source: "sample"`, `method: "illustrative weights v1"`). **No rate literals in components** (the prototype's in-script `sampleRate` values move to fixtures; the repo's yield-literal test enforces this).
- **Income cases never include tokenized stocks (xStocks).** The Mariana case (income) has no equity leg, and its sub-line says so. Only growth/high-risk cases (Diego) may show xStocks, sized to Bearing.
- The showcase never claims returns: "earned on top" is labelled sample; no "earn up to".

## Prototype deltas (the `.yml` wins)

| Prototype | Spec |
|---|---|
| Prompt text on the photo over a `linear-gradient` scrim | Prompt on a solid plate below the photo (no text on photographs, no gradient scrims; the glow is the only gradient and sits behind heroes, not on photos) |
| `photo-src` label overlaid on the photo | Caption below the image |
| `filter: saturate(.9) contrast(1.02)` | No filter (unmodified photography; no duotones) |
| `.mock` = text on hatch with a background span | The case's hatched edge + the muted foot line "sample rates, not live" ([mock-plate.md](./mock-plate.md), gate MOCK-QUIET) |
| `.pin` = 7px hatched circle | The square-pin glyph in its sample state (hatched, no pin, "sample figure") |
| Eyebrow "TWO GOALS · TWO CUTS" uppercase | A caption eyebrow (12px uppercase is allowed for eyebrows) or sentence case Plex Mono; no all-caps word in running text |
| Serif prompt quote | Inter Tight 600 |
| Brown wood legs | Honey-family legs with 2px gaps and pill ends |
| Legend swatches beside the chart | Direct labels at line ends + the leg list |
| "Simulation. Not investment advice." | `DISCLAIMER_SHORT` here + full `DISCLAIMER` block under the section |
| Dark only | Light ships too (paper ground, white case) |

## Accessibility

`<article aria-labelledby>` per case; photo `alt` describes the scene (not the person's finances); chart has text alternative; KPI values in text. Contrast: all text ≥ 4.5 on `--card` in both modes (ink 18.05 on white, text 16.15 on night-2; muted-l 5.16, muted 6.77); the honey base-case line is 1.99 on white and 9.16 on night-2, so on light the chart's data are also in the hidden table and the direct labels are in `--foreground`.

## Do / don't

| Do | Don't |
|---|---|
| A hatched edge and "sample rates, not live" on every case, hatched pins on every rate | One "sample data" note at the bottom of the page |
| Prompt in the person's words, Inter Tight, on a solid plate | Overlaying text on the photo |
| Rates from fixtures with provenance | Rates typed into the JSX |
