# Color System
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01 | Enriched: `/gsp-color --enrich`, 2026-10-01

**Composition strategy: monochrome (one material) with inverted sections.** Wood is the only colour. Every hue in the brand comes from one family (warm yellow-brown), and hierarchy comes from lightness. Light (daylight paper) and dark (warm black) are **peers**, not a theme and its afterthought. Marketing pages alternate between them like a joint photographed on black, then a room in daylight. Proportions on any screen are about **60% ground, 30% ink and hairline, 10% wood**. The 10% sits where it means something: interaction, the pin, the key member in a drawing.

**Why (strategy):** the category speaks in a single saturated accent (blue, violet, mint or lime). We carry identity through the **contrast of two species**, pale against dark, as in master.jpg. Sage gets a muted, structured palette. Caregiver gets warmth: never cold navy, never pure white. Positioning gets material instead of abstract.

---

## Core palette

| Role | Token | Hex | Usage | Rationale |
|---|---|---|---|---|
| Light ground | `paper` | **#F6F1E8** | Light-mode page | Unbleached daylight paper. Warm, calm, never pure white (Caregiver) |
| Light surface | `paper-raised` | **#FBF8F2** | Plan cards, popovers on light | A shade *lighter* than ground: a planed face catching light, not a shadowed card |
| Light recess | `paper-sunk` | **#EDE6DA** | Table headers, code blocks, input wells | The cut face, slightly in shadow |
| Dark ground | `black` | **#0D0B09** | Dark-mode page, Bearing, video | The black seamless of master.jpg, warmed so it isn't cool #000 |
| Dark surface | `char` | **#1A1714** | Panels on dark | |
| Dark raised | `char-2` | **#24201B** | Selected rows, popovers on dark | |
| Text on light | `ink` | **#1C1712** | Body and headings on paper | Warm black ink |
| Text on dark | `washi` | **#ECE4D6** | Body and headings on dark | Paper colour inverted, so text on dark isn't tan |
| Pale species | `hinoki` | **#E6D3B7** | **The brand colour on dark:** interactive, focus, pin, key member | Sampled from the pale tenon in master.jpg |
| Pale, shaded | `hinoki-deep` | **#C9AE86** | Secondary emphasis on dark, two-tone logo | Hinoki in shadow |
| Dark species | `hardwood` | **#7A5A3A** | **The brand colour on light:** links, primary button, pin, key member | Sampled from the hardwood face in master.jpg |
| Dark, end grain | `heartwood` | **#5A3A1E** | Pressed and active states on light, emphasis | The darkest cut face |
| Muted text | `stone` / `stone-d` | **#6E655B** / **#A49A8E** | Secondary text, captions, provenance lines | |
| Hairline | `hair` / `hair-d` | **#D9CDBB** / **#3A322A** | Rules, lattice, dimension lines, table rows | Decorative structure only. Not a control boundary |
| Member line | `member` / `member-d` | **#8C7F70** / **#7A6D5F** | Input borders, control outlines, focus-adjacent edges | Lines that must be *seen* (controls). `gsp-color` confirms they meet non-text contrast |

**The species rule:** on paper, the brand's wood is `hardwood`. On warm black, it's `hinoki`. The pin and any "key member" in a drawing are always **the species opposite the ground**, as the pale pin passes through the dark tenon in master.jpg. There is no third brand hue.

---

## Semantic colours (goal state)

Always **word + shape + colour**, never colour alone (WCAG 2.2, 1.4.1). All three are earth pigments, so they sit inside the wood palette and never read as trading-app red and green.

| State | Light | Dark | Shape | Note |
|---|---|---|---|---|
| **On track** | `forest` **#2F4A2A** | **#7FA37A** | Solid square | Yusuhara cedar forest. Deliberately not P&L green |
| **Watch** | `ochre` **#8A5A00** | **#D9A441** | Half-filled square | Earth ochre. Not Bitcoin orange or amber |
| **Off track / error** | `madder` **#A8324A** | **#E58AA0** | Square outline with a notch | Cool madder (HSL hue ≈ 348°; OKLCH h 12.8). Cinnabar #E34234 sits at OKLCH h 29 and seal-red #B7282E at h 24, so madder is 12–16° cooler, and its scale is chroma-capped at 0.154 |
| **MOCK** | `stone` + 45° hatch | `stone-d` + hatch | Hatched | Never a colour of its own. Hatch + the word MOCK (imagery-style.md) |
| **Stale** | `stone` + hatch | `stone-d` + hatch | Hollow pin | The word "stale" + the age |
| **Info / neutral** | `ink` | `washi` | n/a | There is no blue "info" colour. Blue is the category's colour |

