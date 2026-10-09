import { VaultWait } from '../../../../../features/shared/waits';

// While the page is made on the server: the vault's workbench in outline, so the page's own wait
// takes over without a box moving.
export default function Loading() {
  return <VaultWait />;
}
