# Composer (the typing box)
> Type: custom | Founder change 2026-10-01 | Tokens: `--tf-radius-composer` (20px), `--tf-radius-round` (9999px)

The one place where a person types to us in their own words. It is the **only rounded shape in the system**: the founder found a square typing box too close to Teiten. Everything around it (chips, panels, cards, buttons, the MOCK plate, the constraint-sheet fields) stays at 2px. The rounding is a signal: *here you talk; everywhere else is drawn*.

**Used by:** GoalFlow goal input (`apps/web/components/GoalFlow.tsx`), the landing simulator "Try a goal" panel, and the [subscribe block](./subscribe-block.md) (single-line variant). Not used for constraint-sheet fields, search, or any form field: those are [field.md](./field.md).

## Anatomy

```
╭──────────────────────────────────────────────────────────╮  ← container: rounded-composer (20px), 1px member, card bg
│ $40,000 by June 2028, cash within 7 days▌            ( ↑ ) │  ← borderless auto-growing textarea · round send (36px)
╰──────────────────────────────────────────────────────────╯
  Enter to fit · Shift+Enter for a new line                    ← optional hint, caption, muted
```

1. **Container** `<div role="group">` (or the `<form>` itself): radius `--tf-radius-composer`, 1px `--input` border (member / member-d), background `--card` (paper-raised on light, char on dark). Padding 8px 8px 8px 16px; min-height 52px. Flex row, items end-aligned (the button sits on the last line as text grows).
2. **Textarea**: no border, no background, no outline of its own; Plex Sans 400 16px (never smaller: prevents iOS zoom), line-height 24px, `--foreground`. Auto-grows from 1 to **5 lines** (max-height 120px), then scrolls. `field-sizing: content` where supported, JS fallback (`scrollHeight`) otherwise. Placeholder in `--muted-foreground` and **never the only label**.
3. **Send button**: 36 × 36, radius `--tf-radius-round`, fill `--primary` (hinoki on dark, hardwood on light: the species rule), icon `ArrowUp` 20px, stroke 1.5 square caps, colour `--primary-foreground`. `aria-label="Fit it"` (subscribe: "Subscribe"). Hover `--tf-primary-hover`, pressed `--tf-primary-pressed`.
4. **Label**: a visible label above (`text-caption font-medium`), or, in the chat panel where the heading already names it, a visually hidden `<label>`.
5. **Hint** (optional): caption in `--muted-foreground`, below the container, 8px gap.

## Tokens

| Part | Light | Dark |
|---|---|---|
| Container bg | `--card` paper-raised `#FBF8F2` | `--card` char `#1A1714` |
| Container border | `--input` member `#8C7F70` (3.68:1 on paper-raised) | member-d `#7A6D5F` (3.55:1 on char) |
| Text | ink (16.78:1) | washi (14.14:1 on char) |
| Placeholder | stone (5.39:1) | stone-d (6.45:1 on char) |
| Send fill / icon | hardwood / paper-raised (5.91:1) | hinoki / black (13.44:1) |
| Focus ring | 2px `--ring` hardwood, 2px offset | 2px hinoki, 2px offset |
| Radius | container `rounded-composer`, button `rounded-round` | same |

## States

| State | Treatment |
|---|---|
| Rest | as above |
| Hover (container) | border → `--primary` is **not** used; border stays member (hairline-deepen is for cards). Cursor text |
| Focus-within | ring on the **container** (`:focus-within` → `outline: 2px solid var(--ring); outline-offset: 2px`), following the 20px radius. The textarea has `outline: none` because the container carries it |
| Send focus | its own 2px ring at 2px offset (round). Only visible when focus is on the button itself |
| Empty | send button `aria-disabled="true"`, fill `--muted`, icon `--muted-foreground`. Enter does nothing; no error |
| Busy (parsing) | textarea `readonly`, container `aria-busy="true"`; send shows a 3×3 static lattice glyph (no spinner) and a live status line "Reading your goal…" (`role="status"`). Never a counting or shimmering effect |
| Error (request failed) | border `--destructive`; sentence below in `--destructive` with `role="alert"`, saying what to do ("We couldn't read that. Try an amount and a date."). The typed text is kept |
| Disabled | whole container `opacity` is **not** used; border `--border`, text `--muted-foreground`, button removed from tab order |

