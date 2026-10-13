import { addMoneyMetadata } from '../../../../../../components/shell/metadata';
import { AddMoneyScreen } from '../../../../../../features/portfolio/AddMoneyScreen';

// More money into a vault of the person's: the amount, the funding, then the order. Nothing is signed here.

export function generateMetadata() {
  return addMoneyMetadata();
}

export default async function AddMoneyPage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = await params;
  return <AddMoneyScreen chain={chain} address={address} />;
}
