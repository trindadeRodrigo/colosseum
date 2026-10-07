import { goalMetadata } from '../../../components/shell/metadata';
import { InvestScreen } from '../../../features/invest/InvestScreen';
import { PortfolioSummary } from '../../../features/portfolio/PortfolioSummary';

// The product's first screen, Invest (gate INVEST-TWO-PANE): the conversation on the left and the plan
// built beside it on the right; on a phone, one thread with the plan as a line that opens. Under it, for a person who already holds a vault, one line on where their money
// is, and the way to the monitor. `/` is his landing page for a visitor, and leads a person signed in
// on this browser here (app/(marketing)/page.tsx).

export function generateMetadata() {
  return goalMetadata();
}

export default function GoalPage() {
  return (
    <div className="flex flex-col gap-12">
      <InvestScreen />
      <PortfolioSummary />
    </div>
  );
}
