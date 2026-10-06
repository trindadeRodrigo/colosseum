'use client';
import { type ReactNode, useState } from 'react';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { Sparkline, sparkable } from '../../components/ui/Sparkline';
import { Segmented, TimeChart } from '../../components/ui/TimeChart';
import { useAnswer, useBearing } from './BearingProvider';
import { ChartGrid, picked, RANGES, usePageState } from './DexPage';
import { inPool, R, type Res } from './data';
import { type Fact, mk, none, sumFact } from './fact';
import { iso, minus, nf, pct, pct0, type Regime, RW, short, usd1 } from './format';
import {
  availability,
  collateralAssets,
  coverage,
  coveredSeries,
  covFacts,
  type Group,
  groupBy,
  histFact,
  type LendRow,
  lendSrc,
  markPartial,
  type Part,
  poolName,
  priceGroups,
  seriesFact,
  summed,
} from './lending';
import { Fig, Kpi, Kpis, Loading, MultiSelect, Pie, Reason, SrcLine } from './parts';
import { regimeAt } from './time';
import type { AssetsBody, HistBody } from './types';

// The lending page (analytics2.js, lendPage): if the collateral posted in the lending pools had to be
// sold today, how much of it the swap pools would take at a cost within the tolerance. The tolerance
// box (0.1% to 10%, default 1%) sets it for the whole page: counters, chart and table re-read the
// capacity at that tolerance.

export function LendingPage() {
  const { base, lending, reader, ui } = useBearing();
  const tol = ui.tol;
  const b = useAnswer(() => base(), [base]);
  const rows = useAnswer(() => lending(), [lending]);
  const assets = useAnswer(() => reader.get<AssetsBody>(R.assets(tol)), [reader, tol]);
  const ids = rows ? collateralAssets(rows) : null;
  const known =
    ids && assets?.ok ? ids.filter((a) => assets.body.assets.some((x) => x.symbol === a)) : null;
  const key = known ? `${tol}|${known.join(',')}` : null;
  const hist = useAnswer(
    () =>
      known
        ? inPool(
            known,
            6,
            async (a) => [a, await reader.get<HistBody>(R.hist(a, tol))] as const,
          ).then((pairs) => Object.fromEntries(pairs) as Record<string, Res<HistBody>>)
        : null,
    [key, reader],
  );
  if (!b || !rows || !assets || (assets.ok && b.lendList.ok && !hist))
    return <Loading>Reading the lending pools…</Loading>;
  if (!b.lendList.ok || !assets.ok)
    return (
      <p className="mt-6">
        <Reason code={b.lendList.ok ? assets.reason : b.lendList.reason} />
      </p>
    );
  return <LendView rows={rows} body={assets.body} assetIds={ids ?? []} histBy={hist ?? {}} />;
}

function LendView({
  rows,
  body,
  assetIds,
  histBy,
}: {
  rows: LendRow[];
  body: AssetsBody;
  assetIds: string[];
  histBy: Record<string, Res<HistBody>>;
}) {
  const { clock, reader, ui } = useBearing();
  const { sel, setSel, metric: m, setMetric, range, setRange } = usePageState('lending');
  const r = regimeAt(new Date(clock.now || Date.now()));
  const selRows = rows.filter((row) => picked(sel.pools, row.meta.account));
  const covs = selRows.map((row) => coverage(row, body, sel.assets, r));
  const key = `${ui.tol}|${r}|${selRows.map((x) => x.meta.account).join(',')}|${(sel.assets ?? []).join(',')}|${sel.assets == null}`;
  // Each asset's loss is priced at its whole collateral: once over every selected pool, once per row.
  const priced = useAnswer(async () => {
    const all = groupBy(covs);
    const perRow = covs.map((c) => groupBy([c]));
    await Promise.all([
      priceGroups(all, r, reader),
      ...perRow.map((g) => priceGroups(g, r, reader)),
    ]);
    return { all, perRow };
  }, [key, reader]);
  if (!priced) return <Loading>Pricing the collateral…</Loading>;
  return (
    <LendBody
      rows={rows}
      selRows={selRows}
      covs={covs}
      all={priced.all}
      perRow={priced.perRow}
      body={body}
      assetIds={assetIds}
      histBy={histBy}
      r={r}
      metric={m ?? 'covered'}
      setMetric={setMetric}
      range={range}
      setRange={setRange}
      setSel={setSel}
      sel={sel}
    />
  );
}

