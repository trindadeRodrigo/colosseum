import Link from 'next/link';
import { GoalFlow } from '@/components/GoalFlow';
import { StatsCard } from '@/components/StatsCard';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let plans: Array<{
    id: string;
    profile: string;
    capitalUsd: string;
    wallet: string | null;
    solverVersion: string;
    createdAt: string;
  }> = [];
  let apiError: string | null = null;
  try {
    plans = await apiGet('/plans?limit=10');
  } catch (e) {
    apiError = String(e);
  }
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Diga o objetivo. Receba uma estrutura.</h1>
        <p className="mt-1 text-gray-600">
          Objetivos em reais, alocação em ativos on-chain com risco de crédito e de câmbio
          precificados. Política na sua carteira, não um fundo.
        </p>
      </div>
      <GoalFlow />
      <StatsCard />
      <div>
        <h2 className="font-semibold">Planos recentes</h2>
        {apiError && <p className="text-sm text-red-700">API indisponível: {apiError}</p>}
        <ul className="mt-2 space-y-1 text-sm">
          {plans.map((p) => (
            <li key={p.id}>
              <Link className="text-blue-700 underline" href={`/plans/${p.id}`}>
                {p.id.slice(0, 8)}
              </Link>{' '}
              · {p.profile} · US$ {Number(p.capitalUsd).toFixed(2)} · {p.solverVersion} ·{' '}
              {new Date(p.createdAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
