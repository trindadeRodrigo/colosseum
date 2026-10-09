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

- **Bar**: a `rounded-full overflow-hidden` container with `display:flex; gap:2px; background: var(--background)` (the gap is ground colour, not a border; the container's pill ends round only the first and last segment). Segment fills in leg order `--chart-1`…`--chart-4`: **light** honey `#F5A83A`, honey-deep `#D9881B`, wood-deep `#B9803F`, muted-l `#676A75`; **dark** honey, wood `#E9C48E`, honey-deep, muted `#9A9DAD`. Segment width = weight. Max 4 legs; the solver output decides order (largest first).
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

## A draft's holdings on the bar

A draft proposed in a conversation is drawn on this bar (`<HoldingLegs>` in `features/shared`, which hands `<PlanLegs>` its legs; the preview card at 24px, the deposit step at 12px). It supersedes the mix joint (Thom, 2026-10-09: the preview uses Rodrigo's plan bar; gate `MIX-JOINT`).

- A draft may hold up to sixteen assets and cash, and the bar takes four legs ("more than 4 legs: group them", color-system.md). Four holdings or fewer are a leg each. With five or more, the three largest are a leg each and the rest are one leg, labelled with how many they are ("9 others") and the sum of their shares. The legs lie largest first, as above (the earlier of two equal ones first), the grouped leg where its sum puts it: first, when sixteen equal holdings leave it 81.25%.
- Under the bar's labels a row lists every holding, in the draft's order, with its exact share and its reason. A row's swatch is the colour of the leg it is drawn in, so grouped holdings share one.
- No rate is shown on a leg: a share is not a yield. Pointing at a label rules its segment; nothing is dimmed and no row lights.
- A draft arrives as the plan-lock, once; the next draft is a new plan and seats again. Reduced motion: the 120ms crossfade.
- Every figure is the proposal's own from the first frame. A share is never counted up to.
- On `/goal`, while the next reply is on its way the draft stays, and the card says plainly that it is the one from before: a banner leads the card on the honey tint, with the loader ("Reading your message. Below is the draft from before."; the reply may be a question, so no new draft is promised), the whole draft is set back (its ink goes to `--muted-foreground`; nothing is dimmed, the bar keeps its colours, and every word and figure keeps 4.5:1), and the action keeps its place and says "Waiting for the reply…" beside the loader. The banner's place and the action's width are kept when there is no wait, so nothing on the card moves. The wait is announced once by the conversation, not by the card. Before a first draft the card says "Working on your first draft" at heading size with the loader and still boxes where the bar and rows will be; in a vault's own conversation the same card says "Working on a reply" and promises no draft. A reply with no proposal, or none at all, keeps the last draft and gives its action back (gate `DEPOSIT-STEP`): asking for a change never costs the person the mix they had, and an open deposit step stays open. In a vault's own conversation a draft is never kept while the next is asked for: nothing stale stands beside a funded vault.

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
