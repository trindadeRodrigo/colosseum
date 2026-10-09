# Goal card
> Type: custom | Component: `<GoalCard>` | Used on: home (recent plans → "Your goals"), Monitor header, plan view header (as `variant="header"`) | Revised 2026-10-08 (honey on night)

One goal, where it stands, and where to look next. The card answers a person; it does not sell yield.

## Anatomy

```
┌───────────────────────────────────────────────┐  bg-card, 1px --border, 10px radius, p-6
│ APARTMENT FUND · JUN 2028                     │  1 · eyebrow: Inter 500 caption, 12px uppercase +0.04em, muted
│ $12,480 ⊡                                     │  2 · figure-lg: Inter Tight 600 28/32, −0.02em, tabular, with its pin
│ 6.40% net ⊡ · access to cash within 7 days    │  3 · one line, Inter 400 body-sm; pin on the yield
│ ■ On track                                    │  4 · status pill: square glyph + word on a 14% tint
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │  5 · progress bar: honey on --border, pill ends, 6px
│ See your plan                                 │  6 · one honey-l underlined link
└───────────────────────────────────────────────┘
```

1. **Eyebrow**: the goal's name and its date ("Apartment fund · Jun 2028"), generated from the constraint sheet in the person's words. On the plan view header (`variant="header"`) the goal sentence is the page's h1 in Inter Tight 600 ("Your apartment fund is on track.") and the eyebrow sits above it.
2. **Amount**: the current value in `text-figure-lg` (`font-display font-semibold tabular-nums`) with a [pin](./provenance-pin.md): it is a priced figure. Optionally "of $40,000" in body-sm muted after it.
3. **One line**: net yield after haircut with its pin, then access to cash from the exit plan. Tabular figures, true minus. If income: "pays R$ 5.000/month from Jan 2029".
4. **Status**: a 22px pill (`rounded-full`, 14% tint, the colour as text, Inter 600 12px) leading with the square glyph: On track = solid leaf square on leaf-tint; Watch = half-filled clay square on clay-tint; Off track = notched madder outline on madder-tint. Word always present. The target date may follow the word ("On track · June 2028").
5. **Progress bar**: 6px, `rounded-full`, track `--border`, fill `--tf-honey`. Progress toward the amount, never toward a return.
6. **Action**: "See your plan" (`button.md` link variant, honey-l / honey). One action only.

Optional meta (`variant="header"`): `profile · solver version · created` in `text-caption uppercase text-muted-foreground`, and, if any input is non-live, the muted sample line ("Sample figures" / "Sample figures · test network") beside the card's hatched left edge.

## Tokens

`bg-card`, `border-border`, `rounded-lg`, `font-display` + `text-figure-lg` for the amount, `bg-leaf-tint text-leaf` / `bg-clay-tint text-clay` / `bg-madder-tint text-madder` for the pill only (the card is never tinted by status), `bg-honey` for the progress fill, `text-honey-text` for the link, `--tf-pin*`.

## States

| State | Treatment |
|---|---|
| Rest | as above |
| Hover | edge line-l → line-l2 (line → line-2); the link underline thickens. No lift |
| Focus | chalk ring on the link; whole card clickable via stretched link |
| Selected (in a list) | tint-rise: `bg-accent` (honey 14%) + `aria-current` |
| Watch / Off track | only the pill changes, plus one sentence of reason in body-sm ("A stress case breaks in month 14."). The card itself is not tinted and the bar stays honey |
| Draft (sheet not validated) | no pill, no amount; "Draft: finish the sheet" + link "Edit sheet" |
| Sample inputs | 6px hatched left edge + one muted sample line at the card's foot; figures keep the hatched pin (gate MOCK-QUIET) |
| Loading | the 3-segment honey loader + "Loading your goal", `role="status"` |

## Rules

- **Income goals never mention or show xStocks** (tokenized stocks); the card's legs summary, if shown, comes from the plan whose registry already excludes them. Do not add a "boost with stocks" suggestion.
- Never: photography, patterns, leaderboards, a big APY number as the headline, progress rings, "earn up to". The big number is the amount, not the yield.
- The status is computed by the engine (schedule vs stresses), never by the UI.
- No serif anywhere on the card. The one display line is Inter Tight.

## Accessibility

`<article aria-labelledby={eyebrowId}>`; status word in text; StatusMark `aria-hidden`; the progress bar is `role="progressbar"` with `aria-valuenow`. Contrast: leaf-l 5.48 / clay-l 5.98 / madder-l 6.08 on white; on their 14% tints 4.90 / 5.18 / 5.19, AA at 12px 600 (clay-l and madder-l were darkened on 2026-10-08 for this). Dark on night-2: leaf 8.16, clay 6.15, madder 5.52; on their tints 6.42 / 5.11 / 4.67. Amount ink 18.05 / text 16.15.

## Do / don't

| Do | Don't |
|---|---|
| "$12,480 ⊡" as the big figure | "Earning 6.4% APY" as the headline |
| ■ + "On track" in a leaf pill | A green dot, or a green card |
| A honey progress bar | A progress ring, or a bar coloured by status |
| One link | Three buttons |
