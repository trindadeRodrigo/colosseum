import { VaultRouteWait } from '../../../../../features/shared/waits';

// While the page is made on the server: the vault's page in outline (the owner's workbench, or a
// visitor's head and holdings), so the page's own wait takes over without a box moving.
export default function Loading() {
  return <VaultRouteWait />;
}
