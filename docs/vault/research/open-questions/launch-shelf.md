# Launch shelf: 8 community indexes and the platform asset list

Oct 1, 2026. Proposal for Rodrigo and Thom to edit; nothing here is approved. All numbers were pulled read-only today between about 13:20 and 14:00 UTC (around the US open). No trades were made. Machine-readable copy of everything below: `launch-shelf.seed.json` in this folder.

> Oct 1 update: no meme index in the MVP. Trench Survivors stays here as research only; the MVP shelf is the other seven.

## Short version

- 8 indexes, 14 per-chain recipes. Five are families across chains (The 500, The Seven, Storm Cellar, Crypto in a Suit, Home Team); three are single-chain (Trench Survivors on Solana, Chips & Agents on Base, Sand to Server on Robinhood Chain).
- Every component has a price feed listed today (Chainlink on the EVM chains, Pyth on Solana), so every recipe can be auto-follow. Estimated price impact is under 30 bps for a $50k basket on all 14 recipes, and under 12 bps at $10k.
- Robinhood Chain: 36 Stock Tokens have a Chainlink feed. 26 are liquid enough to list; 10 are too thin (ORCL, NBIS, USAR, ASML, CRWV, RKLB, IONQ, RGTI, EWY, CLSK).
- Base: all 10 Coinbase stock tokens are liquid ($0.85M to $2.6M per token, mostly one Aerodrome USDC pool each) and cost under 10 bps at $10k.
- Robinhood Chain is the only chain with liquid, feed-covered T-bills (SGOV), oil (USO), silver (SLV) and the chip supply chain (TSM, MU, AMD, INTC, DELL). Its gold (GLD, $6.8M) is deeper than Solana's GLDx ($0.84M).
- Dollar yield differs by chain: syrupUSDC or jlUSDC on Solana, SGOV on Robinhood Chain, and on Base only sUSDS through the Sky PSM, which the vault's router allowlist doesn't cover yet. No launch index needs dollar yield on Base.
- If time runs short, ship the first six in the table below. That still meets the MVP (6 indexes, 2 across chains) and cuts the risk sheets from 60 assets to 44.

## The shelf

| # | Index | Chains | Role | Est. impact, $10k / $50k basket |
|---|---|---|---|---|
| 1 | The 500 | Solana, Robinhood | Broad index | 4 / 7 bps (Sol), 2 / 3 (RH) |
| 2 | The Seven | Solana, Base, Robinhood | Theme, same recipe on three chains | 7 / 19 (Sol), 2 / 5 (Base), 4 / 8 (RH) |
| 3 | Trench Survivors | Solana | Solana meme index | 6 / 12 |
| 4 | Chips & Agents | Base | Base-only | 2 / 4 |
| 5 | Sand to Server | Robinhood | Robinhood-only | 5 / 15 |
| 6 | Storm Cellar | Solana, Robinhood | Theme (protect), different recipe per chain | 3 / 6 (Sol), 3 / 5 (RH) |
| 7 | Crypto in a Suit | Solana, Robinhood | Theme | 11 / 25 (Sol), 11 / 27 (RH) |
| 8 | Home Team | Solana, Base | Chain-native theme, different recipe per chain | 3 / 6 (Sol), 1 / 1 (Base) |

Impact is my estimate: each leg's measured cost at $1k, $10k and $50k, interpolated to the leg's size and weighted. It excludes pool fees and the aggregator's spread on the first $100.

### 1. The 500

> Five hundred companies, zero opinions. The basket every other basket gets compared to.

- Voice: deadpan.
- Solana: SPYx 100%. Robinhood: SPY 100%.
- Liquidity: SPYx $4.5M on Jupiter, 3.8 bps at $10k and 6.6 at $50k (from `solana-liquidity.md`). Robinhood SPY is the deepest stock token on any of the three chains: at least $10.5M across pools, 1.8 bps at $10k, 3.2 at $50k.
- Different because: it is the plain building block. Personal baskets can point at it, and it is the benchmark line on every other index's chart. Base has no S&P 500 token, so there is no Base recipe.
- Watch: "S&P 500" is a trademark. The name avoids it; the description can say what SPYx and SPY track. Worth a quick check before launch.

