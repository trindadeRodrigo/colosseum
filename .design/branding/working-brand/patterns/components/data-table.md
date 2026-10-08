# Data table and execution list (override)
> Type: override | Replaces: `w-full text-sm` + `text-gray-500` head + `border-t border-gray-100` rows (PlanView ×4, Monitor ×1); the duplicated execution list and explorer link | Revised 2026-10-08 (honey on night)

**Why override:** financial tables need tabular figures with pins and signed deltas, captions and scoped headers, status by word + shape, a honey-tinted selected row, overflow handling, and a stacked layout on narrow screens. Mainnet transactions need one shared, always-linked line. Proposed: `components/ui/DataTable.tsx`, `components/ExecutionList.tsx`, `components/ui/ExplorerLink.tsx`.

## Table anatomy

| Part | Treatment |
|---|---|
| Wrapper | `overflow-x-auto rounded-lg border border-border` with `tabIndex={0}` and `role="region" aria-labelledby` (scrollable regions must be keyboard-reachable) |
| Caption | `<caption>` visible, Inter 600 `text-h4` left-aligned, or `sr-only` when a card header names it |
| Head | `bg-muted` (paper-3 / night-3), `<th scope="col">` Inter 500 `text-b-head` (11px, uppercase, +0.05em) `text-muted-foreground`, 1px `--border` bottom |
| Rows | 1px `--border` between rows; height 44px (`--tf-row-comfortable`), **36px dense** (Monitor / Bearing: a 20px line + 8px each side). Hover tint-rise `bg-accent`; selected `bg-accent` + `aria-selected` |
| Text cells | Inter 400 `text-body-sm` (consumer) / `text-b-cell` 13px (Bearing); the asset cell = 22px avatar · name Inter 600 · type tag (`rounded-sm bg-secondary text-muted-foreground` 11px) |
| Number cells | right-aligned, Inter `tabular-nums` (not mono); yields 2 decimals; true minus; pin after every yield/price/FX value; a signed delta beneath the value in `text-b-delta` (leaf up, madder down, muted flat) |
| Sparkline cell | 64 × 20 SVG, 1.5px stroke, coloured by direction (leaf / madder / muted), `aria-hidden` |
| Source column | `font-mono text-source text-muted-foreground`: `source · fetched_at · method`, truncation with the full line in the pin popover |
| Projected values | text `--muted-foreground` + "projected" in the head; dashed = projected applies to inline sparklines |

## Status in tables

Drift rows that are out of band get the **Watch** pill (half-filled clay square + "Out of band", `bg-clay-tint text-clay`) in a status cell. The row itself is not tinted by status (honey-tint means *selected*, never *warning*). Colour fill alone is not allowed. Liquidity breaks: notched madder square + "Breaks in month 14" in a madder-tint pill. Stale: hollow pin + "stale · 3 h". Sample: the row keeps a 6px hatched left edge, its figures keep the hatched pin, and the status cell reads "Sample figures" (or "Sample figures · test network") in muted, no box (gate MOCK-QUIET).

## Responsive

Below 640px, tables with > 4 columns switch to stacked rows: each row becomes a `<dl>` block with the leg name as its heading. The risk sheet (10 columns) keeps horizontal scroll on tablet and stacks on phone.

## Execution list (shared by PlanView and Monitor)

```
Swap  5.00 USDC → USDY   · confirmed · 2026-09-30 14:02 UTC   Tx ↗ 4kZ9…mX2p
Deposit 3.00 USDC → Kamino · failed: slippage exceeded (not retried)   Tx ↗ 9aQ1…Lk7c
```

- One line per execution: verb · amount (tabular) · status word · time (UTC, ISO-ish) · **`Tx ↗` + shortened signature** in Plex Mono, as a honey-l / honey link to `explorerUrl` (`target="_blank" rel="noopener"`, accessible name "View transaction 4kZ9…mX2p on Solana Explorer").
- Every mainnet transaction is listed with its link. If `explorerUrl` is null, show the signature and "link unavailable" in muted text; never drop the row.
- Failed: notched madder square + "failed" + the error in words + "(not retried)". There is no retry button on a failed mainnet line; a new attempt is a new, explicitly signed action.
- Sandbox / devnet transactions keep a hatched left edge and read "Test network · Solana · not live" in muted ([mock-plate.md](./mock-plate.md)); they never use the mainnet explorer styling alone.
- Copy button (`Copy` icon, 32px, `rounded-md`) for the full signature; `Check` for 1.5s on success, announced via `role="status"`.

## Accessibility

`<caption>`, `scope`, keyboard-reachable scroll region, status words in cells, link text that names the destination. Contrast: muted-l head text 4.37 on paper-3 (passes AA at 11px 500 only as uppercase caps with +0.05em; keep heads ≥ 11px), muted on night-3 6.25; row text ink 18.05 on white, text 16.15 on night-2; a selected row's text on the honey tint: ink 15.21 on `#F7EAD6` / text 13.63 on `#2D2318`; muted text on the tint 4.35 / 5.71.

## Do / don't

| Do | Don't |
|---|---|
| `Tx ↗ 4kZ9…mX2p` in Plex Mono on every mainnet row | `text-blue-700 underline` or a bare hash |
| "Out of band" word + half square in a clay pill | An amber row with no word |
| Honey-tint for the selected row only | Honey-tint as a warning or a highlight |
| Wrap every table in a scroll region | Let a 7-column table overflow the page |
