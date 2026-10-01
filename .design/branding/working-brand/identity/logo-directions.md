# Logo Directions
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01 · Enriched 2026-10-01 (`/gsp-logo --enrich`)

Visual comparison: [logo-comparison.html](./logo-comparison.html) shows all three directions on paper and warm black at 16/32/48/96 px, as lockups, as "Powered by" in a neutral partner card, as "tenonfi Bearing" and as plain "tenon". It also has the A construction sheet (grid, three cuts, clear space, minimums).

**Brief for every mark:** say *cut to fit* and *every joint shown* (essence "Fit, shown"). Square-cut, never rounded (joinery is square, archetype.md). Hold at favicon size, recede to a "Powered by" credit, carry "Bearing" without a second brand, still work if "fi" is dropped. **No** kanji, seal-red, brush, torii, blossom, bevelled chassis, nameplate, coin, gradient or mascot. Nothing that echoes Teiten's instrument grammar.

**Energy:** technical-calm. A draughtsman's mark, not an emblem: flat, planar, few parts, every part a real member.

---

## A. Pinned through-tenon (recommended, locked)

**Concept.** master.jpg reduced to a side elevation in three solid members: the **rail** (left), the **post** (vertical), and the **tenon end** coming through the far face of the post, with the **pin** as a round knock-out. A hairline gap at each shoulder shows the joint lines. Read left to right it is the product: *your goal (the post) → the plan passes through it (the tenon) → held by its source (the pin)*.

**Strategic rationale.**
- **Sage:** a diagram of *why it holds*. An elevation, not a logo-shape.
- **Caregiver:** the lowercase serif wordmark is a voice, not a bank.
- **Made to measure:** a through-tenon is cut for one mortise only.
- **Every joint shown:** end grain and pin are visible from outside; that is why a through-tenon beat a blind one.
- **System continuity:** the tenon end with its pin is the provenance glyph's parent. The brand recedes until only the pin is left, and the pin is still the brand, so the white-label rule is a property of the logo.

### Construction (master grid)
Unit **u** = 1/32 of the artboard. **H** = mark height = post height = 28u. All edges sit on whole units; only the pin is a circle.

| Member | Box (x, y · w × h, in u) | Relationship |
|---|---|---|
| Rail | 1, 10 · 5 × 12 | Short stub: rail length 5u < tenon length 12u (keeps it asymmetric, never a cross) |
| Shoulder gap | x 6–7 · 1u | The joint line. 1u = H/28 |
| Post | 7, 2 · 10 × 28 | Width 10u = **0.36H**, the system's base measure (clear space, lockup gap) |
| Through gap | x 17–18 · 1u | Second joint line, same as the first |
| Tenon end | 18, 12 · 12 × 8 | **3:2**, the proportion the provenance glyph inherits. Height = rail height − two 2u shoulders |
| Pin | centre 25, 16 · r 2 | Diameter 4u = tenon height ÷ 2. Centre 7u from the post, 5u from the end grain (offset toward the end, as a real draw-bore pin is) |

- Heights post : rail : tenon = **7 : 3 : 2**. Rail, tenon and pin share one centre line (y 16u), the **tenon axis**.
- Bounding box 29u × 28u: near-square, so it optically matches a square app tile.
- The pin is always a knock-out (a hole showing the ground), except in the two-species hero.

### Cuts by size (three masters, never auto-scaled across a breakpoint)
| Cut | Render size | Grid | Coordinates (x, y · w × h) | Notes |
|---|---|---|---|---|
| **Master** | ≥ 32 px, all vector and print | 32 | as above | At 32 px every gap is exactly 1 px |
| **24 hint** | 22–31 px | 24 | rail 1,7 · 3×10 · post 5,1 · 8×22 · tenon 14,9 · 9×6 · pin c(19,12) r1.5 | Gaps snapped to 1 px; proportions within 5% of master |
| **Small cut** | 12–21 px (favicon, tab, "Powered by") | 16 | post 1,1 · 4×14 · tenon 6,4 · 9×8 · pin c(11,8) r2 | Rail dropped, one joint line, pin enlarged, 2 px walls. Pixel-snapped at 16 px |