### 2. The Seven

> The seven stocks doing most of your index fund's heavy lifting, minus the other 493.

- Voice: blunt.
- Same recipe on all three chains, equal weight: NVDA 14.32%, AAPL, MSFT, GOOGL, AMZN, META, TSLA 14.28% each. Tokens: the `x` tickers on Solana, the `c` tickers on Base, plain tickers on Robinhood.
- Liquidity: all seven exist on all three chains with a feed. Base is the cheapest (every leg under 9 bps at $10k). On Solana, NVDAx and TSLAx are deep but AAPLx, MSFTx, GOOGLx, METAx and AMZNx cost 26 to 33 bps at a $10k leg, so a $50k basket ($7k legs) lands near 19 bps. Robinhood sits between.
- Different because: it is the only index that is literally the same on three chains, which makes it the demo for "one name, three recipes, one tap", and shows the per-chain cost side by side. Bitwise runs a Mag 7 portfolio on Base; nobody has it across chains.

### 3. Trench Survivors (Solana)

> Every coin in here was supposed to be dead by now. Plus the casino that mints the next batch.

- Voice: degen, self-aware.
- PUMP 20%, TRUMP 15%, PENGU 15%, BONK 15%, Fartcoin 15%, WIF 10%, USELESS 10%.
- Liquidity (Jupiter pool liquidity / buy cost at a $10k leg): PUMP $41M / 5 bps, TRUMP $30M / 0, PENGU $4.4M / 0, BONK $5.9M / 28, Fartcoin $6.7M / 23, USELESS $3.4M / 14, WIF $7.2M / 41. WIF is the thin one, which is why it gets 10%.
- Different because: weights follow measured exit cost, not market cap or vibes, and it includes the launchpad's own token as "the house". Selection rule to publish with it: Solana-native, Pyth feed, over $3M of pool liquidity, over $150M market cap. MEW, POPCAT and SPX6900 pass on liquidity but sit under $60M market cap and trade about $1M a day or less; they are on the platform list for creators, not in this recipe.
- All seven are plain SPL tokens except PUMP (Token-2022). It trades 24/7, so this is the index to demo auto-follow at any hour.

### 4. Chips & Agents (Base)

> The companies building the brains, and the token of the agents already spending onchain.

- Voice: nerdy.
- NVDAc 25%, SNDKc 15%, MSFTc 15%, GOOGLc 15%, METAc 10%, AMZNc 10%, VIRTUAL 10%.
- Liquidity: the six stock tokens hold $0.9M to $2.6M each on Aerodrome and cost 3 to 6 bps at a $10k leg. VIRTUAL has $9.8M of pool liquidity and $15M daily volume, 2 bps at $10k. All seven have a Chainlink feed on Base.
- Different because: one vault holds tokenized AI equities next to the Base-native agent token. To be straight about "only on Base": the stock tickers also exist on Robinhood Chain; what exists only on Base is the mix with VIRTUAL in one vault under one price-check rule. It lines up with the Base judge's own request list (AI indexes, agents).
- Watch: VIRTUAL moves like a small-cap token, so 10% of the basket will drive more than 10% of the volatility. The risk sheet should say so.

### 5. Sand to Server (Robinhood Chain)

> One AI chip's commute: designed in California, etched in Taiwan, racked in Texas. Own every stop.

- Voice: documentary.
- NVDA 30%, TSM 20%, MU 15%, AMD 12%, INTC 10%, SNDK 8%, DELL 5%.
- Liquidity (DEX liquidity / buy cost at $1k and $10k legs): NVDA $7.4M / 0, 3. TSM $0.42M / 1, 11. MU $1.8M / 1, 7. AMD $0.65M / 9, 37. INTC $1.2M / 0, 22. SNDK $0.42M / 17, 66. DELL $0.40M / 7, 53. The thin names carry the small weights; a $50k basket is about 15 bps.
- Different because: TSM, MU, AMD, INTC and DELL exist as liquid, feed-covered tokens only on Robinhood Chain. This recipe cannot be built on Solana or Base today.
- Left out on purpose: ASML ($52k of liquidity, 61 bps at $1k) and CRWV, NBIS and ORCL (all too thin). Add ASML when its pool grows; the story wants it.

