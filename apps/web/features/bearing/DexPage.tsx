'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { DistChart } from '../../components/ui/DistChart';
import { Sparkline, sparkable } from '../../components/ui/Sparkline';
import { type ChartRange, Segmented, TimeChart } from '../../components/ui/TimeChart';
import type { BearingDictionary } from '../../i18n/bearing';
import { type Base, useAnswer, useBearing } from './BearingProvider';
import { R } from './data';
import {
  COMMODITIES,
  capacitySeries,
  capFact,
  DAY,
  type DexAsset,
  dexCounters,
  dexIds,
  poolLabel,
  poolsOf,
  tvlSeries,
  vol24,
} from './dex';
import { type Fact, mk, none } from './fact';
import { type Fmt, iso } from './format';
import { HeatTile } from './HeatTile';
import {
  Card,
  Count,
  EmptyChart,
  Fig,
  Kpi,
  Kpis,
  Loading,
  MultiSelect,
  Pie,
  Reason,
  SrcLine,
  useChartPin,
  useFmt,
  useReason,
  useWords,
} from './parts';
import { regimeAt } from './time';
import type { AssetsBody, LiqHistBody, LiquidityBody, Pool } from './types';

// The stocks and the commodities pages (analytics2.js, dexPage): one row of counters, a pie of TVL by
// pool, one chart with a metric selector (exit capacity, TVL over time, liquidity by price band) and
// 24 h / 7 d / 30 d ranges, and the table of assets. The asset and pool filters drive every block.

export const RANGES: readonly ChartRange[] = [
  { label: '24 h', ms: DAY },
  { label: '7 d', ms: 7 * DAY },
  { label: '30 d', ms: 30 * DAY },
];

export function usePageState(page: string) {
  const { ui, setUi } = useBearing();
  const sel = ui.sel[page] ?? { assets: null, pools: null };
  return {
    sel,
    setSel: (next: Partial<typeof sel>) =>
      setUi((s) => ({ ...s, sel: { ...s.sel, [page]: { ...sel, ...next } } })),
    metric: ui.metric[page],
    setMetric: (m: string) => setUi((s) => ({ ...s, metric: { ...s.metric, [page]: m } })),
    range: ui.range,
    setRange: (r: number) => setUi((s) => ({ ...s, range: r })),
  };
}

export const picked = (set: readonly string[] | null, id: string) => !set || set.includes(id);

export function DexPage({ page }: { page: 'stocks' | 'commodities' }) {
  const { base, dex } = useBearing();
  const b = useAnswer(() => base(), [base]);
  const ids = b?.assets.ok ? dexIds(b.assets.body, page) : null;
  const key = ids?.join(',');
  const dd = useAnswer(() => (ids ? dex(ids) : null), [key, dex]);
  const router = useRouter();
  const state = usePageState(page);
  const t = useWords();

  // /analytics/stocks?asset=TSLAx (where /risk/tslax now leads): that asset alone, on its page.
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    setAsked(new URLSearchParams(window.location.search).get('asset'));
  }, []);
  useEffect(() => {
    if (!asked || !b?.assets.ok) return;
    const symbol = b.assets.body.assets.find(
      (a) => a.symbol.toLowerCase() === asked.toLowerCase(),
    )?.symbol;
    setAsked(null);
    if (!symbol) return;
    const home = COMMODITIES.includes(symbol) ? 'commodities' : 'stocks';
    if (home !== page) router.replace(`/analytics/${home}?asset=${encodeURIComponent(symbol)}`);
    else state.setSel({ assets: [symbol], pools: null });
  }, [asked, b, page, router, state]);

  if (!b || (b.assets.ok && !dd)) return <Loading>{t.dex.reading}</Loading>;
  if (!b.assets.ok)
    return (
      <p className="mt-6">
        <Reason code={b.assets.reason} />
      </p>
    );
  return <DexView page={page} b={b} body={b.assets.body} ids={ids ?? []} dd={dd ?? {}} />;
}

