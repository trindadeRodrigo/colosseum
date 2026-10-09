# Plan leg (bar + labelled legs)
> Type: custom | Component: `<PlanLegs>` | Replaces: the Allocation table header area in PlanView; used in the showcase case and simulator | Revised 2026-10-08 (honey on night)

The plan as pieces: a stacked horizontal bar of at most four legs, each with a direct label. The bar shows proportion; the labels carry meaning.

## Anatomy

```
(█████████████████▕████████▕█████▕▨▨▨▨▨)      ← bar: 12px tall (24px consumer hero), pill ends, 2px ground-colour gaps
Tokenized treasuries · 45% · 4.10% ⊡ after haircut · quoted 4.35%   ← leg label (direct, in leg order)
Dollar lending · 25% · 5.02% ⊡ · quoted 6.80%
Cash buffer · 20% · — · reachable today
▨ BRL leg · 10% · sample · integration in progress
```

- **Bar**: a `rounded-full overflow-hidden` container with `display:flex; gap:2px; background: var(--background)` (the gap is ground colour, not a border; the container's pill ends round only the first and last segment). Segment fills in leg order `--chart-1`…`--chart-4`: **light** honey `#F5A83A`, honey-deep `#D9881B`, wood-deep `#B9803F`, muted-l `#6A6D78`; **dark** honey, wood `#E9C48E`, honey-deep, muted `#9A9DAD`. Segment width = weight. Max 4 legs; the solver output decides order (largest first).
- **Leg label** (one row each, in a `<ol>`): 10px swatch (same fill, `rounded-[3px]`) → leg name (Inter 600) · weight (Inter, tabular) · after-haircut yield + [pin](./provenance-pin.md) · "quoted x%" in `--muted-foreground` · optional "why" line below in body-sm muted. All yields come from `YieldObservation` (never literals).
- **Sample leg**: segment is `.tf-hatch` on `--card` (no solid fill); its figure keeps the hatched pin ("sample figure"), and the card that holds the bar keeps a 6px hatched left edge with one muted line, "Sample figures" (+ " · test network" for sandbox), no box ([mock-plate.md](./mock-plate.md), gate MOCK-QUIET). Legs with `mintPath: "unavailable"` read "integration in progress" and are never executed.

## Tokens

`--chart-1..4`, `--background` (gap), `--tf-hatch`, `--muted-foreground`, Inter tabular for weights and rates (Plex Mono only in the pin popover).

## States and motion

| State | Treatment |
|---|---|
| Plan-lock (first render) | legs fade in at exploded offsets (160ms, 60ms stagger) → seat on x (320ms, `--ease-seat`) → pins drop 120ms later. Runs once. Reduced motion: 120ms crossfade |
| Hover / focus on a label | the matching segment gets a 2px chalk rule above it (the carpenter's selection line); others unchanged. No dimming |
| "Why this plan?" | part-and-close: segments part 12–24px, callout rows fade in, then close |
| Stress case selected | bar unchanged (it's the allocation); the schedule chart shows the stress |

## The mix joint

A mix proposed in a conversation (`<MixJoint>` in `features/shared`, with `useJointMotion` for its arrival and changes; first used by the strategy preview) holds up to sixteen assets and cash, so it is not a four-leg bar. It is drawn as one joint lying flat: a 44px beam of pieces end to end, one per asset and as wide as its share (see the next point for the one exception), in the wood ramp in turn, with its asset's mark wherever the piece is 36px wide or more on that screen, each seated in the piece before it by a tenon (a sliver under 7% of the beam carries none). The landing's standing post is drawn for four parts; at this width its layers and labels would collide.

- A share under 3% of the beam is drawn at 3%, so it can be seen and pointed at, and the others give up the room in proportion: 90% and ten lines of 1% are drawn 70 / 30. Whenever that happens the line under the beam and the drawing's accessible name say so ("Small shares are drawn wider so they can be seen; the figures in the list are exact."), in place of "as wide as its share". The rows and the piece names are always exact.
- Each piece is a button named "asset, share", the share being the figure its row shows. The beam is a toolbar: one tab stop, the arrows walk the pieces and Escape lets go. Being lit is a highlight, not a pressed state. If the next mix drops the piece that had the focus, the beam takes it.
- The row under the beam carries the piece's swatch. Pointing at a piece (mouse, focus, tap) lifts it 4px, dims the others and lights its row; pointing at a row lights its piece. On a phone a sliver is about 9px wide: the row is the target there, and it is a full line. A line under the beam names the lit piece and its share, for a phone whose row is far down.
- A new mix is the plan-lock: each piece fades in 14px apart (160ms) and slides its tenon home (320ms), 60ms after the one before (less for many pieces, so all are seated within 0.9s); each row fades in as its piece starts to slide, and its share drops in like a pin. Under 1.2s in all.
- A mix that follows another moves only the difference: a piece slides to its place and its face grows or shrinks, a new piece seats, a dropped one fades where it lay, and only a share that changed drops in again.
- On `/goal`, while the next reply is on its way the draft stays with one status line beside the loader ("Reading what you said. This is the last draft."; the reply may be a question, so no new draft is promised) and its action waits. Only the beam recedes (70%): every word and figure keeps its contrast. A reply with no proposal, or none at all, keeps the last draft and gives its action back (gate `DEPOSIT-STEP`): asking for a change never costs the person the mix they had, and an open deposit step stays open. In a vault's own conversation a draft is never kept while the next is asked for: nothing stale stands beside a funded vault.
- Every figure is the proposal's own from the first frame. A share is never counted up to. Only transform and opacity move, so nothing shifts. With reduced motion nothing moves and each mix is simply there, with no crossfade either; that differs from STYLE.md's 120ms crossfade and is open for Rodrigo (gate `MIX-JOINT`).

## Rules

- Direct labels always. Never a legend-only bar or a colour key away from the bar.
- Max 4 legs. If the solver returns more, the spec is violated: surface it as an engine error, don't squeeze.
- **Income profiles: no equity (xStocks) leg can appear.** The asset registry enforces it; the component adds a dev assertion that throws if `profile === 'income'` and any leg `kind === 'equity'`.
- The BRL leg is abstract: label it by its parameters (cap, mint path), not by a partner product name.
- Leg colours are the honey family plus one neutral: never leaf, clay or madder as a leg (direction colours mean direction), never a rainbow.

## Accessibility

Bar is `aria-hidden`; the `<ol>` of labels carries everything. 1.4.11: adjacent segments are separated by the 2px ground gap; against paper the light legs are honey 1.83, honey-deep 2.57, wood-deep 3.10 and muted-l 4.73, so on light the bar is **not** a sole carrier of information: the swatch + name + weight row is. On night every leg is ≥ 6.9:1 (honey 9.75, wood 11.79, honey-deep 6.92, muted 7.21). Swatches are redundant with names.

## Do / don't

| Do | Don't |
|---|---|
| "4.10% ⊡ after haircut · quoted 4.35%" | Only the quoted rate, or a rate without a pin |
| Hatched segment + hatched pin for a sample leg, and the card's sample line | A grey or lighter solid segment for a sample leg, or a boxed label beside it |
| Pill ends on the bar, gaps in ground colour | Rounded segments inside the bar, gradients, a donut |
| Honey family + one neutral | Green or red legs |
