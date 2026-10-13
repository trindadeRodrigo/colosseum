'use client';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinLabels, PinSource } from '../../components/ui/provenance';

// Shares of one whole as a list of bars, largest first: each with its name, its dollars with their
// pin, and its percentage, over one bar whose length is the share. The design system's own bar
// (plan-leg.md) stacks at most four legs and labels each with a rate, so it does not fit a list of any
// length with no rate: this one is drawn here, in SVG, with the same fill, square and solid, as the
// monitor's plan parts are (features/portfolio/VaultPanel.tsx). The bars are a picture of figures
// written beside them, so they are hidden from a screen reader, which reads the list as a list.

export type ShareRow = {
  key: string;
  /** The share's name as a person reads it. */
  name: string;
  /** Its dollars, already formatted. */
  dollars: string;
  /** Its percentage of the whole, already formatted. */
  percent: string;
  /** The same share in basis points: the length of the bar. */
  bps: number;
};

/** One bar: the share of the whole it is drawn in. A share that is held is never drawn as nothing. */
function ShareBar({ bps }: { bps: number }) {
  const width = bps > 0 ? Math.min(100, Math.max(bps / 100, 0.75)) : 0;
  return (
    <svg
      data-ui="share-bar"
      aria-hidden="true"
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      className="block h-2 w-full"
    >
      <rect width="100" height="4" className="fill-muted" />
      <rect data-ui="share-fill" width={width} height="4" className="fill-leg-1" />
    </svg>
  );
}

export function ShareBars({
  by,
  labelledBy,
  rows,
  obs,
  pinLabels,
}: {
  /** What the whole is split by: for a test and a style to find the list. */
  by: 'underlying' | 'issuer';
  /** The id of the heading that names the list. */
  labelledBy: string;
  /** Largest first. */
  rows: readonly ShareRow[];
  /** The stamp of the sums: every row's dollars carry it. */
  obs: PinSource;
  pinLabels: Partial<PinLabels>;
}) {
  return (
    <ol
      data-ui="shares"
      data-by={by}
      aria-labelledby={labelledBy}
      className="flex list-none flex-col gap-3 p-0"
    >
      {rows.map((row) => (
        <li key={row.key} data-ui="share" data-key={row.key} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-body-sm">
            <span data-ui="share-name" className="font-medium">
              {row.name}
            </span>
            <span className="inline-flex items-baseline gap-x-3 tabular-nums">
              <ProvenancePin value={row.dollars} obs={obs} labels={pinLabels} />
              <span data-ui="share-percent" className="min-w-14 text-right">
                {row.percent}
              </span>
            </span>
          </div>
          <ShareBar bps={row.bps} />
        </li>
      ))}
    </ol>
  );
}
