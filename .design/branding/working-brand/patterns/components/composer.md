# Composer (the typing box)
> Type: custom | Founder change 2026-10-01, kept in IDENTITY-2 (2026-10-08) | Tokens: `--tf-radius-composer` (20px), `--tf-radius-pill` (9999px), `--tf-glow`, `--tf-shadow-popover`

The one place where a person types to us in their own words. It is the roundest shape in the system (20px) and the first thing on the home page: the product in the first viewport, on the honey glow, with a sample plan beneath it. Buttons and inputs stay at 8px, cards at 10px; chips and badges are pills. The rounding is a signal: *here you talk; everywhere else is drawn*.

**Used by:** GoalFlow goal input (`apps/web/components/GoalFlow.tsx`), the landing simulator "Try a goal" panel, and the [subscribe block](./subscribe-block.md) (single-line variant). Not used for constraint-sheet fields, search, or any form field: those are [field.md](./field.md).

## Anatomy

```
╭──────────────────────────────────────────────────────────╮  ← container: rounded-composer (20px), 1px --input, --card fill
│ $40,000 by June 2028, cash within 7 days▌            ( ↑ ) │  ← borderless auto-growing textarea · round honey send (36px)
╰──────────────────────────────────────────────────────────╯
  Enter to fit · Shift+Enter for a new line                    ← optional hint, body-sm, muted
  (Apartment fund) (R$ 5.000 por mês) (Trip in 2029)           ← suggestion chips: pills, outside the box
```

1. **Container** `<div role="group">` (or the `<form>` itself): radius `--tf-radius-composer`, 1px `--input` border (line-l2 / line-2), background `--card` (white / night-2). Padding 8px 8px 8px 16px; min-height 52px. Flex row, items end-aligned (the button sits on the last line as text grows). On the home page it sits on `bg-glow` and may carry `shadow-popover` (the one shadow in the system, allowed on popovers and the composer); inside a card it carries no shadow.
2. **Textarea**: no border, no background, no outline of its own; Inter 400 16px (never smaller: prevents iOS zoom), line-height 24px, `--foreground`. Auto-grows from 1 to **5 lines** (max-height 120px), then scrolls. `field-sizing: content` where supported, JS fallback (`scrollHeight`) otherwise. Placeholder in `--muted-foreground` and **never the only label**.
3. **Send button**: 36 × 36, `rounded-full`, fill `--primary` (honey, both modes), icon `ArrowUp` 20px, stroke 2 square caps, colour `--primary-foreground` (ink). `aria-label="Fit it"` (subscribe: "Subscribe"). Hover `--tf-honey-hover`, pressed `--tf-honey-deep`.
4. **Label**: a visible label above (`text-caption uppercase font-medium text-muted-foreground`), or, in the chat panel where the heading already names it, a visually hidden `<label>`.
5. **Hint** (optional): body-sm in `--muted-foreground`, below the container, 8px gap.
6. **Chips** (optional): [button.md](./button.md) chip variant, pills, below the hint.

## Tokens

| Part | Light | Dark |
|---|---|---|
| Container bg | `--card` white `#FFFFFF` | `--card` night-2 `#13151C` |
| Container border | `--input` line-l2 `#C9C4B9` (1.74:1 on white: the fill, the label and the ring carry the boundary) | line-2 `#363B4B` (1.64:1 on night-2) |
| Text | ink (18.05:1) | text (16.15:1 on night-2) |
| Placeholder | muted-l (5.16:1) | muted (6.77:1 on night-2) |
| Send fill / icon | honey / ink (9.06:1) | honey / ink (9.06:1) |
| Focus ring | 2px `--ring` chalk-l `#2A73B0`, 2px offset | 2px chalk `#78B4E8`, 2px offset |
| Radius | container `rounded-composer`, button `rounded-full` | same |
| Behind it (home only) | `bg-glow` (honey 28% → 0, off-centre right) | `bg-glow` (honey 22% → 0) |

## States

