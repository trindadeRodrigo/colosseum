# Bearing heatmap tile
> Type: custom | Component: `<DepthHeatmap>` inside a `<BearingTile>` | Surface: Bearing dashboard (dark default; light ships too) | Data: `DepthObservation` from `scripts/depth-snapshot.ts` | Revised 2026-10-08 (honey on night)

The hour-of-week depth heatmap as a lattice (24 × 7): how much of an xStock can be sold at ≤ X% impact, by hour, measured. It is the instrument drawn as a drawing.

## Tile anatomy (all Bearing tiles)

```
┌──────────────────────────────────────────────────────────────┐ night-2 on night, 1px line, 10px radius, 16px padding
│ XAAPL · SELLABLE AT ≤ 2% IMPACT                               │ b-head: Inter 500 11px uppercase +0.05em, muted
│ $1.2M ⊡  +4.2%                                               │ b-kpi: Inter Tight 600 22px, text, + pin (thinnest hour) + b-delta (signed)
│ thinnest: Sun 03:00 UTC                                      │ b-emph: Inter 600 13px
│ ┌─┬─┬─┬─ … 24 cols ─┐                                          │
│ Mon│▒│▓│█│…                                                   │ heatmap lattice
│ …  7 rows                                                     │
│ └───────────────────┘                                         │
│ 0 ▕░▒▓█▏ $2.5M   – no sample                                  │ scale: 5-step ramp with Plex Mono end values
│ USD · n=412 · method v1.3 · as of 2026-10-08 14:00 UTC        │ b-meta: Plex Mono 12px, muted
└──────────────────────────────────────────────────────────────┘
```

Light mode: white tiles on paper, line-l edges, ink text, muted-l meta; the same geometry.

## Heatmap

- **Grid**: CSS grid 24 columns × 7 rows, cells square (min 12px, ideal 16px), separated by 1px hairlines (`--border`), inside a 6px-radius frame. Row labels Mon–Sun (b-head), column labels every 3 hours (00, 03 … 21 UTC, b-meta).
- **Ramp**: 5 steps, the honey family by lightness, `--tf-heat-1…5`. **Dark**: night-3 `#1A1D26` → `#5C3707` → `#B06C12` → honey `#F5A83A` → `#FFE9C2` (more depth = lighter, more contrast against night). **Light**: reversed (`#FFE9C2` → … → `#1A1D26`). Bins are quantiles of the snapshot window, stated in the method.
- **No-sample cells**: card colour with a centred en dash in `--muted-foreground` and "– no sample" in the scale. **Not hatched**: the hatch means sample or stale only.
- **Stale snapshot** (older than the cron interval × 2): 6px hatched left edge + "stale · 9 h" as the tile's b-meta line (no box); KPI pin hollow.
- **Sample** (`mock`, `fixture`, `prior_dataset`): the tile keeps its 6px hatched left edge and says so once in the b-meta slot, muted, no box: "Sample figures" ("Sample figures · test network" for `sandbox`); the KPI pin is hatched with `aria-label="sample figure"`. No MOCK badge (gate MOCK-QUIET, [mock-plate.md](./mock-plate.md)).
- **Delta**: the KPI carries a signed b-delta against the previous snapshot (leaf up, madder down, muted flat, true minus). Never a status tint on the tile.
- **Cell interaction**: each cell is focusable via roving tabindex (arrow keys move, one tab stop for the grid). Focus/hover shows a popover (night-3 / white, `shadow-popover`): "Sun 03:00 UTC · $1.2M at ≤ 2% · n=18 · method v1.3 ⊡". Selected cell: 2px chalk outline (`--ring`), the carpenter's line.

## Tokens

`--background` night / paper, `--card` night-2 / white, `--border` line / line-l, `rounded-lg`, `--tf-heat-*`, `--font-display` (KPI), `--font-sans`, `--font-mono`, `--text-b-*`, `--tf-pin*`, `--tf-hatch`, `--ring`.

## Rules

- Every figure (KPI, cell popover, scale ends) carries source · fetched_at · method via the pin. `method` includes the impact threshold and version.
- Not shown for income contexts: Bearing measures xStocks, which income plans never hold. The plan view's exit panel links to Bearing only for non-income plans.
- No bevels, nameplates, LEDs, glow or traffic-light colours (anti-Teiten). The heatmap is honey by lightness, never leaf-to-madder. No animation of cells.
- Dashed = projected: if a forecast row is ever added, its cells use a dashed outline and "projected".
- 13px type, 36px rows in any table beside it ([data-table.md](./data-table.md) dense).

## Accessibility (WCAG 2.2 AA)

- `role="grid"` with `aria-label`, row/column headers (`role="rowheader"`/`columnheader`); each cell's accessible name is the popover sentence.
- A "View as table" toggle renders the same data as a 7-row table (sortable by depth) for screen readers and low-vision users.
- 1.4.11: adjacent ramp steps are separated by hairlines; the scale shows numeric ends, so colour is not the only carrier of value (1.4.1).
- Cell targets ≥ 24px via the hit area when 16px cells are used (grid gap counts toward spacing exception, 2.5.8). The chalk selection ring is 8.24 on night-2.
- KPI text 16.15 on night-2; muted meta 6.77; honey pin 9.16.

## Do / don't

| Do | Don't |
|---|---|
| Lightness ramp in honey | Red-to-green heat colours; leaf, clay or madder in a ramp |
| "n=412 · method v1.3 · as of …" on every tile | A number without its sample size and method |
| Hatch + "stale · 9 h" when the cron is late | Show yesterday's depth as current |
| An en dash for no sample | A hatched "no data" cell |
