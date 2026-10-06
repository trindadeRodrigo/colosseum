import { familyBuyMetadata } from '../../../../../components/shell/metadata';
import { FamilyBuyScreen } from '../../../../../features/shared/FamilyBuyScreen';

// Buying a shared portfolio, which opens a vault that follows it. Nothing is signed here.

export function generateMetadata() {
  return familyBuyMetadata();
}

export default async function FamilyBuyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <FamilyBuyScreen slug={slug} />;
}
