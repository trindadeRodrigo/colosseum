import { withdrawMetadata } from '../../../../../../components/shell/metadata';
import { WithdrawScreen } from '../../../../../../features/shared/WithdrawScreen';

// Taking tokens out of a vault, for its owner: what leaves, a review, then the order. Nothing is
// signed here.

export function generateMetadata() {
  return withdrawMetadata();
}

export default async function WithdrawPage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = await params;
  return <WithdrawScreen chain={chain} address={address} />;
}
