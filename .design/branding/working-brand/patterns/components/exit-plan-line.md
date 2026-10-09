# Exit-plan line
> Type: custom | Component: `<ExitPlanLine>` (and `<ExitPlanPanel>` for the plan view) | Glyph: J3 dovetail drop | Revised 2026-10-08 (honey on night)

Every portfolio states how money comes back out **before** the agent invests: how much, how fast, at what cost. The line is the compact form (cards, showcase, simulator); the panel is the full form ("Access to cash" on the plan view).

## Anatomy: line

```
┃ ⟂ Exit plan · up to $4,000 within a day · the rest within 7 days · cost ≤ 0.50% ⊡
┃   Weekend exits are slower and cost more.
```

- 2px left rule in `--tf-honey-text` (honey-l `#9D5A00` on light, honey `#F5A83A` on dark), 12px left padding. (The landing prototype's `.exitline` pattern, kept.)
- J3 glyph 16px (`--muted-foreground`; lines in the text colour, the lifted tail in honey at ≥ 24px), then "Exit plan" (Inter 600), then the tiers separated by " · " (Inter 400 `text-body-sm`, tabular). Any cost or price carries a [pin](./provenance-pin.md); costs are estimates from the engine/Bearing, labelled "≤" or "about", never exact promises.
- Optional second line: the caveat, `--muted-foreground`.

## Anatomy: panel (plan view)

Card (`rounded-lg`, 10px) with header "Access to cash" in Inter 600 + J3 24px. Body: a short orthographic **dimension line** per tier, drawn in **chalk** and dashed (because it is projected): `today ├──── $4,000 ────┤ 1 day ├──── $8,480 ────┤ 7 days`, Plex Mono values with 45° ticks. Below it a table ([data-table.md](./data-table.md)): tier · amount · time · estimated cost ⊡ · route (e.g. "redeem USDY", "sell on Jupiter at the thinnest hour, Bearing v1.3"). For equity legs (non-income only), the time and cost come from Bearing's measured depth, with its `method` in the pin.

## States

| State | Treatment |
|---|---|
| Measured | dimension line dashed chalk (projected), values with live pins |
| Partly sample | the panel keeps a hatched left edge, the sample tier's figures carry the hatched pin, and one muted line says "Sample figures" (+ " · test network" for sandbox); others normal |
| Not yet sourced (landing / simulator) | the line reads "Yields and exit costs are sourced live after you connect." in muted text; no numbers without a source |
| Breach (a stress case breaks the window) | madder pill: notched square + "Off track: in the rate-shock case, cash within 7 days drops to $2,100." |
| Watch | clay pill: half square + word + reason |

## Rules

- No `LogOut`, `DoorOpen` or parachute icons: exit is designed, not escaped.
- Never phrase as a guarantee ("guaranteed liquidity", "instant withdrawal"). Use "up to", "within", "about", "estimated".
- Dashed = projected. The dimension lines are dashed chalk; realised exits in the activity log are solid.
- Chalk draws the lines; honey marks the rule; neither is a fill.

## Accessibility

The dimension drawing is `aria-hidden`; the tier table/sentence carries the content. Left rule is decorative (meaning is in the text "Exit plan"). Contrast: body text ink 18.05 / text 16.15 on the card; the rule honey-l 5.39 on white, honey 9.16 on night-2; chalk-l lines 5.03 on white, chalk 8.24 on night-2.

## Do / don't

| Do | Don't |
|---|---|
| "up to $4,000 within a day · cost ≤ 0.50% ⊡" | "Withdraw anytime!" |
| State the exit before the invest button | Hide the exit plan in a tab or footnote |
| Chalk dimension lines, dashed | Honey or madder dimension lines |
