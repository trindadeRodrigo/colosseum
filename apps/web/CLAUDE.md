# apps/web

@AGENTS.md

## Screens follow the design system

`.design/branding/working-brand/patterns/STYLE.md` is binding, with the component specs in `patterns/components/`. A screen that breaks one of these is wrong, however good it looks:

1. A provenance pin after every yield, price and FX figure. No pin, no number.
2. MOCK is never shown as live: the hatch, with one quiet line per card ("Sample figures · test network") and a hatched glyph or pin named "sample figure" on a figure; no boxed word MOCK (gate `MOCK-QUIET`). Text never sits on the hatch.
3. The disclaimer renders from the one `DISCLAIMER` constant, unedited, at body size.
4. No Japanese words or clichés in the product.
5. Nothing that looks like Teiten.
6. No blue or violet anywhere. Status is a word plus a shape plus an earth colour.
7. The brand recedes in the partner embed.

Square everywhere (2px radius, no shadows, no pills); the only rounded things are the typing box and its send button. Light and dark both ship. One primary button per view; a button that signs names the action and the amount. No spinners: a busy button changes its label.

Copy follows `.design/branding/working-brand/strategy/voice-and-tone.md`: answer, then reason, then risk, then action; "I" for the agent; sentence case; no exclamation marks; MOCK is the only uppercase word.
