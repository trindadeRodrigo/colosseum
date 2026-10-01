# Messaging
> Phase: strategy | Brand: working-brand ([Name] TBD, see naming.md) | Generated: 2026-10-01 · **Revised 2026-10-01 (founder-approved positioning)**

**Swap test (applies to every line here):** replace [Name] with Peaks, Cesto, Ondo, Glider, Wealthfront or Nexa. If the line still works, it's too generic, so rewrite it. **Danger test:** if a line could be summarised as "AI agent that builds diversified RWA portfolios", it invites "why isn't this just Cesto with an AI interface?". Rewrite it around *your goal*, *the exit plan* and *the odds*.

---

## 1. Lead line, core message, proof line

### Lead line (homepage hero, video open, deck title)
> **"Tell us what your money needs to do. [Name] builds the portfolio that gets it there — and shows you how."**

### Core message (the one thing every surface communicates)
> **Others turn an idea into a basket. [Name] turns your goal into a plan made to measure, with an exit plan before it invests and every joint in sight.**

It always carries **both halves**: *made to measure* (worked backwards from one goal) **and** *every joint in sight* (sources, after-risk value, the exit plan, every move logged).

### Proof line (killer feature, used right after the lead line)
> **"Every portfolio has an exit plan before the agent invests."**

Tokenized does not mean liquid. The exit plan answers *"can I actually get the money back when I need it, and at what cost?"* before the first dollar moves.

### Manifesto line (video close, site footer)
> **"No product fits everyone. So we make the pieces — and your goals decide how they fit."**

### Short manifesto (about 90 words, voice-over)
> Most portfolios start from someone else's idea: a theme, a narrative, a model. You pick one and hope it fits.
> We start from yours. Tell us what your money needs to do: an amount, a date, a yield, cash you must be able to reach. [Name] works backwards from that goal, builds the portfolio that fits it, and plans the way out before it invests.
> Then it keeps the odds on your side. When they move, you hear it early, with the reason and the receipt.
> No product fits everyone. So we cut each one to fit.

---

## 2. Supporting messages and proof points

### SM1: Made to measure: worked backwards from your goal
> **You set the outcome and the limits. The portfolio is solved for them, not picked from a menu or built around a theme.**

| Proof point | Status |
|---|---|
| Goals (amount, date, yield, reachable cash) and limits (risk profile, exit window, exclusions) are stated in plain language and turned into an explicit, editable constraint sheet the user confirms | Shipped (parser + zod-validated `ConstraintSheet`) |
| A deterministic solver builds the portfolio backwards from the constraints across tokenized treasuries, credit, stocks, commodities, dollar yield and cash. The same inputs always give the same plan | Shipped (engine) |
| Rules are enforced in the asset registry, not a prompt. For example, tokenized stocks are never used for income goals | Shipped and tested |
| If a goal can't be met within the limits, the user is told why and shown the closest fit | Product behaviour |

*Never say:* "AI-built diversified RWA portfolios", "thematic", "bespoke". *Always say:* **made to measure for your goal**.

### SM2: An exit plan before it invests
> **Before a dollar moves, you know how much you can get back, how fast, and at what cost.**

