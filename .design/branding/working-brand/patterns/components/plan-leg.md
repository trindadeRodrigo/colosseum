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
