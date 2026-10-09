# The yield shelf on Solana: dollar fixed income for a test shelf

Oct 6, 2026. Research for `SHELF-YIELD` (`docs/vault/STATE-VAULT.md`), written from `docs/vault/PROMPT-YIELD-SHELF.md`. Rodrigo decided the list to screen on 2026-10-06, from the list he mapped (`inputs/solana_yield_assets.csv`, 55 rows; its yields are claims read on a date, not readings). Three research threads ran in parallel, one agent each (the first wave, the second wave, the Etherfuse bonds); the session that ran them read four of the mints again on chain and they matched. Everything was read through public, read-only sources: the Solana mainnet RPC, the Jupiter token and quote APIs, DexScreener, the DefiLlama yields API, the issuers' pages and public endpoints. No transaction was sent and no key was used. The code was read on `shelf/common` at `375720a`.

This note is the source of the rows in `packages/engine/src/personal/fixtures/shelves/solana-yield.json`, of their leg types in `leg-types.ts` and of their yields in `fixtures/yields-extended.json`. It lists nothing live: part (b), the rollout, is section 7.

Tags: `[n]` checked that day against source n. `[ns]` or `[ns n]` only a search-result snippet of source n was seen. `[rpc]` read on chain that day. `[api]` read from a public API that day, named. `[sheet]` only the input list says it; not verified. `[repo]` read in the code. `[run]` computed that day by the tests of this branch, on fixtures. `[own]` our reasoning, not from a source. Issuer and protocol names appear because the note is internal; what a person reads names the token only.

## 1. Bottom line

- **Seven tokens are on the extended shelf and can be in a plan**: USDY, wYLDS, kUSDC, jlJupUSD, PST, PRIME and AUTO. Two are rate legs (USDY, wYLDS), two are deposits in a lending market (kUSDC, jlJupUSD), three are credit (PST, PRIME, AUTO). All but USDY carry a caution, said on the row.
- **One of the seven needs Rodrigo's word first: kUSDC.** No market trades it; its exit is redemption at the lending reserve, which is open to anyone and at par, and which the vault cannot do yet. It is in test plans, at the thinnest tier, because Rodrigo chose it and the exit exists; section 5.2 asks whether it should wait off the shelf until the vault can redeem.
- **Four local-currency bonds are listed in their own currency and are in no plan yet**: TESOURO (reais), CETES (Mexican pesos), GILTS (pounds), KTB (won). A vault can hold them; the engine cannot use a bond as the matching leg of a goal until Rodrigo approves the change in sections 5.3 and 5.4.
- **Eight are on hold**, listed and in no plan, each with what would settle it: sUSD, sUSDe, ONyc, USD*, eUSX, oTFY, and the two bonds with no market on Solana (USTRY, EUROB).
- **Three of the tokens Rodrigo chose are out**: sUSDS (no Solana mint was found), USDC+ (it lost its backing in the Drift exploit of April 2026) and USX (it pays nothing; it is only the exit leg of eUSX).
- **Two tokens fit none of the four leg types**: ONyc (reinsurance) and USD* (a mix with swap fees). No type was invented: both wait for Rodrigo (section 5.1).
- **What it changes, on fixtures**: on the grid of 36 goals the share of a plan left in cash falls from 25.38% to 3.12%, the mean over the 69 candidates both shelves show `[run]`; the detail is in `comparison.md`. These are MOCK figures from fixture yields and tier ceilings, not a reading of any market.

| Token | Issuer | Leg types | Tier | Verdict | The filter that decides |
|---|---|---|---|---|---|
| USDY | Ondo | rate | A | add | 3: sells at $50,000 inside the A limit |
| wYLDS | Hastra | rate | B | add with caution | 3: one order book, a standing discount near 48 bps |
| kUSDC | Kamino | market_deposit | C | add with caution | 3: no market route, redemption only |
| jlJupUSD | Jupiter Lend | market_deposit | A | add with caution | 3: sells through redemption while it is open |
| PST | Huma | credit | A | add with caution | 5: credit with no borrower disclosure read |
| PRIME | Hastra | credit | A | add with caution | 1: passes; terms not read |
| AUTO | Hastra | credit | A | add with caution | 1: passes; terms not read |
| TESOURO (BRL) | Etherfuse | rate, in reais | C | add with caution, held out | 3: thin pool, about 5.7% under NAV |
| CETES (MXN) | Etherfuse | rate, in pesos | B | add with caution, held out | 3 |
| GILTS (GBP) | Etherfuse | rate, in pounds | C | add with caution, held out | 3 |
| KTB (KRW) | Etherfuse | rate, in won | C | add with caution, held out | 3 |
| USTRY | Etherfuse | rate | C | hold | 3: not tradable on Solana |
| EUROB (EUR) | Etherfuse | rate, in euros | C | hold | 3: not tradable on Solana |
| sUSD | Solayer | rate, unverified | thinner than C | hold | 3: a $100 sale loses over 4% |
| sUSDe | Ethena | basis | thinner than C | hold | 3: no route at $10,000 |
| ONyc | OnRe | none fits | A | hold | 5, and the leg type |
| USD* | Perena | none fits | A | hold | 5, and the leg type |
| eUSX | Solstice | basis, rate | B | hold | 5: off-chain basis; terms may bar retail |
| oTFY | Obligate | credit | A | hold | 1: no issuer page names the mint |
| sUSDS | Sky | rate, credit | none | out | 4: no Solana mint found |
| USDC+ | Reflect | market_deposit | none | out | 4: exploit-linked, redemption paused |
| USX | Solstice | no yield | A | out | not a yield asset |
| MEX | Etherfuse | none | none | out | 2: not a bond; what backs it was not found |

The table has the 22 tokens screened and MEX, a seventh Etherfuse token the issuer's own list turned up.

## 2. The filters, and how the rows were made

1. A vault can hold it: no allowlist and no KYC on a transfer to a program address.
2. It is a dollar asset, or, for the Etherfuse bonds, a local-currency bond.
3. It can be sold at a person's size. Depth is read from public, read-only sources. A thin market is not a reason to leave a token out; it is said, and the tier reflects it.
4. Live: not wound down, defunct or exploit-linked.
5. Low or medium risk: levered, algorithmic and junior tranches are out.

**The tier** is the launch shelf's rule, on the price impact of a sale into USDC: A, $50,000 at 35 bps or less; B, $10,000 at 35 bps or less; C, about $1,000 to $2,000 at 30 bps or less. Depth is the loss of a sale against a $100 sale on the Jupiter quote API, read between 15:34 and 15:36 UTC `[api]`. Three calls were made here and are Rodrigo's to change `[own]`:
- A token thinner than C has no tier that says so, since the launch shelf's fourth tier is "not listed". sUSD and sUSDe are therefore on hold and in no plan. Their rows carry C because the row's type has nothing thinner; the table above says "thinner than C".
- A token with no market route is judged by how it exits. Where the only exit is the issuer's, after KYC, a vault has none: USTRY and EUROB are on hold. Where anyone may redeem at par, the exit exists but the vault cannot use it yet: the Solana vault trades through a router and cannot redeem at a lending reserve today. kUSDC is the one such token here. It takes C, whatever its redemption allows, so no plan holds more than $1,500 of it, and it is the first question of section 5.2.
- The tier is a fallback. Bearing's measured exit replaces it at the rollout (gate `EXIT-SOURCE`); no exit of an added token is measured yet, so every plan line of one says it takes its tier ceiling.

**The fixture yields** are the dated figures of section 3, each with a haircut taken by hand, as the launch shelf's are: three tenths off a figure an aggregator reports, a quarter off a variable rate read from the protocol, half off a figure only the input list gives. They are fixtures, plated MOCK wherever shown.

**The issuer** on a row is the name that groups tokens for the 50% issuer cap (gate `SOLVER-CAPS`): jlJupUSD shares "Jupiter Lend" with jlUSDC, and wYLDS, PRIME and AUTO share "Hastra".

**Geo-blocks** became `blockedCountries` only where a list was read. For most issuers the terms page did not render, so the row's list is empty because it is unknown, and the row says so (`unverified`). For the three Hastra tokens the US is from the input list only.

## 3. The tokens


### 3.1 The first wave

Depth is the loss on a sale to USDC against a $100 sale, from the Jupiter quote API, read 15:34 to 15:35 UTC `[4]`. The API's own impact figure, against its reference price, is given beside it. kUSDC is the name used here for the deposit token of the USDC reserve of Kamino Lend's Main Market.

#### USDY (Ondo Finance)

- **Verdict** add. Deciding filter: 3 (it sells at $50k inside the A limit).
- **Issuer and backing** Ondo. A tokenised note secured by short-term US Treasuries, shares of a short-Treasury ETF and bank deposits [1]. The page now says "formerly issued by Ondo USDY LLC"; the current issuing entity was not pinned down.
- **Mechanism and leg types** The yield accrues in the price (1.152 USDC today [api, Jupiter]). Leg: `rate`.
- **Address** `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` [2][rpc], 6 decimals, spl-token.
- **Transfer restrictions** Freeze authority set (`51QV…hiuK`) [rpc]. No hook, no allowlist: a program-owned account can hold it [own].
- **Redemption** With Ondo: KYC, non-US, by bank wire [1]. A vault sells on Orca.
- **Geo-blocks** May not subscribe, acquire or redeem: US, Canada, Afghanistan, Belarus, Cuba, North Korea, Iran, Libya, Myanmar, Russia, Somalia, South Sudan, Sudan, Syria, occupied Ukrainian regions [18s]. Brazil, EEA, Hong Kong, Malaysia, Singapore, Switzerland and the UK need professional or qualified status to be issued USDY [18s].
- **Depth** $1k: 0 bps · $10k: 0.4 bps · $50k: 1.8 bps, Whirlpool [api]. API figure: 31.6 / 31.9 / 33.3 bps, so the pool sits about 31 bps under the reference price at any size.
- **Tier** A (close to the 35 bps line on the API measure).
- **Yield** 3.63% on 2026-10-06, DefiLlama, 30-day mean 3.59% [3]. Sheet: 3.5 to 3.75% [sheet]. Live: the DefiLlama pool; no issuer endpoint found.
- **Incidents** None found; not searched in depth.
- **Not verified** The Eligibility page itself; the issuing entity; an issuer-published yield.

