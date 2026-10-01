# Style

## Brand: Tenonfi
**Style:** working-brand ("The Open Joint") | **Generated:** 2026-10-01

> STYLE.md is the single document designer and builder agents consume. It is rendered from [working-brand.yml](./working-brand.yml), plus the philosophy (strategy) and the bold bets (identity). If this file and the `.yml` disagree, the `.yml` wins. Display name **Tenonfi** is provisional (fallback "Tenon"); the wordmark is always lowercase `tenonfi`.

---

## Binding rules (read before anything else)

These are product rules expressed as design. A screen that breaks one of them is wrong, however good it looks.

1. **Provenance pin on every number.** Every yield, price and FX figure is followed by the provenance pin (the tenon end with its pin), which opens `source · fetched_at · method`. No pin, no number.
2. **MOCK is never shown as live.** Mocked, sandboxed or stubbed data carries the 45° section hatch **and** the word **MOCK**, together, every time (the API carries `"provenance": "mock"`). Text never sits on hatch strokes: the value and the label go on a solid plate. Stale data gets a hollow pin plus the word "stale" and its age.
3. **The disclaimer is never omitted, and the brand is never presented as advice.** The disclaimer renders from the single `DISCLAIMER` constant, unedited, on the plan view and in the API docs, at body size, in a hairline box. No return promises: no "earn up to", "guaranteed" or "risk-free".
4. **No Japanese clichés.** The reference is joinery as craft and structure, not culture as costume. No kanji or kana, torii, ensō, hanko or seal-red, sakura, waves, brush type, washi texture, asanoha, kikkō or seigaiha, and no Japanese words in product UI.
5. **Nothing like Teiten.** No bevelled chassis, instrument nameplates, LEDs, screws, retro-OS panels, mono-led headlines or cinnabar signal. Bearing is an instrument *drawn as a drawing*, not hardware.
6. **No blue or violet.** Not for links, info states, charts or focus rings. Wood is the only colour. Status pigments (forest, ochre, madder) are earth colours and always come with a word and a shape.
7. **The brand recedes in the embed.** Inside a partner app, the partner's colours, font, radius and buttons take over. What survives: the pin and its popover, hatch + MOCK, hairline structure, the disclaimer block, explorer links, and a "Powered by tenonfi" credit in the partner's muted colour.

---

## Intensity

| Dial | Value | Meaning |
|------|-------|---------|
| Variance | 3 | A strict 12-column grid, flush left. Asymmetry comes only from one-column P2 offsets and the empty third in heroes |
| Motion | 3 | One vocabulary: slide on one axis, seat, then the pin drops. Purposeful, never ambient |
| Density | 4 | Consumer surfaces are airy (one goal and one sentence above the fold). Bearing is tight (13 px type, 28 px rows). Docs sit in between |

---

## Philosophy