### 6. Storm Cellar

> Stocks, T-bills and gold in one room. For the weeks you'd rather not look.

- Voice: calm, a little grandparent.
- Robinhood: SPY 35%, SGOV 35%, GLD 20%, USO 5%, SLV 5%.
- Solana: SPYx 40%, syrupUSDC 35%, GLDx 25%.
- Liquidity: on Robinhood, SGOV has $2.7M and costs 4 bps at $10k; GLD $6.8M, 7 bps; USO $2.3M, 8 bps; SLV $0.44M, 9 bps at $1k. On Solana, GLDx is the limit: 11 bps at a $10k leg and 32 at $50k, so keep the Solana recipe to about $40k per basket.
- Different because: the two recipes differ by design. Robinhood has real T-bills, oil and silver; Solana has dollar-yield tokens instead. It is the default for the "protect" goal in personalization and the clearest case for the risk sheet.
- Decision for Rodrigo: the Solana dollar leg. syrupUSDC has a Pyth feed (so it can be auto-follow) but is Maple credit risk. jlUSDC redeems at face and is deeper, but I found no Pyth feed for it, so it needs an exchange-rate read from Jupiter Lend before it can sit in an auto-follow recipe.
- Watch: SGOV pays its yield through the multiplier (1.0072 today). Value it with the Chainlink feed, which already includes the multiplier.

### 7. Crypto in a Suit

> Crypto with earnings calls: the listed companies that hold it, issue it and broker it.

