'use client';
import type { ReactNode } from 'react';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { Sparkline, sparkable } from '../../components/ui/Sparkline';
import { Segmented, TimeChart } from '../../components/ui/TimeChart';
import { useAnswer, useBearing } from './BearingProvider';
import { ChartGrid, picked, RANGES, usePageState } from './DexPage';
import { largestFirst, none, sumFact } from './fact';

import { AvailChart } from './LendingPage';
import {
  histFact,
  type LendRow,
  lendSeries,
  lendSrc,
  markPartial,
  poolName,
  STABLE,
  STABLE_OTHER,
  seriesFact,
  shareLentOut,
  summed,
} from './lending';
import {
  Count,
  Fig,
  Kpi,
  Kpis,
  MultiSelect,
  NotOnChain,
  PageWait,
  Pie,
  Reason,
  SrcLine,
  useChartPin,
  useFmt,
  useWords,
} from './parts';

// The stablecoins page (analytics2.js, stablePage): the Kamino reserves that lend a dollar token. A
// lender exits by withdrawing, so "available now" takes the place of exit capacity. Stablecoins the
// registry lists and the collectors do not measure yet are rows with their reason.

/** The stablecoins page while its reserves are read: five figures by their labels. */
export function StableWait() {
  const words = useWords();
  const k = words.stable.kpi;
  return (
    <PageWait
      label={words.stable.reading}
      kpis={[
        { label: k.supplied },
        { label: k.borrowed },
        { label: k.available, note: k.availableNote },
        { label: k.lent },
        { label: k.reserves, note: k.reservesNote },
      ]}
    />
  );
}

/** Lending pools are Solana's: on another chain the page says it is not collected there. */
export function StablePage() {
  const { chain } = useBearing();
  return chain === 'solana' ? <StableOnSolana /> : <NotOnChain />;
}

function StableOnSolana() {
  const { base, lending } = useBearing();
  const b = useAnswer(() => base(), [base]);
  const all = useAnswer(() => lending(), [lending]);
  const words = useWords();
  const reading = words.stable.reading;
  if (!b || !all) return <StableWait />;
  if (!b.lendList.ok)
    return (
      <p className="mt-6">
        <Reason code={b.lendList.reason} />
      </p>
    );
  return (
    <StableView
      rows={all.filter((row) => row.meta.venue === 'kamino' && STABLE.test(row.meta.symbol))}
    />
  );
}

type Token = { t: string; rs: LendRow[] } | { t: string; rs: null };