#### sUSD (Solayer)

- **Verdict** hold. Deciding filter: 3.
- **Issuer and backing** Solayer; said to be backed by US T-bills through OpenEden [14s].
- **Mechanism and leg types** Token-2022 interest-bearing extension: the displayed amount grows, the raw amount does not [rpc][own]. Leg: `rate`, from launch coverage only.
- **Address** `susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X` [rpc], 6 decimals, token-2022. Not confirmed on a Solayer page; the on-chain metadata points to metadata.solayer.org [rpc].
- **Transfer restrictions** Freeze authority set (`FhVc…d2yG`, also mint and rate authority). Extensions: metadataPointer, interestBearingConfig, tokenMetadata. No hook, no permanent delegate [rpc].
- **Redemption** RFQ against USDC in the Solayer app [14s]; terms not verified.
- **Geo-blocks** Not verified; no terms found.
- **Depth** $100 already loses 428 bps (Raydium CLMM). No route at $1k, $10k or $50k [api]. About $7.7k in the one USDC pool [16].
- **Tier** C with a caution: thinner than C. The real exit is the issuer's RFQ.
- **Yield** About 3.4% [sheet]; no reading. The on-chain rate reads 3091 basis points (30.91%) [rpc], which cannot be a T-bill rate; do not use it until explained.
- **Incidents** None found; not searched. Supply is only about 629k tokens (about $0.7M) [rpc]: check it is still run before any use.
- **Not verified** Mint against the issuer; backing; redemption; geo-blocks; yield; the on-chain rate's meaning.

#### wYLDS (Hastra, wrapping Figure's YLDS)

- **Verdict** add with caution. Deciding filter: 3.
- **Issuer and backing** Hastra wraps YLDS, a face-amount certificate of Figure Certificate Company, registered with the SEC; an unsecured debt of that company [13s].
- **Mechanism and leg types** YLDS pays SOFR minus 0.50% [13s]. The wYLDS price stays near $1 (0.9998 [api, Jupiter]), so the yield does not accrue in the price; how a plain holder receives it was not verified. Leg: `rate`, with the issuer's credit beside it [own].
- **Address** `8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih` [rpc], 6 decimals, spl-token, supply 197.3M. Jupiter marks it verified [4]; not confirmed on a Hastra page.
- **Transfer restrictions** Freeze authority set (`8A18…bia6`). No hook, no allowlist [rpc].
- **Redemption** Hastra app to USDC; delay and limits not verified.
- **Geo-blocks** "US blocked" [sheet]. Hastra's site renders by script and could not be read; not verified.
- **Depth** $1k: 0 bps · $10k: 0 bps · $50k: 152 bps, Manifest order book [api]. API figure: 48 / 48 / 199 bps: every sale fills about 48 bps under par.
- **Tier** B, with a caution: one order book and a standing 48 bps discount.
- **Yield** 3.54% on 2026-10-06, DefiLlama, 30-day mean 3.43% [3]. Live: that pool, cross-checked with SOFR minus 0.50%.
- **Incidents** None found; not searched in depth.
- **Not verified** Mint against the issuer; terms; geo-blocks; redemption; how yield is paid.

#### sUSDS (Sky)

- **Verdict** out for now. Deciding filter: 4 (not live on Solana as far as found).
- **Issuer and backing** Sky, formerly Maker. The Savings Rate is set by governance and paid from Sky's income: crypto-backed loans, allocations to lending and credit, Treasury holdings [own].
- **Mechanism and leg types** Honest reading: `rate` plus `credit`. It is not a pass-through of a sovereign rate [own].
- **Address** None found. Jupiter lists no verified sUSDS on Solana [4]. The Wormhole post of 2024-09-20 says SKY, USDS and sUSDS "will be deployed" by Wormhole NTT, with no address and no word on how the rate would accrue there [10]. Only USDS is found: `USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA` [api, Jupiter].
- **Transfer restrictions** Not applicable.
- **Redemption** Not applicable. Nearest on Solana: jlUSDS (`j14XLJZS…LWvh`), a Jupiter Lend deposit at 4.01% [5], which is `market_deposit`, not the Savings Rate.
- **Geo-blocks** Not researched.
- **Depth** None.
- - **Tier** None: there is nothing to sell, and no row.
- **Yield** Savings Rate 3.60% on Ethereum, 2026-10-06 [9]. It applies to no Solana token found.
- **Incidents** Not researched.
- **Not verified** That no Solana sUSDS mint exists: absence from Jupiter is not proof; Sky's developer docs were not read.

#### kUSDC (Kamino Lend, Main Market USDC collateral token)

- **Verdict** add with caution. Deciding filter: 3.
- **Issuer and backing** Kamino Lend program `KLend2g3…gmjD`. Backed by the USDC reserve `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` of the Main Market `7u3HeHxY…5PfF` [6][rpc].
- **Mechanism and leg types** Borrowers pay interest; one token is worth about 1.204 USDC (121.98M USDC over 101.31M tokens) [6][rpc]. Leg: `market_deposit`.
- **Address** `B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D`, 6 decimals, spl-token. Read from the reserve account (collateral mint at byte 2560) and confirmed as a mint with the same supply [rpc].
- **Transfer restrictions** No freeze authority; mint authority is a program address; no extensions [rpc]. A plain program-owned token account can hold it [own]. That a deposit without an obligation hands out the token is from the program's design, not re-read today.
- **Redemption** Redeem at the reserve for USDC, up to the USDC not lent out: 10.9M free at 91.0% utilisation today [6]. Blocked at full utilisation. Withdrawal caps not verified.
- **Geo-blocks** Not verified; the terms page renders by script.
- **Depth** No DEX route: Jupiter says "not tradable" [api]. Exit is redemption only, at par while liquidity is free.
- **Tier** C with a caution (no DEX route).
- **Yield** 4.42% supply rate on 2026-10-06, variable [6]. Live: the same endpoint or the reserve account.
- **Incidents** None found; not searched in depth.
- **Not verified** Terms; withdrawal caps; the no-obligation deposit path.

#### jlJupUSD (Jupiter Lend)

- **Verdict** add with caution. Deciding filter: 3.
- **Issuer and backing** Jupiter Lend deposit token over JupUSD. JupUSD is Jupiter's dollar token, issued on Ethena Labs' infrastructure; reserves reported at launch (January 2026) as 90% USDtb and 10% USDC, custody at Anchorage [15s].
- **Mechanism and leg types** Borrowers pay interest; one share is 1.040228 JupUSD [5]. Leg: `market_deposit`. JupUSD pays the holder nothing; it adds an issuer exposure, not a leg [own].
- **Address** `7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk` [5][rpc], 6 decimals, spl-token. JupUSD: `JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD` [5][rpc].
- **Transfer restrictions** jlJupUSD: no freeze authority, no extensions. JupUSD has a freeze authority (`CkzL…BZNA`) [rpc].
- **Redemption** Redeem to JupUSD, then JupUSD to USDC on pools; Jupiter routes both. 7.65M of 50.29M JupUSD can be withdrawn now [5]. Blocked at full utilisation.
- **Geo-blocks** Not verified; terms page not found.
- **Depth** $1k: 0 bps · $10k: 0.1 bps · $50k: 0.2 bps; first hop is the redemption, then AlphaQ, Manifest, Raydium [api]. API figure 0. The result is about 5 bps under share value.
- **Tier** A, while redemption is open.
- **Yield** 3.79% from borrowers on 2026-10-06; a further 1.50% is an incentive and is kept out of the figure [5]. Live: the same endpoint.
- **Incidents** None found; not searched in depth.
- **Not verified** JupUSD reserves from an issuer document; terms; how rewards are paid.

#### sUSDe (Ethena)

- **Verdict** hold on Solana. Deciding filter: 3.
- **Issuer and backing** Ethena. A hedged position: spot assets long, futures short [own].
- **Mechanism and leg types** The yield accrues in the Ethereum share price; the Solana token (1.244 USDC [api, Jupiter]) follows it only through the bridge and arbitrage [own]. Leg: `basis`; it can pay less than nothing.
- **Address** `Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN` [7][rpc], 9 decimals, spl-token, supply 4.83M.
- **Transfer restrictions** Freeze authority set (`EWZC…VKZA`). No extensions [rpc].
- **Redemption** None on Solana: sell on the DEX, or bridge to Ethereum and unstake with the cooldown. The docs page does not name the bridge type [7].
- **Geo-blocks** Not verified.
- **Depth** $1k: 168 bps (Whirlpool; API 183 bps) · $10k and $50k: no route [api]. About $2.9k in the one USDC pool [16].
- **Tier** C with a caution: thinner than C.
- **Yield** 4.75%, issuer figure dated 30 Sep 2026; 30-day average 4.86% [8]. Live: the same endpoint.
- **Incidents** Not searched today.
- **Not verified** Bridge type; terms; incidents; cooldown length.

#### PST (Huma Finance)

