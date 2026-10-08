# Voice & Tone
> Phase: strategy | Brand: working-brand ([Name] TBD, see naming.md) | Generated: 2026-10-01

**Voice (founder-confirmed): Clear, candid, kind.**

**Reference line:**
> "You're on track for June 2028. If rates fall by a third, you'd land in September instead — we'd tell you in March, not in August."

That one line does all three things. It is **clear** (the answer comes first, with a date). It is **candid** (it states a named downside with its consequence). It is **kind** (it makes a promise to warn early, so the person is looked after, not just informed). Every piece of copy should be checkable against it.

---

## 1. Voice attributes

### Clear
| | |
|---|---|
| **Means** | The answer comes first, in plain words, with a date or an amount. One idea per sentence. Jargon only one layer down, and defined once. The goal is called by its name |
| **Doesn't mean** | Dumbed down, vague or slogan-like. Clear is not short at all costs: a precise 20-word sentence beats a fuzzy 6-word one |
| **Do** | "On track · June 2028." / "You can get up to $4,000 out within a day, and the rest within a week." (illustrative) |
| **Don't** | "Your portfolio is optimally positioned across diversified yield sources." / "Smart money, simplified." |

### Candid
| | |
|---|---|
| **Means** | We say the downside out loud, early, with its consequence. Every number carries where it came from. We separate measured from estimated from MOCK. We say "I don't know yet" and "this goal can't be met as set" when they're true |
| **Doesn't mean** | Alarmist, hedged into mush, or a wall of disclaimers. Candour is specific: one named risk with its effect beats ten generic warnings |
| **Do** | "If rates fall by a third, you'd land in September instead." / "This figure is a MOCK. The live feed isn't connected yet." / "Quoted at 9.1%. After the credit haircut we use 6.4%. Here's why." (illustrative) |
| **Don't** | "Earn up to 12% APY." / "Returns may vary." (true but useless) / "Risk-free." / "Guaranteed." |

### Kind
| | |
|---|---|
| **Means** | We write to one person about their goal, and we look after them. We warn early, offer options rather than verdicts, never shame, and never pressure. Warmth comes from attention, not adjectives |
| **Doesn't mean** | Cute, chummy, gushy or reassuring without facts. No "Yay!", no "Don't worry!", no "bestie". Kind is not soft on the truth (see Candid) |
| **Do** | "Your apartment fund is on track." / "Rates dipped this month, so I moved a little into treasuries. You're still landing in June 2028." / "This goal doesn't fit as set. Here are three ways to make it fit." |
| **Don't** | "Oops! Something went wrong 😅" / "You're falling behind on your dream." / "Act now — rates won't last!" |

### How the three resolve conflicts
- **Candid beats kind on facts.** Never soften a number. **Kind beats candid on delivery.** Lead with what the person can do about it.
- **Clear beats both on structure.** Answer, then reason, then risk.

---

## 2. Tone spectrum

Defaults (1–5):
```
Formal        1 ── 2 ──[3]── 4 ── 5  Casual        plain and conversational, never slangy
Serious       1 ──[2]── 3 ── 4 ── 5  Playful       it's someone's money and their plans
Authoritative 1 ── 2 ──[3]── 4 ── 5  Friendly      expert who is on your side
Technical     1 ── 2 ── 3 ──[4]── 5  Simple        simple first layer, technical on demand
Reserved      1 ──[2]── 3 ── 4 ── 5  Enthusiastic  calm; confidence comes from shown work
```

