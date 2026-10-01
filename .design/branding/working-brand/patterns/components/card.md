# Card and panel (override)
> Type: override | Replaces: `rounded border border-gray-200 p-2/p-3` (GoalFlow, StatsCard, Monitor ×3)

**Why override:** a card is a *planed face*: lighter than the ground, hairline edge, no shadow, and at most one serif line. Those limits (and the stat-cell sub-pattern) are rules, not tokens. Proposed: `components/ui/Card.tsx` with `Card`, `CardHeader`, `CardBody`, `CardFooter`, and `Stat`.

## Anatomy and tokens

| Part | Treatment |
|---|---|
| Surface | `bg-card border border-border rounded-md` (paper-raised / char; hair / hair-d) |
| Padding | 24px consumer and docs (`p-6`); 16px Bearing and Monitor dense (`p-4`) |
| Header | title Plex Sans 600 `text-h4` (consumer) or `text-b-section` (dense); meta on the right in `text-caption text-muted-foreground` |
| Divider | 1px `--border` between header/body/footer, full bleed |
| Footer | source lines, explorer links (Plex Mono), or one link action |
| Table panel | radius 0, no padding; the table owns its cells ([data-table.md](./data-table.md)) |

**Stat cell** (StatsCard, showcase KPIs): label `text-caption text-muted-foreground` above value `font-mono font-medium tabular-nums` (consumer 18px, Bearing `text-b-kpi`); cells separated by 1px hair, not gaps. Any yield, price or FX value gets a [provenance pin](./provenance-pin.md). Counts (plans, transactions) don't.

## States

| State | Treatment |
|---|---|
| Hover (interactive card only) | hairline-deepen: border hair → member. No lift, no shadow. Whole-card links use one `<a>` on the title with a stretched `::after` |
| Focus-within | 2px ring on the card |
| Selected | a 2px `--primary` left border (border-left only; no inset shadow) plus `aria-current` or `aria-selected` |
| MOCK | hatch band on the frame edge + [mock-plate](./mock-plate.md). Never a hatched body |
| Loading | static P1-medium lattice inside the body + label, `role="status"` |
| Empty | P1-medium lattice fragment + one sentence + one action |

## Rules

- At most one Newsreader line per card (the goal sentence). No photography, no pattern inside.
- Never `rounded-lg`/`xl`, never `shadow-*`, never translucent backgrounds.
- Monitor's raw JSON `<pre>` result becomes a card: outcome sentence, orders list, signatures as `Tx ↗` links.

## Do / don't

| Do | Don't |
|---|---|
| Depth by layer (sunk / ground / raised) | Depth by shadow |
| Hairline between stat cells | Gaps with floating boxes |
