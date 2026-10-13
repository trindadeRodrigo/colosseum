import { goalMetadata } from '../../../components/shell/metadata';
import { GoalHome } from '../../../features/goal-conversation/GoalHome';

// Strategy exploration opens as a private, browser-scoped conversation and sourced preview. A picker
// chooses between this conversation and a new one, with the person's recent and saved conversations
// (GoalHome); `/monitor` retains the full portfolio.

export function generateMetadata() {
  return goalMetadata();
}

export default function GoalPage() {
  return <GoalHome />;
}