- **Verdict** add with caution. Deciding filter: 5.
- **Issuer and backing** Huma 2.0. USDC funds payment-financing businesses; their fees are the yield [11]. Borrowers and any loss cover were not disclosed in the pages read.
- **Mechanism and leg types** The share price grows (1.137 USDC today [api, Jupiter]). Leg: `credit`.
- **Address** `59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw` [rpc], 6 decimals, spl-token, supply 363.2M. Jupiter marks it verified [4]; Huma's PST page shows no address [11].
- **Transfer restrictions** No freeze authority, no extensions [rpc]. No KYC [11].
- **Redemption** First come, first served; usually 1 business day, at most 7 days; a global daily cap resets at 00:00 UTC and requests over it are rejected [19]. Or sell on the DEX.
- **Geo-blocks** No list found; press says "outside restricted regions" [12s]. Not verified.
- **Depth** $1k: 0 bps · $10k: 0 bps · $50k: 0.2 bps, JupLend AMM and Whirlpool [api]. API figure 1.2 / 1.2 / 1.4 bps.
- **Tier** A.
- **Yield** About 8% [sheet]; no dated figure found. Live: none found; the PST price over time would give a realised rate.
- **Incidents** None found; not searched in depth.
- **Not verified** Mint against the issuer; borrowers and defaults; the cap's size; geo-blocks; yield.

### 3.2 The second wave

Depth method: Jupiter quote, token to USDC, output per token at the size against output per token at $100, in bps `[api]`. The API's own `priceImpactPct` is given beside it where it differs. All eight mints are classic SPL Token: no transfer hook, no default-frozen accounts, no permanent delegate `[rpc]`.

#### ONyc (OnRe)

- **Verdict.** Hold. Deciding filter: 5. It passes 1 to 4. What settles it: (a) Rodrigo's decision on a leg type for reinsurance; (b) the collateral make-up from OnRe's transparency dashboard, to rule out a basis asset or leverage inside.
- **Issuer and backing.** OnRe, "a fully licensed, collateralized reinsurer and onchain asset manager"; ONyc combines "premium income with collateral returns" `[102]`. Legal entity and regulator not found on the pages read.
- **Mechanism and leg types.** None of the four fits, and no leg type is recorded. The return is underwriting premium less insured losses, plus the yield on the collateral `[102]`. Nearest type: credit, because a loss is written down across the pool through NAV `[own]`. The difference: the loss comes from insured events, not from a borrower's default. A new type ("underwriting") would need: a NAV write-down on loss events, a tail that is seasonal and not tied to rates, the share of the yield that is collateral return and what that collateral is, and the redemption queue `[own]`.
- **Address.** `5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5`, 9 decimals, SPL Token (Tokenkeg) `[rpc]`. Jupiter-verified, 8,977 holders `[api: Jupiter tokens]`. Supply 254.1M × $1.1516 ≈ $293M, against $288M TVL on DefiLlama `[rpc][113]`.
- **Transfer restrictions.** Freeze authority `45Ynzauh…3jaJ5`; mint authority `AbpE5YLp…bMnNX`; no extensions `[rpc]`. No allowlist. The terms read have no clause on freezing or on program holders `[101]`.
- **Redemption.** A holder without KYC sells on the DEX. Issuer redemption carries a 25 bps fee and settles in USDC or USDG, with no fixed holding period `[ns 102]`. Direct mint and redeem at size need KYC `[ns 102]`. Queue not verified.
- **Geo-blocks.** Open Access Interface Terms of Use, effective 2025-11-09 `[101]`: AF, DZ, AO, AU, BY, BO, BA, BG, BF, BI, CM, CF, CU, HR, CD, ET, GW, HT, IR, IQ, CI, KE, XK, KW, LA, LB, LR, LY, ML, MC, ME, MZ, MM, NA, NP, NI, NG, KP, CY, MK, PA, PG, RO, RU, RS, SO, ZA, KR, SS, SD, SY, UA, GB, US, VE, VN, YE, ZW; plus Crimea, North Cyprus, South Ossetia, Somaliland and any sanctioned country. Brazil is not on the list `[101]`.
- **Depth.** $1k: 0.0 bps. $10k: 0.01 bps. $50k: 0.07 bps. Route: Orca Whirlpool. API impact 0.8 bps at every size. Read 15:34 UTC `[api: Jupiter quote]`.
- **Tier.** A.
- **Yield.** 11.02% on 2026-10-06, 30-day mean 11.23%: DefiLlama pool `7083d6a5-e3cb-4eeb-8204-f1b735e4ecbb`, an aggregator figure `[113]`. Sheet: ~11% `[sheet]`. Live: the same DefiLlama pool; an issuer NAV endpoint was not found.
- **Incidents.** None found. OnRe is not among the 11 protocols named after the Drift exploit `[107]`.
- **Not verified.** The mint on an OnRe page (cross-checked by the verified flag and the supply match only). Collateral make-up and leverage. Legal entity. Redemption queue. Use of the freeze authority.

#### PRIME (Hastra / Figure)

