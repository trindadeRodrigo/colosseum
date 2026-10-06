# Plan playground: goals for the extended shelf

Six goals written to exercise the fixed-income tokens of the extended shelf
(docs/vault/research/yield-shelf/). Run them on each shelf and compare:

    pnpm plan:try try/prompts/yield-shelf.md --shelf launch
    pnpm plan:try try/prompts/yield-shelf.md --shelf extended
    pnpm plan:compare try/prompts/examples.md try/prompts/yield-shelf.md --chain solana

Text up here, before the first goal, is not read. See try/README.md. The answers say the goal, the time
frame and the risk, so these goals run with the rules parser as well as with the model.

## Low-risk income

I have $80,000 and I'd like about $250 a month from it, starting in November, for the next three
years. I want to be careful with it. I live in Brazil.

```yaml answers
goal: income
amount: 80000
income: 250
horizon: 5y
risk: low
withdrawals: { monthly: 250, from: 2026-11, months: 36 }
```

## No lending

Grow $40,000 over six years at medium risk. No lending and no credit products. I live in Germany.

```yaml answers
goal: grow
amount: 40000
horizon: 6y
risk: medium
limits:
  creditTolerance: none
```

## Protect

Keep $60,000 safe for four years. I don't want to take risk with it. I live in Portugal.

```yaml answers
goal: protect
amount: 60000
horizon: 4y
risk: low
```

## Em reais, com saques em reais

Tenho o equivalente a US$ 20.000 e quero proteger esse dinheiro. Vou sacar R$ 1.500 por mês, a
partir de dezembro, por dois anos. Risco baixo. Moro no Brasil.

```yaml answers
goal: protect
amount: 20000
horizon: 3y
risk: low
currency: BRL
language: pt
withdrawals: { monthly: 1500, from: 2026-12, months: 24, currency: BRL }
```

## Income in USDG on Robinhood Chain

chain: robinhood

I hold $50,000 in USDG and want about $150 a month from it, from November, for two years. Low risk.
I live in Spain.

```yaml answers
goal: income
amount: 50000
income: 150
horizon: 4y
risk: low
withdrawals: { monthly: 150, from: 2026-11, months: 24 }
```

## Income, living in Canada

<!-- Since gate COUNTRY-REMOVED (Oct 6) the plan reads no country: this goal gets the plan any other does. -->

I have $30,000 and want a steady income from it over five years, low risk. I live in Canada.

```yaml answers
goal: income
amount: 30000
income: 80
horizon: 5y
risk: low
```
