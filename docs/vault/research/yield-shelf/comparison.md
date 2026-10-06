# The extended shelf against the launch shelf

Oct 6, 2026. What the fixed-income tokens of the extended shelf change in the plans the engine makes, per chain. From `docs/vault/PROMPT-YIELD-SHELF.md`, part (a). The goals are those of `try/prompts/examples.md` and the six of `try/prompts/yield-shelf.md`, every one run on the chain of its section, on both shelves, with the rules parser:

```sh
pnpm -s plan:compare try/prompts/examples.md try/prompts/yield-shelf.md --chain <chain> --now 2026-10-06T12:00:00Z
```

Every figure below is **MOCK**. The shelves, the yields and the exit capacities are fixtures: the launch shelf's are written by hand, the extended shelf's yields are figures claimed on a date in the research notes (`solana.md`, `robinhood.md`), and no exit of an added token is measured, so each takes the ceiling of its tier, a labelled fallback (gate `EXIT-SOURCE`). Nothing here is a reading of a market, a forecast or a promise of a return. The same command gives the same tables.

## Solana

Written on `shelf/solana-yield`.

## Robinhood Chain

Made on `shelf/robinhood-yield` at the rows of `fixtures/shelves/robinhood-yield.json` as of 2026-10-06: three tokens a plan may hold (steakUSDG, syrupUSDG, spUSDG). All 14 goals were run on Robinhood Chain, those written for Solana included, so every plan is in USDG.

### What changed, in short

- **Lines.** Every one of the 13 goals that has a plan changes. The launch shelf has one dollar-yield token on this chain (SGOV, capped at 40% of a plan); the extended shelf has four, and a plan holds SGOV with two or three of the new ones.
- **Cash.** The plain plan's cash share falls from 43.80% to 17.56%, the mean of the 13 goals, and falls in each. On the grid of 36 goals the mean over the 39 candidates both shelves show falls from 47.69% to 20.06%, and rises in none (`extended-shelf.robinhood.test.ts`). It does not fall further because steakUSDG and spUSDG take the thinnest tier, $1,500 a line: a $50,000 plan holds 3% in each and still leaves 29% in cash.
- **Candidates shown.** On the launch shelf most income and protect goals showed Cover alone: with one token to hold, Spread and Carry were the same plan or a worse one. On the extended shelf seven goals show all three, and two more show Cover and Carry.
- **Scorecard.** Observed carry rises in every income and protect plan (income in USDG, Cover: 112 to 157 bps; Carry reaches 186). A plan holds 5 issuers where it held 2. The credit and basis share goes from nothing to the person's limit (12.5% on Cover, 25% on Spread and Carry), all of it syrupUSDG. No exit is measured on this chain's yield tokens on either shelf, so the measured share stays at zero.
- **Income verdicts.** Every income goal stays short, by less: income in USDG, short by $103.34 a month on the launch shelf's one candidate, is short by $84.34 on Cover and $72.36 on Carry; low-risk income goes from $175.34 to $129.99 at best.

### Three things the added tokens bring out, for Rodrigo

None is changed here.

1. **The tier of the two vaults decides most of the result.** steakUSDG and spUSDG redeem at par today but have no market route, so each line is held to $1,500 (`robinhood.md`, section 2). Tiered by what they can redeem, the cash share of these plans would fall to near nothing. It is the first call for Rodrigo on this chain.
2. **All the credit a plan takes on this chain is one token.** syrupUSDG is the only credit or basis token listed, so a plan's whole credit budget sits with one issuer.
3. **Spread holds no gold in a plan to protect.** Spread caps one issuer at 30%, and on this chain SGOV and the gold token share an issuer, so SGOV at 30% leaves gold no room. The launch shelf has the same two tokens; it shows now because Spread is shown.

### The goals, one by one

Chain: robinhood. Plans made at 2026-10-06T12:00:00.000Z. Every figure is MOCK: it comes from the engine's fixtures, and none is live. "Carry" is the plan's observed carry in basis points after haircut, from the fixture yields; "Measured exit" is the share of the plan whose exit capacity is measured (the rest takes its tier ceiling, a labelled fallback).

