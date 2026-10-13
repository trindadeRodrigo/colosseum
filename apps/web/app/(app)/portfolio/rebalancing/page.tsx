import { sectionMetadata } from '../../../../features/portfolio-section/metadata';
import { RebalancingPage } from '../../../../features/portfolio-section/RebalancingPage';

// What rebalancing did in the person's vaults: the steps that reached the chain, newest first.

export function generateMetadata() {
  return sectionMetadata('rebalancing');
}

export default function Rebalancing() {
  return <RebalancingPage />;
}
