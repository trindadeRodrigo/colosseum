# Style

## Brand: Tenonfi
**Style:** working-brand ("Honey on night") | **Generated:** 2026-10-01 | **Rewritten:** 2026-10-08 on `IDENTITY-2` and `LOGO-2` (docs/GATES.md)

> STYLE.md is the single document designer and builder agents consume. It is rendered from [working-brand.yml](./working-brand.yml), plus the philosophy (strategy) and the bold bets (identity). If this file and the `.yml` disagree, the `.yml` wins. Display name **Tenonfi** is provisional (fallback "Tenon"); the wordmark is always lowercase `tenonfi`.

---

## Binding rules (read before anything else)

These are product rules expressed as design. A screen that breaks one of them is wrong, however good it looks.

1. **Provenance pin on every number.** Every yield, price and FX figure is followed by the provenance pin (the logo's tenon end in line mode, with its square pin), which opens `source · fetched_at · method`. No pin, no number.
2. **Sample is never shown as live (gate `MOCK-QUIET`, Thom, Oct 6).** Mocked or stubbed data (the API carries `"provenance": "mock"`) is marked by the 45° section hatch on the card's left edge and **one quiet muted line, with no box**: "Sample figures" ("Números de exemplo"), or "Sample figures · test network" for a figure from a test network or a local copy of mainnet (`"provenance": "sandbox"`). A sample figure keeps its hatched pin, or a small hatched glyph where it has no pin, named "sample figure" for screen readers. The word MOCK is the API's value and the name of the state in these documents; it never appears as a boxed label beside a figure. Text never sits on hatch strokes. Stale data gets a hollow pin plus the word "stale" and its age.
3. **The disclaimer is never omitted, and the brand is never presented as advice.** The disclaimer renders from the single `DISCLAIMER` constant, unedited, on the plan view and in the API docs, at body size, in a hairline box. No return promises: no "earn up to", "guaranteed" or "risk-free".
4. **No Japanese clichés.** The reference is joinery as craft and structure, not culture as costume. No kanji or kana, torii, ensō, hanko or seal-red, sakura, waves, brush type, washi texture, asanoha, kikkō or seigaiha, and no Japanese words in product UI.
5. **Nothing like Teiten.** No bevelled chassis, instrument nameplates, LEDs, screws, retro-OS panels, mono-led headlines or cinnabar signal. Bearing is a dense data screen, not hardware.
6. **One brand colour.** Honey `#F5A83A` is the only accent, in both modes, and it always carries ink text. Leaf, clay and madder carry direction and status, never brand. Chalk is a line (focus, guides, "today"), never a fill or a brand element. There is no second brand hue and no blue brand. Exception for token identification (Thom, Oct 7, `INVEST-TWO-PANE`): verified token logos keep their original artwork colours; that does not extend the interface or chart palette.
7. **Status is word + shape + colour.** On track, watch and off track each have a square glyph, a word and a colour on a 14% tint. Deltas are signed and coloured by direction. Colour alone never carries meaning.
8. **The brand recedes in the embed.** Inside a partner app, the partner's colours, font, radius and buttons take over. What survives: the pin and its popover, the hatch with its sample line, hairline structure, the disclaimer block, explorer links, and a "Powered by tenonfi" credit with the 16 px cut in the partner's muted colour.

---

## Intensity

| Dial | Value | Meaning |
|------|-------|---------|
| Variance | 3 | A 12-column grid, flush left. Asymmetry comes from the empty third in heroes and the honey glow sitting off-centre |
| Motion | 3 | One vocabulary: slide on one axis, seat, then the pin appears. Purposeful, never ambient |
| Density | 4 | Consumer surfaces are airy (one goal, the composer and a sample plan above the fold). Bearing is tight (13 px type, 36 px rows). Docs sit in between |

---

## Philosophy

A master joiner who works for you: they measure you first, cut the pieces for your goal alone, and leave every joint where you can see it. The design should feel like **wood in daylight on a product screen**: one warm colour, honey, on a cool near-black or on warm paper, with the numbers dense and alive and every joint still visible. Knowledge is shown as something you can open (an exploded view, a visible pin, a hatched section that admits it isn't finished timber), never as a gradient of two hues or a glowing dashboard.

It takes the Sage's structure (a grid, hairlines, tabular figures, signed deltas), the Caregiver's warmth (honey, warm paper, plain words addressed to one person) and the category's product register (a cool dark ground, tints in surfaces, pills, the product in the first viewport), and declines the category's abstraction: there is still a joint, a pin and a source behind every number. **The display face states, the UI face explains, the mono cites.**

---

## Patterns

### Card
| Property | Rule |
|----------|------|
| border | 1px solid `--border` (line `#262A36` / line-l `#E3DFD6`) |
| shadow | none. Depth comes from the three layers, hairlines and tints |
| radius | 10px (`--radius-lg`) |
| background | `--card`: night-2 `#13151C` / white `#FFFFFF` |
| padding | 24px for consumer and docs, 16px for Bearing tiles |
| rule | No photography and no pattern inside. A card holds one goal, one leg or one tile |

### Button (primary)
| Property | Rule |
|----------|------|
| background | `--primary` honey `#F5A83A` in both modes. Hover `#E99C2E`. Pressed honey-deep `#D9881B` |
| border | none |
| text | Inter 600, 14–15px, sentence case, `--primary-foreground` ink `#15161C`. Never white on honey |
| radius | 8px (`--radius`). Never a pill |
| height | 40px default, 32px dense |
| rule | One primary per view |

### Button (secondary)
| Property | Rule |
|----------|------|
| background | transparent; `--secondary` (night-3 / paper-3) on hover |
| border | 1px solid `--input` (line-2 `#363B4B` / line-l2 `#C9C4B9`) |
| text | Inter 600, sentence case, `--foreground` |
| radius | 8px |

### Input
| Property | Rule |
|----------|------|
| border | 1px solid `--input` |
| radius | 8px |
| background | `--secondary` (night-3 / paper-3): the input well |
| focus | 2px solid `--ring` (chalk `#78B4E8` / chalk-l `#2A73B0`) outline with 2px offset, following the radius. The border is unchanged. No glow |
| error | Border in `--destructive` (madder), plus a sentence that says what to change ("doesn't fit"). Never blame the user |
| label | Inter 500 caption above the field. Never placeholder-only |

### Chip and badge
| Property | Rule |
|----------|------|
| shape | Pill, 22px tall |
| chip | Filter chips: Inter 500 12px, `--muted-foreground` text, 1px `--input` border. Selected: honey-tint fill `rgba(245,168,58,.14)`, honey (night) / honey-l (day) text, no border |
| status | **On track:** solid square, leaf. **Watch:** half-filled square, clay. **Off track:** notched square outline, madder. Fill = the colour's 14% tint; text = the colour; always the word |
| sample line | Inter 400, 12.5px, `--muted-foreground`: "Sample figures", or "Sample figures · test network", once per card at its foot, beside the card's 6px hatched left edge. No plate, no box, no uppercase word (gate `MOCK-QUIET`) |
| delta | Inter 500 11px, signed (+ / U+2212), leaf up / madder down / muted flat, beside or under the value it qualifies |

### Navigation
| Property | Rule |
|----------|------|
| style | A plain horizontal bar on `--background` with a 1px hairline at the bottom. Mark + wordmark on the left, the primary action on the right. No glass, no blur |
| links | Inter 500, 14px, `--muted-foreground`, turning `--foreground` on hover. Active: foreground plus a 2px honey underline at 6px offset |
| docs | Left sidebar on `--sidebar` with a 1px `--sidebar-border` right edge |

### Layout
| Property | Rule |
|----------|------|
| archetype | **asymmetric-grid** |
| max-width | 1280px page, 66ch body, 72ch docs prose, 16ch display |
| section-spacing | 96px marketing, 64px docs and plan, 32px Bearing panels |
| grid-gap | 24px (16px in Bearing) |
| surfaces | Night or paper, flat. A honey glow (`--tf-glow`) behind heroes and the composer. P1 lattice on marketing section grounds only, faint, never in the app |
| first viewport | The product, not a manifesto: the composer with a sample plan beneath it, numbers and pins visible before any scroll |
| decoration | Hairline rules, dimension lines (45° ticks, Plex Mono values, chalk) on drawings, exploded views |

### Provenance pin (brand-specific)
| Property | Rule |
|----------|------|
| placement | After every yield, price and FX figure, at cap height, with a U+202F thin no-break space before it |
| drawing | `viewBox 0 0 18 12`: outline rect 3:2, stroke 1.5, radius 2.5; the square pin 4×4, radius 1, set toward the end (x 11.5). `height: .75em` |
| live | Solid square pin. Outline muted-2 `#6E7282` / line-l2 `#C9C4B9`; pin honey (night) / honey-l `#A8640A` (day) |
| stale | Hollow square pin (1.5px) **plus "stale · 3 h"**. Never without the word |
| sample (MOCK) | No pin. The tenon is filled with a 3px-pitch hatch, `aria-label` "sample figure"; the card carries the quiet line "Sample figures" |
| sandbox | As sample; the card's line reads "Sample figures · test network" |
| popover | Plex Mono: `source · fetched_at (ISO, UTC) · method`, on night-3 / white with a 1px border and `--tf-shadow-popover` |
| a11y | `<button aria-label="Source for 6.4%">` (with ", stale, 3 hours old" or ", mock data" appended), a 24×24 hit area, and Enter opens it |
| embed | The pin takes the partner's muted text colour |

### Goal card, plan leg, data row, chart, disclaimer, embed, Bearing tile
| Component | Rule |
|---|---|
| goal card | Eyebrow caption ("Apartment fund · Jun 2028") → amount in Inter Tight 600 28px + pin → one line (net yield ⊡ · access to cash) → status pill → progress bar (honey on `--border`, pill ends) → one link or the view's one primary. No photography, patterns, leaderboards, a big APY as the headline, or progress rings |
| plan leg | A stacked horizontal bar, at most 4 legs, 2px ground-colour gaps, pill ends. **Night:** honey, wood `#E9C48E`, honey-deep, muted. **Day:** honey, honey-deep, wood-deep `#B9803F`, muted-l. Every leg has a direct label (leg · weight · after-haircut yield ⊡ · "quoted x%" muted). A sample leg is hatched, and its label says "sample" |
| data row | Asset avatar 22px + name (600) + type chip (pill) · sparkline coloured by direction · tabular values with a signed delta beneath · status cell (pin, stale, MOCK). Rows 36px. Selected row on honey-tint. Hover `--accent` |
| chart | Base case: 2px honey with `--tf-curve-fill` beneath. Stress cases: dashed muted and dashed madder. "Today": 1px dashed chalk with a Plex Mono label. Dashed = projected, solid = measured. Heatmaps on the night → honey → pale ramp; no-sample cells empty with an en dash |
| disclaimer | The `DISCLAIMER` constant verbatim, in a hairline box directly under the plan and at the top of the API reference. Inter 400 at body size (≥ 1em in the embed) |
| embed | Partner skin. The pin, the hatch with its sample line, hairlines, disclaimer, explorer links and "Powered by" survive. Sizes in em on a 1.2 ratio, with container queries |
| Bearing tile | b-head label (Inter 500 11px uppercase) → b-kpi value (Inter Tight 600 22px) + pin + delta → b-meta line (unit · n= · method version · as-of UTC, Plex Mono). night-2 on night, 1px line, 10px radius, 16px padding |

---

## Constraints

### Never
- A yield, price or FX figure without its provenance pin. It breaks the core promise ("every joint shown").
- A mock shown as live: a sample figure without its hatched pin or glyph and the card's quiet line, text set on hatch strokes, a sandbox card without "test network", or a boxed MOCK word anywhere (gate `MOCK-QUIET`).
- The hatch used for anything but MOCK or stale.
- Omitting, shrinking or paraphrasing the disclaimer, presenting the brand as licensed advice, or promising returns.
- A second brand colour. Chalk as a fill, a button or a brand element. A blue brand or a blue gradient.
- Two-hue gradients, glass, backdrop blur, neon glow, ambient orbs, gold foil, metallic or wood-grain fills in UI.
- White text on honey (2.0:1). Honey as small text on light grounds (use honey-l).
- Honey as the "watch" colour, or any status shown by colour alone.
- Cinnabar, vermilion or seal-red. Japanese clichés (binding rule 4). Anything like Teiten (binding rule 5).
- A serif anywhere in the app, Bearing or the embed. At most one serif line on the marketing site, by decision, not by default.
- Patterns behind numbers, text, form fields, charts, the provenance popover or the disclaimer.
- Pills on primary or secondary buttons. Radius above 16px on anything but chips, badges and the composer (20px).
- Font weights below 400, centred or justified body text, uppercase other than captions and column heads.
- Text set on photographs, gradient scrims, duotones, wood-grain textures as backgrounds.
- Circles as containers, except the composer's send button, the token identification mark (`AssetMark`, Thom, Oct 7), and the portfolio board's controls (`/portfolio`, gate `PORTFOLIO-BOARD`, Rodrigo, Oct 8): its chart modes (the chosen one a pill with icon and word, the others an icon in a circle), its period drop-down and its buttons are round, and its two boxes take the app tile's 16px.
- Bounce, spring, overshoot, confetti, counting-up figures, parallax or ambient loops.
- The Sparkles, Wand, Rocket, Coins, TrendingUp or Shield-as-promise icons, RefreshCw for rebalance, emoji, exclamation marks, mascots, leaderboards.
- Brand colour, patterns or photography inside the partner embed.
- The word MOCK in the UI (gate `MOCK-QUIET`): it is the API's value, not a label.

### Always
- One brand colour: honey, with ink on it, in both modes. The pin is honey on night and honey-l on day.
- Light and dark as peers. Every component ships both and passes WCAG 2.2 AA in both.
- Status = word + shape + colour on a 14% tint. Deltas signed and coloured by direction.
- Sample = the hatched card edge + the quiet line "Sample figures" + a hatched pin or glyph named "sample figure". Sandbox adds "test network" to the line. Stale = a hollow pin + the word "stale" + its age.
- The disclaimer from the single `DISCLAIMER` constant, on the plan view and in API docs.
- Inter Tight for display and big numbers, Inter for UI, Plex Mono for provenance and code. Tabular lining figures, a true minus (U+2212), `Intl` formatting with 2 decimals on yields.
- Colour in surfaces as 14% tints (selected rows, chips, badges), not only in text.
- A 2px chalk focus ring at 2px offset on every interactive element, following its radius.
- The 4px grid. Line heights snap to multiples of 4.
- Dashed = projected, solid = measured or live, everywhere.
- Every mainnet transaction line with its explorer link (Plex Mono, "Tx ↗").
- Flush left, ragged right, sentence case. The product in the first viewport.

---

## Effects

**Interaction vocabulary:** seat-slide, pin-drop, tint-rise, honey-press, underline-draw, part-and-close, crossfade-reduced

### Hover
| Element | Technique | Description |
|---------|-----------|-------------|
| card | hairline-deepen | The border goes from line to line-2 (line-l to line-l2). No lift, no shadow |
| button | honey-press | The primary fill goes to `#E99C2E`; a secondary gets the `--secondary` surface |
| link | underline-draw | The 1px underline thickens to 2px. The colour stays honey / honey-l |
| row | tint-rise | The background goes to `--accent` (honey at 14%) |

### Active
| Element | Technique | Description |
|---------|-----------|-------------|
| button | honey-press | Honey-deep `#D9881B`. No scale, no translate |

### Focus
| Element | Rule |
|---------|------|
| general | A 2px solid `--ring` (chalk) outline, 2px offset, following the element's radius |
| pin | The same ring around the 24×24 hit area. Enter opens the popover |

### Transition
160ms for colour and opacity, 320ms for slides, all on `cubic-bezier(0.2, 0, 0, 1)` (`--ease-seat`). Motion animates `transform` and `opacity` only.

### Choreography (not ambient: event-driven only)
- **plan-lock:** legs fade in at their exploded positions (160ms, 60ms stagger), slide and seat (280–360ms), and then the pin appears 120ms later over 160ms.
- **part-and-close ("Why this plan?"):** pieces part 12–24px on their axes, callouts fade in, then the pieces close back to locked.
- **loader:** a three-segment bar fills in honey, left to right, 240ms per segment. Only for waits over 400ms, with a text label and `role="status"`.
- **reduced motion:** every slide becomes a 120ms crossfade, the pin appears without travel, and the loader is static with its label. As built today the mix joint (plan-leg.md, "The mix joint") neither moves nor fades under reduced motion; whether that stays or becomes this crossfade is open for Rodrigo (gate `MIX-JOINT`).

---

## Bold Bets

1. **The provenance pin is the brand's smallest logo.** The logo is the end view of a pinned through-tenon on a tile; the pin that follows every figure is the same tenon end drawn in line mode, with the same square pin. It has four states (solid; hollow + "stale"; hatched, named "sample figure", with the card's line "Sample figures"; the same with "test network") and opens `source · fetched_at · method`. When the brand recedes in the embed, only the pin is left, and it is still the brand.
2. **The section hatch is a word, not a texture.** A 45° hatch (1px muted strokes, 6px pitch; 3px in glyphs) means one thing only: *not finished timber* (sample or stale). It always travels with its words (the quiet line "Sample figures", or "stale" and the age), fills a 6px edge band, and never sits under text. A DOM test fails the build if the hatch appears without that line in the same component, or if any element's text is exactly "MOCK" (gate `MOCK-QUIET`).
3. **One colour, and it carries ink.** Honey is the only accent, in both modes, and the primary button is black on honey. Meteora is white on orange, Jupiter black on lime, Binance black on yellow. Black on honey beside a cool black ground and wood photography is ours.
4. **Direction lives in surfaces.** Leaf, clay and madder sit as 14% tints under status pills, as signed deltas under values and as the colour of sparklines. The screen reads alive at density because colour is in the surfaces, not only in the text, and it never means anything but direction.
5. **Light is the only gradient.** A honey glow behind the hero and the composer, a honey fill under the base-case curve, and nothing else. No two-hue gradient, no glass, no glow on controls. The joint is lit; the interface is not.

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
  --color-secondary: var(--secondary);     --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);           --color-accent-foreground: var(--accent-foreground);
  --color-border: var(--border);           --color-input: var(--input);
  --color-ring: var(--ring);               --color-destructive: var(--destructive);
  --color-success: var(--success);         --color-warning: var(--warning);   --color-info: var(--info);
  --color-leg-1: var(--chart-1); --color-leg-2: var(--chart-2);
  --color-leg-3: var(--chart-3); --color-leg-4: var(--chart-4);
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 10px; --radius-xl: 16px;
  --radius-composer: 20px; --radius-pill: 9999px;
  --radius-asset: var(--radius-pill); /* AssetMark only (Thom, 2026-10-07) */
  --font-display: "Inter Tight", "Inter", system-ui, Arial, sans-serif;
  --font-sans: "Inter", "Inter Fallback", system-ui, Arial, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --ease-seat: cubic-bezier(0.2, 0, 0, 1);
}
:root { --tf-honey: #F5A83A; --tf-honey-tint: rgba(245,168,58,.14); --tf-leaf-tint: rgba(63,196,124,.14);
  --tf-clay-tint: rgba(240,112,58,.14); --tf-madder-tint: rgba(239,90,111,.14); --tf-chalk-tint: rgba(120,180,232,.14);
  --tf-glow: radial-gradient(60% 90% at 78% 30%, rgba(245,168,58,.22), rgba(245,168,58,0) 70%);
  --tf-curve-fill: linear-gradient(to bottom, rgba(245,168,58,.35), rgba(245,168,58,0));
  --tf-shadow-popover: 0 8px 24px rgba(0,0,0,.35); }
