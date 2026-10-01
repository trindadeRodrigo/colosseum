# Solana tokens for baskets: liquidity check

Measured Oct 1, 2026, about 11:50–12:00 UTC (US pre-market), from Jupiter's public quote API. Cost is buy / sell in basis points against a $100 quote.

| Token | Market cap / DEX liquidity | $1k | $10k | $50k | $150k |
|---|---|---|---|---|---|
| SPYx (S&P 500) | $73.3M / $4.65M | 1.7 / 0.3 | 3.8 / 0.3 | 6.6 / 5.7 | 10.2 / 14.4 |
| QQQx (Nasdaq-100) | $63.1M / $2.12M | 1.2 / 0.0 | 3.7 / 1.5 | 11.6 / 13.6 | 53 / 68 |
| GLDx (gold) | $44.5M / $0.88M | 1.6 / ~0 | 10.7 / 6.1 | 31.7 / 23.9 | 89 / 82 |
| SPYon (Ondo) | $1.18M / $8.9k | 12 / 7 | unusable | unusable | unusable |

NVDAx ($74M cap, $4.5M liquidity) and TSLAx ($82M, $1.2M) exist but were not quoted.

Dollar-yield tokens:

| Token | Yield | Cost to exit |
|---|---|---|
| jlUSDC (Jupiter Lend) | 4.14% + 0.38% rewards | None; redeems at face value. $56.4M of $474M withdrawable now |
| syrupUSDC (Maple) | about 5.2% | 0.1–2.1 bps up to $150k, DEX only |
| USDY (Ondo T-bills) | 3.60% | 32–43 bps, one pool; about a month of yield |

What it means for the app:

- Baskets of $1k–$50k work on Solana with SPYx, QQQx, NVDAx and jlUSDC or syrupUSDC. Gold only up to about $10k per basket. Ondo's stock tokens and USDY are poor fits.
- xStocks trade every weekend hour. Over six calm weekends prices stayed within about 1–1.6% of Friday's close. Single pools printed bad prices in thin hours (one −12% hour, one −27% wick), so every swap needs a price check against a reference and a slippage cap.
- xStocks are Token-2022 tokens whose issuer can pause or freeze them, and balances carry a multiplier for dividends (SPYx 1.005715). Value holdings in raw units and pause around multiplier changes.
- Not for US persons. Buying on a DEX is not gated at the token level.
- Untested: swapping these tokens from a Swig smart wallet. Run a $10 mainnet swap on day 1.
