# Plan leg (bar + labelled legs)
> Type: custom | Component: `<PlanLegs>` | Replaces: the Allocation table header area in PlanView; used in the showcase case and simulator

The plan as pieces: a stacked horizontal bar of at most four legs, each with a direct label. The bar shows proportion; the labels carry meaning.

## Anatomy

```
███████████████▕███████▕█████▕▨▨▨▨▨          ← bar: 12px tall (24px consumer hero), 2px ground-colour gaps, 0 radius
Tokenized treasuries · 45% · 4.10% ⊡ after haircut · quoted 4.35%   ← leg label (direct, in leg order)
Dollar lending · 25% · 5.02% ⊡ · quoted 6.80%
Cash buffer · 20% · — · reachable today
▨ BRL leg · 10% · MOCK · integration in progress
```

- **Bar**: `display:flex; gap:2px; background: var(--background)` (the gap is ground colour, not a border). Segment fills in leg order: `--chart-1`…`--chart-4` (light: hardwood, heartwood, wood-400 `#9D7751`, stone; dark: hinoki, hinoki-deep, wood-400, stone-d). Segment width = weight. Max 4 legs; the solver output decides order (largest first).
- **Leg label** (one row each, in a `<ol>`): 10px square swatch (same fill) → leg name (Plex Sans 500) · weight (mono, tabular) · after-haircut yield + [pin](./provenance-pin.md) · "quoted x%" in `--muted-foreground` · optional "why" line below in caption muted. All yields come from `YieldObservation` (never literals).
- **MOCK leg**: segment is `.tf-hatch` on `--card` (no solid fill); its label row has a 6px hatch band and the [MOCK plate](./mock-plate.md). Legs with `mintPath: "unavailable"` read "integration in progress" and are never executed.

## Tokens

`--chart-1..4`, `--background` (gap), `--tf-hatch`, `--muted-foreground`, Plex Mono for weights and rates.

## States and motion

| State | Treatment |
|---|---|
| Plan-lock (first render) | legs fade in at exploded offsets (160ms, 60ms stagger) → seat on x (320ms, `--ease-seat`) → pins drop 120ms later. Runs once. Reduced motion: 120ms crossfade |
| Hover / focus on a label | the matching segment gets a 2px `--foreground` top rule; others unchanged. No dimming |
| "Why this plan?" | part-and-close: segments part 12–24px, callout rows fade in, then close |
| Stress case selected | bar unchanged (it's the allocation); the schedule chart shows the stress |

## The mix joint

A mix proposed in a conversation (`<MixJoint>`, in the strategy preview) holds up to sixteen assets and cash, so it is not a four-leg bar. It is drawn as one joint lying flat: a 44px beam of pieces end to end, one per asset and as wide as its share, in the wood ramp in turn, each seated in the piece before it by a tenon (a sliver under 7% of the beam carries none). The landing's standing post is drawn for four parts; at this width its layers and labels would collide.

- Each piece is a button named "asset, share", the share being the figure its row shows. The beam is one tab stop; the arrows walk the pieces and Escape lets go.
- The row under the beam carries the piece's swatch. Pointing at a piece (mouse, focus, tap) lifts it 4px, dims the others and lights its row; pointing at a row lights its piece. A line under the beam names the lit piece and its share, for a phone whose row is far down.
- A new mix is the plan-lock: each piece fades in 14px apart (160ms) and slides its tenon home (320ms), 60ms after the one before (less for many pieces, so all are seated within 0.9s); each row fades in as its piece starts to slide, and its share drops in like a pin. Under 1.2s in all.
- A mix that follows another moves only the difference: a piece slides to its place and its face grows or shrinks, a new piece seats, a dropped one fades where it lay, and only a share that changed drops in again.
- While the next reply is on its way the draft stays, dimmed, with one status line beside the loader ("Working on a new draft. This is the one before it.") and its action waits.
- Every figure is the proposal's own from the first frame. A share is never counted up to. Only transform and opacity move, so nothing shifts. With reduced motion nothing moves and each mix is simply there.

## Rules

- Direct labels always. Never a legend-only bar or a colour key away from the bar.
- Max 4 legs. If the solver returns more, the spec is violated: surface it as an engine error, don't squeeze.
- **Income profiles: no equity (xStocks) leg can appear.** The asset registry enforces it; the component adds a dev assertion that throws if `profile === 'income'` and any leg `kind === 'equity'`.
- The BRL leg is abstract: label it by its parameters (cap, mint path), not by a partner product name.
- Hinoki-deep is never a fill on paper (1.89:1); use wood-400.

## Accessibility

Bar is `aria-hidden`; the `<ol>` of labels carries everything. 1.4.11: adjacent segments are separated by the 2px gap, and each segment vs ground ≥ 3:1 (wood-400 3.60 on paper; stone-d 7.10 on black). Swatches are redundant with names.

## Do / don't

| Do | Don't |
|---|---|
| "4.10% ⊡ after haircut · quoted 4.35%" | Only the quoted rate, or a rate without a pin |
| Hatched segment + MOCK for a mock leg | A grey or lighter solid segment for mock |
| Gaps in ground colour | Rounded segments, gradients, a donut |
