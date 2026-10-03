# PROMPT (design) — Bearing analytics page: a live prototype on the pool and lending data

> Written 2026-10-03 on `risk-analytics`. Use it in a fresh Claude Code session (Opus) started inside the **design worktree** `~/Documents/Colosseum-design` (branch `design`), not in this worktree and not in the main checkout. The page is a brand prototype beside the landing prototype, fed by the risk API running from the `risk-analytics` worktree. Nothing in this prompt changes the API, the collectors or the engine.

---

## Before the session (the founder, in the `risk-analytics` worktree)

The design branch does not hold the fact-sheet routes, so the page reads them from the API started here:

```
cd ~/Documents/Colosseum/.claude/worktrees/risk-analytics
pnpm db:migrate                                        # the colosseum-pg container is already up on 5433; `pnpm db:up` needs the docker compose plugin this machine lacks
API_PORT=3011 pnpm --filter @colosseum/api dev         # 3001 is taken by another project's Next dev server
curl -s localhost:3011/risk/assets | head -c 300       # proves it answers; OpenAPI at localhost:3011/docs
```

Leave it running for the whole session. If the lending sheets are older than an hour, run `pnpm risk:lending-report && pnpm risk:facts-import` here first (or let item 18's job do it once it is installed).

---

## The prompt

Build the **Bearing analytics page** inside the landing prototype in this design worktree, `.design/branding/working-brand/patterns/prototypes/hero-3d.html`: a new view in the same document, reached from an "Analytics" item in the compact menu and from the hash `#analytics`. When the view is open, the landing sections (stage, showcases, simulator, closing) are hidden and the 3D scene is paused; `#top` brings the landing back. Keep the landing exactly as it is otherwise: it is locked by the founder (STATE.md, 2026-10-01). Put the page's script and styles in `prototypes/assets/analytics.js` and `prototypes/assets/analytics.css`, loaded by `hero-3d.html`, so the HTML stays readable; the data snapshot goes under `prototypes/assets/analytics/`. Commit on `design` with the `design:` prefix. Do not push unless I ask.

Bearing is the product's liquidity and risk layer. This page is where a person (or an agent reading over their shoulder) sees what the layer measures today: what each tokenized stock costs to sell at a size, who provides the liquidity and how concentrated they are, how the lending pools that take these stocks as collateral are funded and covered, which way a liquidation would be sold, and what a liquidation right now would lose. Everything on it is measured on-chain by our collectors or computed from those measurements by a stated method. Nothing is a promise.

### Read first, as files

1. `CLAUDE.md` at the repo root and `apps/web/CLAUDE.md` (the seven binding screen rules).
2. `.design/branding/working-brand/patterns/STYLE.md` in full. It is binding. Then these component specs in `patterns/components/`: `data-table.md`, `provenance-pin.md`, `mock-plate.md` (for the stale state), `card.md`, `bearing-heatmap-tile.md`, `disclaimer-block.md`, `compact-nav.md`, `token-mapping.md`.
3. `.design/branding/working-brand/strategy/voice-and-tone.md` (answer, then reason, then risk, then action; sentence case; no exclamation marks).
4. `patterns/prototypes/hero-3d.html` in full: it is the host. Its `:root` tokens, fonts, nav and `.wrap` are the shell you reuse; its sections, scene and scripts must keep working when the analytics view is closed. Read its head comment too: it lists what the prototype got wrong against the `.yml` (blurred nav, uppercase eyebrows). Do not repeat those in the new view.
5. The API, live: `GET http://localhost:3011/docs/json` (OpenAPI) and `GET /risk/facts/methodology` (the methods in words; quote them, do not paraphrase them).
6. `packages/schemas/src/constants.ts` for `DISCLAIMER` (copy it verbatim into the page; it cannot be imported from a static file) and `packages/schemas/src/facts.ts` if it exists on this branch (it may not; the OpenAPI document has the same shapes).

### What the data is

Every number the API serves is a **fact**: `{ value, unit, fetchedAt, regime?, sizeUsd?, source, method, methodVersion, provenance, quality }`, or `{ value: null, reason }`. `quality` is `measured`, `lower_bound` or `assumption`. A `null` fact carries one of these reasons: `no_samples_in_regime`, `insufficient_samples`, `beyond_measured_size`, `no_reference_price`, `no_external_source`, `chain_not_covered`, `not_collected`, `not_imported`, `not_followed`, `before_routed_curves`, `gate_open`. The page shows a missing fact as its reason in words, never as zero, never as a dash alone, and never with the hatch (the hatch means MOCK or stale only).

Regimes are time-of-week: `us_market_hours`, `us_offhours_weekday`, `weekend`, `us_holiday`. The weekend regime has its first samples this weekend (Oct 3–4) and most weekend facts still read `no_samples_in_regime`; they fill with no change to the page.

**Routes the page reads** (all `GET` unless marked):

| Route | Gives |
|---|---|
| `/risk/assets?tau=` | every asset with pool TVL, pool count, exit capacity at cost τ by regime, weekend ratio |
| `/risk/facts/assets/:id?sizeUsd=&tau=` | the `AssetFacts` sheet: exit and entry cost with the fee split (pool fee, transfer fee, impact, basis, network fee, loss in dollars), round trip, break-even, capacity, liquidity stability (LP top 1/3/10 share, cost if the top LPs leave, withdrawal events in 7 days, capacity variation by regime, depth recovery after large trades), tracking against each lending oracle, lending use, issuer route, market risk (volatility, drawdown, weekend gap frequency), data coverage |
| `/risk/assets/:id/depth?side=sell\|buy&regime=` | the cost curve points by size for one regime, with samples per point |
| `/risk/assets/:id/heatmap?notional=` | median cost by hour of week (24 × 7) at one size |
| `/risk/assets/:id/lp` | per pool: positions, in-band positions, top 1/3/10 share, sale cost now and after the top N leave at each grid size |
| `/risk/pools?asset=` | the asset's pools: address, venue, quote token, exit path, TVL, refresh tier |
| `/risk/assets/:id/score?...` | the liquidity score for a window, `null` when no regime in the window is measured |
| `/risk/facts/lending` and `/risk/facts/lending/:account` | the `LendingPoolFacts` sheets: withdrawal (supplied, available now, share lent out, hours above the alarm), rates (supply and borrow APY, variation), lenders (top 1/3/10 share), per collateral asset (collateral USD, liquidation threshold and bonus, oracle gap by regime, coverage ratio by gap, regimes missing, the liquidation routes best first, observed liquidations), history (liquidations, liquidated USD, socialised loss, parameter changes in 30 days) |
| `/risk/lending/coverage?asset=&gapPct=` | both coverage ratios (the earlier one and the margin one) per asset and gap, with the null reason where not measured |
| `/risk/markets` | the lending markets' parameters (LTV, liquidation threshold, bonus, close factor) with their dispersion |
| `POST /risk/markets/:account/gap` body `{ gapPct, bandPct?, closeFactor?, fullLiqLtv? }` | what a price gap does to one market: collateral that becomes liquidatable, what the pools can absorb, the coverage |
| `/risk/facts/plan` (POST) | a plan's facts for a list of positions; **not used on this page** (a later section) |
| `/risk/facts/methodology` | the methods, in words, from the plan's §5 |

What the API **does not serve yet**, and how the page treats it:

- **Volume per pool.** Not served. The collectors do not count swaps yet; the 28-day history has them for 34 pools and item 16 of `docs/risk/PLAN-ANALYTICS.md` (in the `risk-analytics` worktree, not here) turns that into facts. Show the volume cell as a `null` fact with reason `not_collected` and the sentence "Volume is counted from successful swaps once item 16 lands." Do not pull a volume figure from DexScreener or any other off-chain source: the layer's rule is on-chain measurement with provenance.
- **LP owners.** Only positions are known (one owner can hold several). Say so beside every concentration figure, as the current `/risk/[asset]` page does.
- **Wallets.** Never shown. Liquidators, LP owners, holders and positions are aggregates only (D13). Pool addresses and lending market accounts are shown with their explorer links ("Tx ↗" style, Plex Mono).
- **Assets that are not stocks** (USDY, syrupUSDC, USDT, the Kamino USDC supply leg). They appear in the asset list with a sheet of `not_collected` reasons. **Show them**, in the same rows, with their reasons: the page is built on the stock pools now and grows into them with no redesign. Do not hide a row because every fact in it is missing.

### Live and snapshot

The page fetches the API at `http://localhost:3011` (a `data-api` attribute on `<html>`, so it can point elsewhere). On the first build, the session also **captures a snapshot**: every route the page reads, once, as JSON files under `prototypes/assets/analytics/` with a `captured_at` ISO time in a `manifest.json`. The page loads live first; when the API does not answer within 3 seconds it falls back to the snapshot and every figure takes the **stale** state: the hollow pin plus the word "stale" and its age computed from `fetchedAt` (the spec in `provenance-pin.md` and `mock-plate.md`). Never the MOCK state: these are measured figures, only old. A banner at the top says which it is: "Live from the collectors, as of 02:14 UTC" or "Snapshot captured 2026-10-03 02:14 UTC, the API is not running".

The snapshot holds no wallet. Check every captured file for base58 strings of 32–44 characters other than the pool and market accounts the page displays; the `/risk/facts/lending` route already publishes aggregates only, but check anyway and say what you found.

### The page, section by section

Density is Bearing's (STYLE.md: 13 px type, 28 px rows, 16 px tile padding, 32 px between panels, 16 px grid gap), on the prototype's dark ground with `?theme=light` giving the light peer (both must pass AA; `guidelines.html` uses the same switch). One Newsreader sentence per screen, at the top, addressed to the person: "What it costs to leave, and who is holding the door." Everything else Plex Sans and Plex Mono, tabular lining figures, a true minus. Every yield, price, cost and dollar figure carries the provenance pin, which opens `source · fetched_at (ISO, UTC) · method · method version` from the fact itself. A `lower_bound` fact shows "≥" before the value; an `assumption` fact says "assumption" beside it in stone.

**1. Header and coverage line.** The serif sentence, then one Plex Mono line: how many assets, how many pools, which regimes are measured this week, the collectors' last run time. Then the live-or-snapshot banner.

**2. Asset table (the pools, by asset).** One row per asset from `/risk/assets`, the stocks first, then the other assets with their reasons. Columns: asset · pools · on-chain TVL · exit capacity at 1% in market hours, off-hours, weekend, holiday · weekend ÷ market hours · volume 24 h (the `not_collected` cell) · top-3 LP share of the largest pool · exit cost at $10k and $100k in the worst measured regime. A τ control (0.5%, 1%, 2%) and a size control ($10k, $50k, $100k, $250k) above the table; they change the query, not the method. Clicking a row opens the asset panel below the table (one asset open at a time; the URL hash carries it, `#asset=TSLAx`).

**3. Asset panel.** For the open asset, from `/risk/facts/assets/:id?sizeUsd=`:
- **Cost to leave at this size**, by regime, as a stacked horizontal bar of the fee split (pool fee, transfer fee, impact, basis; basis can be negative, draw it to the left of zero and say in one sentence why a small sale can show a negative cost). Beside it the network fee in dollars, the loss in dollars, the round trip and the break-even return. Solid bars for measured, no bar and the reason for `null`.
- **The cost curve** by size for each measured regime (`/depth`), on one chart, dashed from the point where samples fall under the minimum (the API gives `insufficientFrom`). Axes labelled, cost in %, size in USD on a log scale with the grid sizes marked. No blue; the regimes take hinoki, hinoki-deep, wood-400 and stone on dark (the plan-leg palette), with direct labels at the line ends, no legend.
- **Hour of week**: the 24 × 7 lattice from `/heatmap` at the selected size, per `bearing-heatmap-tile.md` (an empty cell with an en dash for no sample).
- **Who provides the liquidity** (`/lp`): per pool, positions and in-band positions, top 1/3/10 share, and the sale cost at $50k and $250k now and after the top N leave. One sentence above: positions, not owners.
- **Stability**: capacity variation by regime, depth recovery after a large trade (minutes to 50% and 90%, share not back in 24 h), LP withdrawal events in 7 days.
- **Tracking**: the pool mid against each lending oracle by regime (premium or discount), and market risk (volatility, drawdown, weekend gap frequency with the number of weekends: "no move above 5% in 52 weekends"). Where the sheet says the weekend gap at 20% has never been seen, the page says that in words next to any coverage ratio at 20%: the ratio rests on a move the record has not seen.
- **Pools** (`/risk/pools?asset=`): address with explorer link, venue, quote, exit path, TVL, refresh cadence.
- **Data coverage**: samples and dates per regime, regimes missing, method version.

**4. Lending pools table.** One row per sheet from `/risk/facts/lending`: venue · market · token · supplied · withdrawable now · share lent out · hours above the alarm (share) · supply APY (and its variation) · top-1 lender share · collateral assets (count) · liquidations to date · socialised loss. Clicking a row opens the lending panel.

**5. Lending panel.** From `/risk/facts/lending/:account`:
- **Funding**: supplied, available, share lent out as a bar with the alarm line, hours above the alarm, the rates with variation, lender concentration top 1/3/10 (with the "one supplier holds at least 91.6%" kind of sentence when top-1 is measured and above half).
- **Collateral**: one block per collateral asset: collateral USD, liquidation threshold, bonus, the oracle gap by regime.
- **How covered it is**: the coverage ratio by gap (5%, 10%, 15%, 20%, 25%, 30%) as a small table with **both ratios** side by side (the earlier ratio and the margin ratio, named as the API names them), the limiting regime, and the regimes missing. Below 1.0 is said in words ("at a 20% gap the pools absorb 92% of what becomes liquidatable"), with the word and the notched-square status mark, never colour alone.
- **The best path for a liquidation**: the routes list, best first, each with its recovered value and the liquidator's margin, the alternatives with their value or their reason (two-hop `not_collected`, wait for market open and issuer redemption `assumption`, never chosen over a measured route). One sentence says the route with the highest recovered value is chosen among measured routes.
- **What liquidations actually did**: count, share sold in the same transaction, realised price against the oracle and against the pool mid, and the follow-up outcome where the sheet has it (sold outside the registry, kept and sold later, still held). State the largest seizure on record if the sheet carries it; where it does not, say "every seizure on record was under $10k; large liquidations rest on the simulation above".
- **History**: liquidations, liquidated USD, socialised loss, parameter changes in 30 days, and the market's parameters from `/risk/markets`.

**6. Liquidation simulator ("if someone were liquidated now").** A small form: lending market (from the sheets), collateral asset (from that market's collateral list), seized size in USD (free input, default $100k), regime (default: the current one, computed in the browser from ET time and the holidays list the API's methodology names; show which), and an optional extra price gap. It computes in the browser with the method the API publishes (`/risk/facts/methodology`, "Liquidator margin"): the liquidator repays debt `d` and seizes stock worth `d(1 + b)` at the venue's oracle price; sold on a route at cost `c(size, regime)` against the pool mid `P_m`: `margin = (1 + b) × (P_m / P_o) × (1 − c) − 1`. `b` and the oracle gap come from the lending sheet's collateral block for that asset and regime; `c` comes from `/risk/facts/assets/:asset?sizeUsd=<seized>` for that regime (the exit cost fact). Output:
- the margin per route in %, and in dollars on the seized size;
- the verdict in words: "A liquidator keeps 2.9% ($2,900) after selling $100k of TSLAx on the routed pools in market hours", or "A liquidator loses 4.7% ($4,700): the bonus does not cover the sale. The position is not liquidated and the shortfall falls on the lenders";
- the loss **to the lender** when the margin is negative: the seized value at the oracle less what the sale returns, as the API's facts allow it, labelled `lower_bound` where the exit fact is one;
- the pool-wide view from `POST /risk/markets/:account/gap` with the chosen gap: collateral that becomes liquidatable, the pools' capacity, the coverage;
- every input the computation used, printed as a Plex Mono line with its pin (cost fact, bonus fact, gap fact), so the number can be checked by hand.
When the exit cost at that size and regime is `null` (beyond the measured size, no samples), the simulator says so and shows nothing else for that row. It never extrapolates a curve.

**7. Methodology and disclaimer.** The methodology from `/risk/facts/methodology`, rendered as the API returns it (headings and the formulas), then the `DISCLAIMER` constant verbatim in a hairline box at body size, then the method versions and the collectors' cadence (5-minute pools, hourly curves, hourly lending import).

### Other analytics to propose (build the ones marked "now"; list the rest in a "What is coming" footer with their `null` reason)

- **Now:** the net return at a size: with entry and exit cost at the selected size and regime, the break-even gross return (from the asset sheet). A one-line "to break even you need 0.19% before costs" sentence under the cost bars.
- **Now:** a "what the record has not seen" line per asset: the largest weekend move in the record and the number of weekends, next to every coverage ratio at a larger gap.
- **Now:** data freshness per fact source (collectors' last run, lending import, lending report, reference prices), as a small table in the footer.
- **Coming (item 16):** volume per pool, turnover against depth, net sell pressure, holder concentration and where the token sits (wallets, lending, pools).
- **Coming (item 15 part 3, Mon Oct 5):** LP owners behind the position NFTs, so one owner in several pools is seen.
- **Coming (item 14):** issuer mint and burn history, replacing the issuer-route assumption.
- **Coming (item 17):** measured exit cost for USDY, syrupUSDC, USDT, and the Kamino USDC supply leg as a lending sheet.
- **Coming (D19):** tracking against the real share price, and a longer gap history than one year.
- **Coming (plan view):** `/risk/facts/plan` for a set of positions: concentration, joint exit cost (legs sharing a route flagged), stress table. Not on this page.

### Constraints

- Branch `design`, this worktree only. Do not `cd` to `~/Documents/Colosseum` or any `.claude/worktrees/`. The API is read over HTTP; you do not run it, change it or read its code beyond the OpenAPI document and the methodology route.
- STYLE.md and `apps/web/CLAUDE.md` are binding: pin on every figure, no blue or violet, square corners, no shadows, no gradients, status as word plus shape plus earth colour, light and dark both AA, flush left, sentence case, MOCK the only uppercase word (and it does not appear on this page: nothing here is mock). No venue logos. No Japanese words. Nothing like Teiten.
- Copy follows voice-and-tone: answer, then reason, then risk, then action. No return promises, no "earn", "guaranteed" or "safe". Product words: goal, limits, plan, portfolio, exit plan, rebalance, Bearing. Competitors are not named; venues (Orca, Raydium, Meteora, Kamino, Jupiter Lend) are data sources and are named as such.
- A missing fact is its reason in words. Never zero, never a hatch, never hidden.
- Wallet-level data never reaches the page or the snapshot (D13).
- No library beyond what the prototype uses. Charts are inline SVG drawn by the page's own script (the data is small). Load fonts from Google Fonts as the prototype does; nothing else external.
- Numbers through `Intl.NumberFormat` (en-US), 2 decimals on percentages, tabular figures, U+2212 for minus, U+202F before the pin.
- Keyboard: every row, control and pin reachable and operable; the pin popover opens with Enter and closes with Escape; `aria-label="Source for 2.90%"`.
- Reduced motion: no animation beyond a 120 ms crossfade on panel open.
- Never read `.env` or anything under `secrets/`. Commit nothing under `data/`.

### Checks before you commit

1. Open the page with the API running and with it stopped. Screenshot both states (light and dark, desktop and 390 px wide) into `prototypes/assets/analytics/screenshots/`. Confirm the stale state appears only when the snapshot is used. Then open `hero-3d.html` at `#top`, `?at=show`, `?at=sim` and `?demo=1`: the landing must behave as before the change (scene, compact nav, showcases, simulator).
2. Pick TSLAx at $250k: the page's exit cost, fee split and loss in dollars equal `GET /risk/facts/assets/TSLAx?sizeUsd=250000` to the displayed precision. Pick one lending market: the coverage table equals `/risk/lending/coverage` for its collateral at each gap. Paste both comparisons in the commit message body or in a `prototypes/assets/analytics/CHECKS.md`.
3. Run the simulator for SPYx at $100k in market hours on the xStocks market and compute the margin by hand from the three printed inputs with the methodology's formula. They must agree to the displayed precision.
4. A DOM check in the page's script (dev only, behind `?check=1`): every element with a numeric figure class has a pin; no element uses the hatch class; log the count of each to the console.
5. Contrast: every text and status colour pair used on the page, in both themes, at or above 4.5:1 (3:1 for large text and UI edges). List the pairs and ratios in `CHECKS.md`.
6. `.design/branding/working-brand/STATE.md`: one dated line saying the analytics prototype exists, what it reads, and what it shows as coming.

### Report back with

What shipped (files), the two comparisons of check 2 and the hand computation of check 3, the snapshot's `captured_at` and which routes it holds, every fact the page shows as a reason today (grouped by reason), what you proposed beyond the asks and where it sits on the page, anything in STYLE.md you could not satisfy and why, and what the page would need from the API next (one list, ordered by value to the reader).
