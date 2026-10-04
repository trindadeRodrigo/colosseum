import { goalMetadata } from '../../../components/shell/metadata';
import { GoalScreen } from '../../../features/goal/GoalScreen';

// The goal comes first: this is the product's first screen. It lives at /goal until the home page is
// rebuilt on the primitives (WEB-2), when it takes `/`.

export function generateMetadata() {
  return goalMetadata();
}

export default function GoalPage() {
  return <GoalScreen />;
}