- Voice: wry.
- Solana: MSTRx 30%, CRCLx 30%, HOODx 20%, COINx 20%.
- Robinhood: MSTR 35%, CRCL 35%, COIN 30%. (HOOD is not among Robinhood's 195 tokens.)
- Liquidity: MSTRx $1.05M and CRCLx $2.06M are cheap (0 and 6 bps at $10k). HOODx ($0.74M) and COINx ($0.97M) cost 13 and 10 bps at $1k and 51 and 61 at $10k. On Robinhood, MSTR ($3.8M) and CRCL ($3.6M) are fine; COIN costs 24 bps at $1k and 39 at $10k. Comfortable up to about $10k per basket on either chain; the app should show the cost above that.
- Different because: Cesto's crypto baskets hold tokens; this holds the equity side of the same trade, on the chains those companies are building.
- This is the weakest on liquidity and the first to cut.

### 8. Home Team

> Back the chain you're standing on: its staked gas token and the apps that pay the bills.

- Voice: fan in the stands.
- Solana: JitoSOL 40%, JUP 20%, RAY 20%, MET 10%, KMNO 10%.
- Base: cbETH 35%, AERO 25%, cbBTC 15%, MORPHO 15%, VIRTUAL 10%.
- Liquidity: JitoSOL, JUP and cbBTC cost about nothing at $50k. RAY $18.6M, 6 bps at $10k. MET $3.2M and KMNO $2.8M cost 28 bps at a $10k leg, hence 10% each. On Base, AERO has $58M of pool liquidity, cbETH $5.3M, MORPHO $3.2M; every leg is 6 bps or less at $50k except VIRTUAL (18).
- Different because: one name, a different recipe per chain, no stock tokens at all. It trades 24/7 on both chains, so it is the second index that can demo auto-follow on a weekend. No Robinhood recipe: the chain has no native token of its own.
- Overlap with Cesto: they have three Solana ecosystem baskets. The Base half and the cross-chain framing are what's new; if the shelf feels too close to theirs, this is the second one to cut.

## How this differs from Cesto's shelf

Cesto has 21 baskets today (`backend.cesto.co/products`, pulled again this afternoon): six trackers (Pelosi, Ackman, Leopold, Ansem, Capitol Gains, Trump), two politics themes, five hedges, four Solana crypto baskets, an AI leaders basket, a momentum basket, plus GTA VI and Autistic CEOs. The voice is a pop-culture hook followed by "X in one basket: a, b, c".

What I kept: one line of copy with an attitude, and small baskets (4 to 7 names). What I avoided: tracker baskets of named people (they need a filings pipeline and age badly), the "in one basket" and "one click" phrasing, backtested return numbers, and thin commodity legs on Solana. Each index above has its own voice so the shelf doesn't read like one writer.

## Platform asset list

Tier is by measured buy cost: **A** = a leg up to $50k costs 35 bps or less, **B** = up to $10k, **C** = up to about $1k to $2k, **X** = not listed at launch. Cost is the output per dollar against a $100 quote, so it is price impact only. Negative readings (quote noise of a few bps) are shown as 0.

### Solana (cash: USDC)

Liquidity and volume from Jupiter's token API; cost from Jupiter's quote API. SPYx, QQQx, GLDx, jlUSDC and syrupUSDC costs are from `solana-liquidity.md` (same day).

| Token | Class | Mint | Jupiter liquidity | 24h vol | Buy cost bps $1k / $10k / $50k | Tier | Pyth feed id |
|---|---|---|---|---|---|---|---|
| SPYx | stock-index | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` (T22) | $4.52M | $15.6M | 2 / 4 / 7 | A | `0x2817b78438c76935…` |
| QQQx | stock-index | `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ` (T22) | $2.11M | $1.8M | 1 / 4 / 12 | A | `0x178a6f73a5aede9d…` |
| NVDAx | stock | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` (T22) | $4.58M | $42.6M | 1 / 2 / 3 | A | `0x4244d07890e4610f…` |
| TSLAx | stock | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` (T22) | $1.25M | $1.4M | 0 / 2 / 13 | A | `0x47a156470288850a…` |
| AAPLx | stock | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` (T22) | $0.53M | $2.0M | 10 / 32 / 86 | B | `0x978e6cc68a119ce0…` |
| GOOGLx | stock | `XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN` (T22) | $0.62M | $5.7M | 0 / 28 / 61 | B | `0xb911b0329028cd02…` |
| METAx | stock | `Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu` (T22) | $0.95M | $3.7M | 8 / 29 / 44 | B | `0xbf3e5871be3f80ab…` |
| MSFTx | stock | `XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX` (T22) | $0.80M | $4.0M | 7 / 32 / 88 | B | `0xbb723a70af731ab5…` |
| AMZNx | stock | `Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg` (T22) | $0.25M | $0.6M | 5 / 26 / 96 | B | `0x7148fbe6e493ff25…` |
| SPCXx | stock | `Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8` (T22) | $2.94M | $17.2M | 0 / 1 / 11 | A | `0xe8e2234a06b288fe…` |
| MSTRx | stock | `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ` (T22) | $1.05M | $1.8M | 0 / 0 / 6 | A | `0x53f95ba4e23ed15e…` |
| CRCLx | stock | `XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1` (T22) | $2.06M | $5.2M | 2 / 6 / 17 | A | `0xc13184461c0c80d9…` |
| HOODx | stock | `XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg` (T22) | $0.74M | $0.5M | 13 / 51 / 100 | C | `0xdd49a9ac6df5cbfa…` |
| COINx | stock | `Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu` (T22) | $0.97M | $0.6M | 10 / 61 / 129 | C | `0x641435d5dffb5311…` |
| PLTRx | stock | `XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4` (T22) | $0.29M | $0.4M | 21 / 85 / 211 | C | none found |
| GLDx | gold | `Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re` (T22) | $0.84M | $3.0M | 2 / 11 / 32 | A | `0xe7d1138d00833686…` |
| jlUSDC | dollar-yield | `9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D` (SPL) | $474.84M | $195.7M | 0 / 0 / 0 | A | none found |
| syrupUSDC | dollar-yield | `AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj` (SPL) | $11.22M | $3.0M | 1 / 2 / 2 | A | `0xe616297dab48626e…` |
| SOL | crypto-major | `So11111111111111111111111111111111111111112` (SPL) | $971.47M | $3527.2M | 0 / 0 / 0 | A | `0xef0d8b6fda2ceba4…` |
| JitoSOL | crypto-major | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` (SPL) | $1225.43M | $7.7M | 0 / 1 / 0 | A | `0x67be9f519b95cf24…` |
| cbBTC | crypto-major | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` (SPL) | $31.03M | $75.4M | 2 / 1 / 0 | A | `0x2817d7bfe5c64b8e…` |
| JUP | solana-native | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` (SPL) | $5.90M | $12.0M | 0 / 0 / 0 | A | `0x0a0408d619e9380a…` |
| RAY | solana-native | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` (SPL) | $18.57M | $12.2M | 2 / 6 / 21 | A | `0x91568baa8beb53db…` |
| PUMP | solana-native | `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` (T22) | $41.22M | $62.6M | 4 / 4 / 13 | A | `0x7a01fca212788bba…` |
| MET | solana-native | `METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL` (SPL) | $3.24M | $3.7M | 15 / 28 / 82 | B | `0x0292e0f405bcd4a4…` |
| KMNO | solana-native | `KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS` (SPL) | $2.77M | $5.3M | 3 / 28 / 148 | B | `0xb17e5bc5de742a8a…` |
| JTO | solana-native | `jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` (SPL) | $0.44M | $0.7M | 17 / 49 / 163 | C | `0xb43660a5f790c693…` |
| PYTH | solana-native | `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3` (SPL) | $0.45M | $0.7M | 24 / 62 / 179 | C | `0x0bbf28e9a841a1cc…` |
| TRUMP | meme | `6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN` (SPL) | $30.06M | $16.9M | 1 / 0 / 11 | A | `0x879551021853eec7…` |
| PENGU | meme | `2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv` (SPL) | $4.39M | $12.5M | 0 / 0 / 22 | A | `0xbed3097008b9b5e3…` |
| BONK | meme | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (SPL) | $5.90M | $2.8M | 8 / 28 / 56 | B | `0x72b021217ca3fe68…` |
| Fartcoin | meme | `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` (SPL) | $6.67M | $3.5M | 8 / 23 / 36 | B | `0x58cd29ef0e714c5a…` |
| USELESS | meme | `Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk` (SPL) | $3.40M | $7.1M | 4 / 14 / 34 | A | `0xf4b55102bfc9ea1b…` |
| WIF | meme | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` (SPL) | $7.19M | $1.2M | 16 / 41 / 150 | C | `0x4ca4beeca86f0d16…` |
| MEW | meme | `MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5` (SPL) | $10.60M | $1.0M | 6 / 25 / 102 | B | `0x514aed52ca529417…` |
| POPCAT | meme | `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` (SPL) | $4.73M | $0.4M | 19 / 56 / 224 | C | `0xb9312a7ee50e189e…` |
| SPX | meme | `J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr` (SPL) | $3.02M | $0.9M | 16 / 51 / 236 | C | `0x8414cfadf82f6bed…` |
- xStocks and PUMP are Token-2022; everything else is classic SPL.
- Pyth lists a feed for every token above except jlUSDC and PLTRx (checked against `hermes.pyth.network/v2/price_feeds`, 1,881 feeds). Most show `min_channel: fixed_rate@200ms`, which looks like the paid Pyth Pro channel; whether the program can read them onchain without a key is the open test in the technical design. [unverified]
- Not listed: Ondo stock tokens and USDY (thin, per the earlier note), PreStocks pre-IPO tokens (the Anthropic and OpenAI transfer dispute), DRIFT ($0.02M of liquidity), XAUt0 and other gold tokens (GLDx is deeper), sUSDe (no liquidity).

### Base (cash: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)

Liquidity from DexScreener (sum of pools against USDC, WETH or cbBTC); cost from KyberSwap's public aggregator API. Stock tokens have 8 decimals.

| Token | Class | Address | DEX liquidity | 24h vol | Buy cost bps $1k / $10k / $50k | Tier | Chainlink feed |
|---|---|---|---|---|---|---|---|
| NVDAc | stock | `0xb20000000000000000000078ee7ce2fE4908108C` | $2.60M | $12.2M | 4 / 6 / 14 | A | `0x04689a41629776563E6822F76f2e57D148d28513` |
| AAPLc | stock | `0xb200000000000000000000C2e324d24d7eEcd1fb` | $1.57M | $9.5M | 1 / 4 / 12 | A | `0x787f13dEa48Db0897CbCDD985de77809D837F988` |
| METAc | stock | `0xb2000000000000000000008bC8786B856E61707C` | $1.95M | $12.2M | 1 / 4 / 9 | A | `0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D` |
| GOOGLc | stock | `0xb2000000000000000000002D0BA3164cc74f58B7` | $1.91M | $19.2M | 0 / 3 / 14 | A | `0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2` |
| AMZNc | stock | `0xb200000000000000000000d9192b6B456483C2E8` | $2.00M | $9.1M | 1 / 5 / 12 | A | `0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295` |
| MSFTc | stock | `0xB200000000000000000000Ab99cFa739E253872B` | $0.88M | $5.3M | 0 / 5 / 20 | A | `0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c` |
| MSTRc | stock | `0xb2000000000000000000004884b426556b92883d` | $1.52M | $13.1M | 2 / 7 / 28 | A | `0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a` |
| SNDKc | stock | `0xb200000000000000000000397293Cb8cda9a10c5` | $1.03M | $12.0M | 0 / 3 / 24 | A | `0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA` |
| SPCXc | stock | `0xb2000000000000000000007b9fcbd005511aCBd5` | $1.16M | $5.0M | 3 / 8 / 20 | A | `0x6A634B235903C4ad6376892180d6fF8612e3Fa68` |
| TSLAc | stock | `0xb2000000000000000000001e800a7f5189430cD0` | $0.85M | $5.4M | 1 / 8 / 27 | A | `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4` |
| AERO | base-native | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | $57.97M | $24.6M | 1 / 2 / 6 | A | `0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0` |
| cbBTC | crypto-major | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | $102.85M | $239.9M | 5 / 0 / 0 | A | `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` |
| cbETH | crypto-major | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | $5.31M | $8.8M | 0 / 0 / 1 | A | `0xd7818272B9e248357d13057AAb0B417aF31E817d` |
| VIRTUAL | base-native | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | $9.76M | $15.3M | 0 / 2 / 18 | A | `0xEaf310161c9eF7c813A14f8FEF6Fb271434019F7` |
| MORPHO | base-native | `0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842` | $3.18M | $1.6M | 0 / 2 / 6 | A | `0xe95e258bb6615d47515Fc849f8542dA651f12bF6` |
- Chainlink's Base directory also lists "Coinbase COIN", "Coinbase CRCL" and "Coinbase INTC" equity feeds. I found no matching tokens on DexScreener, so these look like the next listings. [inference]
- Dollar yield on Base: sUSDS routes through the Sky PSM at about 0 bps up to $50k (KyberSwap route `sky-psm`), and Chainlink has `sUSDS / USDS Exchange Rate` and `USDS / USD` feeds. It has no DEX pool, so the vault's router allowlist (Uniswap Universal Router) can't reach it. Listing it means allowlisting the PSM or an aggregator router. sUSDe on Base has no usable liquidity. syrupUSDC has an exchange-rate feed on Base but I found no pool. [unverified beyond DexScreener and Kyber]
- Base memes (BRETT $2.6M, TOSHI $1.5M, DEGEN $1.1M of liquidity) trade $60k to $270k a day and only DEGEN has a feed. No Base meme index at launch.

### Robinhood Chain (cash: USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`)

