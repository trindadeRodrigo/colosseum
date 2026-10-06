# Subscribe block (marketing closing)
> Type: custom | Component: `<SubscribeBlock>` | Source: landing prototype `.closing` + `form.sub` | Field: [composer.md](./composer.md) single-line variant

The landing's closing section: eyebrow, serif heading, a short lede, a framed picture (on the landing, the hero's joint drawn in ink coming together, gate `CLOSING-INK`; a photograph, with its caption below, where a page supplies one), and an email field to follow the build.

## Anatomy

```
                      Follow along                          ← eyebrow, Plex Mono 12px, --primary, sentence case
          Built piece by piece. Watch it come together.     ← h2, Newsreader 400 (the screen's serif line), max 20ch
   Product updates as new pieces are cut, and a short letter… ← lede, --muted-foreground, max 52ch
                   ┌──────────────────┐
                   │   [photo frame]  │                      ← 1px --border, 2px radius, no scrim
                   └──────────────────┘
                   stacked offset beams · reference photo    ← caption below, Plex Mono 12px
   Email address
   ╭───────────────────────────────────────────╮
   │ you@example.com                (Subscribe) │             ← composer, single-line: rounded-composer, round inline button
   ╰───────────────────────────────────────────╯
        ☑ Product updates   ☑ Newsletter                      ← checkbox group
        Unsubscribe any time.                                 ← status line, aria-live
```

- **Alignment**: this section is the one allowed centred composition on marketing (title cards may centre). The lede is short (≤ 3 lines) so centred text stays readable; longer body text stays flush left.
- **Field**: the [composer](./composer.md) single-line variant: container `rounded-composer` (20px), 1px `--input`, `--card` fill; `<input type="email" autocomplete="email">`; inline **Subscribe** button at `rounded-round`, 36px tall, `--primary` fill. Width `min(520px, 100%)`. Below 520px the container stays one row (the button shrinks to the `ArrowUp` icon with `aria-label="Subscribe"`), rather than splitting into two shapes.
- **Visible label** "Email address" above the field (the prototype's off-screen label becomes visible, caption size).
- **Options**: two checkboxes, square (0px; native with `accent-color: var(--primary)`), Plex Sans 14px, `--muted-foreground` labels; `role="group" aria-label="What to receive"`. At least one must be checked.
- **Photo frame**: no gradient overlay, no text on the image; caption below.

## States

| State | Treatment |
|---|---|
| Rest | "Unsubscribe any time." in the status line |
| Focus | ring on the composer container (2px `--ring`, 2px offset, following the 20px radius) |
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

## Accessibility (WCAG 2.2 AA)

Visible label; `autocomplete="email"` (1.3.5); errors in text with suggestions (3.3.1/3.3.3); status in `aria-live="polite"`; button ≥ 24px; container border 3.68:1 (light) / 3.55:1 (dark); image `alt` describes the beams and the forest view.

## Do / don't

| Do | Don't |
|---|---|
| Composer shape for the field, everything else 2px | Round the checkboxes, frame or section |
| Visible label above | Placeholder as the only label |
| "Check your inbox to confirm." | "You're in! 🎉" |
