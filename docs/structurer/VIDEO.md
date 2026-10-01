# VIDEO.md — 3-minute script and shot list (draft, D9-PM finalises)

Guardrails (HANDOFF §9): lead with the BRL schedule under stress and the risk sheet; "policy in your wallet, not a fund" in the first sentence; one-slide Glider/Ondo answer; Nexa as analog, not opener; claim only what is live or signed; label every mock; no yield figure spoken as a promise, only "as of today, source on screen".

## Script (narration, English; goal typed in Portuguese on screen)

**0:00–0:15 Cold open — the output, not the chat.**
Screen: `/plans/<income plan>` scrolled to the schedule chart and stress table.
"R$3.000 por mês a partir de 2028. This is that goal, month by month, in reais, under a BRL appreciation and a frozen credit leg. It runs as a policy in your own wallet, not a fund."

**0:15–0:40 Why this is not Glider or Ondo.**
Screen: one slide, three columns (Glider · Ondo Intelligent Portfolios · this).
"Glider and Ondo sell fixed model portfolios. We solve a user-specific cash-flow target in reais: near-term withdrawals matched with on-chain reais, later ones funded by dollar yield with the FX gap priced, and every quoted yield haircut by a rule we show. Our prior analytics found on-chain yield and volume figures overstated by two to five times; that discipline is in the product."

**0:40–1:25 Hero flow.**
Screen: `/` → type the goal → "Interpretar objetivo" → sheet appears → edit liquidity window → "Gerar plano" → plan page.
"Type the goal in Portuguese. The parser turns it into a constraint sheet you can edit: target, horizon, liquidity window, risk and credit budget, FX stance. The solver is deterministic: a cash buffer for the liquidity window, a BRL leg for near-term withdrawals capped by liquidity, and a small optimisation over dollar yield legs within caps and a credit budget. Each leg says why it is there. The risk sheet shows the quoted yield, the haircut and the rule, the source and the timestamp, the oracle, the redemption path, gates, and the issuer."

**1:25–2:05 Execution, real money.**
Screen: wallet balance → `sign-and-send` terminal or the wallet prompt → Solscan tabs.
"The wallet holds USDC. The API returns one unsigned transaction per leg; the wallet signs; every transaction is logged with its explorer link." Show three confirmations.
G-Nora PASS: "The BRL leg is BRS, minted from USDC through Nora." Show the mint signature.
G-Nora FAIL: "The BRL leg is on the plan and in the risk sheet, labelled 'integration in progress'; it is not executed yet." Show the label.
High-risk goal: cut to the dated weekday clip of the xStocks buy. "For a growth goal that accepts market risk, the same engine adds tokenized stocks — bought on a weekday; the risk sheet shows why weekends are thin."

**2:05–2:30 Policy and rebalance.**
Screen: `/monitor` with drift table → "Run policy now" → confirmation with agent signer → Solscan.
"The policy is stored: allowed assets, weight bands, a drift trigger, withdrawals only to you. The USD yield legs rebalance under a limit you approved on-chain: the agent key moves only what you allowed, and the output lands in your account. The Kamino and stock legs ask for your signature. You can revoke the agent any time." Show the revoke.

**2:30–2:48 B2B and traction.**
Screen: `/docs` (three endpoints) → `/embed/<id>` → LOI slide → Nexa analog slide.
"Distributors embed this through three endpoints: goals, plans, transactions. Two Brazilian self-custody wallets signed letters of intent this month. Nexa raised R$25M in July 2025 to structure goals inside FIDCs with advisors; we do the same on-chain and non-custodial."

**2:48–3:00 Close.**
Screen: stats card from the database (wallets, deposited value, executions, rebalances) → end card.
"Everything you saw is live on mainnet with our own money, as of today, sources on screen. It is not licensed advice: the distributor holds the client relationship. Policy in your wallet, not a fund."

## Shot list

| # | Shot | Must exist on screen | Produced by | Status |
|---|---|---|---|---|
| 1 | Schedule chart + stress table, income plan | live plan with 4 stresses, liquidity holds/breaks, FX at plan time | D5-PM, D6-PM | ready (`/plans/b028ea5d…`) |
| 2 | Glider / Ondo / this slide | three columns, no yield numbers | D9-PM | todo |
| 3 | Goal typed → sheet → edit → plan | `GoalFlow` | D6-PM | ready |
| 4 | Risk sheet table | rule, source, timestamp, oracle, redemption, depth, gates, issuer | D4-PM | ready |
| 5 | Execution: three legs confirmed via API + script | executions with Solscan links | D3-AM | pending founder run |
| 6 | BRS mint or "integration in progress" label | per G-Nora | D7-PM/D8 | label ready; mint pending gate |
| 7 | xStocks buy (weekday clip, date on screen) | plan `17b2e84a…` executed | D6-PM | pending founder run (weekday) |
| 8 | Monitor: drift table, Run policy, agent-signed confirmation | `/monitor` | D7-AM | ready; run pending founder approval step |
| 9 | Revoke the agent (off-switch) | `buildRevokeTx` in a one-liner or UI button | D7-PM | todo (UI button) |
| 10 | API docs + embed | `/docs`, `/embed/<id>` | D6-AM, D4-AM | ready |
| 11 | LOI slide (Chainless, Picnic, dated) | PDFs from founder | founder | pending |
| 12 | Nexa analog slide | facts from HANDOFF §9 | D9-PM | todo |
| 13 | Stats card (wallets, deposited value, executions, rebalances) | `GET /executions` + positions | D9-AM | todo (small route + card) |
| 14 | End card: disclaimer | `DISCLAIMER` constant | ready | ready |

Recording rules: live segments on Oct 11 with the income goal; shot 7 is the dated weekday clip; nothing simulated shown as real; every FIXTURE/MOCK badge visible where it applies.
