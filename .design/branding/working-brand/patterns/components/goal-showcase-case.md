# Goal showcase case (marketing)
> Type: custom | Component: `<ShowcaseCase>` | Source: landing prototype `.case` (Mariana / trip fund, Diego / mountain season)

A sample person, their goal in their own words, and the plan cut for it: the plan drawn as a joint + prompt + plan panel (sheet chips, KPIs, chart, legs, exit line) + MOCK. It shows *the same pieces fit differently for different people*. **Everything in it is MOCK.**

## Anatomy

```
┌──────────────────────┬────────────────────────────────────────────────────┐ 1px --border, 2px radius, bg --card
│ [plan as a joint]    │ Trip fund · Jan–Mar 2029          ▨[MOCK]           │ pane head: h3 Plex Sans 500 18px + sub (muted)
│                      │ Low risk · reachable in 1 day · income, so no stocks│
│                      │ [target: $1,000/mo × 3] [horizon: 27 months] …     │ sheet chips (2px, mono 12px) = the constraint sheet
├──────────────────────┤ ┌ you save ┬ for ┬ earned on top ┬ odds of funding ┐│ KPI strip (card.md stat cells)
│ Mariana · 31 · USDC  │ │ $1,029/mo│ 27 m│ $1,212 ⊡▨     │ 97% est.        ││
│ "I want a savings    │ └──────────┴─────┴───────────────┴─────────────────┘│
│ plan I can reach any │ [chart: stacked balance by leg, payout dashed]     │
│ day, that pays …"    │ [plan legs: direct labels, weight, rate ⊡▨]        │ plan-leg.md
│                      │ ┃ Exit plan · whole balance within a day …         │ exit-plan-line.md
│                      │ sample rates, not live ⊡▨ · DISCLAIMER_SHORT       │ pane foot (mono 12px)
└──────────────────────┴────────────────────────────────────────────────────┘
```

Grid: 5 / 7 columns (≥ 980px), stacked below. One case per row, 32px between cases.

## Parts

1. **Plan column** (gate `PLAN-JOINT`): the case's plan drawn as a joint in the hero's ink (`JOINT-3D`), not a photograph: one post stacked from the plan's parts, each layer as tall as its share and drawn in the part's legend colour (`--chart-1`…`4`), each set on the one below by a tenon whose hidden length is dashed, with a hairline reveal at each joint; a leader from each layer to its share and name in Plex Mono, in one aligned column kept inside the drawing; a long name wraps at a word, never smaller than 12 px on a phone. Outline 1.5 px, other lines 0.85 px. Its parts are read from the same case data as the legend and the chart. The layers come together from a little apart (≈ 1 s) when the card comes into view; never with reduced motion. Each layer is a part the reader can point at (Thom, Oct 6): a mouse over it, a tap, or the keyboard (one tab stop; the arrows step through the layers; Escape lets go) lifts it a few pixels out of the stack, brightens it and dims the rest, and lights the same part in the parts list and in the trip chart's bars; a row of the list lights its layer. With reduced motion only the colours change. No caption. **The prompt sits on a solid plate above the drawing**, not on it: `who` line (Plex Mono 12px, `--primary`) + the quote (Newsreader 400, 20–23px, typographic quotes). This is the case's one serif line.
2. **Pane head**: title (Plex Sans 500 18px), sub-line muted, MOCK badge (6px hatch band + plate) right-aligned.
3. **Sheet chips**: the constraint sheet in compact form, `key: value`, Plex Mono 12px, `bg-muted`, 1px `--border`, 2px radius. Not interactive.
4. **KPI strip**: [card.md](./card.md) stat cells joined by hairlines; 4 columns, 2×2 below 620px. Rates, prices and anything derived from yields ("earned on top") carry a hatched pin; estimates say "estimate" in the unit slot. Odds are labelled "estimate", never "chance to win". In a cell narrower than 12rem a figure's MOCK plate sits under the figure and its pin, so nothing runs past the cell in either language.
5. **Chart**: SVG, `currentColor` + `--chart-*`. Solid = base/measured, dashed = projected payouts, stresses and range edges. Target line dashed `--foreground`. Direct labels at line ends. `role="img"` + `aria-label` summary, plus a visually hidden data table.
6. **Legs**: [plan-leg.md](./plan-leg.md) in label-list form (weight + why).
7. **Exit line**: [exit-plan-line.md](./exit-plan-line.md), with "Sourced live after you connect." in muted.
8. **Pane foot**: hairline top; "sample rates, not live" + hatched pin glyph; `DISCLAIMER_SHORT` on the right. The full [disclaimer block](./disclaimer-block.md) sits once below the showcase section.

## Data rules

- All figures come from `fixtures/showcase/*.json` with `"provenance": "mock"` and `source`/`fetched_at`/`method` fields (e.g. `source: "sample"`, `method: "illustrative weights v1"`). **No rate literals in components** (the prototype's in-script `sampleRate` values move to fixtures; the repo's yield-literal test enforces this).
- **Income cases never include tokenized stocks (xStocks).** The Mariana case (income) has no equity leg, and its sub-line says so. Only growth/high-risk cases (Diego) may show xStocks, sized to Bearing.
- The showcase never claims returns: "earned on top" is labelled sample; no "earn up to".

## Prototype deltas (the `.yml` wins)

| Prototype | Spec |
|---|---|
| Prompt text on the photo over a `linear-gradient` scrim | Prompt on a solid plate below the drawing (no text over the picture, no gradient scrims) |
| `photo-src` label overlaid on the photo | No photograph: the plan drawn as a joint, no caption |
| `filter: saturate(.9) contrast(1.02)` on the photo | No photograph, so no filter |
| `.mock` = text on hatch with a background span | 6px hatch band beside a solid plate ([mock-plate.md](./mock-plate.md)) |
| `.pin` = 7px hatched circle | The J1 pin glyph in MOCK state |
| Eyebrow "TWO GOALS · TWO CUTS" uppercase | Sentence case Plex Mono "Two goals, two cuts" (MOCK is the only all-caps word) |
| Legend swatches beside the chart | Direct labels at line ends + the leg list |
| "Simulation. Not investment advice." | `DISCLAIMER_SHORT` here + full `DISCLAIMER` block under the section |
| Dark only | Light ships too (paper ground, paper-raised case) |

## Accessibility

`<article aria-labelledby>` per case; the drawing's label names each part and its share, as the legend does; chart has text alternative; KPI values in text. Contrast: all text ≥ 4.5 on `--card` in both modes; chart lines ≥ 3:1 against `--card` (wood-400 3.82:1 on paper-raised; dark uses the hinoki legs, all ≥ 3:1 on char).

## Do / don't

| Do | Don't |
|---|---|
| MOCK badge on every case, hatched pins on every rate | One "sample data" note at the bottom of the page |
| Prompt in the person's words, serif, on a solid plate | Overlaying text on the drawing |
| Rates from fixtures with provenance | Rates typed into the JSX |
