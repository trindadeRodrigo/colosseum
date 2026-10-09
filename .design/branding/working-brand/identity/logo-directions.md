# Logo
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01 · Rewritten 2026-10-08 on `LOGO-2` (docs/GATES.md)

**The mark is "the face":** the end view of a pinned through-tenon on a tile. What you see on the outside of a post where a through-tenon comes out: the end grain, and the pin that holds it. Read it as the product: *held, and you can see what holds it.* The provenance pin that follows every figure is this tenon end drawn in line mode, so the brand's smallest element and its largest are one shape.

Picked by Rodrigo on 2026-10-08 from five options drawn on the accepted palette ([logo-options-2.html](./logo-options-2.html)). The three directions of 2026-10-01 (pinned through-tenon elevation, stacked cantilever, the pin as full stop) are retired; the elevation's idea survives only as the provenance pin.

**Brief every drawing of it must meet:** built from honey, the ground and the ground's text colour only; holds at 16 px; recedes to a "Powered by" credit; carries "Bearing" without a second brand; still works as `tenon`.

---

## Construction (master, 32 grid)

Unit **u** = 1/32 of the artboard. Every edge sits on whole or half units.

| Part | Box (x, y · w × h, in u) | Radius | Colour | Relationship |
|---|---|---|---|---|
| **Tile** | 0, 0 · 32 × 32 | 7 | `honey` #F5A83A | The post's face. The tile is part of the mark, not a container |
| **Tenon end** | 7, 10 · 18 × 12 | 2 | `night` #0C0D12 on night; `ink` #15161C on paper and on the honey app tile | 3:2, the proportion the provenance pin inherits. Centred on the tile's y axis; 7u walls left and right, 10u top and bottom |
| **Pin** | 18, 13.5 · 5 × 5 | 1 | `honey` | Square, as a *komisen* pin is. Set toward the end: 11u from the left wall of the tenon end, 2u from its right wall, centred vertically |

- The tenon end is never a knock-out on paper (it would show paper and lose the end grain). It is a fill in the darkest colour present.
- The pin is always the tile's colour. It is the only part that survives into the provenance glyph as a solid.
- Bounding box 32 × 32: the mark is its own app tile.

### Cuts by size (three masters, never auto-scaled across a breakpoint)

| Cut | Render size | Tile | Tenon end | Pin | File |
|---|---|---|---|---|---|
| **Master** | ≥ 28 px, all vector and print | 32, r 7 | 7, 10 · 18 × 12, r 2 | 18, 13.5 · 5 × 5, r 1 | `logo/mark-32.svg`, `mark-32-night.svg` |
| **24 hint** | 20–27 px | 24, r 5 | 5, 7.5 · 14 × 9, r 1.5 | 13.5, 10 · 4 × 4, r 0.75 | `logo/mark-24.svg`, `mark-24-night.svg` |
| **Small cut** | 12–19 px (favicon, tab, "Powered by") | 16, r 4 | 3, 5 · 10 × 6, r 1 | 9, 6.5 · 3 × 3, r 0.6 | `logo/mark-16.svg`, `mark-16-night.svg` |

Below 12 px: text-only "Powered by tenonfi".

### Colour variants

| Variant | Tile | Tenon end | Pin | Use |
|---|---|---|---|---|
| **On night** | honey | night #0C0D12 | honey | App nav, Bearing, video, social avatar |
| **On paper** | honey | ink #15161C | honey | Docs, the plan, light marketing |
| **App tile** | honey, platform mask | ink | honey | `logo/app-tile-1024.svg`. The platform's mask is the only rounding applied |
| **On honey** | ink | honey | ink | Honey grounds only (closing sections, stickers). `logo/mark-32-on-honey.svg` |
| **Monochrome** | `currentColor` | knock-out | `currentColor` | Partner credit, print, engraving. `logo/mark-mono.svg` (inline it so `currentColor` applies) |

Never: white text or a white tile (the mark has no white), a circle pin, a third colour, a gradient, a shadow, a stroke, a tile without the tenon end.

---

## Wordmark

- **Face:** Inter Tight 600, lowercase `tenonfi`, tracking −0.02 em, kerned from the font's pair table. Production uses the outlines in `logo/wordmark.svg` (ink) and `logo/wordmark-night.svg` (text #F3F1EC), instanced from the variable font at wght 600 with fontTools; the live-type versions in HTML are for review only.
- **Fallback:** `tenon`. Same outlines with the `fi` group removed: `logo/wordmark-tenon.svg`, `wordmark-tenon-night.svg`.
- **Colour:** the ground's text colour (text on night, ink on paper). Never honey, never a different colour for `fi`.
- **Never:** title case ("Tenonfi"), caps, italic, a serif, a different sans, letter-spacing other than −2%.

Measurements at size 100: width 305.3, x-height 54.6, cap height 72.8.

