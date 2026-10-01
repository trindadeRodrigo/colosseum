# Data table and execution list (override)
> Type: override | Replaces: `w-full text-sm` + `text-gray-500` head + `border-t border-gray-100` rows (PlanView ×4, Monitor ×1); the duplicated execution list and explorer link

**Why override:** financial tables need tabular mono figures with pins, captions and scoped headers, status by word + shape, overflow handling, and a stacked layout on narrow screens. Mainnet transactions need one shared, always-linked line. Proposed: `components/ui/DataTable.tsx`, `components/ExecutionList.tsx`, `components/ui/ExplorerLink.tsx`.

## Table anatomy

| Part | Treatment |
|---|---|
| Wrapper | `overflow-x-auto` with `tabIndex={0}` and `role="region" aria-labelledby` (scrollable regions must be keyboard-reachable); panel radius 0 |
| Caption | `<caption>` visible, Plex Sans 600 `text-h4` left-aligned, or `sr-only` when a card header names it |
| Head | `bg-muted`, `<th scope="col">` Plex Sans 500 `text-caption text-muted-foreground`, sentence case, 1px `--border` bottom |
| Rows | 1px `--border` between rows; height 32px (`--tf-row-comfortable`), 28px dense (Monitor/Bearing). Hover `bg-accent` |
| Text cells | Plex Sans 400 `text-body-sm` (consumer) / Plex Sans Condensed `text-b-cell` (Bearing) |
| Number cells | right-aligned, `font-mono tabular-nums`; yields 2 decimals; true minus; pin after every yield/price/FX value |
| Source column | `font-mono text-source text-muted-foreground`: `source · fetched_at · method`, truncation with the full line in the pin popover |
| Projected values | text `--muted-foreground` + "projected" in the head; dashed = projected applies to inline sparklines |

## Status in tables

Drift rows that are out of band get the **Watch** mark (half-filled ochre square + "Out of band") in a status cell, plus `bg-status-watch-bg`. Colour fill alone is not allowed. Liquidity breaks: notched madder square + "Breaks in month 14".

## Responsive

Below 640px, tables with > 4 columns switch to stacked rows: each row becomes a `<dl>` block with the leg name as its heading. The risk sheet (10 columns) keeps horizontal scroll on tablet and stacks on phone.

## Execution list (shared by PlanView and Monitor)

```
Swap  5.00 USDC → USDY   · confirmed · 2026-09-30 14:02 UTC   Tx ↗ 4kZ9…mX2p
Deposit 3.00 USDC → Kamino · failed: slippage exceeded (not retried)   Tx ↗ 9aQ1…Lk7c
```

- One line per execution: verb · amount (tabular) · status word · time (UTC, ISO-ish) · **`Tx ↗` + shortened signature** in Plex Mono, linking to `explorerUrl` (`target="_blank" rel="noopener"`, accessible name "View transaction 4kZ9…mX2p on Solana Explorer").
- Every mainnet transaction is listed with its link. If `explorerUrl` is null, show the signature and "link unavailable" in muted text; never drop the row.
- Failed: notched madder square + "failed" + the error in words + "(not retried)". There is no retry button on a failed mainnet line; a new attempt is a new, explicitly signed action.
- Sandbox/devnet transactions carry the [MOCK plate](./mock-plate.md) and never use the mainnet explorer styling alone.
- Copy button (`Copy` icon, 32px) for the full signature; `Check` for 1.5s on success, announced via `role="status"`.

## Accessibility

`<caption>`, `scope`, keyboard-reachable scroll region, status words in cells, link text that names the destination. Contrast: stone on paper-sunk 4.61 (head text passes AA).

## Do / don't

| Do | Don't |
|---|---|
| `Tx ↗ 4kZ9…mX2p` in Plex Mono on every mainnet row | `text-blue-700 underline` or a bare hash |
| "Out of band" word + half square | An amber row with no word |
| Wrap every table in a scroll region | Let a 7-column table overflow the page |
