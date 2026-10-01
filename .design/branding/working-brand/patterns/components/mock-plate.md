# MOCK plate (hatch + label)
> Type: custom | Component: `<MockPlate>` + `.tf-hatch` | Rule: MOCK = hatch + the word MOCK, together, always

The P4 section hatch is a word, not a texture: it means *not finished timber*. It appears only for **MOCK** and **stale**, and always travels with its word: "MOCK", or "stale · age". This spec covers MOCK; a stale panel or Bearing tile may use the same 6px band with a "stale · 3 h" plate instead of "MOCK" (a stale figure inline uses the hollow pin, not a band). Text never sits on hatch strokes.

## Anatomy

```
┃▨▨┃ ┌──────┐
┃▨▨┃ │ MOCK │  6.40% ⊡▨
┃▨▨┃ └──────┘
 6px   solid plate: Plex Mono 500 12.5px, 0.08em, uppercase, 1px stone border, 0 radius
 hatch band (frame margin or edge)
```

Three parts, never fewer:
1. **Hatch** `.tf-hatch`: `repeating-linear-gradient(45deg, var(--tf-hatch) 0 1px, transparent 1px var(--tf-hatch-pitch-ui))`. 1px strokes, **6px pitch** in UI, 3px inside the pin glyph, 4px in SVG drawings. Colour stone / stone-d (5.08 / 7.10:1: valid as a state indicator alone).
2. **Band**: where the hatch goes. Either a **6px edge band** (left edge of a card, row or leg label) or the **frame margin** of a mocked panel (the 6–8px between the outer frame and an inner solid surface).
3. **Plate**: the label "MOCK" on a solid fill: `--tf-mock-plate` (paper-raised / char), text `--tf-mock-plate-fg` (ink / washi), 1px `--tf-mock-plate-border` (stone / stone-d), radius 0, height 20px, padding 0 6px. The only uppercase word in the system.

## Sizes / placements

| Placement | Treatment |
|---|---|
| `inline` (after a figure) | plate only, 20px, after the hatched pin glyph |
| `badge` (card/pane header) | 6px hatch band immediately left of the plate, both 20px tall |
| `frame` (whole mocked panel or showcase case) | outer 1px border, 8px hatched margin, inner solid `--card` surface carrying all content; plate in the header |
| `row` (table row / plan leg) | 6px hatch band at the row's left edge, plate in the first cell |
| `code` (API docs example) | hatched gutter + `"provenance": "mock"` highlighted + plate |
| Embed | same shape in `--embed-muted` on `--embed-bg` |

## States

There is no hover, active or dismiss state. The plate is not interactive. If the whole view is a simulation (landing showcase, simulator), the plate also appears in each panel header; a page-level notice does not replace per-panel plates.

## Accessibility

- The plate is real text ("MOCK"), read by screen readers; add `<span className="sr-only">: sample data, not live</span>` once per panel.
- Ink on paper-raised 16.78:1; washi on char 14.14:1. **Ink on stone strokes is 3.11:1**, which is why text never sits on the hatch.
- Hatch is `aria-hidden` (CSS background). Forced-colors: hatch disappears, so the plate border uses `CanvasText` and the word remains.

## Enforcement

A DOM test in `apps/web` fails if an element with `.tf-hatch` has no `MockPlate` (or stale pin) in the same component subtree, and if any API payload with `provenance !== "live"` renders without a plate.

## Code hint

```css
.tf-hatch { background-image: repeating-linear-gradient(45deg, var(--tf-hatch) 0 1px, transparent 1px var(--tf-hatch-pitch-ui)); }
.tf-mock-plate { display:inline-flex; align-items:center; height:20px; padding:0 6px; border:1px solid var(--tf-mock-plate-border);
  background:var(--tf-mock-plate); color:var(--tf-mock-plate-fg); font:500 0.78125rem/1.25rem var(--font-mono);
  letter-spacing:.08em; text-transform:uppercase; }
@media (forced-colors: active) { .tf-hatch { background-image:none; border-left:1px dashed CanvasText; } }
```

## Do / don't

| Do | Don't |
|---|---|
| Hatch band **beside** a solid plate | "MOCK" text drawn over hatch with a background span (the landing prototype's `.mock span`) |
| One plate per mocked panel, plus inline plates on mocked figures | A page footer that says "sample data" instead of plates |
| Hatch only for MOCK or stale, each with its word | Hatch as decoration, a section divider, an empty-state fill or a "no data" cell |
| Stone strokes, neutral plate | Amber or yellow "warning" styling for mock |
