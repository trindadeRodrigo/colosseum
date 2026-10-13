import { buyMetadata } from '../../../../../components/shell/metadata';
import { BuyScreen } from '../../../../../features/order/BuyScreen';

// Buying a plan: the amount, the funding, the trust notice, then the order. Nothing is signed here.

export function generateMetadata() {
  return buyMetadata();
}

export default async function BuyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BuyScreen id={id} />;
}
