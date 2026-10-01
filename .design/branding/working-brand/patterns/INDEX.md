# Guidelines
> Phase: guidelines (Pass 1: Core, Pass 2: Components) | Brand: Tenonfi (provisional; fallback "Tenon"; slug `working-brand`) | Generated: 2026-10-01

## Core

| File | Description |
|------|-------------|
| [working-brand.yml](./working-brand.yml) | Style preset: the single source of truth. Its tokens follow the shadcn-flat schema and are validated with `theme-css.js` |
| [STYLE.md](./STYLE.md) | Agent contract, rendered from the .yml. Binding rules, patterns, constraints, effects, bold bets and Tailwind v4 hints |
| [guidelines.html](./guidelines.html) | Visual brand guide (open it in a browser). Light and dark: use the toggle, or open with `?theme=dark` |

## Components
> Pass 2: Components | Generated: 2026-10-01 | Library: none (Tailwind v4 `@theme` + CSS vars, shadcn-compatible names)

| File | Type | Description |
|------|------|-------------|
| [token-mapping.md](./components/token-mapping.md) | mapping | Brand tokens → Tailwind v4 `@theme` + shadcn-native CSS vars (OKLCH from `theme-css.js`), `--tf-*` brand extensions, fonts, theme switching, wallet-adapter overrides, embed vars, and how each existing `apps/web` component consumes them |
| [button.md](./components/button.md) | override | primary / secondary / link / chip / icon / destructive; species-press; one primary per view; no spinner, no auto-retry |
| [field.md](./components/field.md) | override | Input, select, textarea: member edge, sunk well, visible labels, "what to change" errors |
| [card.md](./components/card.md) | override | Planed face: hairline, no shadow, one serif line max; stat cell; MOCK and loading states |
| [data-table.md](./components/data-table.md) | override | Captioned, scoped, tabular-mono tables with pins; status by word + shape; shared execution list with `Tx ↗` explorer links |
| [composer.md](./components/composer.md) | custom | **Founder change:** the typing box is the one rounded shape (20px container, round send button). Goal input and subscribe field |
| [provenance-pin.md](./components/provenance-pin.md) | custom | J1 pin after every yield/price/FX figure: live, stale, MOCK; source · fetched_at · method popover |
| [mock-plate.md](./components/mock-plate.md) | custom | 45° hatch band + MOCK on a solid plate; placements; DOM enforcement |
| [goal-card.md](./components/goal-card.md) | custom | Goal sentence (serif) → status mark + word → amount with pin → one link |
| [plan-leg.md](./components/plan-leg.md) | custom | Stacked bar (≤ 4 legs, 2px ground gaps) with direct labels; MOCK leg; no xStocks in income |
| [exit-plan-line.md](./components/exit-plan-line.md) | custom | Compact exit line and "Access to cash" panel with J3 and dashed dimension lines |
| [constraint-sheet.md](./components/constraint-sheet.md) | custom | Editable sheet with human labels, error summary, per-field errors; solve blocked on invalid input |
| [embed-shell.md](./components/embed-shell.md) | custom | Bare `/embed` root (no Nav, no wallet), partner skin, what survives, "Powered by tenonfi" |
| [bearing-heatmap-tile.md](./components/bearing-heatmap-tile.md) | custom | 24 × 7 hour-of-week depth lattice in a Bearing tile; stale/MOCK; table alternative |
| [disclaimer-block.md](./components/disclaimer-block.md) | custom | `DISCLAIMER` verbatim, body size, hairline box, under the plan and atop API docs |
| [compact-nav.md](./components/compact-nav.md) | custom | Landing header: full bar → centred compact bar with menu from step 03; solid, no blur |
| [goal-showcase-case.md](./components/goal-showcase-case.md) | custom | Photo + prompt + plan panel + chart + KPIs + MOCK; fixture-driven figures |
| [joint-stage.md](./components/joint-stage.md) | custom | Pinned 3D/2D hero that seats on scroll and releases; reduced-motion and no-WebGL fallbacks |
| [subscribe-block.md](./components/subscribe-block.md) | custom | Closing section with composer-shaped email field, options, status messages |

Tier 2 + 3 total 18 specs, above the methodology's 5–12 guide, because the caller required the custom list explicitly.

### Prototype deltas (hero-3d.html vs the confirmed `.yml`; the `.yml` wins in the specs)

The approved landing prototype is the reference for structure, but these details break confirmed constraints, so the specs correct them: frosted/blurred compact nav → solid; prompt text on photos over gradient scrims → solid plate below; photo filter → none; uppercase eyebrows and step labels → sentence case; infinite scroll-cue animation → static; mobile gradient plate behind copy → opaque; MOCK text on hatch → band beside plate; 7px hatched circle → J1 pin; "Simulation. Not investment advice." → `DISCLAIMER_SHORT` + full block; in-script sample rates → `fixtures/` with `"provenance": "mock"`.

### Open items (need a decision)

1. **Staleness is not in the API schema.** `YieldObservation`/`FxObservation` carry `source`, `method`, `fetchedAt`, `provenance` but no stale flag or max-age. The pin spec requires the API to state staleness (the UI must not infer it). Needs a schema field (e.g. `staleAfterSec` or `stale: { ageSec }`).
2. **Provenance enum has five values** (`live`, `mock`, `sandbox`, `fixture`, `prior_dataset`). Specs treat every non-live value as MOCK (hatch + MOCK, the value in the popover). Confirm.
3. **Bearing no-sample cells:** brand-applications.md says "hatched"; the `.yml` reserves the hatch for MOCK and stale. The heatmap spec uses an empty cell with an en dash instead. Confirm or amend the `.yml`.
4. **`DISCLAIMER_SHORT`** exists beside `DISCLAIMER` in `packages/schemas`. The specs allow it only as an in-panel pointer alongside a full block. Confirm.
5. **`ArrowUp`** (composer send) is not in the curated icon registry (iconography.md §6); add it.
6. **Subscribe consent:** the prototype pre-checks both boxes; the newsletter should probably be unchecked by default (LGPD/GDPR).
7. **Composer radius tokens** (`--tf-radius-composer`, `--tf-radius-round`) are referenced here; the coordinator is adding them to `working-brand.yml` and STYLE.md.

## Token decisions made in this pass

- `accent` is shadcn's hover/selected surface (paper-sunk / char-2), not a second hue. The memorable colour is `primary` (hardwood / hinoki).
- `border` = hair (decoration only) and `input` = member (control edges), so shadcn cards get hairlines and form controls meet 3:1.
- `--radius` is 2px. shadcn's `calc(var(--radius) - 4px)` clamps to 0, which is intended because joinery is square.
- `chart-1…4` are the plan legs (wood-400 `#9D7751` on light, per the colour pass), and `chart-5` is the base-case line (ink / washi).
- Hover is wood-600 `#63482E` on light, and `#D7C09E` (the midpoint of hinoki and hinoki-deep) on dark. Pressed uses heartwood / hinoki-deep.
- Hatch pitch is 6px in UI, 3px in glyphs and 4px in SVG drawings. The colour pass supersedes the 4px from imagery for UI surfaces.
- All shadows are `none`. Depth comes from three warm layers plus hairlines.
- The guidelines hero is always on warm black (an inverted section). It "feels alive" through the J1 lock animation (seat, then pin), which runs once, instead of the template's animated gradient (the brand bans gradients and ambient loops).
