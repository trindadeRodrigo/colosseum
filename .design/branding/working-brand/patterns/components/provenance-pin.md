# Provenance pin
> Type: custom | Component: `<ProvenancePin>` (`apps/web/components/ProvenancePin.tsx`) | Replaces: `ProvenanceBadge` for figures | Revised 2026-10-08 (the square pin, LOGO-2)

The brand's smallest drawing: the tenon end in line mode, a rounded 3:2 outline with a **square pin set toward the end**, like the mark's face. It follows **every yield, price and FX figure** and opens `source · fetched_at · method`. No pin, no number. It is not in the icon registry and is never reused for anything else.

## Anatomy

```
6.40% ⊡        ← figure · U+202F · glyph (18×12 viewBox, .75em tall, baseline-aligned)
      └ <button> with a transparent 24×24 ::before hit area
        ┌────────────────────────────────────────────┐
        │ Rate from Kamino                            │  ← what it is and where from (Inter, medium)
        │ Updated 2 minutes ago                       │  ← how fresh (muted)
        │ Live                                        │  ← whether it is live (muted)
        │ quoted 7.10% · after haircut 6.40%          │
        │ Details ⌄                                   │  ← opens the API's own source, time and method
        └────────────────────────────────────────────┘
```

- **Glyph**: `<svg viewBox="0 0 18 12" aria-hidden>`: outline `rect x=.75 y=.75 w=16.5 h=10.5 rx=2.5` stroke 1.5, `stroke: var(--tf-pin-outline)`; pin `rect x=11 y=4 w=4 h=4 rx=1`, `fill: var(--tf-pin)`. The pin sits toward the end (x 11–15 of 18), not centred: it is the mark's pin, and the offset keeps it from reading as a button.
- **Size**: `height: .75em; width: 1.125em` (fallback when `cap` units are unsupported); scales with the figure's font size.
- **Spacing**: U+202F narrow no-break space between figure and glyph; the pair never wraps apart (wrap them in `white-space: nowrap`).
- **Popover**: on `--popover` (white / night-3 `#1A1D26`), 1px `--border`, 8px radius, `shadow-popover` (`0 8px 24px rgba(0,0,0,.35)`: the one shadow in the system), padding 8px 12px, max-width 21rem, in Inter `text-body-sm` (gate `TOOLTIP-WORDS`, Thom, Oct 9). It says, in this order: what the number is (where the screen names it) and where it comes from, in plain words ("Price from the test network's price feed"); how fresh it is ("Updated 2 minutes ago"); whether it is live ("Live", "Test network, not live", "Sample figure, not live"). A stale reading says so first ("Last updated 19 hours ago, older than this feed's 2 minute limit"), with the age the API states. Then, for a yield, quoted vs after-haircut and the haircut rule. Then **Details**, closed until asked for: the API's own `source`, the exact time (UTC) and the `method`, as words in Inter; each address shortened in the middle, in Plex Mono, with its own copy button and its explorer page where the screen knows the network's; "Copy all" copies `source · fetched_at (ISO 8601, UTC) · method` as the API wrote it. A source's plain name comes from the table in `apps/web/components/ui/source-words.ts`; one it does not know reads "Source details below" and is never guessed at. Optional "How we measure ↗" link to docs.

## States (from the API, never inferred by the UI)

| State | Source of truth | Glyph | Paired text | `aria-label` |
|---|---|---|---|---|
| **Live** | `provenance: "live"` and not stale | outline + **solid square** pin in `--tf-pin` (honey-l on light, honey on dark) | popover only | "Source for 6.40%" |
| **Stale** | `provenance: "live"` + API staleness flag/age | outline + **hollow square** (`rect x=11.75 y=4.75 w=2.5 h=2.5 rx=.6`, stroke 1.5, same `--tf-pin` colour) | **"stale · 3 h"** inline after the glyph, Plex Mono 13px, `--muted-foreground`. Always shown | "Source for 6.40%, stale, 3 hours old" |
| **Sample** | `provenance` ∈ `mock`, `fixture`, `prior_dataset` | outline filled with 45° hatch, 1px `--tf-hatch`, **3px pitch**, clipped to the inner rect (`rx 1.75`); **no pin** | nothing boxed beside the figure (gate MOCK-QUIET): the card says "Sample figures" once in a muted line beside its hatched edge ([mock-plate.md](./mock-plate.md)); popover adds the provenance value ("fixture", "prior_dataset") | "Source for 6.40%, sample figure" |
| **Test network** | `provenance: "sandbox"` | same as sample | the card's line reads **"Sample figures · test network"**, muted, no box | "Source for 6.40%, sample figure, test network" |
| **Missing** | no source/fetched_at/method | **render nothing**: the figure must not render either. Show "—" with "no source yet" | | |

