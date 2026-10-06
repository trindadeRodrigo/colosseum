# Iconography

> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01

Enriches the "Iconography direction" line in imagery-style.md §3 (24 px grid, 1.5 px line, square caps and joins, 0 radius, orthographic, few and plain). That direction stands. This chunk adds the library, the numbers and the four brand glyphs. **Icons are wayfinding, never decoration.** Meaning is carried by drawings (H3–H6), not by big icons.

---

## 1. Library: Lucide, retuned

| | |
|---|---|
| Package | `lucide-react`, **exact version pinned** (no caret: Lucide renames icons between minors) |
| Import | Named imports only: `import { ArrowUpRight, Copy } from "lucide-react"`. Never `import *` and never `lucide-react/dynamic` (that breaks tree-shaking and allows unreviewed icons) |
| Why | It is stroke-based, so width, caps and joins can be overridden globally to match the drawing language. It is the shadcn default, so `/gsp-brand-apply` needs no second set. It is MIT-licensed and works with RSC (plain SVG, no client hook) |
| Considered | **Phosphor:** its weights are filled outlines with round terminals baked in, so caps can't be squared. **Carbon (`@carbon/icons-react`):** a Plex sibling with squarish terminals, but it is filled-outline too, so it can't share a stroke with the custom glyphs. **Heroicons / Radix:** sets too small, and Heroicons has round joins |

**One wrapper, used everywhere** (`apps/web/components/icon.tsx`). Product code never renders a Lucide component directly; lint bans direct imports outside the wrapper and the registry.

```tsx
<Lucide size={size} strokeWidth={1.5} absoluteStrokeWidth
  strokeLinecap="square" strokeLinejoin="miter" aria-hidden={!label} aria-label={label} />
```

- **Stroke 1.5 px, absolute, at every size.** This matches the drawing's key-member line (imagery-style.md §3) and doesn't thicken at 32 px or thin out at 16 px. There is no second weight and no filled variant.
- **Square caps, miter joins.** Joinery is square. Lucide's dot strokes (`h.01`) become 1.5 px square dots.
- **Curated registry** (`icons.ts`): only icons that pass §6 are exported. Adding one takes a review against the banned list.

## 2. Size system

| Use case | Size | Text pairing | Example |
|---|---|---|---|
| Provenance pin | **cap height**: 0.75em (12 px at 16 px text) | Inline after the figure | `6.4% ⊡` (own grid, see §4.1) |
| Inline | **16 px** | 13–14 px text | Explorer `↗`, copy, timestamp clock, table sort |
| Default UI | **20 px** | 15–16 px text | Nav items, buttons, inputs, menus |
| Feature | **24 px** | Section labels, 18 px+ | List leads, "Access to cash" panel, empty-state glyph |
| Hero | **32 px** max | Marketing and docs headers only | Product switcher (Plan / Bearing / API) |

- **Above 32 px, use a drawing, not a scaled icon.** Empty states use a P1-medium lattice or an H3 fragment.
- **Hit area ≥ 24 × 24** (WCAG 2.5.8) for any interactive icon, including the 12 px pin. Icon-only buttons are 32 × 32 (dense tables) or 40 × 40 (default), with a visible label or `aria-label` and a tooltip.
- **Icon–text gap** is 0.375em (6 px at 16). The icon is optically centred on the x-height, not the line box.

## 3. Containers and colour

**Bare is the default.** An icon sits on the ground with no container, the way a drawing callout does.

| Treatment | When | Tailwind (tokens from color-system.md; final names set in guidelines) |
|---|---|---|
| **Bare** | Everywhere by default | `inline-flex text-current` |
| **Square tag** | Icon-only buttons, list leads at 24 px. It echoes the square callout tag | `inline-grid place-items-center size-10 rounded-[2px] border border-member bg-paper-raised dark:border-member-d dark:bg-char` |
| **Sunk well** | Feature rows in docs and the Bearing sidebar | `inline-grid place-items-center size-10 rounded-[2px] bg-paper-sunk dark:bg-char-2` (no border) |
| **Pressed / active** | Toggled icon buttons | Square tag + `border-hardwood text-hardwood dark:border-hinoki dark:text-hinoki` |

**Banned containers:** circles (the round shape belongs to the pin alone), pills, radius > 2 px, tinted wood fills, shadows, gradients, glows.

**Colour rules**
- Icons are always `currentColor`, **monochrome**, and never multi-colour or two-species. The two-species treatment is the logo's alone, at ≥ 64 px.
- Default: `ink` / `washi`. Secondary or meta: `stone` / `stone-d`. Interactive (link, focus, pressed): `hardwood` / `hinoki`.
- **Goal state is never an icon.** On track / watch / off track use the solid, half and notched **squares** from color-system.md, plus the word. No check-circles, warning triangles or traffic lights.
- **Embed:** icons take the partner's text and muted colours. The pin glyph and hatch are mandatory. J3 is allowed in monochrome. J4 and J5 are not carried.

## 4. Custom brand glyphs

Shared construction (identical to the retuned Lucide): `viewBox 0 0 24 24`, 2 px keyline padding (20 × 20 live area), 1.5 px stroke via the same absolute-width math (`1.5 × 24 / size`), `fill="none" stroke="currentColor"`, square caps, miter joins, 0 radius, orthographic. No colour is hard-coded. Run SVGO with `removeViewBox: false`, then hand-write a React component per glyph in `components/icons/brand/`. Every glyph has a **16 px cut** with fewer parts, tested at 16 px on paper and on black. Stroke centres sit on `.25` / `.75` so edges land on whole device pixels at 2×.

