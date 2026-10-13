import { sectionMetadata } from '../../../../../../features/portfolio-section/metadata';
import { PlanPage } from '../../../../../../features/portfolio-section/PlanPage';

// One plan over time: the vault it is held in, on its chain. Opened from the plan's card.

export function generateMetadata() {
  return sectionMetadata('plan');
}

export default async function Plan({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = await params;
  return <PlanPage chain={chain} address={address} />;
}
