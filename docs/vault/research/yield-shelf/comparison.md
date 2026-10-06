# The extended shelf against the launch shelf

Oct 6, 2026. What the fixed-income tokens of the extended shelf change in the plans the engine makes, per chain. From `docs/vault/PROMPT-YIELD-SHELF.md`, part (a). The goals are those of `try/prompts/examples.md` and the six of `try/prompts/yield-shelf.md`, every one run on the chain of its section, on both shelves, with the rules parser:

```sh
pnpm -s plan:compare try/prompts/examples.md try/prompts/yield-shelf.md --chain <chain> --now 2026-10-06T12:00:00Z
```

Every figure below is **MOCK**. The shelves, the yields and the exit capacities are fixtures: the launch shelf's are written by hand, the extended shelf's yields are figures claimed on a date in the research notes (`solana.md`, `robinhood.md`), and no exit of an added token is measured, so each takes the ceiling of its tier, a labelled fallback (gate `EXIT-SOURCE`). Nothing here is a reading of a market, a forecast or a promise of a return. The same command gives the same tables.

## Solana

Made on `shelf/solana-yield` at the rows of `fixtures/shelves/solana-yield.json` as of 2026-10-06: seven tokens a plan may hold (USDY, wYLDS, kUSDC, jlJupUSD, PST, PRIME, AUTO). All 14 goals were run on Solana, the two written for Robinhood Chain included.

### What changed, in short

- **Lines.** Every one of the 13 goals that has a plan changes, on every candidate. The launch shelf has two dollar-yield tokens on Solana (jlUSDC, syrupUSDC); the extended shelf has nine, and a plan now holds four to eight of them.
- **Cash.** The plain plan's cash share falls from 13.63% to 1.19%, the mean of the 13 goals; it falls or stays in each. On the grid of 36 goals (`shelfGrid`, each goal at each risk and four sizes) the mean over the 69 candidates both shelves show falls from 25.38% to 3.12% (`extended-shelf.solana.test.ts`). What was left in cash for want of a token under its caps is now in rate legs (USDY, wYLDS) and a second deposit token (jlJupUSD).
- **Candidates shown.** Spread appears in four goals where the launch shelf did not show it (it was the same as Cover, or within 10% of it): with more issuers to spread over it is a choice of its own. Carry is not shown in the two goals in reais: it is ahead of the others on no line.
- **Scorecard.** Observed carry rises in every income and protect plan (low-risk income, Carry: 272 to 374 bps). Spread holds 5 to 7 issuers where it held 3 or 4. The largest issuer stays at or under 50%, and the credit and basis share stays at the person's limit. The share with a measured exit falls, to zero in plans with no gold or stocks: no exit of an added token is measured, so each line takes its tier ceiling, labelled a fallback.
- **Income verdicts.** The gap narrows in every income goal and closes in one: low-risk income, Carry, short by $68.50 a month becomes short by $0.22; the goal in Canada is met on Cover and Carry (it was short by $11.94 at best), holding wYLDS where USDY is blocked; the retirement goal stays short ($353.65 becomes $225.65 on Carry).
- **What the better figures rest on.** Most of the rise in carry is one swap inside the credit budget: Carry holds AUTO at 25% where it held syrupUSDC, and AUTO's fixture yield is an aggregator's figure for a pool of consumer auto loans, the highest on the shelf. The verdict met in Canada rests on wYLDS at 20% to 32.5% of the plan, whose yield is taken on trust: its price stays near a dollar and how a vault receives the yield is not verified (`solana.md`, section 5.5). kUSDC is in most of these plans and the vault cannot redeem it yet (`solana.md`, section 5.2). None of this is a reading.

### Three things the added tokens bring out, for Rodrigo

None is changed here: each is the engine doing what it does today on a longer shelf.

1. **"Months covered" reads 0 where the set-aside moved out of cash.** The set-aside goes to rate legs first when the chain lists any (`set-aside.ts`), and the scorecard's line counts cash and matching legs only (`scorecard.ts`). On the launch shelf Solana had no rate leg, so the set-aside sat in USDC and the line read 36; on the extended shelf Cover and Carry hold it in USDY and wYLDS and the line reads 0, though the coverage check still passes. The line now reads against the candidate whose aim is cover.
2. **Spread drops gold from a plan to protect.** A plan holds at most 8 lines. Spread fills equally across every dollar-yield token, takes all 8, and the gold line is left out with the reason `MAX_LINES` ("Proteger minhas economias", "Protect", "Protect on Robinhood Chain", the college goal). Which sleeve gives up a line first when the limit binds is a choice the engine has not been asked to make.
3. **The goals in reais still have no matching leg.** TESOURO is listed and held out, so the reais set aside stays in USDC with the flag `no_matching_leg:BRL`, as on the launch shelf. Section 5.3 of `solana.md` is the decision that changes it.