## Behaviour

- **Enter submits; Shift+Enter inserts a newline.** Respect IME composition (`event.isComposing` → do not submit).
- Submitting sends the text to the parser only. The parser returns a ConstraintSheet that the person must see and can edit ([constraint-sheet.md](./constraint-sheet.md)); the composer never triggers the solver.
- Suggestion chips sit **outside** the composer, below it, at 2px radius ([button.md](./button.md) chip variant). Clicking a chip fills the textarea and focuses it; it does not auto-submit in the app (the landing simulator may submit, because it is a MOCK simulation).
- The composer never shows a figure, so it carries no provenance pin.

## Single-line variant (subscribe)

Same container and button; `<input type="email">` instead of a textarea; fixed one line (min-height 52px); the send button may be a **text button inside the container** ("Subscribe", 36px tall, `rounded-round`, padding 0 16px) instead of the arrow, because "Subscribe" is clearer than an icon. Enter submits. See [subscribe-block.md](./subscribe-block.md).

## Accessibility (WCAG 2.2 AA)

- 1.4.11: container border ≥ 3:1 against its own fill in both modes (member 3.68 on paper-raised / member-d 3.55 on char). Focus ring ≥ 3:1 (hardwood 5.57 on paper, hinoki 13.44 on black).
- 2.4.7 / 2.4.11: focus visible on the container and not obscured by the sticky nav (`scroll-margin-top: 96px`).
- 2.5.8: send button 36px ≥ 24px target.
- 3.3.2: a programmatic label always exists (`<label for>` or `aria-labelledby` to the panel heading). The keyboard hint is in `aria-describedby`.
- 4.1.3: busy and error messages announced (`role="status"` / `role="alert"`).
- The textarea keeps `lang` of the UI (`pt-BR` or `en`).

## Code hint

```tsx
<form onSubmit={submit} className="space-y-2">
  <label htmlFor="goal" className="text-caption font-medium">Your goal</label>
  <div className="flex items-end gap-2 rounded-composer border border-input bg-card py-2 pr-2 pl-4
                  focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
       aria-busy={busy}>
    <textarea id="goal" rows={1} aria-describedby="goal-hint"
      className="max-h-[120px] min-h-6 flex-1 resize-none bg-transparent py-1.5 text-body outline-none
                 placeholder:text-muted-foreground [field-sizing:content]"
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
    <button type="submit" aria-label="Fit it" aria-disabled={!text.trim()}
      className="grid size-9 shrink-0 place-items-center rounded-round bg-primary text-primary-foreground
                 hover:bg-primary-hover active:bg-primary-pressed aria-disabled:bg-muted aria-disabled:text-muted-foreground">
      <Icon name="ArrowUp" size={20} />
    </button>
  </div>
  <p id="goal-hint" className="text-caption text-muted-foreground">Enter to fit · Shift+Enter for a new line</p>
</form>
```

## Do / don't

| Do | Don't |
|---|---|
| Round the composer container and its send button, nothing else | Round chips, the panel around the composer, the constraint-sheet fields, or other buttons "to match" |
| Keep the 1px member border so the box is seen | Use a shadow, glow or blur to lift it |
| Put the focus ring on the container | Ring the borderless textarea inside it |
| Use `ArrowUp` (add it to the icon registry) | Use `Sparkles`, `Wand` or `Send` paper-plane: the LLM reads and asks, it does not decide |
| Keep the typed text after an error | Clear the box or blame the person ("invalid input") |
