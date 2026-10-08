# Sample marking (gate MOCK-QUIET)
> Type: custom | Components: `.tf-sample-card` (the hatched edge), `<SampleLine>` (the quiet line), the hatched pin / `<SampleGlyph>` | Gate: `MOCK-QUIET` (Thom, 2026-10-06, docs/GATES.md) | Revised 2026-10-08 (honey on night). File name kept for links; the plate it once described is gone.

**The rule.** No boxed MOCK beside a figure, anywhere: landing, plan, buy and funding cards, risk, charts, embed, Bearing. A card whose figures are sample or from a test network keeps its **hatched left edge** and **says so once**, in a muted line with no box: "Sample figures · test network" ("Números de exemplo · rede de teste"), "sample rates, not live" on the landing's cases. A sample figure keeps its **hatched pin**, or a small **hatched glyph** where it has no pin, named "sample figure" for screen readers. Live figures keep their pin. Sample is never shown as live. The buy card's line on a test network reads "Test network · <chain> · not live". The word MOCK stays as the API value (`"provenance": "mock"`) and as the name of the state in the documents; it never appears as a label in the UI.

The P4 hatch is still a word, not a texture: it means *not finished*, and it appears only for **sample** and **stale**. Text never sits on hatch strokes.

## Anatomy

```
┃▨▨┃ KAMINO USDC · AFTER HAIRCUT
┃▨▨┃ 5.20% ⊡▨                                 ← the figure with its hatched pin (aria-label "sample figure")
┃▨▨┃ Sample figures · test network             ← the quiet line: Inter 400 12.5px, muted, once per card, no box
 6px hatched left edge of the card
```

Three parts, together, always:
1. **Hatched edge** `.tf-sample-card`: a 6px band on the card's left edge (`::before`, absolute, full height), `repeating-linear-gradient(45deg, var(--tf-hatch) 0 1px, transparent 1px var(--tf-hatch-pitch-ui))`. 1px strokes, **6px pitch** in UI, 3px inside the pin glyph, 4px in SVG drawings. Colour `--tf-hatch`: muted-l `#6A6D78` / muted `#9A9DAD` (5.16 on white / 6.77 on night-2). The card's padding grows by the band (24 → 30px) so content never sits on the strokes. For a whole mocked panel or showcase case the band may be the frame margin instead (8px between the outer 1px border and the inner solid surface).
2. **The quiet line** `<SampleLine>`: Inter 400, `text-sample-line` (12.5px / 18px), colour `--tf-sample-fg` (muted-l / muted), sentence case, no border, no fill, no icon. One per card, at its foot or in its head, beside the edge. Wording by context:
   - app, plan, risk, charts, Bearing: "Sample figures" · with a reason where useful: "Sample figures · Kamino rate feed not connected";
   - test network (`"provenance": "sandbox"`): "Sample figures · test network" / "Números de exemplo · rede de teste";
   - the buy card on a test network: "Test network · Solana · not live";
   - the landing's cases: "sample rates, not live";
   - never "MOCK", never "demo", never a tint or a pill. Muted, not chalk (chalk is a line colour; the buy card's line may use it only if a colour is needed at all).
3. **The figure's mark**: every sample yield, price or FX figure keeps the hatched pin ([provenance-pin.md](./provenance-pin.md) sample state, `aria-label="Source for 5.20%, sample figure"`). A sample figure that carries no pin (a count, an amount with no source line) gets the 12 × 12 hatched glyph `<SampleGlyph>` (`viewBox 0 0 12 12`, outline `rx 2` in `--tf-pin-outline`, 45° hatch at 3px pitch in `--tf-hatch`, `role="img" aria-label="sample figure"`).

## Placements

| Placement | Treatment |
|---|---|
| `card` (goal card, plan panel, Bearing tile, buy / funding card) | hatched left edge + one line at the foot (or in the head's meta slot), figures with hatched pins |
| `frame` (whole mocked panel or showcase case) | outer 1px border at the card radius (10px), 8px hatched margin, inner solid `--card` surface; the line in the pane foot ("sample rates, not live") |
| `row` (table row / plan leg) | 6px hatched band at the row's left edge; the row's figures keep the hatched pin; the status cell carries the line |
| `inline` (a figure alone, e.g. in prose) | hatched pin or hatched glyph only; the nearest card carries the line |
| `code` (API docs example) | hatched gutter + `"provenance": "mock"` (or `"sandbox"`) highlighted; the caption says "Sample response" |
| Embed | same shape in `--embed-muted` on `--embed-bg`: hatched edge, the line in `e-small`, hatched pins |

## States

There is no hover, active or dismiss state. The line is not interactive. If the whole view is a simulation (landing showcase, simulator), each panel carries its own line; a page-level notice does not replace per-card lines. A stale card uses the same edge with "stale · 3 h" as its line (a stale figure inline uses the hollow pin, not an edge).

## Accessibility

- The line is real text, read by screen readers, once per card. The hatched pin and glyph carry `aria-label="sample figure"` (or ", sample figure, test network" on the pin's button), so a figure is never announced as live.
- Muted-l on white 5.16, muted on night-2 6.77: the line passes AA at 12.5px. Ink on muted-l strokes is about 3.2:1, which is why text never sits on the hatch.
- Hatch is `aria-hidden` (CSS background). Forced-colors: the hatch disappears, the edge becomes a 1px dashed `CanvasText` rule, and the line remains.

## Enforcement

A DOM test in `apps/web` fails if:
- an element with `.tf-hatch` or `.tf-sample-card` has no `<SampleLine>` (or a stale line) in the same component subtree: **hatch never without the line**;
- any API payload with `provenance !== "live"` renders a figure without a hatched pin or `<SampleGlyph>`, or a card without a line;
- `provenance === "sandbox"` renders without the words "test network" (or "rede de teste");
- **any element's text content is exactly "MOCK"** (gate MOCK-QUIET).

## Code hint

```css
.tf-sample-card { position: relative; padding-left: calc(var(--spacing-6) + 6px); }
.tf-sample-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 6px;
  background-image: repeating-linear-gradient(45deg, var(--tf-hatch) 0 1px, transparent 1px var(--tf-hatch-pitch-ui)); }
.tf-sample-line { font: 400 var(--text-sample-line) / var(--text-sample-line--line-height) var(--font-sans); color: var(--tf-sample-fg); }
@media (forced-colors: active) { .tf-sample-card::before { background-image: none; border-left: 1px dashed CanvasText; } }
```

```tsx
export function SampleLine({ provenance, reason, lang = 'en' }: { provenance: Provenance; reason?: string; lang?: 'en' | 'pt' }) {
  const t = lang === 'pt' ? { s: 'Números de exemplo', n: 'rede de teste' } : { s: 'Sample figures', n: 'test network' };
  const parts = [t.s, provenance === 'sandbox' ? t.n : null, reason].filter(Boolean);
  return <p className="tf-sample-line">{parts.join(' · ')}</p>;
}
```

## Do / don't

| Do | Don't |
|---|---|
| Hatched left edge + one muted line per card | A boxed MOCK, a plate, a pill, a badge, a stamp |
| "Sample figures · test network" in Inter, muted | "MOCK" in Plex Mono, uppercase, anywhere a person reads |
| Hatched pin or hatched glyph on every sample figure, named "sample figure" | A solid pin, or no mark, on a sample figure |
| Hatch only for sample or stale, each with its line | Hatch as decoration, a section divider, an empty-state fill or a "no data" cell |
| Muted strokes, muted line | Clay, honey, chalk or yellow styling for sample |
