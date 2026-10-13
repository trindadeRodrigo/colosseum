# Brand Brief

## Brand
- **Name:** working-brand (placeholder slug — **the product has no name yet**; naming is a required output of `/gsp-brand-strategy`, after which this folder is renamed)
- **Date:** 2026-10-01

## Company
- **Company name:** TBD (to be named in strategy)
- **Industry:** Fintech / on-chain finance — goal-based yield on dollar and real-world assets (RWAs), plus liquidity-risk infrastructure
- **Founded:** 2026
- **Size:** Solo founder (background: fixed income, credit structuring, FX hedging, FIDC surveillance)
- **Stage:** mvp — live on Solana mainnet with real money; entering Colosseum Crypto World's Fair (submission Oct 12, 2026); LOIs with Chainless and Picnic
- **Existing brand?** No — the shipped web app (`apps/web`) is unbranded, the embed is deliberately plain

## Brand Mode
- **Mode:** new
- **Reason:** No name, no identity. The product is real; the brand needs to exist before the hackathon video and partner conversations.

### Existing Brand State (evolve only)
N/A — new brand

### Evolution Scope (evolve only)
N/A — new brand

## Business
- **Problem:** People who hold dollars or stablecoins are offered menus: APY leaderboards, "earn 5%" buttons, fixed model portfolios. None answers the question they actually have — *will my specific goal be met, under what risks, and how fast can I get out?* Quoted yields are routinely overstated (the founder's prior analytics found on-chain yield/volume figures off by 2–5.6x), and the liquidity of tokenized stocks and commodities is invisible until you try to sell — or liquidate — them.
- **Solution:** An **agentic, goal-based structurer**. The user states a goal in natural language — a target yield, an amount by a date, a liquidity window, a risk profile. The engine turns it into an explicit, editable constraint sheet, then a deterministic solver builds a **portfolio made to measure for that one goal** across on-chain dollar yield, RWAs (treasuries, credit, tokenized stocks, commodities) and cash. It shows the month-by-month path with stress cases, a risk sheet for every leg with sources and haircuts, executes into the user's own wallet, and then **runs as a policy that rebalances to keep the goal on track**. A separate **liquidity & risk layer** measures how much of an asset can really be turned into dollars, at what cost, at what hour of the week — used internally to size and protect positions, and sold separately.
- **Business model:** AUM fee on assets structured (direct users and partner end-users) + API/SaaS fees (B2B2C embed for neobanks/fintechs; risk-layer API and dashboard for protocols, curators, issuers).
- **Defensibility:** Founder's structuring/credit/FX expertise encoded as a deterministic engine; credit-aware haircuts on quoted yields; a proprietary, time-series liquidity dataset (depth by notional × hour-of-week, collected continuously since Sept 2026, cannot be backfilled); distribution through partner wallets.
- **Three surfaces, one engine:** (1) direct consumer app, (2) embeddable API for neobanks/fintechs, (3) standalone liquidity-risk product. The brand must hold across all three — warm enough for a person's life goal, rigorous enough for a protocol's risk committee.
- **Market:** Global. Brazil/LatAm is where early partners are, not the brand's frame — no regional visual signalling.

## Personas

### Primary 1a: Mariana — the crypto-native diversifier
- **Role:** Independent contractor / remote worker paid in USDC (could be in Lisbon, Lagos, Buenos Aires, São Paulo)
- **Age range:** 26–40
- **Day-in-the-life:** Gets paid in stablecoins, lives in a self-custody wallet, has been through a couple of cycles. Her stables sit idle or scattered across farms she half-trusts. She wants part of her stack in real-world assets — treasuries, credit, some tokenized stocks or gold — without becoming a full-time portfolio manager.
- **Frustration:** Opaque APYs, hidden risks, rebalancing by hand. Every app is a menu, never an answer.
- **Aspiration:** "Tell it what I want — 8% with exit in a week, or this amount in two years — and let it run, safely, where I can see everything."
- **Discovery:** Crypto Twitter/X, Telegram/Discord communities, friends' wallets, protocol dashboards; trusts on-chain proof over marketing.
- **Trust signals:** Self-custody, sources and timestamps on every number, honest downside cases, real transactions with explorer links. Distrusts: hype, guaranteed returns, leaderboards, mascots.

### Primary 1b: Mariana — the life-goal saver
- **Role:** Professional saving toward something concrete — an apartment down payment, a trip, a big purchase
- **Age range:** 28–45
- **Day-in-the-life:** Has dollars (or stablecoins) set aside and a date in mind. Busy; does not want to learn DeFi. Checks progress occasionally, wants to know if she's on track.
- **Frustration:** Products show yields, not whether *her* goal will land — or what happens if rates fall, her currency moves, or she needs cash early.
- **Aspiration:** The private-banker treatment that used to be for the rich: a plan built for her, kept on course, with every assumption visible.
- **Discovery:** Her fintech/neobank app (via partner embed), word of mouth, financial creators.
- **Trust signals:** Plain language, clear "on track / not on track", stress cases shown up front, access to cash stated plainly. Distrusts: jargon, over-promising, gamification of her money.

### Secondary 2: Rafael — Head of Product at a neobank / fintech (B2B2C buyer)
- **Role:** Product lead for savings/earn at a neobank, fintech or self-custody wallet
- **Age range:** 32–45
- **Day-in-the-life:** Owns the roadmap for "earn"; sits between growth, compliance and engineering. Every competitor ships the same "earn 5%" button.
- **Frustration:** Can't build structuring or risk in-house; can't afford to ship something that blows up or that compliance can't defend.
- **Aspiration:** A differentiated, goal-based earn feature behind an API, white-labelled in his app, with risk he can explain to compliance and regulators.
- **Discovery:** Partner intros, conferences, API docs, case studies; evaluates by docs quality and the demo.
- **Trust signals:** Clean OpenAPI docs, provenance on every figure, clear "not licensed advice" boundary, mocks labelled, white-label quality. Distrusts: black boxes, crypto-bro branding he'd be embarrassed to embed.

### Secondary 3: Priya — risk lead at a lending protocol / curator (risk-layer buyer)
- **Role:** Risk lead / curator at a lending market that accepts tokenized stocks or commodities as collateral
- **Age range:** 28–42
- **Day-in-the-life:** Sets LTVs, supply caps, liquidation parameters; answers to governance and depositors.
- **Frustration:** The oracle says the collateral is worth $10M; nobody can say how much can actually be liquidated at 3am on a Sunday, or how fast.
- **Aspiration:** Measured, auditable liquidity numbers — depth by notional, by hour of week, by exit path — she can set parameters from and cite in governance.
- **Discovery:** Risk forums, governance posts, research reports, Gauntlet/Chaos Labs comparisons.
- **Trust signals:** Methodology in the open, raw data reproducible, sample counts, versioned numbers. Distrusts: marketing gloss on risk data.

## Brand Essence

### Emotional Compass
- **brand_heartbeat:** "It fits because it was cut for me — and I trust it because I can see every joint."

### Promise
- **Core promise:** Whenever someone touches this brand they should feel that something was built precisely for them, and that nothing about it is hidden.
- **Functional promise:** Turns a personal goal into a made-to-measure portfolio, keeps it on course, and shows every assumption, source and exit — the hard work of cutting the pieces is done for you; you only bring the need.
- **Emotional promise:** Seen (it's mine, not a template), at ease (it holds), and in control (I can open any joint and see why).

### Point of View
- **Category disagreement:** Finance sells menus — fixed products, model portfolios, APY leaderboards — and asks people to fit themselves to them. And it hides the joinery: haircuts, liquidity, FX gaps, exit costs.
- **Underestimated truth:** A product only fits if it is cut to the person; and trust doesn't come from promises, it comes from being able to see how the pieces hold together. Liquidity is the joint everyone hides.
- **Manifesto line:** "No product fits everyone. So we cut each one to fit — and leave every joint in plain sight."

### Personality
- **Personality:** warm, capable, personal (precision expressed as care, not coldness)
- **Personality reference:** A master joiner who works for you — the quiet confidence of Japanese joinery (Kengo Kuma's lattice), the purpose and humanity of Patagonia / Headspace, the made-to-measure clarity of Nexa
- **Not us:** degen, corporate
- **Never be:** degen/casino (neon, rockets, APY leaderboards, "to the moon"); cold bank/corporate (navy-and-grey, jargon, handshake stock photos); cutesy/gamified (mascots, confetti, streaks); salesy/over-promising (guaranteed returns, urgency, false certainty)
- **Tone:** Warm, plain, specific. Speaks to the person about *their* goal, states numbers with their sources, says the downside out loud. Example: "Your apartment fund is on track. Rates dipped this month, so I moved a little into treasuries — you're still landing in June 2028, with a week's access to cash any time."

## Competitive Landscape
- **Direct competitors:** Glider (non-custodial policy-based portfolios, B2B wallet API, Base); Ondo Intelligent Portfolios (BlackRock-designed income/growth tokens); Peaks (Solana agent portfolio app). Risk layer: Gauntlet, Chaos Labs. Expectation-setters for "goals": Wealthfront, Betterment. Hyper-personalisation reference (TradFi): Nexa Finance.
- **What sets you apart?** (1) Solves for a user-specific goal (amount, date, cash flow, liquidity window) rather than selling a fixed portfolio; (2) credit-aware haircuts on quoted yields; (3) measured liquidity — exit capacity by size, path and hour of week — wired into sizing, stress cases and rebalancing; (4) runs as a transparent policy in the user's own wallet; (5) the risk layer is a product in its own right.
- **Brands admired:** Patagonia, Headspace (purpose, humanity); Nexa Finance (clarity of the hyper-personalisation story); Teiten (founder's own prior brand — admired for being *unique*, taking a reference and polishing it into its own world; **its visual grammar is not to be reused here**).

## Visual Direction
> **2026-10-08 (IDENTITY-2, docs/GATES.md):** the joinery direction stands, but the Oct 1 execution of it (wood as the only colour, warm black, a serif) was replaced on the founder's word by "Honey on night". The governing image for colour is now the daylight timber interior, not master.jpg; master.jpg stays the reference for the *subject* (the pre-lock moment, the pin). See `identity/INDEX.md`.

- **Mood / aesthetic:** **Japanese wood joinery** (kigumi / sashimono / kumimono bracket sets). Precision-cut pieces that lock together without nails or glue — easily, reliably, with balance and beauty. Metaphor: *we cut the self-joining pieces; the client connects them to their needs; the structure comes together and holds.* The joint itself is the transparency: you can see why it holds.
- **Reference links:** `visual-refferences/` (repo root):
  - **`master.jpg` — the governing image.** Two wood species (warm darker hardwood + pale hinoki/spruce) shown *apart, a moment before they lock*, on pure black; every cut exposed, a pin passing through. Shows precision, readiness, and transparency at once.
  - `figure-11-yusuhara-wooden-bridge-museum-structural-detail.jpg` — Kengo Kuma, Yusuhara Wooden Bridge Museum: a cantilevered lattice balanced on a single column; many small pieces carrying a large load; wood against open sky.
  - `images.jpeg` — Kengo Kuma, GC Prostho Museum: an infinite interlocking grid that is both structure and shelving; light passing through.
  - `a2000907_parts_*.webp`, `983a60_*.avif` — temple bracket sets (tokyō/kumimono): complex, stacked, warmly lit joinery; model-scale and full-scale.
  - `photo9.avif` — offset stacked beams framing a view of a forest; warm interior, calm, light.
- **Texture / atmosphere:** Real wood grain and end-grain; warm raking light; deep black or open daylight grounds; exploded-view / assembly-diagram logic (pieces shown apart, then joined); grids and lattices as layout structure; hairline precision; the visible pin, tenon and notch as recurring graphic motifs; calm negative space.
- **Anti-patterns:** Anything that reads as **Teiten** (beveled old-software chassis, instrument nameplates, cinnabar signal) or old-desktop/retro-OS nostalgia; generic fintech (Ondo-style blue gradients, glassmorphism, 3D coins); crypto neon; **Japanese clichés** — no kanji in the logotype, no seal-red, no brush strokes, no cherry blossoms, no torii — the reference is *craft and structure*, not exoticism; no LEGO literalism (the "lego" idea is the mechanism, not the visual); stock photos of handshakes, people staring at phones, or piggy banks.

## Inspiration
- **Styles liked:** Japanese joinery and Kengo Kuma's timber architecture; exploded-view assembly drawings; Patagonia's purposeful, outdoor humanity; Headspace's calm; Nexa's "the ideal product doesn't exist yet — build it" clarity.
- **Styles to avoid:** Ondo and generic RWA/fintech; Teiten's instrument-chassis retro; degen crypto; legacy bank; gamified finance apps.
- **Existing assets:** None. Unbranded MVP in `apps/web` (Next.js) — chat, plan, monitor, embed views; disclaimer constant in `packages/schemas`.

## Constraints
- **Timeline:** Brand (strategy, name, identity, guidelines) **ready by Saturday Oct 4, 2026 at the latest** — ahead of the Oct 9 feature freeze and Oct 12 hackathon submission (video).
- **Budget:** Founder-built; no agency.
- **Must-haves:** Multilingual (English + Portuguese + Spanish, with latin-ext glyph coverage); light and dark mode; works as a **white-label / embeddable** surface inside partner apps (the brand must recede gracefully when embedded); WCAG 2.2 AA; must scale from a consumer goal card to an API docs page to a risk dashboard.
- **Non-negotiables:** Provenance on every yield/price/FX figure (source, fetched_at, method) is part of the visual language, not fine print; anything mocked is labelled **MOCK** and never displayed as live; never presented as licensed advice (single disclaimer constant, shown on the plan view and API docs); no guaranteed-return language; every mainnet transaction shown with its explorer link.

## Goals
- **Business goal:** Win/place in Colosseum (Solana track + Superteam Brasil); convert LOIs (Chainless, Picnic) into pilots; first risk-layer conversations with lending protocols.
- **Brand goal:** A name and an identity distinctive enough that a judge, a partner PM and a risk lead each remember it after one viewing — and that makes "made to measure + transparent" felt, not claimed.
- **Success metrics:** Name chosen and domain/handle available; identity applied to `apps/web` before Oct 9 freeze; video uses the brand end-to-end; partners willing to show the embed in their app.

## Deliverables
- [ ] Discovery & research
- [ ] Brand strategy & voice (**including naming**)
- [ ] Visual identity
- [ ] Design system

## Notes
- **Naming is in scope for strategy.** Should evoke made-to-measure / fit / joinery / precision without literal Japanese words being mandatory; must work in EN/PT/ES; check domain and X handle availability. (Teiten's naming took five rounds — budget for iteration but the Oct 4 deadline is firm.)
- **Brand architecture question for strategy:** one masterbrand across the consumer app, the embed and the risk layer, or a sub-brand for the risk product? The joinery metaphor naturally supports a family (pieces / joints / structure).
- **Agentic framing:** the agent is the craftsman who cuts and keeps the joints true (rebalancing = re-truing the structure), never a personified mascot.
- Product rules from `CLAUDE.md` apply to brand surfaces: xStocks ineligible for income goals, mocks labelled, disclaimer in one constant.
- Tech stack for later phases: Next.js (`apps/web`), Fastify + OpenAPI (`apps/api`), pnpm monorepo.