---

## Lockups

| Lockup | Spec | File |
|---|---|---|
| **Primary (horizontal)** | Mark height **H = 1.4 × cap height**. Gap = 0.4 × cap. The mark's centre sits 0.52 × cap above the baseline, so it reads level with the lowercase word. Mark on the left | `logo/lockup.svg`, `lockup-night.svg` |
| **Fallback** | Same geometry with `tenon` | `logo/lockup-tenon.svg` |
| **Product: `tenonfi Bearing`** | "Bearing" in Inter 500, scaled so its x-height equals the wordmark's; colour `muted-l` #6A6D78 on paper, `muted` #9A9DAD on night; gap = one word space (0.6 × x-height). Never a separate mark | `logo/lockup-bearing.svg`, `lockup-bearing-night.svg` |
| **Stacked** | Mark above the wordmark, left edges aligned, vertical gap 0.5 × H. Square formats only (social card, slide closer, print) | `logo/lockup-stacked.svg`, `lockup-stacked-night.svg` |
| **"Powered by"** | `Powered by` in the partner's UI font (or Inter 500) in the partner's muted colour, then the 16 px cut and the wordmark outlines at 1.15 × the text size (x-heights match). The mark takes the partner's muted colour (mono variant) or stays honey where the partner allows colour | `logo/powered-by.svg` |
| **Wordmark only** | When the mark is already on screen (app header beside the favicon, footer) | `logo/wordmark*.svg` |

### Clear space and minimums

- **Clear space: 0.25 H on every side**, for every cut and lockup (8 px at 32, 4 px at 16). Lockups measure it from the mark's H around the whole lockup box. In the "Powered by" credit the partner's card padding counts.
- **Minimums:** master mark 28 px (24 hint from 20 px, small cut from 12 px); primary lockup 96 px wide (mark 22 px); `tenonfi Bearing` 140 px wide; "Powered by" 12 px mark, 11 px text, 13 px wordmark; wordmark alone 18 px font size; print: mark 6 mm, lockup 22 mm wide.

---

## Don'ts

- Don't scale the master below 28 px: switch cut.
- Don't round the pin, centre it, or drop it. Don't add a second pin.
- Don't knock the tenon end out on paper or on the honey tile. Don't fill it with a colour other than night or ink.
- Don't put the mark in a circle, in a second tile, or on a photograph.
- Don't set the wordmark in a serif, in title case, or in honey. Don't colour `fi`.
- Don't use the mark as the provenance pin or the pin as the logo: the glyph is line mode (outline + square pin), the logo is fill mode (tile + cut + pin).
- Don't animate it except with the brand motion: the tenon end seats (280–360 ms), then the pin appears (160 ms). Reduced motion: no travel.

---

## Exports

`logo/` holds the masters and the exports:

- SVG: `mark-{32,24,16}.svg`, `mark-{32,24,16}-night.svg`, `mark-32-on-honey.svg`, `mark-mono.svg`, `wordmark.svg`, `wordmark-night.svg`, `wordmark-tenon.svg`, `wordmark-tenon-night.svg`, `lockup.svg`, `lockup-night.svg`, `lockup-tenon.svg`, `lockup-bearing.svg`, `lockup-bearing-night.svg`, `lockup-stacked.svg`, `lockup-stacked-night.svg`, `powered-by.svg`, `app-tile-1024.svg`.
- PNG: `png/mark-{16,32,48,64,128,256,512}.png` (paper variant, ink cut) and `png/mark-{…}-night.png`; `png/lockup@2x.png`, `png/lockup-night@2x.png`; `png/app-tile-1024.png`.
- ICO: `favicon.ico` (16, 32, 48 from the small cut, the 24 hint and the master; paper variant, which also reads on dark tabs because the cut is ink).

Regenerate from `scripts` in this folder's history: the SVGs are written by a Python script from the construction table above and the font outlines; the PNGs by headless Chrome; the ICO packs the PNGs.

---

## The provenance glyph (derived)

The tenon end in line mode: an outline rect in the logo's 3:2 (`viewBox 0 0 18 12`, stroke 1.5, radius 2.5) with the **square pin** set toward the end (4 × 4, radius 1), in honey on night and honey-l on paper; outline in `muted-2` / `line-l2`. Height = cap height of the figure it follows; gap U+202F. Live = solid pin · stale = hollow pin + "stale · 3 h" · sample (mock) = 45° hatch, no pin, named "sample figure", with the card's quiet line "Sample figures" (gate `MOCK-QUIET`) · sandbox = the same line with "test network". Its component spec: `../patterns/components/provenance-pin.md`.

---

## Related
- [identity-reassessment.html](./identity-reassessment.html) (the identity decision, 2026-10-08) · [logo-options-2.html](./logo-options-2.html) (the five options) · [color-system.md](./color-system.md) · [typography.md](./typography.md)