These are the 36 Stock Tokens with a Chainlink feed in `reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` (58 feeds in total: 35 named "Robinhood X", plus GLD, plus 22 crypto, stablecoin and exchange-rate feeds). Token addresses from `api.robinhood.com/rhj/assets`. Liquidity from DexScreener, which returns at most 30 pools per token, so the figures for the largest names are a floor. Cost from KyberSwap's aggregator API on chain `robinhood`. Tokens have 18 decimals.

| Token | Address | Chainlink feed | DEX liquidity | 24h vol | Buy cost bps $1k / $10k / $50k | Tier |
|---|---|---|---|---|---|---|
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | $10.50M | $21.05M | 0 / 2 / 3 | A |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | $7.40M | $37.37M | 0 / 3 / 6 | A |
| GLD | `0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e` | `0x470A51258068043bd43dC0a56245625C9fE86eB0` | $6.78M | $3.59M | 2 / 7 / 18 | A |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` | $6.04M | $6.85M | 5 / 0 / 2 | A |
| SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | `0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb` | $5.46M | $11.32M | 4 / 7 / 7 | A |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | `0x396118bdFB181e6240E74D243F266B061c0edc3D` | $3.85M | $2.76M | 1 / 5 / 49 | B |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | `0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a` | $3.55M | $2.42M | 0 / 4 / 36 | B |
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | `0xa0DF4ee0fFf975306345875E3548Fcc519577A11` | $2.67M | $0.76M | 0 / 4 / 8 | A |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `0xF6f373a037c30F0e5010d854385cA89185AE638b` | $2.49M | $11.53M | 4 / 9 / 19 | A |
| USO | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | `0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c` | $2.34M | $3.01M | 5 / 8 / 18 | A |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `0x4A1166a659A55625345e9515b32adECea5547C38` | $2.13M | $1.13M | 0 / 5 / 21 | A |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | $1.94M | $4.20M | 5 / 10 / 23 | A |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` | $1.93M | $0.55M | 24 / 39 / 79 | C |
| MU | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | `0x425EEFdCf05ed6526C3cE61Af99429A228a6d596` | $1.76M | $2.25M | 1 / 7 / 47 | B |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` | $1.70M | $2.90M | 1 / 3 / 10 | A |
| INTC | `0xc72b96e0E48ecd4DC75E1e45396e26300BC39681` | `0x3f390C5C24628Ac7C489515402235FeAD71D1913` | $1.23M | $2.17M | 0 / 22 / 81 | B |
| GME | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | `0x27C71df6A64fB476468EdF256CF72c038baB5B67` | $1.05M | $4.78M | 4 / 20 / 73 | B |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | $1.03M | $0.60M | 1 / 11 / 37 | B |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` | $1.02M | $0.48M | 3 / 22 / 54 | B |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | $0.86M | $0.76M | 8 / 17 / 53 | B |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | $0.65M | $0.36M | 9 / 37 / 106 | C |
| SLV | `0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f` | `0x209b73908e92Ae021826eD79609845451Ecba2ce` | $0.44M | $0.11M | 9 / 29 / 82 | B |
| SNDK | `0xB90A19fF0Af67f7779afF50A882A9CfF42446400` | `0xfb133Fa4B7b385802B693a293606682Df47109A3` | $0.42M | $0.27M | 17 / 66 / 167 | C |
| TSM | `0x58FfE4a942d3885bAa22D7520691F611EF09e7AA` | `0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F` | $0.42M | $0.05M | 1 / 11 / 56 | B |
| DELL | `0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd` | `0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b` | $0.40M | $0.07M | 7 / 53 / 152 | C |
| BABA | `0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4` | `0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984` | $0.17M | $0.07M | 11 / 50 / – | C |
| ORCL | `0xb0992820E760d836549ba69BC7598b4af75dEE03` | `0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844` | $0.14M | $0.01M | 60 / 161 / – | X |
| NBIS | `0x9D9c6684F596F66a64C030B93A886D51Fd4D7931` | `0xE1D87B116Ba0fe898998f1D140339D1fA1E09705` | $0.12M | $0.01M | 108 / 308 / – | X |
| USAR | `0xd917B029C761D264c6A312BBbcDA868658eF86a6` | `0xA994d3684e8400A6c8078226925779FdeE682DD9` | $0.11M | $0.13M | 36 / 202 / – | X |
| ASML | `0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA` | `0xB4106147E8cce40b7d46124090d373A71b70f87D` | $0.05M | $0.01M | 61 / 436 / – | X |
| CRWV | `0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3` | `0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C` | $0.05M | $0.01M | 86 / 213 / – | X |
| RKLB | `0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2` | `0x045477BF65Aef6f4F2386ad0164579e48381CC74` | $0.02M | $0.00M | 197 / 2856 / – | X |
| IONQ | `0x558378E000D634A36593E338eBacdd6207640EfE` | `0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb` | $0.01M | $0.00M | 550 / 5117 / – | X |
| RGTI | `0x284358abc07F9359f19f4b5b4aC91901Be2597Ba` | `0x2A045cF1C49c61c166C036d2f06FA2D2d984f765` | $0.01M | $0.00M | 523 / 5402 / – | X |
| EWY | `0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc` | `0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1` | $0.01M | $0.00M | 122 / 408 / – | X |
| CLSK | `0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3` | `0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF` | $0.00M | $0.00M | 1320 / 6169 / – | X |
- 26 are usable (11 A, 10 B, 5 C). The 10 marked X can still be bought with an owner signature at small size, but shouldn't be in a launch index.
- Spot checks of `latestRoundData()` on the public RPC at 13:57 UTC: USO 146.95 (13 minutes old), TSM 456.34 (27 minutes), GLD 382.03 (10 hours), SGOV 100.93 (14 hours). So a feed can be many hours old inside a live session, as the EVM feasibility note found.
- The other 159 tokens have no feed and are owner-signed only. I didn't measure their liquidity; AVGO has $0.2M and VTI $0.06M, which suggests most are thin.
- `syrupUSDG / USDG Exchange Rate` has a feed; I didn't check the token's liquidity. [unverified]