function DexView({
  page,
  b,
  body,
  ids,
  dd,
}: {
  page: string;
  b: Base;
  body: AssetsBody;
  ids: string[];
  dd: Record<string, DexAsset>;
}) {
  const fm = useFmt();
  const { clock } = useBearing();
  const all = useWords();
  const t = all.dex;
  const { sel, setSel, metric: m, setMetric, range, setRange } = usePageState(page);
  const r = regimeAt(new Date(clock.now || Date.now()));
  const rw = all.regimes[r];
  const byId = new Map(body.assets.map((a) => [a.symbol, a]));
  const assetOpts = ids.map((id) => ({
    id,
    label: id,
    sub: t.poolsSub(fm.num(poolsOf(dd[id]).length)),
  }));
  const selIds = ids.filter((id) => picked(sel.assets, id));
  const many = selIds.length > 1;
  const allPools = selIds
    .flatMap((id) => poolsOf(dd[id]))
    .sort((x, y) => (y.tvlUsd || 0) - (x.tvlUsd || 0));
  const poolOpts = allPools.map((p) => ({
    id: p.address,
    label: poolLabel(p, many, t.liquidity.quoteNotNamed),
    sub: fm.usd1(p.tvlUsd || 0),
  }));
  const pools = allPools.filter((p) => picked(sel.pools, p.address));
  const k = dexCounters(body, selIds, dd, pools, r, sel.pools != null && sel.pools.length === 0);
  const metric = m ?? 'capacity';
  const tools = (
    <Segmented
      label={all.chart.metric}
      options={[
        { id: 'capacity', label: t.metrics.capacity },
        { id: 'tvl', label: t.metrics.tvl },
        { id: 'liquidity', label: t.metrics.liquidity },
      ]}
      value={metric}
      onChange={setMetric}
    />
  );

  return (
    <>
      <div className="mt-6 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <MultiSelect
          label={t.assets}
          options={assetOpts}
          value={sel.assets}
          onChange={(v) => setSel({ assets: v, pools: null })}
        />
        <MultiSelect
          label={t.pools}
          options={poolOpts}
          value={sel.pools}
          onChange={(v) => setSel({ pools: v })}
        />
        <span className="font-mono text-b-meta text-muted-foreground">
          {t.summary(selIds.length, pools.length, rw)}
        </span>
      </div>
      <Kpis>
        <Kpi label={t.kpi.tvl} note={t.kpi.tvlNote}>
          <Fig f={k.tvl} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={t.kpi.pools} note={t.kpi.poolsNote(fm.num(allPools.length))}>
          <Count>{fm.num(pools.length)}</Count>
        </Kpi>
        <Kpi label={t.kpi.capacity} note={t.kpi.capacityNote(rw)}>
          <Fig f={k.cap} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={t.kpi.volume} note={k.volTo ? t.kpi.volumeNote(fm.minute(k.volTo)) : ''}>
          <Fig f={k.vol} fmt={fm.usd1} />
        </Kpi>
        <Kpi label={t.kpi.lp} note={t.kpi.lpNote}>
          <Fig f={k.lp} fmt={fm.pct} />
        </Kpi>
      </Kpis>
      <ChartGrid
        pie={
          <Pie
            title={t.pie.title}
            slices={pools.map((p) => ({
              label: poolLabel(p, many, t.liquidity.quoteNotNamed),
              value: p.tvlUsd || 0,
            }))}
            total={k.tvl.value || 0}
            totalHtml={<Fig f={k.tvl} fmt={fm.usd1} />}
            note={t.pie.note}
          />
        }
        chart={
          metric === 'capacity' ? (
            <CapacityChart
              selIds={selIds}
              dd={dd}
              tools={tools}
              range={range}
              setRange={setRange}
            />
          ) : metric === 'tvl' ? (
            <TvlChart
              pools={pools}
              b={b}
              tvl={k.tvl.value || 0}
              tools={tools}
              range={range}
              setRange={setRange}
            />
          ) : (
            <LiquidityChart pools={pools} b={b} many={many} tools={tools} />
          )
        }
      />
      {selIds.length === 1 && byId.get(selIds[0] as string) && (
        // one asset: its hours of the week, as its sheet in the first view and the old /risk/<asset> had them
        <div className="mt-4">
          <HeatTile asset={byId.get(selIds[0] as string) as AssetsBody['assets'][number]} />
        </div>
      )}
      <section aria-labelledby="bearing-table" className="mt-8">
        <h2 id="bearing-table" className="mb-2 text-b-section font-semibold">
          {t.table.title}
        </h2>
        <p className="mb-3 max-w-[88ch] text-muted-foreground">{t.table.note}</p>
        {selIds.length ? (
          <DataTable
            dense
            caption={t.table.caption}
            captionHidden
            rows={selIds}
            rowKey={(id) => id}
            columns={assetColumns(body, byId, dd, pools, sel.pools != null, t.table, fm)}
          />
        ) : (
          <p>
            <Reason code="nothing_selected" />
          </p>
        )}
      </section>
      <p className="mt-3 max-w-[88ch] font-mono text-b-meta text-muted-foreground">
        method {body.methodVersion} · τ = 1.00% · {body.honesty.join(' ')}
      </p>
    </>
  );
}

