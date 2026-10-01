# Provenance pin
> Type: custom | Component: `<ProvenancePin>` (`apps/web/components/ProvenancePin.tsx`) | Replaces: `ProvenanceBadge` for figures

The brand's smallest logo: the J1 tenon end with its pin, drawn in line mode, after **every yield, price and FX figure**. It opens `source · fetched_at · method`. No pin, no number. It is not in the icon registry and is never reused for anything else.

## Anatomy

```
6.40% ⊡        ← figure · U+202F · glyph (18×12 viewBox, .75em tall, baseline-aligned)
      └ <button> with a transparent 24×24 ::before hit area
        ┌────────────────────────────────────────────┐
        │ Kamino API · 2026-10-01T14:02:11Z · haircut v2 │  ← popover, Plex Mono text-source
        │ quoted 7.10% · after haircut 6.40%          │
        └────────────────────────────────────────────┘
```

- **Glyph**: `<svg viewBox="0 0 18 12" aria-hidden>`: outline `rect x=.75 y=.75 w=16.5 h=10.5` stroke 1.5, square corners, `stroke: var(--tf-pin-outline)`; pin `circle cx=9 cy=6 r=2.5`.
- **Size**: `height: .75em; width: 1.125em` (fallback when `cap` units are unsupported); scales with the figure's font size.
- **Spacing**: U+202F narrow no-break space between figure and glyph; the pair never wraps apart (wrap them in `white-space: nowrap`).
- **Popover**: on `--popover` (paper-raised / char-2), 1px `--border`, 2px radius, padding 8px 12px, max-width 44ch. Line 1: `source · fetched_at (ISO 8601, UTC) · method` in Plex Mono `text-source`. Line 2 (yields): quoted vs after-haircut, and the haircut rule. Line 3 (stale/mock): the state sentence. Optional "How we measure ↗" link to docs.

## States (from the API, never inferred by the UI)

| State | Source of truth | Glyph | Paired text | `aria-label` |
|---|---|---|---|---|
| **Live** | `provenance: "live"` and not stale | outline + **solid** pin in `--tf-pin` (hardwood on paper, hinoki on dark) | popover only | "Source for 6.40%" |
| **Stale** | `provenance: "live"` + API staleness flag/age | outline + **hollow** ring (stroke 1.5) in `--tf-pin-outline` | **"stale · 3 h"** inline after the glyph, caption, `--muted-foreground`. Always shown | "Source for 6.40%, stale, 3 hours old" |
| **MOCK** | `provenance` ∈ `mock`, `sandbox`, `fixture`, `prior_dataset` | outline filled with 45° hatch, 1px `--tf-hatch`, **3px pitch**, clipped to inner rect; **no pin** | the [MOCK plate](./mock-plate.md) inline ("MOCK"); popover adds the provenance value ("fixture", "sandbox") | "Source for 6.40%, mock data" |
| **Missing** | no source/fetched_at/method | **render nothing**: the figure must not render either. Show "—" with "no source yet" | | |

The live and stale pins differ by only 1.10:1 in luminance, so stale must never rely on the glyph alone. MOCK must never look live: no solid pin, ever.

## Behaviour

- `<button type="button">` wraps the glyph; Enter/Space and click toggle the popover; Escape closes and returns focus; hover opens after 300ms on pointer devices (and the popover is hoverable, 1.4.13). Touch: tap toggles.
- Popover is `role="dialog"` with `aria-label="Provenance"` when it contains a link, else a tooltip (`role="tooltip"`, `aria-describedby`).
- Motion: on first reveal in plan-lock, the pin drops (`--animate-pin-drop`: 6px, 160ms, 120ms delay). Reduced motion: appears with no travel.
- Copy: clicking the source line copies it (`Copy` → `Check` 1.5s).

## Colour per context

| Context | Outline | Pin / hatch |
|---|---|---|
| Paper (light) | stone `#6E655B` | hardwood `#7A5A3A` / stone hatch |
| Warm black (dark) | stone-d `#A49A8E` | hinoki `#E6D3B7` / stone-d hatch |
| Embed | `--embed-muted` | `--embed-muted` (no brand colour) |
| On a status-tinted cell | same as ground | same |

## Accessibility (WCAG 2.2 AA)

- 1.4.11: outline stone 5.08:1 on paper, stone-d 7.10:1 on black; hinoki pin 13.44:1.
- 2.5.8: 24×24 hit area via `::before`, even though the glyph is 12px.
- 1.3.1: state is in the accessible name, not only in the drawing.
- Screen readers read "6.40%, button, Source for 6.40%". Don't repeat the figure in visible text.

## Code hint

```tsx
type Obs = { source: string; fetchedAt: string; method: string; provenance: Provenance; staleAgeSec?: number | null };
export function ProvenancePin({ value, obs }: { value: string; obs: Obs }) {
  const state = obs.provenance !== 'live' ? 'mock' : obs.staleAgeSec != null ? 'stale' : 'live';
  // render: <span className="whitespace-nowrap">{value}{' '}<button …><PinGlyph state={state} /></button>{state==='stale' && <StaleTag age={…}/>}{state==='mock' && <MockPlate size="inline"/>}</span>
}
```

The API response schema (`YieldObservation`, `FxObservation`) already carries `source`, `method`, `fetchedAt`, `provenance`. **Staleness is not yet in the schema** (see open items in INDEX.md).

## Do / don't

| Do | Don't |
|---|---|
| A pin after every yield, price and FX figure, including in tables, KPIs and chart labels | A "live" green pill, or one pin for a whole table |
| "stale · 3 h" next to a hollow pin | A hollow pin alone |
| Hatched glyph + MOCK for any non-live provenance | A solid pin on mock, fixture or sandbox data |
| Hide the figure if there's no source | Show a number with an empty popover |
| Pin in hinoki on dark | A red, blue or hardwood-on-dark pin |
