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
