# Identity
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon"; slug `working-brand`) | Generated: 2026-10-01 | Rewritten 2026-10-08 on `IDENTITY-2` and `LOGO-2` (docs/GATES.md)

| Chunk | File | Note |
|-------|------|------|
| Logo | [logo-directions.md](./logo-directions.md) | "The face": construction, cuts, lockups, exports in `logo/` |
| Color System | [color-system.md](./color-system.md) | Honey on night; day; direction colours; light as gradient |
| Palettes (OKLCH, contrast) | [palettes.json](./palettes.json) | Generated from the tokens |
| Typography | [typography.md](./typography.md) | Inter Tight · Inter · IBM Plex Mono |
| Imagery Style | [imagery-style.md](./imagery-style.md) | Wood in daylight; renders lit warm on night |
| Iconography | [iconography.md](./iconography.md) | Lucide retuned; the pin; the joint glyphs |
| Brand Applications | [brand-applications.md](./brand-applications.md) | Goal card, plan, embed, docs, Bearing, video |
| The identity decision (visual) | [identity-reassessment.html](./identity-reassessment.html) | Current vs proposed, the palette, the alternates (2026-10-08) |
| The logo decision (visual) | [logo-options-2.html](./logo-options-2.html) | Five marks on the accepted palette (2026-10-08) |

## Locked decisions (2026-10-08, Rodrigo)
- **Identity:** "Honey on night". One brand colour, honey `#F5A83A`, with ink text on it in both modes. Night `#0C0D12` for the app, Bearing and the video; paper `#F7F5F0` with white cards for docs, the plan and the embed. Leaf, clay and madder for on track, watch and off track, each with a 14% tint and always with a word and a shape. Chalk `#78B4E8` as a line only. Gradients as light only. Wood in imagery only; the daylight timber interior (`../patterns/prototypes/assets/closing.jpg`) is the governing image.
- **Logo:** "the face": a honey tile, the tenon end cut in (night on night, ink elsewhere), a square honey pin set toward the end. Three cuts (32, 24, 16). Wordmark `tenonfi` in Inter Tight 600, −2% tracking; fallback `tenon`; `tenonfi Bearing` with "Bearing" in Inter 500 muted.
- **Provenance glyph:** the tenon end in line mode with the square pin. Live = solid, stale = hollow + "stale", sample (mock) = hatch, no pin, with the card's quiet line "Sample figures" (gate `MOCK-QUIET`, Thom, Oct 6: never a boxed MOCK word), sandbox = the same line with "test network".
- **Type:** Inter Tight 600 (display, big numbers, the wordmark) · Inter (UI) · IBM Plex Mono (provenance, code, data). No serif in the product.
- **Shape:** cards 10 px, controls 8 px, pills for chips and badges, the composer 20 px, app tiles 16 px.
- **Joints:** J1 pinned through-tenon = logo and provenance · J2 half-lap = structure · J3 ari-otoshi dovetail = exit plan · J4 kanawa tsugi = rebalance · J5 bracket set = Bearing. Drawn with lines in the text colour, the key member in honey, dimension lines in chalk.
- **Patterns:** P1 lattice on marketing grounds only · P4 hatch for MOCK and stale only · P5 bracket set in Bearing imagery. P2 and P3 are retired.
- **Unchanged:** the strategy (made to measure, every joint shown; Sage × Caregiver; the voice) and the product rules (pin on every figure, the hatch with its sample line, the disclaimer, no return promises, the brand receding in the embed, no Japanese clichés, nothing like Teiten).

## Changes from the Oct 1 identity ("The Open Joint")
- The wood-only palette (hinoki, hardwood, heartwood on warm black and daylight paper) is replaced. It was sampled from a studio photograph of wood in shadow and read dead.
- Newsreader is dropped from product surfaces. Inter Tight takes display and the wordmark.
- Square-only shapes, the ban on blue, on gradients and on white are lifted as described above. The bans on Japanese clichés, on Teiten's grammar and on a second brand colour stand.
- Logo direction A (the elevation) and its construction are retired; the three-cut idea, the removable `fi` and the pin-as-provenance idea carry over.

## Next
Reskin `apps/web` on the new tokens (a slot of its own, after `../patterns/STYLE.md`), then the video assets on the new imagery rules.