function StableView({ rows }: { rows: LendRow[] }) {
  const chartPin = useChartPin();
  const fm = useFmt();
  const { clock } = useBearing();
  const wds = useWords();
  const w = wds.stable;
  const { sel, setSel, metric: m, setMetric, range, setRange } = usePageState('stablecoins');
  const now = clock.now || Date.now();
  const tokens: string[] = [];
  for (const row of rows) if (!tokens.includes(row.meta.symbol)) tokens.push(row.meta.symbol);
  const r1 = rows.filter((row) => picked(sel.assets, row.meta.symbol));
  const poolOpts = r1.map((row) => ({
    id: row.meta.account,
    label: poolName(row.meta, wds.lending.market),
  }));
  const selRows = r1.filter((row) => picked(sel.pools, row.meta.account));
  const supF = sumFact(
    selRows.map((row) => histFact(row, 'suppliedUsd', 'supplied')),
    { method: 'sum of supplied over the selected reserves' },
  );
  const borF = sumFact(
    selRows.map((row) => histFact(row, 'borrowedUsd', 'borrowed')),
    { method: 'sum of borrowed over the selected reserves' },
  );
  const availOf = (row: LendRow) =>
    row.sheet.ok ? row.sheet.body.withdrawal.availableUsd : none(row.sheet.reason);
  const avF = sumFact(selRows.map(availOf), {
    method: 'sum of what lenders could withdraw now over the selected reserves',
  });
  const shF = shareLentOut(selRows, supF);
  const metric = m === 'liquidity' ? 'liquidity' : 'tvl';
  const tools = (
    <Segmented
      label={wds.chart.metric}
      options={[
        { id: 'tvl', label: w.metrics.tvl },
        { id: 'liquidity', label: w.metrics.liquidity },
      ]}
      value={metric}
      onChange={setMetric}
    />
  );
  const src = selRows.map(lendSrc).find(Boolean) ?? null;
  let chart: ReactNode;
  if (metric === 'tvl') {
    const sup = markPartial(
      summed(selRows, 'suppliedUsd', now),
      wds.lending.supplied.partial,
      fm.usd1,
    );
    const tf = seriesFact(sup, src, 'supplied summed over the selected reserves');
    chart = (
      <TimeChart
        {...chartPin(tf)}
        title={w.supplied.title}
        labels={wds.chart}
        locale={fm.locale}
        tools={tools}
        value={<Fig f={tf} fmt={fm.usd1} />}
        note={w.supplied.note}
        ranges={RANGES}
        range={range}
        onRange={setRange}
        hourly
        panes={[
          {
            h: 260,
            fmt: fm.usd1,
            series: [
              { type: 'area', cls: 's1', label: wds.lending.supplied.supplied, data: sup },
              {
                type: 'line',
                cls: 's2',
                label: wds.lending.supplied.borrowed,
                data: markPartial(
                  summed(selRows, 'borrowedUsd', now),
                  wds.lending.supplied.partial,
                  fm.usd1,
                ),
              },
            ],
          },
        ]}
        legend={[
          { cls: 's1', label: wds.lending.supplied.supplied },
          { cls: 's2', label: wds.lending.supplied.borrowed },
        ]}
        aria={w.supplied.aria}
        src={<SrcLine f={tf} what={wds.lending.supplied.src} />}
        empty={<Reason code="not_collected" />}
      />
    );
  } else
    chart = (
      <AvailChart
        rows={selRows}
        tools={tools}
        note={w.availNote}
        range={range}
        setRange={setRange}
      />
    );

  const list: Token[] = tokens
    .filter((t) => picked(sel.assets, t))
    .map((t) => ({ t, rs: selRows.filter((row) => row.meta.symbol === t) }))
    .filter((x) => x.rs.length > 0);
  if (!sel.assets)
    for (const t of STABLE_OTHER) if (!tokens.includes(t)) list.push({ t, rs: null });
  const biggest = (rs: LendRow[]) =>
    rs
      .slice()
      .sort((x, y) =>
        largestFirst(histFact(x, 'suppliedUsd', ''), histFact(y, 'suppliedUsd', '')),
      )[0] as LendRow;
  const note = (rs: LendRow[]) =>
    rs.length > 1 ? (
      <span className="block font-mono text-b-meta text-muted-foreground">{w.table.largest}</span>
    ) : null;
  const missing = <Reason code="not_collected" />;
  const columns: Column<Token>[] = [
    {
      key: 'asset',
      header: w.table.asset,
      rowHeader: true,
      cell: (x) => (
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <span className={x.rs ? undefined : 'text-muted-foreground'}>{x.t}</span>
        </span>
      ),
    },
    {
      key: 'n',
      header: w.table.reserves,
      numeric: true,
      cell: (x) => (x.rs ? <Count>{fm.num(x.rs.length)}</Count> : missing),
    },
    {
      key: 'sup',
      header: w.table.supplied,
      numeric: true,
      cell: (x) =>
        x.rs ? (
          <Fig
            f={sumFact(
              x.rs.map((row) => histFact(row, 'suppliedUsd', 'supplied')),
              { method: 'sum of supplied over the reserves' },
            )}
            fmt={fm.usd1}
          />
        ) : (
          missing
        ),
    },
    {
      key: 'av',
      header: w.table.available,
      numeric: true,
      cell: (x) =>
        x.rs ? (
          <Fig
            f={sumFact(x.rs.map(availOf), { method: 'sum of available over the reserves' })}
            fmt={fm.usd1}
          />
        ) : (
          missing
        ),
    },
    {
      key: 'lent',
      header: w.table.lent,
      numeric: true,
      cell: (x) => {
        if (!x.rs) return missing;
        const big = biggest(x.rs);
        return big.sheet.ok ? (
          <>
            <Fig f={big.sheet.body.withdrawal.shareLentOut} fmt={fm.pct} />
            {note(x.rs)}
          </>
        ) : (
          <Reason code={big.sheet.reason} />
        );
      },
    },
    { key: 'vol', header: w.table.volume, numeric: true, cell: () => missing },
    {
      key: 'top1',
      header: w.table.top1,
      numeric: true,
      cell: (x) => {
        if (!x.rs) return missing;
        const big = biggest(x.rs);
        return big.sheet.ok ? (
          <>
            <Fig f={big.sheet.body.lenders.top1Share} fmt={fm.pct} />
            {note(x.rs)}
          </>
        ) : (
          <Reason code={big.sheet.reason} />
        );
      },
    },
    {
      key: 'spark',
      header: w.table.spark,
      cell: (x) => {
        if (!x.rs) return missing;
        const values = lendSeries(biggest(x.rs)).map((q) => q.availableUsd);
        return sparkable(values) ? (
          <Sparkline values={values} />
        ) : (
          <Reason code="insufficient_samples" />
        );
      },
    },
  ];

  return (
    <>
      <div className="mt-6 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <MultiSelect
          label={w.coins}
          options={tokens.map((t) => ({ id: t, label: t }))}
          value={sel.assets}
          onChange={(v) => setSel({ assets: v, pools: null })}
        />
        <MultiSelect
          label={w.reserves}
          options={poolOpts}
          value={sel.pools}
          onChange={(v) => setSel({ pools: v })}
        />
        <span className="font-mono text-b-meta text-muted-foreground">
          {w.summary(selRows.length)}
        </span>
      </div>
      <Kpis>
        <Kpi label={w.kpi.supplied}>
          <Fig f={supF} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={w.kpi.borrowed}>
          <Fig f={borF} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={w.kpi.available} note={w.kpi.availableNote}>
          <Fig f={avF} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={w.kpi.lent}>
          <Fig f={shF} fmt={fm.pct} />
        </Kpi>
        <Kpi label={w.kpi.reserves} note={w.kpi.reservesNote}>
          <Count>{fm.num(selRows.length)}</Count>
        </Kpi>
      </Kpis>
      <ChartGrid
        pie={
          <Pie
            title={w.pie}
            slices={selRows.map((row) => ({
              label: poolName(row.meta, wds.lending.market),
              value: histFact(row, 'suppliedUsd', 'supplied').value,
            }))}
            total={supF.value}
            totalHtml={<Fig f={supF} fmt={fm.usd1} />}
          />
        }
        chart={chart}
      />
      <section aria-labelledby="bearing-table" className="mt-8">
        <h2 id="bearing-table" className="mb-2 text-b-section font-semibold">
          {w.table.title}
        </h2>
        <p className="mb-3 max-w-[88ch] text-muted-foreground">{w.table.note}</p>
        <DataTable
          dense
          caption={w.table.caption}
          captionHidden
          rows={list}
          rowKey={(x) => x.t}
          columns={columns}
        />
      </section>
    </>
  );
}
