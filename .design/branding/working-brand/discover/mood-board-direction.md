# Mood Board Direction: "The Open Joint"
> Phase: discover | Brand: working-brand (unnamed) | Generated: 2026-10-01

> **Superseded on 2026-10-08 by `IDENTITY-2` (docs/GATES.md).** Kept as dated history. The colour, type and shape positions below (wood as the only colour, Source Serif / Newsreader, square cuts, no blue, no gradients) no longer hold; the current system is in `../identity/INDEX.md` and `../patterns/working-brand.yml`. The joinery idea, the pre-lock subject and the anti-patterns (Japanese clichés, Teiten, crypto neon) still stand.

**One direction, not three.** The deadline (Oct 4) and the research both point the same way. The category is 100% digital-abstract and blue/violet/mint, and no one owns material mechanism or provenance-as-identity.

**The Open Joint:** two species of wood, cut precisely for each other, shown a moment before they lock, with the pin visible. Precision expressed as care. Every joint can be opened. The structure frames a view, and the view is the person's goal.

**Mapping to the brief's heartbeat:** *"It fits because it was cut for me"* = the two species cut to each other. *"I can see every joint"* = the exploded view and the visible pin.

---

## 1. Colour: wood species, black ground, daylight

The colours are sampled from the reference images (master.jpg, Yusuhara) and then tuned for contrast. All ratios below were computed against WCAG 2.x. `gsp-color` will re-express them in OKLCH and re-validate.

### Grounds
| Token (working) | Hex | Use |
|---|---|---|
| `ground-dark` (warm black) | **#0D0B09** | Dark mode / risk dashboard ground. Photography may sit on true #000 like master.jpg. UI uses warm black to avoid OLED smear and keep warmth |
| `surface-dark` | **#1A1714** | Panels, cards on dark |
| `surface-dark-2` | **#24201B** | Raised / selected on dark |
| `ground-light` (daylight paper) | **#F6F1E8** | Light mode ground: unbleached, warm, never pure white |
| `surface-light` | **#FBF8F2** | Cards on light |
| `ink` | **#1C1712** | Body text on light (15.8:1 on paper) |

### The two species (the brand's only "brand colours")
| Token | Hex | Sampled from | Contrast | Role |
|---|---|---|---|---|
| `hinoki` (pale species) | **#E6D3B7** | master.jpg pale tenon (#E9D8BF / #E1C9AC) | 13.4:1 on `ground-dark` | Primary text-accent and interactive on dark |
| `hinoki-deep` | **#C9AE86** | hinoki in shadow | 9.2:1 on dark | Secondary on dark, chart high values |
| `hardwood` (dark species) | **#7A5A3A** | master.jpg hardwood face (#8A6C4B / #816342) | 5.6:1 on paper | Primary interactive (links, buttons) on light. AA for text |
| `heartwood` | **#5A3A1E** | master.jpg right block (#5E3819) | 9.1:1 on paper | Strong emphasis on light, pressed states |

