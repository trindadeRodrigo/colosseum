'use client';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { TAU, useAnswer, useBearing } from './BearingProvider';
import { R } from './data';
import { type Fact, mk } from './fact';
import { Card, Fig, Reason, useFmt, useWords } from './parts';
import type { ChainFigure, ChainsBody } from './types';

// The chains side by side (GET /risk/chains): for each chain Bearing measures, how many assets it
// tracks, their pools' TVL, the exit capacity at ≤ 1% cost in the time of week it is now, and the
// swap volume of the newest 24 h. Every figure has its pin; one a chain does not have yet says so.
// This is where the page mixes chains, so each row is headed by its chain's tag.

type Row = ChainsBody['chains'][number];

const fact = (f: ChainFigure): Fact =>
  mk(f.value, {
    source: f.source,
    fetchedAt: f.fetchedAt ?? null,
    method: f.method,
    methodVersion: f.methodVersion,
    provenance: f.provenance,
    regime: f.regime,
    quality:
      f.measuredAssets != null && f.assets != null && f.measuredAssets < f.assets
        ? 'lower_bound'
        : 'measured',
  });

export function ChainsSide() {
  const { reader } = useBearing();
  const t = useWords();
  const w = t.chain.sideBySide;
  const fm = useFmt();
  const res = useAnswer(() => reader.get<ChainsBody>(R.chains(TAU)), [reader]);
  const cell = (row: Row, f: ChainFigure, fmt: (v: number) => string) =>
    f.value == null ? (
      <Reason code="not_collected" whyCode={f.nullReason} />
    ) : (
      <Fig f={fact(f)} fmt={fmt} chain={row.chain} />
    );
  const columns: Column<Row>[] = [
    {
      key: 'chain',
      header: w.chain,
      rowHeader: true,
      cell: (r) => <ChainBadge chain={r.chain} />,
    },
    {
      key: 'assets',
      header: w.assets,
      numeric: true,
      cell: (r) => cell(r, r.assetsTracked, fm.num),
    },
    { key: 'tvl', header: w.tvl, numeric: true, cell: (r) => cell(r, r.poolTvlUsd, fm.usd1) },
    {
      key: 'capacity',
      header: w.capacity,
      numeric: true,
      cell: (r) => cell(r, r.exitCapacityUsd, fm.usd1),
    },
    {
      key: 'volume',
      header: w.volume,
      numeric: true,
      cell: (r) => cell(r, r.volume24hUsd, fm.usd1),
    },
  ];
  return (
    <section aria-labelledby="bearing-chains" className="mt-8" data-ui="bearing-chains">
      <h2 id="bearing-chains" className="mb-2 text-b-section font-semibold">
        {w.title}
      </h2>
      <p className="mb-3 max-w-[88ch] text-muted-foreground">{w.note}</p>
      <Card>
        {res?.ok ? (
          <DataTable
            dense
            caption={w.caption}
            captionHidden
            rows={res.body.chains}
            rowKey={(r) => r.chain}
            columns={columns}
          />
        ) : res ? (
          <Reason code={res.reason} />
        ) : (
          <span className="text-caption text-muted-foreground">{t.banner.loading}</span>
        )}
      </Card>
    </section>
  );
}
