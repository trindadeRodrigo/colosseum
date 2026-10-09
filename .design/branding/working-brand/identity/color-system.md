# Color System
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01 | Rewritten 2026-10-08 on `IDENTITY-2` (docs/GATES.md)

**Composition strategy: one brand colour on a cool dark or a warm light ground, with direction colours from daylight.** The brand colour is **honey**, fresh-cut hinoki in sunlight. It is the only warm hue in the chrome, so it owns attention: the primary button, the pin, selection, the base-case line. The dark ground is a cool near-black (a trace of blue), so honey glows instead of sinking; the light ground is warm paper with white cards. Direction colours (**leaf**, **clay**, **madder**) come from the daylight photograph of the timber interior with the forest in the window, and always travel with a word and a shape. **Chalk**, the carpenter's snap line, is a pale blue for lines only. Wood itself leaves the UI chrome and lives in imagery, the 3D joint and the logo's companion tones.

**Why (strategy):** the Oct 1 palette sampled a studio photograph of wood in shadow, so everything was a brown within 1.3:1 of everything else, and the rules banned every tool that makes a screen feel alive. The category's data register (Meteora, measured 2026-10-08: ground #0D0D13, one accent #F54B00 with 16% tints, deltas in green and red) is alive because colour sits in surfaces as tints and in numbers as direction. We take that register and keep our own hue, our warmth, and the product rules.

**The button rule that makes it ours:** honey is light, so the primary button is always **ink on honey**, in both modes. Meteora is white on orange, Jupiter black on lime, Binance black on yellow. Nobody on Solana holds black on honey beside a cool black ground and wood photography.

---

## Core palette

### Dark · "night" (the app, Bearing, the video)

| Role | Token | Hex | Usage | Contrast |
|---|---|---|---|---|
| Ground | `night` | **#0C0D12** | Page | |
| Surface | `night-2` | **#13151C** | Cards, panels, table containers | |
| Raised | `night-3` | **#1A1D26** | Popovers, input wells, selected panels | |
| Hairline | `line` | **#262A36** | Card edges, table rows, dividers | decorative |
| Control edge | `line-2` | **#363B4B** | Inputs, secondary buttons, chip borders | 1.9 on night-2: controls also carry a fill |
| Text | `text` | **#F3F1EC** | Body, headings, numbers | 17.2 on night |
| Muted | `muted` | **#9A9DAD** | Secondary text, column heads, captions | 6.77 on night-2 |
| Muted 2 | `muted-2` | **#6E7282** | Placeholders, the pin's outline, dimension lines | 3.9 on night-2: large or non-text only |
| **Brand** | `honey` | **#F5A83A** | Primary button fill, the pin, selection, the base-case line, links | 9.75 on night; **ink on honey 9.06** |
| Brand hover | `honey-hover` | **#E99C2E** | Primary hover | |
| Brand pressed | `honey-deep` | **#D9881B** | Primary pressed, chart leg 3 | ink on it 6.4 |
| Brand tint | `honey-tint` | rgba(245,168,58,.14) | Selected rows, selected chips, the composer's glow | opaque equivalent `accent` #2D2318 |
| On track | `leaf` | **#3FC47C** | Status, positive deltas, up sparklines | 8.69 on night |
| Watch | `clay` | **#F0703A** | Status | 6.55 on night |
| Off track | `madder` | **#EF5A6F** | Status, negative deltas, down sparklines, destructive | 5.88 on night |
| Line | `chalk` | **#78B4E8** | Focus ring, "today" line, guides, the test-network plate | 8.77 on night |

### Light · "day" (docs, the consumer plan, the embed default)

