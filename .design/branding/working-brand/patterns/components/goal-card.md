# Goal card
> Type: custom | Component: `<GoalCard>` | Used on: home (recent plans → "Your goals"), Monitor header, plan view header (as `variant="header"`)

One goal, one sentence, where it stands, and where to look next. The card answers a person; it does not sell yield.

## Anatomy

```
┌───────────────────────────────────────────────┐  bg-card, 1px hair, 2px radius, p-6
│ Your apartment fund is on track.              │  1 · Newsreader 400, h3 size (card) / display (header), max 18ch
│ ■ On track · June 2028                        │  2 · status mark + word + date, Plex Sans 500 caption
│ $12,480 of $40,000 ⊡ · access to cash in 7 days│  3 · Plex Sans 400 body-sm, tabular; pin on priced figures
│ See your plan                                 │  4 · one hardwood underlined link
└───────────────────────────────────────────────┘
```

1. **Goal sentence**: generated from the constraint sheet in the person's words ("Your apartment fund…"), Newsreader 400, never bold or italic. The only serif on the card (and on the screen: in a list of cards, the page heading is Plex Sans).
2. **Status**: `<StatusMark>` 10px square + word + target date. On track = solid forest square; Watch = half-filled ochre square; Off track = notched madder outline. Word always present.
3. **Amount line**: current value of target ("$12,480 of $40,000") with a pin on the current value (it is a priced figure), then access to cash from the exit plan. Tabular figures, true minus. If income: "pays R$ 5.000/month from Jan 2029".
4. **Action**: "See your plan" (`button.md` link variant). One action only.

Optional meta (`variant="header"` on the plan view): `profile · solver version · created` in `text-caption text-muted-foreground`, and the MOCK plate if any input is non-live.

## Tokens

`bg-card`, `border-border`, `font-display`, `text-status-*` / `bg-status-*-bg` (status mark only, not the card), `text-primary` for the link, `--tf-pin*`.

## States

| State | Treatment |
|---|---|
| Rest | as above |
| Hover | hairline-deepen (border hair → member); the link underline thickens |
| Focus | ring on the link; whole card clickable via stretched link |
| Watch / Off track | only the status mark and word change, plus one sentence of reason ("A stress case breaks in month 14."). The card itself is not tinted |
| Draft (sheet not validated) | no status mark; "Draft: finish the sheet" + link "Edit sheet". No amount line |
| MOCK inputs | 6px hatch band on the left edge + plate after the status line |
| Loading | static lattice + "Loading your goal", `role="status"` |

## Rules

- **Income goals never mention or show xStocks** (tokenized stocks); the card's legs summary, if shown, comes from the plan whose registry already excludes them. Do not add a "boost with stocks" suggestion.
- Never: photography, patterns, leaderboards, a big APY number, progress rings or bars, "earn up to".
- The status is computed by the engine (schedule vs stresses), never by the UI.

## Accessibility

`<article aria-labelledby={sentenceId}>`; status word in text; StatusMark `aria-hidden`. Contrast: forest 8.75:1 on paper, ochre 5.27:1, madder 5.80:1; dark on char: forest-d 6.31, ochre-d 7.94, madder-d 7.20.

## Do / don't

| Do | Don't |
|---|---|
| "Your trip fund is on track." | "Earning 6.4% APY" as the headline |
| ■ + "On track" | A green dot |
| One link | Three buttons |
