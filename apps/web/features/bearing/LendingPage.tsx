'use client';
import { type ReactNode, useState } from 'react';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { Sparkline, sparkable } from '../../components/ui/Sparkline';
import { Segmented, TimeChart } from '../../components/ui/TimeChart';
import { useAnswer, useBearing } from './BearingProvider';
import { ChartGrid, picked, RANGES, usePageState } from './DexPage';
import { inPool, R, type Res } from './data';
import { type Fact, mk, none, sumFact } from './fact';
import { type Fmt, type Regime, short } from './format';
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
import {
  Fig,
  Kpi,
  Kpis,
  Loading,
  MultiSelect,
  NotOnChain,
  OnChain,
  PageWait,
  Pie,
  Reason,
  SrcLine,
  useFmt,
  useWords,
} from './parts';
import { regimeAt } from './time';
import type { AssetsBody, HistBody } from './types';

// The lending page (analytics2.js, lendPage): if the collateral posted in the lending pools had to be
// sold today, how much of it the swap pools would take at a cost within the tolerance. The tolerance
// box (0.1% to 10%, default 1%) sets it for the whole page: counters, chart and table re-read the
// capacity at that tolerance.

/** Lending pools are Solana's: on another chain the page says it is not collected there. */
export function LendingPage() {
  const { chain } = useBearing();
  return chain === 'solana' ? <LendingOnSolana /> : <NotOnChain />;
}

