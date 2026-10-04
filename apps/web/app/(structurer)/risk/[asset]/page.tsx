import Link from 'next/link';
import { CostCurveChart } from '@/components/risk/CostCurveChart';
import { HourOfWeekHeatmap } from '@/components/risk/HourOfWeekHeatmap';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

type CurveRow = {
  regime: string;
  points: Array<{ notionalUsd: number; cost: number; samples: number }>;
  insufficientFrom: number | null;
  samples: number;
  dataFrom: string | null;
  dataTo: string | null;
  methodVersion: string;
};
type Lp = {
  pool: string;
  venue?: string;
  fetchedAt: string;
  positions: number;
  inBandPositions: number;
  top1: number;
  top3: number;
  top10: number;
  lpExitN: number;
  bandPct: number;
  sellBase: Array<{ notionalUsd: number; costPct: number }> | null;
  sellWithoutTopN: Array<{ notionalUsd: number; costPct: number }> | null;
};
type Pool = {
  address: string;
  venue: string;
  quoteSymbol: string | null;
  exitPath: string;
  tvlUsd: number;
  tier: string;
};
const REGIMES = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'];
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const usd = (v: number) =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}k`
      : `$${v.toFixed(0)}`;

export default async function AssetRisk({ params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  const curves: CurveRow[] = [];
  for (const r of REGIMES) {
    try {
      curves.push(await apiGet<CurveRow>(`/risk/assets/${asset}/depth?side=sell&regime=${r}`));
    } catch {
      // regime not measured yet
    }
  }
  const lp = await apiGet<{ pools: Lp[] }>(`/risk/assets/${asset}/lp`).catch(() => ({
    pools: [] as Lp[],
  }));
  const heat = await apiGet<{
    cells: Array<{ hourOfWeekEt: number; medianCost: number; samples: number }>;
    notionalUsd: number;
  }>(`/risk/assets/${asset}/heatmap?notional=50000`).catch(() => ({
    cells: [],
    notionalUsd: 50_000,
  }));
  const pools = await apiGet<{ pools: Pool[] }>(`/risk/pools?asset=${asset}`).catch(() => ({
    pools: [] as Pool[],
  }));
  const at = (xs: Lp['sellBase'], n: number) => xs?.find((p) => p.notionalUsd === n)?.costPct;
  return (
    <section className="space-y-6">
      <div>
        <Link href="/risk" className="text-sm text-blue-700 underline">
          ← all assets
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{asset.toUpperCase()}: exit liquidity</h1>
      </div>

      <div>
        <h2 className="font-semibold">Sell cost by size, per time of week</h2>
        <CostCurveChart curves={curves} tau={0.01} />
        <ul className="text-xs text-gray-600">
          {curves.map((c) => (
            <li key={c.regime}>
              {c.regime.replaceAll('_', ' ')}: {c.samples} samples, {c.dataFrom?.slice(0, 16)} →{' '}
              {c.dataTo?.slice(0, 16)} UTC
              {c.insufficientFrom !== null
                ? ` · dashed from point ${c.insufficientFrom + 1}: too few samples`
                : ''}{' '}
              · {c.methodVersion}
            </li>
          ))}
          {curves.length === 0 && <li>No curve yet: the collector needs more snapshots.</li>}
        </ul>
      </div>

      <div>
        <h2 className="font-semibold">Hour of week</h2>
        <HourOfWeekHeatmap cells={heat.cells} notionalUsd={heat.notionalUsd} />
      </div>

      <div>
        <h2 className="font-semibold">Who provides the liquidity</h2>
        <p className="text-xs text-gray-600">
          Share of liquidity within ±2% of the price held by the largest positions, and the cost of
          a sale if the largest {lp.pools[0]?.lpExitN ?? 3} positions withdraw. Positions, not
          owners (one owner can hold several).
        </p>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="px-2">Pool</th>
              <th className="px-2">Positions (in band)</th>
              <th className="px-2">Top 1</th>
              <th className="px-2">Top 3</th>
              <th className="px-2">Top 10</th>
              <th className="px-2">$50k sale: now → after exit</th>
              <th className="px-2">$250k sale: now → after exit</th>
              <th className="px-2">As of (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {lp.pools.map((p) => (
              <tr key={p.pool} className="border-t border-gray-100 tabular-nums">
                <td className="px-2 font-mono text-xs">{p.pool.slice(0, 8)}…</td>
                <td className="px-2">
                  {p.positions} ({p.inBandPositions})
                </td>
                <td className="px-2">{pct(p.top1)}</td>
                <td className="px-2">{pct(p.top3)}</td>
                <td className="px-2">{pct(p.top10)}</td>
                <td className="px-2">
                  {at(p.sellBase, 50_000)?.toFixed(2)}% →{' '}
                  {at(p.sellWithoutTopN, 50_000)?.toFixed(2)}%
                </td>
                <td className="px-2">
                  {at(p.sellBase, 250_000)?.toFixed(2)}% →{' '}
                  {at(p.sellWithoutTopN, 250_000)?.toFixed(2)}%
                </td>
                <td className="px-2 text-xs">{p.fetchedAt.slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="font-semibold">Pools</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="px-2">Pool</th>
              <th className="px-2">Venue</th>
              <th className="px-2">Quote</th>
              <th className="px-2">Exit path</th>
              <th className="px-2">TVL (on-chain)</th>
              <th className="px-2">Refresh</th>
            </tr>
          </thead>
          <tbody>
            {pools.pools.slice(0, 25).map((p) => (
              <tr key={p.address} className="border-t border-gray-100">
                <td className="px-2 font-mono text-xs">
                  <a
                    className="text-blue-700 underline"
                    href={`https://solscan.io/account/${p.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.address.slice(0, 8)}…
                  </a>
                </td>
                <td className="px-2">{p.venue}</td>
                <td className="px-2">{p.quoteSymbol ?? 'other'}</td>
                <td className="px-2">{p.exitPath.replace('_', ' ')}</td>
                <td className="px-2 tabular-nums">{usd(p.tvlUsd ?? 0)}</td>
                <td className="px-2">{p.tier === 'A' ? '5 min' : 'hourly'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