function assetColumns(
  body: AssetsBody,
  byId: Map<string, AssetsBody['assets'][number]>,
  dd: Record<string, DexAsset>,
  pools: readonly Pool[],
  poolsChosen: boolean,
  t: BearingDictionary['dex']['table'],
  fm: Fmt,
): Column<string>[] {
  const cap = (r: keyof typeof t.capacity): Column<string> => ({
    key: r,
    header: t.capacity[r],
    numeric: true,
    cell: (id) => <Fig f={capFact(byId.get(id), r, body)} fmt={fm.capW} />,
  });
  return [
    {
      key: 'asset',
      header: t.asset,
      rowHeader: true,
      cell: (id) => (
        <Link
          href={`/analytics/simulation?asset=${encodeURIComponent(id)}`}
          className="font-semibold underline decoration-1 underline-offset-[3px] hover:decoration-2"
        >
          {id}
        </Link>
      ),
    },
    {
      key: 'pools',
      header: t.pools,
      numeric: true,
      cell: (id) => {
        const d = dd[id];
        if (!d?.pools.ok) return <Reason code={d?.pools.reason} />;
        return (
          <>
            <Count>{fm.num(pools.filter((p) => p.assetSymbol === id).length)}</Count>
            {poolsChosen && (
              <span className="block font-mono text-b-meta text-muted-foreground">
                {t.poolsOf(fm.num(poolsOf(d).length))}
              </span>
            )}
          </>
        );
      },
    },
    cap('us_market_hours'),
    cap('us_offhours_weekday'),
    cap('weekend'),
    cap('us_holiday'),
    {
      key: 'vol',
      header: t.volume,
      numeric: true,
      cell: (id) => <Fig f={dd[id] ? vol24(dd[id].sheet) : none('not_collected')} fmt={fm.usd1} />,
    },
    {
      key: 'lp',
      header: t.lp,
      numeric: true,
      cell: (id) => {
        const s = dd[id]?.sheet;
        return s?.ok ? (
          <Fig f={s.body.liquidityStability.lpTop3Share} fmt={fm.pct} />
        ) : (
          <Reason code={s?.reason} />
        );
      },
    },
    {
      key: 'spark',
      header: t.spark,
      cell: (id) => {
        const h = dd[id]?.hist;
        const values = h?.ok ? (h.body.points ?? []).map((p) => p.sellCapacityUsd) : [];
        return sparkable(values) ? (
          <Sparkline values={values} />
        ) : (
          <Reason code={h?.ok ? 'insufficient_samples' : h?.reason} />
        );
      },
    },
  ];
}

