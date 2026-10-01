# Embed shell
> Type: custom | Route: `/embed/[id]` | Replaces: `app/embed/[id]/layout.tsx` (which inherits Nav, wallet button, `max-w-4xl` and the footer from the root layout)

Inside a partner's app the brand recedes. The partner's colours, font, radius and buttons take over. What survives is the proof: the pin and its popover, hatch + MOCK, hairline structure, the disclaimer block, explorer links, and a small "Powered by tenonfi" credit.

## Routing fix (blocking)

The scan found `/embed` rendering **Nav and the wallet button** because `embed/[id]/layout.tsx` nests inside the root layout. Fix with route groups so the embed has a bare root:

```
app/
  layout.tsx              ← minimal: <html><body>{children}</body></html>, no Nav, no Providers, no fonts beyond system
  (app)/layout.tsx        ← Nav, wallet Providers, brand fonts, container  → /, /plans/[id], /monitor
  (marketing)/layout.tsx  ← compact nav, Newsreader                       → landing
  embed/[id]/layout.tsx   ← EmbedShell only
```

A verify check (`scripts/verify`) fetches `/embed/<fixture-id>` and fails if the HTML contains `wallet-adapter`, the Nav landmark, `Newsreader`, or any `--primary` wood hex.

## Anatomy

```
┌ partner container (their radius, their bg) ─────────────────────────┐
│ Your apartment fund                       ← e-title 1.44em, partner font, NOT serif
│ $40,000 by June 2028 · cash within 7 days ← e-lead 1.2em
│ ─────────────────────────────── (hairline, --embed-border)
│ [plan legs: partner fg shades, direct labels, pins in --embed-muted]
│ [exit-plan line]  [schedule chart: currentColor, dashed stresses]
│ ┌ disclaimer block (≥ 1em, hairline box) ┐
│ Tx ↗ 4kZ9…mX2p   (if any executions)
│ ───────────────────────────────
│ Powered by ⊡ tenonfi                     ← e-credit, --embed-muted, foot of module
└─────────────────────────────────────────────────────────────────────┘
```

- **No Nav. No wallet button. No sign actions.** The host app owns custody and chrome; the embed is read-only (plan, schedule, risk, exit, executions).
- **Type**: `--embed-font` (partner), em-relative on a 1.2 ratio (`e-title 1.44em`, `e-lead 1.2em`, `e-body 1em`, `e-small 0.8333em` for provenance lines, `e-credit max(0.6944em, 11px)`). Never Newsreader.
- **Colour**: `--embed-*` vars only ([token-mapping §8](./token-mapping.md#8-embed-variables-partner-skin)). Plan-leg fills use `color-mix(in oklab, var(--embed-fg) N%, var(--embed-bg))` at 85/65/45/30% with the 2px gap, so legs stay distinguishable without brand wood.
- **Container queries**: `container-type: inline-size` on the shell; < 360px stacks legs and hides the chart behind a "Show schedule" disclosure; ≥ 560px two columns.
- **Credit**: "Powered by" + small-cut symbol (monochrome, `currentColor`) + `tenonfi` wordmark text, `--embed-muted`, links to the public plan page (`target="_blank"`). Never wood colours, never the two-species logo.

## What survives / what recedes

| Survives (non-negotiable) | Recedes |
|---|---|
| Provenance pin + popover (partner mono or `ui-monospace`) | Brand colours (wood, paper, black) |
| Hatch + MOCK plate on any non-live figure | Newsreader, Plex (unless the partner uses them) |
| Hairline structure in drawings and tables | Kumiko / P2 patterns, photography |
| Disclaimer block from `DISCLAIMER`, ≥ 1em | Our 2px radius (partner radius applies; the composer doesn't appear) |
| Explorer links on every mainnet transaction | Nav, wallet button, CTAs, subscribe |
| "Powered by tenonfi" credit | The two-species logo |

## States

| State | Treatment |
|---|---|
| Loading | text "Loading plan…" `role="status"`, no lattice animation (partner context) |
| Not found / revoked | one sentence + nothing else ("This plan isn't available.") |
| Partner vars missing | system colours (`Canvas`, `CanvasText`, `GrayText`); still legible |
| Low-contrast partner muted | hatch suppressed, MOCK word kept (see token mapping §8) |

## Accessibility

Shell is a `<section aria-label="Plan by tenonfi">` (not a `<main>`; the host owns landmarks). Respects host `color-scheme` and `prefers-reduced-motion`. The credit is ≥ 11px; everything else ≥ 1em of the host base. `lang` set on the shell from the plan's language.

## Do / don't

| Do | Don't |
|---|---|
| Bare root layout for `/embed` | Hide Nav with CSS inside the root layout |
| Pins in the partner's muted colour | Hardwood pins in a partner app |
| Disclaimer at body size | "Not advice" as 10px grey text |
| "Powered by tenonfi" at the foot | "Partner embed · unbranded" debug caption (current layout) |
