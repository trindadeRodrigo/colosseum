'use client';
import { HeatmapTile } from '../../components/ui/HeatmapTile';
import type { HeatCell } from '../../components/ui/heatmap';
import { useAnswer, useBearing } from './BearingProvider';
import { R } from './data';
import { type Fact, maxT, mk } from './fact';
import { iso, REGIMES } from './format';
import { Fig, Reason, useFmt, useWords } from './parts';
import type { AssetRow, HeatmapBody } from './types';

// One asset's sell cost by hour of week (bearing-heatmap-tile.md; Rodrigo's first view drew it in an
// asset's panel, and the old /risk/<asset> page had it): the median of the best single-pool cost per
// snapshot in each Eastern hour, at $50,000, from GET /risk/assets/:id/heatmap. A lower cost is more
// depth. The route gives no measurement time, so each figure takes the asset's newest capacity
// reading, the snapshots it is drawn from; the method says so.

/** The hourly medians are kept at the cost curve's grid sizes only; $50,000 is the one nearest the
 *  pages' $100,000 on a log scale, as in the first view, and the size the old /risk/<asset> page used. */
export const HEAT_SIZE = 50_000;

export function HeatTile({ asset }: { asset: AssetRow }) {
  const fm = useFmt();
  const { reader, clock } = useBearing();
  const t = useWords().heat;
  const res = useAnswer(
    () => reader.get<HeatmapBody>(R.heatmap(asset.symbol, HEAT_SIZE)),
    [asset.symbol, reader],
  );
  const title = t.head(asset.symbol, fm.usd(HEAT_SIZE));
  if (!res) return <p className="text-caption text-muted-foreground">{t.reading}</p>;
  if (!res.ok || !res.body.cells.length)
    return (
      <div className="border border-border bg-card p-4">
        <div className="font-condensed text-b-head font-medium text-muted-foreground">{title}</div>
        <Reason code={res.ok ? 'no_samples_in_regime' : res.reason} />
      </div>
    );
  const h = res.body;
  let at: string | null = null;
  for (const r of REGIMES) at = maxT(at, asset.capacityAtTau[r]?.to ?? null);
  const n = h.notionalUsd ?? HEAT_SIZE;
  const meta = {
    source: 'risk_pool_snapshots (GET /risk/assets/:id/heatmap)',
    fetchedAt: at,
    method: `median of the best single-pool sell cost per snapshot in that ET hour at ${fm.usd(n)}; the route gives no measurement time, so the time is the asset’s newest capacity reading`,
    methodVersion: 'risk-0.3',
  };
  const fact = (v: number, samples: number): Fact => mk(v, { ...meta, samples, sizeUsd: n });
  const cells: HeatCell[] = h.cells.map((c) => ({
    day: Math.floor(c.hourOfWeekEt / 24),
    hour: c.hourOfWeekEt % 24,
    value: c.medianCost,
    samples: c.samples,
  }));
  const worst = h.cells.reduce((a, b) => (b.medianCost > a.medianCost ? b : a));
  const best = h.cells.reduce((a, b) => (b.medianCost < a.medianCost ? b : a));
  const when = (how: number) =>
    `${t.days[Math.floor(how / 24)]} ${String(how % 24).padStart(2, '0')}:00 ET`;
  const samples = h.cells.reduce((a, c) => a + c.samples, 0);
  const age = at ? Math.max(0, (clock.now - Date.parse(at)) / 1000) : 0;
  return (
    <HeatmapTile
      head={title}
      kpi={<Fig f={fact(worst.medianCost, worst.samples)} fmt={fm.pct} />}
      emph={t.thinnest(when(worst.hourOfWeekEt))}
      note={t.note}
      cells={cells}
      deeper="low"
      fmt={fm.pct}
      what={t.what(fm.usd(n))}
      zone="ET"
      least={<Fig f={fact(worst.medianCost, worst.samples)} fmt={fm.pct} />}
      most={<Fig f={fact(best.medianCost, best.samples)} fmt={fm.pct} />}
      cellFigure={(c) => <Fig f={fact(c.value, c.samples)} fmt={fm.pct} />}
      meta={t.meta(
        fm.num(samples),
        h.cells.length,
        `${h.timezone ?? 'America/New_York'}, ${h.hourOfWeek ?? 'Mon 00:00 = 0'}`,
        at ? fm.second(at) : iso(at),
      )}
      state={clock.stale ? { kind: 'stale', ageSec: age } : { kind: 'live' }}
      aria={t.aria(asset.symbol, fm.usd(n))}
      labels={t}
    />
  );
}