### Wordmark construction
- **Source:** Newsreader Medium at opsz 72, outlined, tracking −15 (−0.015 em). Hand corrections: the t's crossbar sits exactly on the x-height; the e's bar is horizontal (no pen tilt).
- **The fi ligature (a half-lap):** the f's crossbar runs right to meet the i's stem at x-height and stops flush; the f's hood ends over the i in a flat cut that replaces the tittle. Both cuts are square, like a sawn lap.
- **Removal:** "fi" is one separate outline group. Deleting it leaves `tenon` with unchanged spacing and no re-kerning; the fallback is the same artwork minus one group.
- Production always uses outlines. The live-type versions in the HTML are for review only.

### Variations
| Variation | Spec |
|---|---|
| **Primary lockup** | Symbol + `tenonfi`, horizontal. H = 1.25 × wordmark cap height. Symbol→word gap = post width (0.36H). The tenon axis aligns with the x-height midline, so the tenon points into the word |
| **Secondary (stacked)** | Symbol above `tenonfi`, left edges aligned (rail edge to the t's stem). Vertical gap 0.5H. Square formats only (social card, print, slide closer) |
| **Icon** | Master / 24 hint / small cut by size. App tile: mark at 62% of tile width on `paper` (or `black`), centred on its bounding box. The platform mask is the only rounding ever applied |
| **Wordmark only** | `tenonfi` (or `tenon`) alone, when the symbol is already on screen (app header beside the favicon, footer) |
| **Fallback** | Symbol + `tenon`. Same geometry, ligature group removed |
| **Product lockup** | `tenonfi Bearing`. "Bearing" in IBM Plex Sans Regular sized so its x-height equals the wordmark's; colour `stone` / `stone-dark`. Gap = 0.6 × x-height (one word space). Never a separate symbol |
| **"Powered by"** | `Powered by` in the partner's UI font (or Plex Sans Regular), partner's muted colour; then small cut + `tenonfi` outlines at 1.15 × the text size (matches x-heights). Symbol = text cap height × 1.25. Text-only "Powered by tenonfi" allowed where a partner forbids marks |
| **Two-species (hero only)** | Members `hardwood`, pin filled `hinoki`; on dark, members `hinoki-deep`, pin `hinoki`. Only ≥ 64 px, never in UI chrome |
| **Monochrome** | One colour, pin knocked out: `ink` on paper; pure white or black for partners and print |
| **Reversed** | `hinoki` symbol + `washi` wordmark on `black` #0D0B09 or `char` #1A1714. All-`washi` for partner dark modes |

### Clear space
- **0.36H on every side** (the post's width), for every cut and lockup. At 16 px: 6 px. At 32 px: 10 px.
- Lockups measure it from the symbol's H, around the whole lockup box (including "Bearing" or "Powered by").
- In the "Powered by" credit it may drop to 0.25H; the partner's card padding counts toward it.

### Minimum sizes
| Asset | Minimum | Below that |
|---|---|---|
| Small cut | 12 px | Text-only "Powered by tenonfi" |
| Master symbol | 32 px (24 hint from 22 px) | Switch cut, never shrink the master |
| Primary lockup | 96 px wide (symbol 22 px) | Wordmark only, or icon only |
| `tenonfi Bearing` | 140 px wide | "Bearing" as plain text beside the icon |
| "Powered by" | 12 px symbol, 11 px text, 13 px wordmark | Text-only |
| Wordmark alone | 20 px font size | Plain Plex Sans "tenonfi" text, not the logo |
| Print | Symbol 6 mm, lockup 22 mm wide | n/a |

### Don'ts
- Don't round corners or add bevels, shadows, gradients, outlines or wood-grain fills. Grain lives in photography.
- Don't close the joint gaps or fill the pin. Gapless reads as a plus; a filled pin loses provenance.
- Don't mirror (tenon pointing left) or rotate. The post is always vertical, because load runs down.
- Don't centre the pin in the master or lengthen the rail to match the tenon: symmetry makes a medical cross.
- Don't give the pin a third colour (above all red: no seal or hanko reading). No kanji, brush texture or frame.
- Don't set the wordmark in caps, title case ("Tenonfi"), the sans or italic. Don't colour "fi" differently.
- Don't place the mark on kumiko patterns, busy photography, or inside a circle or rounded badge.
- Don't put the logo after figures (the provenance glyph does that), and don't use the glyph as the logo.
- Don't animate except with the brand motion: the tenon slides in on one axis and seats (280–360 ms), then the pin drops (160 ms). Reduced motion: no travel.

**Risks.** At a glance it could read as a plus or medical cross. Mitigated by asymmetry (5u rail vs 12u tenon, offset pin); every redraw must keep it.

---

## B. Stacked cantilever (not chosen; survives as pattern P2)

**Concept.** The Yusuhara bridge museum: three members stacked and offset, each longer than the one below, on one column. Reads as a **T**: many small pieces carry a large load on one support (the goal).
**Wordmark.** **Tenonfi** in IBM Plex Sans SemiBold, title case.
**Rationale.** Strongest silhouette, very architectural, suits Bearing. But no pin, so provenance needs a separate glyph; and stacking is a structure, not a joint, so "made to measure" weakens.
**Construction (32 grid).** Members 30u, 22u, 14u wide × 5u tall with 1u gaps, stepping in 4u per side; column 6u × 11u. Small cut: two members + column on a 16 grid.
**If ever revived.** Clear space 0.25H; minimum 24 px. Below that it reads as a **funnel/filter icon**, colliding with product chrome.

---

## C. The pin as full stop (not chosen; idea kept as the provenance glyph)

**Concept.** `tenonfi` in IBM Plex Sans Medium, closed by the provenance glyph as a full stop. *Said, and sourced.* Icon = the pin glyph alone.
**Rationale.** The most literal system (brand mark = provenance glyph) and the lightest credit.
**Construction.** Glyph height = x-height, on the baseline after the last letter with a 0.15 em gap.
**Why not.** At favicon size the pin reads as "record" or a target; the all-sans wordmark sits in the category's grotesk look; and a logo after every figure is self-promotion. The pin must mean *source*, not *brand*.

---

## The provenance glyph (shared, derived from A)

A's tenon end in line mode: an outline rectangle in the tenon's **3:2** with a solid pin. Unlike the logo, the pin is **centred**, so the glyph never reads as a miniature logo.

- **Grid:** 12 × 12 box; rectangle 10.5 × 6.5 centred, stroke 1.25; pin r 1.6. Size = cap height of the figure it follows (12 px at 16 px text); gap 0.25 em.
- **Colour:** the species opposite the ground (`hardwood` on paper, `hinoki` on warm black). In the embed, the partner's muted text colour.

| State | Drawing | Always paired with |
|---|---|---|
| Live | Solid pin | Popover: `source · fetched_at · method` |
| Stale | Hollow pin (stroke 1) | The word **stale** + the age |
| MOCK | No pin, 45° section hatch inside the outline | The word **MOCK** |

Accessible name: "Source for 6.4%". Keyboard-focusable, opens on Enter, hit area ≥ 24 × 24 px.

---

## Recommendation

**Direction A**, locked. Next: draw the final outlines from this spec (three symbol cuts, the wordmark with and without the ligature group, the Bearing and Powered-by lockups), then export SVG/PNG/ICO via `/gsp-visuals --imagery --enrich`.

---

## Related
- [color-system.md](./color-system.md)
- [typography.md](./typography.md)
- [imagery-style.md](./imagery-style.md)
- [brand-applications.md](./brand-applications.md)
