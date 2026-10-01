# Compact centred nav (marketing)
> Type: custom | Component: `<MarketingNav>` in `(marketing)/layout.tsx` | Source: landing prototype `.nav` / `.nav.compact`

On the landing page the header starts as a quiet full-width bar (symbol + wordmark, nothing else competing with the joint) and, from step 03 onward, compacts into a centred bar carrying the menu and the one CTA. The app (`(app)` routes) uses the plain bar from `patterns.nav`, not this.

## Anatomy

```
Full (hero, steps 01–02):
[■ tenonfi]                                                         (no menu)

Compact (from step 03, and on any page without the stage):
              ┌──────────────────────────────────────────────────┐
              │ ■ tenonfi   Products  Invest  Resources [Connect wallet] │
              └──────────────────────────────────────────────────┘
```

- **Position**: `position: fixed; top: calc(env(safe-area-inset-top) + 12px); left: 50%; translateX(-50%)`, z-index above content.
- **Full state**: width = page container (max 1280px), transparent, no border, padding 8px 0. Wordmark Newsreader 400 24px (the wordmark is a logo, not the screen's serif line). Symbol 24px in `--primary` (hinoki on dark).
- **Compact state**: width auto, max `min(860px, 100% - 32px)`, padding 8px 8px 8px 18px, **solid `--card`** (char / paper-raised), **1px `--border`**, 2px radius. Wordmark 20px. Menu links Plex Sans 500 14px, `--foreground`, padding 8px 12px, hover `bg-accent`. CTA = primary button (hinoki / hardwood, 2px radius, `--tf-primary-hover`).
- **Mobile (< 820px)**: compact shows symbol + wordmark + `Menu` icon button (40px) + CTA; links move into a full-width sheet below the bar (solid `--card`, hairline, 2px radius), opened with `aria-expanded`.

## Trigger

Compact when `scrollY > step03.offsetTop - 0.6 × viewport height`, or immediately when the page has no joint stage (or the stage is in its reduced-motion/static form). Use an `IntersectionObserver` on step 03 rather than a scroll listener. Hysteresis: return to full only when scrolled back above step 02.

## Motion

Width, padding and wordmark size transition over 480ms `--ease-seat`; the menu fades in 320ms after a 160ms delay (seat, then reveal). **Reduced motion**: state switches instantly (120ms crossfade on the menu).

## Prototype deltas (the `.yml` wins)

| Prototype | Spec |
|---|---|
| `rgba(26,23,20,.88)` + `backdrop-filter: blur(10px)` | Solid `--card`. No glass, no blur (constraint). Content scrolls under a solid bar |
| CTA hover `#D7C09E` hard-coded | `--tf-primary-hover` |
| `PROTOTYPE · landing` tag | Removed in production |
| Light mode absent | Ships both: paper-raised bar, hardwood symbol and CTA on paper |

## States

| State | Treatment |
|---|---|
| Link hover | `bg-accent` |
| Link current (section in view) | `aria-current="true"`, 2px `--primary` underline at 6px offset |
| Focus | 2px `--ring`, 2px offset, inside the bar's padding (not clipped: no `overflow:hidden` on the bar) |
| Wallet connected | CTA becomes "Open app" (link to `/`), never shows balance in the marketing nav |

## Accessibility

`<header>` with `<nav aria-label="Main">`. The menu is `visibility: hidden` (not just `opacity: 0`) in the full state so hidden links are not focusable. Skip link "Skip to content" first in DOM. Fixed bar height ≤ 64px; anchors use `scroll-margin-top: 88px` so focused targets aren't obscured (2.4.11). Contrast: washi on char 14.14, ink on paper-raised 16.78.

## Do / don't

| Do | Don't |
|---|---|
| Solid bar with a hairline | Frosted glass |
| One CTA in the bar | Two filled buttons |
| Hide menu with `visibility` | Leave invisible links tabbable |