## Risk sheets this shelf needs

60 asset sheets for all 8 indexes (Solana 26, Base 13, Robinhood 21), or 44 for the first six. Most share three issuer templates: xStocks (13 tokens), Coinbase stock tokens (8) and Robinhood Stock Tokens (21). Writing the issuer template once and a short per-asset delta keeps this to a day of Rodrigo's time.

## For agents

The relayed request was to make the product easy for AI agents to use and integrate. For the shelf, that means:

- **One keyless file.** Serve the shelf as static JSON (`/shelf.json`): stable slug, name, copy, and per chain the recipe in basis points, token addresses, decimals, feed ids, tier and the size where cost passes 25 bps. `launch-shelf.seed.json` is that file in draft. Add an `llms.txt` that points at it.
- **A JSON twin for every page.** `/indexes/{slug}.json` returns the recipe, version, `effectiveAt`, the risk roll-up and the flags. `/quote?slug=&chain=&amount=` returns per-leg expected output and cost. An agent should never need to scrape.
- **Unsigned transactions out, signatures in.** The chain adapter already returns `Tx[]`. Expose `buildCreateVault`, `buildDeposit`, `buildOwnerRebalance`, `buildWithdrawInKind` and `buildPublishRecipe` over HTTP so an agent signs with its own wallet. The app never holds an agent's key.
- **A small MCP server over the same endpoints:** `list_indexes`, `get_index`, `quote_basket`, `build_buy`, `get_portfolio`, `build_rebalance`, `publish_index`. Cesto's agent skill can browse, post ideas and backtest; it cannot publish an investable basket. Here an agent can publish an index that people follow, and the vault rules bound what any keeper or agent can do with a follower's money.
- **Errors an agent can act on:** typed reasons such as `MARKET_CLOSED`, `FEED_STALE`, `SIZE_ABOVE_TIER`, `ASSET_NOT_IN_RECIPE`, `REGION_BLOCKED`, each with the next allowed time or size.
- The US block and per-asset eligibility apply to API and MCP callers too. Nothing onchain enforces them.