export const tolW = (tol: number) =>
  `${minus(nf({ maximumFractionDigits: 2 }).format(tol * 100))}%`;

/** The tolerance box: a sale counts as covered when it costs at most this. */
function TolBox() {
  const { ui, setUi } = useBearing();
  const [text, setText] = useState(nf({ maximumFractionDigits: 2 }).format(ui.tol * 100));
  const [err, setErr] = useState('');
  const apply = () => {
    const v = Number.parseFloat(text.replace(',', '.').replace('%', ''));
    if (!(v >= 0.1 && v <= 10)) {
      setErr('Between 0.1% and 10%');
      return;
    }
    setErr('');
    const t = Math.round(v * 100) / 10000;
    if (t !== ui.tol) setUi((s) => ({ ...s, tol: t }));
  };
  return (
    <label
      title="A sale counts as covered when it costs at most this, fees and price impact included"
      className="relative inline-flex items-center gap-1.5 text-caption text-muted-foreground"
    >
      <span>Tolerance</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        aria-describedby="bearing-tol-err"
        aria-invalid={err ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
        }}
        onBlur={apply}
        className="min-h-6 w-13 rounded-md border border-input bg-muted px-1.5 py-0.5 text-right font-mono text-caption font-medium text-foreground"
      />
      <span aria-hidden="true">%</span>
      <span
        id="bearing-tol-err"
        role="alert"
        className="absolute top-full right-0 text-b-meta whitespace-nowrap text-destructive"
      >
        {err}
      </span>
    </label>
  );
}