/** The pie and the chart side by side; one above the other under 1100px. */
export function ChartGrid({ pie, chart }: { pie: ReactNode; chart: ReactNode }) {
  return (
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)] items-stretch gap-4 min-[1100px]:grid-cols-[minmax(260px,1fr)_minmax(0,2.6fr)]">
      <Card>{pie}</Card>
      <Card>{chart}</Card>
    </div>
  );
}

function CapacityChart({
  selIds,
  dd,
  tools,
  range,
  setRange,
}: {
  selIds: readonly string[];
  dd: Record<string, DexAsset>;
  tools: ReactNode;
  range: number;
  setRange: (r: number) => void;
}) {
  const chartPin = useChartPin();
  const fm = useFmt();
  const all = useWords();
  const t = all.dex.capacity;
  const s = capacitySeries(selIds, dd, t.partial, fm.usd1);
  return (
    <TimeChart
      {...chartPin(s.fact)}
      title={t.title}
      labels={all.chart}
      locale={fm.locale}
      tools={tools}
      value={<Fig f={s.fact} fmt={fm.usd1} />}
      note={t.note(s.from ? fm.day(s.from) : t.firstCurve)}
      ranges={RANGES}
      range={range}
      onRange={setRange}
      hourly
      panes={[
        {
          h: 260,
          fmt: fm.usd1,
          series: [
            { type: 'area', cls: 's1', label: t.sell, data: s.sell },
            { type: 'line', cls: 's2', label: t.buy, data: s.buy },
          ],
        },
      ]}
      legend={[
        { cls: 's1', label: t.sell },
        { cls: 's2', label: t.buy },
      ]}
      aria={t.aria}
      src={<SrcLine f={s.fact} what={t.src} />}
      empty={<Reason code="not_collected" />}
    />
  );
}

function TvlChart({
  pools,
  b,
  tvl,
  tools,
  range,
  setRange,
}: {
  pools: readonly Pool[];
  b: Base;
  tvl: number;
  tools: ReactNode;
  range: number;
  setRange: (r: number) => void;
}) {
  const chartPin = useChartPin();
  const fm = useFmt();
  const { reader } = useBearing();
  const all = useWords();
  const say = useReason();
  const t = all.dex.tvl;
  const rec = pools.filter((p) => b.recorded.has(p.address));
  const key = rec.map((p) => p.address).join(',');
  const hs = useAnswer(
    () =>
      rec.length
        ? Promise.all(rec.map((p) => reader.get<LiqHistBody>(R.liqHist(p.address))))
        : null,
    [key, reader],
  );
  if (!rec.length)
    return (
      <EmptyChart title={t.title} tools={tools}>
        {say('not_collected')}: {t.none}
      </EmptyChart>
    );
  if (!hs) return <Loading>{t.reading(rec.length)}</Loading>;
  const n = rec.length;
  const s = tvlSeries(hs, n, t.partial, fm.usd1);
  const recTvl = rec.reduce((a, p) => a + (p.tvlUsd || 0), 0);
  const share = tvl ? recTvl / tvl : null;
  return (
    <TimeChart
      {...chartPin(s.fact)}
      title={t.recorded}
      labels={all.chart}
      locale={fm.locale}
      tools={tools}
      value={<Fig f={s.fact} fmt={fm.usd1} />}
      note={t.note(n, pools.length, share != null ? fm.pct(share) : null)}
      ranges={RANGES}
      range={range}
      onRange={setRange}
      hourly
      panes={[
        {
          h: 260,
          fmt: fm.usd1,
          series: [
            { type: 'area', cls: 's1', label: t.value, data: s.value },
            { type: 'line', cls: 's2', label: t.held, data: s.held },
          ],
        },
      ]}
      legend={[
        { cls: 's1', label: t.valueLegend },
        { cls: 's2', label: t.heldLegend },
      ]}
      aria={t.aria}
      src={<SrcLine f={s.fact} what={t.src} />}
      empty={<Reason code="not_collected" />}
    />
  );
}