| Role | Token | Hex | Usage | Contrast |
|---|---|---|---|---|
| Ground | `paper` | **#F7F5F0** | Page. Warm, never grey | |
| Surface | `paper-2` | **#FFFFFF** | Cards. White is allowed again | |
| Recess | `paper-3` | **#EFECE5** | Input wells, table heads, code blocks | |
| Hairline | `line-l` | **#E3DFD6** | Card edges, rows | decorative |
| Control edge | `line-l2` | **#C9C4B9** | Inputs, secondary buttons, the pin's outline | |
| Text | `ink` | **#15161C** | Body, headings, numbers | 16.57 on paper |
| Muted | `muted-l` | **#676A75** | Secondary text, captions | 5.39 on white |
| **Brand** | `honey` | **#F5A83A** | Primary button fill, progress bars, chart leg 1, large type | ink on honey 9.06; **never as small text on light** |
| Brand as text | `honey-l` | **#9D5A00** | Links, the pin, honey as text | 5.39 on white |
| On track | `leaf-l` | **#117940** | Status, positive deltas | 5.48 on white |
| Watch | `clay-l` | **#A64618** | Status | 5.98 on white |
| Off track | `madder-l` | **#B52F44** | Status, negative deltas, destructive | 5.14 on white |
| Line | `chalk-l` | **#2A73B0** | Focus ring, guides | 5.03 on white |

### Wood (imagery and the logo only)

| Token | Hex | Use |
|---|---|---|
| `wood` | **#E9C48E** | The pale timber in renders and drawings; chart leg 2 on night |
| `wood-deep` | **#B9803F** | The darker timber; chart leg 3 on day |

Wood is never a UI fill, a text colour or a border.

---

## Semantic colours (goal state and direction)

Always **word + shape + colour**, never colour alone (WCAG 2.2, 1.4.1).

| State | Night | Day | Tint (fill) | Shape | Word |
|---|---|---|---|---|---|
| **On track** | `leaf` #3FC47C | `leaf-l` #117940 | rgba(63,196,124,.14) | Solid square | On track |
| **Watch** | `clay` #F0703A | `clay-l` #A64618 | rgba(240,112,58,.14) | Half-filled square | Watch |
| **Off track / error** | `madder` #EF5A6F | `madder-l` #B52F44 | rgba(239,90,111,.14) | Square outline with a notch | Off track |
| **Sample (mock)** | `muted` + 45° hatch | `muted-l` + hatch | none | Hatched pin or glyph, hatched card edge | the quiet line "Sample figures" (gate `MOCK-QUIET`: never a boxed MOCK word) |
| **Stale** | hollow pin | hollow pin | none | Hollow square | stale · age |
| **Test network (sandbox)** | as sample | as sample | none | as sample | "Sample figures · test network"; the buy card: "Test network · <chain> · not live" |

**Deltas** are signed (+ / U+2212) and coloured by direction: leaf up, madder down, muted flat. They sit beside or under the value they qualify, in a smaller size, never alone. Honey is never a status colour: watch is clay, so a honey button beside a watch badge never confuses.

Badges and chips are pills with the 14% tint as fill and the colour as text. This is what makes a dense screen read alive: colour sits in surfaces, not only in text.

---

## Data colour

- **Plan legs (allocation):** up to 4 legs. Day: `honey`, `honey-deep`, `wood-deep`, `muted-l`. Night: `honey`, `wood`, `honey-deep`, `muted`. Direct labels, 2 px ground gap, pill ends. More than 4 legs: group them.
- **Projections:** the base case is a 2 px `honey` line with `curve-fill` (honey 35% → 0) beneath; stress cases are dashed `muted` and dashed `madder`; the measured past is solid. Dashed means projected, everywhere. The "today" marker is a 1 px dashed `chalk` vertical with a Plex Mono label.
- **Sparklines:** coloured by direction (leaf, madder, muted), 1.5 px, no fill.
- **Heatmaps (depth by hour of week):** a single ramp from the ground to pale honey, colour-blind safe because it is lightness-led. Night: `#1A1D26 → #5C3707 → #B06C12 → #F5A83A → #FFE9C2`. Day: reversed. No-sample cells are empty with an en dash, never hatched (the hatch means sample data).
- **Never** a rainbow categorical palette. Direction colours carry direction only.

---

## Light as colour

Gradients are allowed **as light**, never as two hues:

| Token | Value | Use |
|---|---|---|
| `glow` | `radial-gradient(60% 90% at 78% 30%, rgba(245,168,58,.22), rgba(245,168,58,0) 70%)` | Behind heroes and the composer on night |
| `glow-l` | same at .28 | On paper |
| `curve-fill` | `linear-gradient(to bottom, rgba(245,168,58,.35), rgba(245,168,58,0))` | Under the base-case line |

No glass, backdrop blur, neon glow, ambient orbs, metallic or wood-grain fills.

---

## Dark mode direction