| State | Treatment |
|---|---|
| Rest | as above |
| Hover (container) | border stays `--input` (the edge-deepen is for cards). Cursor text |
| Focus-within | ring on the **container** (`:focus-within` → `outline: 2px solid var(--ring); outline-offset: 2px`), following the 20px radius. The textarea has `outline: none` because the container carries it |
| Send focus | its own 2px chalk ring at 2px offset (round). Only visible when focus is on the button itself |
| Empty | send button `aria-disabled="true"`, fill `--muted`, icon `--muted-foreground`. Enter does nothing; no error |
| Busy (parsing) | textarea `readonly`, container `aria-busy="true"`; the send button shows the 3-segment honey loader (static when reduced motion) and a live status line "Reading your goal…" (`role="status"`). Never a counting or shimmering effect |
| Error (request failed) | border `--destructive`; sentence below in `--destructive` with `role="alert"`, saying what to do ("We couldn't read that. Try an amount and a date."). The typed text is kept |
| Disabled | whole container `opacity` is **not** used; border `--border`, text `--muted-foreground`, button removed from tab order |

## Behaviour

- **Enter submits; Shift+Enter inserts a newline.** Respect IME composition (`event.isComposing` → do not submit).
- Submitting sends the text to the parser only. The parser returns a ConstraintSheet that the person must see and can edit ([constraint-sheet.md](./constraint-sheet.md)); the composer never triggers the solver.
- Suggestion chips sit **outside** the composer, below it, as pills ([button.md](./button.md) chip variant). Clicking a chip fills the textarea and focuses it; it does not auto-submit in the app (the landing simulator may submit, because it is a sample simulation).
- The composer never shows a figure, so it carries no provenance pin.

## Single-line variant (subscribe)

Same container and button; `<input type="email">` instead of a textarea; fixed one line (min-height 52px); the send button may be a **text button inside the container** ("Subscribe", 36px tall, `rounded-full`, padding 0 16px, honey with ink) instead of the arrow, because "Subscribe" is clearer than an icon. Enter submits. See [subscribe-block.md](./subscribe-block.md).

## Accessibility (WCAG 2.2 AA)

- 1.4.11: the container is identified by its fill against the ground (white on paper, night-2 on night) and its visible label; the border is a hairline-weight edge and is not the sole boundary. Focus ring ≥ 3:1 (chalk-l 5.03 on white, chalk 8.77 on night).
- 2.4.7 / 2.4.11: focus visible on the container and not obscured by the sticky nav (`scroll-margin-top: 96px`).
- 2.5.8: send button 36px ≥ 24px target.
- 3.3.2: a programmatic label always exists (`<label for>` or `aria-labelledby` to the panel heading). The keyboard hint is in `aria-describedby`.
- 4.1.3: busy and error messages announced (`role="status"` / `role="alert"`).
- The textarea keeps `lang` of the UI (`pt-BR` or `en`).

## Code hint

```tsx
<form onSubmit={submit} className="space-y-2">
  <label htmlFor="goal" className="text-caption font-medium uppercase text-muted-foreground">Your goal</label>
  <div className="flex items-end gap-2 rounded-composer border border-input bg-card py-2 pr-2 pl-4
                  focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
       aria-busy={busy}>
    <textarea id="goal" rows={1} aria-describedby="goal-hint"
      className="max-h-[120px] min-h-6 flex-1 resize-none bg-transparent py-1.5 text-body outline-none
                 placeholder:text-muted-foreground [field-sizing:content]"
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
    <button type="submit" aria-label="Fit it" aria-disabled={!text.trim()}
      className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground
                 hover:bg-honey-hover active:bg-honey-deep aria-disabled:bg-muted aria-disabled:text-muted-foreground">
      <Icon name="ArrowUp" size={20} />
    </button>
  </div>
  <p id="goal-hint" className="text-body-sm text-muted-foreground">Enter to fit · Shift+Enter for a new line</p>
</form>
```

## Do / don't

| Do | Don't |
|---|---|
| 20px container, round honey send button with the ink arrow | A white arrow on honey, or a honey outline |
| Keep the 1px edge and the card fill so the box is seen; the glow behind it on the home page | A glass, blur or neon glow to lift it |
| Put the focus ring on the container | Ring the borderless textarea inside it |
| Use `ArrowUp` (add it to the icon registry) | Use `Sparkles`, `Wand` or `Send` paper-plane: the LLM reads and asks, it does not decide |
| Keep the typed text after an error | Clear the box or blame the person ("invalid input") |
