import Link from 'next/link';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

type Cap = {
  status: 'ok' | 'insufficient_samples';
  capacityUsd: number | null;
  lowerBound: boolean;
  samples: number;
  from: string | null;
  to: string | null;
};
type Asset = {
  assetMint: string;
  symbol: string;
  poolTvlUsd: number;
  pools: number;
  capacityAtTau: Partial<Record<string, Cap>>;
  weekendRatio: number | null;
};
const REGIMES = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'] as const;
const usd = (v: number) =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}k`
      : `$${v.toFixed(0)}`;

function CapCell({ c }: { c?: Cap }) {
  if (!c) return <td className="px-2 text-gray-400">—</td>;
  if (c.status === 'insufficient_samples')
    return <td className="px-2 text-xs text-amber-700">insufficient ({c.samples} samples)</td>;
  return (
    <td
      className="px-2 tabular-nums"
      title={`${c.samples} samples · ${c.from?.slice(0, 16)} → ${c.to?.slice(0, 16)}`}
    >
      {c.lowerBound ? '≥ ' : ''}
      {usd(c.capacityUsd ?? 0)}
    </td>
  );
}

export default async function RiskHome({
  searchParams,
}: {
  searchParams: Promise<{ tau?: string }>;
}) {
  const tau = Number((await searchParams).tau ?? 0.01);
  let data: {
    methodVersion: string;
    tau: number;
    honesty: string[];
    disclaimer: string;
    assets: Asset[];
  } | null = null;
  let error: string | null = null;
  try {
    data = await apiGet(`/risk/assets?tau=${tau}`);
  } catch (e) {
    error = String(e);
  }
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Exit liquidity for tokenized stocks</h1>
        <p className="mt-1 text-gray-600">
          How much of each asset can be sold for dollars at a cost of at most{' '}
          {(tau * 100).toFixed(1)}%, by time of week, measured from on-chain pool state every 5
          minutes.{' '}
          <Link className="text-blue-700 underline" href="/risk/methodology">
            Methodology
          </Link>
        </p>
      </div>
      {error && <p className="text-sm text-red-700">API unavailable: {error}</p>}
      {data && (
        <>
          <ul className="list-disc pl-5 text-xs text-gray-600">
            {data.honesty.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="px-2">Asset</th>
                  <th className="px-2">Pool TVL</th>
                  <th className="px-2">Pools</th>
                  <th className="px-2">Market hours</th>
                  <th className="px-2">Weekday off-hours</th>
                  <th className="px-2">Weekend</th>
                  <th className="px-2">Holiday</th>
                  <th className="px-2">Weekend ÷ market hours</th>
                </tr>
              </thead>
              <tbody>
                {data.assets.map((a) => (
                  <tr key={a.assetMint} className="border-t border-gray-100">
                    <td className="px-2">
                      <Link
                        className="text-blue-700 underline"
                        href={`/risk/${a.symbol.toLowerCase()}`}
                      >
                        {a.symbol}
                      </Link>
                    </td>
                    <td className="px-2 tabular-nums">{usd(a.poolTvlUsd)}</td>
                    <td className="px-2 tabular-nums">{a.pools}</td>
                    {REGIMES.map((r) => (
                      <CapCell key={r} c={a.capacityAtTau[r]} />
                    ))}
                    <td className="px-2 tabular-nums">
                      {a.weekendRatio === null ? '—' : a.weekendRatio.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500">
            Method {data.methodVersion}. {data.disclaimer}
          </p>
        </>
      )}
    </section>
  );
}