Night is the native register for the **app**, **Bearing**, the **video** and **social**. Day is native for **docs**, the **plan view** and the **embed default**. Both are complete and first-class.

| Day | → Night | Note |
|---|---|---|
| `paper` #F7F5F0 | `night` #0C0D12 | Ground |
| `paper-2` #FFFFFF | `night-2` #13151C | Cards |
| `paper-3` #EFECE5 | `night-3` #1A1D26 | Wells and popovers |
| `ink` | `text` | |
| `honey-l` (text, pin) | `honey` | Honey as text needs the deep value on light; honey fills are honey in both |
| `leaf-l` / `clay-l` / `madder-l` | `leaf` / `clay` / `madder` | |
| `chalk-l` | `chalk` | Focus ring |

---

## Partner embed (white-label)

Colour **recedes completely**: ground, text, primary and radius map to the partner's tokens. What stays: the pin (in the partner's muted colour), the hatch with its sample line, hairline structure, the disclaimer block, and the "Powered by" credit with the 16 px cut in the partner's muted colour. *The joints stay. The honey becomes theirs.*

---

## Banned

A second brand colour. Chalk as a fill, a button or a brand element. A blue brand or a blue gradient. Two-hue gradients, glass, blur, neon, gold foil. White text on honey. Honey as small text on light grounds (use `honey-l`). Cinnabar, vermilion or seal-red. Wood as UI chrome. Pure grey grounds.

---

## Scales (for tints, badges and data)

| Stop | honey | neutral | leaf | clay | madder | chalk |
|---|---|---|---|---|---|---|
| 50 | #FFF6E6 | #F7F5F0 | #E8F8EE | #FEEFE7 | #FDEDF0 | #EAF4FC |
| 100 | #FFE9C2 | #EFECE5 | #C9EFD9 | #FDDACB | #FBD6DC | #D1E6F8 |
| 200 | #FFD48A | #E3DFD6 | #9AE1B8 | #FAB89A | #F7AEBA | #A8CFF1 |
| 300 | #F9BE5C | #C9C4B9 | #6AD39A | #F5936A | #F38496 | #8FC1EC |
| **400** | **#F5A83A** honey | #9A9DAD muted | **#3FC47C** leaf | **#F0703A** clay | **#EF5A6F** madder | **#78B4E8** chalk |
| 500 | #E99C2E | #6E7282 | #2AA866 | #DA5F2A | #DB4259 | #4F93D0 |
| 600 | #D9881B | #4B4F5E | #117940 leaf-l | #A64618 clay-l | #B52F44 madder-l | #2A73B0 chalk-l |
| 700 | #B06C12 | #363B4B | #156236 | #964215 | #9B2A3D | #1F588A |
| 800 | #85500C | #262A36 | #0F4727 | #6F310F | #70202D | #174065 |
| 900 | #5C3707 | #1A1D26 | #092E19 | #4A200A | #49151E | #0F2A43 |
| 950 | #3A2204 | #0C0D12 | #051B0E | #2D1306 | #2B0C12 | #081827 |

OKLCH values and the contrast matrix are in [palettes.json](./palettes.json). The named tokens stay the source of truth for UI.

## Contrast audit (WCAG 2.2 AA)

Text needs 4.5:1 (3:1 at ≥ 24 px or ≥ 18.66 px bold). Controls, focus rings and state glyphs need 3:1.

| Pair | Ratio | |
|---|---|---|
| text on night / night-2 / night-3 | 17.2 / 15.6 / 13.9 | pass |
| muted on night-2 | 6.77 | pass |
| honey on night | 9.75 | pass |
| ink on honey | 9.06 | pass (buttons, both modes) |
| ink on honey-deep | 6.4 | pass (pressed) |
| leaf / clay / madder on night | 8.69 / 6.55 / 5.88 | pass |
| chalk on night (focus ring) | 8.77 | pass |
| ink on paper / white | 16.57 / 17.4 | pass |
| muted-l on white | 5.39 | pass |
| honey-l on white | 5.39 | pass |
| leaf-l / clay-l / madder-l on white | 5.48 / 5.98 / 5.14 | pass |
| chalk-l on white (focus ring) | 5.03 | pass |
| white on honey | 2.0 | **fail: banned** |
| honey on white | 1.9 | **fail: fills and large type only** |
