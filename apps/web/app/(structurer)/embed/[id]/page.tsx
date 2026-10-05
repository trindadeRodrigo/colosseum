import { PlanView } from '@/components/PlanView';
import { apiGet, type PlanDetail } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function EmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await apiGet<PlanDetail>(`/plans/${id}`);
  return <PlanView d={d} embed />;
}
