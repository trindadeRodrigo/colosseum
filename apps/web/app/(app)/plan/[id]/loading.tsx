import { PlanScreenWait } from '../../../../features/order/waits';

// While the page is made on the server: the page in its own outline, so its own wait takes over
// without a box moving.
export default function Loading() {
  return <PlanScreenWait />;
}