### Context shifts
| Context | Formal↔Casual | Serious↔Playful | Auth↔Friendly | Tech↔Simple | Notes |
|---|:-:|:-:|:-:|:-:|---|
| Consumer plan view (goal hero) | 3 | 2 | 4 | 5 | One sentence, the goal by name, the date. Serif display |
| Goal intake / chat | 4 | 2 | 4 | 5 | Ask, confirm, play back the constraint sheet |
| Constraint sheet validation error | 3 | 1 | 4 | 4 | "Doesn't fit" plus what to change. Never blame |
| Off-track / at-risk alert | 2 | 1 | 3 | 4 | Fact, consequence, options, by when. No adjectives |
| Rebalance (re-true) log line | 2 | 1 | 3 | 3 | What moved, why, source, explorer link. First person |
| Success (on track, executed) | 3 | 2 | 4 | 5 | Brief, factual, no confetti |
| MOCK / stale state | 2 | 1 | 3 | 3 | Always the word MOCK or stale, plus what is missing |
| Embed (inside partner app) | partner's | 1–2 | partner's | 5 | Inherit the partner's register. Keep provenance, MOCK and disclaimer wording verbatim |
| API docs | 2 | 1 | 2 | 1 | Precise, exhaustive, example-led. Plex Mono |
| [Name] Bearing (risk) | 2 | 1 | 2 | 1 | Instrument language: units, n=, version, method. No adjectives about risk |
| Marketing site / video | 3 | 2 | 3 | 4 | The manifesto voice. Bold claims about fit and visibility, never about returns |
| Social (X) | 4 | 3 | 4 | 4 | Show receipts: transactions, methods, real plan screenshots. Dry wit allowed, hype never |
| Legal / disclaimer | 1 | 1 | 2 | 3 | The single DISCLAIMER constant, unedited |

---

## 3. Do / Don't chart (by situation)

| Situation | Do | Don't |
|---|---|---|
| Headline yield | "6.4% after haircut ⌖" (pin opens: source · fetched_at · method) | "Earn up to 9.1% APY!" |
| On track | "Your apartment fund is on track for June 2028." | "Great job! You're crushing it 🎉" |
| At risk | "Rates fell 0.8 pts this month. At this level you'd land in August, two months late. You can add $150/month, accept August, or move the date." (illustrative) | "Warning: underperformance detected." / "Don't panic!" |
| Can't meet goal | "As set, this goal doesn't fit: 12% with a one-week exit isn't available without risk you've ruled out. Here's the closest fit, and what changes." | "Sorry, we can't do that." / quietly lowering the target |
| Rebalance | "I moved $1,200 from USDC to USDY because rates dipped and your June date needs a little more income. Source ⌖ · Tx ↗" (illustrative) | "Portfolio auto-optimised." |
| MOCK data | "MOCK · Kamino rate feed not connected yet. Plan shown for layout only." | Showing the mock figure styled like a live one |
| Exit / liquidity | "You can get about $X out today at under 0.5% cost. Selling all of it at once on a Sunday night would cost more. Here's how much." | "Instant liquidity." |
| Risk product metric | "xAAPL · $1.2M sellable at ≤2% impact · Sun 03:00 UTC · n=412 · method v1.3 ⌖" (illustrative) | "Deep liquidity, low risk." |
| Agent identity | "I proposed this because…" / "Here's what I did and why." | "Your AI wealth genie" / "Sit back and let autopilot do the rest" |
| Partner pitch | "Your users get a plan for what they're saving for. Compliance gets every figure's source." | "Supercharge your earn product with AI." |

---

## 4. Style rules