A master joiner who works for you: they measure you first, cut the pieces for your goal alone, and leave every joint where you can see it. The design should feel like **a joint photographed a moment before it locks**: one material in two species, pale against dark, on warm black or daylight paper, with every cut exposed. Knowledge is shown as something you can open (an exploded view, a visible pin, a hatched section that admits it isn't finished timber), never as a gradient or a glowing dashboard.

It takes the Sage's structure (Swiss grid discipline, hairlines, tabular figures), the Caregiver's warmth (warm paper, a humanist serif that speaks to one person about one goal, calm motion) and declines the Caregiver's roundness, because joinery is square. Calm comes from shown work, not from adjectives: **the serif gives the answer, the sans explains, the mono cites.**

---

## Patterns

### Card
| Property | Rule |
|----------|------|
| border | 1px solid `--border` (hair `#D9CDBB` / hair-d `#3A322A`) |
| shadow | none. Depth comes from layers and hairlines |
| radius | 2px (`--radius`). 0 for table panels |
| background | `--card`: paper-raised `#FBF8F2` (lighter than ground, a planed face) / char `#1A1714` |
| padding | 24px for consumer and docs, 16px for Bearing tiles |
| rule | At most one Newsreader line per card. No photography and no pattern inside |

### Button (primary)
| Property | Rule |
|----------|------|
| background | `--primary`: hardwood `#7A5A3A` / hinoki `#E6D3B7`. Hover: wood-600 `#63482E` / `#D7C09E`. Pressed: heartwood `#5A3A1E` / hinoki-deep `#C9AE86` |
| border | none |
| text | IBM Plex Sans 500, 15–16px, sentence case, `--primary-foreground` (paper-raised / black) |
| radius | 2px. Never a pill |
| height | 40px default, 32px dense |
| rule | One primary per view. Consumer flows prefer a hardwood underlined link ("See your plan") |

### Button (secondary)
| Property | Rule |
|----------|------|
| background | transparent |
| border | 1px solid `--input` (member `#8C7F70` / member-d `#7A6D5F`). A control edge must be seen |
| text | Plex Sans 500, sentence case, `--foreground` |
| radius | 2px |
| hover | Border and text go to `--primary` |

### Input
| Property | Rule |
|----------|------|
| border | 1px solid `--input` (member / member-d: ≥ 3.14:1 on every ground) |
| radius | 2px |
| background | `--muted` (paper-sunk `#EDE6DA` / char-2 `#24201B`): the input well |
| focus | 2px solid `--ring` outline with 2px offset. The border is unchanged. No glow |
| error | Border in `--destructive`, plus a sentence that says what to change ("doesn't fit"). Never blame the user |
| label | Plex Sans 500 caption above the field. Never placeholder-only |

### Badge
| Property | Rule |
|----------|------|
| shape | Square, 0 radius, 20px tall |
| text | Plex Sans 500 caption (12.5px), sentence case |
| status | **On track:** solid square, forest. **Watch:** half-filled square, ochre. **Off track:** notched square outline, madder. Background is the 50 tint (light) or 950 (dark). Always the word |
| MOCK | Plex Mono 500, 12.5px, uppercase, 0.08em tracking. Ink on paper-raised (washi on char), 1px stone border, beside a 6px hatch band |

### Navigation
| Property | Rule |
|----------|------|
| style | A plain horizontal bar on `--background` with a 1px hairline at the bottom. Symbol + wordmark on the left. No glass, no blur |
| links | Plex Sans 500, 15px, `--muted-foreground`, turning `--foreground` on hover. Active: foreground plus a 2px `--primary` underline at 6px offset |
| docs | Left sidebar on `--sidebar` with a 1px `--sidebar-border` right edge. P1 coarse kumiko in the page margins only |

### Layout
| Property | Rule |
|----------|------|
| archetype | **asymmetric-grid** |
| max-width | 1280px page, 66ch body, 72ch docs prose, 18ch display |
| section-spacing | 96px marketing, 64px docs and plan, 32px Bearing panels |
| grid-gap | 24px (16px in Bearing) |
| surfaces | Flat paper or warm black. Marketing alternates them as inverted sections (about 60% ground, 30% ink and hairline, 10% wood). P1 coarse kumiko on marketing section grounds, on `::before` only |
| decoration | Hairline rules, P2 stepped dividers at section ends, dimension lines (45° ticks, Plex Mono values) and square numbered callout tags |

### Provenance pin (brand-specific)
| Property | Rule |
|----------|------|
| placement | After every yield, price and FX figure, at cap height, with a U+202F thin no-break space before it |
| live | Solid pin. Outline in stone `#6E655B` / stone-d `#A49A8E`; pin in hardwood (light) or hinoki (dark) |
| stale | Hollow pin (1.5px ring) **plus "stale · 3 h"**. Never without the word: live and stale differ by only 1.10:1 in luminance |
| MOCK | No pin. The tenon is filled with a 3px-pitch hatch, **plus MOCK** |
| popover | Plex Mono: `source · fetched_at (ISO, UTC) · method`, on paper-raised / char-2 with a 1px border |
| a11y | `<button aria-label="Source for 6.4%">` (with ", stale, 3 hours old" or ", mock data" appended), a 24×24 hit area, and Enter opens it |
| embed | The pin takes the partner's muted text colour |

### Goal card, plan leg, disclaimer, embed, Bearing tile
| Component | Rule |
|----------|------|
| goal card | Newsreader 400 goal sentence → status square + word + date (Plex Sans 500) → "$12,480 of $40,000 ⊡ · access to cash within 7 days" (tabular) → one hardwood underlined link. No photography, patterns, leaderboards, big APY or progress rings |
| plan leg | A stacked horizontal bar, at most 4 legs, with a 2px ground-colour gap between segments and 0 radius. **Light:** hardwood, heartwood, **wood-400 `#9D7751`**, stone. **Dark:** hinoki, hinoki-deep, wood-400, stone-d. Every leg has a direct label (leg · weight · after-haircut yield ⊡ · "quoted x%" in stone). A MOCK leg is hatched, and its label sits on a solid plate |
| disclaimer | The `DISCLAIMER` constant verbatim, in a hairline box directly under the plan and at the top of the API reference. Plex Sans 400 at body size (≥ 1em in the embed) |
| embed | Partner skin. The pin, hatch + MOCK, hairlines, disclaimer, explorer links and "Powered by" survive. Sizes are in em on a 1.2 ratio, with container queries |
| Bearing tile | b-head label (Condensed 500) → b-kpi value (Plex Mono 500) + pin → b-meta line (unit · n= · method version · as-of UTC). char on black, 1px hair-d, 0 radius, 16px padding |

---

## Constraints

### Never
- A yield, price or FX figure without its provenance pin. It breaks the core promise ("every joint shown").
- A mock shown as live, a MOCK figure without hatch and the word, or text set on hatch strokes (ink on stone is 3.11:1, which fails).
- The hatch used for anything but MOCK or stale, or any diagonal other than the hatch.
- Omitting, shrinking or paraphrasing the disclaimer, presenting the brand as licensed advice, or promising returns.
- Blue, indigo or violet anywhere in UI. Blue is the category's colour.
- Mint, lime, neon, gradients, glass, blur, glow, ambient orbs, gold foil, or amber `#F59E0B`.
- Cinnabar, vermilion or seal-red, a red pin, or pure `#FFFFFF` / `#000000` UI grounds.
- Japanese clichés (see binding rule 4).
- Anything like Teiten (see binding rule 5).
- Hardwood on dark grounds (2.58–3.13:1), or hinoki-deep as a plan-leg fill on paper (1.89:1). Use wood-400 `#9D7751`.
- A status shown by colour alone. "Watch" ochre is 1.06:1 against hardwood, so the word and the half-filled square carry it.
- Patterns behind numbers, text, form fields, charts, the provenance popover or the disclaimer. They stop at least one grid unit away.
- Radius above 2px, pills, circles as containers (round belongs to the pin and the composer's send button alone), or drop shadows. **Sole exception (founder, 2026-10-01):** the typing box. The goal composer container and the subscribe field use `--tf-radius-composer` (20px), with a round 36px send button inside. Nothing else softens.
- Newsreader in the embed, in Bearing, in tables, buttons or labels, or on pinned numbers. Newsreader bold or italic.
- Light font weights, uppercase other than the word MOCK, or centred or justified body text.
- Wood-grain textures as UI backgrounds, text set on photographs, gradient scrims or duotones.
- Bounce, spring, overshoot, confetti, counting-up figures, parallax or ambient loops.
- The Sparkles, Wand, Rocket, Coins, TrendingUp or Shield-as-promise icons, RefreshCw for rebalance, emoji, or exclamation marks.
- Brand colour, the serif, patterns or photography inside the partner embed.

### Always
- The species rule: the brand wood is hardwood on paper and hinoki on warm black, and the pin is the species opposite the ground.
- Light and dark as peers. Every component ships both and passes WCAG 2.2 AA in both.
- Status = word + shape + colour (solid, half or notched square).
- MOCK = hatch + a MOCK label on a solid plate (ink on paper-raised or washi on char, 1px stone border).
- Stale = a hollow pin + the word "stale" + its age.
- The disclaimer from the single `DISCLAIMER` constant, on the plan view and in API docs.
- Newsreader spent once per screen, for the answer to a person. Plex Sans explains. Plex Mono cites.
- Tabular lining figures, a true minus (U+2212), and `Intl` formatting with 2 decimals on yields.
- Controls edged in member / member-d. Hair / hair-d is for decoration only.
- A 2px focus ring in the brand species, at 2px offset, on every interactive element.
- The 4px grid. Line heights snap to multiples of 4.
- Dashed = projected, solid = measured or live, everywhere.
- Every mainnet transaction line with its explorer link (Plex Mono, "Tx ↗").
- Flush left, ragged right, sentence case.

---

## Effects

**Interaction vocabulary:** seat-slide, pin-drop, hairline-deepen, species-press, underline-draw, part-and-close, crossfade-reduced

### Hover
| Element | Technique | Description |
|---------|-----------|-------------|
| card | hairline-deepen | The border goes from hair to member (hair-d to member-d). No lift, no shadow |
| button | species-press | The primary fill goes to wood-600 `#63482E` (light) or `#D7C09E` (dark) |
| link | underline-draw | The 1px underline thickens to 2px. The colour stays hardwood / hinoki |
| row | — | The background goes to `--accent` (paper-sunk / char-2) |

### Active
| Element | Technique | Description |
|---------|-----------|-------------|
| button | species-press | Heartwood (light) or hinoki-deep (dark). No scale, no translate |

### Focus
| Element | Rule |
|---------|------|
| general | A 2px solid `--ring` outline, 2px offset, square corners |
| pin | The same ring around the 24×24 hit area. Enter opens the popover |

### Transition
160ms for colour and opacity, 320ms for slides, all on `cubic-bezier(0.2, 0, 0, 1)` (`--ease-seat`). Motion animates `transform` and `opacity` only.

### Choreography (not ambient: event-driven only)
- **plan-lock:** legs fade in at their exploded positions (160ms, 60ms stagger), slide and seat (280–360ms), and then the pin drops 120ms later over 160ms.
- **part-and-close ("Why this plan?"):** pieces part 12–24px on their axes, callouts fade in, then the pieces close back to locked.
- **loader ("the lattice assembles"):** a 3×3 P1-medium lattice. The horizontals slide in on x, then the verticals drop on y, 240ms each with a 60ms stagger, then a 400ms hold. Only for waits over 400ms, with a text label and `role="status"`.
- **reduced motion:** every slide becomes a 120ms crossfade, the pin appears without travel, and the loader is a static lattice with its label.

---

## Bold Bets

1. **The provenance pin is the brand's smallest logo.** The tenon end with its pin, drawn in line mode, follows every figure at cap height (`viewBox 0 0 18 12`, `height: .75em`). It has three states (solid, hollow + "stale", hatched + MOCK) and opens `source · fetched_at · method`. The logo is a through-tenon, so when the brand recedes in the embed, only the pin is left, and it is still the brand.
2. **The section hatch is a word, not a texture.** A 45° hatch (1px stone strokes, 6px pitch; 3px in glyphs) means one thing only: *not finished timber* (MOCK or stale). It always travels with the word, fills a 6px edge band or frame margin, and never sits under text. A DOM test fails the build if P4 appears without MOCK or stale in the same component.
3. **One material, two species, swapped by ground.** There is no accent hue. Hardwood on paper and hinoki on warm black take every interactive, focus and key-member role, and the pin is always the opposite species. Status pigments are earth colours (forest, ochre, madder), each locked to a word and a shape.
4. **Kumiko as structure, never ornament.** A hairline half-lap lattice (P1) makes the 12-column grid visible on marketing section grounds and docs margins, at 24px only for loading and empty states. It sits on a `::before` layer and stops one grid unit short of any figure.
5. **The serif is spent once per screen.** Newsreader 400 at Display optical size carries the single sentence addressed to a person ("Your apartment fund is on track.") and nothing else. Everything else is Plex Sans (explains) and Plex Mono (cites), with tabular figures throughout.

---

## Implementation

### Component code hints (Tailwind v4)

```css
/* apps/web/app/globals.css — tokens via @theme, values from working-brand.yml */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  --color-background: var(--background);   --color-foreground: var(--foreground);
  --color-card: var(--card);               --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-muted: var(--muted);             --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);           --color-border: var(--border);
  --color-input: var(--input);             --color-ring: var(--ring);
  --color-destructive: var(--destructive);
  --color-success: var(--success);         --color-warning: var(--warning);
  --color-leg-1: var(--chart-1); --color-leg-2: var(--chart-2);
  --color-leg-3: var(--chart-3); --color-leg-4: var(--chart-4);
  --radius-sm: 0px; --radius-md: var(--radius); --radius-lg: var(--radius);
  --radius-composer: 20px; --radius-round: 9999px;   /* typing box only: composer + subscribe field */
  --font-display: "Newsreader Variable", "Newsreader Fallback", Georgia, serif;
  --font-sans: "IBM Plex Sans", "Plex Sans Fallback", system-ui, Arial, sans-serif;
  --font-condensed: "IBM Plex Sans Condensed", "IBM Plex Sans", "Arial Narrow", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --ease-seat: cubic-bezier(0.2, 0, 0, 1);
}
```

| Component | Classes |
|---|---|
| Card | `bg-card border border-border rounded-md p-6` (no `shadow-*`) |
| Primary button | `h-10 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-[var(--tf-primary-hover)] active:bg-[var(--tf-primary-pressed)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` |
| Secondary button | `h-10 px-4 rounded-md border border-input text-foreground font-medium hover:border-primary hover:text-primary` |
| Input | `h-10 px-3 rounded-md bg-muted border border-input text-base tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` |
| Link action | `text-primary underline decoration-1 underline-offset-4 hover:decoration-2` |
| Goal sentence | `font-display font-normal text-[length:var(--text-display)] leading-[var(--lh-display)] tracking-[-0.015em] max-w-[18ch] text-balance` |
| Source line | `font-mono text-[0.8125rem] leading-5 text-muted-foreground` |

### Textures & surfaces

```css
/* P1 square kumiko — on ::before only, never on a content box */
.lattice { position: relative; isolation: isolate; --cell: var(--col); --c: var(--border); }
.lattice::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: linear-gradient(to right, var(--c) 1px, transparent 1px),
                    linear-gradient(to bottom, var(--c) 1px, transparent 1px);
  background-size: var(--cell) var(--cell); }
.lattice--medium { --cell: 24px; }   /* loading + empty states only */

/* P2 stacked offset divider */
.step-rule { --step: var(--col); --c: var(--border); height: 9px; background:
  linear-gradient(var(--c), var(--c)) right 0   / calc(100% - 2 * var(--step)) 1px no-repeat,
  linear-gradient(var(--c), var(--c)) right 4px / calc(100% - var(--step)) 1px no-repeat,
  linear-gradient(var(--c), var(--c)) right 8px / 100% 1px no-repeat; }

/* P4 hatch = MOCK / stale only. 6px pitch for UI bands; 3px inside glyphs */
.hatch { --h: var(--muted-foreground);   /* stone / stone-d */
  background: repeating-linear-gradient(45deg, var(--h) 0 1px, transparent 1px 6px); }
.mock-band { inline-size: 6px; align-self: stretch; }        /* + .hatch, beside the value */
.mock-plate { background: var(--card); border: 1px solid var(--muted-foreground);
  font: 500 0.78125rem/1.25rem var(--font-mono); letter-spacing: .08em; text-transform: uppercase; padding: 0 6px; }
```

### Typography treatments

```css
.tf-app    { font-variant-numeric: lining-nums tabular-nums; }
.tf-figure { font-feature-settings: "tnum" 1, "lnum" 1; }
.display, .h1-serif { font-family: var(--font-display); font-optical-sizing: auto; font-style: normal; font-weight: 400; }
h1, h2, h3, .display { text-wrap: balance; }  p, li { text-wrap: pretty; }
.pin { block-size: 1cap; inline-size: 1.5cap; vertical-align: baseline; }  /* fallback .7em */
.dark { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
```

### Animation recipes

```css
@keyframes seat     { from { transform: translateX(var(--travel, -24px)); } to { transform: none; } }
@keyframes pin-drop { from { transform: translateY(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
.leg  { animation: seat 320ms var(--ease-seat) both; }
.pin-in { animation: pin-drop 160ms var(--ease-seat) 120ms both; }
@media (prefers-reduced-motion: reduce) {
  .leg, .pin-in { animation: fade 120ms linear both; }
}
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
```

---

## Related

- [working-brand.yml](./working-brand.yml): the source of truth (tokens, intensity, patterns, constraints, effects)
- [guidelines.html](./guidelines.html): the visual brand guide, light and dark
- `../identity/`: color-system.md, palettes.json, typography.md, logo-directions.md, imagery-style.md, iconography.md