Validation error ("doesn't fit"): the mortise slot outlined in `madder`, plus a sentence saying what to change (voice-and-tone.md). Success never gets its own celebratory colour. "On track" is enough.

---

## Data colour

- **Heatmaps (Bearing depth by hour-of-week):** single-hue *lightness* ramp, so it is colour-blind safe and reads as wood darkening with depth. On dark: `#1A1714 → #5A3A1E → #8A6C4B → #C9AE86 → #F2E6D3`. On light it is reversed. Empty or no-sample cells are hatched, never coloured.
- **Plan legs (allocation):** up to 4 legs. Light: `hardwood`, `heartwood`, `wood-400` #9D7751, `stone`. Dark: `hinoki`, `hinoki-deep`, `wood-400`, `stone-d`. Each has a direct label (never a legend-only key) and a 2 px ground-colour gap between segments. *(Enrich change: `hinoki-deep` on paper is 1.89:1, below the 3:1 non-text minimum, so light mode uses `wood-400` instead.)* With more than 4 legs, group them or use labelled hairline bars.
- **Projections (path, stress cases):** the base case is a solid `ink`/`washi` line, stress cases are dashed `stone`, and the measured past is solid. Dashed means *projected*, everywhere.
- **Never** a rainbow categorical palette, and never red/green P&L colouring.

---

## Dark mode direction

Dark is the native register for **Bearing**, the **hackathon video** and **photography** (the black seamless). Light is the native register for the **consumer plan**, **API docs** and the **embed default**. Both are complete and both are first-class.

| Light | → Dark | Note |
|---|---|---|
| `paper` #F6F1E8 | `black` #0D0B09 | UI ground. Photography may sit on true #000 inside its frame |
| `paper-raised` #FBF8F2 | `char` #1A1714 | |
| `paper-sunk` #EDE6DA | `char-2` #24201B | Recess becomes raised. That's fine, because both mean "set apart" |
| `ink` #1C1712 | `washi` #ECE4D6 | |
| `hardwood` #7A5A3A | `hinoki` #E6D3B7 | The species swap |
| `heartwood` #5A3A1E | `hinoki-deep` #C9AE86 | |
| `hair` / `member` | `hair-d` / `member-d` | |
| Focus ring: 2 px `hardwood`, 2 px offset | 2 px `hinoki`, 2 px offset | |

There is no glass, blur, glow or ambient orb in dark mode. Depth comes from the three warm layers and hairlines (minimal-dark's structure, without its effects).

---

## Partner embed (white-label)

Colour **recedes completely**: ground, text, primary and radius map to the partner's tokens. What stays: the pin glyph (in the partner's muted text colour), the hatch for MOCK, hairline structure, the disclaimer block, and the "Powered by" line in the partner's muted colour. *The joints stay. The wood becomes theirs.*

---

## Banned

Blue, indigo or violet anywhere in UI. Mint, lime, neon, gradients, glass, gold foil. Cinnabar, vermilion or seal-red. Pure #FFFFFF grounds. Amber #F59E0B. Wood-grain textures as UI backgrounds. Daylight `sky` (#CAE3F4) exists **only inside photographs**, never as a UI colour.

---

## OKLCH scales (technical enrichment)

