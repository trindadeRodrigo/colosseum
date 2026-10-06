'use client';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { Sparkline, sparkable } from '../../components/ui/Sparkline';
import { Segmented, TimeChart } from '../../components/ui/TimeChart';
import { useAnswer, useBearing } from './BearingProvider';
import { ChartGrid, picked, RANGES, usePageState } from './DexPage';
import { none, sumFact } from './fact';
import { num, pct, usd1 } from './format';
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
import { Count, Fig, Kpi, Kpis, Loading, MultiSelect, Pie, Reason, SrcLine } from './parts';

// The stablecoins page (analytics2.js, stablePage): the Kamino reserves that lend a dollar token. A
// lender exits by withdrawing, so "available now" takes the place of exit capacity. Stablecoins the
// registry lists and the collectors do not measure yet are rows with their reason.

export function StablePage() {
  const { base, lending } = useBearing();
  const b = useAnswer(() => base(), [base]);
  const all = useAnswer(() => lending(), [lending]);
  if (!b || !all) return <Loading>Reading the stablecoin reserves…</Loading>;
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
  const { clock } = useBearing();
  const { sel, setSel, metric: m, setMetric, range, setRange } = usePageState('stablecoins');
  const now = clock.now || Date.now();
  const tokens: string[] = [];
  for (const row of rows) if (!tokens.includes(row.meta.symbol)) tokens.push(row.meta.symbol);
  const r1 = rows.filter((row) => picked(sel.assets, row.meta.symbol));
  const poolOpts = r1.map((row) => ({ id: row.meta.account, label: poolName(row.meta) }));
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
      label="Metric"
      options={[
        { id: 'tvl', label: 'TVL over time' },
        { id: 'liquidity', label: 'Liquidity' },
      ]}
      value={metric}
      onChange={setMetric}
    />
  );
  const src = selRows.map(lendSrc).find(Boolean) ?? null;
  let chart: React.ReactNode;
  if (metric === 'tvl') {
    const sup = markPartial(summed(selRows, 'suppliedUsd', now));
    const tf = seriesFact(sup, src, 'supplied summed over the selected reserves');
    chart = (
      <TimeChart
        title="Supplied and borrowed"
        tools={tools}
        value={<Fig f={tf} fmt={usd1} />}
        note="hourly for the last 7 days, the day’s last reading before that"
        ranges={RANGES}
        range={range}
        onRange={setRange}
        hourly
        panes={[
          {
            h: 260,
            fmt: usd1,
            series: [
              { type: 'area', cls: 's1', label: 'supplied', data: sup },
              {
                type: 'line',
                cls: 's2',
                label: 'borrowed',
                data: markPartial(summed(selRows, 'borrowedUsd', now)),
              },
            ],
          },
        ]}
        legend={[
          { cls: 's1', label: 'supplied' },
          { cls: 's2', label: 'borrowed' },
        ]}
        aria="Stablecoin supplied and borrowed over time"
        src={<SrcLine f={tf} what="the supplied chart" />}
        empty={<Reason code="not_collected" />}
      />
    );
  } else
    chart = (
      <AvailChart
        rows={selRows}
        tools={tools}
        note="summed over the selected reserves"
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
      .sort(
        (x, y) =>
          (histFact(y, 'suppliedUsd', '').value || 0) - (histFact(x, 'suppliedUsd', '').value || 0),
      )[0] as LendRow;
  const note = (rs: LendRow[]) =>
    rs.length > 1 ? (
      <span className="block font-mono text-b-meta text-muted-foreground">largest reserve</span>
    ) : null;
  const missing = <Reason code="not_collected" />;
  const columns: Column<Token>[] = [
    {
      key: 'asset',
      header: 'Asset',
      rowHeader: true,
      cell: (x) => <span className={x.rs ? undefined : 'text-muted-foreground'}>{x.t}</span>,
    },
    {
      key: 'n',
      header: 'Reserves',
      numeric: true,
      cell: (x) => (x.rs ? <Count>{num(x.rs.length)}</Count> : missing),
    },
    {
      key: 'sup',
      header: 'Supplied',
      numeric: true,
      cell: (x) =>
        x.rs ? (
          <Fig
            f={sumFact(
              x.rs.map((row) => histFact(row, 'suppliedUsd', 'supplied')),
              { method: 'sum of supplied over the reserves' },
            )}
            fmt={usd1}
          />
        ) : (
          missing
        ),
    },
    {
      key: 'av',
      header: 'Available now',
      numeric: true,
      cell: (x) =>
        x.rs ? (
          <Fig
            f={sumFact(x.rs.map(availOf), { method: 'sum of available over the reserves' })}
            fmt={usd1}
          />
        ) : (
          missing
        ),
    },
    {
      key: 'lent',
      header: 'Share lent out',
      numeric: true,
      cell: (x) => {
        if (!x.rs) return missing;
        const big = biggest(x.rs);
        return big.sheet.ok ? (
          <>
            <Fig f={big.sheet.body.withdrawal.shareLentOut} fmt={pct} />
            {note(x.rs)}
          </>
        ) : (
          <Reason code={big.sheet.reason} />
        );
      },
    },
    { key: 'vol', header: 'Volume 24 h', numeric: true, cell: () => missing },
    {
      key: 'top1',
      header: 'Top-1 lender share',
      numeric: true,
      cell: (x) => {
        if (!x.rs) return missing;
        const big = biggest(x.rs);
        return big.sheet.ok ? (
          <>
            <Fig f={big.sheet.body.lenders.top1Share} fmt={pct} />
            {note(x.rs)}
          </>
        ) : (
          <Reason code={big.sheet.reason} />
        );
      },
    },
    {
      key: 'spark',
      header: 'Available, 30 d',
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
          label="Stablecoins"
          options={tokens.map((t) => ({ id: t, label: t }))}
          value={sel.assets}
          onChange={(v) => setSel({ assets: v, pools: null })}
        />
        <MultiSelect
          label="Reserves"
          options={poolOpts}
          value={sel.pools}
          onChange={(v) => setSel({ pools: v })}
        />
        <span className="font-mono text-b-meta text-muted-foreground">
          {selRows.length} reserve{selRows.length === 1 ? '' : 's'}
        </span>
      </div>
      <Kpis>
        <Kpi label="Supplied">
          <Fig f={supF} fmt={usd1} />
        </Kpi>
        <Kpi label="Borrowed">
          <Fig f={borF} fmt={usd1} />
        </Kpi>
        <Kpi label="Available now" note="what lenders could withdraw">
          <Fig f={avF} fmt={usd1} />
        </Kpi>
        <Kpi label="Share lent out">
          <Fig f={shF} fmt={pct} />
        </Kpi>
        <Kpi label="Reserves" note="Kamino lending reserves">
          <Count>{num(selRows.length)}</Count>
        </Kpi>
      </Kpis>
      <ChartGrid
        pie={
          <Pie
            title="Supplied by reserve"
            slices={selRows.map((row) => ({
              label: poolName(row.meta),
              value: histFact(row, 'suppliedUsd', 'supplied').value || 0,
            }))}
            total={supF.value || 0}
            totalHtml={<Fig f={supF} fmt={usd1} />}
          />
        }
        chart={chart}
      />
      <section aria-labelledby="bearing-table" className="mt-8">
        <h2 id="bearing-table" className="mb-2 text-b-section font-semibold">
          Stablecoins
        </h2>
        <p className="mb-3 max-w-[88ch] text-muted-foreground">
          Measured where the collectors read them today: the Kamino lending reserves that lend them.
          A lender exits by withdrawing, so “available now” takes the place of exit capacity. Swap
          pools for stablecoins and the yield-bearing ones (USDY, syrupUSDC) are measured once item
          17 lands.
        </p>
        <DataTable
          dense
          caption="Stablecoins by lending reserve"
          captionHidden
          rows={list}
          rowKey={(x) => x.t}
          columns={columns}
        />
      </section>
    </>
  );
}