Live and stale differ only by the pin's fill, so stale must never rely on the glyph alone. Sample and test network figures must never look live: no solid pin, ever, and never styled like a live figure. A sample figure that has no pin of its own carries the 12 × 12 hatched glyph `<SampleGlyph>` (`aria-label="sample figure"`, see [mock-plate.md](./mock-plate.md)).

## Behaviour

- `<button type="button">` wraps the glyph; Enter/Space and click toggle the popover; keyboard focus opens it; Escape closes and returns focus; hover opens after 300ms on pointer devices (and the popover is hoverable, 1.4.13). Touch: tap toggles. It is placed against the viewport, under the pin or above it when there is no room below, never over the pin and never past an edge; it fades in over 120ms, and not at all under reduced motion. The behaviour is the one tooltip's (`Hint.tsx`, `hover-card.ts`), which every plain tooltip shares.
- Popover is `role="dialog"` with `aria-label="Source details"`: it holds controls (Details, copy). The pin points at its plain sentences with `aria-describedby` while it is open. A plain tooltip (`Hint`) is `role="tooltip"`.
- Motion: on first reveal in plan-lock, the pin drops (`--animate-pin-drop`: 6px, 160ms, 120ms delay). Reduced motion: appears with no travel.
- Copy: under Details, each address has its own copy button and "Copy all" copies the API's line (`Copy` → `Check` 1.5s, announced).

## Colour per context

| Context | Outline (`--tf-pin-outline`) | Pin (`--tf-pin`) | Hatch (`--tf-hatch`) |
|---|---|---|---|
| Paper (light) | line-l2 `#C9C4B9` | honey-l `#9D5A00` | muted-l `#676A75` |
| Night (dark) | muted-2 `#6E7282` | honey `#F5A83A` | muted `#9A9DAD` |
| Embed | `--embed-muted` | `--embed-muted` (no brand colour) | `--embed-muted` |
| On a status-tinted pill or a honey-tinted row | same as ground | same | same |

## Accessibility (WCAG 2.2 AA)

- 1.4.11: the pin itself is the state carrier: honey-l 5.39:1 on white, honey 9.75:1 on night (8.45 on night-3). The outline is a non-text frame (line-l2 1.74 / muted-2 4.06) and carries no meaning on its own.
- 2.5.8: 24×24 hit area via `::before`, even though the glyph is 12px.
- 1.3.1: state is in the accessible name, not only in the drawing.
- 2.4.7: the 2px chalk focus ring around the 24×24 hit area.
- Screen readers read "6.40%, button, Source for 6.40%". Don't repeat the figure in visible text.

## Code hint

```tsx
type Obs = { source: string; fetchedAt: string; method: string; provenance: Provenance; staleAgeSec?: number | null };
export function ProvenancePin({ value, obs }: { value: string; obs: Obs }) {
  const state = obs.provenance === 'live' ? (obs.staleAgeSec != null ? 'stale' : 'live')
              : obs.provenance === 'sandbox' ? 'sandbox' : 'mock';
  // render: <span className="whitespace-nowrap">{value}{' '}<button …><PinGlyph state={state} /></button>
  //   {state==='stale' && <StaleTag age={…}/>}</span>
  // sample and sandbox: nothing beside the figure; the enclosing card renders <SampleLine provenance={obs.provenance}/> once (gate MOCK-QUIET)
}
```

The API response schema (`YieldObservation`, `FxObservation`) already carries `source`, `method`, `fetchedAt`, `provenance`. **Staleness is not yet in the schema** (see open items in INDEX.md).

## Do / don't

| Do | Don't |
|---|---|
| A pin after every yield, price and FX figure, including in tables, KPIs and chart labels | A "live" green pill, or one pin for a whole table |
| "stale · 3 h" next to a hollow square | A hollow pin alone |
| Hatched glyph for any non-live provenance, and the card's muted sample line (+ "test network" for sandbox) | A solid pin on mock, fixture, prior-dataset or sandbox data |
| Hide the figure if there's no source | Show a number with an empty popover |
| A square pin in honey (night) / honey-l (day) | A circle pin, a red or blue pin, or white on honey |