Source: tints.dev API, fetched 2026-10-01. L and H as returned. Chroma clamped locally to keep every stop an earth pigment: ceiling = source C × 1.15 (madder × 1.00), stop 50 ≤ 0.03, stop 100 ≤ 0.05. Unclamped tints.dev light stops read as lime (forest-100 #9EEA90), amber (ochre-200 #FFAD2F) and hot crimson (madder-400 #DB4463), all banned. Full OKLCH values, and the pre-clamp chroma, are in [palettes.json](./palettes.json).

| Stop | wood (brand) | neutral | forest | ochre | madder |
|---|---|---|---|---|---|
| 50 | #F8ECE3 | #F1EDE9 | #DEEEDB | #FFEADB | #FAEAEC |
| 100 | #F3D8C4 | #E6DED6 | #C2DCBD | #F7D7BD | #F6D5D9 |
| 200 | #DEB48C | #C8BDB0 | #92B68B | #F2B360 | #EEA9B2 |
| 300 | #BC946D | #AA9E92 | #6F9168 | #CE933C | #E87A8A |
| 400 | #9D7751 | #8D8276 | #4D6E47 | #AF7614 | #CE5469 |
| **500** | **#7A5A3A** hardwood | **#6E655B** stone | **#2F4A2A** forest | **#8A5A00** ochre | **#A8324A** madder |
| 600 | #63482E | #595149 | #263C21 | #6F4801 | #89273B |
| 700 | #4A3520 | #433D36 | #1C2E18 | #543500 | #6A1C2C |
| 800 | #342515 | #2E2924 | #132110 | #3D2500 | #4D121E |
| 900 | #20150A | #1C1916 | #0B1609 | #241400 | #310811 |
| 950 | #150D05 | #100E0B | #050D04 | #180C00 | #220409 |

Sources at 500: wood oklch(0.493 0.063 65.5) · neutral oklch(0.512 0.019 70.3) · forest oklch(0.378 0.062 140.6) · ochre oklch(0.508 0.108 73.3) · madder oklch(0.500 0.154 12.8). **The named tokens above stay the source of truth for UI.** Scales are for tints, badges and data only. hinoki (oklch 0.875 0.043 77.6) and hinoki-deep (0.764 0.062 77.4) are the pale species: the same wood family, slightly yellower than the scale.

## Contrast audit (WCAG 2.2 AA)

Text needs 4.5:1 (3:1 at ≥ 24 px or ≥ 18.66 px bold). Controls, focus rings and state glyphs need 3:1 (1.4.11).

**Light** (paper / paper-raised / paper-sunk)

| Foreground | Use | Ratios | |
|---|---|---|---|
| ink | body text | 15.81 / 16.78 / 14.34 | pass |
| stone | muted text, provenance | 5.08 / 5.39 / 4.61 | pass (tightest on sunk) |
| hardwood | links, brand | 5.57 / 5.91 / 5.05 | pass |
| heartwood | emphasis | 9.07 / 9.62 / 8.22 | pass |
| forest / ochre / madder | status text | 8.75 / 5.27 / 5.80 on paper; 7.94 / 4.78 / 5.26 on sunk | pass |
| member | control borders | 3.47 / 3.68 / 3.14 | pass (non-text) |
| hardwood | focus ring | 5.57 on paper | pass (non-text) |
| hair | lattice, rules | 1.39 | decorative only: never a control edge |

**Dark** (black / char / char-2)

| Foreground | Use | Ratios | |
|---|---|---|---|
| washi | body text | 15.56 / 14.14 / 12.82 | pass |
| stone-d | muted text | 7.10 / 6.45 / 5.85 | pass |
| hinoki | links, brand, focus | 13.44 / 12.21 / 11.07 | pass |
| hinoki-deep | secondary emphasis | 9.24 / 8.40 / 7.62 | pass |
| forest-d / ochre-d / madder-d | status text | 6.94 / 8.73 / 7.93 on black; 5.72 / 7.20 / 6.53 on char-2 | pass |
| member-d | control borders | 3.91 / 3.55 / 3.22 | pass (non-text) |
| hair-d | lattice | 1.56 | decorative only |

**Buttons and badges:** paper-raised on hardwood 5.91 · paper on heartwood (pressed) 9.07 · black on hinoki 13.44 · black on hinoki-deep (pressed) 9.24. Status badges, light: forest on forest-50 8.14, ochre on ochre-50 5.09, madder on madder-50 5.60. Dark: forest-d on forest-950 6.96, ochre-d on ochre-950 8.55, madder-d on madder-950 7.78.

**Failures found and handled** (no creative-director colour changed; two usages changed):
1. `hinoki-deep` as a plan-leg fill on paper is 1.89:1 → light legs use `wood-400` #9D7751 (3.60:1). hinoki-deep stays on dark and in the logo.
2. Text over the MOCK hatch: ink vs stone strokes is 3.11:1 → text never sits on strokes (see below).
3. Not a failure but a risk: `hardwood` on dark is 3.13 / 2.85 / 2.58, which confirms the species rule (never hardwood on dark).

**Look-alikes:** ochre vs hardwood is 1.06:1 (same hue band), and ochre-d vs hinoki is 1.54:1. A "watch" state can be told apart from brand wood only by its **word and half-filled square**, never by colour. That rule is mandatory.

## MOCK hatch and provenance pin

| State | Light | Dark | Shape cue | Contrast |
|---|---|---|---|---|
| **Live** | tenon outline `stone`, **solid pin `hardwood`** | outline `stone-d`, **solid pin `hinoki`** | solid pin | pin 5.57 / 13.44; outline 5.08 / 7.10 |
| **Stale** | outline `stone`, **hollow pin `stone`** (1.5 px ring) + "stale · 3h" in `stone` | same in `stone-d` | hollow pin + word + age | 5.08 / 7.10 (4.61 / 5.85 on sunk / char-2) |
| **MOCK** | outline `stone`, tenon filled with **`stone` hatch** + "MOCK" | same in `stone-d` | hatch + word | strokes 5.08 / 7.10 |

- **Hatch spec:** 1 px strokes at 45°, 6 px pitch (3 px pitch for glyphs under 16 px). Strokes: `stone` on light (5.08 on paper, 5.39 on paper-raised), `stone-d` on dark (7.10 on black, 5.85 on char-2). The hatch passes 3:1 on its own, so it is a valid state indicator, and the word MOCK makes it redundant (1.4.1).
- **Text on hatch is forbidden.** On a mocked card the hatch fills the frame margin or a 6 px edge band. Values and the MOCK label sit on a solid plate: light `ink` on `paper-raised` (16.78) with a 1 px `stone` border, dark `washi` on `char` (14.14) with a 1 px `stone-d` border.
- Live and stale pins differ by luminance only 1.10:1 (hardwood vs stone). The **shape (solid vs hollow) plus the word "stale"** carries the difference, so the stale glyph is never shown without its label.

## Semantic token mapping

| Token | Light | Dark |
|---|---|---|
| `--color-bg` / `--color-surface` / `--color-sunk` | paper / paper-raised / paper-sunk | black / char / char-2 |
| `--color-text` / `--color-text-muted` | ink / stone | washi / stone-d |
| `--color-brand` / `--color-brand-pressed` | hardwood / heartwood | hinoki / hinoki-deep |
| `--color-on-brand` | paper-raised | black |
| `--color-border` (controls) / `--color-rule` (decor) | member / hair | member-d / hair-d |
| `--color-focus` | hardwood | hinoki |
| `--color-success` · `-bg` | forest · forest-50 | forest-d · forest-950 |
| `--color-warning` · `-bg` | ochre · ochre-50 | ochre-d · ochre-950 |
| `--color-error` · `-bg` | madder · madder-50 | madder-d · madder-950 |
| `--color-info` | ink (no blue) | washi |
| `--color-provenance-live` / `-stale` / `-mock` | hardwood / stone / stone | hinoki / stone-d / stone-d |

**Dark-mode equivalence:** every light pair has a dark twin that also passes at the same level. Body text is near-equal (15.81 → 15.56), and brand, muted text and status are higher on dark. The tightest pairs are muted text on recess (4.61 light, 5.85 dark) and control borders on recess (3.14 light, 3.22 dark).

**Heatmap ramp:** steps are 1.75 / 2.10 / 2.28 / 1.72:1 apart, monotonic in lightness. The lowest cell is 1.10:1 against black, so cells are separated by `hair-d` lines and no-sample cells use the hatch, never a ramp colour.

---

## Related

- [palettes.json](./palettes.json): scales, tokens, the full contrast list, provenance states
- [imagery-style.md](./imagery-style.md): hatch (P4) and provenance glyph
- [typography.md](./typography.md)
- [brand-applications.md](./brand-applications.md)
