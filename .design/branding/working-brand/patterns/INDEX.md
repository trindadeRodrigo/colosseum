# Guidelines
> Phase: guidelines (Pass 1: Core, Pass 2: Components) | Brand: Tenonfi (provisional; fallback "Tenon"; slug `working-brand`) | Generated: 2026-10-01 | Revised 2026-10-08 on `IDENTITY-2` and `LOGO-2` (docs/GATES.md): honey on night

## Core

| File | Description |
|------|-------------|
| [working-brand.yml](./working-brand.yml) | Style preset: the single source of truth. Its tokens follow the shadcn-flat schema; `working-brand.theme.json` is generated from it in OKLCH |
| [STYLE.md](./STYLE.md) | Agent contract, rendered from the .yml. Binding rules, patterns, constraints, effects, bold bets and Tailwind v4 hints |
| [guidelines.html](./guidelines.html) | Visual brand guide (open it in a browser). Light and dark: use the toggle, or open with `?theme=dark` |

## Components
> Pass 2: Components | Generated: 2026-10-01 | Revised 2026-10-08 to honey on night (every spec states the new tokens, fonts and radii) | Library: none (Tailwind v4 `@theme` + CSS vars, shadcn-compatible names)

| File | Type | Description |
|------|------|-------------|
| [token-mapping.md](./components/token-mapping.md) | mapping | Brand tokens → Tailwind v4 `@theme` + shadcn-native CSS vars (names unchanged, values regenerated in OKLCH from `working-brand.theme.json`), `--tf-*` brand extensions from `brand-color`, radii (8 / 10 / 6 / 16 / pill / 20px composer), Inter Tight · Inter · Plex Mono, theme switching, wallet-adapter overrides, embed vars, and how each existing `apps/web` component consumes them |
| [button.md](./components/button.md) | override | primary (honey, ink on it) / secondary / link (honey-l) / chip (pill, honey-tint when selected) / icon / destructive; honey-press; one primary per view; no spinner, no auto-retry |
| [field.md](./components/field.md) | override | Input, select, textarea: line-l2 / line-2 edge on a paper-3 / night-3 well, 8px, visible uppercase labels, chalk focus ring, "what to change" errors in madder |
| [card.md](./components/card.md) | override | Raised surface: white / night-2, hairline, 10px, no shadow, one Inter Tight line max; stat cell with figure-lg and a signed delta; honey-tint when selected; sample and loading states |
| [data-table.md](./components/data-table.md) | override | Captioned, scoped tables with tabular Inter figures, pins and signed deltas; 44 / 36px rows; honey-tint selected row; status pills; shared execution list with `Tx ↗` explorer links |
| [composer.md](./components/composer.md) | custom | The typing box: 20px container on the card fill, round honey send button with the ink arrow, chalk ring on the container, on the glow in the first viewport. Goal input and subscribe field |
| [provenance-pin.md](./components/provenance-pin.md) | custom | The square pin after every yield/price/FX figure: live (solid), stale (hollow + "stale · 3 h"), sample (hatched, "sample figure"), test network (the card's line adds the words); source · fetched_at · method popover with the one shadow |
| [mock-plate.md](./components/mock-plate.md) | custom | Sample marking (gate MOCK-QUIET): the card's 6px hatched left edge + one muted line "Sample figures" / "Sample figures · test network", hatched pin or glyph named "sample figure"; no boxed MOCK; placements; DOM enforcement |
| [goal-card.md](./components/goal-card.md) | custom | Eyebrow → amount in figure-lg with pin → one line → status pill on a 14% tint → honey progress bar → one link |
| [plan-leg.md](./components/plan-leg.md) | custom | Stacked bar with pill ends (≤ 4 legs, 2px ground gaps) in the honey family; direct labels; sample leg; no xStocks in income |
| [exit-plan-line.md](./components/exit-plan-line.md) | custom | Compact exit line and "Access to cash" panel with J3 and dashed chalk dimension lines |
| [constraint-sheet.md](./components/constraint-sheet.md) | custom | Editable sheet with human labels, madder-tint error summary, per-field errors; solve blocked on invalid input |
| [embed-shell.md](./components/embed-shell.md) | custom | Bare `/embed` root (no Nav, no wallet), partner skin, what survives, "Powered by tenonfi" with the mono 16 cut |
| [bearing-heatmap-tile.md](./components/bearing-heatmap-tile.md) | custom | 24 × 7 hour-of-week depth lattice in a night-2 tile (10px, 16px padding); honey lightness ramp; b-kpi in Inter Tight with a signed delta; stale/sample; table alternative |
| [disclaimer-block.md](./components/disclaimer-block.md) | custom | `DISCLAIMER` verbatim, body size, hairline 10px box, under the plan and atop API docs |
| [compact-nav.md](./components/compact-nav.md) | custom | Landing header: the face + Inter Tight wordmark → centred compact bar with menu from step 03; solid, no blur; honey CTA |
| [goal-showcase-case.md](./components/goal-showcase-case.md) | custom | Superseded on the landing by `LANDING-HERO` (Oct 8): was the sample person, prompt and plan panel |
| [joint-stage.md](./components/joint-stage.md) | custom | Superseded on the landing by `LANDING-HERO` (Oct 8): was the pinned 3D/2D hero on night that seats on scroll |
| [subscribe-block.md](./components/subscribe-block.md) | custom | Closing section with the composer-shaped email field and a pill Subscribe button, options, status messages |

Tier 2 + 3 total 18 specs, above the methodology's 5–12 guide, because the caller required the custom list explicitly.

### Prototype deltas (hero-3d.html vs the confirmed `.yml`; the `.yml` wins in the specs)

The approved landing prototype is the reference for structure, but these details break confirmed constraints, so the specs correct them: frosted/blurred compact nav → solid; prompt text on photos over gradient scrims → solid plate below; photo filter → none; uppercase step labels → sentence case (12px uppercase stays allowed for caption eyebrows and column heads); infinite scroll-cue animation → static; mobile gradient plate behind copy → opaque (the honey glow is the only gradient, behind the joint, never under text); MOCK text on hatch → the case's hatched edge + "sample rates, not live" (gate MOCK-QUIET, Oct 6: no boxed MOCK beside a figure, anywhere); 7px hatched circle → the square-pin glyph in its sample state; brown wood palette, serif headings and wordmark → honey on night, Inter Tight 600 and the face (IDENTITY-2, LOGO-2, 2026-10-08); `#D7C09E` CTA hover → `--tf-honey-hover`; "Simulation. Not investment advice." → `DISCLAIMER_SHORT` + full block; in-script sample rates → `fixtures/` with `"provenance": "mock"`.

### Open items (need a decision)

1. **Staleness is not in the API schema.** `YieldObservation`/`FxObservation` carry `source`, `method`, `fetchedAt`, `provenance` but no stale flag or max-age. The pin spec requires the API to state staleness (the UI must not infer it). Needs a schema field (e.g. `staleAfterSec` or `stale: { ageSec }`).
2. **Provenance enum has five values** (`live`, `mock`, `sandbox`, `fixture`, `prior_dataset`). Specs treat every non-live value as sample (hatched pin + the card's muted sample line, the value in the popover; `sandbox` adds "test network"). Confirm.
3. **Bearing no-sample cells:** brand-applications.md says "hatched"; the `.yml` reserves the hatch for sample and stale. The heatmap spec uses an empty cell with an en dash instead. Confirm or amend the `.yml`.
4. **`DISCLAIMER_SHORT`** exists beside `DISCLAIMER` in `packages/schemas`. The specs allow it only as an in-panel pointer alongside a full block. Confirm.
5. **`ArrowUp`** (composer send) is not in the curated icon registry (iconography.md §6); add it.
6. **Subscribe consent:** the prototype pre-checks both boxes; the newsletter should probably be unchecked by default (LGPD/GDPR).
7. **Composer radius tokens**: resolved 2026-10-08. `working-brand.yml` carries `border-radius-composer: 20px` and `border-radius-pill: 9999px`; the mapping emits them as `--tf-radius-composer` and `--tf-radius-pill` (`rounded-composer`, `rounded-full`).
8. **Light-mode status pills**: closed 2026-10-08. clay-l and madder-l were darkened to `#A8481A` / `#B52F44` everywhere in the folder; on their 14% tints over white they are 5.04 and 5.19 (leaf-l 4.52), AA at 12px 600. The guidelines and the specs state the new ratios.
9. **The mark's clear space and minimum sizes**: closed 2026-10-08, recorded in identity/logo-directions.md and LOGO-2 (docs/GATES.md): clear space 0.25 H on every side for every cut and lockup (8 px at 32, 4 px at 16; the partner card's padding counts in the credit); cuts: small 12–19 px, 24 hint 20–27 px, master ≥ 28 px; below 12 px, text-only "Powered by tenonfi". The guidelines state these values.
10. **Day text below AA**: closed 2026-10-09 (WEB-IDENTITY-2, the e2e axe checks). honey-l, muted-l, leaf-l and clay-l were darkened in OKLCH lightness only, by the least that carries every pair the specs put together to 4.5:1 (links and muted text in wells, on paper, on the hover tint and on the status tints; status words on their tints over paper): honey-l `#A8640A` → `#9D5A00`, muted-l `#6A6D78` → `#676A75`, leaf-l `#1B7F45` → `#117940`, clay-l `#A8481A` → `#A64618`, everywhere in the folder and in `apps/web/app/globals.css`. On white they are now 5.39, 5.39, 5.48 and 5.98; the known-gaps list in `contrast.test.ts` keeps only the control-edge hairlines. A status pill inside a row already on its tint draws no second tint (`Status onTint`).

## Token decisions made in this pass

Revised 2026-10-08 on `IDENTITY-2` and `LOGO-2`. The 2026-10-01 decisions below the line are superseded.

- `primary` is honey `#F5A83A` in both modes, and `primary-foreground` is ink `#15161C` in both: the one brand colour carries ink (9.06). White on honey (2.0) is banned.
- `accent` is shadcn's hover/selected surface and is now a tint, not a neutral: honey at 14% over the ground (`#F7EAD6` on paper, `#2D2318` on night). `accent-foreground` is honey as text: honey-l `#9D5A00` on light (5.39 on white), honey on dark.
- `border` = line-l / line (hairlines) and `input` = line-l2 / line-2 (control edges). The edges are below 3:1 on their own by the `.yml`'s choice; a control is identified by its fill (`secondary`: paper-3 / night-3) and its visible label, and the chalk ring carries focus.
- `ring` is chalk (chalk-l `#2A73B0` / chalk `#78B4E8`): the carpenter's line, used for focus, "today" lines, guides and the "test network" plate, never as a fill or a brand element. `info` maps to it.
- `--radius` is 8px (buttons, inputs, popovers); 6px tags; 10px cards, panels, tiles; 16px app tiles; pills for chips, status badges and the composer's send button; 20px the composer. shadcn's `calc(var(--radius) ± 2px)` yields the 6 / 10 steps.
- `chart-1…4` are the plan legs in the honey family plus one neutral: light honey, honey-deep, wood-deep, muted-l; dark honey, wood, honey-deep, muted. `chart-5` is the base-case line (ink / text), drawn in honey with `curve-fill` beneath on charts.
- `success` / `warning` / `destructive` are the direction colours leaf / clay / madder (`-l` on light), each with a 14% tint for fills. Status is always word + square glyph + colour; deltas are signed with U+2212 and coloured by direction.
- Hover is honey-hover `#E99C2E`, pressed honey-deep `#D9881B`, in both modes.
- Sample marking follows gate `MOCK-QUIET` (Thom, 2026-10-06): no boxed MOCK beside a figure, anywhere. A sample card keeps its 6px hatched left edge and says so once in a muted line (`--tf-sample-fg`: muted-l / muted, `text-sample-line` 12.5px Inter 400); sample figures keep the hatched pin or a hatched glyph named "sample figure". The former `--tf-mock-plate*` vars and `label-mock` style are gone; "MOCK" survives only as the API value and as the state's name in documents.
- Hatch pitch is 6px in UI, 3px in glyphs and 4px in SVG drawings, in muted-l / muted.
- All shadows are `none` except `--tf-shadow-popover` (`0 8px 24px rgba(0,0,0,.35)`) on popovers and the composer. Depth comes from three layers plus hairlines plus the 14% tint on the selected surface.
- Gradients exist only as light: `--tf-glow` behind heroes and the composer, `--tf-curve-fill` under the base-case line. Nothing else.
- Fonts: `--font-display` Inter Tight (600, −0.02em; display, headings, big figures), `--font-sans` Inter, `--font-mono` IBM Plex Mono. No serif, no condensed face. Bearing heads are Inter 500 11px uppercase.
- The heatmap ramp is the honey family by lightness (night-3 → honey → pale on dark, reversed on light).
- The guidelines hero is always on night with the honey glow (an inverted section). It "feels alive" through the J1 lock animation (seat, then the square pin), which runs once, in the new colours: post honey, tenon in the text colour, pin honey.

Superseded on 2026-10-08 (kept for the record): `primary` hardwood / hinoki by the species rule; `accent` a neutral surface; `border` = hair and `input` = member; `--radius` 2px, no pills; brown wood plan legs; forest / ochre / madder-old status colours; wood-600 hover; no shadows at all; no gradients at all; Newsreader display and Plex Sans / Condensed; the P2 stepped divider and the P3 receding grid; the 0-radius square-tag icon container.