## Not checked

- Sell-side cost on Base and Robinhood Chain (only buys were quoted), and all costs outside US market hours.
- Whether the vault can execute the routes KyberSwap found. The quotes may cross pools the allowlisted Uniswap router doesn't reach (Aerodrome on Base in particular, where nearly all stock liquidity sits). The EVM spike should quote through the router the vault will actually use.
- Onchain Pyth availability for the Solana feeds (see above).
- Freeze and mint authorities on the meme tokens.
- Eligibility of a wallet in Brazil for each issuer's tokens.

## Sources

- Jupiter token and quote APIs: `lite-api.jup.ag/tokens/v2/search`, `/tokens/v2/toporganicscore/24h`, `/swap/v1/quote`
- DexScreener: `api.dexscreener.com/token-pairs/v1/{base|robinhood}/{address}`, `/latest/dex/search`
- KyberSwap aggregator: `aggregator-api.kyberswap.com/{base|robinhood}/api/v1/routes`
- Chainlink reference directory: https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json , https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json
- Robinhood asset registry: https://api.robinhood.com/rhj/assets (cached copy from Sep 30)
- Robinhood Chain RPC (read-only `eth_call`): https://rpc.mainnet.chain.robinhood.com
- Pyth: https://hermes.pyth.network/v2/price_feeds
- Cesto: https://backend.cesto.co/products ; an internal team note
- Earlier notes: `research/solana-liquidity.md`, `research/vaults/evm-feasibility.md`, internal team notes