| Rule | Decision |
|---|---|
| **Person** | **"You"** for the user, always. **"I"** for the agent when reporting its own actions ("I moved…", "I proposed…"). **"We"** for the company and its commitments ("we'd tell you in March", "we publish the method"). Never "our AI" |
| **Contractions** | Yes in consumer and marketing ("you're", "we'd"). No in API docs, the risk product and legal |
| **Sentence length** | Consumer: average 12–15 words, max 25. Docs and risk: as long as precision needs |
| **Order** | Answer → reason → risk → action. Always |
| **Numbers** | Always with a unit and an anchor date. Tabular figures. A yield is "after haircut" unless explicitly labelled "quoted". Every yield, price and FX figure carries the pin (source · fetched_at · method). Round for consumers ("about $4,000"), exact in docs and risk |
| **Dates** | Months by name for goals ("June 2028"). ISO 8601 in docs and logs (`2026-10-01T14:02Z`). Always UTC in risk products |
| **Exclamation marks** | Never |
| **Emoji** | Never, in product or marketing. Glyphs that are part of the system (pin ⌖, external link ↗) are not emoji |
| **Capitalisation** | Sentence case everywhere. **MOCK** in caps (it's a label, not a word) |
| **Oxford comma** | Yes |
| **Hedging** | One precise conditional ("if rates fall by a third…") rather than many soft hedges ("may", "could potentially") |
| **Jargon** | Avoid on the first layer. Define on first use one layer down: haircut, depth, slippage, LTV, constraint sheet. Free use in API docs and Bearing |
| **Metaphor** | **The metaphor lives in the pictures, and plain words live in the product.** The UI says "rebalance", not "re-true". The UI says "source", not "pin". Joinery words belong to marketing, the video and the visual system. Exception: "made to measure" may appear anywhere |
| **Disclaimer** | Never paraphrased. Rendered from the single `DISCLAIMER` constant on the plan view and API docs |
| **Comparisons** | Never name competitors in public copy. Contrast with "the menu", "a rate button", "a model portfolio" |

### Multilingual rules (EN · PT · ES)
- **Register:** PT uses Brazilian Portuguese with **"você"**. ES uses neutral Latin American Spanish with **"tú"**, avoiding regionalisms; adapt to "vos" only on a partner's request. Keep the same answer-first order in all three.
- **"Made to measure"** = **"sob medida"** (PT) / **"a la medida"** (ES). These are natural idioms in both languages, so use them freely.
- **Keep untranslated:** the product name, **[Name] Bearing**, **MOCK**, API field names (`source`, `fetched_at`, `method`) and ticker symbols.
- **Avoid literal carpentry terms in PT/ES copy.** ES *mortaja* (mortise) also means **burial shroud**, and PT and ES *dado* (dado/groove) also means **dice**. Use the visual instead.
- **Numbers and dates are localised** (1.234,56 in PT and ES; "junho de 2028", "junio de 2028"). Provenance timestamps stay ISO and UTC.
- **Length budget:** PT and ES run about 20–30% longer. Consumer headlines are written in EN to about 80% of the available width.

---

## 5. Nomenclature

### Product hierarchy
```
[Name]                          masterbrand (company = product name; no "Labs", "Finance", "AI")
├── [Name]                      the direct app (goal → plan → execute → monitor)
├── [Name] API / Powered by [Name]   the embed and API for partners
└── [Name] Bearing              the liquidity-risk product (exit capacity by size, path, hour of week)
```

### Core terms (use exactly these)
| Term | Meaning | Notes |
|---|---|---|
| **Goal** | What the user wants: amount, date, income, exit window, risk profile | Always named by the user's label ("Apartment fund") |
| **Constraint sheet** | The editable, validated statement of the goal | Consumer UI may say **"Your goal, in detail"**. Docs say `ConstraintSheet` |
| **Plan** | The portfolio solved for the goal, plus path and stress cases | Not "strategy" for a plan. Two scoped exceptions (Thom, Oct 7–8): a vault's target weights as its owner sets and refines them in the vault conversation, and a product shared from that vault, are its "strategy" (gates `MODEL-LED-VAULT-CONVERSATION`, `SHARED-FULL`). A plan made for a goal stays a plan |
| **Leg** | One position in the plan | Consumer UI may say "part of your plan". Never "bet" or "play" |
| **After-haircut yield** | The yield we use, after credit-aware haircut | "Quoted" for the source's number. Never show quoted alone |
| **Exit** / **access to cash** | How much can be withdrawn, how fast, at what cost | Consumer: "access to cash". Docs and Bearing: "exit capacity", "depth" |
| **Stress case** | A named downside scenario with its effect on the goal | Shown with the base case, never hidden |
| **On track / Watch / Off track** | Goal states | Always word + shape + colour, never colour alone |
| **Rebalance** | A move to keep the goal on track | Marketing may say "re-true". Product says "rebalance" |
| **Activity** | The log of agent actions and transactions | Every line has a reason and, for mainnet, an explorer link |
| **Source** (the pin) | source · fetched_at · method for a figure | The pin glyph is the visual. The word is "source" |
| **MOCK** | Not live data | Always the word plus section hatch |
| **Not licensed advice** | Boundary statement | From the `DISCLAIMER` constant only |

### Banned words and phrases
*earn up to · guaranteed · risk-free · safe yield · beat the bank · passive income · set and forget · autopilot · walk away · self-driving · smart (as an adjective for the product) · AI-powered · intelligent · magic · unlock · supercharge · seamless · effortless · revolutionary · best-in-class · bespoke (worn out, so use "made to measure") · to the moon · degen · APY leaderboard · don't miss out · limited time · whale · alpha*

### Feature naming pattern
Plain descriptive nouns, sentence case: *Goal, Plan, Stress cases, Access to cash, Activity, Sources*. No coined feature names and no Japanese terms in product UI. The only branded noun below the masterbrand is **Bearing**.
