# Plan playground: examples

Each goal starts with a `## heading`. Under it, the goal as a person would type it. A fenced
block named `yaml answers` answers the intake's questions; a `chain:` line picks the chain (Solana
when left out). Text up here, before the first goal, is not read. See try/README.md.

With no model (no `ANTHROPIC_API_KEY`), the rules parser reads the text, and the goal, the time frame
and the risk it reads are always asked once: the answers below say them, so these goals run either way.

## Income for retirement, monthly

I'm retiring next year with $120,000 saved. I'd like about $600 a month on top of my pension,
from November, for the next two years, and to keep the rest growing gently for five. I live in Portugal and I want to be careful with it.

```yaml answers
goal: income
amount: 120000
income: 600
horizon: 5y
risk: low
withdrawals: { monthly: 600, from: 2026-11, months: 24 }
```

## Proteger minhas economias

Tenho US$ 30.000 guardados e quero proteger esse dinheiro pelos próximos dois anos. Não quero
correr risco. Moro no Brasil.

```yaml answers
goal: protect
amount: 30000
horizon: 24
risk: low
language: pt
```

## Grow, half in AI

Grow $10,000 over ten years. I want half of it in AI companies, the rest however you think fits
the goal. I'm fine with risk. I live in the UK.

```yaml answers
goal: grow
amount: 10000
horizon: 10y
risk: high
sleeves: { goal: 50, ai: 50 }
```

## Faculdade da minha filha, em reais

Quero guardar para a faculdade da minha filha. Tenho o equivalente a US$ 15.000 e vou precisar de
R$ 20.000 no começo de cada semestre de 2030 e 2031. Risco médio. Moro em São Paulo.

```yaml answers
goal: protect
amount: 15000
horizon: 60
risk: medium
currency: BRL
language: pt
obligations:
  - { month: 2030-02, amount: 20000, currency: BRL }
  - { month: 2030-08, amount: 20000, currency: BRL }
  - { month: 2031-02, amount: 20000, currency: BRL }
  - { month: 2031-08, amount: 20000, currency: BRL }
```

## No stocks, no credit

Grow $25,000 over eight years at medium risk. No stocks and no lending or credit products. I live
in Germany.

```yaml answers
goal: grow
amount: 25000
horizon: 8y
risk: medium
limits:
  creditTolerance: none
  cannotHold: { classes: [stock, etf] }
```

## Já tenho Nvidia, The Seven

Quero fazer crescer US$ 8.000 em 5 anos, risco médio, partindo da carteira The Seven. Já tenho
uns US$ 2.000 em Nvidia. Moro no Brasil.

```yaml answers
goal: grow
amount: 8000
horizon: 5y
risk: medium
language: pt
themes: [the-seven]
holdings: { NVDA: 2000 }
```

## Protect on Robinhood Chain

chain: robinhood

Keep $40,000 safe for three years. Low risk. I may need $10,000 of it within a year. I live in
Spain.

```yaml answers
goal: protect
amount: 40000
horizon: 3y
risk: low
limits: { mayNeedInMonths: 12 }
```

## Something vague

I want my money to work for me.
