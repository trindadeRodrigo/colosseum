import { AddMoneyRouteWait } from '../../../../../../features/shared/waits';

// While the page is made on the server: add money in outline, on the chain the address names.
export default function Loading() {
  return <AddMoneyRouteWait />;
}
