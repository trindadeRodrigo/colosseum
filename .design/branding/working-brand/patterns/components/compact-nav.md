# Compact centred nav (marketing)
> Type: custom | Component: `<MarketingNav>` in `(marketing)/layout.tsx` | Source: landing prototype `.nav` / `.nav.compact` | Revised 2026-10-08 (honey on night)

On the landing page the header starts as a quiet full-width bar (mark + wordmark, nothing else competing with the joint) and, from step 03 onward, compacts into a centred bar carrying the menu and the one CTA. The app (`(app)` routes) uses the plain bar from `patterns.nav`, not this.

## Anatomy

```
Full (hero, steps 01–02):
[▣ tenonfi]                                                         (no menu)

Compact (from step 03, and on any page without the stage):
              ╭──────────────────────────────────────────────────╮
              │ ▣ tenonfi   Products  Invest  Resources [Connect wallet] │
              ╰──────────────────────────────────────────────────╯
```

- **Position**: `position: fixed; top: calc(env(safe-area-inset-top) + 12px); left: 50%; translateX(-50%)`, z-index above content.
- **Full state**: width = page container (max 1280px), transparent, no border, padding 8px 0. The mark is the 24 hint (honey tile, the cut in the ground colour) and the wordmark Inter Tight 600 24px, −0.02em, lowercase, in `--foreground`.
- **Compact state**: width auto, max `min(860px, 100% - 32px)`, padding 8px 8px 8px 18px, **solid `--card`** (night-2 / white), **1px `--border`**, 10px radius (the card radius; not a pill). Wordmark 20px. Menu links Inter 500 14px, `--muted-foreground` → `--foreground` on hover, padding 8px 12px, hover `bg-secondary` at 8px radius. CTA = primary button (honey, ink, 8px radius, `--tf-honey-hover`).
- **Mobile (< 820px)**: compact shows mark + wordmark + `Menu` icon button (40px, 8px radius) + CTA; links move into a full-width sheet below the bar (solid `--card`, hairline, 10px radius), opened with `aria-expanded`.

## Trigger

Compact when `scrollY > step03.offsetTop - 0.6 × viewport height`, or immediately when the page has no joint stage (or the stage is in its reduced-motion/static form). Use an `IntersectionObserver` on step 03 rather than a scroll listener. Hysteresis: return to full only when scrolled back above step 02.

## Motion

Width, padding and wordmark size transition over 480ms `--ease-seat`; the menu fades in 320ms after a 160ms delay (seat, then reveal). **Reduced motion**: state switches instantly (120ms crossfade on the menu).

## Prototype deltas (the `.yml` wins)

| Prototype | Spec |
|---|---|
| `rgba(26,23,20,.88)` + `backdrop-filter: blur(10px)` | Solid `--card`. No glass, no blur (constraint). Content scrolls under a solid bar |
| CTA hover `#D7C09E` hard-coded | `--tf-honey-hover` `#E99C2E` |
| `PROTOTYPE · landing` tag | Removed in production |
| Light mode absent | Ships both: white bar on paper, honey mark and CTA on both grounds |
| Serif wordmark | Inter Tight 600 wordmark; the mark is the face (LOGO-2) |

## States

| State | Treatment |
|---|---|
| Link hover | `bg-secondary`, text `--foreground` |
| Link current (section in view) | `aria-current="true"`, `--foreground` + 2px honey underline at 6px offset |
| Focus | 2px chalk `--ring`, 2px offset, inside the bar's padding (not clipped: no `overflow:hidden` on the bar) |
| Wallet connected | CTA becomes "Open app" (link to `/`), never shows balance in the marketing nav. As built since 2026-10-09, following Thom's request for one account control on every bar (gate `ONE-ACCOUNT-CONTROL`), the landing shows the account chip with its menu instead: open for Rodrigo, whose spec this is |

## Accessibility

`<header>` with `<nav aria-label="Main">`. The menu is `visibility: hidden` (not just `opacity: 0`) in the full state so hidden links are not focusable. Skip link "Skip to content" first in DOM. Fixed bar height ≤ 64px; anchors use `scroll-margin-top: 88px` so focused targets aren't obscured (2.4.11). Contrast: text on night-2 16.15, ink on white 18.05; muted links 6.77 / 5.39; CTA ink on honey 9.06.

## Do / don't

| Do | Don't |
|---|---|
| Solid bar with a hairline, 10px corners | Frosted glass, or a pill-shaped bar |
| One CTA in the bar, honey with ink | Two filled buttons; white on honey |
| Hide menu with `visibility` | Leave invisible links tabbable |
