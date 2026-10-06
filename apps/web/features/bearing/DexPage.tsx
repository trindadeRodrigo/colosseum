'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { DistChart } from '../../components/ui/DistChart';
import { Sparkline, sparkable } from '../../components/ui/Sparkline';
import { type ChartRange, Segmented, TimeChart } from '../../components/ui/TimeChart';
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
import { capW, iso, num, pct, RW, reasonW, usd1 } from './format';
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

  if (!b || (b.assets.ok && !dd)) return <Loading>Reading the pools…</Loading>;
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
  const { clock } = useBearing();
  const { sel, setSel, metric: m, setMetric, range, setRange } = usePageState(page);
  const r = regimeAt(new Date(clock.now || Date.now()));
  const byId = new Map(body.assets.map((a) => [a.symbol, a]));
  const assetOpts = ids.map((id) => ({
    id,
    label: id,
    sub: `${num(poolsOf(dd[id]).length)} pools`,
  }));
  const selIds = ids.filter((id) => picked(sel.assets, id));
  const many = selIds.length > 1;
  const allPools = selIds
    .flatMap((id) => poolsOf(dd[id]))
    .sort((x, y) => (y.tvlUsd || 0) - (x.tvlUsd || 0));
  const poolOpts = allPools.map((p) => ({
    id: p.address,
    label: poolLabel(p, many),
    sub: usd1(p.tvlUsd || 0),
  }));
  const pools = allPools.filter((p) => picked(sel.pools, p.address));
  const k = dexCounters(body, selIds, dd, pools, r, sel.pools != null && sel.pools.length === 0);
  const metric = m ?? 'capacity';
  const tools = (
    <Segmented
      label="Metric"
      options={[
        { id: 'capacity', label: 'Exit capacity' },
        { id: 'tvl', label: 'TVL over time' },
        { id: 'liquidity', label: 'Liquidity' },
      ]}
      value={metric}
      onChange={setMetric}
    />
  );

  return (
    <>
      <div className="mt-6 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <MultiSelect
          label="Assets"
          options={assetOpts}
          value={sel.assets}
          onChange={(v) => setSel({ assets: v, pools: null })}
        />
        <MultiSelect
          label="Pools"
          options={poolOpts}
          value={sel.pools}
          onChange={(v) => setSel({ pools: v })}
        />
        <span className="font-mono text-b-meta text-muted-foreground">
          {selIds.length} asset{selIds.length === 1 ? '' : 's'} · {pools.length} pool
          {pools.length === 1 ? '' : 's'} · now {RW[r]}
        </span>
      </div>
      <Kpis>
        <Kpi label="Pool TVL" note="selected pools, read at registration">
          <Fig f={k.tvl} fmt={usd1} />
        </Kpi>
        <Kpi label="Pools" note={`of ${num(allPools.length)} on the selected assets`}>
          <Count>{num(pools.length)}</Count>
        </Kpi>
        <Kpi label="Exit capacity now" note={`sale at ≤ 1% cost, ${RW[r]}`}>
          <Fig f={k.cap} fmt={usd1} />
        </Kpi>
        <Kpi
          label="Volume 24 h"
          note={
            k.volTo
              ? `to ${iso(k.volTo).slice(0, 16).replace('T', ' ')} UTC, the newest swap history`
              : ''
          }
        >
          <Fig f={k.vol} fmt={usd1} />
        </Kpi>
        <Kpi label="Top-3 LP share" note="largest pool, by position">
          <Fig f={k.lp} fmt={pct} />
        </Kpi>
      </Kpis>
      <ChartGrid
        pie={
          <Pie
            title="TVL by pool"
            slices={pools.map((p) => ({ label: poolLabel(p, many), value: p.tvlUsd || 0 }))}
            total={k.tvl.value || 0}
            totalHtml={<Fig f={k.tvl} fmt={usd1} />}
            note="read when each pool was registered"
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
      <section aria-labelledby="bearing-table" className="mt-8">
        <h2 id="bearing-table" className="mb-2 text-b-section font-semibold">
          Assets
        </h2>
        <p className="mb-3 max-w-[88ch] text-muted-foreground">
          Capacity is the largest sale that costs at most 1%, by time of week. Exit capacity is that
          figure hour by hour. The pool filter narrows TVL, the pie, the pool count and the
          liquidity chart; capacity is routed across all of an asset’s pools, so it does not change
          with it. Open an asset to simulate selling it.
        </p>
        {selIds.length ? (
          <DataTable
            dense
            caption="Assets with pools, capacity, volume and LP share"
            captionHidden
            rows={selIds}
            rowKey={(id) => id}
            columns={assetColumns(body, byId, dd, pools, sel.pools != null)}
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
): Column<string>[] {
  const cap = (r: string, header: string): Column<string> => ({
    key: r,
    header,
    numeric: true,
    cell: (id) => <Fig f={capFact(byId.get(id), r, body)} fmt={capW} />,
  });
  return [
    {
      key: 'asset',
      header: 'Asset',
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
      header: 'Pools',
      numeric: true,
      cell: (id) => {
        const d = dd[id];
        if (!d?.pools.ok) return <Reason code={d?.pools.reason} />;
        return (
          <>
            <Count>{num(pools.filter((p) => p.assetSymbol === id).length)}</Count>
            {poolsChosen && (
              <span className="block font-mono text-b-meta text-muted-foreground">
                of {num(poolsOf(d).length)}
              </span>
            )}
          </>
        );
      },
    },
    cap('us_market_hours', 'Capacity, market hours'),
    cap('us_offhours_weekday', 'Capacity, off-hours'),
    cap('weekend', 'Capacity, weekend'),
    cap('us_holiday', 'Capacity, holiday'),
    {
      key: 'vol',
      header: 'Volume 24 h',
      numeric: true,
      cell: (id) => <Fig f={dd[id] ? vol24(dd[id].sheet) : none('not_collected')} fmt={usd1} />,
    },
    {
      key: 'lp',
      header: 'Top-3 LP share',
      numeric: true,
      cell: (id) => {
        const s = dd[id]?.sheet;
        return s?.ok ? (
          <Fig f={s.body.liquidityStability.lpTop3Share} fmt={pct} />
        ) : (
          <Reason code={s?.reason} />
        );
      },
    },
    {
      key: 'spark',
      header: 'Exit capacity, 30 d',
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
  const s = capacitySeries(selIds, dd);
  return (
    <TimeChart
      title="Exit capacity at ≤ 1% cost"
      tools={tools}
      value={<Fig f={s.fact} fmt={usd1} />}
      note={`sell and buy side, summed over the selected assets, one point per UTC hour since ${
        s.from ? iso(s.from).slice(0, 10) : 'the first routed curve'
      }, when the routed curves began`}
      ranges={RANGES}
      range={range}
      onRange={setRange}
      hourly
      panes={[
        {
          h: 260,
          fmt: usd1,
          series: [
            { type: 'area', cls: 's1', label: 'sell (exit)', data: s.sell },
            { type: 'line', cls: 's2', label: 'buy (entry)', data: s.buy },
          ],
        },
      ]}
      legend={[
        { cls: 's1', label: 'sell (exit)' },
        { cls: 's2', label: 'buy (entry)' },
      ]}
      aria="Exit and entry capacity over time for the selected assets"
      src={<SrcLine f={s.fact} what="the capacity chart" />}
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
  const { reader } = useBearing();
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
      <EmptyChart title="TVL over time" tools={tools}>
        {reasonW('not_collected')}: the collector records the pool value hour by hour only for the
        concentrated-liquidity pools that make up the top 80% of registry TVL, and none of the
        selected pools is one of them. Today’s TVL of the selection is in the counters; exit
        capacity over time is measured for every asset.
      </EmptyChart>
    );
  if (!hs)
    return (
      <Loading>
        Reading {rec.length} recorded pool{rec.length > 1 ? 's' : ''}…
      </Loading>
    );
  const n = rec.length;
  const s = tvlSeries(hs, n);
  const recTvl = rec.reduce((a, p) => a + (p.tvlUsd || 0), 0);
  const share = tvl ? recTvl / tvl : null;
  return (
    <TimeChart
      title="TVL over time, recorded pools"
      tools={tools}
      value={<Fig f={s.fact} fmt={usd1} />}
      note={`${n} of ${pools.length} selected pools are recorded hourly${
        share != null ? `, holding ${pct(share)} of the selection’s TVL` : ''
      }; the value of the tokens their liquidity holds, uncollected fees not counted. A pool not recorded in an hour keeps its last value for up to 6 h. Recordings began 2026-10-01.`}
      ranges={RANGES}
      range={range}
      onRange={setRange}
      hourly
      panes={[
        {
          h: 260,
          fmt: usd1,
          series: [
            { type: 'area', cls: 's1', label: 'pool value', data: s.value },
            { type: 'line', cls: 's2', label: 'of which in the asset', data: s.held },
          ],
        },
      ]}
      legend={[
        { cls: 's1', label: 'pool value (TVL)' },
        { cls: 's2', label: 'of which held in the asset' },
      ]}
      aria="Value held by the recorded pools over time"
      src={<SrcLine f={s.fact} what="the TVL chart" />}
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
  const { reader } = useBearing();
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
      <EmptyChart title="Liquidity by price band" tools={tools}>
        {reasonW('not_applicable')}: none of the selected pools is a concentrated-liquidity pool; a
        constant-product pool spreads its liquidity over every price.
      </EmptyChart>
    );
  let body: ReactNode;
  if (!res) body = <Loading>Reading the pool…</Loading>;
  else if (!res.ok)
    body = (
      <EmptyChart title="Liquidity by price band, both sides">
        {reasonW(res.reason)}: {res.body?.error ?? reasonW(res.reason)}. The collector records only
        the pools that make up the top 80% of registry TVL; pick one without “not recorded”, or wait
        for the live read.
      </EmptyChart>
    );
  else if (!res.body.bands?.length)
    body = (
      <EmptyChart title="Liquidity by price band">
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
        ? `the collector’s newest hourly recording, ${iso(d.fetchedAt).slice(0, 16).replace('T', ' ')} UTC`
        : `read live ${iso(d.fetchedAt).slice(11, 16)} UTC`;
    body = (
      <DistChart
        title="Liquidity by price band, both sides"
        value={<Fig f={total} fmt={usd1} />}
        note={`held within ±30% of the price, from ${when}; the asset waits above the price (sold into as it rises), the quote below (bought with as it falls); + and − zoom`}
        bands={d.bands.map((x) => ({
          lo: x.priceLow,
          hi: x.priceHigh,
          usd: x.amountUsd,
          side: x.side,
        }))}
        mid={d.midPrice}
        unit={`${d.quote ?? ''}/${d.asset ?? ''}`}
        fmtP={(v) => num(v, v < 10 ? 4 : 2)}
        fmtY={usd1}
        asset={d.asset || 'asset'}
        quote={d.quote || 'quote'}
        aria={`Liquidity of pool ${d.pool} by price band around the pool price`}
        src={<SrcLine f={total} what="the distribution chart" />}
      />
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        {tools}
        <label className="flex max-w-[440px] min-w-0 flex-col gap-1">
          <span className="text-caption font-medium text-muted-foreground">Pool</span>
          <select
            value={addr ?? ''}
            onChange={(e) => setChosen(e.target.value)}
            className="min-h-8 min-w-0 rounded-md border border-input bg-muted px-2 py-1 text-[0.8125rem]"
          >
            {clmm.slice(0, 40).map((p) => (
              <option key={p.address} value={p.address}>
                {`${poolLabel(p, many)} · TVL ${usd1(p.tvlUsd || 0)}${b.recorded.has(p.address) ? '' : ' · not recorded'}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {body}
    </>
  );
}
