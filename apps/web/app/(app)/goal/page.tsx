import { goalMetadata } from '../../../components/shell/metadata';
import { GoalEntry } from '../../../features/goal-conversation/GoalEntry';
import { PortfolioSummary } from '../../../features/portfolio/PortfolioSummary';

// Strategy exploration opens as a private, browser-scoped conversation and sourced preview.
// Guided investing remains a separate explicit choice with its existing confirmation/funding path.
// Existing vaults stay in a collapsed switcher below; `/monitor` retains the full portfolio.

export function generateMetadata() {
  return goalMetadata();
}

export default function GoalPage() {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <GoalEntry />
      <PortfolioSummary />
    </div>
  );
}