### The goals, one by one

Chain: solana. Plans made at 2026-10-06T12:00:00.000Z. Every figure is MOCK: it comes from the engine's fixtures, and none is live. "Carry" is the plan's observed carry in basis points after haircut, from the fixture yields; "Measured exit" is the share of the plan whose exit capacity is measured (the rest takes its tier ceiling, a labelled fallback).

#### Income for retirement, monthly

- Launch shelf: cover, carry; not shown: spread (Spread is not shown: Carry is as good on every line of the comparison, and better on one.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 41.66%, syrupUSDC 12.50%, USDC 45.84% | 45.84% | 187 | 3 | 45.84% | 12.50% | 0.00% | 24 | short by $412.15 a month |
| cover | extended | USDY 27.92%, jlJupUSD 25.00%, jlUSDC 25.00%, AUTO 12.50%, wYLDS 8.33%, kUSDC 1.25% | 0.00% | 325 | 4 | 50.00% | 12.50% | 0.00% | 0 | short by $274.74 a month |
| spread | launch | not shown | | | | | | | | |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 1.25%, USDC 13.75% | 13.75% | 290 | 7 | 30.00% | 25.00% | 0.00% | 24 | short by $309.76 a month |
| carry | launch | jlUSDC 41.66%, syrupUSDC 25.00%, USDC 33.34% | 33.34% | 246 | 3 | 41.66% | 25.00% | 0.00% | 24 | short by $353.65 a month |
| carry | extended | AUTO 25.00%, jlJupUSD 25.00%, jlUSDC 25.00%, USDY 15.42%, wYLDS 8.33%, kUSDC 1.25% | 0.00% | 374 | 4 | 50.00% | 25.00% | 0.00% | 0 | short by $225.65 a month |

#### Proteger minhas economias

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, GLDx 16.66%, USDC 20.84% | 20.84% | 213 | 4 | 50.00% | 12.50% | 37.50% |  |  |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, AUTO 12.50%, USDY 7.92%, wYLDS 7.91%, kUSDC 5.00%, GLDx 16.66%, USDC 0.01% | 0.01% | 285 | 6 | 50.00% | 12.50% | 16.66% |  |  |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, GLDx 25.00%, USDC 20.00% | 20.00% | 210 | 4 | 30.00% | 25.00% | 45.00% |  |  |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 5.00%, USDC 10.00% | 10.00% | 302 | 7 | 30.00% | 25.00% | 0.00% |  |  |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, GLDx 25.00% | 0.00% | 272 | 3 | 50.00% | 25.00% | 25.00% |  |  |
| carry | extended | AUTO 25.00%, jlJupUSD 22.50%, jlUSDC 22.50%, kUSDC 5.00%, GLDx 25.00% | 0.00% | 312 | 4 | 45.00% | 25.00% | 25.00% |  |  |

#### Grow, half in AI

- Launch shelf: cover; not shown: spread (Spread is not shown: it differs from Cover by 9.58% of the plan, under 10%, so the two are one choice.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Lines changed in: cover, spread, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SPYx 47.50%, NVDAx 8.34%, TSLAx 8.34%, AAPLx 8.33%, AMZNx 8.33%, GOOGLx 8.33%, METAx 8.33%, syrupUSDC 2.50% | 0.00% | 11 | 2 | 97.50% | 2.50% | 55.83% |  |  |
| cover | extended | SPYx 47.50%, NVDAx 8.34%, TSLAx 8.34%, AAPLx 8.33%, AMZNx 8.33%, GOOGLx 8.33%, METAx 8.33%, AUTO 2.50% | 0.00% | 16 | 2 | 97.50% | 2.50% | 55.83% |  |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SPYx 47.50%, NVDAx 25.00%, TSLAx 25.00%, AUTO 0.50%, kUSDC 0.50%, PRIME 0.50%, PST 0.50%, syrupUSDC 0.50% | 0.00% | 11 | 5 | 97.50% | 2.00% | 72.50% |  |  |

#### Faculdade da minha filha, em reais

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread; not shown: carry (Rendimento não aparece: ele não fica à frente dos outros em nenhuma linha da comparação.)
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, GLDx 25.00%, USDC 12.50% | 12.50% | 213 | 4 | 50.00% | 12.50% | 37.50% | 0 |  |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, AUTO 12.50%, kUSDC 10.00%, USDY 1.25%, wYLDS 1.25%, GLDx 25.00% | 0.00% | 268 | 5 | 50.00% | 12.50% | 25.00% | 0 |  |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, GLDx 25.00%, USDC 20.00% | 20.00% | 210 | 4 | 30.00% | 25.00% | 45.00% | 0 |  |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, kUSDC 10.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, USDC 5.00% | 5.00% | 319 | 7 | 30.00% | 25.00% | 0.00% | 0 |  |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, GLDx 25.00% | 0.00% | 272 | 3 | 50.00% | 25.00% | 25.00% | 0 |  |
| carry | extended | not shown | | | | | | | | |

#### No stocks, no credit

- Launch shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Lines changed in: cover, spread, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, GLDx 5.00%, USDC 45.00% | 45.00% | 155 | 3 | 50.00% | 0.00% | 50.00% |  |  |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, USDY 19.50%, wYLDS 19.50%, kUSDC 6.00%, GLDx 5.00% | 0.00% | 266 | 5 | 50.00% | 0.00% | 5.00% |  |  |
| spread | launch | jlUSDC 30.00%, GLDx 5.00%, USDC 65.00% | 65.00% | 93 | 3 | 65.00% | 0.00% | 70.00% |  |  |
| spread | extended | USDY 29.50%, wYLDS 29.50%, jlJupUSD 15.00%, jlUSDC 15.00%, kUSDC 6.00%, GLDx 5.00% | 0.00% | 257 | 5 | 30.00% | 0.00% | 5.00% |  |  |

#### Já tenho Nvidia, The Seven

- Launch shelf: cover, carry; not shown: spread (Diversificação não aparece: ele difere de Cobertura em 2,5% do plano, menos de 10%, então os dois são uma só escolha.)
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | AAPLx 12.87%, AMZNx 12.87%, GOOGLx 12.87%, METAx 12.87%, MSFTx 12.87%, jlUSDC 17.50%, syrupUSDC 12.50%, GLDx 5.65% | 0.00% | 112 | 3 | 70.00% | 12.50% | 5.64% |  |  |
| cover | extended | AAPLx 12.90%, AMZNx 12.90%, GOOGLx 12.90%, jlJupUSD 14.39%, jlUSDC 14.38%, kUSDC 14.38%, AUTO 12.50%, GLDx 5.65% | 0.00% | 214 | 4 | 44.35% | 12.50% | 5.64% |  |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | USDY 26.25%, kUSDC 18.75%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25% | 0.00% | 338 | 6 | 30.00% | 25.00% | 0.00% |  |  |
| carry | launch | AAPLx 10.73%, AMZNx 10.73%, GOOGLx 10.73%, METAx 10.72%, MSFTx 10.72%, TSLAx 10.72%, syrupUSDC 25.00%, GLDx 5.65%, USDC 5.00% | 5.00% | 117 | 3 | 70.00% | 25.00% | 10.64% |  |  |
| carry | extended | AAPLx 10.73%, AMZNx 10.73%, GOOGLx 10.73%, METAx 10.72%, MSFTx 10.72%, TSLAx 10.72%, AUTO 25.00%, GLDx 5.65%, USDC 5.00% | 5.00% | 161 | 3 | 70.00% | 25.00% | 10.64% |  |  |

#### Protect on Robinhood Chain

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, GLDx 12.50%, USDC 25.00% | 25.00% | 213 | 4 | 50.00% | 12.50% | 37.50% |  |  |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, AUTO 12.50%, USDY 8.13%, wYLDS 8.12%, kUSDC 3.75%, GLDx 12.50%, USDC 5.00% | 5.00% | 282 | 6 | 50.00% | 12.50% | 17.50% |  |  |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, GLDx 20.00%, USDC 25.00% | 25.00% | 210 | 4 | 30.00% | 25.00% | 45.00% |  |  |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 3.75%, USDC 11.25% | 11.25% | 298 | 7 | 30.00% | 25.00% | 0.00% |  |  |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, GLDx 20.00%, USDC 5.00% | 5.00% | 272 | 4 | 50.00% | 25.00% | 25.00% |  |  |
| carry | extended | AUTO 25.00%, jlJupUSD 23.13%, jlUSDC 23.12%, kUSDC 3.75%, GLDx 20.00%, USDC 5.00% | 5.00% | 311 | 5 | 46.25% | 25.00% | 25.00% |  |  |

#### Something vague

- Launch shelf: 5 question(s) open: goal, amount, horizon, risk, country
- Extended shelf: 5 question(s) open: goal, amount, horizon, risk, country

#### Low-risk income

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, USDC 37.50% | 37.50% | 213 | 3 | 50.00% | 12.50% | 0.00% | 36 | short by $107.50 a month |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, USDY 23.13%, AUTO 12.50%, wYLDS 12.50%, kUSDC 1.87% | 0.00% | 325 | 4 | 50.00% | 12.50% | 0.00% | 0 | short by $33.01 a month |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, USDC 45.00% | 45.00% | 210 | 3 | 45.00% | 25.00% | 0.00% | 36 | short by $109.90 a month |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 1.87%, USDC 13.13% | 13.13% | 292 | 7 | 30.00% | 25.00% | 0.00% | 36 | short by $55.14 a month |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, USDC 25.00% | 25.00% | 272 | 3 | 50.00% | 25.00% | 0.00% | 36 | short by $68.50 a month |
| carry | extended | AUTO 25.00%, jlJupUSD 25.00%, jlUSDC 25.00%, USDY 12.35%, wYLDS 10.78%, kUSDC 1.87% | 0.00% | 374 | 4 | 50.00% | 25.00% | 0.00% | 0 | short by $0.22 a month |

#### No lending

- Launch shelf: cover; not shown: spread (Spread is not shown: it holds the same as Cover.); carry (Carry is not shown: it holds the same as Cover.)
- Extended shelf: cover, spread; not shown: carry (Carry is not shown: it holds the same as Cover.)
- Lines changed in: cover, spread, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | SPYx 65.00%, jlUSDC 30.00%, GLDx 5.00% | 0.00% | 93 | 2 | 70.00% | 0.00% | 70.00% |  |  |
| cover | extended | SPYx 65.00%, jlJupUSD 13.13%, jlUSDC 13.12%, kUSDC 3.75%, GLDx 5.00% | 0.00% | 90 | 3 | 70.00% | 0.00% | 70.00% |  |  |
| spread | launch | not shown | | | | | | | | |
| spread | extended | SPYx 65.00%, jlJupUSD 6.57%, jlUSDC 6.56%, USDY 6.56%, wYLDS 6.56%, kUSDC 3.75%, GLDx 5.00% | 0.00% | 84 | 5 | 70.00% | 0.00% | 70.00% |  |  |

#### Protect

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, GLDx 8.33%, USDC 29.17% | 29.17% | 213 | 4 | 50.00% | 12.50% | 37.50% |  |  |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, USDY 13.34%, wYLDS 13.33%, AUTO 12.50%, kUSDC 2.50%, GLDx 8.33% | 0.00% | 304 | 5 | 50.00% | 12.50% | 8.33% |  |  |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, GLDx 16.66%, USDC 28.34% | 28.34% | 210 | 4 | 30.00% | 25.00% | 45.00% |  |  |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 2.50%, USDC 12.50% | 12.50% | 294 | 7 | 30.00% | 25.00% | 0.00% |  |  |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, GLDx 16.66%, USDC 8.34% | 8.34% | 272 | 4 | 50.00% | 25.00% | 25.00% |  |  |
| carry | extended | AUTO 25.00%, jlJupUSD 25.00%, jlUSDC 25.00%, USDY 2.92%, wYLDS 2.91%, kUSDC 2.50%, GLDx 16.66%, USDC 0.01% | 0.01% | 333 | 6 | 50.00% | 25.00% | 16.66% |  |  |

#### Em reais, com saques em reais

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread; not shown: carry (Rendimento não aparece: ele não fica à frente dos outros em nenhuma linha da comparação.)
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, GLDx 21.59%, USDC 15.91% | 15.91% | 213 | 4 | 50.00% | 12.50% | 37.50% | 11 |  |
| cover | extended | jlJupUSD 22.39%, jlUSDC 22.38%, AUTO 12.50%, kUSDC 7.50%, GLDx 21.59%, USDC 13.64% | 13.64% | 238 | 5 | 44.77% | 12.50% | 35.23% | 10 |  |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, GLDx 23.63%, USDC 21.37% | 21.37% | 210 | 4 | 30.00% | 25.00% | 45.00% | 15 |  |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, kUSDC 7.50%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, USDC 7.50% | 7.50% | 310 | 7 | 30.00% | 25.00% | 0.00% | 5 |  |
| carry | launch | jlUSDC 45.90%, syrupUSDC 25.00%, GLDx 23.63%, USDC 5.47% | 5.47% | 259 | 4 | 45.90% | 25.00% | 29.10% | 4 |  |
| carry | extended | not shown | | | | | | | | |

#### Income in USDG on Robinhood Chain

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, USDC 37.50% | 37.50% | 213 | 3 | 50.00% | 12.50% | 0.00% | 24 | short by $60.94 a month |
| cover | extended | jlJupUSD 25.00%, jlUSDC 25.00%, USDY 18.90%, wYLDS 15.60%, AUTO 12.50%, kUSDC 3.00% | 0.00% | 326 | 4 | 50.00% | 12.50% | 0.00% | 0 | short by $14.10 a month |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, USDC 45.00% | 45.00% | 210 | 3 | 45.00% | 25.00% | 0.00% | 24 | short by $62.44 a month |
| spread | extended | USDY 30.00%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 3.00%, USDC 12.00% | 12.00% | 296 | 7 | 30.00% | 25.00% | 0.00% | 24 | short by $26.65 a month |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, USDC 25.00% | 25.00% | 272 | 3 | 50.00% | 25.00% | 0.00% | 24 | short by $36.57 a month |
| carry | extended | AUTO 25.00%, jlJupUSD 25.00%, jlUSDC 25.00%, USDY 11.75%, wYLDS 10.25%, kUSDC 3.00% | 0.00% | 375 | 4 | 50.00% | 25.00% | 0.00% | 0 | met ($150.00 a month) |

#### Income, living in Canada

- Launch shelf: cover, spread, carry
- Extended shelf: cover, spread, carry
- Lines changed in: cover, spread, carry, the plain plan

| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |
|---|---|---|---|---|---|---|---|---|---|---|
| cover | launch | jlUSDC 50.00%, syrupUSDC 12.50%, USDC 37.50% | 37.50% | 213 | 3 | 50.00% | 12.50% | 0.00% |  | short by $26.57 a month |
| cover | extended | wYLDS 32.50%, jlJupUSD 25.00%, jlUSDC 25.00%, AUTO 12.50%, kUSDC 5.00% | 0.00% | 326 | 3 | 50.00% | 12.50% | 0.00% |  | met ($80.00 a month) |
| spread | launch | jlUSDC 30.00%, syrupUSDC 25.00%, USDC 45.00% | 45.00% | 210 | 3 | 45.00% | 25.00% | 0.00% |  | short by $27.47 a month |
| spread | extended | wYLDS 17.50%, jlJupUSD 15.00%, jlUSDC 15.00%, AUTO 6.25%, PRIME 6.25%, PST 6.25%, syrupUSDC 6.25%, kUSDC 5.00%, USDC 22.50% | 22.50% | 269 | 6 | 30.00% | 25.00% | 0.00% |  | short by $12.55 a month |
| carry | launch | jlUSDC 50.00%, syrupUSDC 25.00%, USDC 25.00% | 25.00% | 272 | 3 | 50.00% | 25.00% | 0.00% |  | short by $11.94 a month |
| carry | extended | AUTO 25.00%, jlJupUSD 25.00%, jlUSDC 25.00%, wYLDS 20.00%, kUSDC 5.00% | 0.00% | 376 | 3 | 50.00% | 25.00% | 0.00% |  | met ($80.00 a month) |

#### Cash share of the plain plan, by goal

| Goal | Launch | Extended |
|---|---|---|
| Income for retirement, monthly | 33.34% | 0.00% |
| Proteger minhas economias | 0.00% | 0.00% |
| Grow, half in AI | 0.00% | 0.00% |
| Faculdade da minha filha, em reais | 0.00% | 0.00% |
| No stocks, no credit | 45.00% | 0.00% |
| Já tenho Nvidia, The Seven | 5.00% | 5.00% |
| Protect on Robinhood Chain | 5.00% | 5.00% |
| Low-risk income | 25.00% | 0.00% |
| No lending | 0.00% | 0.00% |
| Protect | 8.34% | 0.01% |
| Em reais, com saques em reais | 5.47% | 5.47% |
| Income in USDG on Robinhood Chain | 25.00% | 0.00% |
| Income, living in Canada | 25.00% | 0.00% |
| Mean of 13 goals | 13.63% | 1.19% |

Goals with a plan on either shelf: 13 of 14. Of those, no line changed in 0.

## Robinhood Chain

Written on `shelf/robinhood-yield`.
