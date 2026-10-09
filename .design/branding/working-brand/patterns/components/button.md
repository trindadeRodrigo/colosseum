# Button (override)
> Type: override | Replaces: `rounded bg-black px-3 py-1.5 text-sm text-white` (GoalFlow ×2, Monitor ×1), `rounded bg-gray-100 …` chips | Revised 2026-10-08 (honey on night)

**Why override:** tokens give the colours, but the brand adds rules tokens can't express: one primary per view, honey-press instead of opacity/scale, a link-action variant preferred in consumer flows, pills for chips and never for buttons, and a busy state with no spinner. Proposed file: `apps/web/components/ui/Button.tsx` (named export, `variant` + `size` props, `className` passthrough via a tiny `cn()`).

## Variants

| Variant | Use | Classes |
|---|---|---|
| `primary` | The single committing action per view ("Generate plan", "Sign and send") | `h-10 px-4 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-honey-hover active:bg-honey-deep` — honey `#F5A83A` with **ink** `#15161C` on it, in both modes |
| `secondary` | Alternatives ("Edit sheet", "Run policy now" when it is not the main action) | `h-10 px-4 rounded-md border border-input bg-transparent text-foreground font-semibold hover:bg-secondary hover:border-muted-foreground` |
| `link` | Consumer next steps ("See your plan"), preferred over primary in consumer flows | `text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2` (honey-l `#9D5A00` on light, honey on dark) |
| `chip` | Goal suggestions, filter toggles | `h-8 px-3 rounded-full border border-input text-body-sm font-medium hover:bg-secondary text-left`; selected / `aria-pressed="true"`: `bg-honey-tint text-honey-text border-transparent` (a pill with a 14% honey tint, no border) |
| `icon` | Copy, close, menu | `size-10` (`size-8` dense) `grid place-items-center rounded-md border border-input hover:bg-secondary`; `aria-label` + tooltip |
| `destructive` | "Revoke delegation" | secondary shape, `border-destructive text-destructive`; always a confirm step with the consequence in words |

Sizes: `default` 40px, `dense` 32px (Monitor, Bearing). Text Inter 600, 15px (`dense` 14px), sentence case, no tracking change. Radius is 8px (`rounded-md`) on every button; pills (`rounded-full`) belong to chips, status badges and the composer's send button only.

## States

| State | Treatment |
|---|---|
| Hover | honey-press: primary → honey-hover `#E99C2E`; secondary fill → `--secondary` (paper-3 / night-3) and edge → `--muted-foreground`; link underline 1 → 2px. 160ms `--ease-seat`, colour only |
| Active | primary → honey-deep `#D9881B`. No scale, no translate |
| Focus-visible | 2px `--ring` (chalk-l `#2A73B0` / chalk `#78B4E8`), 2px offset, following the 8px radius |
| Busy | label changes to the present participle ("Building your plan…"), `aria-busy="true"`, `aria-disabled="true"` (keeps focus), width locked. No spinner; for waits > 400ms show the 3-segment honey loader nearby with `role="status"` and a label. Where the wait can last and the button is the only thing that answers the press (the deposit step's check, its confirm, a draft's action while a reply is on its way), the loader stands inside the button before the busy label (`busyMark`): the lattice with its words, in a place the button keeps, still for the first 400ms and under reduced motion |
| Disabled | `aria-disabled`, fill `--muted`, text `--muted-foreground`; **not** `opacity-50` (fails contrast). Say why nearby ("Fix the two fields above to continue") |

## Rules

- One `primary` per view. A mainnet-signing button is always `primary` and its label names the action and amount ("Sign: swap 5 USDC → USDY").
- Never auto-retry after a failed mainnet transaction: the button returns to rest with the error sentence and an explorer link if a signature exists.
- Honey carries ink. Never `text-white` on a honey fill (2.0:1); never a honey outline button (honey on paper is 1.83:1 as a line).
- Icons from the curated registry only; never `Sparkles`, `Rocket`, `RefreshCw` for rebalance.
- The composer's round send button is **not** this component: see [composer.md](./composer.md).

## Accessibility

Native `<button>` (or `<a>` for navigation). Targets ≥ 24px (2.5.8): dense 32px passes. Contrast: ink on honey 9.06 (both modes); ink on honey-hover 7.96, on honey-deep 6.44; secondary label ink on white 18.05 / text on night-2 16.15. The secondary edge (line-l2 1.74 on white, line-2 1.64 on night-2) is below 3:1 on its own: the label identifies the control, the hover fill and the chalk ring (5.03 / 8.77) carry state. Link text honey-l 5.39 on white, honey 9.75 on night.

## Do / don't

| Do | Don't |
|---|---|
| "See your plan" as an underlined honey-l link | A big pill CTA |
| Ink on honey | White on honey, or honey text on a honey fill |
| Explain a disabled state in words | Grey it out at 50% opacity |
| Busy label + `aria-busy` | Spinners, shimmer, counting figures |
