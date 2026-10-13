import { sectionMetadata } from '../../../features/portfolio-section/metadata';
import { OverviewPage } from '../../../features/portfolio-section/OverviewPage';

// The section opens on its overview: the person's plans, chain by chain, one card a plan. The figures
// are read in the browser, for the person signed in (features/portfolio-section/PortfolioProvider.tsx).

export function generateMetadata() {
  return sectionMetadata('overview');
}

export default function Overview() {
  return <OverviewPage />;
}