- **Verdict.** Add with caution. Deciding filter: 1 (a classic mint with no allowlist; it passes). Caution: the geo-blocks and the unstake terms could not be read today.
- **Issuer and backing.** Hastra, a Solana protocol built with Figure Technology Solutions `[ns 117]`. A person locks USDC for wYLDS (wrapped YLDS, Figure's registered yield-bearing dollar token) and stakes wYLDS for PRIME `[ns 117]`. PRIME earns from Democratized Prime, Figure's warehouse lending against home-equity lines of credit awaiting securitisation `[ns 117]`.
- **Mechanism and leg types.** `credit`. Underneath sits a rate leg (wYLDS), and the lending pool can queue exits as a market deposit does; the shares are not published `[own]`.
- **Address.** `3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7`, 6 decimals, SPL Token `[rpc]`. Jupiter-verified, 1,645 holders `[api: Jupiter tokens]`. Supply 118.9M × $1.0627 ≈ $126.4M, against $127.4M on DefiLlama `[rpc][113]`.
- **Transfer restrictions.** Freeze authority `YBRBjnVx…gojJU`; mint authority `EtnHujEk…J31KK`; no extensions `[rpc]`.
- **Redemption.** DEX sale, or unstake to wYLDS and wYLDS to USDC in the Hastra app `[sheet]`. Delays and fees not verified.
- **Geo-blocks.** Not verified. `hastra.io/terms` returned only its title to the reader `[116]`. The sheet says "geo-restricted" `[sheet]`. The row carries the US only, from the input list's line on the issuer, and says it is not verified; the rest is unknown, not unblocked.
- **Depth.** $1k: 0.07 bps. $10k: 0.63 bps. $50k: 0.82 bps. Route: Orca Whirlpool, Manifest, AlphaQ. Read 15:34 UTC `[api: Jupiter quote]`.
- **Tier.** A.
- **Yield.** 5.94% on 2026-10-06, 30-day mean 6.06%: DefiLlama pool `76bb34c2-e68a-4398-9fba-d8a14c0caa44` `[113]`. Sheet: "up to ~8%" `[sheet]`, which is above the figure read. Live: the same pool; the on-chain PRIME/wYLDS rate account was not identified.
- **Incidents.** None found. Not named in the Drift list `[107]`.
- **Not verified.** The mint on a Hastra page. Geo-blocks. Unstake delay and fees. Who bears a default and in what order. The issuing entity.

#### AUTO (Hastra / Figure)

- **Verdict.** Add with caution. Deciding filter: 1 (passes). Caution: consumer credit from one originator, 535 holders, and the same unread terms as PRIME.
- **Issuer and backing.** Hastra. Staking wYLDS gives AUTO, a share in a consumer auto-loan pool on Figure's Democratized Prime; the loans are originated and serviced by a third-party auto lender and tokenised under a master participation agreement `[ns 116]`. AUTO accrues borrower interest net of Hastra's fee `[ns 116]`.
- **Mechanism and leg types.** `credit`. wYLDS underneath is a rate leg `[own]`.
- **Address.** `GNE6oDS6jHrfaV3GQVVCCp37fDnT7PiPuewMKBj2bqNm`, 6 decimals, SPL Token `[rpc]`. Jupiter-verified as "Hastra AUTO" `[api: Jupiter tokens]`. Supply 65.8M × $1.0224 ≈ $67.28M, against $67.29M on DefiLlama `[rpc][113]`.
- **Transfer restrictions.** Freeze authority `GWceuiUg…RLBWp8`; mint authority `f8WN35KH…kTsrA`; no extensions `[rpc]`.
- **Redemption.** DEX sale, or unstake to wYLDS in the Hastra app `[sheet]`. Delays not verified.
- **Geo-blocks.** Not verified, as for PRIME.
- **Depth.** $1k: 0.0 bps. $10k: 0.62 bps. $50k: 2.59 bps. Route: the Manifest order book up to $10k; at $50k it also goes through the Orca AUTO/PRIME pool ($3.59M) `[118]` and then PRIME to USDC. Read 15:34 UTC `[api: Jupiter quote]`. The exit therefore leans on PRIME's pools `[own]`.
- **Tier.** A.
- **Yield.** 9.24% on 2026-10-06, 30-day mean 8.49%: DefiLlama pool `4964d3ac-eb9a-54dd-a7f6-faadac4393ea` `[113]`. Sheet: ~9% target `[sheet]`. Live: the same pool.
- **Incidents.** None found.
- **Not verified.** The mint on a Hastra page. Geo-blocks. The auto lender and the quality of the loans. Unstake terms. Any first-loss cover.

#### USD* (Perena)

- **Verdict.** Hold. Deciding filter: 5. What settles it: Perena's published backing, with the share that is delta-neutral and a statement on leverage.
- **Issuer and backing.** Perena. USD* is described as backed by "delta-neutral positions, secured lending markets, and tokenized real-world assets", priced at the pool's net asset value `[ns 112]`. A separate junior token (USD*-J, about 17% of the structure) takes losses first `[ns 112]`. USD*-J is out by filter 5 `[own]`; this section is about USD* only.
- **Mechanism and leg types.** None of the four alone, and no leg type is recorded. It is a mix of basis, market deposit and rate, plus swap fees from the stablecoin pool, and the shares could not be read `[own]`. Nearest single type: market_deposit. To type it the engine needs the published share of each source, or a "stable-pool" type that covers swap-fee income and the depeg risk of each pool asset `[own]`.
- **Address.** `star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM`, 6 decimals, SPL Token `[rpc]`. Jupiter-verified as "USD Star", 8,591 holders; supply 10.49M, about $11.5M `[api: Jupiter tokens][rpc]`.
- **Transfer restrictions.** No freeze authority; mint authority `ECJGrTZ6…qyCjHT`; no extensions `[rpc]`.
- **Redemption.** Burn in Perena's own program at any time: no lock, a 0.05% redemption fee, deposits free `[111]`.
- **Geo-blocks.** Not verified; no terms page was read.
- **Depth.** $1k, $10k, $50k: 0.0 bps each, at $1.10061 per token. Route: "Perena Star V2", which is the issuer's own program, not an outside market. Read 15:34 UTC `[api: Jupiter quote]`. Outside pools hold about $3.7k (Orca USD*/USDC) `[118]`. If Perena's program pauses there is no other exit `[own]`.
- **Tier.** A as measured, with that caution.
- **Yield.** ~9.3% `[sheet]` only. No issuer or aggregator figure was read today; DefiLlama lists no Perena pool for USD* `[113]`. Live: none found; the candidate is the USD* price in Perena's program state, differenced over time.
- **Incidents.** None found. Not named in the Drift list `[107]`.
- **Not verified.** The mint on a Perena page (the vanity address and the Jupiter route name agree). Backing shares. Leverage. Geo-blocks. Current yield. What a redemption gets when the pool is short of USDC.

#### USDC+ (Reflect)

- **Verdict.** Out. Deciding filter: 4.
- **Issuer and backing.** Reflect (reflect.money). The docs describe USDC supplied to over-collateralised lending pools on Kamino and Jupiter Lend, redeemable "anytime" `[106]`. That page carries no notice of what followed.
- **Mechanism and leg types.** `market_deposit` as documented `[106]`. Moot now.
- **Address.** `usd63SVWcKqLeyNHpmVhZGYAqfE5RHE8jwqjRA2ida2`, 6 decimals, SPL Token, freeze authority `KuBAWM6p…bcLgw` `[rpc]`. Jupiter-verified as "USD Coin Plus"; supply 1.88M `[api: Jupiter tokens][rpc]`. Not confirmed on a Reflect page.
- **Transfer restrictions.** Freeze authority present; no extensions `[rpc]`.
- **Redemption.** Mint and redemption were paused after the Drift exploit `[ns 108]`. From 2026-07-02, for 180 days, a voluntary buy-back pays 0.20 USDC plus 80 Reflect Credits per USDC+, and the holder gives up claims against Drift `[ns 108]`.
- **Geo-blocks.** Not read; not needed.
- **Depth.** None. Jupiter answers `TOKEN_NOT_TRADABLE` `[api: Jupiter quote]`. One Meteora pool with $25 `[118]`. Jupiter's price is $0.21 `[api: Jupiter tokens]`.
- **Tier.** None: no exit, and no row.
- **Yield.** None recorded.
- **Incidents.** Drift was exploited on 2026-04-01 for about $285M `[ns 108]`. Reflect Money is the first of 11 affected protocols named on 2026-04-02 `[107]`.
- **Not verified.** The share of backing lost. The mint on Reflect's own page.

#### USX (Solstice)

- **Verdict.** Out, by none of the five filters: it is a plain stablecoin with no yield, so it is not a shelf candidate by itself. It matters only as the exit leg of eUSX.
- **Issuer and backing.** Solstice. Verified institutions mint USX against USDC or USDT and redeem it for the same `[ns 105]`.
- **Mechanism and leg types.** No yield leg, and no leg type is recorded `[own]`.
- **Address.** `6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG`, 6 decimals, SPL Token `[rpc]`. Jupiter-verified, 11,597 holders, supply 212.0M `[api: Jupiter tokens][rpc]`.
- **Transfer restrictions.** One key, `Ze3CQhTM…qnto4`, is both mint and freeze authority; no extensions `[rpc]`.
- **Redemption.** DEX sale. Issuer mint and redeem are KYC and institutional `[ns 105]`; $500K+ `[sheet]`.
- **Geo-blocks.** Terms & Conditions `[ns 105]`: CU, KP, CD, IR, LY, BY, RU, SO, SS, SD, SY, US, YE; plus Crimea, Donetsk and Luhansk, and any sanctioned place. Read as a snippet only.
- **Depth.** $1k: 0.02 bps. $10k: 0.03 bps. $50k: 0.08 bps, at $0.9995. Route: Raydium CLMM, Orca Whirlpool, Manifest. Read 15:34 UTC `[api: Jupiter quote]`.
- **Tier.** A.
- **Yield.** None; USX pays nothing.
- **Incidents.** On 2025-12-26 USX fell to about $0.80 on Solana DEXs (one report says lower) when pool liquidity ran out; Solstice added liquidity and said collateral stayed above 100% `[ns 114][ns 115]`. strcUSX was wound down, with accrual ending Sep 21 and funds returned in USX (a search snippet whose page was not identified). No report was found that the wind-down touched USX reserves.
- **Not verified.** The mint on a Solstice page. The terms in full. A reserve attestation.

#### eUSX (Solstice)

- **Verdict.** Hold. Deciding filter: 5. What settles it: (a) the full text of the "professional and institutional users only" clause; (b) who runs the strategy, on which venues, in whose custody, and whether with leverage; (c) a current rate read from the vault, not a track-record figure.
- **Issuer and backing.** Solstice YieldVault. eUSX is the share a person gets for locking USX; "rewards accrue into its exchange rate" `[103]`. The yield comes from "delta-neutral strategies" `[103]`: funding-rate arbitrage and hedged staking, with a part in tokenised Treasuries `[ns 105]`.
- **Mechanism and leg types.** `basis` and `rate`. Mostly basis; the Treasury share is not published. The strategy trades off chain, so venue and custody risk sit on top `[own]`. It is not algorithmic and no leverage is stated, but none is ruled out either `[own]`.
- **Address.** `3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC`, 6 decimals, SPL Token `[rpc]`. The same address is printed in Solstice's docs `[103]`. Supply 11.62M, 6,331 holders `[rpc][api: Jupiter tokens]`.
- **Transfer restrictions.** No freeze authority; mint authority `2aHdm37d…rpWbRM`; no extensions `[rpc]`.
- **Redemption.** Unlock to USX in the app: cooldown "7 days standard; 24 hours for $1,000 or less" `[103]`. Or sell on the DEX. Locking needs no KYC `[sheet]`.
- **Geo-blocks.** As USX `[ns 105]`. The site also says the products are "intended for professional and institutional users only and are not available to retail investors in any jurisdiction" `[ns 105]`. If that holds for DEX buyers, eUSX is out for a retail plan `[own]`.
- **Depth.** $1k: 3.9 bps. $10k: 23.6 bps. $50k: 33.4 bps. Route: eUSX to USX on Orca and Raydium (about $1.1M each `[118]`), then USX to USDC. API impact: 8.8, 28.5 and 38.3 bps. Read 15:34 UTC `[api: Jupiter quote]`.
- **Tier.** A by one reading, 1.6 bps under the line; treat as B until measured again `[own]`.
- **Yield.** Issuer's claim: "13.96% 3-Year IRR", "21.5% in 2024", "zero negative months", undated `[104]`. This is a track record of the strategy, not a current rate, and it is the source of the sheet's ~14% `[sheet]`. Live: no endpoint found; the candidate is the eUSX/USX rate in the vault program, or the pool price (1.047 USX today `[118]`), differenced over time.
- **Incidents.** The USX depeg of 2025-12-26; Solstice said eUSX and the YieldVault were not affected `[ns 114]`. strcUSX wound down in September. No exploit found; Solstice is not in the Drift list `[107]`.
- **Not verified.** The clause above. Manager, venues, custody, leverage. A current yield. Whether the eUSX pools held their price during the December depeg.

#### oTFY (Obligate)

- **Verdict.** Hold. Deciding filter: 1. What settles it: an Obligate document that names the mint and says whether a holder without KYC may hold and sell it.
- **Issuer and backing.** Obligate AG (Zurich), through a Luxembourg securitisation vehicle; the token tracks the net asset value of a revolving book of trade-finance notes `[109]`, 7 to 90 days, on physical commodity trade `[ns 120]`.
- **Mechanism and leg types.** `credit`.
- **Address.** There is a Solana mint and it does move: `BwB3tNH92jKw6naNGDYDbDwRo8bvYxZVvZjRZRcoWR2h`, 9 decimals, SPL Token `[rpc]`. Found through the Raydium pair `7GzGBjKG…7qyq` `[118]`. Supply 25.74M matches the ~$26M reported `[rpc][ns 109]`. But Jupiter lists it unverified, as "RWA10 Yield Strategy", with 41 holders `[api: Jupiter tokens]`, and no Obligate page read shows the mint. `addressVerified` is false.
- **Transfer restrictions.** One key, `A1dZeiEE…YV2qm`, is both mint and freeze authority; no extensions, so no allowlist on chain `[rpc]`.
- **Redemption.** Issuer: KYC, qualified or professional investors `[110]`, $10,000 minimum, one-day subscription, seven-day redemption window subject to the liquidity buffer `[109]`. Secondary: one Raydium pool, kept near NAV by a market maker `[109]`.
- **Geo-blocks.** Not verified; no oTFY terms were found.
- **Depth.** $1k: 0.02 bps. $10k: 0.24 bps. $50k: 1.23 bps. Route: Raydium CLMM oTFY/USDC, $0.99M, $30k traded in 24h `[118]`. Read 15:35 UTC `[api: Jupiter quote]`. The API's own impact field is unusable here (no reference price). One pool and one market maker `[own]`.
- **Tier.** A as measured.
- **Yield.** 8.75% a year on Obligate's home page, undated `[110]`; a case study of 2026-08-18 calls it a 7-day historical figure `[109]`. Live: none found; Kamino's Obligate market prices oTFY from a daily Chainlink NAV feed `[109]`, which could be differenced.
- **Incidents.** None found. The token launched in June 2026 `[ns 120]`.
- **Not verified.** The mint against Obligate's own page. Whether Obligate allows holders without KYC or freezes them. Geo-blocks. The feed address.

### 3.3 The Etherfuse bonds

What holds for the whole family:

- **The list.** Etherfuse's own public endpoint returns seven tokens with a Solana mint: TESOURO (BRL), CETES (MXN), GILTS (GBP), KTB (KRW), USTRY (USD), EUROB (EUR) and MEX (MXN, not a bond) [api: 201]. Each mint below is the one that endpoint gives, then read on chain [rpc].
- **The issuer.** Etherfuse MX, S.A. de C.V. (Mexico, incorporated 7 June 2023) [205]. The TESOURO registration agreement names Etherfuse Liquid MX, S.A.P.I. de C.V. as issuer and Etherfuse MX as administrator [206]. The tokens are ledger-based securities under Swiss law (CO art. 973d) [205][206]; Mexico's CNBV ruled (P090/2024, 16 April 2024) that they are not securities there [205].
- **The backing.** Each token is "a proportional economic claim" valued at "the net asset value (NAV) of a segregated pool" of government paper [204]. Assets are held "in administration", not as Etherfuse's property, at BBVA México, Actinver and Kuspit; the protection named is a separation action under Mexican bankruptcy law and Swiss DLT rules, not a separate vehicle [205]. Attestations are said to be regular; no report or auditor was found [205]. No bankruptcy-remote entity is stated [own].
- **Can a vault hold it? Yes, on chain.** Every mint is Token-2022 with two extensions only, `interestBearingConfig` and `metadataPointer`. Freeze authority is null. There is no transfer hook, no default frozen state, no permanent delegate and no pause [rpc]. Orca pool accounts (program-owned) hold TESOURO, CETES, GILTS and KTB today [api: 210]. So "the mint is KYC" [sheet] is true of minting and redeeming with Etherfuse, not of the token [own].
- **The one legal caveat.** The registration agreement lists "whitelisting: restriction of transfers ... only to addresses of which the beneficial owner has been identified by the administrator" [206]. Nothing on the Solana mint can enforce it [rpc]. Whether Etherfuse refuses to redeem tokens bought on a DEX is not verified.
- **Two things the vault program must do** [own]: accept Token-2022 mints, and count raw amounts. The interest-bearing extension changes only the amount a wallet displays; Etherfuse's price is per raw token (TESOURO 1.2633 BRL after starting at 1.00 on 2024-09-18) [api: 201][rpc].
- **Redemption.** With Etherfuse, after KYC, "at NAV any business day. No lock-ups, no gates" [207]. "Instant within the liquidity float and T+1 beyond" is a third-party line [ns: 213]. A vault cannot redeem: its exit is the DEX pool, or the person withdraws the tokens and redeems under their own KYC [own]. Fees: a commission of 0.25% to 1.5% by yield, and 0.5% of interest withheld in Mexico [204].
- **Geo-blocks.** Etherfuse will not onboard residents of AF, BY, CF, CU, ER, ET, GW, IQ, IR, KP, LY, ML, MM, NI, RU, SD, SO, SY, US, VE [api: 202]. This confirms "US blocked" [sheet]. It limits minting and redeeming, not holding [rpc].
- **How the price moves.** In the bond's own currency the price per token only accrues: the coupon is in the price, not paid out [204][api: 201]. On Solana it trades against USDC, so its dollar price also moves with the currency [api: 209].
- **How to read it live.** Yield: `getAccountInfo` on the mint, `interestBearingConfig.currentRate` in basis points with `lastUpdateTimestamp` (all were reset on 2026-10-01 near 22:50 UTC; the reset looks weekly) [rpc]. For TESOURO the on-chain 1155 equals the "+11.55% APY" on the issuer's page [203]. Price in own currency: `GET https://api.etherfuse.com/lookup/stablebonds`, fields `tokenPriceDecimal`, `bondCurrency`, `calculatedAt`, no key needed [api: 201]. The rate is the issuer's posted rate; the realised figure is the change in `tokenPriceDecimal` between two reads [own]. Whether the posted rate is net of fees is not verified.
- **What a holder risks** [own]. (1) Currency: a dollar-based person carries the whole move of the real, peso, pound or won. (2) Selling below NAV: the pool, not the NAV, sets the price a vault gets; TESOURO and KTB sold about 5% under NAV today. (3) The rate resets: the yield follows the central bank down. (4) Price risk in local terms looks small but is not proven: the TESOURO page says "short-term", "Selic rate", start 1 Oct, next maturity 8 Oct [203], which reads like paper rolled weekly; a third party says "Tesouro Prefixado 2027" [ns: 213], which would have about a year of duration. The exact holding is not verified, so no size for a rate shock is supported. (5) The issuer, the custodian and the sovereign (the page shows BB for Brazil [203]).
- **Leg type.** `rate` fits all six bonds: each passes through a sovereign short rate, reset weekly on chain [rpc][203]. It is a rate in the bond's currency, so it is never a dollar-yield leg for a dollar goal [own].
- **Incidents.** None found in one search [214].

Depth below: Jupiter quote API, token to USDC, read 2026-10-06 15:35 UTC [api: 209]. "Impact" is the rate at the size against the rate at $100; the API's own `priceImpactPct` follows in brackets. "Against NAV" compares the $100 sale with `tokenPriceDecimal` at a daily reference rate [api: 211], so it is rough.

#### TESOURO (Etherfuse)
- **Verdict** add with caution, listed in BRL and left out of every plan until the engine change below. Filter 3 decides.
- **Issuer and backing** As above. Brazilian federal paper tied to the Selic; the page calls it "NTNs", "short-term" [203]. Product NAV BRL 2.73M [api: 201].
- **Mechanism and leg types** `rate` (Selic), in reais.
- **Address** `BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p`, 6 decimals, Token-2022; 450,293 tokens on Solana, 131 holders [rpc][api: 201, 209].
- **Transfer restrictions** None on chain [rpc]; the whitelisting clause [206].
- **Redemption** KYC with Etherfuse at NAV; not open to a vault.
- **Geo-blocks** The list above [api: 202].
- **Depth** $1k 0.4 bps (33) · $10k 1.6 bps (35) · $50k 6.9 bps (40), one Orca pool TESOURO/USDC of about $83k with $30 traded in 24 hours [api: 209, 210]. Against NAV the pool pays about 5.7% less (0.23747 against 1.263322 BRL ÷ 5.017 = 0.25181 USD) [api: 201, 211].
- **Tier** C with a caution. The impact alone would read A, but one $50k sale takes most of the pool's dollars and the price is well under NAV [own].
- **Yield** 11.55% a year in BRL, set 2026-10-01 [rpc], equal to the issuer's page [203]. Live: as above.
- **Incidents** None found.
- **Not verified** The exact holding and its maturity; the discount at a traded FX rate; redemption delay; custodian for the Brazilian paper.

#### CETES (Etherfuse)
- **Verdict** add with caution, listed in MXN, out of plans until the engine change. Filter 3.
- **Issuer and backing** Mexican CETES held at Mexican institutions [204][205]. Product NAV MXN 84.4M [api: 201].
- **Mechanism and leg types** `rate`, in pesos.
- **Address** `CETES7CKqqKQizuSN6iWQwmTeFRjbJR6Vw2XRKfEDR8f`, 6 decimals, Token-2022; 9.99M tokens, 4,092 holders [rpc][api: 209].
- **Transfer restrictions** None on chain [rpc].
- **Redemption** As above. Queue today: 5,209 tokens to redeem [api: 201].
- **Geo-blocks** The list above.
- **Depth** $1k 2.3 bps (2) · $10k 32.6 bps (32) · $50k no route. Orca CETES/USDC about $103k, and MXNe/CETES about $141k [api: 209, 210]. Against NAV: about 0.5% above.
- **Tier** B, just.
- **Yield** 5.55% a year in MXN, set 2026-10-01 [rpc]. Live: as above.
- **Incidents** None found.
- **Not verified** Maturity of the paper; redemption delay.

#### GILTS (Etherfuse)
- **Verdict** add with caution. Filter 3. **Mechanism and leg types** `rate`, in pounds.
- **Address** `GiLTSeSFnNse7xQVYeKdMyckGw66AoRmyggGg1NNd4yr`, 6 decimals, Token-2022; 49,118 tokens, 45 holders [rpc][api: 201, 209].
- **Transfer restrictions / Redemption / Geo-blocks** As the family.
- **Depth** $1k 7.9 bps (0) · $10k 63.8 bps (54) · $50k no route; Orca, about $7k of liquidity [api: 209]. Against NAV: level.
- **Tier** C. **Yield** 3.51% a year in GBP, set 2026-10-01 [rpc]. **Incidents** None found. **Not verified** The holding and its maturity.

#### KTB (Etherfuse)
- **Verdict** add with caution. Filter 3. **Mechanism and leg types** `rate`, in won. Live since 2026-01-16 [rpc].
- **Address** `KTBeXe7VMPMLxBsqDQu4KA9PdSajF3Hkw1y9qRsKqfL`, 6 decimals, Token-2022; 11.17M tokens (one is about $0.0007), 44 holders [rpc][api: 209].
- **Transfer restrictions / Redemption / Geo-blocks** As the family.
- **Depth** $1k 12.3 bps (22) · $10k 240 bps (250) · $50k no route; one Orca pool [api: 209]. Against NAV: about 4.8% under (rough).
- **Tier** C with a caution. **Yield** 2.75% a year in KRW, set 2026-10-01 [rpc]. **Incidents** None found. **Not verified** The holding; the discount.

#### USTRY (Etherfuse)
- **Verdict** hold. Filter 3: Jupiter answers "not tradable", so there is no DEX route on Solana; only 3,897 tokens are there, of a $12.4M product [api: 201, 209]. It is the one dollar bond of the family (`rate`, 3.25% in USD, set 2026-10-01 [rpc]).
- **Address** `USTRYnGgcHAhdWsanv8BG6vHGd4p7UGgoB9NRd8ei7j`, 6 decimals, Token-2022 [rpc]. **Tier** C, exit by KYC redemption only. **Not verified** The holding.

#### EUROB (Etherfuse)
- **Verdict** hold. Filter 3: not tradable on Jupiter; 334 tokens on Solana and a product NAV of EUR 348 [api: 201, 209]. `rate`, 1.96% in EUR [rpc].
- **Address** `EuroszHk1AL7fHBBsxgeGHsamUqwBpb26oEyt9BcfZ6G`, 6 decimals, Token-2022 [rpc]. **Tier** C, no route.

#### MEX (Etherfuse)
- **Verdict** hold; not a bond. Price fixed at 1.00 MXN, on-chain rate 0, not tradable on Jupiter [api: 201, 209][rpc]. No leg type applies: it would be a cash token in pesos. Mint `CeteszTBgDCiRWyPX6KFMHGVcSBTAg82dbaiFC7xDXSn`, 6 decimals, Token-2022 [rpc]. What backs it is not verified [ns].

## 4. Out, and why

Rodrigo's decisions of 2026-10-06, kept as decided and not researched again, each with its filter:

| Left out | Filter | Why |
|---|---|---|
| BUIDL, OUSG, BENJI, USTB, VBILL, USYC, WTGXX, SWEEP / SAFO / BAGEY, ACRED, kicUSDC, SCOPE | 1 | Permissioned: a vault is a program and cannot be put on an allowlist `[sheet]` |
| strcUSX, Credix, stSOL, dSOL | 4 | Wound down, defunct or exploit-linked `[sheet]` |
| SOL liquid staking and restaking tokens, JLP | 2 | Not dollar fixed income `[sheet]` |
| stSLX, hyUSD / sHYUSD, jrONyc | 5 | High risk: a staked governance token, a levered stable, a junior tranche `[sheet]` |
| PT and YT tokens (Exponent, RateX) | none of the five | The engine models no maturity `[repo]` |
| PYUSD | 2, in effect | No native yield `[sheet]` |
| reUSD, nPERENA | 4 | Unconfirmed on Solana `[sheet]` |

Added to "out" by this research, from the list Rodrigo chose to add:

| Left out | Filter | Why |
|---|---|---|
| sUSDS | 4 | No Solana mint was found: Jupiter lists none, and the 2024 bridge post says it "will be deployed" `[10]`. Absence from an aggregator is not proof (section 6) |
| USDC+ | 4 | Named among the protocols hit by the Drift exploit of 2026-04-01; mint and redemption paused; not tradable `[107][ns 108][api]` |
| USX | not a yield asset | It pays nothing, as PYUSD does not. Kept in section 3 because it is the exit leg of eUSX |
| MEX (Etherfuse) | 2 | Not a bond, and what backs it was not found `[api: 201]` |

## 5. For Rodrigo

### 5.1 Two tokens fit none of the four leg types

No type was invented. Both are listed and held out.

- **ONyc (reinsurance).** Its return is premium less insured losses, plus the yield on the collateral.
  - Option 1: map it to `credit`, the nearest. A loss is written down across the pool, as a default is; it would count against the credit budget and take the 40% cap. The word is wrong: there is no borrower, and the loss does not follow the credit cycle.
  - Option 2: a new type, `underwriting`. It needs a cap (we would start below credit's, at 20%), a rule for the credit budget (count it, since a loss is shared the same way), and a stress of its own: a loss event that marks the token down, sized from the issuer's loss history, which was not read.
  - **Recommendation: keep it on hold.** Read the collateral make-up on the issuer's transparency page first, to rule out a basis asset or leverage inside (filter 5). If Rodrigo wants it in test plans before that, option 1 with the caution on the row costs nothing and understates no risk the engine can express. Its terms block 58 countries, the UK, Australia and South Korea among them, not Brazil `[101]`.
- **USD\* (a stable pool with a mix of sources).** The issuer describes delta-neutral positions, lending markets and tokenised real-world assets, with a junior token below it; the shares were not read.
  - Option 1: type it by its mix, `basis` with `market_deposit` and `rate`. With `basis` in the list it counts against the credit budget and takes the smallest cap of the three.
  - Option 2: the new type proposed for a pool share on Robinhood Chain (`robinhood.md`, section 5), which covers swap-fee income and the depeg risk of each pool asset.
  - **Recommendation: keep it on hold until the backing shares and a statement on leverage are read; then option 1.** Its only deep exit is the issuer's own program (outside pools hold about $3,700), which Rodrigo should accept or not as depth.

### 5.2 Verdicts the filters do not settle

**kUSDC first, because it is in test plans.** Filter 3 asks that a token can be sold at a person's size. kUSDC cannot be sold: Jupiter answers "not tradable" `[api]`. It can be redeemed at the reserve by anyone, at par, while USDC is free there (about 10.9M at 91% utilisation `[6]`), and the vault has no instruction for that yet. On the grid of goals it is in 86 of the 90 plans shown, never above the $1,500 of its tier, and up to 37.5% of a small plan ($375 of $1,000) `[run]`.
- Option 1 (as built): keep it in test plans at the thinnest tier, with the caution on its row. The plans then show what the shelf would do once the vault can redeem; nothing here is live.
- Option 2: hold it out, as USTRY and EUROB are, until the program has a redeem leg, and let jlUSDC and jlJupUSD be the market deposits meanwhile.
- **Recommendation: option 1 for testing, and no listing in part (b) before the vault can redeem it.** It is Rodrigo's call; moving it is one line on its row (`heldOut`).

The rest are listed, held out, and say why on the page. A recommendation for each:

| Token | Recommendation | What would change it |
|---|---|---|
| sUSD (Solayer) | Out for now | A Solayer page that names the mint and the backing, and a market: today a $100 sale loses 428 bps, the supply is about $0.7M, and the rate on the mint reads 30.91%, which is not a T-bill rate `[rpc]` |
| sUSDe on Solana | Out on Solana for now | A pool: today about $2,900 sits in the one USDC pool, and the real exit is on Ethereum |
| eUSX (Solstice) | Out for a retail plan unless the clause is read otherwise | The full text of "professional and institutional users only"; who runs the strategy, where, and whether with leverage; a current rate. The ~14% of the input list is a three-year track record, not a rate |
| oTFY (Obligate) | Hold, and ask the issuer | A document that names the mint and says a holder without KYC may hold and sell it. 41 holders today |
| USTRY, EUROB (Etherfuse) | Hold | A market on Solana: Jupiter marks both not tradable |

### 5.3 The Etherfuse bonds as a matching leg (an engine change: not built)

The recorded default stands: each bond is listed in its own currency, is meant as the matching leg of a goal in that currency, and is never held in a dollar goal's dollar yield. Today the rows carry `currency` and are in no plan, with the reason "a bond in reais is not a cash leg yet". The proposal for the change is section 5.4. Rodrigo decides:

1. **Way A or way B.** A: an engine-local table of currencies by symbol, as `LEG_TYPES` is, with no edit to the shared type. B: one line in `packages/schemas` that lets a `dollar_yield` token carry `currency`, which is Thom's to approve. **Recommendation: A now, and raise B with Thom** with the schema commit that moves leg types onto the shelf row.
2. **Whether a bond may be the whole matching leg.** TESOURO sold about 5.7% under its net asset value on its one pool today, and KTB about 4.8% `[api]`. **Recommendation: cap a bond's share of the set-aside** (the `rate` cap, 40%, is the starting number) and value it at the pool's price, not the issuer's.
3. **Which bonds.** TESOURO and CETES are the two Rodrigo named. GILTS and KTB have 45 and 44 holders and thin pools: listed and held out, as a thin market is not a reason to leave a token out. **Recommendation: build the change for TESOURO first**, and let Bearing measure its pool before any plan counts on it.
4. **No rate-shock stress yet.** The research could not confirm what TESOURO holds (paper rolled weekly at the Selic rate, or a fixed-rate 2027 bond), so no size for a shock has a source. `fx_goal_*` and `yields_fall` already apply.

### 5.4 Proposal: a bond as the matching leg


Paths are in this repository, read on `shelf/common`. Nothing was changed.

**What the engine does today.**
- Only a `cash` token may carry `currency`: the refine at `packages/schemas/src/basket-asset.ts:75-78`.
- `matchingOf` returns the chain's `cash` token in the currency, or null (`packages/engine/src/personal/world.ts:408-411`); "dollars" is `currency ?? 'USD'` (`world.ts:295`).
- Setting aside fills the matching leg without a cap and sends the rest to dollar cash; with none listed it flags `no_matching_leg:<cur>` (`set-aside.ts:103-115`). The coverage check counts matching legs at par (`set-aside.ts:150-158`).
- The schedule calls a holding `matching` only if it is cash in another currency, keeps its value in that currency through an FX move, sells cash at no cost and without a window limit, and accrues only `dollarYield` holdings (`schedule.ts:86-110`, `:124`, `:172-173`).
- Stresses: `yields_fall` where a `dollarYield` sleeve is held, `fx_goal_up/down` for any goal not in dollars (`status.ts:22-31`; sizes at `params.ts:102`).
- Leg types and their caps are read by symbol from a local table (`leg-types.ts:22`, `world.ts:452-467`). A dollar-yield token with no row is left out (`placement.ts:210-213`).

**The smallest honest change.** Let the matching leg for a currency be, after the cash token, a rate-only token counted in that currency. Four behaviours, each already half there:
1. *Who it is.* One helper `currencyOf(asset)`; `matchingOf` prefers cash, then a `dollar_yield` token with `currencyOf === cur`, a `rate`-only row in `LEG_TYPES` and a yield reading. Preferring cash keeps every existing reais test as it is.
2. *Never in a dollar goal.* Every place that gathers dollar-yield tokens takes only `currencyOf === 'USD'`: `placement.ts` (the loop near :205), `compose.ts:435` and `:465`, the `rateLegs` of `set-aside.ts`, `rebalance.ts:1077`. Best done once, where `world.ts` builds the list, with a left-out reason ("counted in reais; this goal is in dollars"). A test enforces it, like `PROTECT-NO-STOCKS`.
3. *Not cash.* In `set-aside.ts` the fill is capped by `yieldCapOf` (the `rate` cap and Bearing's ceiling, gate `EXIT-SOURCE`); the rest goes to dollar cash with the reason. The coverage check counts it as what it can sell in a window after cost, not at par. In `schedule.ts` only two lines move: `native` and `kind` read `currencyOf` instead of `isCash`, and the accrual line adds `matching` bonds, growing `native` by their haircut yield a twelfth a month. `costOf` and `perWindow` already treat any non-cash as sold at a measured cost within a window.
4. *Its stresses.* `yields_fall` already applies (the class maps to `dollarYield`). `fx_goal_*` leave its value in reais alone, as for matching cash. **No rate-shock stress yet:** the research could not confirm what TESOURO holds (weekly-rolled Selic paper or a fixed-rate 2027 bond), so no size has a source. The risk the research did measure is selling under NAV (about 5.7% today): the plan must value and sell the bond at Bearing's measured price in dollars, not at Etherfuse's NAV.

**Must `packages/schemas` change?** Two ways.
- *A, no schema edit now (recommended).* Follow the `LEG_TYPES` precedent: a local table in the engine, by symbol, `{ currency, source, readAt }`. The shelf row is `cls: 'dollar_yield'` with no `currency`, so it passes today's schema; `currencyOf` reads `asset.currency ?? LOCAL[symbol] ?? 'USD'`. The table moves onto `BasketAsset` in the schema commit Thom already has to approve for leg types.
- *B, the one-line schema edit.* Relax the refine to `cls === 'cash' || cls === 'dollar_yield'` and reword the doc comment. Cleaner in the end, but it is the shared type: flag it for Thom. A new class (`local_bond`) is larger: every `Record<AssetClass, …>` table, the database enum and the sleeves change. Not advised.
- Trade-off: A ships without Thom but keeps a reais bond under a class named `dollar_yield` and its currency off the shared row for a while; B is honest in the type but waits on him.

**Other files.** `types.ts` and `templates.ts`: one reason code for "set aside in a bond in reais: its price can move" and one for the left-out line. `leg-types.ts`: a `rate` row per bond with its source. `world.ts` `World` type: `currencyOf`. `docs/vault/DESIGN-VAULT.md` lines 1101-1104 and 1111 say "the chain's cash token" and "at par": they change in the same pull request (`/decide`).

**Tests that would pin it.** (a) A reais goal on a shelf with TESOURO and no reais cash: the set-aside is in TESOURO up to its cap, the rest in USDC with the reason, and no `no_matching_leg:BRL`. (b) With `reaisToken()` also listed, the plan equals today's. (c) The schedule's rows grow by the haircut yield in reais, and `fx_goal_down` does not move the bond's reais value while `yields_fall` lowers it. (d) A dollar goal on the same shelf gives a plan equal, line for line, to the launch-shelf plan, with TESOURO left out and the reason said. (e) A peso goal is not given TESOURO. (f) The coverage check does not count the bond at par.

**What must not change.** Every plan on `launchShelf()`: no row there has a currency, `currencyOf` returns `'USD'` for all of them, and the existing pinned tests run unedited. Dollar goals never see a bond.

**The interim state.** List the bonds on the extended shelf with `currency` set and keep them out of every plan. Options for the row, given the cash-only refine:
1. *As the fixtures already allow (recommended).* `ExtendedRow.asset` is parsed with `BasketAssetBase`, which has no refines (`testing.ts:212-214`), and a row with `heldOut` never enters the `Shelf` the engine takes (`testing.ts:208-210`). So: `cls: 'dollar_yield'`, `currency: 'BRL'`, `heldOut: 'a bond in reais is not a cash leg yet'`. No schema edit. Add one test: every extended row with a currency and a class other than cash has `heldOut`. The refined `BasketAsset` then acts as a tripwire if someone promotes the row early.
2. `cls: 'cash'` with `currency: 'BRL'`: passes the refine but is false; if promoted the engine would hold it at par with no selling cost. Reject.
3. Leave `currency` off the asset and put it in a side field of `ExtendedRow`: needs the strict row type changed and drops the recorded default "listed in its own currency". Not advised.

**Recommendation.** Interim option 1 now. Then the engine change by way A, with the rate-shock stress left out until the holding is confirmed from a primary source, and the bond sold and valued at Bearing's measured price. Raise way B with Thom alongside the leg-type schema commit. Open points for Rodrigo: whether a bond matching leg should have a ceiling as a share of the set-aside (it sells below NAV today), and whether TESOURO's thin pool is deep enough to be anyone's matching leg before Bearing has measured it.

### 5.5 Smaller calls made here, for Rodrigo to overturn

- **kUSDC's tier, if it stays (section 5.2).** By what it redeems it would be A, as jlUSDC is on the launch shelf. It is C because no router trades it. If the vault gains a redeem leg, tier it by the free liquidity Bearing measures.
- **wYLDS is typed `rate` only.** It wraps a certificate that is an unsecured debt of its issuer `[13s]`, so the issuer's credit stands beside the rate. Every rate token has an issuer; this one's promise is unsecured. Typed `rate` it enters the safe-yield sleeve and a "no lending" plan. Typed `rate` with `credit` it would count against the credit budget and leave both. Rodrigo may prefer the second.
- **No `LEG_TYPES` row for a token that is in no plan.** The six new rows are the tokens a plan may hold. A token on hold or held out gets its row when it enters plans, so a type is never recorded ahead of the decision that it waits on. The shared test fails if a row is moved into plans without one.
- **wYLDS is tier B, and its yield is taken on trust.** Its price stays near one dollar, so the yield is not in the price, and how a plain holder (a vault) receives it was not verified. If a vault earns nothing by holding it, it is cash with an issuer, and comes off the shelf. This is the first thing to check before a rollout.
- **USDY is not blocked for Brazil.** The issuer's eligibility page (seen as a search extract) bars the US, Canada and the sanctioned list, and asks professional or qualified status in Brazil, the EEA, the UK, Hong Kong, Malaysia, Singapore and Switzerland to be *issued* USDY `[18s]`. A plan buys it on a pool. Only the barred countries are on the row. Whether the second list should also block is Rodrigo's call; `portfolio-method.md` already notes that a Brazilian retail holder cannot redeem with the issuer.
- **jlJupUSD's yield leaves the incentive out**: 3.79% from borrowers is the figure, and the further 1.50% of rewards is not counted `[5]`.
- **PST's yield is the input list's**, about 8%, with half taken off. No dated issuer figure was found.
- **The US is on the three Hastra rows from the input list only.** The terms page did not render.

## 6. What could not be verified

- **Geo-blocks** for Hastra (wYLDS, PRIME, AUTO), Solayer, Kamino, Jupiter Lend, Ethena, Huma, Perena and Obligate: the pages render by script or were not found. Ondo's and Solstice's lists are from search extracts.
- **Mints against an issuer page**: wYLDS, PST, sUSD, ONyc, PRIME, AUTO, USD*, USX and oTFY were confirmed on chain and by the aggregator's verified flag or by supply against reported size, not on the issuer's own page. USDY, sUSDe, eUSX, kUSDC, jlJupUSD and the Etherfuse mints were confirmed against the issuer or its own endpoint.
- **That sUSDS has no Solana mint.** Sky's developer documents were not read.
- **Yields from the issuer**: USDY, wYLDS, ONyc, PRIME and AUTO are an aggregator's figures; PST, sUSD and USD* are the input list's only; eUSX's and oTFY's are undated issuer claims.
- **Redemption terms**: wYLDS, the Hastra unstake, Kamino's withdrawal caps, the ONyc queue, what a USD* burn returns when the pool is short of USDC, the Etherfuse delay from a primary source.
- **Backing**: JupUSD's reserves from an issuer document; Solayer's; ONyc's collateral; eUSX's manager, venues and leverage; the borrowers behind PST, PRIME and AUTO and who bears a loss first; what each Etherfuse bond holds.
- **Incidents** were searched once per token at most, and not at all for sUSDe.
- **The vault program**: that it accepts Token-2022 mints and counts raw amounts (the Etherfuse bonds and sUSD carry the interest-bearing extension), and that a Kamino deposit without an obligation hands the token to a plain account. Neither was checked in `programs/`.

## 7. Rollout (b)

Not done here. Nothing below is started. Per token added to plans, what is left and who does it:

| Step | What | Who |
|---|---|---|
| The mint on mainnet | Read again the mint, decimals and token program of each token on the day of listing; the seven are in section 3, all classic SPL Token with 6 decimals | Rodrigo's session, read-only |
| A live yield source | USDY, wYLDS, PRIME, AUTO: the aggregator's pool, or a rate read from the issuer if one is found. kUSDC: the reserve's supply rate from the protocol's endpoint or the reserve account. jlJupUSD: the lending endpoint's supply rate, incentives apart. PST: none found; the token's price over time gives a realised rate. Each with `source`, `fetched_at` and `method` | Rodrigo (feeds) |
| What a vault earns | wYLDS: how a plain holder receives the yield. kUSDC and jlJupUSD: that the vault holds the deposit token itself | Rodrigo, then Thom |
| Bearing's exit measurement | The collectors are not edited before Oct 12 (`CLAUDE.md`). Until then each added token takes its tier ceiling, labelled a fallback. After: add the seven mints and their pools to the Solana collector; kUSDC needs a redemption reading, not a pool | Rodrigo, after Oct 12 |
| The vault's on-chain asset list | `upsert_asset` for each mint in the Solana program's list. kUSDC also needs a way to enter and leave that is not a router swap. A deploy: it needs a person's word | Thom |
| The production registry row | One row per token with its class, issuer, tier or measured cap, `blockedCountries` once the terms are read, and its leg types on the shelf row when the schema commit moves them there | Rodrigo, Thom for the schema |
| The decision | A `/decide` entry under gate `UNIVERSE` for the final list, with the answers to section 5 | Rodrigo |

The tokens held out need their own step first: Rodrigo's answer in section 5.

## 8. Sources


[1] Ondo Finance docs, "USDY: Basics", https://docs.ondo.finance/general-access-products/usdy/basics, read 2026-10-06
[2] Ondo Finance docs, "Addresses", https://docs.ondo.finance/addresses, read 2026-10-06
[3] DefiLlama, yields API, https://yields.llama.fi/pools, read 2026-10-06
[4] Jupiter, token search and quote API, https://lite-api.jup.ag/tokens/v2/search and https://lite-api.jup.ag/swap/v1/quote, read 2026-10-06
[5] Jupiter Lend, earn tokens API, https://lite-api.jup.ag/lend/v1/earn/tokens, read 2026-10-06
[6] Kamino, reserves metrics API, https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics, read 2026-10-06
[7] Ethena docs, "Key Addresses", https://docs.ethena.fi/technical-design/key-addresses.md, read 2026-10-06
[8] Ethena, yields API, https://ethena.fi/api/yields/protocol-and-staking-yield, read 2026-10-06 (figure dated 30 Sep 2026)
[9] Block Analitica for Sky, overall API, https://info-sky.blockanalitica.com/api/v1/overall/, read 2026-10-06
[10] Wormhole, "Sky (formerly Maker) is expanding SKY, USDS and sUSDS multichain to Solana with Wormhole NTT", https://wormhole.com/blog/sky-formerly-maker-is-expanding-sky-usds-and-susds-multichain-to-solana-with, read 2026-10-06 (dated 2024-09-20)
[11] Huma Finance docs, "Huma 2.0: Overview" and "PST", https://docs.huma.finance/products/huma-2.0/overview, read 2026-10-06
[12] Huma Finance blog, "Introducing Huma 2.0: Real Yield on Solana", https://blog.huma.finance/introducing-huma-2.0-permissionless-real-yield-on-solana, search extract 2026-10-06
[13] Eco, "YLDS on Stellar: Figure's Yield-Bearing Stablecoin Explained", https://eco.com/support/en/articles/14982160-ylds-on-stellar-figure-s-yield-bearing-stablecoin-explained, search extract 2026-10-06 (secondary)
[14] Crypto Briefing, "Solayer launches first-ever yield-bearing stablecoin backed by T-Bills on Solana", https://cryptobriefing.com/solana-stablecoin-launch-susd/, search extract 2026-10-06 (secondary)
[15] Blockhead, "Jupiter Launches JupUSD Stablecoin Built on Ethena Infrastructure", https://www.blockhead.co/2026/01/06/jupiter-launches-jupusd-stablecoin-built-on-ethena-infrastructure/, search extract 2026-10-06 (dated 2026-01-06, secondary)
[16] DexScreener, token pairs API, https://api.dexscreener.com/latest/dex/tokens/<mint>, read 2026-10-06
[17] Solana mainnet RPC, getAccountInfo, https://api.mainnet-beta.solana.com, read 2026-10-06
[18] Ondo Finance docs, "USDY: Eligibility", https://docs.ondo.finance/general-access-products/usdy/eligibility, search extract 2026-10-06
[19] Huma Finance docs, "Redemption", https://docs.huma.finance/products/huma-2.0/redemption.md, read 2026-10-06
[101] OnRe, "Open Access Interface Terms of Use", https://www.onre.finance/legal/open-access-interface-terms-of-use, read 2026-10-06 (effective 2025-11-09)
[102] OnRe docs, "Welcome to OnRe" and "Open Access vs Institutional Access", https://docs.onre.finance, read 2026-10-06 (redemption terms seen as a search snippet only)
[103] Solstice docs, "eUSX (powered by YieldVault)", https://docs.solstice.finance/solstice-for-users/eusx-powered-by-yieldvault, read 2026-10-06
[104] Solstice, "YieldVault", https://solstice.finance/vaults, read 2026-10-06
[105] Solstice docs, "Terms and Conditions", https://docs.solstice.finance/legal-documents/terms-and-conditions, search snippet only, 2026-10-06
[106] Reflect docs, "USDC+", https://docs.reflect.money/strategies/USDC, read 2026-10-06
[107] KuCoin News, "11 DeFi protocols affected by Drift vulnerability, partial functions suspended", https://www.kucoin.com/news/flash/11-defi-protocols-affected-by-drift-vulnerability-partial-functions-suspended, read 2026-10-06 (dated 2026-04-02)
[108] Cryptopolitan via Bitget News, "Reflect opens USDC+ recovery program as Drift, Humanity move on from hack", https://www.bitget.com/news/detail/12560605487884, search snippet only, 2026-10-06 (the Cryptopolitan page returned 403)
[109] Gogol (Substack), "From Issuance to a Live DeFi Market: The Obligate oTFY Case Study", https://gogol.substack.com/p/from-issuance-to-a-live-defi-market, read 2026-10-06 (dated 2026-08-18; a secondary source)
[110] Obligate, home page, https://www.obligate.com/, read 2026-10-06
[111] Perena docs, "Use Perena", https://perena.gitbook.io/perena/use-perena, read 2026-10-06
[112] Perena app, "Get USD STAR (USD*)", https://app.perena.org/earn, search snippet only, 2026-10-06 (the page did not render to the reader)
[113] DefiLlama, yields API, https://yields.llama.fi/pools, read 2026-10-06 15:36 UTC
[114] Bitget News, "Solstice: USX is not an algorithmic stablecoin, eUSX and YieldVault are unaffected", https://www.bitget.com/news/detail/12560605123360, search snippet only, 2026-10-06
[115] The Crypto Times, "USX Stablecoin on Solana Depegs to $0.8 Amid Liquidity Concerns", https://www.cryptotimes.io/2025/12/26/usx-stablecoin-on-solana-depegs-to-0-8-amid-liquidity-concerns/, search snippet only, 2026-10-06 (dated 2025-12-26)
[116] Hastra, "Terms of Use", https://hastra.io/terms, search snippet only, 2026-10-06 (the page returned only its title)
[117] KuCoin, "Alpha Project Radar: PRIME (Hastra)", https://www.kucoin.com/news/insight/SOL/6abf0c2638a26400079227ad, search snippet only, 2026-10-06
[118] DexScreener API, https://api.dexscreener.com/latest/dex/tokens/<mint> and /pairs/solana/<pair>, read 2026-10-06
[119] Jupiter, tokens API https://lite-api.jup.ag/tokens/v2/search and quote API https://lite-api.jup.ag/swap/v1/quote, read 2026-10-06
[120] DefiLlama, "Obligate Trade Finance Yield (oTFY)", https://defillama.com/rwa/asset/oTFY, search snippet only, 2026-10-06
[201] Etherfuse API, "List stablebonds", https://api.etherfuse.com/lookup/stablebonds, read 2026-10-06 (`calculatedAt` 2026-10-06T15:33:49Z)
[202] Etherfuse API, "List restricted countries", https://api.etherfuse.com/lookup/restricted-countries, read 2026-10-06
[203] Etherfuse, "Stablebonds - TESOURO", https://app.etherfuse.com/bonds/BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p, read 2026-10-06 (shows start 1 Oct 2026, next maturity 8 Oct 2026)
[204] Etherfuse, "Stablebonds - Overview", https://app.etherfuse.com/legal/stablebonds-overview, read 2026-10-06
[205] Etherfuse, "Legal FAQs", https://app.etherfuse.com/legal/legal-qa, read 2026-10-06
[206] Etherfuse / MME, "Etherfuse (TESOURO) - Registration Agreement", https://stablebonds.s3.us-west-2.amazonaws.com/swiss/Etherfuse+%28TESOURO%29+-+Registration+Agreement+-+MME.txt, read 2026-10-06 (undated)
[207] Etherfuse, "Stablebonds", https://etherfuse.com/products/stablebonds, read 2026-10-06
[208] Etherfuse, API reference index, https://docs.etherfuse.com/llms.txt, read 2026-10-06
[209] Jupiter, token search and quote API, https://lite-api.jup.ag/tokens/v2/search and https://lite-api.jup.ag/swap/v1/quote, read 2026-10-06 15:35 UTC
[210] DexScreener, token pairs API, https://api.dexscreener.com/latest/dex/tokens/<mint>, read 2026-10-06
[211] ExchangeRate-API, daily reference rates, https://open.er-api.com/v6/latest/USD, read 2026-10-06 (dated 2026-10-06 00:02 UTC)
[213] davigiroux/safenudge.xyz, issue #56 "BRL-denominated yield via Etherfuse TESOURO", https://github.com/davigiroux/safenudge.xyz/issues/56, read 2026-10-06 (third party, cites no primary source)
[214] Web search "Etherfuse stablebonds incident exploit depeg paused hack", run 2026-10-06: no report found
