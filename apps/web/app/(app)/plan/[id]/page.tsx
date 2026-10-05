import { planMetadata } from '../../../../components/shell/metadata';
import { PlanScreen } from '../../../../features/order/PlanScreen';

// The plan a goal built, before it is bought. The plan is read from the tab that built it: the API has
// no route that reads a stored plan back (features/order/plan-store.ts).

export function generateMetadata() {
  return planMetadata();
}

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanScreen id={id} />;
}
