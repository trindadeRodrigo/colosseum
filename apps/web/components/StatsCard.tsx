import { apiGet } from '@/lib/api';

type Stats = {
  wallets: number;
  plans: number;
  executionsConfirmed: number;
  rebalances: number;
  byKind: Record<string, number>;
  observedValueUsd: number;
  firstExecutionAt: string | null;
  asOf: string;
};

/** Live numbers from the database for the video close: no hand-typed figures. */
export async function StatsCard() {
  let s: Stats | null = null;
  try {
    s = await apiGet<Stats>('/stats');
  } catch {
    s = null;
  }
  // When the server does not answer for /stats, the card says so in place of the numbers.
  if (!s)
    return (
      <section>
        <h2 className="font-semibold">Live on mainnet</h2>
        <p className="mt-1 text-sm text-gray-600">
          These numbers are not available on this server right now.
        </p>
      </section>
    );
  const cell = (label: string, value: string | number) => (
    <div key={label} className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
  return (
    <section>
      <h2 className="font-semibold">Live on mainnet</h2>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cell('wallets', s.wallets)}
        {cell('plans', s.plans)}
        {cell('confirmed executions', s.executionsConfirmed)}
        {cell('rebalances', s.rebalances)}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        swaps {s.byKind.swap ?? 0} · deposits {s.byKind.deposit ?? 0} · withdrawals{' '}
        {s.byKind.withdraw ?? 0} · mints {s.byKind.mint ?? 0} · observed value US${' '}
        {s.observedValueUsd} · since{' '}
        {s.firstExecutionAt ? new Date(s.firstExecutionAt).toLocaleDateString() : '—'} · as of{' '}
        {new Date(s.asOf).toLocaleString()}
      </p>
    </section>
  );
}
