# Bearing analytics view: checks

Run 2026-10-03 (02:40–03:10 UTC) against the risk API from the `risk-analytics` worktree on `localhost:3011`, page served with `python3 -m http.server` from `patterns/prototypes/`.

## 1. Live and snapshot, both themes, desktop and 390 px

Screenshots in `screenshots/` (retaken 2026-10-03 03:35Z after the chart rebuild): `live-dark-desktop-price`, `live-light-desktop-price`, `live-dark-desktop-distribution-MOCK`, `live-light-desktop-distribution-MOCK` (the distribution on recorded bytes, `?preview=1`), `snapshot-dark-desktop-lending`, `snapshot-light-desktop-overview`, `live-dark-390-price`, `snapshot-light-390-price`. The snapshot state was produced with `?api=http://127.0.0.1:9` (a dead port), so the API kept running for the live shots.

- Live: banner "Live from the collectors, as of 02:07 UTC.", solid pins, no "stale" word anywhere.
- Snapshot: banner "Snapshot captured 2026-10-03 02:40:05 UTC, the API is not running.", every pin hollow with "stale · age" (599 of 599 pins in the DOM check). Never MOCK.
- 390 px: tables stack into label/value rows; `scrollWidth == clientWidth` (375/375), no horizontal page scroll.
- Landing: `#top`, `?at=show`, `?at=sim&demo=1` render as before (scene, compact nav from step 03, showcases, simulator with the demo goal). Menu "Analytics" → view opens, `main#top` and the landing footer hidden, scene loop parked (`TF_RESUME_SCENE` set); brand link → `#top`, loop resumed, canvas re-laid out, scroll back at 0 and the bar full width again.
- The landing hides its menu links under 820 px (locked prototype), so on a phone the view is reached by `#analytics`, not the menu.

Keyboard: the first pin in the asset table (`aria-label="Source for $6.71M"`) took focus, Enter opened the popover (`risk_pools.tvl_usd, tier A and B pools (GET /risk/assets) · 2026-10-01T01:38:24Z · sum of on-chain pool TVL · registry-0.1`), Escape closed it and focus stayed on the pin with `aria-expanded="false"`.

## 2. Page against the API

`GET /risk/facts/assets/TSLAx?sizeUsd=250000`, exit side, page at $250k:

| Regime | API total | Page | API loss USD | Page | API round trip | Page | API break-even | Page | Split (pool fee, transfer fee, impact, basis) |
|---|---|---|---|---|---|---|---|---|---|
| market hours | 0.0263704 | 2.64% | 6592.60 | $6,593 | 0.0501754 | 5.02% | 0.0528260 | 5.28% | null `not_collected` → "not collected yet" ×4 |
| off-hours | 0.0290239 | 2.90% | 7255.97 | $7,256 | 0.0537874 | 5.38% | 0.0568450 | 5.68% | null `insufficient_samples` → "too few samples to fit" ×4 |
| weekend | 0.0252974 | 2.53% | 6324.35 | $6,324 | 0.0482876 | 4.83% | 0.0507376 | 5.07% | same |
| holiday | 0.0252974 | 2.53% | 6324.35 | $6,324 | 0.0482876 | 4.83% | 0.0507376 | 5.07% | same; the page says the holiday figures are the weekend curve's (API rule `curveFor`) |

Network fee: API 0.000596879 USD, page $0.0006 in every regime. All agree to the displayed precision.

`GET /risk/lending/coverage?asset=SPYx` against the coverage table of the xStocks Market (USDC) panel, collateral SPYx:

| Gap | API earlierRatio | Page | API ratio (margin) | Page | API regime | Page | API limitingOracle | Page |
|---|---|---|---|---|---|---|---|---|
| 5% | 5377.36 | 5,377 | 5353.19 | 5,353 | us_offhours_weekday | off-hours | kamino SPYx @xStocks Market | same |
| 10% | 194.72 | 195 | 193.85 | 194 | us_offhours_weekday | off-hours | kamino SPYx @xStocks Market | same |
| 15% | 2.894 | 2.89 | 2.877 | 2.88 | us_offhours_weekday | off-hours | jupiter_lend SPYx/USDC | same |
| 20% | 1.456 | 1.46 | 1.448 | 1.45 | us_offhours_weekday | off-hours | jupiter_lend SPYx/USDC | same |
| 25% | 1.030 | 1.03 | 1.024 | 1.02 | us_offhours_weekday | off-hours | jupiter_lend SPYx/USDC | same |
| 30% | 0.4583 | 0.46 | 0.4557 | 0.46 + "short: the pools absorb 46%" | us_offhours_weekday | off-hours | jupiter_lend SPYx/USDC | same |

