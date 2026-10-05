import type { PlanDetail } from '@/lib/api';
import { ProvenanceBadge } from './Provenance';
import { ScheduleChart } from './ScheduleChart';

type Row = {
  month: string;
  withdrawalBrl: number;
  balanceUsd: number;
  balanceBrl: number;
  fxUsdBrl: number;
  liquidityOk: boolean;
};
const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
const pct3 = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

const pct = (w: string | number) => `${(Number(w) * 100).toFixed(1)}%`;

/** The plan as the user (or a partner frame) sees it: sheet, allocation with reasoning, schedule, stresses, risk sheet, executions. */
export function PlanView({ d, embed = false }: { d: PlanDetail; embed?: boolean }) {
  const sheet = d.sheet?.sheet as Record<string, unknown> | undefined;
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-xl font-semibold">
          Plan {d.plan.id.slice(0, 8)} · {d.plan.profile}
        </h1>
        {d.goal && <p className="mt-1 text-gray-700">“{d.goal.rawText}”</p>}
        <p className="mt-1 text-xs text-gray-500">
          solver {d.plan.solverVersion} · {new Date(d.plan.createdAt).toLocaleString()}{' '}
          {d.sheet && <ProvenanceBadge value={d.sheet.provenance} />}
        </p>
      </section>

      {sheet && (
        <section>
          <h2 className="font-semibold">Constraint sheet</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {Object.entries(sheet).map(([k, v]) => (
              <div key={k}>
                <dt className="text-gray-500">{k}</dt>
                <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section>
        <h2 className="font-semibold">Allocation</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th>Leg</th>
              <th>Weight</th>
              <th>USD</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {d.legs.map((l) => (
              <tr key={l.id} className="border-t border-gray-100 align-top">
                <td className="py-1 pr-2">
                  {l.symbol}
                  <div className="text-xs text-gray-500">{l.name}</div>
                  {l.label && <div className="text-xs text-amber-800">{l.label}</div>}
                </td>
                <td className="py-1 pr-2">{pct(l.weight)}</td>
                <td className="py-1 pr-2">{Number(l.amountUsd).toFixed(2)}</td>
                <td className="py-1 text-gray-700">{l.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.plan.bindingConstraints?.length > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            Binding: {d.plan.bindingConstraints.join('; ')}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-semibold">BRL schedule and stresses</h2>
        {(() => {
          const base = d.schedules.find((x) => x.caseId === 'base');
          if (!base)
            return <p className="mt-1 text-sm text-gray-500">No schedule stored for this plan.</p>;
          const rows = base.rows as Row[];
          const stressRows = d.schedules
            .filter((x) => x.caseId !== 'base')
            .map((x) => ({
              id: x.caseId,
              name: d.stresses.find((st) => st.stressId === x.caseId)?.name ?? x.caseId,
              rows: x.rows as Row[],
            }));
          const firstWithdrawal = rows.findIndex((r) => r.withdrawalBrl > 0);
          const show = rows.slice(
            Math.max(0, firstWithdrawal - 1),
            Math.max(0, firstWithdrawal - 1) + 12,
          );
          return (
            <div className="mt-2 space-y-3">
              <p className="text-sm">
                Base case: liquidity{' '}
                {base.liquidityOk ? (
                  <span className="text-green-700">holds every month</span>
                ) : (
                  <span className="text-red-700">breaks</span>
                )}{' '}
                over {rows.length} months · FX {rows[0]?.fxUsdBrl} (PTAX at plan time) · black =
                base, dashed = stresses
              </p>
              <ScheduleChart base={rows} stresses={stressRows} />
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th>Stress</th>
                    <th>Parameters</th>
                    <th>Liquidity</th>
                    <th>Terminal balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-gray-100">
                    <td className="py-1">Base</td>
                    <td className="text-gray-500">—</td>
                    <td>{base.liquidityOk ? 'holds' : 'breaks'}</td>
                    <td>{brl(rows[rows.length - 1]?.balanceBrl ?? 0)}</td>
                  </tr>
                  {d.stresses.map((st) => {
                    const sr = d.schedules.find((x) => x.caseId === st.stressId)?.rows as
                      | Row[]
                      | undefined;
                    return (
                      <tr key={st.stressId} className="border-t border-gray-100">
                        <td className="py-1">{st.name}</td>
                        <td className="text-gray-500">
                          {Object.entries(st.params)
                            .map(([k, v]) => `${k} ${v}`)
                            .join(', ')}
                        </td>
                        <td className={st.liquidityOk ? 'text-green-700' : 'text-red-700'}>
                          {st.liquidityOk ? 'holds' : 'breaks'}
                        </td>
                        <td>{sr ? brl(sr[sr.length - 1]?.balanceBrl ?? 0) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {show.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600">
                    Month by month (12 months around the first withdrawal)
                  </summary>
                  <table className="mt-1 w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th>Month</th>
                        <th>Withdrawal</th>
                        <th>Balance BRL</th>
                        <th>Balance USD</th>
                        <th>FX</th>
                        <th>Liquidity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {show.map((r) => (
                        <tr key={r.month} className="border-t border-gray-100">
                          <td>{r.month}</td>
                          <td>{brl(r.withdrawalBrl)}</td>
                          <td>{brl(r.balanceBrl)}</td>
                          <td>
                            {r.balanceUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                          </td>
                          <td>{r.fxUsdBrl}</td>
                          <td>{r.liquidityOk ? 'ok' : 'short'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          );
        })()}
      </section>

      {d.riskSheet.some((r) => (r.entry as Record<string, unknown>).liquidity) && (
        <section>
          <h2 className="font-semibold">Exit liquidity</h2>
          <p className="text-xs text-gray-600">
            How much of each leg can be sold for dollars at ≤ the cost tolerance, in the worst time
            of week the plan's liquidity window can contain. Measured from on-chain pools; see{' '}
            <a className="text-blue-700 underline" href="/risk/methodology">
              methodology
            </a>
            .
          </p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th>Leg</th>
                <th>Leg amount</th>
                <th>Exit capacity (worst regime)</th>
                <th>Score</th>
                <th>Weekend ÷ market hours</th>
                <th>If the top LPs leave</th>
                <th>Samples · dates</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.riskSheet
                .filter((r) => (r.entry as Record<string, unknown>).liquidity)
                .map((r) => {
                  const l = (r.entry as Record<string, unknown>).liquidity as {
                    capacityUsd: number;
                    capacityLowerBound: boolean;
                    worstRegime: string;
                    tau: number;
                    score: number;
                    legAmountUsd: number;
                    weekendRatio: number | null;
                    lpExitCostPct: number | null;
                    samples: number;
                    dataFrom: string | null;
                    dataTo: string | null;
                    provenance: string;
                  };
                  return (
                    <tr key={r.assetId} className="border-t border-gray-100">
                      <td className="py-1 pr-2">{r.assetId}</td>
                      <td className="pr-2">US$ {Math.round(l.legAmountUsd).toLocaleString()}</td>
                      <td className="pr-2">
                        {l.capacityLowerBound ? '≥ ' : ''}US${' '}
                        {Math.round(l.capacityUsd).toLocaleString()} at ≤{(l.tau * 100).toFixed(1)}%
                        · {l.worstRegime.replaceAll('_', ' ')}
                      </td>
                      <td className="pr-2">{l.score.toFixed(2)}</td>
                      <td className="pr-2">
                        {l.weekendRatio === null ? '—' : l.weekendRatio.toFixed(2)}
                      </td>
                      <td className="pr-2">
                        {l.lpExitCostPct === null ? '—' : `${l.lpExitCostPct.toFixed(2)}% cost`}
                      </td>
                      <td className="pr-2 text-gray-600">
                        {l.samples} · {l.dataFrom?.slice(0, 10)} → {l.dataTo?.slice(0, 10)}
                      </td>
                      <td>
                        <ProvenanceBadge value={l.provenance} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2 className="font-semibold">Risk sheet</h2>
        {d.riskSheet.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">No risk sheet stored for this plan.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500">
                  <th>Leg</th>
                  <th>Quoted</th>
                  <th>Haircut</th>
                  <th>Rule</th>
                  <th>Source · fetched</th>
                  <th>Oracle</th>
                  <th>Redemption</th>
                  <th>Depth</th>
                  <th>Gates</th>
                  <th>Issuer / credit</th>
                </tr>
              </thead>
              <tbody>
                {d.riskSheet.map((r) => {
                  const e = r.entry as Record<string, unknown>;
                  return (
                    <tr key={r.assetId} className="border-t border-gray-100 align-top">
                      <td className="py-1 pr-2">
                        {r.assetId}
                        {e.label ? <div className="text-amber-800">{String(e.label)}</div> : null}
                      </td>
                      <td className="pr-2">{pct3(e.quotedYield as number | null)}</td>
                      <td className="pr-2 font-medium">{pct3(e.haircutYield as number | null)}</td>
                      <td className="pr-2">{String(e.haircutRule ?? '—')}</td>
                      <td className="pr-2 max-w-[14rem] break-all text-gray-600">
                        {String(e.yieldSource ?? '—')}
                        <div>
                          {e.yieldFetchedAt
                            ? new Date(String(e.yieldFetchedAt)).toLocaleString()
                            : ''}
                        </div>
                      </td>
                      <td className="pr-2">{String(e.oracle ?? '—')}</td>
                      <td className="pr-2">
                        {String(e.redemptionPath ?? '—')}
                        <div className="text-gray-500">{String(e.redemptionTime ?? '')}</div>
                      </td>
                      <td className="pr-2">{String(e.depthNote ?? '—')}</td>
                      <td className="pr-2">
                        {Array.isArray(e.gates) ? (e.gates as string[]).join('; ') : '—'}
                      </td>
                      <td>
                        {String(e.issuer ?? '—')}
                        <div className="text-gray-500">{String(e.creditExposure ?? '')}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {d.policy && (
        <section>
          <h2 className="font-semibold">Policy</h2>
          <p className="mt-1 text-sm">
            Allowed: {d.policy.allowedAssets.join(', ')} · trigger {d.policy.trigger.driftPct}%
            drift · default {d.policy.mechanism}
            {Object.keys(d.policy.mechanismByAsset ?? {}).length > 0 &&
              ` (user-signed: ${Object.entries(d.policy.mechanismByAsset)
                .filter(([, m]) => m === 'user_signed')
                .map(([k]) => k)
                .join(', ')})`}
          </p>
          <ul className="mt-1 text-xs text-gray-600">
            {d.policy.bands.map((b) => (
              <li key={b.assetId}>
                {b.assetId}: {pct(b.min)} – {pct(b.max)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="font-semibold">Executions</h2>
        {d.executions.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {d.executions
              .filter((e) => e.status !== 'built')
              .map((e) => (
                <li key={e.id}>
                  {e.kind} {e.assetId} · {e.status} ·{' '}
                  {e.explorerUrl ? (
                    <a
                      className="text-blue-700 underline"
                      href={e.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {e.signature?.slice(0, 12)}…
                    </a>
                  ) : (
                    '—'
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>

      {!embed && <p className="text-xs text-gray-500">{d.disclaimer.pt}</p>}
    </div>
  );
}
