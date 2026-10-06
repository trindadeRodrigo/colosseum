import { goalMetadata } from '../../../components/shell/metadata';
import { GoalScreen } from '../../../features/goal/GoalScreen';
import { PortfolioSummary } from '../../../features/portfolio/PortfolioSummary';

// The product's first screen. The goal comes first (DESIGN-VAULT section 11): the question, the typing
// box and the limits. Under it, for a person who already holds a vault, one line on where their money
// is, and the way to the monitor. `/` is his landing page for a visitor, and leads a person signed in
// on this browser here (app/(marketing)/page.tsx).

export function generateMetadata() {
  return goalMetadata();
}

export default function GoalPage() {
  return (
    <div className="flex flex-col gap-12">
      <GoalScreen />
      <PortfolioSummary />
    </div>
  );
}