Regimes missing: none in both. All agree.

## 3. Simulator by hand: SPYx, $100k, market hours, xStocks Market

Printed inputs: bonus b = 5.00% · oracle gap (market hours) = 0.03% (oracle ÷ pool mid − 1) · exit cost c($100,000, market hours) = 0.18%.

By hand from the printed figures: margin = (1 + 0.05) × 1 ÷ (1 + 0.0003) × (1 − 0.0018) − 1 = 1.05 × 0.99970 × 0.9982 − 1 = 0.04780 → **4.78%**.
Page: "A liquidator keeps 4.78% ($4,781) after selling $100,000 of SPYx on the routed pools in market hours." From the unrounded facts (b 0.05, gap 0.000327371, c 0.001758245): 0.0478108. The API's own route figure in the lending sheet (`routes[routed_dex, us_market_hours].liquidatorMargin`) is 0.04781081916630048. All three agree to the displayed precision. The formula was checked against every measured regime of that route before the build: `P_m / P_o = 1 / (1 + gap)` reproduces the API exactly; `1 − gap` and `1 + gap` do not.

## 4. DOM check (`?check=1`)

Console, live: `figures 417 · pins 417 · figures without a pin 0 · hatched elements 0 · reasons 188 · stale pins 0 · mode live` (table only, first load).
Console, snapshot with the TSLAx panel open: `figures 599 · pins 599 · figures without a pin 0 · hatched elements 0 · reasons 248 · stale pins 599 · mode snapshot`.
After the chart rebuild: live, SPYx panel with `?preview=1`: `figures 772 · pins 776 · figures without a pin 0 · hatched elements 0`; snapshot, TSLAx panel: `figures 640 · pins 644 · figures without a pin 0 · hatched elements 0 · stale pins 644`. The check counts a figure without a pin as correct only inside a block that carries the MOCK plate (the spec: a MOCK figure has no pin), and a hatch band only beside a plate.

## 5. Contrast (WCAG 2.2: text 4.5:1, large text and UI edges or graphics 3:1)

Heatmap ramp steps are separated by 1px hairlines and the scale prints its numeric ends (1.4.1, 1.4.11), as the heatmap spec allows; adjacent ramp steps are not compared.