function LendingOnSolana() {
  const t = useWords();
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
    return (
      <PageWait
        label={t.lending.reading}
        kpis={[
          { label: t.lending.kpi.supplied },
          { label: t.lending.kpi.borrowed },
          { label: t.lending.kpi.collateral, note: t.lending.kpi.collateralNote },
          {
            label: t.lending.kpi.covered,
            note: t.lending.kpi.coveredNote('1.00%', t.regimes.us_market_hours),
          },
          { label: t.lending.kpi.largest, note: t.lending.kpi.largestNote('1.00%') },
        ]}
      />
    );
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
  const words = useWords();
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
  if (!priced) return <Loading>{words.lending.pricing}</Loading>;
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

export const tolW = (tol: number, fm: Fmt) => `${fm.num(tol * 100, 2)}%`;

/** The tolerance box: a sale counts as covered when it costs at most this. */
function TolBox() {
  const { ui, setUi } = useBearing();
  const fm = useFmt();
  const w = useWords().lending;
  const [text, setText] = useState(fm.num(ui.tol * 100, 2));
  const [err, setErr] = useState('');
  const apply = () => {
    const v = Number.parseFloat(text.replace(',', '.').replace('%', ''));
    if (!(v >= 0.1 && v <= 10)) {
      setErr(w.toleranceError);
      return;
    }
    setErr('');
    const t = Math.round(v * 100) / 10000;
    if (t !== ui.tol) setUi((s) => ({ ...s, tol: t }));
  };
  return (
    <label
      title={w.toleranceTitle}
      className="relative inline-flex items-center gap-1.5 text-caption text-muted-foreground"
    >
      <span>{w.tolerance}</span>
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
  const fm = useFmt();
  const { clock, ui } = useBearing();
  const wds = useWords();
  const t = wds.lending;
  const rw = wds.regimes[p.r];
  const { rows, selRows, covs, all, perRow, body, r } = p;
  const tw = tolW(ui.tol, fm);
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
      label={wds.chart.metric}
      options={[
        { id: 'covered', label: t.metrics.covered },
        { id: 'tvl', label: t.metrics.tvl },
        { id: 'liquidity', label: t.metrics.liquidity },
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
        title={t.covered.title(tw)}
        labels={wds.chart}
        locale={fm.locale}
        tools={tools}
        value={<Fig f={cf} fmt={fm.pct} />}
        note={t.covered.note(fm.day(from ?? '2026-10-01'))}
        ranges={RANGES}
        range={p.range}
        onRange={p.setRange}
        hourly
        rangeTools={<TolBox />}
        panes={[
          {
            h: 260,
            fmt: fm.pct0,
            max: 1,
            tagSeries: 1,
            series: [
              {
                type: 'area',
                cls: 'un',
                label: t.covered.notCovered,
                noDot: true,
                data: cs.map((x) => ({
                  t: x.t,
                  v: x.v == null ? null : 1,
                  show: x.v == null ? null : fm.pct(1 - x.v),
                })),
              },
              {
                type: 'area',
                cls: 'cv',
                label: t.covered.covered,
                data: cs.map((x) => ({ t: x.t, v: x.v, show: x.v == null ? null : fm.pct(x.v) })),
              },
            ],
          },
        ]}
        legend={[
          { cls: 'cv', label: t.covered.coveredLegend(tw) },
          { cls: 'un', label: t.covered.notCoveredLegend },
        ]}
        aria={t.covered.aria(tw)}
        src={<SrcLine f={cf} what={t.covered.src} />}
        empty={<Reason code="not_collected" />}
      />
    );
  } else if (p.metric === 'tvl') {
    const sup = markPartial(summed(selRows, 'suppliedUsd', now), t.supplied.partial, fm.usd1);
    const tf = seriesFact(sup, src, 'supplied summed over the selected pools');
    chart = (
      <TimeChart
        title={t.supplied.title}
        labels={wds.chart}
        locale={fm.locale}
        tools={tools}
        value={<Fig f={tf} fmt={fm.usd1} />}
        note={t.supplied.note}
        ranges={RANGES}
        range={p.range}
        onRange={p.setRange}
        hourly
        rangeTools={<TolBox />}
        panes={[
          {
            h: 260,
            fmt: fm.usd1,
            series: [
              { type: 'area', cls: 's1', label: t.supplied.supplied, data: sup },
              {
                type: 'line',
                cls: 's2',
                label: t.supplied.borrowed,
                data: markPartial(summed(selRows, 'borrowedUsd', now), t.supplied.partial, fm.usd1),
              },
            ],
          },
        ]}
        legend={[
          { cls: 's1', label: t.supplied.supplied },
          { cls: 's2', label: t.supplied.borrowed },
        ]}
        aria={t.supplied.aria}
        src={<SrcLine f={tf} what={t.supplied.src} />}
        empty={<Reason code="not_collected" />}
      />
    );
  } else
    chart = (
      <AvailChart
        rows={selRows}
        tools={tools}
        note={t.avail.jupiter}
        rangeTools={<TolBox />}
        range={p.range}
        setRange={p.setRange}
      />
    );

  const poolOpts = rows.map((row) => ({
    id: row.meta.account,
    label: poolName(row.meta, t.market),
  }));
  const assetOpts = p.assetIds.map((a) => ({ id: a, label: a }));
  type Row = { row: LendRow; i: number };
  const columns: Column<Row>[] = [
    {
      key: 'pool',
      header: t.table.pool,
      rowHeader: true,
      cell: ({ row }) => (
        <>
          <span className="flex flex-wrap items-baseline gap-x-2 font-normal whitespace-nowrap">
            {poolName(row.meta, t.market)}
            <OnChain />
          </span>
          <a
            href={`https://solscan.io/account/${row.meta.account}`}
            target="_blank"
            rel="noopener"
            aria-label={t.table.explorer(poolName(row.meta, t.market))}
            className="font-mono text-source font-normal underline decoration-1 underline-offset-[3px] hover:decoration-2"
          >
            {short(row.meta.account)} ↗
          </a>
        </>
      ),
    },
    {
      key: 'sup',
      header: t.table.supplied,
      numeric: true,
      cell: ({ row }) => <Fig f={histFact(row, 'suppliedUsd', 'supplied')} fmt={fm.usd1} />,
    },
    {
      key: 'avail',
      header: t.table.available,
      numeric: true,
      cell: ({ row }) =>
        !row.sheet.ok ? (
          <Reason code={row.sheet.reason} />
        ) : row.meta.venue === 'jupiter_lend' ? (
          <Reason code="not_applicable" detail={t.table.jupiterAvailable} />
        ) : (
          <Fig f={row.sheet.body.withdrawal.availableUsd} fmt={fm.usd1} />
        ),
    },
    {
      key: 'lent',
      header: t.table.lent,
      numeric: true,
      cell: ({ row }) =>
        row.sheet.ok ? (
          <Fig f={row.sheet.body.withdrawal.shareLentOut} fmt={fm.pct} />
        ) : (
          <Reason code={row.sheet.reason} />
        ),
    },
    {
      key: 'top1',
      header: t.table.top1,
      numeric: true,
      cell: ({ row }) =>
        row.sheet.ok ? (
          <Fig f={row.sheet.body.lenders.top1Share} fmt={fm.pct} />
        ) : (
          <Reason code={row.sheet.reason} />
        ),
    },
    {
      key: 'coll',
      header: t.table.collateral,
      numeric: true,
      cell: ({ i }) => {
        const f = covFacts(perRow[i] ?? [], r, body);
        const parts = covs[i] ?? [];
        return (
          <>
            <Fig f={f.collF} fmt={fm.usd1} />
            {parts.length > 0 && (
              <span
                title={parts.map((x) => x.asset).join(', ')}
                className="block font-mono text-b-meta text-muted-foreground"
              >
                {parts.length === 1 ? parts[0]?.asset : t.table.assets(parts.length)}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: 'cov',
      header: t.table.covered,
      numeric: true,
      cell: ({ i }) => <Fig f={covFacts(perRow[i] ?? [], r, body).covF} fmt={fm.pct} />,
    },
    {
      key: 'max',
      header: t.table.largest,
      numeric: true,
      cell: ({ i }) => <Fig f={covFacts(perRow[i] ?? [], r, body).maxF} fmt={fm.usd1} />,
    },
    {
      key: 'loss',
      header: t.table.loss,
      numeric: true,
      cell: ({ i }) => {
        const f = covFacts(perRow[i] ?? [], r, body);
        return (
          <>
            <Fig f={f.lossF} fmt={fm.usd1} />
            {f.lossPF.value != null && (
              <span className="block font-mono text-b-meta text-muted-foreground">
                {t.table.lossShare(fm.pct(f.lossPF.value))}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: 'spark',
      header: t.table.spark,
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
          label={t.pools}
          options={poolOpts}
          value={p.sel.pools}
          onChange={(v) => p.setSel({ pools: v })}
        />
        <MultiSelect
          label={t.collateral}
          options={assetOpts}
          value={p.sel.assets}
          onChange={(v) => p.setSel({ assets: v })}
        />
        <span className="font-mono text-b-meta text-muted-foreground">
          {t.summary(selRows.length, rw)}
        </span>
      </div>
      <Kpis>
        <Kpi label={t.kpi.supplied}>
          <Fig f={supF} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={t.kpi.borrowed}>
          <Fig f={borF} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={t.kpi.collateral} note={t.kpi.collateralNote}>
          <Fig f={facts.collF} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={t.kpi.covered} note={t.kpi.coveredNote(tw, rw)}>
          <Fig f={facts.covF} fmt={fm.pct} />
        </Kpi>
        <Kpi label={t.kpi.largest} note={t.kpi.largestNote(tw)}>
          <Fig f={facts.maxF} fmt={fm.usd1} />
        </Kpi>
        <Kpi
          label={t.kpi.loss}
          note={facts.lossPF.value != null ? t.kpi.lossNote(fm.pct(facts.lossPF.value)) : ''}
        >
          <Fig f={facts.lossF} fmt={fm.usd1} />
        </Kpi>
      </Kpis>
      <ChartGrid
        pie={
          <Pie
            title={t.pie.title}
            slices={selRows.map((row) => ({
              label: poolName(row.meta, t.market),
              value: histFact(row, 'suppliedUsd', 'supplied').value || 0,
            }))}
            total={supF.value || 0}
            totalHtml={<Fig f={supF} fmt={fm.usd1} />}
            note={t.pie.note}
          />
        }
        chart={chart}
      />
      <section aria-labelledby="bearing-table" className="mt-8">
        <h2 id="bearing-table" className="mb-2 text-b-section font-semibold">
          {t.table.title}
        </h2>
        <p className="mb-3 max-w-[88ch] text-muted-foreground">{t.table.note(tw, rw)}</p>
        <DataTable
          dense
          caption={t.table.caption}
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
  const fm = useFmt();
  const { clock } = useBearing();
  const all = useWords();
  const t = all.lending.avail;
  const a = availability(rows, clock.now || Date.now(), all.lending.supplied.partial, fm.usd1);
  return (
    <TimeChart
      title={t.title}
      labels={all.chart}
      locale={fm.locale}
      tools={tools}
      value={<Fig f={a.fact} fmt={fm.usd1} />}
      note={t.note(note)}
      ranges={RANGES}
      range={range}
      onRange={setRange}
      hourly
      rangeTools={rangeTools}
      panes={[
        {
          h: 200,
          fmt: fm.usd1,
          series: [{ type: 'area', cls: 's1', label: t.available, data: a.av }],
        },
        {
          h: 90,
          fmt: fm.pct0,
          max: 1,
          title: t.lent,
          series: [{ type: 'line', cls: 's2', label: t.lent, data: a.lent }],
        },
      ]}
      aria={t.aria}
      src={<SrcLine f={a.fact} what={t.src} />}
      empty={<Reason code="not_applicable" />}
    />
  );
}
