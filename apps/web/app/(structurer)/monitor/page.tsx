'use client';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { API, apiGet, type WalletView } from '@/lib/api';

type Drift = {
  policy: {
    id: string;
    planId: string;
    allowedAssets: string[];
    trigger: { driftPct: number; minIntervalHours: number };
    mechanism: string;
    mechanismByAsset: Record<string, string>;
    delegation?: { agent: string };
  };
  positions: Array<{
    assetId: string;
    amount: number;
    valueUsd: number;
    price: { usdcPerUnit: number; method: string; fetchedAt: string };
    inPolicy: boolean;
  }>;
  drift: {
    total: number;
    rows: Array<{
      assetId: string;
      valueUsd: number;
      weight: number;
      target: number;
      drift: number;
      min: number;
      max: number;
      outOfBand: boolean;
    }>;
    maxAbsDrift: number;
    anyOutOfBand: boolean;
  };
  proposal: {
    triggered: boolean;
    reason: string;
    orders: Array<{
      fromAssetId: string;
      toAssetId: string;
      amountUsd: number;
      mechanism: string;
      reason: string;
    }>;
  };
  liquidity: {
    breach: boolean;
    likelyBreach: boolean;
    shortfallUsd: number;
    monthsAtRisk: string[];
    withdrawalScale: number;
    windowDays: number;
    methodVersion: string;
    params: Record<string, number>;
  } | null;
  nextWithdrawal: { month: string; withdrawalBrl: number } | null;
  projectedVsActual: {
    month: string;
    projectedUsd: number;
    actualUsd: number;
    planCapitalUsd: number;
    note: string;
  } | null;
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Monitoring for the connected wallet: positions, drift vs bands, next withdrawal, projected vs actual, and "run policy". */
export default function MonitorPage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const wallet = publicKey?.toBase58();
  const [view, setView] = useState<WalletView | null>(null);
  const [drift, setDrift] = useState<Drift | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The server did not answer for the policy: the positions still show, and a sentence says the rest
  // is not there.
  const [policyOff, setPolicyOff] = useState(false);
  // The rebalance signs with a key on the server, so the API registers its route only with
  // LEGACY_STRUCTURER on. Where it is off the route is not there, and a sentence says so.
  const [rebalanceOff, setRebalanceOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    if (!wallet) return;
    try {
      const v = await apiGet<WalletView>(`/wallets/${wallet}/positions`);
      setView(v);
      const pol = v.policies[0];
      if (pol) {
        try {
          setDrift(await apiGet<Drift>(`/policies/${pol.id}/drift`));
          setPolicyOff(false);
        } catch {
          setPolicyOff(true);
        }
      }
    } catch (e) {
      setErr(String(e));
    }
  }, [wallet]);
  useEffect(() => {
    load();
  }, [load]);

  async function revoke() {
    if (!drift || !signTransaction) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/policies/${drift.policy.id}/revoke`, { method: 'POST' });
      const d = (await res.json()) as {
        transactions: Array<{ payload: string; executionId?: string }>;
        note?: string;
      };
      if (!d.transactions.length) {
        setResult({ outcome: 'nothing to revoke', note: d.note });
        return;
      }
      const t = d.transactions[0] as { payload: string; executionId?: string };
      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(atob(t.payload), (c) => c.charCodeAt(0)),
      );
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 0 });
      const conf = await connection.confirmTransaction(sig, 'confirmed');
      await fetch(`${API}/executions/${t.executionId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: conf.value.err ? 'failed' : 'confirmed', signature: sig }),
      });
      setResult({
        outcome: conf.value.err ? 'failed' : 'revoked',
        signature: sig,
        explorerUrl: `https://solscan.io/tx/${sig}`,
      });
      await load();
    } catch (e) {
      setResult({ outcome: 'error', error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function runPolicy() {
    if (!drift) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/policies/${drift.policy.id}/rebalance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 404) {
        setRebalanceOff(true);
        return;
      }
      const d = (await res.json()) as Record<string, unknown> & {
        outcome?: string;
        transaction?: { payload: string; executionId?: string };
      };
      if (d.outcome === 'user_signed' && Array.isArray(d.transactions) && signTransaction) {
        // The policy proposed; the wallet signs each transaction in order and reports every outcome back.
        const outcomes: Array<{
          asset: string;
          signature: string;
          explorerUrl: string;
          ok: boolean;
        }> = [];
        for (const t of d.transactions as Array<{
          payload: string;
          executionId?: string;
          legAssetId: string;
        }>) {
          const tx = VersionedTransaction.deserialize(
            Uint8Array.from(atob(t.payload), (c) => c.charCodeAt(0)),
          );
          const signed = await signTransaction(tx);
          const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 0 });
          await fetch(`${API}/executions/${t.executionId}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'sent', signature: sig }),
          });
          const conf = await connection.confirmTransaction(sig, 'confirmed');
          const ok = !conf.value.err;
          await fetch(`${API}/executions/${t.executionId}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              status: ok ? 'confirmed' : 'failed',
              signature: sig,
              error: ok ? undefined : JSON.stringify(conf.value.err),
            }),
          });
          outcomes.push({
            asset: t.legAssetId,
            signature: sig,
            explorerUrl: `https://solscan.io/tx/${sig}`,
            ok,
          });
          if (!ok) break;
        }
        setResult({
          ...d,
          outcome: outcomes.every((o) => o.ok) ? 'confirmed' : 'failed',
          outcomes,
          signer: wallet,
        });
      } else setResult(d);
      await load();
    } catch (e) {
      setResult({ outcome: 'error', error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!wallet)
    return (
      <p className="text-gray-600">
        Connect a wallet to see its positions, drift against the policy, executions and rebalances.
      </p>
    );
  if (err) return <p className="text-red-700">{err}</p>;
  if (!view) return <p className="text-gray-500">Loading…</p>;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">
        Monitor · {wallet.slice(0, 6)}…{wallet.slice(-4)}
      </h1>

      {drift ? (
        <section className="space-y-3">
          <h2 className="font-semibold">
            Policy {drift.policy.id.slice(0, 8)} · trigger {drift.policy.trigger.driftPct}% ·
            default {drift.policy.mechanism}
            {drift.policy.delegation
              ? ` · agent ${drift.policy.delegation.agent.slice(0, 6)}…`
              : ''}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th>Asset</th>
                <th>Value USD</th>
                <th>Weight</th>
                <th>Target</th>
                <th>Band</th>
                <th>Drift</th>
                <th>Mechanism</th>
              </tr>
            </thead>
            <tbody>
              {drift.drift.rows.map((r) => (
                <tr
                  key={r.assetId}
                  className={`border-t border-gray-100 ${r.outOfBand ? 'bg-amber-50' : ''}`}
                >
                  <td className="py-1">{r.assetId}</td>
                  <td>{r.valueUsd.toFixed(2)}</td>
                  <td>{pct(r.weight)}</td>
                  <td>{pct(r.target)}</td>
                  <td className="text-gray-500">
                    {pct(r.min)} – {pct(r.max)}
                  </td>
                  <td className={r.outOfBand ? 'font-medium text-amber-800' : ''}>
                    {r.drift >= 0 ? '+' : ''}
                    {pct(r.drift)}
                  </td>
                  <td className="text-gray-500">
                    {drift.policy.mechanismByAsset[r.assetId] ?? drift.policy.mechanism}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded border border-gray-200 p-2">
              <div className="text-gray-500">Next scheduled withdrawal</div>
              {drift.nextWithdrawal ? (
                <div>
                  {drift.nextWithdrawal.month} · R${' '}
                  {drift.nextWithdrawal.withdrawalBrl.toLocaleString('pt-BR')}
                </div>
              ) : (
                <div>none in the base schedule</div>
              )}
            </div>
            <div className="rounded border border-gray-200 p-2">
              <div className="text-gray-500">
                Projected vs actual ({drift.projectedVsActual?.month})
              </div>
              {drift.projectedVsActual ? (
                <div>
                  plan US${' '}
                  {drift.projectedVsActual.projectedUsd.toLocaleString('en-US', {
                    maximumFractionDigits: 0,
                  })}{' '}
                  at capital {drift.projectedVsActual.planCapitalUsd.toLocaleString('en-US')} ·
                  wallet US$ {drift.projectedVsActual.actualUsd.toFixed(2)}
                  <div className="text-xs text-gray-500">{drift.projectedVsActual.note}</div>
                </div>
              ) : (
                <div>—</div>
              )}
            </div>
            {drift.liquidity && (
              <div className="rounded border border-gray-200 p-2">
                <div className="text-gray-500">Liquidity check</div>
                <div>
                  {drift.liquidity.likelyBreach ? (
                    <span className="text-amber-800">
                      likely breach: short US$ {drift.liquidity.shortfallUsd.toFixed(2)} under the
                      dry stress in {drift.liquidity.monthsAtRisk.join(', ')}
                    </span>
                  ) : drift.liquidity.breach ? (
                    <span className="text-red-700">breach in the base case</span>
                  ) : (
                    <span className="text-green-700">
                      next withdrawals covered (window {drift.liquidity.windowDays} days)
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  withdrawals scaled ×{drift.liquidity.withdrawalScale.toFixed(4)} to wallet size ·{' '}
                  {drift.liquidity.methodVersion}
                </div>
              </div>
            )}
            <div className="rounded border border-gray-200 p-2">
              <div className="text-gray-500">Policy check</div>
              <div>
                {drift.proposal.triggered ? (
                  <span className="text-amber-800">triggered: {drift.proposal.reason}</span>
                ) : (
                  <span className="text-green-700">{drift.proposal.reason}</span>
                )}
              </div>
            </div>
          </div>
          {drift.proposal.orders.length > 0 && (
            <ul className="text-sm">
              {drift.proposal.orders.map((o) => (
                <li key={`${o.fromAssetId}${o.toAssetId}`}>
                  {o.fromAssetId} → {o.toAssetId} · US$ {o.amountUsd.toFixed(2)} ·{' '}
                  <span className="text-gray-500">{o.mechanism}</span> · {o.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={busy || rebalanceOff || !drift.proposal.triggered}
              onClick={runPolicy}
            >
              {busy ? 'Running…' : 'Run policy now'}
            </button>
            <span className="text-xs text-gray-500">
              Delegated orders are signed by the agent key within the approved limits; user-signed
              orders open your wallet.
            </span>
          </div>
          {rebalanceOff && (
            <p className="text-sm text-gray-600">
              This server did not run the policy: rebalancing from this page is switched off here.
              Nothing was sent.
            </p>
          )}
          {result && (
            <pre className="overflow-auto rounded bg-gray-50 p-2 text-xs">
              {JSON.stringify(result, null, 1)}
            </pre>
          )}
          <p className="text-xs text-gray-500">
            Prices: Jupiter 1-unit sell quotes (
            {drift.positions[0]?.price.fetchedAt
              ? new Date(drift.positions[0].price.fetchedAt).toLocaleString()
              : ''}
            ).
          </p>
        </section>
      ) : policyOff ? (
        <p className="text-sm text-gray-600">
          The policy view is not available right now: the server did not answer for it. Rebalances
          and past executions are below.
        </p>
      ) : (
        <p className="text-sm text-gray-500">No policy for this wallet yet.</p>
      )}

      <section>
        <h2 className="font-semibold">Rebalances</h2>
        {view.rebalances.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="text-sm">
            {view.rebalances.map((r) => (
              <li key={r.id}>
                {new Date(r.createdAt).toLocaleString()} · {r.mechanism} · {r.triggerReason}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="font-semibold">Executions</h2>
        <ul className="space-y-1 text-sm">
          {view.executions
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
                {e.error && <span className="text-xs text-red-700"> {e.error.slice(0, 80)}</span>}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
