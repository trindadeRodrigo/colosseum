import { goalMetadata } from '../../../components/shell/metadata';
import { InvestScreen } from '../../../features/invest/InvestScreen';
import { PortfolioSummary } from '../../../features/portfolio/PortfolioSummary';

// Invest begins with one question and a naturally sized conversation. Once built, a plan joins its
// workspace; on a phone it opens from a disclosure. Existing vault cards sit below, each with its own
// chain, pinned value and direct vault link, plus the link to the monitor. `/` is the visitor landing.

export function generateMetadata() {
  return goalMetadata();
}

export default function GoalPage() {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <InvestScreen />
      <PortfolioSummary />
    </div>
  );
}
