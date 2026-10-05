# Brand State

## Brand: working-brand
**Started:** 2026-10-01
**Mode:** new
**Current Phase:** 4 (Brand complete)
**Prettiness Level:** 100%

---

## Phase Progress

| # | Phase | Status | Started | Completed |
|---|-------|--------|---------|-----------|
| 0 | Audit | skipped | — | — |
| 1 | Discover | complete | 2026-10-01 | 2026-10-01 |
| 2 | Strategy | complete | 2026-10-01 | 2026-10-01 |
| 3 | Identity | complete | 2026-10-01 | 2026-10-01 |
| 4 | Patterns | complete | 2026-10-01 | 2026-10-01 |

## Status Values
<!-- pending | in-progress | complete | needs-revision | skipped -->

## Decisions
<!-- Key brand decisions and rationale -->

## Notes
<!-- Session notes, observations, blockers -->

- 2026-10-01 · Brief: visual direction is Japanese wood joinery (governing image `visual-refferences/master.jpg`). An earlier "warm old-desktop" pick was explicitly rejected as too close to Teiten.
- 2026-10-01 · No name yet; `working-brand` is a placeholder slug. Naming is owed by strategy; rename the folder once chosen.
- 2026-10-01 · Deadline: whole branding diamond done by 2026-10-04.
- 2026-10-01 · Strategy: Sage × Caregiver archetype (founder's choice over Creator × Caregiver); bold positioning "goal + constraints → made-to-measure portfolio, exit plan before it invests" (revised to stand apart from Peaks and Cesto); voice is clear, candid, kind; one masterbrand, with the risk product called "[Name] Bearing".
- 2026-10-01 · Name: **Tenonfi**, provisional (fallback: Tenon). Trademark, domain and native-speaker checks still pending.
- 2026-10-01 · Identity locked: Direction A, a pinned through-tenon (wordmark `tenonfi` in Newsreader with a removable "fi"); wood-only palette; Newsreader + IBM Plex Sans/Mono; joints: tenon = logo/provenance, half-lap = lattice, dovetail = exit plan, kanawa tsugi = rebalance, bracket set = Bearing; kumiko and lattice patterns used as structure only; 3D/2D assembly system (hero assets H1–H4).
- 2026-10-01 · Guidelines locked: working-brand.yml, STYLE.md, guidelines.html (dark hero, ~2s lock, headline "No product fits everyone. So we make the pieces — and your goals decide how they fit."), 18 component specs, theme.json (WCAG 2.2 AA: 36/36 pairs). Founder exception: only the typing box (composer + subscribe) is rounded, 20px. Landing prototype (patterns/prototypes/hero-3d.html) is the marketing reference.
- Open (from components INDEX): staleness field missing from API schema; Bearing no-sample cell style; where DISCLAIMER_SHORT is allowed; whether all non-live provenance = MOCK; ArrowUp missing from icon registry; subscribe checkboxes pre-checked (consent; should default unchecked). Placeholder photos (Canva previews) and reference photo9 (third-party) must be replaced before going public. Tenonfi trademark/domain/handle checks pending.
- 2026-10-01 · LOCKED (founder): landing prototype `patterns/prototypes/hero-3d.html` is the marketing reference. Pinned 3D joint stage (generated wood textures) that scrolls away after step 03; compact centred nav (Products · Invest · Resources · Connect wallet) from step 03; two goal showcases (trip fund, mountain season) with MOCK charts and photos; unboxed simulator with a large rounded composer and suggestions below it; closing section with a centred stacked-beam image and subscribe. The only rounded elements are the composer and subscribe field (20px) and the round send button.
- 2026-10-03 · Bearing analytics prototype: a view inside `patterns/prototypes/hero-3d.html` (`#analytics`, menu item "Analytics"; the landing is otherwise unchanged and its scene pauses while the view is open), script and styles in `prototypes/assets/analytics.{js,css}`. It reads the risk API (`/risk/assets`, `/risk/facts/assets/:id`, `/depth`, `/heatmap`, `/lp`, `/score`, `/risk/pools`, `/risk/facts/lending[/:account]`, `/risk/lending/coverage`, `/risk/markets`, `POST /risk/markets/:account/gap`, `/risk/facts/methodology`) at `data-api` (default localhost:3011) and falls back to the snapshot in `prototypes/assets/analytics/` (captured 2026-10-03T02:40:05Z), shown stale, never MOCK. Shows exit cost by size and regime, cost curves, hour of week, LP concentration (positions, not owners), stability, tracking, lending funding, coverage (both ratios), liquidation routes, a liquidation simulator, methods and the disclaimer. Shows as coming: volume and holders (item 16), LP owners (item 15 part 3), issuer mint and burn (item 14), the non-stock assets (item 17), real-share tracking (D19), plan facts (plan view). Checks in `prototypes/assets/analytics/CHECKS.md`.
- 2026-10-03 · Analytics charts rebuilt on the founder's word (the CLMM liquidity distribution he pasted, DefiLlama-style cards, trading candles): `prototypes/assets/analytics-charts.js`. One serif sentence on the view follows the brief although STYLE.md bars Newsreader in Bearing: the two documents disagree and need a decision. The distribution's live read is gated by DA3 until Mon Oct 5; `?preview=1` shows it on recorded bytes as MOCK.
- 2026-10-03 · Analytics 2.0 on the founder's word: a second view beside the first (kept as it was), `#analytics2/<page>`, menu item "Analytics 2.0", in `prototypes/assets/analytics2.{js,css}`. A retractable side menu (a drawer on phones) with five pages: stocks, commodities (GLDx), stablecoins (the Kamino stablecoin reserves; USDY, syrupUSDC, USDT as not collected), lending, simulation. Each page has one row of counters, one chart with a metric selector and 24 h / 7 d / 30 d ranges, a pie of value by pool, the table (capacity at one decimal), and asset and pool filters, all selected by default. Lending adds covered (the share of collateral the pools buy at ≤ 1% cost, collateral grouped by asset, each Kamino market once), the largest sale without loss and the loss if all is sold, and a 100% covered / not covered chart. The simulation ranks selling now, waiting for market hours, hourly sales within the 1% capacity and issuer redemption (assumption, never chosen). Stock-pool TVL over time is shown as not collected: only one TVL read per pool exists. Chart contrast raised (solid fills, palest wood against mid wood, forest and madder for covered), validated with the dataviz script. Snapshot recaptured with the 2.0 routes. Checks in `prototypes/assets/analytics/CHECKS.md` §9.