| Proof point | Status |
|---|---|
| Exit capacity is measured, not assumed: depth by size, path and hour of week, recorded continuously since Sept 2026 (the [Name] Bearing dataset, which can't be backfilled) | Shipped (depth snapshot cron); dataset growing |
| Positions are sized so the user's cash-access limit holds under measured depth | Engine behaviour (sizing uses depth) |
| Stress cases are shown next to the base case, including exit cost in a thin market | Shipped (path + stress) |

### SM3: Managed on the odds of reaching your goal, with every joint in sight
> **It rebalances to keep your odds of reaching the goal on track, not to follow a theme, and shows why every time.**

| Proof point | Status |
|---|---|
| The plan tracks whether the goal is on track and re-trues when the outlook moves. Each move is logged with its "because" | Policy behaviour. **The odds are an estimate:** always shown with method and as-of date, never as a promise |
| Every yield, price and FX figure carries source · fetched_at · method. Quoted yields are cut by credit-aware haircuts, and quoted and used figures are both shown | Shipped rule, enforced by test |
| Execution goes into the user's own wallet. Every mainnet transaction is shown with its explorer link | Shipped (`executions` table) |
| MOCK is always labelled (`"provenance": "mock"`). Not licensed advice; the disclaimer appears on the plan and in API docs | Shipped |

---

## 3. Elevator pitch (30 seconds)

> Most portfolio apps start from an idea: a theme, a narrative, a model someone else built. None of them starts from what *your* money needs to do.
>
> [Name] works backwards. Tell it the goal ("this amount by June 2028, with a week's access to cash") and your limits. It builds the portfolio of tokenized real-world assets that fits, and **plans the exit before it invests**, because tokenized doesn't mean liquid. Then it manages the odds of reaching your goal, in your own wallet, with every number's source in sight.
>
> Others turn an idea into a basket. We turn your goal into a plan made to measure.

**10-second version:** "Tell us what your money needs to do. [Name] builds the portfolio that gets it there, with an exit plan before it invests, and shows you how."

---

## 4. Tagline directions

**Tagline A stays: "Made to measure. Every joint shown."** It does not conflict with the new positioning: "made to measure" closes the statement, and "every joint shown" is the sign-off form of "every joint in sight" and "shows you how". The roles are separate. The **lead line** opens (hero, video open). The **proof line** follows. **Tagline A** closes (end card, footer, partner badge).

| # | Tagline | Role / rationale | Risk |
|---|---|---|---|
| **A (recommended)** | **Made to measure. Every joint shown.** | Sign-off. Both halves in five words. Passes the swap test against Peaks, Cesto and Ondo | EN cannabis reading of "joint". Test with 5 EN speakers. Fallback: A2 |
| A2 | Made to measure. Nothing hidden. | Unambiguous fallback | Less distinctive |
| B | **Your goal in. The way out planned.** | New option from the exit-plan proof. Use it as a campaign line for the video or social, not as the brand tagline | Loses "made to measure", so pair it with the lead line |
| C | It holds. And you can see why. | Plan-view sub-line | Never alone |

**Localised A:** PT "Sob medida. Cada encaixe à vista." · ES "A la medida. Cada ensamble a la vista."
**Localised proof line:** PT "Todo portfólio tem um plano de saída antes de o agente investir." · ES "Cada portafolio tiene un plan de salida antes de que el agente invierta."

---

## 5. Audience mapping

| Audience | Primary motivation | Key message | Order | Tone | Proof to show | Channel |
|---|---|---|---|---|---|---|
| **Mariana 1a**, crypto-native diversifier | Move idle stables into RWAs for a real target without becoming a PM. Distrusts hidden illiquidity | "Tell it what your stack needs to do. It builds the portfolio for that, **plans the exit before it invests**, and shows every number's source in your wallet." | SM2 → SM1 → SM3 | Drier, receipts over reassurance | Exit plan with measured depth, explorer links, haircut vs quoted | X, Telegram/Discord, Colosseum demo |
| **Mariana 1b**, life-goal saver | Know her goal will land without learning DeFi | "Your apartment fund, built backwards from June 2028. **Your odds of reaching it** are on track, and you can reach your cash within a week. If the odds move, you'll hear it early." | SM1 → SM3 → SM2 | Warmest. Goal by name, dates over percentages | On-track and odds statement (with as-of date), "access to cash" in plain words | Partner app (embed), word of mouth |
| **Rafael**, neobank / fintech PM | A differentiated, defensible earn feature | "Put the **goal and liquidity layer** under your app: users say what their money needs to do, and each plan comes with an **exit plan before it invests** and every figure's source for compliance." | SM1 → SM2 → SM3 | Professional, docs-first | OpenAPI `/docs`, MOCK labels, disclaimer, embed in partner skin | Partner intros (Chainless, Picnic LOIs), docs |
| **Priya**, risk lead | Auditable liquidity to set parameters from | "Tokenized doesn't mean liquid. [Name] Bearing measures **whether the money can come back**: how much, at what cost, at what hour, versioned, n=, method open." | Measurement → method → neutrality | Instrument register | Hour-of-week depth heatmap, method doc, raw samples | Governance forums, research posts |
| **Consumer apps as distribution** (including idea-to-basket apps) | Add liquidity truth and goal tracking without building it | "Your users pick the idea. We tell them whether they can get out, and whether their goal still lands." | SM2 → SM3 | Partner-to-partner | Bearing API, exit-plan endpoint | BD |
| **Colosseum judges** | Real? Novel? Not a rerun of Cohort 5? | "Peaks and Cesto turn an idea into a basket. We solve the inverse problem: goal and constraints in, a made-to-measure portfolio out, **an exit plan before investing**, managed on **the odds of reaching the goal**. Live on mainnet." | Inverse problem → exit plan → live proof → Bearing | Confident, specific | Mainnet transactions, solver determinism, depth heatmap, LOIs | Video, demo, deck |

### Objection handling
| Objection | Answer |
|---|---|
| "Isn't this just Cesto or Peaks with an AI interface?" | No. They start from an idea and build a basket. We start from what your money needs to do, solve backwards, plan the exit before investing, and rebalance on the odds of reaching your goal, not on a theme. |
| "Isn't this a robo-advisor or a model portfolio?" | Those put a goal label on someone else's model. Ours is solved from your goal and limits, with the exit measured. |
| "Can an AI agent be trusted with money?" | The language model only reads your goal and writes it down for you to confirm. A deterministic solver builds the plan. Everything runs in your wallet, and every move is logged. |
| "What return will I get?" | We don't promise returns. We show your odds of reaching the goal (an estimate, with its method), what could change them, and the exit. |
| "How is Bearing neutral if you earn fees?" | Bearing is never paid by, and never curates for, the protocols it measures. The method and samples are public. |
| "Is this financial advice?" | No. It builds and explains a plan from the goal you set. The disclaimer is on every plan. |

---

## 6. Narrative arc (video and deck)

| Beat | Content | Visual cue |
|---|---|---|
| **Setup** | Portfolios start from ideas: themes, narratives, models. You pick one and fit yourself to it | A rack of identical pre-cut parts |
| **Tension** | None asks what your money must do, and none tells you whether you can get out. Tokenized doesn't mean liquid | A piece that won't come out of its slot |
| **Resolution** | Tell [Name] the goal. It works backwards, plans the exit first, builds the fit, and shows every joint | Two species apart → slide → lock → pin. The exploded view of the plan with the exit marked |
| **Transformation** | "Your apartment fund is on track for June 2028. Cash reachable within a week." | Locked joint, light through. End card: tagline A |

---

## 7. Claims guardrails (non-negotiable)
- No return or outcome claims. "Up to" is banned. **The odds of reaching a goal are an estimate**, shown with method and as-of date, never "you will reach".
- The exit plan states measured capacity and cost **as of a date**, never "instant" or "guaranteed liquidity".
- Every number in marketing is real with its pin, or marked **illustrative**. MOCK is always labelled.
- Competitors are named only in decks, judge materials and internal docs, never in public product copy.
- Prior-work statistic (2–5.6x) cited as the founder's prior analytics.
- Brazil and LatAm are partners, not the frame.


---
**Founder edit (2026-10-01):** manifesto / hero headline changed to "No product fits everyone. So we make the pieces — and your goals decide how they fit." The user is the one who decides the fit; the tagline "Made to measure. Every joint shown." is unchanged.