**The rule:** the identity comes from the **contrast of two woods**, pale against dark. It never comes from one bright accent. No saturated "brand colour" exists. That is the clearest break from every competitor (#2D6AE7, #7180F5, #4A46BD, #BBF2D6, #C4F29B).

### Neutral and line
| Token | Light | Dark |
|---|---|---|
| `stone` (muted text) | **#6E655B** (5.1:1) | **#A49A8E** (7.1:1) |
| `hairline` (rules, grid, dimension lines) | **#D9CDBB** | **#3A322A** |

### Semantic (goal state). Always paired with a word and a shape, never colour alone.
| State | Light | Dark | Note |
|---|---|---|---|
| **Holds / on track** | `forest` **#2F4A2A** (8.8:1) | **#7FA37A** (6.9:1) | From the Yusuhara forest (#2F3D23). Deliberately *not* P&L green |
| **Watch / at risk** | `ochre` **#8A5A00** (5.3:1) | **#D9A441** (8.7:1) | Earth ochre. Not Bitcoin orange |
| **Off track / critical** | `madder` **#A8324A** (5.8:1) | **#E58AA0** (7.9:1) | Cool madder (hue ≈ 345°). **Kept away from cinnabar (Teiten) and seal-red (Japanese cliché)**, which both sit around 0–20° |
| **MOCK** | `stone` + section-hatch pattern + the word **MOCK** | same | See motifs. Colour is never the only signal |

### Daylight
- `sky` **#CAE3F4** (Yusuhara sky) is for **photography and illustration atmosphere only**, never UI, because blue is the category colour.

### Banned colour moves
Blue/indigo/violet primaries or gradients. Mint/lime. Neon. Cinnabar / vermilion / seal-red. Gold foil. Glass blur. Pure-white ground in light mode (use daylight paper).

---

## 2. Typography

Every competitor uses a geometric or neo-grotesk sans (Söhne, PP Telegraph, At Aero, Inter, Satoshi, Plus Jakarta, Gelix). We need a sans for UI anyway, so pick one that is *engineered but humanist*, and add a serif voice for the personal register. Everything below is free (OFL), has latin-ext coverage (EN/PT/ES with ã õ ç ñ ¿ ¡ á é í ó ú ü), has tabular figures, and can ship before Oct 4.

| Role | Typeface | Why |
|---|---|---|
| **UI and body** | **IBM Plex Sans** (plus **Plex Sans Condensed** for dense tables) | Engineered with visible "cut" details (the angled terminals read as tooling marks), warm for a grotesk, with excellent latin-ext and tabular figures. The Condensed width makes the risk dashboard fit without a second family. Not used by any competitor in the set |
| **Numbers, provenance, code, API docs** | **IBM Plex Mono** | Provenance lines (`source · fetched_at · method`), explorer hashes, OpenAPI. Shares DNA with Plex Sans, so one system |
| **Display (consumer and marketing only)** | **Source Serif 4** (Display optical size, upright only) | Sharp, bracketed wedge serifs read as *cut*, not as calligraphy. Gives the "personal letter" register for "Your apartment fund is on track." Upright only: Wealthfront owns the serif-italic flourish |

- **Paid upgrade path (post-hackathon, optional):** Klim **Signifier** (display) + Klim **Untitled Sans** or **National 2** (UI). Same logic, more ownable. **Avoid** Söhne (Gauntlet), Inter (Chaos, Peaks), Satoshi (Nexa), Plus Jakarta (Peaks), and anything pixel, dot-matrix or monospace-led for headlines (Teiten / retro-OS).
- **Usage rules:** sentence case everywhere. The serif never appears in the embed or the risk dashboard. Numbers always tabular. The serif's on-track headline is the *one* place for emotional weight.
- `gsp-typography` owns pairing, scale and rhythm verification.

---

## 3. Imagery: photography of mechanism, drawings of logic

**Two image modes, strictly separated.**

### A. Photography (the material). Marketing, video, consumer hero, partner decks.
- **Subject:** real joints, two species, cut faces and end-grain, the pin. Shot *apart* (pre-lock) and *locked*. Secondary: daylight timber interiors that **frame a view** (photo9.avif logic: the structure frames the forest, and the plan frames the person's goal).
- **Light:** one hard, warm, raking key light from upper left. Deep shadow. On **pure black seamless** (dark) or **overcast daylight** (light).
- **Lens:** macro and short-tele, with a shallow plane of focus on the cut.
- **People:** only hands, measuring, fitting, sliding a piece. No faces staring at phones, no handshakes, no piggy banks, no lifestyle couples.
- **Production reality for Oct 4:** reference images (master.jpg, the Kuma photos, the temple brackets) are **mood only and almost certainly not licensed for use**. Buy a physical interlocking joint (a kigumi sample or joint-puzzle set made of two species) and shoot it on black with one lamp. That is about one afternoon and yields the hero, video b-roll and social. **Do not use 3D renders**: renders are the category trope (Glider's glass toggle).

### B. Drawing (the logic). Product UI, docs, explanations, risk dashboard.
- **Exploded-view / assembly line drawings** in hairlines (1px at 1x, `hairline` colour, with key edges in `hardwood` or `hinoki`). Axonometric for marketing, orthographic (flat) inside the product.
- **Dimension lines** for constraints: the goal drawn as a dimension line from *today* to *June 2028* with the amount at the arrowhead.
- **Numbered callouts** connect each leg of the portfolio to its risk sheet ("① USDY · 42% · source ↗").
- No isometric cartoon people, no blob illustrations, no blueprint-blue.

`gsp-visuals/domains/imagery.md` will formalise the vocabulary. The intent is **photographic mode = material truth, line mode = structural truth**.

---

## 4. Motifs and their product meaning

Each motif maps to a product function. If a motif has no function, it doesn't ship.

| Motif | Meaning | Where it appears |
|---|---|---|
| **The pin** | **Provenance.** What makes the joint hold, visible from outside | A small pin glyph after **every** yield/price/FX figure. Tap or hover opens `source · fetched_at · method`. Survives in the white-label embed |
| **Tenon** (the protruding piece) | A **leg / position**: one asset cut to fit | Leg cards in the plan, allocation bars with a square "tenon" end |
| **Notch / mortise** (the receiving cut) | The **constraint**: the space the goal leaves (date, amount, liquidity window, risk profile) | ConstraintSheet fields drawn as slots the legs must fit. A validation error = "doesn't fit", shown with the slot outlined in madder |
| **Exploded view** | **Explain**: open the joint | "Why this plan?" expands the plan into its legs apart, with callouts, and closes back to the locked state |
| **Lattice** | **Structure and measurement** | Layout grid. Risk dashboard's 24×7 **hour-of-week depth heatmap** is literally a lattice (the GC Prostho grid) |
| **Section hatch** (45° hairline) | **Not real timber**: MOCK, estimated or stale | MOCK badges and mocked fields, hatched plus the word MOCK. Stale data (fetched_at older than threshold) gets hatch plus "stale" |
| **Dimension line** | **Goal and time** | Goal timeline, liquidity window ("exit ≤ 7 days" as a short dimension) |
| **Offset stack / cantilever** | **Balance**: many small pieces carry a large load | Marketing compositions only (Yusuhara, photo9): blocks offset by one column |

**Hard no:** LEGO studs, jigsaw puzzle pieces, gears, coins, kanji, brush strokes, seal stamps, torii, blossoms, wood-grain wallpaper, bevelled panels, nameplates, screws.

---

## 5. Layout grid

- **Lattice grid:** 12 columns, 4px base unit, 8px rhythm. On marketing and docs, the grid can be *shown* as hairlines (like timber members) at section level, but never inside dense UI.
- **Square-cut geometry:** radius 0–2px for brand surfaces. Joinery is square. In the embed, inherit the partner's radius.
- **Members, not cards:** content blocks are separated by hairline rules and alignment, not shadows or floating cards. No drop shadows, no glass.
- **Consumer surface:** generous negative space. One goal and one sentence above the fold ("On track · June 2028"). Numbers below, with pins.
- **API docs:** two-column. Prose on the left, Plex Mono on the right. Disclaimer constant rendered in a fixed hairline-boxed block, not a footer.
- **Risk dashboard (dense):** dark default, Plex Sans Condensed 12–13px for tables, tabular Mono figures, hairline row rules. Every metric carries a **unit, n=, method version and pin**. Heatmap ramp is single-hue by lightness: #1A1714 → #5A3A1E → #8A6C4B → #C9AE86 → #F2E6D3. Colour-blind safe because it's lightness-led.

---

## 6. Motion: pieces sliding together

- **Primitive:** two members slide along **one shared axis** toward each other, decelerate, and **lock**. Then the pin slides in. That's the whole vocabulary.
- **Timing (starting values for `gsp` motion work):** slide 280–360ms, ease-out `cubic-bezier(0.2, 0, 0, 1)`. The final 2–4px "seat" carries the strongest deceleration. **No bounce, no overshoot, no spring wobble.** Pin follows after a 100–140ms delay over 160ms.
- **Explode / assemble:** "Why this plan?" reverses the lock (pieces part 12–24px along their axes, callouts fade in).
- **Re-truing (rebalance):** one member slides out, the re-cut member slides in, and the log line appears with an explorer link. Calm, legible, one change at a time.
- **Never:** confetti on "on track", counting-up APY tickers, parallax wood, spinning coins, looping ambient blobs.
- **Reduced motion:** all slides become 120ms crossfades, and the pin appears without travel.

---

## 7. Works in all required contexts

| Context | What carries the brand | What recedes |
|---|---|---|
| **Light mode** | Daylight paper, hardwood interactive, ink text | n/a |
| **Dark mode** | Warm black, hinoki interactive and text | n/a |
| **White-label embed** (inside Picnic/Chainless/neobank apps) | **Only the joinery:** the pin glyph and provenance popover, section-hatch MOCK, hairline structure, disclaimer block, optional small "built with [name]" line | Colour, typeface and radius all map to partner tokens. *The joints stay. The wood becomes theirs* |
| **Dense risk dashboard** | Lattice heatmap, hairlines, Plex Condensed and Mono, pin on every number, versioned methods | Photography and the serif are absent. The tone is *measuring instrument as drawing*, never as hardware chassis |
| **Hackathon video** | Real joint photographed apart → slides → locks → pin → cut to the plan's exploded view → lock | n/a |

Accessibility checks this direction already meets: text pairs ≥ 4.5:1 (see tables). Semantic states never rely on colour alone. Focus ring is 2px `hardwood` / `hinoki` with a 2px offset. The provenance popover must be keyboard-reachable and the pin needs an accessible name ("Source for 4.6%").

---

## 8. Naming territories (for strategy)

Category patterns to avoid are in competitive-audit.md §4: motion/ascent words, coined "-a/-o" words, combat names, -Labs/-fi suffixes, AI/yield descriptors, and the already-taken Kigumi, Tsugite, Dovetail and Truss.

| # | Territory | Seed vocabulary (illustrative, not proposals) | Why it fits | Risks |
|---|---|---|---|---|
| **1** | **Joint and pin** (the mechanism) | pin, peg, dowel, tenon, key, wedge, spline, scarf, mortise | Encodes *both* promises: fit (tenon/mortise) and visibility (the pin). The pin is also the provenance glyph | Crowded (Dovetail, Truss, Kigumi taken). "Joint" has a cannabis meaning in EN. "Peg" collides with *stablecoin peg* (could be a clever double meaning, or confusing). Japanese terms risk exoticism and PT/ES pronunciation |
| **2** | **True / plumb / square** (the craftsman's check) | true, trued, plumb, level, square, "aprumo" (PT), "a plomo" (ES) | Maps exactly to the agent's job, *re-truing* the structure, and to honesty. Strong in the risk context | **Square** (Block) is a fintech giant. "True" is near-impossible to trademark alone. Plumb-named companies likely exist **[U]**. Needs coining or compounding |
| **3** | **Fit and measure** (tailoring) | measure, fit, cut, gauge, caliper, "sob medida" (PT), "a medida" (ES) | Most direct expression of "made to measure"; it works in PT/ES idiom | Generic and luxury-coded ("bespoke" is worn out). Nexa already owns personalisation language. "Gauge" sounds near Gauntlet. Tailoring imagery conflicts with the joinery visual |
| **4** | **Structure and load path** | span, bracket, lattice, beam, cantilever, frame, member, keel | Excellent for the **risk layer** (load, depth, what holds). The Yusuhara cantilever story | Reads infrastructural and cold for Mariana. Lattice and Truss taken. Better as a **sub-brand or product noun** than as the masterbrand |
| **5** | **Grain and species** (the material) | grain, heartwood, end-grain, timber, species | Warmth and individuality (no two grains alike = personal fit) | Drifts to eco/lifestyle/furniture. A "Grain" fintech likely exists **[U]**. Species names (hinoki) bring exoticism |

**Recommendation for strategy:** lead with **Territory 1 (joint/pin) crossed with Territory 2 (true)**. Together they say *cut to fit, visibly held, kept true*. Hold **Territory 4** in reserve for the risk-layer product noun under one masterbrand. Given the Oct 4 deadline, use descriptive sub-product names (e.g. "[Name] Depth") rather than a separate sub-brand. Test every candidate for EN/PT/ES pronunciation, negative meanings, .com / .xyz / X-handle availability, and USPTO/INPI/EUIPO class 36 conflicts.

---

### Style Affinity

The research drove this direction. The presets below *partially* validate it. **No preset is a strong match**, and that is itself a finding: the material-joinery direction isn't in the catalogue, so `gsp-style` should build a custom token set and borrow structure from these three.

1. **`humanist-literary`**
   - **Tag matches:** humanist, warm, calm, conversational.
   - **Rationale:** matches the consumer register the research calls for (Mariana 1b wants plain language, a calm on-track statement and no gamification), plus the warm-paper ground and the serif/sans split. **Do not take** its terracotta primary (#DA7756). It sits in cinnabar territory (Teiten risk), and the preset is explicitly the "Claude aesthetic", which would make the brand read as derivative.

2. **`minimal-dark`**
   - **Tag matches:** dark, minimal, layered, amber (warm accent on dark).
   - **Rationale:** the risk dashboard and dark mode need layered warm darkness with a single warm accent, as Priya's instrument-like dashboard calls for. **Do not take** its glass-effect cards, its #0A0A0F cool-black ground (use warm #0D0B09) or its #F59E0B amber (too bright, Bitcoin-adjacent). Replace them with hinoki/hardwood.

3. **`swiss-minimalist`**
   - **Tag matches:** grid, typographic, clean, professional.
   - **Rationale:** the lattice grid, hairline structure and typographic hierarchy behind API docs and the embed (Rafael evaluates by docs quality). **Do not take** its red/blue accents.

**Explicitly rejected presets:** `nothing`, `industrial`, `retro`, `vaporwave` (instrument/retro-OS, too close to **Teiten**); `web3`, `cyberpunk` (crypto neon); `glassmorphism`, `liquid-glass`, `saas`, `enterprise`, `modern-dark` (the category's blue/violet-gradient default); `claymorphism`, `playful-geometric` (cutesy); `organic`, `botanical` (eco/lifestyle drift).
