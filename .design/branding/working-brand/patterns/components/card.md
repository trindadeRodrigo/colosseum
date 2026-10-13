# Card and panel (override)
> Type: override | Replaces: `rounded border border-gray-200 p-2/p-3` (GoalFlow, StatsCard, Monitor ×3) | Revised 2026-10-08 (honey on night)

**Why override:** a card is a *raised surface*: one layer up from the ground, a hairline edge, 10px corners, no shadow, and at most one display line. Those limits (and the stat-cell sub-pattern) are rules, not tokens. Proposed: `components/ui/Card.tsx` with `Card`, `CardHeader`, `CardBody`, `CardFooter`, and `Stat`.

## Anatomy and tokens

| Part | Treatment |
|---|---|
| Surface | `bg-card border border-border rounded-lg` (white `#FFFFFF` / night-2 `#13151C`; line-l `#E3DFD6` / line `#262A36`; 10px) |
| Padding | 24px consumer and docs (`p-6`); 16px Bearing and Monitor dense (`p-4`) |
| Header | title Inter 600 `text-h4` (consumer) or `text-b-section` (dense); meta on the right in `text-caption uppercase text-muted-foreground` |
| Divider | 1px `--border` between header/body/footer, full bleed |
| Footer | source lines, explorer links (Plex Mono), or one link action |
| Table panel | `rounded-lg overflow-hidden`, no padding; the table owns its cells ([data-table.md](./data-table.md)) |

**Stat cell** (StatsCard, showcase KPIs, Bearing tiles): label `text-caption uppercase text-muted-foreground` above value `font-display font-semibold tabular-nums` (consumer `text-figure-lg` 28px, Bearing `text-b-kpi` 22px) + a signed delta in `text-b-delta` (leaf up, madder down, muted flat); cells separated by 1px hairlines, not gaps. Any yield, price or FX value gets a [provenance pin](./provenance-pin.md). Counts (plans, transactions) don't.

## States

| State | Treatment |
|---|---|
| Hover (interactive card only) | edge line-l → line-l2 (line → line-2). No lift, no shadow. Whole-card links use one `<a>` on the title with a stretched `::after` |
| Focus-within | 2px chalk ring on the card, following the 10px radius |
| Selected | tint-rise: `bg-accent` (honey at 14% over the ground) plus `aria-current` or `aria-selected`. No inset shadow, no honey outline |
| Sample / test network | the card's 6px hatched left edge + one muted sample line ("Sample figures" / "Sample figures · test network"), no box; figures keep the hatched pin ([mock-plate.md](./mock-plate.md), gate MOCK-QUIET). Never a hatched body |
| Loading | the 3-segment honey loader + a label inside the body, `role="status"` |
| Empty | one sentence + one action. No pattern fill |

## Rules

- At most one Inter Tight line per card (the goal sentence or the big figure). No serif, ever. No photography, no pattern inside.
- Radius is 10px and only 10px (`rounded-lg`): never `rounded-xl`+ on a card, never `rounded-md` to "match" a button. Never `shadow-*` (the popover is the only shadowed surface), never translucent backgrounds, never glass.
- Colour sits in surfaces as tints: a selected card is honey-tinted, a status card is not tinted (the status pill carries it).
- Monitor's raw JSON `<pre>` result becomes a card: outcome sentence, orders list, signatures as `Tx ↗` links.

## Accessibility

Contrast on `--card`: ink 18.05 on white, text 16.15 on night-2; muted-l 5.39 / muted 6.77. The hairline is decorative; a card's boundary is also its fill against the ground.

## Do / don't

| Do | Don't |
|---|---|
| Depth by layer (ground / card / raised) | Depth by shadow |
| Hairline between stat cells | Gaps with floating boxes |
| A honey-tinted selected card | A card with a honey border |
