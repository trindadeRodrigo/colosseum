# Embed shell
> Type: custom | Route: `/embed/[id]` | Replaces: `app/embed/[id]/layout.tsx` (which inherits Nav, wallet button, `max-w-4xl` and the footer from the root layout) | Revised 2026-10-08 (honey on night)

Inside a partner's app the brand recedes. The partner's colours, font, radius and buttons take over. What survives is the proof: the pin and its popover, the hatched edge with its sample line, hairline structure, the disclaimer block, explorer links, and a small "Powered by tenonfi" credit with the 16px cut of the mark in the partner's muted colour.

## Routing fix (blocking)

The scan found `/embed` rendering **Nav and the wallet button** because `embed/[id]/layout.tsx` nests inside the root layout. Fix with route groups so the embed has a bare root:

```
app/
  layout.tsx              ← minimal: <html><body>{children}</body></html>, no Nav, no Providers, no fonts beyond system
  (app)/layout.tsx        ← Nav, wallet Providers, brand fonts, container  → /, /plans/[id], /monitor
  (marketing)/layout.tsx  ← compact nav, Inter Tight                        → landing
  embed/[id]/layout.tsx   ← EmbedShell only
```

A verify check (`scripts/verify`) fetches `/embed/<fixture-id>` and fails if the HTML contains `wallet-adapter`, the Nav landmark, an `Inter Tight` font-face, the honey hex `#F5A83A` (or any `--tf-honey*` / `--primary` reference), or a `bg-glow`.

## Anatomy

```
┌ partner container (their radius, their bg) ─────────────────────────┐
│ Your apartment fund                       ← e-title 1.44em, partner font, NOT Inter Tight
│ $40,000 by June 2028 · cash within 7 days ← e-lead 1.2em
│ ─────────────────────────────── (hairline, --embed-border)
│ [plan legs: partner fg shades, direct labels, pins in --embed-muted]
│ [exit-plan line]  [schedule chart: currentColor, dashed stresses]
│ ┌ disclaimer block (≥ 1em, hairline box) ┐
│ Tx ↗ 4kZ9…mX2p   (if any executions)
│ ───────────────────────────────
│ Powered by ▣ tenonfi                     ← e-credit, --embed-muted, foot of module
└─────────────────────────────────────────────────────────────────────┘
```

- **No Nav. No wallet button. No sign actions.** The host app owns custody and chrome; the embed is read-only (plan, schedule, risk, exit, executions).
- **Type**: `--embed-font` (partner), em-relative on a 1.2 ratio (`e-title 1.44em`, `e-lead 1.2em`, `e-body 1em`, `e-small 0.8333em` for provenance lines, `e-credit max(0.6944em, 11px)`). Never Inter Tight, never a serif.
- **Colour**: `--embed-*` vars only ([token-mapping §8](./token-mapping.md#8-embed-variables-partner-skin)). Plan-leg fills use `color-mix(in oklab, var(--embed-fg) N%, var(--embed-bg))` at 85/65/45/30% with the 2px gap, so legs stay distinguishable without honey. The bar's ends follow `--embed-radius`.
- **Container queries**: `container-type: inline-size` on the shell; < 360px stacks legs and hides the chart behind a "Show schedule" disclosure; ≥ 560px two columns.
- **Credit**: "Powered by" + the **16px cut of the mark in one colour** (`identity/logo/mark-mono.svg` geometry at 16: tile minus cut, plus the square pin, `currentColor`) + `tenonfi` wordmark text, all in `--embed-muted`, linking to the public plan page (`target="_blank"`). Never honey, never the two-colour mark, never larger than the partner's own UI text. Where a partner forbids marks: text-only "Powered by tenonfi".

## What survives / what recedes

| Survives (non-negotiable) | Recedes |
|---|---|
| Provenance pin + popover (partner mono or `ui-monospace`), outline and square in `--embed-muted` | Honey, night, paper, the glow, the tints |
| The hatched edge + muted sample line on any card with non-live figures ("Sample figures · test network" on sandbox), hatched pins on the figures | Inter Tight and Inter (unless the partner uses them) |
| Hairline structure in drawings and tables | The lattice, photography, the joint drawings in colour |
| Disclaimer block from `DISCLAIMER`, ≥ 1em | Our radii (8 / 10 / 20px; the partner's `--embed-radius` applies; the composer doesn't appear) |
| Explorer links on every mainnet transaction | Nav, wallet button, CTAs, subscribe, chips |
| "Powered by tenonfi" credit with the mono 16 cut | The honey mark, status tints (status = word + square in `--embed-fg`) |

## States

| State | Treatment |
|---|---|
| Loading | text "Loading plan…" `role="status"`, no loader animation (partner context) |
| Not found / revoked | one sentence + nothing else ("This plan isn't available.") |
| Partner vars missing | system colours (`Canvas`, `CanvasText`, `GrayText`); still legible |
| Low-contrast partner muted | hatch suppressed, the sample line kept (see token mapping §8) |

## Accessibility

Shell is a `<section aria-label="Plan by tenonfi">` (not a `<main>`; the host owns landmarks). Respects host `color-scheme` and `prefers-reduced-motion`. Focus rings use `--embed-accent`, never chalk. The credit is ≥ 11px; everything else ≥ 1em of the host base. `lang` set on the shell from the plan's language.

## Do / don't

| Do | Don't |
|---|---|
| Bare root layout for `/embed` | Hide Nav with CSS inside the root layout |
| Pins and the credit's mark in the partner's muted colour | Honey pins or a honey tile in a partner app |
| Disclaimer at body size | "Not advice" as 10px grey text |
| "Powered by tenonfi" at the foot | "Partner embed · unbranded" debug caption (current layout) |