### 4.1 Provenance pin (J1 tenon end). Not part of the icon set
It has its own component (`<ProvenancePin>`), its own grid and its own sizing. It is never in the icon registry and never reused for anything else (logo-directions.md).

| | Live | Stale | MOCK |
|---|---|---|---|
| Outline | `rect` 18 × 12 (3:2), stroke 1.5, square corners | same | same |
| Pin | Solid disc, Ø 5, centred | Ring Ø 5 at stroke 1.5, empty centre | **None** |
| Fill | none | none | 45° hatch at 3 px pitch, clipped to the inner rect. The **only** permitted sub-1.5 stroke (P4 hairline, 1 px) |
| Paired text | popover `source · fetched_at · method` | **stale** + age ("stale · 3 h") | **MOCK** |

- `viewBox 0 0 18 12`, rendered at `height: .75em; width: 1.125em`, with the baseline aligned to the figure's baseline. Colour: `hardwood` on paper, `hinoki` on dark, partner muted colour in the embed.
- **State comes from the API**: `"provenance": "mock"` or the response's staleness flag. The UI never infers it, and colour is never the only signal.
- `<button>` with `aria-label="Source for 6.4%"` (+ ", stale, 3 hours old" / ", mock data"). Enter opens the popover. The 24 × 24 hit area comes from a transparent `::before`.

### 4.2 Exit plan: J3 *ari-otoshi* (dovetail drop)
Used for the "Access to cash" panel header, exit-plan rows and the docs section for `exitPlan`.
- **Base member:** horizontal rect `x 3–21, y 15–21`, with a tapered socket cut from its top edge (mouth 8 wide at y 15, floor 5 wide at y 19).
- **Tail:** the matching taper (wide at top, 8 → 5) lifted clear, `y 6–10`. This shows *it comes out the way it went in*.
- **Travel:** a dash-dot centre line on x 12 from the socket floor to y 3 (dash 3 / gap 1.5 / dot 0.01 / gap 1.5). Dashed means projected (imagery-style.md): it is a path, not an event.
- **16 px cut:** drop the centre line and keep the member, socket and lifted tail.
- **Not** a door, a logout arrow or a parachute. Exit is designed, not escaped.

### 4.3 Rebalance: J4 *kanawa tsugi* (keyed scarf splice)
Used in activity-log rows ("Rebalanced"), the rebalance settings and policy docs.
- Two lengths on one axis, `y 9–15`: left `x 2–13`, right `x 11–22`, meeting in a **stepped scarf** (joint line down from 11,9 to 11,12, across to 13,12, down to 13,15).
- **Key:** a 3 × 3 outline square on the step at (12, 12). Outline, not solid: solid round is the pin's alone.
- **Re-cut section:** the right length sits 1.5 px high, *just slid in*, the moment before the key is driven.
- **16 px cut:** drop the key and keep the stepped line and the offset.
- **Not** circular arrows (`RefreshCw` is banned for rebalance): it reads as "retry", and a mainnet transaction is never auto-retried.

### 4.4 Bearing: J5 bracket set (*masugumi*)
Used only for the product switcher, the nav item and Bearing doc pages. **It is never placed beside the wordmark:** the `tenonfi Bearing` lockup has no separate symbol (logo-directions.md).
- Post `x 10–14, y 15–21`. Bearing block (*daito*) `x 8–16, y 12–15`. Arm (*hijiki*) `x 3–21, y 9–12`. Three small blocks (*makito*) `x 3–7`, `x 10–14` and `x 17–21` at `y 5–9`, **with 3 px gaps** so load visibly passes through separate pieces.
- **Risk:** like logo B, it can read as a funnel or filter at 16 px. Mitigated by the separated blocks and an arm wider than the block. The 16 px cut keeps the gaps and drops the daito. If it still reads as a filter in testing, the nav uses the word "Bearing" alone.

## 5. Motion
Icons don't animate, except that the brand glyphs may play their joint's single-axis move on state change (J3 tail lifts 3 px and returns, J4 section slides in, the pin drops in on live). 160 ms, `cubic-bezier(0.2,0,0,1)`, no bounce. Reduced motion: none.

## 6. Curated set and banned metaphors
**Allowed (starter registry):** `ArrowUpRight` (explorer and external links, "Tx ↗"), `Copy`, `Check` (copy confirmation only), `X`, `ChevronDown/Right`, `Plus`, `Minus`, `Pencil` (edit constraint sheet), `Clock` (fetched age), `History` (activity), `Wallet`, `Search`, `Menu`, `Info`, `FileText`, `Code`, `Settings`.

**Banned:** `Sparkles` / `Wand` (AI magic; the LLM reads and asks, it does not decide), `Rocket`, `Zap`, `Flame`, `Gem`, `Crown`, `Trophy`, `Coins`, `PiggyBank`, `HandCoins`, `TrendingUp/Down` (P&L), `Shield*` / `BadgeCheck` / `Lock` used as a promise (implies a guarantee; this is not licensed advice), `RefreshCw` for rebalance, `LogOut` / `DoorOpen` for the exit plan, `CircleCheck` / `TriangleAlert` for goal state, any emoji, and any hexagon (kikkō; it reads as crypto).

---

## Related
- [Imagery Style](./imagery-style.md): drawing line weights, hatch, dashed = projected
- [Logo Directions](./logo-directions.md): provenance glyph origin, Bearing lockup rule
- [Color System](./color-system.md): species rule, semantic squares
- [Brand Applications](./brand-applications.md): where the pin, J3 and J4 appear
