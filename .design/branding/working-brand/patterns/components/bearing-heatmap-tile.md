# Bearing heatmap tile
> Type: custom | Component: `<DepthHeatmap>` inside a `<BearingTile>` | Surface: Bearing dashboard (dark default; light ships too) | Data: `DepthObservation` from `scripts/depth-snapshot.ts`

The hour-of-week depth heatmap as a P1 lattice (24 × 7): how much of an xStock can be sold at ≤ X% impact, by hour, measured. It is the instrument drawn as a drawing.

## Tile anatomy (all Bearing tiles)

```
┌──────────────────────────────────────────────────────────────┐ char on black, 1px hair-d, 0 radius, 16px padding
│ xAAPL · sellable at ≤ 2% impact                        [MOCK] │ b-head: Plex Sans Condensed 500 12px, stone-d
│ $1.2M ⊡                                                       │ b-kpi: Plex Mono 500 23.5px, washi, + pin (thinnest hour)
│ thinnest: Sun 03:00 UTC                                       │ b-emph
│ ┌─┬─┬─┬─ … 24 cols ─┐                                          │
│ Mon│▒│▓│█│…                                                   │ heatmap lattice
│ …  7 rows                                                     │
│ └───────────────────┘                                         │
│ 0 ▕░▒▓█▏ $2.5M   – no sample                                  │ scale: 5-step ramp with Plex Mono end values
│ USD · n=412 · method v1.3 · as of 2026-10-01 14:00 UTC        │ b-meta: Plex Mono 12px, stone-d
└──────────────────────────────────────────────────────────────┘
```

## Heatmap

- **Grid**: CSS grid 24 columns × 7 rows, cells square (min 12px, ideal 16px), separated by 1px hairlines (`--border`), i.e. the cells sit in a P1 lattice. Row labels Mon–Sun (b-head), column labels every 3 hours (00, 03 … 21 UTC, b-meta).
- **Ramp**: 5 steps, lightness only, `--tf-heat-1…5`. Dark: char → heartwood → `#8A6C4B` → hinoki-deep → `#F2E6D3` (more depth = lighter, more contrast). Light: reversed. Bins are quantiles of the snapshot window, stated in the method.
- **No-sample cells**: ground colour with a centred en dash in `--muted-foreground` and "– no sample" in the scale. **Not hatched**: the hatch means MOCK or stale only (see open items: brand-applications.md said "hatched").
- **Stale snapshot** (older than the cron interval × 2): 6px hatch band on the tile's left edge + plate "stale · 9 h"; KPI pin hollow.
- **MOCK** (fixture or prior dataset): hatch band + MOCK plate in the header, KPI pin hatched.
- **Cell interaction**: each cell is focusable via roving tabindex (arrow keys move, one tab stop for the grid). Focus/hover shows a popover: "Sun 03:00 UTC · $1.2M at ≤ 2% · n=18 · method v1.3 ⊡". Selected cell: 2px `--ring` outline.

## Tokens

`--background` black, `--card` char, `--border` hair-d, `--tf-heat-*`, `--font-condensed`, `--font-mono`, `--text-b-*`, `--tf-pin*`, `--tf-hatch`.

## Rules

- Every figure (KPI, cell popover, scale ends) carries source · fetched_at · method via the pin. `method` includes the impact threshold and version.
- Not shown for income contexts: Bearing measures xStocks, which income plans never hold. The plan view's exit panel links to Bearing only for non-income plans.
- No bevels, nameplates, LEDs, glow or traffic-light colours (anti-Teiten). No animation of cells.
- Dashed = projected: if a forecast row is ever added, its cells use a dashed outline and "projected".

## Accessibility (WCAG 2.2 AA)

- `role="grid"` with `aria-label`, row/column headers (`role="rowheader"`/`columnheader`); each cell's accessible name is the popover sentence.
- A "View as table" toggle renders the same data as a 7-row table (sortable by depth) for screen readers and low-vision users.
- 1.4.11: adjacent ramp steps are separated by hairlines; the scale shows numeric ends, so colour is not the only carrier of value (1.4.1).
- Cell targets ≥ 24px via the hit area when 16px cells are used (grid gap counts toward spacing exception, 2.5.8).

## Do / don't

| Do | Don't |
|---|---|
| Lightness ramp in wood | Red-to-green heat colours |
| "n=412 · method v1.3 · as of …" on every tile | A number without its sample size and method |
| Hatch + "stale · 9 h" when the cron is late | Show yesterday's depth as current |
