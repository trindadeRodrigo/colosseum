# Button (override)
> Type: override | Replaces: `rounded bg-black px-3 py-1.5 text-sm text-white` (GoalFlow ×2, Monitor ×1), `rounded bg-gray-100 …` chips

**Why override:** tokens give the colours, but the brand adds rules tokens can't express: one primary per view, species-press instead of opacity/scale, a link-action variant preferred in consumer flows, no pills, and a busy state with no spinner. Proposed file: `apps/web/components/ui/Button.tsx` (named export, `variant` + `size` props, `className` passthrough via a tiny `cn()`).

## Variants

| Variant | Use | Classes |
|---|---|---|
| `primary` | The single committing action per view ("Generate plan", "Sign and send") | `h-10 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary-hover active:bg-primary-pressed` |
| `secondary` | Alternatives ("Edit sheet", "Run policy now" when it is not the main action) | `h-10 px-4 rounded-md border border-input bg-transparent text-foreground font-medium hover:border-primary hover:text-primary` |
| `link` | Consumer next steps ("See your plan"), preferred over primary in consumer flows | `text-primary underline decoration-1 underline-offset-4 hover:decoration-2` |
| `chip` | Goal suggestions, filter toggles | `h-8 px-3 rounded-md border border-input text-body-sm hover:bg-accent text-left` (2px, never pill; `aria-pressed` when a toggle) |
| `icon` | Copy, close, menu | square tag: `size-10` (`size-8` dense) `grid place-items-center rounded-md border border-input`; `aria-label` + tooltip |
| `destructive` | "Revoke delegation" | secondary shape, `border-destructive text-destructive`; always a confirm step with the consequence in words |

Sizes: `default` 40px, `dense` 32px (Monitor, Bearing). Text Plex Sans 500, 15px (`dense` 14px), sentence case, no tracking change.

## States

| State | Treatment |
|---|---|
| Hover | species-press rest (primary → wood-600 / `#D7C09E`); secondary edge and text → primary; link underline 1 → 2px. 160ms `--ease-seat`, colour only |
| Active | heartwood / hinoki-deep. No scale, no translate |
| Focus-visible | 2px `--ring`, 2px offset, square |
| Busy | label changes to the present participle ("Building your plan…"), `aria-busy="true"`, `aria-disabled="true"` (keeps focus), width locked. No spinner; for waits > 400ms show the lattice loader nearby with `role="status"` |
| Disabled | `aria-disabled`, fill `--muted`, text `--muted-foreground`; **not** `opacity-50` (fails contrast). Say why nearby ("Fix the two fields above to continue") |

## Rules

- One `primary` per view. A mainnet-signing button is always `primary` and its label names the action and amount ("Sign: swap 5 USDC → USDY").
- Never auto-retry after a failed mainnet transaction: the button returns to rest with the error sentence and an explorer link if a signature exists.
- Icons from the curated registry only; never `Sparkles`, `Rocket`, `RefreshCw` for rebalance.
- The composer's round send button is **not** this component: see [composer.md](./composer.md).

## Accessibility

Native `<button>` (or `<a>` for navigation). Targets ≥ 24px (2.5.8): dense 32px passes. Contrast: paper-raised on hardwood 5.91, black on hinoki 13.44, member edge 3.47 / 3.91 (1.4.11).

## Do / don't

| Do | Don't |
|---|---|
| "See your plan" as a hardwood underlined link | A big pill CTA |
| Explain a disabled state in words | Grey it out at 50% opacity |
| Busy label + `aria-busy` | Spinners, shimmer, counting figures |