| Theme | Kind | Foreground | Background | Ratio | Needs | Result |
|---|---|---|---|---|---|---|
| dark | text | fg #ECE4D6 | bg #0D0B09 | 15.56:1 | 4.5:1 | pass |
| dark | text | fg #ECE4D6 | card #1A1714 | 14.14:1 | 4.5:1 | pass |
| dark | text | fg #ECE4D6 | sunk #24201B | 12.82:1 | 4.5:1 | pass |
| dark | text | muted #A49A8E | bg #0D0B09 | 7.10:1 | 4.5:1 | pass |
| dark | text | muted #A49A8E | card #1A1714 | 6.45:1 | 4.5:1 | pass |
| dark | text | muted #A49A8E | sunk #24201B | 5.85:1 | 4.5:1 | pass |
| dark | text | pfg #0D0B09 | primary #E6D3B7 | 13.44:1 | 4.5:1 | pass |
| dark | text | on #7FA37A | card #1A1714 | 6.31:1 | 4.5:1 | pass |
| dark | text | watch #D9A441 | card #1A1714 | 7.94:1 | 4.5:1 | pass |
| dark | text | off #E58AA0 | card #1A1714 | 7.20:1 | 4.5:1 | pass |
| dark | text | on #7FA37A | sunk #24201B | 5.72:1 | 4.5:1 | pass |
| dark | text | off #E58AA0 | sunk #24201B | 6.53:1 | 4.5:1 | pass |
| dark | UI | pinO #A49A8E | card #1A1714 | 6.45:1 | 3:1 | pass |
| dark | UI | pinO #A49A8E | sunk #24201B | 5.85:1 | 3:1 | pass |
| dark | UI | pin #E6D3B7 | card #1A1714 | 12.21:1 | 3:1 | pass |
| dark | UI | input #7A6D5F | card #1A1714 | 3.55:1 | 3:1 | pass |
| dark | UI | input #7A6D5F | sunk #24201B | 3.22:1 | 3:1 | pass |
| dark | UI | primary #E6D3B7 | card #1A1714 | 12.21:1 | 3:1 | pass |
| dark | UI focus ring | primary #E6D3B7 | bg #0D0B09 | 13.44:1 | 3:1 | pass |
| dark | graphic | l1 #E6D3B7 | card #1A1714 | 12.21:1 | 3:1 | pass |
| dark | graphic | l2 #C9AE86 | card #1A1714 | 8.40:1 | 3:1 | pass |
| dark | graphic | l3 #9D7751 | card #1A1714 | 4.41:1 | 3:1 | pass |
| dark | graphic | l4 #A49A8E | card #1A1714 | 6.45:1 | 3:1 | pass |
| dark | graphic | total #7A6D5F | card #1A1714 | 3.55:1 | 3:1 | pass |
| dark | UI utilisation fill | l2 #C9AE86 | sunk #24201B | 7.62:1 | 3:1 | pass |
| light | text | fg #1C1712 | bg #F6F1E8 | 15.81:1 | 4.5:1 | pass |
| light | text | fg #1C1712 | card #FBF8F2 | 16.78:1 | 4.5:1 | pass |
| light | text | fg #1C1712 | sunk #EDE6DA | 14.34:1 | 4.5:1 | pass |
| light | text | muted #6E655B | bg #F6F1E8 | 5.08:1 | 4.5:1 | pass |
| light | text | muted #6E655B | card #FBF8F2 | 5.39:1 | 4.5:1 | pass |
| light | text | muted #6E655B | sunk #EDE6DA | 4.61:1 | 4.5:1 | pass |
| light | text | pfg #FBF8F2 | primary #7A5A3A | 5.91:1 | 4.5:1 | pass |
| light | text | on #2F4A2A | card #FBF8F2 | 9.28:1 | 4.5:1 | pass |
| light | text | watch #8A5A00 | card #FBF8F2 | 5.59:1 | 4.5:1 | pass |
| light | text | off #A8324A | card #FBF8F2 | 6.15:1 | 4.5:1 | pass |
| light | text | on #2F4A2A | sunk #EDE6DA | 7.94:1 | 4.5:1 | pass |
| light | text | off #A8324A | sunk #EDE6DA | 5.26:1 | 4.5:1 | pass |
| light | UI | pinO #6E655B | card #FBF8F2 | 5.39:1 | 3:1 | pass |
| light | UI | pinO #6E655B | sunk #EDE6DA | 4.61:1 | 3:1 | pass |
| light | UI | pin #7A5A3A | card #FBF8F2 | 5.91:1 | 3:1 | pass |
| light | UI | input #8C7F70 | card #FBF8F2 | 3.68:1 | 3:1 | pass |
| light | UI | input #8C7F70 | sunk #EDE6DA | 3.14:1 | 3:1 | pass |
| light | UI | primary #7A5A3A | card #FBF8F2 | 5.91:1 | 3:1 | pass |
| light | UI focus ring | primary #7A5A3A | bg #F6F1E8 | 5.57:1 | 3:1 | pass |
| light | graphic | l1 #7A5A3A | card #FBF8F2 | 5.91:1 | 3:1 | pass |
| light | graphic | l2 #5A3A1E | card #FBF8F2 | 9.62:1 | 3:1 | pass |
| light | graphic | l3 #9D7751 | card #FBF8F2 | 3.82:1 | 3:1 | pass |
| light | graphic | l4 #6E655B | card #FBF8F2 | 5.39:1 | 3:1 | pass |
| light | graphic | total #8C7F70 | card #FBF8F2 | 3.68:1 | 3:1 | pass |
| light | UI utilisation fill | l2 #5A3A1E | sunk #EDE6DA | 8.22:1 | 3:1 | pass |

FAILS: []

## 6. Wallets in the snapshot (D13)

