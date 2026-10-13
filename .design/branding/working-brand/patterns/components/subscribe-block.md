# Subscribe block (marketing closing)
> Type: custom | Component: `<SubscribeBlock>` | Source: landing prototype `.closing` + `form.sub` | Field: [composer.md](./composer.md) single-line variant | Revised 2026-10-08 (honey on night)

The landing's closing section: eyebrow, display heading (Inter Tight 600), a short lede, a framed picture (on the landing, the hero's joint drawn in ink coming together, gate `CLOSING-INK`; a photograph, with its caption below, where a page supplies one), and an email field to follow the build.

## Anatomy

```
                      Follow along                          ← eyebrow, Plex Mono 12px, --tf-honey-text, sentence case
          Built piece by piece. Watch it come together.     ← h2, Inter Tight 600 text-h2, max 20ch
   Product updates as new pieces are cut, and a short letter… ← lede, --muted-foreground, max 52ch
                   ┌──────────────────┐
                   │   [photo frame]  │                      ← 1px --border, 10px radius, no scrim
                   └──────────────────┘
                   stacked offset beams · reference photo    ← caption below, Plex Mono 12px
   EMAIL ADDRESS
   ╭───────────────────────────────────────────╮
   │ you@example.com                (Subscribe) │             ← composer, single-line: 20px, pill button inside
   ╰───────────────────────────────────────────╯
        ☑ Product updates   ☑ Newsletter                      ← checkbox group
        Unsubscribe any time.                                 ← status line, aria-live
```

- **Alignment**: this section is the one allowed centred composition on marketing (title cards may centre). The lede is short (≤ 3 lines) so centred text stays readable; longer body text stays flush left.
- **Field**: the [composer](./composer.md) single-line variant: container `rounded-composer` (20px), 1px `--input`, `--card` fill; `<input type="email" autocomplete="email">`; inline **Subscribe** button `rounded-full`, 36px tall, honey with ink. Width `min(520px, 100%)`. Below 520px the container stays one row (the button shrinks to the `ArrowUp` icon with `aria-label="Subscribe"`), rather than splitting into two shapes.
- **Visible label** "Email address" above the field (the prototype's off-screen label becomes visible, caption size, uppercase).
- **Options**: two checkboxes, native with `accent-color: var(--tf-honey)` (the browser draws the check in a dark colour on honey, which matches ink on honey), Inter 14px, `--muted-foreground` labels; `role="group" aria-label="What to receive"`. At least one must be checked.
- **Photo frame**: 10px radius, no gradient overlay, no text on the image; caption below.

## States

| State | Treatment |
|---|---|
| Rest | "Unsubscribe any time." in the status line |
| Focus | chalk ring on the composer container (2px `--ring`, 2px offset, following the 20px radius) |
| Invalid email (on submit) | container border `--destructive`; status line: "That email doesn't look complete. Check for an @ and a domain." `role="alert"` |
| No option checked | "Pick at least one: product updates or the newsletter." |
| Submitting | button `aria-busy`, label "Subscribing…" |
| Success | field cleared; status: "Check your inbox to confirm." (double opt-in). No confetti, no exclamation mark |
| Already subscribed | "You're already on the list." (neutral) |
| Server error | "We couldn't save that just now. Try again in a minute." Email kept in the field |

## Rules

- Consent: unchecked-by-default is the safer choice for the newsletter under LGPD/GDPR; **open item** (the prototype pre-checks both).
- The block makes no performance claims ("No hype, no price calls" is the lede's promise; keep it).
- Never collect a wallet address here.
- No serif heading; no glow behind this section (the glow belongs to the hero and the composer on the home page).

## Accessibility (WCAG 2.2 AA)

Visible label; `autocomplete="email"` (1.3.5); errors in text with suggestions (3.3.1/3.3.3); status in `aria-live="polite"`; button ≥ 24px; the container is identified by its card fill and its visible label (the line-l2 / line-2 edge is a hairline weight, see composer.md); ring chalk-l 5.03 on white / chalk 8.77 on night; Subscribe button ink on honey 9.06; image `alt` describes the beams and the trees beyond them.

## Do / don't

| Do | Don't |
|---|---|
| Composer shape for the field, 10px frame, 8px everything else | Round the checkboxes, or pill the frame or section |
| Visible label above | Placeholder as the only label |
| "Check your inbox to confirm." | "You're in! 🎉" |
