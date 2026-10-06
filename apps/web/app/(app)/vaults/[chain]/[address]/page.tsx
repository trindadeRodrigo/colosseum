import { vaultMetadata } from '../../../../../components/shell/metadata';
import { VaultScreen } from '../../../../../features/shared/VaultScreen';

// Any vault, read-only, as its chain holds it.

export function generateMetadata() {
  return vaultMetadata();
}

export default async function VaultPage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = await params;
  return <VaultScreen chain={chain} address={address} />;
}
