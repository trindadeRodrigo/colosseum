import { familyMetadata } from '../../../../components/shell/metadata';
import { FamilyScreen } from '../../../../features/shared/FamilyScreen';

// One shared portfolio: its recipe on the person's chain, its versions, and following it.

export function generateMetadata() {
  return familyMetadata();
}

export default async function FamilyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <FamilyScreen slug={slug} />;
}
