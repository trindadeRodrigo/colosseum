# Identity
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon"; slug `working-brand`) | Generated: 2026-10-01

| Chunk | File | ~Lines |
|-------|------|--------|
| Logo Directions | [logo-directions.md](./logo-directions.md) | ~143 |
| Color System | [color-system.md](./color-system.md) | ~190 |
| Palettes (OKLCH, contrast) | [palettes.json](./palettes.json) | n/a |
| Typography | [typography.md](./typography.md) | ~320 |
| Imagery Style | [imagery-style.md](./imagery-style.md) | ~156 |
| Iconography | [iconography.md](./iconography.md) | ~115 |
| Brand Applications | [brand-applications.md](./brand-applications.md) | ~68 |
| Logo comparison (visual) | [logo-comparison.html](./logo-comparison.html) | n/a |

## Locked decisions
- **Direction:** "The Open Joint", led by imagery. Wood is the only colour. Light and dark are peers.
- **Logo:** **A, pinned through-tenon** (rail, post, tenon end, pin knock-out) + lowercase serif wordmark `tenonfi`. The fi ligature is removable, so it falls back to `tenon`. A small cut for ≤ 20 px. Lockups: `tenonfi Bearing`, "Powered by tenonfi". B (stacked cantilever) survives as pattern P2. C's idea survives as the provenance glyph.
- **Provenance glyph:** the tenon end in outline with a solid pin. Live = solid pin, stale = hollow pin + "stale", MOCK = hatch + "MOCK".
- **Palette:** paper #F6F1E8 · paper-raised #FBF8F2 · paper-sunk #EDE6DA · black #0D0B09 · char #1A1714 · char-2 #24201B · ink #1C1712 · washi #ECE4D6 · hinoki #E6D3B7 · hinoki-deep #C9AE86 · hardwood #7A5A3A · heartwood #5A3A1E · stone #6E655B / #A49A8E · hair #D9CDBB / #3A322A · member #8C7F70 / #7A6D5F. Semantic colours: forest #2F4A2A / #7FA37A, ochre #8A5A00 / #D9A441, madder #A8324A / #E58AA0.
- **Type:** Newsreader (display, upright, consumer and marketing only) · IBM Plex Sans + Condensed (UI) · IBM Plex Mono (provenance, code, data).
- **Joints:** J1 pinned through-tenon = logo, plan and provenance · J2 half-lap cross = structure and lattice · J3 ari-otoshi dovetail = exit plan · J4 kanawa tsugi = rebalance · J5 bracket set = Bearing.
- **Patterns:** P1 square kumiko (coarse/medium/fine) · P2 stacked offset · P3 receding grid · P4 section hatch (MOCK only) · P5 bracket set (Bearing imagery). Never behind numbers. Nothing in the embed except the hatch.
- **Hero assets first:** H1 Open Joint still · H2 Lock animation · H3 Plan exploded (SVG) · H4 Bearing lattice + bracket render.

## Changes from discover/
- 3D renders are now **in** (founder request), held to material realism. Generative AI is for concepting only, never shipped.
- The display serif changed from Source Serif 4 to **Newsreader** (humanist, warmer).
- Added `washi` (text on dark), `paper-sunk`, and `member` lines for control boundaries.

## Next
`/gsp-logo --enrich` (outlines, both cuts, ligature) · `/gsp-color --enrich` (OKLCH, contrast matrix, palettes.json) · `/gsp-typography --enrich` · `/gsp-visuals --imagery --enrich` (asset specs, motion tokens).