```

| Component | Classes |
|---|---|
| Card | `bg-card border border-border rounded-lg p-6` (no `shadow-*`) |
| Primary button | `h-10 px-4 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-[#E99C2E] active:bg-[#D9881B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` |
| Secondary button | `h-10 px-4 rounded-md border border-input text-foreground font-semibold hover:bg-secondary` |
| Chip | `h-[22px] px-3 rounded-full text-xs font-medium border border-input text-muted-foreground data-[on]:bg-[var(--tf-honey-tint)] data-[on]:border-transparent data-[on]:text-accent-foreground` |
| Status pill | `inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-full text-xs font-semibold bg-[var(--tf-leaf-tint)] text-success` (clay / madder likewise) |
| Input | `h-10 px-3 rounded-md bg-secondary border border-input text-base tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` |
| Link action | `text-accent-foreground underline decoration-1 underline-offset-4 hover:decoration-2` |
| Headline | `font-display font-semibold tracking-[-0.02em] text-balance max-w-[16ch]` |
| Big figure | `font-display font-semibold text-[1.75rem] leading-8 tracking-[-0.02em] tabular-nums` |
| Delta | `text-[11px] font-medium tabular-nums text-success` / `text-destructive` / `text-muted-foreground` |
| Source line | `font-mono text-[0.8125rem] leading-5 text-muted-foreground` |

### Textures & surfaces

```css
/* Hero glow — light as the only gradient */
.hero { position: relative; isolation: isolate; }
.hero::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--tf-glow); }

/* P1 lattice — marketing section grounds only, faint */
.lattice::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: .6;
  background-image: linear-gradient(to right, var(--border) 1px, transparent 1px),
                    linear-gradient(to bottom, var(--border) 1px, transparent 1px);
  background-size: var(--col) var(--col); }

/* P4 hatch = MOCK / stale only. 6px pitch for UI bands; 3px inside glyphs */
.hatch { --h: var(--muted-foreground);
  background: repeating-linear-gradient(45deg, var(--h) 0 1px, transparent 1px 6px); }
.sample-edge { inline-size: 6px; align-self: stretch; }      /* + .hatch, the card's left edge */
.sample-line { font: 400 0.78125rem/1.25rem var(--font-sans); color: var(--muted-foreground); }  /* "Sample figures · test network", once per card */
```

### Typography treatments

```css
.tf-app    { font-variant-numeric: lining-nums tabular-nums; }
.tf-figure { font-feature-settings: "tnum" 1, "lnum" 1; }
h1, h2, h3, .display { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.02em; text-wrap: balance; }
p, li { text-wrap: pretty; }
.pin { block-size: 1cap; inline-size: 1.5cap; vertical-align: baseline; }  /* fallback .75em */
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
- [working-brand.theme.json](./working-brand.theme.json): the shadcn theme, OKLCH, generated from the .yml
- [guidelines.html](./guidelines.html): the visual brand guide, light and dark
- `../identity/`: logo-directions.md (and `logo/`), color-system.md, palettes.json, typography.md, imagery-style.md, iconography.md
