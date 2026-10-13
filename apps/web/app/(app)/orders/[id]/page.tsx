import { orderMetadata } from '../../../../components/shell/metadata';
import { OrderScreen } from '../../../../features/order/OrderScreen';

// An order: the review of every step, the signing through the guard, and each step's status. The one
// route of the product that signs (components/shell/product-routes.test.ts, rule 3).

export function generateMetadata() {
  return orderMetadata();
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderScreen id={id} />;
}
