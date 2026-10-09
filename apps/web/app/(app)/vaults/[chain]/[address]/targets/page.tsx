import { targetsMetadata } from '../../../../../../components/shell/metadata';
import { TargetsScreen } from '../../../../../../features/mix/TargetsScreen';

// The weights of a vault the person owns, set by their own hand (gate ANY-COMPOSITION): the editor, the
// server's review, then the order. Nothing is signed here.

export function generateMetadata() {
  return targetsMetadata();
}

export default async function TargetsPage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = await params;
  return <TargetsScreen chain={chain} address={address} />;
}
