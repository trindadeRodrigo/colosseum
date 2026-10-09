# Field: input, select, textarea (override)
> Type: override | Replaces: `rounded border border-gray-300 p-1` (GoalFlow ×4) and the local `field()` helper | Revised 2026-10-08 (honey on night)

**Why override:** the brand separates *control edges* (`--input`: line-l2 / line-2) from *hairlines* (`--border`), puts inputs in a well with 8px corners, never relies on placeholders, and words errors as "what to change". Proposed: `components/ui/Field.tsx` exporting `Field` (label + control + hint + error wiring), `Input`, `Select`, `Textarea`.

The goal input and the subscribe field are **not** fields; they are the 20px [composer](./composer.md). Everything else here is 8px.

## Anatomy

```
AMOUNT (BRL)                        ← label: Inter 500 caption, 12px uppercase +0.04em, --muted-foreground
┌──────────────────────────────┐    ← 1px --input (line-l2 / line-2), bg --secondary (paper-3 / night-3), 8px radius, h-10
│ 40.000                       │    ← Inter 400 16px, tabular, right-aligned for amounts
└──────────────────────────────┘
In reais. Your target, not a promise.   ← hint: body-sm, --muted-foreground
```

## Tokens and states

| State | Treatment |
|---|---|
| Rest | `h-10 px-3 rounded-md border border-input bg-secondary text-body text-foreground tabular-nums` |
| Hover | edge stays `--input` (controls don't deepen; cards do) |
| Focus-visible | 2px `--ring` (chalk) outline, 2px offset, following the 8px radius; border unchanged; no glow |
| Invalid | `aria-invalid="true"`, border `--destructive` (madder-l `#B52F44` / madder `#EF5A6F`), a sentence below in `--destructive` with a 12px notched-square glyph (shape, not colour alone). The sentence says what to change: "A monthly income goal needs the income profile." |
| Read-only | no well: `bg-transparent border-border`, text foreground. Used in the read-only sheet on PlanView |
| Disabled | `bg-transparent`, `border-border`, text `--muted-foreground`, plus the reason in the hint |
| Changed from parser | a 6px honey square (`bg-honey`, `rounded-[1px]`) before the label and "edited" in the hint (so the person sees what differs from what the parser read) |

Select: native `<select>` with the same box and a 16px `ChevronDown` in `--muted-foreground`; options use human labels ("Low", "Accept credit risk"), never raw enum keys (`accept_fx`).

## Rules

- Label always visible above. Never placeholder-only. Placeholder text in `--muted-foreground`.
- Amounts: `inputMode="decimal"`, formatted with `Intl.NumberFormat(locale)`, true minus U+2212 in display.
- Field width follows content length (amount ~12ch, month ~9ch), not the grid cell.
- Errors come from zod `issues[].path` and render next to their field, plus a summary at the top of the form (see [constraint-sheet.md](./constraint-sheet.md)).
- Never a honey border on a control: honey is the action, chalk is focus, madder is the error.

## Accessibility

`<label for>`; hint and error joined in `aria-describedby`; error `role="alert"` only on submit (not on each keystroke). Font size ≥ 16px. Contrast: ink on paper-3 15.30; text on night-3 14.91; madder-l 6.08 on white, madder 5.88 on night; the chalk ring 5.03 / 8.77. The edge alone (line-l2 1.74 on white, line-2 1.51 on night-3) is below 3:1: the well's fill and the visible label mark the control, and the ring carries focus (1.4.11 is met by the fill + label pair, not by the edge).

## Do / don't

| Do | Don't |
|---|---|
| `border-input` + `bg-secondary` on every control | `border-border` (a hairline) on a control, or a borderless well |
| "Doesn't fit: pick a date after today" | "Invalid value" |
| Human labels | `target.kind`, `fxStance` |