function LendBody(p: {
  rows: LendRow[];
  selRows: LendRow[];
  covs: Part[][];
  all: Group[];
  perRow: Group[][];
  body: AssetsBody;
  assetIds: string[];
  histBy: Record<string, Res<HistBody>>;
  r: Regime;
  metric: string;
  setMetric: (m: string) => void;
  range: number;
  setRange: (r: number) => void;
  sel: { assets: string[] | null; pools: string[] | null };
  setSel: (s: Partial<{ assets: string[] | null; pools: string[] | null }>) => void;
}) {
  const { clock, ui } = useBearing();
  const { rows, selRows, covs, all, perRow, body, r } = p;
  const tw = tolW(ui.tol);
  const facts = covFacts(all, r, body);
  const supF = sumFact(
    selRows.map((row) => histFact(row, 'suppliedUsd', 'supplied')),
    {
      method:
        'sum of supplied over the selected pools (Kamino: the token supplied to lend; Jupiter Lend vaults: the collateral deposited)',
    },
  );
  const borF = sumFact(
    selRows.map((row) => histFact(row, 'borrowedUsd', 'borrowed')),
    { method: 'sum of borrowed over the selected pools' },
  );
  const tools = (
    <Segmented
      label="Metric"
      options={[
        { id: 'covered', label: 'Covered' },
        { id: 'tvl', label: 'TVL over time' },
        { id: 'liquidity', label: 'Liquidity' },
      ]}
      value={p.metric}
      onChange={p.setMetric}
    />
  );
  const src = selRows.map(lendSrc).find(Boolean) ?? null;
  const now = clock.now || Date.now();

  let chart: ReactNode;
  if (p.metric === 'covered') {
    const cs = coveredSeries(all, p.histBy);
    const lastC = cs.filter((x) => x.v != null).pop();
    let from: string | null = null;
    for (const a of Object.keys(p.histBy)) {
      const h = p.histBy[a];
      if (h?.ok && h.body.from && (!from || h.body.from < from)) from = h.body.from;
    }
    const cf: Fact = lastC
      ? mk(lastC.v, {
          quality: lastC.lb ? 'lower_bound' : 'measured',
          source:
            'collateral: risk_lending_positions (GET /risk/facts/lending/:account); capacity: risk_asset_snapshots (GET /risk/assets/:id/history)',
          fetchedAt: new Date(lastC.t).toISOString(),
          method: `Σ min(that hour’s exit capacity at ≤ ${tw}, today’s collateral) ÷ today’s collateral, over the selected pools and assets`,
          methodVersion: 'history-0.1',
        })
      : none('not_collected');
    chart = (
      <TimeChart
        title={`Covered and not covered, ${tw} tolerance`}
        tools={tools}
        value={<Fig f={cf} fmt={pct} />}
        note={`today’s collateral against each hour’s exit capacity, as a share of 100%; hours where a collateral asset has no measurement are left out. The counter above reads the curve fitted over the whole time of week; this chart reads each hour’s own snapshot, so the two can differ. Hourly routed curves began ${
          from ? iso(from).slice(0, 10) : '2026-10-01'
        }.`}
        ranges={RANGES}
        range={p.range}
        onRange={p.setRange}
        hourly
        rangeTools={<TolBox />}
        panes={[
          {
            h: 260,
            fmt: pct0,
            max: 1,
            tagSeries: 1,
            series: [
              {
                type: 'area',
                cls: 'un',
                label: 'not covered',
                noDot: true,
                data: cs.map((x) => ({
                  t: x.t,
                  v: x.v == null ? null : 1,
                  show: x.v == null ? null : pct(1 - x.v),
                })),
              },
              {
                type: 'area',
                cls: 'cv',
                label: 'covered',
                data: cs.map((x) => ({ t: x.t, v: x.v, show: x.v == null ? null : pct(x.v) })),
              },
            ],
          },
        ]}
        legend={[
          { cls: 'cv', label: `covered: sold at ≤ ${tw} cost` },
          { cls: 'un', label: 'not covered: the sale would cost more' },
        ]}
        aria={`Share of collateral covered by pool depth at ${tw} cost, over time`}
        src={<SrcLine f={cf} what="the covered chart" />}
        empty={<Reason code="not_collected" />}
      />
    );
  } else if (p.metric === 'tvl') {
    const sup = markPartial(summed(selRows, 'suppliedUsd', now));
    const tf = seriesFact(sup, src, 'supplied summed over the selected pools');
    chart = (
      <TimeChart
        title="Supplied and borrowed"
        tools={tools}
        value={<Fig f={tf} fmt={usd1} />}
        note="summed over the selected pools: hourly for the last 7 days, the day’s last reading before that"
        ranges={RANGES}
        range={p.range}
        onRange={p.setRange}
        hourly
        rangeTools={<TolBox />}
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
        aria="Supplied and borrowed over time"
        src={<SrcLine f={tf} what="the supplied chart" />}
        empty={<Reason code="not_collected" />}
      />
    );
  } else
    chart = (
      <AvailChart
        rows={selRows}
        tools={tools}
        note="a Jupiter Lend vault has no figure here (its lent token sits in a shared liquidity layer)"
        rangeTools={<TolBox />}
        range={p.range}
        setRange={p.setRange}
      />
    );

  const poolOpts = rows.map((row) => ({ id: row.meta.account, label: poolName(row.meta) }));
  const assetOpts = p.assetIds.map((a) => ({ id: a, label: a }));
  type Row = { row: LendRow; i: number };
  const columns: Column<Row>[] = [
    {
      key: 'pool',
      header: 'Pool',
      rowHeader: true,
      cell: ({ row }) => (
        <>
          <span className="block font-normal whitespace-nowrap">{poolName(row.meta)}</span>
          <a
            href={`https://solscan.io/account/${row.meta.account}`}
            target="_blank"
            rel="noopener"
            aria-label={`View ${poolName(row.meta)} on Solscan`}
            className="font-mono text-source font-normal underline decoration-1 underline-offset-[3px] hover:decoration-2"
          >
            {short(row.meta.account)} ↗
          </a>
        </>
      ),
    },
    {
      key: 'sup',
      header: 'Supplied',
      numeric: true,
      cell: ({ row }) => <Fig f={histFact(row, 'suppliedUsd', 'supplied')} fmt={usd1} />,
    },
    {
      key: 'avail',
      header: 'Available now',
      numeric: true,
      cell: ({ row }) =>
        !row.sheet.ok ? (
          <Reason code={row.sheet.reason} />
        ) : row.meta.venue === 'jupiter_lend' ? (
          <Reason
            code="not_applicable"
            detail="the vault’s lent token sits in the shared Jupiter Lend liquidity layer"
          />
        ) : (
          <Fig f={row.sheet.body.withdrawal.availableUsd} fmt={usd1} />
        ),
    },
    {
      key: 'lent',
      header: 'Share lent out',
      numeric: true,
      cell: ({ row }) =>
        row.sheet.ok ? (
          <Fig f={row.sheet.body.withdrawal.shareLentOut} fmt={pct} />
        ) : (
          <Reason code={row.sheet.reason} />
        ),
    },
    {
      key: 'top1',
      header: 'Top-1 lender share',
      numeric: true,
      cell: ({ row }) =>
        row.sheet.ok ? (
          <Fig f={row.sheet.body.lenders.top1Share} fmt={pct} />
        ) : (
          <Reason code={row.sheet.reason} />
        ),
    },
    {
      key: 'coll',
      header: 'Collateral',
      numeric: true,
      cell: ({ i }) => {
        const f = covFacts(perRow[i] ?? [], r, body);
        const parts = covs[i] ?? [];
        return (
          <>
            <Fig f={f.collF} fmt={usd1} />
            {parts.length > 0 && (
              <span
                title={parts.map((x) => x.asset).join(', ')}
                className="block font-mono text-b-meta text-muted-foreground"
              >
                {parts.length === 1 ? parts[0]?.asset : `${parts.length} assets`}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: 'cov',
      header: 'Covered',
      numeric: true,
      cell: ({ i }) => <Fig f={covFacts(perRow[i] ?? [], r, body).covF} fmt={pct} />,
    },
    {
      key: 'max',
      header: 'Largest sale within tolerance',
      numeric: true,
      cell: ({ i }) => <Fig f={covFacts(perRow[i] ?? [], r, body).maxF} fmt={usd1} />,
    },
    {
      key: 'loss',
      header: 'Loss if all is sold',
      numeric: true,
      cell: ({ i }) => {
        const f = covFacts(perRow[i] ?? [], r, body);
        return (
          <>
            <Fig f={f.lossF} fmt={usd1} />
            {f.lossPF.value != null && (
              <span className="block font-mono text-b-meta text-muted-foreground">
                {pct(f.lossPF.value)} of it
              </span>
            )}
          </>
        );
      },
    },
    {
      key: 'spark',
      header: 'Covered, 30 d',
      cell: ({ i }) => {
        const values = coveredSeries(perRow[i] ?? [], p.histBy).map((x) => x.v);
        return sparkable(values) ? (
          <Sparkline values={values} cls="cv" />
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
          label="Lending pools"
          options={poolOpts}
          value={p.sel.pools}
          onChange={(v) => p.setSel({ pools: v })}
        />
        <MultiSelect
          label="Collateral"
          options={assetOpts}
          value={p.sel.assets}
          onChange={(v) => p.setSel({ assets: v })}
        />
        <span className="font-mono text-b-meta text-muted-foreground">
          {selRows.length} pool{selRows.length === 1 ? '' : 's'} · now {RW[r]}
        </span>
      </div>
      <Kpis>
        <Kpi label="Supplied">
          <Fig f={supF} fmt={usd1} />
        </Kpi>
        <Kpi label="Borrowed">
          <Fig f={borF} fmt={usd1} />
        </Kpi>
        <Kpi label="Collateral posted" note="selected assets">
          <Fig f={facts.collF} fmt={usd1} />
        </Kpi>
        <Kpi label="Covered now" note={`sold at ≤ ${tw} cost, ${RW[r]}`}>
          <Fig f={facts.covF} fmt={pct} />
        </Kpi>
        <Kpi label="Largest sale within tolerance" note={`${tw} tolerance`}>
          <Fig f={facts.maxF} fmt={usd1} />
        </Kpi>
        <Kpi
          label="Loss if all is sold"
          note={facts.lossPF.value != null ? `${pct(facts.lossPF.value)} of the collateral` : ''}
        >
          <Fig f={facts.lossF} fmt={usd1} />
        </Kpi>
      </Kpis>
      <ChartGrid
        pie={
          <Pie
            title="Supplied by pool"
            slices={selRows.map((row) => ({
              label: poolName(row.meta),
              value: histFact(row, 'suppliedUsd', 'supplied').value || 0,
            }))}
            total={supF.value || 0}
            totalHtml={<Fig f={supF} fmt={usd1} />}
            note="Kamino: the token supplied; Jupiter Lend vaults: the collateral deposited"
          />
        }
        chart={chart}
      />
      <section aria-labelledby="bearing-table" className="mt-8">
        <h2 id="bearing-table" className="mb-2 text-b-section font-semibold">
          Lending pools
        </h2>
        <p className="mb-3 max-w-[88ch] text-muted-foreground">
          Covered is the share of a pool’s collateral the swap pools could buy at a cost of at most{' '}
          {tw} in the current time of week ({RW[r]}); the rest would sell at a deeper loss. The loss
          if all is sold is the routed sale of every collateral asset at its full size, at once. In
          a row, each lending pool is counted on its own; in the counters and the chart, every
          position in one stock is added up first and sold into that stock’s pools once, since they
          draw on the same depth. Kamino reports collateral per market, so reserves of one market
          show the same collateral; the counters and the chart count it once.
        </p>
        <DataTable
          dense
          caption="Lending pools with coverage of their collateral"
          captionHidden
          rows={selRows.map((row, i) => ({ row, i }))}
          rowKey={({ row }) => row.meta.account}
          columns={columns}
        />
      </section>
    </>
  );
}

/** Available to withdraw over time, with the share lent out in a pane below. */
export function AvailChart({
  rows,
  tools,
  note,
  rangeTools,
  range,
  setRange,
}: {
  rows: readonly LendRow[];
  tools: ReactNode;
  note: string;
  rangeTools?: ReactNode;
  range: number;
  setRange: (r: number) => void;
}) {
  const { clock } = useBearing();
  const a = availability(rows, clock.now || Date.now());
  return (
    <TimeChart
      title="Available to withdraw"
      tools={tools}
      value={<Fig f={a.fact} fmt={usd1} />}
      note={`cash a lender could take out, and the share lent out below; ${note}`}
      ranges={RANGES}
      range={range}
      onRange={setRange}
      hourly
      rangeTools={rangeTools}
      panes={[
        {
          h: 200,
          fmt: usd1,
          series: [{ type: 'area', cls: 's1', label: 'available', data: a.av }],
        },
        {
          h: 90,
          fmt: pct0,
          max: 1,
          title: 'share lent out',
          series: [{ type: 'line', cls: 's2', label: 'share lent out', data: a.lent }],
        },
      ]}
      aria="Available to withdraw and share lent out over time"
      src={<SrcLine f={a.fact} what="the liquidity chart" />}
      empty={<Reason code="not_applicable" />}
    />
  );
}