#### Income for retirement, monthly

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, carry; not shown: spread (Spread is not shown: Carry is as good on every line of the comparison, and better on one.)
- Lines changed in: cover, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, USDG 60.00% | 60.00% | 112 | 2 | 60.00% | 0.00% | 0.00% | 24 | short by $488.00 a month |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 1.25%, steakUSDG 1.25%, USDG 45.00% | 45.00% | 147 | 5 | 45.00% | 12.50% | 0.00% | 24 | short by $452.23 a month |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 1.25%, steakUSDG 1.25%, USDG 32.50% | 32.50% | 176 | 5 | 40.00% | 25.00% | 0.00% | 24 | short by $423.48 a month |

#### Proteger minhas economias

- Launch shelf: cover; not shown: spread (Diversificação não aparece: Cobertura é tão bom em todas as linhas da comparação, e melhor em uma.); carry (Rendimento não aparece: ele guarda o mesmo que Cobertura.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, GLD 10.00%, USDG 50.00% | 50.00% | 112 | 2 | 50.00% | 0.00% | 0.00% |  |  |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 5.00%, steakUSDG 5.00%, GLD 10.00%, USDG 27.50% | 27.50% | 168 | 5 | 50.00% | 12.50% | 0.00% |  |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 5.00%, steakUSDG 5.00%, USDG 35.00% | 35.00% | 169 | 5 | 35.00% | 25.00% | 0.00% |  |  |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 5.00%, steakUSDG 5.00%, GLD 10.00%, USDG 15.00% | 15.00% | 197 | 5 | 50.00% | 25.00% | 0.00% |  |  |

#### Grow, half in AI

- Launch shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Lines changed in: cover, spread, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SPY 47.50%, SGOV 40.00%, USDG 12.50% | 12.50% | 112 | 2 | 87.50% | 0.00% | 0.00% |  |  |
| cover | extended | SPY 47.50%, SGOV 22.50%, spUSDG 15.00%, steakUSDG 15.00% | 0.00% | 147 | 3 | 70.00% | 0.00% | 0.00% |  |  |
| spread | launch | SPY 47.50%, SGOV 30.00%, USDG 22.50% | 22.50% | 84 | 2 | 77.50% | 0.00% | 0.00% |  |  |
| spread | extended | SPY 47.50%, SGOV 13.13%, spUSDG 13.13%, steakUSDG 13.12%, syrupUSDG 13.12% | 0.00% | 140 | 4 | 60.63% | 13.12% | 0.00% |  |  |

#### Faculdade da minha filha, em reais

- Launch shelf: cover; not shown: spread (Diversificação não aparece: Cobertura é tão bom em todas as linhas da comparação, e melhor em uma.); carry (Rendimento não aparece: ele guarda o mesmo que Cobertura.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, GLD 10.00%, USDG 50.00% | 50.00% | 112 | 2 | 50.00% | 0.00% | 0.00% | 2 |  |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 10.00%, steakUSDG 10.00%, GLD 10.00%, USDG 17.50% | 17.50% | 196 | 5 | 50.00% | 12.50% | 0.00% | 0 |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 10.00%, steakUSDG 10.00%, USDG 25.00% | 25.00% | 197 | 5 | 30.00% | 25.00% | 0.00% | 1 |  |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 10.00%, steakUSDG 10.00%, GLD 10.00%, USDG 5.00% | 5.00% | 225 | 5 | 50.00% | 25.00% | 0.00% | 0 |  |

#### No stocks, no credit

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Lines changed in: cover, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, GLD 5.00%, USDG 55.00% | 55.00% | 112 | 2 | 55.00% | 0.00% | 0.00% |  |  |
| cover | extended | SGOV 40.00%, spUSDG 6.00%, steakUSDG 6.00%, GLD 5.00%, USDG 43.00% | 43.00% | 145 | 4 | 45.00% | 0.00% | 0.00% |  |  |

#### Já tenho Nvidia, The Seven

- Launch shelf: cover, spread; not shown: carry (Rendimento não aparece: ele guarda o mesmo que Cobertura.)
- Extended shelf: cover, spread; not shown: carry (Rendimento não aparece: ele guarda o mesmo que Cobertura.)
- Lines changed in: cover, spread, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | AAPL 7.91%, AMZN 7.90%, GOOGL 7.90%, META 7.90%, MSFT 7.90%, TSLA 7.90%, SGOV 40.00%, GLD 5.65%, USDG 6.94% | 6.94% | 112 | 2 | 93.06% | 0.00% | 0.00% |  |  |
| cover | extended | AAPL 12.91%, AMZN 12.90%, GOOGL 12.90%, META 12.90%, SGOV 14.25%, steakUSDG 14.25%, spUSDG 14.24%, GLD 5.65% | 0.00% | 119 | 3 | 71.50% | 0.00% | 0.00% |  |  |
| spread | launch | AAPL 7.91%, AMZN 7.90%, GOOGL 7.90%, META 7.90%, MSFT 7.90%, TSLA 7.90%, SGOV 24.35%, GLD 5.65%, USDG 22.59% | 22.59% | 68 | 2 | 77.41% | 0.00% | 0.00% |  |  |
| spread | extended | AAPL 12.90%, AMZN 12.90%, GOOGL 12.90%, SGOV 13.92%, spUSDG 13.91%, steakUSDG 13.91%, syrupUSDG 13.91%, GLD 5.65% | 0.00% | 149 | 4 | 58.27% | 13.91% | 0.00% |  |  |

#### Protect on Robinhood Chain

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, GLD 10.00%, USDG 50.00% | 50.00% | 112 | 2 | 50.00% | 0.00% | 0.00% |  |  |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 3.75%, steakUSDG 3.75%, GLD 10.00%, USDG 30.00% | 30.00% | 161 | 5 | 50.00% | 12.50% | 0.00% |  |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 3.75%, steakUSDG 3.75%, USDG 37.50% | 37.50% | 162 | 5 | 37.50% | 25.00% | 0.00% |  |  |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 3.75%, steakUSDG 3.75%, GLD 10.00%, USDG 17.50% | 17.50% | 190 | 5 | 50.00% | 25.00% | 0.00% |  |  |

#### Something vague

- Launch shelf: 5 question(s) open: goal, amount, horizon, risk, country
- Extended shelf: 5 question(s) open: goal, amount, horizon, risk, country

#### Low-risk income

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, carry; not shown: spread (Spread is not shown: Carry is as good on every line of the comparison, and better on one.)
- Lines changed in: cover, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, USDG 60.00% | 60.00% | 112 | 2 | 60.00% | 0.00% | 0.00% | 36 | short by $175.34 a month |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 1.87%, steakUSDG 1.87%, USDG 43.76% | 43.76% | 151 | 5 | 43.75% | 12.50% | 0.00% | 36 | short by $149.16 a month |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 1.87%, steakUSDG 1.87%, USDG 31.26% | 31.26% | 180 | 5 | 40.00% | 25.00% | 0.00% | 36 | short by $129.99 a month |

#### No lending

- Launch shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover; not shown: spread (Spread is not shown: it differs from Cover by 5% of the plan, under 10%, so the two are one choice.); carry (Carry is not shown: it holds the same as Cover.)
- Lines changed in: cover, spread, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SPY 50.00%, SGOV 40.00%, GLD 5.00%, USDG 5.00% | 5.00% | 112 | 2 | 95.00% | 0.00% | 0.00% |  |  |
| cover | extended | SPY 57.50%, SGOV 30.00%, spUSDG 3.75%, steakUSDG 3.75%, GLD 5.00% | 0.00% | 105 | 3 | 92.50% | 0.00% | 0.00% |  |  |
| spread | launch | SPY 50.00%, SGOV 25.00%, GLD 5.00%, USDG 20.00% | 20.00% | 70 | 2 | 80.00% | 0.00% | 0.00% |  |  |
| spread | extended | not shown | | | | | | | | |

#### Protect

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, GLD 10.00%, USDG 50.00% | 50.00% | 112 | 2 | 50.00% | 0.00% | 0.00% |  |  |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 2.50%, steakUSDG 2.50%, GLD 10.00%, USDG 32.50% | 32.50% | 154 | 5 | 50.00% | 12.50% | 0.00% |  |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 2.50%, steakUSDG 2.50%, USDG 40.00% | 40.00% | 155 | 5 | 40.00% | 25.00% | 0.00% |  |  |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 2.50%, steakUSDG 2.50%, GLD 10.00%, USDG 20.00% | 20.00% | 183 | 5 | 50.00% | 25.00% | 0.00% |  |  |

#### Em reais, com saques em reais

- Launch shelf: cover; not shown: spread (Diversificação não aparece: Cobertura é tão bom em todas as linhas da comparação, e melhor em uma.); carry (Rendimento não aparece: ele guarda o mesmo que Cobertura.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, GLD 10.00%, USDG 50.00% | 50.00% | 112 | 2 | 50.00% | 0.00% | 0.00% | 24 |  |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 7.50%, steakUSDG 7.50%, GLD 10.00%, USDG 22.50% | 22.50% | 182 | 5 | 50.00% | 12.50% | 0.00% | 16 |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 7.50%, steakUSDG 7.50%, USDG 30.00% | 30.00% | 183 | 5 | 30.00% | 25.00% | 0.00% | 21 |  |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 7.50%, steakUSDG 7.50%, GLD 10.00%, USDG 10.00% | 10.00% | 211 | 5 | 50.00% | 25.00% | 0.00% | 7 |  |

#### Income in USDG on Robinhood Chain

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, USDG 60.00% | 60.00% | 112 | 2 | 60.00% | 0.00% | 0.00% | 24 | short by $103.34 a month |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 3.00%, steakUSDG 3.00%, USDG 41.50% | 41.50% | 157 | 5 | 41.50% | 12.50% | 0.00% | 24 | short by $84.34 a month |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 3.00%, steakUSDG 3.00%, USDG 39.00% | 39.00% | 158 | 5 | 39.00% | 25.00% | 0.00% | 24 | short by $84.02 a month |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 3.00%, steakUSDG 3.00%, USDG 29.00% | 29.00% | 186 | 5 | 40.00% | 25.00% | 0.00% | 24 | short by $72.36 a month |

#### Income, living in Canada

- Launch shelf: cover; not shown: spread (Spread is not shown: Cover is as good on every line of the comparison, and better on one.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SGOV 40.00%, USDG 60.00% | 60.00% | 112 | 2 | 60.00% | 0.00% | 0.00% |  | short by $52.00 a month |
| cover | extended | SGOV 40.00%, syrupUSDG 12.50%, spUSDG 5.00%, steakUSDG 5.00%, USDG 37.50% | 37.50% | 168 | 5 | 40.00% | 12.50% | 0.00% |  | short by $37.80 a month |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SGOV 30.00%, syrupUSDG 25.00%, spUSDG 5.00%, steakUSDG 5.00%, USDG 35.00% | 35.00% | 169 | 5 | 35.00% | 25.00% | 0.00% |  | short by $37.61 a month |
| carry | launch | not shown | | | | | | | | |
| carry | extended | SGOV 40.00%, syrupUSDG 25.00%, spUSDG 5.00%, steakUSDG 5.00%, USDG 25.00% | 25.00% | 197 | 5 | 40.00% | 25.00% | 0.00% |  | short by $30.61 a month |

#### Cash share of the plain plan, by goal

| Goal | Launch | Extended |
|---|---|---|
| Income for retirement, monthly | 60.00% | 32.50% |
| Proteger minhas economias | 50.00% | 15.00% |
| Grow, half in AI | 12.50% | 0.00% |
| Faculdade da minha filha, em reais | 50.00% | 5.00% |
| No stocks, no credit | 55.00% | 43.00% |
| Já tenho Nvidia, The Seven | 6.94% | 0.00% |
| Protect on Robinhood Chain | 50.00% | 17.50% |
| Low-risk income | 60.00% | 31.26% |
| No lending | 5.00% | 0.00% |
| Protect | 50.00% | 20.00% |
| Em reais, com saques em reais | 50.00% | 10.00% |
| Income in USDG on Robinhood Chain | 60.00% | 29.00% |
| Income, living in Canada | 60.00% | 25.00% |
| Mean of 13 goals | 43.80% | 17.56% |

Goals with a plan on either shelf: 13 of 14. Of those, no line changed in 0.
