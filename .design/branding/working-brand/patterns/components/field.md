# Field: input, select, textarea (override)
> Type: override | Replaces: `rounded border border-gray-300 p-1` (GoalFlow ×4) and the local `field()` helper

**Why override:** the brand separates *control edges* (member, ≥ 3:1) from *decoration* (hair), puts inputs in a sunk well, never relies on placeholders, and words errors as "what to change". Proposed: `components/ui/Field.tsx` exporting `Field` (label + control + hint + error wiring), `Input`, `Select`, `Textarea`.

The goal input and the subscribe field are **not** fields; they are the rounded [composer](./composer.md). Everything else here is 2px.

## Anatomy

```
Amount (BRL)                        ← label: Plex Sans 500 caption, --foreground
┌──────────────────────────────┐    ← 1px --input (member), bg --muted (paper-sunk / char-2), 2px radius, h-10
│ 40.000                       │    ← Plex Sans 400 16px, tabular, right-aligned for amounts
└──────────────────────────────┘
In reais. Your target, not a promise.   ← hint: caption, --muted-foreground
```

## Tokens and states

| State | Treatment |
|---|---|
| Rest | `h-10 px-3 rounded-md border border-input bg-muted text-body text-foreground tabular-nums` |
| Hover | border stays member (controls don't deepen; cards do) |
| Focus-visible | 2px `--ring` outline, 2px offset; border unchanged; no glow |
| Invalid | `aria-invalid="true"`, border `--destructive`, a sentence below in `--destructive` with a 12px notched-square glyph (shape, not colour alone). The sentence says what to change: "A monthly income goal needs the income profile." |
| Read-only | no well: `bg-transparent border-border`, text foreground. Used in the read-only sheet on PlanView |
| Disabled | `bg-transparent`, `border-border`, text `--muted-foreground`, plus the reason in the hint |
| Changed from parser | a 6px `--primary` square before the label and "edited" in the hint (so the person sees what differs from what the parser read) |

Select: native `<select>` with the same box and a 16px `ChevronDown` in `--muted-foreground`; options use human labels ("Low", "Accept credit risk"), never raw enum keys (`accept_fx`).

## Rules

- Label always visible above. Never placeholder-only.
- Amounts: `inputMode="decimal"`, formatted with `Intl.NumberFormat(locale)`, true minus U+2212 in display.
- Field width follows content length (amount ~12ch, month ~9ch), not the grid cell.
- Errors come from zod `issues[].path` and render next to their field, plus a summary at the top of the form (see [constraint-sheet.md](./constraint-sheet.md)).

## Accessibility

`<label for>`; hint and error joined in `aria-describedby`; error `role="alert"` only on submit (not on each keystroke). Font size ≥ 16px. Contrast: member 3.47 on paper, 3.14 on paper-sunk; ink on sunk 14.34; madder 5.80 on paper.

## Do / don't

| Do | Don't |
|---|---|
| `border-input` on every control | `border-border` (hair, 1.39:1) on a control |
| "Doesn't fit: pick a date after today" | "Invalid value" |
| Human labels | `target.kind`, `fxStance` |