function LiquidityChart({
  pools,
  b,
  many,
  tools,
}: {
  pools: readonly Pool[];
  b: Base;
  many: boolean;
  tools: ReactNode;
}) {
  const fm = useFmt();
  const { reader } = useBearing();
  const all = useWords();
  const say = useReason();
  const t = all.dex.liquidity;
  const clmm = pools
    .filter((p) => /clmm|whirlpool|dlmm/.test(p.venue))
    .sort(
      (x, y) =>
        (b.recorded.has(y.address) ? 1 : 0) - (b.recorded.has(x.address) ? 1 : 0) ||
        (y.tvlUsd || 0) - (x.tvlUsd || 0),
    );
  const [chosen, setChosen] = useState<string | null>(null);
  const addr =
    chosen && clmm.some((p) => p.address === chosen) ? chosen : (clmm[0]?.address ?? null);
  const res = useAnswer(
    () => (addr ? reader.get<LiquidityBody>(R.liquidity(addr)) : null),
    [addr, reader],
  );
  if (!clmm.length)
    return (
      <EmptyChart title={t.title} tools={tools}>
        {say('not_applicable')}: {t.none}
      </EmptyChart>
    );
  let body: ReactNode;
  if (!res) body = <Loading>{t.reading}</Loading>;
  else if (!res.ok)
    body = (
      <EmptyChart title={t.both}>
        {say(res.reason)}: {t.failed(res.body?.error ?? say(res.reason))}
      </EmptyChart>
    );
  else if (!res.body.bands?.length)
    body = (
      <EmptyChart title={t.title}>
        <Reason code={res.body.reason ?? 'not_collected'} />
      </EmptyChart>
    );
  else {
    const d = res.body;
    const meta = {
      source: d.source,
      fetchedAt: d.fetchedAt,
      method: d.method,
      methodVersion: d.methodVersion,
      provenance: d.provenance,
    };
    const total: Fact = mk((d.totalAssetUsd || 0) + (d.totalQuoteUsd || 0), meta);
    const when =
      d.basis === 'recorded'
        ? t.recordedAt(fm.minute(d.fetchedAt))
        : t.liveAt(iso(d.fetchedAt).slice(11, 16));
    body = (
      <DistChart
        title={t.both}
        labels={all.chart}
        value={<Fig f={total} fmt={fm.usd1} />}
        note={t.note(when)}
        bands={d.bands.map((x) => ({
          lo: x.priceLow,
          hi: x.priceHigh,
          usd: x.amountUsd,
          side: x.side,
        }))}
        mid={d.midPrice}
        unit={`${d.quote ?? ''}/${d.asset ?? ''}`}
        fmtP={(v) => fm.num(v, v < 10 ? 4 : 2)}
        fmtY={fm.usd1}
        asset={d.asset || t.asset}
        quote={d.quote || t.quote}
        aria={t.aria(d.pool)}
        src={<SrcLine f={total} what={t.src} />}
      />
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        {tools}
        <label className="flex max-w-[440px] min-w-0 flex-col gap-1">
          <span className="text-caption font-medium text-muted-foreground">{t.pool}</span>
          <select
            value={addr ?? ''}
            onChange={(e) => setChosen(e.target.value)}
            className="min-h-8 min-w-0 rounded-md border border-input bg-muted px-2 py-1 text-[0.8125rem]"
          >
            {clmm.slice(0, 40).map((p) => (
              <option key={p.address} value={p.address}>
                {t.option(
                  poolLabel(p, many, t.quoteNotNamed),
                  fm.usd1(p.tvlUsd || 0),
                  b.recorded.has(p.address),
                )}
              </option>
            ))}
          </select>
        </label>
      </div>
      {body}
    </>
  );
}