`node scan.mjs`: 1,846 distinct base58 strings of 32–44 characters across 1,056 files, every one carried by a known field: pool `address`/`pool` (992), token mints (815: `assetMint`, `quoteMint`, `mint`), lending and market `account` (29) and one raw market id, programs (4), oracle feeds (5: Kamino `scopePriceFeed`, Jupiter Lend `oracle`). None found inside text fields. No field named owner, wallet, holder, liquidator, user, authority, signer or obligation exists in any file (only counts: `positions`, `inBandPositions`, `totalPositions`, `holderKind`). The first run flagged the four Jupiter Lend `oracle` accounts; they are price feeds, and the scan now classifies them. `capture.mjs` also drops the pools' `discoveryVolume24hUsd` and `discoveryLiquidityUsd` (DexScreener discovery figures) so no off-chain volume sits in the snapshot.

## 7. Charts (rebuilt 2026-10-03 on the founder's word: the distribution chart he pasted, DefiLlama and trading charts)

Engine: `assets/analytics-charts.js`, inline SVG drawn at the element's real width (redrawn on resize), so axis type stays 11 px at every width. Kinds: a time card (headline value with its pin, change over the range with ▲/▼ and its sign, range tabs, value axis on the right, crosshair with date and value tags, a readout line, panes stacked on one time axis, candles), an exchange depth chart, the CLMM liquidity distribution (bars by price around the pool price, pool-price tag, zoom), grouped columns, ranked bars, sparklines. Every card has its source line with a pin; hover and arrow keys both move the crosshair.

- All stocks: exit capacity summed hour by hour across the 47 stocks' `/risk/assets/:id/history` (an hour drawn when at least 90% of stocks have a reading), weekend hours shaded; the asset table has a 7-day exit-capacity sparkline per stock.
- Asset: 4-hour candles from the hourly reference price (`/prices?days=31`; open, high, low and close of the hourly prices in each 4-hour UTC window: up candles hollow, down candles filled, so direction never rests on colour) with exit capacity at τ in the pane below; one year of daily closes (`/prices?days=365`); the depth chart from the sell and buy curves of one regime (cumulative size by average cost; squares are measured sizes, steps run between them, nothing is drawn past the 5% edge); the liquidity distribution; exit capacity over time (sell area, buy line).
- Lending: supplied (with borrowed), share lent out (95% alarm line, axis capped at 100%), supply APY (with borrow APY; a one-off spike is cut at twice the 95th percentile and named in words), ranges 30d/90d/1y; coverage by gap as grouped columns on a log axis with the 1.0 line.
- Palette: the dataviz validator fails the four-wood categorical set (low chroma, by design: one material). Charts therefore carry two series at most, in pairs that pass: dark hinoki #E6D3B7 / wood-400 #9D7751 (ΔE 27.9 normal, 27.6 deutan); light heartwood #5A3A1E / wood-400 (ΔE 21.8), each with a legend and direct labels or a readout.
- The liquidity distribution route (`GET /risk/pools/:address/liquidity`, risk-analytics a9961f9) lists tick arrays with `getProgramAccounts`, which DA3 bars until Mon Oct 5; e46e093 gates it, so the live chart reads "gate DA3 …" until then (and the dev API has no RPC set). `?preview=1` draws it on the recorded pool bytes of 2026-10-01 (SPYx Orca Fae5dW…, QQQx Raydium GMjGLW…), produced by the route's own code from the test fixtures, with the hatch band and the MOCK plate. Nowhere else on the page is MOCK.

Snapshot recaptured 2026-10-03T03:32:07Z: 1,442 routes (20 MB), including the history, price, lending-history, buy-depth and liquidity routes; 167 answered with an error the page shows as its reason (43 are the DA3 gate). `node scan.mjs`: 0 unknown base58 strings (the new flow block's `quote` field holds token mints and is classified as such).

## 8. Review fixes (independent review, 2026-10-03)

Blocking, fixed: the simulator's dollar margin was `margin × seized`; the liquidator's gain or loss is `margin × debt repaid`, where debt = seized ÷ (1 + b). The page now prints it on the debt and names the debt. (The brief's example sentence has the same slip.) Should-fix, fixed: the simulator's figures carry `assumption` when an extra gap is used and the margin says when the exit cost is a lower bound; sequence guards on the asset table and panel against out-of-order responses; the "covered on both ratios" sentence now checks both; a missing transfer fee or pool count is a reason, never 0; ids built from API strings are slugged; pins on the coverage share, unfilled share, other venues' LTV and the bonus maximum; local paths are dropped from source lines; hash routing survives a malformed hash.
